// The multi-leg driver: runs a `legs:` scenario's legs strictly in order under one scenario root.
//
//   <runs>/<slug>/<runId>/            the scenario root (status.json, scenario-result.json at the end)
//     legs/<id>/                      a prompt leg: one ordinary single-prompt execution (turns/1/…, events.jsonl)
//     legs/<id>/                      a host-action leg: action.json and its manifests
//     work/, claude-config/           under `workdir: persistent`, the session tree every leg shares
//
// A prompt leg is a FRESH agent session (its own id, never --resume) with the leg's prompt and assertions, run through
// executeScenario with a LegRunContext. A failing leg stops the scenario: every later leg is reported `skipped`, never
// run on bad state. The scenario's verdict, its one index row and its per-leg verdicts go to scenario-result.json.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunResult, Assertion } from "../types.js";
import type { Verdict, VerdictSignal } from "./verdict.js";
import { computeVerdict } from "./verdict.js";
import { executeScenario, legScenario, loadSessionFromFile, runOutDir, effectiveTier, type ExecuteOptions } from "./execute.js";
import { loadBaseline } from "../baseline.js";
import { UsageError, UnansweredError } from "../errors.js";
import { writeTextAtomic } from "../io.js";
import { writeRunningStatus, finalizeRunStatus, type RunStatusMeta } from "./run-status.js";
import { indexRowFromResult, appendIndexRow, type RunIndexRow } from "./run-index.js";
import { runsWriteRoot } from "./trace-view.js";
import { SCENARIO_RESULT, type LegMarker } from "./turn-layout.js";
import {
  SCENARIO_RESULT_SCHEMA,
  type ScenarioResult,
  type ScenarioLegEntry,
  type ScenarioVerdict,
  type MultiLegSignal,
} from "./scenario-result.js";
import { evaluate } from "../assert.js";
import type { MultiLegScenario, Leg, LegSessionOverlay } from "./multi-leg-scenario.js";
import { buildLaunchPlan, resolveLaunchSources, type SessionConfig, type LegStage } from "../session.js";
import { collectSecrets, scrub } from "../secrets.js";
import { readPreRunManifestHashes } from "./pre-run-manifest.js";
import {
  readActionStatus,
  resolveActionArgv,
  recordedStream,
  gradeAction,
  producedFiles,
  writeActionRecord,
  type ActionRecord,
} from "./host-action.js";
import { actionPaths, runActionInTier, takeActionManifest, actionFileCtx, type ActionTier } from "./host-action-runners.js";
import { hostActionAsserts } from "./multi-leg-scenario.js";

/** The tiers a multi-leg run can host in M1. The host loop is refused: its shell runs in a separate sidecar that a
 *  leg loop cannot keep, and `answer_channel: none` refuses it anyway. */
const MULTI_LEG_TIERS = new Set(["container", "microvm", "protocol"]);

/** The assertion keys that carry POSITIVE completion evidence from files (as answer-channel.ts's list). */
const FILE_EVIDENCE_KEYS = ["artifact_json", "artifact_text", "file_exists", "user_visible_artifact"] as const;
const PRESENCE_KEYS = ["file_exists", "user_visible_artifact"] as const;

export interface MultiLegOutcome {
  outDir: string;
  scenarioResult: ScenarioResult;
  /** Each prompt leg's RunResult, by leg id. */
  legResults: Map<string, RunResult>;
}

/** A leg's session: the scenario session with the leg's overlay applied. */
export function overlaySession(session: SessionConfig, overlay: LegSessionOverlay | undefined): SessionConfig {
  if (!overlay) return session;
  return {
    ...session,
    ...(overlay.answer_channel !== undefined ? { answer_channel: overlay.answer_channel } : {}),
    ...(overlay.permission_mode !== undefined ? { permission_mode: overlay.permission_mode } : {}),
    ...(overlay.agent_env !== undefined ? { agent_env: { ...session.agent_env, ...overlay.agent_env } } : {}),
  };
}

const hasKey = (a: Assertion, k: string): boolean => (a as Record<string, unknown>)[k] !== undefined;
const authoredFlag = (a: Assertion): boolean =>
  FILE_EVIDENCE_KEYS.some((k) => {
    const v = (a as Record<string, unknown>)[k];
    return v !== null && typeof v === "object" && (v as { authored?: unknown }).authored === true;
  });

/** Load-time rule for an `answer_channel: none` leg after the first: its required positive file assertion must be one
 *  that cannot already hold on the earlier legs' files. A presence assertion counts only with `authored: true`; a value
 *  assertion (artifact_json / artifact_text) counts as written. */
export function vacuousLegBlockRefusal(leg: Leg, asserts: Assertion[]): string | undefined {
  const counting = asserts.filter((a) => {
    if (!FILE_EVIDENCE_KEYS.some((k) => hasKey(a, k))) return false;
    if (PRESENCE_KEYS.some((k) => hasKey(a, k))) return authoredFlag(a);
    return true;
  });
  if (counting.length) return undefined;
  return (
    `leg "${leg.id}": under \`answer_channel: none\` a later leg needs a positive file assertion that cannot already hold on the ` +
    `earlier legs' files: a value assertion (artifact_json / artifact_text) or a presence assertion with \`authored: true\`. A bare ` +
    `file_exists on a file an earlier leg wrote passes before this leg runs.`
  );
}

/** Run-time half: does this leg's positive file block already pass on the tree as it stands before the leg? `skipOutputs`
 *  (cowork-task) treats every `outputs/…` path as absent, since a new task's outputs start empty. */
function blockPassesBefore(asserts: Assertion[], workRoot: string, skipOutputs: boolean, tier: string): Assertion | undefined {
  const block = asserts.filter((a) => FILE_EVIDENCE_KEYS.some((k) => hasKey(a, k)) && !authoredFlag(a));
  if (!block.length) return undefined;
  const pathOf = (a: Assertion): string => {
    const o = a as Record<string, unknown>;
    const v = o.file_exists ?? o.user_visible_artifact;
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return String((v as { path?: unknown }).path ?? "");
    const aj = (o.artifact_json ?? o.artifact_text) as { artifact?: unknown } | undefined;
    return String(aj?.artifact ?? "");
  };
  if (skipOutputs && block.some((a) => /^outputs(\/|$)/.test(pathOf(a)))) return undefined;
  const ctx = { transcript: "", workRoot, effectiveFidelity: tier, lane: "local" } as unknown as Parameters<typeof evaluate>[1];
  const results = evaluate(block, ctx, { quietSharedCapture: true });
  return results.every((r) => r.pass) ? block[0] : undefined;
}

/** The work root (the tree assertions resolve against) of a tree based at `workBase` on `tier`. */
function workRootOf(workBase: string, tier: string): string {
  return tier === "protocol" ? join(workBase, "work") : join(workBase, "work", "session", "mnt");
}

function writeLegMarker(dir: string, marker: LegMarker): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "leg.json"), JSON.stringify(marker, null, 2) + "\n");
}

/** A leg's verdict signals and failures, each prefixed with the leg so the scenario verdict names where it failed. */
function prefixVerdict(id: string, v: ScenarioVerdict): { signals: ScenarioVerdict["signals"]; failures: Verdict["failures"] } {
  return {
    signals: v.signals.map((s) => ({ ...s, message: `leg ${id}: ${s.message}` })),
    failures: (v.failures ?? []).map((f) => ({ ...f, message: `leg ${id}: ${f.message}` })),
  };
}

/** The scenario verdict, the same live and on replay: every leg passed and none was skipped. Signals and failures name
 *  their leg; `extra` is the scenario-level signals (plugin identity). */
export function composeScenarioVerdict(
  legEntries: readonly ScenarioLegEntry[],
  stopped: string | undefined,
  extra: readonly MultiLegSignal[] = [],
): ScenarioVerdict {
  const parts = legEntries.filter((e) => e.verdict).map((e) => prefixVerdict(e.id, e.verdict!));
  const skipped = legEntries.filter((e) => e.status === "skipped").map((e) => e.id);
  const signals: ScenarioVerdict["signals"] = [...parts.flatMap((p) => p.signals), ...extra];
  const failures = [...parts.flatMap((p) => p.failures ?? []), ...extra.map((s) => ({ kind: "guard", message: s.message }))];
  if (skipped.length)
    failures.push({ kind: "guard", message: `skipped (prior leg ${stopped} failed): ${skipped.join(", ")}` } as (typeof failures)[number]);
  const pass = stopped === undefined && extra.length === 0 && legEntries.every((e) => e.status === "passed");
  return {
    pass,
    exitCode: pass ? 0 : 1,
    signals,
    guards: [...new Map(legEntries.flatMap((e) => e.verdict?.guards ?? []).map((g) => [g.name, g])).values()],
    failures,
  } as ScenarioVerdict;
}

/** Run one host-action leg: read the status file, resolve the argv, take the pre-run manifest, run in the tier, take
 *  the post-run manifest, grade, and record everything in action.json. A status, template or spawn failure fails the
 *  leg without running (or after failing to run) the command. */
async function executeHostAction(p: {
  leg: Leg;
  legDir: string;
  tier: ActionTier;
  baseline: ReturnType<typeof loadBaseline>;
  session: SessionConfig;
  sessionId: string;
  workBase: string;
}): Promise<{ pass: boolean; verdict: ScenarioVerdict }> {
  const { leg, legDir, tier, baseline, session, sessionId, workBase } = p;
  const ha = leg.host_action!;
  const secrets = collectSecrets();
  const plan = buildLaunchPlan(session, baseline, legDir, tier, false, "local", resolveLaunchSources(session, baseline, tier, false), {
    workBase,
  });
  const paths = actionPaths(tier, baseline, sessionId, workBase);
  const empty = { sha256: "", bytes: 0, head: "" };
  const finish = (rec: Omit<ActionRecord, "pass">): { pass: boolean; verdict: ScenarioVerdict } => {
    const pass = rec.refused === undefined && rec.assertions.every((a) => a.pass);
    writeActionRecord(legDir, { ...rec, pass });
    const messages = [
      ...(rec.refused ? [rec.refused] : []),
      ...rec.assertions.filter((a) => !a.pass).map((a) => a.message ?? JSON.stringify(a.assertion)),
    ];
    return {
      pass,
      verdict: {
        pass,
        exitCode: pass ? 0 : 1,
        signals: messages.map((message) => ({ code: "assertion", severity: "fail", message }) as VerdictSignal),
        guards: [],
        failures: messages.map((message) => ({ kind: "assertion", message })),
      } as unknown as ScenarioVerdict,
    };
  };
  const refusedRecord = (why: string, argv: string[] = ha.run) =>
    finish({
      argv,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdout: empty,
      stderr: empty,
      produced: [],
      refused: why,
      assertions: [],
    });

  let status: Record<string, unknown> | undefined;
  if (ha.status) {
    const r = readActionStatus(paths.hostWorkRoot, ha.status);
    if (!r.ok) return refusedRecord(r.why);
    status = r.status;
  }
  const resolved = resolveActionArgv(ha.run, status, paths.sessionRoot);
  if (!resolved.ok) return refusedRecord(resolved.why);
  takeActionManifest(plan, paths.hostWorkRoot, legDir, tier, "pre");
  process.stderr.write(`[leg ${leg.id}] host action: ${resolved.argv.map((a) => JSON.stringify(scrub(a, secrets))).join(" ")}\n`);
  const exec = await runActionInTier({
    tier,
    baseline,
    plan,
    sessionId,
    workBase,
    legDir,
    argv: resolved.argv,
    timeoutMs: ha.timeout * 1000,
  });
  if (exec.spawnError) return refusedRecord(`the action could not run: ${exec.spawnError}`, resolved.argv);
  takeActionManifest(plan, paths.hostWorkRoot, legDir, tier, "post");
  const before = readPreRunManifestHashes(legDir) ?? {};
  const after = readJsonHashes(join(legDir, "post-run-manifest.json"));
  const assertions = gradeAction(
    hostActionAsserts(leg),
    exec,
    scrub(exec.stdout, secrets),
    actionFileCtx(plan, paths.hostWorkRoot, legDir, tier),
  );
  return finish({
    argv: resolved.argv.map((a) => scrub(a, secrets)),
    exitCode: exec.exitCode,
    timedOut: exec.timedOut,
    durationMs: exec.durationMs,
    stdout: recordedStream(exec.stdout, exec.stdoutBytes, secrets),
    stderr: recordedStream(exec.stderr, exec.stderrBytes, secrets),
    produced: producedFiles(before, after),
    assertions,
  });
}

function readJsonHashes(path: string): Record<string, string | null> {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as { hashes?: Record<string, string | null> };
    return o.hashes ?? {};
  } catch {
    return {};
  }
}

/** Run a multi-leg scenario. Refusals (tier, flags) throw UsageError before the scenario root exists. */
export async function executeMultiLeg(
  ms: MultiLegScenario,
  opts: ExecuteOptions = {},
  /** `afterPromptLeg` runs right after a prompt leg finishes, BEFORE the next leg can change the shared tree: the
   *  moment a recorder must snapshot that leg's files (multi-leg-cassette.ts). */
  hooks: { afterPromptLeg?: (leg: Leg, result: RunResult) => Promise<void> } = {},
): Promise<MultiLegOutcome> {
  if (opts.sessionId !== undefined || opts.resume)
    throw new UsageError("--session-id and --resume take a single-prompt scenario; a multi-leg run's legs are new sessions by design");
  if (opts.ablateSkill) throw new UsageError("--ablate-skill is not supported with a multi-leg scenario");
  const baseline = loadBaseline(ms.baseline);
  const tier = effectiveTier(ms.fidelity, baseline);
  if (ms.fidelity === "cowork" || !MULTI_LEG_TIERS.has(tier))
    throw new UsageError(
      `a multi-leg scenario runs on container, microvm or protocol (got fidelity: ${ms.fidelity}${ms.fidelity === "cowork" ? `, which resolves to ${tier}` : ""}): ` +
        `the host loop's shell runs in a sidecar a leg loop cannot keep. Name the tier explicitly.`,
    );
  const baseSession = opts.session ?? loadSessionFromFile(ms.session);
  const promptLegs = ms.legs.filter((l) => l.prompt !== undefined);
  // Every refusal a leg would hit is checked before the first leg spends: leg 2's mistake must not cost leg 1's run.
  for (const [i, leg] of ms.legs.entries()) {
    if (leg.prompt === undefined) continue;
    const s = overlaySession(baseSession, leg.session);
    if (i > 0 && s.answer_channel === "none") {
      const r = vacuousLegBlockRefusal(leg, legScenario(ms, leg).assert);
      if (r) throw new UsageError(r);
    }
  }
  if (promptLegs.length < 2) throw new UsageError("a multi-leg scenario needs at least two prompt legs");

  const runId = opts.runId ?? `local_${process.hrtime.bigint().toString(36)}`;
  const root = runOutDir(ms.name, runId);
  if (existsSync(root)) throw new UsageError(`run id ${runId} is already used by ${root}`);
  mkdirSync(join(root, "legs"), { recursive: true });
  const meta: RunStatusMeta = {
    pid: process.pid,
    scenario: ms.name,
    fidelity: ms.fidelity,
    sessionId: runId,
    startedAt: Date.now(),
    runLabel: opts.runLabel,
  };
  writeRunningStatus(root, meta);
  process.stderr.write(opts.compact ? "" : `[status] ${root}\n`);

  const startedAt = new Date();
  const legEntries: ScenarioLegEntry[] = [];
  const legResults = new Map<string, RunResult>();
  const legRows: RunIndexRow[] = [];
  let stopped: string | undefined; // the leg that failed; every later leg is skipped
  let unanswered: UnansweredError | undefined;
  let prevWorkBase: string | undefined;
  let prevSessionId: string | undefined;
  let skillHash: string | undefined;
  const identityFailures: MultiLegSignal[] = [];

  try {
    for (const [index, leg] of ms.legs.entries()) {
      const kind: "prompt" | "action" = leg.prompt !== undefined ? "prompt" : "action";
      if (stopped !== undefined) {
        legEntries.push({ id: leg.id, kind, status: "skipped" });
        continue;
      }
      const legDir = join(root, "legs", leg.id);
      writeLegMarker(legDir, { scenarioRoot: "../..", id: leg.id, index, kind, workdir: ms.workdir });
      if (kind === "action") {
        // The action runs in the tree the previous prompt leg left: the shared one, or that leg's own (cowork-task).
        const action = await executeHostAction({
          leg,
          legDir,
          tier: tier as ActionTier,
          baseline,
          session: baseSession,
          sessionId: prevSessionId!,
          workBase: prevWorkBase!,
        });
        legEntries.push({ id: leg.id, kind, status: action.pass ? "passed" : "failed", verdict: action.verdict });
        if (!action.pass) stopped = leg.id;
        continue;
      }
      const persistent = ms.workdir === "persistent";
      const workBase = persistent ? root : legDir;
      const legStage: LegStage | undefined =
        prevWorkBase === undefined
          ? undefined
          : persistent
            ? { workdir: "persistent" }
            : { workdir: "cowork-task", carryFromMnt: workRootOf(prevWorkBase, tier) };
      const scn = legScenario(ms, leg);
      const session = overlaySession(baseSession, leg.session);
      // The run-time half of the vacuity rule: a `none` leg whose file block already passes on the earlier legs' tree
      // proves nothing. Checked before the leg spends.
      if (prevWorkBase !== undefined && session.answer_channel === "none") {
        const hit = blockPassesBefore(scn.assert, workRootOf(prevWorkBase, tier), !persistent, tier);
        if (hit) {
          const message = `leg ${leg.id}: vacuous_positive_assertion: its positive file assertions already pass on the earlier legs' files (${JSON.stringify(hit)}), so they cannot show this leg did anything`;
          legEntries.push({
            id: leg.id,
            kind,
            status: "failed",
            verdict: {
              pass: false,
              exitCode: 1,
              signals: [{ code: "vacuous_positive_assertion", severity: "fail", message }],
              guards: [],
              failures: [{ kind: "guard", message }],
            } as ScenarioVerdict,
          });
          stopped = leg.id;
          continue;
        }
      }
      const agentSessionId = randomUUID();
      const legSessionId = persistent ? runId : `${runId}-${leg.id}`;
      let result: RunResult | undefined;
      try {
        result = await executeScenario(scn, {
          ...opts,
          session,
          leg: {
            outDir: legDir,
            sessionId: legSessionId,
            workBase,
            ...(legStage ? { legStage } : {}),
            agentSessionId,
          },
        });
      } catch (e) {
        if (!(e instanceof UnansweredError)) throw e;
        unanswered = e;
      }
      prevWorkBase = workBase;
      prevSessionId = legSessionId;
      if (!result) {
        legEntries.push({ id: leg.id, kind, agentSessionId, status: "failed" });
        stopped = leg.id;
        continue;
      }
      legResults.set(leg.id, result);
      await hooks.afterPromptLeg?.(leg, result);
      legRows.push(indexRowFromResult(result, { command: opts.command ?? "run", partial: false }));
      const verdict: ScenarioVerdict = computeVerdict(result, "live");
      // Every leg runs the same plugins: a skill tree that changed between legs is not the scenario the author wrote.
      const h = result.fingerprint?.skillHash;
      if (h !== undefined) {
        if (skillHash === undefined) skillHash = h;
        else if (h !== skillHash)
          identityFailures.push({
            code: "plugin_identity_changed",
            severity: "fail",
            message: `leg ${leg.id}: the staged skill/plugin tree changed between legs (${skillHash.slice(0, 12)} → ${h.slice(0, 12)})`,
          });
      }
      const passed = verdict.pass && identityFailures.length === 0;
      legEntries.push({ id: leg.id, kind, agentSessionId, status: passed ? "passed" : "failed", verdict });
      if (!passed) stopped = leg.id;
    }
  } catch (e) {
    // A leg's own run dir is finalized by its execution; the scenario root must not be left reading "running".
    finalizeRunStatus(
      root,
      meta,
      { toolCounts: {}, subagents: [] } as unknown as Parameters<typeof finalizeRunStatus>[2],
      "error",
      Date.now() - startedAt.getTime(),
    );
    throw e;
  }

  const verdict = composeScenarioVerdict(legEntries, stopped, identityFailures);
  const pass = verdict.pass;

  const finishedAt = new Date();
  const indexRow = rollupRow(root, ms, legRows, pass, finishedAt.toISOString(), finishedAt.getTime() - startedAt.getTime(), opts);
  const scenarioResult: ScenarioResult = {
    schema: SCENARIO_RESULT_SCHEMA,
    version: 1,
    scenario: ms.name,
    verdict,
    legs: legEntries,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...(opts.runLabel !== undefined ? { runLabel: opts.runLabel } : {}),
    indexRow,
  };
  writeTextAtomic(join(root, SCENARIO_RESULT), JSON.stringify(scenarioResult, null, 2));
  appendIndexRow(runsWriteRoot(), indexRow);
  finalizeRunStatus(
    root,
    meta,
    { toolCounts: {}, subagents: [] } as unknown as Parameters<typeof finalizeRunStatus>[2],
    pass ? "success" : "error",
    scenarioResult.durationMs,
  );
  if (unanswered) throw unanswered;
  return { outDir: root, scenarioResult, legResults };
}

/** The ONE index row a multi-leg run gets: identity of the scenario root, the scenario verdict, spend summed over the
 *  prompt legs. */
function rollupRow(
  root: string,
  ms: MultiLegScenario,
  legRows: RunIndexRow[],
  pass: boolean,
  ts: string,
  durationMs: number,
  opts: ExecuteOptions,
): RunIndexRow {
  const parts = root.split("/");
  const runId = parts[parts.length - 1]!;
  const slug = parts[parts.length - 2]!;
  const sum = (f: (r: RunIndexRow) => number | undefined): number | undefined => {
    const xs = legRows.map(f).filter((x): x is number => typeof x === "number");
    return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined;
  };
  const first = legRows[0];
  return {
    v: 1,
    ts,
    command: opts.command === "record" ? "record" : "run",
    scenario: ms.name,
    slug,
    runId,
    fidelity: ms.fidelity,
    ...(first?.effectiveFidelity ? { effectiveFidelity: first.effectiveFidelity } : {}),
    baseline: first?.baseline ?? ms.baseline ?? "unknown",
    result: legRows.length && legRows.every((r) => r.result === "success") ? "success" : "error",
    pass,
    ...(opts.runLabel !== undefined ? { runLabel: opts.runLabel } : {}),
    ...(first?.skillHash ? { skillHash: first.skillHash } : {}),
    multiLeg: true,
    signals: [...new Set(legRows.flatMap((r) => r.signals))],
    ...(sum((r) => r.costUsd) !== undefined ? { costUsd: sum((r) => r.costUsd) } : {}),
    ...(sum((r) => r.tokens) !== undefined ? { tokens: sum((r) => r.tokens) } : {}),
    durationMs,
    partial: false,
    nonDeterministic: legRows.some((r) => r.nonDeterministic),
    outDir: root,
    git: first?.git ?? { branch: null, sha: null },
  } as RunIndexRow;
}

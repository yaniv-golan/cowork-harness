// The multi-leg cassette (format v18): one file per `legs:` scenario.
//
//   { cassetteVersion: 18, scenario: <the frozen legs: scenario>, legs: [...], verdict: { pass } }
//   legs[i] = { id, kind: "prompt", status, cassette: <a complete single-prompt cassette for that leg> }
//           | { id, kind: "action", status, action: <the host action's record> }
//           | { id, kind, status: "skipped" }
//
// Each prompt leg nests a whole single-prompt cassette built by the ordinary freeze path (redaction and its
// verdict-preservation check, the account-data scrub, staleness, artifacts), so every per-cassette rule applies to each
// leg unchanged; only the composition is new here. There is no top-level `prompt` or `events`: an older reader's shape
// check fails on it (even under --best-effort-future-cassette) instead of grading leg 1 as the whole run.
//
// Replay re-drives each prompt leg from its nested cassette and re-grades each host action from its record (it never
// re-runs the command: replay stays token-free and Docker-free). Legs after a failing one are skipped, as live.

import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname, relative } from "node:path";
import { z } from "zod";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";
import {
  CASSETTE_VERSION,
  cassetteSchemaUrl,
  cassetteSessionRef,
  cassetteFixtureRef,
  classifyRecordLeak,
  defaultCassettePath,
  freezeRecordedRun,
  parseCassetteObject,
  quarantineCassette,
  replayCassette,
  requiredVersionFor,
  writeFileAtomic,
  RecordPostRunRefusalError,
  checkStaleness,
  type Cassette,
  type RecordOpts,
} from "./cassette.js";
import { loadRedactionPolicy, redactText, type RedactionPolicy } from "../redact.js";
import { warn } from "../io.js";
import { join } from "node:path";
import { legScenario, loadMultiLegScenario } from "./execute.js";
import { executeMultiLeg, composeScenarioVerdict, type MultiLegOutcome } from "./multi-leg.js";
import { hostActionAsserts, type Leg, type MultiLegScenario } from "./multi-leg-scenario.js";
import { compileUserRegex } from "../regex.js";
import type { ActionRecord } from "./host-action.js";
import type { ScenarioLegEntry, ScenarioVerdict } from "./scenario-result.js";
import type { VerdictSignal } from "./verdict.js";
import type { RunHooks } from "./run.js";

export type MultiLegCassetteLeg =
  | { id: string; kind: "prompt"; status: "passed" | "failed"; cassette: Cassette }
  | { id: string; kind: "action"; status: "passed" | "failed"; action: ActionRecord }
  | { id: string; kind: "prompt" | "action"; status: "skipped" };

export interface MultiLegCassette {
  $schema?: string;
  generator?: string;
  cassetteVersion: number;
  /** The frozen scenario: session and fixture cassette-relative, each prompt and assert block copied FROM its leg's
   *  (redacted) nested cassette, each host action's argv redacted. Never the raw authored text. */
  scenario: MultiLegScenario & { name: string };
  /** The scenario file this was recorded from, relative to the cassette dir (drift and --rerecord-stale). */
  scenarioSource?: string;
  legs: MultiLegCassetteLeg[];
  verdict: { pass: boolean };
}

const LegShape = z.discriminatedUnion("status", [
  z.looseObject({ id: z.string(), kind: z.enum(["prompt", "action"]), status: z.literal("skipped") }),
  z.looseObject({ id: z.string(), kind: z.enum(["prompt", "action"]), status: z.enum(["passed", "failed"]) }),
]);
const MultiLegCassetteShape = z.looseObject({
  cassetteVersion: z.number(),
  scenario: z.looseObject({ name: z.string(), session: z.string(), legs: z.array(z.looseObject({ id: z.string() })) }),
  legs: z.array(LegShape),
  verdict: z.looseObject({ pass: z.boolean() }),
});

/** Is this file a multi-leg cassette? A JSON read, no schema. */
export function isMultiLegCassetteFile(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { legs?: unknown };
    return raw !== null && typeof raw === "object" && Array.isArray(raw.legs);
  } catch {
    return false;
  }
}

/** Read and validate a multi-leg cassette; each nested prompt-leg cassette is validated as a single cassette is. */
export function readMultiLegCassette(path: string): { cassette: MultiLegCassette } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { error: `unreadable / invalid cassette JSON: ${(e as Error).message}` };
  }
  const v = (raw as { cassetteVersion?: unknown } | null)?.cassetteVersion;
  const shape = MultiLegCassetteShape.safeParse(raw);
  if (!shape.success) {
    if (typeof v === "number" && v > CASSETTE_VERSION)
      return { error: `cassette format too new: v${v} > this harness's v${CASSETTE_VERSION} — upgrade cowork-harness to read it` };
    return {
      error: `invalid multi-leg cassette: ${shape.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
    };
  }
  const c = raw as MultiLegCassette;
  // Every leg of the scenario, in order, and nothing else: a dropped or reordered leg would replay as a shorter run.
  const want = c.scenario.legs.map((l) => l.id).join(",");
  const got = c.legs.map((l) => l.id).join(",");
  if (!c.legs.length || want !== got)
    return { error: `invalid multi-leg cassette: legs [${got}] do not match the scenario's legs [${want}]` };
  for (const [i, leg] of c.legs.entries()) {
    if (leg.status === "skipped") continue;
    if (leg.kind === "prompt") {
      const r = parseCassetteObject((leg as { cassette?: unknown }).cassette);
      if ("error" in r) return { error: `legs[${i}] (${leg.id}): ${r.error}` };
    } else if (typeof (leg as { action?: unknown }).action !== "object") return { error: `legs[${i}] (${leg.id}): no action record` };
  }
  return { cassette: c };
}

/** Strings a redaction policy rewrites: the action's argv and its recorded output heads. */
function redactAction(rec: ActionRecord, policy: RedactionPolicy | undefined): ActionRecord {
  if (!policy) return rec;
  const r = (s: string) => redactText(s, policy);
  return {
    ...rec,
    argv: rec.argv.map(r),
    stdout: { ...rec.stdout, head: r(rec.stdout.head) },
    stderr: { ...rec.stderr, head: r(rec.stderr.head) },
    ...(rec.refused !== undefined ? { refused: r(rec.refused) } : {}),
    assertions: rec.assertions.map((a) => ({
      ...a,
      assertion: redactStrings(a.assertion, policy),
      ...(a.message !== undefined ? { message: r(a.message) } : {}),
    })),
  };
}

/** Every string leaf of `v` through the redaction policy (keys kept). For the parts of a multi-leg cassette's frozen
 *  scenario that no nested cassette's own redaction covers: the top-level answers, each action's status/run, and
 *  the assert blocks of action and skipped legs. */
function redactStrings<T>(v: T, policy: RedactionPolicy | undefined): T {
  if (!policy) return v;
  const walk = (x: unknown): unknown =>
    typeof x === "string"
      ? redactText(x, policy)
      : Array.isArray(x)
        ? x.map(walk)
        : x !== null && typeof x === "object"
          ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]))
          : x;
  return walk(v) as T;
}

/** `record <legs.yaml>`: run every leg, refuse a failing scenario unless --allow-failing, freeze each prompt leg through
 *  the ordinary freeze path (unwritten), redact each action record, scan, compose, and write one file. */
export async function recordMultiLeg(
  scenarioFile: string,
  opts: RecordOpts & { allowFailing?: boolean; noRedact?: boolean; allowHostInventoryFindings?: boolean },
): Promise<{ outcome: MultiLegOutcome; cassettePath: string }> {
  const ms = loadMultiLegScenario(scenarioFile);
  const cassettePath = opts.cassettePath ?? defaultCassettePath(ms.name);
  // Each prompt leg is frozen the moment it finishes: under `workdir: persistent` the next leg rewrites the shared
  // tree, so a snapshot taken after the scenario would give every leg the LAST leg's files.
  const frozenByLeg = new Map<string, Cassette>();
  const freezeLeg = async (leg: Leg, result: RunResult, outDir: string): Promise<void> => {
    // The nested freeze reads the leg's events.jsonl through a read that answers [] when the file is missing: a
    // missing or empty stream on a leg that ran must refuse here, not freeze as "ran, said nothing".
    const ev = join(outDir, "events.jsonl");
    if (!existsSync(ev) || statSync(ev).size === 0)
      throw new RecordPostRunRefusalError(`leg "${leg.id}": no events.jsonl in ${outDir}; cannot freeze it`, result);
    const frozen = await freezeRecordedRun(
      legScenario(ms, leg),
      { ...opts, cassettePath, allowFailing: true, scenarioSourceFile: undefined, skipRedactionPreflight: true },
      [dirname(scenarioFile)],
      result,
      "build",
    );
    frozenByLeg.set(leg.id, frozen.cassette!);
  };
  const outcome = await executeMultiLeg(
    ms,
    {
      command: "record",
      ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.onUnanswered !== undefined ? { onUnanswered: opts.onUnanswered, onUnansweredFlag: opts.onUnanswered } : {}),
      ...(opts.externalChannel ? { externalChannel: opts.externalChannel } : {}),
      ...(opts.llmIntent !== undefined ? { llmIntent: opts.llmIntent } : {}),
      ...(opts.llmModel !== undefined ? { llmModel: opts.llmModel } : {}),
    },
    { afterPromptLeg: (leg, result) => freezeLeg(leg, result, result.outDir) },
  );
  const sr = outcome.scenarioResult;
  const anyResult = [...outcome.legResults.values()].at(-1);
  const refuse = (msg: string): never => {
    if (anyResult) throw new RecordPostRunRefusalError(msg, anyResult);
    throw new Error(msg);
  };
  if (!sr.verdict.pass && !opts.allowFailing)
    refuse(
      `refusing to freeze a failing multi-leg run: ${(sr.verdict.failures ?? []).map((f) => f.message).join("; ")} (re-run, or --allow-failing)`,
    );
  const policyDirs = [process.cwd(), dirname(scenarioFile), dirname(cassettePath)];
  const policy = opts.noRedact ? undefined : loadRedactionPolicy(policyDirs);
  const usePolicy = policy && (policy.patterns.length || policy.keyNames.length) ? policy : undefined;

  const legs: MultiLegCassetteLeg[] = [];
  const frozenLegs: Leg[] = [];
  for (const entry of sr.legs) {
    const leg = ms.legs.find((l) => l.id === entry.id)!;
    if (entry.status === "skipped") {
      legs.push({ id: entry.id, kind: entry.kind, status: "skipped" });
      frozenLegs.push(
        leg.prompt !== undefined
          ? { ...leg, prompt: usePolicy ? redactText(leg.prompt, usePolicy) : leg.prompt, assert: redactStrings(leg.assert, usePolicy) }
          : { ...leg, assert: redactStrings(leg.assert, usePolicy), host_action: redactStrings(leg.host_action!, usePolicy) },
      );
      continue;
    }
    if (entry.kind === "action") {
      const raw = JSON.parse(readFileSync(join(outcome.outDir, "legs", entry.id, "action.json"), "utf8")) as ActionRecord;
      legs.push({ id: entry.id, kind: "action", status: entry.status, action: redactAction(raw, usePolicy) });
      frozenLegs.push({ ...leg, assert: redactStrings(leg.assert, usePolicy), host_action: redactStrings(leg.host_action!, usePolicy) });
      continue;
    }
    const lc = frozenByLeg.get(entry.id);
    if (!lc) refuse(`leg "${entry.id}": it ran but was not frozen; cannot record it`);
    legs.push({ id: entry.id, kind: "prompt", status: entry.status, cassette: lc! });
    // ONE source of truth: the frozen leg's prompt and asserts are the nested cassette's (redacted) ones.
    frozenLegs.push({ ...leg, prompt: lc!.scenario.prompt, assert: lc!.scenario.assert as unknown[] });
  }

  const frozenScenario = {
    ...ms,
    answers: redactStrings(ms.answers, usePolicy),
    session: cassetteSessionRef(ms.session, cassettePath),
    ...(ms.workspace_fixture !== undefined ? { workspace_fixture: cassetteFixtureRef(ms.workspace_fixture, cassettePath) } : {}),
    legs: frozenLegs,
  };
  const version = Math.max(
    requiredVersionFor(frozenScenario),
    ...legs.flatMap((l) => ("cassette" in l ? [l.cassette.cassetteVersion ?? 0] : [])),
  );
  const cassette: MultiLegCassette = {
    $schema: cassetteSchemaUrl(version),
    generator: "cowork-harness",
    cassetteVersion: version,
    scenario: frozenScenario,
    scenarioSource: relative(dirname(cassettePath), scenarioFile),
    legs,
    verdict: { pass: sr.verdict.pass },
  };
  // The record-time privacy scan, per nested cassette (the action records carry argv and output heads, scrubbed of
  // secrets and redacted above; their head text is scanned through a stand-in cassette carrying it as an event).
  // The frozen scenario itself (answers, action argv and status, assert blocks), outside every nested cassette.
  const scenarioLeak = classifyRecordLeak(
    { scenario: { prompt: JSON.stringify(frozenScenario), session: "", assert: [] }, events: [] } as unknown as Cassette,
    cassettePath,
    opts.allowHostInventoryFindings === true,
  );
  if (scenarioLeak.kind === "quarantine")
    refuse(`refusing to write ${cassettePath}: the frozen scenario carries THIS MACHINE's inventory.\n${scenarioLeak.detail}`);
  for (const l of legs) {
    const target: Cassette | undefined =
      "cassette" in l
        ? l.cassette
        : "action" in l
          ? ({
              scenario: { prompt: l.action.argv.join(" "), session: "", assert: [] },
              events: [
                l.action.stdout.head,
                l.action.stderr.head,
                l.action.refused ?? "",
                ...l.action.assertions.map((a) => a.message ?? ""),
              ],
            } as unknown as Cassette)
          : undefined;
    if (!target) continue;
    const leak = classifyRecordLeak(target, cassettePath, opts.allowHostInventoryFindings === true);
    if (leak.kind === "quarantine") {
      const q = quarantineCassette(
        cassette as unknown as Cassette,
        ms.name,
        cassettePath,
        ms.fidelity,
        leak.detail,
        new Date().toISOString(),
      );
      refuse(
        `refusing to write ${cassettePath}: leg "${l.id}" carries THIS MACHINE's inventory, and that path is inside a git repo.\n${leak.detail}\n` +
          `The recording was NOT discarded: it is quarantined at ${q.path}`,
      );
    } else if (leak.kind !== "ok") warn(`::warning:: [record] leg "${l.id}": ${leak.kind}:\n${leak.detail}\n`);
  }
  writeFileAtomic(cassettePath, JSON.stringify(cassette, null, 2));
  return { outcome, cassettePath };
}

/** Re-grade a host action from its record: exit code, the recorded stdout head, and the recorded file results (the
 *  action's tree is not materialized on replay). */
export function regradeRecordedAction(leg: Leg, rec: ActionRecord): ScenarioLegEntry {
  const msgs: string[] = [];
  const unavailable: string[] = [];
  if (rec.refused) msgs.push(rec.refused);
  if (rec.timedOut) msgs.push("the action timed out and was killed");
  const asserts = hostActionAsserts(leg);
  const recordedFor = (o: Record<string, unknown>) => rec.assertions.find((r) => JSON.stringify(r.assertion) === JSON.stringify(o));
  if (!rec.refused && !asserts.some((a) => (a as Record<string, unknown>).exit_code !== undefined) && rec.exitCode !== 0)
    msgs.push(`exited ${rec.exitCode}, expected 0 (default)`);
  for (const a of asserts) {
    const o = a as Record<string, unknown>;
    if (rec.refused) break;
    if (o.exit_code !== undefined) {
      if (rec.exitCode !== o.exit_code) msgs.push(`exited ${rec.exitCode}, expected ${String(o.exit_code)}`);
    } else if (typeof o.stdout_matches === "string" || typeof o.stdout_not_matches === "string") {
      const key = typeof o.stdout_matches === "string" ? "stdout_matches" : "stdout_not_matches";
      // The live grade saw the whole capture; a recorded failure stands whatever the kept head shows.
      const recorded = recordedFor(o);
      if (recorded && !recorded.pass) {
        msgs.push(recorded.message ?? `${key} ${JSON.stringify(o[key])}: failed when recorded`);
        continue;
      }
      const c = compileUserRegex(o[key] as string);
      if ("error" in c) {
        msgs.push(`bad regex in ${key}: ${c.error}`);
        continue;
      }
      const hit = c.re.test(rec.stdout.head);
      const truncated = rec.stdout.bytes > Buffer.byteLength(rec.stdout.head);
      // Past the kept head neither a match nor its absence can be shown: a no-hit there is evidence-unavailable.
      if (!hit && truncated) {
        unavailable.push(
          `${key} ${JSON.stringify(o[key])}: evidence unavailable — the recording keeps the first ${Buffer.byteLength(rec.stdout.head)} of ${rec.stdout.bytes} stdout bytes`,
        );
        continue;
      }
      const pass = key === "stdout_matches" ? hit : !hit;
      if (!pass) msgs.push(`${key} ${JSON.stringify(o[key])}: ${hit ? "matched" : "no match"} in stdout`);
    } else {
      const recorded = recordedFor(o);
      if (!recorded)
        unavailable.push(
          `${Object.keys(o)[0]}: evidence unavailable — a host action's file assertions are graded from the recording, and this one was not recorded`,
        );
      else if (!recorded.pass) msgs.push(recorded.message ?? JSON.stringify(o));
    }
  }
  const all = [...msgs, ...unavailable];
  const pass = all.length === 0;
  return {
    id: leg.id,
    kind: "action",
    status: pass ? "passed" : "failed",
    verdict: {
      pass,
      exitCode: pass ? 0 : 1,
      signals: all.map((message) => ({ code: "assertion", severity: "fail", message }) as VerdictSignal),
      guards: [],
      failures: all.map((message) => ({ kind: "assertion", message })),
    } as unknown as ScenarioVerdict,
  };
}

export interface MultiLegReplay {
  verdict: ScenarioVerdict;
  legs: ScenarioLegEntry[];
  /** Each replayed prompt leg's RunResult, in leg order. */
  results: RunResult[];
  staleness: string[];
}

/** Replay a multi-leg cassette in leg order; a failing leg stops it and later legs are skipped, as live. */
export async function replayMultiLegCassette(
  c: MultiLegCassette,
  hooks: RunHooks[],
  opts: Parameters<typeof replayCassette>[2] & { cassetteDir: string },
): Promise<MultiLegReplay> {
  const legs: ScenarioLegEntry[] = [];
  const results: RunResult[] = [];
  const staleness: string[] = [];
  let stopped: string | undefined;
  if ((c.cassetteVersion ?? 0) > CASSETTE_VERSION && !opts.bestEffortFutureCassette) {
    const message = `cassette format too new: v${c.cassetteVersion} > this harness's v${CASSETTE_VERSION} (pass --best-effort-future-cassette to attempt replay anyway)`;
    return {
      verdict: {
        pass: false,
        exitCode: 1,
        signals: [{ code: "assertion", severity: "fail", message }],
        guards: [],
        failures: [{ kind: "guard", message }],
      } as unknown as ScenarioVerdict,
      legs: [],
      results: [],
      staleness: [message],
    };
  }
  for (const rec of c.legs) {
    const leg = c.scenario.legs.find((l) => l.id === rec.id);
    if (stopped !== undefined || !leg) {
      legs.push({ id: rec.id, kind: rec.kind, status: "skipped" });
      continue;
    }
    if (rec.status === "skipped") {
      // The recording stopped before this leg: there is nothing to replay it from.
      const message = `leg ${rec.id}: evidence unavailable — the recording skipped this leg (a prior leg failed when it was recorded)`;
      legs.push({
        id: rec.id,
        kind: rec.kind,
        status: "failed",
        verdict: {
          pass: false,
          exitCode: 1,
          signals: [{ code: "assertion", severity: "fail", message }],
          guards: [],
          failures: [{ kind: "guard", message }],
        } as unknown as ScenarioVerdict,
      });
      stopped = rec.id;
      continue;
    }
    if (rec.kind === "action") {
      const e = regradeRecordedAction(leg, (rec as { action: ActionRecord }).action);
      legs.push(e);
      if (e.status !== "passed") stopped = rec.id;
      continue;
    }
    const nested = (rec as { cassette: Cassette }).cassette;
    staleness.push(...checkStaleness(nested, opts.cassetteDir).map((s) => `leg ${rec.id}: ${s}`));
    const r = await replayCassette(nested, hooks, opts);
    results.push(r);
    const verdict: ScenarioVerdict = computeVerdict(r, "replay");
    legs.push({ id: rec.id, kind: "prompt", status: verdict.pass ? "passed" : "failed", verdict });
    if (!verdict.pass) stopped = rec.id;
  }
  return { verdict: composeScenarioVerdict(legs, stopped), legs, results, staleness };
}

/** Drift of a multi-leg cassette's frozen legs against the scenario file it was recorded from: the leg list, each leg's
 *  kind, session overlay and time limits, and each prompt and action argv (compared after the same redaction
 *  the recording applied). A leg's session overlay is not in its nested cassette's session fingerprint, so this is where
 *  an overlay edit shows. Empty when the source cannot be resolved (a relocated cassette is reported by its legs' own
 *  checks) or matches. */
export function multiLegScenarioDrift(c: MultiLegCassette, cassettePath: string): string[] {
  if (!c.scenarioSource) return [];
  const src = join(dirname(cassettePath), c.scenarioSource);
  if (!existsSync(src)) return [];
  let onDisk: MultiLegScenario;
  try {
    onDisk = loadMultiLegScenario(src);
  } catch (e) {
    return [`scenario-drift: ${src} no longer loads as a multi-leg scenario (${(e as Error).message.split("\n")[0]})`];
  }
  const policy = loadRedactionPolicy([process.cwd(), dirname(src), dirname(cassettePath)]);
  const red = (t: string) => (policy.patterns.length || policy.keyNames.length ? redactText(t, policy) : t);
  const out: string[] = [];
  const ids = (l: Leg[]) => l.map((x) => `${x.id}:${x.prompt !== undefined ? "prompt" : "action"}`).join(",");
  if (ids(onDisk.legs) !== ids(c.scenario.legs))
    return [`scenario-drift: the legs changed (${ids(c.scenario.legs)} → ${ids(onDisk.legs)})`];
  if (onDisk.workdir !== c.scenario.workdir) out.push(`scenario-drift: workdir ${c.scenario.workdir} → ${onDisk.workdir}`);
  // The scenario-wide fields that shape a recording, as a single cassette's drift check covers them. The fixture is
  // stored cassette-relative, so it is compared by presence (its content has its own signature in each leg).
  const norm = (v: unknown) => JSON.stringify(v ?? null);
  for (const k of [
    "baseline",
    "fidelity",
    "lane",
    "skills",
    "requires_capabilities",
    "on_unanswered",
    "expect_denied",
    "allow_host_hooks",
  ] as const)
    if (norm(onDisk[k]) !== norm(c.scenario[k])) out.push(`scenario-drift: ${k} changed`);
  if (norm(redactStrings(onDisk.answers, policy)) !== norm(c.scenario.answers)) out.push("scenario-drift: answers changed");
  if ((onDisk.workspace_fixture === undefined) !== (c.scenario.workspace_fixture === undefined))
    out.push("scenario-drift: workspace_fixture added or removed");
  for (const leg of onDisk.legs) {
    const fr = c.scenario.legs.find((l) => l.id === leg.id)!;
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (leg.prompt !== undefined && red(leg.prompt) !== fr.prompt) out.push(`scenario-drift: leg ${leg.id}: the prompt changed`);
    if (!same(leg.session, fr.session)) out.push(`scenario-drift: leg ${leg.id}: the session overlay changed`);
    if (!same(leg.timeout_ms, fr.timeout_ms)) out.push(`scenario-drift: leg ${leg.id}: timeout_ms changed`);
    if (leg.host_action) {
      const ha = redactStrings(leg.host_action, policy);
      if (!same(ha, fr.host_action)) out.push(`scenario-drift: leg ${leg.id}: the host action changed`);
    }
  }
  return out;
}

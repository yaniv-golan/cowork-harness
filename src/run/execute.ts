import { warn } from "../io.js";
import { BoundaryError, UsageError } from "../errors.js";
import { ZodError } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve, basename, isAbsolute, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { Scenario } from "../types.js";
import type { RunResult } from "../types.js";
import { writeRunningStatus, startStatusTicker, registerRunForCrashSafety, statusLine, type RunStatusMeta } from "./run-status.js";
// Runtime-only circular import: cassette.ts imports executeScenario from here, and we import buildFingerprint
// from there. Both bindings are used only inside function bodies (call time), never at module load, so the
// ESM live-binding cycle is safe. buildFingerprint's deps (skillSourceDirs → parseSessionFile) live here, so
// the cycle is intrinsic — kept runtime-only rather than refactored.
import { buildFingerprint } from "./cassette.js";
import { assembleRunResult } from "./assemble-run-result.js";
import { loadBaseline } from "../baseline.js";
import { loadSession, resolveSessionPaths, buildLaunchPlan, userVisibleRootsFromPlan, readonlyFolderRootsFromPlan } from "../session.js";
import { spawnProtocol } from "../runtime/protocol.js";
import { spawnContainer } from "../runtime/container.js";
import { spawnHostLoop } from "../runtime/hostloop.js";
import { snapshotHostLoopWorkspace } from "../runtime/hostloop-stage.js";
import { checkHostLoopWriteConsent, logHostWriteNotice } from "../hostloop/safety.js";
import { PATH_GATE_TOOL_NAMES } from "../hostloop/pretooluse-path-hook.js";
import { spawnMicroVm } from "../runtime/microvm.js";
import {
  probeImageOmitted,
  probeMicrovmOmitted,
  detectCapabilityUse,
  capabilityPreflightDecision,
  CAPABILITY_FAMILIES,
} from "../runtime/image-capabilities.js";
import { instanceName } from "../runtime/lima.js";
import { decideLoopFromBaseline, readGateFlag } from "../loop-decision.js";
import type { WebFetchProvenance } from "../hostloop/workspace-handler.js";
import { startEgressSidecar, registerCleanup, type EgressSidecar } from "../egress/sidecar.js";
import { startEgressProxy } from "../egress/proxy.js";
import { evaluate, hostMatches, budgetFields } from "../assert.js";
import { compileUserRegex } from "../regex.js";
import { renderPrompts } from "../prompt.js";
import { makeDisplayTranslator, vmPathContextFromPlan } from "./display-translate.js";
import { writeVmPathContextFile } from "./vm-path-ctx-file.js";
import { LiveAgentSession, type SdkMcp, type HookBundle } from "../agent/session.js";
import { buildDecider, ExternalDecider, LlmDecider, type Decider, type OnUnanswered, UnansweredError } from "../decide/decider.js";
import { type DecisionChannel } from "../decide/external-channel.js";
import { claudeCliComplete } from "../decide/llm-transport.js";
import { Run, type RunRecord, type RunHooks } from "./run.js";
import { runsWriteRoot } from "./trace-view.js";
import { summarizeGateProvenance } from "./gate-provenance.js";
import { collectSecrets, scrub } from "../secrets.js";
import { indexRowFromResult, appendIndexRow } from "./run-index.js";
import { collectArtifacts } from "./artifacts.js";
import { readPreRunManifest } from "./pre-run-manifest.js";

// Moved to ./artifacts.ts so assert.ts can use it without an assert→execute import cycle;
// re-exported here for the existing importers (cassette.ts, tests).
export { collectArtifacts } from "./artifacts.js";

const RUN_RESULT_SCHEMA_URL = "https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/run-result.json";

export interface ExecuteOptions {
  session?: ReturnType<typeof loadSession>;
  /** input policy for unscripted questions/dialogs. Default: scenario.on_unanswered ?? "fail". */
  onUnanswered?: OnUnanswered;
  /** override the whole decider (replaces scripted + parity + terminal). */
  decider?: Decider;
  /** wire an ExternalDecider TERMINAL over this channel (scripted `--answer` + parity still apply first). */
  externalChannel?: DecisionChannel;
  /** stable session handle: pins the run dir + the agent's native session id (so it can be resumed). */
  sessionId?: string;
  /** resume a prior session of this id — reuse its persisted work dir + pass the agent's `--resume`. */
  resume?: boolean;
  /** --compact: suppress the INFORMATIONAL capability `::notice::` lines for shareable output. The
   *  capability probe still runs and the false-negative hard-fail still fires — only the notices go. */
  compact?: boolean;
  /** steering for the LLM decider (`on_unanswered: llm` / `--decider-llm`) — one-line test intent. */
  llmIntent?: string;
  /** override the LLM decider's answering model (`--decider-model`); falls back to env then the Sonnet default. */
  llmModel?: string;
  /** mark the run non-deterministic even if no `by:"llm"` decision (e.g. a driving agent answers via `--decider-dir`). */
  nonDeterministicHint?: boolean;
  hooks?: RunHooks[];
  /** E4: tags the run-index row this execution writes. Default "run" — the `run`/`skill` CLI commands pass
   *  their own command name through; `record`'s live execution (cassette.ts) passes "record" explicitly so
   *  a recording session isn't misread as a `run` invocation in `stats`. */
  command?: "run" | "skill" | "record";
  /** Display-translator wiring for a renderer built BEFORE this scenario's LaunchPlan/effective fidelity
   *  exist (cli.ts's `run`/`skill` renderer is constructed ahead of `executeScenario`, unlike chat.ts's,
   *  which builds its own plan first and can call makeDisplayTranslator directly). Same mutable-ref
   *  pattern as `provenanceRef` below: the caller passes a ref holding the identity function; once `plan`
   *  and `effectiveFidelity` are known (right after buildLaunchPlan, well before the child spawns or any
   *  AgentEvent can arrive), this function overwrites `.current` with the real translator. The renderer
   *  reads `translateRef.current` fresh on every event, so the late assignment is visible without needing
   *  the RenderPlan object itself to be shared. */
  translateRef?: { current: (s: string) => string };
}

/**
 * The library API: run one scenario end-to-end and return a RunResult. `cli.ts` is a
 * thin wrapper over this; the pytest `cowork` lane drives it too. Owns the run boundary
 * (egress sidecar/proxy start+teardown, env mutation, post-run scan, artifact write).
 */
/** turn a scenario name into a SAFE single directory segment — neutralize path separators and
 *  ".." so a YAML/filename-derived name can't escape `runs/`. Otherwise human-readable; the display
 *  name (scenario.name) is kept separate and unchanged.
 *
 *  Length bound: the full sanitized slug is truncated to 128 chars and a collision-avoidance suffix
 *  is appended: "-" + the first 8 hex chars of SHA-256(full-slug). This caps the segment at 137 chars
 *  (128 + 1 + 8) and prevents names that share a 128-char prefix from colliding in the filesystem.
 *  Format: <up-to-128-char-prefix>-<8-hex-chars>
 */
export function slugForPath(name: string): string {
  const full =
    name
      .split(/[/\\]/)
      .join("-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\-]+/, "") || "scenario";
  if (full.length <= 128) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, 128)}-${hash}`;
}

/** The SOURCE host paths a session stages (skills/uploads/folders/plugins, plus the session file itself).
 *  realpath-canonicalized + deduped + sorted, so the set identifies WHICH project a pinned session belongs
 *  to, invariant to launch cwd and symlinks. Used by the cross-project overwrite guard below — cwd is the
 *  wrong axis (it false-negatives when two checkouts launch from the same dir, e.g. CI / $HOME). */
export function sessionOriginSources(session: ReturnType<typeof loadSession>, sessionRef: string): string[] {
  const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir()); // match buildLaunchPlan's ~ handling
  const raw = [
    ...(sessionRef && sessionRef !== "(inline)" ? [sessionRef] : []),
    ...session.uploads,
    ...session.folders.map((f) => f.from),
    ...session.skills.local,
    ...session.plugins.local_plugins,
    ...session.plugins.remote_plugins,
    ...session.plugins.local_marketplaces,
  ].map(expand);
  // Identity is the DECLARED source set — do NOT drop missing paths. Filtering by existence would make the
  // key depend on transient filesystem state (and would diverge from buildLaunchPlan, which only drops
  // missing sources under COWORK_HARNESS_SOFT_MISSING), so a legit same-project refresh could be mis-keyed
  // as "another project" when an optional source flips presence between runs. Canonicalize a present path
  // via realpath (collapses symlinks/cwd); fall back to the lexical absolute for a not-yet-present one.
  const canon = raw.map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  });
  return Array.from(new Set(canon)).sort();
}

/** A short, deterministic identity hash for a pinned run's source set. With no on-disk sources (inline/
 *  empty session) it falls back to a cwd-derived basis — but the guard treats an EMPTY source set as
 *  UNCONFIRMABLE and never deletes on it (cwd is the false-negative axis), so this fallback is only ever a
 *  stable id for the marker, never trusted to authorize an overwrite. */
export function sessionOriginKey(sources: string[], sessionRef: string): string {
  const basis = sources.length ? sources.join("\n") : `ref:${sessionRef === "(inline)" ? resolve(".") : resolve(sessionRef)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

interface OriginMarker {
  originKey: string;
  sourceHint: string;
  createdAt: string;
}

/** Read a pinned run dir's `.origin` marker, or null if absent/malformed (→ the caller fails CLOSED:
 *  an unconfirmable origin is never deleted). */
function readOriginMarker(path: string): OriginMarker | null {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    if (m && typeof m.originKey === "string") return m as OriginMarker;
  } catch {
    /* missing or malformed */
  }
  return null;
}

export async function executeScenario(scenario: Scenario, opts: ExecuteOptions = {}): Promise<RunResult> {
  // mirror the CLI guard (cli.ts:488) — a library caller skipping the CLI would otherwise get
  // a confusing `cannot resume "undefined"` error deep inside the resume branch.
  if (opts.resume && !opts.sessionId) throw new Error("resume requires sessionId (--session-id was not provided)");

  const baseline = loadBaseline(scenario.baseline);
  const session = opts.session ?? loadSessionFromFile(scenario.session);

  // Session identity. Without a stable handle: a fresh ephemeral id (current behavior). WITH one
  // (--session-id / resume): a STABLE cwd id + run dir, so the agent's native sessionFile persists and
  // can be resumed. The agent's own session uses a UUID, persisted in a per-session manifest.
  // reject a --session-id outside the safe charset rather than collapsing it — distinct ids like
  // "a/b" and "a-b" used to map onto the SAME persisted directory (a silent collision).
  if (opts.sessionId !== undefined && !/^[A-Za-z0-9_-]+$/.test(opts.sessionId))
    throw new Error(
      `--session-id "${opts.sessionId}" may contain only letters, digits, "_" or "-" (no path separators or other characters)`,
    );
  const stable = opts.sessionId ? `sess-${opts.sessionId}` : undefined;
  const sessionId = stable ?? `local_${process.hrtime.bigint().toString(36)}`;
  // the scenario name (YAML or filename-derived) is a PATH component — slugify so a name like
  // "../x" can't place run artifacts outside runs/. The display name (scenario.name) is unchanged.
  const outDir = join(runsWriteRoot(), slugForPath(scenario.name), sessionId);
  // The marker lives at outDir/.origin — ABOVE workRoot (outDir/work/...), so it's invisible to
  // collectArtifacts / file_exists / user_visible_artifact / the trace events.jsonl scan, and untouched
  // by cpSync staging. It MUST stay here; moving it into the staged tree would surface it as an artifact.
  const originPath = join(outDir, ".origin");

  if (opts.sessionId) {
    // Pinned (`sess-<id>`) run dirs are DETERMINISTIC, so on the shared (flat) runs root two different
    // projects can resolve to the same path. Identify the run by its SOURCE content (sessionOriginSources)
    // and refuse to touch a dir that belongs to a different project — replacing the old blind rmSync,
    // which silently destroyed a colliding peer's persisted, resumable session.
    const sources = sessionOriginSources(session, scenario.session);
    const myOrigin = sessionOriginKey(sources, scenario.session);
    // A session that mounts NO source (a bare inline scenario) has no content to identify which project it
    // belongs to — its only fallback anchor is cwd, which false-negatives when two projects share a cwd.
    // Treat that identity as UNCONFIRMABLE: never auto-delete or silently resume it (fail closed). `skill`
    // runs always mount the skill dir, so the common pinned-session workflow stays confirmable.
    const confirmable = sources.length > 0;
    if (existsSync(outDir)) {
      const prior = readOriginMarker(originPath);
      // Same origin requires a CONFIRMABLE identity AND a matching marker; a missing/partial marker or an
      // unconfirmable (sourceless) identity is never "same" → fail CLOSED (throw, never rm).
      const sameOrigin = confirmable && prior?.originKey === myOrigin;
      const where = prior?.sourceHint ?? "(unknown — partial or foreign run dir)";
      if (opts.resume) {
        // --resume reuses the tree IN PLACE; doing so onto another project's (or an unconfirmable) session
        // bleeds across projects. Block unless explicitly allowed.
        if (!sameOrigin && process.env.COWORK_HARNESS_ALLOW_FOREIGN_RESUME !== "1")
          throw new Error(
            `cannot resume "${opts.sessionId}": session dir ${outDir} ` +
              (confirmable
                ? `belongs to another project at ${where}`
                : `can't be confirmed as this project's (the session mounts no source to identify it)`) +
              ` — set COWORK_HARNESS_ALLOW_FOREIGN_RESUME=1 to override, or use --run-dir`,
          );
      } else if (sameOrigin) {
        // a same-project non-resume run must be FRESH — the prior staged tree (uploads, plugins,
        // mnt/.claude agent state, outputs) would otherwise leak in via cpSync's merge semantics, and a
        // new agentSessionId would be written over stale native session files. Clear it first.
        rmSync(outDir, { recursive: true, force: true });
      } else {
        // FAIL CLOSED: never delete a dir whose origin can't be confirmed as ours (different project,
        // missing marker, or an unconfirmable sourceless identity).
        throw new Error(
          !confirmable
            ? `session id "${opts.sessionId}" has an existing run dir at ${outDir}, but this session mounts no source ` +
                `to identify it as yours — pass --run-dir, use a different --session-id, or delete ${outDir} to reset`
            : `session id "${opts.sessionId}" is already in use by another project at ${where} — ` +
                `pass --run-dir, or a different --session-id` +
                (prior ? "" : ` (or delete ${outDir} to reset)`),
        );
      }
    }
    mkdirSync(outDir, { recursive: true });
    // Write the origin marker FIRST (before session.json) to minimize the post-mkdir crash window where a
    // dir exists with no marker (which would fail closed on the next run).
    const sourceHint = sources[0] ?? (scenario.session === "(inline)" ? "(inline session)" : resolve(scenario.session));
    writeFileSync(originPath, JSON.stringify({ originKey: myOrigin, sourceHint, createdAt: new Date().toISOString() }, null, 2));
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  // status.json: writable/discoverable from the EARLIEST possible moment (right after outDir exists,
  // before any container/VM spawn), so `cowork-harness status <dir>` works even in the pre-events.jsonl
  // window `resolveStatusDir` special-cases. Printed to stderr (unconditional — matches the existing
  // `[loop] cowork → …` precedent a few lines below) so a driving agent capturing this run's stderr can
  // grab the exact dir without knowing the session id ahead of time.
  const runStatusMeta: RunStatusMeta = {
    pid: process.pid,
    scenario: scenario.name,
    fidelity: scenario.fidelity,
    sessionId,
    startedAt: Date.now(),
  };
  writeRunningStatus(outDir, runStatusMeta);
  // Raw absolute path by machine-capture contract, but suppressed under --compact/--demo so the
  // shareable "no host paths" mode doesn't leak one. status.json is still written either way — see
  // statusLine's contract note. (`--keep`/footer paths elsewhere are human-facing and DO tildeify.)
  const sLine = statusLine(outDir, !!opts.compact);
  if (sLine) process.stderr.write(sLine);

  // Crash-safety net: WITHOUT this, a throw that unwinds past executeScenario without ever reaching
  // either RunResult assembler (buildPartialResult's call site, or the success-path result below) —
  // e.g. a plain `throw new Error(...)`/BoundaryError earlier in this function, not the recoverable
  // UnansweredError path — leaves status.json frozen at "running" forever: a false "still alive" signal,
  // exactly the failure mode this feature exists to eliminate. `runCrashSafety.finalize(...)` (called at
  // both normal finalize sites in Step 4) removes this run from tracking so a clean finish is never
  // double-written; a run that's still tracked when the process actually exits gets swept to "error" by
  // the ONE shared exit listener `registerRunForCrashSafety` owns (module-level, not per-call — this is
  // what keeps `record --concurrency` batches safe: a per-call `process.on`/`process.off` pair would leak
  // a listener for every crashed-but-not-finalized scenario in the batch, since the crash path by
  // definition never reaches a `.finalize()` call to remove it). Mirrors `writeDoneMarker`'s exit-handler
  // precedent (`src/decide/external-channel.ts:58-64`); `writeJsonAtomic`'s fs calls are synchronous,
  // which a Node `"exit"` handler requires.
  const runCrashSafety = registerRunForCrashSafety(outDir, runStatusMeta);

  let agentSessionId: string | undefined;
  if (opts.sessionId || opts.resume) {
    const manifestPath = join(outDir, "session.json");
    if (opts.resume) {
      if (!existsSync(manifestPath))
        throw new Error(`cannot resume "${opts.sessionId}": no prior session at ${outDir} (run it once with --session-id first)`);
      // validate the manifest rather than silently degrading to a fresh session on a corrupt
      // or older-format file — a missing agentSessionId on the resume path is a hard error.
      agentSessionId = readSessionManifest(manifestPath, opts.sessionId ?? "");
    } else {
      agentSessionId = randomUUID(); // fresh pinned session
      writeFileSync(
        manifestPath,
        JSON.stringify({ sessionId: opts.sessionId, agentSessionId, createdAt: new Date().toISOString() }, null, 2),
      );
    }
  }

  // Resolve the effective tier BEFORE buildLaunchPlan so mount naming is tier-accurate (host-loop folders
  // use hL, VM/container use fy). `cowork` resolves to hostloop|container via the loop-decision gate.
  const effectiveFidelity =
    scenario.fidelity === "cowork" ? (decideLoopFromBaseline(baseline) === "host" ? "hostloop" : "container") : scenario.fidelity;
  if (scenario.fidelity === "cowork") process.stderr.write(`[loop] cowork → ${effectiveFidelity} (per gate 1143815894)\n`);

  // Safety design layer 1 (the load-bearing layer): hostloop with a writable connected folder gives the
  // native agent process genuine, software-checked-only host filesystem access — no container sandbox.
  // Refuse LOUD, before any spawn, unless the scenario opts in via `allow_host_writes: true`.
  if (effectiveFidelity === "hostloop") checkHostLoopWriteConsent(session, scenario.allow_host_writes ?? false);

  const plan = buildLaunchPlan(session, baseline, outDir, effectiveFidelity, !!opts.resume);
  if (agentSessionId) {
    plan.agentSessionId = agentSessionId;
    plan.resume = !!opts.resume;
  }
  // Pre-run baseline capture: only when something will consume it — the scenario asserts
  // no_unexpected_files, or this is a recording (cassettes always carry the baseline so a later
  // assert-add stays replayable without re-record). Skipping keeps the pre-spawn walk (potentially a
  // large live connected folder on hostloop) off runs that never look at it; absence stays loud.
  plan.capturePreRun = scenario.assert.some((a) => a.no_unexpected_files !== undefined) || opts.command === "record";

  // Fill in the caller's display-translate ref (see ExecuteOptions.translateRef) now that plan +
  // effectiveFidelity exist — well before the child spawns, so the renderer never sees a stale identity
  // translator once events start flowing. The translator itself gates on effectiveFidelity/shareable, so
  // this always resolves ctx unconditionally (harmless at non-hostloop tiers — the closure no-ops there).
  //
  // Item 2 (mounts.json — see vm-path-ctx-file.ts's header): persist this SAME ctx to <outDir>/mounts.json,
  // unconditionally and for EVERY tier/lane (not gated on opts.translateRef — `record` calls executeScenario
  // directly with no translateRef, and still needs a ctx file for a later `trace --translate-paths`/replay
  // reader). Reusing this one `vmPathContextFromPlan(...)` call (rather than a second, independent one)
  // guarantees the write-site and the live-translator derivations can never drift apart.
  const vmPathCtx = vmPathContextFromPlan(sessionId, plan, outDir);
  writeVmPathContextFile(outDir, vmPathCtx, effectiveFidelity);
  if (opts.translateRef) {
    opts.translateRef.current = makeDisplayTranslator({
      ctx: vmPathCtx,
      effectiveFidelity,
      shareable: !!opts.compact,
    });
  }

  const startedAt = Date.now();
  const boundaryDeps = scenario.assert.some((a) => a.egress_denied || a.egress_allowed) || scenario.expect_denied.length > 0;
  if (scenario.fidelity === "protocol" && boundaryDeps) {
    throw new BoundaryError(
      `scenario "${scenario.name}" asserts boundary behavior (egress/expect_denied) but fidelity is "protocol" (no sandbox). ` +
        `Use a sandboxed fidelity (container, microvm, or hostloop) so the limitation is actually enforced — otherwise the result is a false pass.`,
    );
  }

  const onUnanswered: OnUnanswered = scenario.on_unanswered ?? opts.onUnanswered ?? "fail";
  // This is a POLICY line (what happens IF an unscripted question arrives), not an outcome — the old
  // `unanswered questions → fail` wording read as a failure on clean runs. State it as policy + source.
  process.stderr.write(
    opts.externalChannel
      ? `[input] unscripted-question policy: live decider channel\n`
      : `[input] unscripted-question policy: ${onUnanswered} (${scenario.on_unanswered ? "scenario" : opts.onUnanswered ? "flag" : "default"})\n`,
  );

  // Secrets are needed BEFORE the decider is built — the external channel emits live, ahead of the
  // post-run file scrub. Same set is reused for the file scrub at the end.
  const secrets = collectSecrets();
  // Dialog auto-cancel: faithful 6s by default; relaxed (∞) under the external decider since the
  // caller is authoritative; `COWORK_HARNESS_DIALOG_TIMEOUT_MS` overrides either way.
  // parse the dialog timeout env var. The special values "inf", "infinite", and "-1" mean Infinity
  // (no timeout), so fail/first policies can also opt out of the 6s auto-cancel. A positive number
  // overrides the policy-based default. 0 or absent → fall through to the policy default below.
  const envDialogMsRaw = process.env.COWORK_HARNESS_DIALOG_TIMEOUT_MS ?? "";
  const envDialogMs = parseDialogTimeout(envDialogMsRaw);
  // Relax the 6s dialog auto-cancel under any deliberate, authoritative terminal: an external channel, the
  // LLM decider (a `claude -p` call would lose the 6s race), or `prompt` (a human can't answer in 6s — the
  // faithful auto-cancel would make PromptDecider's dialog branch unreachable). fail/first keep 6s.
  const dialogTimeoutMs =
    envDialogMs !== undefined
      ? envDialogMs
      : opts.externalChannel || onUnanswered === "llm" || onUnanswered === "prompt"
        ? Infinity
        : undefined;
  // A finite env-override combined with an authoritative async answerer (external channel, LLM, prompt)
  // makes withDialogTimeout() race a never-settling decider promise — on timeout the channel desyncs
  // because the late reply consumes the NEXT gate's readLine slot. There is no valid use case for this
  // combination; reject it early so the desync is impossible, not just serial-gate-guarded.
  if (envDialogMs !== undefined && isFinite(envDialogMs) && (opts.externalChannel || onUnanswered === "llm" || onUnanswered === "prompt")) {
    throw new Error(
      `COWORK_HARNESS_DIALOG_TIMEOUT_MS: cannot use a finite timeout with --decider-cmd/--decider-dir/--on-unanswered=llm/prompt — those are authoritative answerers (set to 'inf' or remove the env var)`,
    );
  }

  // Docker resources (sidecar networks/proxy + the host-loop container) are EPHEMERAL per run — name
  // them by a unique per-invocation token, NOT the (now-stable) sessionId, so a `--resume` after a
  // failed run can't collide with the prior run's leftovers. The persistent state is the work dir.
  const runToken = `r${process.hrtime.bigint().toString(36)}`;
  const runner = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";

  const containerLike = effectiveFidelity === "container" || effectiveFidelity === "hostloop";
  let egress: RunResult["egress"] = [];
  let sidecar: EgressSidecar | undefined;
  let hostProxy: ReturnType<typeof startEgressProxy> | undefined;
  let microvmProxyPort: number | undefined;
  let record: RunRecord;
  let unansweredErr: UnansweredError | undefined; // set when a gate whiffs — drives the salvage branch below
  let child: { kill?: (s?: NodeJS.Signals) => void } | undefined; // hoisted so the finally can reap a crashed/orphaned container
  let containerName: string | undefined;
  let deregisterContainerReap: (() => void) | undefined; // Ctrl-C cleanup for the agent container
  let hostEgress: { host: string; decision: "allow" | "deny" }[] | undefined; // host-routed web_fetch egress
  let hostloopHooks: HookBundle | undefined; // hostloop's PreToolUse path-gate bundle
  let hostloopPathGateFired: Set<string> | undefined; // tool_use_ids the path gate actually saw
  let l0PluginDivergence = false; // set when protocol mode runs with plugins (failing fidelity signal)
  let promptFidelityWarnings: string[] | undefined; // structured prompt warnings collected by renderPrompts
  // web_fetch provenance is gate-driven (coworkWebFetchViaApi) and host-loop only. The ref is
  // created HERE (before spawnHostLoop builds the handler) and filled with a Run-backed bundle after
  // the Run exists — the handler reads ref.current at call time (strictly after the stream starts).
  const viaApiOn = readGateFlag(baseline, "1978029737", "coworkWebFetchViaApi");
  const promptGateOn = readGateFlag(baseline, "1978029737", "coworkWebFetchPrompt");
  const provenanceRef: { current?: WebFetchProvenance } = {};

  // Pre-flight: if the skill DECLARES required capabilities and the image provably omits one, FAIL FAST here
  // — before any paid agent run — instead of burning ~12 min to reach a verdict the post-run guard already
  // knows. The author can opt out with `allow_missing_capability: true` (the fallback is equivalent), which
  // downgrades to a notice. The image probe is digest-cached, so it's shared with the post-run check (no
  // second container spawn), and it spawns a throwaway `--network none` container with no model — zero tokens.
  const declaredCaps = scenario.requires_capabilities ?? [];
  if (
    declaredCaps.length &&
    (effectiveFidelity === "container" || effectiveFidelity === "hostloop" || effectiveFidelity === "microvm") &&
    process.env.COWORK_SKIP_CAPABILITY_PROBE !== "1"
  ) {
    const omitted =
      effectiveFidelity === "microvm"
        ? probeMicrovmOmitted(instanceName(baseline))
        : probeImageOmitted({
            runtime: process.env.COWORK_CONTAINER_RUNTIME ?? "docker",
            image: process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2",
            tier: effectiveFidelity,
          });
    const allowMissing = scenario.assert.some((a) => a.allow_missing_capability === true);
    const { abort, message } = capabilityPreflightDecision(declaredCaps, omitted, allowMissing);
    if (abort) throw new BoundaryError(`[capability] ${message}`); // never gated — the safety net
    if (message && !opts.compact)
      warn(`::notice:: [capability] (pre-flight) ${message} (allow_missing_capability asserted — proceeding)\n`);
  }
  try {
    // acquire the egress sidecar / host proxy INSIDE the protected try so a throw in resource
    // acquisition OR in renderPrompts below can't leak a Docker network / a bound proxy port — the `finally`
    // tears down whatever was assigned to sidecar/hostProxy. (Previously these were acquired before the try,
    // so a renderPrompts throw skipped teardown and orphaned the resource.)
    if (containerLike) {
      // thread proxy/network EXPLICITLY into spawn opts — no process.env mutation so
      // concurrent executeScenario calls don't stomp each other's values.
      sidecar = startEgressSidecar(plan.egressAllow, outDir, runToken);
      // on Ctrl-C, reap the agent container in the "container" PHASE so it runs BEFORE the sidecar's
      // network teardown (network rm fails while the container is still attached). The thunk reads `child`/
      // `containerName` at call time (assigned below). De-registered in the finally so a clean exit doesn't
      // double-run it (and the reap is idempotent regardless).
      deregisterContainerReap = registerCleanup({
        phase: "container",
        run: () => {
          try {
            child?.kill?.("SIGKILL");
          } catch {
            /* already gone */
          }
          if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
        },
      });
    } else if (effectiveFidelity === "microvm") {
      // Bind the proxy first (port 0 → OS assigns), then read the actual port back from the live socket.
      // The firewall rule and HTTP(S)_PROXY (written in spawnMicroVm below) just need the port before the
      // agent spawns, not before the proxy binds — so proxy-first eliminates the freePort() TOCTOU window.
      hostProxy = startEgressProxy({
        allow: plan.egressAllow,
        port: process.env.COWORK_VM_PROXY_PORT ? parseEnvPort("COWORK_VM_PROXY_PORT", 0) : 0,
        logPath: join(outDir, "egress.log"),
        onDecision: (host, decision) => egress.push({ host, decision }),
      });
      await hostProxy.ready; // don't spawn the agent until the proxy is accepting (or fail loud on a bind error)
      microvmProxyPort = hostProxy.actualPort; // read from the live, still-bound socket — no TOCTOU gap
    }

    // Host-loop prompt-token substitution (P2a): renderPrompts runs BEFORE spawnHostLoop below, so these
    // host dirs are recomputed here via the SAME pure joins hostloop's own runtime uses, rather than
    // restructuring the call order. hostCwd/hostUploadsDir mirror hostOutputsDir's derivation
    // (src/runtime/hostloop.ts: `mntHost = join(resolve(outDir), "work", "session", "mnt")`) and the
    // sibling uploads dir stageHostLoopWorkspace creates there (src/runtime/hostloop-stage.ts:39).
    // hostSkillsDir mirrors hostLoopShellSection's own staged-skills check (same file) — plan.configDir's
    // skills copy is already materialized by buildLaunchPlan above, so this is a plain existence check,
    // not a restructuring; undefined (skills absent/unstaged) lets renderPrompts' fallback string stand.
    const hostLoopOpts =
      effectiveFidelity === "hostloop"
        ? (() => {
            const hostMnt = join(resolve(outDir), "work", "session", "mnt");
            const skillsDir = join(plan.configDir, "skills");
            const skillsStaged = existsSync(skillsDir) && readdirSync(skillsDir).length > 0;
            return {
              effectiveFidelity,
              hostCwd: join(hostMnt, "outputs"),
              hostUploadsDir: join(hostMnt, "uploads"),
              hostWorkspaceFolder: plan.mounts.find((m) => m.kind === "folder")?.hostPath,
              hostSkillsDir: skillsStaged ? skillsDir : undefined,
            };
          })()
        : undefined;
    const prompts = renderPrompts(baseline, session, sessionId, plan.mounts.find((m) => m.kind === "folder")?.mountPath, hostLoopOpts);
    promptFidelityWarnings = prompts.fidelityWarnings; // hoist out so RunResult construction (after try) can access it
    let sdkMcp: SdkMcp | undefined;
    if (effectiveFidelity === "hostloop") {
      const hl = spawnHostLoop(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        runToken,
        egressProxy: sidecar?.proxyUrl,
        dockerNetwork: sidecar?.network,
        provenanceRef,
      });
      child = hl.child;
      sdkMcp = hl.sdkMcp;
      containerName = hl.containerName;
      hostEgress = hl.hostEgress;
      hostloopHooks = hl.hooks;
      hostloopPathGateFired = hl.pathGateFired;
      logHostWriteNotice(
        plan.mounts.filter((mt) => mt.kind === "folder").map((mt) => ({ from: mt.hostPath, mode: mt.mode })),
        warn,
      );
      if (scenario.assert.some((a) => a.transcript_no_host_path === true) && !opts.compact)
        warn(
          `::warning:: [hostloop] scenario asserts transcript_no_host_path — hostloop's native file tools legitimately ` +
            `expose real host paths to the model, so this assertion will FAIL by design at this fidelity.\n`,
        );
    } else if (effectiveFidelity === "container") {
      const ct = spawnContainer(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        egressProxy: sidecar?.proxyUrl,
        dockerNetwork: sidecar?.network,
        runToken,
      });
      child = ct.child;
      containerName = ct.containerName; // so the Ctrl-C / finally reap removes the agent container by name
    } else if (effectiveFidelity === "microvm") {
      child = spawnMicroVm(scenario, baseline, plan, outDir, sessionId, {
        systemPromptAppend: prompts.systemPromptAppend,
        proxyPort: microvmProxyPort,
      });
    } else {
      // pass systemPromptAppend so L0 records carry Cowork framing (matches container/microvm/host-loop).
      // capture l0PluginDivergence so computeVerdict can fail the run when plugins are configured.
      const proto = spawnProtocol(scenario, baseline, plan, outDir, { systemPromptAppend: prompts.systemPromptAppend });
      child = proto.child;
      l0PluginDivergence = proto.l0PluginDivergence;
      if (scenario.assert.some((a) => a.transcript_no_host_path === true) && !opts.compact)
        warn(
          `::warning:: [protocol] scenario asserts transcript_no_host_path — protocol (L0) runs the agent's file tools ` +
            `on the real host cwd with no sealed filesystem, so this assertion will FAIL by design at this fidelity.\n`,
        );
    }

    const sessionT = new LiveAgentSession(child as any, outDir);
    // Terminal decider: an explicit external channel, else the LLM decider when `agent` is selected.
    const llmTerminal =
      onUnanswered === "llm" ? new LlmDecider(claudeCliComplete, opts.llmIntent, opts.llmModel || undefined, secrets) : undefined;
    const externalTerminal = opts.externalChannel ? new ExternalDecider(opts.externalChannel, secrets) : llmTerminal;
    const decider =
      opts.decider ?? buildDecider({ rules: scenario.answers, parity: plan.permissionParity, onUnanswered, external: externalTerminal });
    const run = new Run(sessionT, decider, opts.hooks ?? [], sessionId, dialogTimeoutMs ?? undefined);
    run.seedApprovedDomains(session.web_fetch.approved_domains); // test convenience: pre-approved web_fetch hosts
    // fill the provenance bundle (backed by Run's tracker + recorded approval) BEFORE drive().
    // Host-loop only, and only when the web_fetch-via-API gate is on; otherwise the handler stays
    // allowlist-only (ref.current undefined). Run seeds the set from turns + tool_results.
    if (effectiveFidelity === "hostloop" && viaApiOn) {
      provenanceRef.current = {
        isAllowed: (u) => run.provenanceHas(u),
        markAllowed: (u) => run.provenanceAdd(u),
        requestApproval: (d, u) => run.requestWebFetchApproval(d, u),
        promptGateOn,
        permissiveMode: plan.permissionMode === "bypassPermissions",
      };
    }
    const stopStatusTicker = startStatusTicker(outDir, runStatusMeta, () => run.partial());
    try {
      try {
        record = await run.drive(scenario.prompt, {
          subagentAppend: prompts.subagentAppend,
          sdkMcp,
          hooks: hostloopHooks,
        });
      } catch (e) {
        // An unanswered gate is recoverable: grab the in-progress record so the work done before the whiff can
        // be salvaged to disk below. Any other error is a genuine fault — keep today's fail-fast behavior.
        if (e instanceof UnansweredError) {
          unansweredErr = e;
          record = run.partial();
        } else throw e;
      }
    } finally {
      stopStatusTicker();
    }
  } finally {
    // Reap the agent container FIRST (before the sidecar networks), so a crashed/unanswered run can't
    // orphan a running container holding the network. On the success path the child has already
    // exited (--rm), so these are no-ops.
    deregisterContainerReap?.(); // normal path owns the reap below; drop the signal-time thunk
    try {
      child?.kill?.("SIGKILL");
    } catch {
      /* already gone */
    }
    if (containerName) spawnSync(runner, ["rm", "-f", containerName], { stdio: "ignore" });
    if (sidecar) {
      egress = sidecar.collect();
      sidecar.teardown();
    }
    // merge host-routed web_fetch decisions (host-loop) so they're visible to egress assertions.
    if (hostEgress?.length) egress = [...egress, ...hostEgress];
    hostProxy?.close();
  }

  // snapshot the gate rendezvous wire shapes (req/resp/.done) into the run dir BEFORE the caller
  // closes (and wipes) the channel — the forensic evidence you want after a gate bug survives --keep.
  opts.externalChannel?.snapshot?.(join(outDir, "gates"));

  // hostloop never copies connected folders into the run dir while the agent runs (they're bind-mounted
  // real host paths) — snapshot them NOW so every post-run consumer below (evaluate ctx, collectArtifacts,
  // verify-run, cassette record, detectCapabilityUse) keeps reading the same frozen tree the copy-based
  // tiers have always produced. Must run before `workRoot`-relative code below.
  if (effectiveFidelity === "hostloop") {
    try {
      snapshotHostLoopWorkspace(plan, join(outDir, "work", "session", "mnt"));
    } catch (err) {
      // On the unanswered-gate salvage path, a snapshot failure here must not replace the original
      // UnansweredError and skip partial persistence entirely — that would be worse than the folder
      // artifacts simply being incomplete. Best-effort + loud there; still hard-fail on the success path,
      // where nothing more important is being masked by throwing.
      if (unansweredErr) {
        warn(
          `::warning:: [hostloop] snapshot failed during salvage — folder artifacts may be missing from this partial result: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      } else {
        throw err;
      }
    }
  }

  const scan = scanEvents(join(outDir, "events.jsonl"));
  const workRoot = effectiveFidelity === "protocol" ? join(outDir, "work") : join(outDir, "work", "session", "mnt");

  // The runtime tripwire: if a gated tool call completed successfully with no evidence the path-containment
  // gate ever ran on it, the run's real-filesystem safety is unverified — hard-fail rather than pass silently.
  if (effectiveFidelity === "hostloop" && hostloopPathGateFired) {
    const ungated = findUngatedPathToolCalls(join(outDir, "events.jsonl"), hostloopPathGateFired);
    if (ungated.length) {
      warn(
        `::warning:: [hostloop] path-containment gate did not fire for: ${ungated.join(", ")} — real filesystem access is UNVERIFIED for this run.\n`,
      );
      record.result = "error";
    }
  }

  // User-visible roots = outputs + each connected work folder's RESOLVED mount name (derived from the
  // actual mount set, NOT a hardcoded `.projects/` prefix — folder names are now dynamic/gated). Plugins
  // are read-only inputs and are NOT visible roots. Persisted to RunResult so the plan-less lanes
  // (verify reads result.json; replay reads the cassette) match this without rebuilding a LaunchPlan.
  // Shared with the pre-run baseline walk (userVisibleRootsFromPlan) — pre and post MUST agree.
  const userVisibleRoots = userVisibleRootsFromPlan(plan);
  // Read-only (`mode: "r"`) connected-folder roots — inputs, not deliverables. Persisted so the cassette
  // recorder strips their captured BODIES (fidelity/no-bloat) and `RunResult.artifacts` excludes them
  // outright (an input is not a `file_exists` target). Does NOT change `userVisibleRoots` above.
  const readonlyFolderRoots = readonlyFolderRootsFromPlan(plan);
  // artifacts (the ENV-MANIFEST) excludes read-only inputs — a deliverable is something the agent wrote,
  // not a pre-existing input it only read.
  const captureRoots = userVisibleRoots.filter((r) => !readonlyFolderRoots.includes(r));
  // Read the pre-run baseline ONCE: the evaluate ctx and the persisted RunResult must see the same
  // value — two reads could disagree if the file were touched mid-run.
  const preRunPaths = readPreRunManifest(outDir);

  // Salvage path: the run exited on an unanswered gate. Persist a PARTIAL result.json (+ run.jsonl/trace) so
  // the artifacts the agent wrote before the whiff survive for inspection, then re-throw so the CLI still
  // exits 2. Skip assertion eval and the capability probe (a real container spawn) — a partial run has no
  // meaningful assertion or verdict outcome.
  if (unansweredErr) {
    const partialResult = buildPartialResult({
      scenarioName: scenario.name,
      prompt: scenario.prompt,
      fidelity: scenario.fidelity,
      baseline: baseline.appVersion,
      record,
      outDir,
      workRoot,
      userVisibleRoots,
      readonlyFolderRoots,
      effectiveFidelity,
      egress,
      durationMs: Date.now() - startedAt,
      unanswered: { message: unansweredErr.message, hint: unansweredErr.hint },
      fingerprint: buildFingerprint(scenario.session, baseline.appVersion, undefined, scenario.skills),
    });
    // Non-null: `durationMs` is set unconditionally just above (`Date.now() - startedAt`) — the field is
    // typed optional on RunResult/PartialResult for OTHER (non-execute.ts) producers, not this call site.
    runCrashSafety.finalize(record, "error", partialResult.durationMs!);
    writeFileSync(join(outDir, "result.json"), scrub(JSON.stringify(partialResult, null, 2), secrets));
    appendIndexRow(runsWriteRoot(), indexRowFromResult(partialResult, { command: opts.command ?? "run", partial: true }));
    writeRunJsonl(outDir, scenario, effectiveFidelity, record, egress, secrets);
    writeTrace(outDir, record, egress, secrets, partialResult.durationMs);
    scrubFileInPlace(join(outDir, "events.jsonl"), secrets);
    scrubFileInPlace(join(outDir, "control-out.jsonl"), secrets);
    // Loud PARTIAL marker so the populated artifacts are never misread as success (the no-false-green rule).
    warn(
      `::notice:: [partial] run did NOT complete (unanswered gate) — salvaged the pre-failure work to:\n` +
        `  ${outDir}\n  inspect it: cowork-harness inspect ${outDir}\n`,
    );
    throw unansweredErr;
  }

  const assertions = evaluate(scenario.assert, {
    transcript: record.transcript,
    toolsCalled: record.toolsCalled,
    subagentTools: record.subagentTools,
    egress,
    result: record.result,
    workRoot,
    userVisiblePrefixes: userVisibleRoots,
    // Read-only folder inputs are captured body-less; artifact_json must reach the same
    // evidence-unavailable verdict here as on replay (see AssertContext.readonlyFolderRoots).
    readonlyFolderRoots,
    preRunPaths,
    outputsDeletes: scan.outputsDeletes,
    questions: record.questions,
    hostPathLeaked: scan.hostPathLeaked,
    selfHealRan: scan.selfHealRan,
    subagents: record.subagents,
    gateDeliveries: record.gateDeliveries,
    toolResultTexts: record.toolResults.map((r) => r.assertText ?? r.text),
    toolResultsTruncated: record.toolResults.map((r) => r.assertText === undefined),
    skillsInvoked: record.skillsInvoked,
    skillToolAvailable: record.initTools.includes("Skill"),
    effectiveFidelity,
    // Live lane (this run's own machine) — host-shaped computer:// links (hostloop) are checked
    // DIRECTLY on the filesystem, contained to the run's real workspace roots; verify-run shares
    // this same "live" mode without hostRoots (see cli.ts's cmdVerifyRun).
    linkResolution: {
      mode: "live",
      hostRoots: [
        join(resolve(outDir), "work", "session", "mnt"),
        ...plan.mounts.filter((m) => m.kind === "folder").map((m) => m.hostPath),
      ],
    },
    ...budgetFields(record),
  });

  if (scenario.fidelity === "protocol" && (record.toolsCalled.has("WebFetch") || record.toolsCalled.has("WebSearch"))) {
    warn(`::warning:: ${scenario.name}: a network tool ran at L0 (protocol) — egress is NOT enforced here.\n`);
  }

  for (const host of scenario.expect_denied) {
    assertions.push({
      assertion: { egress_denied: host },
      pass: egress.some((e) => hostMatches(e.host, host) && e.decision === "deny"),
      message: `expected ${host} to be denied`,
    });
  }

  // Capability fidelity: on a live sandboxed tier, probe what the runtime OMITS vs the real
  // Cowork rootfs, then detect whether the skill USED an omitted family. A non-empty intersection on an
  // otherwise-green run is a likely FALSE NEGATIVE → computeVerdict fails it (unless allow_missing_capability).
  // Probing is structural (the runtime is the source of truth), so an old `:1` / custom image can't silently
  // fail-open. container/hostloop → Docker image probe; microvm → `limactl shell` guest probe. Skipped on
  // protocol/replay (no live runtime to probe) and via COWORK_SKIP_CAPABILITY_PROBE.
  let missingCapabilityUse: string[] | undefined;
  let capabilityProbe: RunResult["capabilityProbe"] = "skipped"; // default — probe didn't run this tier/lane
  let omittedFamilies: string[] | null = null; // the probe's omitted-set (null = not run / unverified)
  if (
    (effectiveFidelity === "container" || effectiveFidelity === "hostloop" || effectiveFidelity === "microvm") &&
    process.env.COWORK_SKIP_CAPABILITY_PROBE !== "1"
  ) {
    const omitted =
      effectiveFidelity === "microvm"
        ? probeMicrovmOmitted(instanceName(baseline))
        : probeImageOmitted({
            runtime: process.env.COWORK_CONTAINER_RUNTIME ?? "docker",
            image: process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2",
            tier: effectiveFidelity,
          });
    omittedFamilies = omitted;
    capabilityProbe = omitted === null ? "unverified" : "definitive"; // ran → definitive; failed → unverified
    if (omitted === null) {
      const w =
        "agent runtime could not be probed for capabilities — capability fidelity unverified (capability false-negatives won't be caught this run)";
      warn(`::warning:: [capability] (informational, unverified) ${w}\n`);
      promptFidelityWarnings = [...(promptFidelityWarnings ?? []), w];
    } else if (omitted.length) {
      // state the safety net the notice is otherwise silent about — an omitted family that the skill
      // actually USES hard-fails the run below (no silent false-pass). Tag the verdict impact so an observer
      // never reads an informational line as a failure cause (or vice-versa).
      if (!opts.compact)
        warn(
          `::notice:: [capability] (informational, guarded) this image omits: ${omitted.join(", ")} — ` +
            `if a skill actually USES one, this run HARD-FAILS (no silent false-pass). ` +
            `Only rebuild full parity (--build-arg COWORK_FULL_PARITY=1) if your skill needs them.\n`,
        );
      // The probe + hard-fail safety net runs regardless of --compact (only the informational notice above is gated).
      const used = detectCapabilityUse(join(outDir, "events.jsonl"), omitted, workRoot);
      if (used.length) {
        missingCapabilityUse = used;
        warn(
          `::warning:: [capability] (FAILED THIS RUN) the skill USED omitted capabilit(ies) [${used.join(", ")}] — likely a FALSE NEGATIVE, ` +
            `not a skill bug. Rebuild full parity (--build-arg COWORK_FULL_PARITY=1), or assert allow_missing_capability: true if the fallback is equivalent.\n`,
        );
      } else {
        // close the loop — the bare omits-notice + a green run reads as a false-green RISK unless we say
        // the guard ran and found nothing. Emit ONLY here (probe ran, families omitted), never in the
        // omitted===null unverified branch (which has no basis to claim "not used").
        if (!opts.compact)
          warn(`::notice:: [capability] (informational, guarded) omitted families were not used this run → no false-negative.\n`);
      }
    }
  }

  // a skill can DECLARE the capability families its core path needs. If the running tier omits one
  // (clause a) or can't verify them — protocol/replay/skip (clause b) — the run hard-fails (computeVerdict),
  // closing the false-green for extraction-heavy skills. Computed at run time so verify-run/replay honor the
  // recorded outcome (a clean full-parity run records nothing → no false-fail on later verify-run).
  let requiresCapabilityUnmet: RunResult["requiresCapabilityUnmet"];
  const requiredCaps = scenario.requires_capabilities ?? [];
  if (requiredCaps.length) {
    const known = new Set(Object.keys(CAPABILITY_FAMILIES));
    const unknown = requiredCaps.filter((c) => !known.has(c));
    if (unknown.length)
      warn(
        `::warning:: [capability] requires_capabilities lists unknown famil(ies): ${unknown.join(", ")} — known: ${[...known].join(", ")}\n`,
      );
    if (capabilityProbe === "definitive") {
      const missing = requiredCaps.filter((c) => omittedFamilies?.includes(c));
      if (missing.length) requiresCapabilityUnmet = { caps: missing, reason: "omitted" };
    } else {
      // skipped (protocol/replay/skip-env) or unverified — cannot confirm the declared caps are present.
      requiresCapabilityUnmet = { caps: requiredCaps, reason: "unverifiable" };
      warn(
        `::warning:: [capability] (FAILED THIS RUN) skill declares requires_capabilities [${requiredCaps.join(", ")}] but this tier ` +
          `cannot verify them (${capabilityProbe}) — run on a live built-image tier, or assert allow_missing_capability: true.\n`,
      );
    }
  }

  // Gate provenance: how each AskUserQuestion gate was answered (scripted / decided / first / prompt).
  // Derived from the same decision log the envelope persists; `undefined` when the run had no gates so
  // the field self-suppresses. Informational — never affects the verdict. `record.decisions`
  // (DecisionRecord[], `by: string`) is assignable to the summarizer's `by?: string` param — no re-map.
  const gateProvenance = summarizeGateProvenance(record.decisions);

  const result: RunResult = assembleRunResult({
    $schema: RUN_RESULT_SCHEMA_URL,
    generator: "cowork-harness",
    scenario: scenario.name,
    prompt: scenario.prompt, // persisted for `scaffold <run-dir>`
    fidelity: scenario.fidelity,
    baseline: baseline.appVersion,
    result: record.result,
    resultErrorKind: record.resultErrorKind, // transport vs agent classification of a result:"error"
    stalledOnQuestion: record.stalledOnQuestion, // run ended on an unanswered plain-text question
    decisions: record.decisions.map((d) => ({
      kind: d.kind,
      name: d.name,
      decision: d.decision,
      by: d.by,
      model: d.model,
      detail: d.detail,
      rationale: d.rationale,
    })),
    toolCounts: record.toolCounts,
    gateDeliveries: record.gateDeliveries,
    egress,
    assertions,
    toolResults: record.toolResults,
    subagents: record.subagents,
    nonReproducibleAnswers: record.unanswered,
    usage: record.usage,
    cost: record.cost,
    skillsInvoked: record.skillsInvoked,
    skillToolAvailable: record.initTools.includes("Skill"),
    durationMs: Date.now() - startedAt,
    outDir,
    workDir: workRoot,
    outputsDir: join(workRoot, "outputs"),
    userVisibleRoots,
    readonlyFolderRoots,
    artifacts: collectArtifacts(workRoot, captureRoots), // ENV-MANIFEST: observed user-visible files (excl. read-only inputs)
    // The pre-spawn baseline no_unexpected_files diffs against (same single read the evaluate ctx got).
    // undefined = the run didn't capture (key not asserted, microvm, pre-seam) — the assertion then
    // fails evidence-unavailable, loud.
    preRunPaths,
    nonDeterministic:
      // LLM-, external-, human-, or first-option-decided → not reproducible. `first` picks options[0] and
      // option order can vary run-to-run; it's already pushed to unanswered[], so include it here to agree.
      record.decisions.some((d) => d.by === "llm" || d.by === "external" || d.by === "human" || d.by === "first") ||
      !!opts.nonDeterministicHint,
    nonDeterministicTerminal: onUnanswered === "llm" || onUnanswered === "prompt" || !!opts.externalChannel,
    gateProvenance: gateProvenance.total ? gateProvenance : undefined,
    permissiveAutoAllow: record.permissiveAutoAllow.length ? record.permissiveAutoAllow : undefined, // cowork-parity off-registry auto-allows (real Cowork blocks) — non-empty ⇒ NOT a faithful pass
    scan, // post-run scan signals (delete-in-outputs / host-path-leak / self-heal) — computeVerdict default-fails when unasserted
    effectiveFidelity, // The tier actually used — differs from fidelity when fidelity:"cowork"
    fidelityWarnings: promptFidelityWarnings, // structured prompt warnings visible to JSON callers
    l0PluginDivergence: l0PluginDivergence || undefined, // failing fidelity signal for protocol+plugins
    missingCapabilityUse, // capability fidelity: omitted-capability families the skill used (live built-image tiers) — computeVerdict fails unless allow_missing_capability
    capabilityProbe, // probe outcome (definitive | unverified | skipped) for the guard roster
    requiresCapabilityUnmet, // declared requires_capabilities the tier couldn't satisfy → computeVerdict fails unless allow_missing_capability
    // Skill staleness fingerprint, persisted on EVERY run (runs are always kept on disk) so `verify-run` can
    // detect a kept run that predates a skill change and refuse to vouch for answer-coverage. Same call the
    // record path uses for the cassette (cassette.ts) — `(inline)`/no-skill sessions yield a {baseline}-only fp.
    fingerprint: buildFingerprint(scenario.session, baseline.appVersion, undefined, scenario.skills),
    // Fields this lane has NEVER set (were implicitly `undefined` before this refactor; now explicit
    // per assembleRunResult's contract — this line makes the omission a reviewable, greppable fact
    // instead of an invisible one):
    partial: undefined,
    unansweredGate: undefined,
    staleness: undefined,
    skippedAssertions: undefined,
  });

  // Non-null: see the matching comment at the partial-result finalize call above.
  runCrashSafety.finalize(record, result.result, result.durationMs!);

  // Artifacts: the harness-observability log `run.jsonl` REPLACES transcript.json/decisions.jsonl.
  writeFileSync(join(outDir, "result.json"), scrub(JSON.stringify(result, null, 2), secrets));
  appendIndexRow(runsWriteRoot(), indexRowFromResult(result, { command: opts.command ?? "run", partial: false }));
  writeRunJsonl(outDir, scenario, effectiveFidelity, record, egress, secrets);
  writeTrace(outDir, record, egress, secrets, result.durationMs);
  scrubFileInPlace(join(outDir, "events.jsonl"), secrets);
  scrubFileInPlace(join(outDir, "control-out.jsonl"), secrets);
  return result;
}

export function parseSessionFile(path: string): unknown {
  if (path === "(inline)") return {};
  return parseYaml(readFileSync(path, "utf8"));
}

const isFileRelative = (p: string) => p !== "(inline)" && !isAbsolute(p) && !p.startsWith("~");

/**
 * Parse a scenario file and resolve its `session:` reference relative to the SCENARIO
 * file's directory (not the cwd), so a scenario+session bundle is self-contained and
 * relocatable. Use this everywhere a scenario is read from disk (`run`, `record`).
 */
export function parseScenarioFile(path: string): Scenario {
  let scenario: Scenario;
  try {
    scenario = Scenario.parse(parseYaml(readFileSync(path, "utf8")));
  } catch (e) {
    // A schema violation is a USER mistake (a typo'd/retired key like `profile:`, a bad enum value),
    // not a harness bug — rethrow as UsageError so main().catch maps it to category `usage`, not
    // `internal`. The Zod issue list stays in the message (it names the offending key/value).
    if (e instanceof ZodError) throw new UsageError(`invalid scenario ${path}: ${e.message}`);
    throw e;
  }
  // `name` defaults to the filename (sans extension) — the file is the identity.
  if (!scenario.name) scenario.name = basename(path).replace(/\.ya?ml$/i, "");
  if (isFileRelative(scenario.session)) scenario.session = resolve(dirname(path), scenario.session);
  // Load-time regex validation: fail fast with a clear message rather than letting a malformed pattern
  // crash the run at evaluate() time. NOTE: CLI-supplied rules (--answer/--answer-policy) do NOT
  // pass through here — the runtime try/catch in assert.ts and decider.ts is their safety net.
  validateScenarioRegexes(scenario, path);
  return scenario;
}

/** Validate all user-supplied regex patterns in a scenario at load time. Throws on the first bad pattern. */
function validateScenarioRegexes(scenario: Scenario, scenarioPath: string): void {
  const context = `scenario "${scenario.name ?? scenarioPath}"`;
  // `replay_protocol_fidelity` is synthesized by the replay lane only — authored in a live scenario it
  // has no check() branch and always evaluates to "empty assertion". Reject it at load (loud footgun fix).
  for (const a of scenario.assert) {
    if (a.replay_protocol_fidelity !== undefined)
      throw new Error(
        `${context}: \`replay_protocol_fidelity\` is synthesized by the replay lane and cannot be authored in a scenario — remove it (it would evaluate as "empty assertion" on a live run).`,
      );
  }
  // assert[] patterns
  for (const a of scenario.assert) {
    for (const key of ["transcript_matches", "transcript_not_matches", "question_asked", "subagent_dispatched"] as const) {
      const pattern = a[key];
      if (pattern !== undefined) {
        const c = compileUserRegex(pattern);
        if ("error" in c) throw new Error(`bad regex in ${key} in ${context}: ${c.error}`);
      }
    }
  }
  // answers[].when_question patterns (ScriptedDecider uses these)
  for (const rule of scenario.answers) {
    if (rule.when_question !== undefined) {
      const c = compileUserRegex(rule.when_question);
      if ("error" in c) throw new Error(`bad regex in when_question in ${context}: ${c.error}`);
    }
  }
}

/** Load a session from a file and resolve its internal host paths relative to the session
 * file's own directory (see {@link resolveSessionPaths}). Exported for E3 (matrix runner) — cli.ts loads
 * the base session ONCE per matrix run, then applies per-cell overrides (applySessionOverrides,
 * session.ts) on top of the SAME loaded+resolved object, rather than re-resolving paths per cell. */
export function loadSessionFromFile(sessionRef: string): ReturnType<typeof loadSession> {
  const baseDir = sessionRef === "(inline)" ? process.cwd() : dirname(resolve(sessionRef));
  return resolveSessionPaths(loadSession(parseSessionFile(sessionRef)), baseDir);
}

/** the harness-observability JSONL — lifecycle + decisions(by) + subagents + egress + cost. */
function writeRunJsonl(
  outDir: string,
  scenario: Scenario,
  fidelity: string,
  rec: RunRecord,
  egress: RunResult["egress"],
  secrets: string[],
) {
  const lines = [
    { t: "run", scenario: scenario.name, fidelity, runId: rec.runId, result: rec.result, cwd: rec.cwd },
    { t: "init", tools: rec.initTools.length },
    ...rec.decisions.map((d) => ({ t: "decision", ...d })),
    ...rec.subagents.map((s) => ({ t: "subagent", ...s })),
    ...rec.unanswered.map((u) => ({ t: "unanswered", ...u })),
    ...rec.gateDeliveries.map((g) => ({ t: "gate_delivery", ...g })),
    ...egress.map((e) => ({ t: "egress", ...e })),
    { t: "transcript", text: rec.transcript },
    { t: "tool_counts", counts: rec.toolCounts },
    { t: "cost", usage: rec.usage, metrics: rec.cost },
  ];
  writeFileSync(join(outDir, "run.jsonl"), scrub(lines.map((l) => JSON.stringify(l)).join("\n"), secrets));
}

/** Assemble a RunResult for a run that did NOT complete — it exited on an unanswered gate. The work the
 *  agent did before the whiff (artifacts on disk, the partial transcript, decisions/tool counts so far) is
 *  salvaged so the paid run is still inspectable instead of vanishing. Deliberately reduced: no assertion
 *  outcome (a partial run has none) and no capability/verdict fields (those would need a probe we skip).
 *  `partial:true` is the signal that lets consumers (verify-run, scaffold, the footer) refuse to read its
 *  populated `artifacts[]` as a passing run. */
export function buildPartialResult(args: {
  scenarioName: string;
  prompt: string;
  fidelity: string;
  baseline: string;
  record: RunRecord;
  outDir: string;
  workRoot: string;
  userVisibleRoots: string[];
  readonlyFolderRoots: string[];
  effectiveFidelity: string;
  egress: { host: string; decision: "allow" | "deny" }[];
  durationMs: number;
  unanswered: { message: string; hint?: string };
  fingerprint?: RunResult["fingerprint"];
}): RunResult {
  const { record } = args;
  const gp = summarizeGateProvenance(record.decisions);
  return assembleRunResult({
    $schema: RUN_RESULT_SCHEMA_URL,
    generator: "cowork-harness",
    scenario: args.scenarioName,
    prompt: args.prompt,
    fidelity: args.fidelity,
    baseline: args.baseline,
    result: "error",
    partial: true,
    unansweredGate: { message: args.unanswered.message, ...(args.unanswered.hint ? { hint: args.unanswered.hint } : {}) },
    decisions: record.decisions.map((d) => ({
      kind: d.kind,
      name: d.name,
      decision: d.decision,
      by: d.by,
      model: d.model,
      detail: d.detail,
      rationale: d.rationale,
    })),
    toolCounts: record.toolCounts,
    gateDeliveries: record.gateDeliveries,
    egress: args.egress,
    assertions: [],
    toolResults: record.toolResults,
    subagents: record.subagents,
    nonReproducibleAnswers: record.unanswered,
    usage: record.usage,
    cost: record.cost,
    skillsInvoked: record.skillsInvoked,
    skillToolAvailable: record.initTools.includes("Skill"),
    durationMs: args.durationMs,
    outDir: args.outDir,
    workDir: args.workRoot,
    outputsDir: join(args.workRoot, "outputs"),
    userVisibleRoots: args.userVisibleRoots,
    readonlyFolderRoots: args.readonlyFolderRoots,
    artifacts: collectArtifacts(
      args.workRoot,
      args.userVisibleRoots.filter((r) => !args.readonlyFolderRoots.includes(r)),
    ),
    preRunPaths: readPreRunManifest(args.outDir),
    effectiveFidelity: args.effectiveFidelity,
    gateProvenance: gp.total ? gp : undefined,
    fingerprint: args.fingerprint,
    // Fields this lane deliberately never sets (per this function's own doc comment: "no capability/
    // verdict fields") — now explicit instead of implicit:
    resultErrorKind: undefined,
    stalledOnQuestion: undefined,
    capabilityProbe: undefined,
    requiresCapabilityUnmet: undefined,
    nonDeterministic: undefined,
    nonDeterministicTerminal: undefined,
    permissiveAutoAllow: undefined,
    scan: undefined,
    fidelityWarnings: undefined,
    l0PluginDivergence: undefined,
    missingCapabilityUse: undefined,
    staleness: undefined,
    skippedAssertions: undefined,
  });
}

/** the structured run trace. */

function writeTrace(outDir: string, rec: RunRecord, egress: RunResult["egress"], secrets: string[], durationMs?: number) {
  const trace = {
    steps: [...rec.toolsCalled],
    toolCounts: rec.toolCounts, // truthful per-tool call counts (host-routed WebSearch shows here, not usage.server_tool_use)
    questions: rec.questions,
    subagents: rec.subagents,
    gateDeliveries: rec.gateDeliveries, // per-gate answer delivery
    egress,
    decisions: rec.decisions,
    durationMs,
    cost: rec.cost ?? rec.usage ?? null, // cost comes from api_metrics/usage, not just `result`
  };
  writeFileSync(join(outDir, "trace.json"), scrub(JSON.stringify(trace, null, 2), secrets));
}

function scrubFileInPlace(path: string, secrets: string[]) {
  if (!secrets.length) return;
  try {
    const content = readFileSync(path, "utf8");
    const scrubbed = scrub(content, secrets);
    if (scrubbed !== content) writeFileSync(path, scrubbed);
  } catch {
    /* file may not exist (e.g. no control-out at protocol fidelity) */
  }
}

/**
 * detect a host filesystem path leaking into agent-visible text. The original regex was
 * macOS-centric (`/Users/`, `/opt/cowork/`) and false-passed `transcript_no_host_path` on Linux CI
 * where host paths are under `/home/` or `/root/`.
 *
 * Anchoring: each host root is preceded by a boundary char `(^|[\s"'(=:])` — start-of-string or a
 * whitespace/quote/paren/equals/colon — to limit false positives (e.g. a substring like
 * `whatever/home/x` won't match, only a path-like `/home/...`). The legitimate in-VM path
 * `/sessions/<id>/mnt/...` is NOT a host root, and the in-VM HOME is `/tmp`, so `/home/`//`/root/`
 * do not normally appear there.
 *
 * The boundary also allows a `file://[authority]` prefix so file-URI leaks are caught: in
 * `file:///Users/alice` the char before `/Users/` is the path's own `/`, which is NOT in the class,
 * so the bare anchor would miss it. `file:\/\/[^\s\/]*` consumes the optional authority (empty or a
 * host like `localhost`) and lets the path root match. URL-encoded (`%2FUsers`) and backslash
 * (`file:\\host\Users`) forms ARE now covered (see the decode+normalize pass in the body); the Windows
 * `file:///C:/Users/` form is caught incidentally via the drive-letter `:` boundary.
 */
export function hostPathLeaked(text: string): boolean {
  const re = /(^|[\s"'(=:]|file:\/\/[^\s\/]*)(\/Users\/|\/opt\/cowork\/|\/home\/|\/root\/)/;
  if (re.test(text)) return true;
  // also catch URL-encoded (%2FUsers%2F) and backslash (file:\\host\Users) forms by testing a
  // decoded + backslash-normalized copy. Decode each `%`-escape RUN independently rather than the
  // whole string: decodeURIComponent over the entire text throws on ANY stray `%` (e.g. `build 100%
  // done`), which would silently disable the encoded re-test even when a genuine `%2Fhome%2Fvictim`
  // is also present. An undecodable run is left verbatim.
  const decoded = text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
  const normalized = decoded.replace(/\\/g, "/");
  return normalized !== text && re.test(normalized);
}

// rm-family deletes PLUS shell empty-truncation idioms that wipe a file as destructively as `rm`:
// a STATEMENT-LEADING bare `>` (`> outputs/x`, `make && > outputs/x`) and zero-arg `echo >`. The
// redirect `>` is anchored to a statement boundary (start / `\n` / `;` / `|` / `&&` / `||` — the same
// boundaries splitStatements splits on) so a normal deliverable WRITE (`jq … > outputs/f`, where `>`
// follows a command) is NOT flagged; `(?!>)` excludes append (`>>`) and `&>` carries a single `&` that
// is not in the boundary set.
const DELETE_TOKEN =
  /\b(rm|unlink|rmdir|shred|truncate)\b|\bfind\b[^\n]*-delete\b|\bos\.(remove|unlink|rmdir)\b|\bshutil\.rmtree\b|\.unlink\(|(?:^|[\n;|]|&&|\|\|)\s*>(?!>)|\becho\s*>(?!>)/;
// `outputs` MENTIONED as a path segment (followed by `/` or a boundary) — broad, used for the conservative
// rm co-occurrence + ambiguous-mv branch. The negative lookahead avoids `outputs.txt` / `myoutputs`.
const TOUCHES_OUTPUTS = /(^|[\s"'`(/])(mnt\/)?outputs(?![\w.])/;
// `outputs` as a real path COMPONENT (preceded by start/`/`, followed by `/` or end) — used for mv direction
// so a dst like `/tmp/outputs-backup` is NOT mistaken for being inside outputs/.
const UNDER_OUTPUTS = /(^|\/)(mnt\/)?outputs(\/|$)/;
const CD_INTO_OUTPUTS = /\b(cd|pushd)\s+["']?(mnt\/)?outputs(?![\w.])/;

/** Configured safe-staging prefixes (opt-in, no default — `/tmp` is NOT assumed scratch since a skill may
 *  stage deliverables there). Set COWORK_HARNESS_SAFE_STAGING_PREFIX to a comma-separated list to enable
 *  rm-suppression for deletes provably scoped under those prefixes. */
function safePrefixes(): string[] {
  return (process.env.COWORK_HARNESS_SAFE_STAGING_PREFIX ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.endsWith("/") ? p : p + "/"));
}

/** Substitute simple `NAME=VALUE` assignments into later `$NAME`/`${NAME}` uses. Conservative: skips
 *  command-substituted values (`$(...)`/backticks) so an unresolved indirect target is never treated as
 *  resolved (and therefore never "provably safe"). */
function expandSimpleVars(cmd: string): string {
  const vars = new Map<string, string>();
  const assign = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g;
  const record = (part: string): void => {
    assign.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = assign.exec(part))) {
      const v = m[3].replace(/^['"]|['"]$/g, "");
      if (/\$\(|`/.test(v)) continue;
      vars.set(m[2], v);
    }
  };
  const expand = (part: string): string => {
    let s = part;
    // `() => v` (function replacer) inserts the value literally — a raw `String.replace` string would
    // treat `$&`/`$1` in an agent-controlled value as special and corrupt the expansion.
    for (const [k, v] of vars) s = s.replace(new RegExp(`\\$\\{${k}\\}|\\$${k}\\b`, "g"), () => v);
    return s;
  };
  // Expand in SOURCE ORDER so a later reassignment cannot retroactively change an earlier `$NAME`
  // use (`D=outputs; rm "$D/x"; D=/sandbox` must expand the rm to `outputs/x`, not `/sandbox/x`).
  // Capturing-split keeps the separators verbatim, so concatenation round-trips byte-identically.
  // Each segment is expanded against the vars known so far, then its OWN assignments are recorded
  // from the ORIGINAL (un-expanded) text — preserving the single-pass, non-chaining semantics.
  const parts = cmd.split(/(\n|;|&&|\|\|)/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out += parts[i]; // separator — emit verbatim
      continue;
    }
    out += expand(parts[i]);
    record(parts[i]);
  }
  return out;
}

function splitStatements(cmd: string): string[] {
  return cmd
    .split(/\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Non-flag argument tokens of a statement (lightweight word split — NOT a full shell tokenizer; a quoted
 *  path with spaces mis-splits toward MORE matches, never fewer, so it cannot cause a false negative). */
function nonFlagArgs(stmt: string): string[] {
  return stmt
    .split(/\s+/)
    .slice(1)
    .filter((t) => t && !t.startsWith("-"))
    .map((t) => t.replace(/^['"]|['"]$/g, ""));
}

/** An `mv` statement is a delete-from-outputs when it moves a file OUT of outputs (src UNDER outputs, dst
 *  NOT under outputs). Moving INTO outputs is not a delete. Ambiguous mv (`-t`/`--target-directory`, ≠2
 *  operands) → flag only if it mentions outputs (conservative — never a false negative). */
function mvDeletesOutputs(stmt: string): boolean {
  if (!/\bmv\b/.test(stmt)) return false;
  if (/(^|\s)(-t|--target-directory)\b/.test(stmt)) return TOUCHES_OUTPUTS.test(stmt);
  const ops = nonFlagArgs(stmt);
  if (ops.length < 2) return TOUCHES_OUTPUTS.test(stmt);
  // N-ary `mv src… dst`: the last operand is the destination, the rest are sources. A delete-from-
  // outputs is when some source is UNDER outputs and the destination is NOT (reduces to the src/dst
  // logic at length 2). `mv a.pdf b.pdf outputs/` (moving INTO outputs) is therefore not a delete.
  const dst = ops[ops.length - 1];
  const sources = ops.slice(0, -1);
  return sources.some((src) => UNDER_OUTPUTS.test(src)) && !UNDER_OUTPUTS.test(dst);
}

/**
 * A bash command deletes in outputs when (a) an `mv` moves a file OUT of outputs, or (b) an rm-family
 * delete (`rm/unlink/rmdir/shred/truncate`, `find … -delete`, python os.remove/unlink/rmdir/shutil.rmtree,
 * pathlib `.unlink()`) co-occurs with an `outputs/` reference. mv-direction is always evaluated (fixes the
 * move-INTO false positive without losing the move-OUT true positive). For the rm family the DEFAULT is
 * conservative (flag any co-occurrence — current behavior); when the operator opts in via
 * COWORK_HARNESS_SAFE_STAGING_PREFIX, a delete is suppressed only when provably scoped to a configured
 * prefix and outputs is referenced only by non-delete statements. Unresolved/command-substituted targets
 * are never "provably safe". Pure + exported so the rule is directly unit-testable. RESIDUAL GAP: a delete
 * via a script file / renamed binary / non-bash tool still evades this post-hoc scan — real enforcement is
 * the deferred FUSE/MCP sub-project.
 */
export function isOutputsDelete(cmd: string): boolean {
  const expanded = expandSimpleVars(cmd);
  for (const stmt of splitStatements(expanded)) if (mvDeletesOutputs(stmt)) return true; // mv: always-on, direction-aware
  if (!DELETE_TOKEN.test(expanded) || !TOUCHES_OUTPUTS.test(expanded)) return false; // rm-family fast path
  const prefixes = safePrefixes();
  if (prefixes.length === 0) return true; // no opt-in → flag the co-occurrence (unchanged default behavior)
  if (CD_INTO_OUTPUTS.test(expanded)) return true; // a cwd-relative delete could hit outputs
  for (const stmt of splitStatements(expanded)) {
    if (!DELETE_TOKEN.test(stmt)) continue;
    if (TOUCHES_OUTPUTS.test(stmt)) return true; // a delete statement itself names outputs
    const targets = nonFlagArgs(stmt);
    const allSafe = targets.length > 0 && targets.every((t) => prefixes.some((pre) => t.startsWith(pre)));
    if (!allSafe) return true; // unprovable (incl. unexpanded/command-subst vars) → flag
  }
  return false; // every rm delete is provably under a safe prefix; outputs ref was non-delete only
}

/** the operative delete statement(s) within a command that `isOutputsDelete` flagged — for a readable
 *  finding. The raw `cmd.slice(0,120)` truncated away the actual `rm` when a long `VAR=…` assignment prefix
 *  preceded it (the finding then showed only the assignment block). This surfaces the delete/mv itself, with
 *  simple `VAR=literal` assignments resolved so the real target path is visible. Falls back to the whole
 *  (expanded) command if no single statement isolates the delete. Bounded length for the stored finding. */
export function outputsDeleteSnippet(cmd: string): string {
  // Iterate var expansion to a fixed point so CHAINED assignments (ARTIFACTS_ROOT → ANALYSIS_DIR → rm) fully
  // resolve in the displayed path. (Detection keeps the single-pass `expandSimpleVars` — its semantics are
  // pinned by tests; multi-pass here only sharpens the finding, never changes what gets flagged.)
  let expanded = cmd;
  for (let i = 0; i < 5; i++) {
    const next = expandSimpleVars(expanded);
    if (next === expanded) break;
    expanded = next;
  }
  const ops = splitStatements(expanded).filter((s) => mvDeletesOutputs(s) || DELETE_TOKEN.test(s));
  return (ops.length ? ops.join("; ") : expanded).trim().slice(0, 160);
}

/** Scan a run's events.jsonl for limitation-fidelity signals (moved from cli.ts). */
export function scanEvents(file: string): { outputsDeletes: string[]; hostPathLeaked: boolean; selfHealRan: boolean } {
  const out = { outputsDeletes: [] as string[], hostPathLeaked: false, selfHealRan: false };
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return out;
  }
  const selfHealRe = /\/sessions\/[^\s"]*\/mnt\/\.local-plugins/;
  for (const l of lines) {
    let msg: any;
    try {
      msg = JSON.parse(l);
    } catch {
      continue;
    }
    // host-path leaks can appear in tool_result blocks (Bash stdout/stderr) and user messages,
    // not just assistant text. Scan both assistant and user messages; keep the Bash delete/self-heal
    // detection assistant-only (those are tool_use blocks the agent emits).
    if (msg.type !== "assistant" && msg.type !== "user" && msg.type !== "system") continue;
    // A standalone `system` message carries top-level string content (no message.content array).
    if (msg.type === "system" && typeof msg.content === "string" && hostPathLeaked(msg.content)) out.hostPathLeaked = true;
    for (const block of msg.message?.content ?? []) {
      // A `thinking` block can leak a host path in the reasoning text (e.g. quoting an absolute path).
      if (block.type === "thinking") {
        const t = block.thinking ?? block.text;
        if (typeof t === "string" && hostPathLeaked(t)) out.hostPathLeaked = true;
      }
      // delete/self-heal detection must cover BOTH bash surfaces — native `Bash` (container/microvm
      // tiers) AND `mcp__workspace__bash` (host-loop, where native Bash is disabled). Same `command`
      // input shape. Missing the MCP name was a host-loop blind-spot in the post-hoc backstop.
      if (block.type === "tool_use" && (block.name === "Bash" || block.name === "mcp__workspace__bash") && msg.type === "assistant") {
        const cmd = String(block.input?.command ?? "");
        if (isOutputsDelete(cmd)) out.outputsDeletes.push(outputsDeleteSnippet(cmd));
        if (selfHealRe.test(cmd)) out.selfHealRan = true;
      }
      if (block.type === "text" && typeof block.text === "string" && hostPathLeaked(block.text)) out.hostPathLeaked = true;
      if (block.type === "tool_result") {
        // tool_result.content is a string or an array of {type:"text", text} blocks (Bash output, etc.)
        const c = block.content;
        if (typeof c === "string") {
          if (hostPathLeaked(c)) out.hostPathLeaked = true;
        } else if (Array.isArray(c)) {
          for (const sub of c) if (typeof sub?.text === "string" && hostPathLeaked(sub.text)) out.hostPathLeaked = true;
        }
      }
    }
  }
  return out;
}

/**
 * The hostloop runtime tripwire: a working PreToolUse path gate produces an observable hook callback for
 * every gated tool_use. Walk `events.jsonl`'s assistant tool_use blocks whose name is gated (Read/Write/
 * Edit/Glob/Grep/MultiEdit); any block whose id is absent from `gateFired` AND whose matching tool_result
 * was observed non-error means the call completed with NO evidence the gate ever ran on it. This turns a
 * hypothetical future binary version that silently stops firing hooks for pre-approved tools into a hard
 * run failure instead of a silent, unverifiable pass — the same check the chat lane's tripwireHook runs
 * live, applied here to the recorded event stream. Returns the ungated tool names, for the caller's message.
 */
export function findUngatedPathToolCalls(file: string, gateFired: Set<string>): string[] {
  const GATED = new Set(["Read", "Write", "Edit", "Glob", "Grep", "MultiEdit"]);
  const toolUseIdToName = new Map<string, string>();
  const toolResultIsError = new Map<string, boolean>();
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").trim().split("\n");
  } catch {
    return [];
  }
  for (const l of lines) {
    let msg: any;
    try {
      msg = JSON.parse(l);
    } catch {
      continue;
    }
    if (msg.type !== "assistant" && msg.type !== "user") continue;
    for (const block of msg.message?.content ?? []) {
      if (msg.type === "assistant" && block.type === "tool_use" && block.id && GATED.has(block.name)) {
        toolUseIdToName.set(String(block.id), block.name);
      }
      if (msg.type === "user" && block.type === "tool_result" && block.tool_use_id) {
        toolResultIsError.set(String(block.tool_use_id), !!block.is_error);
      }
    }
  }
  const ungated: string[] = [];
  for (const [id, name] of toolUseIdToName) {
    if (gateFired.has(id)) continue;
    const isError = toolResultIsError.get(id);
    if (isError === false) ungated.push(`${name} (${id})`);
  }
  return ungated;
}

/**
 * parse `COWORK_HARNESS_DIALOG_TIMEOUT_MS`. Returns:
 *  - `Infinity` for "inf", "infinite", or "-1" (explicit no-timeout sentinel)
 *  - a positive integer (milliseconds) for a valid numeric string in 1..3_600_000
 *  - `undefined` for absent / "0" / empty (→ policy-based default applies)
 * Rejects decimals, NaN, negative values, zero, and values exceeding 3_600_000 ms (1 hour).
 */
export function parseDialogTimeout(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  if (!s || s === "0") return undefined;
  if (s === "inf" || s === "infinite" || s === "-1") return Infinity;
  const n = parseInt(s, 10);
  if (!Number.isSafeInteger(n)) throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} is not a safe integer`);
  if (String(n) !== s) throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} must be an integer (no decimals)`);
  if (n <= 0) throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} must be > 0`);
  const MAX_MS = 3_600_000;
  if (n > MAX_MS)
    throw new Error(`cowork-harness: COWORK_HARNESS_DIALOG_TIMEOUT_MS=${raw.trim()} exceeds maximum of ${MAX_MS} ms (1 hour)`);
  return n;
}

/**
 * Parse an environment variable as a TCP port (integer in 1..65535).
 * Returns `defaultValue` when the variable is absent or empty.
 * Throws with a descriptive message if the value is present but not a valid port.
 */
export function parseEnvPort(name: string, defaultValue: number): number {
  const val = process.env[name];
  if (!val) return defaultValue;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535 || String(n) !== val.trim())
    throw new Error(`cowork-harness: ${name}=${val} must be an integer in 1..65535`);
  return n;
}

/**
 * read + validate the resume manifest. Converts a raw JSON `SyntaxError` into a friendly
 * "corrupt manifest" error, and on the resume path throws a clear error when `agentSessionId` is
 * missing or not a string (corrupt or older-format file) instead of silently degrading to a fresh
 * session. Extracted so it's unit-testable without spawning a run.
 */
export function readSessionManifest(path: string, sessionId: string): string {
  const raw = readFileSync(path, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt manifest at ${path}: not valid JSON`);
  }
  // if the manifest records a sessionId, verify it matches the requested one so a copied or
  // stale manifest cannot resume the wrong native agent conversation. Legacy manifests without a
  // sessionId field are allowed through for backward compatibility.
  if (parsed?.sessionId !== undefined && sessionId && parsed.sessionId !== sessionId) {
    throw new Error(`cowork-harness: manifest session ID mismatch: manifest has ${parsed.sessionId}, expected ${sessionId}`);
  }
  const id = parsed?.agentSessionId;
  if (typeof id !== "string" || !id) {
    throw new Error(
      `cannot resume "${sessionId}": manifest at ${path} is missing agentSessionId (corrupt or older format) — ` +
        `delete the run dir and re-run to recreate`,
    );
  }
  return id;
}

export { UnansweredError, BoundaryError, UsageError };

import { join, dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeJsonAtomic, envPositiveNumber } from "../io.js";
import type { RunStatus } from "../types.js";
import type { RunRecord } from "./run.js";
import { resolveEventsFile } from "./trace-view.js";
import { expandUserPath } from "../session.js";

const STATUS_FILE = "status.json";

export interface RunStatusMeta {
  pid: number;
  scenario: string;
  fidelity: string;
  sessionId: string;
  startedAt: number; // epoch ms
}

// NOTE: `elapsedMs` is always derived from THIS module's own `meta.startedAt` (set at outDir creation,
// right after mkdir). `durationMs` (terminal only) is passed in from the caller and, at the
// two normal finalize sites, is `RunResult.durationMs` — timed from execute.ts's OWN later `startedAt`
// (set just before the container/VM spawn, so it excludes dir-setup time). The two numbers are
// deliberately NOT forced equal: `elapsedMs` answers "how long has status.json existed" (useful for a
// `--follow` watcher gauging staleness from the very first moment), `durationMs` is the authoritative,
// result.json-matching run duration. A few hundred ms of divergence between them is expected and
// harmless — this is a diagnostic file, not the verdict source.
function buildStatus(
  meta: RunStatusMeta,
  state: RunStatus["state"],
  counts: { toolCounts: Record<string, number>; subagentCount: number },
  terminal?: {
    result: "success" | "error";
    durationMs: number;
    errorSource?: RunStatus["errorSource"];
    resultSubtype?: string;
    stderrLogPath?: string;
  },
): RunStatus {
  const now = Date.now();
  return {
    schemaVersion: 1,
    state,
    pid: meta.pid,
    scenario: meta.scenario,
    fidelity: meta.fidelity,
    sessionId: meta.sessionId,
    startedAt: new Date(meta.startedAt).toISOString(),
    updatedAt: new Date(now).toISOString(),
    elapsedMs: now - meta.startedAt,
    toolCounts: counts.toolCounts,
    subagentCount: counts.subagentCount,
    // undefined-valued keys are dropped by JSON.stringify, so the diagnostics appear only when set.
    ...(terminal
      ? {
          result: terminal.result,
          durationMs: terminal.durationMs,
          errorSource: terminal.errorSource,
          resultSubtype: terminal.resultSubtype,
          stderrLogPath: terminal.stderrLogPath,
        }
      : {}),
  };
}

/** Best-effort write — status.json is diagnostic, NEVER load-bearing. A write failure (e.g. outDir
 *  removed mid-teardown) must never mask or interrupt the real run. */
function writeStatus(outDir: string, status: RunStatus): void {
  try {
    writeJsonAtomic(join(outDir, STATUS_FILE), status);
  } catch {
    /* diagnostic only */
  }
}

/** Write the initial "running" status.json — call once, right after `outDir` is created (before
 *  `drive()` starts), so a checker sees "running" from the earliest possible moment. */
export function writeRunningStatus(outDir: string, meta: RunStatusMeta): void {
  writeStatus(outDir, buildStatus(meta, "running", { toolCounts: {}, subagentCount: 0 }));
}

/** The run-start `[status] <outDir>` stderr line, or `null` when it must be withheld.
 *
 *  The path is RAW/un-tildeified by contract: a driving agent/script parses this line and feeds it
 *  straight back into `cowork-harness status <path>`, so it must round-trip exactly (`~` is a display
 *  nicety Node won't expand). But an un-tildeified absolute path is a host-path leak — exactly what
 *  `--compact`/`--demo` (the shareable / "no host paths" mode) exists to prevent. So it is suppressed
 *  under `compact`: a human sharing a clip isn't scripting `status`, and a machine/CI caller that needs
 *  the path simply doesn't pass `--compact` (or reads `status.json` / `--session-id`). Suppressing the
 *  LINE only — `status.json` is still written either way, so `cowork-harness status` still works. */
export function statusLine(outDir: string, compact: boolean): string | null {
  return compact ? null : `[status] ${outDir}\n`;
}

/** Start a ticker that periodically overwrites status.json with live counts pulled from `record()`
 *  (bind this to `run.partial`). Mirrors `startHeartbeat`'s shape (`src/run/renderer.ts:187-203`):
 *  unref'd `setInterval`, env-tunable via `COWORK_HARNESS_STATUS_INTERVAL_MS`, returns a stop function. */
export function startStatusTicker(outDir: string, meta: RunStatusMeta, record: () => RunRecord): () => void {
  const intervalMs = envPositiveNumber("COWORK_HARNESS_STATUS_INTERVAL_MS", 5_000);
  const tick = () => {
    const r = record();
    writeStatus(outDir, buildStatus(meta, "running", { toolCounts: r.toolCounts, subagentCount: r.subagents.length }));
  };
  const h = setInterval(tick, intervalMs);
  if (typeof h.unref === "function") h.unref(); // never keep the process alive on our account
  return () => clearInterval(h);
}

/** Overwrite status.json with a TERMINAL state (done/error) — call once at each `RunResult` assembly
 *  site (the success path and `buildPartialResult`'s call site). Idempotent + best-effort. */
export function finalizeRunStatus(
  outDir: string,
  meta: RunStatusMeta,
  record: RunRecord,
  result: "success" | "error",
  durationMs: number,
): void {
  writeStatus(
    outDir,
    buildStatus(
      meta,
      result === "success" ? "done" : "error",
      { toolCounts: record.toolCounts, subagentCount: record.subagents.length },
      {
        result,
        durationMs,
        // Terminal-error diagnostics so a failure-output reader gets more than a bare "error". stderrLogPath
        // is the live agent log (same path the assembler records); only meaningful on the error terminal.
        errorSource: result === "error" ? record.errorSource : undefined,
        resultSubtype: result === "error" ? record.resultSubtype : undefined,
        stderrLogPath: result === "error" ? join(outDir, "agent.stderr.log") : undefined,
      },
    ),
  );
}

/** Best-effort terminal write when NO `RunRecord` is available — the crash-safety net. Bound to
 *  `process.on("exit", …)` right after `writeRunningStatus` and removed once a normal
 *  `finalizeRunStatus` runs, so it fires ONLY for a genuine crash: an uncaught throw that unwinds past
 *  `executeScenario` without ever reaching either `RunResult` assembly site (a plain `throw` earlier in
 *  the function — e.g. a `BoundaryError` — or anything else that isn't the recoverable
 *  `UnansweredError` path). Without this, `status.json` would stay frozen at `"running"` forever on a
 *  crash — a false "still alive" signal, exactly the failure mode this feature exists to eliminate.
 *  Mirrors `writeDoneMarker`'s exit-handler precedent (`src/decide/external-channel.ts:58-64`); like
 *  that marker, this is idempotent + synchronous (`writeJsonAtomic` uses sync `fs` calls), which is a
 *  hard requirement for anything run from a Node `"exit"` handler. Not called directly — see
 *  `registerRunForCrashSafety` immediately below, which wraps this with the pending-set bookkeeping a
 *  SINGLE shared exit handler needs. */
export function markRunStatusCrashed(outDir: string, meta: RunStatusMeta): void {
  writeStatus(
    outDir,
    buildStatus(meta, "error", { toolCounts: {}, subagentCount: 0 }, { result: "error", durationMs: Date.now() - meta.startedAt }),
  );
}

// Module-level (not per-call) crash-safety bookkeeping. A per-call `process.on("exit", …)` +
// `process.off(...)` pair — the FIRST design tried for this — leaks a listener for every run whose
// `finalize()` is never reached (exactly the non-`UnansweredError` throw path this net exists for):
// under `record --concurrency`, executeScenario runs in-process and a batch that catches-and-continues
// past a hard failure would accumulate one un-removed listener per crashed scenario. A SINGLE listener,
// registered once and shared across every run in the process, cannot leak: it just sweeps whatever is
// still in `pending` when the process actually exits.
const pending = new Map<string, { outDir: string; meta: RunStatusMeta }>();
let exitHandlerRegistered = false;

/** The exit handler's actual body — exported separately so it's unit-testable by calling it directly,
 *  without triggering a real `process.exit()` inside a test. Marks every STILL-pending run `"error"`;
 *  a run whose `finalize()` already ran is not in `pending` and is left untouched. */
export function crashAllPendingRunStatuses(): void {
  for (const { outDir, meta } of pending.values()) markRunStatusCrashed(outDir, meta);
  pending.clear();
}

/** Register a run for crash-safety tracking — call once, right after `writeRunningStatus`.
 *  Lazily registers the ONE shared `process.on("exit", crashAllPendingRunStatuses)` listener on first
 *  use (idempotent — a second/third call in the same process is a no-op). Returns a `finalize` function;
 *  call it at BOTH normal `RunResult` assembly sites once the run completes — it removes this run from
 *  `pending` (so the eventual exit sweep, if any, skips it) AND writes the real terminal status via
 *  `finalizeRunStatus`. A run that's still in `pending` when the process exits — because its
 *  `executeScenario` call threw something other than the recoverable `UnansweredError` and unwound past
 *  BOTH assembly sites — gets marked `"error"` by the sweep instead of being left at a stale `"running"`
 *  forever. */
export function registerRunForCrashSafety(
  outDir: string,
  meta: RunStatusMeta,
): { finalize(record: RunRecord, result: "success" | "error", durationMs: number): void } {
  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.on("exit", crashAllPendingRunStatuses);
  }
  pending.set(outDir, { outDir, meta });
  return {
    finalize(record, result, durationMs) {
      pending.delete(outDir);
      finalizeRunStatus(outDir, meta, record, result, durationMs);
    },
  };
}

/** Whether a `"running"` status is STALE — the writer has stopped updating `status.json` altogether.
 *  This is the ONLY signal that catches a `SIGKILL`/OOM-kill/segfault mid-run: nothing in the process
 *  runs on those signals, so neither `startStatusTicker` nor the `markRunStatusCrashed` exit-handler
 *  ever fires — `status.json` would otherwise sit at `"running"` FOREVER, the exact false-liveness
 *  conclusion this feature exists to prevent. `thresholdMs` defaults to 3× the ticker's own write
 *  interval (`COWORK_HARNESS_STATUS_INTERVAL_MS`, itself default 5000ms → 15s), generous enough that an
 *  ordinary async-I/O-bound run (spawning a container, streaming agent output) never trips it — the
 *  ticker's `setInterval` is NOT idle-aware (unlike `startHeartbeat`), so it keeps writing every
 *  interval regardless of agent activity; a genuine multi-tick silence means the writer itself is gone,
 *  not that the agent is "just thinking." A terminal status (`done`/`error`) is never stale by
 *  definition — this only ever downgrades a `"running"` read. */
export function isStatusStale(status: RunStatus, thresholdMs?: number): boolean {
  if (status.state !== "running") return false;
  const t =
    thresholdMs ?? envPositiveNumber("COWORK_HARNESS_STATUS_STALE_MS", 3 * envPositiveNumber("COWORK_HARNESS_STATUS_INTERVAL_MS", 5_000));
  const age = Date.now() - Date.parse(status.updatedAt);
  // Date.parse of a malformed updatedAt (e.g. a hand-corrupted file) yields NaN; NaN > t is false, which
  // would silently read as "not stale" — fail toward SUSPECT, not toward blind trust, matching the
  // project's no-silent-false-green ethos. All real writers (buildStatus) always emit a valid ISO string,
  // so this only matters for external corruption.
  return Number.isNaN(age) || age > t;
}

/** Read+parse status.json from a run dir. Throws (ENOENT / SyntaxError) if missing or malformed — the
 *  `status` CLI command translates that into a usage-style error message. */
export function readRunStatus(runDir: string): RunStatus {
  return JSON.parse(readFileSync(join(runDir, STATUS_FILE), "utf8")) as RunStatus;
}

export function hasRunStatus(runDir: string): boolean {
  return existsSync(join(runDir, STATUS_FILE));
}

/** Resolve a `status` CLI argument (a literal run dir, or a run-id/fragment) to the run's directory.
 *  A literal directory is used DIRECTLY — the common case (a driving agent passes the exact `outDir`
 *  printed at run start) — and works even in the earliest moments of a run, BEFORE
 *  `events.jsonl` exists (`resolveEventsFile` alone would reject that window, since it requires
 *  `events.jsonl` to already be present). Falls back to `resolveEventsFile` (run-id / fragment matching
 *  under the runs root) for everything else — the same resolver `trace`/`inspect` already use.
 *
 *  Defense-in-depth: a leading `~` (or `~/...`) is expanded to the user's home directory (via the shared
 *  {@link expandUserPath}, `src/session.ts`) BEFORE the literal-directory check runs. The `[status]`
 *  printer (`src/run/execute.ts`) always emits the raw, un-tildeified `outDir` precisely so this program
 *  never needs to expand `~` for its own output — but a human may still paste in a `~`-abbreviated path
 *  copied from some other display context (shell history, a footer line, etc.), and a shell isn't in the
 *  loop to expand it for us here. */
export function resolveStatusDir(arg: string): string {
  const expanded = expandUserPath(arg);
  if (existsSync(expanded) && statSync(expanded).isDirectory()) return expanded;
  return dirname(resolveEventsFile(expanded));
}

/** Poll `runDir/status.json` and emit one line per CHANGE (by `updatedAt`), stopping once the run
 *  reaches a terminal state (done/error) or `opts.once` is set. Mirrors `streamGates`'s shape
 *  (`src/decide/external-channel.ts:72-111`) — the closest existing precedent for "poll a file for run
 *  status" — so `status --follow` needs just one Monitor instead of a hand-rolled poll loop.
 *
 *  REJECTS in two cases, both fail-loud instead of a silent infinite wait (matching the project's
 *  no-silent-false-green ethos, `AGENTS.md`):
 *   1. `status.json` never appears within `firstSeenTimeoutMs` of the FIRST tick — a wrong directory, or
 *      a run that never started. Once a first status HAS been observed, this no longer applies (a
 *      `"running"` run can legitimately run for a long time).
 *   2. A `"running"` status goes STALE (`isStatusStale`) — the writer stopped updating altogether, which
 *      is what a `SIGKILL`/OOM-kill/segfault mid-run looks like from the outside (`status.json` already
 *      exists, so case 1 above does NOT catch this — it only fires when the file is absent). Without
 *      this check, `--follow` would poll forever on a dead run whose last write happened to be
 *      `"running"` — the exact failure this feature exists to prevent. */
export function followRunStatus(
  runDir: string,
  write: (line: string) => void,
  opts: { pollMs?: number; once?: boolean; firstSeenTimeoutMs?: number; staleMs?: number; corruptTimeoutMs?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? envPositiveNumber("COWORK_HARNESS_STATUS_POLL_MS", 1000);
  const firstSeenTimeoutMs = opts.firstSeenTimeoutMs ?? envPositiveNumber("COWORK_HARNESS_STATUS_FIRST_SEEN_TIMEOUT_MS", 60_000);
  // How long a status.json may exist-but-never-parse before follow gives up. A mid-write parse failure is
  // transient (retried next tick); a persistently corrupt/truncated file would otherwise loop forever once
  // the file has appeared (sawStatus disables the "never appeared" reject). Bound it and reject loud.
  const corruptTimeoutMs = opts.corruptTimeoutMs ?? envPositiveNumber("COWORK_HARNESS_STATUS_CORRUPT_TIMEOUT_MS", 30_000);
  const deadline = Date.now() + firstSeenTimeoutMs;
  let lastUpdatedAt: string | undefined;
  let sawStatus = false;
  let corruptSince: number | undefined;
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (hasRunStatus(runDir)) {
        sawStatus = true;
        let status: RunStatus | undefined;
        try {
          status = readRunStatus(runDir);
          corruptSince = undefined; // a clean read clears any transient-corruption streak
        } catch {
          // mid-write is transient (retried next tick); a persistently corrupt/truncated status.json
          // would otherwise loop forever once the file exists — bound it and reject loud.
          if (corruptSince === undefined) corruptSince = Date.now();
          if (Date.now() - corruptSince > corruptTimeoutMs) {
            const ageS = Math.round((Date.now() - corruptSince) / 1000);
            return reject(
              Object.assign(
                new Error(
                  `${join(runDir, STATUS_FILE)} has existed but never parsed for ${ageS}s — the status file is corrupt/truncated, not mid-write`,
                ),
                { corrupt: true },
              ),
            );
          }
        }
        if (status && status.updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = status.updatedAt;
          write(JSON.stringify(status));
        }
        if (status && status.state !== "running") return resolve();
        if (status && isStatusStale(status, opts.staleMs)) {
          const ageS = Math.round((Date.now() - Date.parse(status.updatedAt)) / 1000);
          // `.stale = true` lets the CLI (cmdStatus) distinguish this from the "never appeared" rejection
          // below by exit code (3 vs 1) without string-matching the message.
          return reject(
            Object.assign(
              new Error(
                `${join(runDir, STATUS_FILE)} stopped updating ${ageS}s ago while still "running" — the process ` +
                  `likely died without a clean exit (e.g. SIGKILL/OOM), which no exit handler can catch`,
              ),
              { stale: true },
            ),
          );
        }
      } else if (!sawStatus && Date.now() > deadline) {
        return reject(
          new Error(
            `no status.json ever appeared at ${runDir} within ${firstSeenTimeoutMs}ms — wrong dir, or the run never started/crashed`,
          ),
        );
      }
      if (opts.once) return resolve();
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

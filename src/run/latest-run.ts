// "Find the newest run dir for a scenario" — the robust replacement for `ls -td runs/<scenario>/* |
// head -1`, which orders by bare directory mtime. Directory mtime is NOT run recency: a dir's mtime
// bumps on ANY write inside it (a later `inspect`/`trace --translate-paths` write, a filesystem touch, a
// slow/retried finalize) independent of when the run itself actually happened, so the newest-BY-CONTENT
// run can easily have an older directory mtime than a stale prior session's dir. See docs/scenario.md's
// "Output" section for the consumer-facing note.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { slugForPath } from "./execute.js";
import { latestTurn, turnArtifactPath } from "./turn-layout.js";

export interface LatestRunInfo {
  /** result.json's own `scenario` field when readable (the display name); falls back to the caller's
   *  lookup argument when result.json is missing/malformed. */
  scenario: string;
  outDir: string;
  /** ISO-8601 — the recency signal that won: `.origin`'s `createdAt`, else `result.json`'s mtime, else
   *  `status.json`'s `startedAt`. */
  createdAt: string;
  /** Read opportunistically from a persisted `result.json`'s `RunResult.verdict` (a subset — pass/exit/
   *  failures) — omitted when absent (older result.json, or one this reader couldn't parse). Never re-derived. */
  verdict?: { pass: boolean; exitCode: 0 | 1; failures: Array<{ assertion?: string; message: string }> };
}

/** Best-effort read of a run dir's `.origin` marker `createdAt` field (the shape execute.ts writes:
 *  `{originKey, sourceHint, createdAt}`) — only written for PINNED (`--session-id`) runs. Returns
 *  `undefined` on any absence/malformed/unparseable-date condition rather than throwing; a missing/corrupt
 *  marker is expected for the common ephemeral (`local_*`) run, not an error. */
function originCreatedAt(dir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ".origin"), "utf8")) as unknown;
    const createdAt = (raw as { createdAt?: unknown } | null)?.createdAt;
    if (typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt))) return createdAt;
  } catch {
    /* absent or malformed — no origin marker to read */
  }
  return undefined;
}

/** The LATEST turn's `result.json` mtime, ISO-8601 — the same proxy `reindexFromRunsTree` (run-index.ts)
 *  uses for a historical row's `ts` when no better signal exists. A root read here (pre-seam) silently
 *  found nothing on any current-layout dir, falling through to `status.json`'s startedAt — a run's START,
 *  not its END — so a long resumed session could order BEHIND a shorter, later one with no error at all.
 *  `undefined` on a `legacy`/`mixed`/`none` dir (`latestTurn` returns no addressable turn there) — the
 *  caller falls through to `statusStartedAt`, same degrade as a genuinely missing file. */
function resultJsonMtime(dir: string): string | undefined {
  const turn = latestTurn(dir);
  if (turn === undefined) return undefined;
  const p = turnArtifactPath(dir, turn, "result.json");
  if (!existsSync(p)) return undefined;
  try {
    return statSync(p).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/** `status.json`'s `startedAt` — the last-resort fallback for a run dir that has neither an `.origin`
 *  marker (ephemeral, non-pinned) nor a `result.json` yet (still running, or crashed before assembly). */
function statusStartedAt(dir: string): string | undefined {
  const p = join(dir, "status.json");
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const startedAt = (raw as { startedAt?: unknown } | null)?.startedAt;
    if (typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt))) return startedAt;
  } catch {
    /* absent or malformed */
  }
  return undefined;
}

/** Best-effort read of a run dir's LATEST turn's `result.json` — used opportunistically for the display
 *  `scenario` name and the (optional) persisted `verdict`. Never throws; a missing/malformed file (or a
 *  `legacy`/`mixed`/`none` dir, where `latestTurn` has no addressable turn to read) just means both stay
 *  at their fallback — a root read here silently dropped `scenario`/`verdict` on every current-layout dir. */
function readResultJson(dir: string): { scenario?: string; verdict?: LatestRunInfo["verdict"] } {
  const turn = latestTurn(dir);
  if (turn === undefined) return {};
  const p = turnArtifactPath(dir, turn, "result.json");
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { scenario?: unknown; verdict?: unknown };
    const scenario = typeof raw.scenario === "string" ? raw.scenario : undefined;
    const verdict = raw.verdict && typeof raw.verdict === "object" ? (raw.verdict as LatestRunInfo["verdict"]) : undefined;
    return { scenario, verdict };
  } catch {
    return {};
  }
}

/** Resolve `arg` (a scenario's display NAME, or an already-slugified dir name) to its physical dir under
 *  `runsRoot`. Tries `slugForPath(arg)` first — the common case, since `arg` is almost always the
 *  scenario's display name and `slugForPath` is what execute.ts applied at write time — then falls back
 *  to `arg` verbatim, for a caller who already has the slug (e.g. copy-pasted from a prior `outDir`). */
function resolveScenarioDir(runsRoot: string, arg: string): string | undefined {
  const bySlug = join(runsRoot, slugForPath(arg));
  if (existsSync(bySlug) && statSync(bySlug).isDirectory()) return bySlug;
  const raw = join(runsRoot, arg);
  if (existsSync(raw) && statSync(raw).isDirectory()) return raw;
  return undefined;
}

/** The newest run dir for a scenario, by actual RUN TIME — never by bare directory mtime (see the module
 *  doc comment above for why that's unreliable). Recency signal preference, per run dir:
 *   1. `.origin` marker's `createdAt` (pinned `--session-id` runs only)
 *   2. `result.json`'s own mtime (the common ephemeral-run case, once the run has finished)
 *   3. `status.json`'s `startedAt` (a run dir with neither of the above yet — still running, or crashed
 *      before `result.json` was ever written)
 *  A run dir with NONE of the three (a bare empty dir) is skipped — never silently ordered by its own
 *  mtime, which would defeat the entire point.
 *
 *  Returns `undefined` when `arg` doesn't resolve to any scenario dir under `runsRoot`, or the scenario
 *  dir exists but has no run subdir with a usable recency signal. */
export function findLatestRunForScenario(runsRoot: string, arg: string): LatestRunInfo | undefined {
  const scenarioDir = resolveScenarioDir(runsRoot, arg);
  if (!scenarioDir) return undefined;

  let entries: string[];
  try {
    entries = readdirSync(scenarioDir);
  } catch {
    return undefined;
  }

  let best: { outDir: string; createdAt: string } | undefined;
  for (const runId of entries) {
    const dir = join(scenarioDir, runId);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const createdAt = originCreatedAt(dir) ?? resultJsonMtime(dir) ?? statusStartedAt(dir);
    if (createdAt === undefined) continue; // no usable recency signal — never fall back to dir mtime
    // ISO-8601 strings with the same (Z) precision compare correctly lexically — same convention
    // run-index.ts already relies on for its `ts` field.
    if (!best || createdAt > best.createdAt) best = { outDir: dir, createdAt };
  }
  if (!best) return undefined;

  const { scenario, verdict } = readResultJson(best.outDir);
  return { scenario: scenario ?? arg, outDir: best.outDir, createdAt: best.createdAt, verdict };
}

/** The newest run/session dir at most TWO levels under `root`, by actual RUN TIME (same recency signal
 *  as findLatestRunForScenario: .origin createdAt → result.json mtime → status.json startedAt). Handles a
 *  `--run-dir` root passed to `status`, whose layout is `<root>/<scenario-slug>/<sessionId>/`. A candidate
 *  MUST contain a status.json — every harness run writes one early, and gating on it prevents an unrelated
 *  dir that merely holds a file named `result.json` from matching when `root` is large (e.g. $HOME).
 *  Returns undefined when nothing under root qualifies. */
export function findLatestRunUnderRoot(root: string): string | undefined {
  let best: { dir: string; createdAt: string } | undefined;
  const consider = (dir: string): void => {
    if (!existsSync(join(dir, "status.json"))) return; // candidacy gate — no random result.json matches
    const createdAt = originCreatedAt(dir) ?? resultJsonMtime(dir) ?? statusStartedAt(dir);
    if (createdAt === undefined) return;
    if (!best || createdAt > best.createdAt) best = { dir, createdAt };
  };
  const children = (d: string): string[] => {
    try {
      return readdirSync(d)
        .map((n) => join(d, n))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  };
  // level 1 (root/<sessionId>) and level 2 (root/<scenario-slug>/<sessionId>) — cap the depth so this
  // never walks an arbitrarily deep tree.
  for (const lvl1 of children(root)) {
    consider(lvl1);
    for (const lvl2 of children(lvl1)) consider(lvl2);
  }
  return best?.dir;
}

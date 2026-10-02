import { applyParsedCommandGlobals, withCommandGlobals } from "./command-globals.js";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../cli-args.js";
import { runsWriteRoot } from "./trace-view.js";
import { classifyRunDir, hasTurnDirs } from "./turn-layout.js";
import { MIGRATION_JOURNAL_DIR } from "./migrate-run-dir.js";
import { evalIdOfLabel, isHillclimbLabel, isSymlink, readSmallJson, runLabelOf } from "./run-labels.js";
import { isStatusStale, isValidRunStatus } from "./run-status.js";

const log = (s: string) => process.stderr.write(s + "\n");

/** How many interrupted migrations are recorded for this scenario. */
function liveJournalsFor(runsRoot: string, scenarioSlug: string): number {
  try {
    return readdirSync(join(runsRoot, MIGRATION_JOURNAL_DIR, scenarioSlug)).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0; // no journal dir for this scenario — the ordinary case
  }
}

const DEFAULT_KEEP_LAST = 5;

/** A "running" status whose updatedAt is older than this is not kept on its pid alone. */
const LIVE_PID_MAX_AGE_MS = 24 * 3_600_000;
/** An updatedAt this far in the future is not trusted as live. */
const FUTURE_SKEW_MS = 60_000;

/** Whether process `pid` exists. EPERM means it exists under another user. */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false; // 0 / negative address a group
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Why a run dir counts as still running, or undefined. Its status.json must say `running`, and either still
 *  be updated (not `isStatusStale`, which reads COWORK_HARNESS_STATUS_STALE_MS from prune's own environment,
 *  default 15s) or record a pid that is alive with an updatedAt under 24h old. The pid branch exists because the
 *  status ticker runs only while the agent session is driven: during staging and spawn before it, and judging and
 *  finalizing after it, a live run's status.json sits at `running` with a frozen updatedAt. A pid reused by an
 *  unrelated process keeps a dead run at most 24h, which costs only disk. An updatedAt more than a minute in the
 *  future, or unparseable, is not live (fail toward suspect). The file is read without following a symlink and
 *  without blocking, so a FIFO cannot hang prune. A symlinked run dir is not read through. */
function liveRunReason(dir: string): string | undefined {
  if (isSymlink(dir)) return undefined;
  const st = readSmallJson(join(dir, "status.json"));
  if (!isValidRunStatus(st) || st.state !== "running") return undefined;
  const updated = Date.parse(st.updatedAt);
  if (Number.isNaN(updated)) return undefined;
  const age = Date.now() - updated;
  if (age < -FUTURE_SKEW_MS) return undefined;
  if (!isStatusStale(st)) return `status.json updated ${Math.round(Math.max(0, age) / 1000)}s ago`;
  if (age <= LIVE_PID_MAX_AGE_MS && pidAlive(st.pid)) return `its process ${st.pid} is alive`;
  return undefined;
}

/** Parse a `<N>d|h|m` retention window (e.g. `7d`, `24h`, `30m`) to milliseconds, or undefined if
 *  malformed. Used only by the opt-in `--pinned-older-than` reclaim — pinned sessions are otherwise
 *  never pruned. */
function parseRetentionMs(s: string): number | undefined {
  const m = s.trim().match(/^(\d+)\s*([dhm])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined; // reject `0d`/`0h` — a zero window would reclaim EVERY pinned session
  const mult = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
  return n * mult;
}

/** A "real run" — has completed at least one turn (`turns/<N>/`, current layout — no writer produces a
 *  root `result.json` compat copy to check for anymore) OR has an `events.jsonl` (a session started, so
 *  the run is in-flight or threw — e.g. an unanswered gate under on_unanswered:fail writes no turn dir but
 *  DOES leave events.jsonl). A never-started empty `scaffold`/failed-before-session dir has neither → it
 *  is what GC should drop first. `events.jsonl` exists from session start, so an in-flight run is
 *  protected without a wall-clock guard. */
const isRealRun = (dir: string) => {
  if (hasTurnDirs(dir) || existsSync(join(dir, "events.jsonl"))) return true;
  // A PRE-LAYOUT dir is still a real run. This predicate reasons about the RANKING population, which is
  // history — not about what current writers produce. Keying it on `hasTurnDirs` alone demoted an
  // unmigrated legacy dir (root result.json, no events.jsonl) into the junk tier, so prune deleted it
  // ahead of an empty scaffold: silent destruction of exactly the history `migrate-run-dir` exists to
  // preserve, in the same file whose journal guard calls that the most expensive outcome in this feature.
  const shape = classifyRunDir(dir);
  return shape.kind === "legacy" || shape.kind === "mixed";
};

/** `cowork-harness prune [--keep-last <n>] [--pinned-older-than <N>d|h|m] [--include-hillclimb] [--dry-run] [<runs-dir>]`
 *
 *  For each scenario directory under the runs root, ranks EPHEMERAL run dirs by (1) real-run first (a
 *  turns/ dir, an events.jsonl, or a pre-layout shape — see isRealRun), (2) mtime descending, (3) name — then keeps the N most recent of that order
 *  and removes the rest. So an older COMPLETED run beats a newer empty scaffold dir for a keep slot, but
 *  `--keep-last` stays a HARD CAP (the ranking only decides WHICH N survive — never grows the kept count).
 *  Do NOT run `prune` against an actively-writing runs root.
 *  Pinned `sess-*` dirs (persisted, resumable `--session-id` sessions) are retained unconditionally by
 *  default — pass `--pinned-older-than <N>d|h|m` to also reclaim pinned sessions whose last activity is
 *  older than that window (opt-in, so a programmatic consumer that leaks one pinned session per run has a
 *  policy to reclaim them; nothing pinned is touched without the flag).
 *  HILLCLIMB runs — any run labelled `hillclimb:…` (what `hillclimb run` writes, `hillclimb:<basename(flow)>:<variant>`,
 *  and also a run a user labelled `--label hillclimb:…` by hand) — are kept the same way: never pruned and never
 *  in a --keep-last slot, because `hillclimb regrade` and `hillclimb freeze-ref` read them and refuse once one is
 *  gone. The label is the only signal: their dir names are ordinary `local_*` ids. `--include-hillclimb` puts
 *  them back into the ranking (it does not delete them wholesale). The label names the flow dir by basename only,
 *  so prune cannot tell which flow, or which project, a run came from: the flag releases the runs of EVERY flow
 *  under the root, a loop still running included.
 *  A run whose status.json says `running` is skipped and counted, pinned, hillclimb or plain, while that file is
 *  still being updated or its recorded process is alive (up to 24h) — see liveRunReason.
 *  The default root is the flat, machine-global `~/.cowork-harness/runs` (shared across projects), so a
 *  bare `prune` prunes ephemeral runs from ALL projects; pass an explicit <runs-dir> to scope it.
 *  Safe by default (dry-run-able). */
export function cmdRunsGc(args: string[]): void {
  let p;
  try {
    p = parseArgs(
      args,
      withCommandGlobals({
        booleans: ["--dry-run", "--include-hillclimb"],
        values: ["--keep-last", "--pinned-older-than"],
      }),
    );
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
  applyParsedCommandGlobals("prune", p, false);
  if (p.positionals.length > 1) {
    log(`prune takes an optional <runs-dir> (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }

  const rawKeep = p.options["--keep-last"];
  const keepLast = rawKeep !== undefined ? Number(rawKeep) : DEFAULT_KEEP_LAST;
  if (!Number.isInteger(keepLast) || keepLast < 1) {
    log(`prune: --keep-last must be a positive integer (got ${rawKeep})`);
    return process.exit(2);
  }

  const rawPinnedAge = p.options["--pinned-older-than"];
  let pinnedOlderThanMs: number | undefined;
  if (rawPinnedAge !== undefined) {
    pinnedOlderThanMs = parseRetentionMs(rawPinnedAge);
    if (pinnedOlderThanMs === undefined) {
      log(`prune: --pinned-older-than must be <N>d|h|m (e.g. 7d, 24h, 30m) — got "${rawPinnedAge}"`);
      return process.exit(2);
    }
  }

  const dryRun = p.flags["--dry-run"] ?? false;
  const includeHillclimb = p.flags["--include-hillclimb"] ?? false;
  const runsRoot = p.positionals[0] ?? runsWriteRoot();
  const now = Date.now();

  if (!existsSync(runsRoot)) {
    log(`✓ prune: ${runsRoot} does not exist — nothing to prune`);
    return process.exit(0);
  }

  let deleted = 0;
  let kept = 0;
  let skippedRunning = 0;
  // Protected hillclimb runs, counted per "<scenario>\0<label>" for the summary.
  const hillclimbKept = new Map<string, number>();
  let hillclimbPruned = 0;
  // An eval's runs are ordinary ephemeral runs, so --keep-last trims them. Its report is rebuilt from the
  // eval dir, never from these, but the report's evidence links point here — say which evals lost runs.
  const evalRunsPruned = new Map<string, number>();
  const notePruned = (label: string | undefined) => {
    const id = evalIdOfLabel(label);
    if (id !== undefined) evalRunsPruned.set(id, (evalRunsPruned.get(id) ?? 0) + 1);
    // Only the flag's own effect: a hillclimb-labelled `sess-*` dir reclaimed by --pinned-older-than is not it.
    if (includeHillclimb && isHillclimbLabel(label)) hillclimbPruned++;
  };
  /** Delete one run dir — unless it is still running (see liveRunReason); no flag overrides that. A symlinked
   *  run dir loses only the link (rmSync does not follow it). */
  const pruneDir = (d: { path: string; label: string | undefined }, how: string): boolean => {
    const live = liveRunReason(d.path);
    if (live !== undefined) {
      log(`↷ skipped ${d.path}: still running (${live})`);
      skippedRunning++;
      return false;
    }
    notePruned(d.label);
    if (!dryRun) rmSync(d.path, { recursive: true, force: true });
    log(`${dryRun ? "(dry-run) " : ""}✗ pruned ${how}${d.path}${includeHillclimb && isHillclimbLabel(d.label) ? ` (${d.label})` : ""}`);
    deleted++;
    return true;
  };

  for (const scenarioSlug of readdirSync(runsRoot).sort()) {
    if (scenarioSlug === MIGRATION_JOURNAL_DIR) continue; // the journal store is not a scenario
    const scenarioDir = join(runsRoot, scenarioSlug);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(scenarioDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    // A LIVE MIGRATION JOURNAL MAKES THIS SCENARIO UNRANKABLE. Between a crashed migration and its
    // recovery the renames have already re-stamped the run dir's mtime while the restore has not run —
    // and the ranking below is BY THAT MTIME. A half-migrated old run therefore ranks as the newest and
    // evicts a genuinely newer one. Pruning the half-migrated dir itself is just as bad: it orphans the
    // journal that holds the only record of the interrupted plan.
    //
    // Skipping is the conservative choice: prune is a space reclaim, so deferring it costs disk, while
    // getting it wrong deletes a run outright — the most expensive failure in this feature.
    const live = liveJournalsFor(runsRoot, scenarioSlug);
    if (live > 0) {
      log(`↷ skipped ${scenarioSlug}: ${live} migration journal(s) in flight — run \`migrate-run-dir\` to finish, then prune`);
      continue;
    }

    // Rank run dirs: (1) real-run first (a completed/in-flight run outranks an empty scaffold dir for a
    // keep slot), (2) newest first (mtime desc), (3) name desc as a deterministic tiebreaker.
    // Each dir's label is read once (status.json, else the latest turn's result.json) and serves both the
    // hillclimb partition and the eval note. A dir that yields no label is an ordinary run: if neither file
    // parses, `regrade`/`freeze-ref` cannot use it either. The one window with no label yet — between a run's
    // mkdir and its status.json write, a few synchronous calls apart — has no guard.
    const sorted = readdirSync(scenarioDir)
      .map((name) => ({ name, path: join(scenarioDir, name), label: runLabelOf(join(scenarioDir, name)) }))
      .filter(({ path }) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
        const aReal = isRealRun(a.path),
          bReal = isRealRun(b.path);
        if (aReal !== bReal) return aReal ? -1 : 1; // a real run ranks ahead of an empty/incomplete dir
        let aMtime = 0,
          bMtime = 0;
        try {
          aMtime = statSync(a.path).mtimeMs;
        } catch {
          /* deleted between filter and sort — treat as oldest */
        }
        try {
          bMtime = statSync(b.path).mtimeMs;
        } catch {
          /* deleted between filter and sort — treat as oldest */
        }
        const mtimeDiff = bMtime - aMtime;
        return mtimeDiff !== 0 ? mtimeDiff : b.name.localeCompare(a.name);
      });

    // PARTITION before counting: pinned `sess-*` dirs are persisted, resumable sessions that share the
    // flat (cross-project) runs root, so they are NEVER pruned — and they must not occupy a --keep-last
    // slot either, or a retained pinned dir would evict a newer ephemeral `local_*` that should be kept.
    // Only ephemeral `local_*` runs are subject to --keep-last.
    // A `sess-*` dir follows the pinned rule even when it carries a hillclimb label.
    const pinned = sorted.filter((d) => d.name.startsWith("sess-"));
    const rest = sorted.filter((d) => !d.name.startsWith("sess-"));
    // HILLCLIMB runs are the second protected partition, for the same reason: kept, and outside the
    // --keep-last count, so a flow's reps never evict the newest plain runs of the same scenario. Only
    // --include-hillclimb returns them to the ranking below.
    const hillclimb = includeHillclimb ? [] : rest.filter((d) => isHillclimbLabel(d.label));
    const ephemeral = includeHillclimb ? rest : rest.filter((d) => !isHillclimbLabel(d.label));
    for (const d of hillclimb) {
      const key = `${scenarioSlug}\0${d.label}`;
      hillclimbKept.set(key, (hillclimbKept.get(key) ?? 0) + 1);
      if (dryRun) log(`(dry-run) ⛨ kept hillclimb ${d.path}`);
    }

    // Pinned sessions are retained unconditionally UNLESS --pinned-older-than opts in to reclaiming the
    // stale ones (by last-activity mtime). Nothing pinned is deleted without that explicit flag.
    for (const d of pinned) {
      let mtime = now;
      try {
        mtime = statSync(d.path).mtimeMs;
      } catch {
        /* deleted between filter and loop — treat as fresh (kept) */
      }
      if (pinnedOlderThanMs !== undefined && now - mtime > pinnedOlderThanMs) {
        pruneDir(d, "pinned ");
      } else {
        kept++;
      }
    }

    for (let i = 0; i < ephemeral.length; i++) {
      if (i < keepLast) {
        kept++;
      } else {
        pruneDir(ephemeral[i], "");
      }
    }
  }

  const protectedHillclimb = [...hillclimbKept.values()].reduce((a, b) => a + b, 0);
  if (protectedHillclimb > 0) {
    // Grouped by scenario and FULL label. The label carries the flow dir's basename only, so two projects on
    // the default flow (`.claude/hillclimb/flow`) show as the same group.
    log(`⛨ prune: kept ${protectedHillclimb} hillclimb run dir(s) for regrade/freeze-ref, outside --keep-last:`);
    for (const [key, n] of [...hillclimbKept].sort(([a], [b]) => a.localeCompare(b))) {
      const [scenario, label] = key.split("\0");
      log(`    ${scenario}  ${label}  ${n}`);
    }
    log(`  \`prune --include-hillclimb\` removes them (every flow under this root) — see \`prune --help\``);
  }
  if (hillclimbPruned > 0)
    log(
      `::warning:: prune: ${hillclimbPruned} hillclimb run dir(s) ${dryRun ? "would be " : ""}pruned under --include-hillclimb — \`hillclimb regrade\` and \`hillclimb freeze-ref\` ` +
        `${dryRun ? "would refuse" : "now refuse"} the rows that point at them, for every flow under ${runsRoot}, a loop still running included ` +
        `(freeze-ref re-reads a frozen reference's source run).`,
    );
  for (const [id, n] of [...evalRunsPruned].sort(([a], [b]) => a.localeCompare(b)))
    log(
      `::warning:: prune: ${n} of the ${dryRun ? "run dir(s) prune would remove" : "pruned run dir(s)"} belong to eval ${id} — its report's evidence links ${dryRun ? "would point" : "now point"} at deleted runs. ` +
        `\`eval report <eval-dir>\` still rebuilds the report (it reads only the eval dir); raise --keep-last to keep an eval's runs.`,
    );
  // Extra clauses appear only when non-zero, so the line is unchanged for a root with neither.
  const extras = [
    protectedHillclimb > 0 ? `protected ${protectedHillclimb} hillclimb` : undefined,
    skippedRunning > 0 ? `skipped ${skippedRunning} running` : undefined,
  ].filter((x): x is string => x !== undefined);
  log(
    deleted > 0
      ? `✓ prune: pruned ${deleted} run dir(s), kept ${kept}${extras.map((x) => `, ${x}`).join("")}${dryRun ? " (dry-run — nothing deleted)" : ""}`
      : `✓ prune: nothing to prune (${kept} run dir(s) within --keep-last ${keepLast}${extras.map((x) => `; ${x}`).join("")})`,
  );
  return process.exit(0);
}

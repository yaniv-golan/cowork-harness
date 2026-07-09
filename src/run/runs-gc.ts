import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../cli-args.js";
import { runsWriteRoot } from "./trace-view.js";

const log = (s: string) => process.stderr.write(s + "\n");

const DEFAULT_KEEP_LAST = 5;

/** Parse a `<N>d|h|m` retention window (e.g. `7d`, `24h`, `30m`) to milliseconds, or undefined if
 *  malformed. Used only by the opt-in `--pinned-older-than` reclaim — pinned sessions are otherwise
 *  never pruned. */
export function parseRetentionMs(s: string): number | undefined {
  const m = s.trim().match(/^(\d+)\s*([dhm])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined; // reject `0d`/`0h` — a zero window would reclaim EVERY pinned session
  const mult = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
  return n * mult;
}

/** A "real run" — has a `result.json` (completed; success OR a recorded error) OR an `events.jsonl`
 *  (a session started, so the run is in-flight or threw — e.g. an unanswered gate under on_unanswered:fail
 *  writes no result.json but DOES leave events.jsonl). A never-started empty `scaffold`/failed-before-session
 *  dir has neither → it is what GC should drop first. `events.jsonl` exists from session start, so an
 *  in-flight run is protected without a wall-clock guard. */
const isRealRun = (dir: string) => existsSync(join(dir, "result.json")) || existsSync(join(dir, "events.jsonl"));

/** `cowork-harness prune [--keep-last <n>] [--dry-run] [<runs-dir>]`
 *
 *  For each scenario directory under the runs root, ranks EPHEMERAL run dirs by (1) real-run first (has
 *  result.json OR events.jsonl), (2) mtime descending, (3) name — then keeps the N most recent of that order
 *  and removes the rest. So an older COMPLETED run beats a newer empty scaffold dir for a keep slot, but
 *  `--keep-last` stays a HARD CAP (the ranking only decides WHICH N survive — never grows the kept count).
 *  Do NOT run `prune` against an actively-writing runs root.
 *  Pinned `sess-*` dirs (persisted, resumable `--session-id` sessions) are retained unconditionally by
 *  default — pass `--pinned-older-than <N>d|h|m` to also reclaim pinned sessions whose last activity is
 *  older than that window (opt-in, so a programmatic consumer that leaks one pinned session per run has a
 *  policy to reclaim them; nothing pinned is touched without the flag).
 *  The default root is the flat, machine-global `~/.cowork-harness/runs` (shared across projects), so a
 *  bare `prune` prunes ephemeral runs from ALL projects; pass an explicit <runs-dir> to scope it.
 *  Safe by default (dry-run-able). */
export function cmdRunsGc(args: string[]): void {
  let p;
  try {
    p = parseArgs(args, {
      booleans: ["--dry-run"],
      values: ["--keep-last", "--pinned-older-than"],
    });
  } catch (e) {
    log((e as Error).message);
    return process.exit(2);
  }
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
  const runsRoot = p.positionals[0] ?? runsWriteRoot();
  const now = Date.now();

  if (!existsSync(runsRoot)) {
    log(`✓ prune: ${runsRoot} does not exist — nothing to prune`);
    return process.exit(0);
  }

  let deleted = 0;
  let kept = 0;

  for (const scenarioSlug of readdirSync(runsRoot).sort()) {
    const scenarioDir = join(runsRoot, scenarioSlug);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(scenarioDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    // Rank run dirs: (1) real-run first (a completed/in-flight run outranks an empty scaffold dir for a
    // keep slot), (2) newest first (mtime desc), (3) name desc as a deterministic tiebreaker.
    const sorted = readdirSync(scenarioDir)
      .map((name) => ({ name, path: join(scenarioDir, name) }))
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
    const pinned = sorted.filter((d) => d.name.startsWith("sess-"));
    const ephemeral = sorted.filter((d) => !d.name.startsWith("sess-"));

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
        if (!dryRun) rmSync(d.path, { recursive: true, force: true });
        log(`${dryRun ? "(dry-run) " : ""}✗ pruned pinned ${d.path}`);
        deleted++;
      } else {
        kept++;
      }
    }

    for (let i = 0; i < ephemeral.length; i++) {
      if (i < keepLast) {
        kept++;
      } else {
        if (!dryRun) {
          rmSync(ephemeral[i].path, { recursive: true, force: true });
        }
        log(`${dryRun ? "(dry-run) " : ""}✗ pruned ${ephemeral[i].path}`);
        deleted++;
      }
    }
  }

  log(
    deleted > 0
      ? `✓ prune: pruned ${deleted} run dir(s), kept ${kept}${dryRun ? " (dry-run — nothing deleted)" : ""}`
      : `✓ prune: nothing to prune (${kept} run dir(s) within --keep-last ${keepLast})`,
  );
  return process.exit(0);
}

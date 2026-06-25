import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../cli-args.js";
import { runsWriteRoot } from "./trace-view.js";

const log = (s: string) => process.stderr.write(s + "\n");

const DEFAULT_KEEP_LAST = 5;

/** H6: a "real run" — has a `result.json` (completed; success OR a recorded error) OR an `events.jsonl`
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
 *  Pinned `sess-*` dirs (persisted, resumable `--session-id` sessions) are retained unconditionally.
 *  The default root is the flat, machine-global `~/.cowork-harness/runs` (shared across projects), so a
 *  bare `prune` prunes ephemeral runs from ALL projects; pass an explicit <runs-dir> to scope it.
 *  Safe by default (dry-run-able). */
export function cmdRunsGc(args: string[]): void {
  let p;
  try {
    p = parseArgs(args, {
      booleans: ["--dry-run"],
      values: ["--keep-last"],
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

  const dryRun = p.flags["--dry-run"] ?? false;
  const runsRoot = p.positionals[0] ?? runsWriteRoot();

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

    // Rank run dirs: (1) real-run first (H6 — a completed/in-flight run outranks an empty scaffold dir for a
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
    kept += pinned.length;

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

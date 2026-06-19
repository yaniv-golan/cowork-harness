import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../cli-args.js";
import { runsWriteRoot } from "./trace-view.js";

const log = (s: string) => process.stderr.write(s + "\n");

const DEFAULT_KEEP_LAST = 5;

/** `cowork-harness runs gc [--keep-last <n>] [--dry-run] [<runs-dir>]`
 *
 *  For each scenario directory under the runs root, sorts run dirs by mtime descending
 *  (newest first) with the directory name as a tiebreaker, then removes all but the N most recent.
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
    log(`runs gc takes an optional <runs-dir> (got ${p.positionals.length}: ${p.positionals.join(", ")})`);
    return process.exit(2);
  }

  const rawKeep = p.options["--keep-last"];
  const keepLast = rawKeep !== undefined ? Number(rawKeep) : DEFAULT_KEEP_LAST;
  if (!Number.isInteger(keepLast) || keepLast < 1) {
    log(`runs gc: --keep-last must be a positive integer (got ${rawKeep})`);
    return process.exit(2);
  }

  const dryRun = p.flags["--dry-run"] ?? false;
  const runsRoot = p.positionals[0] ?? runsWriteRoot();

  if (!existsSync(runsRoot)) {
    log(`✓ runs gc: ${runsRoot} does not exist — nothing to prune`);
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

    // Sort run dirs: newest first (mtime desc), name desc as tiebreaker for determinism.
    const runDirs = readdirSync(scenarioDir)
      .map((name) => ({ name, path: join(scenarioDir, name) }))
      .filter(({ path }) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => {
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
      })
      .map(({ path }) => path);

    for (let i = 0; i < runDirs.length; i++) {
      if (i < keepLast) {
        kept++;
      } else {
        if (!dryRun) {
          rmSync(runDirs[i], { recursive: true, force: true });
        }
        log(`${dryRun ? "(dry-run) " : ""}✗ pruned ${runDirs[i]}`);
        deleted++;
      }
    }
  }

  log(
    deleted > 0
      ? `✓ runs gc: pruned ${deleted} run dir(s), kept ${kept}${dryRun ? " (dry-run — nothing deleted)" : ""}`
      : `✓ runs gc: nothing to prune (${kept} run dir(s) within --keep-last ${keepLast})`,
  );
  return process.exit(0);
}

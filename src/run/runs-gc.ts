import { applyParsedCommandGlobals, runDirFlagGiven, withCommandGlobals } from "./command-globals.js";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "../cli-args.js";
import { defaultRunsHome, runsWriteRoot } from "./trace-view.js";
import { MANIFEST_FILE } from "../eval/manifest.js";
import { classifyRunDir } from "./turn-layout.js";
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

/** The run-dir names prune ranks and deletes. Every writer mints one of these (see `PINNED_RUN_ID_RE` for the
 *  pinned form):
 *  - `local_<base36>`: an ordinary run's id, `process.hrtime.bigint().toString(36)` (execute.ts, chat.ts), or a
 *    pre-assigned one (`^local_[0-9a-z]{8,32}$`, execute.ts) made from a hash for an eval job (eval/schedule.ts)
 *    or a hillclimb attempt (hillclimb/job.ts). base36 from `toString(36)` is lowercase.
 *  Any other child of a scenario dir is left alone and counted, so a wrong root that the shape check cannot
 *  recognise (a home dir, a repo, a hillclimb flow dir) loses nothing. */
export const LOCAL_RUN_ID_RE = /^local_[0-9a-z]+$/;
/** `sess-<id>`: a pinned run, `--session-id <id>` with `<id>` limited to `[A-Za-z0-9_-]+` (execute.ts), or a
 *  critique's `sess-crit-<uuid>`. Deleted only under `--pinned-older-than`. */
export const PINNED_RUN_ID_RE = /^sess-[A-Za-z0-9_-]+$/;

/** `p` is a regular file, following a symlink as the deletion loop does. A DIRECTORY named `status.json` or
 *  `events.jsonl` is a scenario slug, not a marker. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** What marks a dir as a run dir. ONE reader for both the keep-slot ranking (`isRealRun`) and the level check
 *  (`looksLikeRunDir`), so the two cannot drift. Markers are regular files, or numbered `turns/<N>` dirs. */
export interface RunDirEvidence {
  /** status.json (any content: a damaged one still marks a run dir). */
  status: boolean;
  /** .origin, the pinned-run marker written before status.json. */
  origin: boolean;
  events: boolean;
  /** `turns/<N>/` with a canonical numeric N. A bare `turns/` dir is not enough: `turns` can be a scenario slug. */
  turns: boolean;
  /** Pre-layout per-turn files at the dir's root (`classifyRunDir`'s markers that are regular files). */
  legacy: string[];
}
export function runDirEvidence(dir: string): RunDirEvidence {
  const shape = classifyRunDir(dir);
  return {
    status: isFile(join(dir, "status.json")),
    origin: isFile(join(dir, ".origin")),
    events: isFile(join(dir, "events.jsonl")),
    turns: shape.kind === "turns" || shape.kind === "mixed",
    legacy: shape.kind === "legacy" || shape.kind === "mixed" ? shape.markers.filter((m) => isFile(join(dir, m))) : [],
  };
}

/** A "real run" — has completed at least one turn (`turns/<N>/`) OR has an `events.jsonl` (a session started, so
 *  the run is in-flight or threw — e.g. an unanswered gate under on_unanswered:fail writes no turn dir but DOES
 *  leave events.jsonl) OR is a PRE-LAYOUT dir. A never-started empty `scaffold`/failed-before-session dir has none
 *  of these (status.json alone does not count) → it is what GC should drop first. `events.jsonl` exists from
 *  session start, so an in-flight run is protected without a wall-clock guard.
 *  The legacy arm: this predicate reasons about the RANKING population, which is history, not about what
 *  current writers produce. Without it an unmigrated legacy dir (root result.json, no events.jsonl) dropped into
 *  the junk tier and prune deleted it ahead of an empty scaffold: silent destruction of exactly the history
 *  `migrate-run-dir` exists to preserve. */
const isRealRunFrom = (e: RunDirEvidence): boolean => e.turns || e.events || e.legacy.length > 0;
export const isRealRun = (dir: string): boolean => isRealRunFrom(runDirEvidence(dir));
const looksLikeRunDirFrom = (e: RunDirEvidence): boolean => e.status || e.origin || isRealRunFrom(e);
/** Anything that marks `dir` as a run dir, the scaffold tier (status.json or .origin only) included.
 *  `isRealRun(d)` implies `looksLikeRunDir(d)`. */
export const looksLikeRunDir = (dir: string): boolean => looksLikeRunDirFrom(runDirEvidence(dir));

/** Up to three markers, in a fixed order, for a message. */
function markerList(e: RunDirEvidence): string {
  return [e.status && "status.json", e.events && "events.jsonl", e.origin && ".origin", e.turns && "turns/", ...e.legacy]
    .filter((m): m is string => typeof m === "string")
    .slice(0, 3)
    .join(", ");
}

/** The level scan's bounds. It runs on whatever path the user typed, a home dir included, so it must stay cheap:
 *  at most LEVEL_SCAN_MAX_CHILDREN children of any one dir are looked at, and the whole scan stops looking for
 *  more evidence after LEVEL_SCAN_BUDGET entries. What it does not see is still protected by the name allowlist. */
const LEVEL_SCAN_MAX_CHILDREN = 2000;
const LEVEL_SCAN_BUDGET = 20_000;
/** Entries the current level scan may still examine; undefined outside `pruneLevelRefusal` (no bound). */
let scanBudget: number | undefined;
/** Spend `n` units of the level-scan budget; false once it is spent. Always true outside a level scan. */
function charge(n: number): boolean {
  if (scanBudget === undefined) return true;
  scanBudget -= n;
  return scanBudget >= 0;
}

/** Dir children of `dir` for the level scan, sorted, following symlinks as the deletion loop does. Dot entries
 *  (`.migrating`, `.git`, `.Trash`, ...) are never descended into: no writer names a scenario or a run with a
 *  leading dot. An unreadable dir (EPERM, EACCES) has no children. */
function dirChildren(dir: string): string[] {
  if (!charge(1)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names
    .filter((x) => !x.startsWith("."))
    .sort()
    .slice(0, LEVEL_SCAN_MAX_CHILDREN)) {
    if (!charge(1)) break;
    if (isDir(join(dir, n))) out.push(n);
  }
  return out;
}
/** `looksLikeRunDir`, charged to the level-scan budget (false once it is spent). */
const scanLooksLikeRunDir = (dir: string): boolean => charge(1) && looksLikeRunDir(dir);
const looksLikeScenarioDir = (dir: string): boolean => dirChildren(dir).some((x) => scanLooksLikeRunDir(join(dir, x)));
/** Every non-dot child of `dir` is named like a run id (a scenario whose runs are all empty scaffold dirs). */
function runIdNamed(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return false;
  }
  return names.length > 0 && names.every((n) => LOCAL_RUN_ID_RE.test(n) || PINNED_RUN_ID_RE.test(n));
}
/** What marks `dir` as a runs root, or undefined. The deep branch never descends into a run-shaped dir:
 *  a run dir's `turns/1/result.json` would read as a pre-layout run one level down. */
function runsRootEvidence(dir: string): string | undefined {
  if (isFile(join(dir, "index.jsonl"))) return "index.jsonl";
  if (isFile(join(dir, "capability-cache.json"))) return "capability-cache.json";
  if (isDir(join(dir, MIGRATION_JOURNAL_DIR))) return `${MIGRATION_JOURNAL_DIR}/`;
  for (const x of dirChildren(dir)) {
    const px = join(dir, x);
    if (scanLooksLikeRunDir(px)) continue;
    const y = dirChildren(px).find((n) => scanLooksLikeRunDir(join(px, n)));
    if (y !== undefined) return `a <scenario>/<run> dir, ${x}/${y}`;
  }
  return undefined;
}

const DEFAULT_RUNS_DIR_NAME = basename(defaultRunsHome());

/** Why `root` is not at the runs-root level, as a two-line message, or undefined. Checked once, before anything
 *  is deleted and whatever the flags (`--dry-run` included). First match wins, outermost evidence first: a dir
 *  inside a run dir, a run dir, an eval dir, a scenario dir, then a dir holding a runs root. A root this cannot
 *  recognise (a home dir, a repo) is left to the name allowlist: nothing in it is named like a run id.
 *  ANY run-shaped child refuses: a false refusal costs a re-typed path, a false delete costs history.
 *  `source` is appended to the path in the message (e.g. where the root came from). The scan is bounded (see
 *  LEVEL_SCAN_BUDGET). */
export function pruneLevelRefusal(root: string, source = ""): string | undefined {
  scanBudget = LEVEL_SCAN_BUDGET;
  try {
    return levelRefusal(root, source);
  } finally {
    scanBudget = undefined;
  }
}

/** At most this many runs roots are looked for under the given root; the message lists three. */
const MAX_ROOTS_FOUND = 4;

function levelRefusal(root: string, source: string): string | undefined {
  const abs = resolve(root);
  const refuse = (what: string, hint: string) => `prune: ${root}${source} ${what}. Nothing was deleted.\n  ${hint}`;
  /** A hint that points at a WIDER root must say what pruning it does. */
  const wider = (w: string) =>
    `prune takes the runs root, which holds <scenario>/<run> dirs; that looks like ${w}. prune has no per-scenario scope: on ${w} it ` +
    `applies --keep-last to every scenario there. Preview it first: cowork-harness prune --dry-run ${w}`;

  if (!isDir(abs)) return refuse("is not a directory", "prune takes the runs root, a directory that holds <scenario>/<run> dirs.");

  // Inside a run dir (`<run>/work`, `<run>/turns`, `<run>/turns/1`, `<run>/work/outputs`): the loop would treat
  // `outputs/` and the like as scenarios. Checked BEFORE the root's own shape, so `<run>/turns/1` (which has a
  // result.json of its own) names the run dir it is in, not itself. A VALID harness status.json is required, not
  // any marker: the ancestors of a correct root are dirs like ~ or /tmp, where a stray result.json is plausible
  // and a harness status file is not.
  let a = abs;
  for (let i = 0; i < 3; i++) {
    const up = dirname(a);
    if (up === a) break;
    a = up;
    const st = join(a, "status.json");
    if (isFile(st) && isValidRunStatus(readSmallJson(st))) return refuse(`is inside the run dir ${a}`, wider(dirname(dirname(a))));
  }

  const own = runDirEvidence(abs);
  if (looksLikeRunDirFrom(own))
    return refuse(`looks like a run dir, not a runs root (it has ${markerList(own)})`, wider(dirname(dirname(abs))));

  const evalHint =
    "prune does not prune evals. An eval's runs live in the runs root it ran against (by default ~/.cowork-harness/runs), " +
    "and `eval report <eval-dir>` rebuilds a report from the eval dir alone.";
  if (isFile(join(abs, MANIFEST_FILE))) return refuse(`looks like an eval dir (it has ${MANIFEST_FILE}), not a runs root`, evalHint);

  const children = dirChildren(abs);
  for (const c of children) {
    if (!charge(1)) break;
    const e = runDirEvidence(join(abs, c));
    if (looksLikeRunDirFrom(e))
      return refuse(`looks like a scenario dir, not a runs root: ${join(root, c)} is a run dir (${markerList(e)})`, wider(dirname(abs)));
  }

  // Is the root itself a runs root? Then a child holding manifest.json is just a dir the allowlist leaves alone,
  // and a child that is a runs root is a NESTED one.
  const scenarioChildren = new Set(children.filter((c) => looksLikeScenarioDir(join(abs, c))));
  const isRootItself = runsRootEvidence(abs) !== undefined || scenarioChildren.size > 0;

  if (!isRootItself) {
    const evalChild = children.find((c) => isFile(join(abs, c, MANIFEST_FILE)));
    if (evalChild !== undefined)
      return refuse(`looks like a dir of eval dirs, not a runs root: ${join(root, evalChild)} has ${MANIFEST_FILE}`, evalHint);
  }

  // A child that is itself a runs root, or carries the default runs-dir name. A scenario that happens to be
  // named like that is exempt: it has run-shaped children, or (only scaffold dirs) run-id-named ones.
  const roots: Array<{ name: string; why: string }> = [];
  for (const c of children) {
    if (roots.length >= MAX_ROOTS_FOUND) break;
    if (scenarioChildren.has(c)) continue;
    const pc = join(abs, c);
    const ev = runsRootEvidence(pc);
    if (ev !== undefined) roots.push({ name: c, why: ev });
    else if (c === DEFAULT_RUNS_DIR_NAME && !runIdNamed(pc)) roots.push({ name: c, why: "the default runs-dir name" });
  }
  if (roots.length === 0) return undefined;
  // The default name first: it is the likeliest one meant.
  roots.sort((x, y) => Number(y.name === DEFAULT_RUNS_DIR_NAME) - Number(x.name === DEFAULT_RUNS_DIR_NAME));
  const shown = roots.slice(0, 3);
  const more = roots.length > shown.length ? ", and more" : "";
  const list = shown.map((r) => `${join(root, r.name)} (${r.why})`).join(", ") + more;
  const first = join(abs, shown[0].name);
  if (isRootItself)
    return refuse(
      `holds ${roots.length === 1 ? "a nested runs root" : "nested runs roots"}, so prune cannot run on it: ${list}`,
      `Prune each nested runs root by its own path (preview first: cowork-harness prune --dry-run ${first}), or move it out of ${abs}.`,
    );
  return refuse(
    `looks like the parent of ${roots.length === 1 ? "a runs root" : "runs roots"}: ${list}`,
    `prune takes the runs root itself. Did you mean: cowork-harness prune --dry-run ${first}` +
      (shown.length > 1
        ? ` (or ${shown
            .slice(1)
            .map((r) => join(abs, r.name))
            .join(", ")})`
        : ""),
  );
}

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
 *  THE ROOT MUST BE AT THE RUNS-ROOT LEVEL, whatever set it (positional, --run-dir, the env var, the default):
 *  pruneLevelRefusal refuses a run dir, a dir inside one, an eval dir, a scenario dir, or a dir holding a runs
 *  root, with exit 2 and nothing deleted, --dry-run included. Below that, only dirs named like a run id
 *  (LOCAL_RUN_ID_RE, and PINNED_RUN_ID_RE under --pinned-older-than) are ever deleted; every other child of a
 *  scenario dir is left alone and counted.
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
  // ONE check, before anything is deleted and before every flag: a per-scenario check inside the loop would
  // delete earlier-sorted children before refusing.
  const fromEnv = p.positionals[0] === undefined && !runDirFlagGiven() && process.env.COWORK_HARNESS_RUNS_DIR !== undefined;
  const refusal = pruneLevelRefusal(runsRoot, fromEnv ? " (from COWORK_HARNESS_RUNS_DIR)" : "");
  if (refusal !== undefined) {
    log(refusal);
    return process.exit(2);
  }

  let deleted = 0;
  // Children of a scenario dir that are not named like a run id: left alone, counted. The run-shaped ones are
  // counted apart, with a few paths, since they are the ones a user may have expected prune to manage.
  let otherDirs = 0;
  const oddRuns: string[] = [];
  let runNamed = 0;
  // A dir prune may not read (EPERM/EACCES, e.g. ~/.Trash) is skipped and counted, not a crash.
  const unreadable: string[] = [];
  const readNames = (dir: string): string[] | undefined => {
    try {
      return readdirSync(dir);
    } catch {
      unreadable.push(dir);
      return undefined;
    }
  };
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

  for (const scenarioSlug of (readNames(runsRoot) ?? []).sort()) {
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
    // Only dirs named like a run id are candidates (see LOCAL_RUN_ID_RE / PINNED_RUN_ID_RE). Dotfiles are not
    // counted (.DS_Store and the like).
    const scenarioNames = readNames(scenarioDir);
    if (scenarioNames === undefined) continue;
    const dirs = scenarioNames.filter((name) => isDir(join(scenarioDir, name))).sort();
    for (const name of dirs) {
      if (name.startsWith(".") || LOCAL_RUN_ID_RE.test(name) || PINNED_RUN_ID_RE.test(name)) continue;
      if (looksLikeRunDir(join(scenarioDir, name))) oddRuns.push(join(scenarioDir, name));
      else otherDirs++;
    }
    const runIdDirs = dirs.filter((name) => LOCAL_RUN_ID_RE.test(name) || PINNED_RUN_ID_RE.test(name));
    runNamed += runIdDirs.length;
    const sorted = runIdDirs
      .map((name) => {
        const path = join(scenarioDir, name);
        return { name, path, label: runLabelOf(path), real: isRealRun(path) };
      })
      .sort((a, b) => {
        if (a.real !== b.real) return a.real ? -1 : 1; // a real run ranks ahead of an empty/incomplete dir
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
    const pinned = sorted.filter((d) => PINNED_RUN_ID_RE.test(d.name));
    const rest = sorted.filter((d) => LOCAL_RUN_ID_RE.test(d.name));
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

  if (unreadable.length > 0)
    log(
      `↷ prune: skipped ${unreadable.length} dir(s) it could not read: ${unreadable.slice(0, 3).join(", ")}` +
        (unreadable.length > 3 ? ` (+${unreadable.length - 3} more)` : ""),
    );
  if (otherDirs > 0)
    log(
      `↷ prune: left alone ${otherDirs} dir(s) not named like a run (prune only touches dirs named local_ followed by lowercase ` +
        `letters and digits, and sess- ones under --pinned-older-than)`,
    );
  if (oddRuns.length > 0)
    log(
      `↷ prune: left ${oddRuns.length} run-shaped dir(s) with an unrecognised name alone: ${oddRuns.slice(0, 3).join(", ")}` +
        (oddRuns.length > 3 ? ` (+${oddRuns.length - 3} more)` : ""),
    );
  if (runNamed === 0 && otherDirs + oddRuns.length > 0)
    log(
      `  no <scenario>/<run> dirs found under ${runsRoot}; the default runs root is ~/.cowork-harness/runs (or $COWORK_HARNESS_RUNS_DIR)`,
    );
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

// Queryable cross-run result store. index.jsonl (one JSON line per run) is the SOURCE OF TRUTH for
// "what runs exist" — the run-dir-per-run physical layout (<runsRoot>/<slug>/<runId>/) still holds the
// heavy artifacts (events.jsonl/trace.json/result.json); only the discovery/query layer moved here.
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, lstatSync, statSync } from "node:fs";
import { classifyRunDir, hasTurnDirs, listTurns, turnArtifactPath } from "./turn-layout.js";
import { execFileSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";
import { budgetFields } from "../assert.js";
import { warn, writeTextAtomic } from "../io.js";
import { containedRealPath } from "../boundary-paths.js";

export interface RunIndexRow {
  v: 1;
  ts: string; // ISO
  command: "run" | "skill" | "record" | "chat";
  scenario: string;
  slug: string; // the <runsRoot>/<slug>/ path segment (slugForPath(scenario) at write time)
  runId: string; // the <slug>/<runId>/ path segment — local_<hrtime> | sess-<id>
  fidelity: string;
  effectiveFidelity?: string;
  baseline: string;
  result: "success" | "error";
  pass: boolean;
  // Run-identity (iterate-across-fixes loop): the human --label tag + a short prefix of the AUTHORITATIVE
  // content-exact skill-version key (fingerprint.skillHash) — so a harvest/group-by step reads both off
  // the index without opening each result.json. Additive-optional (no `v` bump). Re-derived honestly by
  // reindexFromRunsTree from result.json (unlike `git`).
  runLabel?: string;
  skillHash?: string;
  // 1-based turn number within a resumed (`--session-id`+`--resume`) session, straight from
  // RunResult.turn — set on essentially every run/skill/record completion (a fresh single-shot run gets
  // turn:1). THE per-completion identity discriminator `reindexFromRunsTree` merges rows by: a resumed
  // session's turns (and critique's task+reflection turns) all share one `outDir`, so `outDir` alone is
  // not a valid identity for them. Absent on the chat lane (never tracked) and on rows written before
  // this field existed.
  turn?: number;
  /** Set on rows a `critique` produced, naming which of its turns this is. The index records the INNER
   *  command (`skill`) for both, so a critique was otherwise indistinguishable from a plain skill run —
   *  with three concurrent critiques of three skills against one plugin, every row read
   *  `scenario: skill-<plugin>` and the only way to tell them apart was opening each run dir.
   *
   *  Deliberately a NEW optional field rather than a new `command` value: `isValidRunIndexRow` hard-codes
   *  the command allowlist, so an older CLI reading a newer index would quarantine every critique row with
   *  a per-row warning and drop it from `stats`. Additive-optional costs nothing to old readers. */
  critiqueRole?: "task" | "reflection" | "rollup";
  /** The skill a critique actually graded (`--skill`, or the auto-selected one on a single-skill plugin).
   *  The REPORT has always carried this as `gradedSkill`; the index never did, so a harvester could not
   *  answer "which skill was this row about" without opening the run dir. */
  skill?: string;
  /** TOTAL cost of a whole critique, on its roll-up row only. The per-turn rows carry only the two graded
   *  turns; the two EVALUATOR passes are direct API calls that never produce a run of their own, so
   *  anything summing the index under-reported a critique's true spend by ~39% (measured: $10.17 indexed
   *  against $16.67 actual across three runs). The index is also the only cost record that survives run-dir
   *  pruning, so a spend trend built from it was systematically light. */
  critiqueTotalUsd?: number;
  signals: string[]; // VerdictSignal["code"][]
  costUsd?: number;
  tokens?: number;
  turns?: number;
  cacheReadTokens?: number; // summed across all models in RunResult.modelUsage (stats surfacing)
  modelCostUsd?: number; // summed across all models in RunResult.modelUsage
  /** `semantic_matches` judge spend, summed over `RunResult.assertions[].judgeCostUsd`. Separate model calls
   *  from the agent's — NOT part of `costUsd`. Absent when no assert carried a priced judge call. */
  judgeCostUsd?: number;
  /** The LLM decider's spend (`RunResult.deciderCostUsd`). Separate model calls from the agent's — NOT part
   *  of `costUsd`. Absent when no LLM decider answered or none of its calls was priced. */
  deciderCostUsd?: number;
  durationMs?: number;
  partial: boolean;
  nonDeterministic: boolean;
  outDir: string;
  git: { branch: string | null; sha: string | null };
}

/** Best-effort `git rev-parse` in cwd — null outside a repo (or if git isn't on PATH). Never throws. */
function gitInfo(): { branch: string | null; sha: string | null } {
  const rev = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };
  return { branch: rev(["rev-parse", "--abbrev-ref", "HEAD"]), sha: rev(["rev-parse", "HEAD"]) };
}

/** RunResult.outDir is `<runsRoot>/<slug>/<runId>` — the slug/runId pair IS the physical layout's own
 *  addressing, so derive them from there rather than re-deriving from `scenario` (slugForPath is already
 *  applied once at write time; re-slugifying here could theoretically drift if the algorithm ever changes). */
function slugAndRunIdFromOutDir(outDir: string): { slug: string; runId: string } {
  return { runId: basename(outDir), slug: basename(dirname(outDir)) };
}

/** Turns a real RunResult into an index row, reusing computeVerdict/budgetFields rather than re-deriving
 *  pass/fail or cost from scratch — same "don't re-implement verdict logic per writer" principle as
 *  the repeat/matrix rollups. NOT pure by default (`ts`/`git` default to "now"/the current checkout, both real I/O)
 *  — correct for the LIVE-write call sites (execute.ts, right as a run completes: "now" and "this
 *  checkout" ARE the truth). `reindexFromRunsTree` overrides both explicitly, because for a HISTORICAL run
 *  being walked off disk, "now" and "the checkout doing the reindexing" are not the run's actual
 *  provenance — they'd be fabricated, not derived. */
/** critique mints its session id as `${CRITIQUE_SESSION_PREFIX}${randomUUID()}` and the run dir becomes
 *  `sess-<sessionId>`, so the role is derivable where the row is built — no spawn plumbing, no new CLI
 *  surface, and no env marker (which would leak into the agent's sandbox on hostloop, where the agent is
 *  spawned over the operator's full `process.env`).
 *
 *  Anchored to the FULL minted shape, not the bare prefix: `--session-id` is a public flag accepting any
 *  `[A-Za-z0-9_-]+`, so `skill --session-id crit-mytest` would otherwise be mis-marked as a critique turn.
 *  `critique/command.ts` mints from the same exported constant, and a round-trip test binds the two so a
 *  rename on one side alone fails rather than silently un-marking every future row. */
export const CRITIQUE_SESSION_PREFIX = "crit-";
const CRITIQUE_RUN_ID_RE = new RegExp(`^sess-${CRITIQUE_SESSION_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
// Case-SENSITIVE deliberately: `randomUUID()` mints lowercase, so accepting `sess-CRIT-<UUID>` (reachable
// via the public --session-id) would fabricate a role for a run critique never made.

/** `undefined` for anything that is not exactly turn 1 or 2 of a critique. A user resuming a `sess-crit-*`
 *  session with the public `--session-id`/`--resume` flags produces turn >= 3; labelling that "task" would
 *  fabricate provenance, which is worse than leaving it unmarked. */
function critiqueRoleFor(runId: string, turn: number | undefined): RunIndexRow["critiqueRole"] {
  if (!CRITIQUE_RUN_ID_RE.test(runId)) return undefined;
  if (turn === 1) return "task";
  if (turn === 2) return "reflection";
  return undefined;
}

export function indexRowFromResult(
  result: RunResult,
  opts: {
    command: "run" | "skill" | "record" | "chat";
    partial: boolean;
    ts?: string;
    git?: { branch: string | null; sha: string | null };
  },
): RunIndexRow {
  const verdict = computeVerdict(result, "live");
  const budget = budgetFields(result);
  const { slug, runId } = slugAndRunIdFromOutDir(result.outDir);
  // Separate from budgetFields — sums across RunResult.modelUsage's per-model entries, a
  // different data source than the SDK result message's own cost/usage totals.
  const modelUsageEntries = result.modelUsage ? Object.values(result.modelUsage) : undefined;
  const cacheReadTokens = modelUsageEntries?.reduce(
    (sum, m) => sum + (typeof m.cacheReadInputTokens === "number" ? m.cacheReadInputTokens : 0),
    0,
  );
  const modelCostUsd = modelUsageEntries?.reduce((sum, m) => sum + (typeof m.costUSD === "number" ? m.costUSD : 0), 0);
  const judgeCosts = result.assertions.flatMap((a) => (typeof a.judgeCostUsd === "number" ? [a.judgeCostUsd] : []));
  const judgeCostUsd = judgeCosts.length ? judgeCosts.reduce((sum, c) => sum + c, 0) : undefined;
  return {
    v: 1,
    ts: opts.ts ?? new Date().toISOString(),
    command: opts.command,
    scenario: result.scenario,
    slug,
    runId,
    fidelity: result.fidelity,
    effectiveFidelity: result.effectiveFidelity,
    baseline: result.baseline,
    result: result.result,
    pass: verdict.pass,
    runLabel: result.runLabel,
    skillHash: result.fingerprint?.skillHash?.slice(0, 12), // short prefix — the full hash lives in result.json
    turn: result.turn,
    critiqueRole: critiqueRoleFor(runId, result.turn),
    signals: verdict.signals.map((s) => s.code),
    costUsd: budget.costUsd,
    tokens: budget.tokensTotal,
    turns: budget.turns,
    cacheReadTokens,
    modelCostUsd,
    judgeCostUsd,
    deciderCostUsd: result.deciderCostUsd,
    durationMs: result.durationMs,
    partial: opts.partial,
    nonDeterministic: !!result.nonDeterministic,
    outDir: result.outDir,
    git: opts.git ?? gitInfo(),
  };
}

function indexPath(runsRoot: string): string {
  return join(runsRoot, "index.jsonl");
}

/** The stable event identity `reindexFromRunsTree` merges rows by — NEVER `outDir` alone, which is a
 *  mutable STORAGE LOCATION, not an event: a resumed session's every turn (and critique's task +
 *  reflection turns) write to the same `outDir`. When `turn` is present (essentially every run/skill/record
 *  row from now on) it precisely distinguishes one completion from another sharing that outDir. Rows with
 *  no `turn` (the chat lane, or a row written before this field existed) fall back to bare `outDir` —
 *  this module's historical behavior for that case, and the only signal available to disambiguate them;
 *  it is not a fix for pre-existing legacy data, only for every row written going forward. */
function rowIdentity(r: RunIndexRow): string {
  // A critique's roll-up shares its outDir with the two turn rows and has no `turn` of its own, so without
  // the role it would collide with a legacy no-turn row under bare `outDir` and be merged away on reindex.
  if (r.critiqueRole === "rollup") return `${r.outDir} critique:rollup`;
  return r.turn !== undefined ? `${r.outDir} turn:${r.turn}` : r.outDir;
}

/** Runtime shape check for a parsed index line — `JSON.parse` only proves valid JSON, not a valid
 *  `RunIndexRow`; a same-shaped-but-wrong-typed object (or one from an incompatible future schema) must
 *  never be cast and handed to `buildStats`, which dereferences `r.git.branch` unconditionally. Uses the
 *  otherwise-unused `v` field as the schema-version gate: anything not exactly `v:1` is rejected outright
 *  rather than assumed compatible. */
function isValidRunIndexRow(x: unknown): x is RunIndexRow {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (r.v !== 1) return false;
  if (typeof r.ts !== "string") return false;
  if (typeof r.command !== "string" || !["run", "skill", "record", "chat"].includes(r.command)) return false;
  if (typeof r.scenario !== "string") return false;
  if (typeof r.slug !== "string") return false;
  if (typeof r.runId !== "string") return false;
  if (typeof r.fidelity !== "string") return false;
  if (typeof r.baseline !== "string") return false;
  if (r.result !== "success" && r.result !== "error") return false;
  if (typeof r.pass !== "boolean") return false;
  if (!Array.isArray(r.signals)) return false;
  if (typeof r.partial !== "boolean") return false;
  if (typeof r.nonDeterministic !== "boolean") return false;
  if (typeof r.outDir !== "string") return false;
  // Type-checked because `rowIdentity` interpolates it: a string "2" would otherwise mint an identity
  // distinct from the numeric 2 the walk derives, resurrecting the duplicate-row failure the merge guards.
  if (r.turn !== undefined && typeof r.turn !== "number") return false;
  // Same reasoning as `turn`: `critiqueRole` is interpolated into `rowIdentity`, so a wrong-typed value
  // would mint a distinct identity and resurrect the duplicate-row failure the merge guards against.
  if (r.critiqueRole !== undefined && !["task", "reflection", "rollup"].includes(r.critiqueRole as string)) return false;
  if (r.skill !== undefined && typeof r.skill !== "string") return false;
  if (r.critiqueTotalUsd !== undefined && typeof r.critiqueTotalUsd !== "number") return false;
  // Type-checked for the same reason as the three above — because they are CONSUMED. `stats` filters on
  // `skillHash` with `String.prototype.startsWith` and groups on both, so a corrupt/hand-edited row
  // carrying `"skillHash": 123` (valid JSON) would otherwise pass quarantine and throw a TypeError out
  // of `buildStats` — the CLI crashing on exactly the input class this quarantine exists to absorb.
  if (r.skillHash !== undefined && typeof r.skillHash !== "string") return false;
  if (r.runLabel !== undefined && typeof r.runLabel !== "string") return false;
  if (typeof r.git !== "object" || r.git === null) return false;
  const git = r.git as Record<string, unknown>;
  if (git.branch !== null && typeof git.branch !== "string") return false;
  if (git.sha !== null && typeof git.sha !== "string") return false;
  return true;
}

/** Single-line O_APPEND write — atomic at these sizes, safe under `record --concurrency`'s in-process
 *  pool (same reasoning as the writer note in async-pool.ts). Creates `runsRoot` if it doesn't exist yet
 *  (a fresh machine's first run). */
export function appendIndexRow(runsRoot: string, row: RunIndexRow): void {
  mkdirSync(runsRoot, { recursive: true });
  appendFileSync(indexPath(runsRoot), JSON.stringify(row) + "\n");
}

/** One roll-up row per completed `critique`, carrying the cost the per-turn rows CANNOT.
 *
 *  A critique is four model workloads: two graded turns (which each produce a run, and therefore a row) and
 *  two evaluator passes (direct API calls that produce no run at all). Summing the index therefore missed
 *  the evaluator passes entirely — measured at $10.17 indexed against $16.67 actual across three runs, a
 *  39% under-report — and the index is the only cost record that survives run-dir pruning, so a spend trend
 *  built from it was systematically light.
 *
 *  Deliberately NOT synthesized as two more turn-shaped rows: an evaluator pass has no `outDir`, no
 *  `scenario` and no fingerprint, so a per-pass row would have to fabricate the fields every other consumer
 *  of this file relies on. One honest roll-up beats two fictional runs.
 *
 *  `pass: true` and `signals: []` because this row is bookkeeping, not a verdict — the graded turn's own row
 *  already carries the verdict, and a roll-up that voted would double-count it in `stats`' pass rate. */
export function appendCritiqueRollupRow(
  runsRoot: string,
  args: {
    outDir: string;
    scenario: string;
    fidelity: string;
    effectiveFidelity?: string;
    baseline: string;
    /** WHOLE-critique total → `critiqueTotalUsd`. */
    totalUsd?: number;
    /** The two evaluator passes only → this row's `costUsd`. See the field note below. */
    evaluatorUsd?: number;
    complete: boolean;
    runLabel?: string;
    skill?: string;
    skillHash?: string;
    durationMs?: number;
    ts?: string;
  },
): void {
  const { slug, runId } = slugAndRunIdFromOutDir(args.outDir);
  appendIndexRow(runsRoot, {
    v: 1,
    ts: args.ts ?? new Date().toISOString(),
    command: "skill", // the INNER command both turns ran; `critiqueRole` is what identifies this row
    critiqueRole: "rollup",
    scenario: args.scenario,
    slug,
    runId,
    fidelity: args.fidelity,
    effectiveFidelity: args.effectiveFidelity,
    baseline: args.baseline,
    // A critique that produced a report succeeded as an INSTRUMENT regardless of what it found — findings
    // never gate. An incomplete cost is the one thing that must not read as authoritative, so it degrades
    // the row's `result` rather than being silently summed as if whole.
    result: args.complete ? "success" : "error",
    pass: true,
    runLabel: args.runLabel,
    skill: args.skill,
    skillHash: args.skillHash?.slice(0, 12),
    critiqueTotalUsd: args.totalUsd,
    signals: [],
    // The EVALUATOR passes only — deliberately not the whole-critique total. `costUsd` is the per-row
    // spend field every consumer sums, and the two graded turns already contribute their own rows; putting
    // the total here would double-count them, while leaving it undefined would under-count by exactly the
    // ~39% this row exists to fix. The delta makes `sum(costUsd)` over all rows equal true spend with no
    // trap in either direction. `critiqueTotalUsd` remains the per-critique convenience figure.
    costUsd: args.evaluatorUsd,
    durationMs: args.durationMs,
    partial: !args.complete,
    nonDeterministic: false,
    outDir: args.outDir,
    git: gitInfo(),
  });
}

/** Reads every row, tolerating a corrupt/truncated TRAILING line (a crash mid-append) by skipping just
 *  that line rather than throwing and losing every prior row. Also validates every successfully-parsed
 *  line against the `RunIndexRow` shape (see `isValidRunIndexRow`) and quarantines (skips, with a warning)
 *  any row that is valid JSON but the wrong shape — the returned array is never a blind cast. Returns `[]`
 *  for a runs root with no index.jsonl yet — never throws on a fresh clone / pre-index-era runs root. */
export function readIndex(runsRoot: string): RunIndexRow[] {
  const p = indexPath(runsRoot);
  if (!existsSync(p)) return [];
  const rows: RunIndexRow[] = [];
  const lines = readFileSync(p, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      // Valid JSON, wrong shape (or an incompatible future `v`) — quarantined, not cast: a cast row
      // reaches `buildStats`, which dereferences `r.git.branch` unconditionally and either throws or
      // fabricates a pass/cost value. This is a DIFFERENT failure mode from the corrupt-JSON branch below
      // (which `.catch`es a parse error) and always warns — there is no "expected trailing" shape for a
      // syntactically-valid-but-wrong-schema row.
      if (!isValidRunIndexRow(parsed)) {
        warn(
          `::warning:: stats: quarantining invalid-shape row ${i + 1} of ${indexPath(runsRoot)} (valid JSON, wrong RunIndexRow shape — not indexed, not counted): ${line.slice(0, 120)}\n`,
        );
        continue;
      }
      rows.push(parsed);
    } catch {
      // A truncated TRAILING line (the last non-empty line) is the expected shape of a crash
      // mid-append — tolerated silently, one lost row is the documented worst case. A corrupt line
      // ANYWHERE ELSE is not that failure mode — it's the one observable symptom of a genuine
      // concurrent-write interleaving bug (or manual file corruption), and silently vanishing it would
      // mask exactly the risk this module's own docs call out. Warn, don't stay quiet.
      const isTrailing = lines.slice(i + 1).every((l) => !l.trim());
      if (!isTrailing)
        warn(
          `::warning:: stats: skipping corrupt line ${i + 1} of ${indexPath(runsRoot)} (not the trailing line — investigate, don't just --reindex over it): ${line.slice(0, 120)}\n`,
        );
    }
  }
  return rows;
}

/** Discriminated outcome of reading ONE on-disk result file (the root `result.json`, or an archived
 *  `result.turn-<N>.json`) during a `reindexFromRunsTree` walk. A plain row-or-null return would force the
 *  caller to re-derive which counter (`skipped`/`skippedReplay`/`skippedUnsafe`) a given failure maps to;
 *  returning the classification instead keeps that mapping in one place — the walk loop below — for both
 *  the root file and every archived turn, rather than two hand-rolled copies that could drift apart. */
type WalkedResultFile =
  | { kind: "row"; row: RunIndexRow }
  | { kind: "missing" } // no such file, or not a regular file — not countable evidence, no counter moves
  | { kind: "unsafe" } // a symlink, or resolves outside runsRoot — counted as skippedUnsafe
  | { kind: "corrupt" } // safely resolved but the containment check raced or the JSON didn't parse — counted as skipped
  | { kind: "replay" }; // a command:"replay" result — a re-check, not new evidence — counted as skippedReplay

/** Symlink-rejecting, containment-checked, replay-aware read of one result file for the walk below. Shared
 *  by the root `result.json` and every archived `result.turn-<N>.json` in a run dir so an archived turn
 *  gets EXACTLY the same defense-in-depth (never follow a symlink; require the real path to resolve inside
 *  `runsRoot`) and the same "a corrupt file is skipped, not fatal to the whole walk" handling the root file
 *  always had — not a hand-rolled variant for the archived case. */
function readResultFileForWalk(
  runsRoot: string,
  outDir: string,
  filePath: string,
  priorByOutDir: Map<string, RunIndexRow>,
): WalkedResultFile {
  let fileLstat;
  try {
    fileLstat = lstatSync(filePath);
  } catch {
    return { kind: "missing" }; // same miss the old existsSync(resultPath) check caught
  }
  if (fileLstat.isSymbolicLink()) return { kind: "unsafe" };
  if (!fileLstat.isFile()) return { kind: "missing" };
  // Both sides are confirmed to exist (lstat above) and neither is a symlink (rejected above) — realpath
  // containment is still checked as defense-in-depth against a non-symlink escape (e.g. a TOCTOU swap of
  // an ancestor component). `realpathSync` inside throws if the entry is deleted between the lstat above
  // and this call (a concurrent `runs gc`, say). Treat that as an ordinary miss — before containment
  // checking existed the same race was absorbed as `skipped++`, and letting the raw ENOENT escape would
  // abort the entire reindex over one vanished run dir.
  let contained: boolean;
  try {
    contained = containedRealPath(runsRoot, filePath);
  } catch {
    return { kind: "corrupt" };
  }
  if (!contained) return { kind: "unsafe" };
  try {
    const result = JSON.parse(readFileSync(filePath, "utf8")) as RunResult;
    // A `command:"replay"` result is a RE-CHECK, not new evidence — see the matching comment on the walk
    // loop below for why this must never be relabeled "run" and indexed as fresh evidence.
    if (result.command === "replay") return { kind: "replay" };
    const ts = fileLstat.mtime.toISOString(); // confirmed a regular (non-symlink) file above
    // RunResult.mode has no "skill"/"record" value, so a run originally recorded under one of those
    // commands would otherwise be relabeled "run"/"chat" on every reindex. Prefer the command now
    // persisted in result.json (#48); fall back to a prior index row (for results written before that
    // field existed), then to deriving from `result.mode` for a brand-new outDir with neither.
    const prior = priorByOutDir.get(outDir);
    // `result.command` here is already narrowed to exclude "replay" (returned above), so it maps straight
    // onto the index row's command union — no re-check ever reaches this row.
    const command = result.command ?? prior?.command ?? (result.mode === "chat" ? "chat" : "run");
    const row = indexRowFromResult(result, { command, partial: !!result.partial, ts, git: { branch: null, sha: null } });
    return { kind: "row", row };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Rebuild a critique's roll-up row from `critique-report.json`, for a run dir the walk has just covered.
 *
 *  Only when the report carries `costUsd`: `persistCritiqueArtifacts` writes a report on EVERY outcome,
 *  including a task-turn infra failure where cost is never computed and the live path never appended a
 *  roll-up either — synthesizing there would mint rows real runs never produced. (Asymmetry, visible only
 *  after total index loss: a COMPLETED critique whose four workloads were all unpriced does live-append a
 *  cost-less roll-up, which this cannot recreate. Reconstructing spend is the point; a row with no spend
 *  in it is not worth fabricating.)
 *
 *  `scenario` and `runLabel` come from the GRADED TURN's row, not the report: the report carries neither,
 *  and `slug` is not reversible to `scenario` (`slugForPath` is lossy), so deriving them from the path
 *  would file the row under a fabricated scenario group. `turnRows` is THIS DIR's just-walked rows only.
 *
 *  Identity (`outDir`/`slug`/`runId`) is taken from the graded row too, NOT from the walk path. Walked rows
 *  carry `result.json`'s RECORDED `outDir`, which differs from the walk path whenever the tree has moved —
 *  a restored backup, a relocated HOME, `/var` vs `/private/var`. Keying on the walk path there produced a
 *  SECOND roll-up beside the preserved original (different `rowIdentity`) and lost the graded match, so the
 *  row also landed under a fabricated scenario: both failure modes this function exists to prevent, on the
 *  disaster-recovery path where it matters most.
 *
 *  Provenance is honest, matching the rest of the walk: `ts` is the report file's own mtime, never "now",
 *  and `git` is `{null, null}` — unknowable from an artifact on disk. */
function rollupFromCritiqueReport(outDir: string, turnRows: RunIndexRow[]): RunIndexRow | null {
  const reportPath = join(outDir, "critique-report.json");
  let report: Record<string, unknown>;
  let mtime: string;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    mtime = statSync(reportPath).mtime.toISOString();
  } catch {
    return null; // absent, unreadable, or not JSON — never sinks the reindex
  }
  const cost = report.costUsd as
    { totalUsd?: unknown; evaluatorPass1Usd?: unknown; evaluatorPass2Usd?: unknown; complete?: unknown } | undefined;
  if (!cost || typeof cost.totalUsd !== "number") return null; // no cost → the live path wrote no roll-up either
  const graded = turnRows.find((r) => r.turn === 1) ?? turnRows[0];
  const rowOutDir = graded?.outDir ?? outDir;
  const { slug, runId } = slugAndRunIdFromOutDir(rowOutDir);
  const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);
  const evaluatorUsd =
    num(cost.evaluatorPass1Usd) !== undefined || num(cost.evaluatorPass2Usd) !== undefined
      ? (num(cost.evaluatorPass1Usd) ?? 0) + (num(cost.evaluatorPass2Usd) ?? 0)
      : undefined;
  const complete = cost.complete === true;
  return {
    v: 1,
    ts: mtime,
    command: "skill",
    critiqueRole: "rollup",
    scenario: graded?.scenario ?? (typeof report.skillFolder === "string" ? `skill-${basename(report.skillFolder)}` : slug),
    slug,
    runId,
    fidelity: typeof report.fidelity === "string" ? report.fidelity : (graded?.fidelity ?? "unknown"),
    effectiveFidelity: typeof report.gradedEffectiveFidelity === "string" ? report.gradedEffectiveFidelity : undefined,
    baseline: typeof report.gradedBaseline === "string" ? report.gradedBaseline : (graded?.baseline ?? "unknown"),
    result: complete ? "success" : "error",
    pass: true,
    runLabel: graded?.runLabel,
    skill: typeof report.gradedSkill === "string" ? report.gradedSkill : undefined,
    skillHash: typeof report.gradedSkillHash === "string" ? report.gradedSkillHash.slice(0, 12) : undefined,
    critiqueTotalUsd: cost.totalUsd,
    signals: [],
    costUsd: evaluatorUsd,
    partial: !complete,
    nonDeterministic: false,
    outDir: rowOutDir,
    git: { branch: null, sha: null },
  };
}

/** One-time local migration + self-heal: rebuilds index.jsonl by walking the physical
 *  `<runsRoot>/<slug>/<runId>/result.json` tree, MERGED with any prior index.jsonl — never a blind
 *  overwrite. Every run dir still on disk gets a FRESH row (re-derived from its real result.json,
 *  replacing any stale prior entry for that same outDir); every prior row whose outDir is no longer on
 *  disk (deleted by `prune`) is PRESERVED as-is. This is what makes "the index is the durable history"
 *  (docs/stats.md) actually true across a reindex, not just across ordinary writes — an earlier version of
 *  this function did a full overwrite, which silently discarded every pruned run's history on the very
 *  operation meant to rebuild/heal it. Safe to re-run (idempotent: reindexing twice with no filesystem
 *  changes produces the same row set).
 *
 *  Walks every turn under `turns/<N>/` — each is an independent completion with its own identity. A
 *  `--resume` session or a `critique` task+reflection pair therefore contributes one row per turn. A
 *  PRE-LAYOUT dir is counted as `skippedLegacy` and reported, never half-indexed: reading the readable
 *  part of such a dir and calling it done is the failure this command exists to prevent. For a `critique`
 *  dir specifically, losing a turn would keep the reflection row and lose the GRADED row — the one consumers pair generations
 *  on. See `readResultFileForWalk` for the per-file handling shared between the root and every archive.
 *
 *  `ts`/`git` for a freshly-walked row are NOT "now"/"this checkout" — those would be fabricated
 *  provenance for a run that may have happened days/branches ago. `ts` is the result file's own mtime
 *  (the closest available proxy for "when this run completed"); `git` is honestly `{branch:null,sha:null}`
 *  (unknowable from a bare result.json). `gitInfo()` is intentionally never called during a walk (it was
 *  in an earlier version, once per row — a real perf cost, N subprocess spawns for N run dirs, for a value
 *  that was wrong anyway).
 *
 *  A missing/corrupt result.json is skipped, not fatal — a partial/crashed run dir shouldn't block indexing
 *  everything else. A slug/runId directory entry, or a result file itself, that is a SYMLINK is rejected
 *  outright (never followed) and its real path is additionally required to resolve inside `runsRoot` before
 *  it is opened — a symlinked entry under the runs root must never cause an arbitrary external file to be
 *  read and indexed as harness evidence.
 *
 *  The MERGE below keys prior rows by `rowIdentity` (turn-aware), never by bare `outDir` — a resumed
 *  session's turns (and critique's task+reflection turns) legitimately share one `outDir`, and keying by
 *  that alone would collapse N historical rows down to one on every reindex. */
export function reindexFromRunsTree(runsRoot: string): {
  rows: RunIndexRow[];
  written: number;
  skipped: number;
  skippedReplay: number;
  skippedUnsafe: number;
  /** Pre-layout dirs the walk cannot read. Reported, never silently dropped. */
  skippedLegacy: number;
} {
  const priorRows = readIndex(runsRoot);
  // Command-inheritance fallback ONLY (see below) — last-one-wins-per-outDir is fine for a heuristic hint,
  // but must never be the thing that decides which HISTORICAL rows survive a reindex (that collapse was
  // the actual defect: a mutable storage location standing in for an event identity).
  const priorByOutDir = new Map<string, RunIndexRow>();
  for (const r of priorRows) priorByOutDir.set(r.outDir, r);
  const priorByIdentity = new Map<string, RunIndexRow>();
  for (const r of priorRows) priorByIdentity.set(rowIdentity(r), r);

  const walkedIdentities = new Set<string>();
  /** outDirs that yielded a row from the ROOT `result.json` (not an archive) — see the supersede clause. */
  const rootWalkedOutDirs = new Set<string>();
  const walked: RunIndexRow[] = [];
  let skipped = 0;
  let skippedReplay = 0;
  let skippedUnsafe = 0;
  let skippedLegacy = 0;
  if (existsSync(runsRoot)) {
    for (const slug of readdirSync(runsRoot)) {
      const slugDir = join(runsRoot, slug);
      let slugLstat;
      try {
        slugLstat = lstatSync(slugDir);
      } catch {
        continue;
      }
      if (slugLstat.isSymbolicLink()) {
        skippedUnsafe++;
        continue;
      }
      if (!slugLstat.isDirectory()) continue;
      for (const runId of readdirSync(slugDir)) {
        const outDir = join(slugDir, runId);
        let outDirLstat;
        try {
          outDirLstat = lstatSync(outDir);
        } catch {
          continue;
        }
        if (outDirLstat.isSymbolicLink()) {
          skippedUnsafe++;
          continue;
        }
        if (!outDirLstat.isDirectory()) continue;

        // UNMIGRATED DIRS ARE COUNTED AND REPORTED, NEVER SILENTLY DROPPED.
        //
        // The legacy layer is gone: a pre-layout dir's artifacts live at its root, which nothing here
        // reads anymore. Skipping it quietly while printing a confident "reindexed N run(s)" is the
        // failure this command exists to prevent — `--reindex` is documented as the one-time migration
        // for pre-index runs, i.e. aimed squarely at exactly this population. The caller names
        // `migrate-run-dir` as the remedy.
        const shape = classifyRunDir(outDir);
        if (shape.kind === "legacy" || shape.kind === "mixed") {
          skippedLegacy++;
          continue;
        }

        // The only addressable shape. Each turn is an independent completion with its own identity.
        const dirRows: RunIndexRow[] = []; // just this dir's rows, for the roll-up synthesis below
        for (const n of listTurns(outDir)) {
          const p = turnArtifactPath(outDir, n, "result.json");
          const o = readResultFileForWalk(runsRoot, outDir, p, priorByOutDir);
          if (o.kind === "unsafe") skippedUnsafe++;
          else if (o.kind === "corrupt") skipped++;
          else if (o.kind === "replay") skippedReplay++;
          else if (o.kind === "row") {
            walked.push(o.row);
            dirRows.push(o.row);
            walkedIdentities.add(rowIdentity(o.row));
            rootWalkedOutDirs.add(o.row.outDir);
          }
        }
        // A critique's roll-up row has no result.json of its own — the two evaluator passes it accounts for
        // produce no run — so the walk alone could never rebuild it, and losing the index meant losing every
        // critique's cost record while `critique-report.json` sat in the dir holding it. Re-derive it here.
        const synthesized = rollupFromCritiqueReport(outDir, dirRows);
        if (synthesized) {
          walked.push(synthesized);
          walkedIdentities.add(rowIdentity(synthesized));
        }
      }
    }
  }
  // A turn-less prior row is SUPERSEDED by any walked row for its outDir, and must not be preserved
  // alongside one. Rows written before `turn` existed carry identity `<outDir>`, while the row the walk
  // re-derives from that same run's result.json carries `<outDir> turn:N` — the identities can never
  // match, so a plain "identity not walked" filter would preserve the stale row NEXT TO its own
  // replacement and permanently double-count every pre-existing run on the first reindex (and never
  // self-heal). Note `priorByIdentity` has already collapsed all turn-less rows for one outDir into a
  // single entry, so at most one such row per outDir is dropped here: the most recent turn — which is
  // exactly the completion the current result.json (and thus the walked row) represents.
  // The clause below supersedes a turn-less prior row on the grounds that the walked row "is exactly the
  // completion the current result represents". With one shape that holds for every walked row: each comes
  // from a `turns/<N>/result.json`, and a dir that cannot be read that way is skipped whole rather than
  // partially walked. (Historically this had to be restricted to ROOT rows, because an archive-only walk
  // could key on an OLDER archived turn and silently delete the legacy row: unrecoverable loss on the index that is supposed to be the
  // durable history, during the operation whose job is to heal it.
  const walkedOutDirs = rootWalkedOutDirs;
  // The turn-less clause exists to drop LEGACY rows superseded by a walked root result. A critique
  // roll-up is turn-less by nature and always shares its outDir with the two turn rows, so it matched that
  // clause and every routine `--reindex` DELETED it — destroying the only cost record that survives run-dir
  // pruning, during the operation whose job is to heal the index. Its identity (`<outDir> critique:rollup`)
  // is already collision-proof against the walked rows, so it needs no supersede protection at all.
  const preserved = [...priorByIdentity.values()].filter(
    (r) => !walkedIdentities.has(rowIdentity(r)) && !(r.critiqueRole !== "rollup" && r.turn === undefined && walkedOutDirs.has(r.outDir)),
  );
  const rows = [...walked, ...preserved];
  mkdirSync(runsRoot, { recursive: true });
  writeTextAtomic(indexPath(runsRoot), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return { rows, written: walked.length, skipped, skippedReplay, skippedUnsafe, skippedLegacy };
}

/** An exact `runId` or `slug/runId` match — split out from `resolveRunsFromIndex` (below) so
 *  `resolveEventsFile` (trace-view.ts) can interleave index/filesystem lookups tier-by-tier
 *  (index-exact → fs-exact → index-fragment → fs-fragment): an index FRAGMENT hit must never shadow a
 *  filesystem EXACT hit for a run that predates the index. */
export function resolveRunsExactFromIndex(rows: RunIndexRow[], arg: string): RunIndexRow[] {
  return rows.filter((r) => r.runId === arg || `${r.slug}/${r.runId}` === arg);
}

/** Every row whose `runId` or `scenario` CONTAINS `arg` — the fragment tier, split out for the same
 *  interleaving reason as `resolveRunsExactFromIndex` above. */
export function resolveRunsFragmentFromIndex(rows: RunIndexRow[], arg: string): RunIndexRow[] {
  return rows.filter((r) => r.runId.includes(arg) || r.scenario.includes(arg));
}

/** Resolves `arg` against index rows with exact-then-fragment semantics — an exact `runId` or `slug/runId`
 *  match wins outright; otherwise every fragment match is a candidate, and ALL candidates are returned
 *  (ambiguity is the caller's to surface, never silently resolved to "whichever sorted first"). Composed
 *  from the two tiers above; kept as its own export for callers (and tests) that just want "the index's
 *  best answer" without needing tier-by-tier interleaving against another resolver. */
export function resolveRunsFromIndex(rows: RunIndexRow[], arg: string): RunIndexRow[] {
  const exact = resolveRunsExactFromIndex(rows, arg);
  if (exact.length) return exact;
  return resolveRunsFragmentFromIndex(rows, arg);
}

/** The tier a row actually RAN at. `fidelity` is what was asked for (possibly `cowork`);
 *  `effectiveFidelity` is what resolved — comparability is about the environment, so effective leads.
 *  The fallback covers the one writer that can omit it (reindex-from-critique-report with no
 *  gradedEffectiveFidelity). TOTAL by construction — `fidelity` is a required field — so grouping on it
 *  excludes nothing and needs no hashlessRuns-style honesty channel. If the fallback ever yields the
 *  literal "cowork", grouping it separately is CORRECT: we genuinely do not know which tier it resolved
 *  to, so it is unlike everything else. */
const tierOf = (r: RunIndexRow): string => r.effectiveFidelity ?? r.fidelity;

/** How `buildStats` buckets rows. `scenario` is the historical (and default) behaviour; `skill-hash` /
 *  `label` split a scenario by run IDENTITY (the iterate-across-fixes A/B); `fidelity` splits by the
 *  tier that actually RAN (`effectiveFidelity ?? fidelity`) — the ENVIRONMENT axis, the other thing
 *  that makes two runs incomparable. */
export type StatsGroupBy = "scenario" | "skill-hash" | "label" | "fidelity";

export interface StatsSummary {
  scenario: string;
  /** Set only when grouping by that field — the group's identity, NOT folded into `scenario` (which
   *  stays exactly what it always was, so a consumer matching on it keeps working). */
  skillHash?: string;
  runLabel?: string;
  runs: number;
  passRate: number;
  /** Distinct non-undefined `skillHash` values among THIS group's post-window rows. > 1 means the
   *  aggregate compares unlike things; `stats` warns on it. Always 1 under `--group-by skill-hash`.
   *  Counts only rows that HAVE a hash — see the hashless caveat on `StatsResult.hashlessRuns`. */
  distinctSkillHashes: number;
  /** Set only when grouping by fidelity — the group's effective tier (`effectiveFidelity ?? fidelity`),
   *  NOT folded into `scenario` (which stays exactly what it always was). */
  fidelity?: string;
  /** Distinct effective tiers among THIS group's post-window rows. The key is TOTAL — every row has
   *  one — so unlike `distinctSkillHashes` there is no "rows without one" caveat and deliberately no
   *  tierless counter. > 1 means the aggregate spans environments; `stats` warns and names them.
   *  Always 1 under `--group-by fidelity`. */
  distinctTiers: number;
  /** The tier names behind `distinctTiers`, sorted — so the warning can name them without every
   *  consumer re-deriving the fallback. */
  tiers: string[];
  p50CostUsd?: number;
  p95CostUsd?: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  p50Tokens?: number;
  p95Tokens?: number;
  p50Turns?: number;
  p95Turns?: number;
  p50CacheReadTokens?: number;
  p95CacheReadTokens?: number;
  p50ModelCostUsd?: number;
  p95ModelCostUsd?: number;
  /** TOTAL spend across the group — the percentiles above exclude critique roll-up rows (a roll-up is not
   *  a run, and its cost is a whole critique's evaluator spend), this deliberately includes them. It is
   *  therefore the only figure that reflects a critique's TRUE cost: before this existed, `stats` priced
   *  the live example critique at its task turn's $0.1708 against an actual $1.0588. `undefined` when no
   *  row in the group carried cost telemetry — never 0, which would read as "free". */
  totalUsd?: number;
  /** Rows in the cost set (runs AND roll-ups) with no cost telemetry. `totalUsd` is a FLOOR when this is
   *  > 0 — the honesty channel that keeps "could not tell" from rendering as a smaller number. */
  unpricedRuns: number;
  lastGreenTs?: string;
  prunedRuns: number; // rows whose outDir no longer exists on disk — still aggregated, just flagged
}

/** `buildStats`'s full return. The summaries are the answer; `hashlessRuns` is the honesty channel —
 *  under `--group-by skill-hash`/`label` a row lacking that field is EXCLUDED (never bucketed under a
 *  blank key: a `chat` row, a run that mounted no skill, or a pre-1.5.0 skill-lane row folded into a
 *  generation would misattribute it), and a silent exclusion reads as "covered everything". */
export interface StatsResult {
  summaries: StatsSummary[];
  hashlessRuns: number;
}

/** Historical per-run cost for one scenario, newest first — the only basis a PRE-flight budget check can
 *  reason from. There is no live cost signal to abort a run mid-flight on: `cost.usd` lands only with the
 *  SDK result message, and `api_metrics` (the one mid-stream cost-adjacent event) is TTFT/output-token
 *  metering carrying no USD at all (verified against the staged agent binary). So "will this run blow my
 *  budget?" is answerable only from what the same scenario has cost before.
 *
 *  Rows without cost telemetry are skipped, NOT counted as 0 — a zero would silently pull an estimate
 *  down and let an over-budget run through, the exact false-green this check exists to prevent. */
export function scenarioCostHistory(rows: RunIndexRow[], scenario: string): number[] {
  return (
    rows
      // `isRun`, NOT `carriesSpend` — deliberately. This answers "what does ONE run of this scenario cost",
      // and a roll-up is not a run: its cost is a whole critique's evaluator spend. Summing it in here would
      // make `worst` wildly unrepresentative and REFUSE runs that are nowhere near the cap. Measured on
      // skill-csv-metrics: runs-only worst $0.1985 (a $0.50 cap correctly proceeds); with the roll-up,
      // worst $0.6912 — a false refusal of a run that will cost $0.19. The `stats` TOTAL is the place
      // roll-ups belong; a per-run history is not.
      .filter(isRun)
      .filter((r) => r.scenario === scenario && typeof r.costUsd === "number")
      .map((r) => r.costUsd!)
  );
}

/** The pre-flight verdict itself, as a pure function of history + cap so BOTH outcomes are testable
 *  without starting a paid run (the refusal path terminates the process; the proceed path does not).
 *
 *  `worst`, not a percentile: this is a refusal gate, and an estimator that under-predicts lets through
 *  exactly the expensive run the flag was reached for. Strict `>` — a history that exactly equals the cap
 *  has never breached it, and "$1.00 max, cap $1.00" should run. */
export function budgetPreflight(history: number[], maxBudgetUsd: number): { refuse: boolean; worst?: number; priced: number } {
  if (history.length === 0) return { refuse: false, priced: 0 };
  const worst = Math.max(...history);
  return { refuse: worst > maxBudgetUsd, worst, priced: history.length };
}

/** Content-exact skill-version keys compare PREFIX-tolerantly in both directions: the index row stores
 *  a 12-char prefix (see `skillHash` on the row) while `result.json` and every doc recipe hand you the
 *  full 64-char sha, so a user pasting either must match. Both sides are prefixes of the same hex
 *  string, so this cannot produce a false pair at any sane length — the CLI enforces the length floor. */
function skillHashMatches(rowHash: string | undefined, query: string): boolean {
  if (!rowHash) return false;
  return rowHash.startsWith(query) || query.startsWith(rowHash);
}

/** The identity a group is keyed by. Kept as FIELDS, not a joined string: `buildStats` used to
 *  destructure its map key straight into `StatsSummary.scenario`, so a composite key would have emitted
 *  `scenario: "my-scenario\0abc123"` into the text line AND the JSON envelope — breaking scenario
 *  matching for every consumer. A `--label` value is unvalidated freeform and may contain anything, so
 *  splitting a joined key back apart is not reliably possible either. */
interface StatsGroup {
  scenario: string;
  skillHash?: string;
  runLabel?: string;
  fidelity?: string;
  /** RUN rows — every count, rate, and percentile is computed from exactly these. */
  rows: RunIndexRow[];
  /** Rows contributing to `totalUsd` ONLY: `rows` plus the roll-ups, plus any row re-admitted by session
   *  expansion. Kept separate from `rows` rather than merged, because a spend row must never reach
   *  `runs`/`passRate`/`durations`/percentiles — an unlabelled reflection turn re-entering a labelled
   *  group as a near-always-green "run" is precisely the passRate inflation that keeping `--label` off
   *  turn 2 exists to prevent (src/run/skill-flag-surface.ts:70-74). */
  spend: RunIndexRow[];
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/** Aggregation over already-loaded rows (filters applied first). NOT pure — `prunedRuns` below calls
 *  `existsSync(r.outDir)` per row, real filesystem I/O, so the same rows can produce a different
 *  `prunedRuns` count if the caller re-runs this after a `prune` in between. Every other field IS a pure
 *  function of `rows`/`filters`. `since` compares ISO-string timestamps lexically (both are ISO 8601, so
 *  this is safe and avoids a Date-parsing dependency). A row whose `outDir` no longer exists on disk
 *  (deleted by `prune`) still counts toward every stat — the index is the durable history — but is flagged `prunedRuns` so a consumer can tell "no evidence left to
 *  re-inspect" apart from "still on disk". */
/** Rows that are RUNS. A roll-up is BOOKKEEPING: no verdict of its own, no duration, and its scenario
 *  matches the turn rows' — so leaving it in adds a phantom run to the count and drags `passRate` toward
 *  1. There is no neutral `pass` value in a RATE, only exclusion.
 *
 *  Pairs with {@link carriesSpend}. These were ONE predicate (`isAggregatable`) answering two different
 *  questions, and the collapse was a bug: "is this a run?" is correctly no for a roll-up, but "does this
 *  carry spend?" is emphatically yes, and the single gate answered no to both. Every count, rate and
 *  PERCENTILE uses this one; only the total uses the other. */
function isRun(r: RunIndexRow): boolean {
  return r.critiqueRole !== "rollup";
}

/** Rows that carry SPEND — every row with cost telemetry, roll-ups included.
 *
 *  Safe to sum because a critique's rows partition its cost DISJOINTLY: the two graded turns carry their
 *  own, and the roll-up's `costUsd` is the two evaluator passes ONLY (see `appendCritiqueRollupRow`, which
 *  sets it that way precisely so this sum is exact and double-counts nothing). Verified live:
 *  0.1708 + 0.1967 + 0.6912 == 1.0588 == that critique's `critiqueTotalUsd`, to the cent. */
function carriesSpend(r: RunIndexRow): boolean {
  return typeof r.costUsd === "number";
}

export interface StatsFilters {
  scenario?: string;
  since?: string;
  baseline?: string;
  branch?: string;
  last?: number;
  skillHash?: string;
  label?: string;
  groupBy?: StatsGroupBy;
}

/** Filter → group → window, shared by the aggregate (`buildStats`) and the per-run listing
 *  (`listRuns`). Deliberately ONE implementation: two copies of this chain would let `stats --runs` show
 *  a row set the summary line above it did not actually aggregate — the precise "the tool disagrees with
 *  itself" failure this whole feature exists to remove. */
function resolveGroups(rows: RunIndexRow[], filters: StatsFilters): { groups: Map<string, StatsGroup>; hashlessRuns: number } {
  // SCOPE filters first, over ALL rows — roll-ups included. These express "I don't want these rows at
  // all" (a scenario, a date window, a baseline, a branch), so nothing may re-admit them later.
  let scoped = rows;
  if (filters.scenario) scoped = scoped.filter((r) => r.scenario === filters.scenario);
  if (filters.since) scoped = scoped.filter((r) => r.ts >= filters.since!);
  if (filters.baseline) scoped = scoped.filter((r) => r.baseline === filters.baseline);
  if (filters.branch) scoped = scoped.filter((r) => r.git.branch === filters.branch);

  // IDENTITY filters mean something different — "I want THIS generation" — and a generation includes its
  // own evaluator spend even though that spend sits on a row the filter cannot match.
  const hasIdentityFilter = filters.skillHash !== undefined || filters.label !== undefined;
  const matchesIdentity = (r: RunIndexRow) =>
    (filters.skillHash === undefined || skillHashMatches(r.skillHash, filters.skillHash)) &&
    (filters.label === undefined || r.runLabel === filters.label);
  const identityMatched = scoped.filter(matchesIdentity);

  // SESSION EXPANSION — cost only. `--label` is forwarded to a critique's task turn but deliberately NOT
  // its reflection turn, so a label-filtered set holds turn 1 + the roll-up and silently drops turn 2:
  // measured $0.862 of a $1.0588 critique, 19% light. A critique is ONE session and `runId` already IS
  // that session's identity, so re-admit siblings by runId — from `scoped`, never from `rows`, so a row
  // excluded by scenario/since/baseline/branch stays excluded. (`--skill-hash` needs none of this: the
  // roll-up and both turns all carry skillHash. Expansion is a no-op there, which T8 pins.)
  const matchedRunIds = new Set(identityMatched.map((r) => r.runId));
  const spendScoped = hasIdentityFilter ? scoped.filter((r) => matchedRunIds.has(r.runId)) : scoped;

  const groupBy = filters.groupBy ?? "scenario";
  const identityOf = (r: RunIndexRow) =>
    groupBy === "skill-hash" ? r.skillHash : groupBy === "label" ? r.runLabel : groupBy === "fidelity" ? tierOf(r) : undefined;
  // NUL joins the composite: `--label` is unvalidated freeform (it may contain spaces, `=`, anything a
  // shell will pass), so any printable separator could collide two distinct generations into one group.
  const keyOf = (r: RunIndexRow, identity: string | undefined) => (groupBy === "scenario" ? r.scenario : `${r.scenario}\0${identity}`);

  // Rows lacking the grouping field are DROPPED, not bucketed under a blank key — counted so the caller
  // can say so out loud rather than silently under-reporting. Counted over RUN rows only, which is what
  // it has always meant (roll-ups were excluded before this loop ever saw them).
  let hashlessRuns = 0;
  const groups = new Map<string, StatsGroup>();
  const keyByRunId = new Map<string, string>();
  for (const r of identityMatched.filter(isRun)) {
    const identity = identityOf(r);
    if (groupBy !== "scenario" && identity === undefined) {
      hashlessRuns++;
      continue;
    }
    const key = keyOf(r, identity);
    let g = groups.get(key);
    if (!g) {
      g = {
        scenario: r.scenario,
        ...(groupBy === "skill-hash" ? { skillHash: identity } : {}),
        ...(groupBy === "label" ? { runLabel: identity } : {}),
        ...(groupBy === "fidelity" ? { fidelity: identity } : {}),
        rows: [],
        spend: [],
      };
      groups.set(key, g);
    }
    g.rows.push(r);
    keyByRunId.set(r.runId, key);
  }
  // Second pass assigns SPEND. A roll-up carries skillHash and runLabel so it keys directly; a row
  // re-admitted by expansion may not (the unlabelled reflection turn under `--group-by label`), and
  // inherits its session sibling's group. A spend row with no home group is DROPPED, never used to mint
  // one — a group with zero run rows would divide by zero in `passRate` and report a phantom.
  for (const r of spendScoped) {
    const identity = identityOf(r);
    const key = groupBy === "scenario" || identity !== undefined ? keyOf(r, identity) : keyByRunId.get(r.runId);
    if (key === undefined) continue;
    groups.get(key)?.spend.push(r);
  }
  // `--last` windows to the N most recent rows PER GROUP, AFTER since/baseline/branch/scenario/identity
  // have already narrowed the candidate set — "the last N runs matching these filters", not "of the last
  // N runs overall, whichever happen to match" (the latter would silently starve a scenario/branch out of
  // the window entirely once a higher-frequency one dominates the unfiltered recent rows). At the default
  // `--group-by scenario` a group IS a scenario, so this is bit-identical to the pre-grouping behaviour.
  if (filters.last !== undefined) {
    const n = filters.last;
    for (const g of groups.values()) {
      g.rows = g.rows
        .slice()
        .sort((a, b) => (a.ts < b.ts ? 1 : -1))
        .slice(0, n);
      // Spend follows the window by SESSION, so the total describes exactly the runs shown above it. A
      // windowed-out critique must not leave its evaluator cost behind in the total (that would price
      // runs the summary no longer counts); a surviving one must keep it.
      const kept = new Set(g.rows.map((r) => r.runId));
      g.spend = g.spend.filter((r) => kept.has(r.runId));
    }
  }

  return { groups, hashlessRuns };
}

export function buildStats(rows: RunIndexRow[], filters: StatsFilters): StatsResult {
  const { groups, hashlessRuns } = resolveGroups(rows, filters);
  const summaries: StatsSummary[] = [];
  for (const { scenario, skillHash, runLabel, fidelity, rows: group, spend } of groups.values()) {
    // Roll-ups are IN here and nowhere else above — see `carriesSpend`. `undefined`, not 0, when nothing
    // in the group was priced: the house rule is that an unpriced row is skipped rather than counted as
    // zero, and a `$0.0000` total would read as "this was free" instead of "we could not tell".
    const priced = spend.filter(carriesSpend);
    const totalUsd = priced.length ? priced.reduce((sum, r) => sum + r.costUsd!, 0) : undefined;
    const numbers = (pick: (r: RunIndexRow) => number | undefined) =>
      group
        .map(pick)
        .filter((v): v is number => v !== undefined)
        .sort((a, b) => a - b);
    const costs = numbers((r) => r.costUsd);
    const durations = numbers((r) => r.durationMs);
    const tokens = numbers((r) => r.tokens);
    const turns = numbers((r) => r.turns);
    const cacheReadTokensArr = numbers((r) => r.cacheReadTokens);
    const modelCostArr = numbers((r) => r.modelCostUsd);
    const greens = group.filter((r) => r.pass).sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const tiers = [...new Set(group.map(tierOf))].sort();
    summaries.push({
      scenario,
      // undefined-valued keys are dropped by JSON.stringify, so these appear only when grouped on.
      ...(skillHash !== undefined ? { skillHash } : {}),
      ...(runLabel !== undefined ? { runLabel } : {}),
      runs: group.length,
      passRate: group.filter((r) => r.pass).length / group.length,
      // Counted over the POST-window rows — the same set every other number here is computed from, so
      // the warning can never disagree with the aggregate it annotates.
      distinctSkillHashes: new Set(group.map((r) => r.skillHash).filter((h): h is string => h !== undefined)).size,
      ...(fidelity !== undefined ? { fidelity } : {}),
      distinctTiers: tiers.length,
      tiers,
      p50CostUsd: costs.length ? percentile(costs, 0.5) : undefined,
      p95CostUsd: costs.length ? percentile(costs, 0.95) : undefined,
      p50DurationMs: durations.length ? percentile(durations, 0.5) : undefined,
      p95DurationMs: durations.length ? percentile(durations, 0.95) : undefined,
      p50Tokens: tokens.length ? percentile(tokens, 0.5) : undefined,
      p95Tokens: tokens.length ? percentile(tokens, 0.95) : undefined,
      p50Turns: turns.length ? percentile(turns, 0.5) : undefined,
      p95Turns: turns.length ? percentile(turns, 0.95) : undefined,
      p50CacheReadTokens: cacheReadTokensArr.length ? percentile(cacheReadTokensArr, 0.5) : undefined,
      p95CacheReadTokens: cacheReadTokensArr.length ? percentile(cacheReadTokensArr, 0.95) : undefined,
      p50ModelCostUsd: modelCostArr.length ? percentile(modelCostArr, 0.5) : undefined,
      p95ModelCostUsd: modelCostArr.length ? percentile(modelCostArr, 0.95) : undefined,
      totalUsd,
      unpricedRuns: spend.length - priced.length,
      lastGreenTs: greens[0]?.ts,
      prunedRuns: group.filter((r) => !existsSync(r.outDir)).length,
    });
  }
  return { summaries, hashlessRuns };
}

/** One entry per RUN, for `stats --runs`. The consumer request this answers: "surface `skillHash` in
 *  whatever lists runs, so the arm is visible without opening `result.json`" — until now no command
 *  listed individual runs at all (`list` lists baselines; `stats` only aggregates), so telling which
 *  generation a given run belonged to meant opening each `result.json` by hand. */
export interface RunListEntry {
  ts: string;
  scenario: string;
  runId: string;
  command: RunIndexRow["command"];
  pass: boolean;
  result: "success" | "error";
  skillHash?: string;
  runLabel?: string;
  /** The tier this run actually ran at (`effectiveFidelity ?? fidelity` — the same `tierOf` helper
   *  `buildStats`'s fidelity grouping keys on, so a summary's `fidelity` and a listed run's `fidelity`
   *  can never diverge). TOTAL by construction — every row has one — so unlike `skillHash`/`runLabel`
   *  this is never conditionally omitted. */
  fidelity: string;
  turn?: number;
  critiqueRole?: RunIndexRow["critiqueRole"];
  costUsd?: number;
  /** The row's `judgeCostUsd` / `deciderCostUsd`: harness-side model spend beside the agent's `costUsd`. */
  judgeCostUsd?: number;
  deciderCostUsd?: number;
  durationMs?: number;
  outDir: string;
  pruned: boolean; // outDir no longer on disk — the row is history, the evidence is gone
}

/** Newest first, over EXACTLY the rows `buildStats` aggregated for the same filters (same
 *  `resolveGroups`), so a listing can never disagree with the summary printed beside it. */
export function listRuns(rows: RunIndexRow[], filters: StatsFilters): { runs: RunListEntry[]; hashlessRuns: number } {
  const { groups, hashlessRuns } = resolveGroups(rows, filters);
  const runs = [...groups.values()]
    .flatMap((g) => g.rows)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .map((r) => ({
      ts: r.ts,
      scenario: r.scenario,
      runId: r.runId,
      command: r.command,
      pass: r.pass,
      result: r.result,
      // undefined-valued keys drop out of JSON.stringify, so absence stays absence rather than becoming
      // a null a consumer has to special-case.
      ...(r.skillHash !== undefined ? { skillHash: r.skillHash } : {}),
      ...(r.runLabel !== undefined ? { runLabel: r.runLabel } : {}),
      fidelity: tierOf(r),
      ...(r.turn !== undefined ? { turn: r.turn } : {}),
      ...(r.critiqueRole !== undefined ? { critiqueRole: r.critiqueRole } : {}),
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(r.judgeCostUsd !== undefined ? { judgeCostUsd: r.judgeCostUsd } : {}),
      ...(r.deciderCostUsd !== undefined ? { deciderCostUsd: r.deciderCostUsd } : {}),
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      outDir: r.outDir,
      pruned: !existsSync(r.outDir),
    }));
  return { runs, hashlessRuns };
}

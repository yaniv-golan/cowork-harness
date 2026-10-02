// `hillclimb regrade`: re-grade a flow's scored rows in place, from their kept run dirs, without re-running the agent.
//
// Two modes:
//   full (default)  every judged assert of every scored row is graded again (a judge or rubric change), with the flow's
//                   references as they are now; `pass` is recomputed from the re-graded result.
//   --fill-refs     only the pairwise comparisons a row lacks are judged (a reference frozen after the row was
//                   written); every other outcome and every semantic_matches grade is the live one, so `pass` cannot
//                   move. Every scored row is re-graded through the same producer, so each carries every win column.
//
// In both modes every selected row's metrics are re-measured from its kept run: by the core re-grade for a row a judge
// re-grades, and by `reevaluateFromRun` — no judge call — for every other row (a case with no judged assert, an agent
// failure, a fill row that needs no comparison), so a metric added mid-flow is filled on every row.
//
// A row is rewritten by the SAME producer `run` writes it with (`gradeFor` over the result with the re-graded entries
// substituted), never patched key by key. `result.json` is never touched (`regrade`'s own invariant). Everything that
// can refuse is decided before the first judge call, over every selected variant: the host-`claude` isolation check,
// the gate, the locks, and each batch's evidence preflight.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.js";
import { tildeify } from "../io.js";
import { classifyRep } from "../eval/classify.js";
import { pkgVersion } from "../run/envelope.js";
import { runOutDir } from "../run/execute.js";
import { regradeRuns, type RegradeOptions, type RegradeOutcome, type RegradeRunReport } from "../run/regrade.js";
import { reevaluateRun } from "../run/verify-context.js";
import { runsWriteRoot } from "../run/trace-view.js";
import { latestTurn, turnArtifactPath } from "../run/turn-layout.js";
import { computeVerdict } from "../run/verdict.js";
import type { RunResult } from "../types.js";
import type { AssertContext } from "../assert.js";
import { loadCases, selectCases, type HillclimbCase } from "./cases.js";
import { prepareCases } from "./command.js";
import { FlowWriter, redactDeep } from "./flow.js";
import { lexists, normalizeRootArg, NoFollowRoot } from "./fs.js";
import { approvedHarnessSkill, flowHarnessDigest, gateDecision } from "./gate.js";
import { assertIdentity, assertSig, canonicalJson, flowHasPairwise, type MetricDecl } from "./grade-keys.js";
import { BASELINE_REF, discoverFlowRefs, flowPairwiseOptions, metricRefNames } from "./pairwise.js";
import { readRefDoc } from "../refs/store.js";
import { pairwiseComposeKey, type PairwiseRef } from "../run/pairwise-prepass.js";
import { JUDGE_PROMPT_HASH } from "../decide/semantic-judge.js";
import { PAIRWISE_PROMPT_HASH } from "../decide/pairwise-judge.js";
import { judgedOpts } from "../assert.js";
import { gradeFor, judgeFieldsOf, orderedGrade } from "./rows.js";
import { flowMetricUnion, metricSigs, refuseChangedMetrics } from "./metric-keys.js";
import { existingFlowSnapshot, readStateIfPresent, readVariantFileIfPresent } from "./runner.js";
import { VARIANT_DIR_RE } from "./schema-check.js";

export interface HillclimbRegradeArgs {
  target: string;
  flow: string;
  /** A variant id, or `all` (the default): every variant with rows. */
  variant: string;
  cases: string[];
  judgeModel?: string;
  fillRefs: boolean;
  approveHarness: boolean;
  allowDocDrift: boolean;
  /** Forwarded to `regrade` only when the user passed it. */
  allowUnchecked: boolean;
  /** Re-judge every judged assert, changed or not (default: only one whose judge inputs changed — `judgedPlan`). */
  rejudge?: boolean;
}

export interface RegradeFlowDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  secrets: readonly string[];
  stderr: (line: string) => void;
  /** The host-`claude` isolation preflight (`isolationRefusal`, src/decide/llm-transport.ts): the refusal message, or
   *  undefined when the judge can run isolated. `hillclimb run` takes the same check. */
  isolationCheck: () => string | undefined;
  harnessVersion?: string;
  /** Test seams, forwarded to `regradeRuns`. */
  regradeOptions?: Pick<RegradeOptions, "makeJudge" | "pairwiseComplete" | "now">;
  /** Test seam: the core re-grade (default `regradeRuns`). */
  regrade?: typeof regradeRuns;
  /** Test seam: the metrics merge (default `mergeMetrics`). */
  mergeMetrics?: typeof mergeMetrics;
  /** The flow's declared metrics, as `run` grades rows with them (default `flowMetricUnion`, `run`'s own producer: a
   *  rebuilt row keeps only declared keys, so a caller that passed none would drop every metric column). */
  metricDecls?: (cases: readonly HillclimbCase[]) => MetricDecl[];
}

export interface RegradeFlowVariant {
  variant: string;
  rewritten: number;
  /** Rows not re-graded, with why. Nothing was written for them. */
  listed: Array<{ prompt_id: string; rep: number; why: string }>;
  /** Rows whose deterministic asserts (every assert no judge grades, and each `expect_denied` host) were re-evaluated
   *  from their kept run with no judge call (a case with no judged assert, an agent-failed row, a fill row that needed
   *  no comparison). A row whose re-evaluation changed nothing is counted here but not rewritten. A re-judged row's
   *  deterministic asserts are re-evaluated too; it is counted in `rewritten`. */
  reevaluated: number;
  /** Rows whose metrics were re-measured from their kept run with no judge call (a case with no judged assert, an
   *  agent-failed row, a fill row that needed no comparison). A row whose re-measure changed nothing is counted here
   *  but not rewritten. */
  remeasured: number;
  /** Agent-failed rows (`meta.failure_class: errored_agent`) whose kept run cannot be re-evaluated (a partial run, an
   *  unanswered gate): such a row scores 0 whatever its asserts say, so only its meta is brought current
   *  (`assert_sig`, `metric_sigs`), its grade all 0 as `run` writes it — never listed. */
  agentFailed: number;
  regradeFiles: string[];
  backup?: string;
}

export interface RegradeFlowOutcome {
  exitCode: 0 | 1 | 2;
  variants: RegradeFlowVariant[];
  error?: { category: "usage" | "runtime"; message: string };
}

/** The metrics seam: a re-measure's row metadata merges here into every row rebuilt from a re-measure — a re-grade
 *  report's, or the one `reevaluateFromRun` makes for a row no judge re-grades — after its grade is rebuilt and before
 *  its keys are ordered. The values and `_present` keys are already in `row.grade` — `gradeFor` read them from the result
 *  the re-measured metrics were merged into — so this sets only what the row's meta says about them, the way `run` writes it:
 *  `meta.metric_sigs` is exactly the declarations' signatures (a row that predated a metric gains its sig; a removed
 *  metric's sig goes with its column, which the rebuilt grade no longer carries; omitted when none is declared), and
 *  `meta.metrics_unavailable` by id — a reason the re-measure gives is added or replaced, an id the grade now reads
 *  measured loses its reason, any other id's entry stays, and the key is omitted when empty. An agent-failed row scores
 *  no metric, so it gains no reason. Mutates in place. */
export function mergeMetrics(
  row: { grade: Record<string, number>; meta: Record<string, unknown> },
  report: Remeasure,
  decls: readonly MetricDecl[],
): void {
  if (decls.length) row.meta.metric_sigs = metricSigs(decls);
  else delete row.meta.metric_sigs;
  // Only the declarations' reasons survive: `run` never writes one for an id outside them, so a removed metric's
  // reason goes with its column and sig.
  const unavailable = declaredUnavailable(row.meta, decls);
  if (row.meta.failure_class === "errored_agent") {
    if (Object.keys(unavailable).length) row.meta.metrics_unavailable = unavailable;
    else delete row.meta.metrics_unavailable;
    return;
  }
  for (const m of decls) {
    if (row.grade[`${m.id}_present`] === 1) delete unavailable[m.id];
    else {
      const why = report.metrics?.find((x) => x.id === m.id)?.unavailable;
      if (why !== undefined) unavailable[m.id] = why;
    }
  }
  if (Object.keys(unavailable).length) row.meta.metrics_unavailable = unavailable;
  else delete row.meta.metrics_unavailable;
}

/** What a re-measure of one kept run produced: the case's declared metrics, read from the kept work dir (absent when
 *  the case declares none). A re-grade report is one. */
export type Remeasure = Pick<RegradeRunReport, "metrics">;

/** One row re-evaluated from its kept run: the context the kept-run builder rebuilt, and the products read from it. */
export interface Reevaluation {
  /** What `verify-run` evaluates a scenario against, rebuilt from the kept run dir. */
  ctx: AssertContext;
  /** The case's authored entries re-evaluated from the kept run: one per scenario assert (a judged one reads
   *  unevaluated — no judge is called), then one per `expect_denied` host. */
  deterministic: RunResult["assertions"];
  /** The case's declared metrics, re-measured from the kept work dir (absent when the case declares none). */
  metrics?: NonNullable<RunResult["metrics"]>;
}

/** Re-evaluate one selected row from its kept run dir: the one per-row step every selected row goes through, in every
 *  mode, before any judge call. It is `verify-run`'s own evaluation (`reevaluateRun`: the kept-run context, the
 *  recorded-fixture refusal, `evaluate` + `expandExpectDenied`, and the metrics re-measured on the same context — a
 *  file read only while its bytes still equal the run's recorded post-run hash), without `verify-run`'s
 *  answer-coverage and skill-drift checks (every variant ran another snapshot of the skill). `listed` (never a zeroed
 *  value) when the run cannot be re-evaluated — a run dir the builder refuses (multi-turn, partial, replay, chat, no
 *  result, a work dir a filesystem assert needs gone), an assert the recorded fixture would satisfy on its own — or
 *  when the case declares a metric and the kept work dir it would be read from is gone. */
export function reevaluateFromRun(runDir: string, c: HillclimbCase): Reevaluation | { listed: string } {
  const built = reevaluateRun(runDir, c.scenario, { command: "hillclimb regrade" });
  if (!built.ok) {
    if (built.kind === "scenario") throw new Error("unreachable: the scenario was passed as an object");
    return { listed: `refused: ${built.message.split("\n")[0]}` };
  }
  if (c.scenario.metrics?.length && !existsSync(built.ctx.workRoot))
    return { listed: `its kept work dir is gone (${built.ctx.workRoot || "<unset>"}) — its metrics cannot be re-measured` };
  return { ctx: built.ctx, deterministic: built.deterministic, ...(built.metrics !== undefined ? { metrics: built.metrics } : {}) };
}

/** The row's `meta.metrics_unavailable` reasons for the declared ids only. */
function declaredUnavailable(meta: Record<string, unknown>, decls: readonly MetricDecl[]): Record<string, unknown> {
  const prev = meta.metrics_unavailable;
  if (!prev || typeof prev !== "object" || Array.isArray(prev)) return {};
  const ids = new Set(decls.map((m) => m.id));
  return Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id)));
}

type Row = Record<string, unknown> & { prompt_id?: unknown; rep?: unknown; grade?: Record<string, number>; meta?: Record<string, unknown> };

interface Line {
  raw: string;
  row?: Row;
}

interface Target {
  variant: string;
  c: HillclimbCase;
  line: Line;
  runDir: string;
  result: RunResult;
  /** The references this row's comparisons lack (fill mode); empty when it needs no judge call. */
  missing: string[];
  /** The row re-evaluated from its kept run, before any judge call. */
  re: Reevaluation;
  /** Per authored index (scenario asserts, then `expect_denied` hosts): the run's entry for the same assertion, matched
   *  by identity (`liveByIdentity`), or undefined for an assertion the run did not grade. */
  live: Array<Entry | undefined>;
  /** The deterministic indexes whose live entry was kept although the kept run re-evaluates them differently. */
  keptLive: number[];
  /** The row's judged entries now, and which of them are re-judged and why. */
  plan: JudgedPlan;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A run dir as a flow may record it: relative to the runs root, else redacted. */
function shownRunPath(p: string, secrets: readonly string[]): string {
  const rel = relative(resolve(runsWriteRoot()), resolve(p));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return `<runs>/${rel.split(sep).join("/")}`;
  return redactDeep(tildeify(p), secrets);
}

/** The judge model that made a fill's comparisons (the row's own judge fields stay the live ones). */
const fillModel = (report: RegradeRunReport): string | undefined =>
  report.assertions.find((a) => a.assertion.semantic_pairwise !== undefined && a.judgeModel !== undefined)?.judgeModel;

/** A core message as the flow, the JSON envelope and stderr show it: no secret, no host path. */
const shownMessage = (m: string, secrets: readonly string[]): string => redactDeep(m, secrets);

function readResult(runDir: string): RunResult | undefined {
  try {
    const turn = latestTurn(runDir);
    if (turn === undefined) return undefined;
    return JSON.parse(NoFollowRoot.existing(runDir).readFile(turnArtifactPath(runDir, turn, "result.json"))) as RunResult;
  } catch {
    return undefined;
  }
}

/** The kept run dir of a row: its run id under the CURRENT runs root, named by the joined case's scenario (a row's
 *  recorded `meta.run_dir` is redacted outside the home dir, so it is not relied on). */
function runDirOf(row: Row, c: HillclimbCase): string | undefined {
  const id = row.meta?.run_id;
  if (typeof id !== "string" || id === "" || id.includes("/")) return undefined;
  const dir = runOutDir(c.scenario.name ?? c.id, id);
  return lexists(join(dir, "turns")) ? dir : undefined;
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

type Entry = RunResult["assertions"][number];

/** A run's authored entries (no `source`): one per scenario assert, then one per `expect_denied` host. */
const authoredOf = (r: RunResult): Entry[] => (r.assertions ?? []).filter((e) => e.source === undefined);

/** The scenario's authored list as a live run grades it: its asserts, then one `egress_denied` per `expect_denied` host. */
const authoredNow = (c: HillclimbCase): object[] => [
  ...c.scenario.assert,
  ...(c.scenario.expect_denied ?? []).map((host) => ({ egress_denied: host })),
];

/** The authored indexes no judge grades: every assert without a judged key, then every `expect_denied` host. */
const deterministicIndexes = (c: HillclimbCase): number[] =>
  authoredNow(c).flatMap((a, i) => (i >= c.scenario.assert.length || judgedOpts(a as never) === undefined ? [i] : []));

const keysOf = (a: object): string => Object.keys(a).sort().join(",");

/** The run's entry for each authored index, matched by IDENTITY (`assertIdentity`: the assertion as written, refs left
 *  out), never by position: adding or removing an assert leaves every other one matched. With multiplicity — each run
 *  entry answers one index; the same index first, then the first unused one — so a second copy of an assert is new. */
function liveByIdentity(live: RunResult, c: HillclimbCase): Array<Entry | undefined> {
  const was = authoredOf(live);
  const ids = was.map((e) => assertIdentity(e.assertion));
  const used = new Set<number>();
  const now = authoredNow(c).map(assertIdentity);
  const out: Array<Entry | undefined> = now.map((id, i) => {
    if (ids[i] !== id) return undefined;
    used.add(i);
    return was[i];
  });
  for (const [i, id] of now.entries()) {
    if (out[i] !== undefined) continue;
    const k = ids.findIndex((x, j) => x === id && !used.has(j));
    if (k >= 0) {
      used.add(k);
      out[i] = was[k];
    }
  }
  return out;
}

/** A regrade file's name as `regradeFileStem` writes it: never a path. */
const REGRADE_FILE_RE = /^[A-Za-z0-9._-]+\.json$/;

/** The judged entries a row is graded with now: those of the re-grade that last rewrote it (`meta.regrade_file` — a
 *  re-grade never touches result.json, so after one the run's own judged entries are no longer the row's), else the
 *  run's own. `undefined` when the row names a regrade file that cannot be read: what it was graded with is unknown. */
function gradedSource(row: Row, runDir: string, result: RunResult): { entries: Entry[]; file: boolean } | undefined {
  const named = row.meta?.regrade_file;
  if (typeof named !== "string" || named === "")
    return { entries: authoredOf(result).filter((e) => judgedOpts(e.assertion) !== undefined), file: false };
  try {
    const turn = latestTurn(runDir);
    const name = basename(named);
    if (turn === undefined || !REGRADE_FILE_RE.test(name)) return undefined;
    const file = join(dirname(turnArtifactPath(runDir, turn, "result.json")), "regrade", name);
    const doc = JSON.parse(NoFollowRoot.existing(runDir).readFile(file)) as { assertions?: RegradeRunReport["assertions"] };
    if (!Array.isArray(doc.assertions)) return undefined;
    return { entries: doc.assertions.map(reportEntry), file: true };
  } catch {
    return undefined;
  }
}

/** Why a judged assert is re-judged. Everything that changes what its judge reads or how it grades:
 *  - `assert_changed`: no entry the row is graded with is this assertion (`assertIdentity`: its rubric, claims, judge
 *    model, `pass_if`, evidence scope — `include_subagent_text`, `evidence_files`, `include_fork_results` — and so the
 *    pairwise compose key are all part of it); an added assert is one;
 *  - `graded_entry_unavailable`: the regrade file the row names cannot be read;
 *  - `rejudge`: `--rejudge`;
 *  - `judge_model`: `--judge-model` is not the model that graded it (exact string);
 *  - `judge_prompt`: it was graded under another judge prompt template (`judgePromptHash`);
 *  - `opponents_changed`: a pairwise assert's references (its own variant's aside: neutral, never judged) or their
 *    gating are not the flow's now;
 *  - `reference_changed`: a reference document it was judged against is not the one the flow's store holds now. */
export type RejudgeTrigger =
  "assert_changed" | "graded_entry_unavailable" | "rejudge" | "judge_model" | "judge_prompt" | "opponents_changed" | "reference_changed";

export interface JudgedPlan {
  /** Per judged scenario index: the entry the row is graded with now, matched by identity. */
  entries: Map<number, Entry>;
  /** The judged indexes to re-judge, each with the triggers that fired, in order. */
  rejudge: Map<number, RejudgeTrigger[]>;
  /** The entries came from the row's regrade file (its judge-side meta then describes them). */
  fromFile: boolean;
}

/** Which of a row's judged asserts a regrade re-judges, decided from the row, its kept run and the flow's reference
 *  stores — no judge call, nothing written (it also runs before the locks, to decide whether a judge will run at all).
 *  A judged assert whose inputs are all unchanged keeps the entry the row is graded with: re-judging it would only
 *  re-roll the judge's noise. A fill re-judges nothing (its references and gating are what it fills), so only identity
 *  is decided there. */
export function judgedPlan(
  row: Row,
  c: HillclimbCase,
  runDir: string,
  result: RunResult,
  o: { rejudge: boolean; judgeModel?: string; fill: boolean; variant: string; refs: readonly PairwiseRef[] },
): JudgedPlan {
  const src = gradedSource(row, runDir, result);
  const entries = new Map<number, Entry>();
  const rejudge = new Map<number, RejudgeTrigger[]>();
  const pool = src?.entries ?? [];
  const ids = pool.map((e) => assertIdentity(e.assertion));
  const used = new Set<number>();
  const refNames = o.refs.map((r) => r.name).filter((n) => n !== o.variant);
  for (const [i, a] of c.scenario.assert.entries()) {
    if (judgedOpts(a) === undefined) continue;
    const why: RejudgeTrigger[] = [];
    const id = assertIdentity(a);
    const k = src ? ids.findIndex((x, j) => x === id && !used.has(j)) : -1;
    if (!src) why.push("graded_entry_unavailable");
    else if (k < 0) why.push("assert_changed");
    else {
      used.add(k);
      const e = pool[k]!;
      entries.set(i, e);
      if (o.rejudge) why.push("rejudge");
      // A judge read it only when it recorded a model: an entry no judge read (every comparison neutral, or its
      // evidence refused) has no model or prompt to differ.
      if (e.judgeModel !== undefined) {
        if (o.judgeModel !== undefined && e.judgeModel !== o.judgeModel) why.push("judge_model");
        const prompt = a.semantic_pairwise !== undefined ? PAIRWISE_PROMPT_HASH : JUDGE_PROMPT_HASH;
        if (e.judgePromptHash !== prompt) why.push("judge_prompt");
      }
      if (!o.fill && a.semantic_pairwise !== undefined && e.pairwise !== undefined) {
        const had = e.pairwise.map((x) => x.ref).filter((n) => n !== o.variant);
        const gating = e.pairwise.some((x) => (x.gate === false) !== (x.ref !== BASELINE_REF));
        if (gating || had.length !== refNames.length || !refNames.every((n) => had.includes(n))) why.push("opponents_changed");
        const key = pairwiseComposeKey(a);
        for (const x of e.pairwise) {
          if (x.refDocSha256 === undefined) continue;
          const store = o.refs.find((r) => r.name === x.ref)?.store;
          const now = store ? readRefDoc(store, c.id, key) : undefined;
          if (now?.status !== "ok" || now.sha256 !== x.refDocSha256) {
            why.push("reference_changed");
            break;
          }
        }
      }
    }
    if (why.length) rejudge.set(i, why);
  }
  return { entries, rejudge, fromFile: src?.file ?? false };
}

/** The deterministic step, decided for every selected row before any judge call, over its re-evaluation:
 *  - an assert UNCHANGED since the run (matched by identity) keeps the run's own entry: its grader is the one the run
 *    used, so a re-evaluation that differs is a difference in our reconstruction from the kept run (a changed sidecar,
 *    an evaluator fixed since, evidence a kept run does not record) — `keptLive` names those, never listed, never
 *    written as a moved outcome;
 *  - an assert CHANGED or added since the run is always the re-evaluation's; in a fill, one whose outcome differs from
 *    the run's at that index is LISTED: a fill never moves `pass`, so a grader fix waits for a default regrade. */
function deterministicCheck(
  live: RunResult,
  c: HillclimbCase,
  re: Reevaluation,
  matched: ReadonlyArray<Entry | undefined>,
  fill: boolean,
): { listed: string } | { keptLive: number[] } {
  const was = authoredOf(live);
  const keptLive: number[] = [];
  for (const i of deterministicIndexes(c)) {
    const fresh = re.deterministic[i]!;
    const prev = matched[i];
    if (prev !== undefined) {
      if (prev.pass !== fresh.pass) keptLive.push(i);
      continue;
    }
    if (fill && was[i] !== undefined && was[i]!.pass !== fresh.pass)
      return {
        listed: `the grader changed since the run (${labelOf(c, i)} ${outcomeOf(fresh.pass)} now, ${outcomeOf(was[i]!.pass)} in the run): run a default \`hillclimb regrade\` first, then --fill-refs (a fill never moves pass; until then this row lacks the new win column)`,
      };
  }
  return { keptLive };
}

const outcomeOf = (p: boolean) => (p ? "passes" : "fails");

/** An authored index as messages name it. */
function labelOf(c: HillclimbCase, i: number): string {
  const now = authoredNow(c);
  return i < c.scenario.assert.length
    ? `assertion ${i} (\`${keysOf(now[i]!)}\`)`
    : `expect_denied ${String((now[i] as { egress_denied: string }).egress_denied)}`;
}

/** The result rebuilt from the CURRENT scenario: a judged assert's entry from `judged(i)`, every other assert's and
 *  each `expect_denied` host's re-evaluated from the kept run, then the run's own non-authored entries. `why` when a
 *  judged assert has no entry to take (no re-grade, and the run graded another assert at that index). The verdict is
 *  left as the run's; the caller recomputes it when an outcome may have moved. */
function reevaluatedResult(
  live: RunResult,
  c: HillclimbCase,
  re: Reevaluation,
  matched: ReadonlyArray<Entry | undefined>,
  judged: (i: number) => Entry | undefined,
): { result: RunResult } | { why: string } {
  const authored: Entry[] = [];
  for (const [i, a] of c.scenario.assert.entries()) {
    if (judgedOpts(a) === undefined) {
      // An assert unchanged since the run keeps the run's own entry; a changed or added one is re-evaluated.
      authored.push(matched[i] ?? re.deterministic[i]!);
      continue;
    }
    const e = judged(i);
    if (e === undefined)
      return {
        why: `assertion ${i} (\`${keysOf(a)}\`) was not re-graded and is not the assert its run graded — run a default \`hillclimb regrade\``,
      };
    authored.push(e);
  }
  for (let i = c.scenario.assert.length; i < re.deterministic.length; i++) authored.push(matched[i] ?? re.deterministic[i]!);
  return { result: { ...live, assertions: [...authored, ...(live.assertions ?? []).filter((e) => e.source !== undefined)] } };
}

/** Whether a rebuilt result's authored entries are exactly the run's (then the run's own verdict stands). */
const sameAuthored = (a: RunResult, b: RunResult): boolean => canonicalJson(authoredOf(a)) === canonicalJson(authoredOf(b));

/** A re-grade report's entry as a result entry. */
function reportEntry(g: RegradeRunReport["assertions"][number]): Entry {
  const { assertionIndex: _i, docMatchesLive: _d, ...entry } = g as typeof g & { docMatchesLive?: unknown };
  void _i;
  void _d;
  return entry as unknown as Entry;
}

/** A judged assert's entry on an agent-failed row the scenario changed since the run: no judge reads it, and the row
 *  scores 0 whatever it says. */
const notJudged = (a: object): Entry => ({ assertion: a as never, pass: false, message: "not judged: the agent failed" });

/** The keys a re-grade wrote about the judged entries it produced, kept on a row rebuilt with those entries. */
const JUDGE_SIDE_META = [
  "regrade_file",
  "regrade_doc_matches_live",
  "regrade_unchecked",
  "regrade_fill",
  "regrade_judge_usd",
  "regrade_judge_model",
] as const;
const carriedJudgeMeta = (row: Row): Record<string, unknown> =>
  Object.fromEntries(JUDGE_SIDE_META.flatMap((k) => (row.meta && k in row.meta ? [[k, row.meta[k]]] : [])));

/** A case that declares a metric of its own (a row of another case carries the flow's columns unmeasured). */
const declaresMetrics = (c: HillclimbCase): boolean => (c.scenario.metrics?.length ?? 0) > 0;

const withVerdict = (r: RunResult): RunResult => ({ ...r, verdict: computeVerdict(r, "live") as RunResult["verdict"] });

/** The result with its metrics as a re-measure measured them, id by id: a re-measure with no finite value (a pruned or
 *  changed file) never replaces a value the run measured. One rule for a re-graded row and a re-measured-only one. */
function withRemeasured(live: RunResult, re: Remeasure): RunResult {
  if (re.metrics === undefined) return live;
  const byId = new Map((live.metrics ?? []).map((m) => [m.id, m]));
  for (const m of re.metrics) {
    const prev = byId.get(m.id);
    const fresh = typeof (m as { value?: unknown }).value === "number" && Number.isFinite((m as { value: number }).value);
    if (fresh || prev === undefined || typeof (prev as { value?: unknown }).value !== "number") byId.set(m.id, m);
  }
  return { ...live, metrics: [...byId.values()] as RunResult["metrics"] };
}

/** Rebuild one scored row from a result: grade, explanation, claim texts, reference shas and judge fields through the
 *  producer `run` uses; every other field kept as it was, in its place, and keys `gradeFor` no longer emits removed. */
function rebuiltRow(
  row: Row,
  result: RunResult,
  c: HillclimbCase,
  /** `pairwise` only when the flow has semantic_pairwise — exactly what `run` passes — so a rebuilt row carries the
   *  keys `run` would write, no more. */
  shape: { pairwise?: { metricRefs: readonly string[] }; metrics: readonly MetricDecl[]; merge: typeof mergeMetrics },
  extraMeta: Record<string, unknown>,
  judgeFieldsFrom: RunResult | undefined,
  /** The row's re-measure (a re-grade report, or `reevaluateFromRun`'s); undefined when its metrics were not re-measured
   *  (a flow that declares none). */
  report: Remeasure | undefined,
): { row: Row } | { why: string } {
  const rep = classifyRep({ result: result as never }, {});
  if (rep.bucket === "judge_invalid")
    return { why: `the re-grade is invalid (judge) on assertion(s) ${rep.judgeInvalidAssertions.join(", ")}` };
  const agentFailed = rep.bucket === "errored_agent";
  // The same declarations `run` grades a row with: its metric union and the flow's later references.
  const ctx = { assertions: c.scenario.assert, metrics: shape.metrics, ...(shape.pairwise ? { pairwise: shape.pairwise } : {}) };
  const g = gradeFor(result, ctx, rep, agentFailed);
  if ("misaligned" in g) return { why: `assertion ${g.misaligned} no longer lines up with the scenario (${g.excluded})` };
  // Rebuilt IN PLACE: a key assigned keeps its position; the producer's keys (and every earlier re-grade's own) that
  // this rebuild does not set are removed at the end, so no stale value from a previous grade or re-grade survives.
  const meta: Record<string, unknown> = { ...(row.meta ?? {}) };
  const set = new Set<string>();
  const put = (k: string, v: unknown) => {
    meta[k] = v;
    set.add(k);
  };
  const clear = [
    "claims",
    "pairwise_ref_sha256",
    "explanation_untrusted",
    "judge_models",
    "judge_transport",
    "judge_transports",
    "judge_retries_unrecorded",
    "regrade_fill",
    "regrade_judge_usd",
    "regrade_judge_model",
    "regrade_doc_matches_live",
    "regrade_unchecked",
    "regrade_file",
    "regrade_remeasured",
    "regrade_reevaluated",
    "regrade_harness_version",
    "regrade_kept_live",
    "regrade_rejudged_because",
    "regraded_at",
  ];
  const grade = { ...g.grade };
  if (report) shape.merge({ grade, meta }, report, shape.metrics);
  else {
    // Not re-measured (only a flow that declares no metric), so the row stays as `run` left it. A removed metric's sig
    // and unavailable reason go with its column (the ordered grade no longer carries it). A metric the row predates (no sig) gains neither a sig nor the
    // `<id>` / `<id>_present` keys `gradeFor` emits for every declared metric — a `_present: 0` would read as
    // "measured: no", and `check` would no longer count the row as predating the metric.
    const sigs = meta.metric_sigs;
    const ids = new Set(shape.metrics.map((m) => m.id));
    const kept =
      sigs && typeof sigs === "object" && !Array.isArray(sigs)
        ? Object.fromEntries(Object.entries(sigs).filter(([id]) => ids.has(id)))
        : {};
    if (Object.keys(kept).length) meta.metric_sigs = kept;
    else delete meta.metric_sigs;
    for (const m of shape.metrics)
      if (!(m.id in kept)) {
        delete grade[m.id];
        delete grade[`${m.id}_present`];
      }
    const unavailable = declaredUnavailable(meta, shape.metrics);
    if (Object.keys(unavailable).length) meta.metrics_unavailable = unavailable;
    else delete meta.metrics_unavailable;
  }
  // Replacements, by key; `undefined` removes a key the producer no longer emits.
  const repl: Record<string, unknown> = {
    grade: orderedGrade(grade, ctx),
    explanation: undefined,
    judge_model: undefined,
    judge_usage: undefined,
  };
  if (Object.keys(g.explanation).length) {
    const e: Record<string, string> = {};
    if ("claims" in g.explanation) e.claims = g.explanation.claims;
    for (const [k, v] of Object.entries(g.explanation)) if (k !== "claims") e[k] = v;
    repl.explanation = e;
    put("explanation_untrusted", true);
  }
  if (Object.keys(g.claims).length) put("claims", g.claims);
  if (Object.keys(g.refShas).length) put("pairwise_ref_sha256", g.refShas);
  // Who judged: the re-graded result in a full re-grade; in a fill, the row's own judge fields stand (its grades are
  // the live ones) and the fill's spend is said beside them.
  if (judgeFieldsFrom) {
    const { judges, transports, jr } = judgeFieldsOf(judgeFieldsFrom);
    repl.judge_model = judges.judge_model;
    repl.judge_usage = judges.judge_usage;
    if (judges.judge_models !== undefined) put("judge_models", judges.judge_models);
    if (transports.length === 1) put("judge_transport", transports[0]);
    else if (transports.length > 1) put("judge_transports", transports);
    put("judge_retries", jr.judge_retries);
    if (jr.unrecorded) put("judge_retries_unrecorded", true);
  } else {
    // A fill's grades are the live ones: so are its judge fields (kept as they are).
    for (const k of ["judge_models", "judge_transport", "judge_transports", "judge_retries_unrecorded"]) if (k in meta) set.add(k);
    repl.judge_model = row.judge_model;
    repl.judge_usage = row.judge_usage;
  }
  // Rebuilt from the scenario as it is now: the assertion set the row is graded under now.
  put("assert_sig", assertSig(c.scenario));
  for (const [k, v] of Object.entries(extraMeta)) put(k, v);
  for (const k of clear) if (!set.has(k)) delete meta[k];
  repl.meta = meta;
  // Every field in its original place; a key the row did not have goes where `run` would put it (before meta).
  const out: Row = {};
  for (const k of Object.keys(row)) {
    if (!(k in repl)) out[k] = row[k];
    else if (repl[k] !== undefined) out[k] = repl[k];
  }
  for (const k of ["judge_model", "judge_usage", "grade", "explanation", "meta"])
    if (!(k in out) && repl[k] !== undefined) out[k] = repl[k];
  return { row: out };
}

/** The result with a neutral outcome added against the row's OWN variant's reference wherever it has none (that
 *  reference was frozen after the row; a run is never judged against its own variant's — neutral, 0.5, no judge
 *  call), in reference order. */
function withOwnNeutral(result: RunResult, c: HillclimbCase, variant: string, refNames: readonly string[]): RunResult {
  if (!refNames.includes(variant)) return result;
  let k = 0;
  const assertions = (result.assertions ?? []).map((e) => {
    if (e.source !== undefined) return e;
    const i = k++;
    if (c.scenario.assert[i]?.semantic_pairwise === undefined || !e.pairwise || e.pairwise.some((o) => o.ref === variant)) return e;
    const neutral = { ref: variant, ...(variant === "baseline" ? {} : { gate: false as const }), status: "neutral" as const, value: 0.5 };
    const order = (ref: string) => refNames.indexOf(ref);
    return { ...e, pairwise: [...e.pairwise, neutral].sort((a, b) => order(a.ref) - order(b.ref)) };
  });
  return { ...result, assertions };
}

/** The references whose COPIED outcome (kept from the live run by a fill) recorded a document other than the one the
 *  flow's store holds now. */
function staleCopied(
  entries: ReadonlyArray<{ assertionIndex: number; pairwise?: NonNullable<RunResult["assertions"][number]["pairwise"]> }>,
  c: HillclimbCase,
  refs: ReadonlyArray<{ name: string; store: string }>,
  copiedOnly = true,
): string[] {
  const out = new Set<string>();
  for (const a of entries) {
    const asrt = c.scenario.assert[a.assertionIndex];
    if (!asrt?.semantic_pairwise) continue;
    for (const o of a.pairwise ?? []) {
      if ((copiedOnly && !o.copied) || o.refDocSha256 === undefined) continue;
      const store = refs.find((r) => r.name === o.ref)?.store;
      const now = store ? readRefDoc(store, c.id, pairwiseComposeKey(asrt)) : undefined;
      if (now?.status === "ok" && now.sha256 !== o.refDocSha256) out.add(o.ref);
    }
  }
  return [...out];
}

/** The references a row's pairwise asserts have no live outcome against (its own variant's included: neutral, no
 *  judge call, but the column must be there). An outcome that exists but could not be compared live (`missing`,
 *  `integrity`) counts as present: re-judging it could move a gating comparison, which a fill never does — a full
 *  re-grade is the tool for that. */
/** Why a row's live result no longer lines up with the scenario's assertion list — a different count, a different
 *  key at an index, or a pairwise assert with another evidence scope — decided before any judge call (a re-grade
 *  substitutes entries by index, so a shifted list would grade one assert into another's place). */
function shapeMismatch(result: RunResult, c: HillclimbCase): string | undefined {
  const live = authoredOf(result);
  const now = c.scenario.assert;
  const hosts = c.scenario.expect_denied?.length ?? 0;
  // The run graded each `expect_denied` host as a trailing `egress_denied` entry.
  if (live.length !== now.length + hosts)
    return `the scenario now has ${now.length} assertion(s)${hosts ? ` and ${hosts} expect_denied host(s)` : ""}, its run graded ${live.length}`;
  for (let i = 0; i < now.length; i++) {
    if (keysOf(live[i]!.assertion) !== keysOf(now[i]!))
      return `assertion ${i} is \`${keysOf(now[i]!)}\` now, \`${keysOf(live[i]!.assertion)}\` in its run`;
    if (now[i]!.semantic_pairwise && pairwiseComposeKey(now[i]!) !== pairwiseComposeKey(live[i]!.assertion))
      return `assertion ${i} (semantic_pairwise) has another evidence scope than in its run`;
  }
  return undefined;
}

function missingRefs(result: RunResult, c: HillclimbCase, refNames: readonly string[]): string[] {
  const pairwiseIdx = c.scenario.assert.map((a, i) => (a.semantic_pairwise !== undefined ? i : -1)).filter((i) => i >= 0);
  if (!pairwiseIdx.length) return [];
  const authored = (result.assertions ?? []).filter((e) => e.source === undefined);
  return refNames.filter((ref) => pairwiseIdx.some((i) => !(authored[i]?.pairwise ?? []).some((o) => o.ref === ref)));
}

/** Whether a row's `a<i>` keys before and after a rebuild name the same asserts: its assertion set is the scenario's
 *  now (same `assert_sig`), or — a row no regrade rewrote, so graded under its run's list — the run's list has the same
 *  length and the same keys at every index (a value edit keeps the alignment; an inserted or removed assert breaks it).
 *  A row an earlier regrade rewrote under another set has a list nothing here records: not aligned. */
function aIndexAligned(row: Row, result: RunResult, c: HillclimbCase): boolean {
  const sig = row.meta?.assert_sig;
  if (sig !== undefined && sig === assertSig(c.scenario)) return true;
  if (row.meta?.regraded_at !== undefined) return false;
  const was = authoredOf(result).map((e) => keysOf(e.assertion));
  const now = authoredNow(c).map(keysOf);
  return was.length === now.length && was.every((k, i) => k === now[i]);
}

/** The grade keys a rebuild moved: the verdict, each assert's (`a<i>`, its claims and companions), the claims and win
 *  roll-ups, and the flow's metric columns. */
const changedKeys = (
  before: Record<string, number> | undefined,
  after: Record<string, number> | undefined,
  metricIds: readonly string[],
): string[] => {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const metric = (k: string) => metricIds.some((id) => k === id || k === `${id}_present`);
  return [...keys].filter((k) => (/^(pass|claims|win|both_bad|a\d+)/.test(k) || metric(k)) && before?.[k] !== after?.[k]);
};

export async function regradeFlow(args: HillclimbRegradeArgs, deps: RegradeFlowDeps): Promise<RegradeFlowOutcome> {
  const say = (l: string) => deps.stderr(l);
  const refuse = (m: string): RegradeFlowOutcome => {
    const line = m.startsWith("refusing") ? m : `refusing to regrade: ${m}`;
    say(line);
    return { exitCode: 2, variants: [], error: { category: "usage", message: line } };
  };
  const progress = { spent: false, written: [] as string[] };
  try {
    return await regradeFlowInner(args, deps, say, refuse, progress);
  } catch (e) {
    // Before the first judge call every failure is a refusal (nothing spent, nothing written). After it, the judge
    // spend is real and some variants may already be rewritten: a runtime failure that says which.
    if (!progress.spent) return refuse(message(e));
    const m =
      `hillclimb regrade stopped after its judge calls began: ${message(e)}` +
      (progress.written.length ? ` — already rewritten: ${progress.written.join(", ")}` : " — nothing was rewritten");
    say(m);
    return { exitCode: 1, variants: [], error: { category: "runtime", message: m } };
  }
}

async function regradeFlowInner(
  args: HillclimbRegradeArgs,
  deps: RegradeFlowDeps,
  say: (l: string) => void,
  refuse: (m: string) => RegradeFlowOutcome,
  progress: { spent: boolean; written: string[] },
): Promise<RegradeFlowOutcome> {
  const flowArg = normalizeRootArg(args.flow);
  const flowAbs = resolve(deps.cwd, flowArg);
  if (!lexists(flowAbs)) throw new UsageError(`no flow dir at ${flowArg}`);
  const { cases: all } = loadCases(resolve(deps.cwd, args.target));
  const cases = selectCases(all, args.cases);
  const byId = new Map(cases.map((c) => [c.id, c]));
  // No agent runs here, so no agent model needs resolving (a flow run with --model would otherwise be refused).
  // `run --case`'s rule: the per-case checks cover the selected cases; the gate below covers every case.
  const harnessVersion = deps.harnessVersion ?? pkgVersion();
  const prep = prepareCases(
    all,
    {
      env: deps.env,
      noAgentRun: true,
      ...(args.judgeModel !== undefined ? { judgeModelFlag: args.judgeModel } : {}),
    },
    cases,
  );
  for (const n of prep.notes) say(n);
  // The flow's metric columns, refused as `run` refuses them: one id declared two ways across the cases, or a declaration
  // that changed since the flow's rows (any variant) were written — a rebuilt row would carry the new quantity beside
  // rows holding the old one. Before the gate, the locks and any judge call.
  const union = (deps.metricDecls ?? flowMetricUnion)(all);
  const existing = existingFlowSnapshot(flowArg, deps.cwd);
  if (existing) refuseChangedMetrics(existing, union);

  // The variants: every one with rows, or the one named. Read-only checks first — opening a writer creates files.
  const variants =
    args.variant === "all"
      ? NoFollowRoot.existing(flowArg, { cwd: deps.cwd })
          .readdirNoFollow(flowAbs)
          .filter((d) => d.isDirectory() && VARIANT_DIR_RE.test(d.name))
          .map((d) => d.name)
          .filter((v) => readVariantFileIfPresent(flowArg, v, "results.jsonl", deps.cwd) !== null)
          .sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : Number(a.slice(1)) - Number(b.slice(1))))
      : [args.variant];
  if (args.variant !== "all" && !VARIANT_DIR_RE.test(args.variant))
    throw new UsageError(`--variant must be 'all', 'baseline' or 'v<N>' (got ${JSON.stringify(args.variant)})`);
  for (const v of variants)
    if (readVariantFileIfPresent(flowArg, v, "results.jsonl", deps.cwd) === null)
      throw new UsageError(`${join(flowArg, v)} has no results.jsonl`);
  if (!variants.length) throw new UsageError(`${flowArg} has no variant with rows to re-grade`);

  // Every judge (semantic_matches, semantic_pairwise) runs the host `claude` isolated and tool-less, as `hillclimb run`
  // requires: a CLI that cannot is refused here, before any lock or write, instead of grading every row judge-invalid —
  // but only when a judge would run. That is decided from the rows as they are now (read-only), with the rules the
  // regrade applies under its locks: a row whose judged asserts all keep their entries costs no judge call; a fill
  // judges only the comparisons a row lacks (its own variant's aside). The rows are read again under the locks and a
  // change in between is refused, so the decision cannot be made over rows the regrade does not see.
  const refs = discoverFlowRefs(flowAbs);
  const refNames = refs.map((r) => r.name);
  const preLock = new Map(variants.map((v) => [v, readVariantFileIfPresent(flowArg, v, "results.jsonl", deps.cwd) ?? ""]));
  const willJudge = (): boolean => {
    for (const [v, text] of preLock)
      for (const raw of text.split("\n")) {
        let row: Row | undefined;
        try {
          row = raw.trim() ? (JSON.parse(raw) as Row) : undefined;
        } catch {
          row = undefined;
        }
        const c = row ? byId.get(String(row.prompt_id)) : undefined;
        if (!row || !c || !c.scenario.assert.some((a) => (args.fillRefs ? a.semantic_pairwise !== undefined : judgedOpts(a) !== undefined)))
          continue;
        const runDir = runDirOf(row, c);
        const result = runDir ? readResult(runDir) : undefined;
        if (!runDir || !result || classifyRep({ result: result as never }, {}).bucket === "errored_agent") continue;
        if (args.fillRefs ? missingRefs(result, c, refNames).some((r) => r !== v) : args.rejudge === true) return true;
        if (
          !args.fillRefs &&
          judgedPlan(row, c, runDir, result, {
            rejudge: false,
            ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
            fill: false,
            variant: v,
            refs,
          }).rejudge.size
        )
          return true;
      }
    return false;
  };
  if (willJudge()) {
    const iso = deps.isolationCheck();
    if (iso) return refuse(iso);
  }

  // The harness gate, exactly as `run` applies it: a rubric fix is a gated scenario edit.
  const state = readStateIfPresent(flowArg, deps.cwd);
  const baselineIds = [...new Set(all.map((c) => prep.baseline(c).appVersion))].sort();
  // Hashed under the `--skill` selection the flow was approved with: regrade never changes what skill_invoked tracks.
  const approvedSkill = approvedHarnessSkill(state);
  const digest = flowHarnessDigest({
    cwd: deps.cwd,
    state,
    derived: prep.derivedPaths(all),
    derivedValues: prep.derivedValues(all),
    harnessVersion,
    baselineId: baselineIds.join(","),
    ...(approvedSkill !== undefined ? { skill: approvedSkill } : {}),
  });
  const decision = gateDecision(state, digest.sha, args.approveHarness);
  if (decision.kind === "absent")
    return refuse(
      `no approved harness sha in ${join(flowArg, "_state.json")} (computed ${digest.sha.slice(0, 12)} over: ${digest.hashed.join(", ")}). Review the harness, then run once with --approve-harness to record it.`,
    );
  if (decision.kind === "mismatch")
    return refuse(
      `harness changed since last approved run (files: ${digest.hashed.join(", ")}); approved ${String(state.harness_sha).slice(0, 12)}, now ${digest.sha.slice(0, 12)}. Re-run with --approve-harness after reviewing the diff.`,
    );

  // Lock every selected variant (sorted), all or nothing.
  const writers = new Map<string, FlowWriter>();
  const releases: Array<() => void> = [];
  try {
    for (const v of variants) {
      const w = FlowWriter.open(flowArg, v, { cwd: deps.cwd, secrets: deps.secrets });
      releases.push(w.lock());
      writers.set(v, w);
    }
    // The rows the judge decision above was made over: a change since (a concurrent pass) is refused, nothing written.
    for (const v of variants)
      if ((writers.get(v)!.readVariantFile("results.jsonl") ?? "") !== preLock.get(v))
        return refuse(
          `${join(flowArg, v, "results.jsonl")} changed while regrade was starting (a concurrent pass?) — nothing was written; run it again`,
        );
    const regrade = deps.regrade ?? regradeRuns;
    const shape = {
      ...(flowHasPairwise(all.map((c) => ({ assertions: c.scenario.assert ?? [] })))
        ? { pairwise: { metricRefs: metricRefNames(refs) } }
        : {}),
      metrics: union,
      merge: deps.mergeMetrics ?? mergeMetrics,
    };
    const outcome: RegradeFlowOutcome = { exitCode: 0, variants: [] };
    // Said on every rewritten row: its deterministic asserts were re-evaluated from its kept run (only a case that has
    // one), and which harness version evaluated it (`meta.env.harnessVersion` is the run's).
    const reevaluatedMeta = (c: HillclimbCase, t: Target): Record<string, unknown> => ({
      ...(deterministicIndexes(c).length ? { regrade_reevaluated: true } : {}),
      regrade_harness_version: harnessVersion,
      ...(t.keptLive.length ? { regrade_kept_live: t.keptLive } : {}),
    });

    // Rows, grouped into batches: one regrade call per (variant, case, references to fill).
    interface Batch {
      variant: string;
      c: HillclimbCase;
      onlyRefs?: string[];
      targets: Target[];
    }
    const batches: Batch[] = [];
    // Rows rebuilt with no judge call — a case with no judged assert (re-evaluated and re-measured; in a fill, also given
    // its columns), an agent failure, a fill row lacking only its own variant's outcome — each from its kept run.
    const plain: Target[] = [];
    // Agent-failed rows whose kept run cannot be re-evaluated: rebuilt with no evidence read (see `agentFailed`).
    const metaOnly: Array<{ variant: string; c: HillclimbCase; line: Line; result: RunResult }> = [];
    const perVariant = new Map<string, { lines: Line[]; old: string; v: RegradeFlowVariant }>();
    for (const v of variants) {
      const old = writers.get(v)!.readVariantFile("results.jsonl") ?? "";
      const lines: Line[] = old
        .split("\n")
        .filter((l, i, a) => !(i === a.length - 1 && l === ""))
        .map((raw) => {
          try {
            const row = JSON.parse(raw) as Row;
            return row && typeof row === "object" ? { raw, row } : { raw };
          } catch {
            return { raw }; // a torn line is kept as it is
          }
        });
      const vr: RegradeFlowVariant = {
        variant: v,
        rewritten: 0,
        listed: [],
        reevaluated: 0,
        remeasured: 0,
        agentFailed: 0,
        regradeFiles: [],
      };
      perVariant.set(v, { lines, old, v: vr });
      outcome.variants.push(vr);
      const groups = new Map<string, Batch>();
      for (const line of lines) {
        const row = line.row;
        if (!row) continue;
        const id = String(row.prompt_id);
        const rep = Number(row.rep);
        const c = byId.get(id);
        if (!c) {
          if (!args.cases.length) vr.listed.push({ prompt_id: id, rep, why: "no scenario file for this case in the target" });
          continue;
        }
        const judged = c.scenario.assert.some((a) => judgedOpts(a) !== undefined);
        // Every selected row is re-evaluated from its kept run, a case with no judged assert included: a grader fix to
        // a deterministic assert is applied to every row, never left stale.
        const runDir = runDirOf(row, c);
        const result = runDir ? readResult(runDir) : undefined;
        if (!runDir || !result) {
          vr.listed.push({ prompt_id: id, rep, why: "its kept run dir is gone (evidence unavailable)" });
          continue;
        }
        // A fill copies every outcome it does not judge by index, so the run's list must line up with the scenario's. A
        // default regrade rebuilds the list from the scenario (each deterministic assert re-evaluated, each judged one
        // re-judged), so an added or removed assert is applied there, not listed.
        const mismatch = args.fillRefs ? shapeMismatch(result, c) : undefined;
        if (mismatch) {
          vr.listed.push({ prompt_id: id, rep, why: `${mismatch} — run a default \`hillclimb regrade\` first, then --fill-refs` });
          continue;
        }
        // A fill keeps every live outcome: one judged against a reference that has since changed (re-frozen by hand)
        // would mix two references in one row — listed before any spend, never written.
        if (args.fillRefs) {
          let k = 0;
          const entries = (result.assertions ?? []).flatMap((e) =>
            e.source === undefined ? [{ assertionIndex: k++, pairwise: e.pairwise }] : [],
          );
          const stale = staleCopied(entries, c, refs, false);
          if (stale.length) {
            vr.listed.push({
              prompt_id: id,
              rep,
              why: `its kept outcome against ${stale.join(", ")} was judged against a reference that has changed since`,
            });
            continue;
          }
        }
        // Every selected row is re-evaluated from its kept run here, before any judge call: a row whose context cannot be
        // rebuilt is listed, never re-measured as unavailable.
        const re = reevaluateFromRun(runDir, c);
        if ("listed" in re) {
          // An agent failure scores 0 whatever its asserts say: a run that cannot be re-evaluated changes nothing a row
          // grades, so only the row's meta is brought current — never listed (no command would clear it).
          if (row.meta?.failure_class === "errored_agent") metaOnly.push({ variant: v, c, line, result });
          else vr.listed.push({ prompt_id: id, rep, why: shownMessage(re.listed, deps.secrets) });
          continue;
        }
        // Decided here, before batching: a row listed by the deterministic step costs no judge call.
        const matched = liveByIdentity(result, c);
        const det = deterministicCheck(result, c, re, matched, args.fillRefs);
        if ("listed" in det) {
          vr.listed.push({ prompt_id: id, rep, why: det.listed });
          continue;
        }
        for (const i of det.keptLive)
          say(
            `  [${v}] ${id} rep${rep}: ${labelOf(c, i)} ${outcomeOf(matched[i]!.pass)} in the run, ${outcomeOf(re.deterministic[i]!.pass)} re-evaluated now — unchanged since the run, so it kept its live outcome (the kept evidence or the evaluator differs, not the grader; harness ${harnessVersion})`,
          );
        const agentFailed = classifyRep({ result: result as never }, {}).bucket === "errored_agent";
        const plan = judgedPlan(row, c, runDir, result, {
          rejudge: args.rejudge === true,
          ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
          fill: args.fillRefs,
          variant: v,
          refs,
        });
        // A fill copies every judged outcome it does not add: one whose assert changed since it was graded would be
        // stamped with the current assertion set over an old rubric's outcome — listed before any judge call.
        if (args.fillRefs && !agentFailed) {
          const changed = [...plan.rejudge].find(([, why]) => why.includes("assert_changed") || why.includes("graded_entry_unavailable"));
          if (changed) {
            vr.listed.push({
              prompt_id: id,
              rep,
              why: changed[1].includes("assert_changed")
                ? `the rubric changed since the run (${labelOf(c, changed[0])} is not the assert it was graded with): run a default \`hillclimb regrade\` first, then --fill-refs`
                : `the regrade file it was graded with cannot be read: run a default \`hillclimb regrade\` first, then --fill-refs`,
            });
            continue;
          }
        }
        const t: Target = {
          variant: v,
          c,
          line,
          runDir,
          result,
          missing: args.fillRefs ? missingRefs(result, c, refNames) : [],
          re,
          live: matched,
          keptLive: det.keptLive,
          plan,
        };
        if (!judged || (args.fillRefs ? agentFailed || !t.missing.filter((r) => r !== v).length : agentFailed || !plan.rejudge.size)) {
          // No comparison to judge: a case with no judged assert, an agent failure (it scores 0 whatever the judge
          // says), a row whose judged asserts all keep what they were graded with, and a fill row lacking only its own
          // variant's (neutral) outcome. Rebuilt with no judge call, so it is re-measured and, in a fill, carries every
          // column.
          plain.push(t);
          continue;
        }
        // One batch per set of asserts to re-judge (the rest are kept): every run in a core re-grade keeps the same ones.
        const key = `${id}\0${args.fillRefs ? t.missing.join(",") : [...plan.rejudge.keys()].join(",")}`;
        const b = groups.get(key) ?? { variant: v, c, ...(args.fillRefs ? { onlyRefs: t.missing } : {}), targets: [] };
        b.targets.push(t);
        groups.set(key, b);
      }
      batches.push(...groups.values());
      // An error row a judge outage wrote (judge_invalid) is not promoted into results.jsonl here: its slot is still
      // open, so the next `hillclimb run` pass of this variant re-runs it. Listed so the slot is not forgotten.
      const scored = new Set(lines.flatMap((l) => (l.row ? [`${String(l.row.prompt_id)}\0${String(l.row.rep)}`] : [])));
      for (const raw of (writers.get(v)!.readVariantFile("errors.jsonl") ?? "").split("\n")) {
        let e: Row | undefined;
        try {
          e = raw.trim() ? (JSON.parse(raw) as Row) : undefined;
        } catch {
          e = undefined;
        }
        if (!e || (e as { failure_class?: unknown }).failure_class !== "judge_invalid") continue;
        const id = String(e.prompt_id);
        if (args.cases.length && !byId.has(id)) continue;
        if (scored.has(`${id}\0${String(e.rep)}`)) continue;
        vr.listed.push({
          prompt_id: id,
          rep: Number(e.rep),
          // `run` schedules reps below --reps only, so the command names the case and a --reps that covers this rep.
          why: `an errors.jsonl row (judge_invalid): its slot is open — \`hillclimb run ${args.target} --flow ${flowArg} --variant ${v} --case ${id} --reps ${Number(e.rep) + 1}\` re-runs it (one agent run per open slot)`,
        });
      }
    }

    const optsFor = (b: Batch, checkOnly: boolean) => ({
      runDirs: b.targets.map((t) => t.runDir),
      scenarioFile: b.c.file,
      secrets: [...deps.secrets],
      ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
      ...(args.allowDocDrift ? { allowDocDrift: true } : {}),
      ...(args.allowUnchecked ? { allowUnchecked: true } : {}),
      pairwise: { ...flowPairwiseOptions(b.c.id, b.variant, refs), ...(b.onlyRefs ? { onlyRefs: b.onlyRefs } : {}) },
      // What each row is graded with now, and (default mode) the judged asserts it keeps: never sent to a judge.
      graded: (dir: string) => {
        const t = b.targets.find((x) => real(x.runDir) === real(dir));
        if (!t) return undefined;
        const keep = new Set(args.fillRefs ? [] : [...t.plan.entries.keys()].filter((i) => !t.plan.rejudge.has(i)));
        return { entries: t.plan.entries, keep };
      },
      ...(deps.regradeOptions ?? {}),
      ...(checkOnly ? { checkOnly: true as const } : {}),
    });

    // Before any spend, anywhere: every batch's evidence preflight. A drift or unchecked-content refusal lists every
    // run it names and rewrites nothing; a batch refused for another reason is listed and skipped.
    const skip = new Set<Batch>();
    const evidence: string[] = [];
    // A batch the core refuses for a reason that is not about evidence (a multi-turn, partial or replay run dir, a
    // pruned work dir) stops at its first such dir: split it so one bad rep does not cost its siblings their re-grade.
    for (const b of [...batches]) {
      if (b.targets.length < 2) continue;
      const pre = (await regrade(optsFor(b, true))) as RegradeOutcome | { ok: true };
      if (pre.ok || ("code" in pre && pre.code !== undefined)) continue;
      batches.splice(batches.indexOf(b), 1, ...b.targets.map((t) => ({ ...b, targets: [t] })));
    }
    for (const b of batches) {
      const pre = (await regrade(optsFor(b, true))) as RegradeOutcome | { ok: true };
      if (pre.ok) continue;
      const vr = perVariant.get(b.variant)!.v;
      if ("code" in pre && (pre.code === "doc_drift" || pre.code === "unchecked_content")) {
        for (const r of pre.refusals ?? []) {
          const t = b.targets.find((x) => real(x.runDir) === real(r.runDir));
          const where = t ? `${b.variant} ${b.c.id} rep${String(t.line.row?.rep)}` : `${b.variant} ${b.c.id}`;
          evidence.push(`${where}: ${r.code}${r.uncheckedCount ? ` (${r.uncheckedCount} unchecked section(s))` : ""}`);
        }
        continue;
      }
      if ("code" in pre && pre.code === "no_semantic_asserts") {
        skip.add(b);
        for (const t of b.targets)
          vr.listed.push({ prompt_id: b.c.id, rep: Number(t.line.row?.rep), why: "the scenario has no judged assert to re-grade" });
        continue;
      }
      skip.add(b);
      for (const t of b.targets)
        vr.listed.push({
          prompt_id: b.c.id,
          rep: Number(t.line.row?.rep),
          why: shownMessage(`refused: ${pre.message.split("\n")[0]}`, deps.secrets),
        });
    }
    if (evidence.length)
      return refuse(
        `the kept evidence cannot be re-graded as the live judge read it — nothing was re-graded or written:\n  ${evidence.join("\n  ")}\n  (--allow-doc-drift / --allow-unchecked accept it, after reading why)`,
      );
    // Every refusal is decided: record the approval now, so a refused regrade never records one.
    if (decision.kind === "approve") {
      writers.get(variants[0]!)!.approveHarness(digest.sha, approvedSkill);
      say(
        `harness approved: sha256 ${digest.sha.slice(0, 12)} over ${digest.hashed.length} file(s) recorded in ${join(flowArg, "_state.json")}`,
      );
    }

    // The spend.
    const rebuilt = new Map<Line, Row>();
    const before = new Map<Line, Record<string, number> | undefined>();
    // Rebuilt rows whose a<i> keys name other asserts than before (`aIndexAligned`): the moved table leaves them out.
    const misaligned = new Set<Line>();
    const at = new Date().toISOString();
    for (const b of batches) {
      if (skip.has(b)) continue;
      const vr = perVariant.get(b.variant)!.v;
      progress.spent = true;
      const r = (await regrade(optsFor(b, false) as RegradeOptions)) as RegradeOutcome;
      const reports = r.ok ? r.runs : "completed" in r && r.completed ? r.completed : [];
      if (!r.ok) say(`  [${b.variant}] ${b.c.id}: ${shownMessage(r.message.split("\n")[0]!, deps.secrets)}`);
      for (const t of b.targets) {
        const rep = Number(t.line.row?.rep);
        const report = reports.find((x) => real(x.runDir) === real(t.runDir));
        if (!report) {
          vr.listed.push({
            prompt_id: b.c.id,
            rep,
            why: r.ok ? "no report for its run dir" : shownMessage(`stopped: ${r.message.split("\n")[0]}`, deps.secrets),
          });
          continue;
        }
        vr.regradeFiles.push(shownRunPath(report.regradeFile, deps.secrets));
        // A fill keeps every outcome it did not judge: one copied against a reference that has since changed (re-frozen
        // by hand) would mix two references in one row — listed, never written.
        const stale = args.fillRefs ? staleCopied(report.assertions as never, b.c, refs) : [];
        if (stale.length) {
          vr.listed.push({
            prompt_id: b.c.id,
            rep,
            why: `its kept outcome against ${stale.join(", ")} was judged against a reference that has changed since`,
          });
          continue;
        }
        const byIndex = new Map(report.assertions.map((a) => [a.assertionIndex, a]));
        const built = reevaluatedResult(t.result, b.c, t.re, t.live, (i) => {
          const g = byIndex.get(i);
          return g !== undefined ? reportEntry(g) : t.plan.entries.get(i);
        });
        if ("why" in built) {
          vr.listed.push({ prompt_id: b.c.id, rep, why: built.why });
          continue;
        }
        const remeasured = withRemeasured(built.result, report);
        // A fill re-judged no gating comparison and moved no deterministic outcome: the live verdict stands, so `pass`
        // cannot move by construction. A full re-grade recomputes it (a persisted verdict would otherwise win in
        // `gradeFor` and hide every change).
        const copy = args.fillRefs && sameAuthored(remeasured, t.result) ? remeasured : withVerdict(remeasured);
        const got = rebuiltRow(
          t.line.row!,
          copy,
          b.c,
          shape,
          {
            regrade_doc_matches_live: report.docMatchesLive,
            regrade_unchecked: report.uncheckedCount,
            regrade_file: shownRunPath(report.regradeFile, deps.secrets),
            regraded_at: at,
            ...reevaluatedMeta(b.c, t),
            ...(t.plan.rejudge.size
              ? { regrade_rejudged_because: [...t.plan.rejudge].map(([i, because]) => ({ assert: i, because })) }
              : {}),
            ...(args.fillRefs
              ? {
                  regrade_fill: b.onlyRefs,
                  ...(report.judgeCostUsd !== undefined ? { regrade_judge_usd: report.judgeCostUsd } : {}),
                  ...(fillModel(report) ? { regrade_judge_model: fillModel(report) } : {}),
                }
              : {}),
          },
          args.fillRefs ? undefined : copy,
          report,
        );
        if ("why" in got) {
          vr.listed.push({ prompt_id: b.c.id, rep, why: got.why });
          continue;
        }
        before.set(t.line, t.line.row!.grade);
        rebuilt.set(t.line, got.row);
        if (!aIndexAligned(t.line.row!, t.result, b.c)) misaligned.add(t.line);
      }
    }
    for (const t of plain) {
      // A fill keeps every live outcome of a row it does not judge: the same changed-reference rule applies.
      if (args.fillRefs) {
        let k = 0;
        const entries = (t.result.assertions ?? []).flatMap((e) =>
          e.source === undefined ? [{ assertionIndex: k++, pairwise: e.pairwise }] : [],
        );
        const stale = staleCopied(entries, t.c, refs, false);
        if (stale.length) {
          perVariant.get(t.variant)!.v.listed.push({
            prompt_id: t.c.id,
            rep: Number(t.line.row?.rep),
            why: `its kept outcome against ${stale.join(", ")} was judged against a reference that has changed since`,
          });
          continue;
        }
      }
      const vr = perVariant.get(t.variant)!.v;
      const rep = Number(t.line.row?.rep);
      // No judge reads this row: a judged assert keeps the run's grade (an agent-failed row scores 0 whatever it says).
      const agentFailed = classifyRep({ result: t.result as never }, {}).bucket === "errored_agent";
      const built = reevaluatedResult(
        t.result,
        t.c,
        t.re,
        t.live,
        (i) => t.plan.entries.get(i) ?? (agentFailed ? notJudged(t.c.scenario.assert[i]!) : undefined),
      );
      if ("why" in built) {
        vr.listed.push({ prompt_id: t.c.id, rep, why: built.why });
        continue;
      }
      // Its re-evaluation's metrics, when the flow declares any (a flow that declares none carries no metric column).
      const re: Remeasure | undefined = shape.metrics.length ? t.re : undefined;
      const remeasured = re ? withRemeasured(built.result, re) : built.result;
      // The verdict moves only when an authored entry is not the run's own (an assert changed, added or removed since
      // the run): otherwise the persisted verdict stands (as in a fill, which never moves it).
      const live = sameAuthored(remeasured, t.result) ? remeasured : withVerdict(remeasured);
      const got = rebuiltRow(
        t.line.row!,
        withOwnNeutral(live, t.c, t.variant, refNames),
        t.c,
        shape,
        {
          // The judged entries kept from the row's last re-grade: that re-grade's own keys describe them still.
          ...(t.plan.fromFile ? carriedJudgeMeta(t.line.row!) : {}),
          regraded_at: at,
          ...reevaluatedMeta(t.c, t),
          ...(re && declaresMetrics(t.c) ? { regrade_remeasured: true } : {}),
          ...(args.fillRefs ? { regrade_fill: t.missing } : {}),
        },
        undefined,
        re,
      );
      if (!("why" in got)) {
        if (re && declaresMetrics(t.c)) vr.remeasured++;
        if (deterministicIndexes(t.c).length) vr.reevaluated++;
      }
      if ("why" in got) vr.listed.push({ prompt_id: t.c.id, rep, why: got.why });
      // Nothing to add (every column already there, nothing re-judged, the metrics re-measured as they were): the row
      // stays byte for byte.
      else if (
        (["grade", "explanation"] as const).every((k) => JSON.stringify(got.row[k]) === JSON.stringify(t.line.row![k])) &&
        (["metric_sigs", "metrics_unavailable", "regrade_kept_live"] as const).every(
          (k) => JSON.stringify(got.row.meta?.[k]) === JSON.stringify(t.line.row!.meta?.[k]),
        ) &&
        // A row that records another assertion set is brought current. One that records none (written before the sig
        // existed) was graded under its run's list: it is stamped when that list is not the scenario's now.
        (t.line.row!.meta?.assert_sig === undefined
          ? authoredOf(t.result).length === authoredNow(t.c).length && t.live.every((e) => e !== undefined)
          : t.line.row!.meta.assert_sig === got.row.meta?.assert_sig)
      )
        continue;
      else {
        before.set(t.line, t.line.row!.grade);
        rebuilt.set(t.line, got.row);
        if (!aIndexAligned(t.line.row!, t.result, t.c)) misaligned.add(t.line);
      }
    }

    for (const m of metaOnly) {
      const vr = perVariant.get(m.variant)!.v;
      // Every authored entry unevaluated: the row scores 0 by rule, so its grade is what `run` writes for it.
      const authored: Entry[] = authoredNow(m.c).map((a) => ({
        assertion: a as never,
        pass: false,
        message: "not evaluated: the agent failed",
      }));
      const result = { ...m.result, assertions: [...authored, ...(m.result.assertions ?? []).filter((e) => e.source !== undefined)] };
      const got = rebuiltRow(
        m.line.row!,
        result,
        m.c,
        shape,
        { regraded_at: at, regrade_harness_version: harnessVersion },
        undefined,
        shape.metrics.length ? {} : undefined,
      );
      if ("why" in got) {
        vr.listed.push({ prompt_id: m.c.id, rep: Number(m.line.row?.rep), why: got.why });
        continue;
      }
      vr.agentFailed++;
      if (
        JSON.stringify(got.row.grade) === JSON.stringify(m.line.row!.grade) &&
        (["metric_sigs", "assert_sig"] as const).every((k) => JSON.stringify(got.row.meta?.[k]) === JSON.stringify(m.line.row!.meta?.[k]))
      )
        continue;
      before.set(m.line, m.line.row!.grade);
      rebuilt.set(m.line, got.row);
      if (!aIndexAligned(m.line.row!, m.result, m.c)) misaligned.add(m.line);
    }

    // Write each variant atomically; untouched lines byte for byte.
    const report: string[] = [];
    for (const v of variants) {
      const pv = perVariant.get(v)!;
      const w = writers.get(v)!;
      const changed = pv.lines.filter((l) => rebuilt.has(l));
      if (changed.length) {
        const text = pv.lines.map((l) => (rebuilt.has(l) ? JSON.stringify(w.redactRow(rebuilt.get(l)!)) : l.raw)).join("\n") + "\n";
        pv.v.backup = w.rewriteResults(text, pv.old);
        pv.v.rewritten = changed.length;
        progress.written.push(v);
      }
      const metricIds = shape.metrics.map((m) => m.id);
      // A row whose a<i> keys name other asserts than before is compared on everything but them, and says so.
      const moved = changed
        .map((l) => ({
          l,
          keys: changedKeys(before.get(l), rebuilt.get(l)!.grade, metricIds).filter((k) => !misaligned.has(l) || !/^a\d+/.test(k)),
        }))
        .filter((x) => x.keys.length || misaligned.has(x.l));
      const mean = (rows: Array<Record<string, number> | undefined>) => {
        const xs = rows.map((g) => g?.pass).filter((x): x is number => typeof x === "number");
        return xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) : "n/a";
      };
      const lines = [
        `# ${v}: hillclimb regrade ${at}${args.fillRefs ? " (--fill-refs)" : ""}`,
        "",
        `rewritten ${pv.v.rewritten}${pv.v.reevaluated ? `, re-evaluated ${pv.v.reevaluated} (no judge call)` : ""}${pv.v.remeasured ? `, re-measured ${pv.v.remeasured} (no judge call)` : ""}${pv.v.agentFailed ? `, ${pv.v.agentFailed} agent failure(s): meta updated` : ""}, listed ${pv.v.listed.length}; mean pass before ${mean(changed.map((l) => before.get(l)))}, after ${mean(changed.map((l) => rebuilt.get(l)!.grade))}`,
        ...(moved.length ? ["", "| case | rep | moved |", "|---|---|---|"] : []),
        ...moved.map(({ l, keys }) => {
          const b = before.get(l) ?? {};
          const a = rebuilt.get(l)!.grade ?? {};
          const note = misaligned.has(l) ? "(a<i> not compared: the assertion list changed)" : "";
          const cell = [keys.map((k) => `${k} ${b[k] ?? "—"}→${a[k] ?? "—"}`).join(", "), note].filter(Boolean).join(" ");
          return `| ${String(l.row!.prompt_id)} | ${String(l.row!.rep)} | ${cell} |`;
        }),
        ...(pv.v.listed.length ? ["", "Not re-graded:", ...pv.v.listed.map((x) => `- ${x.prompt_id} rep${x.rep}: ${x.why}`)] : []),
        "",
      ];
      if (changed.length || pv.v.listed.length) w.writeRegradeReport(lines.join("\n"));
      report.push(
        ...lines
          .slice(2)
          .filter(Boolean)
          .map((x) => `  [${v}] ${x}`),
      );
    }
    for (const l of report) say(l);
    for (const vr of outcome.variants) {
      const open = vr.listed.filter((x) => x.why.startsWith("an errors.jsonl row (judge_invalid)"));
      if (!open.length) continue;
      // One command per case: --reps covers its highest open rep (lower open slots of the case are re-run with it).
      const byCase = new Map<string, number>();
      for (const x of open) byCase.set(x.prompt_id, Math.max(byCase.get(x.prompt_id) ?? 0, x.rep + 1));
      say(
        `  [${vr.variant}] ${open.length} slot(s) hold a judge_invalid error row (about one agent run each to re-run): ${[...byCase]
          .map(([id, reps]) => `\`hillclimb run ${args.target} --flow ${flowArg} --variant ${vr.variant} --case ${id} --reps ${reps}\``)
          .join("; ")}`,
      );
    }
    outcome.exitCode = outcome.variants.some((v) => v.listed.length) ? 1 : 0;
    say(
      `hillclimb regrade: ${outcome.variants
        .map(
          (v) =>
            `${v.variant} ${v.rewritten} rewritten${v.reevaluated ? `, ${v.reevaluated} re-evaluated (no judge call)` : ""}${v.remeasured ? `, ${v.remeasured} re-measured (no judge call)` : ""}${v.agentFailed ? `, ${v.agentFailed} agent failure(s): meta updated` : ""}${v.listed.length ? `, ${v.listed.length} listed` : ""}`,
        )
        .join("; ")}`,
    );
    return outcome;
  } finally {
    for (const r of releases.reverse()) r();
  }
}

// Paired-evaluation per-rep classification and row extraction. Pure: reads a rep's persisted RunResult (and
// the error its job threw, if any) and returns a bucket; reads the frozen scenario's assertions and returns
// rows. Nothing here runs, reads files, or re-derives a field another producer already stamped.
//
// Why a table and not `resultErrorKind`: `classifyResultError` (src/run/run.ts) returns "agent" for every
// spawn and protocol failure, and the wall-clock timeout and no-terminal-event paths set `errorSource` without
// any `resultErrorKind`. Keying on the kind alone blames a Docker outage on the skill and leaves a timeout in
// no bucket. The table below keys on every field that distinguishes the cases, and a combination it does not
// recognise is `errored_infra` with `unclassified: true` — excluded and reported, never silently scored as
// the skill failing.
import type { Assertion, RunResult } from "../types.js";
import { isLiveModelId } from "../types.js";
import { BoundaryError, DeciderTimeoutError, UnansweredError } from "../errors.js";
import { firstAssertionKey } from "../run/repeat.js";
import { matchesTerminalUsageLimitText } from "../usage-limit.js";

type ErrorSource = NonNullable<RunResult["errorSource"]>;
type ResultErrorKind = NonNullable<RunResult["resultErrorKind"]>;

/** Every `RunResult.errorSource` member. The `satisfies` below fails the typecheck if a member is added to
 *  the type and not here, and the Record in `ERROR_SOURCE_RULE` fails it until the member has a rule. */
export const ERROR_SOURCES = ["spawn", "protocol", "exit", "agent", "result", "no_result", "timeout", "decider_timeout"] as const;
export const RESULT_ERROR_KINDS = ["transport", "agent", "usage_limit"] as const;
type Missing<Union, Listed> = Exclude<Union, Listed> extends never ? true : false;
const errorSourcesComplete: Missing<ErrorSource, (typeof ERROR_SOURCES)[number]> = true;
const resultErrorKindsComplete: Missing<ResultErrorKind, (typeof RESULT_ERROR_KINDS)[number]> = true;
void errorSourcesComplete;
void resultErrorKindsComplete;

/** SDK result subtypes seen in the staged agent binary. Diagnostic only: `resultSubtype` is a free string,
 *  so no bucket may depend on it — a subtype the SDK ships next month must land exactly where its
 *  (errorSource, resultErrorKind) pair already does. */
export const KNOWN_RESULT_SUBTYPES = [
  "success",
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
] as const;

export type TerminationBucket = "valid" | "errored_infra" | "errored_agent";

/** The fields of a rep's result the classifier and the row extractor read. A full `RunResult` satisfies it. */
export type ClassifiableResult = Partial<
  Pick<
    RunResult,
    | "scenario"
    | "errorSource"
    | "resultErrorKind"
    | "resultSubtype"
    | "stalledOnQuestion"
    | "partial"
    | "unansweredGate"
    | "models"
    | "modelPinHonored"
    | "finalMessage"
  >
> & {
  result: RunResult["result"];
  fingerprint?: { contentSig?: string };
  cost?: { usd?: number };
  usage?: { turns?: number };
  durationMs?: number;
  assertions?: Array<
    Pick<RunResult["assertions"][number], "assertion" | "pass"> &
      Partial<
        Pick<
          RunResult["assertions"][number],
          "source" | "semanticClaims" | "judgeInvalid" | "judgePromptHash" | "judgeCostUsd" | "semanticEvidence"
        >
      >
  >;
};

export interface RepEvidence {
  /** The rep's result.json, including a salvaged partial. Absent when the job produced none. */
  result?: ClassifiableResult;
  /** What the rep's job threw, if anything (the runner catches it and passes it here). */
  thrown?: unknown;
}

export interface TerminationClassification {
  bucket: TerminationBucket;
  /** Which row of the table matched — stable identifiers for the report's histogram. */
  rule: string;
  /** No row matched: the bucket is `errored_infra` so the rep is excluded, and the report must say so. */
  unclassified: boolean;
  /** An `exit` after a crash: an OOM-killed binary and a skill-caused crash look alike here. */
  ambiguousExit: boolean;
  errorSource?: ErrorSource;
  resultErrorKind?: ResultErrorKind;
  resultSubtype?: string;
}

/** How an `error` result's `errorSource` decides the bucket before the kind is consulted. `by_kind` defers
 *  to `resultErrorKind` (only `agent` is the agent's); `agent_if_no_kind` is the agent's only with no kind. */
const ERROR_SOURCE_RULE: Record<ErrorSource, "infra" | "agent" | "by_kind" | "agent_if_no_kind"> = {
  spawn: "infra", // the harness could not start the agent (Docker, a missing staged binary)
  protocol: "infra", // the stream-json channel broke
  decider_timeout: "infra", // a --decider-cmd / --decider-dir channel did not answer within its backstop
  timeout: "agent", // the run never finished its task within the wall-clock limit
  no_result: "agent", // the stream ended with no terminal event (turn/time exhaustion)
  result: "by_kind", // the SDK's own is_error result
  exit: "by_kind", // a nonzero child exit
  // A non-fatal agent event came first and `errorSource ??= "agent"` kept it (run.ts): an unanswered-gate
  // partial and a stream that then ended with no terminal event (the `no_result` stamp only fires when no
  // source is set) both persist this with NO kind, and both are the agent's. A kind here has no producer.
  agent: "agent_if_no_kind",
};

const INFRA_KINDS: ReadonlySet<ResultErrorKind> = new Set(["transport", "usage_limit"]);

/** The agent's own text when it could not authenticate — the whole reply, fabricated locally (model
 *  `<synthetic>`, the assistant event's `error: "authentication_failed"`), surfaced as the result's
 *  `finalMessage`. The two spellings are the ones kept runs hold (searched 2026-09-30): `Not logged in ·
 *  Please run /login` and `Authentication required · Sign in again to continue`. No kept run shows an
 *  invalid-API-key or 401 text, so none is guessed here; such a rep still lands in `no_model_answered`. */
export const AUTH_FAILURE_SIGNATURE = /\bNot logged in\b.*\/login\b|\bAuthentication required\b.*\bSign in again\b/;

/** No model answered: the agent reported models, every one a local marker (`<synthetic>`), and zero spend.
 *  Positive evidence only — an absent or empty `models` is "no evidence" and stays on the table below (a
 *  skill that crashes before its first model call must be scored, not excluded). Spend separates it from a
 *  slash-command run, whose `models` is synthetic-only too but which a model did answer. */
function noModelAnswered(r: ClassifiableResult): boolean {
  return Array.isArray(r.models) && r.models.length > 0 && !r.models.some(isLiveModelId) && r.cost?.usd === 0;
}

type ThrownKind = "decider_timeout" | "boundary" | "unanswered" | "other";
function thrownKind(e: unknown): ThrownKind {
  // Subclass first: a DeciderTimeoutError IS an UnansweredError, and it is the answerer's failure, not the skill's.
  if (e instanceof DeciderTimeoutError) return "decider_timeout";
  if (e instanceof BoundaryError) return "boundary";
  if (e instanceof UnansweredError) return "unanswered";
  return "other";
}

/** The termination decision table: valid, the agent's error (counted as failing every row), or
 *  infrastructure (excluded). Evaluated in this order:
 *
 *  | evidence                                                           | bucket          |
 *  |--------------------------------------------------------------------|-----------------|
 *  | thrown DeciderTimeoutError                                         | errored_infra   |
 *  | thrown BoundaryError                                               | errored_infra   |
 *  | thrown UnansweredError                                             | errored_agent   |
 *  | thrown anything else / no result at all                            | unclassified    |
 *  | success, errorSource absent or `agent`, no kind, stalled           | errored_agent   |
 *  | success, errorSource absent or `agent`, no kind                    | valid           |
 *  | success, any other errorSource or any kind                         | unclassified    |
 *  | error, errorSource spawn / protocol / decider_timeout              | errored_infra   |
 *  | error, kind transport / usage_limit                                | errored_infra   |
 *  | error, `<synthetic>` in models, finalMessage an auth failure       | errored_infra (auth) |
 *  | error, `<synthetic>` in models, finalMessage a terminal limit      | errored_infra (usage_limit) |
 *  | error, models only `<synthetic>`, cost 0 (no model answered)       | errored_infra (no_model_answered) |
 *  | error, errorSource timeout / no_result                             | errored_agent   |
 *  | error, errorSource result, kind agent (any subtype)                | errored_agent   |
 *  | error, errorSource exit, kind agent                                | errored_agent, ambiguousExit |
 *  | error, errorSource agent, no kind (partial, or no terminal event)  | errored_agent   |
 *  | error, no errorSource, no kind, partial or unansweredGate          | errored_agent   |
 *  | anything else                                                      | unclassified    |
 */
export function classifyTermination(ev: RepEvidence): TerminationClassification {
  const r = ev.result;
  const detail = {
    ...(r?.errorSource !== undefined ? { errorSource: r.errorSource } : {}),
    ...(r?.resultErrorKind !== undefined ? { resultErrorKind: r.resultErrorKind } : {}),
    ...(r?.resultSubtype !== undefined ? { resultSubtype: r.resultSubtype } : {}),
  };
  const out = (bucket: TerminationBucket, rule: string, extra: { unclassified?: boolean; ambiguousExit?: boolean } = {}) => ({
    bucket,
    rule,
    unclassified: extra.unclassified ?? false,
    ambiguousExit: extra.ambiguousExit ?? false,
    ...detail,
  });
  const unclassified = (rule: string) => out("errored_infra", rule, { unclassified: true });

  if (ev.thrown !== undefined) {
    switch (thrownKind(ev.thrown)) {
      case "decider_timeout":
        return out("errored_infra", "thrown_decider_timeout");
      case "boundary":
        return out("errored_infra", "thrown_boundary");
      case "unanswered":
        return out("errored_agent", "thrown_unanswered");
      case "other":
        return unclassified("thrown_other");
    }
  }
  if (r === undefined) return unclassified("no_result_file");

  const source = r.errorSource;
  const kind = r.resultErrorKind;

  if (r.result === "success") {
    if ((source === undefined || source === "agent") && kind === undefined) {
      // A stall is the agent's own failure, so it fails every row. The flag is run.ts's detector: a closing
      // `?`, or (after a gate) a cued closing request for input such as "Please share X so I can…" — see
      // input-request.ts. `allow_stall` is a verdict modifier and is not consulted here.
      return r.stalledOnQuestion === true ? out("errored_agent", "stalled_on_question") : out("valid", "success");
    }
    return unclassified("success_with_error_fields");
  }

  // Infrastructure the table already names keeps its name; then, before the agent's rows: the agent reports
  // a failed login as an ordinary `result`/`exit` error with kind `agent`, so the table alone blames the
  // skill for a missing credential.
  if (source !== undefined && ERROR_SOURCE_RULE[source] === "infra") return out("errored_infra", `source_${source}`);
  if (kind !== undefined && INFRA_KINDS.has(kind)) return out("errored_infra", `kind_${kind}`);
  // The agent writes its own sign-in and limit replies as a `<synthetic>` turn (every kept error run with
  // such text has one), so the text counts only beside that marker — a skill's own message that merely
  // reads like a limit or a login prompt ("You've reached your daily limit of 5 files") stays the skill's.
  const agentWrote = typeof r.finalMessage === "string" && (r.models ?? []).some((m) => !isLiveModelId(m));
  if (agentWrote && AUTH_FAILURE_SIGNATURE.test(r.finalMessage!)) return out("errored_infra", "auth");
  // The run lane names a usage limit only on the `result` path (with its HTTP status); on the nonzero-exit
  // path the same terminal text arrives as kind `agent`, even after a live model has spent. The text is the
  // account's quota, never the skill: the shared terminal-limit matcher (transient rate limits excluded).
  if (agentWrote && matchesTerminalUsageLimitText(r.finalMessage!)) return out("errored_infra", "usage_limit");
  if (noModelAnswered(r)) return out("errored_infra", "no_model_answered");

  if (source !== undefined) {
    const rule = ERROR_SOURCE_RULE[source];
    if (rule === "infra") return out("errored_infra", `source_${source}`);
    if (kind !== undefined && INFRA_KINDS.has(kind)) return out("errored_infra", `kind_${kind}`);
    if (rule === "agent") return out("errored_agent", `source_${source}`);
    if (rule === "by_kind" && kind === "agent") {
      return source === "exit" ? out("errored_agent", "exit_agent", { ambiguousExit: true }) : out("errored_agent", `${source}_agent`);
    }
    if (rule === "agent_if_no_kind" && kind === undefined) {
      return out(
        "errored_agent",
        r.partial === true || r.unansweredGate !== undefined ? "agent_then_unanswered_gate" : "agent_then_no_result",
      );
    }
    return unclassified(`source_${source}_kind_${kind ?? "none"}`);
  }

  if (kind !== undefined && INFRA_KINDS.has(kind)) return out("errored_infra", `kind_${kind}`);
  if (kind === undefined && (r.partial === true || r.unansweredGate !== undefined)) return out("errored_agent", "unanswered_gate");
  return unclassified(`no_source_kind_${kind ?? "none"}`);
}

export type RepBucket =
  "valid" | "errored_infra" | "arm_source_drift" | "model_mismatch" | "judge_prompt_mismatch" | "errored_agent" | "judge_invalid";

/** What one arm's reps must match. An unset field skips that check. */
export interface ArmExpectations {
  /** The arm snapshot's content signature, derived by the same call a rep's fingerprint uses. */
  contentSig?: string;
  /** The grading-prompt identity every graded assertion must carry (`JUDGE_PROMPT_HASH`). */
  judgePromptHash?: string;
}

export interface RepClassification {
  bucket: RepBucket;
  termination: TerminationClassification;
  /** Assertion indexes (into the frozen scenario) whose grade is invalid for this rep. Their rows lose the
   *  rep; every other row keeps it. Only meaningful when `bucket` is `judge_invalid`. */
  judgeInvalidAssertions: number[];
}

/** Assertions the harness injected (staleness, cassette-format, coverage) are not the author's rows. */
const authoredGrades = (r: ClassifiableResult | undefined) => (r?.assertions ?? []).filter((a) => a.source === undefined);

/** Does any graded `semantic_matches` carry an OBSERVED prompt identity other than the expected one? */
function promptMismatch(r: ClassifiableResult | undefined, expected: string): boolean {
  return authoredGrades(r).some(
    (a) => a.assertion.semantic_matches !== undefined && a.judgePromptHash !== undefined && a.judgePromptHash !== expected,
  );
}

/** One bucket per rep, in fixed precedence:
 *  errored_infra > errored_agent > arm_source_drift > judge_prompt_mismatch > model_mismatch > judge_invalid > valid.
 *
 *  Only POSITIVE evidence excludes a rep. An agent error ranks above every exclusion, so a skill change that
 *  crashes on the first turn (no model evidence, no grades) is scored 0 on every row rather than silently
 *  removed from the denominator. Then:
 *  - `arm_source_drift` needs an OBSERVED `fingerprint.contentSig` that differs from the arm's; a missing sig
 *    is not drift.
 *  - `judge_prompt_mismatch` needs a graded `semantic_matches` whose OBSERVED `judgePromptHash` differs.
 *  - `model_mismatch` on `modelPinHonored === false`, or on `undefined` — which can only reach here on a
 *    success-shaped rep, where no model evidence means the pin cannot be vouched for. It reads the persisted
 *    value that `deriveModelProvenance` (the one producer) stamped, so a report re-rendered from disk agrees
 *    with the run. */
export function classifyRep(ev: RepEvidence, expected: ArmExpectations): RepClassification {
  const termination = classifyTermination(ev);
  const r = ev.result;
  const bucket = ((): RepBucket => {
    if (termination.bucket === "errored_infra") return "errored_infra";
    if (termination.bucket === "errored_agent") return "errored_agent";
    const observedSig = r?.fingerprint?.contentSig;
    if (expected.contentSig !== undefined && observedSig !== undefined && observedSig !== expected.contentSig) return "arm_source_drift";
    if (expected.judgePromptHash !== undefined && promptMismatch(r, expected.judgePromptHash)) return "judge_prompt_mismatch";
    if (r?.modelPinHonored !== true) return "model_mismatch";
    return invalidIndexes(r).length > 0 ? "judge_invalid" : "valid";
  })();
  return { bucket, termination, judgeInvalidAssertions: bucket === "judge_invalid" ? invalidIndexes(r) : [] };
}

function invalidIndexes(r: ClassifiableResult | undefined): number[] {
  const out: number[] = [];
  authoredGrades(r).forEach((a, i) => {
    if (a.judgeInvalid === true) out.push(i);
  });
  return out;
}

// ---- rows ------------------------------------------------------------------------------------------------

/** The claim-text normal form a sub-row is keyed by: NFC, whitespace collapsed, trimmed, lowercased. */
export function normalizeClaim(claim: string): string {
  return claim.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export interface RowKey {
  /** Unambiguous key: JSON of [scenario, assertionIndex] or [scenario, assertionIndex, normalizedClaim]. */
  id: string;
  scenario: string;
  assertionIndex: number;
  /** `semantic_rollup` is a semantic_matches assertion's own pass (a function of its claims via min_pass);
   *  `claim` is one rubric claim. */
  kind: "assertion" | "semantic_rollup" | "claim";
  /** `firstAssertionKey` of the assertion — a display label, NOT unique (two semantic asserts share it). */
  label: string;
  claimIndex?: number;
  /** The normalized claim text (claim rows only). */
  claim?: string;
}

/** Every assertion of the frozen scenario is a row; each `semantic_matches` rubric claim is a sub-row.
 *  Rows come from the scenario, never from a result — an errored rep's result has fewer or no grades. */
export function scenarioRows(scenario: string, assertions: readonly Assertion[]): RowKey[] {
  const rows: RowKey[] = [];
  assertions.forEach((a, assertionIndex) => {
    const label = firstAssertionKey(a);
    const rubric = a.semantic_matches?.rubric;
    rows.push({
      id: JSON.stringify([scenario, assertionIndex]),
      scenario,
      assertionIndex,
      kind: rubric ? "semantic_rollup" : "assertion",
      label,
    });
    if (!rubric) return;
    const seen = new Set<string>();
    rubric.forEach((raw, claimIndex) => {
      const claim = normalizeClaim(raw);
      if (seen.has(claim))
        throw new Error(`scenario "${scenario}" assertion ${assertionIndex}: duplicate rubric claim after normalization: "${claim}"`);
      seen.add(claim);
      rows.push({
        id: JSON.stringify([scenario, assertionIndex, claim]),
        scenario,
        assertionIndex,
        kind: "claim",
        label,
        claimIndex,
        claim,
      });
    });
  });
  return rows;
}

export type RowExclusion =
  | Exclude<RepBucket, "valid" | "errored_agent">
  /** The rep has no grade at this assertion index. */
  | "grade_missing"
  /** The grade at this index is for a different assertion than the frozen scenario's. */
  | "grade_misaligned"
  /** A semantic_matches grade with no per-claim results (the judge never graded the claims). */
  | "claims_missing"
  /** A semantic_matches assert whose verdict REFUSED for unavailable evidence (`semanticEvidence.reason` is
   *  anything but `graded`): the rep is neither a pass nor a fail on that assertion, so — like a
   *  `judge_invalid` grade — it leaves that assertion's claim rows, and its roll-up row when
   *  `semantic_matches` is the assertion's only key. Claims recorded beside such a refusal (a result written
   *  before the judge was skipped for it) were graded over incomplete evidence and are not counted either.
   *  A MULTI-key assertion's roll-up keeps its fail: the grade keeps one `pass` for the AND of every key, so
   *  a sibling key that failed would be dropped with it — and a refusal that hides a real fail is the
   *  direction an A/B comparison must not err in. */
  | "evidence_unavailable";

type Grade = NonNullable<ClassifiableResult["assertions"]>[number];

/** Why a `semantic_matches` grade's evidence was unavailable — its typed reason, or `unrecorded` for a refusal
 *  proven from a grade that predates the persisted reason (see below). */
export type SemanticRefusalReason = Exclude<NonNullable<Grade["semanticEvidence"]>["reason"], "graded"> | "unrecorded";

/** The refusal reason of a `semantic_matches` grade whose evidence was unavailable, else undefined.
 *
 *  Read from `semanticEvidence` — never from the message text, which a grade does not keep. A runs.jsonl
 *  line written before that field was persisted carries none, so for it only the case that is PROVABLE from
 *  the persisted fields is recognised: a grade whose assertion has `semantic_matches` as its only key, with
 *  per-claim results that meet `min_pass`, no `judgeInvalid`, and `pass: false`. The check sets `pass` to
 *  exactly "claims met min_pass" when it grades, so a fail there can only have been a refusal (`unrecorded`).
 *  A refused grade whose claims ALSO missed `min_pass` looks exactly like a graded fail, and is left as one. */
export function semanticRefusalReason(g: Grade): SemanticRefusalReason | undefined {
  const sm = g.assertion.semantic_matches;
  if (sm === undefined) return undefined;
  if (g.semanticEvidence !== undefined) return g.semanticEvidence.reason === "graded" ? undefined : g.semanticEvidence.reason;
  if (g.pass || g.judgeInvalid === true || g.semanticClaims === undefined || Object.keys(g.assertion).length !== 1) return undefined;
  const need = sm.min_pass === undefined || sm.min_pass === "all" ? sm.rubric.length : sm.min_pass;
  return g.semanticClaims.filter((c) => c.pass).length >= need ? "unrecorded" : undefined;
}

export interface RowValue {
  row: RowKey;
  /** 1 = the rep passed this row, 0 = it failed. Absent when excluded. */
  value?: 0 | 1;
  excluded?: RowExclusion;
}

const sameAssertion = (a: Assertion, b: Assertion): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One rep's contribution to each row. `errored_agent` is 0 on every row (intention to treat); the excluded
 *  buckets drop the rep from every row; `judge_invalid` drops it from that assertion's rows only, and so does
 *  a `semantic_matches` grade that refused for unavailable evidence (`evidence_unavailable`). A grade
 *  that cannot be lined up with the frozen scenario is excluded with a reason, never guessed. */
export function repRowValues(
  rows: readonly RowKey[],
  scenarioAssertions: readonly Assertion[],
  c: RepClassification,
  result: ClassifiableResult | undefined,
): RowValue[] {
  if (c.bucket === "errored_agent") return rows.map((row) => ({ row, value: 0 }));
  if (c.bucket !== "valid" && c.bucket !== "judge_invalid") return rows.map((row) => ({ row, excluded: c.bucket as RowExclusion }));
  const grades = authoredGrades(result);
  const invalid = new Set(c.judgeInvalidAssertions);
  const bit = (pass: boolean): 0 | 1 => (pass ? 1 : 0);
  return rows.map((row): RowValue => {
    if (invalid.has(row.assertionIndex)) return { row, excluded: "judge_invalid" };
    const g = grades[row.assertionIndex];
    if (g === undefined) return { row, excluded: "grade_missing" };
    if (!sameAssertion(g.assertion, scenarioAssertions[row.assertionIndex])) return { row, excluded: "grade_misaligned" };
    if (semanticRefusalReason(g) !== undefined && (row.kind === "claim" || Object.keys(g.assertion).length === 1))
      return { row, excluded: "evidence_unavailable" };
    if (row.kind !== "claim") return { row, value: bit(g.pass) };
    if (g.semanticClaims === undefined) return { row, excluded: "claims_missing" };
    const claim = g.semanticClaims.find((sc) => sc.index === row.claimIndex);
    if (claim === undefined) return { row, excluded: "claims_missing" };
    if (normalizeClaim(claim.claim) !== row.claim) return { row, excluded: "grade_misaligned" };
    return { row, value: bit(claim.pass) };
  });
}

// ---- descriptive per-arm medians ---------------------------------------------------------------------------

export interface MedianStat {
  /** Undefined when no eligible rep carries the metric. */
  median?: number;
  /** How many reps the median covers (eligible reps that carry the metric). */
  n: number;
}

export interface ArmMedians {
  /** Reps the medians are drawn from: valid, judge_invalid and errored_agent (the reps that ran as the arm). */
  eligibleReps: number;
  costUsd: MedianStat;
  /** Per rep, the sum of its priced judge calls; a rep with none is unpriced, not $0, and is not counted. */
  judgeCostUsd: MedianStat;
  turns: MedianStat;
  durationMs: MedianStat;
}

const MEDIAN_BUCKETS: ReadonlySet<RepBucket> = new Set(["valid", "judge_invalid", "errored_agent"]);

function median(values: number[]): MedianStat {
  if (values.length === 0) return { median: undefined, n: 0 };
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return { median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, n: v.length };
}

const finite = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** Descriptive medians of cost, judge cost, turns and duration for one arm — no test is run on them.
 *  Drawn from valid, judge_invalid and errored_agent reps: the same reps that are scored, so an arm whose
 *  change makes runs crash early shows it here too. Infrastructure and excluded reps are left out. */
export function armMedians(reps: ReadonlyArray<{ bucket: RepBucket; result?: ClassifiableResult }>): ArmMedians {
  const eligible = reps.filter((x) => MEDIAN_BUCKETS.has(x.bucket)).map((x) => x.result);
  const pick = (f: (r: ClassifiableResult) => number | undefined) => median(eligible.map((r) => (r ? f(r) : undefined)).filter(finite));
  return {
    eligibleReps: eligible.length,
    costUsd: pick((r) => r.cost?.usd),
    judgeCostUsd: pick((r) => {
      const priced = (r.assertions ?? []).map((a) => a.judgeCostUsd).filter(finite);
      return priced.length ? priced.reduce((a, b) => a + b, 0) : undefined;
    }),
    turns: pick((r) => r.usage?.turns),
    durationMs: pick((r) => r.durationMs),
  };
}

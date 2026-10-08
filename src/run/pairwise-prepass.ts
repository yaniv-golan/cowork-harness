// LIVE-ONLY async pre-pass for `semantic_pairwise`: compare each such assert's judged document with its frozen
// references, before the synchronous `evaluate()`, which only reads the stored outcomes (the same split as
// `runSemanticJudges`). The candidate document is the one `semantic_matches` would grade — one composer — and an
// assert whose evidence is unavailable refuses before any judge call, with the same typed reasons.

import { createHash } from "node:crypto";
import { COMPOSER_ID, composeJudgedDocument, judgedOpts, semanticRefusal, type AssertContext } from "../assert.js";
import { finalizeRationale } from "../decide/semantic-judge.js";
import { PAIRWISE_PROMPT_HASH, PairwiseJudgeInvalid, type PairwiseJudge } from "../decide/pairwise-judge.js";
import { addCost, addTokenUsage } from "../decide/usage.js";
import { warn } from "../io.js";
import { scrub } from "../secrets.js";
import { composeKey, readRefDoc } from "../refs/store.js";
import { redactHostPaths } from "./host-path-tokens.js";
import type { Assertion, RunResult, TokenUsage } from "../types.js";
import type { TransportIdentity } from "../decide/llm-transport.js";

export interface PairwiseRef {
  /** Identifies the reference in results (`baseline`, `v2`, or a store dir's name). */
  name: string;
  /** The reference store directory. */
  store: string;
}

export interface PairwisePrepassOpts {
  /** The case's entry name in every store. */
  caseId: string;
  /** Seeds the per-case A/B order, so a re-grade of the same run reproduces it. */
  sessionId: string;
  /** The task the outputs answer (the scenario prompt). */
  task: string;
  refsFor: (a: Assertion) => PairwiseRef[];
  /** References frozen from this very run's variant: no judge call, a neutral 0.5. */
  neutralRefs?: ReadonlySet<string>;
  /** The references that decide the verdict. Unset = every reference (a scenario run, an eval). A reference outside
   *  the set is a metric only: its outcome is recorded with `gate: false`, and one that cannot be compared (missing,
   *  integrity, a judge reply that stayed invalid) degrades that outcome alone instead of the assert. */
  gateRefs?: ReadonlySet<string>;
  /** Fill mode (a re-grade that only adds comparisons): judge only these references; every other outcome is the
   *  live run's, from `copyOutcome`, recorded `copied: true` — no judge call, so it cannot move. */
  onlyRefs?: ReadonlySet<string>;
  copyOutcome?: (assertIndex: number, ref: string) => Outcome | undefined;
  /** Asserts (by index in `assertions`) this pass leaves alone: no document is composed, no judge called, nothing
   *  recorded in the context. The index still seeds every other assert's comparison order, so the list is passed whole. */
  skip?: (assertIndex: number) => boolean;
  /** Epoch ms after which no judge call may start. A comparison not started by then is not made, and
   *  `deadlinePassed` is set on the context, so the caller ends the run as a timeout. */
  deadline?: number;
  /** A judge for a resolved model id. Called lazily, only when a comparison actually runs. */
  judgeFor: (model: string) => PairwiseJudge;
  modelFor: (a: Assertion) => string;
  /** The run's observed main-agent model(s): a judge that IS the model under test grades its own kind of output
   *  (build-eval.md: avoid using the exact model-under-test as its own judge) — warned, not refused. */
  mainModels?: readonly string[];
  /** How the judge's host `claude` was called (`transportIdentity`); absent for an injected transport. */
  transport?: () => TransportIdentity;
}

type Outcome = NonNullable<RunResult["assertions"][number]["pairwise"]>[number];

/** Scrub markers in a text. */
const markers = (t: string): number => t.split(REDACTION_MARK).length - 1;
/** How many distinct strings a scrub set holds (the count a reference sidecar records, `scrubCount`). */
export const distinct = (secrets: readonly string[]): number => new Set(secrets.filter((x) => x.length > 0)).size;
const REDACTION_MARK = "[REDACTED]";

/** One model, however it is spelled: case-folded, without a context-window suffix (`[1m]`) or a trailing release
 *  date (`-20250101`). Used for the self-judge warning, so an alias and its dated id are the same model, and by
 *  `hillclimb regrade` to compare a requested judge model with a served id when no request was recorded. */
export function sameModelKey(m: string): string {
  return m
    .trim()
    .toLowerCase()
    .replace(/\[\d+[km]\]$/, "")
    .replace(/-\d{8}$/, "");
}

/** The composed candidate document for one assert, with the host-path transform every frozen reference received
 *  — applied to both sides, or `~/…` against `/Users/…` would tell the judge which output is the reference. */
export function candidateDocument(ctx: AssertContext, a: Assertion): ReturnType<typeof composeJudgedDocument> & { candidate: string } {
  const o = judgedOpts(a)!;
  const built = composeJudgedDocument(ctx, o.includeSubagentText, o.evidenceFiles, o.includeForkResults);
  return { ...built, candidate: redactHostPaths(built.doc).text };
}

/** The compose key a reference document for this assert is stored under, on the scenario's lane: a remote document
 *  is transcript-only, so it has its own key (see `composeKey`). The lane is a required argument (undefined = local) so
 *  a caller that drops it fails to compile instead of silently reading the local key. */
export function pairwiseComposeKey(a: Assertion, lane: "local" | "remote" | undefined): string {
  const o = judgedOpts(a)!;
  return composeKey(COMPOSER_ID, {
    includeSubagentText: o.includeSubagentText,
    includeForkResults: o.includeForkResults,
    evidenceFiles: o.evidenceFiles,
    lane,
  });
}

export async function runPairwiseJudges(assertions: Assertion[], ctx: AssertContext, opts: PairwisePrepassOpts): Promise<void> {
  ctx.pairwiseResults ??= new Map();
  ctx.judgeModels ??= new Map();
  ctx.judgeCosts ??= new Map();
  ctx.judgeUsages ??= new Map();
  ctx.judgedDocs ??= new Map();
  ctx.judgePromptHashes ??= new Map();
  ctx.judgeInvalid ??= new Set();
  ctx.judgeAttempts ??= new Map();
  ctx.semanticDocInfo ??= new Map();
  ctx.semanticRefused ??= new Map();
  const secrets = ctx.secrets ?? [];
  // Every line this pass prints goes through the scrub: a reference's name, a model id and a judge's reply can each
  // carry a value the run scrubs.
  const say = (m: string): void => warn(secrets.length ? scrub(m, secrets) : m);
  const task = secrets.length ? scrub(opts.task, secrets) : opts.task;
  const taskSha256 = createHash("sha256").update(opts.task, "utf8").digest("hex");
  const warnedWeakerRef = new Set<string>();
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i]!;
    const p = a.semantic_pairwise;
    if (p === undefined || opts.skip?.(i)) continue;
    const built = candidateDocument(ctx, a);
    ctx.semanticDocInfo.set(a, {
      evidenceCut: built.evidenceCut,
      healthNoteCut: built.healthNoteCut,
      overflowSection: built.overflowSection,
      skillResultsCut: built.skillResultsCut,
    });
    const refusal = semanticRefusal(a, ctx, ctx.semanticDocInfo.get(a));
    if (refusal) {
      ctx.semanticRefused.set(a, refusal);
      continue;
    }
    // Recorded whether or not a judge reads it: a run whose every comparison is neutral (the reference's own
    // variant) still has to prove, when frozen later, that the recomposed document is the one it produced.
    (ctx.composedDocs ??= new Map()).set(a, built.fingerprint);
    if (!p.rubric?.length)
      say(
        `::warning:: [semantic_pairwise] assert ${i} has no rubric — the judge weighs overall quality for the task; concrete criteria grade more reliably\n`,
      );
    // The rubric leaves for the judge exactly as the documents do, so it is scrubbed with the same set — and a claim
    // that NAMED a secret is said to be redacted, by index only (the semantic_matches contract).
    const rubric = p.rubric && secrets.length ? p.rubric.map((c) => scrub(c, secrets)) : p.rubric;
    const redacted = (p.rubric ?? []).flatMap((c, k) => (rubric && c !== rubric[k] ? [k] : []));
    if (redacted.length)
      say(
        `::warning:: [semantic_pairwise] rubric criterion ${redacted.length === 1 ? "index" : "indexes"} ${redacted.join(",")} contained a ` +
          `scrubbed secret value and ${redacted.length === 1 ? "was" : "were"} sent to the judge redacted.\n`,
      );
    const key = pairwiseComposeKey(a, ctx.lane);
    const outcomes: Outcome[] = [];
    let warnedSelfJudge = false;
    let cost: number | undefined;
    let usage: TokenUsage | undefined;
    let model: string | undefined;
    let judged = false;
    let retries = 0;
    for (const ref of opts.refsFor(a)) {
      const gate = opts.gateRefs === undefined || opts.gateRefs.has(ref.name);
      const tag = gate ? {} : { gate: false as const };
      if (opts.onlyRefs) {
        // A fill never re-judges an outcome the live run has: only a missing one is compared.
        const kept = opts.copyOutcome?.(i, ref.name);
        if (kept) {
          outcomes.push({ ...kept, copied: true });
          continue;
        }
        if (!opts.onlyRefs.has(ref.name)) {
          outcomes.push({ ref: ref.name, ...tag, status: "missing", why: "the live run recorded no outcome to keep" });
          continue;
        }
      }
      if (opts.neutralRefs?.has(ref.name)) {
        outcomes.push({ ref: ref.name, ...tag, status: "neutral", value: 0.5 });
        continue;
      }
      const got = readRefDoc(ref.store, opts.caseId, key);
      if (got.status !== "ok") {
        outcomes.push({ ref: ref.name, ...tag, status: got.status, why: got.why });
        continue;
      }
      if (got.taskSha256 !== taskSha256) {
        outcomes.push({ ref: ref.name, ...tag, status: "missing", why: "frozen for a different task (the scenario's prompt changed)" });
        continue;
      }
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
        // A metric-only comparison cannot change the verdict: losing it costs that column, not the attempt.
        if (!gate) {
          outcomes.push({ ref: ref.name, ...tag, status: "invalid", why: "the deadline passed before this comparison" });
          continue;
        }
        ctx.deadlinePassed = true;
        break;
      }
      const resolved = opts.modelFor(a);
      if (!warnedSelfJudge && opts.mainModels?.some((m) => sameModelKey(m) === sameModelKey(resolved))) {
        warnedSelfJudge = true;
        say(
          `::warning:: [semantic_pairwise] assert ${i}: the judge model ${resolved} is also the model under test — a model judging its own ` +
            `kind of output is a known bias; pin a different judge_model.\n`,
        );
      }
      // The stored reference is scrubbed with THIS set before the judge reads it, as the candidate was: a value the
      // reference was frozen with unscrubbed (a smaller set at freeze time) never reaches the judge, and the two
      // outputs carry the same redactions. Its integrity and identity (`refDocSha256`) stay the stored bytes'.
      const reference = secrets.length ? scrub(got.text, secrets) : got.text;
      const refRedactions = markers(reference) - markers(got.text);
      if (got.scrubCount !== undefined && distinct(secrets) > got.scrubCount && !warnedWeakerRef.has(ref.name)) {
        warnedWeakerRef.add(ref.name);
        say(
          `::notice:: [semantic_pairwise] reference ${ref.name} was frozen with a smaller scrub set than this process's; it is scrubbed ` +
            `with this process's set before the judge reads it (ref_scrub_weaker).\n`,
        );
      }
      try {
        const r = await opts.judgeFor(resolved)({
          task,
          rubric,
          candidate: built.candidate,
          reference,
          sessionId: opts.sessionId,
          assertIndex: i,
          refName: ref.name,
          order: p.order ?? "random",
        });
        judged = true;
        retries += r.retries ?? 0;
        cost = addCost(cost, r.costUsd);
        usage = addTokenUsage(usage, r.usage);
        model = r.model;
        const rationale = r.rationale !== undefined ? finalizeRationale(r.rationale, secrets) : undefined;
        outcomes.push({
          ref: ref.name,
          ...tag,
          status: "graded",
          outcome: r.outcome,
          value: r.value,
          order: r.order,
          ...(r.positionFlip ? { positionFlip: true } : {}),
          ...(r.orders ? { orders: r.orders } : {}),
          ...(rationale !== undefined ? { rationale } : {}),
          refDocSha256: got.sha256,
          refRedactions,
          refSentSha256: createHash("sha256").update(reference, "utf8").digest("hex"),
          ...(got.unchecked ? { unchecked: true } : {}),
        });
      } catch (e) {
        if (!(e instanceof PairwiseJudgeInvalid)) throw e;
        judged = true;
        retries += e.retries;
        cost = addCost(cost, e.costUsd);
        usage = addTokenUsage(usage, e.usage);
        model = e.model ?? model;
        // The message can quote the judge's reply, which can quote either output: scrubbed before it is stored or warned.
        const why = scrub(e.message.split("\n")[0]!, secrets);
        if (!gate) {
          // A metric-only reference: this comparison is lost, the verdict is not.
          outcomes.push({
            ref: ref.name,
            ...tag,
            status: "invalid",
            why,
            refDocSha256: got.sha256,
            refSentSha256: createHash("sha256").update(reference, "utf8").digest("hex"),
          });
          say(
            `::warning:: semantic_pairwise grade vs ${ref.name} invalid after retry (a metric-only reference; the verdict stands): ${why}\n`,
          );
          continue;
        }
        ctx.judgeInvalid.add(a);
        say(`::warning:: semantic_pairwise grade invalid after retry (rep counts as invalid, not passed): ${why}\n`);
        break;
      }
    }
    // Past the deadline the assert has no result at all ("judge not run"), never a partial set of comparisons — but
    // what the comparisons already made spent is still recorded.
    if (ctx.deadlinePassed) {
      if (judged) {
        if (cost !== undefined) ctx.judgeCosts.set(a, cost);
        if (usage !== undefined) ctx.judgeUsages.set(a, usage);
        ctx.judgeModels.set(a, model ?? "unknown");
        ctx.judgeAttempts.set(a, 1 + retries);
      }
      break;
    }
    ctx.pairwiseResults.set(a, outcomes);
    if (!judged) continue;
    ctx.judgeAttempts.set(a, 1 + retries);
    ctx.judgedDocs.set(a, built.fingerprint);
    ctx.judgePromptHashes.set(a, PAIRWISE_PROMPT_HASH);
    ctx.judgeModels.set(a, model ?? "unknown");
    if (opts.transport) (ctx.judgeTransports ??= new Map()).set(a, opts.transport());
    if (cost !== undefined) ctx.judgeCosts.set(a, cost);
    if (usage !== undefined) ctx.judgeUsages.set(a, usage);
  }
}

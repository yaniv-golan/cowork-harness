// LIVE-ONLY async pre-pass for `semantic_pairwise`: compare each such assert's judged document with its frozen
// references, before the synchronous `evaluate()`, which only reads the stored outcomes (the same split as
// `runSemanticJudges`). The candidate document is the one `semantic_matches` would grade — one composer — and an
// assert whose evidence is unavailable refuses before any judge call, with the same typed reasons.

import { COMPOSER_ID, composeJudgedDocument, judgedOpts, semanticRefusal, type AssertContext } from "../assert.js";
import { finalizeRationale } from "../decide/semantic-judge.js";
import { PAIRWISE_PROMPT_HASH, PairwiseJudgeInvalid, type PairwiseJudge } from "../decide/pairwise-judge.js";
import { addCost, addTokenUsage } from "../decide/usage.js";
import { warn } from "../io.js";
import { scrub } from "../secrets.js";
import { composeKey, readRefDoc } from "../refs/store.js";
import { redactHostPaths } from "./host-path-tokens.js";
import type { Assertion, RunResult, TokenUsage } from "../types.js";

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
  /** A judge for a resolved model id. Called lazily, only when a comparison actually runs. */
  judgeFor: (model: string) => PairwiseJudge;
  modelFor: (a: Assertion) => string;
}

type Outcome = NonNullable<RunResult["assertions"][number]["pairwise"]>[number];

/** The composed candidate document for one assert, with the host-path transform every frozen reference received
 *  — applied to both sides, or `~/…` against `/Users/…` would tell the judge which output is the reference. */
export function candidateDocument(ctx: AssertContext, a: Assertion): ReturnType<typeof composeJudgedDocument> & { candidate: string } {
  const o = judgedOpts(a)!;
  const built = composeJudgedDocument(ctx, o.includeSubagentText, o.evidenceFiles, o.includeForkResults);
  return { ...built, candidate: redactHostPaths(built.doc).text };
}

/** The compose key a reference document for this assert is stored under. */
export function pairwiseComposeKey(a: Assertion): string {
  const o = judgedOpts(a)!;
  return composeKey(COMPOSER_ID, {
    includeSubagentText: o.includeSubagentText,
    includeForkResults: o.includeForkResults,
    evidenceFiles: o.evidenceFiles,
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
  ctx.semanticDocInfo ??= new Map();
  ctx.semanticRefused ??= new Map();
  const secrets = ctx.secrets ?? [];
  const task = secrets.length ? scrub(opts.task, secrets) : opts.task;
  for (let i = 0; i < assertions.length; i++) {
    const a = assertions[i]!;
    const p = a.semantic_pairwise;
    if (p === undefined) continue;
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
    if (!p.rubric?.length)
      warn(
        `::warning:: [semantic_pairwise] assert ${i} has no rubric — the judge weighs overall quality for the task; concrete criteria grade more reliably\n`,
      );
    const key = pairwiseComposeKey(a);
    const outcomes: Outcome[] = [];
    let cost: number | undefined;
    let usage: TokenUsage | undefined;
    let model: string | undefined;
    let judged = false;
    for (const ref of opts.refsFor(a)) {
      if (opts.neutralRefs?.has(ref.name)) {
        outcomes.push({ ref: ref.name, status: "neutral", value: 0.5 });
        continue;
      }
      const got = readRefDoc(ref.store, opts.caseId, key);
      if (got.status !== "ok") {
        outcomes.push({ ref: ref.name, status: got.status, why: got.why });
        continue;
      }
      const resolved = opts.modelFor(a);
      try {
        const r = await opts.judgeFor(resolved)({
          task,
          rubric: p.rubric,
          candidate: built.candidate,
          reference: got.text,
          sessionId: opts.sessionId,
          assertIndex: i,
          refName: ref.name,
          order: p.order ?? "random",
        });
        judged = true;
        cost = addCost(cost, r.costUsd);
        usage = addTokenUsage(usage, r.usage);
        model = r.model;
        const rationale = r.rationale !== undefined ? finalizeRationale(r.rationale, secrets) : undefined;
        outcomes.push({
          ref: ref.name,
          status: "graded",
          outcome: r.outcome,
          value: r.value,
          order: r.order,
          ...(r.positionFlip ? { positionFlip: true } : {}),
          ...(rationale !== undefined ? { rationale } : {}),
          refDocSha256: got.sha256,
        });
      } catch (e) {
        if (!(e instanceof PairwiseJudgeInvalid)) throw e;
        judged = true;
        cost = addCost(cost, e.costUsd);
        usage = addTokenUsage(usage, e.usage);
        model = e.model ?? model;
        ctx.judgeInvalid.add(a);
        warn(`::warning:: semantic_pairwise grade invalid after retry (rep counts as invalid, not passed): ${e.message.split("\n")[0]}\n`);
        break;
      }
    }
    ctx.pairwiseResults.set(a, outcomes);
    if (!judged) continue;
    ctx.judgedDocs.set(a, built.fingerprint);
    ctx.judgePromptHashes.set(a, PAIRWISE_PROMPT_HASH);
    ctx.judgeModels.set(a, model ?? "unknown");
    if (cost !== undefined) ctx.judgeCosts.set(a, cost);
    if (usage !== undefined) ctx.judgeUsages.set(a, usage);
  }
}

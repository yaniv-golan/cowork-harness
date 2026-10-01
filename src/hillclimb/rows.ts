// One attempt → one `results.jsonl` row or one `errors.jsonl` row, with the field names and failure classes
// runner-scaffold.mjs writes (S l.509-564) and the row contract of build-eval.md l.118 / eval-hillclimb.md
// l.170-183.
//
// Where an attempt goes, in order:
//   1. the runner's own wall-clock ceiling fired           → errors, `timeout`
//   2. infrastructure (classifyTermination errored_infra)   → errors, `error` (rule in meta)
//   3. positive served-model mismatch (S l.476-494)         → errors, `serving_substitution`
//   4. the agent's own failure (errored_agent)              → SCORED: every graded key 0, reason in meta
//   5. no model evidence on an otherwise-valid run (N5)     → errors, `serving_substitution`
//   6. a run built from another snapshot than the variant's → errors, `error` + meta.arm_source_drift
//   7. an invalid judge grade                               → errors, `judge_invalid` (promotable by regrade)
//   8. a grade that does not line up with the scenario      → errors, `error` (never a guessed value)
//   9. otherwise                                            → SCORED
// A served-model mismatch outranks an agent error (3 before 4): a score from the wrong model is not the
// skill's. No evidence (5) does not: a skill that crashes before its first model call must be scored, not
// excluded (classify.ts's rule).
//
// Grade values come from eval's `repRowValues` — one producer for both commands. Strings are NOT scrubbed
// here; the flow writer scrubs every byte it writes.

import { basename } from "node:path";
import type { Assertion, RunResult, TokenUsage } from "../types.js";
import { classifyRep, classifyTermination, repRowValues, scenarioRows, type ClassifiableResult } from "../eval/classify.js";
import { combineJudges } from "./judge-rollup.js";
import { caseKeyDecls, type MetricDecl } from "./grade-keys.js";
import { mainLoopModels, servedModelMismatch } from "./served-model.js";
import { resultEventFields } from "./result-event.js";
import { UNTRUSTED_JUDGE_PREFIX } from "./schema-check.js";
import { computeVerdict } from "../run/verdict.js";

export interface AttemptContext {
  caseId: string;
  /** The file stem when pathSafeId changed it (S's meta.original_id). */
  originalId?: string;
  scenarioName: string;
  /** The prompt as authored (the row's `prompt`; the report shows it). */
  prompt: string;
  /** The scenario's authored assertions — the frozen list every grade lines up against. */
  assertions: readonly Assertion[];
  metrics?: readonly MetricDecl[];
  rep: number;
  /** The concrete model the main loop must be served by. */
  pin?: string;
  /** The variant snapshot's content signature; a run whose fingerprint differs is not this variant. */
  expectedContentSig?: string;
  /** `events.jsonl` lines of the attempt's run dir (readers scope to the current turn). */
  events: readonly string[];
  /** Wall clock of the whole attempt, seconds. */
  attemptS: number;
  /** The runner's ceiling ended the attempt (not the scenario's own timeout_ms). */
  runnerTimeout: boolean;
  tags: string[];
  attachments?: Array<{ kind?: string; ref: string; alt?: string }>;
  skillInvoked?: boolean;
  meta: {
    flowHash: string;
    env: { harnessVersion: string; baselineId: string };
    runDir?: string;
    contentSig?: string;
    skillHash?: string;
    ablated?: boolean;
    nonDeterministic?: boolean;
  };
}

export interface Attempt {
  result?: RunResult;
  thrown?: unknown;
}

export type RowOut = { dest: "results"; row: Record<string, unknown> } | { dest: "errors"; row: Record<string, unknown> };

const snake = (e: Record<string, unknown> | undefined): TokenUsage | undefined => {
  if (!e) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: n(e.inputTokens),
    output_tokens: n(e.outputTokens),
    cache_read_input_tokens: n(e.cacheReadInputTokens),
    cache_creation_input_tokens: n(e.cacheCreationInputTokens),
  };
};

const authored = (r: RunResult | undefined) => (r?.assertions ?? []).filter((a) => a.source === undefined);

function judgeRetries(r: RunResult | undefined): { judge_retries: number; unrecorded: boolean } {
  let n = 0;
  let unrecorded = false;
  for (const a of authored(r)) {
    if (a.judgeModel === undefined) continue;
    const attempts = (a as { judgeAttempts?: number }).judgeAttempts;
    if (typeof attempts === "number") n += Math.max(0, attempts - 1);
    else unrecorded = true;
  }
  return { judge_retries: n, unrecorded };
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function attemptRow(a: Attempt, ctx: AttemptContext): RowOut {
  const r = a.result;
  const ev = resultEventFields(ctx.events);
  const mains = mainLoopModels(ctx.events);
  const model = mains[0];
  const usage = model ? snake(r?.modelUsage?.[model] as Record<string, unknown> | undefined) : undefined;
  const judges = combineJudges(authored(r));
  const jr = judgeRetries(r);
  const retries = r?.apiRetries?.count ?? 0;

  const errorRow = (failure_class: string, error: string, metaExtra: Record<string, unknown>): RowOut => ({
    dest: "errors",
    row: {
      prompt_id: ctx.caseId,
      rep: ctx.rep,
      ...(ctx.originalId !== undefined ? { original_id: ctx.originalId } : {}),
      failure_class,
      error,
      retries,
      judge_retries: jr.judge_retries,
      ...(model !== undefined ? { model } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(judges.judge_model !== undefined ? { judge_model: judges.judge_model } : {}),
      ...(judges.judge_usage !== undefined ? { judge_usage: judges.judge_usage } : {}),
      latency_s: ctx.attemptS, // the whole attempt, as S (l.563)
      meta: {
        ...(ctx.meta.runDir !== undefined ? { run_dir: ctx.meta.runDir } : {}),
        ...(typeof r?.cost?.usd === "number" ? { cost_usd: r.cost.usd } : {}),
        ...(jr.unrecorded ? { judge_retries_unrecorded: true } : {}),
        ...metaExtra,
      },
    },
  });

  // 1. The runner's ceiling.
  if (ctx.runnerTimeout) return errorRow("timeout", `exceeded the runner's wall-clock ceiling after ${ctx.attemptS}s`, {});

  // 2. Infrastructure, from the shared termination table.
  const evidence = { result: r as ClassifiableResult | undefined, thrown: a.thrown };
  const term = classifyTermination(evidence);
  if (term.bucket === "errored_infra") {
    const text = a.thrown !== undefined ? message(a.thrown) : `run ended ${r?.result ?? "without a result"} (${term.rule})`;
    return errorRow("error", text, { failure_rule: term.rule, ...(term.unclassified ? { unclassified: true } : {}) });
  }

  // 3. Positive served-model evidence.
  const substituted = servedModelMismatch(ctx.pin, mains);
  if (substituted !== undefined)
    return errorRow("serving_substitution", `served model ${substituted} != requested ${ctx.pin}`, { failure_rule: "served_model" });
  if (r?.modelPinHonored === false)
    return errorRow("serving_substitution", `the run fell off the requested model ${ctx.pin ?? ""}`.trim(), {
      failure_rule: "model_pin_not_honored",
    });

  const rep = classifyRep(evidence, ctx.expectedContentSig !== undefined ? { contentSig: ctx.expectedContentSig } : {});
  const agentFailed = rep.bucket === "errored_agent";
  if (!agentFailed) {
    // 5. No model evidence on a success-shaped run.
    if (rep.bucket === "model_mismatch")
      return errorRow("serving_substitution", "no evidence the requested model served this run", { failure_rule: "model_pin_unverified" });
    // 6. Another snapshot's run.
    if (rep.bucket === "arm_source_drift")
      return errorRow("error", "the run's skill content differs from this variant's snapshot", {
        failure_rule: "arm_source_drift",
        arm_source_drift: true,
      });
    // 7. Invalid judge grade.
    if (rep.bucket === "judge_invalid")
      return errorRow("judge_invalid", `judge grade invalid after retry on assertion(s) ${rep.judgeInvalidAssertions.join(", ")}`, {
        failure_rule: "judge_invalid",
      });
  }

  // Grades, from the shared row extractor.
  const rows = scenarioRows("", ctx.assertions);
  const values = repRowValues(rows, ctx.assertions, rep, r as ClassifiableResult | undefined);
  // `pass` is the run's verdict — the persisted one, else the one producer (computeVerdict), never a re-derivation.
  const passed = r === undefined ? false : (r.verdict?.pass ?? computeVerdict(r, "live").pass);
  const grade: Record<string, number> = { pass: !agentFailed && passed ? 1 : 0 };
  const claims: Record<string, string> = {};
  const explanation: Record<string, string> = {};
  const authoredGrades = authored(r);
  for (const v of values) {
    const i = v.row.assertionIndex;
    if (v.excluded !== undefined && v.excluded !== "evidence_unavailable")
      // 8. Never guess a value that does not line up.
      return errorRow("error", `grade for assertion ${i} could not be aligned with the scenario (${v.excluded})`, {
        failure_rule: "grade_alignment",
      });
    if (v.row.kind === "semantic_rollup") grade[`a${i}_present`] = v.excluded === "evidence_unavailable" ? 0 : 1;
    else if (v.row.kind === "assertion") grade[`a${i}`] = v.value!;
    else if (v.excluded === undefined) {
      const key = `a${i}_c${v.row.claimIndex}`;
      grade[key] = v.value!;
      const sc = authoredGrades[i]?.semanticClaims?.find((c) => c.index === v.row.claimIndex);
      if (sc) claims[key] = sc.claim;
      if (!agentFailed && sc?.rationale) explanation[key] = UNTRUSTED_JUDGE_PREFIX + sc.rationale;
    }
  }
  // claims: the pooled share of graded claims that passed (refused asserts are excluded — they have no claim
  // values). The explanation lists every graded claim, failed first, so a reader sees what cost the score.
  const gradedClaims = values.filter((v) => v.row.kind === "claim" && v.excluded === undefined);
  grade.claims_present = gradedClaims.length > 0 ? 1 : 0;
  if (gradedClaims.length > 0) {
    const passedN = gradedClaims.filter((v) => v.value === 1).length;
    grade.claims = passedN / gradedClaims.length;
    if (!agentFailed && Object.keys(explanation).length > 0) {
      const line = (v: (typeof gradedClaims)[number]) => {
        const key = `a${v.row.assertionIndex}_c${v.row.claimIndex}`;
        const why = explanation[key]?.slice(UNTRUSTED_JUDGE_PREFIX.length);
        return `${v.value === 1 ? "passed" : "FAILED"} ${key}: ${claims[key] ?? ""}${why ? ` — ${why}` : ""}`;
      };
      const ordered = [...gradedClaims.filter((v) => v.value !== 1), ...gradedClaims.filter((v) => v.value === 1)];
      explanation.claims = `${UNTRUSTED_JUDGE_PREFIX}${gradedClaims.length - passedN}/${gradedClaims.length} claims failed. ${ordered.map(line).join(" | ")}`;
    }
  }
  for (const m of ctx.metrics ?? []) {
    const got = (r as { metrics?: Array<{ id: string; value?: number }> } | undefined)?.metrics?.find((x) => x.id === m.id);
    const ok = !agentFailed && typeof got?.value === "number" && Number.isFinite(got.value);
    grade[`${m.id}_present`] = ok ? 1 : 0;
    if (ok) grade[m.id] = got!.value!;
  }
  // Order the keys as declared, so every row reads the same way.
  const ordered: Record<string, number> = {};
  for (const d of caseKeyDecls(ctx.assertions, ctx.metrics ?? [])) if (d.id in grade) ordered[d.id] = grade[d.id];

  const toolCalls = r?.toolCalls;
  const latencyBasisWall = ev.durationMs === undefined;
  const latency_s = latencyBasisWall ? ctx.attemptS : Math.max(0, (ev.durationMs! - (r?.apiRetries?.delayMs ?? 0)) / 1000);
  const models: Record<string, unknown> = {};
  for (const [m, e] of Object.entries(r?.modelUsage ?? {})) {
    const cost = (e as { costUSD?: unknown }).costUSD;
    models[m] = { ...snake(e as Record<string, unknown>), ...(typeof cost === "number" ? { cost_usd: cost } : {}) };
  }
  const hasExplanation = Object.keys(explanation).length > 0;
  const explanationOrdered: Record<string, string> = {};
  if ("claims" in explanation) explanationOrdered.claims = explanation.claims;
  for (const [k, v] of Object.entries(explanation)) if (k !== "claims") explanationOrdered[k] = v;
  const row: Record<string, unknown> = {
    prompt_id: ctx.caseId,
    rep: ctx.rep,
    prompt: ctx.prompt,
    tags: ctx.tags,
    ...(ctx.attachments?.length ? { attachments: ctx.attachments } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined
      ? {
          usage,
          in_tokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
          out_tokens: usage.output_tokens,
        }
      : {}),
    ...(ev.stopReason !== undefined ? { stop_reason: ev.stopReason } : {}),
    status: ev.stopReason === "max_tokens" ? "truncated" : "ok",
    ...(judges.judge_model !== undefined ? { judge_model: judges.judge_model } : {}),
    ...(judges.judge_usage !== undefined ? { judge_usage: judges.judge_usage } : {}),
    latency_s,
    ...(toolCalls !== undefined
      ? { tool_calls: toolCalls.length, web_searches: toolCalls.filter((t) => t.name === "WebSearch").length }
      : {}),
    ...(typeof r?.cost?.usd === "number" ? { cost_usd: r.cost.usd } : {}),
    ...(typeof r?.deciderCostUsd === "number" ? { decider_usd: r.deciderCostUsd } : {}),
    ...(ctx.skillInvoked !== undefined ? { skill_invoked: ctx.skillInvoked ? 1 : 0 } : {}),
    grade: ordered,
    ...(hasExplanation ? { explanation: explanationOrdered } : {}),
    meta: {
      scenario_name: ctx.scenarioName,
      ...(ctx.originalId !== undefined ? { original_id: ctx.originalId } : {}),
      ...(ctx.meta.runDir !== undefined ? { run_dir: ctx.meta.runDir, run_id: basename(ctx.meta.runDir) } : {}),
      ...(ev.sessionId !== undefined ? { session_id: ev.sessionId } : {}),
      env: { ...ctx.meta.env, ...(ev.agentVersion !== undefined ? { agentVersion: ev.agentVersion } : {}) },
      flow_hash: ctx.meta.flowHash,
      ...(ctx.meta.contentSig !== undefined ? { content_sig: ctx.meta.contentSig } : {}),
      ...(ctx.meta.skillHash !== undefined ? { skill_hash: ctx.meta.skillHash } : {}),
      retries,
      retry_delay_s: (r?.apiRetries?.delayMs ?? 0) / 1000,
      ...(r?.apiRetries ? { subagent_retries: r.apiRetries.subagentCount } : {}),
      wall_s: ctx.attemptS,
      ...(latencyBasisWall ? { latency_basis: "wall" } : {}),
      judge_retries: jr.judge_retries,
      ...(jr.unrecorded ? { judge_retries_unrecorded: true } : {}),
      ...(Object.keys(claims).length ? { claims } : {}),
      ...(hasExplanation ? { explanation_untrusted: true } : {}),
      ...(agentFailed ? { failure_class: "errored_agent", termination_rule: term.rule } : {}),
      ...(Object.keys(models).length ? { models } : {}),
      ...(judges.judge_models !== undefined ? { judge_models: judges.judge_models } : {}),
      ...(toolCalls !== undefined ? { web_fetches: toolCalls.filter((t) => t.name === "WebFetch").length } : {}),
      ...(ctx.meta.ablated ? { ablated: true } : {}),
      ...(ctx.meta.nonDeterministic ? { non_deterministic: true } : {}),
    },
  };
  return { dest: "results", row };
}

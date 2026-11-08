// Did a grader fail in a way that every later grade would fail too? `eval` and `hillclimb run` stop scheduling when
// one did: a rejected credential, an unknown model or a spent usage quota does not recover by running more jobs, and
// each further job is a paid agent run whose grade is lost.

import { failsEveryLaterCall } from "../decide/judge-call-error.js";
import { ApiExitError } from "../decide/llm-transport.js";
import type { RunResult } from "../types.js";

export interface GraderFailure {
  /** Which grader: a judge (a `semantic_matches` / `semantic_pairwise` call) or the LLM decider. */
  source: "judge" | "decider";
  /** The API status, when one was reported. */
  status?: number;
}

/** The first grader failure in one job that every later job would hit too, or undefined. Read from what the run
 *  persisted for its judges (`assertions[].judgeError`, a metric-only pairwise outcome's `callStatus`) and from what
 *  the job threw (the LLM decider's call is not caught inside the run, so its `ApiExitError` is the job's throw). A
 *  server error, a timeout, a plain rate limit and a malformed grade are never one. */
export function graderCredentialFailure(result: RunResult | undefined, thrown: unknown): GraderFailure | undefined {
  if (thrown instanceof ApiExitError && failsEveryLaterCall(thrown.status, thrown.retryable))
    return { source: "decider", ...(thrown.status !== undefined ? { status: thrown.status } : {}) };
  // Never throws: a result too malformed to read (its row builder fails on it) simply shows no grader failure.
  const assertions = Array.isArray(result?.assertions) ? result.assertions : [];
  for (const a of assertions) {
    const e = a?.judgeError;
    if (e && failsEveryLaterCall(e.status, e.retryable))
      return { source: "judge", ...(e.status !== undefined ? { status: e.status } : {}) };
    for (const o of Array.isArray(a?.pairwise) ? a.pairwise : [])
      if (o.status === "invalid" && failsEveryLaterCall(o.callStatus, o.callRetryable))
        return { source: "judge", ...(o.callStatus !== undefined ? { status: o.callStatus } : {}) };
  }
  return undefined;
}

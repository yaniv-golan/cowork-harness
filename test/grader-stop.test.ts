// `graderCredentialFailure`: the one reading of a finished job that stops `eval` and `hillclimb run` scheduling. Each
// channel it reads is tested on its own: a judged assert's `judgeError`, a metric-only `semantic_pairwise` comparison's
// `callStatus` / `callRetryable` (its verdict is not lost, so the assert carries no judgeError), and the LLM decider's
// thrown `ApiExitError`. Synthetic results only.
import { describe, it, expect } from "vitest";
import { graderCredentialFailure } from "../src/run/grader-stop.js";
import { ApiExitError } from "../src/decide/llm-transport.js";
import type { RunResult } from "../src/types.js";

const result = (assertion: Record<string, unknown>): RunResult => ({ assertions: [assertion] }) as unknown as RunResult;
const pairwise = (callStatus: number, callRetryable?: boolean) =>
  result({
    assertion: { semantic_pairwise: { rubric: ["r"] } },
    pass: true,
    pairwise: [
      { ref: "baseline", status: "ok" },
      { ref: "v1", status: "invalid", why: "judge call failed", callStatus, ...(callRetryable !== undefined ? { callRetryable } : {}) },
    ],
  });

describe("graderCredentialFailure", () => {
  it("a metric-only pairwise comparison whose call was refused (401) is a judge failure", () => {
    expect(graderCredentialFailure(pairwise(401), undefined)).toEqual({ source: "judge", status: 401 });
  });
  it("a pairwise 429 the API marked not retryable (a spent quota) is one; a retryable or unmarked 429 is not", () => {
    expect(graderCredentialFailure(pairwise(429, false), undefined)).toEqual({ source: "judge", status: 429 });
    expect(graderCredentialFailure(pairwise(429, true), undefined)).toBeUndefined();
    expect(graderCredentialFailure(pairwise(429), undefined)).toBeUndefined();
  });
  it("(control) a pairwise server error, or an invalid comparison with no call status, is not", () => {
    expect(graderCredentialFailure(pairwise(500), undefined)).toBeUndefined();
    const malformed = result({ assertion: {}, pass: true, pairwise: [{ ref: "v1", status: "invalid", why: "malformed" }] });
    expect(graderCredentialFailure(malformed, undefined)).toBeUndefined();
  });
  it("a judged assert's judgeError (403) is a judge failure", () => {
    const r = result({ assertion: {}, pass: false, judgeInvalid: true, judgeError: { kind: "call", status: 403, message: "API 403" } });
    expect(graderCredentialFailure(r, undefined)).toEqual({ source: "judge", status: 403 });
  });
  it("the LLM decider's thrown ApiExitError (401) is a decider failure; a 500 is not", () => {
    expect(graderCredentialFailure(undefined, new ApiExitError("API 401", 401, "first_party", "Invalid API key"))).toEqual({
      source: "decider",
      status: 401,
    });
    expect(graderCredentialFailure(undefined, new ApiExitError("API 500", 500, "first_party", "Overloaded"))).toBeUndefined();
  });
});

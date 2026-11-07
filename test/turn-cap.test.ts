// `allow_max_turns`: a run the session's own `agent_max_turns` cap stopped is a completed run, not a failure. One
// predicate (src/run/turn-cap.ts) is read by the verdict, the eval classifier and the `result` key's message; these
// cases pin each reader to it, and the edges the predicate draws.
//
// The results here are built by hand. Their producers: `errorSource: "result"` with a `resultErrorKind` is set by
// run.ts on an `is_error` result frame (classifyResultError; a transport-signature text is `transport`, not `agent`),
// `usage.turns` is the result frame's num_turns (run.ts), and `turnCap` is set by executeScenario from the launch
// plan's agentMaxTurns (execute.ts). test/turn-cap-e2e.test.ts drives the real stub → execute → result path.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeVerdict } from "../src/run/verdict.js";
import { classifyTermination, type ClassifiableResult } from "../src/eval/classify.js";
import { allowsMaxTurns, turnCapAllowed, turnCapReached } from "../src/run/turn-cap.js";
import { CASSETTE_VERSION, requiredVersionFor, V19_ASSERT_FEATURES } from "../src/run/cassette.js";
import { VERDICT_MODIFIER_KEYS, type Assertion, type RunResult } from "../src/types.js";
import { buildRunsLine, repEvidenceOf } from "../src/eval/runs.js";

const capped = (over: Partial<RunResult> = {}): RunResult => ({
  scenario: "t",
  fidelity: "protocol",
  baseline: "x",
  result: "error",
  errorSource: "result",
  resultErrorKind: "agent",
  resultSubtype: "error_max_turns",
  turnCap: { maxTurns: 2, source: "session" },
  usage: { turns: 2 },
  models: ["claude-sonnet-5"],
  cost: { usd: 0.01 },
  decisions: [],
  egress: [],
  assertions: [],
  outDir: "/tmp/x",
  ...over,
});
const allow = { assertion: { allow_max_turns: true } as Assertion, pass: true };
const resultSuccess = { assertion: { result: "success" } as Assertion, pass: false };

describe("turnCapReached: the cap the session set, reached, as an agent-reported error", () => {
  it("reached at the cap and past it", () => {
    expect(turnCapReached(capped())).toBe(true);
    expect(turnCapReached(capped({ usage: { turns: 3 } }))).toBe(true);
  });
  it("not below the cap, not without a cap, not without turns", () => {
    expect(turnCapReached(capped({ usage: { turns: 1 } }))).toBe(false);
    expect(turnCapReached(capped({ turnCap: undefined }))).toBe(false);
    expect(turnCapReached(capped({ usage: undefined }))).toBe(false);
  });
  it("fails closed on any end that is not the agent's own error result", () => {
    expect(turnCapReached(capped({ result: "success" }))).toBe(false);
    // A transport-signature text is classified `transport` by run.ts, so a dropped stream is never read as the cap.
    expect(turnCapReached(capped({ resultErrorKind: "transport" }))).toBe(false);
    expect(turnCapReached(capped({ resultErrorKind: "usage_limit" }))).toBe(false);
    expect(turnCapReached(capped({ errorSource: "timeout" }))).toBe(false);
    expect(turnCapReached(capped({ errorSource: "exit" }))).toBe(false);
  });
  it("a cap-stop subtype counts at the cap, error_during_execution included", () => {
    expect(turnCapReached(capped({ resultSubtype: "error_during_execution" }))).toBe(true);
    expect(turnCapReached(capped({ resultSubtype: "error_during_execution", usage: { turns: 1 } }))).toBe(false);
  });
  it("any other subtype, or none, is not the cap stopping the agent", () => {
    expect(turnCapReached(capped({ resultSubtype: "success" }))).toBe(false);
    expect(turnCapReached(capped({ resultSubtype: undefined }))).toBe(false);
    expect(turnCapReached(capped({ resultSubtype: "error_max_budget_usd" }))).toBe(false);
  });
  it("the agent's own sign-in, usage-limit or no-model end at the cap is not the cap, whatever its subtype", () => {
    const synthetic = { models: ["<synthetic>"], cost: { usd: 0 } };
    const auth = { ...synthetic, finalMessage: "Authentication required · Sign in again to continue" };
    expect(turnCapReached(capped(auth))).toBe(false);
    expect(turnCapReached(capped({ ...auth, resultSubtype: "error_during_execution" }))).toBe(false);
    expect(turnCapReached(capped({ ...synthetic, finalMessage: "Not logged in · Please run /login" }))).toBe(false);
    expect(
      turnCapReached(capped({ models: ["claude-sonnet-5", "<synthetic>"], finalMessage: "You've hit your usage limit · resets 3pm" })),
    ).toBe(false);
    expect(turnCapReached(capped({ ...synthetic, finalMessage: "anything" }))).toBe(false);
    // The same text from a live model alone is the skill's, so the cap still reads.
    expect(turnCapReached(capped({ finalMessage: "Authentication required · Sign in again to continue" }))).toBe(true);
  });
  it("the modifier is read alone or beside another key, as allow_stall is", () => {
    expect(allowsMaxTurns([allow])).toBe(true);
    expect(allowsMaxTurns([{ assertion: { result: "error", allow_max_turns: true } as Assertion }])).toBe(true);
    expect(allowsMaxTurns([resultSuccess])).toBe(false);
    expect(allowsMaxTurns(undefined)).toBe(false);
  });
});

describe("the verdict reads the predicate", () => {
  it("allowed: no result_error, the run passes", () => {
    const v = computeVerdict(capped({ assertions: [allow] }), "live");
    expect(v.signals.map((s) => s.code)).not.toContain("result_error");
    expect(v.pass).toBe(true);
  });
  it("not allowed: result_error names the cap and the scenario lane's spelling", () => {
    const v = computeVerdict(capped(), "live");
    const sig = v.signals.find((s) => s.code === "result_error")!;
    expect(v.pass).toBe(false);
    expect(sig.message).toContain("agent_max_turns: 2 cap was reached");
    expect(sig.message).toContain("assert allow_max_turns: true");
  });
  it("the modifier does not cover any other error: a non-cap error still fails with the plain message", () => {
    const v = computeVerdict(capped({ usage: { turns: 1 }, assertions: [allow] }), "live");
    expect(v.pass).toBe(false);
    expect(v.signals.find((s) => s.code === "result_error")!.message).toBe("run result was error");
  });
  it("`result: success` beside the modifier still fails through its own row, never through result_error", () => {
    const v = computeVerdict(capped({ assertions: [allow, resultSuccess] }), "live");
    expect(v.pass).toBe(false);
    expect(v.signals.map((s) => s.code)).toContain("assertion");
    expect(v.signals.map((s) => s.code)).not.toContain("result_error");
  });
  it("acts the same on replay", () => {
    expect(computeVerdict(capped({ assertions: [allow] }), "replay").pass).toBe(true);
  });
});

describe("the eval classifier reads the predicate", () => {
  const cr = (over: Partial<RunResult> = {}) => capped(over) as unknown as ClassifiableResult;
  it("allowed ⇒ valid, rule turn_cap_allowed", () => {
    expect(classifyTermination({ result: cr({ assertions: [allow] }) })).toMatchObject({ bucket: "valid", rule: "turn_cap_allowed" });
  });
  it("by design, a `result: success` row beside it does not move the bucket: the cap was the intended end", () => {
    expect(classifyTermination({ result: cr({ assertions: [allow, resultSuccess] }) }).rule).toBe("turn_cap_allowed");
  });
  it("error_during_execution at the cap ⇒ turn_cap_allowed; below the cap ⇒ errored_agent", () => {
    expect(classifyTermination({ result: cr({ resultSubtype: "error_during_execution", assertions: [allow] }) }).rule).toBe(
      "turn_cap_allowed",
    );
    expect(
      classifyTermination({ result: cr({ resultSubtype: "error_during_execution", usage: { turns: 1 }, assertions: [allow] }) }),
    ).toMatchObject({ bucket: "errored_agent", rule: "result_agent" });
  });
  it("no modifier, no cap, or a usage limit: unchanged", () => {
    expect(classifyTermination({ result: cr() })).toMatchObject({ bucket: "errored_agent", rule: "result_agent" });
    expect(classifyTermination({ result: cr({ turnCap: undefined, assertions: [allow] }) }).rule).toBe("result_agent");
    expect(classifyTermination({ result: cr({ resultErrorKind: "usage_limit", assertions: [allow] }) })).toMatchObject({
      bucket: "errored_infra",
    });
  });
  it("survives the runs.jsonl round trip (`eval report` re-reads it from disk)", () => {
    const line = JSON.parse(
      JSON.stringify(
        buildRunsLine({
          index: 0,
          arm: "A",
          scenario: "t",
          rep: 0,
          runId: "run-0",
          runDir: undefined,
          result: capped({ assertions: [allow] }),
          thrown: undefined,
          evidence: undefined,
        }),
      ),
    );
    expect(line.result.turnCap).toEqual({ maxTurns: 2, source: "session" });
    expect(classifyTermination(repEvidenceOf(line)).rule).toBe("turn_cap_allowed");
  });
});

describe("the modifier's surface", () => {
  it("is a verdict modifier (graded ok(), never a row)", () => {
    expect(VERDICT_MODIFIER_KEYS).toContain("allow_max_turns");
  });
  it("stamps v19; its absence stamps exactly what it did", () => {
    expect(CASSETTE_VERSION).toBe(19);
    expect(V19_ASSERT_FEATURES.some((f) => f({ allow_max_turns: true }))).toBe(true);
    const base = { prompt: "x", fidelity: "protocol" };
    expect(requiredVersionFor({ ...base, assert: [{ allow_max_turns: true }] })).toBe(19);
    expect(requiredVersionFor({ ...base, assert: [{ result: "error" }] })).toBe(requiredVersionFor(base));
  });
  it("the frozen turnCap and timeout stamp nothing on their own", () => {
    const base = { prompt: "x", fidelity: "protocol" };
    expect(requiredVersionFor(base, {})).toBe(requiredVersionFor(base));
  });
});

describe("one predicate: nothing in src re-derives the turn-cap condition", () => {
  it("only turn-cap.ts compares the turn count with the cap", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
      );
    const offenders = walk("src").filter((f) => {
      if (f.endsWith(join("run", "turn-cap.ts"))) return false;
      // A second copy of the condition: any line that compares something with `maxTurns`, however the other side is
      // spelled (`turns >= cap.maxTurns`, `(r.usage?.turns ?? 0) >= …maxTurns`, `cap.maxTurns <= n`). `=>` is not a
      // comparison.
      return readFileSync(f, "utf8")
        .split("\n")
        .some((line) => /maxTurns/.test(line) && /(?<![=!<>-])(?:[<>]=?)(?![=>])/.test(line.replace(/\/\/.*$/, "")));
    });
    expect(offenders).toEqual([]);
  });
});

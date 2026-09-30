// Per-rep classification for the paired evaluation: the termination decision table, bucket precedence,
// and per-rep row extraction.
//
// Fixture provenance (test/fixtures/eval-classify/): all eleven files are EXCERPTS of real kept run dirs. Nine
// are one per shape the local corpus exhibits — a clean run with a graded semantic_matches, a stalled-on-question run,
// an `exit`+`agent` crash, a `result`+`agent` error, a usage-limit result, a wall-clock timeout, a timeout
// that overrode an earlier `exit`+`agent` classification, a stream that ended with no terminal event, and an
// unanswered-gate partial. Only the fields the classifier reads were kept; every string inside an
// assertion was replaced by "<redacted>", rubric claims by "claim N", the unanswered-gate text by a
// placeholder, and the scenario name by `fixture-<shape>`. The corpus holds NO spawn failure, protocol
// break, `error_max_turns`, `decider_timeout` or recovered-then-succeeded run, so those rows are CONSTRUCTED
// below rather than read from a fixture. The tenth, `public-scenario-aligned`, is a run of the repo's own
// public e2e scenario kept with its assertions VERBATIM (the text is already public), so row alignment is
// tested against the scenario loader rather than against the result itself. `public-scenario-pinned` is a
// run of the public csv-metrics example, also verbatim, and the only fixture that carries every field the
// precedence reads (modelPinHonored: true, a contentSig) plus cost/turns/duration for the medians.
//
// Staleness, stated rather than patched: the timeout, no-result, exit-agent, result-agent, usage-limit and
// unanswered-partial excerpts carry NO modelPinHonored (those runs produced no live model evidence), and the
// kept corpus holds no newer timeout or no_result run that does (searched 2026-09-30: the five newest are
// 2026-08-25..30, all without it). Under the precedence that is harmless for an errored rep — an agent
// error ranks above model_mismatch — and the precedence tests below use these fixtures unpatched.
import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BoundaryError, DeciderTimeoutError, UnansweredError } from "../src/errors.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import { hostPathTokenOccurrences } from "../src/run/host-path-tokens.js";
import { loadScenarioPure } from "../src/run/execute.js";
import type { Assertion, RunResult } from "../src/types.js";
import { evaluateFamily, insufficientThreshold } from "../src/eval/stats.js";
import {
  ERROR_SOURCES,
  RESULT_ERROR_KINDS,
  KNOWN_RESULT_SUBTYPES,
  classifyTermination,
  classifyRep,
  normalizeClaim,
  scenarioRows,
  repRowValues,
  armMedians,
  type ClassifiableResult,
  type RepBucket,
  type TerminationBucket,
} from "../src/eval/classify.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
const fixture = (name: string): ClassifiableResult => JSON.parse(readFileSync(join(FX, `${name}.json`), "utf8")) as ClassifiableResult;

type ErrorSource = NonNullable<RunResult["errorSource"]>;
type ResultErrorKind = NonNullable<RunResult["resultErrorKind"]>;

// The only patched classification in this file is `public-scenario-aligned`'s (a success with no
// modelPinHonored, so it is model_mismatch by the rules); the loader test overrides its bucket to valid to
// test row ALIGNMENT, and says so.
//
// A Record over the type's literal union: adding an `errorSource` member to types.ts fails `npm run
// typecheck` here until it gets a row below, and the runtime loop then checks that row against the table.
const ERROR_ROWS: Record<ErrorSource, Record<ResultErrorKind | "-", string>> = {
  spawn: { "-": "errored_infra", transport: "errored_infra", agent: "errored_infra", usage_limit: "errored_infra" },
  protocol: { "-": "errored_infra", transport: "errored_infra", agent: "errored_infra", usage_limit: "errored_infra" },
  decider_timeout: { "-": "errored_infra", transport: "errored_infra", agent: "errored_infra", usage_limit: "errored_infra" },
  timeout: { "-": "errored_agent", transport: "errored_infra", agent: "errored_agent", usage_limit: "errored_infra" },
  no_result: { "-": "errored_agent", transport: "errored_infra", agent: "errored_agent", usage_limit: "errored_infra" },
  result: { "-": "unclassified", transport: "errored_infra", agent: "errored_agent", usage_limit: "errored_infra" },
  exit: { "-": "unclassified", transport: "errored_infra", agent: "errored_agent", usage_limit: "errored_infra" },
  // An `error` result whose first source was a non-fatal `agent` event: `errorSource ??= "agent"` survives
  // (run.ts), so an unanswered-gate partial, or a stream that then ends with no terminal event (the
  // `no_result` stamp only fires when no source is set), both persist exactly this shape with no kind. Both
  // are the agent's. A kind of `agent` here has no producer (every path that sets it also sets a fatal
  // source), so it stays unclassified.
  agent: { "-": "errored_agent", transport: "errored_infra", agent: "unclassified", usage_limit: "errored_infra" },
};

const expectBucket = (got: ReturnType<typeof classifyTermination>, want: string): void => {
  if (want === "unclassified") {
    expect(got).toMatchObject({ bucket: "errored_infra", unclassified: true });
  } else {
    expect(got).toMatchObject({ bucket: want as TerminationBucket, unclassified: false });
  }
};

describe("the literal unions the table is exhaustive over", () => {
  it("ERROR_SOURCES and RESULT_ERROR_KINDS list exactly the type's members", () => {
    expect([...ERROR_SOURCES].sort()).toEqual(Object.keys(ERROR_ROWS).sort());
    expect([...RESULT_ERROR_KINDS].sort()).toEqual(["agent", "transport", "usage_limit"]);
  });
  it("every (errorSource x resultErrorKind) cell of an error result has the bucket the table states", () => {
    for (const source of Object.keys(ERROR_ROWS) as ErrorSource[]) {
      for (const [kind, want] of Object.entries(ERROR_ROWS[source])) {
        const got = classifyTermination({
          result: { result: "error", errorSource: source, ...(kind === "-" ? {} : { resultErrorKind: kind as ResultErrorKind }) },
        });
        expectBucket(got, want);
      }
    }
  });
  it("the bucket never depends on resultSubtype (a free string): known and unknown subtypes land alike", () => {
    expect(KNOWN_RESULT_SUBTYPES).toEqual(
      expect.arrayContaining([
        "success",
        "error_max_turns",
        "error_during_execution",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
      ]),
    );
    for (const resultSubtype of [...KNOWN_RESULT_SUBTYPES, "error_shipped_next_month", undefined]) {
      expectBucket(
        classifyTermination({ result: { result: "error", errorSource: "result", resultErrorKind: "agent", resultSubtype } }),
        "errored_agent",
      );
      expectBucket(classifyTermination({ result: { result: "success", resultSubtype } }), "valid");
    }
  });
  it("an error result with no errorSource is an unanswered partial when it says so, and unclassified otherwise", () => {
    expectBucket(classifyTermination({ result: { result: "error", partial: true } }), "errored_agent");
    expectBucket(classifyTermination({ result: { result: "error", unansweredGate: { message: "m" } } }), "errored_agent");
    expectBucket(classifyTermination({ result: { result: "error" } }), "unclassified");
    expectBucket(classifyTermination({ result: { result: "error", resultErrorKind: "agent" } }), "unclassified");
    expectBucket(classifyTermination({ result: { result: "error", resultErrorKind: "transport" } }), "errored_infra");
    expectBucket(classifyTermination({ result: { result: "error", resultErrorKind: "usage_limit", partial: true } }), "errored_infra");
  });
  it("an unanswered partial or a no-terminal-event end AFTER a non-fatal agent error is the agent's", () => {
    // execute.ts's partial builder copies the record's errorSource with resultErrorKind undefined.
    expectBucket(
      classifyTermination({ result: { result: "error", errorSource: "agent", partial: true, unansweredGate: { message: "m" } } }),
      "errored_agent",
    );
    expectBucket(classifyTermination({ result: { result: "error", errorSource: "agent" } }), "errored_agent");
  });
  it("a decider_timeout partial is infrastructure, not an unanswered gate", () => {
    expectBucket(
      classifyTermination({ result: { result: "error", errorSource: "decider_timeout", partial: true, unansweredGate: { message: "m" } } }),
      "errored_infra",
    );
  });
  it("success rows: clean, recovered from a non-fatal agent error, stalled, and the shapes no producer emits", () => {
    expectBucket(classifyTermination({ result: { result: "success" } }), "valid");
    expectBucket(classifyTermination({ result: { result: "success", errorSource: "agent" } }), "valid");
    expectBucket(classifyTermination({ result: { result: "success", stalledOnQuestion: true } }), "errored_agent");
    expectBucket(classifyTermination({ result: { result: "success", errorSource: "agent", stalledOnQuestion: true } }), "errored_agent");
    for (const source of ERROR_SOURCES.filter((s) => s !== "agent")) {
      expectBucket(classifyTermination({ result: { result: "success", errorSource: source } }), "unclassified");
    }
    for (const kind of RESULT_ERROR_KINDS) {
      expectBucket(classifyTermination({ result: { result: "success", resultErrorKind: kind } }), "unclassified");
    }
  });
  it("stalledOnQuestion does not rescue or change an error result", () => {
    expectBucket(
      classifyTermination({ result: { result: "error", errorSource: "spawn", resultErrorKind: "agent", stalledOnQuestion: true } }),
      "errored_infra",
    );
  });
  it("flags an exit-after-crash as ambiguous (an OOM-killed binary and a skill-caused crash look alike)", () => {
    expect(classifyTermination({ result: { result: "error", errorSource: "exit", resultErrorKind: "agent" } }).ambiguousExit).toBe(true);
    expect(classifyTermination({ result: { result: "error", errorSource: "result", resultErrorKind: "agent" } }).ambiguousExit).toBe(false);
  });
});

describe("thrown errors", () => {
  const err = fixture("unanswered-partial");
  it("a thrown BoundaryError is infrastructure", () => {
    expectBucket(classifyTermination({ thrown: new BoundaryError("would mount EMPTY") }), "errored_infra");
  });
  it("a thrown UnansweredError is the agent's (with or without the salvaged result)", () => {
    expectBucket(classifyTermination({ thrown: new UnansweredError("no rule", "hint") }), "errored_agent");
    expectBucket(classifyTermination({ thrown: new UnansweredError("no rule", "hint"), result: err }), "errored_agent");
  });
  it("a DeciderTimeoutError is checked before its UnansweredError superclass", () => {
    expectBucket(classifyTermination({ thrown: new DeciderTimeoutError("slow", "hint", "decider-cmd") }), "errored_infra");
    expectBucket(classifyTermination({ thrown: new DeciderTimeoutError("slow", "hint", "decider-dir"), result: err }), "errored_infra");
  });
  it("any other thrown value, or no evidence at all, is unclassified infrastructure", () => {
    expectBucket(classifyTermination({ thrown: new Error("boom") }), "unclassified");
    expectBucket(classifyTermination({ thrown: "a string" }), "unclassified");
    expectBucket(classifyTermination({}), "unclassified");
  });
});

describe("real kept run shapes (sanitized excerpts)", () => {
  const cases: Array<[string, string]> = [
    ["success-semantic", "valid"],
    ["stalled-on-question", "errored_agent"],
    ["exit-agent", "errored_agent"],
    ["result-agent", "errored_agent"],
    ["usage-limit", "errored_infra"],
    ["timeout", "errored_agent"],
    ["timeout-after-agent-error", "errored_agent"],
    ["no-result", "errored_agent"],
    ["unanswered-partial", "errored_agent"],
    ["public-scenario-aligned", "valid"],
    ["public-scenario-pinned", "valid"],
  ];
  for (const [name, want] of cases) {
    it(`${name} -> ${want}`, () => {
      expectBucket(classifyTermination({ result: fixture(name) }), want);
    });
  }
  it("every fixture file is covered above", () => {
    const files = readdirSync(FX)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(files).toEqual(cases.map(([n]) => n).sort());
  });
  it("fixtures carry no host path, username or secret (the repo is public)", () => {
    for (const f of readdirSync(FX)) {
      const text = readFileSync(join(FX, f), "utf8");
      expect(hostPathTokenOccurrences(text), f).toEqual([]);
      expect(text, f).not.toMatch(/\/Users\/|\/home\/|\/private\/|\\Users\\|sk-ant-|yaniv/i);
    }
  });
});

describe("constructed shapes the corpus does not hold", () => {
  it("spawn failure (classifyResultError returns `agent` for it) is infrastructure", () => {
    expectBucket(
      classifyTermination({ result: { result: "error", errorSource: "spawn", resultErrorKind: "agent", models: [] } }),
      "errored_infra",
    );
  });
  it("protocol break is infrastructure", () => {
    expectBucket(classifyTermination({ result: { result: "error", errorSource: "protocol", resultErrorKind: "agent" } }), "errored_infra");
  });
  it("error_max_turns is the agent's", () => {
    expectBucket(
      classifyTermination({
        result: { result: "error", errorSource: "result", resultErrorKind: "agent", resultSubtype: "error_max_turns" },
      }),
      "errored_agent",
    );
  });
  it("a transport drop after a clean result is infrastructure", () => {
    expectBucket(classifyTermination({ result: { result: "error", errorSource: "exit", resultErrorKind: "transport" } }), "errored_infra");
  });
});

// ---- bucket precedence -------------------------------------------------------------------------------------

const SIG = "sig-A";
const semAssertion: Assertion = { semantic_matches: { rubric: ["Names the  Owner.", "cites a source"], min_pass: 1 } } as Assertion;
const plainAssertion: Assertion = { result: "success" } as Assertion;

function validRep(over: Partial<ClassifiableResult> = {}): ClassifiableResult {
  return {
    result: "success",
    modelPinHonored: true,
    fingerprint: { contentSig: SIG },
    assertions: [
      { assertion: plainAssertion, pass: true },
      {
        assertion: semAssertion,
        pass: true,
        judgePromptHash: JUDGE_PROMPT_HASH,
        semanticClaims: [
          { index: 0, claim: "Names the  Owner.", pass: true },
          { index: 1, claim: "cites a source", pass: false },
        ],
      },
    ],
    ...over,
  };
}
const expected = { contentSig: SIG, judgePromptHash: JUDGE_PROMPT_HASH };

describe("classifyRep precedence: infra > agent > drift > prompt > model > judge_invalid > valid", () => {
  it("a clean rep is valid", () => {
    expect(classifyRep({ result: validRep() }, expected).bucket).toBe("valid");
  });
  it("infra beats every later bucket", () => {
    const r = validRep({
      result: "error",
      errorSource: "spawn",
      resultErrorKind: "agent",
      modelPinHonored: undefined,
      fingerprint: { contentSig: "other" },
    });
    expect(classifyRep({ result: r }, expected).bucket).toBe("errored_infra");
  });
  it("an agent error beats drift, prompt and model mismatch (it is scored 0, not excluded)", () => {
    const r = validRep({ result: "error", errorSource: "timeout", fingerprint: { contentSig: "other" }, modelPinHonored: false });
    expect(classifyRep({ result: r }, { ...expected, judgePromptHash: "0000000000000000" }).bucket).toBe("errored_agent");
  });
  it("an agent-errored rep with NO model evidence is errored_agent, not model_mismatch", () => {
    const crash = validRep({ result: "error", errorSource: "result", resultErrorKind: "agent", models: [], modelPinHonored: undefined });
    expect(classifyRep({ result: crash }, expected).bucket).toBe("errored_agent");
  });
  it("a thrown UnansweredError with no result reaches errored_agent", () => {
    expect(classifyRep({ thrown: new UnansweredError("no rule", "hint") }, expected).bucket).toBe("errored_agent");
  });
  it("arm_source_drift needs an OBSERVED sig that differs; a missing sig is not drift", () => {
    expect(classifyRep({ result: validRep({ fingerprint: { contentSig: "other" } }) }, expected).bucket).toBe("arm_source_drift");
    expect(classifyRep({ result: validRep({ fingerprint: undefined }) }, expected).bucket).toBe("valid");
    expect(classifyRep({ result: validRep({ fingerprint: {} }) }, expected).bucket).toBe("valid");
  });
  it("drift beats prompt mismatch, which beats model mismatch", () => {
    const r = validRep({ fingerprint: { contentSig: "other" }, modelPinHonored: false });
    expect(classifyRep({ result: r }, { ...expected, judgePromptHash: "0000000000000000" }).bucket).toBe("arm_source_drift");
    expect(classifyRep({ result: validRep({ modelPinHonored: false }) }, { ...expected, judgePromptHash: "0000000000000000" }).bucket).toBe(
      "judge_prompt_mismatch",
    );
  });
  it("model_mismatch on modelPinHonored false; on undefined only for a success-shaped rep", () => {
    expect(classifyRep({ result: validRep({ modelPinHonored: false }) }, expected).bucket).toBe("model_mismatch");
    expect(classifyRep({ result: validRep({ modelPinHonored: undefined }) }, expected).bucket).toBe("model_mismatch");
  });
  it("judge_prompt_mismatch needs an OBSERVED hash that differs; a missing hash is not a mismatch", () => {
    expect(classifyRep({ result: validRep() }, { ...expected, judgePromptHash: "0000000000000000" }).bucket).toBe("judge_prompt_mismatch");
    const noHash = validRep();
    delete noHash.assertions![1].judgePromptHash;
    expect(classifyRep({ result: noHash }, expected).bucket).toBe("valid");
  });
  it("an agent error beats judge_invalid", () => {
    const agentErrInvalid = validRep({ result: "error", errorSource: "timeout" });
    agentErrInvalid.assertions![1].judgeInvalid = true;
    expect(classifyRep({ result: agentErrInvalid }, expected).bucket).toBe("errored_agent");
  });
  it("judge_invalid is per assertion and beats valid", () => {
    const r = validRep();
    r.assertions![1].judgeInvalid = true;
    const c = classifyRep({ result: r }, expected);
    expect(c.bucket).toBe("judge_invalid");
    expect(c.judgeInvalidAssertions).toEqual([1]);
  });
  it("carries the termination classification (errorSource, unclassified, ambiguousExit) for the header histogram", () => {
    const c = classifyRep({ result: validRep({ result: "error", errorSource: "exit", resultErrorKind: "agent" }) }, expected);
    expect(c.bucket).toBe("errored_agent");
    expect(c.termination).toMatchObject({ errorSource: "exit", ambiguousExit: true, unclassified: false });
  });
});

describe("classifyRep over the real fixtures, unpatched", () => {
  const pinned = fixture("public-scenario-pinned");
  const pinnedSig = { contentSig: pinned.fingerprint!.contentSig };
  const cases: Array<[string, RepBucket]> = [
    ["public-scenario-pinned", "valid"],
    ["success-semantic", "valid"],
    ["public-scenario-aligned", "model_mismatch"], // success with no model evidence
    ["result-agent", "errored_agent"], // models ["<synthetic>"], no modelPinHonored
    ["exit-agent", "errored_agent"],
    ["timeout", "errored_agent"],
    ["timeout-after-agent-error", "errored_agent"],
    ["no-result", "errored_agent"],
    ["unanswered-partial", "errored_agent"],
    ["stalled-on-question", "errored_agent"],
    ["usage-limit", "errored_infra"],
  ];
  for (const [name, want] of cases) {
    it(`${name} -> ${want} (with an arm sig that the rep does not match)`, () => {
      expect(classifyRep({ result: fixture(name) }, { contentSig: "not-this-arm" }).bucket).toBe(
        want === "valid" ? "arm_source_drift" : want,
      );
    });
  }
  it("the pinned public run is valid against its own arm sig, and drift against another", () => {
    expect(classifyRep({ result: pinned }, pinnedSig).bucket).toBe("valid");
    expect(classifyRep({ result: pinned }, { contentSig: "0".repeat(64) }).bucket).toBe("arm_source_drift");
  });
  it("result-agent really has no live model evidence", () => {
    expect(fixture("result-agent").models).toEqual(["<synthetic>"]);
  });
});

describe("first-turn crashes are scored, not excluded", () => {
  it("5 of 10 B reps crash with models: [] -> each counts 0, and the row is a possible drop (p = 21/646)", () => {
    const scen = [plainAssertion];
    const rows = scenarioRows("s", scen);
    const ok = (): ClassifiableResult => ({
      result: "success",
      modelPinHonored: true,
      fingerprint: { contentSig: SIG },
      assertions: [{ assertion: plainAssertion, pass: true }],
    });
    const crash = (): ClassifiableResult => ({
      result: "error",
      errorSource: "result",
      resultErrorKind: "agent",
      models: [],
      assertions: [],
    });
    const tally = (reps: ClassifiableResult[]) => {
      const vals = reps.flatMap((r) => repRowValues(rows, scen, classifyRep({ result: r }, { contentSig: SIG }), r));
      expect(vals.every((v) => v.excluded === undefined)).toBe(true);
      return { k: vals.filter((v) => v.value === 1).length, n: vals.length };
    };
    const a = tally(Array.from({ length: 10 }, ok));
    const b = tally([...Array.from({ length: 5 }, ok), ...Array.from({ length: 5 }, crash)]);
    expect([a, b]).toEqual([
      { k: 10, n: 10 },
      { k: 5, n: 10 },
    ]);
    // Four other rows at 10/10 both arms make m = 5: adjusted 5 * 21/646 = 0.1625 > q, so `possible`.
    const fam = evaluateFamily(
      [
        { id: "r", k1: a.k, n1: a.n, k2: b.k, n2: b.n },
        ...Array.from({ length: 4 }, (_, i) => ({ id: `f${i}`, k1: 10, n1: 10, k2: 10, n2: 10 })),
      ],
      { correction: "bh", q: 0.1, alpha: 0.05, threshold: insufficientThreshold(10, false) },
    );
    expect(fam.rows[0].p).toBeCloseTo(21 / 646, 12);
    expect(fam.rows[0].label).toBe("possible drop");
  });
});

// ---- rows --------------------------------------------------------------------------------------------------

describe("normalizeClaim", () => {
  it("trims, collapses whitespace, lowercases and NFC-normalizes", () => {
    expect(normalizeClaim("  Names the\t\n Owner.  ")).toBe("names the owner.");
    expect(normalizeClaim("Café")).toBe(normalizeClaim("Café"));
  });
});

describe("scenarioRows: every assertion is a row, each claim a sub-row", () => {
  const allRows = () => scenarioRows("s1", [plainAssertion, semAssertion, semAssertion]);
  it("keys assertion rows by (scenario, index) and labels them with firstAssertionKey", () => {
    const rows = allRows();
    const assertionRows = rows.filter((r) => r.kind !== "claim");
    expect(assertionRows.map((r) => [r.assertionIndex, r.label, r.kind])).toEqual([
      [0, "result", "assertion"],
      [1, "semantic_matches", "semantic_rollup"],
      [2, "semantic_matches", "semantic_rollup"],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length); // two semantic asserts do not collide
  });
  it("keys claim sub-rows by (scenario, assertion index, normalized claim text)", () => {
    const claims = allRows().filter((r) => r.kind === "claim");
    expect(claims).toHaveLength(4);
    expect(claims[0]).toMatchObject({ scenario: "s1", assertionIndex: 1, claimIndex: 0, claim: "names the owner." });
    expect(claims[0].id).toBe(JSON.stringify(["s1", 1, "names the owner."]));
  });
  it("refuses a rubric whose claims collide after normalization", () => {
    const dup = { semantic_matches: { rubric: ["A claim", "a  CLAIM"] } } as Assertion;
    expect(() => scenarioRows("s1", [dup])).toThrow(/duplicate/i);
  });
});

describe("repRowValues", () => {
  const assertions = [plainAssertion, semAssertion];
  let rows: ReturnType<typeof scenarioRows>;
  beforeEach(() => {
    rows = scenarioRows("s1", assertions);
  });
  const byLabel = (vals: ReturnType<typeof repRowValues>) =>
    Object.fromEntries(vals.map((v) => [v.row.kind === "claim" ? v.row.claim : v.row.label, v.value ?? `x:${v.excluded}`]));

  it("a valid rep contributes each row's pass bit", () => {
    const r = validRep();
    expect(byLabel(repRowValues(rows, assertions, classifyRep({ result: r }, expected), r))).toEqual({
      result: 1,
      semantic_matches: 1,
      "names the owner.": 1,
      "cites a source": 0,
    });
  });
  it("errored_agent is 0 on every row, even rows the rep's partial grade passed", () => {
    const r = validRep({ result: "error", errorSource: "timeout" });
    const vals = repRowValues(rows, assertions, classifyRep({ result: r }, expected), r);
    expect(vals.map((v) => v.value)).toEqual([0, 0, 0, 0]);
  });
  it("errored_agent with no assertions at all (an unanswered partial) is still 0 on every row", () => {
    const r = fixture("unanswered-partial");
    const c = classifyRep({ result: r }, {});
    expect(c.bucket).toBe("errored_agent");
    expect(repRowValues(rows, assertions, c, r).map((v) => v.value)).toEqual([0, 0, 0, 0]);
  });
  it("judge_invalid removes only that assertion's rows", () => {
    const r = validRep();
    r.assertions![1].judgeInvalid = true;
    expect(byLabel(repRowValues(rows, assertions, classifyRep({ result: r }, expected), r))).toEqual({
      result: 1,
      semantic_matches: "x:judge_invalid",
      "names the owner.": "x:judge_invalid",
      "cites a source": "x:judge_invalid",
    });
  });
  for (const bucket of ["errored_infra", "arm_source_drift", "model_mismatch", "judge_prompt_mismatch"] as const) {
    it(`${bucket} excludes the rep from every row`, () => {
      const r = validRep();
      const c = { ...classifyRep({ result: r }, expected), bucket };
      expect(repRowValues(rows, assertions, c, r).map((v) => v.excluded)).toEqual(Array(4).fill(bucket));
    });
  }
  it("a valid rep whose semantic assert carries no claim grades excludes the claim rows, keeps the rollup", () => {
    const r = validRep();
    delete r.assertions![1].semanticClaims;
    expect(byLabel(repRowValues(rows, assertions, classifyRep({ result: r }, expected), r))).toEqual({
      result: 1,
      semantic_matches: 1,
      "names the owner.": "x:claims_missing",
      "cites a source": "x:claims_missing",
    });
  });
  it("a grade that does not line up with the frozen scenario is excluded, never guessed", () => {
    const r = validRep();
    r.assertions![0] = { assertion: { tool_called: "Write" } as Assertion, pass: true };
    const vals = byLabel(repRowValues(rows, assertions, classifyRep({ result: r }, expected), r));
    expect(vals.result).toBe("x:grade_misaligned");
    const short = validRep();
    short.assertions = short.assertions!.slice(0, 1);
    expect(byLabel(repRowValues(rows, assertions, classifyRep({ result: short }, expected), short)).semantic_matches).toBe(
      "x:grade_missing",
    );
  });
  it("harness-injected pseudo-assertions are skipped when aligning", () => {
    const r = validRep();
    r.assertions = [{ assertion: { result: "success" } as Assertion, pass: false, source: "staleness" }, ...r.assertions!];
    expect(byLabel(repRowValues(rows, assertions, classifyRep({ result: r }, expected), r)).result).toBe(1);
  });
  it("a real result lines up with its scenario as loaded through the real scenario loader", () => {
    // Independent oracle: the frozen assertions come from the public YAML via `loadScenarioPure`, not from
    // the result. If the Zod-parsed scenario ever stopped JSON-equalling the persisted assertion, every valid
    // rep would be `grade_misaligned` and every row insufficient.
    const scen = loadScenarioPure(join(import.meta.dirname, "..", "e2e", "scenarios", "smoke-semantic-evidence-files.yaml"));
    const r = fixture("public-scenario-aligned");
    // PATCHED: this success carries no modelPinHonored, so by the rules it is model_mismatch (tested above);
    // the bucket is overridden here to test row alignment alone. The unpatched case is the next test.
    const c = { ...classifyRep({ result: r }, {}), bucket: "valid" as const };
    const vals = repRowValues(scenarioRows(scen.name, scen.assert ?? []), scen.assert ?? [], c, r);
    expect(vals).toHaveLength(6);
    expect(vals.map((v) => v.excluded)).toEqual(Array(6).fill(undefined));
    expect(vals.map((v) => v.value)).toEqual([1, 1, 1, 1, 1, 1]);
  });
  it("a pinned real run lines up with its loaded scenario, unpatched", () => {
    const scen = loadScenarioPure(join(import.meta.dirname, "..", "examples", "scenarios", "csv-metrics.yaml"));
    const r = fixture("public-scenario-pinned");
    const c = classifyRep({ result: r }, { contentSig: r.fingerprint!.contentSig });
    expect(c.bucket).toBe("valid");
    const vals = repRowValues(scenarioRows(scen.name, scen.assert ?? []), scen.assert ?? [], c, r);
    expect(vals.map((v) => v.value)).toEqual(Array(scen.assert!.length).fill(1));
  });
  it("reads the real semantic fixture's claim grades", () => {
    const r = fixture("success-semantic");
    const scen = r.assertions!.map((a) => a.assertion);
    const frows = scenarioRows(r.scenario ?? "x", scen);
    const vals = repRowValues(frows, scen, classifyRep({ result: r }, {}), r);
    const claims = vals.filter((v) => v.row.kind === "claim");
    expect(claims).toHaveLength(5);
    expect(claims.every((v) => v.value === 0 || v.value === 1)).toBe(true);
    expect(vals.filter((v) => v.row.kind !== "claim").map((v) => v.value)).toEqual([1, 1, 1, 1]);
  });
});

describe("armMedians — descriptive, over valid + judge_invalid + errored_agent reps", () => {
  const rep = (bucket: RepBucket, over: Partial<ClassifiableResult>) => ({ bucket, result: { result: "success" as const, ...over } });
  it("medians each metric over the eligible reps that carry it, with the count it covers", () => {
    const m = armMedians([
      rep("valid", {
        cost: { usd: 1 },
        usage: { turns: 3 },
        durationMs: 100,
        assertions: [{ assertion: semAssertion, pass: true, judgeCostUsd: 0.1 }],
      }),
      rep("errored_agent", { cost: { usd: 3 }, usage: { turns: 9 }, durationMs: 300 }),
      rep("judge_invalid", {
        cost: { usd: 2 },
        durationMs: 200,
        assertions: [
          { assertion: semAssertion, pass: false, judgeCostUsd: 0.2 },
          { assertion: semAssertion, pass: true, judgeCostUsd: 0.1 },
        ],
      }),
      rep("errored_infra", { cost: { usd: 99 }, usage: { turns: 99 }, durationMs: 9999 }),
      rep("model_mismatch", { cost: { usd: 99 } }),
    ]);
    expect(m.eligibleReps).toBe(3);
    expect(m.costUsd).toEqual({ median: 2, n: 3 });
    expect(m.turns).toEqual({ median: 6, n: 2 }); // even count: mean of the middle two
    expect(m.durationMs).toEqual({ median: 200, n: 3 });
    expect(m.judgeCostUsd.n).toBe(2); // the errored rep has no priced judge call: unpriced is not $0
    expect(m.judgeCostUsd.median).toBeCloseTo(0.2, 12); // median of 0.1 and 0.3
  });
  it("a metric no eligible rep carries has no median", () => {
    expect(armMedians([rep("valid", {})]).costUsd).toEqual({ median: undefined, n: 0 });
    expect(armMedians([]).eligibleReps).toBe(0);
  });
  it("reads the real pinned fixture's telemetry", () => {
    const m = armMedians([{ bucket: "valid", result: fixture("public-scenario-pinned") }]);
    expect(m).toMatchObject({ costUsd: { median: 0.216095, n: 1 }, turns: { median: 7, n: 1 }, durationMs: { median: 23472, n: 1 } });
  });
});

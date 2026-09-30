import { describe, it, expect, vi, afterEach } from "vitest";
import { makeSemanticJudge, JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import type { Complete } from "../src/decide/decider.js";
import { evaluate, runSemanticJudges, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { collectSecrets, scrub } from "../src/secrets.js";
import { classifyRep, repRowValues, scenarioRows, type ClassifiableResult } from "../src/eval/classify.js";
import type { Assertion } from "../src/types.js";

// The `semantic_matches` RUBRIC leaves the process for the judge model exactly like the judged document
// does, so it must be scrubbed with the SAME secret set. Everything downstream of the call (claim text,
// index alignment, the prompt-hash provenance) must be what it would have been without the scrub.

const SECRET = "sk-ant-rubric-SECRET-0123456789";

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    ...over,
  };
}

/** The production secret set, shaped exactly as `collectSecrets()` builds it (literal + encodings). */
function secretsFor(value: string): string[] {
  vi.stubEnv("COWORK_HARNESS_SCRUB_VALUES", value);
  return collectSecrets();
}

/** A recording judge that echoes the claims it was SENT, by index (the real judge's contract). */
function recorder(opts: { throwFirst?: boolean } = {}): SemanticJudge & { calls: Array<{ rubric: string[]; answer: string }> } {
  const calls: Array<{ rubric: string[]; answer: string }> = [];
  const j = (async (rubric: string[], answer: string) => {
    calls.push({ rubric, answer });
    if (opts.throwFirst && calls.length === 1) throw new Error("malformed grade");
    return rubric.map((claim, index) => ({ index, claim, pass: index % 2 === 0 }));
  }) as SemanticJudge & { calls: typeof calls };
  j.calls = calls;
  j.promptHash = JUDGE_PROMPT_HASH;
  return j;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Capture everything written to stderr (where `warn()` goes) while `fn` runs. */
async function stderrOf(fn: () => Promise<void>): Promise<string> {
  let out = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
    out += String(c);
    return true;
  }) as typeof process.stderr.write);
  await fn();
  return out;
}

describe("semantic_matches rubric — scrubbed before it reaches the judge", () => {
  it("a secret in a rubric claim (any collectSecrets() encoding) never reaches the judge", async () => {
    const secrets = secretsFor(SECRET);
    const b64 = Buffer.from(SECRET).toString("base64");
    const a: Assertion = {
      semantic_matches: {
        rubric: [`the report does not contain ${SECRET}`, "the report has a summary", `no base64 form ${b64} either`],
      },
    };
    const j = recorder();
    await runSemanticJudges([a], ctx({ finalMessage: "a summary", secrets }), j);
    expect(j.calls).toHaveLength(1);
    const sent = JSON.stringify(j.calls[0]);
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain(b64);
    expect(j.calls[0].rubric).toEqual([
      "the report does not contain [REDACTED]",
      "the report has a summary",
      "no base64 form [REDACTED] either",
    ]);
    // The scenario's own assertion object is NOT mutated (it is the Map key and is echoed into result.json).
    expect(a.semantic_matches!.rubric[0]).toBe(`the report does not contain ${SECRET}`);
  });

  it("the filled prompt of the REAL judge carries no secret from the rubric", async () => {
    const secrets = secretsFor(SECRET);
    const prompts: string[] = [];
    const complete: Complete = async (prompt) => {
      prompts.push(prompt);
      return {
        text: '{"results":[{"index":0,"rationale":"ok","pass":true},{"index":1,"rationale":"ok","pass":false}]}',
        model: "claude-test",
      };
    };
    const a: Assertion = { semantic_matches: { rubric: [`must not print ${SECRET}`, "has a title"] } };
    const c = ctx({ finalMessage: "title", secrets });
    await runSemanticJudges([a], c, makeSemanticJudge({ complete }));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(SECRET);
    expect(prompts[0]).toContain("0. must not print [REDACTED]");
  });

  it("a rubric with no secret in it is passed through byte-identical (the same array)", async () => {
    const secrets = secretsFor(SECRET);
    const rubric = ["alpha", "beta"];
    const a: Assertion = { semantic_matches: { rubric } };
    const j = recorder();
    await runSemanticJudges([a], ctx({ finalMessage: "alpha", secrets }), j);
    expect(j.calls[0].rubric).toBe(rubric);
  });

  it("claim→result mapping stays index-aligned and carries the ORIGINAL claim text", async () => {
    const secrets = secretsFor(SECRET);
    const rubric = ["first", `second mentions ${SECRET}`, "third"];
    const a: Assertion = { semantic_matches: { rubric, min_pass: 1 } };
    const c = ctx({ finalMessage: "x", secrets });
    await runSemanticJudges([a], c, recorder());
    // Same in-memory result as an unscrubbed grade: the downstream (whole-file scrub on persist) is unchanged.
    expect(c.semanticResults!.get(a)).toEqual([
      { index: 0, claim: "first", pass: true },
      { index: 1, claim: `second mentions ${SECRET}`, pass: false },
      { index: 2, claim: "third", pass: true },
    ]);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(true);
    expect(r.semanticClaims!.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it("a judge that returns its own claim text keeps it for claims the scrub did not change", async () => {
    const secrets = secretsFor(SECRET);
    const a: Assertion = { semantic_matches: { rubric: ["plain", `has ${SECRET}`] } };
    const j: SemanticJudge = async (rubric) => rubric.map((_c, index) => ({ index, claim: `reworded ${index}`, pass: true }));
    const c = ctx({ secrets });
    await runSemanticJudges([a], c, j);
    expect(c.semanticResults!.get(a)!.map((x) => x.claim)).toEqual(["reworded 0", `has ${SECRET}`]);
  });

  it("the prompt-hash provenance is identical with and without a secret in the rubric", async () => {
    const secrets = secretsFor(SECRET);
    const withSecret: Assertion = { semantic_matches: { rubric: [`contains ${SECRET}`] } };
    const without: Assertion = { semantic_matches: { rubric: ["contains nothing"] } };
    const c = ctx({ secrets });
    await runSemanticJudges([withSecret, without], c, recorder());
    expect(c.judgePromptHashes!.get(withSecret)).toBe(JUDGE_PROMPT_HASH);
    expect(c.judgePromptHashes!.get(without)).toBe(JUDGE_PROMPT_HASH);
  });

  it("the retry attempt is sent the scrubbed rubric too", async () => {
    const secrets = secretsFor(SECRET);
    const a: Assertion = { semantic_matches: { rubric: [`contains ${SECRET}`] } };
    const j = recorder({ throwFirst: true });
    const c = ctx({ secrets });
    await runSemanticJudges([a], c, j);
    expect(j.calls).toHaveLength(2);
    for (const call of j.calls) expect(call.rubric).toEqual(["contains [REDACTED]"]);
    expect(c.semanticResults!.get(a)).toEqual([{ index: 0, claim: `contains ${SECRET}`, pass: true }]);
  });

  it("a per-assert judge_model override judge also receives the scrubbed rubric", async () => {
    const secrets = secretsFor(SECRET);
    const a: Assertion = { semantic_matches: { rubric: [`contains ${SECRET}`], judge_model: "claude-x" } };
    const override = recorder();
    await runSemanticJudges([a], ctx({ secrets }), recorder(), () => override);
    expect(override.calls[0].rubric).toEqual(["contains [REDACTED]"]);
  });

  it("warns once per assert, naming the redacted claim indexes and never the secret", async () => {
    const secrets = secretsFor(SECRET);
    const a: Assertion = { semantic_matches: { rubric: ["plain", `must not contain ${SECRET}`, `nor ${SECRET}`] } };
    const err = await stderrOf(() => runSemanticJudges([a], ctx({ secrets }), recorder()));
    const lines = err.split("\n").filter((l) => l.includes("[semantic_matches]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^::warning:: \[semantic_matches\] rubric claim indexes 1,2 /);
    expect(lines[0]).toMatch(/cannot be graded for that value/);
    expect(lines[0]).toContain("transcript_not_contains");
    expect(lines[0]).toContain("artifact_text");
    expect(err).not.toContain(SECRET);
  });

  it("an unchanged rubric emits no warning", async () => {
    const secrets = secretsFor(SECRET);
    const a: Assertion = { semantic_matches: { rubric: ["alpha", "beta"] } };
    const err = await stderrOf(() => runSemanticJudges([a], ctx({ secrets }), recorder()));
    expect(err).not.toContain("[semantic_matches]");
  });

  it("eval's per-claim rows line up with a restored claim (in-memory result), by index and text", async () => {
    const secrets = secretsFor(SECRET);
    const a: Assertion = { semantic_matches: { rubric: ["first", `second mentions ${SECRET}`], min_pass: 1 } };
    const c = ctx({ secrets });
    await runSemanticJudges([a], c, recorder());
    const r: ClassifiableResult = { result: "success", assertions: evaluate([a], c) };
    const rows = scenarioRows("s", [a]);
    const vals = repRowValues(rows, [a], { ...classifyRep({ result: r }, {}), bucket: "valid" as const }, r);
    expect(vals.map((v) => [v.row.kind, v.row.claimIndex, v.value, v.excluded])).toEqual([
      ["semantic_rollup", undefined, 1, undefined],
      ["claim", 0, 1, undefined],
      ["claim", 1, 0, undefined],
    ]);
    // The PERSISTED result.json is scrubbed whole on write, so its assertion no longer equals the frozen
    // scenario's and eval excludes the grade as misaligned. That predates the rubric scrub (the whole-file
    // scrub already did this) and is pinned here so the behaviour is known, not inferred.
    const persisted = JSON.parse(scrub(JSON.stringify(r), secrets)) as ClassifiableResult;
    const pv = repRowValues(rows, [a], { ...classifyRep({ result: persisted }, {}), bucket: "valid" as const }, persisted);
    expect(pv.every((v) => v.excluded === "grade_misaligned")).toBe(true);
  });
});

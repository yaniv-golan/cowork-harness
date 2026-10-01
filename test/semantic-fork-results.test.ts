import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeJudgedDocument,
  evaluate,
  joinSkillResults,
  runSemanticJudges,
  toolResultEvidence,
  type AssertContext,
  type SemanticJudge,
} from "../src/assert.js";
import { Assertion as AssertionSchema, SKILL_RESULT_ASSERT_CAP, type Assertion, type RunResult } from "../src/types.js";
import { repRowValues, semanticRefusalReason } from "../src/eval/classify.js";

// `semantic_matches.include_fork_results` — a `context: fork` skill's answer comes back as the `Skill` tool
// result, which is neither transcript text nor a sub-agent dispatch, so the judge never saw it. The key joins
// each main-agent Skill call to its result BY toolUseId and appends the result; a result the judge would see
// only in part (capture-capped) or not at all (unpaired) refuses the verdict with a typed reason.

const here = dirname(fileURLToPath(import.meta.url));
/** Synthesized from a real kept fork run's SHAPE — see its `_provenance`. */
const realShape = JSON.parse(readFileSync(join(here, "fixtures/fork-skill-result/result-shape.json"), "utf8")) as {
  finalMessage: string;
  toolCalls: NonNullable<RunResult["toolCalls"]>;
  toolResults: NonNullable<RunResult["toolResults"]>;
};

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

/** A judge double that records what it was handed and passes a claim iff the document contains it. */
function capturing(): { judge: SemanticJudge; received: string[] } {
  const received: string[] = [];
  const judge: SemanticJudge = async (rubric, answer) => {
    received.push(answer);
    return rubric.map((claim, index) => ({ index, claim, pass: answer.includes(claim) }));
  };
  return { judge, received };
}

const forkText = (skill: string, answer: string): string => `Skill "${skill}" completed (forked execution).\n\nResult:\n${answer}`;
const call = (id: string | undefined, skill: string, origin: "main" | "subagent" | "unknown" = "main") => ({
  ...(id !== undefined ? { toolUseId: id } : {}),
  name: "Skill",
  input: { skill: { text: skill } },
  origin,
});
const res = (id: string, text: string, assertTextTruncated?: boolean) => ({
  toolUseId: id,
  isError: false,
  text,
  ...(assertTextTruncated ? { assertTextTruncated } : {}),
});
const withForks = (rubric: string[]): Assertion => ({ semantic_matches: { rubric, include_fork_results: true } });

describe("semantic_matches.include_fork_results — schema", () => {
  it("parses as an optional boolean under the strict semantic_matches object", () => {
    expect(AssertionSchema.safeParse({ semantic_matches: { rubric: ["x"], include_fork_results: true } }).success).toBe(true);
    expect(AssertionSchema.safeParse({ semantic_matches: { rubric: ["x"], include_fork_results: "yes" } }).success).toBe(false);
  });
});

describe("semantic_matches.include_fork_results — the join", () => {
  it("joins by toolUseId, not by position: two calls whose results arrive in the OPPOSITE order each get their own answer", async () => {
    const { judge, received } = capturing();
    const a = withForks(["ALPHA-ANSWER", "BETA-ANSWER"]);
    const c = ctx({
      toolCalls: [call("t1", "plug:alpha"), call("t2", "plug:beta")],
      toolResults: [res("t2", forkText("plug:beta", "BETA-ANSWER")), res("t1", forkText("plug:alpha", "ALPHA-ANSWER"))],
    });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(true);
    const doc = received[0]!;
    // Each heading is followed by ITS OWN skill's answer — the positional pairing would swap them.
    expect(doc).toMatch(/## Fork skill result: plug:alpha\nSkill "plug:alpha" completed \(forked execution\)\.\n\nResult:\nALPHA-ANSWER/);
    expect(doc).toMatch(/## Fork skill result: plug:beta\nSkill "plug:beta" completed \(forked execution\)\.\n\nResult:\nBETA-ANSWER/);
    expect(r.judgedDoc?.sections.map((s) => s.kind)).toEqual(["transcript", "skill_result", "skill_result"]);
    expect(r.semanticEvidence).toEqual({ reason: "graded", paths: [] });
    expect(r.evidence).toMatch(/graded Skill results: plug:alpha, plug:beta/);
  });

  it("ignores Skill calls that did not run in the main agent (a Skill inside a sub-agent is not the run's answer)", () => {
    const j = joinSkillResults(
      ctx({
        toolCalls: [call("t1", "plug:inner", "subagent"), call("t2", "plug:outer")],
        toolResults: [res("t2", forkText("plug:outer", "x"))],
      }),
    );
    expect(j.joined.map((x) => x.skill)).toEqual(["plug:outer"]);
    expect(j.unpaired).toEqual([]);
  });

  it("labels an inline skill's result honestly — included, but never headed as a fork answer", () => {
    const { doc } = composeJudgedDocument(
      ctx({ toolCalls: [call("t1", "plug:inline")], toolResults: [res("t1", "Launching skill: plug:inline")] }),
      false,
      undefined,
      true,
    );
    expect(doc).toContain("## Skill result: plug:inline\nLaunching skill: plug:inline");
    expect(doc).not.toContain("Fork skill result");
  });

  it("scrubs secrets from a skill result before it leaves for the judge", () => {
    const { doc } = composeJudgedDocument(
      ctx({ secrets: ["TOKEN-XYZ"], toolCalls: [call("t1", "plug:a")], toolResults: [res("t1", forkText("plug:a", "leaks TOKEN-XYZ"))] }),
      false,
      undefined,
      true,
    );
    expect(doc).not.toContain("TOKEN-XYZ");
  });
});

describe("semantic_matches.include_fork_results — refusals are typed, never a grade", () => {
  it("a Skill result cut at its capture cap → evidence-unavailable, fork_result_truncated, even when every claim would pass", async () => {
    const { judge } = capturing();
    const a = withForks(["HEAD"]);
    const c = ctx({ toolCalls: [call("t1", "plug:big")], toolResults: [res("t1", forkText("plug:big", "HEAD …"), true)] });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable: include_fork_results/);
    expect(r.message).toMatch(
      /cut at the tool-result capture cap \(plug:big; a top-level Skill result is captured up to 32768 chars, and a record with no assertText keeps only the 500-char display text\)/,
    );
    expect(r.semanticEvidence).toEqual({ reason: "fork_result_truncated", paths: ["plug:big"] });
  });

  it("a display-fallback result (assertText absent on an old record) counts as truncated — via the real toolResultEvidence mapping", async () => {
    const { judge } = capturing();
    const a = withForks(["HEAD"]);
    const c = ctx({
      toolCalls: [call("t1", "plug:old")],
      toolResults: [toolResultEvidence({ toolUseId: "t1", isError: false, text: forkText("plug:old", "HEAD") })],
    });
    await runSemanticJudges([a], c, judge);
    expect(evaluate([a], c)[0].semanticEvidence?.reason).toBe("fork_result_truncated");
  });

  it("a Skill call with no paired result → fork_result_unpaired (a missing answer outranks a cut one)", async () => {
    const { judge } = capturing();
    const a = withForks(["x"]);
    const c = ctx({
      transcript: "x",
      toolCalls: [call("t1", "plug:gone"), call("t2", "plug:cut"), call(undefined, "plug:noid")],
      toolResults: [res("t2", forkText("plug:cut", "x"), true)],
    });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(false);
    expect(r.semanticEvidence).toEqual({ reason: "fork_result_unpaired", paths: ["plug:gone", "plug:noid"] });
    expect(r.message).toMatch(/2 Skill call\(s\) with NO paired result/);
    expect(r.message).toMatch(/1 Skill result\(s\) cut/); // both gaps named in ONE report
  });

  it("no tool-call record on the lane (an older result.json) → fork_calls_unrecorded, not a green over an empty section list", async () => {
    const { judge } = capturing();
    const a = withForks(["x"]);
    const c = ctx({ transcript: "x", toolCalls: undefined, toolResults: [] });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(false);
    expect(r.semanticEvidence).toEqual({ reason: "fork_calls_unrecorded" });
  });

  it("a Skill result the aggregate document cap cut → fork_result_truncated, naming ONLY the cut skills, once each", async () => {
    const { judge } = capturing();
    // final 32K + transcript 128K + five 16K sub-agents ≈ 240K: a short early skill result still fits under
    // the 256K aggregate cap, the 20K one after it does not (called twice — listed once).
    const c = ctx({
      transcript: "x".repeat(128 * 1024),
      finalMessage: "y".repeat(32 * 1024),
      subagents: Array.from({ length: 5 }, (_, i) => ({
        description: `w${i}`,
        reasoning: [{ kind: "text" as const, text: "z".repeat(16 * 1024) }],
      })) as AssertContext["subagents"],
      toolCalls: [call("t0", "plug:early"), call("t1", "plug:late"), call("t2", "plug:late")],
      toolResults: [
        res("t0", forkText("plug:early", "x")),
        res("t1", forkText("plug:late", "q".repeat(20 * 1024))),
        res("t2", forkText("plug:late", "q".repeat(20 * 1024))),
      ],
    });
    const aSub: Assertion = { semantic_matches: { rubric: ["x"], include_fork_results: true, include_subagent_text: true } };
    await runSemanticJudges([aSub], c, judge);
    const r = evaluate([aSub], c)[0];
    expect(r.semanticEvidence).toEqual({ reason: "fork_result_truncated", paths: ["plug:late"] });
    expect(r.message).toMatch(/Skill result section\(s\) of plug:late were cut/);
  });

  it("a fork launched in the BACKGROUND → fork_result_background, never a grade over the launch line", async () => {
    const { judge, received } = capturing();
    // A rubric the launch line would FAIL — grading it would be a silent false red.
    const a = withForks(["the answer names three lanes"]);
    const c = ctx({
      transcript: "",
      toolCalls: [call("t1", "plug:bg")],
      toolResults: [res("t1", 'Skill "plug:bg" launched (forked execution, running in the background).')],
    });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable: include_fork_results/);
    expect(r.message).toMatch(
      /ran in the BACKGROUND \(plug:bg\) — the tool result is only the launch line and the fork's answer is not in it/,
    );
    expect(r.semanticEvidence).toEqual({ reason: "fork_result_background", paths: ["plug:bg"] });
    // The judge is never CALLED: a per-claim grade over the launch line would otherwise reach
    // `semanticClaims`, which eval counts per claim even when the assert refuses.
    expect(received).toHaveLength(0);
    expect(r.semanticClaims).toBeUndefined();
    expect(r.judgedDoc).toBeUndefined();
  });
});

describe("semantic_matches.include_fork_results — inert when unset or when there is nothing to join", () => {
  const withSkill = (): AssertContext =>
    ctx({
      transcript: "alpha",
      finalMessage: "final alpha",
      toolCalls: [call("t1", "plug:a")],
      toolResults: [res("t1", forkText("plug:a", "fork says alpha"))],
    });

  it("key OFF: the judged document and its fingerprint are byte-identical to the same run with no Skill record at all", () => {
    const on = withSkill();
    const off = { ...withSkill(), toolCalls: undefined, toolResults: undefined };
    const a = composeJudgedDocument(on, false, undefined);
    const b = composeJudgedDocument(off, false, undefined);
    expect(a).toEqual(b); // doc, fingerprint, every flag — and no new key on the returned object
    expect(Object.keys(a).sort()).toEqual(["doc", "evidenceCut", "fingerprint", "healthNoteCut", "overflowSection"]);
    expect(composeJudgedDocument(on, false, undefined, false)).toEqual(a); // explicit false = omitted
  });

  it("key OFF: an existing rubric's verdict, message and evidence are unchanged by a present Skill result", async () => {
    const run = async (c: AssertContext) => {
      const { judge } = capturing();
      const a: Assertion = { semantic_matches: { rubric: ["alpha"] } };
      await runSemanticJudges([a], c, judge);
      return evaluate([a], c)[0];
    };
    const r1 = await run(withSkill());
    const r2 = await run({ ...withSkill(), toolCalls: undefined, toolResults: undefined });
    expect(r1).toEqual(r2);
    expect(r1.semanticEvidence).toEqual({ reason: "graded", paths: [] });
  });

  it("key ON with no Skill call: no skill section, the same document and verdict as key OFF", async () => {
    const c = ctx({ transcript: "alpha", toolCalls: [], toolResults: [] });
    expect(composeJudgedDocument(c, false, undefined, true)).toEqual(composeJudgedDocument(c, false, undefined, false));
    const { judge } = capturing();
    const a = withForks(["alpha"]);
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(true);
    expect(r.semanticEvidence).toEqual({ reason: "graded", paths: [] });
    expect(r.evidence).toMatch(/graded Skill results: \(none — no Skill call\)/);
  });

  it("two asserts differing ONLY in include_fork_results get different documents (the pre-pass cache is keyed on it)", async () => {
    const { judge, received } = capturing();
    const plain: Assertion = { semantic_matches: { rubric: ["fork says"] } };
    const forks = withForks(["fork says"]);
    const c = withSkill();
    await runSemanticJudges([plain, forks], c, judge);
    const [r1, r2] = evaluate([plain, forks], c);
    expect(received[0]).not.toContain("fork says");
    expect(received[1]).toContain("fork says");
    expect(r1.pass).toBe(false);
    expect(r2.pass).toBe(true);
  });
});

describe("semantic_matches.include_fork_results — the real fork run's shape", () => {
  // The run's Skill call is FIRST in toolCalls and its result is LAST in toolResults (its seven children
  // resolve before it returns), and two of those children's Read results are cut at the 10 KB cap.
  const c = (): AssertContext =>
    ctx({
      transcript: realShape.finalMessage,
      finalMessage: realShape.finalMessage,
      toolCalls: realShape.toolCalls,
      toolResults: realShape.toolResults.map(toolResultEvidence),
    });

  it("grades the fork's WHOLE answer (head and tail) — the capped child results do not refuse it", async () => {
    const { judge, received } = capturing();
    const a = withForks(["FORK-ANSWER-HEAD-SENTINEL", "FORK-ANSWER-TAIL-SENTINEL"]);
    const ctx1 = c();
    await runSemanticJudges([a], ctx1, judge);
    const r = evaluate([a], ctx1)[0];
    expect(r.pass).toBe(true);
    expect(r.semanticEvidence).toEqual({ reason: "graded", paths: [] });
    const skillSections = r.judgedDoc!.sections.filter((s) => s.kind === "skill_result");
    expect(skillSections).toHaveLength(1);
    expect(received[0]).toContain("## Fork skill result: claude-code-internals:claude-code-internals\n");
    // A positional pairing would have attached the FIRST result (a child ToolSearch's) to the Skill call.
    expect(received[0]).not.toContain("placeholder child tool output");
  });

  it("without the key, the same run's judge never sees the fork's answer", async () => {
    const { judge, received } = capturing();
    const a: Assertion = { semantic_matches: { rubric: ["FORK-ANSWER-TAIL-SENTINEL"] } };
    const ctx1 = c();
    await runSemanticJudges([a], ctx1, judge);
    expect(evaluate([a], ctx1)[0].pass).toBe(false);
    expect(received[0]).not.toContain("FORK-ANSWER");
  });

  it("the fixture keeps the shape it claims (call first, result last, only children truncated)", () => {
    const skillId = realShape.toolCalls[0]!.toolUseId;
    expect(realShape.toolCalls[0]!.name).toBe("Skill");
    expect(realShape.toolResults.at(-1)!.toolUseId).toBe(skillId);
    expect(realShape.toolResults.filter((t) => t.assertTextTruncated).length).toBe(2);
    expect(realShape.toolResults.at(-1)!.assertTextTruncated).toBeUndefined();
    expect(realShape.toolCalls.slice(1).every((t) => t.parentToolUseId === skillId && t.origin === "main")).toBe(true);
  });
});

describe("semantic_matches.include_fork_results — eval reads every fork refusal as a refusal", () => {
  // eval needs no code change: it treats any `semanticEvidence.reason` other than `graded` as a refusal.
  // Pinned over the grades the REAL check produces for each fork reason, so a new reason cannot slip past.
  const cases: Array<[string, Partial<AssertContext>]> = [
    ["fork_result_truncated", { toolCalls: [call("t1", "plug:a")], toolResults: [res("t1", forkText("plug:a", "x"), true)] }],
    ["fork_result_unpaired", { toolCalls: [call("t1", "plug:a")], toolResults: [] }],
    [
      "fork_result_background",
      {
        toolCalls: [call("t1", "plug:a")],
        toolResults: [res("t1", 'Skill "plug:a" launched (forked execution, running in the background).')],
      },
    ],
    ["fork_calls_unrecorded", { toolCalls: undefined, toolResults: [] }],
  ];
  for (const [reason, over] of cases)
    it(`${reason} → semanticRefusalReason names it, and the claim row is excluded as evidence_unavailable`, async () => {
      const { judge } = capturing();
      const a = withForks(["x"]);
      const c = ctx({ transcript: "x", ...over });
      await runSemanticJudges([a], c, judge);
      const g = evaluate([a], c)[0];
      expect(g.semanticEvidence?.reason).toBe(reason);
      expect(semanticRefusalReason(g)).toBe(reason);
      const rows = repRowValues(
        [{ assertionIndex: 0, kind: "claim", claimIndex: 0, claim: "x" } as Parameters<typeof repRowValues>[0][number]],
        [a],
        { bucket: "valid", judgeInvalidAssertions: [] } as unknown as Parameters<typeof repRowValues>[2],
        { assertions: [g] } as unknown as Parameters<typeof repRowValues>[3],
      );
      expect(rows[0]).toMatchObject({ excluded: "evidence_unavailable" });
    });
});

describe("semantic_matches.include_fork_results — with no judge pre-pass (verify-run)", () => {
  it("a record-only fork refusal is still reported, typed — it reads nothing but the persisted call/result record", () => {
    const a = withForks(["x"]);
    const r = evaluate([a], ctx({ toolCalls: [call("t1", "plug:a")], toolResults: [] }))[0];
    expect(r.pass).toBe(false);
    expect(r.semanticEvidence).toEqual({ reason: "fork_result_unpaired", paths: ["plug:a"] });
  });
  it("a clean fork record falls through to 'judge not run' (the compose-time cut needs the pre-pass)", () => {
    const a = withForks(["x"]);
    const r = evaluate([a], ctx({ toolCalls: [call("t1", "plug:a")], toolResults: [res("t1", forkText("plug:a", "x"))] }))[0];
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/semantic judge not run/);
    expect(r.semanticEvidence).toBeUndefined();
  });
});

describe("semantic_matches.include_fork_results — review fixes", () => {
  it("a Skill parented under a fork is excluded from the judged document and cannot make the assert refuse", async () => {
    const { judge, received } = capturing();
    const a = withForks(["OUTER-ANSWER"]);
    const c = ctx({
      toolCalls: [call("t1", "plug:outer"), { ...call("t2", "plug:inner"), parentToolUseId: "t1" }],
      // The inner result is CUT — had it been joined, the assert would refuse fork_result_truncated.
      toolResults: [res("t2", forkText("plug:inner", "INNER-ANSWER"), true), res("t1", forkText("plug:outer", "OUTER-ANSWER"))],
    });
    expect(joinSkillResults(c).joined.map((j) => j.skill)).toEqual(["plug:outer"]);
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.pass).toBe(true);
    expect(received[0]).toContain("## Fork skill result: plug:outer");
    expect(received[0]).not.toContain("plug:inner");
    // An unpaired inner call is ignored too.
    const c2 = ctx({
      toolCalls: [call("t1", "plug:outer"), { ...call("t2", "plug:inner"), parentToolUseId: "t1" }],
      toolResults: [res("t1", forkText("plug:outer", "x"))],
    });
    expect(joinSkillResults(c2).unpaired).toEqual([]);
  });

  it("an overflow into the AUTHORED region that skill sections helped cause points at include_fork_results", async () => {
    const { judge } = capturing();
    const a: Assertion = { semantic_matches: { rubric: ["x"], include_fork_results: true } };
    const c = ctx({
      transcript: "x".repeat(128 * 1024),
      finalMessage: "y".repeat(32 * 1024),
      toolCalls: [call("t1", "plug:a"), call("t2", "plug:b"), call("t3", "plug:c")],
      toolResults: ["t1", "t2", "t3"].map((id) => res(id, forkText(`plug:${id}`, "q".repeat(30 * 1024)))),
      authoredFiles: [{ path: "outputs/report.md", content: "r".repeat(10 * 1024) }],
    });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.semanticEvidence?.reason).toBe("authored_evidence_truncated");
    expect(r.message).toContain("set include_fork_results: false, or ");
  });

  it("the hint is absent when the key is off", async () => {
    const { judge } = capturing();
    const a: Assertion = { semantic_matches: { rubric: ["x"] } };
    const c = ctx({
      transcript: "x".repeat(128 * 1024),
      finalMessage: "y".repeat(32 * 1024),
      toolCalls: [call("t1", "plug:a")],
      toolResults: [res("t1", forkText("plug:a", "q"))],
      authoredFiles: [{ path: "outputs/report.md", content: "r".repeat(120 * 1024) }],
    });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.semanticEvidence?.reason).toBe("authored_evidence_truncated");
    expect(r.message).not.toContain("include_fork_results");
  });

  it("scrubbing that lengthens a near-cap result past the Skill cap refuses fork_result_truncated, never a silent cut", async () => {
    const { judge, received } = capturing();
    const a = withForks(["x"]);
    // Under the cap as captured (not flagged truncated); each 2-char secret becomes `[REDACTED]` (10 chars).
    const body = "zz ".repeat(10_000); // 30,000 chars, 10,000 secrets → ~110,000 after scrubbing
    const text = forkText("plug:s", body);
    expect(text.length).toBeLessThan(SKILL_RESULT_ASSERT_CAP);
    const c = ctx({ secrets: ["zz"], toolCalls: [call("t1", "plug:s")], toolResults: [res("t1", text)] });
    await runSemanticJudges([a], c, judge);
    const r = evaluate([a], c)[0];
    expect(r.semanticEvidence).toEqual({ reason: "fork_result_truncated", paths: ["plug:s"] });
    expect(r.message).toMatch(/secret scrubbing lengthened a result past the 32768-char Skill-result cap/);
    expect(received).toHaveLength(0); // refused before the judge
  });
});

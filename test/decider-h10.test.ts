import { describe, it, expect } from "vitest";
import {
  LlmDecider,
  ScriptedDecider,
  UnansweredError,
  ABSTAIN,
  isBoundaryPrefix,
  echoPrefixMatch,
  suffixCanonMatch,
  parseIndexReply,
  coerceLabel,
  type RunContext,
  type Complete,
} from "../src/decide/decider.js";
import type { DecisionRequest } from "../src/agent/session.js";
import type { AnswerRule } from "../src/types.js";

// H10 fix: index protocol (model replies a number; code maps to the canonical label), the `label: description`
// echo backstop (label ⊑ reply at a `:` boundary, longest-wins), the scripted author-prefix (drift-tolerant
// anchor), multi-select on the LLM path, and the OTHER-vs-echo ordering. Evidence: zigi/zigi2/zigi3 runs.

const ctx = (t = ""): RunContext => ({ task: "", transcript: () => t, toolLog: () => [], runId: "x" });
const ask = (q: string, opts: string[], multiSelect = false): DecisionRequest => ({
  id: "r",
  kind: "question",
  questions: [{ question: q, options: opts.map((label) => ({ label })), multiSelect }],
});
const llm = (reply: string) => new LlmDecider(async () => reply);
const answersOf = async (d: any, req: DecisionRequest) => ((await d.decide(req, ctx())) as any).response.answers;

const SCRIPTED = ":(,—–"; // mirror SCRIPTED_SEPARATORS (module-private)

describe("isBoundaryPrefix", () => {
  it("binds at a `:` boundary (the reproduced echo)", () => {
    expect(isBoundaryPrefix("Seed / AI/ML", "Seed / AI/ML: Seed stage", ":")).toBe(true);
    expect(isBoundaryPrefix("Israeli company only", "Israeli company only: Incorporated", ":")).toBe(true);
  });
  it("`/` and bare whitespace are NOT separators (no prose / shorter-shadow binds)", () => {
    expect(isBoundaryPrefix("Seed", "Seed / AI/ML: x", ":")).toBe(false); // `/` after ws → not a separator
    expect(isBoundaryPrefix("Series A", "Series A is my pick", ":")).toBe(false); // prose: space then `i`
  });
  it("scripted set rides drift continuations via `(` and `,` (optional-whitespace then separator)", () => {
    expect(isBoundaryPrefix("Israeli company", "Israeli company (IL only)", SCRIPTED)).toBe(true); // space then (
    expect(isBoundaryPrefix("2 founders", "2 founders, ~5M each", SCRIPTED)).toBe(true); // comma
  });
  it("comma/paren are echo asides (NOT in the echo set) but safe in the scripted set", () => {
    expect(isBoundaryPrefix("No", "No, I disagree", ":")).toBe(false); // comma not an echo separator
    expect(isBoundaryPrefix("Seed", "Seed (probably) but Series A", ":")).toBe(false); // paren not an echo separator
  });
  it("end-of-string after optional whitespace is a boundary", () => {
    expect(isBoundaryPrefix("Seed", "Seed", ":")).toBe(true);
    expect(isBoundaryPrefix("Seed", "Seed   ", ":")).toBe(true);
  });
});

describe("echoPrefixMatch — label ⊑ reply, longest-wins, `:` only", () => {
  it("binds the two reproduced echoes", () => {
    expect(
      echoPrefixMatch("Israeli company only: Incorporated in Israel", ["Israeli company only", "Delaware (already flipped)", "Mid-flip"]),
    ).toBe("Israeli company only");
    expect(echoPrefixMatch("Seed / AI/ML: Seed stage, AI focused", ["Seed / B2B SaaS", "Seed / AI/ML"])).toBe("Seed / AI/ML");
  });
  it("longest-wins on (degenerate) nested colon labels", () => {
    expect(echoPrefixMatch("Seed: AI: details", ["Seed", "Seed: AI"])).toBe("Seed: AI");
  });
  it("rejects prose and aside hazards (returns null)", () => {
    expect(echoPrefixMatch("Series A is my pick", ["Seed", "Series A"])).toBe(null);
    expect(echoPrefixMatch("No, I disagree with all of these", ["No", "Yes"])).toBe(null); // comma aside
    expect(echoPrefixMatch("Seed (probably wrong) but Series A", ["Seed", "Series A"])).toBe(null); // paren aside
    expect(echoPrefixMatch("Seed — actually no", ["Seed", "Series A"])).toBe(null); // dash aside
  });
  it("composes with trim — a quoted echo still binds at index 0", () => {
    expect(echoPrefixMatch('"Seed / AI/ML: Seed stage"', ["Seed / B2B SaaS", "Seed / AI/ML"])).toBe("Seed / AI/ML");
  });
});

describe("suffixCanonMatch — (Recommended) canonicalization, uniqueness-guarded", () => {
  it("binds the full canonical label", () => {
    expect(suffixCanonMatch("Approve", ["Approve (Recommended)", "Reject"])).toBe("Approve (Recommended)");
  });
  it("composes with trim — trailing punctuation does not defeat it", () => {
    expect(suffixCanonMatch("Approve.", ["Approve (Recommended)", "Reject"])).toBe("Approve (Recommended)");
    expect(suffixCanonMatch('"Approve!"', ["Approve (Recommended)", "Reject"])).toBe("Approve (Recommended)");
  });
  it("2 collisions → null (loud)", () => {
    expect(suffixCanonMatch("Approve", ["Approve (Recommended)", "Approve"])).toBe(null);
  });
});

describe("parseIndexReply — bare digits, range-guarded (#50)", () => {
  it("in-range bare digit → index", () => expect(parseIndexReply("2", 3)).toBe(2));
  it("out-of-range bare digit → null (a numeric LABEL falls through to label match)", () => expect(parseIndexReply("2024", 3)).toBe(null));
  it("non-bare-digit forms are not indices", () => {
    for (const r of ["2)", "option 2", "the second one", "2 and 4", "0", " "]) expect(parseIndexReply(r, 4)).toBe(null);
  });
});

describe("LlmDecider — index protocol (primary)", () => {
  it("a bare number maps to the canonical label", async () => {
    expect(await answersOf(llm("2"), ask("Stage?", ["Pre-seed", "Seed", "Series A"]))).toEqual({ "Stage?": "Seed" });
  });
  it("digit-label edge: out-of-range number is treated as a label, in-range as an index", async () => {
    expect(await answersOf(llm("2024"), ask("Year?", ["2024", "2025"]))).toEqual({ "Year?": "2024" }); // out of [1,2] → label
    expect(await answersOf(llm("1"), ask("Year?", ["2024", "2025"]))).toEqual({ "Year?": "2024" }); // index 1
  });
  it("non-bare-digit numeric replies fall through and fail loud (soft-enforcement contract)", async () => {
    for (const r of ["2)", "option 2", "2 and 4"])
      await expect(llm(r).decide(ask("Stage?", ["Pre-seed", "Seed", "Series A"]), ctx())).rejects.toThrow(UnansweredError);
  });
});

describe("LlmDecider — echo backstop (the reproduced bug)", () => {
  it("binds a `label: description` echo via the `:` boundary", async () => {
    expect(
      await answersOf(
        llm("Israeli company only: Incorporated in Israel, no Delaware flip yet"),
        ask("Jurisdiction?", ["Israeli company only", "Delaware (already flipped)", "Mid-flip", "Delaware with Israeli sub"]),
      ),
    ).toEqual({ "Jurisdiction?": "Israeli company only" });
  });
  it("rejects prose / comma / paren / dash asides — loud, never a guess", async () => {
    await expect(llm("Series A is my pick").decide(ask("Stage?", ["Seed", "Series A"]), ctx())).rejects.toThrow(UnansweredError);
    await expect(llm("No, I disagree with all of these").decide(ask("Use it?", ["No", "Yes"]), ctx())).rejects.toThrow(UnansweredError);
    await expect(llm("Seed (probably wrong) but Series A").decide(ask("Stage?", ["Seed", "Series A"]), ctx())).rejects.toThrow(
      UnansweredError,
    );
  });
  it("the loud failure surfaces the closest label in the hint (diagnosability)", async () => {
    await expect(llm("Confirmd").decide(ask("Use it?", ["Confirmed", "Different"]), ctx())).rejects.toMatchObject({
      hint: expect.stringContaining('closest: "Confirmed"'),
    });
  });
  it("trim composes with the suffix tier: 'Approve.' binds the (Recommended) option", async () => {
    expect(await answersOf(llm("Approve."), ask("Go?", ["Approve (Recommended)", "Reject"]))).toEqual({ "Go?": "Approve (Recommended)" });
  });
});

describe("LlmDecider — multi-select (net-new on the LLM path)", () => {
  it("a comma-list of bare numbers selects multiple, comma-joined", async () => {
    expect(await answersOf(llm("1, 3"), ask("Model what?", ["Snapshot", "Priced round", "Flip"], true))).toEqual({
      "Model what?": "Snapshot, Flip",
    });
  });
  it("a mixed digit+label reply fails loud", async () => {
    await expect(llm("1, Seed").decide(ask("Model what?", ["Snapshot", "Priced round", "Flip"], true), ctx())).rejects.toThrow(
      UnansweredError,
    );
  });
});

describe("LlmDecider — OTHER vs echo ordering", () => {
  it("a literal `OTHER:`-named label still binds as a label (exact precedes OTHER)", async () => {
    expect(await answersOf(llm("OTHER: pick me"), ask("Which?", ["OTHER: pick me", "Else"]))).toEqual({ "Which?": "OTHER: pick me" });
  });
  it("FLIP test: with label `OTHER` present, `OTHER: please use CSV` delivers free-text (OTHER precedes the echo tier)", async () => {
    // If the echo tier ran before OTHER, `OTHER` would bind via its `:` boundary — wrong. OTHER-first wins.
    expect(await answersOf(llm("OTHER: please use CSV"), ask("Format?", ["OTHER", "Keep default"]))).toEqual({
      "Format?": "please use CSV",
    });
  });
});

describe("ScriptedDecider — author-prefix anchor (drift-tolerant), exactly-one", () => {
  const run = async (choose: string, opts: string[]) => {
    const rules: AnswerRule[] = [{ when_question: "jur", choose }];
    const req: DecisionRequest = {
      id: "q",
      kind: "question",
      questions: [{ question: "jur?", options: opts.map((label) => ({ label })) }],
    };
    return new ScriptedDecider(rules).decide(req, ctx());
  };
  it("a stable partial anchor binds the unique option that starts with it (via `(`)", async () => {
    expect(
      ((await run("Israeli company", ["Israeli company (IL only)", "Delaware with Israeli subsidiary", "Mid-flip"])) as any).response
        .answers,
    ).toEqual({ "jur?": "Israeli company (IL only)" });
  });
  it("rides a comma drift continuation", async () => {
    expect(((await run("2 founders", ["1 founder, ~10M shares", "2 founders, ~5M each"])) as any).response.answers).toEqual({
      "jur?": "2 founders, ~5M each",
    });
  });
  it("an ambiguous anchor (2 sibling options) fails loud — the documented determinism cost", async () => {
    await expect(run("Delaware", ["Delaware only", "Delaware + Israeli subsidiary"])).rejects.toThrow(/matched no offered option/);
  });
  it("does NOT shadow an exact pin, and a full mistyped label still fails loud with closest: in the hint", async () => {
    await expect(run("Delawaer only", ["Delaware only", "Mid-flip"])).rejects.toMatchObject({ hint: expect.stringContaining("closest:") });
  });
});

describe("coerceLabel — author-prefix is opt-in (default off keeps deterministic paths strict)", () => {
  it("default (no scriptedPrefix) does NOT widen — a partial anchor stays unmatched", () => {
    expect(coerceLabel("Israeli company", ["Israeli company (IL only)", "Mid-flip"]).matched).toBe(false);
  });
  it("with scriptedPrefix it binds the unique boundary-prefixed option", () => {
    expect(coerceLabel("Israeli company", ["Israeli company (IL only)", "Mid-flip"], true, true)).toEqual({
      value: "Israeli company (IL only)",
      matched: true,
    });
  });
});

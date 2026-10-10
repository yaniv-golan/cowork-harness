// The evaluator reply repair, through the real parser (`parseCritiqueItems`): a `{"items":[...]}` document complete
// except for its trailing closer(s) is repaired by appending exactly those; anything else is refused as before.
import { describe, it, expect } from "vitest";
import { parseCritiqueItems, runCritique, canaryIdea } from "../src/critique/evaluator.js";
import { buildJsonReport, buildTextReport } from "../src/critique/command.js";
import { buildCritiqueSummary } from "../src/critique/summary.js";
import type { Complete } from "../src/decide/decider.js";
import { repairTrailingClosers } from "../src/critique/reply-repair.js";

const item = (idea: string, extra = "") =>
  `{"idea":${JSON.stringify(idea)},"classification":"grounded-and-actionable","evidence":"the skill never says which currency","recommendedAction":"state the currency${extra}"}`;
const parse = (raw: string) => parseCritiqueItems(raw, "self-report", "critique pass 2 (verify self-report)", "nonce-test");

describe("evaluator reply repair — only the missing trailing closers", () => {
  it("repairs the observed shape: a complete items array whose final } is missing", () => {
    const raw = `{"items":[${item("first finding")},${item("second finding")}]`;
    const r = parse(raw);
    expect(r.items.map((i) => i.idea)).toEqual(["first finding", "second finding"]);
    expect(r.repair).toEqual({ appended: "}" });
  });

  it("repairs after leading prose", () => {
    const r = parse(`Here is my assessment:\n\n{"items":[${item("only finding")}]`);
    expect(r.items).toHaveLength(1);
    expect(r.repair).toEqual({ appended: "}" });
  });

  it("REFUSES a reply that would also need a ] (the list left open — a cut-off reply looks like this)", () => {
    expect(repairTrailingClosers(`{"items":[${item("only finding")}`)).toBeNull();
    expect(() => parse(`{"items":[${item("a")},${item("b")}`)).toThrow(/no valid \{"items":\[\.\.\.\]\} JSON/);
  });

  it("brackets inside strings do not count: an idea containing '}]' is repaired correctly", () => {
    const r = parse(`{"items":[${item('uses a literal "}]" token in its template')}]`);
    expect(r.items[0]!.idea).toBe('uses a literal "}]" token in its template');
    expect(r.repair).toEqual({ appended: "}" });
  });

  it("a complete reply is unchanged — extra trailing text included — and carries no repair", () => {
    const r = parse(`{"items":[${item("a finding")}]}\n\nLet me know if you want more detail.`);
    expect(r.items).toHaveLength(1);
    expect(r.repair).toBeUndefined();
  });

  it("REFUSES a reply cut mid-item", () => {
    expect(() => parse(`{"items":[${item("ok")},{"idea":"cut here","classification":`)).toThrow(/no valid \{"items":\[\.\.\.\]\} JSON/);
  });

  it("REFUSES a reply cut mid-string, even where closing the string would make a valid item", () => {
    const raw = `{"items":[{"idea":"a","classification":"not-adjudicable","evidence":"","recommendedAction":"no`;
    expect(() => parse(raw)).toThrow(/no valid \{"items":\[\.\.\.\]\} JSON/);
  });

  it("REFUSES a reply with a missing inner comma (an inner fix is never made)", () => {
    const raw = `{"items":[{"idea":"a" "classification":"grounded-and-actionable","evidence":"e","recommendedAction":"r"}]`;
    expect(() => parse(raw)).toThrow(/no valid \{"items":\[\.\.\.\]\} JSON/);
  });

  it('REFUSES a reply cut right after the items opener (an empty repair never stands in for "no findings")', () => {
    expect(() => parse(`{"items":[`)).toThrow(/no valid \{"items":\[\.\.\.\]\} JSON/);
  });

  it("REFUSES an items document nested in another unclosed opener (nothing outside it is dropped)", () => {
    expect(repairTrailingClosers(`{"result":{"items":[${item("x")}]`)).toBeNull();
    expect(repairTrailingClosers(`[{"items":[${item("x")}]`)).toBeNull();
    expect(() => parse(`{"result":{"items":[${item("x")}]`)).toThrow();
  });

  it("a repaired reply that then fails validation reports the repair and the ORIGINAL reply", () => {
    const raw = `{"items":[{"idea":"x","classification":"not-a-class","evidence":"e","recommendedAction":"r"}]`;
    let msg = "";
    try {
      parse(raw);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/after appending "\}" to an unclosed reply/);
    expect(msg.split("--- raw reply ---\n")[1]).toBe(raw);
  });

  it("REFUSES a mismatched closer and trailing prose after an unclosed document", () => {
    expect(repairTrailingClosers(`{"items":[${item("x")}}`)).toBeNull();
    expect(repairTrailingClosers(`{"items":[${item("x")}] and that is all`)).toBeNull();
  });

  it("a stray double quote in prose before the document is not read as a string", () => {
    const r = parse(`The "summary: {"items":[${item("x")}]`);
    expect(r.items).toHaveLength(1);
    expect(r.repair).toEqual({ appended: "}" });
  });

  it("REFUSES a canary-only reply missing its closer (a repair that leaves no findings)", () => {
    const canary = `{"idea":${JSON.stringify(canaryIdea("nonce-test"))},"classification":"not-adjudicable","evidence":"","recommendedAction":"none"}`;
    expect(() => parse(`{"items":[${canary}]`)).toThrow(/no valid/);
  });
});

describe("evaluator reply repair — from runCritique to the report, text and summary", () => {
  const N = "0123456789abcdef";
  const SECTIONS = [{ title: "SKILL.md", body: "# s\n\nthe skill never says which currency" }];
  const canary = `{"idea":${JSON.stringify(canaryIdea(N))},"classification":"not-adjudicable","evidence":"","recommendedAction":"none"}`;

  it("a pass-2 reply missing its final } fires onRepair for pass 2, and the report, text and summary carry it", async () => {
    let calls = 0;
    const complete = (async () => {
      calls++;
      return calls === 1
        ? { text: `{"items":[${canary},${item("pass one finding")}]}`, model: "m" }
        : { text: `{"items":[${canary},${item("pass two finding")}]`, model: "m" };
    }) as unknown as Complete;
    const repairs: unknown[] = [];
    await runCritique(SECTIONS, "self report text", { nonce: N, complete, onRepair: (r) => repairs.push(r) });
    expect(repairs).toEqual([{ pass: 2, appended: "}" }]);

    const state = {
      skillFolder: "s",
      prompt: "p",
      sessionId: "crit-1",
      outDir: "/tmp/x",
      fidelity: "container",
      selfReportStatus: "captured",
      items: [],
      requestedModel: "claude-opus-4-8",
      evaluatorRepair: repairs,
    } as unknown as Parameters<typeof buildJsonReport>[0];
    const ctx = { identity: { name: "s", kind: "folder" as const }, includeCost: false, includePromptHash: false };
    expect(buildCritiqueSummary(buildJsonReport(state), ctx).evaluatorRepaired).toBe(true);
    expect(buildCritiqueSummary(buildJsonReport({ ...state, evaluatorRepair: undefined }), ctx).evaluatorRepaired).toBe(false);
    expect(buildTextReport(state)).toContain(`evaluator pass 2's reply was missing its final closing "}"`);
  });
});

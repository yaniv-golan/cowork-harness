// The evaluator reply repair, through the real parser (`parseCritiqueItems`): a `{"items":[...]}` document complete
// except for its trailing closer(s) is repaired by appending exactly those; anything else is refused as before.
import { describe, it, expect } from "vitest";
import { parseCritiqueItems } from "../src/critique/evaluator.js";
import { repairTrailingClosers } from "../src/critique/reply-repair.js";

const item = (idea: string, extra = "") =>
  `{"idea":${JSON.stringify(idea)},"classification":"grounded-and-actionable","evidence":"the skill never says which currency","recommendedAction":"state the currency${extra}"}`;
const parse = (raw: string) => parseCritiqueItems(raw, "self-report", "critique pass 2 (verify self-report)", "nonce-test");

describe("evaluator reply repair — only the missing trailing closers", () => {
  it("repairs the observed shape: a complete items array whose final } is missing", () => {
    const raw = `{"items":[${item("first finding")},${item("second finding")}]`;
    const r = parse(raw);
    expect(r.items.map((i) => i.idea)).toEqual(["first finding", "second finding"]);
    expect(r.repair).toEqual({ appended: "}", possiblyTruncated: false });
  });

  it("repairs after leading prose, and when both ] and } are missing", () => {
    const r = parse(`Here is my assessment:\n\n{"items":[${item("only finding")}`);
    expect(r.items).toHaveLength(1);
    expect(r.repair).toEqual({ appended: "]}", possiblyTruncated: true }); // the list was left open: maybe cut off
  });

  it("brackets inside strings do not count: an idea containing '}]' is repaired correctly", () => {
    const r = parse(`{"items":[${item('uses a literal "}]" token in its template')}]`);
    expect(r.items[0]!.idea).toBe('uses a literal "}]" token in its template');
    expect(r.repair).toEqual({ appended: "}", possiblyTruncated: false });
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
});

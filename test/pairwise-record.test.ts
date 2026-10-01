import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { embeddedPairwiseRefs, preSpendVerdicts, relocatePairwiseRefs } from "../src/run/cassette.js";
import { cassetteSessionRef } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

const sc = (refs: string[]): Scenario =>
  ({
    name: "case_1",
    session: "(inline)",
    prompt: "p",
    assert: [{ semantic_pairwise: { refs } }, { result: "success" }],
  }) as unknown as Scenario;

describe("semantic_pairwise refs in a recorded cassette", () => {
  it("are stored relative to the cassette (never an absolute host path) and resolve back for --from-embedded", () => {
    const cassette = "/repo/tests/cassettes/case_1.cassette.json";
    const recorded = relocatePairwiseRefs(sc(["/repo/tests/refs"]), (r) => cassetteSessionRef(r, cassette));
    expect(recorded.assert[0]!.semantic_pairwise!.refs).toEqual(["../refs"]);
    expect(recorded.assert[1]).toEqual({ result: "success" });
    const back = embeddedPairwiseRefs(recorded, cassette);
    expect(back.assert[0]!.semantic_pairwise!.refs).toEqual(["/repo/tests/refs"]);
  });
  it("leave a scenario without pairwise refs as the same object", () => {
    const s = { name: "x", session: "(inline)", prompt: "p", assert: [{ result: "success" }] } as unknown as Scenario;
    expect(relocatePairwiseRefs(s, () => "z")).toBe(s);
  });
});

describe("record --dry-run previews the pairwise gate", () => {
  it("refuses a scenario whose reference store does not exist", () => {
    const v = preSpendVerdicts(sc([join("/nonexistent-store-for-test")]), "/tmp/x.cassette.json", {});
    expect(v.some((x) => x.kind === "refuse" && /semantic_pairwise: refusing before the run spends anything/.test(x.message))).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { requiredVersionFor, CASSETTE_VERSION } from "../src/run/cassette.js";
import { scenarioArmsPreRunManifest } from "../src/run/execute.js";
import { judgedOpts } from "../src/assert.js";
import type { Assertion, Scenario } from "../src/types.js";

const pw = { semantic_pairwise: { refs: ["r"], evidence_files: ["outputs/report.md"] } } as unknown as Assertion;
const sc = (asserts: Assertion[]): Scenario => ({ name: "s", prompt: "p", session: "(inline)", assert: asserts }) as unknown as Scenario;

describe("semantic_pairwise wiring", () => {
  it("a scenario using it stamps cassette v14; one without it does not", () => {
    expect(CASSETTE_VERSION).toBe(14);
    expect(requiredVersionFor(sc([pw]))).toBe(14);
    expect(requiredVersionFor(sc([{ result: "success" } as Assertion]))).toBeLessThan(14);
  });

  it("a pairwise-only scenario arms the pre-run manifest (its authored-file evidence needs the baseline)", () => {
    expect(scenarioArmsPreRunManifest(sc([pw]))).toBe(true);
    expect(scenarioArmsPreRunManifest(sc([{ result: "success" } as Assertion]))).toBe(false);
  });

  it("judgedOpts exposes its evidence scope, which the live capture spends its budget on first", () => {
    expect(judgedOpts(pw)).toMatchObject({ key: "semantic_pairwise", evidenceFiles: ["outputs/report.md"] });
  });
});

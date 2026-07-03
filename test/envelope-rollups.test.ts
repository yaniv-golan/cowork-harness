import { describe, it, expect } from "vitest";
import { jsonEnvelope } from "../src/run/envelope.js";
import { buildRepeatRollup } from "../src/run/repeat.js";
import type { RunResult } from "../src/types.js";

function rr(over: Partial<RunResult>): RunResult {
  return { scenario: "t", fidelity: "container", baseline: "x", result: "success", decisions: [], egress: [], assertions: [], outDir: "/tmp/x", ...over };
}

describe("jsonEnvelope — E1's rollups/minPassRate additions (§8: ok redefined per mode, no shadow field)", () => {
  it("without rollups, ok is unchanged: derived from results.every(verdict.pass)", () => {
    const allPass = JSON.parse(jsonEnvelope("run", [rr({}), rr({})]));
    expect(allPass.ok).toBe(true);
    expect(allPass.rollups).toBeUndefined();
    const onefail = JSON.parse(jsonEnvelope("run", [rr({}), rr({ result: "error" })]));
    expect(onefail.ok).toBe(false);
  });

  it("with rollups, ok is derived from rollupPasses against minPassRate, NOT results.every(pass)", () => {
    // 9/10 completed pass (passRate 0.9) — every individual RunResult in results[] still carries its own
    // real verdict.pass (one is false), but the BATCH itself should read ok:true at minPassRate 0.8.
    const results = [...Array(9).fill(0).map(() => rr({})), rr({ result: "error" })];
    const rollup = buildRepeatRollup("t", 10, results);
    const envelope = JSON.parse(jsonEnvelope("run", results, [rollup], 0.8));
    expect(envelope.ok).toBe(true);
    expect(envelope.results.some((r: any) => r.verdict.pass === false)).toBe(true); // the raw per-result verdict is untouched
    expect(envelope.rollups).toHaveLength(1);
    expect(envelope.rollups[0].passRate).toBeCloseTo(0.9);
  });

  it("a diverged rollup makes ok:false even if every individual RunResult in results[] passed", () => {
    const results = [rr({})]; // the single completed run happened to pass
    const rollup = buildRepeatRollup("t", 10, results, "diverged");
    const envelope = JSON.parse(jsonEnvelope("run", results, [rollup], 0.1));
    expect(envelope.ok).toBe(false);
  });

  it("results[] always holds every raw RunResult — nothing hidden from a --repeat caller", () => {
    const results = [rr({}), rr({ result: "error" }), rr({})];
    const rollup = buildRepeatRollup("t", 3, results);
    const envelope = JSON.parse(jsonEnvelope("run", results, [rollup], 0.5));
    expect(envelope.results).toHaveLength(3);
  });
});

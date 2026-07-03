import { describe, it, expect } from "vitest";
import { jsonEnvelope } from "../src/run/envelope.js";
import { buildRepeatRollup } from "../src/run/repeat.js";
import { buildMatrixRollup } from "../src/run/matrix.js";
import type { RunResult } from "../src/types.js";

function rr(over: Partial<RunResult>): RunResult {
  return { scenario: "t", fidelity: "container", baseline: "x", result: "success", decisions: [], egress: [], assertions: [], outDir: "/tmp/x", ...over };
}

describe("jsonEnvelope — E1's rollups/minPassRate additions (§8: ok redefined per mode, no shadow field)", () => {
  it("without opts, ok is unchanged: derived from results.every(verdict.pass)", () => {
    const allPass = JSON.parse(jsonEnvelope("run", [rr({}), rr({})]));
    expect(allPass.ok).toBe(true);
    expect(allPass.rollups).toBeUndefined();
    expect(allPass.matrix).toBeUndefined();
    const onefail = JSON.parse(jsonEnvelope("run", [rr({}), rr({ result: "error" })]));
    expect(onefail.ok).toBe(false);
  });

  it("with rollups, ok is derived from rollupPasses against minPassRate, NOT results.every(pass)", () => {
    // 9/10 completed pass (passRate 0.9) — every individual RunResult in results[] still carries its own
    // real verdict.pass (one is false), but the BATCH itself should read ok:true at minPassRate 0.8.
    const results = [...Array(9).fill(0).map(() => rr({})), rr({ result: "error" })];
    const rollup = buildRepeatRollup("t", 10, results);
    const envelope = JSON.parse(jsonEnvelope("run", results, { rollups: [rollup], minPassRate: 0.8 }));
    expect(envelope.ok).toBe(true);
    expect(envelope.results.some((r: any) => r.verdict.pass === false)).toBe(true); // the raw per-result verdict is untouched
    expect(envelope.rollups).toHaveLength(1);
    expect(envelope.rollups[0].passRate).toBeCloseTo(0.9);
  });

  it("a diverged rollup makes ok:false even if every individual RunResult in results[] passed", () => {
    const results = [rr({})]; // the single completed run happened to pass
    const rollup = buildRepeatRollup("t", 10, results, "diverged");
    const envelope = JSON.parse(jsonEnvelope("run", results, { rollups: [rollup], minPassRate: 0.1 }));
    expect(envelope.ok).toBe(false);
  });

  it("results[] always holds every raw RunResult — nothing hidden from a --repeat caller", () => {
    const results = [rr({}), rr({ result: "error" }), rr({})];
    const rollup = buildRepeatRollup("t", 3, results);
    const envelope = JSON.parse(jsonEnvelope("run", results, { rollups: [rollup], minPassRate: 0.5 }));
    expect(envelope.results).toHaveLength(3);
  });
});

describe("jsonEnvelope — E3's matrix addition (ok redefined from matrix.anyFail when present)", () => {
  it("ok is true when every matrix cell passes", () => {
    const results = [rr({}), rr({})];
    const matrix = buildMatrixRollup(
      [
        { index: 0, axes: {}, pass: true, failedAssertions: [], signals: [] },
        { index: 1, axes: {}, pass: true, failedAssertions: [], signals: [] },
      ],
      2,
      false,
    );
    const envelope = JSON.parse(jsonEnvelope("run", results, { matrix }));
    expect(envelope.ok).toBe(true);
    expect(envelope.matrix.cells).toHaveLength(2);
  });

  it("ok is false when any matrix cell fails (assertion OR infra error)", () => {
    const results = [rr({})];
    const matrix = buildMatrixRollup([{ index: 0, axes: {}, pass: false, failedAssertions: [], signals: [], error: "agent binary unavailable" }], 1, false);
    const envelope = JSON.parse(jsonEnvelope("run", results, { matrix }));
    expect(envelope.ok).toBe(false);
  });

  it("matrix and rollups are mutually exclusive in practice but the envelope doesn't enforce it structurally — matrix wins if both given", () => {
    const results = [rr({})];
    const rollup = buildRepeatRollup("t", 1, results); // would say ok:true
    const matrix = buildMatrixRollup([{ index: 0, axes: {}, pass: false, failedAssertions: [], signals: [] }], 1, false); // says ok:false
    const envelope = JSON.parse(jsonEnvelope("run", results, { rollups: [rollup], matrix }));
    expect(envelope.ok).toBe(false);
  });
});

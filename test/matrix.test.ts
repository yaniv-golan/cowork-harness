import { describe, it, expect } from "vitest";
import { MatrixFile, expandMatrix, buildMatrixRollup, formatMatrixRollup, type MatrixCellResult } from "../src/run/matrix.js";

describe("MatrixFile schema", () => {
  it("accepts a file with all three optional axes", () => {
    expect(() =>
      MatrixFile.parse({ baselines: ["desktop-1.17377.2", "desktop-1.18286.0"], models: ["claude-opus-4-8"], skill_dirs: ["./skill"] }),
    ).not.toThrow();
  });
  it("accepts an empty file — all axes absent", () => {
    expect(() => MatrixFile.parse({})).not.toThrow();
  });
  it("rejects an unknown top-level key (strict schema, no silent typo)", () => {
    expect(() => MatrixFile.parse({ baseline: ["x"] })).toThrow(); // typo: singular, not the real `baselines` key
  });
  it("rejects a non-array axis value", () => {
    expect(() => MatrixFile.parse({ baselines: "desktop-1.18286.0" })).toThrow();
  });
});

describe("expandMatrix — cross-product cell generation", () => {
  it("a single axis produces one cell per value, others undefined", () => {
    const { cells } = expandMatrix({ baselines: ["a", "b"] }, 16);
    expect(cells).toHaveLength(2);
    expect(cells[0].axes).toEqual({ baseline: "a", model: undefined, skillDir: undefined });
    expect(cells[1].axes).toEqual({ baseline: "b", model: undefined, skillDir: undefined });
  });

  it("two axes produce the full cross-product", () => {
    const { cells } = expandMatrix({ baselines: ["a", "b"], models: ["x", "y"] }, 16);
    expect(cells).toHaveLength(4);
    expect(cells.map((c) => `${c.axes.baseline}/${c.axes.model}`).sort()).toEqual(["a/x", "a/y", "b/x", "b/y"]);
  });

  it("all three axes cross-product correctly", () => {
    const { cells } = expandMatrix({ baselines: ["a"], models: ["x", "y"], skill_dirs: ["p", "q"] }, 16);
    expect(cells).toHaveLength(4);
  });

  it("an empty matrix (no axes at all) produces exactly one cell with all axes undefined", () => {
    const { cells, totalBeforeCap, truncated } = expandMatrix({}, 16);
    expect(cells).toHaveLength(1);
    expect(cells[0].axes).toEqual({ baseline: undefined, model: undefined, skillDir: undefined });
    expect(totalBeforeCap).toBe(1);
    expect(truncated).toBe(false);
  });

  it("caps at maxCells and reports truncation + the real pre-cap total", () => {
    const { cells, truncated, totalBeforeCap } = expandMatrix({ baselines: ["a", "b", "c"], models: ["x", "y", "z"] }, 4);
    expect(cells).toHaveLength(4);
    expect(truncated).toBe(true);
    expect(totalBeforeCap).toBe(9);
  });

  it("does not truncate when the cross-product is exactly at the cap", () => {
    const { truncated } = expandMatrix({ baselines: ["a", "b"] }, 2);
    expect(truncated).toBe(false);
  });

  it("assigns stable, zero-based sequential indices to cells", () => {
    const { cells } = expandMatrix({ baselines: ["a", "b", "c"] }, 16);
    expect(cells.map((c) => c.index)).toEqual([0, 1, 2]);
  });
});

function cellResult(over: Partial<MatrixCellResult>): MatrixCellResult {
  return { index: 0, axes: {}, pass: true, failedAssertions: [], signals: [], ...over };
}

describe("buildMatrixRollup", () => {
  it("anyFail is false when every cell passes", () => {
    const rollup = buildMatrixRollup([cellResult({}), cellResult({ index: 1 })], 2, false);
    expect(rollup.anyFail).toBe(false);
  });

  it("anyFail is true when any cell fails an assertion", () => {
    const rollup = buildMatrixRollup([cellResult({}), cellResult({ index: 1, pass: false, failedAssertions: ["tool_called"] })], 2, false);
    expect(rollup.anyFail).toBe(true);
  });

  it("anyFail is true when any cell has an infra error (agent-binary-unavailable etc), distinct from an assertion failure", () => {
    const rollup = buildMatrixRollup([cellResult({ pass: false, error: "agent binary unavailable for baseline desktop-1.17377.2" })], 1, false);
    expect(rollup.anyFail).toBe(true);
    expect(rollup.cells[0].error).toContain("agent binary unavailable");
    expect(rollup.cells[0].failedAssertions).toEqual([]); // an infra error is not an assertion failure
  });

  it("carries requested/ranCells/truncated through from expandMatrix's cap", () => {
    const rollup = buildMatrixRollup([cellResult({})], 9, true);
    expect(rollup.requested).toBe(9);
    expect(rollup.ranCells).toBe(1);
    expect(rollup.truncated).toBe(true);
  });
});

describe("formatMatrixRollup — text rendering", () => {
  it("renders one line per cell with axes, pass/fail, and cost", () => {
    const rollup = buildMatrixRollup(
      [cellResult({ axes: { baseline: "desktop-1.18286.0", model: "claude-opus-4-8" }, costUsd: 0.05, durationMs: 12000, effectiveFidelity: "container" })],
      1,
      false,
    );
    const lines = formatMatrixRollup(rollup);
    const joined = lines.join("\n");
    expect(joined).toContain("desktop-1.18286.0");
    expect(joined).toContain("claude-opus-4-8");
    expect(joined).toContain("0.05");
  });

  it("renders a distinct 'cell error' line for an infra failure, not a fake assertion failure", () => {
    const rollup = buildMatrixRollup([cellResult({ pass: false, error: "agent binary unavailable" })], 1, false);
    const joined = formatMatrixRollup(rollup).join("\n");
    expect(joined).toMatch(/cell error/i);
    expect(joined).toContain("agent binary unavailable");
  });

  it("does NOT repeat the truncation warning — that's emitted once at expansion time in cli.ts (before " +
    "any cell runs, so it fires in both --output-format modes), not duplicated here per-render", () => {
    const rollup = buildMatrixRollup([cellResult({})], 9, true);
    const joined = formatMatrixRollup(rollup).join("\n");
    expect(joined).not.toMatch(/truncat/i);
    // the underlying data the CLI-level warning is built from is still on the rollup itself
    expect(rollup.truncated).toBe(true);
    expect(rollup.requested).toBe(9);
  });
});

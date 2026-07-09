import { describe, it, expect } from "vitest";
import {
  MatrixFile,
  expandMatrix,
  buildMatrixRollup,
  formatMatrixRollup,
  buildMatrixRepeatRollup,
  formatMatrixRepeatRollup,
  type MatrixCellResult,
  type MatrixCellRepeatResult,
} from "../src/run/matrix.js";
import { buildRepeatRollup } from "../src/run/repeat.js";
import type { RunResult } from "../src/types.js";

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
    const rollup = buildMatrixRollup(
      [cellResult({ pass: false, error: "agent binary unavailable for baseline desktop-1.17377.2" })],
      1,
      false,
    );
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

  it(
    "anyFail is true when truncated is true and allowTruncated is omitted, even though every executed " +
      "cell passes — incomplete is not green, the un-run cells are an unknown, not a pass",
    () => {
      const rollup = buildMatrixRollup([cellResult({}), cellResult({ index: 1 })], 9, true);
      expect(rollup.cells.every((c) => c.pass)).toBe(true);
      expect(rollup.anyFail).toBe(true);
    },
  );

  it("anyFail stays true when truncated is true and allowTruncated is explicitly false, all cells passing", () => {
    const rollup = buildMatrixRollup([cellResult({})], 9, true, false);
    expect(rollup.anyFail).toBe(true);
  });

  it("anyFail is false when truncated is true but allowTruncated is true (opt-out honored) and all cells pass", () => {
    const rollup = buildMatrixRollup([cellResult({}), cellResult({ index: 1 })], 9, true, true);
    expect(rollup.anyFail).toBe(false);
  });

  it("truncated:true + allowTruncated:true still fails if an executed cell itself fails", () => {
    const rollup = buildMatrixRollup([cellResult({ pass: false, failedAssertions: ["tool_called"] })], 9, true, true);
    expect(rollup.anyFail).toBe(true);
  });

  it("control: truncated:false + all cells pass ⇒ anyFail is false (no truncation penalty applies)", () => {
    const rollup = buildMatrixRollup([cellResult({}), cellResult({ index: 1 })], 2, false);
    expect(rollup.truncated).toBe(false);
    expect(rollup.anyFail).toBe(false);
  });
});

describe("formatMatrixRollup — text rendering", () => {
  it("renders one line per cell with axes, pass/fail, and cost", () => {
    const rollup = buildMatrixRollup(
      [
        cellResult({
          axes: { baseline: "desktop-1.18286.0", model: "claude-opus-4-8" },
          costUsd: 0.05,
          durationMs: 12000,
          effectiveFidelity: "container",
        }),
      ],
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

  it(
    "does NOT repeat the truncation warning — that's emitted once at expansion time in cli.ts (before " +
      "any cell runs, so it fires in both --output-format modes), not duplicated here per-render",
    () => {
      const rollup = buildMatrixRollup([cellResult({})], 9, true);
      const joined = formatMatrixRollup(rollup).join("\n");
      expect(joined).not.toMatch(/truncat/i);
      // the underlying data the CLI-level warning is built from is still on the rollup itself
      expect(rollup.truncated).toBe(true);
      expect(rollup.requested).toBe(9);
    },
  );
});

// --matrix + --repeat composition: each cell becomes its own repeat batch, not a single run.
function rr(over: Partial<RunResult>): RunResult {
  return {
    scenario: "t",
    fidelity: "container",
    baseline: "x",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
    ...over,
  };
}
function cellRepeatResult(over: Partial<MatrixCellRepeatResult>): MatrixCellRepeatResult {
  return { index: 0, axes: {}, ...over };
}

describe("buildMatrixRepeatRollup", () => {
  it("anyFail is false when every cell's rollup passes at the given minPassRate", () => {
    const rollup = buildMatrixRepeatRollup(
      [
        cellRepeatResult({ rollup: buildRepeatRollup("t", 2, [rr({}), rr({})]) }),
        cellRepeatResult({ index: 1, rollup: buildRepeatRollup("t", 2, [rr({}), rr({})]) }),
      ],
      2,
      false,
      1.0,
    );
    expect(rollup.anyFail).toBe(false);
  });

  it("anyFail is true when any cell's rollup fails rollupPasses at the given minPassRate", () => {
    const rollup = buildMatrixRepeatRollup(
      [cellRepeatResult({ rollup: buildRepeatRollup("t", 2, [rr({}), rr({ result: "error" })]) })], // 1/2 = 0.5
      1,
      false,
      1.0, // requires 100% — this cell's 50% fails it
    );
    expect(rollup.anyFail).toBe(true);
  });

  it("anyFail is true when any cell has a pre-execution infra error (no rollup at all — never got to run)", () => {
    const rollup = buildMatrixRepeatRollup(
      [cellRepeatResult({ error: "skill_dirs axis requires exactly one plugins.local_plugins entry" })],
      1,
      false,
      1.0,
    );
    expect(rollup.anyFail).toBe(true);
    expect(rollup.cells[0].rollup).toBeUndefined();
  });

  it("respects minPassRate per cell, same as standalone --repeat", () => {
    const rollup = buildMatrixRepeatRollup(
      [cellRepeatResult({ rollup: buildRepeatRollup("t", 4, [rr({}), rr({}), rr({}), rr({ result: "error" })]) })], // 3/4 = 0.75
      1,
      false,
      0.75,
    );
    expect(rollup.anyFail).toBe(false); // meets the threshold exactly
  });

  it("carries requested/ranCells/truncated through, same as the plain matrix rollup", () => {
    const rollup = buildMatrixRepeatRollup([cellRepeatResult({ rollup: buildRepeatRollup("t", 2, [rr({})]) })], 9, true, 1.0);
    expect(rollup.requested).toBe(9);
    expect(rollup.ranCells).toBe(1);
    expect(rollup.truncated).toBe(true);
  });
});

describe("formatMatrixRepeatRollup — text rendering", () => {
  it("renders each cell's own repeat rollup summary (pass rate, axes)", () => {
    const rollup = buildMatrixRepeatRollup(
      [
        cellRepeatResult({
          axes: { model: "claude-opus-4-8" },
          rollup: buildRepeatRollup("t", 4, [rr({}), rr({}), rr({}), rr({ result: "error" })]),
        }),
      ],
      1,
      false,
      0.5,
    );
    const joined = formatMatrixRepeatRollup(rollup, 0.5).join("\n");
    expect(joined).toContain("claude-opus-4-8");
    expect(joined).toContain("3/4"); // 3 passes out of 4 completed
  });

  it("renders a distinct 'cell error' line for a pre-execution infra failure, not a fake rollup", () => {
    const rollup = buildMatrixRepeatRollup([cellRepeatResult({ error: "agent binary unavailable" })], 1, false, 1.0);
    const joined = formatMatrixRepeatRollup(rollup, 1.0).join("\n");
    expect(joined).toMatch(/cell error/i);
    expect(joined).toContain("agent binary unavailable");
  });

  it("surfaces a stoppedEarly reason (e.g. an unanswered gate mid-batch) per cell", () => {
    const rollup = buildMatrixRepeatRollup(
      [cellRepeatResult({ rollup: buildRepeatRollup("t", 10, [rr({})], "unanswered") })],
      1,
      false,
      1.0,
    );
    const joined = formatMatrixRepeatRollup(rollup, 1.0).join("\n");
    expect(joined).toMatch(/unanswered/i);
  });
});

// replayMetrics: the frozen declaration is validated (the cassette reader is lenient), an empty or absent one gives
// no metrics, and a cassette with no artifact manifest (no work tree) is pruned and warned about. Synthetic data only.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayMetrics } from "../src/run/cassette.js";

const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
afterEach(() => err.mockClear());
const said = () => err.mock.calls.map((c) => String(c[0])).join("");
const decl = { id: "words", artifact: "outputs/m.json", path: "words", better: "higher", scale: 10 };

describe("replayMetrics", () => {
  it("absent or empty: no metrics, nothing said", () => {
    expect(replayMetrics({ workRoot: "", userVisiblePrefixes: [] }, undefined)).toBeUndefined();
    expect(replayMetrics({ workRoot: "", userVisiblePrefixes: [] }, [])).toBeUndefined();
    expect(said()).toBe("");
  });
  it("an invalid frozen declaration: skipped loudly", () => {
    expect(replayMetrics({ workRoot: "", userVisiblePrefixes: [] }, [{ ...decl, scale: undefined }])).toBeUndefined();
    expect(said()).toMatch(/\[replay\] metrics: the cassette's frozen metrics declaration is invalid/);
  });
  it("no pre-run manifest: no_manifest, warned with a re-run or re-record as the remedy (either arms the manifest)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "replay-nm-")));
    try {
      mkdirSync(join(root, "outputs"));
      writeFileSync(join(root, "outputs", "m.json"), '{"words":3}');
      expect(replayMetrics({ workRoot: root, userVisiblePrefixes: ["outputs"] }, [decl])).toEqual([
        { id: "words", unavailable: "no_manifest" },
      ]);
      expect(said()).toMatch(
        /\[replay\] metrics: 1\/1 not measurable from this cassette \(words: no_manifest — no pre-run manifest for this run\/cassette .*; re-run or re-record the case with the metric declared: declaring a metric arms the pre-run manifest, which a cassette keeps/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("no artifact manifest: pruned, and warned", () => {
    expect(replayMetrics({ workRoot: "", userVisiblePrefixes: [] }, [decl])).toEqual([{ id: "words", unavailable: "pruned" }]);
    expect(said()).toMatch(
      /\[replay\] metrics: 1\/1 not measurable from this cassette \(words: pruned — there is no work tree to read; re-record: the recording kept no artifact manifest\)/,
    );
  });
});

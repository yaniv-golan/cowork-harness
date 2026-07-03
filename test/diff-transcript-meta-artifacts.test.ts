import { describe, it, expect } from "vitest";
import { diffTranscript, diffMeta, diffArtifacts } from "../src/run/diff.js";

describe("diffTranscript — line-based, normalization-aware", () => {
  it("identical transcripts produce all 'same' lines", () => {
    const t = "line one\nline two";
    const ops = diffTranscript(t, t);
    expect(ops.every((o) => o.op === "same")).toBe(true);
  });

  it("transcripts differing only in volatile content (a toolu_ id) diff as identical after normalization", () => {
    const a = "ran toolu_AAA111 successfully";
    const b = "ran toolu_BBB222 successfully";
    const ops = diffTranscript(a, b);
    expect(ops.every((o) => o.op === "same")).toBe(true);
  });

  it("a genuinely added line is reported as 'added'", () => {
    const ops = diffTranscript("line one", "line one\nline two");
    expect(ops.map((o) => o.op)).toEqual(["same", "added"]);
  });

  it("a genuinely removed line is reported as 'removed'", () => {
    const ops = diffTranscript("line one\nline two", "line one");
    expect(ops.map((o) => o.op)).toEqual(["same", "removed"]);
  });
});

describe("diffMeta — result/fidelity/baseline/verdict deltas", () => {
  it("reports no entries when meta is identical", () => {
    const meta = { result: "success", effectiveFidelity: "container", baseline: "desktop-1.18286.0", assertionsPassed: true };
    expect(diffMeta(meta, meta)).toEqual([]);
  });

  it("reports a changed result field", () => {
    const a = { result: "success", baseline: "desktop-1.18286.0", assertionsPassed: true };
    const b = { result: "error", baseline: "desktop-1.18286.0", assertionsPassed: true };
    const entries = diffMeta(a, b);
    expect(entries).toContainEqual({ field: "result", from: "success", to: "error" });
  });

  it("reports a changed assertion-verdict outcome distinctly from a fidelity/baseline change", () => {
    const a = { result: "success", baseline: "desktop-1.17377.2", assertionsPassed: true };
    const b = { result: "success", baseline: "desktop-1.18286.0", assertionsPassed: false };
    const entries = diffMeta(a, b);
    expect(entries).toContainEqual({ field: "baseline", from: "desktop-1.17377.2", to: "desktop-1.18286.0" });
    expect(entries).toContainEqual({ field: "assertionsPassed", from: true, to: false });
  });
});

describe("diffArtifacts — wraps the exported cassette manifest differ", () => {
  it("reports no changes for identical manifests", () => {
    const m: Array<[string, string]> = [["outputs/x.md", "abc123"]];
    expect(diffArtifacts(m, m)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("reports an added, removed, and changed file", () => {
    const a: Array<[string, string]> = [
      ["outputs/same.md", "h1"],
      ["outputs/gone.md", "h2"],
      ["outputs/edited.md", "h3"],
    ];
    const b: Array<[string, string]> = [
      ["outputs/same.md", "h1"],
      ["outputs/new.md", "h4"],
      ["outputs/edited.md", "h3-changed"],
    ];
    const d = diffArtifacts(a, b);
    expect(d.added).toEqual(["outputs/new.md"]);
    expect(d.removed).toEqual(["outputs/gone.md"]);
    expect(d.changed).toEqual(["outputs/edited.md"]);
  });
});

import { describe, it, expect } from "vitest";
import { diffToolSequence, type NormalizedToolRow } from "../src/run/diff.js";

const row = (name: string, canon: string): NormalizedToolRow => ({ name, canon });

describe("diffToolSequence — LCS-based tool-call sequence diff", () => {
  it("identical sequences produce all 'same' ops", () => {
    const a = [row("Read", "{}"), row("Write", '{"path":"x"}')];
    const b = [row("Read", "{}"), row("Write", '{"path":"x"}')];
    const ops = diffToolSequence(a, b);
    expect(ops.every((o) => o.op === "same")).toBe(true);
    expect(ops).toHaveLength(2);
  });

  it("an added tool call at the end is one 'added' op after the matched prefix", () => {
    const a = [row("Read", "{}")];
    const b = [row("Read", "{}"), row("Write", "{}")];
    const ops = diffToolSequence(a, b);
    expect(ops.map((o) => o.op)).toEqual(["same", "added"]);
  });

  it("a removed tool call is one 'removed' op", () => {
    const a = [row("Read", "{}"), row("Write", "{}")];
    const b = [row("Read", "{}")];
    const ops = diffToolSequence(a, b);
    expect(ops.map((o) => o.op)).toEqual(["same", "removed"]);
  });

  it("the SAME tool name with a DIFFERENT canonicalized input at the same position is one 'changed' op, not remove+add", () => {
    const a = [row("Write", '{"path":"old.md"}')];
    const b = [row("Write", '{"path":"new.md"}')];
    const ops = diffToolSequence(a, b);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("changed");
  });

  it("a renamed tool (different name) at the same position is removed+added, not 'changed'", () => {
    const a = [row("Bash", "{}")];
    const b = [row("Write", "{}")];
    const ops = diffToolSequence(a, b);
    expect(ops.map((o) => o.op).sort()).toEqual(["added", "removed"]);
  });

  it("two empty sequences produce no ops", () => {
    expect(diffToolSequence([], [])).toEqual([]);
  });

  it("preserves relative order — a common tool before and after an insertion is still two 'same' ops flanking the 'added'", () => {
    const a = [row("Read", "{}"), row("Write", "{}")];
    const b = [row("Read", "{}"), row("Bash", "{}"), row("Write", "{}")];
    const ops = diffToolSequence(a, b);
    expect(ops.map((o) => o.op)).toEqual(["same", "added", "same"]);
  });
});

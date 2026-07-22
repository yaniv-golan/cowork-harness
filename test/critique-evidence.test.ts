import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  snapshotTurnBoundary,
  readTurn1Slice,
  readTurn1Result,
  citationResolves,
  validateCitations,
  type CritiqueItem,
} from "../src/critique/evidence";

describe("turn-1 evidence slicing (uncontaminated ground truth)", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "cwh-crit-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads only the task turn's events, not the reflection turn's appends", () => {
    const turn1 = '{"t":"init"}\n{"t":"read","path":"references/tiers.md"}\n';
    writeFileSync(join(dir, "events.jsonl"), turn1);
    const boundary = snapshotTurnBoundary(dir); // captured BEFORE the reflection turn
    // reflection turn appends more (e.g. it re-reads a file to critique it)
    writeFileSync(join(dir, "events.jsonl"), turn1 + '{"t":"read","path":"references/answers.md"}\n');
    const sliced = readTurn1Slice(dir, "events.jsonl", boundary);
    expect(sliced).toBe(turn1);
    expect(sliced).not.toContain("answers.md"); // the reflection turn's read is excluded
  });

  it("reads turns/1/result.json — the single addressable turn-1 file, never a later turn's", () => {
    // Single shape: turn 1 always lives at turns/1/result.json, whether or not the session ever resumed.
    // No more root-file-is-turn-1-until-archived distinction to fall back through.
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(join(dir, "turns", "1", "result.json"), JSON.stringify({ turn: 1, from: "turn1" }));
    expect((readTurn1Result(dir) as { from: string }).from).toBe("turn1");
    // A later turn's result.json (e.g. the reflection turn's) must never be substituted for turn 1's.
    mkdirSync(join(dir, "turns", "2"), { recursive: true });
    writeFileSync(join(dir, "turns", "2", "result.json"), JSON.stringify({ turn: 2, from: "turn2" }));
    expect((readTurn1Result(dir) as { from: string }).from).toBe("turn1");
  });
});

describe("mechanical citation grounding", () => {
  const pkg = "## Transcript\nThe agent read references/tiers.md and then chose the container fidelity tier.";

  it("resolves a verbatim excerpt (whitespace-insensitive) and rejects a hallucinated one", () => {
    expect(citationResolves(pkg, "read references/tiers.md")).toBe(true);
    expect(citationResolves(pkg, "read\n  references/tiers.md")).toBe(true); // whitespace differs
    expect(citationResolves(pkg, "never consulted the tier table")).toBe(false); // not in the package
  });

  it("rejects trivially-short citations that would match by accident", () => {
    expect(citationResolves(pkg, "the")).toBe(false);
  });

  it("drops (flags) an item whose citation doesn't resolve, but keeps not-adjudicable uncited", () => {
    const items: CritiqueItem[] = [
      {
        source: "self-report",
        idea: "add tier guidance",
        classification: "grounded-and-actionable",
        evidence: "read references/tiers.md",
        recommendedAction: "note it",
      },
      {
        source: "self-report",
        idea: "the intro is confusing",
        classification: "confabulated",
        evidence: "the agent said the intro made no sense",
        recommendedAction: "none",
      },
      {
        source: "evaluator",
        idea: "unclear whether SKILL.md guidance was reached",
        classification: "not-adjudicable",
        evidence: "",
        recommendedAction: "human review",
      },
    ];
    const validated = validateCitations(items, pkg);
    expect(validated[0].citationResolved).toBe(true); // real excerpt
    expect(validated[1].citationResolved).toBe(false); // hallucinated → flagged
    expect(validated[2].citationResolved).toBe(true); // not-adjudicable needs no citation
  });
});

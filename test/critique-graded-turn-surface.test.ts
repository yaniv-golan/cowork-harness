import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildJsonReport, buildTextReport } from "../src/critique/command.js";

// THE FOOTGUN THIS CLOSES. `critique` runs two turns into ONE run directory. After the resume,
// `result.json` is the REFLECTION turn's result and the graded turn is archived as `result.turn-1.json`
// — so the correct file to read is the LOWER-numbered one, the opposite of every other multi-run
// convention. A consumer building a sweep on `result.json.outcome` gets the reflection turn's number:
// valid-looking, wrong, and silent.
//
// Documenting it only helps a reader who already knows to look. So the graded turn's facts are surfaced
// in the report itself (no turn file needed) and also written under a stable `result.graded.json`.

const state = {
  skillFolder: "./s",
  prompt: "p",
  sessionId: "sess-1",
  outDir: "/runs/x",
  taskResult: "success" as const,
  gradedOutcome: "delivered_clean",
  gradedSkillHash: "abcdef0123456789",
  selfReportStatus: "captured" as const,
  items: [],
  requestedModel: "m",
};

describe("the graded turn's facts are readable without opening a turn file", () => {
  it("JSON report carries gradedOutcome + gradedSkillHash", () => {
    const j = buildJsonReport(state);
    expect(j.gradedOutcome).toBe("delivered_clean");
    expect(j.gradedSkillHash).toBe("abcdef0123456789");
  });

  it("they ride on EVERY branch, including infra failure", () => {
    // The infra-failure branches are exactly where knowing which skill generation was graded matters
    // most, so these must not be success-path-only.
    const j = buildJsonReport({ ...state, infraFailure: "reflection protocol broke", items: [] });
    expect(j.gradedOutcome, "gradedOutcome vanished on the infra-failure branch").toBe("delivered_clean");
    expect(j.gradedSkillHash, "gradedSkillHash vanished on the infra-failure branch").toBe("abcdef0123456789");
  });

  it("the text report shows them too", () => {
    const t = buildTextReport(state);
    expect(t).toMatch(/graded outcome: delivered_clean/);
    expect(t).toMatch(/graded skillHash: abcdef012345/);
  });

  it("omits them cleanly when the envelope never provided them", () => {
    // A task turn whose envelope was unavailable has no graded facts. An absent key is the honest
    // reading; inventing a placeholder would be worse than saying nothing.
    const t = buildTextReport({ ...state, gradedOutcome: undefined, gradedSkillHash: undefined });
    expect(t).not.toMatch(/graded outcome:/);
    expect(t).not.toMatch(/graded skillHash:/);
  });
});

describe("the stable-named graded result is written before the resume can rename it", () => {
  const SRC = readFileSync(resolve("src/critique/command.ts"), "utf8");

  it("copies result.json -> result.graded.json at the task turn, not after the reflection", () => {
    // Ordering is the whole point: at this moment `result.json` IS turn 1. Copying the ARCHIVED
    // `result.turn-1.json` after the reflection would also lose the file whenever the reflection turn
    // never completes. Pin the source of the copy so a later refactor cannot quietly invert it.
    const copyIdx = SRC.indexOf('copyFileSync(live, join(outDir, "result.graded.json"))');
    const reflectIdx = SRC.indexOf("const reflect = await runSkillTurn(buildReflectionTurnArgs");
    expect(copyIdx, "the result.graded.json copy is gone").toBeGreaterThan(-1);
    expect(reflectIdx, "the reflection-turn spawn moved — re-anchor this guard").toBeGreaterThan(-1);
    expect(copyIdx, "result.graded.json must be written BEFORE the reflection turn renames result.json").toBeLessThan(reflectIdx);
  });

  it("the copy is best-effort and cannot fail a critique that otherwise ran", () => {
    const around = SRC.slice(SRC.indexOf("result.graded.json") - 400, SRC.indexOf("result.graded.json") + 400);
    expect(around, "the convenience copy must be wrapped in try/catch").toMatch(/try\s*\{/);
  });
});

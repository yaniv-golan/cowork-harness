import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPartialResult } from "../src/run/execute.js";
import type { RunRecord } from "../src/run/run.js";

/** A minimal in-progress RunRecord, as `Run.partial()` would return after a gate throw. */
function partialRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-x",
    result: "error",
    initTools: [],
    transcript: "I read the PDF and extracted the cap table.",
    toolsCalled: new Set(["Read"]),
    toolCounts: { Read: 1 },
    subagentTools: new Set(),
    subagents: [],
    questions: [],
    decisions: [{ kind: "tool", name: "Read", decision: "allow", by: "parity" }],
    permissiveAutoAllow: [],
    unanswered: [],
    toolResults: [],
    gateAnswers: [],
    gateDeliveries: [],
    skillsInvoked: [],
    models: [],
    thinking: [],
    thinkingElided: 0,
    toolErrors: {},
    redundantToolCalls: [],
    tasks: new Map(),
    context: { tools: [], mcpServers: [] },
    ...over,
  };
}

/** A run dir whose work tree already holds one artifact the agent wrote before the gate whiffed. */
function runDirWithArtifact(): { outDir: string; workRoot: string; configDir: string } {
  const outDir = mkdtempSync(join(tmpdir(), "cwh-partial-"));
  const workRoot = join(outDir, "work", "session", "mnt");
  const configDir = join(outDir, "claude-config");
  mkdirSync(join(workRoot, "outputs"), { recursive: true });
  writeFileSync(join(workRoot, "outputs", "actions.md"), "# pre-failure deliverable\n");
  return { outDir, workRoot, configDir };
}

describe("buildPartialResult — salvage a whiffed run", () => {
  it("marks the run partial, records the unanswered gate, and keeps the pre-failure artifacts", () => {
    const { outDir, workRoot, configDir } = runDirWithArtifact();
    const result = buildPartialResult({
      scenarioName: "cap-table",
      prompt: "extract the cap table",
      fidelity: "container",
      baseline: "desktop-1.13576.1",
      record: partialRecord(),
      outDir,
      workRoot,
      configDir,
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      effectiveFidelity: "container",
      egress: [],
      durationMs: 1234,
      unanswered: { message: 'unscripted AskUserQuestion (on_unanswered=fail):\n  • "Confirm?"', hint: "add --answer" },
    });

    expect(result.partial).toBe(true);
    expect(result.result).toBe("error");
    expect(result.unansweredGate?.message).toContain("Confirm?");
    expect(result.unansweredGate?.hint).toBe("add --answer");
    // the work done before the whiff is salvaged, not discarded
    expect(result.artifacts?.map((a) => a.path)).toEqual(["outputs/actions.md"]);
    expect(result.artifacts?.[0].bytes).toBeGreaterThan(0);
    // a partial run has no meaningful assertion outcome
    expect(result.assertions).toEqual([]);
    // forensic context survives
    expect(result.workDir).toBe(workRoot);
    expect(result.toolCounts).toEqual({ Read: 1 });
  });

  it("omits the hint key when the gate carried none", () => {
    const { outDir, workRoot, configDir } = runDirWithArtifact();
    const result = buildPartialResult({
      scenarioName: "s",
      prompt: "p",
      fidelity: "container",
      baseline: "b",
      record: partialRecord(),
      outDir,
      workRoot,
      configDir,
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      effectiveFidelity: "container",
      egress: [],
      durationMs: 1,
      unanswered: { message: "m" },
    });
    expect(result.unansweredGate).toEqual({ message: "m" });
  });

  // T3: a `mode: r` connected-folder input is an INPUT, not a deliverable — `RunResult.artifacts`
  // excludes it (so `scaffold` doesn't emit `file_exists` for it) while `userVisibleRoots` still lists
  // the folder (so `no_unexpected_files` / `computer_links_resolve` keep enumerating it).
  it("excludes a readonlyFolderRoots entry from `artifacts` while keeping it in `userVisibleRoots`", () => {
    const { outDir, workRoot, configDir } = runDirWithArtifact();
    mkdirSync(join(workRoot, "carta-folder"), { recursive: true });
    writeFileSync(join(workRoot, "carta-folder", "synthetic_carta.xlsx"), "input content, not a deliverable");
    const result = buildPartialResult({
      scenarioName: "s",
      prompt: "p",
      fidelity: "container",
      baseline: "b",
      record: partialRecord(),
      outDir,
      workRoot,
      configDir,
      userVisibleRoots: ["outputs", "carta-folder"],
      readonlyFolderRoots: ["carta-folder"],
      effectiveFidelity: "container",
      egress: [],
      durationMs: 1,
      unanswered: { message: "m" },
    });
    expect(result.userVisibleRoots).toEqual(["outputs", "carta-folder"]);
    expect(result.readonlyFolderRoots).toEqual(["carta-folder"]);
    // the read-only input is NOT in artifacts (not a deliverable)...
    expect(result.artifacts?.map((a) => a.path)).toEqual(["outputs/actions.md"]);
    expect(result.artifacts?.some((a) => a.path.startsWith("carta-folder/"))).toBe(false);
  });
});

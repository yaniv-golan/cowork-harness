import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #54: a nested unreadable subtree (EACCES/EIO on a subdir) must collapse the persisted
// workspaceFiles/artifacts to UNAVAILABLE (undefined) — never a PARTIAL list that reads as complete.
// Previously every RunResult producer gated only on `rootAbsent`, so an authored file inside an
// unreadable subtree vanished with no signal and an absence-sensitive assertion (delivered_clean,
// file_exists) read it as absent — a silent false-clean. All three producers (run success, run partial,
// chat) now route through the single `trustedWorkspaceFiles` gate; this proves the gate collapses a
// partial walk and that the run-partial + chat lanes honor it.
//
// Arm-able node:fs.readdirSync EACCES, mirroring the established pattern in artifacts-evidence-health.test.ts
// (vi.spyOn can't redefine ESM named exports of node:fs — this repo uses vi.mock + importOriginal). Every
// call delegates to the REAL implementation unless the armed path matches, so nothing else is affected.
const hooks = vi.hoisted(() => ({ blockReaddirPath: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readdirSync: ((...args: unknown[]) => {
      if (hooks.blockReaddirPath && String(args[0]) === hooks.blockReaddirPath) {
        throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readdirSync as any)(...args);
    }) as typeof real.readdirSync,
  };
});

beforeEach(() => {
  hooks.blockReaddirPath = undefined;
});

// Imported AFTER the mock is declared (vi.mock hoists above imports regardless).
const { classifyWorkspaceFilesWithHealth, trustedWorkspaceFiles } = await import("../src/run/artifacts.js");
const { buildPartialResult } = await import("../src/run/execute.js");
const { buildChatResult } = await import("../src/run/chat-result.js");
type RunRecord = import("../src/run/run.js").RunRecord;

/** A well-formed RunRecord with the field set the Run constructor initializes (grep run.ts's ctor). */
function baseRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "r",
    result: "success",
    initTools: [],
    transcript: "ok",
    toolsCalled: new Set(["Read"]),
    toolCounts: { Read: 1 },
    filesRead: [],
    subagentTools: new Set(),
    subagents: [],
    questions: [],
    decisions: [],
    permissiveAutoAllow: [],
    unanswered: [],
    toolResults: [],
    gateAnswers: [],
    gateDeliveries: [],
    skillsInvoked: [],
    models: ["claude-x"],
    thinking: [],
    thinkingElided: 0,
    toolErrors: {},
    redundantToolCalls: [],
    tasks: new Map(),
    context: { tools: [], mcpServers: [] },
    contextEvents: [],
    mcpErrors: [],
    hookEvents: [],
    fileToolAttempts: [],
    pathDenials: [],
    presentedFiles: [],
    webSearches: [],
    infraErrors: [],
    evidenceErrors: { taskTracking: 0, webSearchParse: 0, presentFilesMalformed: 0 },
    ...over,
  } as RunRecord;
}

/** A work tree with a visible deliverable AND a nested subdir holding a second one. Blocking readdir on
 *  the nested subdir makes the walk PARTIAL: `outputs/visible.txt` is seen, `outputs/locked/hidden.md`
 *  never is — the exact shape that used to persist as a complete-looking list. */
function workTreeWithLockedSubtree(): { outDir: string; workRoot: string; lockedAbs: string } {
  const outDir = mkdtempSync(join(tmpdir(), "cwh-wwh-"));
  const workRoot = join(outDir, "work", "session", "mnt");
  mkdirSync(join(workRoot, "outputs", "locked"), { recursive: true });
  writeFileSync(join(workRoot, "outputs", "visible.txt"), "seen");
  writeFileSync(join(workRoot, "outputs", "locked", "hidden.md"), "# deliverable in an unreadable subtree\n");
  return { outDir, workRoot, lockedAbs: join(workRoot, "outputs", "locked") };
}

describe("#54: trustedWorkspaceFiles collapses an untrustworthy walk to UNAVAILABLE (undefined)", () => {
  it("returns the files when the whole tree was observed (rootAbsent:false, walkComplete:true)", () => {
    expect(
      trustedWorkspaceFiles({
        files: [{ path: "outputs/a", bytes: 1, class: "output" }],
        rootAbsent: false,
        walkComplete: true,
        walkErrors: [],
      }),
    ).toEqual([{ path: "outputs/a", bytes: 1, class: "output" }]);
  });
  it("returns undefined when the root was unobservable (#52 rootAbsent)", () => {
    expect(trustedWorkspaceFiles({ files: [], rootAbsent: true, walkComplete: true, walkErrors: [] })).toBeUndefined();
  });
  it("returns undefined when a nested subtree was unreadable (#54 !walkComplete), NOT the partial list", () => {
    const partial = [{ path: "outputs/visible.txt", bytes: 4, class: "output" as const }];
    expect(
      trustedWorkspaceFiles({
        files: partial,
        rootAbsent: false,
        walkComplete: false,
        walkErrors: [{ path: "outputs/locked", error: "EACCES" }],
      }),
    ).toBeUndefined();
  });
});

describe("#54: the real walk detects a nested unreadable subtree and the gate collapses it", () => {
  it("classifyWorkspaceFilesWithHealth reports walkComplete:false, and trustedWorkspaceFiles → undefined", () => {
    const { workRoot, lockedAbs } = workTreeWithLockedSubtree();
    hooks.blockReaddirPath = lockedAbs;
    const health = classifyWorkspaceFilesWithHealth(workRoot, ["outputs"], []);
    expect(health.rootAbsent).toBe(false);
    expect(health.walkComplete).toBe(false);
    expect(health.walkErrors).toEqual([{ path: "outputs/locked", error: "EACCES" }]);
    expect(health.files.map((f) => f.path)).toEqual(["outputs/visible.txt"]); // partial results still surface at the walk layer
    expect(trustedWorkspaceFiles(health)).toBeUndefined(); // ...but the persist gate refuses the partial list
  });
});

describe("#54: run PARTIAL lane (buildPartialResult) records UNAVAILABLE on a partial walk", () => {
  it("workspaceFiles and artifacts are undefined (not the partial [outputs/visible.txt]) when a subtree is unreadable", () => {
    const { outDir, workRoot, lockedAbs } = workTreeWithLockedSubtree();
    hooks.blockReaddirPath = lockedAbs;
    const result = buildPartialResult({
      scenarioName: "s",
      prompt: "p",
      fidelity: "container",
      baseline: "1.0",
      record: baseRecord({ result: "error" }),
      outDir,
      workRoot,
      configDir: join(outDir, "cfg"),
      pluginSkillRoots: [],
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      effectiveFidelity: "container",
      egress: [],
      durationMs: 1,
      unanswered: { message: "whiff" },
    });
    expect(result.workspaceFiles).toBeUndefined();
    expect(result.artifacts).toBeUndefined();
  });

  it("control: a fully-readable tree still persists the artifact (proves the mock isn't blanket-breaking the walk)", () => {
    const { outDir, workRoot } = workTreeWithLockedSubtree(); // no blockReaddirPath armed
    const result = buildPartialResult({
      scenarioName: "s",
      prompt: "p",
      fidelity: "container",
      baseline: "1.0",
      record: baseRecord({ result: "error" }),
      outDir,
      workRoot,
      configDir: join(outDir, "cfg"),
      pluginSkillRoots: [],
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      effectiveFidelity: "container",
      egress: [],
      durationMs: 1,
      unanswered: { message: "whiff" },
    });
    expect(result.artifacts?.map((a) => a.path).sort()).toEqual(["outputs/locked/hidden.md", "outputs/visible.txt"]);
  });
});

describe("#54: chat lane (buildChatResult) records UNAVAILABLE on a partial walk", () => {
  it("workspaceFiles and artifacts are undefined when a subtree is unreadable", () => {
    const { outDir, workRoot, lockedAbs } = workTreeWithLockedSubtree();
    hooks.blockReaddirPath = lockedAbs;
    const r = buildChatResult(baseRecord(), {
      scenario: "(chat)",
      prompt: "hi",
      fidelity: "container",
      baseline: "1.0",
      outDir,
      workRoot,
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      egress: [],
      durationMs: 1,
      turn: 1,
    });
    expect(r.workspaceFiles).toBeUndefined();
    expect(r.artifacts).toBeUndefined();
  });

  it("control: a fully-readable tree still persists the artifact", () => {
    const { outDir, workRoot } = workTreeWithLockedSubtree(); // no blockReaddirPath armed
    const r = buildChatResult(baseRecord(), {
      scenario: "(chat)",
      prompt: "hi",
      fidelity: "container",
      baseline: "1.0",
      outDir,
      workRoot,
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      egress: [],
      durationMs: 1,
      turn: 1,
    });
    expect(r.artifacts?.map((a) => a.path).sort()).toEqual(["outputs/locked/hidden.md", "outputs/visible.txt"]);
  });
});

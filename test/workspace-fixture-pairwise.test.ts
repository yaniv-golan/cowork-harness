// workspace_fixture × semantic_pairwise: the pairwise judge compares the document the run AUTHORED, so an
// untouched fixture file must never reach it; and a frozen reference store must never be readable by the agent,
// which it would be if it sat inside the fixture (the fixture is copied into outputs/). Synthetic data only.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnMock = vi.fn(() => ({ stdin: null, stdout: null, stderr: null }));
vi.mock("node:child_process", async (orig) => {
  const real = (await orig()) as typeof import("node:child_process");
  return { ...real, spawn: (...a: unknown[]) => (spawnMock as unknown as (...x: unknown[]) => unknown)(...a) };
});

import { scanWorkspaceFixture } from "../src/fixture/workspace.js";
import { spawnProtocol } from "../src/runtime/protocol.js";
import { readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { captureAuthoredFilesWithHealth } from "../src/run/artifacts.js";
import { authoredCaptureOpts } from "../src/run/authored-capture-opts.js";
import { executeScenario, scenarioArmsPreRunManifest } from "../src/run/execute.js";
import { candidateDocument } from "../src/run/pairwise-prepass.js";
import type { AssertContext } from "../src/assert.js";
import type { LaunchPlan } from "../src/session.js";
import type { Assertion, PlatformBaseline, Scenario } from "../src/types.js";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spawnMock.mockClear();
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubEnv("COWORK_HARNESS_GITSET", "0");
});
afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

const PAIRWISE: Assertion = { semantic_pairwise: { refs: ["refs/v1"] } } as Assertion;

describe("the semantic_pairwise candidate document never carries fixture-only content", () => {
  it("an untouched fixture file is absent from the judged candidate; a rewritten one and a new one are present", () => {
    const fixture = join(tmp("wsfp-"), "fx");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "scores.md"), "FIXTURE-ONLY-SCORES\n");
    writeFileSync(join(fixture, "draft.md"), "FIXTURE-DRAFT\n");
    const scenario = { assert: [PAIRWISE], workspace_fixture: fixture } as unknown as Scenario;
    const root = tmp("wsfp-plan-");
    mkdirSync(join(root, "config", "skills"), { recursive: true });
    const plan = {
      configDir: join(root, "config"),
      mcpConfig: null,
      mounts: [],
      pluginDirs: [],
      egressAllow: [],
      baseEnv: {},
      permissionMode: "default",
      permissionParity: "cowork",
      resume: false,
      capturePreRun: scenarioArmsPreRunManifest(scenario),
      workspaceFixture: scanWorkspaceFixture(fixture),
    } as unknown as LaunchPlan;
    expect(plan.capturePreRun).toBe(true);
    const outDir = join(tmp("wsfp-run-"), "run");
    spawnProtocol({ name: "fx" } as unknown as Scenario, {} as unknown as PlatformBaseline, plan, outDir);
    const work = join(outDir, "work");
    writeFileSync(join(work, "outputs", "draft.md"), "STEP-2-REWROTE-THE-DRAFT\n");
    writeFileSync(join(work, "outputs", "memo.md"), "STEP-2-NEW-MEMO\n");
    const { files } = captureAuthoredFilesWithHealth(
      work,
      ["outputs"],
      [],
      readPreRunManifestHashes(outDir),
      authoredCaptureOpts({ workRoot: work, runDir: outDir }),
    );
    const ctx = { transcript: "", finalMessage: "done", authoredFiles: files, subagents: [] } as unknown as AssertContext;
    const { candidate } = candidateDocument(ctx, PAIRWISE);
    expect(candidate).toContain("STEP-2-REWROTE-THE-DRAFT");
    expect(candidate).toContain("STEP-2-NEW-MEMO");
    expect(candidate).not.toContain("FIXTURE-ONLY-SCORES");
    expect(candidate).not.toContain("FIXTURE-DRAFT");
  });
});

describe("a frozen reference store must not sit inside the workspace_fixture", () => {
  it("is refused before the run spends anything (the fixture is copied into outputs/, where the agent reads)", async () => {
    vi.stubEnv("COWORK_HARNESS_RUNS_DIR", tmp("wsfp-runs-"));
    const fixture = join(tmp("wsfp-fx-"), "fx");
    mkdirSync(join(fixture, "refs", "v1"), { recursive: true });
    writeFileSync(join(fixture, "refs", "v1", "frozen.md"), "the reference answer");
    const scenario = {
      name: "pw",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      lane: "local",
      execution: "local",
      prompt: "p",
      answers: [],
      expect_denied: [],
      skills: [],
      requires_capabilities: [],
      assert: [{ semantic_pairwise: { refs: [join(fixture, "refs", "v1")] } }],
      workspace_fixture: fixture,
    } as unknown as Scenario;
    await expect(executeScenario(scenario, { modelOverride: "claude-test", semanticJudge: (async () => ({})) as never })).rejects.toThrow(
      /overlaps the mounted source/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

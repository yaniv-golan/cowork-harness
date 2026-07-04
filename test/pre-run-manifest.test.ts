import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchPlan } from "../src/session.js";
import { capturePreRunManifest, readPreRunManifest } from "../src/run/pre-run-manifest.js";
import { collectArtifacts } from "../src/run/artifacts.js";
import { snapshotHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { evaluate } from "../src/assert.js";

function minimalPlan(mounts: LaunchPlan["mounts"], resume = false): LaunchPlan {
  return {
    configDir: mkdtempSync(join(tmpdir(), "cwh-cfg-")),
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts,
    pluginDirs: [],
    egressAllow: [],
    resume,
    capturePreRun: true,
  };
}

describe("capturePreRunManifest", () => {
  it("records staged paths under workRoot for copy tiers", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-cap-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "seed.txt"), "x");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toEqual(["outputs/seed.txt"]);
  });

  it("does not overwrite an existing manifest on resume", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-resume-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(outDir, "pre-run-manifest.json"), JSON.stringify({ paths: ["outputs/run1.json"] }));
    writeFileSync(join(workRoot, "outputs", "run2.json"), "y");
    capturePreRunManifest(minimalPlan([], true), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toEqual(["outputs/run1.json"]);
  });

  it("resume without an existing manifest captures nothing (baseline stays absent, key fails loud later)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-resume-noop-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "run1.json"), "x");
    capturePreRunManifest(minimalPlan([], true), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toBeUndefined();
    expect(existsSync(join(outDir, "pre-run-manifest.json"))).toBe(false);
  });

  it("no capture when plan.capturePreRun is not set", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-nocapture-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "seed.txt"), "x");
    const plan: LaunchPlan = { ...minimalPlan([]), capturePreRun: false };
    capturePreRunManifest(plan, workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toBeUndefined();
  });

  it("collectArtifacts never returns pre-run-manifest.json (it lives above workRoot)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-manifest-guard-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "real.txt"), "hello");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    const paths = collectArtifacts(workRoot, ["outputs"]).map((f) => f.path);
    expect(paths).toContain("outputs/real.txt");
    expect(JSON.parse(readFileSync(join(outDir, "pre-run-manifest.json"), "utf8")).paths.join("|")).not.toContain("pre-run-manifest");
  });

  it("hostloop end-to-end: connected-folder pre/post diff flags exactly the stray file", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hl-e2e-"));
    const mntHost = join(outDir, "work", "session", "mnt");
    const hostFolder = mkdtempSync(join(tmpdir(), "cwh-host-folder-"));
    mkdirSync(join(mntHost, "outputs"), { recursive: true });
    writeFileSync(join(hostFolder, "input.pdf"), "pdf");

    const plan = minimalPlan([{ kind: "folder", hostPath: hostFolder, mountPath: ".projects/Acme", mode: "rw" }]);
    capturePreRunManifest(plan, mntHost, outDir, "hostloop");
    const pre = readPreRunManifest(outDir)!;
    expect(pre).toEqual([".projects/Acme/input.pdf"]);

    // Agent writes through the bind mount (allowed handoff + stray fabrication).
    writeFileSync(join(hostFolder, "allowed.json"), "{}");
    writeFileSync(join(hostFolder, "checklist.json"), "{}");

    snapshotHostLoopWorkspace(plan, mntHost);

    const [passing] = evaluate([{ no_unexpected_files: [".projects/Acme/input.pdf", ".projects/Acme/allowed.json"] }], {
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: mntHost,
      userVisiblePrefixes: ["outputs", ".projects/Acme"],
      preRunPaths: pre,
      outputsDeletes: [],
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
    });
    expect(passing.pass).toBe(false);
    const strayPart = passing.message!.split(" (allow:")[0]!;
    expect(strayPart).toMatch(/checklist\.json/);
    expect(strayPart).not.toMatch(/allowed\.json/);
    expect(strayPart).not.toMatch(/input\.pdf/);
  });

  it("hostloop baseline includes pre-existing hardlinked files (paths-only walk)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hl-hardlink-"));
    const mntHost = join(outDir, "work", "session", "mnt");
    const hostFolder = mkdtempSync(join(tmpdir(), "cwh-host-folder-"));
    mkdirSync(join(mntHost, "outputs"), { recursive: true });
    writeFileSync(join(hostFolder, "file1.txt"), "shared");
    linkSync(join(hostFolder, "file1.txt"), join(hostFolder, "file2.txt"));

    const plan = minimalPlan([{ kind: "folder", hostPath: hostFolder, mountPath: ".projects/Acme", mode: "rw" }]);
    capturePreRunManifest(plan, mntHost, outDir, "hostloop");
    const pre = readPreRunManifest(outDir)!;
    expect(pre).toEqual([".projects/Acme/file1.txt", ".projects/Acme/file2.txt"]);

    // Nothing touches the folder — the post-run snapshot copy should diff clean against the baseline
    // (regression: the old nlink>1 rejection would have dropped both paths from the baseline, so the
    // post-run copy — where every file lands at nlink=1 — would read as two agent-"created" strays).
    snapshotHostLoopWorkspace(plan, mntHost);

    const [passing] = evaluate([{ no_unexpected_files: [] }], {
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: mntHost,
      userVisiblePrefixes: ["outputs", ".projects/Acme"],
      preRunPaths: pre,
      outputsDeletes: [],
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
    });
    expect(passing.pass).toBe(true);
  });
});

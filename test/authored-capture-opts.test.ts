import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { authoredCaptureOpts } from "../src/run/authored-capture-opts.js";
import { capturePreRunManifest, readPreRunManifestStats } from "../src/run/pre-run-manifest.js";
import type { LaunchPlan } from "../src/session.js";

// The one derivation of the authored-capture options the live run and a kept-run re-grade share. Pinned
// directly: the parity tests elsewhere compare the builder AGAINST this function, so they cannot notice a
// change to what it returns.

function plan(): LaunchPlan {
  return {
    configDir: mkdtempSync(join(tmpdir(), "cwh-aco-cfg-")),
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    resume: false,
    capturePreRun: true,
  };
}

/** A run dir with a REAL pre-run manifest over a staged `…/session/mnt` tree. */
function runWithManifest(): { runDir: string; workRoot: string } {
  const runDir = mkdtempSync(join(tmpdir(), "cwh-aco-"));
  const workRoot = join(runDir, "work", "session", "mnt");
  mkdirSync(join(workRoot, "outputs"), { recursive: true });
  writeFileSync(join(workRoot, "outputs", "input.md"), "pre-existing\n");
  capturePreRunManifest(plan(), workRoot, runDir, "container");
  return { runDir, workRoot };
}

describe("authoredCaptureOpts", () => {
  it("minimal input: scratchpadRoot is the parent of a …/mnt root, preRunStats is the manifest's, nothing else", () => {
    const { runDir, workRoot } = runWithManifest();
    const stats = readPreRunManifestStats(runDir);
    expect(stats?.["outputs/input.md"], "the fixture manifest carries stats").toBeDefined();
    expect(authoredCaptureOpts({ workRoot, runDir })).toEqual({ scratchpadRoot: dirname(workRoot), preRunStats: stats });
  });

  it("scratchpadRoot is undefined for a work root that does not end in /mnt", () => {
    const { runDir } = runWithManifest();
    const o = authoredCaptureOpts({ workRoot: join(runDir, "work", "session", "mntx"), runDir });
    expect("scratchpadRoot" in o).toBe(true);
    expect(o.scratchpadRoot).toBeUndefined();
  });

  it("empty priorityGlobs and absent resume/totalBytes/perFileBytes are omitted, not set to undefined", () => {
    const { runDir, workRoot } = runWithManifest();
    expect(Object.keys(authoredCaptureOpts({ workRoot, runDir, priorityGlobs: [] })).sort()).toEqual(["preRunStats", "scratchpadRoot"]);
  });

  it("passes resume, priorityGlobs, totalBytes and perFileBytes through as given", () => {
    const { runDir, workRoot } = runWithManifest();
    const o = authoredCaptureOpts({ workRoot, runDir, resume: true, priorityGlobs: ["outputs/r.md"], totalBytes: 1234, perFileBytes: 56 });
    expect(o).toEqual({
      scratchpadRoot: dirname(workRoot),
      resume: true,
      preRunStats: readPreRunManifestStats(runDir),
      priorityGlobs: ["outputs/r.md"],
      totalBytes: 1234,
      perFileBytes: 56,
    });
    expect(authoredCaptureOpts({ workRoot, runDir, resume: false }).resume).toBe(false);
  });
});

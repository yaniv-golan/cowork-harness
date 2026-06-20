import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { runsWriteRoot, runsRoot, defaultRunsHome } from "../src/run/trace-view.js";

// Flat, out-of-tree default runs root + env override. Writer and reader resolve identically (no #45
// write/read drift), and the default is the absolute ~/.cowork-harness/runs — never cwd-relative, so a
// `trace <run-id>` resolves from any directory.
describe("runs root resolution (flat default; writer == reader)", () => {
  const prev = process.env.COWORK_HARNESS_RUNS_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
    else process.env.COWORK_HARNESS_RUNS_DIR = prev;
  });

  it("default (no env) is the flat ~/.cowork-harness/runs under homedir — NOT cwd-relative", () => {
    delete process.env.COWORK_HARNESS_RUNS_DIR;
    const def = join(homedir(), ".cowork-harness", "runs");
    expect(defaultRunsHome()).toBe(def);
    expect(runsWriteRoot()).toBe(def);
    expect(runsRoot()).toBe(def);
    expect(runsWriteRoot()).not.toBe(join(process.cwd(), "runs"));
  });

  it("the env override is honored by BOTH writer and reader", () => {
    process.env.COWORK_HARNESS_RUNS_DIR = "/tmp/custom-runs";
    expect(runsWriteRoot()).toBe("/tmp/custom-runs");
    expect(runsRoot()).toBe("/tmp/custom-runs");
  });

  it("writer and reader agree in both modes (no #45 drift)", () => {
    delete process.env.COWORK_HARNESS_RUNS_DIR;
    expect(runsWriteRoot()).toBe(runsRoot());
    process.env.COWORK_HARNESS_RUNS_DIR = "/tmp/drift-check";
    expect(runsWriteRoot()).toBe(runsRoot());
  });
});

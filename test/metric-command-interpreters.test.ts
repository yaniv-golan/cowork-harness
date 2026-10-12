// The Node permission flag by feature detection, and the shipped Python runner's place in the package.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodePermissionFlag } from "../src/metric-command/interpreters.js";
import { METRIC_RUNNER } from "../src/metric-command/run.js";

describe("Node permission flag", () => {
  it("--permission where the runtime lists it, --experimental-permission otherwise (22.0–22.12)", () => {
    expect(nodePermissionFlag(new Set(["--permission"]))).toBe("--permission");
    expect(nodePermissionFlag(new Set(["--experimental-permission"]))).toBe("--experimental-permission");
  });
  it("this runtime's choice is one it accepts", () => {
    expect(process.allowedNodeEnvironmentFlags.has(nodePermissionFlag())).toBe(true);
  });
});

describe("the shipped Python runner", () => {
  it("resolves to python/metric-runner.py, and the package ships python/", () => {
    expect(METRIC_RUNNER).toBe(join(process.cwd(), "python", "metric-runner.py"));
    expect(existsSync(METRIC_RUNNER)).toBe(true);
    const files = (JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] }).files;
    expect(files).toContain("python");
  });
  it("uses no syntax newer than Python 3.9 (no match statement, no runtime `X | Y` types)", () => {
    const src = readFileSync(METRIC_RUNNER, "utf8");
    expect(src).not.toMatch(/^\s*match\s+\S.*:\s*$/m);
    expect(src).not.toMatch(/:\s*\w+\s*\|\s*\w+\s*[=)]/);
  });
});

describe("a Python command metric needs python3 3.9+, refused at load (before any spend)", () => {
  it("loadRunnableScenario refuses when python3 is older than 3.9", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    const { loadRunnableScenario } = await import("../src/run/execute.js");
    const { resetInterpreterCache } = await import("../src/metric-command/interpreters.js");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pyfloor-")));
    const savedPath = process.env.PATH;
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin", "python3"), "#!/bin/sh\necho /usr/bin/python3.8\necho 3.8.10\n");
      chmodSync(join(root, "bin", "python3"), 0o755);
      mkdirSync(join(root, "repo", "metrics"), { recursive: true });
      writeFileSync(join(root, "repo", "metrics", "m.py"), "print(1)\n");
      writeFileSync(
        join(root, "repo", "s.yaml"),
        "fidelity: protocol\nprompt: hi\nmetrics:\n  - {id: n, command: [metrics/m.py], better: lower, unbounded: true}\n",
      );
      execFileSync("git", ["init", "-q"], { cwd: join(root, "repo") });
      execFileSync("git", ["add", "-A"], { cwd: join(root, "repo") });
      process.env.PATH = `${join(root, "bin")}:${savedPath}`;
      resetInterpreterCache();
      expect(() => loadRunnableScenario(join(root, "repo", "s.yaml"))).toThrow(/needs 3\.9 or later/);
    } finally {
      process.env.PATH = savedPath;
      resetInterpreterCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

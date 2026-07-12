import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveScenarioScript } from "../src/run/scenario-tool.js";

describe("scenario-tool — locates the bundled scenario.py", () => {
  it("returns an existing absolute path to scenario.py", () => {
    const p = resolveScenarioScript();
    expect(p.endsWith("scenario.py")).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});

// `cowork-harness lint-skill` is a thin passthrough to `python3 scenario.py lint-skill` (the same
// mechanism `cowork-harness lint` already uses — see cmdLint above). These tests drive the BUILT CLI
// (dist/cli.js — the `ci` script builds before testing) so the dispatch wiring in src/cli.ts is
// exercised end to end, not just the python linter directly (that's covered by skill-body-lint.test.ts).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

function runCli(args: string[], env?: Record<string, string>) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function writeFootgunSkill(dir: string) {
  const md = ["# Demo skill", "", "```bash", 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"', "```", ""].join("\n");
  writeFileSync(join(dir, "SKILL.md"), md);
}

function writeCleanSkill(dir: string) {
  const md = ["# Clean skill", "", "Read `${CLAUDE_PLUGIN_ROOT}/references/x.md` before you begin.", ""].join("\n");
  writeFileSync(join(dir, "SKILL.md"), md);
}

describe.skipIf(!can || !havePython)("cowork-harness lint-skill (CLI passthrough)", () => {
  it("a footgun fixture WITHOUT --strict exits 0 (the two footguns are WARN-only)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-warn-"));
    writeFootgunSkill(d);
    const { code, stdout } = runCli(["lint-skill", d]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/plugin-root-in-vm-bash/);
  });

  it("the same footgun fixture WITH --strict exits 1 and prints the finding", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-strict-"));
    writeFootgunSkill(d);
    const { code, stdout } = runCli(["lint-skill", d, "--strict"]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/plugin-root-in-vm-bash/);
  });

  it("a path with no SKILL.md/hooks.json is an ERROR → exit 1 even without --strict", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-empty-"));
    const { code, stdout } = runCli(["lint-skill", d]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/no SKILL\.md/);
  });

  it("a clean fixture skill exits 0 even with --strict", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-clean-"));
    writeCleanSkill(d);
    const { code } = runCli(["lint-skill", d, "--strict"]);
    expect(code).toBe(0);
  });

  it("a missing $PYTHON exits 127 with a clear message", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-nopy-"));
    writeCleanSkill(d);
    const { code, stderr } = runCli(["lint-skill", d], { PYTHON: "/does/not/exist" });
    expect(code).toBe(127);
    expect(stderr).toMatch(/not found/i);
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// The Action always appends `--output-format json` to every command it drives (action.yml), but
// python's `lint`/`lint-skill` only understand `--json` — this was the "lint lane broken in the Action"
// bug: argparse rejected `--output-format` (exit 2, empty stdout) → the wrapper's `ok` output came out
// false with no useful message. These tests drive the CLI wrapper (not python directly) to prove the
// flag gets translated/stripped and the harness's own envelope comes back well-formed.

function writeCleanScenario(dir: string, name = "demo") {
  const p = join(dir, `${name}.yaml`);
  writeFileSync(
    p,
    [
      "name: " + name,
      "baseline: latest",
      "fidelity: container",
      "on_unanswered: fail",
      "",
      "prompt: |",
      "  hello",
      "",
      "assert:",
      "  - result: success",
      "",
    ].join("\n"),
  );
  return p;
}

// Triggers a real (INFO-severity) lint finding — `user_visible_artifact` without an `artifacts`
// manifest — while still exiting 0 (INFO doesn't gate). Used to prove findings survive the json
// envelope wrap even on a clean (ok:true) exit.
function writeScenarioWithFinding(dir: string, name = "demo-finding") {
  const p = join(dir, `${name}.yaml`);
  writeFileSync(
    p,
    [
      "name: " + name,
      "baseline: latest",
      "fidelity: container",
      "on_unanswered: fail",
      "",
      "prompt: |",
      "  hello",
      "",
      "assert:",
      "  - result: success",
      '  - user_visible_artifact: "out.txt"',
      "",
    ].join("\n"),
  );
  return p;
}

describe.skipIf(!can || !havePython)("cowork-harness lint --output-format json (Action passthrough)", () => {
  it("a clean scenario → a well-formed jsonPayloadEnvelope with ok:true (not a python argparse error)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-json-clean-"));
    const scenario = writeCleanScenario(d);
    const { code, stdout } = runCli(["lint", scenario, "--output-format", "json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.tool).toBe("cowork-harness");
    expect(payload.command).toBe("lint");
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.findings)).toBe(true);
    expect(payload.findings).toHaveLength(0);
  });

  it("a scenario with a lint finding → the findings are present in the envelope (still ok:true, INFO doesn't gate)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-json-finding-"));
    const scenario = writeScenarioWithFinding(d);
    const { code, stdout } = runCli(["lint", scenario, "--output-format", "json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.findings.length).toBeGreaterThan(0);
    expect(payload.findings[0].rule).toBe("manifest-needs-snapshot");
  });

  it("the `--output-format=json` equals-form also works (stripped + translated the same way)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-json-eq-"));
    const scenario = writeCleanScenario(d);
    const { code, stdout } = runCli(["lint", scenario, "--output-format=json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(true);
  });

  it("an ERROR-severity finding (an empty scenario dir) → ok:false, mirroring the non-zero exit code", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-json-error-"));
    const emptyDir = join(d, "no-scenarios-here");
    mkdirSync(emptyDir);
    const { code, stdout } = runCli(["lint", emptyDir, "--output-format", "json"]);
    expect(code).not.toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.findings.length).toBeGreaterThan(0);
  });

  it("a python usage error (missing positional) in json mode → a jsonError envelope, not a crash", () => {
    // `lint --output-format json` with no scenario path forwards to `python3 scenario.py lint --json`
    // with no `files` positional — argparse's own hard requirement (nargs='+'), so it exits 2 with a
    // "usage: ..." message on stderr and EMPTY stdout. The wrapper must not let JSON.parse("") throw.
    const { code, stdout } = runCli(["lint", "--output-format", "json"]);
    expect(code).toBe(2);
    const payload = JSON.parse(stdout.trim());
    expect(payload.tool).toBe("cowork-harness");
    expect(payload.command).toBe("lint");
    expect(payload.ok).toBe(false);
    expect(payload.error).not.toBeNull();
    expect(payload.error.category).toBe("usage");
  });

  it("text mode `lint --output-format text` still works (the flag is stripped, not forwarded)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-text-"));
    const scenario = writeCleanScenario(d);
    const { code, stdout } = runCli(["lint", scenario, "--output-format", "text"]);
    expect(code).toBe(0);
    expect(stdout).not.toMatch(/unrecognized arguments/);
  });
});

describe.skipIf(!can || !havePython)("cowork-harness lint-skill --output-format json (Action passthrough)", () => {
  it("a footgun fixture → a well-formed jsonPayloadEnvelope with the finding present (still ok:true — WARN doesn't gate without --strict)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-json-warn-"));
    writeFootgunSkill(d);
    const { code, stdout } = runCli(["lint-skill", d, "--output-format", "json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.tool).toBe("cowork-harness");
    expect(payload.command).toBe("lint-skill");
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.findings)).toBe(true);
    expect(payload.findings.some((f: { rule: string }) => f.rule === "plugin-root-in-vm-bash")).toBe(true);
  });

  it("the same fixture WITH --strict → ok:false, mirroring the exit-1 gate", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-json-strict-"));
    writeFootgunSkill(d);
    const { code, stdout } = runCli(["lint-skill", d, "--strict", "--output-format", "json"]);
    expect(code).toBe(1);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.findings.length).toBeGreaterThan(0);
  });

  it("a clean fixture → ok:true, empty findings", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-json-clean-"));
    writeCleanSkill(d);
    const { code, stdout } = runCli(["lint-skill", d, "--output-format", "json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.findings).toHaveLength(0);
  });

  it("a python usage error (missing positional) in json mode → a jsonError envelope, not a crash", () => {
    const { code, stdout } = runCli(["lint-skill", "--output-format", "json"]);
    expect(code).toBe(2);
    const payload = JSON.parse(stdout.trim());
    expect(payload.command).toBe("lint-skill");
    expect(payload.ok).toBe(false);
    expect(payload.error.category).toBe("usage");
  });
});

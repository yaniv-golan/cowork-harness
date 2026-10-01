import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// `--ignore-rule` through the wrapper: its value must be forwarded as a value (never parsed as a global
// flag), the json envelope carries the `suppressed` record unchanged plus a `suppressedCount`, and the wrong
// sibling (`lint`) fails with a named error.
describe.skipIf(!can || !havePython)("cowork-harness lint-skill --ignore-rule (CLI passthrough)", () => {
  function writeBigSkill(dir: string) {
    writeFileSync(join(dir, "SKILL.md"), "# Big\n\n" + "x".repeat(19_001));
  }

  it("json: ok:true under --strict, the finding keeps suppressed.by=flag, suppressedCount:1", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-ignore-json-"));
    writeBigSkill(d);
    const { code, stdout } = runCli([
      "lint-skill",
      d,
      "--ignore-rule",
      "skill-body-over-reattach-cap",
      "--strict",
      "--output-format",
      "json",
    ]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.findings[0].rule).toBe("skill-body-over-reattach-cap");
    expect(payload.findings[0].suppressed.by).toBe("flag");
    expect(payload.suppressedCount).toBe(1);
  });

  it("text: the same invocation exits 0 and reports the suppression", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-ignore-text-"));
    writeBigSkill(d);
    const { code, stdout } = runCli(["lint-skill", d, "--ignore-rule", "skill-body-over-reattach-cap", "--strict"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/1 suppressed \(skill-body-over-reattach-cap ×1 by --ignore-rule\)/);
  });

  it("the `--ignore-rule=<value>` form is forwarded too", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-ignore-eq-"));
    writeBigSkill(d);
    const { code, stdout } = runCli(["lint-skill", d, "--ignore-rule=skill-body-over-reattach-cap", "--strict", "--output-format", "json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim()).suppressedCount).toBe(1);
  });

  it("an unknown rule is a usage error (exit 2)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-ignore-bad-"));
    writeBigSkill(d);
    const { code, stderr } = runCli(["lint-skill", d, "--ignore-rule", "nope"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown lint-skill rule: nope/);
  });

  it("`lint --ignore-rule` → exit 2 naming lint-skill as the owner", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-ignore-rule-"));
    const scenario = writeCleanScenario(d);
    const { code, stderr } = runCli(["lint", scenario, "--ignore-rule", "replay-noop"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--ignore-rule is a `lint-skill` flag; `lint` has no rule suppression/);
  });

  it("json without suppression: no suppressedCount key (the envelope is unchanged)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-ignore-none-"));
    writeFootgunSkill(d);
    const payload = JSON.parse(runCli(["lint-skill", d, "--output-format", "json"]).stdout.trim());
    expect(payload).not.toHaveProperty("suppressedCount");
  });
});

// `--suppressions FILE` / `--strict-ignores` through the wrapper: the file path is forwarded as a value, a
// relative path resolves against the caller's working directory, and the envelope counts file suppressions.
describe.skipIf(!can || !havePython)("cowork-harness lint-skill --suppressions (CLI passthrough)", () => {
  function setup(): { parent: string; sup: string } {
    const parent = mkdtempSync(join(tmpdir(), "cwh-lint-skill-sup-"));
    mkdirSync(join(parent, "big"));
    writeFileSync(join(parent, "big", "SKILL.md"), "# Big\n\n" + "x".repeat(19_001));
    const sup = join(parent, "suppressions.json");
    writeFileSync(
      sup,
      JSON.stringify({
        version: 1,
        suppressions: [{ rule: "skill-body-over-reattach-cap", file: "big/SKILL.md", reason: "accepted size" }],
      }),
    );
    return { parent, sup };
  }

  it("json: ok:true under --strict, suppressed.by=file with its source, suppressedCount:1", () => {
    const { parent, sup } = setup();
    const { code, stdout } = runCli(["lint-skill", join(parent, "big"), "--suppressions", sup, "--strict", "--output-format", "json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(true);
    expect(payload.findings[0].suppressed).toMatchObject({ by: "file", reason: "accepted size", source: `${sup}#0` });
    expect(payload.suppressedCount).toBe(1);
  });

  it("a relative path resolves against the caller's working directory", () => {
    const { parent } = setup();
    const r = spawnSync("node", [CLI, "lint-skill", "big", "--suppressions", "suppressions.json", "--strict"], {
      encoding: "utf8",
      cwd: parent,
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("--strict --strict-ignores fails on an entry that suppressed nothing", () => {
    const { parent, sup } = setup();
    writeFileSync(join(parent, "big", "SKILL.md"), "# Small\n");
    const { code, stdout } = runCli(["lint-skill", join(parent, "big"), "--suppressions", sup, "--strict", "--strict-ignores"]);
    expect(code).toBe(1);
    expect(stdout).toMatch(/⚠ WARN \[lint-skill-ignore-unused\]/);
  });

  it("a linter crash never exits 0: a SKILL.md that is not UTF-8 → nonzero, ok:false", () => {
    const { parent, sup } = setup();
    writeFileSync(join(parent, "big", "SKILL.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const { code, stdout } = runCli(["lint-skill", join(parent, "big"), "--suppressions", sup, "--output-format", "json"]);
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout.trim()).ok).toBe(false);
  });

  it("`lint --suppressions` → exit 2 naming lint-skill as the owner", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-sup-owner-"));
    const { code, stderr } = runCli(["lint", writeCleanScenario(d), "--suppressions", "x.json"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--suppressions is a `lint-skill` flag; `lint` has no rule suppression/);
  });
});

// `lint`/`lint-skill` previously accepted ANY `--output-format` value that wasn't literally "text" or
// "json" (and a valueless trailing `--output-format`) by silently falling through isJsonOutput's strict
// match into text mode — unlike every other command, which validates via parseOutputFormat and exits 2
// "expected one of text|json". These prove the wrapper now rejects it the same way.
describe.skipIf(!can || !havePython)("cowork-harness lint/lint-skill --output-format validation", () => {
  it("lint --output-format xml is a usage error (exit 2), not a silent text-mode degrade", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-badfmt-"));
    const scenario = writeCleanScenario(d);
    const { code, stderr } = runCli(["lint", scenario, "--output-format", "xml"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--output-format must be "text" or "json"/);
  });

  it("lint --output-format xml followed by a later --output-format json is still a usage error, routed through the json envelope", () => {
    // parseOutputFormat is first-occurrence-authoritative (the invalid "xml" wins and throws), but
    // isJsonOutput independently finds the later "json" occurrence and reports json mode — so the usage
    // error must come back as a jsonError envelope, not bare text, matching every other command's
    // fail(..., isJsonOutput(args)) plumbing.
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-badfmt-json-"));
    const scenario = writeCleanScenario(d);
    const { code, stdout } = runCli(["lint", scenario, "--output-format", "xml", "--output-format", "json"]);
    expect(code).toBe(2);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(false);
    expect(payload.error.category).toBe("usage");
  });

  it("lint-skill with a valueless trailing --output-format is a usage error (exit 2)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-skill-badfmt-"));
    writeCleanSkill(d);
    const { code, stderr } = runCli(["lint-skill", d, "--output-format"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--output-format must be "text" or "json"/);
  });

  it("lint --output-format json (a valid value) still works — the new validation doesn't regress the happy path", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-goodfmt-"));
    const scenario = writeCleanScenario(d);
    const { code, stdout } = runCli(["lint", scenario, "--output-format", "json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.ok).toBe(true);
  });
});

// action.yml's Run step builds the cowork-harness arg array in bash. --strict is accepted only by
// replay/lint/lint-skill/analyze-skill — verify-cassettes/run exit 2 ("unknown flag") on it — so the
// step must NOT unconditionally append --strict; it has to guard on the command the same way it
// already guards --fail-on-skill-drift to replay-only. The command is read from the HARNESS_COMMAND
// env var (inputs are passed via `env:`, not interpolated into the script body, to close a shell
// injection surface). This asserts the guard textually (no bash interpreter here) so a future edit
// that removes the case-guard and reintroduces the unconditional append is caught.
describe("action.yml — --strict is guarded to the commands that accept it", () => {
  const actionYml = readFileSync(resolve("action.yml"), "utf8");
  const runStep = actionYml.slice(actionYml.indexOf("Run cowork-harness"), actionYml.indexOf("Report"));

  it("guards the --strict append behind a case/if that lists exactly the four commands that accept it", () => {
    expect(runStep).toMatch(/replay\s*\|\s*lint\s*\|\s*lint-skill\s*\|\s*analyze-skill/);
    // the --strict append line itself must appear AFTER the case guard opens (i.e. inside the case body)
    const caseIdx = runStep.search(/case "\$HARNESS_COMMAND" in/);
    const strictAppendIdx = runStep.indexOf('args+=("--strict")');
    expect(caseIdx).toBeGreaterThan(-1);
    expect(strictAppendIdx).toBeGreaterThan(caseIdx);
  });

  it("verify-cassettes and run are absent from the --strict guard's command list", () => {
    const caseIdx = runStep.search(/case "\$HARNESS_COMMAND" in/);
    const esacIdx = runStep.indexOf("esac", caseIdx);
    const guardBody = runStep.slice(caseIdx, esacIdx);
    expect(guardBody).not.toMatch(/verify-cassettes/);
    expect(guardBody).not.toMatch(/\brun\b/);
  });
});

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `scenario.py lint-skill` inspects SKILL.md bodies for two Cowork host-loop footguns:
//   (a) ${CLAUDE_PLUGIN_ROOT} used as a path in an in-VM bash context (fenced bash / hooks JSON
//       command / Bash() directive) — dead in the host-loop VM;
//   (b) a hook command that exports an env var or writes into /tmp for the in-VM agent — a host-side
//       hook write is not VM-visible in Cowork.
// The linter is offline Python spawned exactly like the scenario linter (see lint-vendored-yaml.test.ts).
const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

if (!havePython) {
  // Make the missing interpreter loud rather than a silent skip that looks like a pass.
  // eslint-disable-next-line no-console
  console.warn("python3 not found — skill-body-lint tests skipped");
}

type Finding = {
  severity: string;
  rule: string;
  message: string;
  fix: string;
  file: string;
  line: number | null;
};

function lintSkill(dir: string): { status: number | null; findings: Finding[]; raw: string } {
  const r = spawnSync(py, [SCRIPT, "lint-skill", "--json", join(dir, "SKILL.md")], { encoding: "utf8" });
  const raw = (r.stdout || "") + (r.stderr || "");
  let findings: Finding[] = [];
  try {
    findings = JSON.parse(r.stdout || "[]");
  } catch {
    findings = [];
  }
  return { status: r.status, findings, raw };
}

describe.skipIf(!havePython)("scenario.py lint-skill — Cowork host-loop footguns", () => {
  it("POSITIVE: flags a ${CLAUDE_PLUGIN_ROOT} bash path AND a SessionStart hook that exports a var", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-pos-"));
    const md = [
      "# Demo skill",
      "",
      "Set up the environment first:",
      "",
      "```bash",
      'bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh"',
      "```",
      "",
      "Configure the hook:",
      "",
      "```json",
      "{",
      '  "hooks": {',
      '    "SessionStart": [',
      '      { "hooks": [ { "type": "command", "command": "export DEMO_FLAG=1" } ] }',
      "    ]",
      "  }",
      "}",
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { findings } = lintSkill(d);
    const rules = findings.map((f) => f.rule);

    // (a) the bash-block plugin-root path
    expect(rules).toContain("plugin-root-in-vm-bash");
    const bashHit = findings.find((f) => f.rule === "plugin-root-in-vm-bash");
    expect(bashHit?.severity).toBe("WARN");
    expect(bashHit?.line).toBe(6); // 1-based line of the setup.sh invocation
    expect(bashHit?.message).toMatch(/dead in host-loop VM/i);

    // (b) the host-side hook export
    expect(rules).toContain("hook-host-side-write");
    const hookHit = findings.find((f) => f.rule === "hook-host-side-write");
    expect(hookHit?.severity).toBe("WARN");
    expect(hookHit?.message).toMatch(/not VM-visible in Cowork/i);
  });

  it("POSITIVE: a hook command that writes into /tmp is flagged too", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-tmp-"));
    const md = [
      "# Tmp-writing hook",
      "",
      "```json",
      '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "echo hi > /tmp/seed.txt" } ] } ] } }',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { findings } = lintSkill(d);
    const hookHit = findings.find((f) => f.rule === "hook-host-side-write");
    expect(hookHit, "expected a /tmp-write hook finding").toBeDefined();
    expect(hookHit?.severity).toBe("WARN");
  });

  it("NEGATIVE: host-side prose + Read/Grep directives referencing ${CLAUDE_PLUGIN_ROOT} are NOT flagged", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-neg-"));
    const md = [
      "# Reference-reading skill",
      "",
      "Read the file at `${CLAUDE_PLUGIN_ROOT}/references/x.md` before you begin.",
      "",
      "Use the Read tool: Read ${CLAUDE_PLUGIN_ROOT}/references/guide.md",
      "Then Grep ${CLAUDE_PLUGIN_ROOT}/references for the relevant pattern.",
      "",
      "A non-shell code block should also be ignored:",
      "",
      "```python",
      'path = f"{CLAUDE_PLUGIN_ROOT}/x"',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { status, findings } = lintSkill(d);
    expect(findings).toEqual([]);
    expect(status).toBe(0); // clean, no findings
  });

  it("Item 4: a self-healed ${CLAUDE_PLUGIN_ROOT} bash block is INFO (guarded), not WARN", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-guarded-"));
    const md = [
      "# Guarded skill",
      "",
      "```bash",
      'S="${CLAUDE_PLUGIN_ROOT}/scripts/x.py"',
      '[ -d "$S" ] || S="$(find /sessions -name x.py -path \'*/scripts/*\' | head -1)"',
      'python3 "$S" run',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { findings, status } = lintSkill(d);
    // downgraded to INFO (the block self-heals via find /sessions) — NOT the alarming WARN
    expect(findings.some((f) => f.rule === "plugin-root-in-vm-bash")).toBe(false);
    const guarded = findings.find((f) => f.rule === "plugin-root-guarded");
    expect(guarded, "expected a plugin-root-guarded INFO").toBeDefined();
    expect(guarded?.severity).toBe("INFO");
    expect(guarded?.line).toBe(4); // 1-based line of the token use, preserved through the buffered emit
    expect(guarded?.fix).toMatch(/not validated/i);
    expect(status).toBe(0); // INFO is clean
  });

  it("Item 4: two bash fences — one guarded (INFO), one not (WARN) — get INDEPENDENT verdicts", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-multi-"));
    const md = [
      "# Two blocks",
      "",
      "```bash", // guarded block
      'A="${CLAUDE_PLUGIN_ROOT}/scripts/a.py"',
      '[ -d "$A" ] || A="$(find /sessions -name a.py | head -1)"',
      "```",
      "",
      "```bash", // unguarded block
      'bash "${CLAUDE_PLUGIN_ROOT}/scripts/b.sh"',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);
    const { findings } = lintSkill(d);
    const guarded = findings.find((f) => f.rule === "plugin-root-guarded");
    const warn = findings.find((f) => f.rule === "plugin-root-in-vm-bash");
    expect(guarded?.line).toBe(4); // first block's token → INFO
    expect(warn?.line).toBe(9); // second block's token → WARN (buffer reset between fences)
    expect(warn?.severity).toBe("WARN");
  });

  it("exit code: WARN findings are clean (0) by default but non-zero under --strict", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-strict-"));
    const md = ["# S", "", "```bash", 'cat "${CLAUDE_PLUGIN_ROOT}/x.sh"', "```", ""].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const lenient = spawnSync(py, [SCRIPT, "lint-skill", join(d, "SKILL.md")], { encoding: "utf8" });
    expect(lenient.status).toBe(0);

    const strict = spawnSync(py, [SCRIPT, "lint-skill", "--strict", join(d, "SKILL.md")], { encoding: "utf8" });
    expect(strict.status).toBe(1);
  });
});

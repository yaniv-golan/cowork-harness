import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `scenario.py lint-skill` inspects SKILL.md bodies for two Cowork host-loop footguns:
//   (a) ${CLAUDE_PLUGIN_ROOT} in an in-VM bash context (fenced bash / Bash() directive) — the bare form is
//       empty in the VM shell at host-loop (WARN); the braced form is replaced with a HOST path that the
//       host-loop bash tool rewrites to the plugin's VM mount (INFO), and the whole root passed as an option
//       value is most likely forwarded to a host-side reader, which then gets a VM path (WARN);
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
  it("POSITIVE: flags a $CLAUDE_PLUGIN_ROOT bash path AND a SessionStart hook that exports a var", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-pos-"));
    const md = [
      "# Demo skill",
      "",
      "Set up the environment first:",
      "",
      "```bash",
      'bash "$CLAUDE_PLUGIN_ROOT/scripts/setup.sh"',
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
    expect(bashHit?.message).toMatch(/empty at host-loop/i);

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
      'bash "$CLAUDE_PLUGIN_ROOT/scripts/b.sh"',
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

  it("Task E: self-heal `find -path` naming the CURRENT skill stays INFO plugin-root-guarded", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-guard-self-"));
    const md = [
      "---",
      "name: demo-skill3",
      "---",
      "",
      "# Demo skill 3",
      "",
      "```bash",
      'S="${CLAUDE_PLUGIN_ROOT}/scripts/x.py"',
      '[ -d "$S" ] || S="$(find /sessions -name x.py -path \'*/skills/demo-skill3/scripts\')"',
      'python3 "$S" run',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { findings } = lintSkill(d);
    expect(findings.some((f) => f.rule === "guard-pattern-mismatch")).toBe(false);
    const guarded = findings.find((f) => f.rule === "plugin-root-guarded");
    expect(guarded, "expected a plugin-root-guarded INFO").toBeDefined();
    expect(guarded?.severity).toBe("INFO");
  });

  it("Task E: self-heal `find -path` naming the enclosing PLUGIN's script dir stays INFO (widened scope)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-guard-plugin-"));
    mkdirSync(join(d, ".claude-plugin"), { recursive: true });
    writeFileSync(join(d, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    const md = [
      "# Demo skill in a plugin",
      "",
      "```bash",
      'S="${CLAUDE_PLUGIN_ROOT}/scripts/x.py"',
      '[ -d "$S" ] || S="$(find /sessions -name x.py -path \'*/demo-plugin/scripts\')"',
      'python3 "$S" run',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { findings } = lintSkill(d);
    expect(findings.some((f) => f.rule === "guard-pattern-mismatch")).toBe(false);
    const guarded = findings.find((f) => f.rule === "plugin-root-guarded");
    expect(guarded, "expected a plugin-root-guarded INFO").toBeDefined();
    expect(guarded?.severity).toBe("INFO");
  });

  it("Task E: self-heal `find -path` naming a WRONG/different skill is WARN guard-pattern-mismatch", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-guard-wrong-"));
    const md = [
      "---",
      "name: demo-skill3",
      "---",
      "",
      "# Demo skill 3",
      "",
      "```bash",
      'S="${CLAUDE_PLUGIN_ROOT}/scripts/x.py"',
      '[ -d "$S" ] || S="$(find /sessions -name x.py -path \'*/skills/other-skill/scripts\')"',
      'python3 "$S" run',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { findings } = lintSkill(d);
    expect(findings.some((f) => f.rule === "plugin-root-guarded")).toBe(false);
    const mismatch = findings.find((f) => f.rule === "guard-pattern-mismatch");
    expect(mismatch, "expected a guard-pattern-mismatch WARN").toBeDefined();
    expect(mismatch?.severity).toBe("WARN");
    expect(mismatch?.message).toMatch(/other-skill/);
    expect(mismatch?.message).toMatch(/demo-skill3/);
  });

  it("Task E: self-heal `find` with only `-name` (no `-path` skill token) stays INFO — conservative", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-guard-noname-"));
    const md = [
      "---",
      "name: demo-skill3",
      "---",
      "",
      "# Demo skill 3",
      "",
      "```bash",
      'S="${CLAUDE_PLUGIN_ROOT}/scripts/x.py"',
      '[ -d "$S" ] || S="$(find /sessions -name x.py)"',
      'python3 "$S" run',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const { findings } = lintSkill(d);
    expect(findings.some((f) => f.rule === "guard-pattern-mismatch")).toBe(false);
    const guarded = findings.find((f) => f.rule === "plugin-root-guarded");
    expect(guarded, "expected a plugin-root-guarded INFO").toBeDefined();
    expect(guarded?.severity).toBe("INFO");
  });

  it("exit code: WARN findings are clean (0) by default but non-zero under --strict", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-strict-"));
    const md = ["# S", "", "```bash", 'cat "$CLAUDE_PLUGIN_ROOT/x.sh"', "```", ""].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);

    const lenient = spawnSync(py, [SCRIPT, "lint-skill", join(d, "SKILL.md")], { encoding: "utf8" });
    expect(lenient.status).toBe(0);

    const strict = spawnSync(py, [SCRIPT, "lint-skill", "--strict", join(d, "SKILL.md")], { encoding: "utf8" });
    expect(strict.status).toBe(1);
  });

  it("`--min-severity` (a `lint`-only flag) names `lint` as the sibling instead of a bare exit 2", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-min-severity-"));
    writeFileSync(join(d, "SKILL.md"), "# S\n");

    const r = spawnSync(py, [SCRIPT, "lint-skill", join(d, "SKILL.md"), "--min-severity", "ERROR"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--min-severity is a `lint` flag, not `lint-skill`/);
    expect(r.stderr).toMatch(/cowork-harness lint\b/);
  });

  it("`--min-severity=ERROR` (equals form) gets the same named-sibling error", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-min-severity-eq-"));
    writeFileSync(join(d, "SKILL.md"), "# S\n");

    const r = spawnSync(py, [SCRIPT, "lint-skill", join(d, "SKILL.md"), "--min-severity=ERROR"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--min-severity is a `lint` flag, not `lint-skill`/);
  });

  it("an unrelated unknown flag is NOT given the min-severity hint (regression against over-matching)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-unknown-flag-"));
    writeFileSync(join(d, "SKILL.md"), "# S\n");

    const r = spawnSync(py, [SCRIPT, "lint-skill", join(d, "SKILL.md"), "--bogus-flag"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unrecognized arguments: --bogus-flag/);
    expect(r.stderr).not.toMatch(/--min-severity/);
  });

  it("`lint` (the actual owner) still accepts --min-severity normally", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-min-severity-owner-"));
    const scenario = join(d, "demo.yaml");
    writeFileSync(
      scenario,
      [
        "name: demo",
        "baseline: latest",
        "fidelity: container",
        "on_unanswered: fail",
        "",
        "prompt: |",
        "  hi",
        "",
        "assert:",
        "  - result: success",
        "",
      ].join("\n"),
    );
    const r = spawnSync(py, [SCRIPT, "lint", scenario, "--min-severity", "ERROR"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});

// At host-loop the bash tool rewrites the braced root's host path to the plugin's VM mount, so a program that
// OPENS the value works and one that FORWARDS it to a host-side file tool hands that tool a VM path it refuses.
// The difference lives in the receiving program, not in the skill text. The one shape flagged as a forward is
// the whole root as an option value; a path built under the root, a positional argument, a heredoc line, an
// assignment and a comment stay the INFO. These pin both sides.
describe.skipIf(!havePython)("lint-skill — the forwarding shape", () => {
  const rulesFor = (cmd: string) => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-argval-"));
    writeFileSync(join(d, "SKILL.md"), ["# S", "", "```bash", cmd, "```", ""].join("\n"));
    return lintSkill(d).findings.filter((f) => f.rule.startsWith("plugin-root"));
  };
  it.each([
    ['python3 "$S" --plugin-root-agent "${CLAUDE_PLUGIN_ROOT}"'],
    ["python3 \"$S\" --root '${CLAUDE_PLUGIN_ROOT}' --x 1"],
    ["node s.js --root=${CLAUDE_PLUGIN_ROOT}"],
    ['  --plugin-root-agent "${CLAUDE_PLUGIN_ROOT}" \\'],
    ['python3 b.py --plugin-root-agent "${CLAUDE_PLUGIN_ROOT}"; echo done'],
  ])("%s → WARN plugin-root-forwarded-from-vm-bash", (cmd) => {
    const hits = rulesFor(cmd);
    expect(hits.map((f) => [f.rule, f.severity])).toEqual([["plugin-root-forwarded-from-vm-bash", "WARN"]]);
    expect(hits[0]!.line).toBe(4);
    expect(hits[0]!.message).toMatch(/breaks at hostloop: the sub-agent gets a VM path its file tools refuse/);
    expect(hits[0]!.fix).toMatch(/plugin agent's definition/);
    expect(hits[0]!.fix).toContain("<!-- lint-skill: ignore-start plugin-root-forwarded-from-vm-bash: ");
  });
  it.each([
    ['python3 "$S" --data-dir "${CLAUDE_PLUGIN_ROOT}/data"'],
    ['python3 "$S" "${CLAUDE_PLUGIN_ROOT}"'],
    ["${CLAUDE_PLUGIN_ROOT}"],
    ['ROOT="${CLAUDE_PLUGIN_ROOT}"'],
    ["# pass --plugin-root-agent ${CLAUDE_PLUGIN_ROOT} to the builder"],
    ['bash "${CLAUDE_PLUGIN_ROOT}/x.sh" --root "${CLAUDE_PLUGIN_ROOT}-old"'],
  ])("%s → INFO plugin-root-braced-in-vm-bash only", (cmd) => {
    expect(rulesFor(cmd).map((f) => [f.rule, f.severity])).toEqual([["plugin-root-braced-in-vm-bash", "INFO"]]);
  });
  it("a forwarded value in a self-healing block still WARNs (a heal fixes a path the shell opens, not one it passes on)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-fwd-heal-"));
    const md = [
      "# S",
      "",
      "```bash",
      'S="${CLAUDE_PLUGIN_ROOT}/scripts"',
      '[ -d "$S" ] || S="$(dirname "$(find /sessions -name build.py | head -1)")"',
      'python3 "$S/build.py" --plugin-root-agent "${CLAUDE_PLUGIN_ROOT}"',
      "```",
      "",
    ].join("\n");
    writeFileSync(join(d, "SKILL.md"), md);
    const hits = lintSkill(d).findings.filter((f) => f.rule.startsWith("plugin-root"));
    expect(hits.map((f) => [f.rule, f.line])).toEqual([
      ["plugin-root-guarded", 4],
      ["plugin-root-forwarded-from-vm-bash", 6],
    ]);
  });
});

// The finding names the mechanism for the form actually written. The agent replaces the BRACED token in a
// plugin skill's text when the skill loads (at host-loop, with a host path the bash tool then rewrites to the
// plugin's VM mount); it does not replace the bare `$CLAUDE_PLUGIN_ROOT`, which the VM shell then reads as an
// environment variable, empty at host-loop.
describe.skipIf(!havePython)("lint-skill — plugin-root finding per form", () => {
  function hitsFor(line: string, fence = true): Finding[] {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-form-"));
    const body = fence ? ["# S", "", "```bash", line, "```", ""] : ["# S", "", line, ""];
    writeFileSync(join(d, "SKILL.md"), body.join("\n"));
    return lintSkill(d).findings.filter((f) => f.rule.startsWith("plugin-root"));
  }

  it("braced ${CLAUDE_PLUGIN_ROOT}: INFO — load-time replacement, the rewrite, its word boundary and the forwarding case", () => {
    const [hit, ...rest] = hitsFor('python3 "${CLAUDE_PLUGIN_ROOT}/scripts/x.py"');
    expect(rest).toEqual([]);
    expect(hit?.rule).toBe("plugin-root-braced-in-vm-bash");
    expect(hit?.severity).toBe("INFO");
    expect(hit?.message).toMatch(/replaces it with a path when the skill loads/i);
    expect(hit?.message).toMatch(/the bash tool rewrites to the plugin's VM mount/i);
    expect(hit?.message).toMatch(/arrives there as a VM path/i);
    expect(hit?.message).toMatch(/cannot tell a positional forward/i);
    expect(hit?.fix).toMatch(/Keep the path its own word/i);
    expect(hit?.fix).toMatch(/do not pass it through bash/i);
    expect(hit?.fix).toContain("<!-- lint-skill: ignore-start plugin-root-braced-in-vm-bash: ");
    expect(hit?.fix).toContain("<!-- lint-skill: ignore-end -->");
  });

  it("bare $CLAUDE_PLUGIN_ROOT: WARN — nothing replaces it; the VM shell reads the variable, empty at host-loop", () => {
    const [hit, ...rest] = hitsFor('python3 "$CLAUDE_PLUGIN_ROOT/scripts/x.py"');
    expect(rest).toEqual([]);
    expect(hit?.rule).toBe("plugin-root-in-vm-bash");
    expect(hit?.severity).toBe("WARN");
    expect(hit?.message).toMatch(/does not replace/i);
    expect(hit?.message).toMatch(/empty at host-loop/i);
    expect(hit?.message).not.toMatch(/replaces it with a path when the skill loads/i);
    expect(hit?.fix).toMatch(/Use the braced `\$\{CLAUDE_PLUGIN_ROOT\}` as a word of its own/);
  });

  it("a line with both forms gets one finding per form", () => {
    expect(hitsFor('cp "${CLAUDE_PLUGIN_ROOT}/a" "$CLAUDE_PLUGIN_ROOT/b"').map((f) => [f.rule, f.severity])).toEqual([
      ["plugin-root-braced-in-vm-bash", "INFO"],
      ["plugin-root-in-vm-bash", "WARN"],
    ]);
  });

  it("a braced form with an operator is not replaced: the bare-form WARN, echoing it as written", () => {
    const [hit, ...rest] = hitsFor('python3 "${CLAUDE_PLUGIN_ROOT:-/opt/p}/x.py"');
    expect(rest).toEqual([]);
    expect(hit?.rule).toBe("plugin-root-in-vm-bash");
    expect(hit?.message).toContain("`${CLAUDE_PLUGIN_ROOT:-/opt/p}`");
    expect(hit?.message).toMatch(/does not replace/i);
    expect(hit?.message).not.toContain("`$CLAUDE_PLUGIN_ROOT`");
  });

  it("the Bash() directive context gets the same per-form findings", () => {
    expect(hitsFor("Run Bash(python3 ${CLAUDE_PLUGIN_ROOT}/x.py) first.", false).map((f) => f.rule)).toEqual([
      "plugin-root-braced-in-vm-bash",
    ]);
    const bare = hitsFor("Run Bash(python3 $CLAUDE_PLUGIN_ROOT/x.py) first.", false);
    expect(bare.map((f) => f.rule)).toEqual(["plugin-root-in-vm-bash"]);
    expect(bare[0]!.message).toMatch(/empty at host-loop/i);
    expect(hitsFor("Run Bash(python3 b.py --plugin-root-agent ${CLAUDE_PLUGIN_ROOT}) first.", false).map((f) => f.rule)).toEqual([
      "plugin-root-forwarded-from-vm-bash",
    ]);
  });

  it("the braced INFO alone never fails --strict; the bare WARN does", () => {
    const run = (line: string) => {
      const d = mkdtempSync(join(tmpdir(), "cwh-skill-form-strict-"));
      writeFileSync(join(d, "SKILL.md"), ["# S", "", "```bash", line, "```", ""].join("\n"));
      return spawnSync(py, [SCRIPT, "lint-skill", "--strict", join(d, "SKILL.md")], { encoding: "utf8" }).status;
    };
    expect(run('bash "${CLAUDE_PLUGIN_ROOT}/x.sh"')).toBe(0);
    expect(run('bash "$CLAUDE_PLUGIN_ROOT/x.sh"')).toBe(1);
  });
});

// A plugin hook command is not an in-VM bash step: the agent substitutes the token when it runs the hook
// and also sets the variable, so the hook always receives a path valid where it runs (on the host at
// host-loop, in the VM at VM-loop). The rule used to fire there; it no longer does.
describe.skipIf(!havePython)("lint-skill — hook commands are not a plugin-root context", () => {
  const hooks = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash ${CLAUDE_PLUGIN_ROOT}/hooks/check.sh" }] }] },
  });

  it("hooks/hooks.json with ${CLAUDE_PLUGIN_ROOT} in a command → no plugin-root finding", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-hookroot-"));
    writeFileSync(join(d, "SKILL.md"), "# S\n");
    mkdirSync(join(d, "hooks"));
    writeFileSync(join(d, "hooks", "hooks.json"), hooks);
    const { findings, status } = lintSkill(d);
    expect(findings.filter((f) => f.rule.startsWith("plugin-root"))).toEqual([]);
    expect(status).toBe(0);
  });

  it("a ```json hooks block in SKILL.md → no plugin-root finding either", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-hookroot-md-"));
    writeFileSync(join(d, "SKILL.md"), ["# S", "", "```json", hooks, "```", ""].join("\n"));
    expect(lintSkill(d).findings.filter((f) => f.rule.startsWith("plugin-root"))).toEqual([]);
  });

  it("the host-side-write check on the same hook command still fires", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-hookroot-write-"));
    const cmd = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "export X=${CLAUDE_PLUGIN_ROOT}" }] }] } });
    writeFileSync(join(d, "SKILL.md"), ["# S", "", "```json", cmd, "```", ""].join("\n"));
    const rules = lintSkill(d).findings.map((f) => f.rule);
    expect(rules).toContain("hook-host-side-write");
    expect(rules.filter((r) => r.startsWith("plugin-root"))).toEqual([]);
  });
});

// A finding's JSON shape when no suppression is in play. The `suppressed` record is opt-in: an invocation
// that uses neither `--ignore-rule`, a suppressions file nor a marker must print exactly these six keys, so an existing consumer
// that parses the array (a jq recipe, an allowlist gate) sees no change.
describe.skipIf(!havePython)("lint-skill --json — finding shape without suppression", () => {
  it("every finding carries exactly severity/rule/message/fix/file/line", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-shape-"));
    writeFileSync(join(d, "SKILL.md"), '# S\n\n```bash\nbash "$CLAUDE_PLUGIN_ROOT/x.sh"\n```\n\n' + "x".repeat(19_001));
    const { findings } = lintSkill(d);
    expect(findings.map((f) => f.rule).sort()).toEqual(["plugin-root-in-vm-bash", "skill-body-over-reattach-cap"]);
    for (const f of findings) {
      expect(Object.keys(f).sort()).toEqual(["file", "fix", "line", "message", "rule", "severity"]);
    }
  });
});

// Corpus-size proximity to the critique evidence ceiling. Guarding the BEHAVIOUR, not just the
// constant: a cross-language sync test pins the number, but it stays green with the rule deleted
// entirely — so without these cases the feature could be gutted and nothing would notice.
describe.skipIf(!havePython)("lint-skill — corpus vs the critique evidence ceiling", () => {
  const CEILING = 512 * 1024;
  /** A skill dir whose SKILL.md + references/part-N.md total ~`bytes`. Split into parts under the
   *  per-reference read cap, so these cases exercise the corpus ceiling alone rather than also tripping
   *  `skill-reference-over-read-cap` (a separate WARN, which would fail `--strict` on its own). */
  function skillOfSize(bytes: number): string {
    const d = mkdtempSync(join(tmpdir(), "corpus-lint-"));
    const head = "# t\n";
    writeFileSync(join(d, "SKILL.md"), head);
    mkdirSync(join(d, "references"), { recursive: true });
    const PART = 50_000;
    let left = Math.max(0, bytes - head.length);
    for (let i = 0; left > 0 || i === 0; i++) {
      const n = Math.min(PART, left);
      writeFileSync(join(d, "references", `part-${i}.md`), "x".repeat(n));
      left -= n;
    }
    return d;
  }
  const rules = (dir: string): string[] => lintSkill(dir).findings.map((f) => f.rule);

  it("stays silent well under the notice band", () => {
    expect(rules(skillOfSize(1024))).not.toContain("skill-corpus-near-evidence-ceiling");
    expect(rules(skillOfSize(1024))).not.toContain("skill-corpus-over-evidence-ceiling");
  });

  it("emits the INFO notice at 80% of the ceiling", () => {
    const r = rules(skillOfSize(Math.ceil(CEILING * 0.8)));
    expect(r).toContain("skill-corpus-near-evidence-ceiling");
    expect(r).not.toContain("skill-corpus-over-evidence-ceiling");
  });

  it("stays silent one byte below the notice band", () => {
    expect(rules(skillOfSize(Math.ceil(CEILING * 0.8) - 1))).not.toContain("skill-corpus-near-evidence-ceiling");
  });

  it("flips to WARN past the ceiling, and exactly AT the ceiling stays INFO (the packager cuts only above it)", () => {
    expect(rules(skillOfSize(CEILING))).toContain("skill-corpus-near-evidence-ceiling");
    const over = rules(skillOfSize(CEILING + 1));
    expect(over).toContain("skill-corpus-over-evidence-ceiling");
    expect(over).not.toContain("skill-corpus-near-evidence-ceiling");
  });

  // The ceiling governs SKILL.md + references + agents/<name>.md COMBINED. Sizing only the first two
  // let a plugin sit in the INFO band -- and PASS --strict -- while the packager was already over the
  // ceiling and would cut content. A proximity check that greens a doomed corpus is worse than none.
  /** A multi-skill plugin: <root>/skills/<name>/{SKILL.md,references/big.md} + <root>/agents/<name>.md. */
  function pluginOfSize(refBytes: number, agentsBytes: number): string {
    const root = mkdtempSync(join(tmpdir(), "corpus-plug-"));
    const sd = join(root, "skills", "demo");
    mkdirSync(join(sd, "references"), { recursive: true });
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(sd, "SKILL.md"), "# demo\n");
    writeFileSync(join(sd, "references", "big.md"), "x".repeat(refBytes));
    writeFileSync(join(root, "agents", "demo.md"), "y".repeat(agentsBytes));
    return sd;
  }

  it("counts agents/<name>.md: a plugin under the ceiling on refs alone but over WITH it reports WARN", () => {
    // refs alone ~83% (INFO band); + agents md pushes past 100%.
    const sd = pluginOfSize(435_000, 120_000);
    const r = lintSkill(sd).findings.map((f) => f.rule);
    expect(r).toContain("skill-corpus-over-evidence-ceiling");
    expect(r).not.toContain("skill-corpus-near-evidence-ceiling");
    const strict = spawnSync(py, [SCRIPT, "lint-skill", "--strict", join(sd, "SKILL.md")], { encoding: "utf8" });
    expect(strict.status, "--strict must fail on a corpus the packager would cut").toBe(1);
  });

  it("a plugin whose agents md keeps it under the band stays silent", () => {
    expect(lintSkill(pluginOfSize(1024, 1024)).findings.map((f) => f.rule)).toEqual([]);
  });

  it("counts a non-.md reference — the packager applies no extension filter", () => {
    const d = mkdtempSync(join(tmpdir(), "corpus-ext-"));
    mkdirSync(join(d, "references"), { recursive: true });
    writeFileSync(join(d, "SKILL.md"), "# t\n");
    writeFileSync(join(d, "references", "schema.json"), "x".repeat(Math.ceil(512 * 1024 * 0.8)));
    expect(lintSkill(d).findings.map((f) => f.rule)).toContain("skill-corpus-near-evidence-ceiling");
  });

  it("the INFO notice never fails --strict; the WARN does", () => {
    const near = spawnSync(py, [SCRIPT, "lint-skill", "--strict", join(skillOfSize(Math.ceil(CEILING * 0.8)), "SKILL.md")], {
      encoding: "utf8",
    });
    expect(near.status).toBe(0);
    const over = spawnSync(py, [SCRIPT, "lint-skill", "--strict", join(skillOfSize(CEILING + 1), "SKILL.md")], { encoding: "utf8" });
    expect(over.status).toBe(1);
  });
});

// Per-rule suppression. `--ignore-rule <id>[=<glob>]` for a run-level decision (the size caps carry no line,
// so only a flag can reach them), and an in-file `ignore-start`/`ignore-end` marker for a reviewed site. A
// suppressed finding is still REPORTED (same severity, plus a `suppressed` record) and only leaves the exit
// computation. Provable rules (ERROR, and the two WARNs that are facts rather than judgement calls) cannot
// be suppressed by either form.
describe.skipIf(!havePython)("lint-skill — per-rule suppression", () => {
  type Sup = { by: "flag" | "marker" | "file"; marker_line: number | null; reason: string | null; source?: string };
  type SFinding = Finding & { suppressed?: Sup };
  function run(args: string[]) {
    const r = spawnSync(py, [SCRIPT, "lint-skill", ...args], { encoding: "utf8" });
    let findings: SFinding[] = [];
    try {
      findings = JSON.parse(r.stdout || "[]");
    } catch {
      findings = [];
    }
    return { status: r.status, findings, stdout: r.stdout || "", stderr: r.stderr || "" };
  }
  function skill(lines: string[], eol = "\n"): string {
    const d = mkdtempSync(join(tmpdir(), "cwh-skill-sup-"));
    writeFileSync(join(d, "SKILL.md"), lines.join(eol));
    return d;
  }
  // Suppression mechanics, not the rule: the fixture is the bare form, which stays a WARN.
  const FWD = 'python3 "$S/build.py" --root "$CLAUDE_PLUGIN_ROOT"';
  const START = "<!-- lint-skill: ignore-start plugin-root-in-vm-bash: the build script defaults an empty root -->";
  const END = "<!-- lint-skill: ignore-end -->";
  const BIG = "x".repeat(19_001);

  describe("--ignore-rule", () => {
    it("suppresses a size cap: --strict exits 0, the finding stays in --json as WARN with suppressed.by=flag", () => {
      const d = skill(["# S", "", BIG]);
      const r = run([d, "--json", "--strict", "--ignore-rule", "skill-body-over-reattach-cap"]);
      expect(r.status).toBe(0);
      const f = r.findings.find((x) => x.rule === "skill-body-over-reattach-cap");
      expect(f?.severity).toBe("WARN");
      expect(f?.suppressed).toEqual({ by: "flag", marker_line: null, reason: null });
    });

    it("an unknown rule id is a usage error (exit 2) naming the known ids", () => {
      const d = skill(["# S", ""]);
      const r = run([d, "--ignore-rule", "no-such-rule"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/unknown lint-skill rule: no-such-rule/);
      expect(r.stderr).toContain("skill-body-over-reattach-cap");
    });

    it.each(["hook-event-unknown", "no-skill", "hooks-json-misplaced", "subagent-type-not-found-in-plugin"])(
      "a provable rule (%s) cannot be suppressed: exit 2",
      (id) => {
        const d = skill(["# S", ""]);
        const r = run([d, "--ignore-rule", id]);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/cannot be suppressed/);
      },
    );

    it("`=<glob>` scopes it to matching files: two skills, only the named one is suppressed", () => {
      const root = mkdtempSync(join(tmpdir(), "cwh-skill-sup-glob-"));
      for (const n of ["alpha", "beta"]) {
        mkdirSync(join(root, n));
        writeFileSync(join(root, n, "SKILL.md"), "# S\n\n" + BIG);
      }
      const r = run([
        join(root, "alpha"),
        join(root, "beta"),
        "--json",
        "--strict",
        "--ignore-rule",
        "skill-body-over-reattach-cap=*alpha/SKILL.md",
      ]);
      expect(r.status).toBe(1);
      const caps = r.findings.filter((x) => x.rule === "skill-body-over-reattach-cap");
      expect(caps.find((x) => x.file.includes("alpha"))?.suppressed?.by).toBe("flag");
      expect(caps.find((x) => x.file.includes("beta"))?.suppressed).toBeUndefined();
    });

    it("the glob also matches the path relative to the argument's PARENT, so it names the skill dir", () => {
      const d = skill(["# S", "", BIG]);
      const name = d.split(/[\\/]/).pop();
      const r = run([d, "--json", "--strict", "--ignore-rule", `skill-body-over-reattach-cap=${name}/SKILL.md`]);
      expect(r.status).toBe(0);
    });

    it("one dir per skill: `=a/SKILL.md` covers only a; a bare `=SKILL.md` covers neither (never every skill)", () => {
      const root = mkdtempSync(join(tmpdir(), "cwh-skill-sup-base-"));
      for (const n of ["a", "b"]) {
        mkdirSync(join(root, n));
        writeFileSync(join(root, n, "SKILL.md"), ["# S", "", "```bash", FWD, "```", ""].join("\n"));
      }
      const args = [join(root, "a"), join(root, "b"), "--json", "--strict"];
      const scoped = run([...args, "--ignore-rule", "plugin-root-in-vm-bash=a/SKILL.md"]);
      const hits = scoped.findings.filter((x) => x.rule === "plugin-root-in-vm-bash");
      expect(hits.map((x) => [x.file.endsWith(join("a", "SKILL.md")), x.suppressed?.by ?? null])).toEqual([
        [true, "flag"],
        [false, null],
      ]);
      // A SKILL.md argument resolves to the same base as its directory.
      const fileArgs = run([join(root, "a", "SKILL.md"), "--json", "--strict", "--ignore-rule", "plugin-root-in-vm-bash=a/SKILL.md"]);
      expect(fileArgs.status).toBe(0);
      const bare = run([...args, "--ignore-rule", "plugin-root-in-vm-bash=SKILL.md"]);
      expect(bare.findings.filter((x) => x.suppressed)).toEqual([]);
      expect(bare.findings.some((x) => x.rule === "lint-skill-ignore-unused")).toBe(true);
      expect(bare.status).toBe(1);
    });

    it("an --ignore-rule that suppresses nothing is INFO lint-skill-ignore-unused, per (id, glob); --strict still 0", () => {
      const d = skill(["# S", "", BIG]);
      const r = run([
        d,
        "--json",
        "--strict",
        "--ignore-rule",
        "skill-body-over-reattach-cap",
        "--ignore-rule",
        "skill-body-over-reattach-cap=nomatch/*",
      ]);
      expect(r.status).toBe(0);
      const unused = r.findings.filter((x) => x.rule === "lint-skill-ignore-unused");
      expect(unused).toHaveLength(1);
      expect(unused[0].severity).toBe("INFO");
      expect(unused[0].message).toContain("skill-body-over-reattach-cap=nomatch/*");
    });
  });

  describe("ignore-start / ignore-end markers", () => {
    it("a marker around the fence suppresses it: --strict 0, suppressed.by=marker with the start line and reason", () => {
      const d = skill(["# S", "", START, "```bash", FWD, "```", END, ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(0);
      const f = r.findings.find((x) => x.rule === "plugin-root-in-vm-bash");
      expect(f?.severity).toBe("WARN");
      expect(f?.line).toBe(5);
      expect(f?.suppressed).toEqual({ by: "marker", marker_line: 3, reason: "the build script defaults an empty root" });
    });

    it("one marker names several rules, comma-separated", () => {
      const start = "<!-- lint-skill: ignore-start plugin-root-in-vm-bash, subagent-type-unknown: reviewed -->";
      const d = skill(["# S", "", start, "```bash", FWD, "```", "subagent_type: nowhere-agent", END, ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.findings.filter((x) => !x.suppressed)).toEqual([]);
      expect(r.findings.map((x) => x.rule).sort()).toEqual(["plugin-root-in-vm-bash", "subagent-type-unknown"]);
    });

    it("is scoped: two fences, a marker around the first only → the second still WARNs, --strict 1", () => {
      const d = skill(["# S", "", START, "```bash", FWD, "```", END, "", "```bash", FWD, "```", ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(1);
      const hits = r.findings.filter((x) => x.rule === "plugin-root-in-vm-bash");
      expect(hits.map((x) => [x.line, x.suppressed?.by ?? null])).toEqual([
        [5, "marker"],
        [10, null],
      ]);
    });

    it("is rule-scoped: a marker naming a different rule leaves the plugin-root WARN alone", () => {
      const other = "<!-- lint-skill: ignore-start skill-body-over-reattach-cap: size reviewed -->";
      const d = skill(["# S", "", other, "```bash", FWD, "```", END, ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(1);
      expect(r.findings.find((x) => x.rule === "plugin-root-in-vm-bash")?.suppressed).toBeUndefined();
    });

    it("a marker inside a fence is documentation, not a marker: the WARN still fires", () => {
      const d = skill([
        "# S",
        "",
        "```bash",
        "# lint-skill: ignore-start plugin-root-in-vm-bash: nope",
        FWD,
        "# lint-skill: ignore-end",
        "```",
        "",
      ]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(1);
      expect(r.findings.find((x) => x.rule === "plugin-root-in-vm-bash")?.suppressed).toBeUndefined();
      expect(r.findings.some((x) => x.rule.startsWith("lint-skill-ignore"))).toBe(false);
    });

    it("a marker indented 4+ spaces is indented code, not a marker; up to 3 spaces is still a marker", () => {
      const four = skill(["# S", "", "    " + START, "```bash", FWD, "```", "    " + END, ""]);
      const r4 = run([four, "--json", "--strict"]);
      expect(r4.status).toBe(1);
      expect(r4.findings.find((x) => x.rule === "plugin-root-in-vm-bash")?.suppressed).toBeUndefined();
      const three = skill(["# S", "", "   " + START, "```bash", FWD, "```", "   " + END, ""]);
      expect(run([three, "--json", "--strict"]).status).toBe(0);
    });

    it("a 4-backtick fence holding a ``` line: the marker parser and the linter agree it is still open", () => {
      // If the marker parser closed the fence at the inner ``` (as a naive rule would), it would honour the
      // markers below and suppress the second hit. Both scanners must keep the fence open until ````.
      const d = skill(["# S", "", "````bash", FWD, "```", START, FWD, END, "````", ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(1);
      const hits = r.findings.filter((x) => x.rule === "plugin-root-in-vm-bash");
      expect(hits.map((x) => [x.line, x.suppressed ?? null])).toEqual([
        [4, null],
        [7, null],
      ]);
      expect(r.findings.some((x) => x.rule.startsWith("lint-skill-ignore"))).toBe(false);
    });

    it("a marker inside a ~~~ fence is inert too", () => {
      const d = skill(["# S", "", "~~~bash", START, FWD, END, "~~~", ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(1);
      expect(r.findings.find((x) => x.rule === "plugin-root-in-vm-bash")?.suppressed).toBeUndefined();
    });

    it("a blockquote line is not a marker", () => {
      const d = skill(["# S", "", "> " + START, "```bash", FWD, "```", "> " + END, ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(1);
      expect(r.findings.find((x) => x.rule === "plugin-root-in-vm-bash")?.suppressed).toBeUndefined();
    });

    it("works with CRLF line endings, and in the bare and `[//]: #` spellings", () => {
      const crlf = skill(["# S", "", START, "```bash", FWD, "```", END, ""], "\r\n");
      expect(run([crlf, "--json", "--strict"]).status).toBe(0);
      const bare = skill([
        "# S",
        "",
        "lint-skill: ignore-start plugin-root-in-vm-bash: ok",
        "```bash",
        FWD,
        "```",
        "lint-skill: ignore-end",
        "",
      ]);
      expect(run([bare, "--json", "--strict"]).status).toBe(0);
      const link = skill([
        "# S",
        "",
        "[//]: # (lint-skill: ignore-start plugin-root-in-vm-bash: ok)",
        "```bash",
        FWD,
        "```",
        "[//]: # (lint-skill: ignore-end)",
        "",
      ]);
      expect(run([link, "--json", "--strict"]).status).toBe(0);
    });

    it("an unclosed ignore-start is WARN lint-skill-ignore-unclosed (it still suppresses to EOF); --strict 1", () => {
      const d = skill(["# S", "", START, "```bash", FWD, "```", ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(1);
      const u = r.findings.find((x) => x.rule === "lint-skill-ignore-unclosed");
      expect(u?.severity).toBe("WARN");
      expect(u?.line).toBe(3);
      expect(r.findings.find((x) => x.rule === "plugin-root-in-vm-bash")?.suppressed?.by).toBe("marker");
    });

    it("a nested ignore-start and a stray ignore-end are each WARN lint-skill-ignore-invalid", () => {
      const d = skill(["# S", "", START, START, "```bash", FWD, "```", END, END, ""]);
      const r = run([d, "--json"]);
      const bad = r.findings.filter((x) => x.rule === "lint-skill-ignore-invalid");
      expect(bad.map((x) => x.line)).toEqual([4, 9]);
      expect(bad.every((x) => x.severity === "WARN")).toBe(true);
    });

    it("a marker naming an unknown rule, a provable rule, or no rule is WARN lint-skill-ignore-invalid", () => {
      const d = skill([
        "# S",
        "",
        "<!-- lint-skill: ignore-start plugin-root-in-vm-bsh: typo -->",
        END,
        "<!-- lint-skill: ignore-start hook-event-unknown: nope -->",
        END,
        "<!-- lint-skill: ignore-start -->",
        END,
        "",
      ]);
      const bad = run([d, "--json"]).findings.filter((x) => x.rule === "lint-skill-ignore-invalid");
      expect(bad.map((x) => x.line)).toEqual([3, 5, 7]);
      expect(bad[0].message).toMatch(/unknown lint-skill rule `plugin-root-in-vm-bsh`/);
      expect(bad[0].message).toContain("plugin-root-in-vm-bash");
      expect(bad[1].message).toMatch(/cannot be suppressed/);
    });

    it("`ignore-start: reason` (a reason but no rule) is still a marker: WARN names no rule, on its line", () => {
      const d = skill(["# S", "", "<!-- lint-skill: ignore-start: forwarded to the sub-agent -->", "```bash", FWD, "```", END, ""]);
      const r = run([d, "--json"]);
      const bad = r.findings.filter((x) => x.rule === "lint-skill-ignore-invalid");
      expect(bad.map((x) => [x.line, /names no rule/.test(x.message)])).toEqual([[3, true]]);
      expect(r.findings.find((x) => x.rule === "plugin-root-in-vm-bash")?.suppressed).toBeUndefined();
    });

    it("a marker range that suppresses nothing is INFO lint-skill-ignore-unused; --strict 0", () => {
      const d = skill(["# S", "", START, "Nothing to see.", END, ""]);
      const r = run([d, "--json", "--strict"]);
      expect(r.status).toBe(0);
      const u = r.findings.find((x) => x.rule === "lint-skill-ignore-unused");
      expect(u?.severity).toBe("INFO");
      expect(u?.line).toBe(3);
    });

    it("only suppresses findings in the SAME file: a hooks.json finding at a line inside the range survives", () => {
      const d = mkdtempSync(join(tmpdir(), "cwh-skill-sup-file-"));
      const hookHost = "<!-- lint-skill: ignore-start hook-host-side-write: not this file -->";
      writeFileSync(join(d, "SKILL.md"), ["# S", hookHost, "", "", "", "", "", "", "", END, ""].join("\n"));
      mkdirSync(join(d, "hooks"));
      const cmd = { type: "command", command: "export X=1" };
      writeFileSync(join(d, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [cmd] }] } }, null, 2));
      const r = run([d, "--json", "--strict"]);
      const w = r.findings.find((x) => x.rule === "hook-host-side-write");
      expect(w?.file).toMatch(/hooks\.json$/);
      expect(w?.line).toBeGreaterThan(1);
      expect(w?.line).toBeLessThan(10);
      expect(w?.suppressed).toBeUndefined();
      expect(r.status).toBe(1);
    });
  });

  describe("text output", () => {
    it("prints a suppressed finding with its own glyph, counts it in the summary, and never says clean", () => {
      const d = skill(["# S", "", START, "```bash", FWD, "```", END, ""]);
      const r = run([d, "--strict"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/⊘ WARN \[plugin-root-in-vm-bash\] .*SKILL\.md:5 \(suppressed by marker at :3 — the build script defaults/);
      expect(r.stdout).toMatch(
        /0 error\(s\), 0 warning\(s\), 0 info across 1 file\(s\); 1 suppressed \(plugin-root-in-vm-bash ×1 by marker\)\./,
      );
      expect(r.stdout).not.toMatch(/✓/);
      expect(r.stdout).not.toMatch(/clean/);
    });

    it("an unsuppressed run prints exactly as before (no suppressed count)", () => {
      const d = skill(["# S", "", "```bash", FWD, "```", ""]);
      const r = run([d]);
      expect(r.stdout).toMatch(/0 error\(s\), 1 warning\(s\), 0 info across 1 file\(s\)\.\n?$/);
    });
  });

  // `--suppressions FILE`: reviewed sites listed outside the skill, each entry suppressing AT MOST ONE finding (its
  // rule, exactly its file, and with `match` exactly its source line), so a new copy of an accepted line still reds.
  describe("--suppressions FILE", () => {
    type Entry = { rule?: unknown; file?: unknown; match?: unknown; reason?: unknown; [k: string]: unknown };
    function supFile(entries: Entry[], extra: Record<string, unknown> = {}): string {
      const d = mkdtempSync(join(tmpdir(), "cwh-sup-file-"));
      const f = join(d, "suppressions.json");
      writeFileSync(f, JSON.stringify({ version: 1, suppressions: entries, ...extra }));
      return f;
    }
    /** A skill dir named `sk` under a fresh parent, so entries can name `sk/SKILL.md` (relative to the parent). */
    function namedSkill(lines: string[]): string {
      const parent = mkdtempSync(join(tmpdir(), "cwh-sup-parent-"));
      const d = join(parent, "sk");
      mkdirSync(d);
      writeFileSync(join(d, "SKILL.md"), lines.join("\n"));
      return d;
    }
    const fence = (line: string) => ["```bash", line, "```", ""];
    const SAME = '  --root "$CLAUDE_PLUGIN_ROOT"';
    const OTHER = 'bash "$CLAUDE_PLUGIN_ROOT/x.sh"';
    const entry = (match: string | undefined, reason = "reviewed: host path is right") => ({
      rule: "plugin-root-in-vm-bash",
      file: "sk/SKILL.md",
      ...(match === undefined ? {} : { match }),
      reason,
    });
    const flagged = (r: { findings: SFinding[] }) => r.findings.filter((f) => f.rule === "plugin-root-in-vm-bash");
    const unused = (r: { findings: SFinding[] }) => r.findings.filter((f) => f.rule === "lint-skill-ignore-unused");
    // The consumer's shape: three byte-identical flagged lines plus one distinct one.
    const CONSUMER = ["# S", "", ...fence(SAME), ...fence(SAME), ...fence(SAME), ...fence(OTHER)];
    const FOUR = () => [entry(SAME.trim(), "r0"), entry(SAME.trim(), "r1"), entry(SAME.trim(), "r2"), entry(OTHER, "r3")];

    it("one entry per site: three identical lines + one distinct, four entries → --strict 0, every finding suppressed by file", () => {
      const d = namedSkill(CONSUMER);
      const f = supFile(FOUR());
      const r = run([d, "--json", "--strict", "--suppressions", f]);
      expect(r.status, r.stderr).toBe(0);
      const fl = flagged(r);
      expect(fl).toHaveLength(4);
      for (const x of fl) expect(x.suppressed).toMatchObject({ by: "file", marker_line: null });
      // Byte-identical duplicate entries are allowed and each consumes one finding.
      expect(fl.map((x) => x.suppressed!.source).sort()).toEqual([0, 1, 2, 3].map((i) => `${f}#${i}`));
      expect(fl.find((x) => x.line === 16)?.suppressed).toMatchObject({ reason: "r3", source: `${f}#3` });
      expect(unused(r)).toEqual([]);
    });

    it("a pasted 4th copy of an accepted line fails --strict, and its message names every line of that text", () => {
      const d = namedSkill([...CONSUMER, ...fence(SAME)]);
      const r = run([d, "--json", "--strict", "--suppressions", supFile(FOUR())]);
      expect(r.status).toBe(1);
      const open = flagged(r).filter((x) => !x.suppressed);
      expect(open).toHaveLength(1);
      expect(open[0]!.message).toMatch(/3 entries for this exact line text, 4 finding\(s\) on lines 4, 8, 12, 20/);
    });

    it("a fixed site leaves its entry unused: INFO by default (exit 0), WARN under --strict-ignores (exit 1)", () => {
      const d = namedSkill(["# S", "", ...fence(SAME), ...fence(SAME), ...fence(OTHER)]);
      const f = supFile(FOUR());
      const plain = run([d, "--json", "--strict", "--suppressions", f]);
      expect(plain.status).toBe(0);
      expect(unused(plain)).toHaveLength(1);
      expect(unused(plain)[0]).toMatchObject({ severity: "INFO", file: f, line: null });
      expect(unused(plain)[0]!.message).toMatch(/suppressions entry #2 \(`plugin-root-in-vm-bash` in sk\/SKILL\.md matching/);
      const strict = run([d, "--json", "--strict", "--strict-ignores", "--suppressions", f]);
      expect(strict.status).toBe(1);
      expect(unused(strict).map((u) => u.severity)).toEqual(["WARN"]);
      // Without --strict the promoted WARN is advisory only.
      expect(run([d, "--json", "--strict-ignores", "--suppressions", f]).status).toBe(0);
    });

    it("--strict-ignores also promotes a stale marker and a stale --ignore-rule", () => {
      const d = skill(["# S", "", START, "plain prose", END, ""]);
      const r = run([d, "--json", "--strict", "--strict-ignores", "--ignore-rule", "hook-host-side-write"]);
      expect(r.status).toBe(1);
      expect(unused(r).map((u) => u.severity)).toEqual(["WARN", "WARN"]);
      const plain = run([d, "--json", "--strict", "--ignore-rule", "hook-host-side-write"]);
      expect(plain.status).toBe(0);
      expect(unused(plain).map((u) => u.severity)).toEqual(["INFO", "INFO"]);
    });

    it("a size cap (no line) is suppressed by an entry without match; an entry with match on it is a usage error", () => {
      const d = namedSkill(["# S", "", BIG]);
      const ok = run([
        d,
        "--json",
        "--strict",
        "--suppressions",
        supFile([{ rule: "skill-body-over-reattach-cap", file: "sk/SKILL.md", reason: "accepted" }]),
      ]);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.findings.find((x) => x.rule === "skill-body-over-reattach-cap")?.suppressed).toMatchObject({ by: "file" });
      const bad = run([
        d,
        "--suppressions",
        supFile([{ rule: "skill-body-over-reattach-cap", file: "sk/SKILL.md", match: "x", reason: "r" }]),
      ]);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toMatch(/entry #0: `skill-body-over-reattach-cap` findings carry no line/);
    });

    it("a corpus finding's file is the skill directory itself", () => {
      const d = namedSkill(["# S", ""]);
      mkdirSync(join(d, "references"));
      for (let i = 0; i < 10; i++) writeFileSync(join(d, "references", `p${i}.md`), "y".repeat(54_000));
      const r = run([
        d,
        "--json",
        "--strict",
        "--suppressions",
        supFile([{ rule: "skill-corpus-over-evidence-ceiling", file: "sk", reason: "big on purpose" }]),
      ]);
      expect(r.findings.find((x) => x.rule === "skill-corpus-over-evidence-ceiling")?.suppressed).toMatchObject({ by: "file" });
    });

    it("entries with match are used before entries without, so a broad entry never takes a specific entry's site", () => {
      // The broad entry comes FIRST in the file; greedy file order alone would hand it the SAME line.
      const d = namedSkill(["# S", "", ...fence(SAME), ...fence(OTHER)]);
      const f = supFile([entry(undefined, "broad"), entry(SAME.trim(), "specific")]);
      const r = run([d, "--json", "--strict", "--suppressions", f]);
      expect(r.status).toBe(0);
      expect(flagged(r).find((x) => x.line === 4)?.suppressed).toMatchObject({ reason: "specific" });
      expect(flagged(r).find((x) => x.line === 8)?.suppressed).toMatchObject({ reason: "broad" });
      expect(unused(r)).toEqual([]);
    });

    it("exact matching: short-text entries and longer superset lines are separate classes (all suppressed, none unused)", () => {
      // The consumer's real shape: two lines are the short line's text PLUS more arguments. Under substring
      // matching the three short entries could be spent on the longer lines first and leave a short site red
      // (or vice versa); exact matching puts each entry in exactly one class, where greedy is optimal.
      const LONG = `${SAME.trim()} --extra "y"`;
      const d = namedSkill(["# S", "", ...fence(LONG), ...fence(SAME), ...fence(LONG), ...fence(SAME), ...fence(SAME)]);
      const f = supFile([entry(SAME.trim()), entry(SAME.trim()), entry(SAME.trim()), entry(LONG), entry(LONG)]);
      const r = run([d, "--json", "--strict", "--suppressions", f]);
      expect(r.status, r.stderr).toBe(0);
      expect(flagged(r).every((x) => x.suppressed)).toBe(true);
      expect(unused(r)).toEqual([]);
    });

    it("a finding a marker covers consumes no entry (the entry reports unused); an --ignore-rule still counts as used", () => {
      const d = namedSkill(["# S", "", START, ...fence(FWD), END, ""]);
      const f = supFile([{ rule: "plugin-root-in-vm-bash", file: "sk/SKILL.md", match: FWD, reason: "r" }]);
      const r = run([d, "--json", "--strict", "--suppressions", f, "--ignore-rule", "plugin-root-in-vm-bash"]);
      expect(r.status).toBe(0);
      expect(flagged(r)[0]!.suppressed).toMatchObject({ by: "marker" });
      expect(unused(r).map((u) => u.message)).toEqual([expect.stringMatching(/suppressions entry #0/)]);
    });

    it("a file entry wins over --ignore-rule for the record", () => {
      const d = namedSkill(["# S", "", ...fence(OTHER)]);
      const r = run([d, "--json", "--suppressions", supFile([entry(OTHER, "why")]), "--ignore-rule", "plugin-root-in-vm-bash"]);
      expect(flagged(r)[0]!.suppressed).toMatchObject({ by: "file", reason: "why" });
      expect(unused(r)).toEqual([]);
    });

    it("a skill reached through two spellings is linted once: no doubled finding, and its used marker is not reported unused", () => {
      const d = namedSkill(["# S", "", START, ...fence(FWD), END, ...fence(OTHER)]);
      const parent = join(d, "..");
      const r = spawnSync(
        py,
        [SCRIPT, "lint-skill", "sk", d, "--json", "--strict", "--strict-ignores", "--suppressions", supFile([entry(OTHER)])],
        {
          encoding: "utf8",
          cwd: parent,
        },
      );
      const findings = JSON.parse(r.stdout || "[]") as SFinding[];
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(findings.filter((f) => f.rule === "plugin-root-in-vm-bash")).toHaveLength(2);
      expect(findings.filter((f) => f.rule === "lint-skill-ignore-unused")).toEqual([]);
    });

    it("two genuine findings on one line stay two (each needs its own entry)", () => {
      const d = namedSkill(["# S", "", 'Dispatch subagent_type: "foo-agent" then again subagent_type: "foo-agent".', ""]);
      const r = run([d, "--json"]);
      expect(r.findings.filter((f) => f.rule === "subagent-type-unknown")).toHaveLength(2);
    });

    it("the same suppressions file named twice counts once, so a pasted copy still reds", () => {
      const d = namedSkill(["# S", "", ...fence(OTHER), ...fence(OTHER)]);
      const f = supFile([entry(undefined)]);
      expect(run([d, "--strict", "--suppressions", f]).status).toBe(1);
      expect(run([d, "--strict", "--suppressions", f, "--suppressions", f]).status).toBe(1);
      // Two DIFFERENT files each contribute their entries; the `=` form works too.
      expect(run([d, "--strict", `--suppressions=${f}`, "--suppressions", supFile([entry(undefined)])]).status).toBe(0);
    });

    it("the line-list note goes only on a finding left unsuppressed (not one an --ignore-rule then covered)", () => {
      const d = namedSkill(["# S", "", ...fence(OTHER), ...fence(OTHER)]);
      const r = run([d, "--json", "--suppressions", supFile([entry(OTHER)]), "--ignore-rule", "plugin-root-in-vm-bash"]);
      const byFlag = flagged(r).find((x) => x.suppressed?.by === "flag");
      expect(byFlag).toBeDefined();
      expect(byFlag!.message).not.toMatch(/Suppressions file:/);
    });

    it("CRLF lines with tabs and trailing spaces match a stripped `match`", () => {
      const parent = mkdtempSync(join(tmpdir(), "cwh-sup-crlf-"));
      mkdirSync(join(parent, "sk"));
      writeFileSync(join(parent, "sk", "SKILL.md"), ["# S", "", "```bash", `\t${OTHER}   `, "```", ""].join("\r\n"));
      const r = run([join(parent, "sk"), "--json", "--strict", "--suppressions", supFile([entry(OTHER)])]);
      expect(r.status, JSON.stringify(r.findings)).toBe(0);
      expect(flagged(r)[0]!.suppressed).toMatchObject({ by: "file" });
    });

    it("a hooks.json finding is matched against the hooks file's own line", () => {
      const d = namedSkill(["# S", ""]);
      mkdirSync(join(d, "hooks"));
      writeFileSync(join(d, "hooks", "hooks.json"), ["{", '  "hooks": {', '    "Stop": []', "  }", "}", ""].join("\n"));
      const f = supFile([{ rule: "hook-event-not-served", file: "sk/hooks/hooks.json", match: '"Stop": []', reason: "r" }]);
      const r = run([d, "--json", "--suppressions", f]);
      expect(r.findings.find((x) => x.rule === "hook-event-not-served")?.suppressed).toMatchObject({ by: "file" });
      expect(unused(r)).toEqual([]);
    });

    it("a file reached by two arguments matches its relative name from either, in either order", () => {
      const d = namedSkill(["# S", ""]);
      mkdirSync(join(d, "hooks"));
      const cmd = { type: "command", command: "export X=1" };
      const hp = join(d, "hooks", "hooks.json");
      writeFileSync(hp, JSON.stringify({ hooks: { SessionStart: [{ hooks: [cmd] }] } }, null, 2));
      const f = supFile([{ rule: "hook-host-side-write", file: "sk/hooks/hooks.json", reason: "r" }]);
      // Passed directly, the hooks file's own base is `sk`, so only the skill-dir argument yields `sk/hooks/hooks.json`.
      for (const args of [
        [d, hp],
        [hp, d],
      ]) {
        const r = run([...args, "--json", "--strict", "--strict-ignores", "--suppressions", f]);
        expect(r.status, args.join(" ")).toBe(0);
        expect(r.findings.find((x) => x.rule === "hook-host-side-write")?.suppressed).toMatchObject({ by: "file" });
        expect(unused(r)).toEqual([]);
      }
    });

    it("a UTF-8 BOM is accepted", () => {
      const d = namedSkill(["# S", "", ...fence(OTHER)]);
      const f = join(mkdtempSync(join(tmpdir(), "cwh-sup-bom-")), "s.json");
      writeFileSync(f, "﻿" + JSON.stringify({ version: 1, suppressions: [entry(OTHER)] }));
      expect(run([d, "--strict", "--suppressions", f]).status).toBe(0);
    });

    it("never edits the skill: SKILL.md bytes are unchanged", () => {
      const d = namedSkill(CONSUMER);
      const before = readFileSync(join(d, "SKILL.md"));
      run([d, "--strict", "--suppressions", supFile(FOUR())]);
      expect(readFileSync(join(d, "SKILL.md")).equals(before)).toBe(true);
    });

    it("text mode names the entry and its reason, and groups the summary by suppressions file", () => {
      const d = namedSkill(["# S", "", ...fence(OTHER)]);
      const f = supFile([entry(OTHER, "host-side read")]);
      const r = run([d, "--strict", "--suppressions", f]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`(suppressed by ${f}#0: host-side read)`);
      expect(r.stdout).toMatch(/1 suppressed \(plugin-root-in-vm-bash ×1 by suppressions file\)\./);
    });

    it("a relative --suppressions path resolves against the working directory", () => {
      const d = namedSkill(["# S", "", ...fence(OTHER)]);
      const f = supFile([entry(OTHER)]);
      const r = spawnSync(py, [SCRIPT, "lint-skill", d, "--strict", "--suppressions", "suppressions.json"], {
        encoding: "utf8",
        cwd: join(f, ".."),
      });
      expect(r.status, r.stderr).toBe(0);
    });

    describe("usage errors (exit 2), naming the file and the entry", () => {
      const cases: Array<[string, () => string, RegExp]> = [
        [
          "unknown rule",
          () => supFile([{ rule: "no-such-rule", file: "sk/SKILL.md", reason: "r" }]),
          /entry #0: unknown lint-skill rule: no-such-rule/,
        ],
        [
          "provable rule",
          () => supFile([{ rule: "hooks-json-misplaced", file: "sk/SKILL.md", reason: "r" }]),
          /entry #0: `hooks-json-misplaced` cannot be suppressed/,
        ],
        ["missing reason", () => supFile([{ rule: "plugin-root-in-vm-bash", file: "sk/SKILL.md" }]), /entry #0: `reason` is required/],
        [
          "blank reason",
          () => supFile([{ rule: "plugin-root-in-vm-bash", file: "sk/SKILL.md", reason: "  " }]),
          /entry #0: `reason` is required/,
        ],
        ["missing file", () => supFile([{ rule: "plugin-root-in-vm-bash", reason: "r" }]), /entry #0: `file` is required/],
        [
          "unknown entry key",
          () => supFile([{ rule: "plugin-root-in-vm-bash", file: "sk/SKILL.md", reason: "r", glob: "*" }]),
          /entry #0: unknown key\(s\): glob/,
        ],
        ["unknown top-level key", () => supFile([], { notes: "x" }), /unknown top-level key\(s\): notes/],
        [
          "blank match",
          () => supFile([{ rule: "plugin-root-in-vm-bash", file: "sk/SKILL.md", match: " ", reason: "r" }]),
          /entry #0: `match` must be a non-empty string/,
        ],
      ];
      for (const [name, make, rx] of cases) {
        it(name, () => {
          const f = make();
          const r = run([namedSkill(["# S", ""]), "--suppressions", f]);
          expect(r.status).toBe(2);
          expect(r.stderr).toContain(`--suppressions ${f}`);
          expect(r.stderr).toMatch(rx);
        });
      }
      it("wrong version (incl. true and 1.0), malformed or too-deep JSON, a missing file", () => {
        const dir = mkdtempSync(join(tmpdir(), "cwh-sup-bad-"));
        const write = (name: string, body: string) => {
          const f = join(dir, name);
          writeFileSync(f, body);
          return f;
        };
        const v2 = write("v2.json", JSON.stringify({ version: 2, suppressions: [] }));
        const vTrue = write("vtrue.json", '{"version": true, "suppressions": []}');
        const vFloat = write("vfloat.json", '{"version": 1.0, "suppressions": []}');
        const broken = write("broken.json", "{ not json");
        const deep = write("deep.json", "[".repeat(200_000) + "]".repeat(200_000));
        for (const [f, rx] of [
          [v2, /`version` must be 1/],
          [vTrue, /`version` must be 1/],
          [vFloat, /`version` must be 1/],
          [broken, /not valid JSON/],
          [deep, /nested too deeply/],
          [join(dir, "absent.json"), /cannot read the file/],
        ] as const) {
          const r = run([namedSkill(["# S", ""]), "--suppressions", f]);
          expect(r.status, f).toBe(2);
          expect(r.stderr).toMatch(rx);
        }
      });
    });
  });

  it("`lint --suppressions` / `lint --strict-ignores` name lint-skill as the owner", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-sup-"));
    const f = join(d, "s.yaml");
    writeFileSync(f, "name: s\nfidelity: container\nprompt: hi\nassert:\n  - result: success\n");
    for (const flag of [["--suppressions", "x.json"], ["--suppressions=x.json"], ["--strict-ignores"]]) {
      const r = spawnSync(py, [SCRIPT, "lint", f, ...flag], { encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`(${flag[0].split("=")[0]} is a \`lint-skill\` flag; \`lint\` has no rule suppression)`);
    }
  });

  it("`lint --ignore-rule` names lint-skill as the owner instead of a bare unrecognized-arguments error", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-lint-ignore-rule-"));
    const f = join(d, "s.yaml");
    writeFileSync(f, "name: s\nfidelity: container\nprompt: hi\nassert:\n  - result: success\n");
    const r = spawnSync(py, [SCRIPT, "lint", f, "--ignore-rule", "replay-noop"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--ignore-rule is a `lint-skill` flag; `lint` has no rule suppression/);
  });
});

// Every rule id the linter can emit is claimed by exactly one registry, with the right severity. The
// `--ignore-rule` validation and the marker validation both read LINT_SKILL_RULES, so a new lint-skill rule
// that is not registered would be refused as "unknown" — this catches it at the source. The ids are read
// from scenario.py's own `Finding("<SEV>", "<id>", …)` calls with `ast`, not from a copied list.
describe.skipIf(!havePython)("lint rule registries cover every emitted rule id", () => {
  it("LINT_SKILL_RULES ∪ LINT_RULES = every literal rule id, disjoint, max severity matching", () => {
    const code = [
      "import ast, importlib.util, json, sys",
      "p = sys.argv[1]",
      "spec = importlib.util.spec_from_file_location('scenario_mod', p)",
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "lits = {}",
      "for n in ast.walk(ast.parse(open(p, encoding='utf-8').read())):",
      "    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'Finding' and len(n.args) >= 2 \\",
      "            and all(isinstance(a, ast.Constant) and isinstance(a.value, str) for a in n.args[:2]):",
      "        lits.setdefault(n.args[1].value, []).append(n.args[0].value)",
      "print(json.dumps({'lits': lits, 'skill': {k: v[0] for k, v in m.LINT_SKILL_RULES.items()}, 'lint': m.LINT_RULES}))",
    ].join("\n");
    const r = spawnSync(py, ["-c", code, SCRIPT], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const { lits, skill, lint } = JSON.parse(r.stdout) as {
      lits: Record<string, string[]>;
      skill: Record<string, string>;
      lint: Record<string, string>;
    };
    // The extractor must actually see the rules — an empty set would pass every check below.
    expect(Object.keys(lits).length).toBeGreaterThan(40);
    const both = Object.keys(skill).filter((k) => k in lint);
    expect(both, "claimed by both registries").toEqual([]);
    expect(Object.keys({ ...skill, ...lint }).sort()).toEqual(Object.keys(lits).sort());
    const order = { ERROR: 0, WARN: 1, INFO: 2 } as Record<string, number>;
    for (const [id, sevs] of Object.entries(lits)) {
      const max = sevs.reduce((a, b) => (order[a] <= order[b] ? a : b));
      expect(skill[id] ?? lint[id], `max severity of ${id}`).toBe(max);
    }
  });
});

// A suppressions entry with `match` on a rule in LINELESS_SKILL_RULES is a usage error, because those findings never
// carry a line. Pin that: every emission of those rules passes no line, and every other suppressible rule passes one.
describe.skipIf(!havePython)("LINELESS_SKILL_RULES matches how each rule is emitted", () => {
  it("lineless rules emit no line; the other suppressible rules always pass one", () => {
    const code = [
      "import ast, importlib.util, json, sys",
      "p = sys.argv[1]",
      "spec = importlib.util.spec_from_file_location('scenario_mod', p)",
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "out = {}",
      "for n in ast.walk(ast.parse(open(p, encoding='utf-8').read())):",
      "    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'Finding' and len(n.args) >= 2 \\",
      "            and isinstance(n.args[1], ast.Constant) and n.args[1].value in m.LINT_SKILL_RULES and m.LINT_SKILL_RULES[n.args[1].value][1]:",
      "        has_line = len(n.args) > 5 or any(k.arg == 'line' for k in n.keywords)",
      "        out.setdefault(n.args[1].value, []).append(has_line)",
      "print(json.dumps({'emits': out, 'lineless': sorted(m.LINELESS_SKILL_RULES)}))",
    ].join("\n");
    const r = spawnSync(py, ["-c", code, SCRIPT], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const { emits, lineless } = JSON.parse(r.stdout) as { emits: Record<string, boolean[]>; lineless: string[] };
    expect(Object.keys(emits).length).toBeGreaterThan(8);
    for (const rule of lineless) expect(emits[rule], rule).toBeDefined();
    for (const [rule, lines] of Object.entries(emits)) {
      if (lineless.includes(rule))
        expect(
          lines.every((x) => !x),
          `${rule} emits a line`,
        ).toBe(true);
      else
        expect(
          lines.every((x) => x),
          `${rule} emits without a line`,
        ).toBe(true);
    }
  });
});

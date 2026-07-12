import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `scenario.py` resolves a plugin's valid `<plugin>:<agent>` subagent types statically from
// `plugin.json` + `agents/*.md` frontmatter, and folds a check into `lint-skill` that flags a SKILL.md's
// pinned `subagent_type` values that don't resolve. Unknown bare values are ALWAYS INFO, never WARN —
// there is no harness registry of built-in agent types to disprove them against (only `general-purpose`
// is harness-known).
const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

if (!havePython) {
  // eslint-disable-next-line no-console
  console.warn("python3 not found — subagent-type-resolve tests skipped");
}

type Finding = {
  severity: string;
  rule: string;
  message: string;
  fix: string;
  file: string;
  line: number | null;
};

/** Build a fixture plugin dir: `.claude-plugin/plugin.json` (name: "testplug"), `agents/foo.md`
 * (frontmatter `name: foo`), `agents/bar.md` (NO `name:` frontmatter — resolves via the filename
 * stem `bar`). Returns the plugin dir path. */
function makeFixturePlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-subagent-plugin-"));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "testplug", version: "0.0.1" }, null, 2));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "agents", "foo.md"),
    ["---", "name: foo", "description: a test agent", "---", "", "# Foo agent body", ""].join("\n"),
  );
  // NO `name:` frontmatter — must resolve by filename stem `bar`.
  writeFileSync(join(dir, "agents", "bar.md"), ["# Bar agent (no frontmatter name)", ""].join("\n"));
  return dir;
}

function resolveAgentTypes(pluginDir: string, json: boolean): { status: number | null; stdout: string } {
  const args = ["resolve-agent-types", pluginDir];
  if (json) args.push("--json");
  const r = spawnSync(py, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout || "" };
}

function lintSkill(skillMdPath: string): { status: number | null; findings: Finding[] } {
  const r = spawnSync(py, [SCRIPT, "lint-skill", "--json", skillMdPath], { encoding: "utf8" });
  let findings: Finding[] = [];
  try {
    findings = JSON.parse(r.stdout || "[]");
  } catch {
    findings = [];
  }
  return { status: r.status, findings };
}

describe.skipIf(!havePython)("scenario.py resolve-agent-types", () => {
  it("resolves {testplug:foo, testplug:bar} from plugin.json + agents/*.md frontmatter (text)", () => {
    const dir = makeFixturePlugin();
    const { status, stdout } = resolveAgentTypes(dir, false);
    expect(status).toBe(0);
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(new Set(lines)).toEqual(new Set(["testplug:foo", "testplug:bar"]));
  });

  it("resolves the same set via --json", () => {
    const dir = makeFixturePlugin();
    const { status, stdout } = resolveAgentTypes(dir, true);
    expect(status).toBe(0);
    const types = JSON.parse(stdout);
    expect(new Set(types)).toEqual(new Set(["testplug:foo", "testplug:bar"]));
  });

  it("returns an empty set (no crash) for a dir with no plugin.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-subagent-noplugin-"));
    const { status, stdout } = resolveAgentTypes(dir, true);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});

describe.skipIf(!havePython)("scenario.py lint-skill — subagent_type static resolution", () => {
  function writeSkill(pluginDir: string, subagentTypeLine: string): string {
    const skillsDir = join(pluginDir, "skills", "demo");
    mkdirSync(skillsDir, { recursive: true });
    const md = [
      "---",
      "name: demo",
      "description: a demo skill",
      "---",
      "",
      "# Demo skill",
      "",
      "Dispatch a sub-agent:",
      "",
      "```",
      `Task(description="do the thing", prompt="...", ${subagentTypeLine})`,
      "```",
      "",
    ].join("\n");
    const path = join(skillsDir, "SKILL.md");
    writeFileSync(path, md);
    return path;
  }

  it("CLEAN: subagent_type: testplug:foo resolves within the plugin", () => {
    const dir = makeFixturePlugin();
    const skillPath = writeSkill(dir, 'subagent_type="testplug:foo"');
    const { status, findings } = lintSkill(skillPath);
    expect(findings.filter((f) => f.rule.startsWith("subagent-type"))).toEqual([]);
    expect(status).toBe(0);
  });

  it("CLEAN: subagent_type: testplug:bar resolves via the filename-fallback agent", () => {
    const dir = makeFixturePlugin();
    const skillPath = writeSkill(dir, 'subagent_type="testplug:bar"');
    const { status, findings } = lintSkill(skillPath);
    expect(findings.filter((f) => f.rule.startsWith("subagent-type"))).toEqual([]);
    expect(status).toBe(0);
  });

  it("CLEAN: subagent_type: general-purpose is always clean", () => {
    const dir = makeFixturePlugin();
    const skillPath = writeSkill(dir, 'subagent_type="general-purpose"');
    const { status, findings } = lintSkill(skillPath);
    expect(findings.filter((f) => f.rule.startsWith("subagent-type"))).toEqual([]);
    expect(status).toBe(0);
  });

  it("INFO subagent-type-unresolvable: a cross-plugin pinned type can't be confirmed from here", () => {
    const dir = makeFixturePlugin();
    const skillPath = writeSkill(dir, 'subagent_type="otherplug:baz"');
    const { status, findings } = lintSkill(skillPath);
    const hit = findings.find((f) => f.rule === "subagent-type-unresolvable");
    expect(hit, "expected a subagent-type-unresolvable finding").toBeDefined();
    expect(hit?.severity).toBe("INFO");
    expect(hit?.message).toMatch(/belongs to another plugin/i);
    expect(status).toBe(0); // INFO never fails lint-skill without --strict
  });

  it("INFO subagent-type-not-found-in-plugin: an in-plugin-prefixed but absent agent is a provable typo", () => {
    const dir = makeFixturePlugin();
    const skillPath = writeSkill(dir, 'subagent_type="testplug:qux"');
    const { status, findings } = lintSkill(skillPath);
    const hit = findings.find((f) => f.rule === "subagent-type-not-found-in-plugin");
    expect(hit, "expected a subagent-type-not-found-in-plugin finding").toBeDefined();
    expect(hit?.severity).toBe("INFO");
    expect(findings.some((f) => f.rule === "subagent-type-unknown")).toBe(false);
    expect(findings.some((f) => f.rule === "subagent-type-unresolvable")).toBe(false);
    expect(status).toBe(0); // INFO never fails lint-skill without --strict
  });

  it("INFO subagent-type-unknown (NEVER WARN): an unknown bare pinned type is surfaced, not failed", () => {
    const dir = makeFixturePlugin();
    const skillPath = writeSkill(dir, 'subagent_type="typo-agent"');
    const { status, findings } = lintSkill(skillPath);
    const hit = findings.find((f) => f.rule === "subagent-type-unknown");
    expect(hit, "expected a subagent-type-unknown finding").toBeDefined();
    expect(hit?.severity).toBe("INFO");
    expect(hit?.severity).not.toBe("WARN");
    expect(hit?.message).toMatch(/not defined in this plugin/i);
    expect(status).toBe(0); // fail-on-break: INFO does not exit non-zero without --strict
  });

  it("REGRESSION: `lint-skill --strict` does NOT fail on an INFO-only result (a pinned built-in like `Explore`)", () => {
    const dir = makeFixturePlugin();
    const skillPath = writeSkill(dir, 'subagent_type="Explore"');
    const r = spawnSync(py, [SCRIPT, "lint-skill", "--strict", "--json", skillPath], { encoding: "utf8" });
    const findings: Finding[] = JSON.parse(r.stdout || "[]");
    const hit = findings.find((f) => f.rule === "subagent-type-unknown");
    expect(hit, "expected a subagent-type-unknown INFO for the unresolved bare built-in").toBeDefined();
    expect(hit?.severity).toBe("INFO");
    expect(findings.every((f) => f.severity === "INFO")).toBe(true); // no WARN/ERROR riding along
    expect(r.status).toBe(0); // --strict fails on WARN/ERROR, never on INFO alone
  });

  it("YAML-form `subagent_type: <value>` frontmatter-style pin is also detected", () => {
    const dir = makeFixturePlugin();
    const skillsDir = join(dir, "skills", "demo2");
    mkdirSync(skillsDir, { recursive: true });
    const md = ["# Demo skill 2", "", "Dispatch:", "", "subagent_type: typo-agent", ""].join("\n");
    const path = join(skillsDir, "SKILL.md");
    writeFileSync(path, md);
    const { findings } = lintSkill(path);
    const hit = findings.find((f) => f.rule === "subagent-type-unknown");
    expect(hit, "expected the YAML-form pin to be detected too").toBeDefined();
    expect(hit?.severity).toBe("INFO");
  });
});

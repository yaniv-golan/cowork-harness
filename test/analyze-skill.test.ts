import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { analyzeSkillText } from "../src/run/analyze-skill.js";

const RULE1 = "sessions-path-to-file-tool";
const RULE2 = "sessions-find-into-file-read";

function findRule(text: string, rule: string) {
  return analyzeSkillText(text, "SKILL.md").filter((f) => f.rule === rule);
}

// --------------------------------------------------------------------------------------------- //
// Firing fixtures — each must produce at least one finding of the named rule (and exit-1-worthy).
// --------------------------------------------------------------------------------------------- //

describe("analyzeSkillText — firing cases", () => {
  it("flags an OUTPUT_PATH= assignment pointing at /sessions inside a dispatch prompt block", () => {
    const text = [
      "## Dispatch a research sub-agent",
      "",
      "Use this prompt template:",
      "",
      "```",
      "Task: gather background notes.",
      "OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/notes.md",
      "Write your findings to that path.",
      "```",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.line === 7)).toBe(true);
    expect(hits[0].message).toContain("denied on host-loop");
  });

  it("flags a Write(/sessions/.../out.md) directive target", () => {
    const text = "Then call `Write(/sessions/{{session_id}}/mnt/outputs/out.md)` to save the report.";
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].message).toContain("Write(...)");
  });

  it("flags a find /sessions … output substituted into a Read(...) directive (same line)", () => {
    const text = 'Then run: Read($(find /sessions/{{session_id}} -name "notes.md"))';
    const hits = findRule(text, RULE2);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  it("flags a find /sessions … line whose output visibly feeds the next Read( line", () => {
    const text = ['Run: find /sessions/{{session_id}} -name "notes.md" > $REFS', "Read($REFS)"].join("\n");
    const hits = findRule(text, RULE2);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2); // flagged at the violating Read( call, not the find line
  });

  it("flags Read(/sessions/...) and Edit(/sessions/...) directive targets", () => {
    const text = ["Call `Read(/sessions/{{id}}/mnt/outputs/notes.md)` first.", "Then `Edit(/sessions/{{id}}/mnt/outputs/notes.md)`."].join(
      "\n",
    );
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(2);
    expect(hits.map((f) => f.line).sort()).toEqual([1, 2]);
  });

  it("flags Glob(/sessions/...) and Grep(/sessions/...) path args", () => {
    const text = ['Glob(pattern="**/*.md", path="/sessions/{{id}}/mnt/outputs")', 'Grep(pattern="TODO", path="/sessions/{{id}}")'].join(
      "\n",
    );
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(2);
  });

  it("flags the prose idiom 'save … to `/sessions/...`'", () => {
    const text = "Please save the report to `/sessions/{{session_id}}/mnt/outputs/report.md` when done.";
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain("prose");
  });

  it("flags a bare /sessions path sitting inside a dispatch construct (fenced block with Task()", () => {
    const text = [
      "Dispatch template:",
      "",
      "```",
      'Task(description="fetch", prompt="...", subagent_type="general-purpose")',
      "Expected output:",
      "/sessions/{{session_id}}/mnt/outputs/result.json",
      "```",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(6);
    expect(hits[0].message).toContain("dispatch construct");
  });

  it("flags a bare /sessions path inside a fenced block that mentions subagent_type", () => {
    const text = ["```", "subagent_type: general-purpose", "output: /sessions/{{id}}/mnt/outputs/x.json", "```"].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });
});

// --------------------------------------------------------------------------------------------- //
// Near-miss CLEAN fixtures — the false-positive guards. Every one of these MUST produce zero
// findings; this is the whole risk budget of the task.
// --------------------------------------------------------------------------------------------- //

describe("analyzeSkillText — near-miss clean cases (anti-FP guards)", () => {
  it("does NOT flag 'NEVER write to /sessions/...' (negation idiom)", () => {
    const text = "NEVER write to `/sessions/{{session_id}}/mnt/outputs/x.md` — use the host outputs path instead.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag 'don't', 'do not', or 'avoid' near a /sessions path either", () => {
    for (const word of ["don't", "do not", "avoid"]) {
      const path = "/sessions/{{id}}/mnt/outputs/x.md";
      const text = `Please ${word} write directly to \`${path}\` from a file tool.`;
      expect(analyzeSkillText(text, "SKILL.md"), `word=${word}`).toEqual([]);
    }
  });

  it("does NOT flag a /sessions/<id>/... command inside a ```bash fenced block (legit VM bash)", () => {
    const text = ["```bash", 'cat "/sessions/{{session_id}}/mnt/outputs/notes.md"', "```"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag sh/shell/zsh fences either", () => {
    for (const lang of ["sh", "shell", "zsh"]) {
      const text = ["```" + lang, "OUTPUT_PATH=/sessions/{{id}}/mnt/outputs/x.md", "```"].join("\n");
      expect(analyzeSkillText(text, "SKILL.md"), `lang=${lang}`).toEqual([]);
    }
  });

  it("does NOT flag a host-relative artifacts/out.md output (the canonical host-loop idiom)", () => {
    const text = ["```", "OUTPUT_PATH=artifacts/out.md", "```"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag prose documenting the VM cwd with no file-tool/OUTPUT context", () => {
    const text = "Note: on VM tiers the agent cwd is `/sessions/{{session_id}}` (not applicable on host-loop).";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag a find/Read pair inside a bash fence (legit VM bash, not a file-tool read)", () => {
    const text = ["```bash", 'find /sessions/{{id}} -name "notes.md" > $REFS', "cat $REFS", "```"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag a variable-carried path whose literal value isn't /sessions (documented false negative)", () => {
    const text = ['Run: find /sessions/{{id}} -name "notes.md" > $REFS', "Read($REFS)"].join("\n");
    // The Read() call itself only ever sees $REFS, not a literal /sessions token, so rule 1's
    // directive-target context correctly finds nothing here — only rule 2 (tested above) fires.
    expect(findRule(text, RULE1)).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------- //
// Fail-on-break: every firing fixture MUST flip to clean when isVmSessionsPath is stubbed to
// always-false (proves this analyzer defers to the production predicate, not a re-implementation).
// --------------------------------------------------------------------------------------------- //

describe("fail-on-break — stubbing isVmSessionsPath to always-false clears every firing fixture", () => {
  it("clears the OUTPUT_PATH, directive-target, and find-into-Read firing fixtures", async () => {
    vi.resetModules();
    vi.doMock("../src/vm-paths.js", async () => {
      const actual = await vi.importActual<typeof import("../src/vm-paths.js")>("../src/vm-paths.js");
      return { ...actual, isVmSessionsPath: () => false };
    });
    const { analyzeSkillText: stubbed } = await import("../src/run/analyze-skill.js");

    const outputPathText = "OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/notes.md";
    const writeDirectiveText = "Write(/sessions/{{session_id}}/mnt/outputs/out.md)";
    const findIntoReadText = 'Read($(find /sessions/{{session_id}} -name "notes.md"))';

    expect(stubbed(outputPathText, "SKILL.md")).toEqual([]);
    expect(stubbed(writeDirectiveText, "SKILL.md")).toEqual([]);
    expect(stubbed(findIntoReadText, "SKILL.md")).toEqual([]);

    vi.doUnmock("../src/vm-paths.js");
    vi.resetModules();
  });
});

// --------------------------------------------------------------------------------------------- //
// CLI-level: exit codes + envelope shape.
// --------------------------------------------------------------------------------------------- //

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!can)("analyze-skill CLI — exit codes and envelope", () => {
  it("exits 1 with a finding, 0 clean, on a real SKILL.md file target", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-"));
    const dirty = join(d, "SKILL-dirty.md");
    writeFileSync(dirty, "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    const clean = join(d, "SKILL-clean.md");
    writeFileSync(clean, "OUTPUT_PATH=artifacts/out.md\n");

    const dirtyRun = run(["analyze-skill", dirty], d);
    expect(dirtyRun.code).toBe(1);

    const cleanRun = run(["analyze-skill", clean], d);
    expect(cleanRun.code).toBe(0);
  });

  it("resolves a skill directory to its SKILL.md", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-dir-"));
    const skillDir = join(d, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    const r = run(["analyze-skill", skillDir], d);
    expect(r.code).toBe(1);
  });

  it("exits 2 on a directory with no SKILL.md, and on a missing target", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-usage-"));
    mkdirSync(join(d, "empty-dir"));
    expect(run(["analyze-skill", join(d, "empty-dir")], d).code).toBe(2);
    expect(run(["analyze-skill", join(d, "does-not-exist.md")], d).code).toBe(2);
    expect(run(["analyze-skill"], d).code).toBe(2);
  });

  it("--output-format json emits a machine envelope with ok/findings", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-json-"));
    const dirty = join(d, "SKILL.md");
    writeFileSync(dirty, "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    const r = run(["analyze-skill", dirty, "--output-format", "json"], d);
    expect(r.code).toBe(1);
    const payload = JSON.parse(r.out.trim());
    expect(payload.tool).toBe("cowork-harness");
    expect(payload.command).toBe("analyze-skill");
    expect(payload.ok).toBe(false);
    expect(Array.isArray(payload.findings)).toBe(true);
    expect(payload.findings.length).toBeGreaterThan(0);
    expect(payload.findings[0].rule).toBe(RULE1);
  });

  it("rejects an unknown flag (exit 2, not silently accepted)", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-badflag-"));
    const r = run(["analyze-skill", "SKILL.md", "--zzz-bogus"], d);
    expect(r.code).toBe(2);
  });
});

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

  it("dedupes a token that matches BOTH the OUTPUT_PATH context and the dispatch-construct context to one finding", () => {
    const text = [
      "```",
      'Task(description="deliver", subagent_type="general-purpose")',
      "OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/report.md",
      "```",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].message).toContain("denied on host-loop");
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

  // --- prose that correctly routes a /sessions path through the bash tool must not fire -------- //

  it("does NOT flag prose that explicitly routes the /sessions path through the bash tool", () => {
    const text = "Use the bash tool to write the summary to `/sessions/{{session_id}}/mnt/outputs/summary.md`.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag a prose write instruction whose anti-instruction sits on the ADJACENT line", () => {
    const text = [
      "Never write directly to a /sessions path from a file tool.",
      "Instead, save the report to `/sessions/{{session_id}}/mnt/outputs/summary.md`.",
    ].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- passive tier-documentation prose must not fire ---------------------------------------- //

  it("does NOT flag passive 'are read-only at ...' documentation prose", () => {
    const text = "Uploads are read-only at `/sessions/{{session_id}}/mnt/uploads` on every tier.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag passive 'are saved at ...' documentation prose", () => {
    const text = "Deliverables are saved at `/sessions/{{session_id}}/mnt/outputs` by the in-VM agent.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- a fence info-string must not defeat the bash exemption or cascade into later prose ----- //

  it("does NOT flag a ```bash fence carrying a trailing info-string, and does NOT cascade-swallow later prose", () => {
    const text = [
      '```bash title="deliver.sh"',
      "OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/report.md",
      "```",
      "",
      "Then call `Write(/sessions/{{session_id}}/mnt/outputs/other.md)` to save the report.",
    ].join("\n");
    // The bash-fence line with the info-string is exempt (not flagged)...
    const outputPathHit = findRule(text, RULE1).find((f) => f.line === 2);
    expect(outputPathHit).toBeUndefined();
    // ...and the fence closed properly (no phantom unlabeled fence), so the REAL violation two
    // lines later still fires — proving there's no cascade.
    const laterHit = findRule(text, RULE1).find((f) => f.line === 5);
    expect(laterHit).toBeDefined();
    expect(laterHit?.message).toContain("Write(...)");
  });

  // --- shell-transcript fences and indented/blockquoted code must not fire -------------------- //

  it("does NOT flag a ```console shell-transcript fence", () => {
    const text = ["```console", "$ OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/report.md ./run.sh", "```"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag a 4-space INDENTED (unfenced) shell template", () => {
    const text = ["Run this locally:", "", "    OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/report.md", "    ./run.sh"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag a blockquoted ```bash fence", () => {
    const text = ["> ```bash", "> OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/report.md", "> ```"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- a dispatch prompt that correctly bash-mediates a /sessions path must not fire ---------- //

  it("does NOT flag a /sessions path embedded inside a bash-mediated command string in a Task( prompt", () => {
    const text = ["```", 'Task(prompt="Using the bash tool run: cp report.md /sessions/{{session_id}}/mnt/outputs/")', "```"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- rule 2 must require visible data flow, not just line adjacency ------------------------- //

  it("does NOT flag a find /sessions line adjacent to an UNRELATED Read( with no shared variable", () => {
    const text = ["Run `find /sessions/{{session_id}} -name notes.md` with the bash tool.", "Read(artifacts/index.md)"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- Attack vectors that correctly did NOT fire — regression guards ------------------------- //

  it("does NOT flag a ~~~bash tilde fence (regression guard)", () => {
    const text = ["~~~bash", 'echo "/sessions/{{id}}/mnt/outputs/x.md"', "~~~"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag a Bash(...) directive — not one of the tracked file tools (regression guard)", () => {
    const text = 'Bash(cmd="cat /sessions/{{id}}/mnt/outputs/x.md")';
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // NOTE: the FIRST fix pass treated a same-line stray "not" as suppressing a Write(...) directive too
  // (an accepted trade-off at the time). The SECOND fix pass narrows the negation guard to the
  // low-confidence PROSE context only — a `Write(/sessions/...)` directive target is a machine-unambiguous
  // structured context and must fire regardless of an unrelated "not" on the line (see the
  // "restored true positives" describe block below for the full context-confidence rationale). This
  // fixture is intentionally flipped from CLEAN to FIRING to match that supersession.
  it("DOES flag a real Write(...) directive even with a stray unrelated 'not' on the same line (structured context — negation guard no longer applies)", () => {
    const text = "This report is not final yet; Write(/sessions/{{id}}/mnt/outputs/out.md) saves it anyway.";
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
  });

  // --- rule 2 must key off find's OUTPUT-capture variable, not any shared token (NFP-1) ------- //

  it('does NOT flag rule 2 when the shared token is find\'s OWN input pattern (-name "$NAME"), not its captured output (NFP-1)', () => {
    const text = ['Run `find /sessions/{{id}}/mnt/uploads -name "$NAME"` with the bash tool.', "Read(docs/$NAME/index.md)"].join("\n");
    expect(findRule(text, RULE2)).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------- //
// Restored true positives — the second fix pass. The first FP-fix pass over-corrected: guards meant
// for the low-confidence PROSE context leaked onto HIGH-confidence STRUCTURED contexts
// (OUTPUT_PATH=/OUTPUT_DIR= assignments, Write(/Read(/Edit(/Glob(/Grep( directive targets, and a bare
// /sessions path line inside a dispatch construct), silencing unambiguous true positives. These fixtures
// prove the structured contexts fire again while the FP-clean fixtures above stay clean.
// --------------------------------------------------------------------------------------------- //

describe("analyzeSkillText — restored true positives (context-confidence fixes)", () => {
  // --- OC-1/2/6/9: the negation guard no longer applies to structured contexts ----------------- //

  it("flags Write(/sessions/...) even with an unrelated negation on the very next line (OC-1)", () => {
    const text = ["Write(/sessions/{{id}}/mnt/outputs/out.md) saves the report.", "Do not modify any other file."].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.line === 1)).toBe(true);
  });

  it("flags an OUTPUT_PATH= assignment even with an unrelated negation on the line above (OC-2)", () => {
    const text = ["The report must not be empty.", "OUTPUT_PATH=/sessions/{{id}}/mnt/outputs/report.md"].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.line === 2)).toBe(true);
  });

  it("flags Read(/sessions/...) even with an unrelated negation on the very next line (OC-6)", () => {
    const text = ["Read(/sessions/{{id}}/mnt/outputs/notes.md) loads context.", "Avoid long summaries."].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.line === 1)).toBe(true);
  });

  it("flags a bare dispatch-construct /sessions path even with an unrelated negation on the line above (OC-9)", () => {
    const text = [
      "```",
      'Task(description="deliver", subagent_type="general-purpose")',
      "Do not include drafts.",
      "/sessions/{{id}}/mnt/outputs/result.json",
      "```",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.line === 4)).toBe(true);
  });

  // --- OC-5: a trailing comma (multi-line Task(...) argument list) must not defeat the bare-path match --- //

  it("flags a bare dispatch-construct /sessions path even with a trailing comma (multi-line Task(...) args) (OC-5)", () => {
    const text = [
      "```",
      "Task(",
      '  subagent_type="general-purpose",',
      '  output_path="/sessions/{{id}}/mnt/outputs/x.json",',
      ")",
      "```",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(4);
  });

  it("still flags the comma-less bare dispatch-construct path form (regression check for OC-5)", () => {
    const text = [
      "```",
      'Task(description="fetch", prompt="...", subagent_type="general-purpose")',
      "Expected output:",
      "/sessions/{{id}}/mnt/outputs/result.json",
      "```",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
  });

  // --- OC-3: bash-mention suppression is scoped to the clause linking the verb to the path, not the whole line --- //

  it("flags a prose Write-tool instruction even though an earlier, unrelated clause mentions bash (OC-3)", () => {
    const text = "After the bash step completes, use the Write tool to write the final summary to `/sessions/{{id}}/mnt/outputs/final.md`.";
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].message).toContain("prose");
  });

  it("still does NOT flag prose where bash is the instrument IN THE SAME clause as the verb (regression check for OC-3)", () => {
    const text = "Use the bash tool to write the summary to `/sessions/{{session_id}}/mnt/outputs/summary.md`.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- OC-4: an indented DISPATCH template is analyzed, not exempted as VM bash ----------------- //

  it("analyzes an INDENTED dispatch template (Task(/subagent_type) instead of exempting it as VM bash (OC-4)", () => {
    const text = [
      "Dispatch template:",
      "",
      '    Task(subagent_type="general-purpose")',
      "    OUTPUT_PATH=/sessions/{{id}}/mnt/outputs/result.json",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.line === 4)).toBe(true);
  });

  it("still does NOT flag a plain INDENTED shell template with no dispatch marker (regression check for OC-4)", () => {
    const text = ["Run this locally:", "", "    OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/report.md", "    ./run.sh"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- NFP-1 (positive counterpart): a real VAR=$(find ...) assignment still feeds a Read($VAR) -- //

  it("still flags rule 2 when a VAR=$(find ...) assignment visibly feeds the next Read($VAR) call", () => {
    const text = ['REFS=$(find /sessions/{{id}}/mnt/outputs -name "notes.md")', "Read($REFS)"].join("\n");
    const hits = findRule(text, RULE2);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  // --- Minor: isBashishLang matches KNOWN bash-ish langs exactly, not by "sh"/"bash" prefix ------ //

  it("flags a Write(/sessions/...) inside a ```shiny fence — 'sh' prefix is no longer treated as bash-ish", () => {
    const text = ["```shiny", "Write(/sessions/{{id}}/mnt/outputs/out.md)", "```"].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------------------------- //
// Fail-on-break: every firing fixture MUST flip to clean when isVmSessionsPath is stubbed to
// always-false (proves this analyzer defers to the production predicate, not a re-implementation).
// --------------------------------------------------------------------------------------------- //

describe("fail-on-break — stubbing isVmSessionsPath to always-false clears every firing fixture", () => {
  it("clears the OUTPUT_PATH, directive-target, and find-into-Read firing fixtures", async () => {
    const outputPathText = "OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/notes.md";
    const writeDirectiveText = "Write(/sessions/{{session_id}}/mnt/outputs/out.md)";
    const findIntoReadText = 'Read($(find /sessions/{{session_id}} -name "notes.md"))';

    // Test-honesty check FIRST, unstubbed: prove each fixture actually fires under normal
    // conditions, so the stubbed assertions below can't go vacuous (i.e. "clears" something that
    // was already empty).
    expect(analyzeSkillText(outputPathText, "SKILL.md").length).toBeGreaterThan(0);
    expect(analyzeSkillText(writeDirectiveText, "SKILL.md").length).toBeGreaterThan(0);
    expect(analyzeSkillText(findIntoReadText, "SKILL.md").length).toBeGreaterThan(0);

    vi.resetModules();
    vi.doMock("../src/vm-paths.js", async () => {
      const actual = await vi.importActual<typeof import("../src/vm-paths.js")>("../src/vm-paths.js");
      return { ...actual, isVmSessionsPath: () => false };
    });
    const { analyzeSkillText: stubbed } = await import("../src/run/analyze-skill.js");

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

import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { analyzeSkillText, hasIgnoreMarker, resolveSkillTarget } from "../src/run/analyze-skill.js";

// This repo is pure ESM ("type": "module") — `__dirname` is undefined; derive the repo root from
// `import.meta.url` instead (this file lives at `<repoRoot>/test/analyze-skill.test.ts`).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RULE1 = "sessions-path-to-file-tool";
const RULE2 = "sessions-find-into-file-read";
const RULE_UNCLOSED = "unclosed-ignore-fence";

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

  // --- D-1: the "bash tool" instrument phrase suppresses prose regardless of WHERE on the line it sits -- //

  it("does NOT flag a FRONTED bash-tool instrument clause, comma-severed from the verb ('Using the bash tool, write ... to `/sessions/...`') (D-1)", () => {
    const text = "Using the bash tool, write the summary to `/sessions/{{session_id}}/mnt/outputs/summary.md`.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT flag a TRAILING bash-tool instrument clause, after the path token ('Write ... to `/sessions/...` using the bash tool.') (D-1)", () => {
    const text = "Write the report to `/sessions/{{session_id}}/mnt/outputs/report.md` using the bash tool.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- D-3: a negation in the SAME CLAUSE as a structured directive is the teaching idiom, not a violation --- //

  it("does NOT flag the teaching idiom '❌ Write(...) — never do this; use the bash tool instead.' (D-3, same-clause negation carve-out)", () => {
    const text = "❌ Write(/sessions/{{id}}/mnt/outputs/x.md) — never do this; use the bash tool instead.";
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  // --- D-4: a `#` comment mentioning Task( must not un-exempt the indented block it heads --------------- //

  it("does NOT flag an indented block where the ONLY dispatch marker is inside a `#` comment (D-4)", () => {
    const text = [
      "    # after the Task( dispatch returns, collect via bash:",
      "    OUTPUT_PATH=/sessions/{{id}}/mnt/outputs/report.md",
    ].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
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

  // --- D-2: a BLANK line inside an indented dispatch template must not sever the marker from the path -- //

  it("analyzes an INDENTED dispatch template even when a BLANK line separates Task( from OUTPUT_PATH= (D-2)", () => {
    const text = [
      "Dispatch template:",
      "",
      '    Task(subagent_type="general-purpose")',
      "",
      "    OUTPUT_PATH=/sessions/{{id}}/mnt/outputs/result.json",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.line === 5)).toBe(true);
  });

  // --- D-1 regression: OC-3's unrelated fronted clause ("bash step", not "the bash tool") must still fire --- //

  it("still flags OC-3's fronted 'bash step' clause after the D-1 whole-line 'bash tool' phrase check (regression check for OC-3/D-1)", () => {
    const text = "After the bash step completes, use the Write tool to write the final summary to `/sessions/{{id}}/mnt/outputs/final.md`.";
    const hits = findRule(text, RULE1);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].message).toContain("prose");
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
// The `analyze-skill: ignore` file-level marker — the single switch that silences the ENTIRE
// path-fidelity warning class for a SKILL.md, including a genuine true positive (an explicit author
// override, not a narrower FP guard).
// --------------------------------------------------------------------------------------------- //

describe("analyzeSkillText — `analyze-skill: ignore` marker", () => {
  it("hasIgnoreMarker detects a bare marker line", () => {
    expect(hasIgnoreMarker("some text\nanalyze-skill: ignore\nmore text")).toBe(true);
  });

  it("hasIgnoreMarker detects the marker inside an HTML comment", () => {
    expect(hasIgnoreMarker("some text\n<!-- analyze-skill: ignore -->\nmore text")).toBe(true);
  });

  it("hasIgnoreMarker is false when the marker is absent", () => {
    expect(hasIgnoreMarker("Write(/sessions/{{id}}/mnt/outputs/out.md)")).toBe(false);
  });

  it("suppresses a genuine true-positive Write(/sessions/...) directive when the file carries the marker", () => {
    const text = ["<!-- analyze-skill: ignore -->", "", "Then call `Write(/sessions/{{id}}/mnt/outputs/out.md)` to save the report."].join(
      "\n",
    );
    // Test-honesty check first: the same text WITHOUT the marker actually fires.
    const withoutMarker = text.replace("<!-- analyze-skill: ignore -->\n\n", "");
    expect(analyzeSkillText(withoutMarker, "SKILL.md").length).toBeGreaterThan(0);
    // With the marker, every finding — including this real violation — is suppressed.
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("suppresses a bare marker line (no HTML comment) the same way", () => {
    const text = ["analyze-skill: ignore", "", "OUTPUT_PATH=/sessions/{{session_id}}/mnt/outputs/notes.md"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
  });

  it("does NOT suppress when the marker only appears mid-prose (embedded in a sentence, not the line's sole content)", () => {
    const text = [
      "This skill documents that adding `analyze-skill: ignore` suppresses warnings.",
      "",
      "Then call `Write(/sessions/{{id}}/mnt/outputs/out.md)` to save the report.",
    ].join("\n");
    // The prose line must not register as the marker at all...
    expect(hasIgnoreMarker(text)).toBe(false);
    // ...so the genuine Write(/sessions/...) directive still fires as a real finding.
    const findings = analyzeSkillText(text, "SKILL.md");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.rule === RULE1)).toBe(true);
  });

  it("still recognizes the marker when prefixed with `#` or a list bullet", () => {
    expect(hasIgnoreMarker("# analyze-skill: ignore")).toBe(true);
    expect(hasIgnoreMarker("- analyze-skill: ignore")).toBe(true);
    expect(hasIgnoreMarker("* analyze-skill: ignore")).toBe(true);
  });

  it("still recognizes the marker inside a markdown reference-link comment", () => {
    expect(hasIgnoreMarker("[//]: # (analyze-skill: ignore)")).toBe(true);
  });
});

// --------------------------------------------------------------------------------------------- //
// Scoped ignores — `ignore-next-line` and `ignore-start`/`ignore-end`. Unlike the file-wide
// `analyze-skill: ignore` marker (which blinds the WHOLE file), these silence only the exact
// line(s) they scope, so a single teaching example doesn't blind the rest of the file to a real
// finding — the regression these markers exist to prevent.
// --------------------------------------------------------------------------------------------- //

describe("analyzeSkillText — `ignore-next-line` (line-scoped)", () => {
  it("silences the immediately-following line while a genuine finding on an un-ignored line still fires (regression: adjacent finding must not go silent)", () => {
    const text = [
      "<!-- analyze-skill: ignore-next-line -->",
      "Write(/sessions/{{id}}/mnt/outputs/teaching-example.md)",
      "Write(/sessions/{{id}}/mnt/outputs/real-violation.md)",
    ].join("\n");
    const hits = findRule(text, RULE1);
    // The ignored line (2) is absent...
    expect(hits.some((f) => f.line === 2)).toBe(false);
    // ...but the un-ignored line (3) still fires — the exact regression the file-wide marker caused.
    expect(hits.some((f) => f.line === 3)).toBe(true);
  });

  it("works with the bare, `#`, and list-bullet marker spellings", () => {
    for (const marker of ["analyze-skill: ignore-next-line", "# analyze-skill: ignore-next-line", "- analyze-skill: ignore-next-line"]) {
      const text = [marker, "Write(/sessions/{{id}}/mnt/outputs/x.md)"].join("\n");
      expect(findRule(text, RULE1), `marker=${marker}`).toEqual([]);
    }
  });

  it("does NOT suppress when the marker only appears mid-prose (line-anchored, same as the file-wide marker)", () => {
    const text = ["add `analyze-skill: ignore-next-line` to skip a line", "Write(/sessions/{{id}}/mnt/outputs/out.md)"].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.some((f) => f.line === 2)).toBe(true);
  });

  it("only silences the ONE following line, not the rest of the file", () => {
    const text = [
      "analyze-skill: ignore-next-line",
      "Write(/sessions/{{id}}/mnt/outputs/ignored.md)",
      "Write(/sessions/{{id}}/mnt/outputs/second.md)",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.map((f) => f.line)).toEqual([3]);
  });
});

describe("analyzeSkillText — `ignore-start` / `ignore-end` (block-scoped)", () => {
  it("silences findings inside the fence while findings outside still fire", () => {
    const text = [
      "Write(/sessions/{{id}}/mnt/outputs/before.md)",
      "<!-- analyze-skill: ignore-start -->",
      "Write(/sessions/{{id}}/mnt/outputs/inside-1.md)",
      "Write(/sessions/{{id}}/mnt/outputs/inside-2.md)",
      "<!-- analyze-skill: ignore-end -->",
      "Write(/sessions/{{id}}/mnt/outputs/after.md)",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 6]);
  });

  it("works with the bare marker spelling", () => {
    const text = ["analyze-skill: ignore-start", "Write(/sessions/{{id}}/mnt/outputs/inside.md)", "analyze-skill: ignore-end"].join("\n");
    expect(findRule(text, RULE1)).toEqual([]);
  });

  it("does NOT suppress when either marker only appears mid-prose (line-anchored)", () => {
    const text = [
      "Wrap a block in `analyze-skill: ignore-start` / `analyze-skill: ignore-end` to silence it.",
      "Write(/sessions/{{id}}/mnt/outputs/out.md)",
    ].join("\n");
    const hits = findRule(text, RULE1);
    expect(hits.some((f) => f.line === 2)).toBe(true);
  });

  it("a properly closed fence never emits `unclosed-ignore-fence`", () => {
    const text = ["analyze-skill: ignore-start", "Write(/sessions/{{id}}/mnt/outputs/inside.md)", "analyze-skill: ignore-end"].join("\n");
    expect(findRule(text, RULE_UNCLOSED)).toEqual([]);
  });
});

describe("analyzeSkillText — unclosed `ignore-start` (must-fix: gates visibly, never a silent notice)", () => {
  it("emits its OWN `unclosed-ignore-fence` finding, at the ignore-start line, when there is no matching ignore-end", () => {
    const text = [
      "Write(/sessions/{{id}}/mnt/outputs/before.md)",
      "analyze-skill: ignore-start",
      "Write(/sessions/{{id}}/mnt/outputs/inside.md)",
    ].join("\n");
    const unclosed = findRule(text, RULE_UNCLOSED);
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0].line).toBe(2);

    // Fail-on-break: this is a REAL finding (not a side-channel notice) — it appears in the same
    // findings array as every other rule and would gate under --strict exactly like a genuine
    // sessions-path finding. Removing the unclosed-fence detection would flip `unclosed` to [].
    const all = analyzeSkillText(text, "SKILL.md");
    expect(all.some((f) => f.rule === RULE_UNCLOSED && f.line === 2)).toBe(true);
  });

  it("still suppresses findings from the unclosed ignore-start to EOF (suppress-to-EOF), while the fence finding itself is not suppressed by its own range", () => {
    const text = [
      "analyze-skill: ignore-start",
      "Write(/sessions/{{id}}/mnt/outputs/inside.md)",
      "Write(/sessions/{{id}}/mnt/outputs/also-inside.md)",
    ].join("\n");
    const rule1Hits = findRule(text, RULE1);
    expect(rule1Hits).toEqual([]); // suppressed to EOF
    const unclosedHits = findRule(text, RULE_UNCLOSED);
    expect(unclosedHits).toHaveLength(1); // the fence finding itself still fires
    expect(unclosedHits[0].line).toBe(1);
  });

  it("does not emit `unclosed-ignore-fence` when the file-wide `analyze-skill: ignore` marker is ALSO present (explicit whole-file override wins)", () => {
    const text = ["analyze-skill: ignore", "analyze-skill: ignore-start", "Write(/sessions/{{id}}/mnt/outputs/x.md)"].join("\n");
    expect(analyzeSkillText(text, "SKILL.md")).toEqual([]);
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

describe.skipIf(!can)("analyze-skill CLI — exit codes and envelope (ADVISORY: exit 0 by default, --strict to gate)", () => {
  it("a finding prints but exits 0 by default; a clean file also exits 0", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-"));
    const dirty = join(d, "SKILL-dirty.md");
    writeFileSync(dirty, "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    const clean = join(d, "SKILL-clean.md");
    writeFileSync(clean, "OUTPUT_PATH=artifacts/out.md\n");

    const dirtyRun = run(["analyze-skill", dirty], d);
    expect(dirtyRun.code).toBe(0);
    expect(dirtyRun.err).toMatch(new RegExp(RULE1));

    const cleanRun = run(["analyze-skill", clean], d);
    expect(cleanRun.code).toBe(0);
  });

  it("--strict flips a finding to exit 1; a clean file still exits 0 under --strict", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-strict-"));
    const dirty = join(d, "SKILL-dirty.md");
    writeFileSync(dirty, "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    const clean = join(d, "SKILL-clean.md");
    writeFileSync(clean, "OUTPUT_PATH=artifacts/out.md\n");

    expect(run(["analyze-skill", dirty, "--strict"], d).code).toBe(1);
    expect(run(["analyze-skill", clean, "--strict"], d).code).toBe(0);
  });

  it("the `analyze-skill: ignore` marker suppresses a real finding — exit 0 even under --strict", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-marker-"));
    const suppressed = join(d, "SKILL.md");
    writeFileSync(suppressed, ["<!-- analyze-skill: ignore -->", "", "Write(/sessions/{{id}}/mnt/outputs/out.md)"].join("\n"));

    const defaultRun = run(["analyze-skill", suppressed], d);
    expect(defaultRun.code).toBe(0);

    const strictRun = run(["analyze-skill", suppressed, "--strict"], d);
    expect(strictRun.code).toBe(0);

    const jsonRun = run(["analyze-skill", suppressed, "--strict", "--output-format", "json"], d);
    expect(jsonRun.code).toBe(0);
    const payload = JSON.parse(jsonRun.out.trim());
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].findings).toEqual([]);
    expect(payload.files[0].suppressed).toBe(true);
  });

  it("a marker mentioned only mid-prose does NOT suppress — the real finding still fires and --strict still gates", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-marker-prose-"));
    const notSuppressed = join(d, "SKILL.md");
    writeFileSync(
      notSuppressed,
      [
        "This skill documents that adding `analyze-skill: ignore` suppresses warnings.",
        "",
        "Then call `Write(/sessions/{{id}}/mnt/outputs/out.md)` to save the report.",
      ].join("\n"),
    );

    const defaultRun = run(["analyze-skill", notSuppressed], d);
    expect(defaultRun.code).toBe(0);
    expect(defaultRun.err).toMatch(new RegExp(RULE1));

    const strictRun = run(["analyze-skill", notSuppressed, "--strict"], d);
    expect(strictRun.code).toBe(1);

    const jsonRun = run(["analyze-skill", notSuppressed, "--output-format", "json"], d);
    expect(jsonRun.code).toBe(0);
    const payload = JSON.parse(jsonRun.out.trim());
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].suppressed).toBe(false);
    expect(payload.files[0].findings.length).toBeGreaterThan(0);
  });

  it("an unclosed `ignore-start` prints visibly and gates under --strict (never a silent stderr-only notice)", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-unclosed-"));
    const dirty = join(d, "SKILL.md");
    writeFileSync(dirty, ["analyze-skill: ignore-start", "OUTPUT_PATH=artifacts/out.md"].join("\n"));

    const defaultRun = run(["analyze-skill", dirty], d);
    expect(defaultRun.code).toBe(0);
    expect(defaultRun.err).toMatch(new RegExp(RULE_UNCLOSED));

    const strictRun = run(["analyze-skill", dirty, "--strict"], d);
    expect(strictRun.code).toBe(1);

    const jsonRun = run(["analyze-skill", dirty, "--output-format", "json"], d);
    const payload = JSON.parse(jsonRun.out.trim());
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].findings.some((f: { rule: string }) => f.rule === RULE_UNCLOSED)).toBe(true);
  });

  it("resolves a skill directory to its SKILL.md", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-dir-"));
    const skillDir = join(d, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    expect(run(["analyze-skill", skillDir], d).code).toBe(0);
    expect(run(["analyze-skill", skillDir, "--strict"], d).code).toBe(1);
  });

  it("exits 2 on a directory with no SKILL.md, and on a missing target", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-usage-"));
    mkdirSync(join(d, "empty-dir"));
    expect(run(["analyze-skill", join(d, "empty-dir")], d).code).toBe(2);
    expect(run(["analyze-skill", join(d, "does-not-exist.md")], d).code).toBe(2);
    expect(run(["analyze-skill"], d).code).toBe(2);
  });

  it("--output-format json emits a machine envelope with ok/findings (default exit 0 despite findings)", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-json-"));
    const dirty = join(d, "SKILL.md");
    writeFileSync(dirty, "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    const r = run(["analyze-skill", dirty, "--output-format", "json"], d);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out.trim());
    expect(payload.tool).toBe("cowork-harness");
    expect(payload.command).toBe("analyze-skill");
    expect(payload.ok).toBe(false);
    expect(Array.isArray(payload.files)).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].file).toBe(dirty);
    expect(Array.isArray(payload.files[0].findings)).toBe(true);
    expect(payload.files[0].findings.length).toBeGreaterThan(0);
    expect(payload.files[0].findings[0].rule).toBe(RULE1);
    expect(Array.isArray(payload.scanned)).toBe(true);
    expect(Array.isArray(payload.unscanned)).toBe(true);
  });

  it("--output-format json + --strict exits 1 on a finding", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-json-strict-"));
    const dirty = join(d, "SKILL.md");
    writeFileSync(dirty, "Write(/sessions/{{id}}/mnt/outputs/out.md)\n");
    const r = run(["analyze-skill", dirty, "--strict", "--output-format", "json"], d);
    expect(r.code).toBe(1);
    const payload = JSON.parse(r.out.trim());
    expect(payload.ok).toBe(false);
    expect(payload.files[0].findings.length).toBeGreaterThan(0);
  });

  it("rejects an unknown flag (exit 2, not silently accepted)", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-badflag-"));
    const r = run(["analyze-skill", "SKILL.md", "--zzz-bogus"], d);
    expect(r.code).toBe(2);
  });
});

// --------------------------------------------------------------------------------------------- //
// Directory-target resolution: the union scan (a plugin's dispatch/output contracts often live in
// agents/*.md / references/*.md, not just SKILL.md — a directory target must scan every
// contract-bearing markdown file present, deduped, or it's a false green).
// --------------------------------------------------------------------------------------------- //

const SESSIONS_WRITE = "Write(/sessions/{{id}}/mnt/outputs/out.md)\n";

describe("resolveSkillTarget — directory union resolution", () => {
  it("a plugin-root dir pulls in agents/*.md, references/**/*.md, and commands/*.md", () => {
    const root = mkdtempSync(join(tmpdir(), "as-resolve-plugin-root-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents", "x.md"), "agent doc\n");
    mkdirSync(join(root, "references"));
    writeFileSync(join(root, "references", "y.md"), "reference doc\n");
    mkdirSync(join(root, "commands"));
    writeFileSync(join(root, "commands", "z.md"), "command doc\n");

    const resolved = resolveSkillTarget(root);
    if ("error" in resolved) throw new Error(`expected a resolution, got error: ${resolved.error}`);
    const names = resolved.files.map((f) => f.slice(root.length + 1)).sort();
    expect(names).toEqual([join("agents", "x.md"), join("commands", "z.md"), join("references", "y.md")].sort());
  });

  it("a skill dir inside a plugin also pulls the enclosing plugin's agents/*.md", () => {
    const root = mkdtempSync(join(tmpdir(), "as-resolve-skilldir-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents", "coordinator.md"), "agent doc\n");
    const skillDir = join(root, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "skill body\n");

    const resolved = resolveSkillTarget(skillDir);
    if ("error" in resolved) throw new Error(`expected a resolution, got error: ${resolved.error}`);
    expect(resolved.files).toContain(join(skillDir, "SKILL.md"));
    expect(resolved.files).toContain(join(root, "agents", "coordinator.md"));
  });

  it("a skill dir inside a plugin leaves the plugin's commands/ and sibling skills/ UNSCANNED, named in the banner", () => {
    const root = mkdtempSync(join(tmpdir(), "as-resolve-unscanned-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    mkdirSync(join(root, "commands"));
    writeFileSync(join(root, "commands", "z.md"), "command doc\n");
    const skillDir = join(root, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "skill body\n");
    const siblingDir = join(root, "skills", "other-skill");
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(siblingDir, "SKILL.md"), "sibling skill body\n");

    const resolved = resolveSkillTarget(skillDir);
    if ("error" in resolved) throw new Error(`expected a resolution, got error: ${resolved.error}`);
    expect(resolved.files).not.toContain(join(root, "commands", "z.md"));
    expect(resolved.files).not.toContain(join(siblingDir, "SKILL.md"));
    expect(resolved.unscanned.some((u) => u.includes(join(root, "commands")))).toBe(true);
    expect(resolved.unscanned.some((u) => u.includes(siblingDir))).toBe(true);
  });

  it("this repo's own .claude/skills/cowork-harness/ (plugin.json + top-level SKILL.md + references/, no agents/, no skills/) resolves NON-EMPTY", () => {
    // Regression fixture: rule 1 (top-level SKILL.md) and rule 2 (plugin root) BOTH apply to this exact
    // shape and must union without going empty — the false green this task exists to close.
    const repoRoot = REPO_ROOT;
    const skillDir = join(repoRoot, ".claude", "skills", "cowork-harness");
    const resolved = resolveSkillTarget(skillDir);
    if ("error" in resolved) throw new Error(`expected a non-empty resolution, got error: ${resolved.error}`);
    expect(resolved.files.length).toBeGreaterThan(0);
    expect(resolved.files).toContain(join(skillDir, "SKILL.md"));
    expect(resolved.files.some((f) => f.includes(join("references", "ci-recipe.md")))).toBe(true);
  });

  it("dedup: a dir matching BOTH the top-level-SKILL.md shape and the plugin-root shape analyzes each file ONCE", () => {
    const root = mkdtempSync(join(tmpdir(), "as-resolve-dedup-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    writeFileSync(join(root, "SKILL.md"), "skill body\n");
    mkdirSync(join(root, "references"));
    writeFileSync(join(root, "references", "y.md"), SESSIONS_WRITE);

    const resolved = resolveSkillTarget(root);
    if ("error" in resolved) throw new Error(`expected a resolution, got error: ${resolved.error}`);
    const refPath = join(root, "references", "y.md");
    expect(resolved.files.filter((f) => f === refPath)).toHaveLength(1);
  });

  it("an empty/uncontract dir resolves to a usage error enumerating the shapes it looked for", () => {
    const d = mkdtempSync(join(tmpdir(), "as-resolve-empty-"));
    const emptyDir = join(d, "empty");
    mkdirSync(emptyDir);
    const resolved = resolveSkillTarget(emptyDir);
    if (!("error" in resolved)) throw new Error("expected an error, got a resolution");
    expect(resolved.error).toMatch(/SKILL\.md/);
    expect(resolved.error).toMatch(/plugin\.json/);
    expect(resolved.error).toMatch(/agents/);
  });

  it("a FILE target still resolves to just that file (unchanged single-file behavior)", () => {
    const d = mkdtempSync(join(tmpdir(), "as-resolve-file-"));
    const file = join(d, "SKILL.md");
    writeFileSync(file, "skill body\n");
    const resolved = resolveSkillTarget(file);
    if ("error" in resolved) throw new Error(`expected a resolution, got error: ${resolved.error}`);
    expect(resolved.files).toEqual([file]);
    expect(resolved.unscanned).toEqual([]);
  });
});

describe.skipIf(!can)("analyze-skill CLI — directory union scan (agents/references/commands, plugin-root-aware)", () => {
  it("a /sessions write in a PLUGIN-ROOT agents/x.md fires under --strict — the consumer's exact case", () => {
    const root = mkdtempSync(join(tmpdir(), "as-cli-plugin-agents-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents", "x.md"), SESSIONS_WRITE);

    const defaultRun = run(["analyze-skill", root], root);
    expect(defaultRun.code).toBe(0);
    expect(defaultRun.err).toMatch(new RegExp(RULE1));

    const strictRun = run(["analyze-skill", root, "--strict"], root);
    expect(strictRun.code).toBe(1);
  });

  it("a /sessions write in references/y.md or commands/z.md fires UNLESS scope-ignored (D coexists)", () => {
    const root = mkdtempSync(join(tmpdir(), "as-cli-plugin-refs-cmds-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    mkdirSync(join(root, "references"));
    writeFileSync(join(root, "references", "y.md"), SESSIONS_WRITE);
    mkdirSync(join(root, "commands"));
    writeFileSync(join(root, "commands", "z.md"), SESSIONS_WRITE);

    expect(run(["analyze-skill", root, "--strict"], root).code).toBe(1);

    // Scope-ignored: both teaching examples wrapped, the dir now passes clean under --strict.
    writeFileSync(join(root, "references", "y.md"), "<!-- analyze-skill: ignore -->\n" + SESSIONS_WRITE);
    writeFileSync(join(root, "commands", "z.md"), "<!-- analyze-skill: ignore -->\n" + SESSIONS_WRITE);
    expect(run(["analyze-skill", root, "--strict"], root).code).toBe(0);
  });

  it("a skill dir inside a plugin pulls the enclosing plugin's agents/ — fires under --strict", () => {
    const root = mkdtempSync(join(tmpdir(), "as-cli-skilldir-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents", "coordinator.md"), SESSIONS_WRITE);
    const skillDir = join(root, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "clean skill body, no /sessions mentions here\n");

    expect(run(["analyze-skill", skillDir, "--strict"], root).code).toBe(1);
  });

  it("this repo's own .claude/skills/cowork-harness/ resolves non-empty (regression vs. a zero-file false green)", () => {
    const repoRoot = REPO_ROOT;
    const skillDir = join(".claude", "skills", "cowork-harness");
    const r = run(["analyze-skill", skillDir, "--output-format", "json"], repoRoot);
    expect(r.code).not.toBe(2);
    const payload = JSON.parse(r.out.trim());
    expect(payload.files.length).toBeGreaterThan(0);
  });

  it("an empty/uncontract dir exits 2 with a message enumerating the shapes looked for", () => {
    const d = mkdtempSync(join(tmpdir(), "as-cli-empty-dir-"));
    const emptyDir = join(d, "empty");
    mkdirSync(emptyDir);
    const r = run(["analyze-skill", emptyDir], d);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/SKILL\.md/);
    expect(r.err).toMatch(/plugin\.json/);
  });

  it("dedup: a dir matching two shapes reports each finding ONCE (no duplicate findings or banner entries)", () => {
    const root = mkdtempSync(join(tmpdir(), "as-cli-dedup-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    writeFileSync(join(root, "SKILL.md"), "skill body\n");
    mkdirSync(join(root, "references"));
    writeFileSync(join(root, "references", "y.md"), SESSIONS_WRITE);

    const r = run(["analyze-skill", root, "--output-format", "json"], root);
    const payload = JSON.parse(r.out.trim());
    const refPath = join(root, "references", "y.md");
    expect(payload.files.filter((f: { file: string }) => f.file === refPath)).toHaveLength(1);
    expect(payload.scanned.filter((f: string) => f === refPath)).toHaveLength(1);

    const scopeLines = r.err.split("\n").filter((l) => l.includes(refPath));
    // Once as the per-file header, once inside the "scope: scanned" banner line — never duplicated beyond that.
    expect(scopeLines.length).toBeLessThanOrEqual(2);
  });

  it("emits the `files:`-keyed JSON envelope (not a bare array, not results[]) with a scope banner naming scanned + unscanned", () => {
    const root = mkdtempSync(join(tmpdir(), "as-cli-envelope-"));
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
    mkdirSync(join(root, "commands"));
    writeFileSync(join(root, "commands", "z.md"), "command doc\n");
    const skillDir = join(root, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "clean\n");

    const r = run(["analyze-skill", skillDir, "--output-format", "json"], root);
    const payload = JSON.parse(r.out.trim());
    expect(payload.results).toBeUndefined();
    expect(Array.isArray(payload.files)).toBe(true);
    expect(Array.isArray(payload.scanned)).toBe(true);
    expect(Array.isArray(payload.unscanned)).toBe(true);
    expect(payload.unscanned.length).toBeGreaterThan(0);

    const textRun = run(["analyze-skill", skillDir], root);
    expect(textRun.err).toMatch(/scope: scanned/);
    expect(textRun.err).toMatch(/scope: left unscanned/);
    expect(textRun.err).toContain(join(root, "commands"));
  });
});

import { describe, it, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrompts } from "../src/prompt.js";
import { loadBaseline, BASELINES_DIR } from "../src/baseline.js";
import { SessionConfig } from "../src/session.js";

const baselineFiles = readdirSync(BASELINES_DIR).filter((f) => f.startsWith("desktop-") && f.endsWith(".json"));

describe("baseline prompt-asset references", () => {
  // A repointed/typo'd promptTemplate would otherwise surface only at run time (a hard error in
  // renderPrompts) — guard it statically for every committed baseline.
  it.each(baselineFiles)("%s promptTemplate/subagentAppend resolve to committed files", (file) => {
    const b = JSON.parse(readFileSync(join(BASELINES_DIR, file), "utf8"));
    for (const key of ["promptTemplate", "subagentAppend"] as const) {
      const rel = b.spawn?.[key];
      if (!rel) continue; // absent is legitimate (renderPrompts treats it as no asset)
      expect(existsSync(join(BASELINES_DIR, rel)), `${file} spawn.${key} -> ${rel}`).toBe(true);
    }
  });
});

describe("renderPrompts — desktop-1.18286.0 reconstruction", () => {
  const baseline = loadBaseline("desktop-1.18286.0");
  const sessionId = "vm_test123";

  it("leaves no unresolved {{…}} tokens (account_name unset — default path)", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend, subagentAppend } = renderPrompts(baseline, session, sessionId, "project");
    for (const rendered of [systemPromptAppend, subagentAppend]) {
      expect(rendered).toBeTruthy();
      expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
    }
    expect(systemPromptAppend).toContain("User name: User"); // {{accountName}} default
  });

  it("leaves no unresolved tokens and honors account_name when set", () => {
    const session = SessionConfig.parse({ account_name: "Yaniv" });
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project");
    expect(systemPromptAppend).not.toMatch(/\{\{[^}]*\}\}/);
    expect(systemPromptAppend).toContain("User name: Yaniv");
  });

  it("carries the key behavior-driving sections", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project");
    for (const tag of [
      "<application_details>",
      "<claude_behavior>",
      "<tone_and_formatting>",
      "<ask_user_question_tool>",
      "<todo_list_tool>",
      "<computer_use>",
      "<env>",
    ])
      expect(systemPromptAppend).toContain(tag);
    // The load-bearing identity correction must survive every re-paraphrase.
    expect(systemPromptAppend).toContain("NOT Claude Code");
  });

  it("never leaks a /sessions/ backend path through a computer:// link", () => {
    // sharing_files is deliberately adapted: our {{workspaceFolder}} renders /sessions/…, which the
    // prompt itself forbids exposing — so no rendered computer:// link may embed it.
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project");
    expect(systemPromptAppend).not.toMatch(/computer:\/\/\/?sessions\//);
    expect(systemPromptAppend).not.toContain("computer://{{");
  });

  it("renders both with and without a connected folder", () => {
    const session = SessionConfig.parse({});
    const noFolder = renderPrompts(baseline, session, sessionId, undefined).systemPromptAppend!;
    expect(noFolder).toContain(`/sessions/${sessionId}/mnt/outputs`); // workspaceFolder falls back to outputs
    expect(noFolder).toContain("User selected a folder: false");
    const withFolder = renderPrompts(baseline, session, sessionId, "project").systemPromptAppend!;
    expect(withFolder).toContain(`/sessions/${sessionId}/mnt/project`);
    expect(withFolder).toContain("User selected a folder: true");
  });
});

describe("renderPrompts — host-loop token substitution (P2a)", () => {
  const baseline = loadBaseline("desktop-1.18286.0");
  const sessionId = "vm_test123";

  it("substitutes {{cwd}}/{{workspaceFolder}}/{{skillsDir}} with HOST paths, and fires the uploads pre-replacement (no naive <hostCwd>/mnt/uploads join)", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs",
      hostUploadsDir: "/Users/me/uploads-staging/vm_test123",
      hostWorkspaceFolder: "/Users/me/Project",
      hostSkillsDir: "/Users/me/.cowork-harness/config/skills",
    });
    expect(systemPromptAppend).toBeTruthy();
    const rendered = systemPromptAppend!;
    // {{cwd}} -> hostCwd
    expect(rendered).toContain("/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs");
    // {{workspaceFolder}} -> hostWorkspaceFolder (NOT the VM path)
    expect(rendered).toContain("/Users/me/Project");
    // {{skillsDir}} -> hostSkillsDir
    expect(rendered).toContain("/Users/me/.cowork-harness/config/skills");
    // the dedicated uploads pre-replacement fired: the literal "{{cwd}}/mnt/uploads" resolved to
    // hostUploadsDir, NOT to a naive `<hostCwd>/mnt/uploads` join (which would be a DIFFERENT string here).
    expect(rendered).toContain("/Users/me/uploads-staging/vm_test123");
    expect(rendered).not.toContain("/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs/mnt/uploads");
    // no VM-shaped /sessions/ paths should remain from these four tokens.
    expect(rendered).not.toContain(`/sessions/${sessionId}/mnt`);
    // no unresolved tokens.
    expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("falls back {{skillsDir}} to the verbatim no-skills string when hostSkillsDir is undefined", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/runs/x/work/session/mnt/outputs",
      hostUploadsDir: "/Users/me/runs/x/work/session/mnt/uploads",
      hostWorkspaceFolder: "/Users/me/Project",
      // hostSkillsDir intentionally omitted
    });
    expect(systemPromptAppend).toContain("(no skills directory — skip skill reads)");
    expect(systemPromptAppend).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("falls back {{workspaceFolder}} to hostCwd when no folder is connected", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, undefined, {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/runs/x/work/session/mnt/outputs",
    });
    // both {{cwd}} and {{workspaceFolder}} render the SAME hostCwd fallback.
    const occurrences = systemPromptAppend!.split("/Users/me/runs/x/work/session/mnt/outputs").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(systemPromptAppend).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("non-hostloop tiers are byte-identical to rendering with no hostLoopOpts at all", () => {
    const session = SessionConfig.parse({ account_name: "Yaniv" });
    const withoutOpts = renderPrompts(baseline, session, sessionId, "project").systemPromptAppend;
    const withIgnoredOpts = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "container", // not "hostloop" — every hostLoopOpts field must be ignored
      hostCwd: "/should/not/appear",
      hostUploadsDir: "/should/not/appear/either",
    }).systemPromptAppend;
    expect(withIgnoredOpts).toBe(withoutOpts);
    expect(withIgnoredOpts).not.toContain("/should/not/appear");
  });
});

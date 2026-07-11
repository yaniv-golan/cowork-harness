import { describe, it, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrompts } from "../src/prompt.js";
import { loadBaseline, BASELINES_DIR } from "../src/baseline.js";
import { SessionConfig } from "../src/session.js";

const baselineFiles = readdirSync(BASELINES_DIR).filter((f) => f.startsWith("desktop-") && f.endsWith(".json"));

describe("baseline prompt-asset references", () => {
  // A repointed/typo'd promptTemplate would otherwise surface only at run time (a hard error in
  // renderPrompts) — guard it statically for every committed baseline.
  it.each(baselineFiles)("%s promptTemplate/subagentAppend resolve to committed files", (file) => {
    const b = JSON.parse(readFileSync(join(BASELINES_DIR, file), "utf8"));
    for (const key of ["promptTemplate", "subagentAppend", "subagentAppendHostLoop"] as const) {
      const rel = b.spawn?.[key];
      if (!rel) continue; // absent is legitimate (renderPrompts treats it as no asset)
      expect(existsSync(join(BASELINES_DIR, rel)), `${file} spawn.${key} -> ${rel}`).toBe(true);
    }
  });
});

describe("renderPrompts — desktop-1.18286.0 reconstruction", () => {
  // Loads the 1.18286.2 baseline JSON, not 1.18286.0: this block's own tests render hostloop, which
  // now requires spawn.subagentAppendHostLoop (only backfilled for the verified >=1.18286.2 window —
  // see the per-tier branch-selection describe below). 1.18286.2 points promptTemplate at the SAME
  // reconstructed "prompts/desktop-1.18286.0/system-prompt-append.md" asset this describe exercises,
  // so the rendered systemPromptAppend content this block asserts on is unchanged.
  const baseline = loadBaseline("desktop-1.18286.2");
  const sessionId = "vm_test123";

  it("leaves no unresolved {{…}} tokens (account_name unset — default path)", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend, subagentAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "container",
    });
    for (const rendered of [systemPromptAppend, subagentAppend]) {
      expect(rendered).toBeTruthy();
      expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
    }
    expect(systemPromptAppend).toContain("User name: User"); // {{accountName}} default
  });

  it("leaves no unresolved tokens and honors account_name when set", () => {
    const session = SessionConfig.parse({ account_name: "Yaniv" });
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" });
    expect(systemPromptAppend).not.toMatch(/\{\{[^}]*\}\}/);
    expect(systemPromptAppend).toContain("User name: Yaniv");
  });

  it("carries the key behavior-driving sections", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" });
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

  it("the rendered (non-hostloop) asset contains the instructed computer:// link form", () => {
    // sharing_files now INSTRUCTS computer:// links faithfully. At non-hostloop fidelity
    // {{workspaceFolder}} renders a VM path — that's the production-faithful un-rewritten model
    // context (production's model context keeps /sessions/… forever; only the DISPLAY layer, at
    // hostloop, rewrites it — see src/run/display-translate.ts + the computer_links_resolve
    // assertion in test/computer-links-resolve.test.ts). No leak: this is model-visible text.
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" });
    expect(systemPromptAppend).toContain(`computer:///sessions/${sessionId}/mnt/project/report.docx`);
  });

  it("the rendered HOSTLOOP asset's computer:// link carries the HOST workspace path, with no /sessions/ remnant", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs",
      hostUploadsDir: "/Users/me/uploads-staging/vm_test123",
      hostWorkspaceFolder: "/Users/me/Project",
      hostSkillsDir: "/Users/me/.cowork-harness/config/skills",
    });
    const rendered = systemPromptAppend!;
    const link = "computer:///Users/me/Project/report.docx";
    expect(rendered).toContain(link);
    expect(link).not.toMatch(/\/sessions\//);
  });

  it("renders both with and without a connected folder", () => {
    const session = SessionConfig.parse({});
    const noFolder = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "container" }).systemPromptAppend!;
    expect(noFolder).toContain(`/sessions/${sessionId}/mnt/outputs`); // workspaceFolder falls back to outputs
    expect(noFolder).toContain("User selected a folder: false");
    const withFolder = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" }).systemPromptAppend!;
    expect(withFolder).toContain(`/sessions/${sessionId}/mnt/project`);
    expect(withFolder).toContain("User selected a folder: true");
  });
});

describe("renderPrompts — host-loop token substitution (P2a)", () => {
  // See the comment on the describe above: every test here renders hostloop, which requires the
  // subagentAppendHostLoop pointer (backfilled starting at 1.18286.2, not 1.18286.0).
  const baseline = loadBaseline("desktop-1.18286.2");
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
    const withoutOpts = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" }).systemPromptAppend;
    const withIgnoredOpts = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "container", // not "hostloop" — every hostLoopOpts field must be ignored
      hostCwd: "/should/not/appear",
      hostUploadsDir: "/should/not/appear/either",
    }).systemPromptAppend;
    expect(withIgnoredOpts).toBe(withoutOpts);
    expect(withIgnoredOpts).not.toContain("/should/not/appear");
  });
});

describe("subagentAppend — per-tier branch selection (subagent_env_hl / subagent_env_vm)", () => {
  const baseline = loadBaseline("desktop-1.20186.1");
  const session = SessionConfig.parse({});
  const sessionId = "vm_test123";
  const hlOpts = {
    effectiveFidelity: "hostloop",
    hostCwd: "/Users/me/runs/x/work/session/mnt/outputs",
    hostUploadsDir: "/Users/me/runs/x/work/session/mnt/uploads",
  };

  it("hostloop renders the hl asset: host cwd for file tools, VM root for the bash mount clause", () => {
    const { subagentAppend } = renderPrompts(baseline, session, sessionId, undefined, hlOpts);
    expect(subagentAppend).toBeTruthy();
    // {{cwd}} -> host cwd (file tools reach the real filesystem there)
    expect(subagentAppend).toContain("/Users/me/runs/x/work/session/mnt/outputs");
    // {{vmCwd}}/mnt/ -> the VM session root's mount path (bash side)
    expect(subagentAppend).toContain(`/sessions/${sessionId}/mnt/`);
    expect(subagentAppend).toContain("mcp__workspace__bash");
    expect(subagentAppend).not.toMatch(/\{\{[^}]*\}\}/);
    // the hl branch must NOT claim files exist only in a sandbox (that's the vm branch's claim)
    expect(subagentAppend!.toLowerCase()).not.toContain("only in the sandbox");
  });

  it("container and microvm both render the vm asset (identical bytes, VM paths, no hl claims)", () => {
    const vmC = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "container" }).subagentAppend;
    const vmM = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "microvm" }).subagentAppend;
    expect(vmC).toBeTruthy();
    expect(vmM).toBe(vmC);
    expect(vmC).toContain(`/sessions/${sessionId}`);
    expect(vmC).not.toContain("mnt/outputs/mnt"); // no double-substitution artifacts
  });

  it("protocol gets NO sub-agent append (decided divergence: neither branch text is true on that topology)", () => {
    const { subagentAppend } = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "protocol" });
    expect(subagentAppend).toBeUndefined();
  });

  it("hostloop on a baseline WITHOUT the hl pointer fails loud — never silently falls back to the vm text", () => {
    const old = loadBaseline("desktop-1.15200.0"); // family predates the verified hl text window (>=1.18286.2)
    expect(() => renderPrompts(old, session, sessionId, undefined, hlOpts)).toThrow(/subagentAppendHostLoop/);
  });
});

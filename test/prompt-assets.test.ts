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

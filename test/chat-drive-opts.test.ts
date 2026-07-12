import { describe, it, expect } from "vitest";
import { chatDriveOpts } from "../src/run/chat.js";
import { WORKSPACE_TOOL_ALIASES } from "../src/runtime/hostloop.js";

describe("chatDriveOpts — the chat lane's drive() options (sub-agent append delivery)", () => {
  const prompts = { subagentAppend: "## Cowork environment\n(rendered)" };
  it("carries subagentAppend on a plain (protocol/container) branch", () => {
    expect(chatDriveOpts(prompts)).toEqual({ subagentAppend: "## Cowork environment\n(rendered)" });
  });
  it("carries subagentAppend alongside the hostloop sdkMcp/hooks bundle, plus toolAliases", () => {
    const sdkMcp = { servers: ["workspace"], handle: async () => ({}) };
    const hooks = { definitions: { PreToolUse: [] }, handle: async () => ({}) };
    const out = chatDriveOpts(prompts, { sdkMcp, hooks });
    expect(out.subagentAppend).toBe(prompts.subagentAppend);
    expect(out.sdkMcp).toBe(sdkMcp);
    expect(out.hooks).toBe(hooks);
    // toolAliases rides along with the hostloop bundle (host-loop-only — see WORKSPACE_TOOL_ALIASES).
    expect(out.toolAliases).toEqual(WORKSPACE_TOOL_ALIASES);
  });
  it("omits the key when the renderer selected no append (protocol tier)", () => {
    expect(chatDriveOpts({})).toEqual({ subagentAppend: undefined });
  });
  it("omits toolAliases on a plain (no hl) branch", () => {
    expect(chatDriveOpts(prompts).toolAliases).toBeUndefined();
  });
});

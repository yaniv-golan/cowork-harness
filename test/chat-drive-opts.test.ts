import { describe, it, expect } from "vitest";
import { chatDriveOpts } from "../src/run/chat.js";

describe("chatDriveOpts — the chat lane's drive() options (sub-agent append delivery)", () => {
  const prompts = { subagentAppend: "## Cowork environment\n(rendered)" };
  it("carries subagentAppend on a plain (protocol/container) branch", () => {
    expect(chatDriveOpts(prompts)).toEqual({ subagentAppend: "## Cowork environment\n(rendered)" });
  });
  it("carries subagentAppend alongside the hostloop sdkMcp/hooks bundle", () => {
    const sdkMcp = { servers: ["workspace"], handle: async () => ({}) };
    const hooks = { definitions: { PreToolUse: [] }, handle: async () => ({}) };
    const out = chatDriveOpts(prompts, { sdkMcp, hooks });
    expect(out.subagentAppend).toBe(prompts.subagentAppend);
    expect(out.sdkMcp).toBe(sdkMcp);
    expect(out.hooks).toBe(hooks);
  });
  it("omits the key when the renderer selected no append (protocol tier)", () => {
    expect(chatDriveOpts({})).toEqual({ subagentAppend: undefined });
  });
});

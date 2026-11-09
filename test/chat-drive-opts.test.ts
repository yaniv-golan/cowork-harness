import { describe, it, expect } from "vitest";
import { chatDriveOpts } from "../src/run/chat.js";
import { WORKSPACE_TOOL_ALIASES } from "../src/runtime/hostloop.js";

describe("chatDriveOpts — the chat lane's drive() options (sub-agent append delivery)", () => {
  const prompts = { subagentAppend: "## Cowork environment\n(rendered)" };
  it("carries subagentAppend on the plain (protocol) branch", () => {
    expect(chatDriveOpts(prompts, { tier: "protocol" })).toEqual({ subagentAppend: "## Cowork environment\n(rendered)" });
  });
  it("carries subagentAppend alongside the hostloop sdkMcp/hooks bundle, plus toolAliases", () => {
    const sdkMcp = { servers: ["workspace"], handle: async () => ({}) };
    const hooks = { definitions: { PreToolUse: [] }, handle: async () => ({}) };
    const out = chatDriveOpts(prompts, { tier: "hostloop", sdkMcp, hooks });
    expect(out.subagentAppend).toBe(prompts.subagentAppend);
    expect(out.sdkMcp).toBe(sdkMcp);
    expect(out.hooks).toBe(hooks);
    // toolAliases rides along with the hostloop bundle (host-loop-only — see WORKSPACE_TOOL_ALIASES).
    expect(out.toolAliases).toEqual(WORKSPACE_TOOL_ALIASES);
  });
  it("omits the key when the renderer selected no append (protocol tier)", () => {
    expect(chatDriveOpts({}, { tier: "protocol" })).toEqual({ subagentAppend: undefined });
  });
  it("omits toolAliases on the plain (no wiring) branch", () => {
    expect(chatDriveOpts(prompts, { tier: "protocol" }).toolAliases).toBeUndefined();
  });

  // The container branch USED to drop spawnContainer's sdkMcp bundle on the floor while
  // spawnContainer still put mcp__cowork__present_files + the 5 mcp__skills__/mcp__plugins__ discovery
  // tools on --tools/--allowedTools — advertising tools whose servers were never announced, and
  // silently no-op'ing the skills.suggest_enabled knob on this lane. These pin the forwarding.
  describe("container branch forwards the sdkMcp bundle (regression: it was discarded)", () => {
    const sdkMcp = { servers: ["cowork", "skills", "plugins"], handle: async () => ({}) };
    it("forwards sdkMcp so the declared discovery tools have announced servers", () => {
      const out = chatDriveOpts(prompts, { tier: "container", sdkMcp });
      expect(out.sdkMcp).toBe(sdkMcp);
      expect(out.sdkMcp?.servers).toEqual(["cowork", "skills", "plugins"]);
      expect(out.subagentAppend).toBe(prompts.subagentAppend);
    });
    it("carries NEITHER hooks NOR toolAliases (both are host-loop-only)", () => {
      const out = chatDriveOpts(prompts, { tier: "container", sdkMcp });
      expect(out.hooks).toBeUndefined();
      expect(out.toolAliases).toBeUndefined();
    });
  });

  // `wiring` is REQUIRED (protocol has its own variant) so that forgetting a tier's bundle is a COMPILE
  // error, not a silent no-op — an earlier container bug reverted cleanly past the whole unit suite, because
  // the bug was the CALL SITE and this function was never wrong. `npm run typecheck` (tsconfig.test.json)
  // covers this file, so a 1-arg call fails CI.
  it("protocol carries neither sdkMcp nor hooks nor toolAliases", () => {
    const out = chatDriveOpts(prompts, { tier: "protocol" });
    expect(out.sdkMcp).toBeUndefined();
    expect(out.hooks).toBeUndefined();
    expect(out.toolAliases).toBeUndefined();
  });
});

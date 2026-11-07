// One source for the flags a session decides (sessionFlagArgs), and one record of which launch-plan field reaches
// which tier's agent (SESSION_ARGV_FIELDS). Before this, protocol built its own argv and silently dropped
// `--max-turns`, thinking, `--thinking-display` and `--session-id`/`--resume`: a session's `agent_max_turns` was
// recorded on the result while the protocol agent never received it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadBaseline } from "../src/baseline.js";
import type { LaunchPlan } from "../src/session.js";
import { baseAgentArgs } from "../src/runtime/argv.js";
import { protocolAgentArgs } from "../src/runtime/protocol.js";
import { SESSION_ARGV_FIELDS, renderSessionArgvTable, type SessionArgvDisposition } from "../src/runtime/session-argv-fields.js";

const baseline = loadBaseline("desktop-1.12603.1");
const plan = (over: Partial<LaunchPlan> = {}): LaunchPlan => ({
  configDir: "/HOST/CFG",
  mcpConfig: null,
  permissionMode: "default",
  permissionParity: "cowork",
  baseEnv: {},
  mounts: [],
  pluginDirs: [],
  egressAllow: ["api.anthropic.com"],
  ...over,
});
const protocol = (p: LaunchPlan) => protocolAgentArgs(baseline, p, { workRoot: "/HOST/work" });
const sandbox = (p: LaunchPlan) => baseAgentArgs(baseline, p, { mntRoot: "/sessions/x/mnt" });

// Each flag-bearing field set to a value, and the argv tokens it must produce (flag then value, adjacent).
const SET: Partial<Record<keyof LaunchPlan, { over: Partial<LaunchPlan>; tokens: string[] }>> = {
  model: { over: { model: "claude-x-1" }, tokens: ["--model", "claude-x-1"] },
  effort: { over: { effort: "max" }, tokens: ["--effort", "max"] },
  extendedThinking: { over: { extendedThinking: false }, tokens: ["--thinking", "disabled"] },
  debugMaxThinkingTokens: { over: { debugMaxThinkingTokens: 1234 }, tokens: ["--max-thinking-tokens", "1234"] },
  debugThinkingDisplay: { over: { debugThinkingDisplay: "summarized" }, tokens: ["--thinking-display", "summarized"] },
  agentMaxTurns: { over: { agentMaxTurns: 3 }, tokens: ["--max-turns", "3"] },
  agentSessionId: { over: { agentSessionId: "sid-1" }, tokens: ["--session-id", "sid-1"] },
  resume: { over: { agentSessionId: "sid-1", resume: true }, tokens: ["--resume", "sid-1"] },
  includeHookEvents: { over: { includeHookEvents: true }, tokens: ["--include-hook-events"] },
  answerChannel: { over: { answerChannel: "none" }, tokens: ["--permission-prompts", "none"] },
  pluginDirs: { over: { pluginDirs: ["p/one"] }, tokens: ["--plugin-dir"] },
  mcpConfig: { over: { mcpConfig: "/HOST/mcp.json" }, tokens: ["--mcp-config", "/HOST/mcp.json"] },
  permissionMode: { over: { permissionMode: "acceptEdits" }, tokens: ["--permission-mode", "acceptEdits"] },
};

const hasRun = (argv: string[], tokens: string[]) => argv.some((_, i) => tokens.every((t, j) => argv[i + j] === t));
const entries = Object.entries(SESSION_ARGV_FIELDS) as [keyof LaunchPlan, SessionArgvDisposition][];

describe("SESSION_ARGV_FIELDS: every flag-bearing launch-plan field reaches protocol's agent, or is excluded with a reason", () => {
  it("each argv field has a case here (a new one fails until it is given one)", () => {
    expect(entries.filter(([, d]) => d.argv).map(([k]) => k)).toEqual(Object.keys(SET));
  });

  for (const [field, d] of entries) {
    if (!d.argv) continue;
    const c = SET[field]!;
    it(`${field} → ${d.flag}: protocol ${d.protocol}`, () => {
      const argv = protocol(plan(c.over));
      if (d.protocol === "emitted") expect(hasRun(argv, c.tokens), argv.join(" ")).toBe(true);
      else expect(hasRun(argv, c.tokens)).toBe(false);
    });
  }

  it("the sandbox tiers' argv carries every argv field too (mcp.config arrives as the staged copy the runtime passes)", () => {
    for (const [field, d] of entries) {
      if (!d.argv || field === "mcpConfig") continue;
      expect(hasRun(sandbox(plan(SET[field]!.over)), SET[field]!.tokens), field).toBe(true);
    }
  });

  it("protocol: unset session fields add nothing beyond the always-on effort and thinking defaults", () => {
    const argv = protocol(plan());
    const unset = protocol(plan({ permissionMode: undefined }));
    for (const f of ["--max-turns", "--thinking-display", "--session-id", "--resume", "--model"]) expect(argv).not.toContain(f);
    expect(unset).not.toContain("--permission-mode");
    expect(hasRun(argv, ["--max-thinking-tokens", "31999"])).toBe(true);
  });
});

describe("docs/session.md carries the generated per-tier table", () => {
  it("between its markers, byte for byte", () => {
    const doc = readFileSync("docs/session.md", "utf8");
    const m = doc.match(/<!-- session-argv-fields:start -->\n([\s\S]*?)\n<!-- session-argv-fields:end -->/);
    expect(m, "docs/session.md is missing the session-argv-fields markers").not.toBeNull();
    expect(m![1]).toBe(renderSessionArgvTable());
  });
});

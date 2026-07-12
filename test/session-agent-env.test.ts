import { describe, it, expect } from "vitest";
import { loadSession, agentEnvOverrides, SCRUBBED_AGENT_ENV_KEYS } from "../src/session.js";
import { buildHostLoopNativeEnv } from "../src/runtime/hostloop.js";
import { buildProtocolEnv } from "../src/runtime/protocol.js";
import { spawnEnv } from "../src/runtime/argv.js";
import { loadBaseline } from "../src/baseline.js";
import type { LaunchPlan } from "../src/session.js";

// hostloop AND protocol spawn over the operator's FULL shell env, while container/microvm build a
// constructed allowlist — so an operator-exported CLAUDE_CODE_SUBAGENT_MODEL / ENABLE_TOOL_SEARCH /
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS silently affects only the env-inheriting tiers. `agent_env` is
// the authored knob that applies uniformly across all four tiers; the three keys are scrubbed from the
// OPERATOR layer on hostloop/protocol (the only tiers that inherit it) before any baseline/knob overlay.

describe("agent_env — the tier-uniform gated-env knob", () => {
  it("maps the three fields to their exact env keys", () => {
    const cfg = loadSession({ agent_env: { subagent_model: "claude-haiku-x", tool_search: "off", disable_experimental_betas: true } });
    expect(agentEnvOverrides(cfg.agent_env)).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-x",
      ENABLE_TOOL_SEARCH: "off",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    });
  });

  it("unset fields emit NO keys (absent = binary mode tst, ToolSearch ON — never an empty string)", () => {
    expect(agentEnvOverrides(loadSession({}).agent_env)).toEqual({});
  });

  it("hostloop scrubs the OPERATOR layer only, preserving a BASELINE value, and the knob wins last", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "stray-from-shell";
    process.env.ENABLE_TOOL_SEARCH = "auto";
    try {
      // A baseline whose spawn.env legitimately sets one of the three keys must NOT be erased by the
      // operator-layer scrub (the scrub must touch process.env only, before the baseline overlay).
      const base = loadBaseline("latest");
      const baseWithKey = { ...base, spawn: { ...base.spawn, env: { ...(base.spawn?.env ?? {}), ENABLE_TOOL_SEARCH: "auto" } } };
      const env = buildHostLoopNativeEnv(baseWithKey as never, {
        configDir: "/tmp/cfg",
        agentEnv: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-x" },
      });
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-haiku-x"); // knob wins over the stray operator value
      expect(env.ENABLE_TOOL_SEARCH).toBe("auto"); // baseline value PRESERVED (scrub touched only process.env, not the baseline overlay)
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      delete process.env.ENABLE_TOOL_SEARCH;
    }
  });

  it("hostloop scrubs a stray operator value that neither baseline nor knob sets → absent", () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    try {
      const env = buildHostLoopNativeEnv(loadBaseline("latest"), { configDir: "/tmp/cfg" });
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    }
  });

  it("container/microvm: the knob rides in via spawnEnv's `extra` (which wins last), no operator inheritance", () => {
    const env = spawnEnv(loadBaseline("latest"), {
      configGuest: "/mnt/.config",
      proxyHost: "http://p",
      extra: { ...agentEnvOverrides(loadSession({ agent_env: { subagent_model: "claude-haiku-x" } }).agent_env) },
    });
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-haiku-x");
  });

  it("protocol scrubs a stray operator value with no baseline overlay (two-layer: knob > operator)", () => {
    process.env.ENABLE_TOOL_SEARCH = "auto";
    try {
      const plan = { baseEnv: { ...process.env }, agentEnv: {} } as unknown as LaunchPlan;
      const env = buildProtocolEnv(plan);
      expect(env.ENABLE_TOOL_SEARCH).toBeUndefined();
    } finally {
      delete process.env.ENABLE_TOOL_SEARCH;
    }
  });

  it("protocol: the knob wins over a stray operator value (no baseline layer at all)", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "stray-from-shell";
    try {
      const plan = { baseEnv: { ...process.env }, agentEnv: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-x" } } as unknown as LaunchPlan;
      const env = buildProtocolEnv(plan);
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-haiku-x");
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
  });

  it("SCRUBBED_AGENT_ENV_KEYS is exactly the three inheritance-asymmetric keys", () => {
    expect([...SCRUBBED_AGENT_ENV_KEYS].sort()).toEqual(
      ["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_SUBAGENT_MODEL", "ENABLE_TOOL_SEARCH"].sort(),
    );
  });
});

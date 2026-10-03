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
      const env = buildProtocolEnv(plan, loadBaseline("latest"));
      expect(env.ENABLE_TOOL_SEARCH).toBeUndefined();
    } finally {
      delete process.env.ENABLE_TOOL_SEARCH;
    }
  });

  it("protocol: the knob wins over a stray operator value (no baseline layer at all)", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "stray-from-shell";
    try {
      const plan = { baseEnv: { ...process.env }, agentEnv: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-x" } } as unknown as LaunchPlan;
      const env = buildProtocolEnv(plan, loadBaseline("latest"));
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-haiku-x");
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
  });

  // The two _FORCE keys added 2026-09-06 need the SAME real-path coverage as the original three, not just
  // membership in the list. The "exact-key" test below hand-builds an env object and calls delete itself —
  // it proves the semantics of the list, and NOTHING about whether the spawn builders consult it for these
  // keys. Drive the real builders, one per inheriting tier, exactly as the three cases above do.
  it("hostloop scrubs a stray CLAUDE_CODE_SUBAGENT_MODEL_FORCE (no knob exists for it)", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = "1";
    try {
      const env = buildHostLoopNativeEnv(loadBaseline("latest"), { configDir: "/tmp/cfg" });
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
    }
  });

  it("protocol scrubs a stray CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL", () => {
    process.env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL = "1";
    try {
      // `baseEnv` is the source buildProtocolEnv scrubs — NOT process.env. Passing a plan without it
      // makes the assertion vacuous: the key was never in the object, so `toBeUndefined()` holds no
      // matter what the scrub list says. (Written that way first; caught by mutating the list and
      // watching this test keep passing.)
      const plan = { baseEnv: { ...process.env }, agentEnv: {} } as unknown as LaunchPlan;
      const env = buildProtocolEnv(plan, loadBaseline("latest"));
      expect(env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL;
    }
  });

  // The enabling key for the second one is deliberately NOT scrubbed — see the membership rule on
  // SCRUBBED_AGENT_ENV_KEYS. Pinned so that decision is visible as a choice rather than an omission, and
  // so flipping it is a deliberate test edit rather than a silent widening.
  it("CLAUDE_CODE_COORDINATOR_MODE is deliberately NOT scrubbed", () => {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = "1";
    try {
      const env = buildHostLoopNativeEnv(loadBaseline("latest"), { configDir: "/tmp/cfg" });
      expect(env.CLAUDE_CODE_COORDINATOR_MODE).toBe("1");
    } finally {
      delete process.env.CLAUDE_CODE_COORDINATOR_MODE;
    }
  });

  it("SCRUBBED_AGENT_ENV_KEYS is exactly the five inheritance-asymmetric keys", () => {
    expect([...SCRUBBED_AGENT_ENV_KEYS].sort()).toEqual(
      [
        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ENABLE_TOOL_SEARCH",
        "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
        "CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL",
      ].sort(),
    );
  });

  // The two _FORCE keys were missed for as long as they existed because the scrub is EXACT-KEY: a reader
  // scanning the list sees `CLAUDE_CODE_SUBAGENT_MODEL` and assumes the family is covered. Pin the
  // mechanism, not just the membership — a future prefix-matching "simplification" would pass the test
  // above while silently changing which keys survive.
  it("scrubbing is exact-key: a same-prefix key not in the list is NOT scrubbed", () => {
    const env: Record<string, string> = {
      CLAUDE_CODE_SUBAGENT_MODEL: "x",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      CLAUDE_CODE_SUBAGENT_MODEL_NOT_A_REAL_KEY: "keep",
    };
    for (const k of SCRUBBED_AGENT_ENV_KEYS) delete env[k];
    expect(env).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL_NOT_A_REAL_KEY: "keep" });
  });
});

// Desktop 2.16120.0's W2 base env sets PYTHONDONTWRITEBYTECODE="1" unconditionally. The harness carries it
// through the pinned baseline spawn.env, so every tier's agent spawn env must include it: container and
// microvm build theirs with spawnEnv, hostloop with buildHostLoopNativeEnv (over hostNativeSpawnEnv).
describe("PYTHONDONTWRITEBYTECODE reaches the agent spawn env on every tier (Desktop 2.16120.0)", () => {
  const base = () => loadBaseline("desktop-2.16120.0");
  it('the 2.16120.0 baseline pins it to "1"', () => {
    expect(base().spawn?.env?.PYTHONDONTWRITEBYTECODE).toBe("1");
  });
  it("container/microvm (spawnEnv)", () => {
    expect(spawnEnv(base(), { configGuest: "/mnt/.claude", proxyHost: "http://p" }).PYTHONDONTWRITEBYTECODE).toBe("1");
  });
  it("hostloop (native process env)", () => {
    expect(buildHostLoopNativeEnv(base(), { configDir: "/tmp/cfg" }).PYTHONDONTWRITEBYTECODE).toBe("1");
  });
});

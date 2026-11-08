import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostLoopNativeEnv, hostLoopAgentEnv, HOST_TMPDIR_KEY } from "../src/runtime/hostloop.js";
import { buildProtocolEnv, protocolOperatorEnv } from "../src/runtime/protocol.js";
import { passthroughRefusal, passthroughRefusalSet, passthroughUnsetNotice } from "../src/runtime/passthrough.js";
import { SESSIONS_OAUTH_TOKEN_KEY } from "../src/runtime/host-env.js";
import { hostInheritedKeys } from "../src/sync/spawn-env-registry.js";
import { agentEnvForTier } from "../src/run/execute.js";
import { buildSessionFingerprint } from "../src/run/cassette.js";
import { buildLaunchPlan, loadSession, SessionConfig, type LaunchPlan } from "../src/session.js";
import { loadBaseline } from "../src/baseline.js";
import type { PlatformBaseline } from "../src/types.js";

// The hostloop agent's env is built from named keys, as Desktop builds its host-loop spawn: Desktop's copied set, the
// session's `agent_env.passthrough`, and what the harness constructs. Nothing else from the operator's env reaches it.

const BASE = loadBaseline("latest");
const SIX = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];
const session = (agent_env: Record<string, unknown>) => ({ agent_env }) as { agent_env: { passthrough?: string[] } };
const build = (operatorEnv: NodeJS.ProcessEnv, passthrough?: string[]) =>
  buildHostLoopNativeEnv(BASE, { configDir: "/tmp/cfg", extra: { TZ: "UTC", ANTHROPIC_API_KEY: "k" }, operatorEnv, passthrough });

afterEach(() => vi.unstubAllEnvs());

describe("the hostloop operator layer is Desktop's copied set", () => {
  it("the copied set is the registry's six host-inherited names", () => {
    expect([...hostInheritedKeys()].sort()).toEqual(SIX);
  });

  it("copies the six (and CLAUDE_CODE_TMPDIR when set), and nothing else from the operator's env", () => {
    const op: NodeJS.ProcessEnv = Object.fromEntries(SIX.map((k) => [k, `op-${k}`]));
    Object.assign(op, {
      [HOST_TMPDIR_KEY]: "/op/tmp",
      TMPDIR: "/var/folders/op",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      SOME_RANDOM_VAR: "x",
      [SESSIONS_OAUTH_TOKEN_KEY]: "s",
      HTTPS_PROXY: "http://p:1",
      SSH_AUTH_SOCK: "/tmp/ssh",
      LANG: "en_US.UTF-8",
    });
    const env = build(op);
    for (const k of SIX) expect(env[k], k).toBe(`op-${k}`);
    expect(env[HOST_TMPDIR_KEY]).toBe("/op/tmp");
    for (const k of ["TMPDIR", "ANTHROPIC_BASE_URL", "SOME_RANDOM_VAR", SESSIONS_OAUTH_TOKEN_KEY, "HTTPS_PROXY", "SSH_AUTH_SOCK", "LANG"])
      expect(env[k], k).toBeUndefined();
  });

  it("a name the operator does not set is not invented", () => {
    expect(build({})[HOST_TMPDIR_KEY]).toBeUndefined();
    expect(build({}).TERM).toBeUndefined();
  });

  it("a passthrough name is copied, with its value", () => {
    const env = build({ ANTHROPIC_BASE_URL: "https://gateway.example", HTTPS_PROXY: "http://p:1" }, ["ANTHROPIC_BASE_URL", "HTTPS_PROXY"]);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
    expect(env.HTTPS_PROXY).toBe("http://p:1");
  });
});

describe("agent_env.passthrough: what it may name", () => {
  const refusalSet = [...passthroughRefusalSet(BASE)].sort();

  it("the refusal set is derived from the builder, and covers what a hand list missed", () => {
    for (const k of [
      "TZ",
      "CLAUDE_PLUGIN_ROOT",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_HOST_PLATFORM",
      "CLAUDE_CODE_DESKTOP_APP_VERSION",
      "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
      "MAX_THINKING_TOKENS",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      SESSIONS_OAUTH_TOKEN_KEY,
      ...Object.keys(BASE.spawn?.env ?? {}),
    ])
      expect(refusalSet, k).toContain(k);
    expect(refusalSet).not.toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(refusalSet).not.toContain("ANTHROPIC_BASE_URL");
  });

  it.each(refusalSet)("%s is refused at hostloop and protocol", (name) => {
    for (const tier of ["hostloop", "protocol"])
      expect(passthroughRefusal(session({ passthrough: [name] }), tier, BASE), tier).toMatch(/agent_env\.passthrough/);
  });

  it("with the token, no name in the refusal set delivers the operator's value: none is over-included", () => {
    const op = Object.fromEntries(refusalSet.map((k) => [k, "SENTINEL"]));
    const env = buildHostLoopNativeEnv(BASE, {
      configDir: "/tmp/cfg",
      extra: { CLAUDE_PLUGIN_ROOT: "", TZ: "UTC", CLAUDE_CODE_OAUTH_TOKEN: "t" },
      folderHostPaths: ["/f"],
      operatorEnv: op,
      passthrough: refusalSet,
    });
    for (const k of refusalSet) expect(env[k], k).not.toBe("SENTINEL");
  });

  it("container and microvm refuse any list; an empty one is fine", () => {
    for (const tier of ["container", "microvm"]) {
      expect(passthroughRefusal(session({ passthrough: ["ANTHROPIC_BASE_URL"] }), tier, BASE)).toMatch(/applies at fidelity hostloop/);
      expect(passthroughRefusal(session({ passthrough: [] }), tier, BASE)).toBeUndefined();
      expect(passthroughRefusal(session({}), tier, BASE)).toBeUndefined();
    }
  });

  it("an ordinary name passes at hostloop and protocol (CLAUDE_CODE_COORDINATOR_MODE included: not scrubbed on purpose)", () => {
    for (const tier of ["hostloop", "protocol"])
      for (const n of ["ANTHROPIC_BASE_URL", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "SSH_AUTH_SOCK", "LANG", "CLAUDE_CODE_COORDINATOR_MODE"])
        expect(passthroughRefusal(session({ passthrough: [n] }), tier, BASE), `${tier} ${n}`).toBeUndefined();
  });

  it("protocol also refuses the baseline's bgEnvStrip names (Cowork strips them), hostloop does not", () => {
    const strip = BASE.bgEnvStrip?.knownVars ?? [];
    const free = strip.filter((n) => !refusalSet.includes(n));
    expect(free.length).toBeGreaterThan(0);
    for (const n of free) {
      expect(passthroughRefusal(session({ passthrough: [n] }), "protocol", BASE), n).toMatch(/bgEnvStrip/);
      expect(passthroughRefusal(session({ passthrough: [n] }), "hostloop", BASE), n).toBeUndefined();
    }
  });

  it("ANTHROPIC_CUSTOM_HEADERS is refused while the agent is given the OAuth token, and passes with the API key", () => {
    const s = session({ passthrough: ["ANTHROPIC_CUSTOM_HEADERS"] });
    expect(passthroughRefusal(s, "hostloop", BASE, { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" })).toMatch(
      /while the agent is given the OAuth token.*ANTHROPIC_API_KEY/,
    );
    expect(passthroughRefusal(s, "hostloop", BASE, { ANTHROPIC_API_KEY: "k" })).toBeUndefined();
  });

  it("a credential is refused, named as one", () => {
    for (const n of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", SESSIONS_OAUTH_TOKEN_KEY])
      expect(passthroughRefusal(session({ passthrough: [n] }), "hostloop", BASE), n).toMatch(/cannot carry a credential/);
  });

  it("the schema takes env-variable names only", () => {
    expect(() => SessionConfig.parse({ agent_env: { passthrough: ["A_B", "lower_ok"] } })).not.toThrow();
    for (const bad of ["1ABC", "A-B", "A B", ""]) expect(() => SessionConfig.parse({ agent_env: { passthrough: [bad] } }), bad).toThrow();
  });

  it("names a requested variable this environment does not set, names only", () => {
    expect(passthroughUnsetNotice(["SET_ONE", "UNSET_ONE", "EMPTY_ONE"], { SET_ONE: "v", EMPTY_ONE: "" })).toBe(
      "[agent_env] passthrough: not set in this environment, so not passed: UNSET_ONE",
    );
    expect(passthroughUnsetNotice(["SET_ONE"], { SET_ONE: "v" })).toBeUndefined();
    expect(passthroughUnsetNotice(undefined)).toBeUndefined();
  });
});

describe("the plan records the passthrough names that apply at its tier", () => {
  const plan = (tier: "hostloop" | "protocol" | "container") =>
    buildLaunchPlan(loadSession({ agent_env: { passthrough: ["HTTPS_PROXY"] } }), BASE, mkdtempSync(join(tmpdir(), "pt-plan-")), tier);
  it("hostloop and protocol carry the list; container (refused before any plan) carries none", () => {
    expect(plan("hostloop").agentEnvPassthrough).toEqual(["HTTPS_PROXY"]);
    expect(plan("protocol").agentEnvPassthrough).toEqual(["HTTPS_PROXY"]);
    expect(plan("container").agentEnvPassthrough).toBeUndefined();
  });
  it("hostLoopAgentEnv (the spawn's env) delivers it", () => {
    vi.stubEnv("HTTPS_PROXY", "http://p:1");
    expect(hostLoopAgentEnv(BASE, plan("hostloop")).HTTPS_PROXY).toBe("http://p:1");
  });
});

describe("the hook scan reads the env the agent was spawned with, per tier", () => {
  const KEY = "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG";
  const mk = (tier: "hostloop" | "protocol", passthrough?: string[]): LaunchPlan =>
    buildLaunchPlan(loadSession({ agent_env: passthrough ? { passthrough } : {} }), BASE, mkdtempSync(join(tmpdir(), "pt-scan-")), tier);
  it("hostloop: an operator export the agent never got is not in the scan's env; a passthrough of it is", () => {
    vi.stubEnv(KEY, "1");
    expect(agentEnvForTier(mk("hostloop"), "hostloop", BASE)[KEY]).toBeUndefined();
    expect(agentEnvForTier(mk("hostloop", [KEY]), "hostloop", BASE)[KEY]).toBe("1");
    const p = mk("hostloop");
    expect(agentEnvForTier(p, "hostloop", BASE)).toEqual(hostLoopAgentEnv(BASE, p));
  });
  it("protocol: the agent inherits the operator's env, and the scan's env is buildProtocolEnv's", () => {
    vi.stubEnv(KEY, "1");
    const p = mk("protocol");
    expect(agentEnvForTier(p, "protocol", BASE)[KEY]).toBe("1");
    expect(agentEnvForTier(p, "protocol", BASE)).toEqual(buildProtocolEnv(p, BASE));
  });
});

describe("protocol drops CLAUDE_CODE_SESSIONS_OAUTH_TOKEN", () => {
  it("an operator export does not reach the protocol agent", () => {
    const env = protocolOperatorEnv({ baseEnv: { [SESSIONS_OAUTH_TOKEN_KEY]: "s", KEEP_ME: "k" }, agentEnv: {} });
    expect(env[SESSIONS_OAUTH_TOKEN_KEY]).toBeUndefined();
    expect(env.KEEP_ME).toBe("k");
  });
});

describe("the session fingerprint covers passthrough", () => {
  const fp = (yaml: string) => {
    const d = mkdtempSync(join(tmpdir(), "pt-fp-"));
    writeFileSync(join(d, "session.yaml"), yaml);
    return buildSessionFingerprint(join(d, "session.yaml"));
  };
  it("a list moves the hash; order and duplicates do not; no list hashes as a session without agent_env", () => {
    const none = fp("model: claude-sonnet-5\n");
    expect(fp("model: claude-sonnet-5\nagent_env: {}\n")).toBe(none);
    const a = fp("model: claude-sonnet-5\nagent_env:\n  passthrough: [B, A]\n");
    expect(a).not.toBe(none);
    expect(fp("model: claude-sonnet-5\nagent_env:\n  passthrough: [A, B, A]\n")).toBe(a);
    expect(fp("model: claude-sonnet-5\nagent_env:\n  passthrough: [A]\n")).not.toBe(a);
  });
});

describe("searchCorpusPreflight builds with the session's passthrough", () => {
  it("a passed-through ANTHROPIC_BASE_URL is what the search-corpus refusal sees", async () => {
    const { searchCorpusPreflight } = await import("../src/run/execute.js");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example");
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    const r = searchCorpusPreflight({
      scenario: {} as never,
      session: { agent_env: { passthrough: ["ANTHROPIC_BASE_URL"] } } as never,
      baseline: BASE as PlatformBaseline,
      effectiveFidelity: "hostloop",
    });
    expect("refusal" in r && r.refusal).toMatch(/ANTHROPIC_BASE_URL points the agent elsewhere/);
    const plain = searchCorpusPreflight({
      scenario: {} as never,
      session: { agent_env: {} } as never,
      baseline: BASE as PlatformBaseline,
      effectiveFidelity: "hostloop",
    });
    expect("refusal" in plain ? plain.refusal : "").not.toMatch(/ANTHROPIC_BASE_URL/);
  });
});

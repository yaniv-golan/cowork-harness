import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHostLoopNativeEnv, hostLoopSidecarEnv } from "../src/runtime/hostloop.js";
import { dockerRunArgv } from "../src/runtime/argv.js";
import { runtimeAuthEnv, TOKEN_PATH_DROPPED_ENV_KEYS } from "../src/runtime/host-env.js";
import { searchCorpusPreflight } from "../src/run/execute.js";
import { harnessHostLoopKeys } from "../src/sync/observed-spawn-env.js";
import { extractSearchAnchors } from "../src/sync/search-anchors.js";
import { loadBaseline } from "../src/baseline.js";
import { bundle } from "./helpers/search-anchor-bundle.js";
import type { PlatformBaseline, Scenario } from "../src/types.js";
import type { loadSession } from "../src/session.js";

// The hostloop agent gets named keys from the operator's env (Desktop's copied set, plus `agent_env.passthrough`), never a
// credential: the one it is given comes from runtimeAuthEnv (the OAuth token, else the API key). Every case stubs all
// four names: runtimeAuthEnv reads process.env, so an unstubbed name would make the outcome depend on the machine.

const NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"] as const;
type Name = (typeof NAMES)[number];
const credentialKeys = (env: NodeJS.ProcessEnv) => NAMES.filter((k) => env[k] !== undefined).sort();
function stubCredentials(set: Partial<Record<Name, string>>) {
  for (const k of NAMES) vi.stubEnv(k, set[k]);
}
const BASE = loadBaseline("latest");

afterEach(() => {
  vi.unstubAllEnvs();
});

// [case, what the operator exports, the credential keys the agent's env must carry: exactly these]
const cases: Array<[string, Partial<Record<Name, string>>, Name[]]> = [
  [
    "token + key + bearer token + custom headers → the token alone",
    { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "b", ANTHROPIC_CUSTOM_HEADERS: "x-h: 1" },
    ["CLAUDE_CODE_OAUTH_TOKEN"],
  ],
  ["token + key → the token alone", { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, ["CLAUDE_CODE_OAUTH_TOKEN"]],
  ["token only → unchanged", { CLAUDE_CODE_OAUTH_TOKEN: "t" }, ["CLAUDE_CODE_OAUTH_TOKEN"]],
  ["key only (no token) → the key, unchanged", { ANTHROPIC_API_KEY: "k" }, ["ANTHROPIC_API_KEY"]],
  [
    "no token: key + bearer token + custom headers → the key alone (the others reach it only by passthrough)",
    { ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "b", ANTHROPIC_CUSTOM_HEADERS: "x-h: 1" },
    ["ANTHROPIC_API_KEY"],
  ],
  ["bearer token only → none (it reaches the agent at protocol only)", { ANTHROPIC_AUTH_TOKEN: "b" }, []],
];

describe("hostloop agent env: the token is the only credential when the agent is given it", () => {
  it("drops exactly the API key, the bearer token and the custom headers", () => {
    expect([...TOKEN_PATH_DROPPED_ENV_KEYS].sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"]);
  });

  // spawnHostLoop has no env seam short of a Docker sidecar, so this replicates its call (src/runtime/hostloop.ts,
  // `buildHostLoopNativeEnv(baseline, { …, extra: { CLAUDE_PLUGIN_ROOT, ...runtimeAuthEnv() } })`) rather than
  // exercising it. searchCorpusPreflight below is exercised for real.
  it.each(cases)("buildHostLoopNativeEnv as spawnHostLoop calls it: %s", (_n, set, want) => {
    stubCredentials(set);
    const env = buildHostLoopNativeEnv(BASE, { configDir: "/tmp/cfg", extra: { CLAUDE_PLUGIN_ROOT: "", ...runtimeAuthEnv() } });
    expect(credentialKeys(env)).toEqual([...want].sort());
    if (want.includes("CLAUDE_CODE_OAUTH_TOKEN")) expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("t");
    expect(env.TZ).toBeTruthy();
  });

  // The credential comes from `extra`, never from the operator layer: an operator export is not copied either way.
  it("an operator layer's key is not copied: with extra carrying none, the agent has no credential", () => {
    stubCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    const env = buildHostLoopNativeEnv(BASE, { configDir: "/tmp/cfg", operatorEnv: { ANTHROPIC_API_KEY: "k" }, extra: { TZ: "UTC" } });
    expect(credentialKeys(env)).toEqual([]);
  });
  it("extra with the token: the token alone, whatever the operator layer holds", () => {
    stubCredentials({});
    const env = buildHostLoopNativeEnv(BASE, {
      configDir: "/tmp/cfg",
      operatorEnv: { ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "b" },
      extra: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
    });
    expect(credentialKeys(env)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });
  // The token-path delete still runs after the copy: a passthrough can never re-admit a credential beside the token
  // (passthroughRefusal refuses these names first; this is the builder's own backstop).
  it("with the token, a passthrough of the dropped keys does not re-admit them", () => {
    stubCredentials({});
    const env = buildHostLoopNativeEnv(BASE, {
      configDir: "/tmp/cfg",
      operatorEnv: { ANTHROPIC_API_KEY: "k", ANTHROPIC_CUSTOM_HEADERS: "h" },
      passthrough: ["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS"],
      extra: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
    });
    expect(credentialKeys(env)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });
  it("with the API key, a passthrough of ANTHROPIC_CUSTOM_HEADERS reaches the agent", () => {
    stubCredentials({ ANTHROPIC_API_KEY: "k", ANTHROPIC_CUSTOM_HEADERS: "x-h: 1" });
    const env = buildHostLoopNativeEnv(BASE, { configDir: "/tmp/cfg", extra: runtimeAuthEnv(), passthrough: ["ANTHROPIC_CUSTOM_HEADERS"] });
    expect(credentialKeys(env)).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS"]);
  });

  // Deleted from the operator layer before the overlay: a key the baseline's spawn env sets survives.
  it("keeps a dropped key the baseline's spawn env sets itself", () => {
    stubCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_CUSTOM_HEADERS: "from-operator" });
    const pinned = {
      ...BASE,
      spawn: { ...BASE.spawn, env: { ...(BASE.spawn?.env ?? {}), ANTHROPIC_CUSTOM_HEADERS: "from-baseline" } },
    } as PlatformBaseline;
    const env = buildHostLoopNativeEnv(pinned, { configDir: "/tmp/cfg", extra: runtimeAuthEnv() });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("from-baseline");
  });

  it("ANTHROPIC_BASE_URL reaches the agent only when the session passes it through", () => {
    stubCredentials({ ANTHROPIC_API_KEY: "k" });
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example");
    expect(buildHostLoopNativeEnv(BASE, { configDir: "/tmp/cfg", extra: runtimeAuthEnv() }).ANTHROPIC_BASE_URL).toBeUndefined();
    const passed = buildHostLoopNativeEnv(BASE, { configDir: "/tmp/cfg", extra: runtimeAuthEnv(), passthrough: ["ANTHROPIC_BASE_URL"] });
    expect(passed.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
  });

  it("sync's comparison (an empty operator layer) keeps the same key set whatever the maintainer exports", () => {
    stubCredentials({});
    const clean = harnessHostLoopKeys(BASE);
    stubCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "b", ANTHROPIC_CUSTOM_HEADERS: "h" });
    const exported = harnessHostLoopKeys(BASE);
    expect([...exported].sort()).toEqual([...clean].sort());
    expect(credentialKeys(Object.fromEntries([...clean].map((k) => [k, ""])))).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });
});

describe("searchCorpusPreflight judges the env the agent will get", () => {
  // A synthetic agent whose search anchors the baseline is given, so the preflight runs to the end and returns the
  // agent env it built (the call site under test), rather than refusing before it.
  function anchoredBaseline(): PlatformBaseline {
    const dir = mkdtempSync(join(tmpdir(), "hl-cred-"));
    const agent = join(dir, "claude");
    writeFileSync(agent, bundle());
    const got = extractSearchAnchors(bundle());
    if (!got.ok) throw new Error(`synthetic bundle has no anchors: ${got.defects.join("; ")}`);
    vi.stubEnv("COWORK_HOST_AGENT_BINARY", agent);
    return { ...BASE, agentBinary: { ...BASE.agentBinary!, searchAnchors: { ...got.anchors, source: "native" } } } as PlatformBaseline;
  }
  const run = (baseline: PlatformBaseline) =>
    searchCorpusPreflight({
      scenario: {} as Scenario,
      session: { agent_env: {} } as unknown as ReturnType<typeof loadSession>,
      baseline,
      effectiveFidelity: "hostloop",
    });

  it.each([
    ["token + key + bearer token + custom headers", cases[0][1], ["CLAUDE_CODE_OAUTH_TOKEN"]],
    ["key only (control)", { ANTHROPIC_API_KEY: "k" }, ["ANTHROPIC_API_KEY"]],
  ] as const)("%s", (_n, set, want) => {
    const baseline = anchoredBaseline();
    stubCredentials(set);
    const r = run(baseline);
    if ("refusal" in r) throw new Error(`refused: ${r.refusal}`);
    expect(credentialKeys(r.agentEnv)).toEqual([...want].sort());
  });
});

describe("the hostloop bash sidecar (Bash tool calls, skill scripts) never gets a credential", () => {
  it("its env is the proxy settings alone, and its docker argv names no credential", () => {
    stubCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "b", ANTHROPIC_CUSTOM_HEADERS: "h" });
    const env = hostLoopSidecarEnv("http://proxy:3128");
    expect(credentialKeys(env)).toEqual([]);
    const argv = dockerRunArgv({
      network: "cowork-net",
      lockdown: true,
      sessionRoot: "/sessions/T",
      sessionHost: "/HOST/SESSION",
      agentHost: "/HOST/claude",
      agentIn: "/usr/local/bin/claude",
      image: "cowork-agent-base:2",
      env,
      name: "hl-sidecar",
    });
    for (const k of NAMES) expect(argv.join(" ")).not.toContain(k);
  });
});

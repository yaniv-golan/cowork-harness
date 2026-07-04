import { describe, it, expect } from "vitest";
import { loadBaseline } from "../src/baseline.js";
import type { LaunchPlan } from "../src/session.js";
import { agentArgs, spawnEnv, dockerRunArgv } from "../src/runtime/argv.js";
import { microvmAgentArgs } from "../src/runtime/microvm.js";
import { makeWorkspaceHandler } from "../src/hostloop/workspace-handler.js";
import { serializeDecision, type DecisionRequest } from "../src/agent/session.js";
import { ScriptedDecider, PermissionDefaultDecider, type Decision, type RunContext } from "../src/decide/decider.js";

// Golden snapshot suite — asserts the CONTRACT LAYER against SPEC.md.
// Snapshots catch ANY change (review the diff); the inline invariant assertions catch the
// specific SPEC §9 regressions even if a snapshot is blessed carelessly.

const baseline = loadBaseline("desktop-1.12603.1");
const ID = "local_TEST";
const mntRoot = `/sessions/${ID}/mnt`;
const sessionRoot = `/sessions/${ID}`;
const configGuest = `${mntRoot}/.claude`;

function plan(over: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    configDir: "/HOST/CFG",
    mcpConfig: null,
    effort: "high",
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [".local-plugins/cache/my-skill"],
    egressAllow: ["api.anthropic.com"],
    ...over,
  };
}

const dockerInput = (agentArgv: string[], name?: string) => ({
  network: "cowork-net",
  lockdown: true,
  sessionRoot,
  sessionHost: "/HOST/SESSION",
  agentHost: "/HOST/claude",
  agentIn: "/usr/local/bin/claude",
  image: "cowork-agent-base:2",
  env: spawnEnv(baseline, { configGuest, proxyHost: "http://egress-proxy:8080" }),
  agentArgv,
  name,
});

const lastFlag = (args: string[]) => args.filter((a) => a.startsWith("--")).pop();

// CLAUDE_CODE_HOST_PLATFORM is `process.platform`-derived by design — real on macOS dev, "linux"
// on CI (ubuntu-latest). Golden snapshots must stay reproducible across both, so redact it to a fixed
// placeholder before snapshotting; the actual live value is pinned by an inline assertion instead
// (below, and in test/execute.test.ts's host-identity suite) so a regression to the wrong var/shape still fails loud.
const HOST_PLATFORM_PLACEHOLDER = "<host-platform>";
const redactHostPlatformEnv = (env: Record<string, string>): Record<string, string> => ({
  ...env,
  CLAUDE_CODE_HOST_PLATFORM: HOST_PLATFORM_PLACEHOLDER,
});
const redactHostPlatformArgv = (argv: string[]): string[] =>
  argv.map((a) => (a === `CLAUDE_CODE_HOST_PLATFORM=${process.platform}` ? `CLAUDE_CODE_HOST_PLATFORM=${HOST_PLATFORM_PLACEHOLDER}` : a));

describe("golden — container (VM-loop)", () => {
  const args = agentArgs(baseline, plan(), { mntRoot });
  it("agentArgs snapshot", () => expect(args).toMatchSnapshot());
  it("dockerRunArgv snapshot", () => expect(redactHostPlatformArgv(dockerRunArgv(dockerInput(args)))).toMatchSnapshot());
  it("spawnEnv snapshot", () =>
    expect(redactHostPlatformEnv(spawnEnv(baseline, { configGuest, proxyHost: "http://egress-proxy:8080" }))).toMatchSnapshot());

  it("#28 — secret env renders by NAME only (no value in argv); non-secrets keep KEY=value", () => {
    const input = { ...dockerInput(args), env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-secret-xyz", FOO_PUBLIC: "bar" } };
    const docker = dockerRunArgv(input);
    expect(docker).toContain("CLAUDE_CODE_OAUTH_TOKEN"); // passed by name (docker inherits the value)
    expect(docker.join("\0")).not.toContain("sk-secret-xyz"); // the token value never appears in argv
    expect(docker).toContain("FOO_PUBLIC=bar"); // non-secret keeps the explicit value
  });

  it("#23 — a mode:r mount gets a nested :ro bind (read-only enforcement)", () => {
    const docker = dockerRunArgv({ ...dockerInput(args), readOnlyMountPaths: ["uploads/report.pdf"] });
    expect(docker).toContain(`/HOST/SESSION/mnt/uploads/report.pdf:${sessionRoot}/mnt/uploads/report.pdf:ro`);
    // no read-only paths → no extra binds (snapshot/default path unchanged)
    expect(dockerRunArgv(dockerInput(args)).filter((a) => a.endsWith(":ro")).length).toBe(1); // only the agent bind
  });

  it("SPEC §9 argv invariants", () => {
    const docker = dockerRunArgv(dockerInput(args));
    expect(docker[docker.indexOf("-w") + 1]).toBe(sessionRoot); // cwd = session root, not mnt
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(`${mntRoot}/.local-plugins/cache/my-skill`);
    expect(args.indexOf("--tools")).toBeGreaterThan(args.indexOf("--effort")); // variadic flags last
    expect(lastFlag(args)).toMatch(/--tools|--allowedTools/);
  });

  it("SPEC §9 env invariants", () => {
    const env = spawnEnv(baseline, { configGuest, proxyHost: "P" });
    expect(env.CLAUDE_CONFIG_DIR).toBe(configGuest);
    expect(env.CLAUDE_CODE_IS_COWORK).toBe("1");
    expect(env.CLAUDE_CODE_USE_COWORK_PLUGINS).toBeUndefined(); // never set
    expect(env.MAX_THINKING_TOKENS).toBe("31999"); // never 0
    expect(env.CLAUDE_CODE_HOST_PLATFORM).toBe(process.platform); // win32|darwin|linux, ELF-validated
  });
});

describe("golden — host-loop (deltas)", () => {
  const args = agentArgs(baseline, plan(), {
    mntRoot,
    systemPromptAppend: "## Shell access\n...",
    disallowed: ["Bash", "WebFetch", "NotebookEdit"],
    extraTools: ["mcp__workspace__bash", "mcp__workspace__web_fetch"],
  });
  it("agentArgs snapshot", () => expect(args).toMatchSnapshot());
  it("dockerRunArgv snapshot (named for docker exec)", () =>
    expect(redactHostPlatformArgv(dockerRunArgv(dockerInput(args, `cowork-hl-${ID}`)))).toMatchSnapshot());

  it("SPEC §3.4 host-loop invariants", () => {
    expect(args.slice(args.indexOf("--disallowedTools"))).toEqual(expect.arrayContaining(["Bash", "WebFetch", "NotebookEdit"]));
    const toolsAfter = args.slice(args.indexOf("--tools"));
    expect(toolsAfter).toContain("mcp__workspace__bash");
    expect(toolsAfter).not.toContain("Bash");
    expect(dockerRunArgv(dockerInput(args, `cowork-hl-${ID}`))).toContain("--name");
    const env = spawnEnv(baseline, { configGuest, proxyHost: "P", extra: { CLAUDE_PLUGIN_ROOT: "/host/plugins/my-skill" } });
    expect(env.CLAUDE_PLUGIN_ROOT).toMatch(/^\/host\//); // unmounted host path -> self-heal
  });
});

describe("session permission_mode reaches every sandbox tier (not just L0)", () => {
  const flagVal = (args: string[]) => args[args.indexOf("--permission-mode") + 1];

  it("agentArgs (L1 container/host-loop) emits the session's acceptEdits, not the baseline default", () => {
    expect(flagVal(agentArgs(baseline, plan({ permissionMode: "acceptEdits" }), { mntRoot }))).toBe("acceptEdits");
  });
  it("microvmAgentArgs (L2) emits the session's bypassPermissions", () => {
    expect(flagVal(microvmAgentArgs(baseline, plan({ permissionMode: "bypassPermissions" }), mntRoot))).toBe("bypassPermissions");
  });
  it("#32 — microvmAgentArgs (L2) includes --max-thinking-tokens before the variadic --tools flags", () => {
    const a = microvmAgentArgs(baseline, plan(), mntRoot);
    const mtt = a.indexOf("--max-thinking-tokens");
    expect(mtt).toBeGreaterThan(-1);
    expect(Number(a[mtt + 1])).toBeGreaterThan(0);
    if (a.indexOf("--tools") >= 0) expect(mtt).toBeLessThan(a.indexOf("--tools")); // before variadic flags
  });
  it("a default-permission session is unchanged at both tiers (golden parity)", () => {
    expect(flagVal(agentArgs(baseline, plan(), { mntRoot }))).toBe("default");
    expect(flagVal(microvmAgentArgs(baseline, plan(), mntRoot))).toBe("default");
  });
});

describe("golden — control envelopes", () => {
  // Drive the REAL runtime path (ScriptedDecider / PermissionDefaultDecider → serializeDecision), the
  // same code `Run` uses on the wire — not a parallel adapter. So the snapshot reflects exactly what the
  // agent receives: an AskUserQuestion allow carries BOTH `updatedInput.questions` AND `updatedInput.answers`
  // (the O7 invariant — `questions` is required by the in-VM binary's handler and must never be dropped).
  const ctx: RunContext = { task: "", transcript: () => "", toolLog: () => [], runId: "g" };
  const envelope = (req: DecisionRequest, d: Decision | symbol) => serializeDecision(req, (d as Decision).response);

  it("AskUserQuestion answer envelope", async () => {
    const req: DecisionRequest = {
      id: "r1",
      kind: "question",
      questions: [{ question: "Which fruit?", options: [{ label: "Mango" }, { label: "Kiwi" }] }],
    };
    const d = await new ScriptedDecider([{ when_question: "fruit", choose: "Kiwi" }]).decide(req, ctx);
    expect(envelope(req, d)).toMatchSnapshot();
  });
  it("tool deny envelope (strict)", async () => {
    // An off-registry tool with no scripted rule falls to the strict parity default (the real terminal
    // for an unmatched permission) — NOT a ScriptedDecider deny, which would emit a different message.
    const req: DecisionRequest = { id: "r2", kind: "permission", tool: "Bash", input: { command: "x" } };
    const d = await new PermissionDefaultDecider("strict").decide(req, ctx);
    expect(envelope(req, d)).toMatchSnapshot();
  });
  it("workspace mcp tools/list (verbatim cowork bash description)", async () => {
    const h = makeWorkspaceHandler({ containerName: "cowork-hl-X", vmMnt: mntRoot });
    expect(await h("workspace", { method: "tools/list" })).toMatchSnapshot(); // #30: handler is async
  });

  // SPEC §6: web_fetch is host/API-routed + gated by a web-fetch hostname allowlist (NOT container
  // egress). The deny paths are pure (no curl) — assert the faithful gating deterministically.
  // (No provenanceRef → allowlist-only path, unchanged.)
  const wf = async (allow: string[], url: string) =>
    (await makeWorkspaceHandler({ containerName: "cowork-hl-X", vmMnt: mntRoot, webFetchAllow: allow })("workspace", {
      method: "tools/call",
      params: { name: "web_fetch", arguments: { url } },
    })) as { result: { isError?: boolean; content: { text: string }[] } };

  it("web_fetch denies a host outside the web-fetch allowlist", async () => {
    const r = await wf(["api.anthropic.com"], "https://evil.example.com/x");
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/not in the session web-fetch allowlist/);
  });
  it("web_fetch denies a subdomain of a BARE allowlisted domain (faithful U1t wen() exact-for-bare)", async () => {
    // Path B now uses the SAME wen()/compile() matcher as container egress — exact-for-bare, NOT the old
    // subdomain-permissive stand-in. `example.com` does not cover `sub.example.com`.
    const r = await wf(["example.com"], "https://sub.example.com/x");
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/not in the session web-fetch allowlist/);
  });
  it("web_fetch with an empty allowlist reports no-allowlist (U1t, not container egress)", async () => {
    const r = await wf([], "https://example.com/x");
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/No network allowlist is configured/);
  });
});

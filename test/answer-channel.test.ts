import { describe, it, expect } from "vitest";
import { answerChannelRefusal, artifactsRootEnv, permissionPromptArgs, ANSWER_CHANNEL_NONE_LABEL } from "../src/answer-channel.js";
import { Scenario, GATE_ASSERT_KEYS, Assertion } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { SessionConfig, loadSession } from "../src/session.js";
import type { PlatformBaseline } from "../src/types.js";
import { buildLaunchPlan, type LaunchPlan } from "../src/session.js";
import { agentArgs } from "../src/runtime/argv.js";
import { microvmAgentArgs } from "../src/runtime/microvm.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseline = loadBaseline("desktop-2.26454.0");
const parkedAssert = { artifact_json: { artifact: "outputs/artifacts/runs/r1/run_status.json", path: "status", equals: "waiting" } };
const scen = (over: Record<string, unknown> = {}) =>
  Scenario.parse({ name: "t", baseline: "latest", session: "s.yaml", fidelity: "container", prompt: "p", assert: [parkedAssert], ...over });
const sess = (over: Record<string, unknown> = {}) => loadSession({ answer_channel: "none", permission_mode: "bypassPermissions", ...over });
const refuse = (o: {
  scenario?: Record<string, unknown>;
  session?: Record<string, unknown>;
  tier?: string;
  b?: PlatformBaseline;
  inv?: object;
}) =>
  answerChannelRefusal({
    scenario: scen(o.scenario),
    session: sess(o.session),
    tier: o.tier ?? "container",
    baseline: o.b ?? baseline,
    invocation: o.inv,
    probeHostCli: () => ({ supported: true, path: "/x/claude" }),
  });

describe("session schema", () => {
  it("accepts answer_channel: none and agent_env.artifacts_root", () => {
    const s = loadSession({ answer_channel: "none", agent_env: { artifacts_root: "artifacts" } });
    expect(s.answer_channel).toBe("none");
    expect(s.agent_env.artifacts_root).toBe("artifacts");
  });
  it("absent key stays absent (today's channel)", () => {
    expect(loadSession({}).answer_channel).toBeUndefined();
  });
  it("refuses any other answer_channel value (no second spelling of the default)", () => {
    expect(() => SessionConfig.parse({ answer_channel: "stdio" })).toThrow();
  });
  it.each(["/abs/path", "../up", "a/../../b", "", "a\\b"])("refuses artifacts_root %j (absolute, escaping or empty)", (v) => {
    expect(() => SessionConfig.parse({ agent_env: { artifacts_root: v } })).toThrow();
  });
});

describe("permissionPromptArgs — the one place argv says who answers", () => {
  it("absent key: the stdio tool, as today", () => {
    expect(permissionPromptArgs({})).toEqual(["--permission-prompt-tool", "stdio"]);
  });
  it("none: omits the stdio tool and declares --permission-prompts none", () => {
    expect(permissionPromptArgs({ answerChannel: "none" })).toEqual(["--permission-prompts", "none"]);
  });
});

describe("artifactsRootEnv", () => {
  it("joins the authored relative path onto the agent-visible outputs dir", () => {
    expect(artifactsRootEnv("artifacts", "/sessions/x/mnt/outputs")).toEqual({
      COWORK_ARTIFACTS_ROOT: "/sessions/x/mnt/outputs/artifacts",
    });
  });
  it("unset: no key at all", () => {
    expect(artifactsRootEnv(undefined, "/o")).toEqual({});
  });
});

describe("answerChannelRefusal", () => {
  it("passes the recipe shape", () => {
    expect(refuse({})).toBeUndefined();
  });
  it("is a no-op when the key is absent", () => {
    expect(
      answerChannelRefusal({
        scenario: scen({ answers: [{ when_question: "x", choose: "y" }] }),
        session: loadSession({}),
        tier: "hostloop",
        baseline,
      }),
    ).toBeUndefined();
  });
  it.each(["default", "acceptEdits", "plan"])("refuses permission_mode %s", (m) => {
    expect(refuse({ session: { permission_mode: m } })).toMatch(/bypassPermissions/);
  });
  it("refuses the host loop and the cowork overlay", () => {
    expect(refuse({ tier: "hostloop" })).toMatch(/host loop/);
    expect(refuse({ scenario: { fidelity: "cowork" }, tier: "container" })).toMatch(/host loop/);
  });
  it("refuses the remote lane", () => {
    expect(refuse({ scenario: { lane: "remote" } })).toMatch(/cloud lane/);
  });
  it("refuses scripted answers", () => {
    expect(refuse({ scenario: { answers: [{ when_question: "x", choose: "y" }] } })).toMatch(/answers:/);
  });
  it("refuses an authored on_unanswered and the --on-unanswered flag", () => {
    expect(refuse({ scenario: { on_unanswered: "first" } })).toMatch(/on_unanswered/);
    expect(refuse({ inv: { onUnansweredFlag: "fail" } })).toMatch(/on_unanswered/);
  });
  it("does NOT refuse a caller's resolved default (eval/hillclimb/record fill one)", () => {
    expect(refuse({ inv: {} })).toBeUndefined();
  });
  it.each([{ hasDecider: true }, { hasExternalChannel: true }, { llmModel: "m" }, { llmIntent: "i" }])("refuses a decider %j", (inv) => {
    expect(refuse({ inv })).toMatch(/decider/);
  });
  it("refuses permission_parity: strict, keeps the cowork default", () => {
    expect(refuse({ session: { permission_parity: "strict" } })).toMatch(/permission_parity/);
    expect(refuse({ session: { permission_parity: "cowork" } })).toBeUndefined();
  });
  it("refuses web_fetch.approved_domains", () => {
    expect(refuse({ session: { web_fetch: { approved_domains: ["example.com"] } } })).toMatch(/approved_domains/);
  });

  // The shared contract with the gate-assertion keys: every key in GATE_ASSERT_KEYS is refused. A new gate key is
  // added to that list (gates_all_scripted is one), and this test then covers it with no edit here.
  const gateValue: Record<string, unknown> = {
    question_asked: "x",
    question_options: { equals: ["a"] },
    question_context: { matches: "x" },
    question_option_count: { matches: "x", exactly: 2 },
    gate_answers_delivered: true,
    gate_answer_count_min: 1,
    gates_all_scripted: true,
  };
  it.each([...GATE_ASSERT_KEYS])("refuses the gate key %s", (k) => {
    expect(k in gateValue, `add a sample value for ${k} to this test`).toBe(true);
    const a = Assertion.parse({ [k]: gateValue[k] });
    expect(refuse({ scenario: { assert: [parkedAssert, a] } })).toMatch(new RegExp(k));
  });
  // Named on its own: it passes vacuously when no gate fires, which is every run without a channel.
  it("refuses gates_all_scripted, both forms", () => {
    expect(GATE_ASSERT_KEYS).toContain("gates_all_scripted");
    for (const v of [true, { include_permissions: true }])
      expect(refuse({ scenario: { assert: [parkedAssert, Assertion.parse({ gates_all_scripted: v })] } })).toMatch(/gates_all_scripted/);
  });
  it("GATE_ASSERT_KEYS names every question/gate assertion key in the schema", () => {
    const schemaKeys = Object.keys(Assertion.shape).filter((k) => /^(question_|gate_|gates_)/.test(k) && k !== "questions_count_max");
    expect([...GATE_ASSERT_KEYS].sort()).toEqual(schemaKeys.sort());
  });
  // It counts the questions that reach the harness, and under this key none do: `questions_count_max: 0` always passes.
  it("refuses questions_count_max (no question reaches the harness to count)", () => {
    expect(refuse({ scenario: { assert: [parkedAssert, { questions_count_max: 0 }] } })).toMatch(/questions_count_max/);
  });

  it.each(["AskUserQuestion", "AskUser*", { tool: "AskUserQuestion" }, { tool: ["Read", "AskUserQuestion"] }])(
    "refuses tool_called %j",
    (v) => {
      expect(refuse({ scenario: { assert: [parkedAssert, { tool_called: v }] } })).toMatch(/AskUserQuestion/);
    },
  );
  it.each(["*", "Read", { tool: "Bash" }])("keeps tool_called %j", (v) => {
    expect(refuse({ scenario: { assert: [parkedAssert, { tool_called: v }] } })).toBeUndefined();
  });
  it("keeps tool_not_called: AskUserQuestion", () => {
    expect(refuse({ scenario: { assert: [parkedAssert, { tool_not_called: "AskUserQuestion" }] } })).toBeUndefined();
  });

  it("requires a file assertion", () => {
    expect(refuse({ scenario: { assert: [{ result: "success" }] } })).toMatch(/file assertion/);
  });
  // A skill that did nothing satisfies `file_absent`, so it cannot be the completion evidence.
  it("does not count file_absent as completion evidence", () => {
    expect(refuse({ scenario: { assert: [{ file_absent: "outputs/x" }] } })).toMatch(/file assertion/);
    expect(refuse({ scenario: { assert: [{ file_absent: "outputs/x" }, { file_exists: "outputs/y" }] } })).toBeUndefined();
    expect(refuse({ scenario: { assert: [{ file_exists: "outputs/x" }] } })).toBeUndefined();
  });

  it("refuses an agent without the capability, and a baseline that does not record it", () => {
    const withCaps = (c: unknown) =>
      ({ ...baseline, agentBinary: { ...baseline.agentBinary, cliCapabilities: c } }) as unknown as PlatformBaseline;
    expect(refuse({ b: withCaps({ permissionPrompts: false }) })).toMatch(/does not/);
    expect(refuse({ b: withCaps(undefined) })).toMatch(/re-run `cowork-harness sync`/i);
  });
  it("protocol asks the host CLI, not the baseline", () => {
    const noCaps = { ...baseline, agentBinary: { ...baseline.agentBinary, cliCapabilities: undefined } } as unknown as PlatformBaseline;
    const base = { scenario: scen({ fidelity: "protocol" }), session: sess(), tier: "protocol", baseline: noCaps };
    expect(answerChannelRefusal({ ...base, probeHostCli: () => ({ supported: true, path: "/x/claude" }) })).toBeUndefined();
    expect(answerChannelRefusal({ ...base, probeHostCli: () => ({ supported: false, path: "/x/claude" }) })).toMatch(/\/x\/claude/);
    expect(answerChannelRefusal({ ...base, probeHostCli: () => ({ supported: false, path: undefined }) })).toMatch(/on PATH/);
  });
});

describe("label", () => {
  it("names no product other than Cowork", () => {
    expect(ANSWER_CHANNEL_NONE_LABEL).toBe("headless, no answer channel — not Cowork");
  });
});

// The sandbox tiers' argv: container (agentArgs), microvm (microvmAgentArgs) and hostloop all go through
// baseAgentArgs, so the same golden covers each builder by calling it the way its tier does.
describe("sandbox argv under answer_channel: none", () => {
  const spawnable = loadBaseline("desktop-2.26454.0");
  const mk = (session: Record<string, unknown>) =>
    buildLaunchPlan(
      loadSession({ permission_mode: "bypassPermissions", ...session }),
      spawnable,
      mkdtempSync(join(tmpdir(), "ac-argv-")),
      "container",
    );
  const builders: Array<[string, (p: LaunchPlan) => string[]]> = [
    ["container", (p) => agentArgs(spawnable, p, { mntRoot: "/sessions/x/mnt" })],
    ["microvm", (p) => microvmAgentArgs(spawnable, p, "/sessions/x/mnt")],
  ];
  it.each(builders)("%s: absent key keeps the stdio pair; none removes exactly it and declares none", (_n, build) => {
    const before = build(mk({}));
    const after = build(mk({ answer_channel: "none" }));
    expect(before[before.indexOf("--permission-prompt-tool") + 1]).toBe("stdio");
    expect(before).not.toContain("--permission-prompts");
    const i = before.indexOf("--permission-prompt-tool");
    expect(after).toEqual([...before.slice(0, i), "--permission-prompts", "none", ...before.slice(i + 2)]);
  });
  it("the plan carries the authored artifacts_root, not a resolved path", () => {
    expect(mk({ agent_env: { artifacts_root: "artifacts" } }).artifactsRoot).toBe("artifacts");
    expect(mk({ agent_env: { artifacts_root: "artifacts" } }).agentEnv).toEqual({});
  });
});

// The wiring: executeScenario must consult the refusal before anything is staged or spawned. Token-free: each case
// throws before buildLaunchPlan (the pattern test/tier-vacuous-tools.test.ts uses).
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import { writeFileSync, existsSync } from "node:fs";
describe("executeScenario refuses at load", () => {
  const load = (sessionYaml: string, scenarioTail: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-ac-"));
    writeFileSync(join(dir, "s.yaml"), sessionYaml);
    const f = join(dir, "sc.yaml");
    writeFileSync(f, `name: ac\nbaseline: desktop-2.26454.0\nsession: ./s.yaml\n${scenarioTail}`);
    return parseScenarioFile(f);
  };
  const pinned = (s: Parameters<typeof executeScenario>[0], extra: object = {}) =>
    executeScenario(s, { modelOverride: "claude-sonnet-5", ...extra });
  const tail = "fidelity: container\nprompt: hi\nassert:\n  - file_exists: outputs/x\n";

  it("a non-bypass mode", async () => {
    await expect(pinned(load("answer_channel: none\n", tail))).rejects.toThrow(/bypassPermissions/);
  });
  it("the --on-unanswered flag", async () => {
    const s = load("answer_channel: none\npermission_mode: bypassPermissions\n", tail);
    await expect(pinned(s, { onUnansweredFlag: "first" })).rejects.toThrow(/on_unanswered/);
  });
  it("artifacts_root on the host loop, with or without the channel key", async () => {
    await expect(pinned(load("agent_env: { artifacts_root: a }\n", tail.replace("container", "hostloop")))).rejects.toThrow(
      /artifacts_root[\s\S]*host loop/,
    );
  });
  it("leaves no run dir behind", async () => {
    const prev = process.env.COWORK_HARNESS_RUNS_DIR;
    const root = mkdtempSync(join(tmpdir(), "cwh-ac-runs-"));
    process.env.COWORK_HARNESS_RUNS_DIR = root;
    try {
      await expect(pinned(load("answer_channel: none\n", tail))).rejects.toThrow(/bypassPermissions/);
      expect(existsSync(join(root, "ac"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = prev;
    }
  });
});

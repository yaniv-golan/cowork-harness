// `onFailure: "block"` (agent 2.1.295+): a failed or timed-out eligible hook is turned into a block AFTER the agent
// emits its `hook_response` frame, so the frame still says `error` / `cancelled`. The frame shapes below are the ones
// the agent's runner emits for each case (read from the 2.1.295 binary; no kept run holds one).
import { mkdirSync, mkdtempSync, readFileSync as readFile, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseMessage } from "../src/agent/session.js";
import {
  FRAMELESS_HOOK_EVENTS,
  ONFAILURE_EXEMPT_EVENTS,
  resolveHookFailureBlocks,
  scanHookFailureBlocks,
  type HookFailureBlocks,
} from "../src/run/hook-failure-blocks.js";
import {
  CASSETTE_VERSION,
  freezeRecordedRun,
  readCassette,
  replayCassette,
  requiredVersionFor,
  type Cassette,
} from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import { assertContextFromRunDir } from "../src/run/verify-context.js";
import { runHookFailureBlocks } from "../src/run/execute.js";
import { Assertion, ScenarioObject, type RunResult, type Scenario } from "../src/types.js";

type Frame = Record<string, unknown>;
let n = 0;
/** A hook that started and answered: the `hook_started` / `hook_response` pair the agent streams. */
function hook(event: string, tool: string | undefined, resp: Frame): Frame[] {
  const id = `h${++n}`;
  const name = tool === undefined ? event : `${event}:${tool}`;
  return [
    { type: "system", subtype: "hook_started", hook_id: id, hook_name: name, hook_event: event },
    { type: "system", subtype: "hook_response", hook_id: id, hook_name: name, hook_event: event, ...resp },
  ];
}
// The runner's shapes (2.1.295 `zc` calls).
const exit1 = { output: "boom", stdout: "", stderr: "boom", exit_code: 1, outcome: "error" };
const timedOut = { output: "", stdout: "", stderr: "", exit_code: 143, outcome: "cancelled" };
const http500 = { output: "HTTP 500 from https://h", stdout: "", stderr: "HTTP 500 from https://h", exit_code: 500, outcome: "error" };
const ok = { output: "", stdout: "", stderr: "", exit_code: 0, outcome: "success" };
const exit2 = { output: "no", stdout: "", stderr: "no", exit_code: 2, outcome: "error" };

const toEvents = (frames: Frame[]) =>
  frames.flatMap((f) => parseMessage(f)).flatMap((e) => (e.type === "system_event" ? [{ subtype: e.subtype, data: e.data }] : []));
const ctx = (frames: Frame[], hookFailureBlocks?: HookFailureBlocks) =>
  ({
    transcript: "",
    toolsCalled: new Set(),
    questions: [],
    subagents: [],
    contextEvents: toEvents(frames),
    ...(hookFailureBlocks ? { hookFailureBlocks } : {}),
  }) as unknown as AssertContext;
const run = (a: unknown, c: AssertContext) => evaluate([Assertion.parse(a)], c)[0]!;
const UNAVAILABLE = /^evidence unavailable: /;
const PRE: HookFailureBlocks = { events: ["PreToolUse"] };

describe("a failed frame of an event with an onFailure:block hook is unreadable, not 'no decision'", () => {
  for (const [label, shape] of [
    ["exit 1", exit1],
    ["a timeout (cancelled)", timedOut],
    ["an HTTP 500", http500],
  ] as const) {
    it(`${label}: no_hook_event_blocked, hook_decision deny {max: 0} and hook_event_blocked {max: 0} report evidence-unavailable`, () => {
      const frames = hook("PreToolUse", "Bash", shape);
      const c = ctx(frames, PRE);
      for (const a of [
        { no_hook_event_blocked: { event: "PreToolUse" } },
        { hook_decision: { event: "PreToolUse", decision: "deny", max: 0 } },
        { hook_event_blocked: { event: "PreToolUse", max: 0 } },
      ]) {
        const r = run(a, c);
        expect(r.pass, JSON.stringify(a)).toBe(false);
        expect(r.message, JSON.stringify(a)).toMatch(UNAVAILABLE);
      }
    });
    it(`${label}: without such a hook the reading is unchanged (no decision)`, () => {
      const c = ctx(hook("PreToolUse", "Bash", shape), { events: [] });
      expect(run({ no_hook_event_blocked: { event: "PreToolUse" } }, c).pass).toBe(true);
    });
  }
  it("an unknown inventory taints failed frames too", () => {
    const c = ctx(hook("PreToolUse", "Bash", exit1), { unknown: true, why: "a hooks source could not be parsed" });
    expect(run({ no_hook_event_blocked: { event: "PreToolUse" } }, c).message).toMatch(UNAVAILABLE);
  });
  it("another event's eligible hook does not taint this one (event-level)", () => {
    const c = ctx(hook("PostToolUse", "Bash", exit1), PRE);
    expect(run({ no_hook_event_blocked: { event: "PostToolUse" } }, c).pass).toBe(true);
  });
  it("success and exit-2 frames are never tainted", () => {
    const c = ctx([...hook("PreToolUse", "Bash", ok), ...hook("PreToolUse", "Write", exit2)], PRE);
    expect(run({ hook_event_blocked: { event: "PreToolUse", min: 1, max: 1 } }, c).pass).toBe(true);
    expect(run({ hook_decision: { event: "PreToolUse", decision: "deny", min: 1, max: 1 } }, c).pass).toBe(true);
  });
  it("an exit-2 frame keeps its readable JSON channel (exit 2 is not a failure the agent converts)", () => {
    const c = ctx(hook("PreToolUse", "Write", exit2), PRE);
    expect(run({ hook_event_blocked: { event: "PreToolUse", via: "json", max: 0 } }, c).pass).toBe(true);
  });
  it("the exit-2 channel count is exact: a converted failure is not an exit-2 block", () => {
    const c = ctx(hook("PreToolUse", "Bash", exit1), PRE);
    expect(run({ hook_event_blocked: { event: "PreToolUse", via: "exit2", max: 0 } }, c).pass).toBe(true);
  });
  it("the exempt events keep today's reading", () => {
    expect([...ONFAILURE_EXEMPT_EVENTS].sort()).toEqual(["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"]);
    const c = ctx(hook("Stop", undefined, exit1), { events: ["Stop"] });
    expect(run({ no_hook_event_blocked: { event: "Stop" } }, c).pass).toBe(true);
  });
  it("a run with no hook frames for the event is unchanged, whatever the inventory", () => {
    const c = ctx(hook("PostToolUse", "Bash", ok), { unknown: true, why: "x" });
    expect(run({ no_hook_event_blocked: { event: "PostToolUse" } }, c).pass).toBe(true);
  });
});

describe("events whose hooks stream no frame at all (the agent's outside-REPL runner)", () => {
  it("lists them", () => {
    expect([...FRAMELESS_HOOK_EVENTS].sort()).toEqual(
      [
        "ConfigChange",
        "CwdChanged",
        "DirectoryAdded",
        "Elicitation",
        "ElicitationResult",
        "FileChanged",
        "InstructionsLoaded",
        "Notification",
        "PostCompact",
        "PreCompact",
        "SessionEnd",
        "StopFailure",
        "WorktreeCreate",
        "WorktreeRemove",
      ].sort(),
    );
  });
  it("unscoped no_hook_event_blocked is evidence-unavailable when such an event has an eligible hook, or the inventory is unknown", () => {
    const frames = hook("PreToolUse", "Bash", ok);
    expect(run({ no_hook_event_blocked: true }, ctx(frames, { events: [] })).pass).toBe(true);
    expect(run({ no_hook_event_blocked: true }, ctx(frames, { events: ["Notification"] })).message).toMatch(/Notification/);
    expect(run({ no_hook_event_blocked: true }, ctx(frames, { events: ["Notification"] })).message).toMatch(UNAVAILABLE);
    expect(run({ no_hook_event_blocked: true }, ctx(frames, { unknown: true, why: "x" })).message).toMatch(UNAVAILABLE);
  });
});

describe("resolveHookFailureBlocks: a malformed recorded inventory", () => {
  it("reads as unknown, never crashes, and still needs a v16 reader", () => {
    for (const bad of [null, {}, { events: "PreToolUse" }, { unknown: true }, [], "x"])
      expect("unknown" in resolveHookFailureBlocks(bad, "2.1.293"), JSON.stringify(bad)).toBe(true);
    expect(requiredVersionFor({ prompt: "x" }, { hookFailureBlocks: null })).toBe(16);
  });
  it("a cassette file carrying one is refused cleanly on read; an in-memory one replays as unknown, without a crash", async () => {
    const c = cassetteOf(hook("PreToolUse", "Bash", exit1), {
      hookFailureBlocks: { events: "PreToolUse" },
    } as unknown as Partial<Cassette>);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "onfail-bad-")));
    try {
      const f = join(dir, "bad.cassette.json");
      writeFileSync(f, JSON.stringify(c));
      const read = readCassette(f);
      expect("error" in read && read.error).toMatch(/hookFailureBlocks/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const r = await replayedNoBlock(c);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(UNAVAILABLE);
  });
});

describe("resolveHookFailureBlocks: a recording without the inventory", () => {
  it("keeps a recorded inventory as is", () => {
    expect(resolveHookFailureBlocks(PRE, "2.1.293")).toEqual(PRE);
  });
  it("an agent at or below 2.1.293 has no onFailure: nothing to taint", () => {
    for (const v of ["2.1.293", "2.1.284", "2.0.99", "1.9.300"]) expect(resolveHookFailureBlocks(undefined, v), v).toEqual({ events: [] });
  });
  it("a newer or unknown agent is unknown (compared numerically: 2.1.1000 > 2.1.293)", () => {
    for (const v of ["2.1.294", "2.1.295", "2.1.1000", "3.0.0", undefined, "garbage"])
      expect("unknown" in resolveHookFailureBlocks(undefined, v), String(v)).toBe(true);
  });
});

describe("scanHookFailureBlocks: what the agent could read", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "onfail-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, body: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof body === "string" ? body : JSON.stringify(body));
  };
  const group = (...hooks: unknown[]) => [{ matcher: "*", hooks }];
  const cmd = (extra: Record<string, unknown> = {}) => ({ type: "command", command: "x", ...extra });

  it("a plugin's hooks/hooks.json: command (sync) and http with onFailure:block are eligible", () => {
    put("p/hooks/hooks.json", {
      hooks: {
        PreToolUse: group(cmd({ onFailure: "block" })),
        PostToolUse: group({ type: "http", url: "https://h", onFailure: "block" }),
        UserPromptSubmit: group(cmd()),
      },
    });
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "p")] })).toEqual({ events: ["PostToolUse", "PreToolUse"] });
  });
  it("async / asyncRewake command hooks, prompt hooks and other onFailure values are not eligible", () => {
    put("p/hooks/hooks.json", {
      PreToolUse: group(cmd({ onFailure: "block", async: true })),
      PostToolUse: group(cmd({ onFailure: "block", asyncRewake: true })),
      Stop: group({ type: "prompt", prompt: "x", onFailure: "block" }),
      UserPromptSubmit: group(cmd({ onFailure: "ignore" })),
    });
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "p")] })).toEqual({ events: [] });
  });
  it("the plugin manifest's hooks: inline, a path, and an array", () => {
    put("a/.claude-plugin/plugin.json", { name: "a", hooks: { Stop: group(cmd({ onFailure: "block" })) } });
    put("b/.claude-plugin/plugin.json", { name: "b", hooks: "./extra/h.json" });
    put("b/extra/h.json", { hooks: { PreCompact: group(cmd({ onFailure: "block" })) } });
    put("c/.claude-plugin/plugin.json", { name: "c", hooks: ["./x.json", { Notification: group(cmd({ onFailure: "block" })) }] });
    put("c/x.json", { SessionEnd: group(cmd({ onFailure: "block" })) });
    expect(scanHookFailureBlocks({ pluginRoots: ["a", "b", "c"].map((p) => join(root, p)) })).toEqual({
      events: ["Notification", "PreCompact", "SessionEnd", "Stop"],
    });
  });
  it("skill and agent frontmatter hooks", () => {
    put(
      "p/skills/s/SKILL.md",
      `---\nname: s\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: x\n          onFailure: block\n---\nbody\n`,
    );
    put(
      "p/agents/a.md",
      `---\nname: a\nhooks:\n  PostToolUse:\n    - hooks:\n        - {type: http, url: "https://h", onFailure: block}\n---\n`,
    );
    put(
      "cfg/skills/l/SKILL.md",
      `---\nname: l\nhooks:\n  UserPromptSubmit:\n    - hooks: [{type: command, command: x, onFailure: block}]\n---\n`,
    );
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "p")], configDirs: [join(root, "cfg")] })).toEqual({
      events: ["PostToolUse", "PreToolUse", "UserPromptSubmit"],
    });
  });
  it("a config dir: settings.json, cowork_settings.json and the plugins it installed", () => {
    put("cfg/settings.json", { hooks: { PreToolUse: group(cmd({ onFailure: "block" })) } });
    put("cfg/cowork_settings.json", { hooks: { PostToolUse: group(cmd({ onFailure: "block" })) } });
    put("cfg/plugins/cache/mp/q/1.0.0/hooks/hooks.json", { hooks: { Stop: group(cmd({ onFailure: "block" })) } });
    expect(scanHookFailureBlocks({ configDirs: [join(root, "cfg")] })).toEqual({ events: ["PostToolUse", "PreToolUse", "Stop"] });
  });
  it("host managed settings: managed-settings.json and managed-settings.d/*.json", () => {
    put("m/managed-settings.json", { env: {} });
    put("m/managed-settings.d/10.json", { hooks: { PreToolUse: group(cmd({ onFailure: "block" })) } });
    expect(scanHookFailureBlocks({ managedSettingsDirs: [join(root, "m")] })).toEqual({ events: ["PreToolUse"] });
  });
  it("a JSON-escaped key is still read (no literal prefilter)", () => {
    put("p/hooks/hooks.json", `{"PreToolUse":[{"hooks":[{"type":"command","command":"x","on\\u0046ailure":"block"}]}]}`);
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "p")] })).toEqual({ events: ["PreToolUse"] });
  });
  it("a hooks source that exists but does not parse is unknown — and says so without a path", () => {
    put("p/hooks/hooks.json", "{ not json");
    const r = scanHookFailureBlocks({ pluginRoots: [join(root, "p")] });
    expect("unknown" in r).toBe(true);
    expect(JSON.stringify(r)).not.toContain(root);
  });
  it("CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG in the spawn env makes the user's own sync hooks eligible on its five events", () => {
    put("cfg/settings.json", { hooks: { PreToolUse: group(cmd()), Stop: group(cmd()), UserPromptSubmit: group(cmd({ async: true })) } });
    expect(scanHookFailureBlocks({ configDirs: [join(root, "cfg")], spawnEnv: {} })).toEqual({ events: [] });
    expect(scanHookFailureBlocks({ configDirs: [join(root, "cfg")], spawnEnv: { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: "1" } })).toEqual({
      events: ["PreToolUse"],
    });
  });
  it("follows symlinks, as the agent does (a dotfiles-linked settings.json, a linked skill, a linked hooks.json)", () => {
    put("real/settings.json", { hooks: { PreToolUse: group(cmd({ onFailure: "block" })) } });
    put("realskill/SKILL.md", `---\nname: s\nhooks:\n  PostToolUse:\n    - hooks: [{type: command, command: x, onFailure: block}]\n---\n`);
    put("realhooks.json", { Stop: group(cmd({ onFailure: "block" })) });
    mkdirSync(join(root, "cfg", "skills"), { recursive: true });
    symlinkSync(join(root, "real", "settings.json"), join(root, "cfg", "settings.json"));
    symlinkSync(join(root, "realskill"), join(root, "cfg", "skills", "s"));
    mkdirSync(join(root, "p", "hooks"), { recursive: true });
    symlinkSync(join(root, "realhooks.json"), join(root, "p", "hooks", "hooks.json"));
    symlinkSync(join(root, "cfg"), join(root, "cfg", "skills", "loop")); // a cycle is read once
    expect(scanHookFailureBlocks({ configDirs: [join(root, "cfg")], pluginRoots: [join(root, "p")] })).toEqual({
      events: ["PostToolUse", "PreToolUse", "Stop"],
    });
  });
  it("reads a symlink loop once: a self-linking plugins dir does not exhaust the budget into unknown", () => {
    put("cfg/settings.json", { hooks: { PreToolUse: group(cmd({ onFailure: "block" })) } });
    mkdirSync(join(root, "cfg", "plugins"), { recursive: true });
    for (const n of ["a", "b", "c", "d"]) symlinkSync(join(root, "cfg", "plugins"), join(root, "cfg", "plugins", n));
    expect(scanHookFailureBlocks({ configDirs: [join(root, "cfg")] })).toEqual({ events: ["PreToolUse"] });
  });
  it("a skill description that only mentions hooks does not make an unparseable frontmatter unknown", () => {
    put("p/skills/s/SKILL.md", `---\nname: s\ndescription: Use for git hooks: pre-commit setup\n---\n`);
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "p")] })).toEqual({ events: [] });
    put("q/skills/s/SKILL.md", `---\nname: s\ndescription: a: b: c\nhooks:\n  PreToolUse: [\n---\n`);
    expect("unknown" in scanHookFailureBlocks({ pluginRoots: [join(root, "q")] })).toBe(true);
  });
  it("keeps only event names the agent knows; any other key is skipped, never recorded", () => {
    put("cfg/settings.json", {
      hooks: { "/Users/secret/path": group(cmd({ onFailure: "block" })), PreToolUse: group(cmd({ onFailure: "block" })) },
    });
    const r = scanHookFailureBlocks({ configDirs: [join(root, "cfg")], knownEvents: new Set(["PreToolUse", "Stop"]) });
    expect(r).toEqual({ events: ["PreToolUse"] });
  });
  it("a manifest's custom skills / commands / agents paths are read", () => {
    put("p/.claude-plugin/plugin.json", { name: "p", skills: "./src/skills", agents: ["./team/a.md"] });
    put(
      "p/src/skills/s/SKILL.md",
      `---\nname: s\nhooks:\n  PreToolUse:\n    - hooks: [{type: command, command: x, onFailure: block}]\n---\n`,
    );
    put("p/team/a.md", `---\nname: a\nhooks:\n  Stop:\n    - hooks: [{type: http, url: "https://h", onFailure: block}]\n---\n`);
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "p")] })).toEqual({ events: ["PreToolUse", "Stop"] });
  });
  it("CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG from a settings file's env, and a personal (uploads) plugin's hooks", () => {
    put("cfg/settings.json", { env: { CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: "1" } });
    put("up/hooks/hooks.json", { PreToolUse: group(cmd()) });
    put("plain/hooks/hooks.json", { UserPromptSubmit: group(cmd()) });
    expect(
      scanHookFailureBlocks({
        configDirs: [join(root, "cfg")],
        personalPluginRoots: [join(root, "up")],
        pluginRoots: [join(root, "plain")],
      }),
    ).toEqual({ events: ["PreToolUse"] });
  });
  it("a config dir's installed_plugins.json names the plugin roots read (a broken marketplace checkout is not)", () => {
    put("cfg/plugins/cache/mp/q/1/hooks/hooks.json", { Stop: group(cmd({ onFailure: "block" })) });
    put("cfg/plugins/marketplaces/mp/broken/.claude-plugin/plugin.json", "{ not json");
    put("cfg/plugins/installed_plugins.json", {
      version: 2,
      plugins: { "q@mp": [{ installPath: join(root, "cfg/plugins/cache/mp/q/1") }] },
    });
    expect(scanHookFailureBlocks({ configDirs: [join(root, "cfg")] })).toEqual({ events: ["Stop"] });
  });
  it("protocol's project settings (settings.json and settings.local.json) are read", () => {
    put("work/.claude/settings.local.json", { hooks: { PreToolUse: group(cmd({ onFailure: "block" })) } });
    expect(scanHookFailureBlocks({ projectClaudeDirs: [join(root, "work", ".claude")] })).toEqual({ events: ["PreToolUse"] });
  });
  it("nothing staged, nothing found", () => {
    expect(scanHookFailureBlocks({})).toEqual({ events: [] });
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "missing")], configDirs: [join(root, "nope")] })).toEqual({ events: [] });
  });
});

// Through the real record and replay paths.

const LIVE = loadBaseline("latest").appVersion;
const line = (o: unknown) => JSON.stringify(o);
const NO_BLOCK = { no_hook_event_blocked: { event: "PreToolUse" } };
/** `agent`: the version the recording's init frame reports (null: none reported). */
function cassetteOf(frames: Frame[], extra: Partial<Cassette> = {}, agent: string | null = "2.1.293"): Cassette {
  return {
    scenario: {
      name: "onfail",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [NO_BLOCK],
    } as unknown as Scenario,
    events: [
      line({ type: "system", subtype: "init", tools: [], skills: [], ...(agent ? { claude_code_version: agent } : {}) }),
      ...frames.map(line),
      line({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: [],
    cassetteVersion: CASSETTE_VERSION,
    userVisibleRoots: ["outputs"],
    fingerprint: { baseline: LIVE },
    ...extra,
  } as unknown as Cassette;
}
const replayedNoBlock = async (c: Cassette) =>
  (await replayCassette(c, [])).assertions.find((a) => "no_hook_event_blocked" in a.assertion)!;

describe("replay reads the frozen inventory", () => {
  it("a frozen eligible event makes the failed frame unreadable; an empty one keeps the pass", async () => {
    const frames = hook("PreToolUse", "Bash", exit1);
    expect((await replayedNoBlock(cassetteOf(frames, { hookFailureBlocks: { events: ["PreToolUse"] } } as Partial<Cassette>))).pass).toBe(
      false,
    );
    expect((await replayedNoBlock(cassetteOf(frames, { hookFailureBlocks: { events: [] } } as Partial<Cassette>))).pass).toBe(true);
  });
  it("an older cassette without it: the agent its init frame reports decides, NOT its baseline's pin", async () => {
    const frames = hook("PreToolUse", "Bash", exit1);
    expect((await replayedNoBlock(cassetteOf(frames, {}, "2.1.293"))).pass).toBe(true);
    // The baseline (LIVE) pins 2.1.293, but the recording ran 2.1.295 (a hostloop substitution, a host claude):
    for (const agent of ["2.1.295", null]) {
      const r = await replayedNoBlock(cassetteOf(frames, {}, agent));
      expect(r.pass, String(agent)).toBe(false);
      expect(r.message).toMatch(UNAVAILABLE);
    }
  });
  it("an older cassette with no failed frame is unchanged, whatever its agent", async () => {
    expect((await replayedNoBlock(cassetteOf(hook("PreToolUse", "Bash", ok), {}, "2.1.295"))).pass).toBe(true);
  });
});

describe("record freezes the inventory and stamps v16 only when it is non-empty", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "onfail-rec-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  async function freeze(hookFailureBlocks: HookFailureBlocks | undefined) {
    const outDir = join(dir, `run-${++n}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        line({ type: "system", subtype: "init", tools: [], skills: [] }),
        line({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    );
    writeFileSync(join(outDir, "control-out.jsonl"), "");
    const scenario = ScenarioObject.parse({
      name: "onfail-freeze",
      fidelity: "container",
      prompt: "hi",
      assert: [{ result: "success" }],
    }) as unknown as Scenario;
    const result = {
      mode: "run",
      command: "record",
      scenario: scenario.name,
      prompt: scenario.prompt,
      fidelity: "container",
      effectiveFidelity: "container",
      result: "success",
      baseline: LIVE,
      outDir,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE, hashFormat: "jcs1" },
      assertions: [],
      egress: [],
      ...(hookFailureBlocks ? { hookFailureBlocks } : {}),
    } as unknown as RunResult;
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const cassettePath = join(outDir, "c.cassette.json");
      await freezeRecordedRun(scenario, { noRedact: true, allowFailing: true, cassettePath }, [], result);
      return JSON.parse(readFile(cassettePath, "utf8")) as Record<string, unknown>;
    } finally {
      errSpy.mockRestore();
    }
  }
  it("empty: frozen as is, the stamp unchanged", async () => {
    const base = await freeze(undefined);
    const empty = await freeze({ events: [] });
    expect(empty.hookFailureBlocks).toEqual({ events: [] });
    expect(empty.cassetteVersion).toBe(base.cassetteVersion);
    expect(base.hookFailureBlocks).toBeUndefined();
  });
  it("non-empty: frozen and stamped v16, and the cassette reads back", async () => {
    const c = await freeze({ events: ["PreToolUse"] });
    expect(c.hookFailureBlocks).toEqual({ events: ["PreToolUse"] });
    expect(c.cassetteVersion).toBe(16);
    expect(String(c.$schema)).toMatch(/cassette\.v16\.json$/);
  });
});

describe("verify-run reads the kept run's inventory", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "onfail-verify-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const kept = (result: Record<string, unknown>, agent?: string) => {
    const runDir = join(dir, `run-${++n}`);
    mkdirSync(join(runDir, "turns", "1"), { recursive: true });
    writeFileSync(join(runDir, "turns", "1", "result.json"), JSON.stringify(result));
    if (agent) writeFileSync(join(runDir, "events.jsonl"), line({ type: "system", subtype: "init", claude_code_version: agent }) + "\n");
    return runDir;
  };
  const scenario = ScenarioObject.parse({
    name: "onfail-verify",
    fidelity: "container",
    prompt: "hi",
    assert: [NO_BLOCK],
  }) as unknown as Scenario;
  const base = { result: "success", command: "run", contextEvents: toEvents(hook("PreToolUse", "Bash", exit1)) };
  const blocks = (r: Record<string, unknown>, agent?: string) => {
    const v = assertContextFromRunDir(kept(r, agent), scenario);
    if (!v.ok) throw new Error(JSON.stringify(v));
    return v.ctx.hookFailureBlocks;
  };
  it("reads a recorded inventory as is", () => {
    expect(blocks({ ...base, baseline: LIVE, hookFailureBlocks: { events: ["PreToolUse"] } })).toEqual({ events: ["PreToolUse"] });
  });
  it("resolves a result.json without it by the agent the run's stream reports, not its baseline", () => {
    expect(blocks({ ...base, baseline: LIVE }, "2.1.293")).toEqual({ events: [] });
    expect("unknown" in blocks({ ...base, baseline: LIVE }, "2.1.295")!).toBe(true);
    expect("unknown" in blocks({ ...base, baseline: LIVE })!).toBe(true); // no stream: unknown
  });
});

describe("runHookFailureBlocks reads the plan's sources", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "onfail-plan-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it("a staged plugin, the config dir and the work root's .claude; nothing else", () => {
    const plugin = join(dir, "plugin");
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    const hooks = (event: string) =>
      JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command: "x", onFailure: "block" }] }] } });
    writeFileSync(join(plugin, "hooks", "hooks.json"), hooks("PreToolUse"));
    mkdirSync(join(dir, "cfg"), { recursive: true });
    writeFileSync(join(dir, "cfg", "settings.json"), hooks("PostToolUse"));
    mkdirSync(join(dir, "work", ".claude"), { recursive: true });
    writeFileSync(join(dir, "work", ".claude", "settings.json"), hooks("UserPromptSubmit"));
    const folder = join(dir, "folder");
    mkdirSync(join(folder, "hooks"), { recursive: true });
    writeFileSync(join(folder, "hooks", "hooks.json"), hooks("Stop")); // a connected folder: the agent loads no hooks from it
    const plan = {
      configDir: join(dir, "cfg"),
      baseEnv: {},
      mounts: [
        { kind: "local-plugin", hostPath: plugin, mountPath: ".local-plugins/p" },
        { kind: "folder", hostPath: folder, mountPath: "folder" },
      ],
    } as unknown as Parameters<typeof runHookFailureBlocks>[0];
    expect(runHookFailureBlocks(plan, "container", join(dir, "work"), "local_t")).toEqual({
      events: ["PostToolUse", "PreToolUse", "UserPromptSubmit"],
    });
  });
});

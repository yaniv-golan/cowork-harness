// `onFailure: "block"` (agent 2.1.295+): a failed or timed-out eligible hook is turned into a block AFTER the agent
// emits its `hook_response` frame, so the frame still says `error` / `cancelled`. The frame shapes below are the ones
// the agent's runner emits for each case (read from the 2.1.295 binary; no kept run holds one).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseMessage } from "../src/agent/session.js";
import {
  FRAMELESS_HOOK_EVENTS,
  ONFAILURE_EXEMPT_EVENTS,
  resolveHookFailureBlocks,
  scanHookFailureBlocks,
  type HookFailureBlocks,
} from "../src/run/hook-failure-blocks.js";
import { Assertion } from "../src/types.js";

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
    put("local/SKILL.md", `---\nname: l\nhooks:\n  UserPromptSubmit:\n    - hooks: [{type: command, command: x, onFailure: block}]\n---\n`);
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "p")], skillDirs: [join(root, "local")] })).toEqual({
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
  it("nothing staged, nothing found", () => {
    expect(scanHookFailureBlocks({})).toEqual({ events: [] });
    expect(scanHookFailureBlocks({ pluginRoots: [join(root, "missing")], configDirs: [join(root, "nope")] })).toEqual({ events: [] });
  });
});

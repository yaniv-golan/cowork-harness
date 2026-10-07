// The count form of `hook_event_blocked`, `no_hook_event_blocked` and the `hook_decision` schema, over the committed
// Stop recording (test/fixtures/hook-frames/stop-hook-block.events.jsonl: the hook blocks once with exit 2, then
// passes with exit 0). Where a case needs a frame the recording lacks (no exit code, a hook that never answered, a
// different event), it edits the recorded frames and says so in its name.
import { describe, it, expect } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseMessage } from "../src/agent/session.js";
import { Assertion } from "../src/types.js";
import { loadHookFrames } from "./helpers/hook-frames.js";

type Frame = Record<string, unknown>;
function recorded(edit?: (frames: Frame[]) => Frame[]) {
  const frames = loadHookFrames();
  return (edit ? edit(frames.map((f) => ({ ...f }))) : frames)
    .flatMap((f) => parseMessage(f))
    .flatMap((e) => (e.type === "system_event" ? [{ subtype: e.subtype, data: e.data }] : []));
}
const ctx = (contextEvents: AssertContext["contextEvents"]) =>
  ({ transcript: "", toolsCalled: new Set(), questions: [], subagents: [], contextEvents }) as unknown as AssertContext;
const run = (a: unknown, c: AssertContext) => evaluate([a as Assertion], c)[0]!;
const isResponse = (f: Frame) => f.subtype === "hook_response";
/** The recording's exit-0 frame and its hook_started alone: a Stop hook that fired and did not block. */
const passFrames = (fs: Frame[]) => {
  const id = fs.find((f) => isResponse(f) && f.exit_code === 0)?.hook_id;
  return fs.filter((f) => f.hook_id === id);
};
const passOnly = () => recorded(passFrames);
/** The exit-0 frame with its exit code removed. */
const noExitCode = (fs: Frame[]) => fs.map((f) => (isResponse(f) && f.exit_code === 0 ? { ...f, exit_code: undefined } : f));
/** The exit-0 frame dropped, its hook_started kept: a hook that started and never answered. */
const pending = (fs: Frame[]) => fs.filter((f) => !isResponse(f) || f.exit_code !== 0);
const UNAVAILABLE = /^evidence unavailable: /;

describe("schema", () => {
  const parse = (a: unknown) => Assertion.safeParse(a).success;
  it("hook_event_blocked takes the bare event or {event, tool?, min?, max?}", () => {
    expect(parse({ hook_event_blocked: "Stop" })).toBe(true);
    expect(parse({ hook_event_blocked: { event: "Stop", max: 0 } })).toBe(true);
    expect(parse({ hook_event_blocked: { event: "PreToolUse", tool: "Bash", min: 1, max: 3 } })).toBe(true);
    expect(parse({ hook_event_blocked: { event: "Stop", min: 3, max: 1 } })).toBe(false);
    expect(parse({ hook_event_blocked: { event: "Stop", min: -1 } })).toBe(false);
    expect(parse({ hook_event_blocked: { event: "Stop", matcher: "Bash" } })).toBe(false);
    expect(parse({ hook_event_blocked: { event: "NoSuchEvent" } })).toBe(false);
  });
  it("no_hook_event_blocked takes true or {event, tool?}; tool needs event", () => {
    expect(parse({ no_hook_event_blocked: true })).toBe(true);
    expect(parse({ no_hook_event_blocked: false })).toBe(false);
    expect(parse({ no_hook_event_blocked: { event: "Stop" } })).toBe(true);
    expect(parse({ no_hook_event_blocked: { event: "PreToolUse", tool: "Bash" } })).toBe(true);
    expect(parse({ no_hook_event_blocked: { tool: "Bash" } })).toBe(false);
  });
  it("hook_decision takes {event, decision, tool?, min?, max?} with a fixed decision vocabulary", () => {
    for (const decision of ["allow", "deny", "ask", "defer", "block", "approve"])
      expect(parse({ hook_decision: { event: "PreToolUse", decision } }), decision).toBe(true);
    expect(parse({ hook_decision: { event: "PreToolUse", decision: "denied" } })).toBe(false);
    expect(parse({ hook_decision: { event: "PreToolUse" } })).toBe(false);
    expect(parse({ hook_decision: { event: "PreToolUse", decision: "deny", min: 2, max: 1 } })).toBe(false);
  });
});

describe("hook_event_blocked, count form", () => {
  it("the bare form keeps its meaning: at least one block", () => {
    expect(run({ hook_event_blocked: "Stop" }, ctx(recorded())).pass).toBe(true);
  });
  it("{event} alone means min 1", () => {
    expect(run({ hook_event_blocked: { event: "Stop" } }, ctx(recorded())).pass).toBe(true);
    expect(run({ hook_event_blocked: { event: "Stop" } }, ctx(passOnly())).pass).toBe(false);
  });
  it("{max: 0} is the per-event negative: one block fails it, naming the count", () => {
    const r = run({ hook_event_blocked: { event: "Stop", max: 0 } }, ctx(recorded()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/1 blocking .*expected at most 0/);
    expect(run({ hook_event_blocked: { event: "Stop", max: 0 } }, ctx(passOnly())).pass).toBe(true);
  });
  it("a count under min fails; an exact range passes", () => {
    expect(run({ hook_event_blocked: { event: "Stop", min: 2 } }, ctx(recorded())).message).toMatch(/1 blocking .*expected at least 2/);
    expect(run({ hook_event_blocked: { event: "Stop", min: 1, max: 1 } }, ctx(recorded())).pass).toBe(true);
  });
  it("{max: 0} over an event that never fired fails 'never fired', never a vacuous pass", () => {
    const r = run({ hook_event_blocked: { event: "PostToolUse", max: 0 } }, ctx(recorded()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no hook_response frame for `PostToolUse`/);
  });
  it("tool: scopes to hook_name `<event>:<tool>`; the recording's matcher-less `Stop` frames match no tool", () => {
    const r = run({ hook_event_blocked: { event: "Stop", tool: "Bash" } }, ctx(recorded()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no hook_response frame for `Stop` \(tool `Bash`\)/);
  });
  describe("unknown frames (edited: exit code removed / response dropped) decide by range intersection", () => {
    // One known block (B=1) and one unknown frame (U=1): the true count is 1 or 2.
    it("[1,2] inside [0,5] passes", () => {
      expect(run({ hook_event_blocked: { event: "Stop", max: 5 } }, ctx(recorded(noExitCode))).pass).toBe(true);
    });
    it("[1,2] disjoint from [3,∞) fails", () => {
      const r = run({ hook_event_blocked: { event: "Stop", min: 3 } }, ctx(recorded(noExitCode)));
      expect(r.pass).toBe(false);
      expect(r.message).not.toMatch(UNAVAILABLE);
    });
    it("[1,2] straddling [2,2] is evidence-unavailable, though both ends alone would fail or pass", () => {
      expect(run({ hook_event_blocked: { event: "Stop", min: 2, max: 2 } }, ctx(recorded(noExitCode))).message).toMatch(UNAVAILABLE);
      expect(run({ hook_event_blocked: { event: "Stop", max: 1 } }, ctx(recorded(noExitCode))).message).toMatch(UNAVAILABLE);
    });
    it("a hook that started and never answered counts as unknown too", () => {
      expect(run({ hook_event_blocked: { event: "Stop", max: 1 } }, ctx(recorded(pending))).message).toMatch(UNAVAILABLE);
      expect(run({ hook_event_blocked: { event: "Stop", max: 5 } }, ctx(recorded(pending))).pass).toBe(true);
    });
  });
  it("no context events: cannot verify", () => {
    expect(run({ hook_event_blocked: { event: "Stop", max: 0 } }, ctx(undefined)).message).toMatch(/cannot verify/);
  });
});

describe("no_hook_event_blocked", () => {
  it("a blocking frame fails it, naming the frame", () => {
    for (const v of [true, { event: "Stop" }]) {
      const r = run({ no_hook_event_blocked: v }, ctx(recorded()));
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/: Stop \(exit 2\) blocked — 1 of 2 /);
    }
  });
  it("passes when hooks fired and none blocked", () => {
    expect(run({ no_hook_event_blocked: true }, ctx(passOnly())).pass).toBe(true);
    expect(run({ no_hook_event_blocked: { event: "Stop" } }, ctx(passOnly())).pass).toBe(true);
  });
  it("zero frames in scope: never a vacuous pass", () => {
    expect(run({ no_hook_event_blocked: { event: "PostToolUse" } }, ctx(passOnly())).pass).toBe(false);
    const r = run({ no_hook_event_blocked: true }, ctx([]));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(UNAVAILABLE);
  });
  it("unscoped over SessionStart-only frames (edited) is evidence-unavailable: those stream without --include-hook-events", () => {
    const sessionStartOnly = recorded((fs) =>
      passFrames(fs).map((f) => ({ ...f, hook_event: "SessionStart", hook_name: "SessionStart:startup" })),
    );
    const r = run({ no_hook_event_blocked: true }, ctx(sessionStartOnly));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(UNAVAILABLE);
    expect(r.message).toMatch(/--include-hook-events/);
    expect(run({ no_hook_event_blocked: { event: "SessionStart" } }, ctx(sessionStartOnly)).pass).toBe(true);
  });
  it("an in-scope frame without an exit code (edited) is evidence-unavailable", () => {
    const c = ctx(recorded((fs) => noExitCode(passFrames(fs))));
    expect(run({ no_hook_event_blocked: true }, c).message).toMatch(UNAVAILABLE);
  });
  it("a hook that started and never answered (edited) is evidence-unavailable", () => {
    const c = ctx(recorded((fs) => [...passFrames(fs), { ...fs[0]!, hook_id: "never-answered" }]));
    expect(run({ no_hook_event_blocked: true }, c).message).toMatch(UNAVAILABLE);
  });
  it("no context events: cannot verify", () => {
    expect(run({ no_hook_event_blocked: true }, ctx(undefined)).message).toMatch(/cannot verify/);
  });
});

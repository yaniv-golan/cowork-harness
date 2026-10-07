// The count form of `hook_event_blocked`, `no_hook_event_blocked` and the `hook_decision` schema, over the committed
// Stop recording (test/fixtures/hook-frames/stop-hook-block.events.jsonl: the hook blocks once with exit 2, then
// passes with exit 0). Where a case needs a frame the recording lacks (no exit code, a hook that never answered, a
// different event), it edits the recorded frames and says so in its name.
import { describe, it, expect } from "vitest";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseMessage } from "../src/agent/session.js";
import { Assertion } from "../src/types.js";
import { loadHookDecisionFrames, loadHookFrames } from "./helpers/hook-frames.js";

type Frame = Record<string, unknown>;
const toEvents = (frames: Frame[]) =>
  frames.flatMap((f) => parseMessage(f)).flatMap((e) => (e.type === "system_event" ? [{ subtype: e.subtype, data: e.data }] : []));
function recorded(edit?: (frames: Frame[]) => Frame[]) {
  const frames = loadHookFrames();
  return toEvents(edit ? edit(frames.map((f) => ({ ...f }))) : frames);
}
/** The hook-decision recording: Bash denied by JSON (exit 0), Write blocked by exit 2, Stop blocked once by JSON
 *  (exit 0) and then passed with empty stdout. */
function decisions(edit?: (frames: Frame[]) => Frame[]) {
  const frames = loadHookDecisionFrames();
  return toEvents(edit ? edit(frames.map((f) => ({ ...f }))) : frames);
}
/** Rewrite the stdout of the response frames whose hook_name is `name`. */
const withStdout = (name: string, stdout: string) => (fs: Frame[]) =>
  fs.map((f) => (isResponse(f) && f.hook_name === name ? { ...f, stdout, output: stdout } : f));
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
  it("tool: on an event whose frames carry no tool name (Stop) is evidence-unavailable, never a pass or a 'never fired' fail", () => {
    for (const a of [
      { hook_event_blocked: { event: "Stop", tool: "Bash" } },
      { hook_event_blocked: { event: "Stop", tool: "Bash", max: 0 } },
      { no_hook_event_blocked: { event: "Stop", tool: "Bash" } },
      { hook_decision: { event: "Stop", decision: "deny", tool: "Bash" } },
      { hook_decision: { event: "Stop", decision: "deny", tool: "Bash", max: 0 } },
    ]) {
      const r = run(a, ctx(recorded()));
      expect(r.pass, JSON.stringify(a)).toBe(false);
      expect(r.message, JSON.stringify(a)).toMatch(UNAVAILABLE);
      expect(r.message, JSON.stringify(a)).toMatch(/carry no tool name/);
    }
  });
  it("tool: naming a tool that never fired, where the event's frames do carry tool names, fails 'never fired'", () => {
    const r = run({ hook_event_blocked: { event: "PreToolUse", tool: "Edit" } }, ctx(decisions()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no hook_response frame for `PreToolUse` \(tool `Edit`\)/);
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
    it("[1,3] around [2,2] is evidence-unavailable though both ends fall outside it (one block, two unknowns)", () => {
      const twoUnknown = (fs: Frame[]) => [...noExitCode(fs), { ...fs[0]!, hook_id: "never-answered" }];
      const r = run({ hook_event_blocked: { event: "Stop", min: 2, max: 2 } }, ctx(recorded(twoUnknown)));
      expect(r.message).toMatch(UNAVAILABLE);
      expect(r.message).toMatch(/plus 2 whose outcome cannot be read/);
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

describe("the JSON decision channel (the hook-decision recording)", () => {
  it("the bare form counts exit 2 alone: Bash's JSON deny is not counted, Write's exit 2 is", () => {
    expect(run({ hook_event_blocked: "PreToolUse" }, ctx(decisions())).pass).toBe(true);
    const r = run(
      { hook_event_blocked: "PreToolUse" },
      ctx(decisions(withStdout("PreToolUse:Write", "")).filter((e) => e.data?.hook_name !== "PreToolUse:Write")),
    );
    expect(r.pass).toBe(false);
  });
  it("the bare form's 'never blocked' failure names a JSON deny it did not count and points to `via`", () => {
    const r = run({ hook_event_blocked: "Stop" }, ctx(decisions()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/never blocked/);
    expect(r.message).toMatch(/1 frame\(s\) denied by JSON on stdout/);
    expect(r.message).toMatch(/via: any/);
  });
  it("the object form counts either channel by default", () => {
    expect(run({ hook_event_blocked: { event: "PreToolUse", min: 2, max: 2 } }, ctx(decisions())).pass).toBe(true);
    expect(run({ hook_event_blocked: { event: "Stop", min: 1, max: 1 } }, ctx(decisions())).pass).toBe(true);
  });
  it("{max: 0} without via fails over a hook that denied by JSON alone (no false green on a real deny)", () => {
    const r = run({ hook_event_blocked: { event: "Stop", max: 0 } }, ctx(decisions()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/1 blocking .*expected at most 0/);
  });
  it("via: exit2 | json | any picks the channel", () => {
    const n =
      (via: string, event = "PreToolUse") =>
      (min: number) =>
        run({ hook_event_blocked: { event, via, min, max: min } }, ctx(decisions())).pass;
    expect(n("exit2")(1)).toBe(true);
    expect(n("json")(1)).toBe(true);
    expect(n("any")(2)).toBe(true);
    expect(n("exit2", "Stop")(0)).toBe(true);
    expect(n("json", "Stop")(1)).toBe(true);
  });
  it("via is refused on the bare form's schema and must be one of exit2|json|any", () => {
    expect(Assertion.safeParse({ hook_event_blocked: { event: "Stop", via: "exit2" } }).success).toBe(true);
    expect(Assertion.safeParse({ hook_event_blocked: { event: "Stop", via: "stdout" } }).success).toBe(false);
  });
  it("tool: scopes to the tool that fired", () => {
    expect(run({ hook_event_blocked: { event: "PreToolUse", tool: "Bash", min: 1, max: 1 } }, ctx(decisions())).pass).toBe(true);
    expect(run({ hook_event_blocked: { event: "PreToolUse", tool: "Bash", via: "exit2", max: 0 } }, ctx(decisions())).pass).toBe(true);
  });
  it("no_hook_event_blocked fails on a JSON deny, naming it", () => {
    const r = run({ no_hook_event_blocked: { event: "PreToolUse", tool: "Bash" } }, ctx(decisions()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/PreToolUse:Bash \(exit 0, JSON deny\) blocked/);
  });
  describe("stdout that is not a whole JSON decision is no decision", () => {
    for (const [label, stdout] of [
      ["the bare word deny", "deny\n"],
      ["prose naming deny", "the hook said deny; permissionDecision deny\n"],
      ["JSON with a deny after other text", 'note: {"decision":"block"}\n'],
      ["a JSON array", '[{"decision":"block"}]\n'],
      ["a JSON string", '"deny"\n'],
      ["continue: false (stops, does not deny)", '{"continue":false,"stopReason":"x"}\n'],
    ] as const)
      it(`${label}: not a block, not unknown`, () => {
        const c = ctx(decisions(withStdout("PreToolUse:Bash", stdout)));
        const r = run({ hook_event_blocked: { event: "PreToolUse", tool: "Bash", max: 0 } }, c);
        expect(r.pass, r.message).toBe(true);
        expect(run({ hook_decision: { event: "PreToolUse", tool: "Bash", decision: "deny", max: 0 } }, c).pass).toBe(true);
      });
  });
  it("a hookEventName naming another event makes the decision unreadable", () => {
    const wrong = '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"deny"}}\n';
    const r = run(
      { hook_decision: { event: "PreToolUse", tool: "Bash", decision: "deny", max: 0 } },
      ctx(decisions(withStdout("PreToolUse:Bash", wrong))),
    );
    expect(r.message).toMatch(UNAVAILABLE);
  });
  it("stdout a redaction rewrote so it no longer parses is unreadable; a [REDACTED] inside a reason still parses", () => {
    const broken = '{"hookSpecificOutput": [REDACTED]\n';
    const r = run(
      { hook_decision: { event: "PreToolUse", tool: "Bash", decision: "deny", max: 0 } },
      ctx(decisions(withStdout("PreToolUse:Bash", broken))),
    );
    expect(r.message).toMatch(UNAVAILABLE);
    const inReason =
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"[REDACTED]"}}\n';
    expect(
      run(
        { hook_decision: { event: "PreToolUse", tool: "Bash", decision: "deny" } },
        ctx(decisions(withStdout("PreToolUse:Bash", inReason))),
      ).pass,
    ).toBe(true);
    // The exit-2 channel ignores stdout, so a rewritten stdout leaves via: exit2 readable.
    expect(
      run(
        { hook_event_blocked: { event: "PreToolUse", tool: "Bash", via: "exit2", max: 0 } },
        ctx(decisions(withStdout("PreToolUse:Bash", broken))),
      ).pass,
    ).toBe(true);
  });
  it("via: json over stdout it cannot read is evidence-unavailable, not a miss", () => {
    const broken = withStdout("PreToolUse:Bash", '{"hookSpecificOutput": [REDACTED]\n');
    const r = run({ hook_event_blocked: { event: "PreToolUse", tool: "Bash", via: "json", max: 0 } }, ctx(decisions(broken)));
    expect(r.message).toMatch(UNAVAILABLE);
  });
  it("an exit code other than 0 or 2 decides nothing, whatever stdout holds (edited: Bash's frame exits 1)", () => {
    const exit1 = (fs: Frame[]) =>
      fs.map((f) => (isResponse(f) && f.hook_name === "PreToolUse:Bash" ? { ...f, exit_code: 1, outcome: "error" } : f));
    const c = ctx(decisions(exit1));
    expect(run({ hook_event_blocked: { event: "PreToolUse", tool: "Bash", max: 0 } }, c).pass).toBe(true);
    expect(run({ hook_decision: { event: "PreToolUse", tool: "Bash", decision: "deny", max: 0 } }, c).pass).toBe(true);
  });
  it("stdout the agent truncated is unreadable", () => {
    const cut = '{"hookSpecificOutput": {"hookEventName"\nOutput truncated (40KB total)';
    const r = run(
      { hook_decision: { event: "PreToolUse", tool: "Bash", decision: "deny", max: 0 } },
      ctx(decisions(withStdout("PreToolUse:Bash", cut))),
    );
    expect(r.message).toMatch(UNAVAILABLE);
  });
});

describe("hook_decision", () => {
  const d = (spec: Record<string, unknown>) => run({ hook_decision: spec }, ctx(decisions()));
  it("deny counts the JSON deny and the exit 2", () => {
    expect(d({ event: "PreToolUse", decision: "deny", min: 2, max: 2 }).pass).toBe(true);
    expect(d({ event: "PreToolUse", decision: "deny", tool: "Bash", min: 1, max: 1 }).pass).toBe(true);
    expect(d({ event: "PreToolUse", decision: "deny", tool: "Write", min: 1, max: 1 }).pass).toBe(true);
  });
  it("block is an alias of deny; a top-level decision: block reads as deny", () => {
    expect(d({ event: "Stop", decision: "block", min: 1, max: 1 }).pass).toBe(true);
    expect(d({ event: "Stop", decision: "deny", min: 1, max: 1 }).pass).toBe(true);
  });
  it("a frame with empty stdout decides nothing: it is not an allow", () => {
    const r = d({ event: "Stop", decision: "allow" });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/0 `Stop` hook frame\(s\) decided allow/);
  });
  it("allow / approve, ask and defer read permissionDecision (edited stdout)", () => {
    const say = (v: string) =>
      ctx(
        decisions(
          withStdout("PreToolUse:Bash", JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: v } })),
        ),
      );
    for (const v of ["allow", "ask", "defer"])
      expect(run({ hook_decision: { event: "PreToolUse", tool: "Bash", decision: v } }, say(v)).pass, v).toBe(true);
    expect(run({ hook_decision: { event: "PreToolUse", tool: "Bash", decision: "approve" } }, say("allow")).pass).toBe(true);
    expect(run({ hook_decision: { event: "PreToolUse", tool: "Bash", decision: "deny", max: 0 } }, say("allow")).pass).toBe(true);
    const approve = ctx(decisions(withStdout("Stop", '{"decision":"approve"}')));
    expect(run({ hook_decision: { event: "Stop", decision: "allow", min: 2 } }, approve).pass).toBe(true);
  });
  it("max: 0 over a frame that denied fails, naming the raw token and exit code", () => {
    const r = d({ event: "PreToolUse", decision: "deny", tool: "Bash", max: 0 });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/PreToolUse:Bash \(exit 0, JSON deny\)/);
  });
  it("never fired fails; no context events cannot verify", () => {
    expect(d({ event: "PostToolUse", decision: "deny", max: 0 }).message).toMatch(/no hook_response frame for `PostToolUse`/);
    expect(run({ hook_decision: { event: "Stop", decision: "deny" } }, ctx(undefined)).message).toMatch(/cannot verify/);
  });
  it("a frame with no exit code is unknown and decides by the range rule", () => {
    const c = ctx(
      decisions((fs) => fs.map((f) => (isResponse(f) && f.hook_name === "PreToolUse:Write" ? { ...f, exit_code: undefined } : f))),
    );
    expect(run({ hook_decision: { event: "PreToolUse", decision: "deny", min: 2, max: 2 } }, c).message).toMatch(UNAVAILABLE);
    expect(run({ hook_decision: { event: "PreToolUse", decision: "deny", min: 1, max: 5 } }, c).pass).toBe(true);
  });
});

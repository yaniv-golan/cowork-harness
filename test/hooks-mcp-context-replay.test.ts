import { describe, it, expect, afterEach } from "vitest";
import { replayCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import { computeVerdict } from "../src/run/verdict.js";

const LIVE = loadBaseline("latest").appVersion;

const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function mute(): void {
  process.stderr.write = (() => true) as typeof process.stderr.write;
}

describe("compaction_occurred on replay", () => {
  it("replays from the re-driven stream (content-class)", async () => {
    mute();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: [], skills: [] }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", trigger: "auto" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ compaction_occurred: true }],
      },
      events,
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.compaction_occurred !== undefined);
    expect(a).toBeDefined();
    expect(a?.pass).toBe(true);
  });

  it("fails on replay when no compact_boundary event was in the recorded stream", async () => {
    mute();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: [], skills: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ compaction_occurred: true }],
      },
      events,
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.compaction_occurred !== undefined);
    expect(a).toBeDefined();
    expect(a?.pass).toBe(false);
  });
});

describe("no_mcp_error on replay", () => {
  it("is excluded-loud on replay (live-only) and does not vacuously pass", async () => {
    mute();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: [], skills: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }, { no_mcp_error: true }],
      },
      events,
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    expect(r.assertions.some((a) => a.assertion.no_mcp_error !== undefined)).toBe(false); // stripped, not evaluated
    expect(computeVerdict(r, "replay").pass).toBe(true);
  });
});

describe("hookEvents reconstruction on replay", () => {
  const hookReqId = "req-hook-1";
  const hookCallbackEvent = JSON.stringify({
    type: "control_request",
    request_id: hookReqId,
    request: {
      subtype: "hook_callback",
      callback_id: "cowork-task-bg-block",
      tool_use_id: "tu1",
      input: { tool_name: "Task", tool_input: { run_in_background: true } },
    },
  });
  const hookReply = JSON.stringify({
    type: "control_response",
    response: { request_id: hookReqId, subtype: "success", response: { decision: "block", reason: "background Task blocked" } },
  });
  const baseEvents = [
    JSON.stringify({ type: "system", subtype: "init", tools: [], skills: [] }),
    hookCallbackEvent,
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ];

  it("reconstructs hookEvents from events+controlOut and evaluates no_hook_blocked=false", async () => {
    mute();
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ no_hook_blocked: true }],
      },
      events: baseEvents,
      controlOut: [hookReply],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    const a = r.assertions.find((x) => x.assertion.no_hook_blocked !== undefined);
    expect(a?.pass).toBe(false); // a Task hook DID block
    expect(a?.message).toMatch(/Task/);
  });

  it("excludes both keys loudly when controlOut is absent (never a vacuous pass)", async () => {
    mute();
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }, { no_hook_blocked: true }],
      },
      events: baseEvents,
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    expect(r.assertions.some((a) => a.assertion.no_hook_blocked !== undefined)).toBe(false);
    expect(computeVerdict(r, "replay").pass).toBe(true);
  });
});

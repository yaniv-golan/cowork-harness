import { describe, it, expect, afterEach } from "vitest";
import { replayCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import { computeVerdict } from "../src/run/verdict.js";
import { emptyControlOut } from "./helpers/minimal-cassette.js";
import { HOSTLOOP_PATH_GATE_ID } from "../src/runtime/hostloop.js";

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

describe("max_peak_rss_bytes on replay", () => {
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
        assert: [{ result: "success" }, { max_peak_rss_bytes: 1000 }],
      },
      events,
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    expect(r.assertions.some((a) => a.assertion.max_peak_rss_bytes !== undefined)).toBe(false); // stripped, not evaluated
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

  it("an unpaired hook_callback (empty controlOut) fails the replay as truncated — never an allow", async () => {
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
      controlOut: emptyControlOut(),
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
    const truncated = r.assertions.find((a) => a.assertion.replay_protocol_fidelity !== undefined && !a.pass);
    expect(truncated?.message).toMatch(
      /hook_callback \S+ present in events\.jsonl has no matching control_response .* cassette is truncated; re-record/,
    );
    expect(computeVerdict(r, "replay").pass).toBe(false);
  });
});

describe("the hostloop path gate's callback with no recorded reply", () => {
  it("fails the replay as truncated — never read as allow, so no_path_denied cannot pass over a lost block", async () => {
    mute();
    const r = await replayCassette({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "hostloop",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ no_path_denied: true }],
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init", tools: [], skills: [] }),
        JSON.stringify({
          type: "control_request",
          request_id: "req-gate-1",
          request: {
            subtype: "hook_callback",
            callback_id: HOSTLOOP_PATH_GATE_ID,
            tool_use_id: "tu9",
            input: { tool_name: "Write", tool_input: { file_path: "/sessions/x/outputs/a.md" } },
          },
        }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      controlOut: emptyControlOut(),
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      effectiveFidelity: "hostloop",
      fingerprint: { baseline: LIVE },
    } as any);
    expect(r.pathDenials).toEqual([]);
    const truncated = r.assertions.find((a) => a.assertion.replay_protocol_fidelity !== undefined && !a.pass);
    expect(truncated?.message).toMatch(/hook_callback req-gate-1 present in events\.jsonl has no matching control_response/);
    expect(computeVerdict(r, "replay").pass).toBe(false);
  });
});

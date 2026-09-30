import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { replayCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { apiRetriesFrom } from "../src/run/api-retries.js";
import { parseMessage } from "../src/agent/session.js";
import { loadBaseline } from "../src/baseline.js";

// The agent retries a failed model call internally and says so on the stream as a `system` frame with
// `subtype: "api_retry"`. The frames in the fixture are copied VERBATIM from kept live runs (one per run,
// four runs — no single kept stream held more than one); nothing in them was hand-typed. The fields read
// here (`retry_delay_ms`) are the ones those frames actually carry.
const FRAMES = readFileSync("test/fixtures/api-retry/api-retry.events.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0);

const INIT = JSON.stringify({ type: "system", subtype: "init", tools: [], skills: [] });
const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false });
const LIVE = loadBaseline("latest").appVersion;

async function replay(events: string[], controlOut: string[] = []) {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await replayCassette({
      scenario: {
        name: "retries",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }],
      },
      events,
      controlOut,
      cassetteVersion: CASSETTE_VERSION,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE },
    } as any);
  } finally {
    process.stderr.write = orig;
  }
}

describe("apiRetries — the agent's own API retries, counted from the real stream frame", () => {
  it("a real stream holding one api_retry frame: count 1, its retry_delay_ms", async () => {
    const r = await replay([INIT, FRAMES[0]!, RESULT]);
    expect(r.apiRetries).toEqual({ count: 1, delayMs: 593, subagentCount: 0, subagentDelayMs: 0 });
  });

  it("sums every frame (the four real frames, from four runs, in one stream)", async () => {
    const r = await replay([INIT, ...FRAMES, RESULT]);
    expect(r.apiRetries).toEqual({ count: 4, delayMs: 593 + 537 + 580 + 521, subagentCount: 0, subagentDelayMs: 0 });
  });

  it("a driven stream with no retry of either kind is all zeros — a real zero, not absence", async () => {
    const r = await replay([INIT, RESULT]);
    expect(r.apiRetries).toEqual({ count: 0, delayMs: 0, subagentCount: 0, subagentDelayMs: 0 });
  });

  it("the fold reads the parser's own output: every fixture frame surfaces as a system_event", () => {
    const events = FRAMES.flatMap((l) => parseMessage(JSON.parse(l)));
    expect(events.map((e) => e.type)).toEqual(["system_event", "system_event", "system_event", "system_event"]);
    const contextEvents = events.map((e) => ({ subtype: (e as any).subtype, data: (e as any).data }));
    expect(apiRetriesFrom({ contextEvents, subagentRetries: { count: 0, delayMs: 0 }, context: { tools: [] } })).toEqual({
      count: 4,
      delayMs: 2231,
      subagentCount: 0,
      subagentDelayMs: 0,
    });
  });

  it("absent when no stream was observed; a frame without a numeric delay still counts", () => {
    const seen = { tools: [] };
    expect(apiRetriesFrom({ subagentRetries: { count: 0, delayMs: 0 }, context: seen })).toBeUndefined();
    expect(apiRetriesFrom({ contextEvents: [], context: seen })).toBeUndefined(); // sub-agent side not observed → never a false zero
    // Tallies initialised but no system/init ever arrived (the agent died before its stream): absent, not zeros.
    expect(apiRetriesFrom({ contextEvents: [], subagentRetries: { count: 0, delayMs: 0 }, context: {} })).toBeUndefined();
    const ce = [
      { subtype: "api_retry", data: { attempt: 2 } },
      { subtype: "compact_boundary", data: {} },
    ];
    expect(apiRetriesFrom({ contextEvents: ce, subagentRetries: { count: 0, delayMs: 0 }, context: seen })).toEqual({
      count: 1,
      delayMs: 0,
      subagentCount: 0,
      subagentDelayMs: 0,
    });
  });
});

// Sub-agent retries arrive on a DIFFERENT frame: `tool_progress` carrying `subagent_retry` (parented to the
// dispatching Agent tool_use). When the retry resolves, the agent emits a twin frame with the same shape
// minus `subagent_retry`; heartbeats are `tool_progress` too. This excerpt is every non-heartbeat
// `tool_progress` frame, the first two heartbeats and the one `api_retry` frame of ONE kept live run, copied
// verbatim in stream order: 19 retry frames (delays summing to 244519 ms), 3 resolved twins, 1 main-loop
// retry of 537 ms. The expected numbers were counted from the file outside this code.
const SUB = readFileSync("test/fixtures/api-retry/subagent-retry.events.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0);

describe("apiRetries — sub-agent retries, kept apart from the main loop's", () => {
  it("counts sub-agent retry frames separately; resolved twins and heartbeats do not count", async () => {
    const r = await replay([INIT, ...SUB, RESULT]);
    expect(r.apiRetries).toEqual({ count: 1, delayMs: 537, subagentCount: 19, subagentDelayMs: 244519 });
  });

  it("a stream of only resolved twins and heartbeats has zero sub-agent retries", async () => {
    const quiet = SUB.filter((l) => !l.includes('"subagent_retry"') && !l.includes('"api_retry"'));
    expect(quiet.length).toBe(5); // 3 twins + 2 heartbeats — the filter really kept frames
    const r = await replay([INIT, ...quiet, RESULT]);
    expect(r.apiRetries).toEqual({ count: 0, delayMs: 0, subagentCount: 0, subagentDelayMs: 0 });
  });

  it("the parser emits one subagent_retry event per retry frame and nothing for a twin or heartbeat", () => {
    const events = SUB.flatMap((l) => parseMessage(JSON.parse(l)));
    const retries = events.filter((e) => e.type === "subagent_retry");
    expect(retries).toHaveLength(19);
    expect(events.filter((e) => e.type !== "system_event")).toHaveLength(19); // twins/heartbeats emit nothing
    expect(retries[0]).toMatchObject({ delayMs: expect.any(Number), parentToolUseId: expect.any(String) });
  });

  it("a truncated cassette (never driven) reports apiRetries as absent, not zero", async () => {
    const QUESTION = JSON.stringify({
      type: "control_request",
      request_id: "q1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Which format?", options: [{ label: "Markdown" }, { label: "PDF" }] }] },
      },
    });
    const OTHER = JSON.stringify({
      type: "control_response",
      response: { request_id: "other", subtype: "success", response: { behavior: "allow" } },
    });
    const r = await replay([JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }), ...SUB, QUESTION], [OTHER]);
    expect(r.assertions?.some((a) => /truncated cassette/.test(a.message ?? ""))).toBe(true);
    expect(r.apiRetries).toBeUndefined();
  });
});

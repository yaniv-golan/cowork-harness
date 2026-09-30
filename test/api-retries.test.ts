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

async function replay(events: string[]) {
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
      controlOut: [],
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
    expect(r.apiRetries).toEqual({ count: 1, delayMs: 593 });
  });

  it("sums every frame (the four real frames, from four runs, in one stream)", async () => {
    const r = await replay([INIT, ...FRAMES, RESULT]);
    expect(r.apiRetries).toEqual({ count: 4, delayMs: 593 + 537 + 580 + 521 });
  });

  it("a driven stream with no retry is {0, 0} — a real zero, not absence", async () => {
    const r = await replay([INIT, RESULT]);
    expect(r.apiRetries).toEqual({ count: 0, delayMs: 0 });
  });

  it("the fold reads the parser's own output: every fixture frame surfaces as a system_event", () => {
    const events = FRAMES.flatMap((l) => parseMessage(JSON.parse(l)));
    expect(events.map((e) => e.type)).toEqual(["system_event", "system_event", "system_event", "system_event"]);
    const contextEvents = events.map((e) => ({ subtype: (e as any).subtype, data: (e as any).data }));
    expect(apiRetriesFrom(contextEvents)).toEqual({ count: 4, delayMs: 2231 });
  });

  it("absent when no stream was observed; a frame without a numeric delay still counts", () => {
    expect(apiRetriesFrom(undefined)).toBeUndefined();
    expect(
      apiRetriesFrom([
        { subtype: "api_retry", data: { attempt: 2 } },
        { subtype: "compact_boundary", data: {} },
      ]),
    ).toEqual({
      count: 1,
      delayMs: 0,
    });
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { replayCassette, CASSETTE_VERSION } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";

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

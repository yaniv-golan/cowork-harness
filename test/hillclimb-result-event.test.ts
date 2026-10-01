// The turn's terminal `{type:"result"}` frame is the only place the agent reports `stop_reason` (every
// streamed assistant event carries `stop_reason: null`) and its own session duration, which — unlike
// RunResult.durationMs — excludes staging and the semantic judge. Fixtures are real frames; see
// test/fixtures/hillclimb-runs/README.md for what was trimmed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resultEventFields } from "../src/hillclimb/result-event.js";

const real = readFileSync("test/fixtures/hillclimb-runs/result-event-pair.jsonl", "utf8").trim().split("\n");
const stub = readFileSync("test/fixtures/eval-classify/auth-agent-stream.jsonl", "utf8").trim().split("\n");
const [initLine, resultLine] = real;
const marker = JSON.stringify({ _emu: "turn_start" });
// A turn-1 result with different values, so a reader that ignores the turn marker reads the wrong turn.
const priorTurnResult = JSON.stringify({ ...JSON.parse(resultLine), stop_reason: "max_tokens", duration_ms: 1, session_id: "prior" });

describe("resultEventFields", () => {
  it("reads stop_reason, duration_ms, session_id and the agent version from a real run's frames", () => {
    expect(resultEventFields(real)).toEqual({
      stopReason: "end_turn",
      durationMs: 16134,
      sessionId: "a9997992-62b9-4795-9b94-b7fc106bce6f",
      agentVersion: "2.1.280",
    });
  });

  it("reads the committed stub-agent stream (stop_sequence, 66 ms; no init frame → no version)", () => {
    expect(resultEventFields(stub)).toEqual({ stopReason: "stop_sequence", durationMs: 66, sessionId: "stub" });
  });

  it("reads only the current turn of an append-only multi-turn file", () => {
    const lines = [initLine, priorTurnResult, marker, resultLine];
    expect(resultEventFields(lines)).toMatchObject({ stopReason: "end_turn", durationMs: 16134 });
  });

  it("takes the LAST result frame of the turn", () => {
    expect(resultEventFields([initLine, priorTurnResult, resultLine])).toMatchObject({ stopReason: "end_turn" });
  });

  it("with no result frame, reports nothing rather than a default (a killed run)", () => {
    expect(resultEventFields([initLine])).toEqual({ agentVersion: "2.1.280" });
    expect(resultEventFields([])).toEqual({});
  });

  it("skips corrupt lines and non-string / negative fields instead of coercing them", () => {
    const bad = JSON.stringify({ type: "result", stop_reason: 7, duration_ms: -3, session_id: "" });
    expect(resultEventFields(["{not json", bad])).toEqual({});
  });
});

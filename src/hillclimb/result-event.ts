// What the agent itself reported about the current turn, read from `events.jsonl`.
//
// The terminal `{type:"result"}` frame is the only place `stop_reason` appears: every streamed assistant
// event carries `stop_reason: null` (measured on a kept fan-out run: 1 `end_turn` vs 244 `null`), and
// `parseMessage`'s result case drops it (src/agent/session.ts:1420-1438). Its `duration_ms` is the agent's
// own session duration — the row's latency source, because RunResult.durationMs also spans proxy start
// and the semantic judge (src/run/execute.ts:826, :1676, :1928). The agent version comes from
// `system/init` (`claude_code_version`), the same frame recordedInitAgentVersion reads for cassettes.

import { currentTurnEventLines } from "../run/turn-events.js";

export interface ResultEventFields {
  stopReason?: string;
  durationMs?: number;
  sessionId?: string;
  agentVersion?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Fields of the current turn's LAST result frame and its init frame. A field that is absent, empty, or of
 *  the wrong type is left out — never defaulted: a killed run has no result frame, and a row must say so
 *  rather than carry an invented `end_turn` or a 0 s latency. */
export function resultEventFields(lines: readonly string[]): ResultEventFields {
  const out: ResultEventFields = {};
  for (const line of currentTurnEventLines([...lines])) {
    let o: {
      type?: unknown;
      subtype?: unknown;
      stop_reason?: unknown;
      duration_ms?: unknown;
      session_id?: unknown;
      claude_code_version?: unknown;
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "system" && o.subtype === "init") {
      const v = str(o.claude_code_version);
      if (v !== undefined) out.agentVersion = v;
      continue;
    }
    if (o?.type !== "result") continue;
    // The last result frame wins outright: a field it lacks must not survive from an earlier frame.
    delete out.stopReason;
    delete out.durationMs;
    delete out.sessionId;
    const stop = str(o.stop_reason);
    if (stop !== undefined) out.stopReason = stop;
    if (typeof o.duration_ms === "number" && Number.isFinite(o.duration_ms) && o.duration_ms >= 0) out.durationMs = o.duration_ms;
    const sid = str(o.session_id);
    if (sid !== undefined) out.sessionId = sid;
  }
  return out;
}

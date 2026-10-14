import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMessage } from "../src/agent/session.js";
import { sliceTurnEvents } from "../src/metric-command/slice.js";
import { currentTurnEventLines } from "../src/run/turn-events.js";
import { harvestRun } from "../src/search-corpus/harvest.js";
import { turnEventsBytes } from "../src/metric-command/live.js";

// The serve frames this release adds, provisional (a sub-agent's, not yet resolved) and unpaired (a result with no
// request), through the readers that see events.jsonl: none acts on them, attributes by their ordinal, or drops them.
const provisional = JSON.stringify({
  _emu: "search_corpus_serve",
  streamed: true,
  toolUseId: "c1",
  parentToolUseId: "task1",
  attribution: "provisional",
  query: "q",
  ordinal: 2,
  pool: { poolId: "p", sha256: "a".repeat(64) },
  verdict: "served",
  rounds: [],
});
const unpaired = JSON.stringify({
  _emu: "search_corpus_serve",
  streamed: true,
  toolUseId: "c2",
  parentToolUseId: "task1",
  query: "q",
  unpaired: true,
});
const use = JSON.stringify({
  type: "assistant",
  parent_tool_use_id: "task1",
  message: { content: [{ type: "tool_use", id: "c1", name: "WebSearch", input: { query: "q" } }] },
});
const turn2 = JSON.stringify({ _emu: "turn_start", turn: 2 });

describe("provisional and unpaired serve frames through the events.jsonl readers", () => {
  it("the stream parser makes no event of either", () => {
    expect(parseMessage(JSON.parse(provisional))).toEqual([]);
    expect(parseMessage(JSON.parse(unpaired))).toEqual([]);
  });
  it("a command metric's slice passes both through verbatim, in their turn", () => {
    const raw = [use, provisional, unpaired, turn2, provisional].join("\n") + "\n";
    const one = sliceTurnEvents(raw, 1) as { bytes: Buffer };
    expect(one.bytes.toString("utf8")).toBe([use, provisional, unpaired].join("\n") + "\n");
    const two = sliceTurnEvents(raw, 2) as { bytes: Buffer };
    expect(two.bytes.toString("utf8")).toBe(provisional + "\n");
  });
  it("a live command metric's events read passes both through verbatim", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-frames-"));
    writeFileSync(join(d, "events.jsonl"), [use, provisional, unpaired].join("\n") + "\n");
    const got = turnEventsBytes(d, 1) as { bytes: Buffer };
    expect(got.bytes.toString("utf8")).toBe([use, provisional, unpaired].join("\n") + "\n");
  });
  it("the current-turn reader keeps them and splits only on a turn marker", () => {
    expect(currentTurnEventLines([use, provisional, unpaired, turn2, unpaired])).toEqual([unpaired]);
    expect(currentTurnEventLines([use, provisional, unpaired])).toEqual([use, provisional, unpaired]);
  });
  it("harvest skips a served run whole, frames included", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-frames-"));
    mkdirSync(join(d, "turns", "1"), { recursive: true });
    writeFileSync(join(d, "events.jsonl"), [use, provisional, unpaired].join("\n"));
    writeFileSync(join(d, "search-corpus.jsonl"), "");
    const h = harvestRun(d);
    expect(h.served).toBe(true);
    expect(h.records).toEqual([]);
  });
});

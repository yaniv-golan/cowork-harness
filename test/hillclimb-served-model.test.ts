// The served-model assertion (runner-scaffold.mjs runner-scaffold.mjs l.476-494), applied to the MAIN loop only.
//
// Why not RunResult.modelPinHonored: it is `observed.some(m => m === pin)` over every model on every
// assistant event, sub-agents included (src/run/model-provenance.ts:123, src/run/run.ts:856-861). A main
// loop that answered partly on the pin and partly on another model therefore reports "honored". The scaffold's
// rule fails the attempt when ANY response model differs beyond a documented alias→snapshot resolution.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mainLoopModels, servedModelMismatch } from "../src/hillclimb/served-model.js";
import { deriveModelProvenance } from "../src/run/model-provenance.js";

const fanout = readFileSync("test/fixtures/hillclimb-runs/assistant-models-fanout.jsonl", "utf8").trim().split("\n");

describe("mainLoopModels", () => {
  it("collects only the main loop's live models — sub-agent models are not the model under test", () => {
    // SYNTHETIC fixture (README): main loop on claude-opus-5; sub-agents on claude-opus-5 and claude-sonnet-5.
    expect(mainLoopModels(fanout)).toEqual(["claude-opus-5"]);
  });

  it("ignores <synthetic> and model-less events", () => {
    const lines = [
      JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: "<synthetic>" } }),
      JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: {} }),
    ];
    expect(mainLoopModels(lines)).toEqual([]);
  });
});

describe("servedModelMismatch (runner-scaffold.mjs l.485-494)", () => {
  it("a fan-out stream whose sub-agents used another model is NOT a substitution", () => {
    expect(servedModelMismatch("claude-opus-5", mainLoopModels(fanout))).toBeUndefined();
  });

  it("catches a second main-loop model that modelPinHonored misses", () => {
    // One extra main-loop event served by another model, appended to the stream.
    const lines = [...fanout, JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-sonnet-5" } })];
    const models = mainLoopModels(lines);
    // The existing provenance check calls this run honored — the reason the runner carries its own rule.
    expect(deriveModelProvenance("claude-opus-5", models, []).modelPinHonored).toBe(true);
    expect(servedModelMismatch("claude-opus-5", models)).toBe("claude-sonnet-5");
  });

  it("accepts S's documented alias → snapshot shapes", () => {
    for (const [pin, served] of [
      ["claude-x-latest", "claude-x-20250101"],
      ["claude-x-0", "claude-x@20250101"],
      ["claude-x", "claude-x-2025-01-01"],
      ["claude-x-20250101", "claude-x-20250101"],
    ])
      expect(servedModelMismatch(pin, [served])).toBeUndefined();
  });

  it("refuses another snapshot, a sibling model, and an unversioned echo of an alias", () => {
    expect(servedModelMismatch("claude-x-20240101", ["claude-x-20250101"])).toBe("claude-x-20250101");
    expect(servedModelMismatch("claude-x", ["claude-y-20250101"])).toBe("claude-y-20250101");
    expect(servedModelMismatch("claude-x-latest", ["claude-x"])).toBe("claude-x");
  });

  it("no pin ⇒ no check (S skips it when --model is absent); no observed model ⇒ nothing to refuse", () => {
    expect(servedModelMismatch(undefined, ["anything"])).toBeUndefined();
    expect(servedModelMismatch("claude-x", [])).toBeUndefined();
  });
});

// The one model-id matcher (`modelIdMatches`) and the pin checks built on it.
//
// The key shape comes from a real eval rep pinned to an undated id (agent 2.1.317): the main loop reported
// `models: ["claude-haiku-4-5-20251001"]` while `modelUsage` was keyed `claude-haiku-4-5` — the agent keys usage by
// the id it was ASKED for, and the response names the dated snapshot it was SERVED. Synthetic data only.
import { describe, it, expect } from "vitest";
import { deriveModelProvenance, isConcreteModelId, modelIdMatches } from "../src/run/model-provenance.js";
import { servedModelMismatch } from "../src/hillclimb/served-model.js";
import { otherModelShare } from "../src/hillclimb/cost.js";

const PIN = "claude-haiku-4-5";
const SERVED = "claude-haiku-4-5-20251001";

describe("modelIdMatches", () => {
  it.each([
    [PIN, PIN, true],
    [PIN, SERVED, true],
    [PIN, "claude-haiku-4-5@20251001", true],
    [PIN, "claude-haiku-4-5-2025-10-01", true],
    [`${PIN}[1m]`, SERVED, true],
    [PIN, "Claude-Haiku-4-5-20251001", true],
    ["claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022", true],
    ["claude-sonnet-4-0", "claude-sonnet-4-20250514", true],
    // A dated pin is matched by itself only: another snapshot is another model.
    [SERVED, "claude-haiku-4-5-20251101", false],
    [SERVED, PIN, false],
    // Siblings and other families never match; nor a prefix that is not a date.
    [PIN, "claude-haiku-4-5-1", false],
    ["claude-opus-5", "claude-opus-5-5", false],
    ["claude-opus-5", "claude-opus-5-5-20250101", false],
    [PIN, "claude-sonnet-5", false],
    // The bare base served for a rolling alias is an unversioned echo, not a snapshot.
    ["claude-x-latest", "claude-x", false],
  ])("(%s, %s) ⇒ %s", (pin, served, want) => {
    expect(modelIdMatches(pin, served)).toBe(want);
  });

  it("servedModelMismatch is the same rule: it names the first served id the matcher rejects", () => {
    expect(servedModelMismatch(PIN, [SERVED])).toBeUndefined();
    expect(servedModelMismatch(PIN, [SERVED, "claude-sonnet-5"])).toBe("claude-sonnet-5");
    expect(servedModelMismatch(SERVED, ["claude-haiku-4-5-20251101"])).toBe("claude-haiku-4-5-20251101");
  });
});

describe("isConcreteModelId: a rolling alias is not concrete", () => {
  it.each(["claude-3-5-sonnet-latest", "claude-sonnet-4-0", "opus", "best"])("%s ⇒ false", (id) => {
    expect(isConcreteModelId(id)).toBe(false);
  });
  it.each([PIN, SERVED, "claude-opus-5[1m]", "claude-sonnet-4-5"])("%s ⇒ true", (id) => {
    expect(isConcreteModelId(id)).toBe(true);
  });
});

describe("deriveModelProvenance under an undated pin", () => {
  it("the pin is honored when the main loop is served its dated snapshot", () => {
    expect(deriveModelProvenance(PIN, [SERVED], [], { [PIN]: { costUSD: 0.07 } }).modelPinHonored).toBe(true);
  });
  it("another model served is still a mismatch", () => {
    expect(deriveModelProvenance(PIN, ["claude-sonnet-5"], [], {}).modelPinHonored).toBe(false);
  });
  it("no live model: the usage key (the requested id) vouches for the pin", () => {
    expect(deriveModelProvenance(PIN, ["<synthetic>"], [], { [PIN]: { costUSD: 0.07 } }).modelPinHonored).toBe(true);
  });
  it("a fallback off the pin refutes it, whichever form of the pin it names (a dated originalModel is a CONSTRUCTED shape)", () => {
    expect(
      deriveModelProvenance(PIN, [SERVED], [{ originalModel: SERVED, fallbackModel: "claude-sonnet-5" }] as never, {}).modelPinHonored,
    ).toBe(false);
    expect(
      deriveModelProvenance(PIN, [SERVED], [{ originalModel: PIN, fallbackModel: "claude-sonnet-5" }] as never, {}).modelPinHonored,
    ).toBe(false);
  });
});

describe("hillclimb cost: usage keyed by the requested id is the main model's", () => {
  it("otherModelShare does not count the main model's own spend as another model's", () => {
    const row = {
      cost_usd: 0.1,
      model: SERVED,
      meta: { run_id: "r1", models: { [PIN]: { cost_usd: 0.09 }, "claude-sonnet-5": { cost_usd: 0.01 } } },
    };
    const s = otherModelShare(JSON.stringify(row) + "\n");
    expect(s?.share).toBeCloseTo(0.1);
  });
});

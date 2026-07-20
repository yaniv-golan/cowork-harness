import { describe, it, expect } from "vitest";
import { diffMeta, compareDiffSides, type DiffMetaSummary, type DiffSide } from "../src/run/diff.js";

/** `diff --help` (cli.ts) promises: "transcript is advisory (model-stochastic prose differs across live
 *  re-records no matter what) — tools/artifacts/meta are the gateable signal." The exit code conjoined
 *  ALL FOUR views including the advisory transcript, so two live runs of the SAME skill exited 1 and the
 *  signal could not separate "behaviour changed" from "the model breathed". These pin the documented
 *  contract onto the value the exit code actually uses. */
function side(over: Partial<DiffSide> = {}): DiffSide {
  return {
    tools: [{ name: "Read", canon: '{"file":"a.md"}' }],
    transcript: "the agent read a.md and summarised it",
    artifacts: [["outputs/x.md", "abc"]],
    meta: { result: "success", baseline: "1.0.0", assertionsPassed: true },
    ...over,
  };
}

describe("diff gateable signal", () => {
  it("stays gateable-identical when ONLY the advisory transcript differs", () => {
    const r = compareDiffSides(side(), side({ transcript: "the agent read a.md, then wrote a summary" }), true);
    expect(r.transcript.some((o) => o.op !== "same")).toBe(true); // the prose really did differ
    expect(r.identical).toBe(true); // ...but that is advisory, per the documented contract
  });

  it("is not gateable-identical when a GATEABLE view differs", () => {
    const r = compareDiffSides(side(), side({ tools: [{ name: "Write", canon: '{"file":"a.md"}' }] }), true);
    expect(r.identical).toBe(false);
  });

  it("reports transcript drift separately so it is visible, not swallowed", () => {
    const r = compareDiffSides(side(), side({ transcript: "different prose entirely" }), true);
    expect(r.transcriptDiffers).toBe(true);
    expect(r.identical).toBe(true);
  });
});

describe("diff artifacts availability — missing evidence must not read as verified-equal", () => {
  it("a-side missing a manifest is NOT gateable-identical, even though tools/meta agree", () => {
    const r = compareDiffSides(side({ artifacts: undefined }), side(), true);
    expect(r.identical).toBe(false);
    expect(r.artifactsAvailability).toBe("a-unavailable");
    expect(r.artifacts).toBeUndefined();
  });

  it("b-side missing a manifest is NOT gateable-identical, even though tools/meta agree", () => {
    const r = compareDiffSides(side(), side({ artifacts: undefined }), true);
    expect(r.identical).toBe(false);
    expect(r.artifactsAvailability).toBe("b-unavailable");
    expect(r.artifacts).toBeUndefined();
  });

  it("both sides missing a manifest does not veto identity — nothing to contradict on either side, and this must not turn every legacy manifest-less cassette-vs-cassette diff permanently red", () => {
    const r = compareDiffSides(side({ artifacts: undefined }), side({ artifacts: undefined }), true);
    expect(r.identical).toBe(true);
    expect(r.artifactsAvailability).toBe("both-unavailable");
    expect(r.artifacts).toBeUndefined();
  });

  it("both sides available with equal artifacts stays gateable-identical", () => {
    const r = compareDiffSides(side(), side(), true);
    expect(r.identical).toBe(true);
    expect(r.artifactsAvailability).toBe("both-available");
  });

  it("both sides available but artifact content differs is NOT gateable-identical", () => {
    const r = compareDiffSides(side(), side({ artifacts: [["outputs/x.md", "a-different-hash"]] }), true);
    expect(r.identical).toBe(false);
    expect(r.artifactsAvailability).toBe("both-available");
    expect(r.artifacts?.changed).toEqual(["outputs/x.md"]);
  });
});

describe("diff meta carries generation identity", () => {
  it("diffs skillHash so a diff can name which generations it compared", () => {
    const a: Partial<DiffMetaSummary> = { result: "success", baseline: "1.0.0", skillHash: "aaaaaaaaaaaa" };
    const b: Partial<DiffMetaSummary> = { result: "success", baseline: "1.0.0", skillHash: "bbbbbbbbbbbb" };
    const entries = diffMeta(a, b);
    expect(entries).toContainEqual({ field: "skillHash", from: "aaaaaaaaaaaa", to: "bbbbbbbbbbbb" });
  });

  it("does not report a skillHash delta when both sides are the same generation", () => {
    const same: Partial<DiffMetaSummary> = { result: "success", baseline: "1.0.0", skillHash: "aaaaaaaaaaaa" };
    expect(diffMeta(same, same).find((e) => e.field === "skillHash")).toBeUndefined();
  });
});

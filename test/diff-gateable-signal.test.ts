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

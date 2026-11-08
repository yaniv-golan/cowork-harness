// `hillclimb check`: a variant whose scored rows for one pin were served two models (an error unless every such row opted in, then a warning), and a promoted
// judge_invalid slot whose errors row an interrupted regrade left behind (a note). Synthetic rows only.
import { describe, it, expect } from "vitest";
import { promotedOrphanNotes, servedModelSplitFindings } from "../src/hillclimb/check.js";
import type { FlowSnapshot } from "../src/hillclimb/schema-check.js";

const jl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const snap = (results: string, errors = ""): FlowSnapshot => ({ variants: { baseline: { results, errors } } }) as unknown as FlowSnapshot;
const row = (id: string, model: string, runId: string) => ({
  prompt_id: id,
  rep: 0,
  model,
  meta: { model_requested: "claude-sonnet-5", run_id: runId },
});

describe("served_model.split", () => {
  const S1 = "claude-sonnet-5-20251001";
  const S2 = "claude-sonnet-5-20251101";
  const allowed = (r: ReturnType<typeof row>) => ({ ...r, meta: { ...r.meta, model_split_allowed: true } });
  it("two snapshots of one pin, not opted in: an error naming both and the cases", () => {
    expect(servedModelSplitFindings(snap(jl(row("a", S1, "r1"), row("b", S2, "r2"))))).toEqual([
      { severity: "error", message: expect.stringMatching(new RegExp(`served ${S1} and ${S2} \\(cases a, b\\).*not every row`)) },
    ]);
  });
  it("one split row written without the flag beside one written with it is still an error", () => {
    expect(servedModelSplitFindings(snap(jl(row("a", S1, "r1"), allowed(row("b", S2, "r2")))))[0]!.severity).toBe("error");
  });
  it("every split row written under --allow-model-split: a warning that says the rows count in the headline", () => {
    expect(servedModelSplitFindings(snap(jl(allowed(row("a", S1, "r1")), allowed(row("b", S2, "r2")))))).toEqual([
      { severity: "warning", message: expect.stringContaining("count in the headline score") },
    ]);
  });
  it("(control) one snapshot, or a served model that is not the pin's (an error row's business), finds nothing", () => {
    expect(servedModelSplitFindings(snap(jl(row("a", S1, "r1"), row("b", S1, "r2"))))).toEqual([]);
    expect(servedModelSplitFindings(snap(jl(row("a", S1, "r1"), row("b", "claude-opus-5", "r2"))))).toEqual([]);
  });
});

describe("a promoted slot's leftover errors row", () => {
  const inv = (runId: string) => ({ prompt_id: "a", rep: 0, failure_class: "judge_invalid", meta: { run_id: runId } });
  it("a judge_invalid errors row sharing its run id with a results row is noted", () => {
    expect(promotedOrphanNotes(snap(jl(row("a", "claude-sonnet-5", "r1")), jl(inv("r1"))))).toEqual([
      expect.stringContaining("slot (a, rep 0)"),
    ]);
  });
  it("(control) an earlier failed attempt at a slot a later pass filled is history, not noted", () => {
    expect(promotedOrphanNotes(snap(jl(row("a", "claude-sonnet-5", "r2")), jl(inv("r1"))))).toEqual([]);
  });
});

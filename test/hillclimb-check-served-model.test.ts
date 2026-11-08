// `hillclimb check`: a variant whose scored rows for one pin were served two models (a warning), and a promoted
// judge_invalid slot whose errors row an interrupted regrade left behind (a note). Synthetic rows only.
import { describe, it, expect } from "vitest";
import { promotedOrphanNotes, servedModelSplitWarnings } from "../src/hillclimb/check.js";
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
  it("two snapshots of one pin across a variant's rows: one warning naming both and the cases", () => {
    const w = servedModelSplitWarnings(snap(jl(row("a", "claude-sonnet-5-20251001", "r1"), row("b", "claude-sonnet-5-20251101", "r2"))));
    expect(w).toEqual([
      expect.stringMatching(/^served_model\.split: .*served claude-sonnet-5-20251001 and claude-sonnet-5-20251101 \(cases a, b\)/),
    ]);
  });
  it("(control) one snapshot, or a served model that is not the pin's (an error row's business), warns nothing", () => {
    expect(
      servedModelSplitWarnings(snap(jl(row("a", "claude-sonnet-5-20251001", "r1"), row("b", "claude-sonnet-5-20251001", "r2")))),
    ).toEqual([]);
    expect(servedModelSplitWarnings(snap(jl(row("a", "claude-sonnet-5-20251001", "r1"), row("b", "claude-opus-5", "r2"))))).toEqual([]);
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

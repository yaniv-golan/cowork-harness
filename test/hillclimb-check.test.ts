// `hillclimb check`: our schema reading plus two loop-readiness reports. Headroom: baseline cases that sit at
// the ceiling or the floor of the headline metric on every rep cannot show a change, which the loop must know
// before round 1 (eval-hillclimb.md l.35). It is a WARNING, never an exit code — refusing is the loop's call, not ours.
import { describe, it, expect } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFlowSnapshot, type FlowSnapshot } from "../src/hillclimb/schema-check.js";
import { headroom, metricRangeWarnings, stateMetricFindings } from "../src/hillclimb/check.js";
import { otherModelShareNotes } from "../src/hillclimb/cost.js";

const FIXTURE = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "test", "fixtures", "hillclimb-flow");
const snap = (): FlowSnapshot => structuredClone(loadFlowSnapshot(FIXTURE));
type Row = Record<string, unknown>;
const editRows = (s: FlowSnapshot, v: string, f: (r: Row) => void) => {
  const rs = s.variants[v]!.results!.trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
  rs.forEach(f);
  s.variants[v]!.results = rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
};
const setState = (s: FlowSnapshot, f: (st: Row) => void) => {
  const st = JSON.parse(s.state!) as Row;
  f(st);
  s.state = JSON.stringify(st);
};

describe("headroom", () => {
  it("on the fixture's baseline, the case failing on every rep is at the floor; none is at the ceiling", () => {
    // baseline pass by case: extract-table 1,0 · summarize-report 0,0 · long-answer 1,0
    const h = headroom(snap());
    expect(h).toMatchObject({ metric: "pass", better: "higher", cases: 3, ceiling: [], floor: ["summarize-report"] });
    expect(h.warnings).toEqual([expect.stringMatching(/^warning: 1\/3 baseline cases are at the floor on pass.*summarize-report/)]);
  });

  it("every rep at the good end is the ceiling", () => {
    const s = snap();
    editRows(s, "baseline", (r) => r.prompt_id === "extract-table" && ((r.grade as Row).pass = 1));
    expect(headroom(s).ceiling).toEqual(["extract-table"]);
  });

  it("a pairwise case at the pass ceiling is a note, not a warning: its pairwise assert is neutral on baseline", () => {
    const s = snap();
    editRows(s, "baseline", (r) => (r.prompt_id === "extract-table" || r.prompt_id === "long-answer") && ((r.grade as Row).pass = 1));
    const cases = [
      { id: "extract-table", scenario: { assert: [{ result: "success" }, { semantic_pairwise: { rubric: ["r"] } }] } },
      { id: "long-answer", scenario: { assert: [{ result: "success" }] } },
    ] as never;
    const h = headroom(s, cases);
    expect(h.ceiling).toEqual(["extract-table", "long-answer"]);
    expect(h.warnings).toEqual([
      "note: extract-table: its pairwise assert cannot fail on baseline (neutral against its own reference), so `pass` cannot show a pairwise gain; that shows in `win`",
      expect.stringMatching(/^warning: 1\/3 baseline cases are at the ceiling on pass .*: long-answer — they cannot show a gain/),
      expect.stringMatching(/^warning: 1\/3 baseline cases are at the floor on pass.*summarize-report/),
    ]);
  });

  it("with no cases to read (check without a target), a case whose rows carry a<i>_win_present is pairwise, whatever its value", () => {
    const s = snap();
    editRows(s, "baseline", (r) => {
      if (r.prompt_id === "extract-table" || r.prompt_id === "long-answer") (r.grade as Row).pass = 1;
      // The key's presence marks the pairwise assert; its value (0 here: not compared) is never read.
      if (r.prompt_id === "extract-table") (r.grade as Row).a1_win_present = 0;
    });
    expect(headroom(s).warnings).toEqual([
      "note: extract-table: its pairwise assert cannot fail on baseline (neutral against its own reference), so `pass` cannot show a pairwise gain; that shows in `win`",
      expect.stringMatching(/^warning: 1\/3 baseline cases are at the ceiling on pass .*: long-answer — they cannot show a gain/),
      expect.stringMatching(/^warning: 1\/3 baseline cases are at the floor on pass.*summarize-report/),
    ]);
  });

  it("a pairwise case at the floor still warns; the note is for pass alone, not another headline metric", () => {
    const s = snap();
    const pw = [{ id: "summarize-report", scenario: { assert: [{ semantic_pairwise: { rubric: ["r"] } }] } }] as never;
    expect(headroom(s, pw).warnings).toEqual([
      expect.stringMatching(/^warning: 1\/3 baseline cases are at the floor on pass.*summarize-report/),
    ]);
    setState(s, (st) => ((st.metrics as Row[])[0].better = "lower"));
    expect(headroom(s, pw).warnings).toEqual([
      expect.stringMatching(/^warning: 1\/3 baseline cases are at the ceiling on pass.*summarize-report/),
    ]);
    const s2 = snap();
    setState(s2, (st) => (st.metrics = [{ id: "words", kind: "float", better: "lower", unbounded: true }]));
    editRows(s2, "baseline", (r) => ((r.grade as Row).words = r.prompt_id === "extract-table" ? 0 : 120));
    const et = [{ id: "extract-table", scenario: { assert: [{ semantic_pairwise: { rubric: ["r"] } }] } }] as never;
    expect(headroom(s2, et).warnings).toEqual([expect.stringMatching(/^warning: 1\/3 baseline cases are at the ceiling on words/)]);
  });

  it("direction-aware: with better: lower, all-zero is the good end", () => {
    const s = snap();
    setState(s, (st) => ((st.metrics as Row[])[0].better = "lower"));
    expect(headroom(s)).toMatchObject({ better: "lower", ceiling: ["summarize-report"], floor: [] });
  });

  it("a non-ok rep and a rep without the key do not count; a case with no measured rep is left out", () => {
    const s = snap();
    editRows(s, "baseline", (r) => {
      if (r.prompt_id === "extract-table" && r.rep === 1) r.status = "truncated";
      if (r.prompt_id === "long-answer") delete (r.grade as Row).pass;
    });
    expect(headroom(s)).toMatchObject({ cases: 2, ceiling: ["extract-table"], floor: ["summarize-report"] });
  });

  it("a lower-is-better float with no declared min reads its floor as 0 (scenario docs: min is declared only when not 0)", () => {
    const s = snap();
    setState(s, (st) => (st.metrics = [{ id: "words", kind: "float", better: "lower", unbounded: true }]));
    editRows(s, "baseline", (r) => ((r.grade as Row).words = r.prompt_id === "extract-table" ? 0 : 120));
    const h = headroom(s);
    expect(h).toMatchObject({ metric: "words", better: "lower", cases: 3, ceiling: ["extract-table"], floor: [] });
    expect(h.warnings).toEqual([expect.stringMatching(/^warning: 1\/3 baseline cases are at the ceiling on words/)]);
  });

  it("a min that is not a number gives no good end (it is a _state.json error, never read as 0)", () => {
    const s = snap();
    setState(s, (st) => (st.metrics = [{ id: "words", kind: "float", better: "lower", min: "0" }]));
    editRows(s, "baseline", (r) => ((r.grade as Row).words = 0));
    const h = headroom(s);
    expect(h.ceiling).toEqual([]);
    expect(h.warnings).toEqual([
      "note: words is lower-is-better with a floor (min) that is not a number — the good end is unknown, so ceiling/floor are not computed",
    ]);
  });

  it("a lower-is-better float with a declared min: every rep at the min is the ceiling (direction-aware)", () => {
    const s = snap();
    setState(s, (st) => (st.metrics = [{ id: "words", kind: "float", better: "lower", min: 5 }]));
    editRows(s, "baseline", (r) => ((r.grade as Row).words = r.prompt_id === "extract-table" ? 5 : 120));
    expect(headroom(s)).toMatchObject({ metric: "words", better: "lower", cases: 3, ceiling: ["extract-table"], floor: [] });
  });

  it("a higher-is-better float with no declared scale has no known good end either", () => {
    const s = snap();
    setState(s, (st) => (st.metrics = [{ id: "ratio", kind: "float", better: "higher" }]));
    editRows(s, "baseline", (r) => ((r.grade as Row).ratio = 1));
    expect(headroom(s).warnings).toEqual([
      "note: ratio is higher-is-better with no scale declared — the good end is unknown, so ceiling/floor are not computed",
    ]);
  });

  it("a higher-is-better float at its scale on every rep is the ceiling", () => {
    const s = snap();
    setState(s, (st) => (st.metrics = [{ id: "ratio", kind: "float", better: "higher", scale: 1 }]));
    editRows(s, "baseline", (r) => ((r.grade as Row).ratio = r.prompt_id === "long-answer" ? 1 : 0.5));
    expect(headroom(s)).toMatchObject({ metric: "ratio", ceiling: ["long-answer"], floor: [] });
  });

  it("no baseline rows → no headroom report", () => {
    const s = snap();
    delete s.variants.baseline;
    expect(headroom(s).warnings).toEqual(["note: no baseline rows yet — run the baseline before round 1"]);
  });
});

describe("metricRangeWarnings (a float value outside its declared range)", () => {
  const declare = (s: FlowSnapshot, m: Row) =>
    setState(s, (st) => (st.metrics as Row[]).push({ id: "ratio", kind: "float", better: "higher", ...m }));

  it("a value above scale or below min (0 when absent) is a warning naming the row; in range is silent", () => {
    const s = snap();
    declare(s, { scale: 1 });
    editRows(
      s,
      "baseline",
      (r) =>
        ((r.grade as Row).ratio =
          r.prompt_id === "extract-table" && r.rep === 1 ? 12.5 : r.prompt_id === "long-answer" && r.rep === 0 ? -0.5 : 0.5),
    );
    expect(metricRangeWarnings(s)).toEqual([
      "warning: grade.ratio = 12.5 is outside its declared range [0, 1] (variant baseline, prompt_id extract-table, rep 1) — check the metric's path and units",
      "warning: grade.ratio = -0.5 is outside its declared range [0, 1] (variant baseline, prompt_id long-answer, rep 0) — check the metric's path and units",
    ]);
  });

  it("a declared min is the lower bound; every variant is read", () => {
    const s = snap();
    declare(s, { scale: 10, min: 2 });
    editRows(s, "baseline", (r) => ((r.grade as Row).ratio = 5));
    editRows(s, "v1", (r) => ((r.grade as Row).ratio = r.prompt_id === "summarize-report" && r.rep === 0 ? 1 : 5));
    expect(metricRangeWarnings(s)).toEqual([
      expect.stringMatching(
        /^warning: grade\.ratio = 1 is outside its declared range \[2, 10\] \(variant v1, prompt_id summarize-report, rep 0\)/,
      ),
    ]);
  });

  it("an unbounded float (no scale), or a bound that is not a number, is not range-checked", () => {
    for (const m of [{ unbounded: true }, { scale: "1" }, { scale: 1, min: "0" }]) {
      const s = snap();
      declare(s, m);
      editRows(s, "baseline", (r) => ((r.grade as Row).ratio = 999));
      expect(metricRangeWarnings(s), JSON.stringify(m)).toEqual([]);
    }
  });
});

describe("stateMetricFindings (a float must say which way is better)", () => {
  it("a declared float without `better` is an error — a silent 'higher' on a cost-like metric climbs the wrong way", () => {
    const s = snap();
    setState(s, (st) => (st.metrics as Row[]).push({ id: "cost", kind: "float" }));
    expect(stateMetricFindings(s)).toEqual([
      expect.objectContaining({ level: "error", rule: "state.metrics", message: expect.stringMatching(/cost.*better/) }),
    ]);
  });

  it("the fixture's declarations are clean", () => {
    expect(stateMetricFindings(snap())).toEqual([]);
  });
});

describe("otherModelShareNotes (check repeats the pass's different-model warning)", () => {
  const priced = (s: FlowSnapshot, v: string, other: number) =>
    editRows(s, v, (r) => {
      r.model = "claude-opus-5";
      r.cost_usd = 1;
      r.meta = { ...(r.meta as Row), models: { "claude-opus-5": { cost_usd: 1 - other }, "claude-sonnet-5": { cost_usd: other } } };
    });
  it("a note per variant whose other models carry more than 25% of its cost_usd; none at or below", () => {
    const s = snap();
    priced(s, "baseline", 0.25);
    priced(s, "v1", 0.4);
    expect(otherModelShareNotes(s)).toEqual([
      expect.stringMatching(/^note: v1: models other than the main loop's carry 40% of this variant's cost_usd/),
    ]);
  });
  it("the fixture, which records no per-model cost, has none", () => {
    expect(otherModelShareNotes(snap())).toEqual([]);
  });
});

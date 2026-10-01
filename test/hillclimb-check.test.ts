// `hillclimb check`: our schema reading plus two loop-readiness reports. Headroom: baseline cases that sit at
// the ceiling or the floor of the headline metric on every rep cannot show a change, which the loop must know
// before round 1 (eval-hillclimb.md l.35). It is a WARNING, never an exit code — refusing is the loop's call, not ours.
import { describe, it, expect } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFlowSnapshot, type FlowSnapshot } from "../src/hillclimb/schema-check.js";
import { headroom, stateMetricFindings } from "../src/hillclimb/check.js";

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

  it("a float headline with no declared bound reports that, not a number", () => {
    const s = snap();
    setState(s, (st) => (st.metrics = [{ id: "words", kind: "float", better: "lower" }]));
    editRows(s, "baseline", (r) => ((r.grade as Row).words = 120));
    const h = headroom(s);
    expect(h.ceiling).toEqual([]);
    expect(h.floor).toEqual([]);
    expect(h.warnings).toEqual(["note: words is a float with no declared bound — ceiling/floor not computed"]);
  });

  it("no baseline rows → no headroom report", () => {
    const s = snap();
    delete s.variants.baseline;
    expect(headroom(s).warnings).toEqual(["note: no baseline rows yet — run the baseline before round 1"]);
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

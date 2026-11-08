// `eval report --headroom`: which rows an arm still has room to move on (pure over the report).
import { describe, it, expect } from "vitest";
import { headroomRows, headroomText, resolveHeadroomArm } from "../src/eval/headroom.js";
import { parseEvalReportArgs } from "../src/eval/command.js";
import type { EvalReport, ReportRow } from "../src/eval/report.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const row = (text: string, k2: number, n2: number, scenario = "s1"): ReportRow =>
  ({ text, scenario, kind: "assertion", k1: 0, n1: 0, k2, n2, label: "insufficient", inFamily: true }) as unknown as ReportRow;
const report = (rows: ReportRow[], held: ReportRow[] = []) =>
  ({ sections: { tuned: { rows }, heldOut: held.length ? { rows: held } : null } }) as unknown as Pick<EvalReport, "sections">;

describe("headroomRows", () => {
  it("the boundaries: 0/1, 0/3, 3/3 in (too few reps); 4/4 and 0/5 out; 2/5 in", () => {
    const out = headroomRows(report([row("a", 0, 1), row("b", 0, 3), row("c", 3, 3), row("d", 4, 4), row("e", 0, 5), row("f", 2, 5)]), "B");
    expect(out.map((r) => r.text).sort()).toEqual(["a", "b", "c", "f"]);
    expect(out.find((r) => r.text === "f")).toMatchObject({ k: 2, n: 5, rate: 0.4, tooFewReps: false });
    expect(out.find((r) => r.text === "f")!.headroom).toBeCloseTo(0.4);
    expect(out.find((r) => r.text === "c")).toMatchObject({ tooFewReps: true, headroom: 0 });
  });

  it("lists assertion and claim rows only: a derived row with room is left out", () => {
    const of = (text: string, kind: string) => ({ ...row(text, 2, 5), kind }) as unknown as ReportRow;
    const out = headroomRows(
      report([
        of("a", "assertion"),
        of("c", "claim"),
        of("r", "semantic_rollup"),
        of("e", "errored_agent_rate"),
        of("i", "invocation_rate"),
      ]),
      "B",
    );
    expect(out.map((r) => r.text).sort()).toEqual(["a", "c"]);
  });

  it("orders by headroom, then scenario; a row with no rep last; reads the chosen arm", () => {
    const rows = [row("x", 1, 5, "zz"), row("y", 2, 4, "aa"), row("z", 0, 0, "aa"), row("w", 2, 4, "bb")];
    expect(headroomRows(report(rows), "B").map((r) => r.text)).toEqual(["y", "w", "x", "z"]);
    // arm A: k1/n1 are 0/0 everywhere — all too few, no rate
    expect(headroomRows(report(rows), "A").every((r) => r.rate === null && r.tooFewReps)).toBe(true);
  });

  it("covers the held-out section, labelled", () => {
    const out = headroomRows(report([], [row("h", 1, 4)]), "B");
    expect(out).toMatchObject([{ section: "heldOut", text: "h" }]);
    expect(headroomText(out, { label: "after", role: "B" })).toMatch(/held out · s1 · assertion h · 1\/4 \(25%\) — headroom 25%/);
  });
});

describe("--arm", () => {
  const arms = {
    arms: [
      { label: "before", role: "A" },
      { label: "after", role: "B" },
    ],
  } as unknown as Pick<EvalReport, "arms">;
  it("takes a label or a role", () => {
    expect(resolveHeadroomArm(arms, "before")).toBe("A");
    expect(resolveHeadroomArm(arms, "B")).toBe("B");
  });
  it("refuses an unknown arm, and a value that is one arm's label and the other's role", () => {
    expect(() => resolveHeadroomArm(arms, "nope")).toThrow(/names no arm/);
    const swapped = {
      arms: [
        { label: "B", role: "A" },
        { label: "x", role: "B" },
      ],
    } as unknown as Pick<EvalReport, "arms">;
    expect(() => resolveHeadroomArm(swapped, "B")).toThrow(/ambiguous/);
  });
  it("parses: default B; --arm needs --headroom", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-"));
    writeFileSync(join(dir, "manifest.json"), "{}");
    expect(parseEvalReportArgs([dir, "--headroom"]).headroom).toEqual({ arm: "B" });
    expect(parseEvalReportArgs([dir, "--headroom", "--arm", "before"]).headroom).toEqual({ arm: "before" });
    expect(parseEvalReportArgs([dir]).headroom).toBeUndefined();
    expect(() => parseEvalReportArgs([dir, "--arm", "A"])).toThrow(/only applies with --headroom/);
  });
});

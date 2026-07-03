import { describe, it, expect } from "vitest";
import { renderSummary } from "../.github/actions/report/render.js";

function envelope(over: Record<string, unknown> = {}) {
  return {
    tool: "cowork-harness",
    version: "0.22.0",
    command: "replay",
    ok: true,
    results: [],
    error: null,
    ...over,
  };
}

describe("renderSummary (Wave 1 / E5 reporter)", () => {
  it("renders the overall pass/fail headline from envelope.ok", () => {
    expect(renderSummary(envelope({ ok: true }))).toContain("pass");
    expect(renderSummary(envelope({ ok: false }))).toContain("fail");
  });

  it("renders one row per result with its scenario name and pass/fail verdict", () => {
    const md = renderSummary(
      envelope({
        results: [
          { scenario: "pdf-extract", verdict: { pass: true, signals: [] } },
          { scenario: "csv-normalize", verdict: { pass: false, signals: [{ code: "stalled", severity: "fail" }] } },
        ],
      }),
    );
    expect(md).toContain("pdf-extract");
    expect(md).toContain("csv-normalize");
    expect(md).toContain("stalled");
  });

  it("surfaces cost.usd and usage.turns when present, tolerating their absence", () => {
    const withBudget = renderSummary(
      envelope({ results: [{ scenario: "x", verdict: { pass: true, signals: [] }, cost: { usd: 0.02 }, usage: { turns: 3 } }] }),
    );
    expect(withBudget).toContain("0.02");
    expect(withBudget).toContain("3");
    // absent cost/usage must not throw or print "undefined"
    const withoutBudget = renderSummary(envelope({ results: [{ scenario: "x", verdict: { pass: true, signals: [] } }] }));
    expect(withoutBudget).not.toContain("undefined");
  });

  it("surfaces staleness findings when present", () => {
    const md = renderSummary(
      envelope({
        results: [
          {
            scenario: "x",
            verdict: { pass: true, signals: [] },
            staleness: [{ class: "baseline", message: "baseline moved since record" }],
          },
        ],
      }),
    );
    expect(md).toContain("baseline moved since record");
  });

  it("surfaces the skippedAssertions honesty line when replay skipped live-only assertions", () => {
    const md = renderSummary(
      envelope({ results: [{ scenario: "x", verdict: { pass: true, signals: [] }, skippedAssertions: { full: 2, partial: 1 } }] }),
    );
    expect(md).toMatch(/skipped 2/);
  });

  it("does not print the skipped-assertions line when nothing was skipped", () => {
    const md = renderSummary(
      envelope({ results: [{ scenario: "x", verdict: { pass: true, signals: [] }, skippedAssertions: { full: 0, partial: 0 } }] }),
    );
    expect(md).not.toContain("skipped");
  });

  it("surfaces the error envelope's category/message when the run failed before producing results", () => {
    const md = renderSummary(envelope({ ok: false, results: [], error: { category: "usage", message: "no such file" } }));
    expect(md).toContain("usage");
    expect(md).toContain("no such file");
  });

  it("ignores unknown envelope fields (rollups/matrix, added by later waves) without throwing", () => {
    expect(() =>
      renderSummary(envelope({ rollups: [{ scenario: "x", passRate: 0.9 }], matrix: { axes: {}, cells: [] } })),
    ).not.toThrow();
  });
});

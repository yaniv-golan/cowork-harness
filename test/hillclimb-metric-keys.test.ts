// The grade keys of a flow's scenario-declared metrics. For every metric in the flow's union, `<id>_present` says
// whether this run measured it, and `<id>` is the value only when it did: an unmeasured metric is OMITTED, never 0
// (a 0 would be a fabricated failure, or a win for a lower-is-better metric). Why it was not measured is returned
// apart, for the row's meta.
import { describe, it, expect } from "vitest";
import { metricEntries, metricSigs } from "../src/hillclimb/metric-keys.js";
import { metricSig } from "../src/hillclimb/grade-keys.js";
import type { RunResult, ScenarioMetric } from "../src/types.js";

const decl = (id: string): ScenarioMetric => ({ id, artifact: "outputs/stats.json", path: id, better: "higher", scale: 1 });
const union = [decl("words"), decl("ratio")];

describe("metricEntries", () => {
  it("a measured value is kept as is, a 0 included, with <id>_present 1", () => {
    expect(
      metricEntries(
        {
          metrics: [
            { id: "words", value: 0 },
            { id: "ratio", value: 0.25 },
          ],
        },
        union,
      ),
    ).toEqual({
      grade: { words_present: 1, words: 0, ratio_present: 1, ratio: 0.25 },
      unavailable: {},
    });
  });

  it("an unavailable metric is omitted with <id>_present 0, and its reason is returned apart", () => {
    expect(
      metricEntries(
        {
          metrics: [
            { id: "words", unavailable: "missing_path" },
            { id: "ratio", value: 1 },
          ],
        },
        union,
      ),
    ).toEqual({
      grade: { words_present: 0, ratio_present: 1, ratio: 1 },
      unavailable: { words: "missing_path" },
    });
  });

  it("a union metric this run has no entry for (its case does not declare it) is <id>_present 0 with no reason", () => {
    expect(metricEntries({ metrics: [{ id: "ratio", value: 1 }] }, union)).toEqual({
      grade: { words_present: 0, ratio_present: 1, ratio: 1 },
      unavailable: {},
    });
    expect(metricEntries({}, union)).toEqual({ grade: { words_present: 0, ratio_present: 0 }, unavailable: {} });
  });

  it("a non-finite value is not a measurement", () => {
    const r = {
      metrics: [
        { id: "words", value: Number.NaN },
        { id: "ratio", value: Number.POSITIVE_INFINITY },
      ],
    } as Pick<RunResult, "metrics">;
    expect(metricEntries(r, union).grade).toEqual({ words_present: 0, ratio_present: 0 });
  });

  it("an entry the flow does not declare is ignored", () => {
    expect(metricEntries({ metrics: [{ id: "other", value: 5 }] }, [decl("words")]).grade).toEqual({ words_present: 0 });
  });
});

describe("metricSigs — the meta.metric_sigs a row graded under these declarations carries", () => {
  it("one sig per declared id (metricSig of its declaration); none for an empty union", () => {
    expect(metricSigs(union)).toEqual({ words: metricSig(union[0]), ratio: metricSig(union[1]) });
    expect(metricSigs([])).toEqual({});
  });
});

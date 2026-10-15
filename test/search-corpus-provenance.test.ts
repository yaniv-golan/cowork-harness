// A frozen pool's provenance against the compared variants, and the asymmetry marker. Pure, $0, synthetic records.
import { describe, it, expect } from "vitest";
import { classifyProvenance, provenanceLine, provenanceRefusal } from "../src/search-corpus/provenance.js";
import { asymmetry, asymmetryLine, sideMetrics, ASYMMETRY_MIN_SEARCHES } from "../src/search-corpus/asymmetry.js";
import { poolManifest, poolRecord, type RecSpec } from "./search-corpus-fixture-pool.js";

const S = "csv-metrics";
const ARMS = [
  { label: "before", sigs: { [S]: "sigA" } },
  { label: "after", sigs: { [S]: "sigB" } },
];
const recs = (spec: Array<[number, RecSpec]>) => spec.flatMap(([k, s]) => Array.from({ length: k }, () => poolRecord(s)));
const classify = (spec: Array<[number, RecSpec]>, o: { dups?: number } = { dups: 0 }, arms = ARMS) => {
  const records = recs(spec);
  return classifyProvenance(poolManifest(records, o), records, [S], arms);
};

describe("provenance: the classes", () => {
  it("no record from either arm is disjoint; a third variant's records are the evidence", () => {
    const p = classify([[5, { scenario: S, variantHash: "sigC" }]]);
    expect(p.class).toBe("disjoint");
    expect(p.perScenario[S]).toMatchObject({ nOther: 5, nUnknown: 0 });
    expect(provenanceRefusal(p)).toBeNull();
  });

  it("records from one arm only are one-sided, and refused naming that arm", () => {
    const p = classify([[4, { scenario: S, variantHash: "sigB" }]]);
    expect(p.class).toBe("one-sided");
    expect(p.perScenario[S]!.drawnFrom).toBe("after");
    expect(provenanceRefusal(p)).toMatch(/come from after \(4 of 4 records/);
  });

  it("one arm diluted by a third variant is still one-sided (the share is over the compared-variant records)", () => {
    const p = classify([
      [2, { scenario: S, variantHash: "sigA" }],
      [8, { scenario: S, variantHash: "sigC" }],
    ]);
    expect(p.class).toBe("one-sided");
    expect(p.perScenario[S]!.drawnFrom).toBe("before");
  });

  it("60/40 is balanced; 61/39 is one-sided", () => {
    expect(
      classify([
        [60, { scenario: S, variantHash: "sigA" }],
        [40, { scenario: S, variantHash: "sigB" }],
      ]).class,
    ).toBe("balanced");
    expect(
      classify([
        [61, { scenario: S, variantHash: "sigA" }],
        [39, { scenario: S, variantHash: "sigB" }],
      ]).class,
    ).toBe("one-sided");
  });

  it("A/A arms with the same signature: a pool from that signature is balanced", () => {
    const aa = [
      { label: "before", sigs: { [S]: "sigA" } },
      { label: "after", sigs: { [S]: "sigA" } },
    ];
    expect(classify([[5, { scenario: S, variantHash: "sigA" }]], { dups: 0 }, aa).class).toBe("balanced");
  });
});

describe("provenance: unknown evidence", () => {
  it("a null variantHash makes a pool with no arm records unknown: CONFOUNDED, not refused", () => {
    const p = classify([
      [3, { scenario: S, variantHash: "sigC" }],
      [1, { scenario: S, variantHash: null }],
    ]);
    expect(p.class).toBe("unknown");
    expect(provenanceRefusal(p)).toBeNull();
    expect(provenanceLine(p)).toMatch(/CONFOUNDED/);
  });

  it("a record from a scenario the eval does not compare is unknown, never disjoint (its hash proves nothing)", () => {
    const p = classify([[3, { scenario: "another-scenario", variantHash: "sigZ" }]]);
    expect(p.class).toBe("unknown");
    expect(p.perScenario[S]!.nUnknown).toBe(3);
  });

  it("one stray unknown record never lifts a one-sided refusal", () => {
    const p = classify([
      [14, { scenario: S, variantHash: "sigB" }],
      [1, { scenario: S, variantHash: null }],
    ]);
    expect(p.class).toBe("one-sided");
    expect(provenanceRefusal(p)).not.toBeNull();
  });
});

describe("provenance: both arms present with no record of this scenario", () => {
  it("is balanced over the known records, then unknown (CONFOUNDED, not refused): the 0/0 share is never computed", () => {
    const records = [
      poolRecord({ scenario: "elsewhere", variantHash: "sigA" }),
      poolRecord({ scenario: "elsewhere", variantHash: "sigB" }),
    ];
    const p = classifyProvenance(poolManifest(records, { dups: 0 }), records, [S], ARMS);
    expect(p.class).toBe("unknown");
    expect(p.perScenario[S]).toMatchObject({ n: { before: 0, after: 0 }, nUnknown: 2 });
    expect(provenanceRefusal(p)).toBeNull();
  });

  it("a recorded duplicate count keeps the --allow-confounded-pool hint on the worst-case refusal", () => {
    const records = recs([
      [55, { scenario: S, variantHash: "sigA" }],
      [45, { scenario: S, variantHash: "sigB" }],
    ]);
    const p = classifyProvenance(poolManifest(records, { dups: 20 }), records, [S], ARMS);
    expect(provenanceRefusal(p)).toMatch(/20 duplicate result\(s\).*--allow-confounded-pool/);
  });
});

describe("provenance: duplicate results bound the shares", () => {
  it("a pool built before the duplicate count was recorded cannot be bounded: a 50/50 split is refused, by name", () => {
    const p = classify(
      [
        [5, { scenario: S, variantHash: "sigA" }],
        [5, { scenario: S, variantHash: "sigB" }],
      ],
      {},
    );
    expect(p.sharesBounded).toBe(false);
    expect(p.class).toBe("one-sided");
    expect(provenanceRefusal(p)).toMatch(/built before the harness recorded duplicate results.*rebuild it.*re-export it/);
  });

  it("the same old pool at 99:1 is not read as balanced", () => {
    const p = classify(
      [
        [99, { scenario: S, variantHash: "sigA" }],
        [1, { scenario: S, variantHash: "sigB" }],
      ],
      {},
    );
    expect(p.class).toBe("one-sided");
  });

  it("a recorded duplicate count takes the worst case: 55/45 turns one-sided at 20 duplicates", () => {
    const spec: Array<[number, RecSpec]> = [
      [55, { scenario: S, variantHash: "sigA" }],
      [45, { scenario: S, variantHash: "sigB" }],
    ];
    expect(classify(spec, { dups: 0 }).class).toBe("balanced");
    // (55 + 10) / (100 + 10) = 0.59 → still balanced; 20 duplicates: 75/120 = 0.625 → one-sided
    expect(classify(spec, { dups: 10 }).class).toBe("balanced");
    expect(classify(spec, { dups: 20 }).class).toBe("one-sided");
  });
});

describe("the asymmetry marker", () => {
  const side = (served: number, miss: number, top?: number) =>
    sideMetrics([{ served, miss, ...(top !== undefined ? { meanTopScore: top } : {}) }]);

  it("fires above a 0.10 miss-rate gap and stays quiet at 0.09", () => {
    const fires = asymmetry({ label: "A", m: side(89, 11, 0.7) }, { label: "B", m: side(78, 22, 0.7) });
    expect(fires).toMatchObject({ judged: true, fires: true });
    const quiet = asymmetry({ label: "A", m: side(89, 11, 0.7) }, { label: "B", m: side(80, 20, 0.7) });
    expect(quiet).toMatchObject({ judged: true, fires: false });
  });

  it("fires on a mean top score ratio below 0.8", () => {
    const c = asymmetry({ label: "A", m: side(50, 0, 1.0) }, { label: "B", m: side(50, 0, 0.79) });
    expect(c).toMatchObject({ judged: true, fires: true });
  });

  it(`is not judged under ${ASYMMETRY_MIN_SEARCHES} searches on either side, and says so (never "no asymmetry")`, () => {
    const c = asymmetry({ label: "A", m: side(30, 0) }, { label: "B", m: side(4, 0) });
    expect(c).toEqual({ judged: false, reason: "B: 4 searches" });
    expect(asymmetryLine(c, side(30, 0), side(4, 0))).toBe("asymmetry: not judged (B: 4 searches)");
  });

  it("names the placeholder threshold in the CONFOUNDED line", () => {
    const a = side(90, 10);
    const b = side(70, 30);
    expect(asymmetryLine(asymmetry({ label: "A", m: a }, { label: "B", m: b }), a, b)).toMatch(/a placeholder threshold.*CONFOUNDED/);
  });

  it("weights each rep's mean top score by what it served", () => {
    const m = sideMetrics([
      { served: 1, miss: 0, meanTopScore: 1 },
      { served: 3, miss: 1, meanTopScore: 0.5 },
    ]);
    expect(m.meanTopScore).toBeCloseTo((1 + 1.5) / 4);
    expect(m.missRate).toBeCloseTo(1 / 5);
  });
});

// The scenario `metrics:` key: what the loader accepts and refuses, the published JSON Schema's mirror of the
// exactly-one-of rule, the single reserved-id predicate, and the cassette-version decision. Synthetic data only.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { SCHEMA_DIR } from "../scripts/gen-schema.js";
import { METRIC_UNAVAILABLE, Scenario, isMetricIdSafe, reservedMetricId } from "../src/types.js";
import { reservedMetricId as gradeKeysReserved } from "../src/hillclimb/grade-keys.js";
import { isPathSafeId } from "../src/hillclimb/schema-check.js";
import { KEY_REQUIRED_VERSION } from "../src/run/cassette.js";
import { scenarioArmsPreRunManifest } from "../src/run/execute.js";

const base = { prompt: "x", fidelity: "protocol" as const };
const metric = (over: Record<string, unknown> = {}) => ({
  id: "words",
  artifact: "outputs/m.json",
  path: "words",
  better: "higher",
  scale: 100,
  ...over,
});
const parse = (metrics: unknown) => Scenario.safeParse({ ...base, metrics });
const issues = (metrics: unknown): string => {
  const r = parse(metrics);
  return r.success ? "" : JSON.stringify(r.error.issues);
};

describe("metrics: what loads", () => {
  it("a bounded and an unbounded metric, with and without min", () => {
    const r = parse([metric(), metric({ id: "cost", better: "lower", scale: undefined, unbounded: true, min: 0 })]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metrics?.map((m) => m.id)).toEqual(["words", "cost"]);
  });
  it("absent stays absent (no default)", () => {
    const r = Scenario.safeParse(base);
    expect(r.success && r.data.metrics).toBe(undefined);
  });
});

describe("metrics: what is refused at load", () => {
  it("neither scale nor unbounded", () =>
    expect(issues([metric({ scale: undefined })])).toContain("exactly one of `scale` or `unbounded`"));
  it("both scale and unbounded", () => expect(issues([metric({ unbounded: true })])).toContain("exactly one of `scale` or `unbounded`"));
  it("unbounded: false", () => expect(parse([metric({ scale: undefined, unbounded: false })]).success).toBe(false));
  it("a non-positive scale", () => expect(parse([metric({ scale: 0 })]).success).toBe(false));
  it("better missing or invalid", () => {
    expect(parse([metric({ better: undefined })]).success).toBe(false);
    expect(parse([metric({ better: "up" })]).success).toBe(false);
  });
  it("an unknown field (strict)", () => expect(parse([metric({ bogus: 1 })]).success).toBe(false));
  it("reserved ids", () => {
    for (const id of ["pass", "claims", "a1", "a0_c2", "x_present", "foo_win", "both_bad"])
      expect(issues([metric({ id })]), id).toContain("collides with a key the hillclimb runner generates");
  });
  it("reserved ids in any letter case", () => {
    for (const id of ["Pass", "CLAIMS", "A1_x", "foo_PRESENT", "Both_Bad", "x_WIN"])
      expect(issues([metric({ id })]), id).toContain("collides with a key the hillclimb runner generates");
  });
  it("min not below scale, naming both", () => {
    const msg = issues([metric({ scale: 1, min: 5 })]);
    expect(msg).toContain("`min` (5) must be below `scale` (1)");
    expect(parse([metric({ scale: 1, min: 1 })]).success).toBe(false);
    expect(parse([metric({ scale: 1, min: -1 })]).success).toBe(true);
    expect(parse([metric({ scale: undefined, unbounded: true, min: 50 })]).success).toBe(true);
  });
  it("a backslash in the artifact path", () => {
    expect(parse([metric({ artifact: "outputs\\m.json" })]).success).toBe(false);
  });
  it("ids that are not path-safe", () => {
    for (const id of ["a/b", "..", "a b", "", "x".repeat(130), "wörds"]) expect(parse([metric({ id })]).success, id).toBe(false);
  });
  it("duplicate ids, compared case-insensitively", () => {
    expect(issues([metric(), metric()])).toContain("duplicate metric id");
    expect(issues([metric({ id: "Words" }), metric()])).toContain("duplicate metric id");
  });
  it("an artifact path that is absolute, climbs out, is blank or carries a NUL", () => {
    for (const artifact of ["/etc/x.json", "../x.json", "outputs/../../x.json", "  ", "outputs/a\0b"])
      expect(parse([metric({ artifact })]).success, JSON.stringify(artifact)).toBe(false);
  });
  it("an empty path", () => expect(parse([metric({ path: "" })]).success).toBe(false));
});

describe("the published JSON Schema mirrors exactly-one-of scale/unbounded", () => {
  const validate = new Ajv({ strict: true }).compile(JSON.parse(readFileSync(join(SCHEMA_DIR, "scenario.schema.json"), "utf8")));
  it("accepts one, rejects neither and both", () => {
    expect(validate({ ...base, metrics: [metric()] })).toBe(true);
    expect(validate({ ...base, metrics: [metric({ scale: undefined, unbounded: true })] })).toBe(true);
    expect(validate({ ...base, metrics: [metric({ scale: undefined })] })).toBe(false);
    expect(validate({ ...base, metrics: [metric({ unbounded: true })] })).toBe(false);
  });
});

describe("the published schema's id rules agree with the loader", () => {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "scenario.schema.json"), "utf8"));
  const validate = new Ajv({ strict: true }).compile(schema);
  it("reserved and all-dots ids: the JSON Schema refuses exactly what reservedMetricId / the dots rule refuse", () => {
    const corpus = [
      "pass",
      "Pass",
      "PASS",
      "claims",
      "Claims",
      "win",
      "both_bad",
      "a0",
      "A1",
      "a12_c3",
      "A1_x",
      "a1x",
      "ab1",
      "x_present",
      "foo_PRESENT",
      "present",
      "a0_win",
      "x_WIN",
      "winner",
      "twin",
      "both_bad_v2",
      "x_both_bad",
      "words",
      "cost_ratio",
      "alpha",
      "...",
      ".",
      "a.b",
    ];
    for (const id of corpus) {
      const loader = !reservedMetricId(id) && isMetricIdSafe(id);
      expect(validate({ ...base, metrics: [metric({ id })] }), id).toBe(loader);
    }
  });
  it("min below scale is loader-only and the schema description says so", () =>
    expect(JSON.stringify(schema.properties.metrics)).toContain("`min` below `scale`"));
});

describe("one definition of the reserved-id rule and the id rule", () => {
  it("grade-keys re-exports the core predicate", () => expect(gradeKeysReserved).toBe(reservedMetricId));
  it("exactly one `function reservedMetricId` in src", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("function reservedMetricId")) hits.push(p);
      }
    };
    walk("src");
    expect(hits).toEqual([join("src", "types.ts")]);
  });
  it("the id rule is hillclimb's path-safe rule minus all-dots", () => {
    for (const id of ["words", "a.b", "x-y_z", "...", ".", "a/b", "x".repeat(129), "x".repeat(130), "é", ""])
      expect(isMetricIdSafe(id), id).toBe(isPathSafeId(id) && !/^\.+$/.test(id));
  });
});

describe("the reason list", () => {
  it("is one tuple, in the agreed order", () =>
    expect([...METRIC_UNAVAILABLE]).toEqual([
      "missing_artifact",
      "missing_path",
      "not_json",
      "not_a_number",
      "readonly",
      "size",
      "remote",
      "pruned",
      "pre_run",
    ]));
});

describe("cassette version and the pre-run manifest", () => {
  it("metrics changes no verdict: version 0 for any value", () => {
    expect(KEY_REQUIRED_VERSION.metrics([metric()])).toBe(0);
    expect(KEY_REQUIRED_VERSION.metrics(undefined)).toBe(0);
  });
  it("declaring a metric arms the pre-run manifest; an empty list does not", () => {
    const s = (metrics?: unknown[]) => Scenario.parse({ ...base, ...(metrics ? { metrics } : {}) });
    expect(scenarioArmsPreRunManifest(s([metric()]))).toBe(true);
    expect(scenarioArmsPreRunManifest(s([]))).toBe(false);
    expect(scenarioArmsPreRunManifest(s())).toBe(false);
  });
});

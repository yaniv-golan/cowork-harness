// How the covered-surface diff reads a change to a schema a user WRITES (INPUT_SCHEMAS): a change that accepts
// every file the old schema did is a widening; one that can reject a file that used to load is a narrowing,
// reported as `changed` (a break). Output schemas keep "any change is a change". Only the leaf kinds the
// baseline snapshot declares are compared, so a kind the walker starts recording never reads as a break against a
// snapshot that did not record it.
import { describe, it, expect } from "vitest";
import { diffSurfaces } from "../scripts/check-surface.js";
import { computeSurface, LEAF_KINDS, PRE_491_KINDS } from "../scripts/lib/surface.js";

const IN = "scenario.schema.json";
const OUT = "run-result.json";
const surface = (file: string, leaves: Record<string, object>, leafKinds: readonly string[] = LEAF_KINDS) => ({
  leafKinds: [...leafKinds],
  schemas: { [file]: leaves },
});
const diff = (file: string, before: Record<string, object>, after: Record<string, object>) =>
  diffSurfaces(surface(file, before), surface(file, after));
const k = (file: string, rest: string) => `schemas.${file}.${rest}`;

describe("leafKinds: only the kinds the baseline recorded are compared", () => {
  it("a kind the baseline did not record never reads as a break", () => {
    const before = surface(IN, { ".a": { type: "string" } }, PRE_491_KINDS);
    const after = surface(IN, { ".a": { type: "string", minLength: 1, pattern: "^x" } });
    const d = diffSurfaces(before, after);
    expect(d.ok).toBe(true);
    expect(d.changed).toEqual([]);
    expect(d.added.filter((p) => p.startsWith("schemas.")).some((p) => p.includes("minLength") || p.includes("pattern"))).toBe(false);
  });
  it("a baseline with no leafKinds field is read as the pre-4.9.1 kinds, ref included", () => {
    const before = { schemas: { [OUT]: { ".a": { ref: "#/definitions/A" } } } };
    const d = diffSurfaces(before, { leafKinds: [...LEAF_KINDS], schemas: { [OUT]: { ".a": {} } } });
    expect(d.removed).toEqual([k(OUT, ".a.ref")]);
  });
  it("the snapshot declares every kind it records", () => {
    const s = computeSurface();
    const seen = new Set<string>();
    for (const file of Object.values(s.schemas))
      for (const leaf of Object.values(file)) for (const kind of Object.keys(leaf)) seen.add(kind);
    for (const kind of seen) expect(s.leafKinds, kind).toContain(kind);
  });
});

describe("closed (additionalProperties: false) on an input schema", () => {
  it("added on an existing object narrows it", () => {
    expect(diff(IN, { ".o": { type: "object" } }, { ".o": { type: "object", closed: true } }).changed).toEqual([k(IN, ".o.closed")]);
  });
  it("removed widens it", () => {
    const d = diff(IN, { ".o": { type: "object", closed: true } }, { ".o": { type: "object" } });
    expect(d.widened).toEqual([k(IN, ".o.closed")]);
    expect(d.ok).toBe(true);
  });
  it("on a new object it is just added", () => {
    expect(diff(IN, { ".a": { type: "string" } }, { ".a": { type: "string" }, ".o": { type: "object", closed: true } }).ok).toBe(true);
  });
  it("an output schema that drops it still breaks", () => {
    expect(diff(OUT, { ".o": { type: "object", closed: true } }, { ".o": { type: "object" } }).removed).toEqual([k(OUT, ".o.closed")]);
  });
});

describe("const and enum on an input schema", () => {
  it("a const removed widens; a const added on an existing property narrows", () => {
    expect(diff(IN, { ".a": { type: "string", const: "x" } }, { ".a": { type: "string" } }).widened).toEqual([k(IN, ".a.const")]);
    expect(diff(IN, { ".a": { type: "string" } }, { ".a": { type: "string", const: "x" } }).changed).toEqual([k(IN, ".a.const")]);
  });
  it("adding an enum value is an addition; removing one is a removal (pinned)", () => {
    expect(diff(IN, { ".a": { enum: ["x"] } }, { ".a": { enum: ["x", "y"] } }).ok).toBe(true);
    expect(diff(IN, { ".a": { enum: ["x", "y"] } }, { ".a": { enum: ["x"] } }).removed).toEqual([k(IN, ".a.enum[y]")]);
  });
  it("an enum introduced on an existing property narrows it; a const → enum swap fails", () => {
    expect(diff(IN, { ".a": { type: "string" } }, { ".a": { type: "string", enum: ["x"] } }).changed).toEqual([k(IN, ".a.enum[x]")]);
    const d = diff(IN, { ".a": { const: "x" } }, { ".a": { enum: ["y"] } });
    expect(d.ok).toBe(false);
    expect(d.changed).toEqual([k(IN, ".a.enum[y]")]);
  });
});

describe("type on an input schema", () => {
  it("a scalar type that becomes an array keeping it widens", () => {
    const d = diff(IN, { ".a": { type: "string" } }, { ".a": { type: ["string", "null"] } });
    expect(d.ok).toBe(true);
    expect(d.widened).toEqual([k(IN, ".a.type")]);
  });
  it("a one-element array and the same scalar are equivalent, both ways", () => {
    expect(diff(IN, { ".a": { type: ["string"] } }, { ".a": { type: "string" } }).ok).toBe(true);
    expect(diff(IN, { ".a": { type: "string" } }, { ".a": { type: ["string"] } }).ok).toBe(true);
  });
  it("a type that drops a value, or changes, still breaks", () => {
    expect(diff(IN, { ".a": { type: ["string", "null"] } }, { ".a": { type: "string" } }).ok).toBe(false);
    expect(diff(IN, { ".a": { type: "string" } }, { ".a": { type: "number" } }).ok).toBe(false);
  });
  it("an output schema's scalar → array is still a removal", () => {
    expect(diff(OUT, { ".a": { type: "string" } }, { ".a": { type: ["string", "null"] } }).ok).toBe(false);
  });
});

describe("constraints on an input schema", () => {
  it("added on an existing property narrows; removed widens", () => {
    expect(diff(IN, { ".a": { type: "string" } }, { ".a": { type: "string", minLength: 1 } }).changed).toEqual([k(IN, ".a.minLength")]);
    expect(diff(IN, { ".a": { type: "string", maxLength: 9 } }, { ".a": { type: "string" } }).widened).toEqual([k(IN, ".a.maxLength")]);
  });
  it("a min raised or a max lowered narrows; the reverse widens", () => {
    expect(diff(IN, { ".a": { minimum: 1 } }, { ".a": { minimum: 2 } }).changed).toEqual([k(IN, ".a.minimum")]);
    expect(diff(IN, { ".a": { minimum: 2 } }, { ".a": { minimum: 1 } }).widened).toEqual([k(IN, ".a.minimum")]);
    expect(diff(IN, { ".a": { maxItems: 5 } }, { ".a": { maxItems: 4 } }).changed).toEqual([k(IN, ".a.maxItems")]);
    expect(diff(IN, { ".a": { maxItems: 4 } }, { ".a": { maxItems: 5 } }).widened).toEqual([k(IN, ".a.maxItems")]);
  });
  it("any pattern change is a change", () => {
    expect(diff(IN, { ".a": { pattern: "^x" } }, { ".a": { pattern: "^x|y" } }).changed).toEqual([k(IN, ".a.pattern")]);
  });
  it("constraints are recorded for input schemas only", () => {
    const s = computeSurface();
    const kinds = (file: string) => new Set(Object.values(s.schemas[file]!).flatMap((l) => Object.keys(l)));
    expect(kinds("scenario.schema.json").has("pattern") || kinds("scenario.schema.json").has("minLength")).toBe(true);
    for (const kind of ["pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"])
      expect(kinds("run-result.json").has(kind), kind).toBe(false);
  });
});

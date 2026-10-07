import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CASSETTE_VERSION, V15_ASSERT_FEATURES, V14_ASSERT_FEATURES, requiredVersionFor, cassetteSchemaUrl } from "../src/run/cassette.js";

// v15 is the next shared interpretation bump, landed on its own before any key uses it. The stamp is
// requirement-based (requiredVersionFor), so raising CASSETTE_VERSION alone moves no cassette's stamp.

/** One sample assertion per V15_ASSERT_FEATURES predicate, in the same order. A key of this release that appends a
 *  predicate appends its sample here; the coverage test below fails until it does. */
const V15_SAMPLES: unknown[] = [];

describe("cassette v15", () => {
  it("this build writes and reads v15, and ships its schema", () => {
    expect(CASSETTE_VERSION).toBe(15);
    expect(cassetteSchemaUrl(15)).toMatch(/schema\/cassette\.v15\.json$/);
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schema", "cassette.v15.json"), "utf8"));
    expect(schema.$id).toBe(cassetteSchemaUrl(15));
    expect(schema.title).toBe("cowork-harness cassette v15");
    expect(existsSync(join(process.cwd(), "schema", "cassette.v14.json"))).toBe(true); // v14 stays as history
  });

  it("every V15 predicate has a sample that it alone lifts to 15", () => {
    expect(V15_SAMPLES).toHaveLength(V15_ASSERT_FEATURES.length);
    V15_ASSERT_FEATURES.forEach((f, i) => {
      const a = V15_SAMPLES[i];
      expect(f(a)).toBe(true);
      expect(V15_ASSERT_FEATURES.filter((g) => g(a))).toHaveLength(1);
      expect(V14_ASSERT_FEATURES.some((g) => g(a))).toBe(false);
      expect(requiredVersionFor({ prompt: "x", assert: [a] })).toBe(15);
    });
  });

  it("the stamp consults the V15 list: a predicate appended to it lifts a matching assertion to 15", () => {
    const list = V15_ASSERT_FEATURES as Array<(a: unknown) => boolean>;
    const probe = (a: unknown) => !!a && typeof a === "object" && "__v15_probe" in (a as object);
    list.push(probe);
    try {
      expect(requiredVersionFor({ prompt: "x", assert: [{ __v15_probe: true }] })).toBe(15);
      expect(requiredVersionFor({ prompt: "x", assert: [{ result: "success" }] })).toBe(12);
    } finally {
      list.splice(list.indexOf(probe), 1);
    }
  });

  it("the bump alone stamps nothing at 15: a plain scenario still stamps the epoch floor", () => {
    expect(requiredVersionFor({ prompt: "x" })).toBe(12);
    expect(requiredVersionFor({ prompt: "x", assert: [{ result: "success" }] })).toBe(12);
  });

  it("no committed cassette's required version moves (all stay below 15)", () => {
    const files = execFileSync("git", ["ls-files", "*.cassette.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const c = JSON.parse(readFileSync(f, "utf8")) as { scenario: unknown };
      expect({ f, v: requiredVersionFor(c.scenario) < 15 }).toEqual({ f, v: true });
    }
  });
});

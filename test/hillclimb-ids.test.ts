import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { findDuplicateCaseIds, pathSafeId } from "../src/hillclimb/ids.js";
import { isPathSafeId } from "../src/hillclimb/schema-check.js";

// Expected values transcribed from runner-scaffold.mjs's pathSafeId (bundle 2.1.285, l.329-339): an id that
// is already path-safe and ≤ 129 chars passes through; anything else is cleaned to [\w.-], cut to 120 chars,
// and suffixed with the first 8 hex of sha256(original).
const h8 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);

describe("pathSafeId (scaffold parity)", () => {
  it.each([
    ["case_01", "case_01"],
    ["a.b-c", "a.b-c"],
    ["x".repeat(129), "x".repeat(129)],
    ["", ""],
  ])("passes a path-safe id through: %s", (id, want) => {
    expect(pathSafeId(id)).toBe(want);
  });

  it("cleans and hash-suffixes an unsafe id, keeping twins distinct", () => {
    expect(pathSafeId("case/1")).toBe(`case_1-${h8("case/1")}`);
    expect(pathSafeId("case/1")).not.toBe(pathSafeId("case_1"));
  });

  it("truncates a long id to 120 chars plus the hash", () => {
    const long = "y".repeat(130);
    expect(pathSafeId(long)).toBe(`${"y".repeat(120)}-${h8(long)}`);
  });

  it("is idempotent and always yields an id the schema check accepts", () => {
    for (const id of ["case/1", "z".repeat(300), "ünïcode id", "ok", "../etc"]) {
      const once = pathSafeId(id);
      expect(pathSafeId(once)).toBe(once);
      expect(isPathSafeId(once)).toBe(true);
    }
  });
});

describe("findDuplicateCaseIds", () => {
  it("reports case-insensitive twins after sanitization (scaffold l.415-423)", () => {
    expect(findDuplicateCaseIds(["Case_A", "case_a", "b"])).toEqual([{ id: "case_a", collidesWith: "Case_A" }]);
  });

  it("returns nothing for distinct ids", () => {
    expect(findDuplicateCaseIds(["a", "b", "case/1", "case_1"])).toEqual([]);
  });
});

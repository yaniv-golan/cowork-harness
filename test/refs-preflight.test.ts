import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRefsBeforeSpend, pairwiseRefsRefusal, scenarioPairwiseSetup } from "../src/refs/preflight.js";
import { COMPOSER_ID } from "../src/assert.js";
import type { Scenario } from "../src/types.js";
import { composeKey, freezeRef } from "../src/refs/store.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "refs-pre-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("checkRefsBeforeSpend", () => {
  const K = composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
  const SRC = { command: "ref freeze", runDir: "~/r", resultSha256: "a".repeat(64) };
  it("passes when every (case, ref, key) resolves with integrity", () => {
    freezeRef(join(tmp, "refs"), "case_1", SRC, { [K]: "D" }, { harnessVersion: "t", composerId: "c1" });
    expect(checkRefsBeforeSpend([{ caseId: "case_1", assertIndex: 0, refName: "refs", store: join(tmp, "refs"), composeKey: K }])).toEqual(
      [],
    );
  });
  it("lists every miss with a remedy, before any spend", () => {
    freezeRef(join(tmp, "refs"), "case_1", SRC, { [K]: "D" }, { harnessVersion: "t", composerId: "c1" });
    const K2 = composeKey("c1", { includeSubagentText: true, includeForkResults: false, evidenceFiles: undefined });
    const problems = checkRefsBeforeSpend([
      { caseId: "case_2", assertIndex: 0, refName: "refs", store: join(tmp, "refs"), composeKey: K },
      { caseId: "case_1", assertIndex: 1, refName: "refs", store: join(tmp, "refs"), composeKey: K2 },
      { caseId: "case_1", assertIndex: 0, refName: "gone", store: join(tmp, "gone"), composeKey: K },
    ]);
    expect(problems.map((p) => [p.caseId, p.assertIndex, p.refName, p.status])).toEqual([
      ["case_2", 0, "refs", "missing"],
      ["case_1", 1, "refs", "missing"],
      ["case_1", 0, "gone", "missing"],
    ]);
    for (const p of problems) expect(p.message).toMatch(/ref freeze|freeze-ref/);
  });
});

describe("pairwiseRefsRefusal (the pre-spend gate)", () => {
  const K = composeKey(COMPOSER_ID, { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
  const SRC2 = { command: "ref freeze", runDir: "~/r", resultSha256: "a".repeat(64) };
  const sc = (refs: string[] | undefined, name = "case_1"): Scenario =>
    ({ name, assert: [{ semantic_pairwise: { rubric: ["x"], ...(refs ? { refs } : {}) } }] }) as unknown as Scenario;

  it("passes when every reference resolves", () => {
    freezeRef(join(tmp, "refs"), "case_1", SRC2, { [K]: "D" }, { harnessVersion: "t", composerId: COMPOSER_ID });
    const s = sc([join(tmp, "refs")]);
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toBeUndefined();
  });
  it("refuses an assert with no reference at all", () => {
    const s = sc(undefined);
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toMatch(/has no reference/);
  });
  it("refuses a store that sits inside a mounted source (the answer key), and one that CONTAINS a mount", () => {
    mkdirSync(join(tmp, "mount"));
    freezeRef(join(tmp, "mount", "refs"), "case_1", SRC2, { [K]: "D" }, { harnessVersion: "t", composerId: COMPOSER_ID });
    const s = sc([join(tmp, "mount", "refs")]);
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [join(tmp, "mount")])).toMatch(/could read the reference/);
    freezeRef(join(tmp, "outer"), "case_1", SRC2, { [K]: "D" }, { harnessVersion: "t", composerId: COMPOSER_ID });
    mkdirSync(join(tmp, "outer", "upload"));
    const s2 = sc([join(tmp, "outer")]);
    expect(pairwiseRefsRefusal(s2, scenarioPairwiseSetup(s2), [join(tmp, "outer", "upload")])).toMatch(/overlaps the mounted source/);
  });
  it("a neutral reference (this variant's own, about to be frozen) is exempt from the existence check", () => {
    const s = sc([join(tmp, "absent")]);
    const setup = { ...scenarioPairwiseSetup(s), neutralRefs: new Set(["absent"]) };
    expect(pairwiseRefsRefusal(s, setup, [])).toBeUndefined();
  });
  it("refuses an empty or all-dot case id", () => {
    const s = sc([join(tmp, "refs")], "..");
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toMatch(/all dots/);
  });
  it("a scenario without semantic_pairwise is untouched", () => {
    const s = { name: "x", assert: [{ result: "success" }] } as unknown as Scenario;
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toBeUndefined();
  });
});

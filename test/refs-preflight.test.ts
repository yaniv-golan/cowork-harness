import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRefsBeforeSpend, pairwiseRefsRefusal, scenarioPairwiseSetup } from "../src/refs/preflight.js";
import { COMPOSER_ID } from "../src/assert.js";
import type { Scenario } from "../src/types.js";
import { composeKey, freezeRef } from "../src/refs/store.js";
import { createHash } from "node:crypto";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
/** The task identity `pairwiseRefsRefusal` hashes for a scenario with no prompt. */
const NO_PROMPT = sha("");

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "refs-pre-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("checkRefsBeforeSpend", () => {
  const K = composeKey("c1", { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
  const SRC = { command: "ref freeze", runDir: "~/r", resultSha256: "a".repeat(64) };
  it("passes when every (case, ref, key) resolves with integrity", () => {
    freezeRef(
      join(tmp, "refs"),
      "case_1",
      SRC,
      { [K]: "D" },
      { harnessVersion: "t", composerId: "c1", scenario: "case_1", taskSha256: NO_PROMPT },
    );
    expect(
      checkRefsBeforeSpend([
        { caseId: "case_1", assertIndex: 0, refName: "refs", store: join(tmp, "refs"), composeKey: K, taskSha256: NO_PROMPT },
      ]),
    ).toEqual([]);
  });
  it("lists every miss with a remedy, before any spend", () => {
    freezeRef(
      join(tmp, "refs"),
      "case_1",
      SRC,
      { [K]: "D" },
      { harnessVersion: "t", composerId: "c1", scenario: "case_1", taskSha256: NO_PROMPT },
    );
    const K2 = composeKey("c1", { includeSubagentText: true, includeForkResults: false, evidenceFiles: undefined });
    const problems = checkRefsBeforeSpend([
      { caseId: "case_2", assertIndex: 0, refName: "refs", store: join(tmp, "refs"), composeKey: K, taskSha256: NO_PROMPT },
      { caseId: "case_1", assertIndex: 1, refName: "refs", store: join(tmp, "refs"), composeKey: K2, taskSha256: NO_PROMPT },
      { caseId: "case_1", assertIndex: 0, refName: "gone", store: join(tmp, "gone"), composeKey: K, taskSha256: NO_PROMPT },
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
    freezeRef(
      join(tmp, "refs"),
      "case_1",
      SRC2,
      { [K]: "D" },
      { harnessVersion: "t", composerId: COMPOSER_ID, scenario: "case_1", taskSha256: NO_PROMPT },
    );
    const s = sc([join(tmp, "refs")]);
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toBeUndefined();
  });
  it("refuses an assert with no reference at all", () => {
    const s = sc(undefined);
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toMatch(/has no reference/);
  });
  it("refuses a store that sits inside a mounted source (the answer key), and one that CONTAINS a mount", () => {
    mkdirSync(join(tmp, "mount"));
    freezeRef(
      join(tmp, "mount", "refs"),
      "case_1",
      SRC2,
      { [K]: "D" },
      { harnessVersion: "t", composerId: COMPOSER_ID, scenario: "case_1", taskSha256: NO_PROMPT },
    );
    const s = sc([join(tmp, "mount", "refs")]);
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [join(tmp, "mount")])).toMatch(/could read the reference/);
    freezeRef(
      join(tmp, "outer"),
      "case_1",
      SRC2,
      { [K]: "D" },
      { harnessVersion: "t", composerId: COMPOSER_ID, scenario: "case_1", taskSha256: NO_PROMPT },
    );
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

describe("pairwiseRefsRefusal — task identity", () => {
  it("refuses a reference frozen for a different prompt", () => {
    const K = composeKey(COMPOSER_ID, { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
    freezeRef(
      join(tmp, "refs"),
      "case_1",
      { command: "x", runDir: "~/r", resultSha256: "a".repeat(64) },
      { [K]: "D" },
      { harnessVersion: "t", composerId: COMPOSER_ID, scenario: "case_1", taskSha256: "0".repeat(64) },
    );
    const s = {
      name: "case_1",
      prompt: "the current prompt",
      assert: [{ semantic_pairwise: { refs: [join(tmp, "refs")] } }],
    } as unknown as Scenario;
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toMatch(/frozen for a different task/);
  });
});

describe("pairwiseRefsRefusal — an entry without a task identity", () => {
  it("refuses before spend as a damaged reference (integrity), never as 'any task'", () => {
    const K = composeKey(COMPOSER_ID, { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
    const store = join(tmp, "refs");
    freezeRef(
      store,
      "case_1",
      { command: "x", runDir: "~/r", resultSha256: "a".repeat(64) },
      { [K]: "D" },
      {
        harnessVersion: "t",
        composerId: COMPOSER_ID,
        scenario: "case_1",
        taskSha256: sha("the prompt"),
      },
    );
    const ref = join(store, "case_1", "ref.json");
    const m = JSON.parse(readFileSync(ref, "utf8")) as Record<string, unknown>;
    delete m.taskSha256;
    writeFileSync(ref, JSON.stringify(m, null, 2) + "\n");
    const s = { name: "case_1", prompt: "the prompt", assert: [{ semantic_pairwise: { refs: [store] } }] } as unknown as Scenario;
    expect(pairwiseRefsRefusal(s, scenarioPairwiseSetup(s), [])).toMatch(/frozen without a task identity[\s\S]*never repaired in place/);
  });
});

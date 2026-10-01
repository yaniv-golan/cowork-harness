import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRefsBeforeSpend } from "../src/refs/preflight.js";
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

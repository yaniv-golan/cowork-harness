// The walked-roots rule of `authored: true` (and of a metric's pre_run decision) is decided on the file's canonical
// on-disk name, folded the way every other authorship lookup folds: on a case-insensitive filesystem
// `OUTPUTS/new.json` IS `outputs/new.json`, a new file under a walked root, and must not read as outside the walk.
// Synthetic data only.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { extractMetrics } from "../src/metrics.js";
import type { Assertion } from "../src/types.js";

function caseInsensitiveFs(): boolean {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "fold-probe-")));
  writeFileSync(join(d, "a"), "");
  return existsSync(join(d, "A"));
}

const ctx = (mnt: string): AssertContext => ({
  transcript: "",
  toolsCalled: new Set(),
  subagentTools: new Set(),
  egress: [],
  result: "success",
  workRoot: mnt,
  userVisiblePrefixes: ["outputs"],
  preRunHashes: {},
  preRunPaths: [],
  outputsDeletes: [],
  mountDeletes: [],
  questions: [],
  hostPathLeaked: false,
  selfHealRan: false,
  subagents: [],
  gateDeliveries: [],
  toolResultTexts: [],
  skillsInvoked: [],
  skillToolAvailable: true,
  slashInvokedSkills: [],
});

describe.runIf(caseInsensitiveFs())("walked roots are matched on the canonical, folded name", () => {
  it("OUTPUTS/new.json is a new file under outputs/: authored passes and the metric is measured", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-"))), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    writeFileSync(join(mnt, "outputs", "new.json"), '{"n":4}');
    const [r] = evaluate([{ file_exists: { path: "OUTPUTS/new.json", authored: true } } as Assertion], ctx(mnt));
    expect(r.message).toBeUndefined();
    expect(r.pass).toBe(true);
    expect(extractMetrics(ctx(mnt), [{ id: "n", artifact: "OUTPUTS/new.json", path: "n", better: "higher", scale: 9 }])).toEqual([
      { id: "n", value: 4 },
    ]);
  });
});

describe("the walked-roots rule still refuses what was never walked, whatever the spelling", () => {
  it("a sibling that only starts with a root's name is outside it", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-"))), "mnt");
    mkdirSync(join(mnt, "outputsX"), { recursive: true });
    writeFileSync(join(mnt, "outputsX", "a.json"), '{"n":1}');
    const [r] = evaluate([{ file_exists: { path: "outputsX/a.json", authored: true } } as Assertion], ctx(mnt));
    expect(r.message).toMatch(/outside the folders the pre-run manifest covers/);
  });
});

// The walked-roots rule of `authored: true` (and of a metric's pre_run decision) is decided on the file's canonical
// on-disk name (realpath.native), compared EXACTLY — NFC-normalized, never case-folded. On a case-insensitive
// filesystem `OUTPUTS/new.json` IS `outputs/new.json` (its canonical name is the on-disk one), so it is under a walked
// root. On a case-sensitive one `Outputs/` is a different directory the pre-run walk never covered: a file there is
// absent from the manifest because nobody looked, so it must never read as new. Absence is the evidence here, so
// folding would err toward a pass.
// Synthetic data only.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { evaluate, type AssertContext } from "../src/assert.js";
import { extractMetrics } from "../src/metrics.js";
import type { Assertion } from "../src/types.js";

const sha = (x: string) => createHash("sha256").update(x).digest("hex");

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

describe.runIf(!caseInsensitiveFs())("on a case-sensitive filesystem, Outputs/ is not outputs/", () => {
  it("a pre-run file in Outputs/ is outside the walk: authored is evidence-unavailable, the metric pre_run", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-cs-"))), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    mkdirSync(join(mnt, "Outputs"), { recursive: true });
    writeFileSync(join(mnt, "Outputs", "pre.json"), '{"n":7}');
    const [r] = evaluate([{ file_exists: { path: "Outputs/pre.json", authored: true } } as Assertion], ctx(mnt));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable: .* outside the folders the pre-run manifest covers/);
    expect(extractMetrics(ctx(mnt), [{ id: "n", artifact: "Outputs/pre.json", path: "n", better: "higher", scale: 9 }])).toEqual([
      { id: "n", unavailable: "pre_run" },
    ]);
  });
  it("the recorded post-run hash of outputs/m.json is not OUTPUTS/m.json's, even with identical bytes: pruned", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-cs-"))), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    mkdirSync(join(mnt, "OUTPUTS"), { recursive: true });
    writeFileSync(join(mnt, "outputs", "m.json"), '{"n":7}');
    writeFileSync(join(mnt, "OUTPUTS", "m.json"), '{"n":7}');
    const c = { ...ctx(mnt), userVisiblePrefixes: ["outputs", "OUTPUTS"], recordedPostRunHashes: { "outputs/m.json": sha('{"n":7}') } };
    expect(extractMetrics(c, [{ id: "n", artifact: "OUTPUTS/m.json", path: "n", better: "higher", scale: 9 }])).toEqual([
      { id: "n", unavailable: "pruned" },
    ]);
  });
});

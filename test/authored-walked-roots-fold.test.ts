// The walked-roots rule of `authored: true` (and of a metric's pre_run decision) is decided on the file's canonical
// on-disk name (realpath.native), compared EXACTLY — NFC-normalized, never case-folded. On a case-insensitive
// filesystem `OUTPUTS/new.json` IS `outputs/new.json` (its canonical name is the on-disk one), so it is under a walked
// root. On a case-sensitive one `Outputs/` is a different directory the pre-run walk never covered: a file there is
// absent from the manifest because nobody looked, so it must never read as new. Absence is the evidence here, so
// folding would err toward a pass.
// Synthetic data only.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

describe.runIf(caseInsensitiveFs())("the replay link set is checked on the canonical name", () => {
  it("OUTPUTS/lnk.json, recorded as the link outputs/lnk.json, gets the link message", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-lnk-"))), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    writeFileSync(join(mnt, "outputs", "lnk.json"), ""); // replay's placeholder for a recorded link
    const c = { ...ctx(mnt), linkPaths: new Set(["outputs/lnk.json"]), postRunHashes: {} };
    const [r] = evaluate([{ file_exists: { path: "OUTPUTS/lnk.json", authored: true } } as Assertion], c);
    expect(r.message).toMatch(/it is a symlink — a link is never authored evidence/);
  });
});

describe("the walked-roots rule still refuses what was never walked, whatever the spelling", () => {
  it("the walked-roots rule runs before any manifest lookup: a path outside the declared roots is refused even with a manifest entry", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-order-"))), "mnt");
    mkdirSync(join(mnt, "other"), { recursive: true });
    writeFileSync(join(mnt, "other", "x.json"), '{"n":2}');
    const c = { ...ctx(mnt), preRunHashes: { "other/x.json": sha('{"n":1}') }, preRunPaths: ["other/x.json"] };
    const [r] = evaluate([{ file_exists: { path: "other/x.json", authored: true } } as Assertion], c);
    expect(r.message).toMatch(/outside the folders the pre-run manifest covers/);
  });
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
  // The manifest holds outputs/x.json; an unwalked pre-run Outputs/x.json with DIFFERENT bytes must not be matched
  // onto it (that would read as "rewritten"), live or on replay.
  function twin(): { mnt: string; pre: Record<string, string | null> } {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-twin-"))), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    mkdirSync(join(mnt, "Outputs"), { recursive: true });
    writeFileSync(join(mnt, "outputs", "x.json"), '{"n":1}');
    writeFileSync(join(mnt, "Outputs", "x.json"), '{"n":7}');
    return { mnt, pre: { "outputs/x.json": sha('{"n":1}') } };
  }
  const decl = (artifact: string) => [{ id: "n", artifact, path: "n", better: "higher" as const, scale: 9 }];
  it("a case-twin of a manifest file outside the walk is not 'rewritten' (live)", () => {
    const { mnt, pre } = twin();
    const c = { ...ctx(mnt), preRunHashes: pre, preRunPaths: Object.keys(pre) };
    const [r] = evaluate([{ file_exists: { path: "Outputs/x.json", authored: true } } as Assertion], c);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/outside the folders the pre-run manifest covers/);
    expect(extractMetrics(c, decl("Outputs/x.json"))).toEqual([{ id: "n", unavailable: "pre_run" }]);
  });
  it("a case-twin of a manifest file outside the walk is not 'rewritten' (replay hashes)", () => {
    const { mnt, pre } = twin();
    const c = {
      ...ctx(mnt),
      preRunHashes: pre,
      preRunPaths: Object.keys(pre),
      postRunHashes: { "outputs/x.json": sha('{"n":2}'), "Outputs/x.json": sha('{"n":7}') },
    };
    const [r] = evaluate([{ file_exists: { path: "Outputs/x.json", authored: true } } as Assertion], c);
    expect(r.pass).toBe(false);
    expect(extractMetrics(c, decl("Outputs/x.json"))).toEqual([{ id: "n", unavailable: "pre_run" }]);
  });
  it("an NFD twin of an NFC connected folder is a different, unwalked directory", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-nfd-"))), "mnt");
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    mkdirSync(join(mnt, nfc), { recursive: true });
    mkdirSync(join(mnt, nfd), { recursive: true });
    writeFileSync(join(mnt, nfd, "x.json"), '{"n":3}');
    const c = { ...ctx(mnt), userVisiblePrefixes: ["outputs", nfc] };
    const [r] = evaluate([{ file_exists: { path: `${nfd}/x.json`, authored: true } } as Assertion], c);
    expect(r.message).toMatch(/outside the folders the pre-run manifest covers/);
    expect(extractMetrics(c, decl(`${nfd}/x.json`))).toEqual([{ id: "n", unavailable: "pre_run" }]);
  });
  it("Outputs -> outputs (a symlink) is a symlinked directory, never authored evidence", () => {
    const mnt = join(realpathSync(mkdtempSync(join(tmpdir(), "fold-link-"))), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    writeFileSync(join(mnt, "outputs", "new.json"), '{"n":4}');
    symlinkSync("outputs", join(mnt, "Outputs"));
    const [r] = evaluate([{ file_exists: { path: "Outputs/new.json", authored: true } } as Assertion], ctx(mnt));
    expect(r.message).toMatch(/reached through a symlinked directory/);
    expect(extractMetrics(ctx(mnt), decl("Outputs/new.json"))).toEqual([{ id: "n", unavailable: "pre_run" }]);
  });
});

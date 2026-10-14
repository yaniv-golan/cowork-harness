// The private pool copy eval and hillclimb serve from, and the per-rep pin check before anything runs. $0, synthetic.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoFollowRoot } from "../src/hillclimb/fs.js";
import { copyPinnedPool, poolCopyHooks } from "../src/search-corpus/pool-copy.js";
import { effectivePool, readPool, SearchPoolPinError } from "../src/search-corpus/pool.js";
import { startRunSearchCorpus } from "../src/search-corpus/run.js";
import { loadBaseline } from "../src/baseline.js";
import { poolRecord, writeFixturePool } from "./search-corpus-fixture-pool.js";

let root: string;
let src: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sc-copy-")));
  src = join(root, "source-pool");
  writeFixturePool(src, [poolRecord({ scenario: "s", variantHash: "x" }), poolRecord({ scenario: "s", variantHash: "x" })], { dups: 0 });
});
afterEach(() => {
  delete poolCopyHooks.beforeRename;
  rmSync(root, { recursive: true, force: true });
});

describe("copyPinnedPool", () => {
  it("writes a verified copy whose effective hash is the source's", () => {
    const r = NoFollowRoot.open(join(root, "snap"));
    const dest = join(root, "snap", "flow", "search-pools", "id");
    const c = copyPinnedPool(r, src, dest, undefined);
    expect(c).toMatchObject({ dir: dest, created: true, sha256: effectivePool(src, undefined).sha256 });
    expect(readPool(dest).manifest.sha256).toBe(readPool(src).manifest.sha256);
    expect(readdirSync(join(root, "snap", "flow", "search-pools"))).toEqual(["id"]); // no temp left behind
  });

  it("reuses an existing copy after verifying it, and never rewrites it", () => {
    const r = NoFollowRoot.open(join(root, "snap"));
    const dest = join(root, "snap", "p");
    copyPinnedPool(r, src, dest, undefined);
    const before = readFileSync(join(dest, "pool.json"), "utf8");
    const again = copyPinnedPool(r, src, dest, undefined);
    expect(again.created).toBe(false);
    expect(readFileSync(join(dest, "pool.json"), "utf8")).toBe(before);
  });

  it("refuses an existing copy that was edited, naming the dir", () => {
    const r = NoFollowRoot.open(join(root, "snap"));
    const dest = join(root, "snap", "p");
    copyPinnedPool(r, src, dest, undefined);
    writeFileSync(join(dest, "records.jsonl"), readFileSync(join(dest, "records.jsonl"), "utf8").replace("invented", "edited"));
    expect(() => copyPinnedPool(r, src, dest, undefined)).toThrow(/existing search pool copy at .*cannot be used.*delete it/);
  });

  it("two passes racing: the loser of the rename gets 'exists' and reuses the winner's copy", () => {
    const r = NoFollowRoot.open(join(root, "snap"));
    const dest = join(root, "snap", "p");
    let raced = false;
    poolCopyHooks.beforeRename = () => {
      if (raced) return;
      raced = true;
      // The other pass completes its copy inside this pass's check→rename window.
      copyPinnedPool(r, src, dest, undefined);
    };
    const c = copyPinnedPool(r, src, dest, undefined);
    expect(raced).toBe(true);
    expect(c.created).toBe(false);
    expect(readdirSync(join(root, "snap")).filter((e) => e.includes(".tmp-"))).toEqual([]);
  });

  it("refuses a planted symlink on the copy's path instead of following it", () => {
    const r = NoFollowRoot.open(join(root, "snap"));
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "snap", "search-pools"));
    expect(() => copyPinnedPool(r, src, join(root, "snap", "search-pools", "id"), undefined)).toThrow(/symlink/);
    expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
  });
});

describe("the per-rep pin check, before anything is written or started", () => {
  const baseline = loadBaseline("latest");
  const outDir = () => {
    const d = join(root, "run");
    mkdirSync(d, { recursive: true });
    return d;
  };

  it("a copy that is not the pinned pool refuses with SearchPoolPinError and writes nothing", async () => {
    const d = outDir();
    const err = await startRunSearchCorpus({
      option: { pool: src, miss: "empty", expect: { sha256: "f".repeat(64), miss: "empty" } },
      baseline,
      outDir: d,
      agentEnv: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchPoolPinError);
    expect((err as SearchPoolPinError).got).toEqual({ sha256: effectivePool(src, undefined).sha256, miss: "empty" });
    expect(existsSync(join(d, "search-corpus.jsonl"))).toBe(false);
  });

  it("another miss mode than the pinned one is the same refusal", async () => {
    const err = await startRunSearchCorpus({
      option: { pool: src, miss: "error", expect: { sha256: effectivePool(src, undefined).sha256, miss: "empty" } },
      baseline,
      outDir: outDir(),
      agentEnv: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchPoolPinError);
  });

  it("a copy that cannot be read is a pin refusal with nothing observed", async () => {
    const err = await startRunSearchCorpus({
      option: { pool: join(root, "gone"), miss: "empty", expect: { sha256: "a".repeat(64), miss: "empty" } },
      baseline,
      outDir: outDir(),
      agentEnv: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchPoolPinError);
    expect((err as SearchPoolPinError).got).toBeNull();
  });
});

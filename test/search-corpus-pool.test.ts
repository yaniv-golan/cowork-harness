import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemblePool,
  discoverRunDirs,
  exportPool,
  importPool,
  insideGitWorkTree,
  poolHash,
  readPool,
  resolvePoolDir,
  writePool,
  PoolBuildError,
  POOLS_DIR,
} from "../src/search-corpus/pool.js";
import { DEFAULT_RETRIEVAL } from "../src/search-corpus/retrieval.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";

// Synthetic kept runs; all web text invented.
const REM = "REMINDER: cite the sources above.";
let n = 0;
function run(root: string, o: { skill: string; searches: [string, string, string][]; upload?: [string, string] }): string {
  const d = join(root, `scn-${o.skill}`, `local_${n++}`);
  mkdirSync(join(d, "turns", "1"), { recursive: true });
  const lines = o.searches.flatMap(([q, url, text], i) => [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: `t${i}`, name: "WebSearch", input: { query: q } }] },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `t${i}`,
            content: renderWebSearchResult({
              query: q,
              entries: [
                { kind: "links", links: [{ title: q, url }] },
                { kind: "text", text },
              ],
              reminder: REM,
            }),
          },
        ],
      },
    }),
  ]);
  writeFileSync(join(d, "events.jsonl"), lines.join("\n"));
  writeFileSync(
    join(d, "turns", "1", "result.json"),
    JSON.stringify({ scenario: "s", fingerprint: { contentSig: `sig-${o.skill}`, skillSources: [`../${o.skill}`] } }),
  );
  if (o.upload) {
    mkdirSync(join(d, "work", "uploads"), { recursive: true });
    writeFileSync(join(d, "work", "uploads", o.upload[0]), o.upload[1]);
  }
  return d;
}
const base = {
  poolId: "p",
  mixed: false,
  exclude: new Set<string>(),
  retrieval: DEFAULT_RETRIEVAL,
  harnessVersion: "0.0.0",
  now: new Date(0),
  secrets: [] as string[],
};

describe("assemblePool", () => {
  it("builds one skill's pool, merging duplicate searches and keeping every contributing run as a source", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const a = run(root, { skill: "ms", searches: [["ev market", "https://a/1", "Big."]] });
    const b = run(root, { skill: "ms", searches: [["ev market", "https://a/1", "Big."]] });
    const { manifest, records, summary } = assemblePool({ ...base, runDirs: [a, b] });
    expect(records).toHaveLength(1);
    expect(summary.crossRunDuplicates).toBe(1);
    expect(manifest.sources).toHaveLength(2);
    expect(manifest).toMatchObject({ skills: ["ms"], mixed: false, counts: { records: 1, urls: 1, runs: 2 } });
    expect(manifest.sha256).toBe(poolHash(records, DEFAULT_RETRIEVAL));
  });

  it("refuses searches from two skills unless --mixed", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const dirs = [
      run(root, { skill: "ms", searches: [["q1", "https://a", "x"]] }),
      run(root, { skill: "cp", searches: [["q2", "https://b", "y"]] }),
    ];
    expect(() => assemblePool({ ...base, runDirs: dirs })).toThrow(/2 skills \(cp, ms\)/);
    expect(assemblePool({ ...base, runDirs: dirs, mixed: true }).manifest).toMatchObject({ mixed: true, skills: ["cp", "ms"] });
  });

  it("refuses, writing nothing, when a known secret appears in a record, and names the record", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const d = run(root, { skill: "ms", searches: [["q", "https://a", "token sk-ant-SECRETVALUE123 leaked"]] });
    expect(() => assemblePool({ ...base, runDirs: [d], secrets: ["sk-ant-SECRETVALUE123"] })).toThrow(PoolBuildError);
    expect(() => assemblePool({ ...base, runDirs: [d], secrets: ["sk-ant-SECRETVALUE123"] })).toThrow(/--exclude/);
  });

  it("drops an excluded record, and refuses an --exclude that names nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const d = run(root, {
      skill: "ms",
      searches: [
        ["q1", "https://a", "x"],
        ["q2", "https://b", "y"],
      ],
    });
    const all = assemblePool({ ...base, runDirs: [d] }).records;
    const one = assemblePool({ ...base, runDirs: [d], exclude: new Set([all[0]!.id]) });
    expect(one.records.map((r) => r.id)).toEqual([all[1]!.id]);
    expect(() => assemblePool({ ...base, runDirs: [d], exclude: new Set(["nope"]) })).toThrow(/names no record/);
  });

  it("lists records that name an upload or repeat its text", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const d = run(root, {
      skill: "ms",
      searches: [
        ["acme-financials.xlsx revenue", "https://a", "x"],
        ["q2", "https://b", "the quarterly revenue of acme grew by twelve percent last year"],
        ["clean", "https://c", "nothing"],
      ],
      upload: ["acme-financials.xlsx", "The quarterly revenue of Acme grew by twelve percent last year, it says."],
    });
    const { summary, records } = assemblePool({ ...base, runDirs: [d] });
    const why = Object.fromEntries(summary.uploadOverlaps.map((u) => [records.find((r) => r.id === u.id)!.query, u.why]));
    expect(why).toEqual({ "acme-financials.xlsx revenue": "upload-filename", q2: "upload-text" });
  });

  it("refuses runs with no searches", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    expect(() => assemblePool({ ...base, runDirs: [run(root, { skill: "ms", searches: [] })] })).toThrow(/no searches/);
  });

  it("the hash covers the retrieval parameters", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const d = run(root, { skill: "ms", searches: [["q", "https://a", "x"]] });
    const a = assemblePool({ ...base, runDirs: [d] }).manifest.sha256;
    const b = assemblePool({ ...base, runDirs: [d], retrieval: { ...DEFAULT_RETRIEVAL, minScore: 0.5 } }).manifest.sha256;
    expect(a).not.toBe(b);
  });
});

describe("pool files", () => {
  const built = () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    return assemblePool({ ...base, runDirs: [run(root, { skill: "ms", searches: [["q", "https://a", "x"]] })] });
  };
  it("writes a 0700 dir with 0600 files, reads back, and refuses a non-empty target", () => {
    const { manifest, records } = built();
    const dir = join(mkdtempSync(join(tmpdir(), "cwh-pool-out-")), "pool");
    writePool(dir, manifest, records);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "records.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "pool.json")).mode & 0o777).toBe(0o600);
    expect(readPool(dir).records).toEqual(records);
    expect(() => writePool(dir, manifest, records)).toThrow(/not empty/);
  });
  it("readPool refuses an edited record or manifest", () => {
    const { manifest, records } = built();
    const dir = join(mkdtempSync(join(tmpdir(), "cwh-pool-out-")), "pool");
    writePool(dir, manifest, records);
    const p = join(dir, "records.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").replace('"x"', '"y"'));
    expect(() => readPool(dir)).toThrow(/does not hash to its id/);
  });
  it("export and import round-trip and re-verify the hash", () => {
    const { manifest, records } = built();
    const dir = join(mkdtempSync(join(tmpdir(), "cwh-pool-out-")), "pool");
    writePool(dir, manifest, records);
    const file = join(mkdtempSync(join(tmpdir(), "cwh-pool-x-")), "p.json");
    exportPool(dir, file);
    expect(JSON.parse(readFileSync(file, "utf8")).notice).toMatch(/private evaluation/);
    const back = join(mkdtempSync(join(tmpdir(), "cwh-pool-in-")), "pool");
    expect(importPool(file, back).sha256).toBe(manifest.sha256);
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.manifest.retrieval.minScore = 0.1;
    writeFileSync(file, JSON.stringify(tampered));
    expect(() => importPool(file, join(mkdtempSync(join(tmpdir(), "cwh-pool-in-")), "p2"))).toThrow(/hash does not match/);
  });
});

describe("helpers", () => {
  it("resolvePoolDir: a bare name lives under the pools dir, a path is a path", () => {
    expect(resolvePoolDir("my-pool")).toBe(join(POOLS_DIR, "my-pool"));
    expect(resolvePoolDir("./x/y")).toMatch(/x\/y$/);
  });
  it("discoverRunDirs finds run dirs under a root but never inside a run's work dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const d = run(root, { skill: "ms", searches: [["q", "https://a", "x"]] });
    mkdirSync(join(d, "work", "nested", "local_x"), { recursive: true });
    writeFileSync(join(d, "work", "nested", "local_x", "events.jsonl"), "");
    expect(discoverRunDirs([root])).toEqual([d]);
    expect(discoverRunDirs([d])).toEqual([d]);
  });
  it("insideGitWorkTree is true in this repo and false in a temp dir", () => {
    expect(insideGitWorkTree(process.cwd())).toBe(true);
    expect(insideGitWorkTree(mkdtempSync(join(tmpdir(), "cwh-nogit-")))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, globSync, mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
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
import { harvestRun, recordId, runRefOf } from "../src/search-corpus/harvest.js";

// Synthetic kept runs; all web text invented.
const REM = "REMINDER: cite the sources above.";
let n = 0;
function run(root: string, o: { skill: string; searches: [string, string, string][]; upload?: [string, string]; dir?: string }): string {
  const d = o.dir ?? join(root, `scn-${o.skill}`, `local_${n++}`);
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
    JSON.stringify({
      scenario: "s",
      fingerprint: { contentSig: `sig-${o.skill}`, skillSources: ["../plugin"] },
      ...(o.skill === "none" ? {} : { skillsInvoked: [`plug:${o.skill}`] }),
    }),
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

/** A multi-leg scenario root `<root>/scn-<skill>/<rootId>/` with one prompt leg `legs/<legId>/` (a complete run dir with
 *  its `leg.json` marker) and one host-action leg (a marker and no events). */
function legRoot(root: string, skill: string, rootId: string, legId: string, searches: [string, string, string][]): string {
  const scenarioRoot = join(root, `scn-${skill}`, rootId);
  const leg = join(scenarioRoot, "legs", legId);
  run(root, { skill, searches, dir: leg });
  writeFileSync(
    join(leg, "leg.json"),
    JSON.stringify({ scenarioRoot: "../..", id: legId, index: 0, kind: "prompt", workdir: "persistent" }),
  );
  const action = join(scenarioRoot, "legs", "apply");
  mkdirSync(action, { recursive: true });
  writeFileSync(
    join(action, "leg.json"),
    JSON.stringify({ scenarioRoot: "../..", id: "apply", index: 1, kind: "action", workdir: "persistent" }),
  );
  return leg;
}

describe("multi-leg runs in a pool", () => {
  it("discoverRunDirs finds a prompt leg from a runs root, a scenario dir and the scenario root, never an action leg", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-legs-"));
    const leg = legRoot(root, "ms", "local_root1", "ask", [["q", "https://a", "x"]]);
    const plain = run(root, { skill: "ms", searches: [["q2", "https://b", "y"]] });
    expect(discoverRunDirs([root])).toEqual([leg, plain].sort());
    expect(discoverRunDirs([join(root, "scn-ms")])).toEqual([leg, plain].sort());
    expect(discoverRunDirs([join(root, "scn-ms", "local_root1")])).toEqual([leg]);
  });
  it("two runs' legs of the same id are two sources, so a two-skill pool is mixed", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-legs-"));
    const a = legRoot(root, "alpha", "local_r1", "ask", [["qa", "https://a", "x"]]);
    const b = legRoot(root, "beta", "local_r2", "ask", [["qb", "https://b", "y"]]);
    expect(() => assemblePool({ ...base, runDirs: [a, b] })).toThrow(/mixed|more than one skill|alpha.*beta|beta.*alpha/i);
    const { manifest } = assemblePool({ ...base, runDirs: [a, b], mixed: true });
    expect(manifest.sources.map((s) => s.skill).sort()).toEqual(["alpha", "beta"]);
  });
  it("an ordinary run's runRef is unchanged: the hash of <scenario>/<run id>", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-legs-"));
    const d = run(root, { skill: "ms", searches: [["q", "https://a", "x"]] });
    const { manifest } = assemblePool({ ...base, runDirs: [d] });
    const expected = createHash("sha256")
      .update(`${basename(dirname(d))}/${basename(d)}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(manifest.sources.map((s) => s.runRef)).toEqual([expected]);
  });
  it("a leg's runRef names its scenario root, so it differs across runs, and is never a host path", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-legs-"));
    const a = legRoot(root, "ms", "local_r1", "ask", [["qa", "https://a", "x"]]);
    const b = legRoot(root, "ms", "local_r2", "ask", [["qb", "https://b", "y"]]);
    const { manifest } = assemblePool({ ...base, runDirs: [a, b] });
    const h = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
    expect(manifest.sources.map((s) => s.runRef).sort()).toEqual([h("scn-ms/local_r1/legs/ask"), h("scn-ms/local_r2/legs/ask")].sort());
  });
  it("a persistent leg's sub-agent searches are harvested from the scenario root's config dir, per leg", () => {
    // workdir: persistent shares one claude-config at the scenario root; each leg's sub-agent transcripts sit under
    // its own agent session id there.
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-legs-"));
    const leg = legRoot(root, "ms", "local_r1", "ask", [["main q", "https://a", "x"]]);
    const other = legRoot(root, "ms", "local_r1", "resume", [["resume q", "https://c", "z"]]);
    const sessionOf = (d: string, id: string) =>
      writeFileSync(
        join(d, "events.jsonl"),
        [JSON.stringify({ type: "system", subtype: "init", session_id: id }), readFileSync(join(d, "events.jsonl"), "utf8")].join("\n"),
      );
    sessionOf(leg, "sess-ask");
    sessionOf(other, "sess-resume");
    const sub = (id: string, q: string, url: string) => {
      const dir = join(root, "scn-ms", "local_r1", "claude-config", "projects", "p", id, "subagents");
      mkdirSync(dir, { recursive: true });
      const rendered = renderWebSearchResult({ query: q, entries: [{ kind: "links", links: [{ title: q, url }] }], reminder: REM });
      writeFileSync(
        join(dir, "agent-a1.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "s1", name: "WebSearch", input: { query: q } }] },
          }),
          JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: rendered }] } }),
        ].join("\n"),
      );
    };
    sub("sess-ask", "subq ask", "https://sub-ask");
    sub("sess-resume", "subq resume", "https://sub-resume");
    expect(
      harvestRun(leg)
        .records.map((r) => r.query)
        .sort(),
    ).toEqual(["main q", "subq ask"]);
    expect(
      harvestRun(other)
        .records.map((r) => r.query)
        .sort(),
    ).toEqual(["resume q", "subq resume"]);
  });
  it("a leg whose leg.json does not parse is treated the same from a runs dir and from its root: an ordinary run dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-legs-"));
    const leg = legRoot(root, "ms", "local_r1", "ask", [["q", "https://a", "x"]]);
    writeFileSync(join(leg, "leg.json"), "{not json");
    expect(discoverRunDirs([root])).toEqual([leg]);
    expect(discoverRunDirs([join(root, "scn-ms", "local_r1")])).toEqual([leg]);
  });
  it("pin (also true before the leg fix): record ids and the pool hash do not depend on where a run sits", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-legs-"));
    const leg = legRoot(root, "ms", "local_r1", "ask", [["q", "https://a", "x"]]);
    const plain = run(mkdtempSync(join(tmpdir(), "cwh-pool-legs-")), { skill: "ms", searches: [["q", "https://a", "x"]] });
    const fromLeg = assemblePool({ ...base, runDirs: [leg] });
    const fromPlain = assemblePool({ ...base, runDirs: [plain] });
    expect(fromLeg.records.map((r) => r.id)).toEqual(fromPlain.records.map((r) => r.id));
    expect(fromLeg.manifest.sha256).toBe(fromPlain.manifest.sha256);
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

describe("review fixes", () => {
  const one = (skill = "ms", searches: [string, string, string][] = [["q", "https://a", "x"]]) => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    return { root, d: run(root, { skill, searches }) };
  };

  it("the content hash covers provenance: a forged manifest field or record source is refused on read", () => {
    const { d } = one();
    const { manifest, records } = assemblePool({ ...base, runDirs: [d] });
    for (const forge of [
      (m: Record<string, unknown>) => (m.mixed = true),
      (m: Record<string, unknown>) => ((m.sources as { variantHash: string }[])[0]!.variantHash = "forged"),
    ]) {
      const dir = join(mkdtempSync(join(tmpdir(), "cwh-pool-out-")), "pool");
      writePool(dir, manifest, records);
      const m = JSON.parse(readFileSync(join(dir, "pool.json"), "utf8"));
      forge(m);
      writeFileSync(join(dir, "pool.json"), JSON.stringify(m));
      expect(() => readPool(dir)).toThrow(/content hash/);
    }
    const dir = join(mkdtempSync(join(tmpdir(), "cwh-pool-out-")), "pool");
    writePool(dir, manifest, records);
    const p = join(dir, "records.jsonl");
    const r = JSON.parse(readFileSync(p, "utf8"));
    r.source.runRef = "/Users/someone/run";
    writeFileSync(p, JSON.stringify(r) + "\n");
    expect(() => readPool(dir)).toThrow(/unexpected shape/);
  });

  it("a run naming no skill is refused unless --skill or --mixed; --skill refuses a run of another skill", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const none = run(root, { skill: "none", searches: [["q1", "https://a", "x"]] });
    const ms = run(root, { skill: "ms", searches: [["q2", "https://b", "y"]] });
    expect(() => assemblePool({ ...base, runDirs: [none] })).toThrow(/--skill/);
    expect(assemblePool({ ...base, runDirs: [none, ms], skill: "ms" }).manifest).toMatchObject({ skills: ["ms"], mixed: false });
    expect(() => assemblePool({ ...base, runDirs: [ms], skill: "cp" })).toThrow(/of skill ms/);
  });

  it("a run of another skill whose searches all duplicate this one's still makes the pool mixed", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const a = run(root, { skill: "ms", searches: [["same", "https://a", "x"]] });
    const b = run(root, { skill: "cp", searches: [["same", "https://a", "x"]] });
    expect(() => assemblePool({ ...base, runDirs: [a, b] })).toThrow(/2 skills/);
  });

  it("finds a secret in the query, a title or a URL, not only the prose", () => {
    for (const where of ["query", "title", "url"] as const) {
      const S = "sk-ant-SECRETVALUE123";
      const q = where === "query" ? `q ${S}` : "q";
      const url = where === "url" ? `https://a/${S}` : "https://a";
      const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
      const d = run(root, { skill: "ms", searches: [[q, url, "x"]] });
      if (where === "title") {
        const ev = readFileSync(join(d, "events.jsonl"), "utf8").replaceAll('\\"title\\":\\"q\\"', `\\"title\\":\\"t ${S}\\"`);
        writeFileSync(join(d, "events.jsonl"), ev);
      }
      expect(() => assemblePool({ ...base, runDirs: [d], secrets: [S] }), where).toThrow(/known secret/);
    }
  });

  it("export refuses an existing file and writes 0600; import refuses a malformed file or a secret", () => {
    const { d } = one();
    const { manifest, records } = assemblePool({ ...base, runDirs: [d] });
    const dir = join(mkdtempSync(join(tmpdir(), "cwh-pool-out-")), "pool");
    writePool(dir, manifest, records);
    const file = join(mkdtempSync(join(tmpdir(), "cwh-pool-x-")), "p.json");
    exportPool(dir, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => exportPool(dir, file)).toThrow(/already exists/);
    const bad = join(mkdtempSync(join(tmpdir(), "cwh-pool-x-")), "bad.json");
    writeFileSync(bad, '{"manifest": 1}');
    expect(() => importPool(bad, join(mkdtempSync(join(tmpdir(), "cwh-in-")), "p"))).toThrow(/not a search pool/);
    writeFileSync(bad, "not json");
    expect(() => importPool(bad, join(mkdtempSync(join(tmpdir(), "cwh-in-")), "p"))).toThrow(/not JSON/);
    expect(() => importPool(file, join(mkdtempSync(join(tmpdir(), "cwh-in-")), "p"), ["https://a"])).toThrow(/known secret/);
  });

  it("refuses an empty pool name", () => {
    const { d } = one();
    expect(() => assemblePool({ ...base, poolId: "", runDirs: [d] })).toThrow(/empty/);
  });
});

describe("final-review fixes", () => {
  it("insideGitWorkTree answers the same under a non-English locale", () => {
    const outside = mkdtempSync(join(tmpdir(), "cwh-nogit-"));
    for (const env of [
      { ...process.env, LC_ALL: "de_DE.UTF-8" },
      { ...process.env, LANG: "fr_FR.UTF-8", LANGUAGE: "fr" },
    ])
      expect(insideGitWorkTree(outside, env)).toBe(false);
  });
  it("insideGitWorkTree fails closed when git cannot be run", () => {
    expect(insideGitWorkTree(mkdtempSync(join(tmpdir(), "cwh-nogit-")), { ...process.env, PATH: "/nonexistent" })).toBe(true);
  });
  it("insideGitWorkTree uses the directory when the nearest existing ancestor is a file", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-nogit-"));
    writeFileSync(join(d, "f.json"), "{}");
    expect(insideGitWorkTree(join(d, "f.json", "sub"))).toBe(false);
  });
  it("a --mixed pool of runs naming no skill is marked mixed", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const d = run(root, { skill: "none", searches: [["q", "https://a", "x"]] });
    expect(assemblePool({ ...base, runDirs: [d], mixed: true }).manifest).toMatchObject({ mixed: true, skills: ["(unknown)"] });
  });
  it("readPool refuses another schema version, a record with an extra key, or a link field of the wrong type", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-pool-"));
    const { manifest, records } = assemblePool({ ...base, runDirs: [run(root, { skill: "ms", searches: [["q", "https://a", "x"]] })] });
    const fresh = () => {
      const dir = join(mkdtempSync(join(tmpdir(), "cwh-pool-out-")), "pool");
      writePool(dir, manifest, records);
      return dir;
    };
    const v2 = fresh();
    const m = JSON.parse(readFileSync(join(v2, "pool.json"), "utf8"));
    m.schemaVersion = 2;
    writeFileSync(join(v2, "pool.json"), JSON.stringify(m));
    expect(() => readPool(v2)).toThrow(/schema version 2/);
    for (const forge of [(r: Record<string, unknown>) => (r.extra = 1), (r: { links: { url: unknown }[] }) => (r.links[0]!.url = {})]) {
      const dir = fresh();
      const p = join(dir, "records.jsonl");
      const r = JSON.parse(readFileSync(p, "utf8"));
      forge(r);
      writeFileSync(p, JSON.stringify(r) + "\n");
      expect(() => readPool(dir)).toThrow(/unexpected shape/);
    }
  });
});

// Local only (never CI): over the operator's kept runs, the leg fix moves nothing but legs. Every ordinary run keeps
// the runRef it had (the hash of its last two path parts), and the records each run yields — their ids — and so the
// pool hash, do not depend on runRef at all. Prints counts only.
const RUNS_ROOT = join(homedir(), ".cowork-harness");
const keptRoots = process.env.COWORK_SEARCH_CORPUS_KEPT && existsSync(RUNS_ROOT) ? globSync(join(RUNS_ROOT, "runs*")) : [];
describe.skipIf(keptRoots.length === 0)("kept runs (local, COWORK_SEARCH_CORPUS_KEPT=1)", () => {
  it("ordinary runs keep their runRef; records and the pool hash are a function of the records alone", () => {
    const dirs = discoverRunDirs(keptRoots);
    const legs = dirs.filter((d) => basename(dirname(d)) === "legs");
    const plain = dirs.filter((d) => basename(dirname(d)) !== "legs");
    const old = (d: string) =>
      createHash("sha256")
        .update(`${basename(dirname(d))}/${basename(d)}`, "utf8")
        .digest("hex")
        .slice(0, 16);
    let withRecords = 0;
    let records = 0;
    for (const d of plain) {
      const h = harvestRun(d);
      for (const r of h.records) {
        expect(r.source.runRef, d).toBe(old(d));
      }
      if (h.records.length) withRecords++;
      records += h.records.length;
    }
    const legRefs = new Set(legs.map(runRefOf));
    expect(legRefs.size).toBe(legs.length);
    console.log(
      `kept runs: ${plain.length} ordinary (${withRecords} with searches, ${records} records), ${legs.length} prompt legs, ${legRefs.size} distinct leg runRefs`,
    );
  });
});

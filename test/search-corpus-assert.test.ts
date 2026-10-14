import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import type { RunSearchCorpusResult, SearchCorpusCall } from "../src/types.js";

// The two frozen-corpus assertion keys, over a run's RunResult.searchCorpus.
function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    ...over,
  };
}
const round = (match: "exact" | "nearby", urls: string[]) => ({
  match,
  nscore: 0.5,
  sourceQuery: "s",
  recordId: "r",
  sourceSkill: null,
  urls,
});
function sc(m: Partial<RunSearchCorpusResult["metrics"]> = {}, calls: SearchCorpusCall[] = []): RunSearchCorpusResult {
  return {
    poolId: "p",
    sha256: "a".repeat(64),
    label: "frozen search corpus p@aaaaaaaa",
    miss: "empty",
    interposition: "proxy-env+ca",
    credentialSource: "env",
    metrics: {
      requests: 0,
      served: 0,
      miss: 0,
      refused: 0,
      retriesFolded: 0,
      unfinished: 0,
      passedThroughWithSearchTool: 0,
      toolUses: 0,
      noRequest: 0,
      toolUsesExpected: 0,
      byAgent: {},
      liveServerTools: 0,
      shapeUnfenced: 0,
      unattributed: 0,
      unattributedExpected: 0,
      reassigned: 0,
      attributionUncertain: 0,
      ...m,
    },
    calls,
  };
}
const one = (a: Parameters<typeof evaluate>[0][number], c: Partial<AssertContext>) => evaluate([a], ctx(c))[0]!;

describe("search_corpus_max_miss_rate", () => {
  it("judges misses over served + misses against the bound", () => {
    expect(one({ search_corpus_max_miss_rate: 0.5 }, { searchCorpus: sc({ served: 3, miss: 1, toolUses: 4 }) }).pass).toBe(true);
    const r = one({ search_corpus_max_miss_rate: 0.2 }, { searchCorpus: sc({ served: 3, miss: 1, toolUses: 4 }) });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/miss rate 0\.25 \(1 of 4\).*0\.2/);
  });
  it("a refused search is never read as clean: the rate is not judged", () => {
    const r = one({ search_corpus_max_miss_rate: 1 }, { searchCorpus: sc({ served: 3, refused: 1, toolUses: 4 }) });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/1 search request\(s\) refused; the miss rate is not judged/);
    // even when nothing reached the corpus otherwise, the refusal is what is named
    expect(one({ search_corpus_max_miss_rate: 1 }, { searchCorpus: sc({ refused: 2, toolUses: 2 }) }).message).toMatch(/refused/);
  });
  it("WebSearch calls that never reached the corpus fail by name; a run that never searched passes", () => {
    const r = one({ search_corpus_max_miss_rate: 0 }, { searchCorpus: sc({ toolUses: 3, noRequest: 3 }) });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/3 WebSearch call\(s\), none reached the corpus \(3 made no request\)/);
    const some = one({ search_corpus_max_miss_rate: 1 }, { searchCorpus: sc({ served: 1, toolUses: 5, noRequest: 4 }) });
    expect(some.pass).toBe(true);
    expect(some.evidence).toMatch(/of 5 WebSearch call\(s\), 4 made no request/);
    const zero = one({ search_corpus_max_miss_rate: 0 }, { searchCorpus: sc() });
    expect(zero.pass).toBe(true);
    expect(zero.evidence).toMatch(/0 searches/);
  });
  it("cannot verify without a frozen corpus, or from a record without the tool-use counts", () => {
    expect(one({ search_corpus_max_miss_rate: 1 }, {}).message).toMatch(/no frozen search corpus/);
    const old = sc({ served: 1 });
    delete (old.metrics as Partial<RunSearchCorpusResult["metrics"]>).toolUses;
    expect(one({ search_corpus_max_miss_rate: 1 }, { searchCorpus: old }).message).toMatch(/older harness/);
  });
});

describe("search_corpus_nearby_citations", () => {
  function work(body: string | Buffer) {
    const root = mkdtempSync(join(tmpdir(), "cwh-nearby-"));
    mkdirSync(join(root, "outputs"));
    writeFileSync(join(root, "outputs", "report.md"), body);
    return root;
  }
  const calls: SearchCorpusCall[] = [
    {
      query: "q1",
      verdict: "served",
      ordinal: 1,
      rounds: [round("exact", ["https://exact.example/a"]), round("nearby", ["https://Near.example/b/"])],
    },
    { query: "q2", verdict: "served", ordinal: 2, rounds: [round("nearby", ["https://both.example/c", "https://near2.example/d"])] },
    { query: "q3", verdict: "served", ordinal: 3, rounds: [round("exact", ["https://both.example/c"])] },
  ];
  const run = (body: string | Buffer, max?: number) =>
    one(
      { search_corpus_nearby_citations: { path: "outputs/report.md", ...(max !== undefined ? { max } : {}) } },
      { workRoot: work(body), searchCorpus: sc({ served: 3, toolUses: 3 }, calls) },
    );

  it("counts distinct cited URLs served only on nearby rounds, under the same URL identity as the served links", () => {
    const r = run("See https://near.example/b and [x](https://near.example/b#frag) and https://exact.example/a.");
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/1 cited URL\(s\) were served only on nearby rounds \(max 0\): https:\/\/near\.example\/b/);
    const one = run("See https://near.example/b and https://unserved.example/z.", 1);
    expect(one.pass).toBe(true);
    // the evidence says how many cited URLs matched a served one: an unmatched citation is not judged
    expect(one.evidence).toMatch(/1 of 2 cited URL\(s\) matched a served URL/);
  });
  it("a URL served on both an exact and a nearby round does not count", () => {
    expect(run("Source: https://both.example/c").pass).toBe(true);
  });
  // A `www.` citation is matched by the bare-host pattern too (it is a valid host), so it is given https whether or not
  // the `www.` pattern also prefixes it: dropping that prefix alone changes nothing a test can see.
  it("a bare-host or www. citation is read as https and matched", () => {
    const bare = run("Sources: https://exact.example/a and near2.example/d");
    expect(bare.pass).toBe(false);
    expect(bare.message).toMatch(/1 cited URL\(s\).*https:\/\/near2\.example\/d/);
    const www = one(
      { search_corpus_nearby_citations: { path: "outputs/report.md" } },
      {
        workRoot: work("Sources: https://exact.example/a and www.near3.example/e"),
        searchCorpus: sc({ served: 1, toolUses: 1 }, [
          {
            query: "q",
            verdict: "served",
            ordinal: 1,
            rounds: [round("exact", ["https://exact.example/a"]), round("nearby", ["https://www.near3.example/e"])],
          },
        ]),
      },
    );
    expect(www.message).toMatch(/https:\/\/www\.near3\.example\/e/);
  });
  it("a deliverable citing none of the served URLs cannot be judged after a nearby round: fails, never passes blind", () => {
    const r = run("Built from README.md and deck.pdf, see https://unrelated.example.");
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/cites none of the 4 served URL\(s\), so nearby citations cannot be judged/);
  });
  it("with no nearby round served there is nothing to cite from one: passes", () => {
    const r = one(
      { search_corpus_nearby_citations: { path: "outputs/report.md" } },
      {
        workRoot: work("no links"),
        searchCorpus: sc({ served: 1, toolUses: 1 }, [
          { query: "q", verdict: "served", ordinal: 1, rounds: [round("exact", ["https://e"])] },
        ]),
      },
    );
    expect(r.pass).toBe(true);
    expect(r.evidence).toMatch(/no nearby round was served/);
  });
  it("refuses by name a deliverable that is not text, or that cannot be found", () => {
    expect(run(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])).message).toMatch(/not text \(a zip container/);
    expect(run(Buffer.from("%PDF-1.7\n")).message).toMatch(/not text \(a PDF/);
    expect(run(Buffer.from([0x68, 0x00, 0x69])).message).toMatch(/not text \(it holds a NUL byte/);
    expect(run(Buffer.from([0xff, 0xfe, 0x41])).message).toMatch(/not text \(not valid UTF-8/);
    const missing = one(
      { search_corpus_nearby_citations: { path: "outputs/nope.md" } },
      { workRoot: work("x"), searchCorpus: sc({ served: 3, toolUses: 3 }, calls) },
    );
    expect(missing.message).toMatch(/file not found: outputs\/nope\.md/);
    expect(
      one({ search_corpus_nearby_citations: { path: "../escape.md" } }, { workRoot: work("x"), searchCorpus: sc({}, calls) }).message,
    ).toMatch(/must stay under the work root/);
  });
  it("cannot verify without a frozen corpus", () => {
    expect(one({ search_corpus_nearby_citations: { path: "outputs/report.md" } }, { workRoot: work("x") }).message).toMatch(
      /no frozen search corpus/,
    );
  });
});

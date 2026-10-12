import { describe, it, expect } from "vitest";
import {
  tokenize,
  queryTokenSet,
  normalizeUrl,
  buildIndex,
  rank,
  select,
  maxScore,
  DEFAULT_RETRIEVAL,
} from "../src/search-corpus/retrieval.js";
import { recordId, type PoolRecord } from "../src/search-corpus/harvest.js";

const src = {
  runRef: "r",
  scenario: null,
  skill: null,
  skillRef: null,
  variantHash: null,
  agentVersion: null,
  desktopVersion: null,
  model: null,
  recordedAt: null,
};
const rec = (query: string, links: [string, string][], text: string): PoolRecord => {
  const l = links.map(([title, url]) => ({ title, url }));
  return { id: recordId({ query, links: l, text }), query, links: l, text, origin: "events", agent: "main", source: src };
};

describe("tokenize (v1)", () => {
  it("NFKC-folds, lowercases, splits on non-letters/numbers, keeps digit runs, drops stopwords and 1-char words", () => {
    expect(tokenize("The ＴＡＭ of EV-charging in 2026, a 5% CAGR")).toEqual(["tam", "ev", "charging", "2026", "5", "cagr"]);
  });
  it("keeps non-Latin words and a single digit", () => {
    expect(tokenize("Größe des Marktes 7")).toEqual(["größe", "des", "marktes", "7"]);
    expect(tokenize("市場 規模")).toEqual(["市場", "規模"]);
  });
  it("queryTokenSet keeps stopwords and numbers, ignores order and repeats", () => {
    expect(queryTokenSet("market size of the EU 2026")).toBe(queryTokenSet("2026 EU the of size market market"));
    expect(queryTokenSet("market size")).not.toBe(queryTokenSet("market size 2026"));
  });
});

describe("normalizeUrl", () => {
  it("lowercases scheme and host, drops fragment and trailing slash, keeps the query string", () => {
    expect(normalizeUrl("HTTPS://Example.COM/A/b/?x=1#frag")).toBe("https://example.com/A/b/?x=1");
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path");
  });
});

describe("rank / select", () => {
  const pool = [
    rec(
      "electric vehicle charging market size europe",
      [["EV charging Europe", "https://a.example/ev"]],
      "The European EV charging market was 5 billion.",
    ),
    rec(
      "electric vehicle charging market size usa",
      [
        ["EV charging US", "https://b.example/ev"],
        ["Dup", "https://a.example/ev/"],
      ],
      "US charging market figures.",
    ),
    rec("restaurant pos software competitors", [["POS", "https://c.example/pos"]], "Toast, Square and Clover lead."),
  ];
  const idx = buildIndex(pool);

  it("serves the best record, plus rounds within 0.75 of it, deduping URLs across rounds", () => {
    const s = select(idx, "electric vehicle charging market size europe");
    expect(s.verdict).toBe("served");
    expect(s.rounds[0]!.record.id).toBe(pool[0]!.id);
    expect(s.rounds[0]!.match).toBe("exact");
    const urls = s.rounds.flatMap((r) => r.links.map((l) => normalizeUrl(l.url)));
    expect(new Set(urls).size).toBe(urls.length);
    for (const r of s.rounds.slice(1)) expect(r.score).toBeGreaterThanOrEqual(0.75 * s.rounds[0]!.score);
  });

  it("misses below the normalised floor, and on no shared term", () => {
    expect(select(idx, "quantum computing qubits").verdict).toBe("miss");
    const weak = select(idx, "electric guitar amplifier reviews");
    expect(weak.verdict).toBe("miss");
    expect(weak.nscore).toBeLessThan(DEFAULT_RETRIEVAL.minScore);
  });

  it("a query term absent from the pool counts against the score, so one shared word cannot pass", () => {
    expect(maxScore(idx, "charging zzzunknownterm")).toBeGreaterThan(maxScore(idx, "charging"));
    expect(select(idx, "charging").verdict).toBe("served");
  });

  it("marks a round nearby when the token sets differ", () => {
    const s = select(idx, "europe electric vehicle charging market size 2026");
    expect(s.verdict).toBe("served");
    expect(s.rounds[0]!.match).toBe("nearby");
  });

  it("filters links by allowed and blocked domains, and drops a record the filter leaves empty", () => {
    const allowed = select(idx, "electric vehicle charging market size", { allowed: ["b.example"] });
    expect(allowed.rounds.every((r) => r.links.every((l) => l.url.includes("b.example")))).toBe(true);
    expect(allowed.rounds.map((r) => r.record.id)).not.toContain(pool[0]!.id);
    const blocked = rank(idx, "electric vehicle charging market size", { blocked: ["a.example"] });
    expect(blocked.map((c) => c.id)).not.toContain(pool[0]!.id);
  });

  it("caps links per round", () => {
    const many = rec(
      "widget suppliers",
      Array.from({ length: 15 }, (_, i) => [`t${i}`, `https://w.example/${i}`] as [string, string]),
      "x",
    );
    const s = select(buildIndex([many]), "widget suppliers");
    expect(s.rounds[0]!.links).toHaveLength(DEFAULT_RETRIEVAL.maxLinks);
  });

  it("is deterministic: ties break by record id, whatever the pool order", () => {
    const a = rec("same query words", [["x", "https://x.example/1"]], "same text");
    const b = rec("same query words", [["x", "https://x.example/2"]], "same text");
    const one = rank(buildIndex([a, b]), "same query words").map((c) => c.id);
    const two = rank(buildIndex([b, a]), "same query words").map((c) => c.id);
    expect(one).toEqual(two);
    expect(one).toEqual([a.id, b.id].sort());
  });
});

/**
 * Retrieval over a search pool: which recorded searches answer an agent's query.
 *
 * BM25F over three fields (the record's query weighted 2, its link titles and its prose 1 each), scored over the
 * agent's query terms only. A query is served only when the top record's NORMALISED score — its share of the score
 * the query's terms could reach in this pool — clears the floor; up to two more records join as extra search rounds
 * when they score at least 0.75 of the top one.
 *
 * The floor, 0.40, was measured leave-one-run-out over 14 kept critique runs with this normalisation: 85% of
 * market-sizing and 89% of competitive-positioning queries served, the served links overlapping the live ones on
 * 99% and 90% of hits. Changing any constant, the tokenizer or the normalisation changes what is served, so they
 * are versioned and part of the pool hash.
 */

import type { PoolRecord } from "./harvest.js";
import type { SearchLink } from "./render.js";

export const TOKENIZER_VERSION = 1;

/** A fixed English stopword list, part of tokenizer version 1. */
const STOPWORDS = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the this to was were will with vs versus what which who how why when where".split(
    " ",
  ),
);

export interface RetrievalParams {
  tokenizerVersion: number;
  k1: number;
  b: number;
  fieldWeights: { query: number; titles: number; text: number };
  minScore: number;
  maxRecords: number;
  maxLinks: number;
  /** A later round must score at least this share of the top record's score. */
  roundShare: number;
}

export const DEFAULT_RETRIEVAL: RetrievalParams = {
  tokenizerVersion: TOKENIZER_VERSION,
  k1: 1.2,
  b: 0.75,
  fieldWeights: { query: 2, titles: 1, text: 1 },
  minScore: 0.4,
  maxRecords: 3,
  maxLinks: 10,
  roundShare: 0.75,
};

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const DIGITS = /^\p{Nd}+$/u;

/** Tokenizer v1: NFKC, lowercase, runs of letters, combining marks and numbers (so Indic, Thai and pointed scripts
 *  stay whole); keep every digit run and every other token of at
 *  least two characters that is not a stopword. No stemming. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const t of s.normalize("NFKC").toLowerCase().match(WORD) ?? []) {
    if (DIGITS.test(t) || ([...t].length >= 2 && !STOPWORDS.has(t))) out.push(t);
  }
  return out;
}

/** The query identity used for `exact`: the SET of all word tokens, stopwords and numbers kept, order-insensitive. */
export function queryTokenSet(q: string): string {
  return [...new Set(q.normalize("NFKC").toLowerCase().match(WORD) ?? [])].sort().join(" ");
}

/** URL identity for merging links across rounds: lowercase scheme and host, no fragment, no trailing slash, the
 *  query string kept. */
export function normalizeUrl(u: string): string {
  const m = u.trim().match(/^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m) return u.trim();
  return `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3]!.replace(/\/+$/, "")}${m[4] ?? ""}`;
}

interface Doc {
  tf: Map<string, number>;
  len: number;
}

export interface PoolIndex {
  records: PoolRecord[];
  docs: Doc[];
  idf: Map<string, number>;
  avgLen: number;
  params: RetrievalParams;
}

export function buildIndex(records: PoolRecord[], params: RetrievalParams = DEFAULT_RETRIEVAL): PoolIndex {
  const w = params.fieldWeights;
  const docs: Doc[] = records.map((r) => {
    const tf = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + weight);
    };
    add(r.query, w.query);
    add(r.links.map((l) => l.title).join(" "), w.titles);
    add(r.text, w.text);
    let len = 0;
    for (const v of tf.values()) len += v;
    return { tf, len };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  const avgLen = N === 0 ? 0 : docs.reduce((s, d) => s + d.len, 0) / N;
  return { records, docs, idf, avgLen, params };
}

export interface Candidate {
  index: number;
  id: string;
  score: number;
}

/** Records with a positive score for `query`, best first; ties by record id. `allowed`/`blocked` filter each record's
 *  links first, and a record they leave with no links cannot be served. */
export function rank(idx: PoolIndex, query: string, domains: { allowed?: string[]; blocked?: string[] } = {}): Candidate[] {
  const { k1, b } = idx.params;
  const terms = [...new Set(tokenize(query))];
  const out: Candidate[] = [];
  idx.docs.forEach((d, i) => {
    // A domain filter that leaves a record no links makes it ineligible (live search filters the same way). With no
    // filter, a record with no links stays eligible, as in the measurement that set the floor.
    if ((domains.allowed?.length || domains.blocked?.length) && filterLinks(idx.records[i]!.links, domains).length === 0) return;
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      score += (idx.idf.get(t)! * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / idx.avgLen));
    }
    if (score > 0) out.push({ index: i, id: idx.records[i]!.id, score });
  });
  return out.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** The score the query's terms could reach: each term's idf times (k1 + 1). A term absent from the pool counts with
 *  the idf of a term no record holds, so a query whose other words the pool lacks cannot pass on one shared word. */
export function maxScore(idx: PoolIndex, query: string): number {
  const unseen = Math.log(1 + (idx.docs.length + 0.5) / 0.5);
  return [...new Set(tokenize(query))].reduce((s, t) => s + (idx.idf.get(t) ?? unseen) * (idx.params.k1 + 1), 0);
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function matchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*\./, "");
  return host === d || host.endsWith(`.${d}`);
}

export function filterLinks(links: SearchLink[], domains: { allowed?: string[]; blocked?: string[] }): SearchLink[] {
  return links.filter((l) => {
    const host = hostOf(l.url);
    if (domains.allowed?.length && (!host || !domains.allowed.some((d) => matchesDomain(host, d)))) return false;
    if (domains.blocked?.length && host && domains.blocked.some((d) => matchesDomain(host, d))) return false;
    return true;
  });
}

export interface ServedRound {
  record: PoolRecord;
  score: number;
  links: SearchLink[];
  match: "exact" | "nearby";
}

export interface Selection {
  verdict: "served" | "miss";
  /** Top score over `maxScore` (0 with no candidate). */
  nscore: number;
  rounds: ServedRound[];
  /** The top candidates, for the per-query log. */
  candidates: { id: string; score: number }[];
}

/** Choose what to serve for one query. Deterministic. */
export function select(idx: PoolIndex, query: string, domains: { allowed?: string[]; blocked?: string[] } = {}): Selection {
  const p = idx.params;
  const ranked = rank(idx, query, domains);
  const candidates = ranked.slice(0, 5).map((c) => ({ id: c.id, score: c.score }));
  const top = ranked[0];
  const max = maxScore(idx, query);
  const nscore = top && max > 0 ? top.score / max : 0;
  if (!top || nscore < p.minScore) return { verdict: "miss", nscore, rounds: [], candidates };
  const chosen = [top, ...ranked.slice(1, p.maxRecords).filter((c) => c.score >= p.roundShare * top.score)];
  const seen = new Set<string>();
  const want = queryTokenSet(query);
  const rounds: ServedRound[] = [];
  for (const c of chosen) {
    const record = idx.records[c.index]!;
    const links: SearchLink[] = [];
    for (const l of filterLinks(record.links, domains)) {
      const key = normalizeUrl(l.url);
      if (seen.has(key) || links.length >= p.maxLinks) continue;
      seen.add(key);
      links.push(l);
    }
    // A later round whose links were all served earlier adds nothing a live search would show twice; drop it.
    if (rounds.length > 0 && links.length === 0) continue;
    rounds.push({ record, score: c.score, links, match: queryTokenSet(record.query) === want ? "exact" : "nearby" });
  }
  return { verdict: "served", nscore, rounds, candidates };
}

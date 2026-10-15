// A synthetic search pool for the frozen-corpus tests: every record invented, hashed with the pool's own functions.
import { createHash } from "node:crypto";
import { recordId, type PoolRecord } from "../src/search-corpus/harvest.js";
import { contentHash, poolHash, writePool, type PoolManifest } from "../src/search-corpus/pool.js";
import { DEFAULT_RETRIEVAL } from "../src/search-corpus/retrieval.js";

export interface RecSpec {
  scenario: string | null;
  variantHash: string | null;
  run?: string;
  query?: string;
}

let n = 0;
export function poolRecord(s: RecSpec): PoolRecord {
  const i = n++;
  const base = {
    query: s.query ?? `invented query ${i}`,
    links: [{ title: `Invented ${i}`, url: `https://example.invalid/${i}` }],
    text: `invented summary ${i}`,
  };
  return {
    ...base,
    id: recordId(base),
    origin: "events",
    agent: "main",
    source: {
      runRef: createHash("sha256")
        .update(s.run ?? `run-${i}`)
        .digest("hex")
        .slice(0, 16),
      scenario: s.scenario,
      skill: "csv-metrics",
      skillRef: null,
      variantHash: s.variantHash,
      agentVersion: null,
      desktopVersion: null,
      model: null,
      recordedAt: null,
    },
  };
}

/** The manifest a build would write over these records (`crossRunDuplicates` absent when `dups` is undefined). */
export function poolManifest(records: PoolRecord[], o: { poolId?: string; dups?: number; mixed?: boolean } = {}): PoolManifest {
  const sorted = [...records].sort((x, y) => (x.id < y.id ? -1 : 1));
  const sources = [
    ...new Map(
      sorted.map((r) => [
        r.source.runRef,
        { runRef: r.source.runRef, skill: r.source.skill, skillRef: null, variantHash: r.source.variantHash },
      ]),
    ).values(),
  ];
  const base: Omit<PoolManifest, "contentSha256"> = {
    schemaVersion: 1,
    poolId: o.poolId ?? "fixture",
    sha256: poolHash(sorted, DEFAULT_RETRIEVAL),
    createdAt: "2026-10-15T00:00:00.000Z",
    harnessVersion: "0.0.0-test",
    mixed: o.mixed ?? false,
    skills: o.mixed ? ["csv-metrics", "other"] : ["csv-metrics"],
    sources: sources.sort((x, y) => (x.runRef < y.runRef ? -1 : 1)),
    counts: {
      records: sorted.length,
      urls: sorted.length,
      runs: sources.length,
      ...(o.dups !== undefined ? { crossRunDuplicates: o.dups } : {}),
    },
    retrieval: DEFAULT_RETRIEVAL,
  };
  return { ...base, contentSha256: contentHash(base, sorted) };
}

export function writeFixturePool(dir: string, records: PoolRecord[], o: Parameters<typeof poolManifest>[1] = {}): PoolManifest {
  const m = poolManifest(records, o);
  writePool(
    dir,
    m,
    [...records].sort((x, y) => (x.id < y.id ? -1 : 1)),
  );
  return m;
}

/**
 * A search pool on disk: the recorded searches a frozen search corpus serves from.
 *
 * `<pool dir>/records.jsonl` holds one search per line; `<pool dir>/pool.json` holds the manifest: the pool's id,
 * its hash (over the sorted record ids AND the retrieval parameters, since changing either changes what is served),
 * the source runs with their skill identity, counts, and the retrieval parameters. Pools live under
 * `~/.cowork-harness/search-pools/` by default, dirs 0700 and files 0600, and are never committed: a pool holds live
 * web titles and URLs and model-written summaries, which can quote an upload.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { collectSecrets } from "../secrets.js";
import { harvestRun, recordId, type HarvestCounts, type PoolRecord } from "./harvest.js";
import { DEFAULT_RETRIEVAL, type RetrievalParams } from "./retrieval.js";

export const POOL_SCHEMA_VERSION = 1;
export const POOLS_DIR = join(homedir(), ".cowork-harness", "search-pools");

export interface PoolSource {
  runRef: string;
  skill: string | null;
  skillRef: string | null;
  variantHash: string | null;
}

export interface PoolManifest {
  schemaVersion: number;
  poolId: string;
  sha256: string;
  createdAt: string;
  harnessVersion: string;
  /** More than one skill: built with `--mixed`, and treated as a measured variant, never a baseline. */
  mixed: boolean;
  skills: string[];
  sources: PoolSource[];
  counts: { records: number; urls: number; runs: number };
  retrieval: RetrievalParams;
}

/** A bare name is a pool under `~/.cowork-harness/search-pools/`; anything with a path separator is a path. */
export function resolvePoolDir(arg: string): string {
  return /[\\/]/.test(arg) || arg === "." || arg === ".." ? resolve(arg) : join(POOLS_DIR, arg);
}

export function poolHash(records: { id: string }[], retrieval: RetrievalParams): string {
  const ids = records.map((r) => r.id).sort();
  return createHash("sha256").update(JSON.stringify({ ids, retrieval }), "utf8").digest("hex");
}

/** Run dirs named by `--from`: a run dir itself (it holds events.jsonl), or a dir whose run dirs sit up to three
 *  levels below it. A run's own work dir is never searched (an agent's nested runs are not this run's). */
export function discoverRunDirs(from: string[]): string[] {
  const out = new Set<string>();
  const walk = (d: string, depth: number) => {
    if (existsSync(join(d, "events.jsonl"))) {
      out.add(resolve(d));
      return;
    }
    if (depth === 0) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (n === "work" || n.startsWith(".")) continue;
      const p = join(d, n);
      try {
        if (statSync(p).isDirectory()) walk(p, depth - 1);
      } catch {
        // unreadable entry
      }
    }
  };
  for (const f of from) walk(resolve(f), 3);
  return [...out].sort();
}

/** The upload files of a run (`work/uploads`, `work/session/uploads`, `work/session/mnt/uploads`). */
function uploadFiles(runDir: string): string[] {
  const out: string[] = [];
  for (const rel of ["work/uploads", "work/session/uploads", "work/session/mnt/uploads"]) {
    const d = join(runDir, rel);
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        if (statSync(join(d, n)).isFile()) out.push(join(d, n));
      } catch {
        // unreadable
      }
    }
  }
  return out;
}

const SHINGLE = 8;
function shingles(text: string): Set<string> {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= w.length; i++) out.add(w.slice(i, i + SHINGLE).join(" "));
  return out;
}

export interface UploadOverlap {
  id: string;
  why: "upload-filename" | "upload-text";
}

/** Records whose query or prose names an upload file or repeats eight consecutive words of a text upload. The agent
 *  builds queries from uploads, so a pool can carry upload text; the build summary lists these for `--exclude`. */
export function uploadOverlaps(records: PoolRecord[], runDirs: string[]): UploadOverlap[] {
  const names = new Set<string>();
  const grams = new Set<string>();
  for (const d of runDirs)
    for (const f of uploadFiles(d)) {
      const n = basename(f);
      if (n.length >= 5) names.add(n.toLowerCase());
      try {
        if (statSync(f).size <= 1_000_000) {
          const t = readFileSync(f, "utf8");
          if (!t.includes("\u0000")) for (const g of shingles(t)) grams.add(g);
        }
      } catch {
        // unreadable upload
      }
    }
  const out: UploadOverlap[] = [];
  for (const r of records) {
    const hay = `${r.query}\n${r.text}`.toLowerCase();
    if ([...names].some((n) => hay.includes(n))) out.push({ id: r.id, why: "upload-filename" });
    else if (grams.size && [...shingles(hay)].some((g) => grams.has(g))) out.push({ id: r.id, why: "upload-text" });
  }
  return out;
}

/** Record ids whose query, prose, titles or URLs contain a known secret in any stored form. */
export function secretHits(records: PoolRecord[], secrets: string[] = collectSecrets()): string[] {
  if (secrets.length === 0) return [];
  return records
    .filter((r) => {
      const hay = [r.query, r.text, ...r.links.flatMap((l) => [l.title, l.url])].join("\n");
      return secrets.some((s) => s && hay.includes(s));
    })
    .map((r) => r.id);
}

export function insideGitWorkTree(dir: string): boolean {
  let d = resolve(dir);
  while (!existsSync(d)) d = dirname(d);
  const r = spawnSync("git", ["-C", d, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

export interface BuildSummary {
  runs: number;
  runsWithSearches: number;
  harvest: HarvestCounts;
  /** Records dropped because another run produced the same id (their sources are kept in pool.json). */
  crossRunDuplicates: number;
  excluded: number;
  uploadOverlaps: UploadOverlap[];
  perSkill: Record<string, number>;
}

export class PoolBuildError extends Error {}

/** Assemble a pool from run dirs. Pure apart from reads; writes nothing. */
export function assemblePool(a: {
  poolId: string;
  runDirs: string[];
  mixed: boolean;
  exclude: ReadonlySet<string>;
  retrieval: RetrievalParams;
  harnessVersion: string;
  now: Date;
  secrets?: string[];
}): { manifest: PoolManifest; records: PoolRecord[]; summary: BuildSummary } {
  const harvest: HarvestCounts = { results: 0, records: 0, errorResults: 0, unparsed: 0, queryMismatch: 0, searchErrors: 0, duplicates: 0 };
  const byId = new Map<string, PoolRecord>();
  const sources = new Map<string, PoolSource>();
  const contributors = new Map<string, Set<string>>(); // record id -> every run that produced it
  let runsWithSearches = 0;
  let crossRunDuplicates = 0;
  for (const d of a.runDirs) {
    const h = harvestRun(d);
    for (const k of Object.keys(harvest) as (keyof HarvestCounts)[]) harvest[k] += h.counts[k];
    if (h.records.length) runsWithSearches++;
    for (const r of h.records) {
      sources.set(r.source.runRef, {
        runRef: r.source.runRef,
        skill: r.source.skill,
        skillRef: r.source.skillRef,
        variantHash: r.source.variantHash,
      });
      const c = contributors.get(r.id) ?? new Set<string>();
      c.add(r.source.runRef);
      contributors.set(r.id, c);
      if (byId.has(r.id)) crossRunDuplicates++;
      else byId.set(r.id, r);
    }
  }
  const unknownExcludes = [...a.exclude].filter((id) => !byId.has(id));
  if (unknownExcludes.length) throw new PoolBuildError(`--exclude names no record in this pool: ${unknownExcludes.join(", ")}`);
  const records = [...byId.values()].filter((r) => !a.exclude.has(r.id)).sort((x, y) => (x.id < y.id ? -1 : 1));
  if (records.length === 0) throw new PoolBuildError("no searches found in the given runs; a pool needs at least one");
  const leaked = secretHits(records, a.secrets);
  if (leaked.length)
    throw new PoolBuildError(
      `a known secret appears in ${leaked.length} record(s): ${leaked.join(", ")}. Nothing was written; drop them with --exclude <id>.`,
    );
  const skills = [...new Set(records.map((r) => r.source.skill ?? "(unknown)"))].sort();
  if (skills.length > 1 && !a.mixed)
    throw new PoolBuildError(
      `the runs hold searches from ${skills.length} skills (${skills.join(", ")}); a pool holds one skill. Build one pool per skill, or pass --mixed for a pool that is a measured variant, never a baseline.`,
    );
  const perSkill: Record<string, number> = {};
  for (const r of records) perSkill[r.source.skill ?? "(unknown)"] = (perSkill[r.source.skill ?? "(unknown)"] ?? 0) + 1;
  const manifest: PoolManifest = {
    schemaVersion: POOL_SCHEMA_VERSION,
    poolId: a.poolId,
    sha256: poolHash(records, a.retrieval),
    createdAt: a.now.toISOString(),
    harnessVersion: a.harnessVersion,
    mixed: skills.length > 1,
    skills,
    // Every run that produced a kept record, including one whose records all duplicate another run's.
    sources: [...new Set(records.flatMap((r) => [...contributors.get(r.id)!]))]
      .map((ref) => sources.get(ref)!)
      .sort((x, y) => (x.runRef < y.runRef ? -1 : 1)),
    counts: { records: records.length, urls: new Set(records.flatMap((r) => r.links.map((l) => l.url))).size, runs: runsWithSearches },
    retrieval: a.retrieval,
  };
  return {
    manifest,
    records,
    summary: {
      runs: a.runDirs.length,
      runsWithSearches,
      harvest,
      crossRunDuplicates,
      excluded: a.exclude.size,
      uploadOverlaps: uploadOverlaps(records, a.runDirs),
      perSkill,
    },
  };
}

/** Write a pool dir (0700) with its two files (0600). Refuses a dir that already holds anything. */
export function writePool(dir: string, manifest: PoolManifest, records: PoolRecord[]): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new PoolBuildError(`${dir} already exists and is not empty`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const recPath = join(dir, "records.jsonl");
  writeFileSync(recPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  writeFileSync(join(dir, "pool.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
}

/** Read a pool dir and verify its hash against its records and retrieval parameters. */
export function readPool(dir: string): { manifest: PoolManifest; records: PoolRecord[] } {
  const manifest = JSON.parse(readFileSync(join(dir, "pool.json"), "utf8")) as PoolManifest;
  if (manifest.schemaVersion !== POOL_SCHEMA_VERSION)
    throw new PoolBuildError(`${dir}: pool schema version ${manifest.schemaVersion} is not supported (expected ${POOL_SCHEMA_VERSION})`);
  const records = readFileSync(join(dir, "records.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PoolRecord);
  for (const r of records)
    if (recordId(r) !== r.id) throw new PoolBuildError(`${dir}: record ${r.id} does not hash to its id (the pool was edited)`);
  const sha = poolHash(records, manifest.retrieval);
  if (sha !== manifest.sha256)
    throw new PoolBuildError(`${dir}: the pool hash does not match its records and parameters (the pool was edited)`);
  return { manifest, records };
}

export const EXPORT_NOTICE =
  "This file holds third-party web page titles and URLs and model-written search summaries, recorded from your own " +
  "cowork-harness runs, for private evaluation. It holds no page bodies. Sharing it is your call.";

/** A single-file export: the notice, the manifest and the records. The hash travels with it and is re-verified on
 *  import, so an eval pin checks on the other machine. */
export function exportPool(dir: string, file: string): void {
  const { manifest, records } = readPool(dir);
  if (!isAbsolute(file)) file = resolve(file);
  writeFileSync(file, JSON.stringify({ notice: EXPORT_NOTICE, manifest, records }) + "\n", { mode: 0o600 });
}

export function importPool(file: string, dir: string): PoolManifest {
  const bundle = JSON.parse(readFileSync(file, "utf8")) as { manifest?: PoolManifest; records?: PoolRecord[] };
  if (!bundle.manifest || !Array.isArray(bundle.records)) throw new PoolBuildError(`${file} is not a search-pool export`);
  for (const r of bundle.records) if (recordId(r) !== r.id) throw new PoolBuildError(`${file}: record ${r.id} does not hash to its id`);
  if (poolHash(bundle.records, bundle.manifest.retrieval) !== bundle.manifest.sha256)
    throw new PoolBuildError(`${file}: the pool hash does not match its records and parameters`);
  writePool(dir, bundle.manifest, bundle.records);
  return bundle.manifest;
}

export { DEFAULT_RETRIEVAL };

// Compares the current structured surface (schema/*.json, action.yml IO, documented COWORK_* env
// vars — see scripts/lib/surface.ts) against the committed test/fixtures/surface-baseline.json and
// categorizes the diff into additions / removals / changes.
//
//   npx tsx scripts/check-surface.ts
//
// Pre-1.0, drift detection lives in test/surface-contract.test.ts as a plain snapshot-sync assertion
// — ANY diff (including a pure addition) fails that test, forcing a conscious `npm run gen:surface`
// regen + review before it ships. This script/module is the FUTURE 1.0 upgrade path: at 1.0, switch
// the test to call checkSurface() and hard-fail only on `removed`/`changed` — a pure `added` result
// is fine without a major bump, since additions aren't a compatibility break.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeSurface } from "./lib/surface.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO_ROOT, "test/fixtures/surface-baseline.json");

export interface SurfaceDiff {
  ok: boolean;
  added: string[];
  removed: string[];
  changed: string[];
}

/** Flatten an arbitrarily-nested JSON-able value into dotted/bracketed leaf paths -> a stable string
 *  value, so two surfaces can be diffed key-by-key regardless of nesting shape. */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || typeof value !== "object") {
    out.set(prefix, JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, "[]");
      return;
    }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    out.set(prefix, "{}");
    return;
  }
  for (const key of keys) flatten(obj[key], prefix ? `${prefix}.${key}` : key, out);
}

/** Compare computeSurface() against the committed baseline. `added` (a new leaf path) is fine at
 *  1.0; `removed` and `changed` are breaking and, at 1.0, must gate a release without a major bump. */
export function checkSurface(): SurfaceDiff {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as unknown;
  const current = computeSurface() as unknown;

  const baseFlat = new Map<string, string>();
  const curFlat = new Map<string, string>();
  flatten(baseline, "", baseFlat);
  flatten(current, "", curFlat);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [path, curVal] of curFlat) {
    if (!baseFlat.has(path)) added.push(path);
    else if (baseFlat.get(path) !== curVal) changed.push(path);
  }
  for (const path of baseFlat.keys()) {
    if (!curFlat.has(path)) removed.push(path);
  }

  added.sort();
  removed.sort();
  changed.sort();

  return { ok: removed.length === 0 && changed.length === 0, added, removed, changed };
}

function main(): void {
  const { ok, added, removed, changed } = checkSurface();
  process.stdout.write(`surface diff: +${added.length} -${removed.length} ~${changed.length}\n`);
  if (added.length) process.stdout.write(`  added:   ${added.join(", ")}\n`);
  if (removed.length) process.stderr.write(`::error::removed: ${removed.join(", ")}\n`);
  if (changed.length) process.stderr.write(`::error::changed: ${changed.join(", ")}\n`);
  if (ok) {
    process.stdout.write("✓ no breaking surface changes\n");
    return;
  }
  process.exitCode = 1;
}

// Run only when invoked directly (so a test can import checkSurface without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

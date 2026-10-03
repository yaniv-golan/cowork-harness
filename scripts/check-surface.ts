// Compares the current structured surface (schema/*.json, action.yml IO, documented COWORK_* env
// vars — see scripts/lib/surface.ts) against the committed test/fixtures/surface-baseline.json and
// categorizes the diff into additions / removals / changes.
//
//   npx tsx scripts/check-surface.ts
//   npx tsx scripts/check-surface.ts --since-tag   # diff against the LAST RELEASE TAG's snapshot instead
//
// Every PR regenerates the committed snapshot, so the plain form reads +0 at release time whatever changed
// since the last release. `--since-tag` diffs against the snapshot as of the highest `vX.Y.Z` tag that is an
// ancestor of HEAD, and fails on a removed or changed leaf unless package.json's version is a MAJOR bump
// over that tag. `npm run preflight` runs the same check.
//
// Pre-1.0, drift detection lives in test/surface-contract.test.ts as a plain snapshot-sync assertion
// — ANY diff (including a pure addition) fails that test, forcing a conscious `npm run gen:surface`
// regen + review before it ships. This script/module is the FUTURE 1.0 upgrade path: at 1.0, switch
// the test to call checkSurface() and hard-fail only on `removed`/`changed` — a pure `added` result
// is fine without a major bump, since additions aren't a compatibility break.
import { spawnSync } from "node:child_process";
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
  /** Removed scalar leaves that survive as an arm of a new union at the same path (`X.type` → `X<anyOf:k>.type`
   *  with the same value): a widening, not a removal. Reported for review, never counted as breaking. */
  widened: string[];
}

/** Flatten an arbitrarily-nested JSON-able value into dotted/bracketed leaf paths -> a stable string
 *  value, so two surfaces can be diffed key-by-key regardless of nesting shape. A list of PRIMITIVES (the
 *  env-var names, an `enum`) is a set: each member becomes its own `[value]` leaf, so inserting one name
 *  is one addition rather than a cascade of shifted positional indexes reported as "changed". */
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
    if (value.every((v) => v === null || typeof v !== "object")) {
      for (const v of value) out.set(`${prefix}[${typeof v === "string" ? v : JSON.stringify(v)}]`, "true");
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

/** Pure diff of two surfaces. `added` (a new leaf path) is fine at 1.0; `removed` and `changed` are
 *  breaking. A scalar leaf that moved under a union arm with the SAME value (`a.b.type` → `a.b<anyOf:0>.type`)
 *  is a widening — the old shape is still accepted — so it goes to `widened`, not `removed`. */
export function diffSurfaces(baseline: unknown, current: unknown): SurfaceDiff {
  const baseFlat = new Map<string, string>();
  const curFlat = new Map<string, string>();
  flatten(baseline, "", baseFlat);
  flatten(current, "", curFlat);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const widened: string[] = [];

  for (const [path, curVal] of curFlat) {
    if (!baseFlat.has(path)) added.push(path);
    else if (baseFlat.get(path) !== curVal) changed.push(path);
  }
  // A removed leaf may have moved under a union arm (`a.x.type` → `a.x<anyOf:k>.type`). That is a WIDENING
  // only when the arm carries exactly the old scalar's direct leaves with the same values — nothing more. An
  // arm that adds a constraint (minLength, an enum, a pattern) on the same field NARROWS it: `changed`.
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directLeaves = (m: Map<string, string>, prefix: string) =>
    new Map([...m].filter(([p]) => p.startsWith(prefix) && !/[.<]/.test(p.slice(prefix.length).replace(/\[[^\]]*\]$/, ""))));
  const consumedArmLeaves = new Set<string>();
  const decided = new Map<string, "widened" | "changed">();
  for (const path of baseFlat.keys()) {
    if (curFlat.has(path) || decided.has(path)) continue;
    const dot = path.lastIndexOf(".");
    if (dot === -1) continue;
    const parent = path.slice(0, dot);
    const oldLeaves = directLeaves(baseFlat, parent + ".");
    const armRe = new RegExp(`^${escape(parent)}<(?:anyOf|oneOf):\\d+>\\.`);
    const arms = new Set([...curFlat.keys()].filter((p) => armRe.test(p)).map((p) => p.slice(0, p.indexOf(">", parent.length) + 2)));
    let verdict: "widened" | "changed" | undefined;
    for (const arm of arms) {
      const armLeaves = directLeaves(curFlat, arm);
      const keepsAll = [...oldLeaves].every(([p, v]) => armLeaves.get(arm + p.slice(parent.length + 1)) === v);
      if (!keepsAll) continue;
      if (armLeaves.size === oldLeaves.size) {
        verdict = "widened";
        for (const p of armLeaves.keys()) consumedArmLeaves.add(p);
        break;
      }
      verdict = "changed"; // keeps the scalar but adds a constraint on it — a narrowing
    }
    if (verdict) for (const p of oldLeaves.keys()) if (!curFlat.has(p)) decided.set(p, verdict);
  }
  for (const path of baseFlat.keys()) {
    if (curFlat.has(path)) continue;
    const v = decided.get(path);
    (v === "widened" ? widened : v === "changed" ? changed : removed).push(path);
  }
  for (let i = added.length - 1; i >= 0; i--) if (consumedArmLeaves.has(added[i])) added.splice(i, 1);

  added.sort();
  removed.sort();
  changed.sort();
  widened.sort();

  return { ok: removed.length === 0 && changed.length === 0, added, removed, changed, widened };
}

/** Compare computeSurface() against the committed baseline. */
export function checkSurface(): SurfaceDiff {
  return diffSurfaces(JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as unknown, computeSurface() as unknown);
}

const SNAPSHOT_REL = "test/fixtures/surface-baseline.json";
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The last release tag among `tags`: the highest strict `vX.Y.Z`, compared numerically. The moving
 *  `vX` / `vX.Y` alias tags and pre-release tags are not releases and are ignored. */
export function pickLastReleaseTag(tags: readonly string[]): string | undefined {
  const parsed = tags.flatMap((t) => {
    const m = RELEASE_TAG.exec(t.trim());
    return m ? [{ tag: t.trim(), v: [Number(m[1]), Number(m[2]), Number(m[3])] }] : [];
  });
  parsed.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return parsed[0]?.tag;
}

export interface SinceTagVerdict {
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  detail: string;
  diff?: SurfaceDiff;
}

/** Pure release-time judgement of the surface diff since the last release tag.
 *  - no snapshot at the tag → SKIP;
 *  - `version` equals the tag's version (not bumped yet) → informational: WARN when something would need a
 *    MAJOR, PASS otherwise, never FAIL;
 *  - a MAJOR bump over the tag → PASS, still listing every removed/changed leaf (the major's notes owe them);
 *  - otherwise any removed or changed leaf → FAIL. Added and widened leaves never fail. */
export function judgeSurfaceSinceTag(input: { tag: string; tagSnapshot: unknown; current: unknown; version: string }): SinceTagVerdict {
  const { tag, tagSnapshot, current, version } = input;
  if (tagSnapshot === undefined)
    return { status: "SKIP", detail: `${tag} carries no ${SNAPSHOT_REL} — nothing to diff the release surface against` };
  const tm = RELEASE_TAG.exec(tag);
  const vm = RELEASE_VERSION.exec(version);
  if (!tm || !vm) return { status: "FAIL", detail: `cannot compare release version "${version}" with tag "${tag}" (both must be X.Y.Z)` };

  const diff = diffSurfaces(tagSnapshot, current);
  const { added, removed, changed, widened } = diff;
  const lines = [`surface since ${tag}: +${added.length} −${removed.length} ~${changed.length}, ${widened.length} widened`];
  if (removed.length) lines.push(`removed: ${removed.join(", ")}`);
  if (changed.length) lines.push(`changed: ${changed.join(", ")}`);
  if (widened.length) lines.push(`widened (additive): ${widened.join(", ")}`);
  const breaking = removed.length > 0 || changed.length > 0;

  if (version === tag.slice(1)) {
    lines.push(
      `package.json is still ${version} (not bumped yet) — informational only, not enforced` +
        (breaking ? "; the removed/changed leaves above will need a MAJOR bump" : ""),
    );
    return { status: breaking ? "WARN" : "PASS", detail: lines.join("\n"), diff };
  }
  const isMajor = Number(vm[1]) > Number(tm[1]);
  if (!breaking) return { status: "PASS", detail: lines.join("\n"), diff };
  if (isMajor) {
    lines.push(`${version} is a MAJOR bump over ${tag} — the breaks are allowed; list each in the release notes`);
    return { status: "PASS", detail: lines.join("\n"), diff };
  }
  lines.push(`${version} is not a MAJOR bump over ${tag}: a removed or changed covered-surface leaf needs a MAJOR`);
  return { status: "FAIL", detail: lines.join("\n"), diff };
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, stdout: "", stderr: String(res.error.message ?? res.error) };
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Thin git wrapper: the last release tag reachable from HEAD and its parsed snapshot. `tagSnapshot` is
 *  undefined only when the file is ABSENT at that tag; any other git or parse failure throws, so the check
 *  can never go quietly vacuous. */
export function loadLastReleaseSnapshot(cwd: string = REPO_ROOT): { tag: string | undefined; tagSnapshot: unknown } {
  const tags = git(cwd, ["tag", "--merged", "HEAD"]);
  if (!tags.ok) throw new Error(`git tag --merged HEAD failed: ${tags.stderr.trim()}`);
  const tag = pickLastReleaseTag(tags.stdout.split("\n"));
  if (!tag) return { tag: undefined, tagSnapshot: undefined };
  const spec = `refs/tags/${tag}:${SNAPSHOT_REL}`;
  if (!git(cwd, ["cat-file", "-e", spec]).ok) return { tag, tagSnapshot: undefined };
  const shown = git(cwd, ["show", spec]);
  if (!shown.ok) throw new Error(`git show ${spec} failed: ${shown.stderr.trim()}`);
  return { tag, tagSnapshot: JSON.parse(shown.stdout) as unknown };
}

/** The release-time check, end to end: last tag's snapshot vs computeSurface(), judged against `version`. */
export function checkSurfaceSinceLastTag(version: string, cwd: string = REPO_ROOT): SinceTagVerdict {
  let loaded: { tag: string | undefined; tagSnapshot: unknown };
  try {
    loaded = loadLastReleaseSnapshot(cwd);
  } catch (e) {
    return { status: "FAIL", detail: (e as Error).message };
  }
  if (!loaded.tag)
    return {
      status: "SKIP",
      detail: "no vX.Y.Z release tag is an ancestor of HEAD (a shallow clone? run `git fetch --tags`) — nothing to diff against",
    };
  return judgeSurfaceSinceTag({ tag: loaded.tag, tagSnapshot: loaded.tagSnapshot, current: computeSurface() as unknown, version });
}

function mainSinceTag(): void {
  const version = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
  const v = checkSurfaceSinceLastTag(version);
  const out = v.status === "FAIL" ? process.stderr : process.stdout;
  out.write(`[${v.status}] release surface (package.json ${version})\n  ${v.detail.replace(/\n/g, "\n  ")}\n`);
  if (v.status === "FAIL") process.exitCode = 1;
}

function main(): void {
  if (process.argv.includes("--since-tag")) return mainSinceTag();
  const { ok, added, removed, changed, widened } = checkSurface();
  process.stdout.write(`surface diff: +${added.length} -${removed.length} ~${changed.length}\n`);
  if (added.length) process.stdout.write(`  added:   ${added.join(", ")}\n`);
  if (widened.length) process.stdout.write(`  widened (scalar kept as a union arm — additive): ${widened.join(", ")}\n`);
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

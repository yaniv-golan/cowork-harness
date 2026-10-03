// The harness-integrity gate of runner-scaffold.mjs (l.216-277), for a runner that is a CLI rather than a
// file in the user's repo.
//
// The scaffold hashes its own source, any lockfile beside it or in cwd, and `_state.json.harness_paths`. Our runner has
// no source file in the user's tree, so the harness itself enters as two virtual entries (harness version
// and platform baseline), and the files that define the measurement — every scenario the positional resolves
// to (independent of --case, so a canary and the full pass agree), its session file, its uploads and its
// workspace_fixture files — enter as the DERIVED set. The skill dir never does: the loop edits it every round.
//
// Like the scaffold's, this is a change detector, not a security boundary: the sha and the list live where the loop
// agent can write. What bounds an unattended run is the permission allowlist on the runner command.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathsInsideMounts } from "./answer-key.js";

const LOCKFILES = ["package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"];

export interface DigestInput {
  cwd: string;
  /** `_state.json.harness_paths`, as written (relative to cwd). Unreadable ⇒ warning + skipped (runner-scaffold.mjs l.249-253). */
  listed: readonly string[];
  /** Absolute paths that define the measurement. Unreadable ⇒ throw: the measurement itself is missing. */
  derived: readonly string[];
  /** Name → value entries standing in for the runner's own source. */
  virtual: Readonly<Record<string, string>>;
  /** Selections that define the measurement without being files (`skill:<name>` under `--skill`), hashed after
   *  the virtual entries as `tag\0`, in order. None ⇒ nothing is hashed, so the sha is the one recorded before
   *  tags existed. */
  tags?: readonly string[];
}

export interface Digest {
  sha: string;
  /** What was hashed, in order: cwd-relative paths, then `<name>` virtual entries, then the tags as written. */
  hashed: string[];
  /** Each hashed entry's own sha256, keyed by its name in `hashed` (a file's bytes, a virtual entry's value, a tag's
   *  text). `--approve-harness` records it as `_state.json` `harness_files`, so a later refusal can name what changed. */
  entries: Record<string, string>;
  skipped: Array<{ path: string; code: string }>;
  lockfiles: string[];
}

export function harnessDigest(input: DigestInput): Digest {
  const { cwd } = input;
  const lockfiles = LOCKFILES.filter((f) => existsSync(resolve(cwd, f)));
  const derived = new Set(input.derived.map((p) => resolve(cwd, p)));
  const all = [...new Set([...derived, ...lockfiles.map((f) => resolve(cwd, f)), ...input.listed.map((p) => resolve(cwd, p))])].sort();
  const h = createHash("sha256");
  const hashed: string[] = [];
  const entries: Record<string, string> = {};
  const one = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
  const skipped: Digest["skipped"] = [];
  for (const p of all) {
    const rel = relative(cwd, p);
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch (e) {
      if (derived.has(p)) throw new Error(`harness digest: cannot read ${rel} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      skipped.push({ path: rel, code: (e as NodeJS.ErrnoException).code ?? "error" });
      continue;
    }
    h.update(rel).update("\0").update(buf).update("\0");
    hashed.push(rel);
    entries[rel] = one(buf);
  }
  for (const k of Object.keys(input.virtual).sort()) {
    const name = `<${k}>`;
    h.update(name).update("\0").update(input.virtual[k]).update("\0");
    hashed.push(name);
    entries[name] = one(input.virtual[k]);
  }
  for (const t of input.tags ?? []) {
    h.update(t).update("\0");
    hashed.push(t);
    entries[t] = one(t);
  }
  return { sha: h.digest("hex"), hashed, entries, skipped, lockfiles };
}

/** What a flow's harness sha covers, whichever command computes it (`run`, `regrade`): one function, so the two can
 *  never hash different inputs for one flow. */
export interface FlowDigestInput {
  cwd: string;
  /** The flow's `_state.json` (its `harness_paths` are hashed when present). */
  state: Readonly<Record<string, unknown>>;
  /** Every scenario the positional resolves to, with their session files, uploads and fixtures. */
  derived: readonly string[];
  /** Name → value signatures of the derived inputs that are not plain files (a fixture's tree). */
  derivedValues?: Readonly<Record<string, string>>;
  harnessVersion: string;
  /** The platform baselines, joined. */
  baselineId: string;
  /** The `--skill` selection (`run`), or the one `harness_skill` recorded (`regrade`, which never changes it). */
  skill?: string;
}

export function flowHarnessDigest(i: FlowDigestInput): Digest {
  return harnessDigest({
    cwd: i.cwd,
    listed: Array.isArray(i.state.harness_paths) ? i.state.harness_paths.map(String) : [],
    derived: i.derived,
    virtual: { ...i.derivedValues, "cowork-harness-version": i.harnessVersion, baseline: i.baselineId },
    tags: i.skill !== undefined ? [`skill:${i.skill}`] : [],
  });
}

/** The selection a flow's harness sha was approved with: `_state.json` `harness_skill`, when it is a string. */
export const approvedHarnessSkill = (state: Readonly<Record<string, unknown>>): string | undefined =>
  typeof state.harness_skill === "string" ? state.harness_skill : undefined;

/** The `harness_paths` entries that resolve inside the skill dir. Listing one would make every round stop
 *  for approval, because the loop edits that dir by design. An entry that no longer exists resolves through its
 *  nearest existing ancestor (the exposure check's rule), so a renamed file is no error here: the digest skips it. */
export function listedInside(cwd: string, listed: readonly string[], skillDir: string): string[] {
  const inside = new Set(
    pathsInsideMounts(
      listed.map((p) => resolve(cwd, p)),
      [skillDir],
    ).map((x) => x.path),
  );
  return listed.filter((p) => inside.has(resolve(cwd, p)));
}

export type GateDecision = { kind: "ok" } | { kind: "approve" } | { kind: "absent" } | { kind: "mismatch" };

/** runner-scaffold.mjs l.259-276: run on a match; record on --approve-harness; otherwise refuse (absent vs changed). */
export function gateDecision(state: { harness_sha?: unknown }, sha: string, approve: boolean): GateDecision {
  if (state.harness_sha === sha) return { kind: "ok" };
  if (approve) return { kind: "approve" };
  return state.harness_sha == null ? { kind: "absent" } : { kind: "mismatch" };
}

/** The per-entry hashes an approval recorded (`_state.json` `harness_files`), or undefined when it recorded none
 *  (an approval from before they existed) or the value is not a name → sha map — never trusted half-read. */
function recordedEntries(state: Readonly<Record<string, unknown>>): Record<string, string> | undefined {
  const f = state.harness_files;
  if (f === null || typeof f !== "object" || Array.isArray(f)) return undefined;
  return Object.values(f).every((v) => typeof v === "string") ? (f as Record<string, string>) : undefined;
}

/** What a refusal (or the dry run's gate line) says changed since the approval: the changed entries first (a new one
 *  marked `(new)`, a gone one `(removed)`), then how many are unchanged, never their names. An approval that recorded
 *  no per-entry hashes says so and lists every hashed entry, as before; so do recorded hashes that all still match. */
export function harnessChangeText(state: Readonly<Record<string, unknown>>, digest: Digest): string {
  const all = `files: ${digest.hashed.join(", ")}`;
  const before = recordedEntries(state);
  if (before === undefined) return `changed: unknown (older approval); ${all}`;
  const changed: string[] = [];
  let unchanged = 0;
  for (const name of digest.hashed) {
    if (!(name in before)) changed.push(`${name} (new)`);
    else if (before[name] !== digest.entries[name]) changed.push(name);
    else unchanged++;
  }
  for (const name of Object.keys(before)) if (!(name in digest.entries)) changed.push(`${name} (removed)`);
  if (!changed.length) return `changed: none identified; ${all}`;
  return `changed: ${changed.join(", ")}${unchanged ? `; and ${unchanged} unchanged` : ""}`;
}

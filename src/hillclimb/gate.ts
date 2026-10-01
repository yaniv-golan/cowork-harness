// The harness-integrity gate of runner-scaffold.mjs (S l.216-277), for a runner that is a CLI rather than a
// file in the user's repo.
//
// S hashes its own source, any lockfile beside it or in cwd, and `_state.json.harness_paths`. Our runner has
// no source file in the user's tree, so the harness itself enters as two virtual entries (harness version
// and platform baseline), and the files that define the measurement — every scenario the positional resolves
// to (independent of --case, so a canary and the full pass agree), its session, answers, decider config and
// uploads — enter as the DERIVED set. The skill dir never does: the loop edits it every round.
//
// Like S, this is a change detector, not a security boundary: the sha and the list live where the loop
// agent can write. What bounds an unattended run is the permission allowlist on the runner command.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { containedRealPath } from "../boundary-paths.js";

const LOCKFILES = ["package-lock.json", "bun.lock", "bun.lockb", "yarn.lock", "pnpm-lock.yaml"];

export interface DigestInput {
  cwd: string;
  /** `_state.json.harness_paths`, as written (relative to cwd). Unreadable ⇒ warning + skipped (S l.249-253). */
  listed: readonly string[];
  /** Absolute paths that define the measurement. Unreadable ⇒ throw: the measurement itself is missing. */
  derived: readonly string[];
  /** Name → value entries standing in for the runner's own source. */
  virtual: Readonly<Record<string, string>>;
}

export interface Digest {
  sha: string;
  /** What was hashed, in order: cwd-relative paths, then `<name>` virtual entries. */
  hashed: string[];
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
  }
  for (const k of Object.keys(input.virtual).sort()) {
    const name = `<${k}>`;
    h.update(name).update("\0").update(input.virtual[k]).update("\0");
    hashed.push(name);
  }
  return { sha: h.digest("hex"), hashed, skipped, lockfiles };
}

/** The `harness_paths` entries that resolve inside the skill dir. Listing one would make every round stop
 *  for approval, because the loop edits that dir by design. */
export function listedInside(cwd: string, listed: readonly string[], skillDir: string): string[] {
  return listed.filter((p) => containedRealPath(skillDir, resolve(cwd, p)));
}

export type GateDecision = { kind: "ok" } | { kind: "approve" } | { kind: "absent" } | { kind: "mismatch" };

/** S l.259-276: run on a match; record on --approve-harness; otherwise refuse (absent vs changed). */
export function gateDecision(state: { harness_sha?: unknown }, sha: string, approve: boolean): GateDecision {
  if (state.harness_sha === sha) return { kind: "ok" };
  if (approve) return { kind: "approve" };
  return state.harness_sha == null ? { kind: "absent" } : { kind: "mismatch" };
}

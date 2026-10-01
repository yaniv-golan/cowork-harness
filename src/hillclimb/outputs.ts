// The files a run authored, prepared for copying into the flow dir (eval-hillclimb.md l.200: output artifacts
// are attached to the trace turn that produced them, written under the variant dir and referenced from the
// flow root). The source is the run's work dir, which the agent could write: every read goes through the
// shared no-follow root, so a planted link or FIFO is skipped rather than followed into a host file, and a
// path that is absolute or climbs out is refused before anything is read.

import { createHash } from "node:crypto";
import { extname, join } from "node:path";
import type { RunResult } from "../types.js";
import { FsRefusal, lstatOrNull, NoFollowRoot } from "./fs.js";

/** Work-dir-relative paths the run wrote: new under the user-visible roots, or present before and changed. */
export function authoredOutputs(r: RunResult): string[] {
  if (!r.workDir || !r.artifacts) return [];
  const pre = new Set(r.preRunPaths ?? []);
  const hashes = r.preRunHashes ?? {};
  let root: NoFollowRoot | undefined;
  try {
    root = NoFollowRoot.existing(r.workDir);
  } catch {
    root = undefined;
  }
  const out: string[] = [];
  for (const a of r.artifacts) {
    if (!pre.has(a.path)) {
      out.push(a.path);
      continue;
    }
    const before = hashes[a.path];
    if (typeof before !== "string" || !root || !safeRel(a.path)) continue;
    try {
      const now = createHash("sha256")
        .update(root.readBytes(join(root.root, a.path)))
        .digest("hex");
      if (now !== before) out.push(a.path);
    } catch {
      /* unreadable now: nothing to copy anyway */
    }
  }
  return out.sort();
}

const safeRel = (rel: string): boolean =>
  rel !== "" && !rel.startsWith("/") && rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");

export interface OutputCopyPlan {
  copy: Array<{ rel: string; data: Buffer }>;
  skipped: Array<{ rel: string; reason: string }>;
}

export function planOutputCopy(
  workDir: string,
  rels: readonly string[],
  caps: { perFileBytes: number; totalBytes: number },
): OutputCopyPlan {
  const plan: OutputCopyPlan = { copy: [], skipped: [] };
  let root: NoFollowRoot | undefined;
  try {
    root = NoFollowRoot.existing(workDir);
  } catch {
    root = undefined;
  }
  let total = 0;
  for (const rel of rels) {
    if (!safeRel(rel)) {
      plan.skipped.push({ rel, reason: "not a safe relative path" });
      continue;
    }
    const p = root ? join(root.root, rel) : undefined;
    const st = p ? lstatOrNull(p) : null;
    if (!root || !p || !st || !st.isFile()) {
      plan.skipped.push({ rel, reason: "not a plain file in the work dir" });
      continue;
    }
    if (st.size > caps.perFileBytes) {
      plan.skipped.push({ rel, reason: "over the per-file cap" });
      continue;
    }
    if (total + st.size > caps.totalBytes) {
      plan.skipped.push({ rel, reason: "over the total cap" });
      continue;
    }
    try {
      const data = root.readBytes(p);
      total += data.length;
      plan.copy.push({ rel, data });
    } catch (e) {
      if (e instanceof FsRefusal || (e as NodeJS.ErrnoException)?.code === "ENOENT")
        plan.skipped.push({ rel, reason: "not a plain file in the work dir" });
      else throw e;
    }
  }
  return plan;
}

const KINDS: Record<string, string> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "svg",
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".json": "json",
  ".md": "text",
  ".txt": "text",
  ".csv": "text",
  ".tsv": "text",
  ".py": "code",
  ".js": "code",
  ".ts": "code",
  ".mjs": "code",
  ".sh": "code",
};

/** The SCHEMA.md Attachment kind for a file name; `file` (a download chip) when nothing better fits. */
export function attachmentKind(name: string): string {
  return KINDS[extname(name).toLowerCase()] ?? "file";
}

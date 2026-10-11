// A prompt leg's POST-RUN manifest: the user-visible files of its session tree, with sha256, as they stood when the
// leg ended (`legs/<id>/leg-post-manifest.json`). Re-grading a leg later (`verify-run --leg`, `regrade --leg`) reads its
// files from that tree, which a later leg or a host action may have changed since; comparing the tree with this
// manifest is how a re-grade knows the files it would read are still the leg's own, and refuses when they are not.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectArtifactPathsWithHealth } from "./artifacts.js";

export const LEG_POST_MANIFEST = "leg-post-manifest.json";

interface LegPostManifest {
  roots: string[];
  /** workRoot-relative path → sha256 of a regular file, or "link" for a symlink/hardlink (never followed). */
  files: Record<string, string>;
  complete: boolean;
}

function snapshot(workRoot: string, roots: string[]): LegPostManifest {
  const walk = collectArtifactPathsWithHealth(workRoot, roots);
  const files: Record<string, string> = {};
  for (const e of walk.entries) {
    if (e.linkKind) {
      files[e.path] = "link";
      continue;
    }
    try {
      const abs = join(workRoot, e.path);
      if (!lstatSync(abs).isFile()) continue;
      files[e.path] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch {
      files[e.path] = "unreadable";
    }
  }
  return { roots, files, complete: walk.complete };
}

/** Take the leg's post-run manifest. Never throws: a manifest that could not be written leaves the leg un-re-gradable
 *  (legTreeDrift then reports no manifest), never wrongly re-gradable. */
export function writeLegPostManifest(legDir: string, workRoot: string, roots: string[]): void {
  try {
    writeFileSync(join(legDir, LEG_POST_MANIFEST), JSON.stringify(snapshot(workRoot, roots), null, 2) + "\n");
  } catch {
    /* see above */
  }
}

/** How the tree at `workRoot` differs from the leg's post-run manifest: changed, added and removed paths. `undefined`
 *  when the leg has no (readable) manifest, or either walk was incomplete — a caller refuses then too. */
export function legTreeDrift(legDir: string, workRoot: string): string[] | undefined {
  let m: LegPostManifest;
  try {
    m = JSON.parse(readFileSync(join(legDir, LEG_POST_MANIFEST), "utf8")) as LegPostManifest;
  } catch {
    return undefined;
  }
  if (!m.complete || !Array.isArray(m.roots) || typeof m.files !== "object") return undefined;
  const now = snapshot(workRoot, m.roots);
  if (!now.complete) return undefined;
  const out: string[] = [];
  for (const [p, h] of Object.entries(m.files)) {
    if (!(p in now.files)) out.push(`removed ${p}`);
    else if (now.files[p] !== h) out.push(`changed ${p}`);
  }
  for (const p of Object.keys(now.files)) if (!(p in m.files)) out.push(`added ${p}`);
  return out.sort();
}

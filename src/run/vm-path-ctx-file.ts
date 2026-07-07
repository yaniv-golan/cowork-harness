import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeJsonAtomic, warn } from "../io.js";
import type { VmPathContext } from "../vm-paths.js";

/**
 * Persists ONE run's `VmPathContext` (the mount/host-path resolution context — see
 * `display-translate.ts`'s module header) to `<outDir>/mounts.json`, a sibling of `status.json`. The
 * live process already has this ctx in memory (built once, at `buildLaunchPlan` time, and reused for
 * the live display translator); this module is what lets a LATER process — `trace` reading a kept run
 * dir after the writer has exited, or a future TUI run-browser — rebuild the SAME ctx instead of
 * degrading to raw VM paths (today's replay rule).
 *
 * A sibling file, not a `display-translate.ts` export, so this can be authored/reviewed independently
 * of that module's own policy-seam contract work.
 *
 * ## Schema (`v: 1`)
 *
 * ```json
 * { "v": 1, "sessionId": "…", "effectiveFidelity": "hostloop",
 *   "outputsHostDir": "…", "uploadsHostDir": "…",
 *   "folders": { "<mountName>": "<hostSourceDir>" } }
 * ```
 *
 * `folders` is `VmPathContext.folders` (a `Map`) serialized as a plain object — JSON has no Map type.
 * The two DORMANT `VmPathContext` fields are deliberately NOT persisted: `hostHomeResolver` is a
 * function (unserializable — JSON.stringify would just drop it) and `autoMemoryHostDir`, though a
 * plain string, belongs to a feature that is never populated at run time (see `vm-paths.ts`'s own
 * `.host-home`/`.auto-memory` notes). `loadVmPathContext` reconstructs a ctx with both left `undefined`,
 * which is exactly what `mapVMPathToHostPath` already treats as "unmappable" — correct until those
 * gates flip, at which point this schema gains fields rather than needing to un-omit them.
 *
 * `v: 1` plus unknown-field tolerance on read: a future writer may add fields (bumping only on a
 * BREAKING shape change, mirroring `cassette.ts`'s `CASSETTE_VERSION` convention) and an older reader
 * ignores what it doesn't recognize rather than rejecting the file.
 *
 * ## Write site
 *
 * Called from `executeScenario` right after `buildLaunchPlan` (`execute.ts`) — the same spot, and the
 * same `vmPathContextFromPlan(...)` VALUE, that fills the live display-translate ref — and mirrored at
 * chat's own plan-build (`chat.ts`). Written UNCONDITIONALLY, for every fidelity tier and every lane
 * that creates a run dir (not just hostloop): the file records what the mounts WERE, so a container/
 * microvm/protocol run gets a ctx file too (~300 bytes) even though today's only consumer only acts on
 * it at `hostloop` — a future consumer may reasonably want the non-hostloop staged-mount picture, and
 * gating at write time would foreclose that for no real cost. The hostloop-only PRESENTATION rule
 * belongs to the consumer (`display-translate.ts`'s policy closure), not to this writer.
 *
 * Best-effort, per `run-status.ts`'s `writeStatus` convention: a write failure (e.g. `outDir` removed
 * mid-teardown) warns and is otherwise swallowed — this file is diagnostic, never load-bearing, and
 * must never fail or alter the real run.
 *
 * ## Reader
 *
 * `loadVmPathContext` returns `null` on anything that isn't a confidently-readable v1 file — absent,
 * corrupt JSON, or an unrecognized major version — so a caller degrades to identity translation, the
 * same rule `replay` already applies when no ctx is available at all.
 *
 * ## Interplay (documented once, here, rather than at each call site)
 *
 * - **`prune`** deletes run dirs wholesale; `mounts.json` needs no special garbage collection — it goes
 *   with the rest of the directory.
 * - **The run index** (`run-index.ts`) stays discovery-only: index rows never
 *   carry a mount map, so an indexed run still requires reading THIS file (via its `outDir`) for ctx.
 * - **Cassettes never carry this file.** `record` builds a cassette from exactly `events.jsonl` +
 *   `control-out.jsonl` + a manifest snapshot of the run's user-visible-roots subtree
 *   (`buildManifest(result.workDir, …, recordRoots)` in `cassette.ts`) — `workDir` is
 *   `<outDir>/work/...`, a SIBLING of `mounts.json` (which lives at the `outDir` ROOT), so the file is
 *   structurally unreachable from that walk regardless of `recordRoots`. See
 *   `test/vm-path-ctx-file.test.ts` for the regression test pinning this.
 * - **No new privacy surface.** The run dir is local-only and already contains host paths (`run.jsonl`'s
 *   header `cwd`, `status.json`'s `pid`); `mounts.json` adds nothing a determined reader of the same
 *   directory didn't already have.
 */
export const MOUNTS_FILE = "mounts.json";

const SCHEMA_VERSION = 1;

/** The on-disk (JSON) shape — see the module header for field-by-field rationale. */
interface MountsFileV1 {
  v: 1;
  sessionId: string;
  effectiveFidelity: string;
  outputsHostDir?: string;
  uploadsHostDir?: string;
  folders: Record<string, string>;
}

/** Best-effort write — see the module header's "Write site" section. Never throws. */
export function writeVmPathContextFile(outDir: string, ctx: VmPathContext, effectiveFidelity: string): void {
  try {
    const body: MountsFileV1 = {
      v: SCHEMA_VERSION,
      sessionId: ctx.sessionId,
      effectiveFidelity,
      ...(ctx.outputsHostDir !== undefined ? { outputsHostDir: ctx.outputsHostDir } : {}),
      ...(ctx.uploadsHostDir !== undefined ? { uploadsHostDir: ctx.uploadsHostDir } : {}),
      folders: Object.fromEntries(ctx.folders),
    };
    writeJsonAtomic(join(outDir, MOUNTS_FILE), body);
  } catch (e) {
    warn(
      `could not write ${MOUNTS_FILE} in ${outDir}: ${String((e as Error)?.message ?? e)} (diagnostic only — the run itself is unaffected)`,
    );
  }
}

/** Read+parse `<runDir>/mounts.json` — see the module header's "Reader" section. Never throws:
 *  absent, corrupt, or an unrecognized major version all degrade to `null` (identity translation). */
export function loadVmPathContext(runDir: string): { ctx: VmPathContext; effectiveFidelity: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(runDir, MOUNTS_FILE), "utf8"));
  } catch {
    return null; // absent (ENOENT) or corrupt JSON
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== SCHEMA_VERSION) return null; // unknown/future major version — degrade rather than guess
  if (typeof r.sessionId !== "string" || typeof r.effectiveFidelity !== "string") return null;

  const folders = new Map<string, string>();
  if (r.folders && typeof r.folders === "object") {
    for (const [k, v] of Object.entries(r.folders as Record<string, unknown>)) {
      if (typeof v === "string") folders.set(k, v);
    }
  }
  const ctx: VmPathContext = {
    sessionId: r.sessionId,
    ...(typeof r.outputsHostDir === "string" ? { outputsHostDir: r.outputsHostDir } : {}),
    ...(typeof r.uploadsHostDir === "string" ? { uploadsHostDir: r.uploadsHostDir } : {}),
    folders,
    // hostHomeResolver/autoMemoryHostDir intentionally left unset — dormant fields, never persisted.
  };
  return { ctx, effectiveFidelity: r.effectiveFidelity };
}

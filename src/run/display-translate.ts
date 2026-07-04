import { join, resolve } from "node:path";
import type { VmPathContext } from "../vm-paths.js";
import { deepTranslateVMPaths } from "../vm-paths.js";

/**
 * CONTRACT: this module is the SINGLE policy seam for translating model-visible VM paths into
 * human-displayed paths. The closure here decides WHETHER a run's display surfaces (the live renderer
 * today; any future consumer of the same `AgentEvent` stream — a TUI, a web view — tomorrow) rewrite VM
 * paths to host paths, and performs the rewrite when they do. It is deliberately factored OUT of the
 * renderer (see docs/internal/2026-07-03-computer-link-scheme-research-and-plan.md, "Forward-
 * compatibility — a future full TUI", for the full rationale) so the policy can't drift between
 * consumers: any future frontend MUST consume `makeDisplayTranslator` + `vmPathContextFromPlan` rather
 * than re-deriving these rules against its own copy of the gate condition.
 *
 * Three invariants make up the gate (each enforced by a dedicated CONTRACT test in
 * test/display-translate.test.ts — copy that table, don't hand-roll a new gate check):
 *   1. **hostloop-only** — translate iff `effectiveFidelity === "hostloop"`. WHY: that's the one tier
 *      where the resolved host path is production-identical; at container/microvm/protocol a mount's
 *      "host" side is harness-internal staging, so translating there would be LESS faithful than the
 *      VM-shaped path production's own model also emits.
 *   2. **identity-without-ctx** — translate iff a `VmPathContext` was supplied. WHY: replay has no
 *      LaunchPlan/run-dir to resolve against — there is nothing to translate against, so identity is the
 *      only correct behavior, matching today's raw-VM-path replay rendering.
 *   3. **identity-when-shareable** — translate iff NOT `shareable` (e.g. `--compact`/`--demo`, or a
 *      future frontend's own export/share mode). WHY: shareable output must never leak a real host path
 *      (`/Users/…`) into something meant to be handed to someone else; this suppression wins even at
 *      hostloop with a ctx present.
 */
export interface DisplayTranslateOptions {
  /** The run's VM-path resolution context (mounts + run dirs). Absent for replay (a cassette has no
   *  LaunchPlan/run-dir — there is nothing to resolve against) — identity in that case, matching
   *  today's raw-VM-path replay rendering. */
  ctx?: VmPathContext;
  /** The tier actually used this run (post `cowork` gate resolution). Translate ONLY at `"hostloop"` —
   *  that is the one tier where the resolved host path is production-identical (a real user folder /
   *  the real staged uploads dir). At container/microvm/protocol, a mount's "host" side is harness-
   *  internal staging (`outDir/work/session/mnt/...`) — showing that would be LESS faithful than
   *  today's `/sessions/...` and would leak the runs dir, so those tiers stay untranslated. */
  effectiveFidelity?: string;
  /** `--compact`/`--demo` (or a future TUI's own export/share mode): the shareable, no-host-paths
   *  output. Its only existing tool, `collapseSessionRoot`, collapses `/sessions/<id>/mnt/` -> `mnt/`
   *  and cannot re-suppress an ALREADY-TRANSLATED `/Users/...` link — so shareable mode forces
   *  identity here rather than relying on that collapse to clean up after us. */
  shareable?: boolean;
}

/**
 * Build the display translator for one run. Gate: translate iff `effectiveFidelity === "hostloop"`
 * AND a ctx was supplied AND the output isn't shareable — every other combination (including
 * shareable-at-hostloop) is identity. See `DisplayTranslateOptions` for the rationale behind each leg.
 *
 * When active, this is host-loop mode in the vm-paths.ts sense (`hostLoopMode: true`): the model
 * already speaks host paths at this tier, so `deepTranslateVMPaths` mainly runs the
 * `encodeComputerUrlsForHostLoop` percent-encoding normalization pass; any VM-shaped path that still
 * shows up in the same text (unusual at hostloop, not impossible) maps through `ctx` too —
 * harmless belt-and-braces, not the primary job here.
 */
export function makeDisplayTranslator(opts: DisplayTranslateOptions): (text: string) => string {
  const { ctx, effectiveFidelity, shareable } = opts;
  if (effectiveFidelity !== "hostloop" || !ctx || shareable) return (text: string) => text;
  return (text: string) => deepTranslateVMPaths(text, ctx, /* hostLoopMode */ true);
}

/**
 * Build a `VmPathContext` from a run's `LaunchPlan` + run directory — pure joins, no filesystem
 * access, so it's safe to call before (or regardless of whether) anything is actually staged on disk.
 * Mirrors the SAME derivations the hostloop runtime itself uses, so the resolved paths agree with what
 * hostloop actually spawns against:
 *   - outputs/uploads: `<outDir>/work/session/mnt/{outputs,uploads}` — matches `hostOutputsDir` in
 *     `src/runtime/hostloop.ts` (`mntHost = join(resolve(outDir), "work", "session", "mnt")`) and the
 *     sibling `uploads` dir `stageHostLoopWorkspace` (`src/runtime/hostloop-stage.ts`) creates there.
 *   - folders: every `kind: "folder"` mount's `mountPath -> hostPath` (hostloop bind-mounts folders at
 *     their REAL host path — never a staged copy — so this is also production-identical, unlike the
 *     container/microvm tiers' staged-copy "host" side).
 * `.host-home`/`.auto-memory` are left unset (dormant features — see the plan's §1.8; `mapVMPathToHostPath`
 * already returns null for them without a resolver, which is correct until those gates flip).
 */
export function vmPathContextFromPlan(
  sessionId: string,
  plan: { mounts: Array<{ kind: string; hostPath: string; mountPath: string }> },
  outDir: string,
): VmPathContext {
  const mntHost = join(resolve(outDir), "work", "session", "mnt");
  const folders = new Map<string, string>();
  for (const m of plan.mounts) {
    if (m.kind === "folder") folders.set(m.mountPath, m.hostPath);
  }
  return {
    sessionId,
    outputsHostDir: join(mntHost, "outputs"),
    uploadsHostDir: join(mntHost, "uploads"),
    folders,
  };
}

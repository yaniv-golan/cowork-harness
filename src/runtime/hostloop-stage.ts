import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { containedRealPath } from "../boundary-paths.js";
import { BoundaryError } from "../errors.js";
import { warn } from "../io.js";
import type { LaunchPlan } from "../session.js";
import type { HostLoopBindMount } from "./argv.js";
import { resolveDeclaredSource } from "../staging/resolve.js";

export type { HostLoopBindMount };

/**
 * Hostloop-specific staging: bind-mount the agent-visible world instead of copying it, then snapshot it
 * at run end so the (unchanged) artifact-collection pipeline keeps working. `stageWorkspace` (stage.ts)
 * is UNTOUCHED — container/microvm's copy-then-isolate is a deliberate safety property for the tiers
 * meant to run untrusted code under OS-level sandboxing. Hostloop's premise is that its native file
 * tools and its VM's bash see the SAME real bytes (matching production), so it gets its own staging module.
 */

/** The nested binds layered over the session-tree bind for hostloop fidelity. Folders are REAL host
 *  paths (production mounts connected folders, never copies them). `.claude` is NOT bound wholesale —
 *  production's host-loop VM gets only skills + projects, read-only (asar `PQn`, byte 10972366); the
 *  native process's config travels on CLAUDE_CONFIG_DIR instead. */
export function resolveHostLoopBindMounts(plan: LaunchPlan, sessionRoot: string): HostLoopBindMount[] {
  const mnt = (p: string) => `${sessionRoot}/mnt/${p}`;
  return [
    ...plan.mounts
      .filter((m) => m.kind === "folder")
      .map((m) => ({ hostPath: m.hostPath, guestPath: mnt(m.mountPath), ro: m.mode === "r" })),
    { hostPath: join(plan.configDir, "skills"), guestPath: mnt(".claude/skills"), ro: true },
    { hostPath: join(plan.configDir, "projects"), guestPath: mnt(".claude/projects"), ro: true },
  ];
}

/** Hostloop pre-run staging. Differences from stageWorkspace: NO folder copies (folders are bind-mounted
 *  real paths), NO mnt/.claude config copy (the native process reads plan.configDir via CLAUDE_CONFIG_DIR;
 *  the sidecar gets only skills/projects as ro binds), mcp.json staged into the CONFIG dir (a host path
 *  the native argv can reference), same resume-skips-recopy semantics as stageWorkspace. */
export function stageHostLoopWorkspace(plan: LaunchPlan, mntHost: string): { mcpHostPath?: string } {
  for (const d of ["uploads", "outputs", ".local-plugins", ".remote-plugins"]) mkdirSync(join(mntHost, d), { recursive: true });
  mkdirSync(join(plan.configDir, "projects"), { recursive: true }); // production: Dr(join(c,"projects"))
  if (!plan.resume) {
    const mntHostReal = realpathSync(mntHost);
    for (const mt of plan.mounts) {
      if (mt.kind === "folder") continue; // bind-mounted, never copied — matches production
      const dest = join(mntHost, mt.mountPath);
      mkdirSync(dirname(dest), { recursive: true });
      if (!containedRealPath(mntHostReal, dirname(dest)))
        throw new BoundaryError(`cowork-harness: staged mount path "${mt.mountPath}" resolves outside the session tree (symlink escape)`);
      if (existsSync(mt.hostPath)) {
        const f = mt.stageFilter ?? null; // uploads are single files; plugins carry stageFilter from plan-build
        cpSync(mt.hostPath, dest, { recursive: true, dereference: false, ...(f ? { filter: f } : {}) });
      } else {
        // buildLaunchPlan validated every source present (or filtered it under COWORK_HARNESS_SOFT_MISSING);
        // absent here is a TOCTOU vanish. Fail loud instead of silently staging an incomplete workspace.
        throw new Error(`cowork-harness: mount source vanished after plan validation: ${mt.hostPath} -> ${mt.mountPath}`);
      }
    }
    // mcp.json: resolved via resolveDeclaredSource exactly as stageWorkspace does, but into
    // join(plan.configDir, "mcp.json") — the native argv's --mcp-config takes this HOST path (there is
    // no configGuest for a native process). Same softMissing/resume exemptions.
    if (plan.mcpConfig) {
      const softMissing = (process.env.COWORK_HARNESS_SOFT_MISSING ?? "") !== "";
      const mcpDest = join(plan.configDir, "mcp.json");
      const resolved = resolveDeclaredSource(plan.mcpConfig, mcpDest, "r", "file", {
        softMissing,
        deferMissing: false,
        what: "mcp.config",
      });
      if (resolved && existsSync(plan.mcpConfig)) cpSync(plan.mcpConfig, mcpDest, { dereference: false });
    }
  }
  return { mcpHostPath: plan.mcpConfig && existsSync(join(plan.configDir, "mcp.json")) ? join(plan.configDir, "mcp.json") : undefined };
}

/** Run-END snapshot for hostloop: materialize the SAME mnt tree stageWorkspace built pre-run for the
 *  copy-based tiers, so every post-run consumer (evaluate ctx, collectArtifacts, verify-run, cassette
 *  record, detectCapabilityUse) keeps reading an IMMUTABLE run-end copy. The agent never sees this tree —
 *  it is a post-run forensic artifact, so it costs zero fidelity (the mount-not-copy rule during the run
 *  is about the agent-visible world only). NOTE: NO gitCpFilter/stageFilter here, unlike stage.ts — the agent's new
 *  files in a connected folder are untracked by definition; filtering would drop exactly the artifacts
 *  this snapshot exists to capture. Only kind:"folder" is snapshotted — uploads and plugins are already
 *  pre-staged copies living in the tree. */
export function snapshotHostLoopWorkspace(plan: LaunchPlan, mntHost: string): void {
  const mntHostReal = realpathSync(mntHost);
  for (const mt of plan.mounts) {
    if (mt.kind !== "folder") continue;
    const dest = join(mntHost, mt.mountPath);
    // The containment check MUST run BEFORE rmSync, not after. A symlinked parent component inside
    // mntHost can make a lexically-inside `dest` resolve outside the session tree; rmSync resolves
    // intermediate symlinks on the host before any check runs, so checking after rm means the
    // out-of-tree recursive delete has ALREADY happened by the time the BoundaryError throws — the
    // exact "✓ success ≠ correct" class this repo's ethos exists to prevent. Check, THEN mkdir/rm/copy.
    mkdirSync(dirname(dest), { recursive: true });
    if (!containedRealPath(mntHostReal, dirname(dest)))
      throw new BoundaryError(`cowork-harness: snapshot path "${mt.mountPath}" resolves outside the session tree (symlink escape)`);
    // Check the source BEFORE the destructive rmSync. The old order (rm, THEN `if (existsSync) copy`)
    // meant a connected-folder source that vanished after plan validation would leave `dest` deleted
    // and nothing copied back — silently erasing the PRIOR run's snapshot evidence. Preserve the prior
    // dest and warn instead. (The symlink-escape boundary check already ran above, before any op.)
    if (!existsSync(mt.hostPath)) {
      warn(`::warning:: [snapshot] connected-folder source vanished: ${mt.hostPath} — preserving prior snapshot for "${mt.mountPath}"\n`);
      continue;
    }
    // rm AFTER the guard — cpSync MERGES: a file the agent DELETED from the real folder would otherwise
    // survive from a prior run/resume and false-pass file_exists (a silent false-green).
    rmSync(dest, { recursive: true, force: true });
    cpSync(mt.hostPath, dest, { recursive: true, dereference: false });
  }
}

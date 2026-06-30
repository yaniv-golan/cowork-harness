import { warn } from "../io.js";
import { existsSync, mkdirSync, cpSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import type { LaunchPlan } from "../session.js";
import { resolveDeclaredSource } from "../staging/resolve.js";
import { containedRealPath } from "../boundary-paths.js";
import { gitModeEnabled, gitCpFilter } from "../run/skill-files.js";
import { BoundaryError } from "../errors.js";

/** Subdirs the writable session tree always pre-creates under mnt (idempotent). `.local-plugins` (not
 *  `.local-plugins/cache`) so both the gated `marketplaces/<mp>/<plugin>` and legacy `cache/<x>` plugin
 *  layouts nest under it; per-mount parents are created on demand in stageWorkspace. `.projects` stays for
 *  the legacy folder layout (an empty hidden dir is harmless under the gated bare-name layout). */
const BARE_DIRS = ["uploads", "outputs", ".projects", ".local-plugins", ".remote-plugins", ".claude"];

export interface StageResult {
  /** true iff mnt/.claude/mcp.json is present after staging — caller derives the guest --mcp-config path. */
  mcpStaged: boolean;
}

/**
 * Stage the writable session tree at `mntHost` for the three sandboxed runtimes (container /
 * hostloop / microvm). They previously duplicated this block and disagreed on resume handling;
 * this centralizes it.
 *
 * FIDELITY (the deciding principle): Cowork resume reuses the SAME VM and never re-stages mounts or
 * config — binary-verified in app.asar 1.12603.1 (native --resume / --resume-session-at /
 * --fork-session, "same VM user"; project/upload content is synced ONCE into a sessionId-keyed
 * storage dir, not re-synced on resume). The harness re-spawns the sandbox each invocation but its
 * outDir (and thus mntHost) is sessionId-keyed and persists, so on `plan.resume` we SKIP every
 * re-copy and reuse the persisted tree. This both matches Cowork and avoids reverting in-session
 * edits a skill made to a rw / .projects mount. Fresh runs (`!plan.resume`) copy everything as
 * before. The bare-dir mkdir is idempotent and always runs.
 *
 * (Note: re-copying the managed `.claude` dir on resume was previously believed to be a "clobber",
 * but cpSync merges and plan.configDir has no projects/ — the session file survives regardless.
 * Skipping it on resume is nonetheless the faithful behavior, so the guard now covers all of it.)
 */
export function stageWorkspace(plan: LaunchPlan, mntHost: string): StageResult {
  for (const d of BARE_DIRS) mkdirSync(join(mntHost, d), { recursive: true });
  const mcpDest = join(mntHost, ".claude", "mcp.json");

  let mcpStaged: boolean;
  if (!plan.resume) {
    // managed config dir (settings.json/cowork_settings.json/skills) -> mnt/.claude
    // preserve symlinks as-is during staging; do not copy out-of-tree content
    cpSync(plan.configDir, join(mntHost, ".claude"), { recursive: true, dereference: false });
    // session content (uploads/projects/plugins) -> under mnt
    const mntHostReal = realpathSync(mntHost); // resolved once; tmpdir() is symlinked on macOS
    for (const mt of plan.mounts) {
      const dest = join(mntHost, mt.mountPath);
      const destParent = dirname(dest);
      mkdirSync(destParent, { recursive: true });
      // `cpSync`/Docker bind follow symlinks at access time, so a pre-existing out-of-tree
      // symlink anywhere in the staged tree could make `destParent` resolve outside `mntHost` and let
      // a copy land off-tree. `mt.mountPath` segments are already sanitized, but a realpath containment
      // check on the destination's parent closes the symlinked-mount-root gap. Reject out-of-tree
      // targets with a boundary error rather than copying into them.
      if (!containedRealPath(mntHostReal, destParent))
        throw new BoundaryError(`cowork-harness: staged mount path "${mt.mountPath}" resolves outside the session tree (symlink escape)`);
      // preserve symlinks as-is during staging; do not copy out-of-tree content
      // prefer the filter precomputed at plan-build (same tracked snapshot used for the staged-set
      // counts ⇒ delivered == counted). Fall back to a fresh gitCpFilter for non-plugin mounts.
      if (existsSync(mt.hostPath)) {
        const f = mt.stageFilter ?? (gitModeEnabled() ? gitCpFilter(mt.hostPath) : null);
        cpSync(mt.hostPath, dest, { recursive: true, dereference: false, ...(f ? { filter: f } : {}) });
      }
    }
    // A declared mcp.config whose source is missing must FAIL on a fresh run (it was silently dropped
    // before — no --mcp-config, no error). Resolved HERE, not in buildLaunchPlan, because resume (the
    // else branch) must stay exempt: on resume the source may be gone but the staged copy persists.
    // Route through the shared source resolver: a present source is kind-checked (--mcp-config models a single mcpServers
    // FILE; a directory would otherwise reach the no-`recursive` cpSync below and throw an opaque
    // ERR_FS_EISDIR, so a wrong-kind source fails loud regardless of softMissing); a missing source
    // throws by default or, under COWORK_HARNESS_SOFT_MISSING=1, returns null → warn-and-skip.
    if (plan.mcpConfig) {
      const softMissing = (process.env.COWORK_HARNESS_SOFT_MISSING ?? "") !== "";
      const resolved = resolveDeclaredSource(plan.mcpConfig, mcpDest, "r", "file", {
        softMissing,
        deferMissing: false,
        what: "mcp.config",
      });
      if (!resolved)
        warn(`::warning:: [mcp] config missing, --mcp-config not advertised (COWORK_HARNESS_SOFT_MISSING): ${plan.mcpConfig}\n`);
    }
    // Advertise --mcp-config only when THIS run actually staged a config. Tie it to the current
    // plan, not to whether a file happens to exist: a fresh non-resume run that reuses a stable
    // outDir (e.g. same --session-id) must NOT inherit a prior run's mnt/.claude/mcp.json when the
    // current plan has no mcpConfig (that would leak removed MCP servers into the new run).
    mcpStaged = !!plan.mcpConfig && existsSync(plan.mcpConfig);
    // preserve symlinks as-is during staging; do not copy out-of-tree content
    if (mcpStaged) cpSync(plan.mcpConfig!, mcpDest, { dereference: false });
  } else {
    // Resume reuses the persisted tree (no re-copy). Advertise the preserved mcp.json only if the
    // current plan still declares one — so dropping MCP between a run and its --resume is honored.
    // if the persisted tree was deleted out-of-band (manifest kept, staged content gone) the run
    // would silently proceed against an empty workspace. We can't hard-fail (an empty-tree resume is a
    // supported shape), but warn loudly so the cause is visible if it was unintended.
    const looksStaged =
      plan.mounts.some((mt) => existsSync(join(mntHost, mt.mountPath))) || existsSync(join(mntHost, ".claude", "settings.json"));
    if (!looksStaged)
      warn(
        `::warning:: [resume] staged workspace at ${mntHost} looks empty (no prior mounts/config found) — if the prior session's files were removed, re-run WITHOUT --resume to re-stage\n`,
      );
    mcpStaged = !!plan.mcpConfig && existsSync(mcpDest);
    if (plan.mcpConfig && !existsSync(mcpDest)) {
      warn(
        `::warning:: [mcp] --resume: mcp.config declared but mnt/.claude/mcp.json is absent -- --mcp-config will NOT be advertised to the agent; re-run WITHOUT --resume to stage it\n`,
      );
    }
  }

  return { mcpStaged };
}

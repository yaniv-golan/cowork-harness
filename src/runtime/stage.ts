import { warn } from "../io.js";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import type { LaunchPlan } from "../session.js";

/** Subdirs the writable session tree always pre-creates under mnt (idempotent). */
const BARE_DIRS = ["uploads", "outputs", ".projects", ".local-plugins/cache", ".remote-plugins", ".claude"];

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
    cpSync(plan.configDir, join(mntHost, ".claude"), { recursive: true });
    // session content (uploads/projects/plugins) -> under mnt
    for (const mt of plan.mounts) {
      const dest = join(mntHost, mt.mountPath);
      mkdirSync(dirname(dest), { recursive: true });
      if (existsSync(mt.hostPath)) cpSync(mt.hostPath, dest, { recursive: true });
    }
    // A declared mcp.config whose source is missing must FAIL on a fresh run (it was silently dropped
    // before — no --mcp-config, no error). Checked HERE, not in buildLaunchPlan, because resume (the
    // else branch) must stay exempt: on resume the source may be gone but the staged copy persists.
    // COWORK_HARNESS_SOFT_MISSING=1 downgrades to warn-and-skip.
    if (plan.mcpConfig && !existsSync(plan.mcpConfig)) {
      const softMissing = (process.env.COWORK_HARNESS_SOFT_MISSING ?? "") !== "";
      if (!softMissing)
        throw new Error(`mcp.config not found: ${plan.mcpConfig}. Fix the path, or set COWORK_HARNESS_SOFT_MISSING=1 to skip it.`);
      warn(`::warning:: [mcp] config missing, --mcp-config not advertised (COWORK_HARNESS_SOFT_MISSING): ${plan.mcpConfig}\n`);
    }
    // Advertise --mcp-config only when THIS run actually staged a config. Tie it to the current
    // plan, not to whether a file happens to exist: a fresh non-resume run that reuses a stable
    // outDir (e.g. same --session-id) must NOT inherit a prior run's mnt/.claude/mcp.json when the
    // current plan has no mcpConfig (that would leak removed MCP servers into the new run).
    mcpStaged = !!plan.mcpConfig && existsSync(plan.mcpConfig);
    if (mcpStaged) cpSync(plan.mcpConfig!, mcpDest);
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
  }

  return { mcpStaged };
}

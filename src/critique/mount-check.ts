import { relative, resolve } from "node:path";
import { tildeify } from "../io.js";
import { gitModeEnabled, gitStageStats } from "../run/skill-files.js";

/** Would staging, mounting `mountRoot`, deliver the skill at `skillDir`? Answered from the ONE tracked set
 *  staging itself reads (`gitStageStats(mountRoot)`, the same call `stageFilterFor` makes), never from a
 *  tracked set read inside `skillDir` — a submodule or nested repo there has its own index, which staging
 *  never consults.
 *
 *  Returns the DIAGNOSIS only. What to do about it depends on the caller: a refusal appends a fix
 *  (`action`), while critique's promotion check uses the diagnosis as the reason it fell back to mounting
 *  the skill folder alone — and there a "git add it" would be wrong (a submodule's contents cannot be added
 *  to the plugin's index) and "pass --skill" would be wrong too (the user passed none).
 *
 *  Skipped entirely under `COWORK_HARNESS_GITSET=0` or when `mountRoot` is not a git work tree: staging
 *  then copies raw, so every file is delivered. */
export type MountDelivery =
  | { ok: true }
  | {
      ok: false;
      /** What staging would do, in its own terms. Stable substrings are pinned by tests. */
      diagnosis: string;
      /** The remedy a REFUSAL should print after the diagnosis (may be empty). */
      action: string;
    };

const GIT_ADD_FIX = "Fix: 'git add' it, or set COWORK_HARNESS_GITSET=0 to copy untracked files.";

export function checkMountDelivers(mountRoot: string, skillDir: string): MountDelivery {
  if (!gitModeEnabled()) return { ok: true };
  let stats: ReturnType<typeof gitStageStats>;
  try {
    stats = gitStageStats(mountRoot);
  } catch (e) {
    return {
      ok: false,
      diagnosis: `could not read the git-tracked set for ${tildeify(mountRoot)}: ${(e as Error).message}`,
      action: "",
    };
  }
  if (!stats.tracked) return { ok: true }; // not a work tree: staging copies raw
  if (stats.tracked.size === 0)
    return {
      ok: false,
      diagnosis: `${tildeify(mountRoot)} has 0 git-tracked files — staging delivers tracked files only, so it would mount EMPTY`,
      action: GIT_ADD_FIX,
    };
  // POSIX keys, like the tracked set (`skill-files.ts` splits on `sep` and joins with "/").
  const rel = relative(resolve(mountRoot), resolve(skillDir)).split("\\").join("/");
  if (rel.startsWith(".."))
    // Unreachable for every target critique resolves today, kept as the closed default: a skill dir
    // OUTSIDE the mount is never delivered, and a guard that exempts the one shape it cannot vouch for is
    // the unsafe-default pattern.
    return { ok: false, diagnosis: `${tildeify(skillDir)} is outside the mounted folder ${tildeify(mountRoot)}`, action: "" };
  if (rel !== "" && ![...stats.tracked].some((t) => t.startsWith(`${rel}/`))) {
    // A case-insensitive filesystem finds `skills/Alpha` for a tracked `skills/alpha`; git does not. Name
    // the real cause rather than prescribing a `git add` that would change nothing.
    const lower = `${rel.toLowerCase()}/`;
    const caseHit = [...stats.tracked].find((t) => t.toLowerCase().startsWith(lower));
    if (caseHit)
      return {
        ok: false,
        diagnosis: `${rel}/ has 0 git-tracked files under ${tildeify(mountRoot)} — its case differs from the tracked path (${caseHit.slice(0, caseHit.indexOf("/", rel.length))})`,
        action: "Pass the name exactly as tracked.",
      };
    return {
      ok: false,
      diagnosis: `${rel}/ has 0 git-tracked files under ${tildeify(mountRoot)} — staging would mount it WITHOUT this skill`,
      action: `A critique would grade a skill the agent never received. ${GIT_ADD_FIX}`,
    };
  }
  return { ok: true };
}

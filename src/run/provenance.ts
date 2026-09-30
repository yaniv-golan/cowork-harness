import type { RunResult } from "../types.js";
import { isLiveModelId } from "../types.js";
import { recordedSlashInvokedSkills } from "../critique/skill-invocation.js";

/**
 * "Which experiment actually ran?" — derived from fields the record already carries, in one place, so
 * the footer, the JSON envelope and the `--repeat` rollup can never disagree about the answer.
 *
 * WHY THIS EXISTS. Three separate multi-run measurements were silently scoped to the wrong thing, and
 * in every case `result.json` already held the answer: a whole finding measured on `claude-sonnet-5`
 * because the session file omitted `model:`; a 10-run "A/B" that was 10 ablated control runs and zero
 * treatment runs; an answer that read exactly like skill output, produced by a run where the skill was
 * never invoked (the model read the mounted `SKILL.md` as a file instead). `models`, `ablated`,
 * `context.availableSkills` and `skillsInvoked` were all present and none of them were surfaced where
 * anyone looks, so checking them meant hand-written scripts against the record — every time, for every
 * run. In practice nobody does that until a result looks wrong, which is after the money is spent.
 *
 * THE LOAD-BEARING RULE, shared with the guards roster: never print a confident negative from a
 * missing field. Absent evidence is `unknown`, never `NOT-invoked` / `not-offered`. A banner that
 * exists to prevent false confidence must not manufacture any.
 */
export interface RunProvenance {
  /** Comma-joined real model ids, or `"unknown"` when none could be determined. */
  model: string;
  /** `offered,invoked` | `offered,invoked(slash)` | `offered,NOT-invoked` | `offered,unknown` | `not-offered` |
   *  `unknown`. `invoked(slash)` = the only invocation was the prompt's leading `/<skill>` command, which the
   *  agent expands itself with no `Skill` tool_use. */
  skill: string;
  /** True only for a `--ablate-skill` run. Absent on the record means false (see `RunResult.ablated`). */
  ablated: boolean;
}

export function runProvenance(r: RunResult): RunProvenance {
  // An agent MARKER, not a model id — the agent stamps `<synthetic>` on assistant messages it fabricates
  // locally (no API call, zero-filled usage). The rule is `isLiveModelId` (src/types.ts), shared with
  // every other consumer of `RunResult.models`: this banner and critique's `gradedModels` disagreeing
  // about what counts as a model is exactly the class of bug the filter exists to prevent.
  const realModels = (r.models ?? []).filter(isLiveModelId);

  // Two independent pieces of evidence, so four states rather than a boolean. `availableSkills` is read
  // off each staged skill's SKILL.md frontmatter at assembly time (src/run/skill-metadata.ts); undefined
  // means the inventory could not be read at all, which is not the same as an empty inventory.
  const offered = r.context?.availableSkills;
  const invoked = r.skillsInvoked;
  // The slash-command channel: a `/<skill>` prompt runs the skill with no Skill tool_use, so `skillsInvoked`
  // alone would print NOT-invoked over a run where the skill ran. Undefined = cannot tell, which blocks the
  // negative the same way an absent `skillsInvoked` does.
  const slash = recordedSlashInvokedSkills(r);
  const skill =
    offered === undefined
      ? "unknown"
      : offered.length === 0
        ? "not-offered"
        : // Any invocation counts. Deliberately NOT "did the skill under test specifically run": the
          // banner has no notion of which skill is under test, and `skillsInvoked` ids
          // (`{plugin}:{skill}`) need not match an `availableSkills` id spelling. Precision beyond
          // "was a skill invoked at all" belongs to `skill_triggered`, which is an assertion with the
          // scenario's own expectations to compare against.
          invoked !== undefined && invoked.length > 0
          ? "offered,invoked"
          : slash !== undefined && slash.length > 0
            ? "offered,invoked(slash)"
            : invoked === undefined || slash === undefined
              ? "offered,unknown"
              : "offered,NOT-invoked";

  return { model: realModels.length ? realModels.join(",") : "unknown", skill, ablated: r.ablated === true };
}

/** The one-line banner. Two spaces between fields so the three key=value pairs stay scannable in a
 *  terminal without being a table. */
export function formatProvenanceLine(r: RunResult): string {
  const p = runProvenance(r);
  return `[provenance] model=${p.model}${unknownModelNote(r, p.model)}  skill=${p.skill}  ablated=${p.ablated}`;
}

/** When the main loop carried no real model — a slash-invoked `context: fork` skill answers through an
 *  agent-fabricated `<synthetic>` message — the result frame's `modelUsage` may still name the model that
 *  did the work. Say what it shows and no more: `modelUsage` covers every API call in the session, so it is
 *  NOT attributed to a particular sub-agent, and the JSON `model` stays `unknown` (text banner only). */
function unknownModelNote(r: RunResult, model: string): string {
  if (model !== "unknown") return "";
  const mainLoopSynthetic = (r.models ?? []).length > 0 && (r.models ?? []).every((m) => !isLiveModelId(m));
  const usage = Object.keys(r.modelUsage ?? {}).filter(isLiveModelId);
  return mainLoopSynthetic && usage.length ? ` (main loop synthetic; modelUsage: ${usage.join(",")})` : "";
}

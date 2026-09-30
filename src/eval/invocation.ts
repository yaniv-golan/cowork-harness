// Per-rep evidence facts: was the selected skill invoked, did the agent read its source directly, or neither.
// Descriptive only — no bucket and no row value depends on them. Computed at run time from the run's own
// record, and persisted, because the run dir may later be pruned.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../types.js";
import { skillInvocationFromRecord } from "../critique/command.js";
import type { EvidenceFacts, Fact } from "./runs.js";

/** Tools whose input can name a file the agent opened. Recipe 5's "observed source access" set. */
const SOURCE_READ_TOOLS = new Set(["Read", "Grep", "Bash", "mcp__workspace__bash"]);
const SKILL_MD = /SKILL\.md/;

/** Did the agent read the mounted SKILL.md or a reference directly? `referencesAccessed` (the reference
 *  reads the run attributed) or a tool call whose input names SKILL.md. `unobservable` when the result
 *  carries neither channel. */
export function sourceReadFact(r: Pick<RunResult, "referencesAccessed" | "toolCalls">): Fact {
  if (r.toolCalls === undefined && r.referencesAccessed === undefined) return "unobservable";
  if ((r.referencesAccessed ?? []).length > 0) return true;
  const named = (r.toolCalls ?? []).some(
    (c) => SOURCE_READ_TOOLS.has(c.name) && Object.values(c.input ?? {}).some((v) => typeof v?.text === "string" && SKILL_MD.test(v.text)),
  );
  return named;
}

export function evidenceFacts(args: {
  result: RunResult;
  /** The selected skill's name; undefined = no single skill to check (invocation unobservable). */
  skillName: string | undefined;
  /** The arm's snapshot (the plugin root the run mounted). */
  pluginRoot: string;
}): EvidenceFacts {
  const r = args.result;
  const eventsPath = r.outDir ? join(r.outDir, "events.jsonl") : undefined;
  const eventsText = (() => {
    if (!eventsPath || !existsSync(eventsPath)) return undefined;
    try {
      return readFileSync(eventsPath, "utf8");
    } catch {
      return undefined;
    }
  })();
  const inv = skillInvocationFromRecord({
    gradedSkillName: args.skillName,
    pluginRoot: args.pluginRoot,
    record: r as unknown as Record<string, unknown>,
    eventsText,
  });
  const invoked: Fact = inv === undefined ? "unobservable" : inv;
  const sourceRead = sourceReadFact(r);
  const neither: Fact = invoked === true || sourceRead === true ? false : invoked === false && sourceRead === false ? true : "unobservable";
  return { invoked, sourceRead, neither };
}

/**
 * Matching a critique's `--skill` selector against an OBSERVED skill id, and deciding which
 * invocation channels a graded run actually lets us observe.
 *
 * The match used to be `JSON.stringify(skillActivity).includes(name)`, which scanned tool names and
 * JSON keys as well as ids: measured against a real run with zero invocations, selectors `fetch`,
 * `root` and `skill` all reported `true`, and `root` collided with the `(root)` sentinel itself.
 * Match ids structurally instead.
 *
 * The selector is a bare skill-directory NAME by construction: `resolveCritiquedSkillDir` refuses
 * anything with a separator, a colon or a dot-dir (`safePathSegment`) before this module sees it, so
 * there is no normalisation to do here — and none is attempted, because a second copy of the rule is
 * how the two would drift.
 */

/** The two sentinels `TimelineWriter`/`foldSkillActivity` emit for un-attributed activity
 *  (`src/agent/timeline.ts`, `src/run/timeline-fold.ts`). Parenthesized precisely so they cannot
 *  collide with a real id — honour that here. */
const SENTINELS = new Set(["(root)", "(unknown)"]);

/** Does an observed skill id name the selected skill? An id is either bare (`deck-review`) or
 *  plugin-qualified (`founder-skills:deck-review`) — both forms occur in the corpus. A bare id must equal
 *  the selector; a qualified id must match the name AND, when the graded plugin's name is known, the
 *  qualifier. `deck-review-lite` must NOT match `deck-review` (what a substring test got wrong), and
 *  `anthropic-skills:skill-creator` must NOT match a critique of `skill-creator:skill-creator` — on
 *  `hostloop`/`protocol` the host's own plugins are in the inventory, and a same-named skill from
 *  another plugin is exactly the kind of thing that is installed on a maintainer's machine. */
export function matchesSkillId(observedId: string, selector: string, pluginName?: string): boolean {
  if (SENTINELS.has(observedId)) return false;
  const colon = observedId.lastIndexOf(":");
  if (colon === -1) return observedId === selector;
  if (observedId.slice(colon + 1) !== selector) return false;
  return pluginName === undefined || observedId.slice(0, colon) === pluginName;
}

/** What a prompt's leading slash token turned out to be. `unobservable` means the run did not record
 *  what we would need (an older `result.json` with no prompt, or a slash prompt whose init frame delivered
 *  no skill inventory), OR the token is a bare name that more than one staged skill answers to — distinct from
 *  `none`, which is a real negative. */
export type SlashInvocation = { kind: "skill"; id: string } | { kind: "none" } | { kind: "unobservable" };

/** Did this prompt invoke a STAGED SKILL by slash command?
 *
 *  The rule is the BINARY's, measured (six prompts through the real host agent 2.1.278 with the API
 *  unreachable; the expansion happens before any call, so the persisted transcript shows what it did):
 *   - the slash must be the FIRST character — `"  /x"` is sent to the model as plain text;
 *   - the token is everything up to the first whitespace — `/x.` and `/x,` are NOT expanded, so
 *     trailing punctuation is part of the token and simply fails to resolve (an earlier version stripped
 *     it "so `/plugin:skill.` resolves", and reported `true` over a run the model saw as prose);
 *   - a BARE name resolves to the plugin skill (`/deck-review` → `founder-skills:deck-review`), while
 *     the inventory spells every plugin skill qualified — so a bare token is matched by suffix, and one
 *     that more than one staged skill answers to is `unobservable`, never `none`.
 *  The match is against the init frame's SKILL inventory, never against `slash_commands` — that list
 *  mixes plugin commands with auto-registered skills and carries no distinguisher, so keying off it
 *  accepts `founder-skills:feedback` and `creative-problem-solving:ideas` (both verified real, both
 *  plain commands) as skill invocations. */
export function slashCommandSkillInvocation(
  prompt: string | undefined,
  availableSkills: readonly { id: string }[] | undefined,
): SlashInvocation {
  if (prompt === undefined) return { kind: "unobservable" };
  const m = /^\/(\S+)/.exec(prompt);
  // No leading slash: the binary expands nothing, so this is a real negative whatever the inventory says.
  if (!m) return { kind: "none" };
  if (availableSkills === undefined) return { kind: "unobservable" };
  const token = m[1];
  const ids = availableSkills.map((s) => s.id);
  if (ids.includes(token)) return { kind: "skill", id: token };
  // A qualified token that is not a staged skill is a command, or prose: the suffix rule below cannot
  // match it either (that would need an id with two colons, of which the corpus has none), so no
  // separate guard — one that nothing can exercise is a claim, not a check.
  const bySuffix = ids.filter((id) => id.endsWith(`:${token}`));
  if (bySuffix.length === 1) return { kind: "skill", id: bySuffix[0] };
  if (bySuffix.length > 1) return { kind: "unobservable" }; // the binary picked one; the record does not say which
  return { kind: "none" };
}

/** `slashCommandSkillInvocation` as a record field: the staged skill ids a prompt invoked by slash command.
 *  `[id]` = the binary expanded that skill itself (no `Skill` tool_use is emitted for it); `[]` = the prompt
 *  invoked no staged skill by slash; `undefined` = cannot tell (no prompt, a slash prompt with no inventory,
 *  or a bare name more than one staged skill answers to). The one conversion every lane uses, so the live
 *  run, a replay and a kept-run re-check cannot disagree about the channel. */
export function slashInvokedSkillIds(
  prompt: string | undefined,
  availableSkills: readonly { id: string }[] | undefined,
  run: SlashRunEvidence = {},
): string[] | undefined {
  const s = slashCommandSkillInvocation(prompt, availableSkills);
  if (s.kind !== "skill") return s.kind === "none" ? [] : undefined;
  // The inventory says the token names a staged skill; the binary can still refuse to run it.
  const token = /^\/(\S+)/.exec(prompt ?? "")?.[1] ?? "";
  return slashCommandRefused(token, run) ? [] : [s.id];
}

/** What the refusal check reads: the turn's result text and the result frame's per-model usage. Only
 *  these two, in every lane (`resultText` live and replay, `finalMessage` on a persisted result), so the
 *  lanes cannot disagree about a refusal. */
export interface SlashRunEvidence {
  resultText?: string;
  modelUsage?: Record<string, unknown>;
}

/** Agent 2.1.284's refusal lines for a slash command it will not run, verbatim from its strings: a skill
 *  with `user-invocable: false`, and a name its command registry does not resolve. */
export const SLASH_REFUSED_NOT_USER_INVOCABLE = "This skill can only be invoked by Claude, not directly by users.";
const SLASH_REFUSED_UNKNOWN = "Unknown command: /";

/** Did the binary refuse the slash command, rather than run it? Refused only when BOTH hold:
 *   1. the trimmed result text STARTS with a refusal line — the not-user-invocable sentence, or
 *      `Unknown command: /<token>` ending there or at `.`/whitespace (so `/x` is not matched by `/xyz`).
 *      A skill whose answer merely QUOTES either line (a skill explaining the binary would) is not a
 *      refusal: the check was `includes` once, and it demoted exactly that real invocation;
 *   2. no live model spent output tokens — a refusal is produced locally and spends nothing, while a
 *      skill that ran (s1: a fork answering under a `<synthetic>` main loop) shows its model in
 *      `modelUsage`. Absent `modelUsage` cannot show zero spend, so it never counts as a refusal.
 *  UNMEASURED against a real refusal: the shape above is read from the binary's code, not observed in a
 *  run (one run of a `user-invocable: false` skill would settle where the line lands). */
export function slashCommandRefused(token: string, run: SlashRunEvidence): boolean {
  const text = run.resultText?.trim();
  if (!text || !run.modelUsage) return false;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refusal =
    text.startsWith(SLASH_REFUSED_NOT_USER_INVOCABLE) ||
    (token !== "" && new RegExp(`^${SLASH_REFUSED_UNKNOWN}${esc}(?:$|[.\\s])`).test(text));
  if (!refusal) return false;
  return !Object.entries(run.modelUsage).some(([model, u]) => {
    if (model.startsWith("<") && model.endsWith(">")) return false;
    const out = (u as { outputTokens?: unknown } | null)?.outputTokens;
    return typeof out === "number" && out > 0;
  });
}

/** The `Skill` calls a SUB-AGENT made during the turn, by the skill id each named — or `undefined` when
 *  the record cannot say.
 *
 *  A `Skill` tool_use with a `parentToolUseId` is a sub-agent's own invocation. `run.ts`'s
 *  `isMainAgentFlow` gate drops it and `timeline.ts`'s sticky window ignores it, so it reaches no
 *  `skillActivity` entry, and the TIMELINE records no tool input. But the turn's `events.jsonl` slice —
 *  which the critique already snapshots — carries the same call as an `assistant` frame with
 *  `parent_tool_use_id` set and `input.skill` populated, so the NAME is recoverable after all. Read it
 *  from there. The earlier version declared the name unrecoverable and refused a verdict; the record
 *  disagreed.
 *
 *  Returns `undefined` when the slice is unreadable or when a parented `Skill` call carries no string
 *  `input.skill` — "a skill ran somewhere we cannot name" is enough to refuse a negative verdict and not
 *  enough to assert a positive one. */
export function subagentSkillCalls(eventsJsonl: string): string[] | undefined {
  const ids: string[] = [];
  let unnamed = false;
  for (const line of eventsJsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // a torn final line is normal on an append-only stream; never fail the critique on it
    }
    if (!e || typeof e !== "object") continue; // a JSON scalar (`null`, a number) is not an event
    if (e.type !== "assistant" || typeof e.parent_tool_use_id !== "string") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Array<{ type?: unknown; name?: unknown; input?: { skill?: unknown } }>) {
      if (!b || b.type !== "tool_use" || b.name !== "Skill") continue;
      if (typeof b.input?.skill === "string" && b.input.skill) ids.push(b.input.skill);
      else unnamed = true;
    }
  }
  return unnamed ? undefined : ids;
}

/** critique's `skillInvocationObserved`, as a tri-state.
 *
 *  `true`  — a channel we can observe named the selected skill, and nothing makes that ambiguous.
 *  `false` — every channel was observable and none did.
 *  `undefined` — a channel could not be observed, or the one that fired is ambiguous, so a verdict
 *                would be an unsupportable claim rather than a finding. Absent is never a synonym
 *                for "no".
 *
 *  Channels: the main agent's `Skill` tool calls (`skillActivity`), a sub-agent's `Skill` calls (from the
 *  events slice), and the prompt's leading slash token. `commandShadowsSkill` — a plugin shipping BOTH
 *  `commands/<n>.md` and `skills/<n>/SKILL.md` (`vercel@0.48.0` does exactly this) — makes EVERY channel
 *  ambiguous, not just the slash one: the `Skill` tool launches plugin commands through the same registry
 *  (`Skill{skill:"creative-problem-solving:ideas"}` is a command, measured 24/24), so a `Skill` call naming
 *  `vercel:bootstrap` is as undecidable as the slash token. Report absent rather than guess. */
export function observedSkillInvocation(
  selector: string,
  pluginName: string | undefined,
  skillActivity: ReadonlyArray<{ skillId?: unknown }> | undefined,
  subagentSkills: readonly string[] | undefined,
  slash: SlashInvocation,
  commandShadowsSkill: boolean,
): boolean | undefined {
  const named =
    skillActivity?.some((e) => typeof e?.skillId === "string" && matchesSkillId(e.skillId, selector, pluginName)) ||
    subagentSkills?.some((id) => matchesSkillId(id, selector, pluginName)) ||
    (slash.kind === "skill" && matchesSkillId(slash.id, selector, pluginName));
  if (named) return commandShadowsSkill ? undefined : true;
  if (skillActivity === undefined || subagentSkills === undefined || slash.kind === "unobservable") return undefined;
  // A top-level Skill call whose id the fold could not read is "cannot tell", not "not this skill".
  if (skillActivity.some((e) => e?.skillId === "(unknown)")) return undefined;
  return false;
}

/** A persisted run's slash channel: the recorded `slashInvokedSkills`, or — on a `result.json` written
 *  before that field existed — the same derivation over the prompt and inventory the record already
 *  carries. Shared by the kept-run re-check and the provenance banner so the two cannot disagree. */
export function recordedSlashInvokedSkills(r: {
  mode?: string;
  slashInvokedSkills?: string[];
  prompt?: string;
  finalMessage?: string;
  modelUsage?: Record<string, unknown>;
  context?: { availableSkills?: readonly { id: string }[] };
}): string[] | undefined {
  if (r.slashInvokedSkills !== undefined) return r.slashInvokedSkills;
  // A chat's `prompt` is only its seed — the REPL messages after it were never recorded — so re-deriving
  // from it would claim a negative the record cannot support.
  if (r.mode === "chat") return undefined;
  return slashInvokedSkillIds(r.prompt, r.context?.availableSkills, { resultText: r.finalMessage, modelUsage: r.modelUsage });
}

import type { RunResult } from "../types.js";
import { isLiveModelId } from "../types.js";
import { UsageError } from "../errors.js";

/** The model a run was ASKED to use, and where that request came from.
 *
 *  `user_setting` is production's own vocabulary — Desktop stamps
 *  `source: "user_setting" | "global_default"` on its resolved model — reused here so the harness names
 *  the concept the way the thing it emulates does. Production's `global_default` has no harness analogue
 *  and is deliberately not mirrored: it names an account-resolved default this harness never observes.
 *  `unresolved` is the state only the harness can reach: nothing pinned the model. A run that would reach
 *  it is refused (`ModelUnresolvedError`), so it is stamped only where no agent ran (a replay, an error
 *  result) or read back from a result recorded before 4.0.0. Cowork never occupies it — its own resolver
 *  always yields a concrete id (the first entry of the account's model list). */
export type ModelSource = NonNullable<RunResult["modelSource"]>;

export interface ModelProvenance {
  modelSource: ModelSource;
  modelPinHonored: boolean | undefined;
  modelFallbacks: RunResult["modelFallbacks"];
}

/** The single derivation every `RunResult` producer calls. One implementation on purpose: `isLiveModelId`
 *  right below it carries a docstring recording three consumers that each reimplemented the `<synthetic>`
 *  filter with different rules and each got it wrong, so this file exists to keep that from happening to
 *  the pin check.
 *
 *  **`modelPinHonored` is deliberately three-state, and the third state is the reason this is a function
 *  rather than an inline `&&`.** `undefined` means *unverifiable* — nothing was pinned, or the run
 *  produced no live model evidence at all. The tempting shape,
 *  `pinned && actual.length && !actual.includes(pinned)`, silently PASSES when `models` is absent (the
 *  unreadable-cassette lane sets `models: undefined`), which renders "we could not tell" as "the pin
 *  held". That is a false green, and this repo's record has several: a cannot-verify is never a pass. */
/** The agent binary's own alias tokens. A pin of `opus` names a FAMILY, not a model — the binary resolves
 *  it to a concrete id at spawn, and the id it reports back (`claude-opus-4-8`) can never string-match the
 *  alias. Comparing them yields a confident `false` for a pin that was in fact honored, which is the same
 *  false-verdict class as the false green above, in the other direction. So an alias pin is `unverifiable`:
 *  the harness cannot know which concrete id the account resolves an alias to. Mirrors the binary's own
 *  list (verified in the staged 2.1.247 agent). */
const FAMILY_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

/** Aliases that name no family at all, so a resolved id cannot be checked against them: `best` can map to
 *  anything the account offers, and `opusplan` selects a planning MODE. These stay unverifiable. */
const UNRESOLVABLE_ALIASES = new Set(["best", "opusplan"]);

/** Normalize an id the way the agent binary's own comparator does — `y(e)=e.replace(/\[1m\]$/i,"")` then
 *  a case-insensitive compare. `[1m]` is a CONTEXT-WINDOW selector Cowork's picker appends to the same
 *  model (`e.id+"[1m]"`), not a different model, so a `[1m]` pin is honored by the bare id. */
const normalizeModelId = (m: string): string => m.replace(/\[\dm\]$/i, "").toLowerCase();

/** Is `id` a CONCRETE model id — one that names exactly one model — rather than a family alias
 *  (`opus`), a mode/any alias (`best`, `opusplan`), or nothing? `[1m]` is a context-window selector on the
 *  same model, so it is stripped first (the binary's own normalization). Used where a comparison must hold
 *  the model fixed across runs: an alias resolves to whatever the account's latest member is at call time.
 *  Deliberately does not claim the id EXISTS — only that it cannot silently mean two different models. */
export function isConcreteModelId(id: string | undefined): id is string {
  if (id === undefined) return false;
  const n = normalizeModelId(id.trim());
  if (n === "") return false;
  if ((FAMILY_ALIASES as readonly string[]).includes(n)) return false;
  if (UNRESOLVABLE_ALIASES.has(n)) return false;
  return true;
}

export function deriveModelProvenance(
  pinnedModel: string | undefined,
  models: string[] | undefined,
  fallbacks: RunResult["modelFallbacks"],
): ModelProvenance {
  const observed = (models ?? []).filter(isLiveModelId);
  const pinned = pinnedModel === undefined ? undefined : normalizeModelId(pinnedModel);
  // Only a fallback OFF the pinned model refutes the pin. A fallback whose `originalModel` is some OTHER
  // model — a sub-agent running `subagent_model:` that overloaded, say — says nothing about whether the
  // main turn honored its pin, and one that fell back *to* the pinned model is evidence FOR it. A
  // fallback with no `originalModel` at all is unattributable, so it counts (fail toward reporting).
  const fellOffPin =
    pinned !== undefined && (fallbacks ?? []).some((f) => f.originalModel === undefined || normalizeModelId(f.originalModel) === pinned);
  return {
    // A pinned model is a user setting whatever its channel (session key, --model flag, matrix axis, env):
    // the distinction production draws is user-chose vs system-chose, not which UI surface carried it.
    modelSource: pinnedModel === undefined ? "unresolved" : "user_setting",
    modelPinHonored: (() => {
      if (pinned === undefined || observed.length === 0) return undefined; // nothing to honor, or no evidence
      if (UNRESOLVABLE_ALIASES.has(pinned)) return undefined; // names no family — nothing to compare against
      // A FAMILY alias is checkable as membership, not equality. Live-verified: `--model opus` runs and
      // the agent reports `claude-opus-5` — it resolves the alias rather than echoing it, and WHICH member
      // it resolves to is account-supplied, so equality would report a false `false`. Family membership is
      // exactly what the author asked for, and it still catches the real violation (pin `opus`, get a
      // sonnet). The `-` anchor keeps `opus` from matching a hypothetical `opusplan-*` id.
      const family = FAMILY_ALIASES.find((f) => pinned === f);
      if (family !== undefined)
        return (
          !fellOffPin && observed.some((m) => normalizeModelId(m).includes(`-${family}-`) || normalizeModelId(m).startsWith(`${family}-`))
        );
      return !fellOffPin && observed.some((m) => normalizeModelId(m) === pinned);
    })(),
    modelFallbacks: fallbacks,
  };
}

/** Provenance for a lane that ran no agent (replay of a cassette, an error result). Every field is
 *  `undefined`/empty rather than a confident-looking default: no turn happened, so there is nothing to
 *  report and nothing to claim. */
export function noModelProvenance(): ModelProvenance {
  return { modelSource: "unresolved", modelPinHonored: undefined, modelFallbacks: undefined };
}

/** The refusal for a run that resolves no model, shared by every lane so the wording cannot drift between
 *  them. `subject` names what was refused (`scenario "x"`, "this `skill` run"), so a batch refusal can list
 *  the files it applies to.
 *
 *  **Why a refusal.** With nothing pinned, the agent binary picks its own default, so the run's model is a
 *  property of the machine it ran on rather than of the scenario. The agent selects part of its system prompt
 *  by model capability, so that changes the instructions the agent is given, not just answer quality — and
 *  Cowork itself never runs without a concrete model id. `fidelity:` is required on the same reasoning.
 *
 *  The text names the KEY, the FLAG and the ENV VAR, never "the file to edit": the `skill` lane builds its
 *  session inline and has no file, and house style throughout `session.ts` names keys and flags. */
export function unresolvedModelRefusal(subject: string): string {
  return (
    `no model is pinned for ${subject}. Set \`model:\` in the session (reproducible), pass \`--model <id>\`, ` +
    `or set COWORK_HARNESS_MODEL (for example in .env). A run must state its model: the agent selects part of ` +
    `its system prompt by model capability, so an unpinned model changes the INSTRUCTIONS the agent is given, ` +
    `and the verdict would be a property of this machine rather than of the scenario.`
  );
}

/** Thrown by `executeScenario` when nothing pins the model. A `UsageError`, so every lane maps it to its
 *  usage exit (`run`/`skill`/`probe-dispatch`: 2) or, on `record`, to the pre-spend refusal code (1). */
export class ModelUnresolvedError extends UsageError {
  constructor(subject: string) {
    super(unresolvedModelRefusal(subject));
    this.name = "ModelUnresolvedError";
  }
}

/** The machine-scoped default, `COWORK_HARNESS_MODEL`. An empty value counts as unset: an empty model
 *  string must never reach argv (SPEC §CB-2), and must not satisfy the refusal above either. */
export function envModelDefault(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.COWORK_HARNESS_MODEL || undefined;
}

/** Resolve which model a run should pin, given the three channels that can supply one.
 *
 *  Extracted from `executeScenario` so the PRECEDENCE is testable on its own. It is worth stating
 *  explicitly because collapsing it into a `??` chain is what broke it once: `explicit ?? env ?? file`
 *  reads naturally and is wrong, because it lets a machine-scoped environment variable outrank a model
 *  the scenario's own session file declares. That reintroduces — through the back door, and invisibly —
 *  the exact defect this module exists to close: a run whose model is a property of the shell it was
 *  launched from rather than of the scenario. A stray line in a repo `.env` would have repointed every
 *  clone's runs while `modelSource` still read `user_setting`.
 *
 *  `explicit` is `--model` or a matrix axis: a per-invocation act by the author, so it outranks the file.
 *  `envDefault` only fills a gap. Returns `undefined` when nothing pins the model — the state that is refused
 *  (`ModelUnresolvedError`). */
export function resolvePinnedModel(
  explicit: string | undefined,
  sessionModel: string | undefined,
  envDefault: string | undefined,
): string | undefined {
  if (explicit !== undefined) return explicit;
  if (sessionModel !== undefined) return sessionModel;
  return envDefault;
}

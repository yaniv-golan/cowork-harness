// THE source of truth for `cowork-harness skill`'s flag surface, and for what `critique` does with each
// flag.
//
// WHY THIS EXISTS. `critique` runs a skill by spawning two `skill` turns (a task turn, then a `--resume`
// reflection turn), but its own parser was a hand-rolled SUBSET of `skill`'s flags. That subset drifts
// silently — a `skill` flag added tomorrow is simply unavailable to `critique`, with nothing failing. This
// repo has shipped that exact "propagate-minus-one" shape repeatedly, so a design that requires manually
// mirroring a flag list is wrong even when it is momentarily correct.
//
// The fix is structural, in two halves:
//   1. `critique` field below is REQUIRED, so an entry cannot be added without deciding its disposition.
//   2. `test/critique-skill-flag-parity.test.ts` extracts the flag literals the `skill` lane actually
//      accepts and fails if any is missing here — so a NEW skill flag is red CI, not a silent gap.
//
// Half 2 is the load-bearing half: the required field only gives totality over entries already present.

/** What `critique` does with a `skill` flag. */
export type CritiqueDisposition =
  /** Pass through to the spawned turn(s).
   *
   *  `turns: "both"` is REQUIRED for any flag that declares a session SOURCE (uploads, folders, plugins,
   *  marketplaces). Those paths are part of the session-origin key (`sessionOriginSources`, run/execute.ts),
   *  so forwarding them to the task turn alone makes the reflection turn's `--resume` compute a DIFFERENT
   *  origin and throw fail-closed. Re-declaring them is harmless: resume re-uses the staged tree in place
   *  and re-stages nothing. */
  | { kind: "forward"; turns: "both" | "task" }
  /** Refuse with `reason`. Never silently accept a flag that cannot work — a silent no-op is this repo's
   *  documented anti-pattern. */
  | { kind: "reject"; reason: string }
  /** `critique` implements or pins this itself; never forwarded verbatim. `note` is DESCRIPTIVE — unlike
   *  `reject.reason` (which is surfaced in the error), nothing reads it. Kept as colocated documentation. */
  | { kind: "owned"; note: string };

export interface SkillFlagSpec {
  flag: string;
  /** 0 = boolean, 1 = takes a value. Both `--flag value` and `--flag=value` spellings are accepted. */
  arity: 0 | 1;
  /** Enforced for arity-1 flags: given twice, the child keeps only the last value, so the earlier one is
   *  silently discarded — `critique` rejects instead. Arity-0 flags are exempt: there is no value to lose
   *  and the child takes them idempotently, so `repeatable` is meaningless on them. */
  repeatable?: boolean;
  /** REQUIRED — totality by construction. */
  critique: CritiqueDisposition;
}

const forwardBoth = (): CritiqueDisposition => ({ kind: "forward", turns: "both" });
const forwardTask = (): CritiqueDisposition => ({ kind: "forward", turns: "task" });

export const SKILL_FLAG_SURFACE: SkillFlagSpec[] = [
  // ---- session SOURCES — must reach BOTH turns or the resume throws on an origin-key mismatch ----
  { flag: "--upload", arity: 1, repeatable: true, critique: forwardBoth() },
  { flag: "--folder", arity: 1, repeatable: true, critique: forwardBoth() },
  { flag: "--plugin", arity: 1, repeatable: true, critique: forwardBoth() },
  { flag: "--marketplace", arity: 1, repeatable: true, critique: forwardBoth() },
  { flag: "--enable", arity: 1, repeatable: true, critique: forwardBoth() },

  // ---- session shape that both turns must agree on ----
  // The reflection must run on the SAME model as the task turn: the skill lane rebuilds its inline session
  // per invocation, so an unforwarded resume would reflect using the DEFAULT model — a self-report from a
  // different model than the one that did the work.
  { flag: "--model", arity: 1, critique: forwardBoth() },
  // Without this a lean-image capability gap makes the task turn error, and the critique harvests a fact
  // about the rig instead of the skill — the same failure class as a missing upload.
  { flag: "--allow-missing-capability", arity: 0, critique: forwardBoth() },
  // hostloop host-write consent. forwardBoth is load-bearing: checkHostLoopWriteConsent runs on EVERY
  // executeScenario at hostloop (the reflection resume included), so a task-only forward would refuse
  // every reflection turn of a folder-bearing hostloop critique.
  { flag: "--allow-host-writes", arity: 0, critique: forwardBoth() },

  // ---- the GRADED run only ----
  // TASK-only deliberately: forwarding to the reflection turn would inject a near-always-green row into the
  // labelled generation group, inflating passRate and breaking the `runLabel` filter docs/debugging.md
  // documents as the escape hatch for exactly that dilution. Not in the origin key, so nothing forces both.
  { flag: "--label", arity: 1, critique: forwardTask() },
  // Parsed as well as forwarded: critique's own spawn kill-switch is fixed, so a longer --timeout would be
  // killed by the INSTRUMENT and misreported as an infra failure instead of a gradeable timeout.
  { flag: "--timeout", arity: 1, critique: forwardTask() },
  // Makes GATED skills critiquable for the first time: the inner spawn has no TTY, so an unscripted gate
  // otherwise resolves to `fail` and the task turn dies before anything can be graded.
  { flag: "--answer", arity: 1, repeatable: true, critique: forwardTask() },
  { flag: "--answer-policy", arity: 1, critique: forwardTask() },
  // `prompt` is rejected at parse time — no TTY inside the spawn, so it would resolve differently than the
  // caller expects. Gates belong to the graded run; the reflection turn stays pinned deterministic.
  { flag: "--on-unanswered", arity: 1, critique: forwardTask() },
  { flag: "--decider-llm", arity: 0, critique: forwardTask() },
  { flag: "--intent", arity: 1, critique: forwardTask() },
  { flag: "--decider-model", arity: 1, critique: forwardTask() },
  { flag: "--decider-cmd", arity: 1, critique: forwardTask() },
  // HARD invariant: the file channel requires a fresh, empty dir per run. Reaching the reflection turn
  // would break it.
  { flag: "--decider-dir", arity: 1, critique: forwardTask() },

  // ---- refused ----
  {
    flag: "--session-id",
    arity: 1,
    critique: {
      kind: "reject",
      reason: "critique mints and manages its own session (the reflection turn IS a resume of it)",
    },
  },
  {
    flag: "--resume",
    arity: 0,
    critique: {
      kind: "reject",
      reason: "critique mints and manages its own session (the reflection turn IS a resume of it)",
    },
  },
  ...(["--repeat", "--min-pass-rate", "--stop-on-diverge", "--max-budget-usd", "--allow-budget-stop"] as const).map(
    (flag): SkillFlagSpec => ({
      flag,
      arity: flag === "--stop-on-diverge" || flag === "--allow-budget-stop" ? 0 : 1,
      critique: {
        kind: "reject",
        reason:
          "critique is a fixed two-turn protocol — loop `critique` itself and pair generations by fingerprint.skillHash (docs/critique.md's 'Reproduction' section has the recipe)",
      },
    }),
  ),
  {
    flag: "--ablate-skill",
    arity: 0,
    critique: { kind: "reject", reason: "grading a skill you removed is incoherent (and ablate+resume is rejected anyway)" },
  },
  ...(["--quiet", "-q", "--verbose", "--compact", "--demo"] as const).map((flag): SkillFlagSpec => ({
    flag,
    arity: 0,
    critique: {
      kind: "reject",
      reason:
        "critique produces its own report (host paths in it are already collapsed to ~); inner-turn rendering flags have no effect on it",
    },
  })),
  {
    flag: "--dry-run",
    arity: 0,
    critique: { kind: "reject", reason: "there is no meaningful two-turn preview — use `skill --dry-run` directly" },
  },

  // ---- critique implements or pins these itself ----
  { flag: "--prompt-file", arity: 1, critique: { kind: "owned", note: "critique's probe prompt, read from a file" } },
  {
    flag: "--fidelity",
    arity: 1,
    critique: {
      kind: "owned",
      note: "container (default) or hostloop; microvm/protocol/cowork refused (resume continuity unproven there)",
    },
  },
  {
    flag: "--output-format",
    arity: 1,
    critique: { kind: "owned", note: "critique's REPORT format; the inner turns always speak json internally" },
  },
  { flag: "--keep", arity: 0, critique: { kind: "owned", note: "accepted as a no-op — critique always keeps its runs" } },
];

/** Flags `critique` defines that the `skill` lane does not have. Kept separate so the parity guard can
 *  treat them as legitimately-unknown-to-skill rather than drift. */
// `--prompt` is here, not in the surface above: the `skill` lane takes its prompt POSITIONALLY
// (`skill <folder> "<prompt>"`), so there is no `--prompt` flag to have a disposition about. The parity
// guard caught this modelling error on its first run.
export const CRITIQUE_ONLY_FLAGS = ["--evaluator-model", "--dotenv", "--prompt"] as const;

const BY_FLAG = new Map(SKILL_FLAG_SURFACE.map((s) => [s.flag, s]));

export function lookupSkillFlag(name: string): SkillFlagSpec | undefined {
  return BY_FLAG.get(name);
}

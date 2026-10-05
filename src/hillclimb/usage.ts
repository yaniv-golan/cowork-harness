// `hillclimb` usage text and flag lists. Dependency-free on purpose (the eval/usage.ts precedent): the
// usage-guard registry in src/run/cassette.ts imports these, so this module must not import anything that
// imports cassette.ts.

export const HILLCLIMB_RUN_BOOLEAN_FLAGS = ["--approve-harness", "--ablate", "--dry-run", "--no-copy-inputs"] as const;
export const HILLCLIMB_RUN_VALUE_FLAGS = [
  "--flow",
  "--variant",
  "--model",
  "--effort",
  "--reps",
  "--concurrency",
  "--timeout-s",
  "--judge-model",
  "--decider-cmd",
  "--decider-dir",
  "--skill",
  "--output-format",
  "--dotenv",
  "--run-dir",
] as const;
export const HILLCLIMB_RUN_REPEATED_FLAGS = ["--case"] as const;
/** `hillclimb regrade`'s own booleans (its value flags are a subset of run's). */
export const HILLCLIMB_REGRADE_VALUE_FLAGS = ["--flow", "--variant", "--judge-model", "--output-format"] as const;
export const HILLCLIMB_REGRADE_BOOLEAN_FLAGS = [
  "--approve-harness",
  "--fill-refs",
  "--rejudge",
  "--allow-doc-drift",
  "--allow-unchecked",
  "--allow-scrub-change",
] as const;

export const HILLCLIMB_RUN_USAGE = `usage: hillclimb run <scenario.yaml | dir/> [--flow DIR] [--variant ID] [--model ID] [--effort LEVEL] [--reps N]
       [--concurrency N] [--timeout-s N (0 = no ceiling)] [--approve-harness] [flags]
       The runner for /claude-api hillclimb: runs every scenario --reps times into <flow>/<variant>/ with the
       runner-scaffold contract (results.jsonl, errors.jsonl, traces/, progress.txt, summary.json). Exit 0 all
       attempts ok, 1 any failed attempt or a mid-run stop, 2 refused before spending. See docs/cli.md.
  --flow DIR              flow directory (default .claude/hillclimb/flow)
  --variant ID            'baseline' or 'v<N>' (default baseline)
  --model ID              concrete model id the agent must be served by; an alias is refused
  --effort LEVEL          the effort the agent is asked for: low|medium|high|xhigh|max (extra = xhigh);
                          default the session's effort:, else the baseline default. Levels are per model:
                          one the model does not offer, or any on a model with no effort
                          selector, is refused before spend. Each row records it
                          (meta.effort) and the effort the agent sent (meta.effort_sent); a mismatch is
                          an error row. Not in the harness sha: keep one value per variant
  --reps N                reps per case (default 1)
  --concurrency N         jobs in flight (default 4; a decider needs --concurrency 1)
  --timeout-s N           per-case wall-clock ceiling in seconds (default 1800; 0 = none)
  --approve-harness       record the harness sha, and a sha256 per hashed file, in _state.json (yours to
                          pass, never the loop's)
  --case ID               run only this case (file stem or scenario name); repeatable
  --ablate                run with the skill removed (the null run); use a sibling flow dir
  --dry-run               print the resolved scope, gate status and estimate; spend nothing
  --judge-model ID        concrete judge model for every semantic assertion
  --skill NAME            the plugin skill whose invocation the rows record (skill_invoked): a skill
                          directory's name or its registered name; needed when the plugin registers
                          several skills. It joins the harness sha, so changing it needs
                          --approve-harness; pass the same --skill on every pass
  --no-copy-inputs        do not copy session uploads into <flow>/inputs/
  --decider-cmd CMD | --decider-dir DIR   answer unscripted questions (one channel; --concurrency 1)
  --output-format text|json   json: one envelope on stdout at exit
  --dotenv FILE  --run-dir DIR   as on every command`;

export const HILLCLIMB_CHECK_USAGE = `usage: hillclimb check [<scenario.yaml | dir/>] [--flow DIR] [--output-format text|json]
       Checks a flow dir against our reading of the published hillclimb schema, plus _state.json's metric
       declarations, and warns when a baseline case has no headroom. It warns about a case whose rows were graded
       under another assertion set than its scenario's now: the scenario target given, else the scenario files
       the last --approve-harness hashed (_state.json harness_files), else those harness_paths lists; a note
       names each case not compared (nothing recorded, a recorded scenario not found from this directory, a
       case the target lacks). Warnings never change the exit code. Exit 0 clean, 1 findings, 2 usage (a target that does not load included).`;

export const HILLCLIMB_STATE_TEMPLATE_USAGE = `usage: hillclimb state-template <scenario.yaml | dir/> [--flow DIR] [--skill NAME] [--output-format text|json]
       Prints a _state.json skeleton for the loop to save: the metrics every row carries, the perf columns and
       the files the harness gate digests. With --flow, also writes the metrics legend to <flow>/metrics.md
       (an existing copy that differs is kept; the new legend goes to metrics.md.new). json: the envelope
       also carries it as metrics_md. --skill NAME is checked against the plugin as run's is (an unknown
       skill exits 2, naming the plugin's skills); with several skills and no --skill, or no skill at all,
       skill_invoked is left out of perf_fields.`;

export const HILLCLIMB_FREEZE_REF_USAGE = `usage: hillclimb freeze-ref <scenario.yaml | dir/> --variant ID [--flow DIR] [--case ID]... [--output-format text|json]
       Freezes each selected semantic_pairwise case's reference into <flow>/<variant>/ref from the variant's
       lowest-rep good row (status ok, not an agent failure, verdict and pairwise evidence measured), under the
       variant's lock. A baseline pass freezes the baseline's itself; freeze a later variant's to compare the next
       ones with it (win_<vN>). An entry already complete is reported, never rewritten. An entry lacking a compose
       key gains it from its own run only when this process's scrub set provably covers that run's (else the case is
       refused: re-run the variant). Exit 0 nothing refused, 1 a case refused, 2 usage.`;

export const HILLCLIMB_REGRADE_USAGE = `usage: hillclimb regrade <scenario.yaml | dir/> [--flow DIR] [--variant all|baseline|vN] [--case ID]...
       [--judge-model ID] [--fill-refs | --rejudge] [--approve-harness] [--allow-doc-drift] [--allow-unchecked]
       [--allow-scrub-change] [--output-format text|json] [--dotenv FILE] [--run-dir DIR]
       Rebuilds a flow's scored rows from the scenario as it is now and their kept run dirs (no agent run), rewriting
       results.jsonl atomically (the prior file kept as regrade-<sha>.bak.jsonl, a before/after in <variant>/regrade.md).
       Every row is re-evaluated first, with no judge call: its deterministic asserts and expect_denied hosts with
       verify-run's evaluation (an assert unchanged since the run keeps its live outcome), its metrics re-measured from
       the kept work dir. Default: a judged assert is re-judged only when its judge's inputs changed (the assert, the
       judge prompt, the judge model it would ask for — --judge-model, the pin, or the env/default — a pairwise reference or its
       content); the rest keep their entries, at no judge cost. A row whose judged evidence the current harness
       composes differently than it was graded on is listed and kept (--rejudge grades it on the current evidence,
       unless it is less redacted: then only --rejudge --allow-scrub-change). A row that would re-judge an assert whose
       literal the run scrubbed and this process's scrub does not reproduce is listed too: --allow-scrub-change re-judges
       it, the judge then seeing the raw rubric against the scrubbed evidence (its grade may not match the live run's).
       A row whose judge input (the pairwise task line, a new or edited rubric line, an evidence note, a reference)
       cannot be proven scrubbed with a set covering its run's is listed (a run before 4.4 records no scrub-set
       fingerprint, so its new or edited rubric text is listed until the case is re-run): --allow-scrub-change sends it
       anyway, recorded as scrubAcceptedBy. Neither --rejudge nor --allow-doc-drift implies it.
       An edit inside a scrubbed literal cannot be applied: that row is listed until the case is re-run.
       --rejudge: re-judge every judged assert. --fill-refs: only the pairwise comparisons a row lacks are judged (a
       reference frozen after it), so pass cannot move and every row carries every win column. Gated like run. Exit 0
       rewritten or nothing to do, 1 some rows listed (not re-graded) or a failure after the first judge call, 2 refused
       before any judge call.`;

/** The whole family: `hillclimb --help`, and the usage guard's text (every flag of every subcommand). */
export const HILLCLIMB_USAGE = `usage: hillclimb <run | check | state-template | freeze-ref | regrade> ...

${HILLCLIMB_RUN_USAGE}

${HILLCLIMB_CHECK_USAGE}

${HILLCLIMB_STATE_TEMPLATE_USAGE}

${HILLCLIMB_FREEZE_REF_USAGE}

${HILLCLIMB_REGRADE_USAGE}`;

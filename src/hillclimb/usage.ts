// `hillclimb` usage text and flag lists. Dependency-free on purpose (the eval/usage.ts precedent): the
// usage-guard registry in src/run/cassette.ts imports these, so this module must not import anything that
// imports cassette.ts.

export const HILLCLIMB_RUN_BOOLEAN_FLAGS = ["--approve-harness", "--ablate", "--dry-run", "--no-copy-inputs"] as const;
export const HILLCLIMB_RUN_VALUE_FLAGS = [
  "--flow",
  "--variant",
  "--model",
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

export const HILLCLIMB_RUN_USAGE = `usage: hillclimb run <scenario.yaml | dir/> [--flow DIR] [--variant ID] [--model ID] [--reps N]
       [--concurrency N] [--timeout-s N (0 = no ceiling)] [--approve-harness] [flags]
       The runner for /claude-api hillclimb: runs every scenario --reps times into <flow>/<variant>/ with the
       runner-scaffold contract (results.jsonl, errors.jsonl, traces/, progress.txt, summary.json). Exit 0 all
       attempts ok, 1 any failed attempt or a mid-run stop, 2 refused before spending. See docs/cli.md.
  --flow DIR              flow directory (default .claude/hillclimb/flow)
  --variant ID            'baseline' or 'v<N>' (default baseline)
  --model ID              concrete model id the agent must be served by; an alias is refused
  --reps N                reps per case (default 1)
  --concurrency N         jobs in flight (default 4; 1 with a decider)
  --timeout-s N           per-case wall-clock ceiling in seconds (default 1800; 0 = none)
  --approve-harness       record the harness sha in _state.json (yours to pass, never the loop's)
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

export const HILLCLIMB_CHECK_USAGE = `usage: hillclimb check [--flow DIR] [--output-format text|json]
       Checks a flow dir against our reading of the published hillclimb schema, plus _state.json's metric
       declarations, and warns when a baseline case has no headroom. Exit 0 clean, 1 findings, 2 usage.`;

export const HILLCLIMB_STATE_TEMPLATE_USAGE = `usage: hillclimb state-template <scenario.yaml | dir/> [--flow DIR] [--skill NAME] [--output-format text|json]
       Prints a _state.json skeleton for the loop to save: the metrics every row carries, the perf columns and
       the files the harness gate digests. With --flow, also writes the metrics legend to <flow>/metrics.md
       (an existing copy that differs is kept; the new legend goes to metrics.md.new). json: the envelope
       also carries it as metrics_md. --skill NAME is checked against the plugin as run's is (an unknown
       skill exits 2, naming the plugin's skills); with several skills and no --skill, skill_invoked is left
       out of perf_fields.`;

/** The whole family: `hillclimb --help`, and the usage guard's text (every flag of every subcommand). */
export const HILLCLIMB_USAGE = `usage: hillclimb <run | check | state-template> ...

${HILLCLIMB_RUN_USAGE}

${HILLCLIMB_CHECK_USAGE}

${HILLCLIMB_STATE_TEMPLATE_USAGE}`;

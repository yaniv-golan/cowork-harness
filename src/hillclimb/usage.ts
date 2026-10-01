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
  "--output-format",
  "--dotenv",
  "--run-dir",
] as const;
export const HILLCLIMB_RUN_REPEATED_FLAGS = ["--case"] as const;

export const HILLCLIMB_RUN_USAGE = `usage: hillclimb run <scenario.yaml | dir/> [--flow DIR] [--variant ID] [--model ID] [--reps N]
       [--concurrency N] [--timeout-s N (0 = no ceiling)] [--approve-harness] [flags]
       The runner for /claude-api hillclimb: runs every scenario --reps times into <flow>/<variant>/ with the
       runner-scaffold contract (results.jsonl, errors.jsonl, traces/, progress.txt, summary.json). Exit 0 all
       attempts ok, 1 any failed attempt or a mid-run stop, 2 refused before spending. See docs/hillclimb.md.
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
  --no-copy-inputs        do not copy session uploads into <flow>/inputs/
  --decider-cmd CMD | --decider-dir DIR   answer unscripted questions (one channel; --concurrency 1)
  --output-format text|json   json: one envelope on stdout at exit
  --dotenv FILE  --run-dir DIR   as on every command`;

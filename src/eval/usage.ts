// `eval` usage text and flag lists. Dependency-free on purpose: the usage-guard registry in
// src/run/cassette.ts imports these, and the eval command imports cassette.ts, so this module must not.

export const EVAL_BOOLEAN_FLAGS = ["--allow-underpowered", "--include-untracked", "--allow-identical-arms", "--quiet"] as const;
export const EVAL_VALUE_FLAGS = [
  "--reps",
  "--model",
  "--judge-model",
  "--concurrency",
  "--alpha",
  "--correction",
  "--fail-on",
  "--out",
  "--output-format",
  "--skill",
  "--on-unanswered",
  "--decider-cmd",
  "--decider-dir",
  "--dotenv",
  "--run-dir",
] as const;
export const EVAL_REPEATED_FLAGS = ["--arm", "--holdout"] as const;

export const EVAL_USAGE = `usage: eval <scenario.yaml | dir/> --arm [<label>=]<source> --arm [<label>=]<source> [flags]
       eval report <eval-dir> [--output-format text|json]
       EXPERIMENTAL — paired A/B evaluation of a skill edit: runs every scenario with each arm's plugin in place
       of the session's single plugins.local_plugins entry, interleaved, and compares per-claim pass rates.
       A drop is a signal to investigate, not proof. Live runs only (no replay, no cassettes). See docs/eval.md.
  --arm [<label>=]<source>   exactly two. The FIRST is A (the baseline); a drop is B below A. <label> matches
                             [a-z0-9_-]{1,32} (default before/after). <source>: a plugin directory, or
                             git:<ref>:<path> (path relative to the root of the repository containing the cwd).
                             Each arm is snapshotted once, before any run, into <eval-dir>/arms/<label>/.
  --reps <n>                 reps per arm per scenario (default 5; below 4 is refused without --allow-underpowered).
                             --reps 5 tolerates one lost rep per arm before a row is 'insufficient'.
  --allow-underpowered       accept --reps 2..3; rows whose exact test cannot reach --alpha are labelled
                             'underpowered', never 'no detectable change'
  --model <id>               the agent model; it (or the session's model:) must be a CONCRETE id, not an alias
  --judge-model <id>         grade every semantic_matches assert with this concrete model (per-assert judge_model
                             is then inert); without it every live judge model must be concrete
  --concurrency <n>          jobs in flight (default 2, 1..8); must be 1 with --decider-cmd/--decider-dir
  --alpha <a>                per-row level for 'possible' and Holm's family-wise level (default 0.05)
  --correction bh|holm       multiple-comparison correction for 'confirmed' (default bh at a fixed q = 0.10;
                             holm at --alpha is stricter). Runs within each report section.
  --holdout <scenario.yaml>  repeatable; must be one of the eval's scenarios. Reported (and corrected) in a
                             separate held-out section — scenarios you tuned the skill against are weak evidence.
  --include-untracked        snapshot a directory arm's untracked files too (the raw walk); not with a git: arm
  --allow-identical-arms     run even when both arms hash identically (an A/A noise run)
  --fail-on possible|confirmed  opt in to gating: exit 1 on a drop at this level. Without it no drop fails the
                             eval (every row insufficient, or a judge disagreement, still exits 1). At --reps 5 a single collapsed row reaches
                             'possible' but, with 13 or more rows under bh, cannot reach 'confirmed' alone; the
                             start-up notice prints how many rows 'confirmed' needs. An A/A run under
                             --fail-on possible can exit 1 on noise.
  --skill <name>             the skill whose invocation each rep records (needed for a plugin with several
                             skills; without a single skill the invocation fact is 'unobservable')
  --out <dir>                the eval directory (default ~/.cowork-harness/evals/<eval-id>); refused inside a git
                             work tree, where the stager would mount the snapshots empty
  --on-unanswered fail|first, --decider-cmd '<helper>', --decider-dir <dir>   answer path, as on 'run'
  --output-format text|json  json: {tool,version,command,ok,evalDir,arms,pins,sections,summary,cost,stoppedEarly,error}
  --quiet                    no per-job progress lines
  --dotenv <path>, --run-dir <path>   as on every command
       No run label or session id is accepted: eval labels each run eval:<eval-id>:<arm> and gives each job its own session.
       exit codes: 0 completed (with --fail-on: and no drop at that level) · 1 a drop at the --fail-on level,
       every row insufficient, a row insufficient only because the candidate refused more semantic_matches
       grades for unavailable evidence, or the judge model differed across reps · 2 usage, or a refusal before any
       run · 3 an arm snapshot could not be copied, or failed its staging preflight`;

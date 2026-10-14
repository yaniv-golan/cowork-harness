// `eval` usage text and flag lists. Dependency-free on purpose: the usage-guard registry in
// src/run/cassette.ts imports these, and the eval command imports cassette.ts, so this module must not.

export const EVAL_BOOLEAN_FLAGS = [
  "--allow-underpowered",
  "--include-untracked",
  "--allow-identical-arms",
  "--quiet",
  "--dry-run",
  "--allow-confounded-pool",
  "--allow-mixed-pool",
] as const;
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
  "--target-effect",
  "--max-budget-usd",
  "--search-corpus",
  "--search-corpus-miss",
  "--search-corpus-min-score",
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
                             holm at --alpha is stricter). Runs within each report section. Metric rows (a
                             scenario's metrics:) are their own family: holm at --alpha split across the section's
                             families by default (0.025 beside pass rows); with an explicit bh, BH at q = 0.10, no split
  --holdout <scenario.yaml>  repeatable; must be one of the eval's scenarios. Reported (and corrected) in a
                             separate held-out section — scenarios you tuned the skill against are weak evidence.
  --include-untracked        snapshot a directory arm's untracked files too (the raw walk); not with a git: arm
  --allow-identical-arms     run even when both arms hash identically (an A/A noise run)
  --fail-on possible|confirmed  opt in to gating: exit 1 on a drop, or a metric that got worse, at this level. Without it no drop fails the
                             eval (every row insufficient, a scenario that compared nothing, a metric row not compared, or a
                             judge disagreement still exits 1; see exit codes below). At --reps 5 a single collapsed row reaches
                             'possible' but, with 13 or more rows under bh, cannot reach 'confirmed' alone; the
                             start-up notice prints how many rows 'confirmed' needs. An A/A run under
                             --fail-on possible can exit 1 on noise.
  --skill <name>             the skill whose invocation each rep records (needed for a plugin with several
                             skills; without a single skill the invocation fact is 'unobservable')
  --out <dir>                the eval directory (default ~/.cowork-harness/evals/<eval-id>); refused inside a git
                             work tree, where the stager would mount the snapshots empty
  --on-unanswered fail|first, --decider-cmd '<helper>', --decider-dir <dir>   answer path, as on 'run'
  --dry-run                  plan only: print what the eval would cost at --reps (p50, mean, p95, worst observed, from
                             this runs dir's history of each scenario on its tier and baseline) and what each row could
                             detect (minimum detectable change, power), then exit 0. Runs no agent and creates no eval
                             dir; every refusal the real eval makes before its first run still applies.
  --target-effect <pp>       with --dry-run: the change to size for, in percentage points (30pp or 30, 1..100); the plan
                             adds the smallest --reps that detects it per row, its power, and the cost at that --reps
  --max-budget-usd <x>       refuse before any run (exit 2) when the scenarios' worst observed runs, times the jobs
                             scheduled, exceed x. A pre-flight from history only: the eval is never stopped mid-way, and
                             judge spend is not counted. With no priced history the check is a LOWER BOUND, and says so.
  --search-corpus <pool>     serve both arms' web searches from one recorded pool (search-pool build), copied into the
                             eval dir and pinned by hash; hostloop only. A frozen corpus holds search fixed: it cannot
                             evaluate a change to what or when the skill searches (evaluate that live; or run a live eval of
                             the search change, then a frozen eval with a pool built evenly from both versions' live runs).
                             Refused before any run when the pool's records come from one arm (or one arm holds more than
                             60% of them); the report prints both arms' search metrics side by side and marks the
                             comparison CONFOUNDED when they were served unequally (placeholder thresholds)
  --search-corpus-miss empty|error, --search-corpus-min-score <n>   as on run
  --allow-confounded-pool    run a pool drawn from one arm (or whose split cannot be bounded); every surface says CONFOUNDED
  --allow-mixed-pool         accept a pool built with --mixed (several skills)
  --output-format text|json  json: {tool,version,command,ok,evalDir,arms,pins,sections,summary,cost,stoppedEarly,searchCorpus?,error};
                             with --dry-run: {tool,version,command,ok,dryRun,plan,budget?,error}
  --quiet                    no per-job progress lines (a --dry-run's plan is its output, and still prints)
  --dotenv <path>, --run-dir <path>   as on every command
       No run label or session id is accepted: eval labels each run eval:<eval-id>:<arm> and gives each job its own session.
       exit codes: 0 completed (with --fail-on: and no drop at that level) · 1 a drop or a worse metric at the --fail-on level
       (under possible, also an insufficient_refusals row: the candidate refused ≥ 2 more semantic_matches
       grades for unavailable evidence than the baseline, and that excess took the row below the threshold; or an
       insufficient_unmeasured metric row, the same for metric values the scorer or a cap left out),
       every row insufficient, a scenario that compared nothing (every rep of both arms errored, or every rep of one arm
       was an infrastructure failure), a metric row not compared (a broken metric state), or the judge model differed
       across reps, or (with --search-corpus) any rep not served from the pinned pool · 2 usage, or a refusal before any
       run (including the --max-budget-usd refusal, a one-sided or mixed pool, and a pool that cannot be read) · 3 an arm
       snapshot or the pool copy could not be made, or failed its staging preflight. --dry-run: 0 plan printed · 2 any refusal the real eval would make before its first run · 3 as above, or the
       temp dir is inside a git work tree, or git cannot tell whether it is (set TMPDIR)`;

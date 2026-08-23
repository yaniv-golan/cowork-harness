# CI recipe — replay vs live lanes

Self-contained reference. Tracks `cowork-harness 2.0.1` (baseline `desktop-1.34493.1`).

**Fastest path: the packaged Action.** One step gets you `replay`/`lint`/`verify-cassettes` plus a PR
job-summary reporter (verdict table, staleness findings, cost/turns when available):

```yaml
- uses: yaniv-golan/cowork-harness@v2
  with:
    command: replay
    path: cassettes/
    version: "^2"              # hold the major; see below
```

**These recipes pin `version: "^2"`.** The Action's `version` input *defaults* to `latest`, which means a
CLI major reaches your workflow the moment it is promoted even though your `uses:` ref never changed — so a
copy-pasted recipe that omits the input takes a major bump with no say in it. `^2` holds the major, needs no
patch number to remember, and only wants a human decision at the next major. Pin an exact version
(e.g. `version: "2.0.1"`) instead when you want byte-reproducible CI.

Reach for the manual multi-step form below only when you need per-step control the Action's inputs don't
cover (a custom flag combination, a different runner matrix per step, or `lint`/`verify-cassettes` gated
independently instead of as one action run per command).

**Live lane (`command: run`) with the packaged Action — self-hosted runner, you stage the binary.** The
Action never downloads or provisions the agent ELF itself — by design, not an oversight (see "the
realistic CI shape" below for why). Stage it yourself as an explicit step in *your own* workflow, then
point the Action at it:

```yaml
jobs:
  live:
    runs-on: [self-hosted, linux, arm64]   # needs Docker + this staged ELF; not a stock GitHub-hosted runner
    steps:
      - uses: actions/checkout@v4
      - name: Stage the agent binary (official channel, sha256-verified against the pinned baseline)
        run: |
          V=2.1.237   # match your scenario's pinned baseline's agentVersion
          # The expected digest is baselines/desktop-<ver>.json -> agentBinary.sha256. Paste it here, or
          # read it with jq if you vendor the baseline. An unverified download is an unverified agent:
          # this step FAILS rather than staging one, which is the whole point of naming it "verified".
          EXPECTED=<paste agentBinary.sha256 for $V>
          curl -fSL "https://downloads.claude.ai/claude-code-releases/$V/linux-arm64/claude" -o "$RUNNER_TEMP/claude-$V"
          echo "$EXPECTED  $RUNNER_TEMP/claude-$V" | sha256sum -c -
          chmod +x "$RUNNER_TEMP/claude-$V"
          echo "COWORK_AGENT_BINARY=$RUNNER_TEMP/claude-$V" >> "$GITHUB_ENV"
          # Background on the provenance chain: the "Agent-binary provenance" section of
          # https://github.com/yaniv-golan/cowork-harness/blob/main/docs/maintenance.md
      - uses: yaniv-golan/cowork-harness@v2
        with:
          command: run
          path: scenarios/
          version: "^2"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Why this is a step *you* write, not an Action input the harness provides for you: pulling Anthropic's
binary is a call about your own relationship with their distribution terms — keeping it in your own
version-controlled workflow keeps that decision and its execution yours, auditable, and outside any
third-party action's code. The agent-binary provenance runbook ([`docs/maintenance.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/maintenance.md) in the repo —
not shipped with the installed skill) has the full recovery/verification story (including why
`COWORK_AGENT_BINARY` substitutions are
sha256-*checked* but not hard-blocking on mismatch — it's advisory for an intentional substitution).

**Minimal token-free PR gate (manual form)** — the smallest thing worth committing; runs on stock
GitHub-hosted runners, no token/Docker/agent:

```yaml
- run: npm i -g "cowork-harness@^2.0.1"
- run: cowork-harness lint scenarios/*.yaml --strict --min-severity WARN
                                                    # no silent false-greens. WITHOUT --strict this
                                                    # step cannot fail on a WARN-class rule (e.g.
                                                    # vacuous-gate-assert) — it would print the
                                                    # finding and still exit 0. --min-severity WARN
                                                    # keeps the advisory INFO class advisory — pair them.
                                                    # Bare `lint --strict` fails on INFO too, which reds
                                                    # on scenarios that are perfectly fine. (`lint-skill
                                                    # --strict` never fails on INFO: same flag name, a
                                                    # different rule. Do not carry one over to the other.)
- run: cowork-harness verify-cassettes cassettes/    # privacy + staleness — FAILS on a stale recording
                                                    # ALSO fails on a leaked host inventory: recording at
                                                    # protocol/hostloop freezes YOUR machine's MCP servers,
                                                    # agents and account org into the cassette. Record
                                                    # committed fixtures at `container` (sealed) to avoid it.
- run: cowork-harness replay cassettes/              # token-free content/structure
```

If a cassette has MOVED (a `git mv`, a repo reorg, a copy between projects), staleness becomes
unverifiable — `verify-cassettes` exits 3 and says the skill dirs are not resolvable. Recover with
`--session <file>` on either command rather than re-recording:

```yaml
- run: cowork-harness verify-cassettes cassettes/moved.cassette.json --session sessions/default.yaml
```

It takes a session (not skill dirs) so `staleness.hash_ignore` survives, refuses a directory target,
and echoes the dirs it resolved. Full contract:
[docs/cassette.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/cassette.md).

Both lines matter: for the CONTENT-drift classes (`skill`, `shared-root`) `replay` alone **warns** and
exits 0, so dropping the
`verify-cassettes` step means a skill edit silently stops being tested. (One command instead of two:
`replay --fail-on-skill-drift`.)

The rest of this doc explains the lane split, recording, privacy, and the full pipeline + live job.

## The core split: token-free PR gate + live nightly (self-hosted)

### `extra-args` and the version it silently requires

The packaged Action builds `path` and `extra-args` **verbatim** into the invocation, for whatever
subcommand you name — it is not a validated allowlist. That makes `extra-args` the way to pass a flag the
Action has no input for, and it creates a coupling nothing checks:

> **If a flag in `extra-args` was added in release X, floor that step's `version` to `>=X`.**

`version` defaults to `latest`, and accepts **any npm range** — not just an exact pin. Leave it off unless
you have a reason:

```yaml
- uses: yaniv-golan/cowork-harness@v2
  with:
    command: lint
    path: scenarios/
    version: "^2"                       # holds the major
    extra-args: --min-severity WARN     # needs a CLI >= 1.11.0; any 2.x satisfies that
```

**If a flag you pass in `extra-args` landed in a specific release, bound the range — don't write a bare
floor.** `>=1.11.0` reads as "at least 1.11.0" and silently means "and every future major too", so a
recipe written that way hands a copy-paster the next major with no say in it. Anchor it at the current
major instead — `version: "^2"`, which is what the steps above use — keeping the floor's intent while
stopping at the major boundary. An exact
pin (`version: "2.0.1"`) is the right choice when you want byte-reproducible CI, at the cost of rotting the
moment a recipe adopts a newer flag.

Without a satisfied floor, an older CLI fails the step with `unrecognized arguments: --min-severity WARN`
(exit 2, wrapped in an `ok:false` envelope) — it does **not** degrade gracefully.


The harness has two execution lanes with different cost, coverage, AND infrastructure requirements.
The split is not just about tokens — it decides **where each lane can run**:

- **`replay` / `verify-cassettes` (token-free, agent-free).** Replays a recorded cassette
  (`events.jsonl` + `control-out.jsonl`) and lints the committed cassettes. **No model tokens, no
  Docker, no agent binary** — runs on a stock GitHub Actions runner. Evaluates **content** assertions —
  `transcript_*`, `tool_*`, `subagent_*`, `dispatch_count_max`, `skill_triggered`, `no_skill_triggered`,
  `max_cost_usd`, `max_tokens`, `tool_calls_max`, `result`, and the verdict modifiers
  `allow_permissive_auto_allow` / `allow_missing_capability` / `allow_l0_plugin_divergence` /
  `allow_stall` (no-op passes); plus the gate keys `question_asked` / `question_options` /
  `questions_count_max` / `gate_answers_delivered` **if** the cassette has `controlOut`, and the manifest keys
  (`file_exists` / `user_visible_artifact` / `artifact_json` / `artifact_text`) **if** it carries an artifact
  manifest. `file_absent` is in neither class — it is live/verify-run only.
  **That list is illustrative, not the authoritative set** — more keys are replay-checkable than fit a
  paragraph, and a hand-typed enumeration is exactly what goes stale. For the current set, ask the CLI:

  ```bash
  cowork-harness assertions --list --output-format json   # every key + its one-line semantics
  ```

  It emits `{key, description}` — there is no structured replay-class field to filter on; the
  live-only / manifest / `controlOut` preconditions are stated in each key's `description` prose and,
  in full, in the catalog's replay-class tables in
  [`references/scenario-schema.md`](./scenario-schema.md).

  **`replay --mutate`** is a distinct, reporting-only diagnostic on this same lane: it perturbs each
  recorded JSON artifact value one at a time, re-runs the assertions against the perturbed cassette,
  and reports which perturbations NOTHING caught — those are the fields your `assert:` block leaves
  unguarded. It never changes the verdict or exit code (it's coverage information, not a check), so
  don't wire it into a pass/fail gate — read its `::warning::`/`::notice::` output to find `assert:`
  gaps to close.

  Placing a key on this gate from a doc list rather than from `assertions --list` is how a valid
  replay-lane check ends up left off the PR gate. Filesystem/egress assertions are
  skipped on this token-free lane — loudly: replay emits an `::warning::` annotation whenever it drops
  one (see [docs/cassette.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/cassette.md)). This is your **always-on PR gate**. With `--output-format json`, read each
  `results[].verdict.{pass,signals}` for **per-cassette** pass/fail and the reason (the top-level `ok`
  collapses the whole batch) — e.g. a `stalled` signal fails a cassette whose assertions all passed.
  The PR gate evaluates the **whole scenario frozen in the cassette** (`lane:`/`fidelity:`/`baseline:` too,
  not only `assert:`) — a YAML edit cannot move this gate's verdict. To re-check against an edited on-disk
  `assert:` without a paid re-record, use `replay --assert-from <scenario.yaml>` (or `--reassert`); any other
  edited key needs a re-record.
- **`run` / `record` (live).** Spawns the real agent in a sandbox: real model tokens + Docker **+ the
  staged Claude Code agent ELF**, bind-mounted from a local Claude Desktop install or pointed to via
  `COWORK_AGENT_BINARY`. Nothing is bundled, and **the agent binary is not redistributable** — a clean
  GitHub-hosted runner has neither Desktop nor the ELF. So the live lane is **self-hosted / local-runner
  only**. Evaluates **every** assertion (filesystem/egress/boundary). This is your **nightly /
  pre-release job**, and recording new cassettes happens here too.

> **The realistic CI shape:** the replay gate + `verify-cassettes` run in stock GitHub Actions on every
> PR; recording and the live nightly run on your machine or a self-hosted runner that has the agent
> binary. Don't expect a "download the agent in CI" path — there isn't one (it's Anthropic's staged
> binary, not ours to ship).

The cardinal rule: **a replay PR gate cannot verify a boundary** (egress / filesystem-deny) — it has
no live filesystem and no network — and it verifies an artifact's *content* only when the cassette
carries an `artifacts` manifest (recorded `outputs/` + connected folders; then `file_exists` /
`user_visible_artifact` / `artifact_json` evaluate on replay). On a manifest-less cassette the
deliverable is invisible to the gate. Don't let a green replay gate convince you the deliverable is correct.
Run `cowork-harness lint` (the bundled `scenario.py lint`) in CI to catch a scenario that put a
filesystem/egress-only check on the replay lane (a silent no-op). Author new scenarios with
`scenario.py scaffold` so they start from a valid, self-linted skeleton.

## Recording a cassette

```bash
cowork-harness record scenarios/my-test.yaml      # live run that also writes the cassette
cowork-harness record scenarios/                  # batch: record every scenario in the dir
cowork-harness record cassettes/ --rerecord-stale # re-record ONLY the cassettes whose fingerprint drifted
cowork-harness replay cassettes/my-test.cassette.json  # token-free re-evaluation of content assertions
cowork-harness replay cassettes/                   # replay every *.cassette.json in the committed dir
```

Re-record whenever the protocol or your scenario's expected content changes. An old cassette without
`controlOut` excludes the gate keys (with a loud warning) — re-record to enable them. `record` **refuses
to freeze a failing live run** into a cassette (pass `--allow-failing` to override) — a committed red
cassette is a latent false-signal.

## Privacy: cassettes are committed fixtures → record only against SYNTHETIC inputs

A cassette snapshots the transcript **and** the `outputs/` JSON bodies (cap tables, instruments, names,
dollar figures). In a skill repo these cassettes get **committed**. So:

- **Record against synthetic data only** (e.g. "Cadence / Acme", made-up numbers) — never a real
  customer's cap table.
- **Opt-in redaction** rewrites configured PII out of the cassette at record time. Drop a
  `.cowork-redact.json` next to your scenarios (or set `COWORK_HARNESS_REDACT_PATTERNS` /
  `_KEYS`); empty by default. The policy is searched in **cwd → the scenario's dir → the cassette's
  dir** (first file found per dir; env vars merge on top). `cowork-harness init-redact` copies the
  packaged reference template (local-path prefixes + a generic email regex) into the cwd as a starting
  point — review and tailor it. Redaction is **verdict-preserving** — `record` refuses to write if
  redaction would flip an assertion (a manufactured green). `--no-redact` skips it for known-synthetic
  inputs.
- **Pre-spawn preflight**: `record` warns (`::warning::`, before the paid run starts — once per batch
  for `record <dir>` / `--rerecord-stale`) when a scenario about to record at a host-path-bearing tier
  (`hostloop`, `protocol`) has an **empty** redaction policy — that combination commits real host paths
  the `path` scanner then hard-fails at `verify-cassettes` time. The always-on scanner remains the
  universal net (container-tier recordings can trip it too).
- **Host-inheriting record refused by default — `--allow-host-inventory-fixture` is the consent.** A
  `protocol`/`hostloop`/`cowork`-resolving-to-hostloop record into a repo-visible cassette path would
  freeze THIS machine's MCP server names, agents, and account metadata into a committed fixture, so
  `record` refuses **before the paid spawn**. Pass `--allow-host-inventory-fixture` only when the
  recording session genuinely has no personal MCP servers or plugins to leak — it is a per-record
  boolean consent, not a pattern.

  Two details that matter for a re-record loop. The pre-spend check **warns rather than refuses when the
  cassette already exists**, deliberately: refusing there would fire on every `--rerecord-stale` pass and
  make the escape flag reflexive. And it is a **prediction** — it reads the tier and the destination path,
  never the resulting bytes, so it can be wrong in both directions.

  So `record` also checks the **evidence**. After redaction and before the write, the finished cassette is
  scanned; a `host-inventory` or `machine-inventory` finding on a repo-visible path is **quarantined** —
  written to `<runs-root>/quarantine/` (honouring `--run-dir`/`COWORK_HARNESS_RUNS_DIR`) with a
  `.findings.txt` sibling naming what leaked, and the command fails without writing the path you asked for.
  The recording is not discarded; you paid for it. Only the machine-identity classes trigger this —
  `email`/`currency`/`domain`/`path` are frequently legitimate scenario content, and a gate that fires on
  those just teaches you to pass the escape flag. Outside a git repo it warns instead: nothing there
  publishes the file by accident.
- **Always-on scan gate** — `verify-cassettes` flags email / currency / bare-domain / local-path /
  machine-inventory matches it finds in the committed cassettes and **exits non-zero**, so "no leak" is
  a gate, not discipline. Non-zero is not one thing, though: exit `1` means verification RAN and found a
  real finding (a PII match, a genuine staleness drift, or scenario-prompt drift); exit `3` means
  verification could NOT complete (an `unverifiable-*`-class staleness finding, a cassette written by a
  newer harness than this one understands, or a malformed/unreadable cassette). A plain `|| true` or `[
  $? -ne 0 ]` tripwire treats both the same — if you need to tell "the gate caught something" apart from
  "the gate couldn't run", branch on the exit code (or parse `--output-format json`'s per-file
  `findings`/`staleness` vs `unverifiable`/`version`/`error` buckets).

  **Do not read `error` as "this file was never scanned".** The privacy scan needs a readable *transcript*
  (an `events` array of strings), not a *valid* cassette — so a file that fails shape validation is still
  scanned, and reports its findings **and** its `error`. Each result carries **`privacyScanned`**, which
  answers that question directly. A gate that must not treat "could not verify" as "verified clean" should
  key on `privacyScanned === false`, where `findings: []` is an absence of evidence rather than evidence of
  absence. `--skip-privacy` also reports `false`, for the same reason.
  Suppress synthetic / public reference names (NVCA, Cooley GO, …) with `--allow <regex>`. (Multi-word
  proper names are NOT a default class — too noisy to gate on; add a pattern via config if your corpus
  needs it.)
- **`--allow-host-inventory <regex>` — the per-finding sibling of the record-time consent above, and a
  different thing from it.** `verify-cassettes` scans a **structural** `host-inventory` class (an
  `mcp_servers[].name`/`agents[]` entry outside the harness's own known set, or `account.email`/
  `.organization`/`.subscriptionType`) over already-committed cassettes. `--allow-host-inventory <regex>`
  suppresses a specific finding there — it is a scanner allowlist entry, not a record-time green light —
  and, like `--allow-domain`/`--allow-email`/`--allow-path`/`--allow-machine-inventory`, scopes the
  pattern to that one class so it can't accidentally clear an unrelated finding.

```bash
cowork-harness verify-cassettes cassettes/                       # privacy scan + staleness — exit 1 = verified & failed, exit 3 = could not verify
cowork-harness verify-cassettes cassettes/ --allow 'NVCA|Cooley GO|Acme'
cowork-harness verify-cassettes cassettes/ --skip-privacy        # staleness only (skip the privacy scan); both run by default
```

## Four-stage pipeline

A typical skill repo runs four stages, fastest/cheapest first:

1. **Unit** — your skill's own tests (pytest/vitest of its scripts). Not the harness's job.
2. **Boundary / lint** — `cowork-harness lint scenarios/*.yaml` (no-silent-false-green invariants; needs
   python3 — PyYAML is bundled) + `cowork-harness verify-cassettes cassettes/` (privacy scan + staleness) +
   `cowork-harness boundary-check` where relevant. Token-free, agent-free. **Don't `|| true` the lint
   step** — a missing python3 (exit 127) or a lint error makes `scenario.py` exit non-zero, and swallowing
   that turns the false-green guard itself into a silent no-op.

   **Add a load gate next to `lint`** — they answer different questions, and `lint` is the more permissive
   of the two (it *warns* on an unknown key; the runtime *refuses* to load one):

   ```bash
   cowork-harness record scenarios/ --dry-run --quiet   # does every scenario LOAD? no tokens, writes nothing
   ```

   This is the shape a CI step wants: **silent on success (no output, exit 0), loud and specific on
   failure** — `--quiet` suppresses the readiness preview but never the `✗ broken:` lines, which name the
   offending file *and* the rejected key, and the step still exits 1. A scenario that lints with only
   warnings can still be unloadable, so a green `lint` is not evidence the suite runs.
3. **Scenarios (replay)** — `cowork-harness replay cassettes/` on every PR (the committed `*.cassette.json`).
   Token-free; content + structure + gate delivery.
4. **Parity / live (nightly, self-hosted)** — `cowork-harness run scenarios/` with a token + Docker +
   the agent binary; full filesystem/egress/boundary coverage. **Self-hosted / local runner only**
   (needs the ELF). Optionally `cowork-harness sync` drift checks against a new Desktop release.

## GitHub Actions sketch

The PR gate below is the manual, step-by-step version of what `uses: yaniv-golan/cowork-harness@v2` does
in one step (see the top of this doc) — reach for this form when you need independent per-command
gating/annotations rather than one action run per command. The nightly live job has no packaged-Action
equivalent yet (the Action's `command: run` mode needs a self-hosted runner with Docker + the agent binary
already provisioned, same as the manual form below).

PR gate (token-free — runs on every push):

```yaml
name: cowork-skill-pr
on: [pull_request]
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - uses: actions/setup-python@v5
        with: { python-version: '3.x' }                                       # python3 only — PyYAML is bundled with the linter
      - run: npm i -g "cowork-harness@^2.0.1"
      - run: cowork-harness lint scenarios/*.yaml                              # no-silent-false-green (needs python3; PyYAML bundled)
      - run: cowork-harness verify-cassettes cassettes/ --output-format json   # privacy + staleness gate
      - run: cowork-harness replay cassettes/ --output-format json             # token-free content/structure
```

Nightly live job — **self-hosted only** (needs the agent ELF, not present on GitHub-hosted runners):

```yaml
name: cowork-skill-nightly
on:
  schedule: [{ cron: '0 7 * * *' }]
jobs:
  live:
    runs-on: [self-hosted, macos, arm64]   # a box with Claude Desktop / COWORK_AGENT_BINARY
    steps:
      - uses: actions/checkout@v4
      # GitHub does NOT expose `secrets` in a job-level `if:`. Gate on a guard STEP's output instead.
      - id: guard
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
            echo "::warning::CLAUDE_CODE_OAUTH_TOKEN not set — skipping live scenario suite."
            echo "live=false" >> "$GITHUB_OUTPUT"
          else
            echo "live=true" >> "$GITHUB_OUTPUT"
          fi
      - if: steps.guard.outputs.live == 'true'
        run: npm i -g "cowork-harness@^2.0.1"
      - if: steps.guard.outputs.live == 'true'
        run: cowork-harness run scenarios/ --output-format json
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          COWORK_HARNESS_RUNS_DIR: runs    # workspace-relative so the upload step can collect them
          # COWORK_AGENT_BINARY: /path/to/claude-code-vm/<ver>/claude   # if not using a Desktop install
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: cowork-run-artifacts
          path: runs/
```

A GitHub-**hosted** runner has no agent binary, so `run`/`record` can't work there — that's why the live
lane is self-hosted. The PR gate above (replay + verify-cassettes) is what runs in hosted CI. Keep the
token in CI **secrets**, never in a `.env` inside a mounted skill/folder (it would be copied into the
sandbox).

## Reading results in CI

`--output-format json` emits a machine envelope on stdout (human output goes to stderr):
`{tool, version, command, ok, results[], error}` — one `RunResult` per scenario. **Overall pass for a
scenario is `verdict.pass`** (envelope-wide: `ok`), and it is strictly stronger than
`result === "success" && assertions.every(pass)`: the verdict also carries ~20 signal codes that fail a run
with no failing assertion at all — `stalled`, `outputs_delete`, `mount_delete`, `host_path_leak`,
`undelivered_deliverables`, `missing_capability`, `permissive_auto_allow`, `ended_with_question`,
`infra_error`, and more. A parser that reimplements the shorter formula greens through every one of them.
Read `ok` / `verdict.pass`, or just use the exit code — a plain `cowork-harness run scenarios/` is already
CI-ready without parsing JSON.

**Telling *why* a run failed, without scraping stderr.** Each result carries a `verdict` whose
`failures[]` is the one place every failure reason is enumerated, in one shape (the same object lands
in `result.json` and in the stdout envelope, by construction). Each entry is
`{kind, assertion?: "<key>", message}`, and **`kind` is the discriminator**:

- **`assertion`** — one of *your* `assert:` items failed; `assertion` names its key (`file_exists`,
  `semantic_matches`, …).
- **`guard`** — a signal you didn't author: `stalled`, `permissive_auto_allow`, `missing_capability`, a
  host-path leak, an `outputs/` delete, an infra or transport error, an unanswered gate.
- **`staleness`** — on `replay --strict` / `--assert-from` / `--reassert`, skill or baseline drift,
  which those modes escalate to a hard failure on purpose (frozen events must not green an edited
  assert against a skill whose current source produces something else).
- **`cassette-format`** — the cassette itself cannot be interpreted: too new a version for this build,
  OR corrupt (duplicate/malformed control frames, a truncated recording). Before 1.25.0 the corrupt
  cases were mis-reported as `assertion`, i.e. as if you had written them.
- **`coverage`** — a `verify-run` answer-coverage miss: a gate the run fired that your `answers:` block
  does not cover.

So `jq '[.results[]? | .verdict.failures[]? | select(.kind=="assertion")] | length'` answers "did MY
assertions pass?" and swapping in `select(.kind=="staleness")` answers "is the cassette stale?", from
the envelope alone. Do not infer either from the exit code: every kind lands on exit 1.

Keep the `.results[]?` hop and the `?` operators. `.results[0]` silently ignores every scenario after
the first when you pass a directory, and a bare `.verdict` does not exist at the envelope root at all —
both read as "no failures" against a run that failed.

> **Do not filter on whether `assertion` is present.** That was the only discriminator before `kind`
> existed and it never worked in both directions: `coverage` entries carry a key too (an internal
> `answer_coverage` marker), so they read as authored asserts, while `guard`, `staleness` and
> `cassette-format` all arrive key-less and indistinguishable from one another.

**For the commands in this recipe, stdout carries the machine envelope and nothing else.** Without
`--output-format json`, `run` / `record` / `replay` / `verify-cassettes` / `status` write their whole
human rendering — warnings, verdict, `status`'s summary line — to **stderr**, and stdout stays empty.
A wrapper that captures only stdout gets an empty log and, if it greps that for a state, a silent false
negative. Capture stderr for the human trail (`2> run.stderr.log`), or ask for JSON and parse stdout.
(Commands whose whole job is to print a value — `--version`, `assertions --list`, `scaffold`, `gates`,
`skill --dry-run` — write it to stdout by design, with or without the flag.)

`verify-cassettes` emits its **own** envelope (`{command, ok, coverage, results[]}` with per-file
`findings`/`staleness`/`unverifiable`/`notes`/`version`/`error`), published as
`schema/verify-cassettes.json` in the npm package. `ok:false` doesn't say *why* — read the buckets, or <!-- npm-only-ok -->
the exit code (`1` = `findings`/`staleness`/`scenarioDrift` populated, a real problem verified & found;
`3` = `unverifiable`/`version`/`error` populated, verification could not complete; a real finding wins
`1` if both are present). Both envelope schemas are covered 1.0 contract surfaces (SPEC §12) — parse the
JSON, not the human-readable text (which is explicitly NOT stable).

A run writes to `~/.cowork-harness/runs/<name>/<sessionId>/` by default — outside any working tree. In CI,
set `COWORK_HARNESS_RUNS_DIR` (or pass `--run-dir`) to a workspace-relative path (e.g. `runs`) so an
artifact-upload step can collect them. Each run dir holds `events.jsonl`, `control-out.jsonl` and
`egress.log` at the root, plus each turn's `run.jsonl` / `trace.json` / `result.json` under `turns/<N>/`
(a single-turn run has just `turns/1/`; there is no root compat copy of any of these). Digest one with `cowork-harness trace <run-id | dir>`.
Secrets are scrubbed from every persisted log by value.

## Don't assume a fixed assertion count across lanes

On `replay`, skipped assertions are **absent** from `results[].assertions[]` (filtered before
evaluation), not present-and-passing. A CI script that counts assertions will see a different count
on replay vs live — compare by assertion identity / pass-fail, not by total count. The count of
skipped live-only assertions is reported on each replay result as `skippedAssertions: {full, partial}`.

## Staleness mostly does NOT fail a replay — read it from the JSON

A plain `replay` **warns** on a DRIFTED cassette (skill/baseline drift) but stays `ok:true` — a green
replay does **not** imply the recording is still valid. **Since 2.0.0 there is one exception:**
`unverifiable-skill` — staleness that could not be checked at all, most often a cassette that moved —
FAILS a bare `replay`. Recover with `--session <file>` rather than re-recording. Each replay result carries `staleness[]`, an array of
`{class, message}`, so a token-free gate can act on it without `ok` being the whole story:

| `class` | meaning | concern |
|---|---|---|
| `baseline` | platform baseline moved since record | low (format-compatible) |
| `skill` / `shared-root` | the skill source the assertions validate drifted | **high** (assertions may validate dead code) |
| `format` | the git/raw file-set mode or agent-scope differs from the recording | re-record under the same setting (waivable) |
| `unverifiable-baseline` | the latest baseline couldn't be loaded | couldn't verify (env, not skill) |
| `unverifiable-skill` | skill dirs unresolvable, **or** the cassette predates the hash-format epoch (v12) so its digest is not comparable | couldn't verify the skill. **Fails a bare `replay`.** For the epoch case try `rehash` first — it migrates without a re-record where it can prove the content unchanged (`rehash <file> --session <s.yaml>` if the cassette moved) |
| `resolved-tier` | a `fidelity: cowork` cassette's recorded `effectiveFidelity` no longer matches what the baseline resolves to today (the host-loop gate flipped) | **high** (the recording exercises the wrong tier) |
| `unverifiable-tier` | tier check couldn't run for a `fidelity: cowork` cassette (no recorded `effectiveFidelity`, or its pinned baseline failed to load) | couldn't verify the tier — re-record |

(A pre-`effectiveFidelity` cassette with an **explicit** tier is statically knowable — it passes the tier
check with a non-failing informational note in the `verify-cassettes` envelope's per-file `notes[]`, a
`·`-prefixed row in text output. On `verify-cassettes` every staleness *finding* above still fails the
gate (`ok:false`) — but it is class-AWARE on the EXIT CODE: a `baseline`/`skill`/`shared-root`/
`format`/`resolved-tier` class lands in the envelope's `staleness[]` (verified & failed — exit `1`),
while an `unverifiable-*` class lands in `unverifiable[]` (could not verify — exit `3`). Notes never
fail it either way.)

To gate in CI, pick the severity you want:

- `replay --strict` — fail (exit 1) on **any** staleness class.
- `replay --fail-on-skill-drift` — fail on the skill-source DRIFT classes (`skill` / `shared-root`); `unverifiable-skill` needs no flag, it fails the default verdict since 2.0.0;
  baseline / format / `unverifiable-baseline` stay non-failing warnings.
  Note `--allow-failing` waives this gate wholesale, including the copy `--assert-from` turns on for you:
  `replay --assert-from … --write --allow-failing` will persist an assert block validated against a
  recording whose skill sources have since moved. Re-record when the drift is real.
- Or read `results[].staleness[].class` yourself and decide.

Both flags realize the gate as failing assertions, so the verdict / `ok` / exit code stay consistent with the
plain run.

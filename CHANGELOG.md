# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses
[Semantic Versioning](https://semver.org/); pre-1.0 minor versions may include breaking changes.

## [Unreleased]

## [0.6.0] — 2026-06-19

### Breaking changes

- **Exit code 3 for boundary/integrity violations.** Commands that previously exited `2` for a
  boundary constraint (e.g. `skill` hitting the egress sandbox, `run` with a `boundary`-category
  failure) now exit `3`. Exit `2` is narrowed to usage errors, unknown flags, and runtime errors.
  Scripts that check `$? -eq 2` to detect boundary failures must be updated to `$? -eq 3`.
- **`verify-cassettes --staleness-only` / `--privacy-only` removed.** Replaced by
  `--skip-staleness` (run privacy scan only) and `--skip-privacy` (run staleness scan only). The
  old flags are not aliased — they now exit `2` as unknown flags.
- **`decide` with no configuration exits `2` instead of `1`.** Previously, calling `decide` with no
  `--decider-*`, `--answer`, or `--answer-policy` would fall through to a `ScriptedDecider([])` and
  exit `1` ("no rule matched"). It now fails early with exit `2` ("no decider configured") and a
  clear message.

### Added

- **`chat` — full flag parity for interactive debugging:**
  - `[prompt]` — optional seed prompt sent as the first turn before the REPL opens.
  - `--upload <file>` (repeatable) — attach a file at `mnt/uploads/<basename>`; live at session start.
  - `--folder <dir>` (repeatable) — connect a project folder at `mnt/.projects/<basename>` as a live bind mount.
  - `--verbose` / `-V` — show thinking blocks, tool inputs, and the sub-agent tree (previously hardcoded off).
  - `--fidelity protocol` — no-Docker fastest tier; accepted alongside `container` and `hostloop`.
  - `--model` in `--raw` mode — previously silently dropped; now passed as `--model <id>` to the docker argv.
  - Idle heartbeat wired in all three fidelity branches (protocol / hostloop / container).
  - Run ID printed at session start (before first turn) so a mid-session crash still tells you where the transcript is.
- **`assertions` command** — canonical rename of `assert`; `assert` is kept as a deprecated alias
  that prints a migration notice. `assertions --list` is the new canonical form.
- **`scaffold <run-id>` positional** — canonical form; `--from-run <id>` is kept as a deprecated
  alias that prints a migration notice.
- **`trace --view tools|questions|dispatches`** — replaces the three separate `--tools` / `--gates`
  / `--dispatches` flags with a single `--view` enum. Legacy flags are kept as backward-compat
  aliases (`--gates` maps to `--view questions`).
- **Env-var defaults for all live commands:**
  - `COWORK_HARNESS_FIDELITY` — default fidelity tier for `skill` and `chat` (validated; exits 2 on an invalid value).
  - `COWORK_HARNESS_MODEL` — default model override for `skill` and `chat`.
  - `COWORK_HARNESS_OUTPUT_FORMAT` — default `--output-format` for all commands (`text` or `json`).
- **`decide` no-decider guard** — calling `decide` with no configuration fails immediately with a
  clear message and exit `2` instead of falling through to a vacuous "no rule matched" exit `1`.
- **`vm` per-subcommand `--help`** — `vm <sub> --help` prints the subcommand usage and exits `0`.
- **`--quiet` / `-q` accepted in `decide`** — no-op flag for flag-surface consistency with `skill` / `run`.

### Fixed

- **`--rerecord-stale` now prefers on-disk scenario over embedded snapshot (G-1).** When a
  `scenarios/<name>.yaml` exists alongside the cassette dir, `--rerecord-stale` re-records from it
  instead of the embedded copy. Edits to the scenario (e.g. adding `skills:` for staleness scoping)
  now take effect. Falls back to the embedded snapshot when no on-disk file is found, with a clear
  warning.
- **Staleness message distinguishes format-version bump from real content change (G-2).** After a
  harness upgrade that changes the hash algorithm, `verify-cassettes` now reports
  `recorded under an older hash format (vN → vM)` instead of the misleading
  `local skill/plugin dir contents changed`.
- **`.cowork-hashignore` leading-slash patterns now correctly anchor to the mount root (G-3).**
  `/tests` previously compiled to a regex that never matched (no leading slash in relative paths);
  it now matches only the top-level `tests/` dir, as expected.
- **Scoped staleness findings now name the changed bucket (G-4).** When a cassette was recorded with
  `skills: [<name>]` scoping, `verify-cassettes` now reports `skills/<name> changed` or
  `shared root changed` rather than the generic `local skill/plugin dir contents changed`.
- **Unknown flags in `chat` now exit `2`.** Previously ignored silently; any unrecognised flag now
  exits `2` with a clear message.
- **`chat --model` bounds-checked.** If `--model` is the last argument (no value following), the
  command now exits `2` with a clear message instead of silently using `undefined`.
- **`cmdSync` platform guard fires before argument parsing.** On non-macOS platforms the guard now
  exits before `parseArgs`, so `sync --help` on Linux no longer crashes on a missing flag.
- **`record` conflict check.** Passing both a positional and `--cassette` now exits `2` immediately
  instead of silently preferring one.
- **L0 plugin divergence signal.** `spawnProtocol` now reports whether the skill resolved at L0
  (no container) vs. L1, so callers can surface the divergence accurately.
- **System-prompt threading.** `systemPromptAppend` is now passed through all runtime paths that
  previously dropped it.
- **Strict agent binary resolution.** When the exact staged binary path is missing, the harness now
  fails with a clear message pointing to `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1` instead of
  silently falling back to an arbitrary sibling version.
- **Path traversal guard on plugin sources.** Plugin source paths are now validated to be
  directories (not files or traversal strings) before mounting.
- **Cassette correctness (batch):** privacy/staleness coverage tracking, redaction verdict
  preservation across re-records, base64-encoded artifact body scanning, and exhaustiveness
  checks on the replay assertion set.

## [0.5.0] — 2026-06-18

### Added

- **`verify-run <run-dir> <scenario.yaml>`** — re-evaluate a scenario's `assert:` block against an
  already-kept run dir with **no live agent** (no tokens, no Docker). Fixing a wrong assertion was a full live
  re-record (~17 min); this turns it into ~1s. Reconstructs the assert context from the run's `result.json` +
  the `run.jsonl`/`trace.json` sidecars and routes the verdict through the same path as a real record. Refuses
  (rather than false-passing) when a filesystem assertion needs a work dir that's already torn down.
- **`record --max-artifact-bytes <n>` / `COWORK_HARNESS_MAX_ARTIFACT_BYTES`** — override the 64 KiB
  inline-body cap so a large structured deliverable can be inlined instead of stored hash-only. Paired with a
  **record-time guard**: if an `artifact_json` asserts an artifact that had to be truncated, record now fails
  (or warns under `--allow-failing`) at the cause, instead of producing a green record that goes red at replay
  (no committed body to parse).
- **`verify-cassettes --allow-domain` / `--allow-email` / `--allow-file`** — class-scoped privacy allows, plus
  a version-controlled allow file (one regex per line, `#` comments).
- **Scoped cassette-staleness fingerprint** — scenario **`skills: [<name>]`** narrows the staleness hash to the
  named skills' dirs plus the plugin's shared roots (fail-closed to whole-tree on an unknown name); session
  **`staleness.hash_ignore`** globs and a plugin-local **`.cowork-hashignore`** file (composed) drop
  non-runtime paths (`tests/`, `docs/`). Default behavior is unchanged (whole-tree, byte-identical). Cassette
  format bumped to **v2** (an older reader warns rather than mis-flagging a scoped cassette as stale).
- **Per-subcommand `--help`** — subcommands now print a usage line and exit 0 instead of answering `--help`
  with `unknown flag` (exit 2).
- **Cowork identity in the system-prompt append** — the emulated agent now self-identifies as "Claude, the
  Cowork assistant" and is told it is **not** Claude Code (verified against the installed Claude Desktop app;
  reconstructed, not bundled).

### Fixed

- **Privacy allows are whole-token + class-scoped.** A bare `--allow <regex>` previously substring-matched, so a
  domain allow (`example\.com`) silently cleared an email finding (`alice@example.com`) whose domain it matched.
  Allows are now anchored to the whole finding token, and `--allow-domain`/`--allow-email` can't bleed across
  classes — the email tripwire stays live.
- **Staleness hash no longer over-fires.** A pure `plugin.json` `version` bump (and, with the new scoping knobs,
  unrelated skills/tests/docs) no longer re-stales every cassette in a multi-skill plugin. *Upgrade note:*
  because the hash now ignores the `plugin.json` `version` field, cassettes recorded before this release
  recompute to a new digest and are flagged **stale once** after upgrading — re-record them
  (`record --rerecord-stale`). The cassette format is also bumped to **v2**.
- **`chat` is pipe/script-safe.** A piped/non-interactive stdin reaching EOF mid-turn crashed the REPL with
  `ERR_USE_AFTER_CLOSE`; it now exits cleanly.
- **Outputs-delete findings show the `rm` itself.** A long `VAR=…` assignment prefix used to push the operative
  delete past the truncation; the finding now isolates and variable-resolves the delete target.
- **Clearer record/run messaging.** The record freeze-refusal separates the run *result* from the *verdict* and
  names the failing signal; the run log states the unscripted-question *policy* instead of reading as a failure
  on clean runs.
- **`sync` warns when a synced baseline lacks its host-loop prompt asset** — previously host-loop records
  silently ran with an empty shell-access section.

### Internal

- Corrected the system-prompt fidelity note in `docs/boundary.md` (Cowork appends onto the `claude_code` preset
  by default rather than replacing it).
- Assertion docs steer content checks to `artifact_json` / stable lexical markers (not paraphrasable prose).
- `vitest` excludes `runs/` from test discovery (ephemeral live output could crash the walk with EACCES).

## [0.4.3] — 2026-06-18

### Fixed

- **`cowork-harness lint` no longer flags `artifact_json` / `allow_permissive_auto_allow` as unknown keys.**
  The linter's assertion-key list is now **generated from the Zod `Assertion` schema** (the same source
  `assert --list` uses) into a file shipped next to `scenario.py`, with a CI drift-guard — so it can't lag the
  schema again. Its replay-class warnings were also reconciled with the 0.3.0 artifact-manifest: `file_exists`,
  `user_visible_artifact`, and `artifact_json` are now treated as **manifest-backed** (replay-checkable when the
  cassette carries an `artifacts` manifest) rather than always-skipped, so a scenario asserting only those is no
  longer a false `replay-noop`. A self-check fails the linter if a future schema key isn't classified.

### Internal

- The npm tarball no longer ships `docs/internal/` (internal planning docs were being published).

### Added

- **Platform baseline `desktop-1.13576.1`** — synced from the updated Claude Desktop (the app moved
  `1.12603.1` → `1.13576.1`). `loadBaseline("latest")` now resolves to it. The embedded agent binary is
  unchanged at `2.1.177` (the update changed the app shell + gate states, not the agent ELF); this baseline
  also corrects the prior baselines' stale `2.1.170` agent pin to the actually-staged `2.1.177`. Egress
  allowlist unchanged.

## [0.4.1] — 2026-06-18

### Fixed

- **Agent-binary newest-staged fallback now applies on the real runtime paths** (container / hostloop, and
  thus `skill` / `run` / `chat`), not just `sync`/tests. `resolveAgentBinary` had two private duplicates
  (`container.ts`, `hostloop.ts`) **without** the 0.4.0 fallback, so a host with a newer staged
  `claude-code-vm/<ver>` than the baseline expects still hard-failed with "Staged agent binary not found".
  The duplicates were consolidated into the single exported resolver; a host that has staged a newer build
  now falls back to it (with a warning) instead of failing. A structural test + CI guard prevent the
  resolver from being re-duplicated.

## [0.4.0] — 2026-06-18

The parsing/validation hardening + safety release: a current-tree code-review sweep plus fidelity and
robustness findings from real skill-testing sessions — uniform fail-loud CLI parsing (enforced by a
structural test + CI guard), a centralized staging-source resolver, cassette replay/manifest safety
(base64 + containment + hash-verify), egress SSRF/DNS-rebind hardening, `replay <dir>`, and `cowork-harness lint`.

### Added

- **`cowork-harness lint <scenario.yaml>…`** — the bundled scenario linter/scaffolder (`scenario.py`) is now
  shipped in the npm package and reachable as a first-class subcommand, so a consumer who `npm i`s the harness
  (with no skill checkout) can run the no-silent-false-green checks in CI. Needs `python3` + PyYAML; a missing
  interpreter fails with a clear, actionable message.
- **`replay <dir>`** — `replay` now accepts a directory and replays every `*.cassette.json` in it (sorted,
  non-recursive), exiting on the worst per-cassette verdict, in addition to the existing `--cassette <file>`
  form. An unreadable cassette is reported per-file and forces the JSON envelope's `ok:false` (never a vacuous
  pass), and never aborts the batch.
- **A shipped `protocol`-tier example** (`examples/scenarios/protocol-smoke.yaml` + its session) — the first
  zero-Docker/zero-agent worked example for the L0 tier (a scripted answer reaches the model, a tool runs, a
  file is written), with the host-path leak owned via `transcript_no_host_path: false` to illustrate exactly
  what protocol fidelity does and does not seal.
- **Documentation for previously-undocumented surfaces:** `sync --allow-empty`, `boundary-check --session`,
  `decide`'s `--decider-dir` rejection, `verify-cassettes`'s non-recursive scan, `replay` (one file vs
  `record` batching), `gates` raw-output (no envelope), `gate_answers_delivered: false`, python
  `run_scenario()`, six public reproducibility env vars, and HELP text for `chat --fidelity/--model` and
  `sync --allow-empty`. Plus a zero-dependency "try it in 10s" `replay` lead in the README quick start.

### Changed

- **Uniform CLI argument validation.** A shared declarative argument parser backs the cassette commands
  (`record`/`replay`/`verify-cassettes`) + `boundary-check`, and **every** command now rejects unknown flags,
  extra positionals, and flag-looking values for path/id flags instead of silently ignoring them — closing a
  class of silent-accept parsing footguns. This is enforced going forward by a structural test (every command
  must reject an unknown flag) and a CI grep-ban on the legacy first-non-dash-token idiom. Error paths only;
  valid invocations are unchanged.
- **The npm package ships `scenario.py`** (the linter/scaffolder) and publishes with provenance attestation so
  CI consumers can lint without a skill checkout.
- **Agent-binary discovery falls back to the newest staged build.** When the baseline's exact
  `claude-code-vm/<ver>/claude` is absent (e.g. Cowork staged a newer build), the harness now uses the newest
  staged sibling with a warning instead of hard-failing; `COWORK_AGENT_BINARY` still takes precedence.
- **`chat --fidelity` now validates its argument** — a value other than `container`/`hostloop` is rejected
  (exit 2) instead of being silently coerced to `container` (a fidelity footgun).
- **`assert --list`** now describes `replay_protocol_fidelity` as replay-only and **not authorable** (it is
  synthesized by the replay lane and rejected if written in a scenario).

### Fixed

- **CLI parsing hygiene across commands.** `run` now treats an empty scenario directory as a loud non-zero
  (was a vacuous exit-0 pass); `record`/`verify-cassettes`/`gates` no longer mistake a `--output-format`/
  `--allow` value for the positional target; `trace` rejects mutually-exclusive view flags and extra targets;
  `scaffold`/`assert --list` validate `--output-format` and reject stray arguments; `decide` rejects unknown
  flags, stray positionals, `--intent` without `--decider-llm`, an `--decider-llm`+`--answer` conflict, and a
  flag-looking `--decider-cmd` value; `vm` validates its subcommand before loading a baseline; `boundary-check`
  rejects unknown flags; the global `--dotenv=<path>` equals form is accepted; and `--output-format=<x>`
  validates the value rather than silently degrading to text.
- **Cassette replay safety.** `replay` routes reads through the safe cassette reader (a malformed cassette is a
  clean error, not an internal crash); a lenient schema guards the dereferenced `scenario`/`events` fields and
  a missing optional `assert` is normalized so it can't crash a batch; manifest bodies are stored with an
  encoding marker (binary as base64) so non-text artifacts round-trip byte-exactly; materialized entries are
  path-contained (no `..`/absolute escape) and verified against their recorded sha256.
- **Skill-staleness hash no longer self-invalidates.** The `skillHash` fingerprint now excludes recorded
  cassettes (`*.cassette.json`, by extension) and VCS/cache dirs (`.git`/`node_modules`/`__pycache__`/…), so
  writing a cassette under the hashed skill tree no longer changes the fingerprint it just recorded (and a
  repo that co-locates committed cassettes with the skill stops falsely tripping the staleness gate). Real
  skill-source edits — including under a `tests/` dir — still change the hash (kept conservative: no
  false-negative).
- **Staging source validation.** Every declared session source now resolves through one central choke point
  (`resolveDeclaredSource`, guarded by a structural test): `mcp.config` must be a file; connected folders,
  local/remote plugin roots, and local skills must be directories; a nameless marketplace manifest now
  resolves and qualifier-matches by its derived name; and a corrupt `plugin.json` errors instead of silently
  defaulting to version `0.0.0`. The soft-missing reconciliation path is preserved (a missing source still
  reconciles; only a wrong-kind existing source fails loud).
- **Artifact collection no longer follows symlinks** (`lstat` + symlink-skip + a realpath cycle guard), and the
  egress sidecar/proxy are acquired inside the protected block so a prompt-render throw can't leak them.
- **Egress/web-fetch guards.** The private-address guard recognizes IPv4-mapped IPv6 and numeric/hex/octal IPv4
  loopback forms; a host-side `web_fetch` to a hostname that **resolves** to a private/loopback address is now
  denied (DNS-rebind/SSRF, fail-closed — a name that won't resolve is also denied), checked on every redirect
  hop; the proxy parses bracketed IPv6 `Host` headers; and an `allow` egress decision is recorded only once the
  upstream actually connects (so `egress_allowed` can't pass when nothing reached the host).
- **Verdict/assertion correctness.** A nonzero child exit after a success result is now fatal (with the stderr
  tail); `artifact_json` `equals`/`in` compare JSON with key-order-insensitive deep equality (arrays stay
  order-significant); the external decider rejects an invalid permission `behavior` loudly instead of silently
  denying; `no_delete_in_outputs` accepts only `true` (authoring `false` was a silent no-op footgun); and the
  outputs-delete detector parses `mv` direction (a move *into* `outputs/` is no longer a false delete) with an
  opt-in safe-staging-prefix suppression for scratch cleanups (`COWORK_HARNESS_SAFE_STAGING_PREFIX`).
- **Python wrapper drift.** `run_scenario()` no longer passes `--fidelity`/`--answer` flags the `run` command
  rejects; fidelity and answers are scenario-authored (the YAML's `fidelity:`/`answers:` fields).
- **Docs reconciled with the 0.3.0 artifact-manifest replay behavior.** README, SPEC, `docs/scenario.md`,
  the companion `SKILL.md`, and the skill references previously claimed `file_exists`/`user_visible_artifact`/
  `artifact_json` were "always skipped" on replay; they now correctly state these are evaluated **when the
  cassette carries an `artifacts` manifest** (only the live-only egress keys are always skipped), with
  `docs/cassette.md` flagged as canonical and `allow_permissive_auto_allow` added to its table.
- **Corrected the claim that the `protocol` tier needs no token** — L0 spawns the host `claude` and calls a
  real model, so it needs the auth token (Docker-free/agent-free, not token-free).
- **Aligned stale references:** npx floor `>=0.2.0` → `>=0.3.0`; skill reference headers `0.1.0` → `0.3.0`;
  stale `cassette.ts` line-cites → the `contentKeys` symbol; and the broken `DESIGN.md §1` anchor.
- **Doc accuracy:** all five fidelity values (vs "L0/L1/L2"), `max_thinking_tokens` over "extended thinking",
  the `config_dir` write-guard caveat, the `boundary-check` (exit 1) vs `BoundaryError` (exit 2) exit-code
  distinction, and the `npm run ci` vs CI-Stage-1 gate framing.

## [0.3.0] — 2026-06-17

The CI-operate + privacy layer for committed cassettes: record-time redaction, an always-on
`verify-cassettes` scan/staleness gate, batch recording, and a set-membership assert operator.

### Added

- **`verify-cassettes <file|dir>`** — a token/agent-free CI gate over committed cassettes. A privacy
  **scan** flags `email`/`currency`/bare-`domain` matches across the whole cassette, excluding only the
  agent's **capability-manifest** messages (`system/init` + the `init-1` registry) from the noisy classes —
  that catalog/MCP-server boilerplate is the sole concentrated false-positive source (email still scans it,
  since the registry `account` field can carry the dev's email). `--allow <regex>` suppresses synthetic/
  public reference names; multi-word proper names are opt-in, not a default class. Plus a **staleness** check
  (`--staleness-only`) fails when a cassette's fingerprint drifted (you edited the skill but didn't
  re-record). Exit 1 on any finding/drift/unreadable cassette; a malformed cassette is tallied, never
  crashes the batch. Dedicated JSON envelope (`{command, ok, results}`), not the `RunResult` shape.
- **Record-time content redaction** (opt-in; distinct from secret-scrub). A `.cowork-redact.json` (or
  `COWORK_HARNESS_REDACT_PATTERNS`/`_KEYS`) rewrites configured PII across the **whole** cassette surface
  (transcript, artifact bodies + filenames, prompt/answers/assert, skillSources) **structurally** — JSON
  stays valid and the AskUserQuestion question/answer strings stay in sync (the O7 guard still passes), with
  collision-safe deterministic tokens. Redaction is **verdict-preserving**: `record` refuses to write if it
  would flip an assertion (a manufactured green). `--no-redact` / `--allow-failing` escape hatches.
- **Batch recording** — `record <dir>` records every scenario in a directory (classified by a positive
  `prompt:` signal: a non-scenario YAML is an announced skip, a broken scenario is a failure, never a silent
  skip); `record <cassette-dir> --rerecord-stale` re-records only the cassettes whose fingerprint drifted.
- **`artifact_json` `in:` operator** — assert the resolved value deep-equals one of a fixed set; stable for
  stochastic (LLM-extracted) values where `equals` churns across re-records.

### Fixed

- **`skillHash` cassette fingerprint was silently dead** — `skillSourceDirs` passed a path string to
  `loadSession` (which wants parsed YAML), threw, and the throw was swallowed, so the staleness gate's
  skill-edit signal never computed for a file-based session. Now parses + resolves the session correctly;
  `hashDir` folds in each file's relative path + type marker (a *move* now registers); `skillSources` are
  stored relative, never as absolute host paths.

## [0.2.0] — 2026-06-17

Binary-verified the AskUserQuestion answer wire shape (agent ELF 2.1.170), implemented the
harness-improvements plan, and resolved a 39-finding code-review pass behind two centralizing seams.

### Added

- **AskUserQuestion answer shapes.** `multiSelect` gates (answer with a list of labels → the verified
  comma-joined wire shape); free-text **"Other"** via `answer:` (distinct from the label-validated
  `choose:`); `choose` tolerates the `(Recommended)` suffix + `recommended`/`first` keywords. A partial
  match on a batched gate now **names the unmatched sub-questions**.
- **`artifact_json` assertion** — assert a JSON artifact's contents via a dotted path
  (`equals`/`gt`/`exists`/`absent`/`is_null`); `absent`, `is_null`, and an unresolved intermediate are
  distinct (the last fails loud, never a vacuous pass).
- **Artifact manifest in cassettes** — `record` snapshots `outputs/`/`.projects/` (paths + hashes + small
  JSON bodies) so `file_exists`/`user_visible_artifact`/`artifact_json` run on token-free `replay`. A
  cassette→skill/baseline **staleness fingerprint** warns on drift; `replay --strict` fails on it. Cassettes
  now carry a `cassetteVersion` (forward-compat guard).
- **`RunResult.artifacts`** (ENV-MANIFEST) — observed user-visible files (path + bytes); also surfaced as
  `Result.artifacts` in the Python helper.
- **`allow_permissive_auto_allow` assertion + `RunResult.scan`** — a security-scan surface for the
  Cowork-parity verdict (below); the assertion opts a scenario into a permissive auto-allow on purpose.
- **CLI:** `trace --dispatches` (sub-agent dispatch tree + real total), `assert --list` (schema-generated),
  `scaffold --from-run <id>` (kept run → starter scenario YAML).
- **Python:** `run_scenario()` — run an authored scenario YAML and get the typed `Result`.

### Changed

- **Single verdict source (`computeVerdict()`)** wired into all five pass/fail sites (run/skill exit, footer,
  replay exit, JSON-envelope `ok`) plus the Python `assert_success`. A Cowork-parity violation — a permissive
  auto-allow, a recorded `outputs/` delete, or a host-path leak — now **default-fails** the run unless the
  scenario explicitly asserts about it.
- **Single fail-loud staging policy (`src/staging/resolve.ts`)** for every declared input (marketplace
  manifest, enabled-plugin resolution, local skills, `mcp.config`, uploads, folders), with a Docker-safe
  marketplace charset.
- The run root honors `COWORK_HARNESS_RUNS_DIR`.

### Fixed

- **Egress / runtime hardening:** per-hop redirect egress logging, allowlist validation, a per-run proxy
  port, proxy/sidecar readiness handshakes, fail-loud Lima provisioning, and boundary teardown in
  `try/finally`.
- **Protocol / decider hardening:** oversized control-frame hard-fail, a nonzero child-exit error event,
  provenance untruncation, TTY-elicit cancel, and a JSON-safe `reply_with` key.
- **Detection / packaging:** `%2F`/backslash decode in the outputs-delete detector; the npm package now
  ships `schema/`, `docs/`, `python/`, and `scripts/`; assertion path containment; resume empty-tree warning.

### Notes

- Held/deferred per the plan's gating: composed partial-gate answering, `decider_intent:` in scenario YAML,
  a whole-gate `response:` freeform, and `artifacts_share_field`. All additive/opt-in when built.

## [0.1.1] — 2026-06-16

Docs, distribution, and packaging. No CLI behavior change.

### Added

- **Companion Claude Code skill, installable.** A `.claude-plugin/marketplace.json` + skills-directory
  plugin make the bundled skill installable via `/plugin marketplace add yaniv-golan/cowork-harness`;
  the skill self-bootstraps the CLI (`npx cowork-harness@latest`) and fails loud on missing tier deps.
- **`AGENTS.md`** — canonical, cross-tool agent instructions — and **`llms.txt`** doc index.
- **JSON Schema for scenario & session YAML** (`schema/*.schema.json`, generated via `npm run schema`,
  pinned by a token-free drift-guard); `# yaml-language-server: $schema=` hints in the example scenarios.
- README banner, badges, an "For AI agents" section, and `npm install` instructions.

### Changed

- Release pipeline publishes via npm **Trusted Publishing (OIDC)** with provenance (no stored token).
- GitHub Actions bumped off the deprecated Node 20 runtime; CI live-scenario job skips cleanly without a key.

## [0.1.0] — 2026-06-16

Initial public release. A faithful, headless, scriptable harness for Claude Cowork's runtime — for
testing Claude Code **skills** outside the Desktop app with the same staged agent, spawn/control-protocol
contract, egress allowlist, permission protocol, and sandbox limitations. Binary-grounded against
`app.asar` 1.12603.1 / agent ELF 2.1.170.

### Added

- Commands: `skill`, `run`, `chat`, `record`, `replay`, `trace`, and `decide`, plus `sync`,
  `boundary-check`, and `vm` management. Stable `--output-format json` envelope and CI-ready exit codes.
- Five fidelity tiers (`fidelity:`): `protocol`, `container`, `microvm`, `hostloop`, and `cowork`
  (auto-picks host-loop vs container the way Cowork does).
- Scenario YAML — prompt + scripted answers + `assert:` (transcript, files, artifacts, tool / sub-agent
  usage, egress, and more) for authored, asserted regression runs.
- Input policy with no silent false-greens: scripted, LLM, and in-band (`--decider-dir`) answering for
  AskUserQuestion / tool-permission gates; an unanswered gate fails loud.
- Default-deny egress sandbox enforced against the synced Cowork domain allowlist.
- Token-free, Docker-free cassette `record` / `replay` for the PR gate.
- Platform baselines synced from a local Claude Desktop install — nothing Anthropic-owned is bundled
  or distributed.

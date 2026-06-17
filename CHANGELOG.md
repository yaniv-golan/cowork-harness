# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses
[Semantic Versioning](https://semver.org/); pre-1.0 minor versions may include breaking changes.

## [Unreleased]

### Added

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

- **`chat --fidelity` now validates its argument** — a value other than `container`/`hostloop` is rejected
  (exit 2) instead of being silently coerced to `container` (a fidelity footgun).
- **`assert --list`** now describes `replay_protocol_fidelity` as replay-only and **not authorable** (it is
  synthesized by the replay lane and rejected if written in a scenario).

### Fixed

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

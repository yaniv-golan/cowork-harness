# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses
[Semantic Versioning](https://semver.org/); pre-1.0 minor versions may include breaking changes.

## [0.10.0] — 2026-06-23

### Added

- **Stall-on-question verdict axis.** A run that ends on an unanswered plain-text question (final
  assistant turn ends with `?`, no tool calls, no structured `AskUserQuestion`) previously reported
  `result: "success"` — a false green. Runs now carry `stalledOnQuestion`, and a new **`stalled`**
  verdict signal (both the live and replay lanes) fails such runs by default. The detector re-derives on
  the replay re-drive, so cassettes stay consistent. Opt out per scenario with the **`allow_stall`**
  verdict modifier when a trailing question is the expected, acceptable ending. ⚠️ This can flip a
  scenario that was previously green to red — set `allow_stall: true` to restore the prior verdict. The
  published contract is updated accordingly: `schema/run-result.json`, `schema/scenario.schema.json`, the
  `assertion-keys.json` modifier list, `SPEC.md`, and the `docs/scenario.md` success formula now document
  the verdict-signal layer.
- **`lint` advisory for order-dependent positional `choose`.** `scenario.py` now parses `answers:` and
  flags a positional `choose` (`first` / index) as order-dependent — reconciled with `docs/scenario.md`'s
  guidance to prefer positional `choose` when option labels drift. Advisory only; it does not fail the lint.
- **Documentation completeness:** `record --dry-run`; the `COWORK_HARNESS_FIDELITY` / `_MODEL` /
  `_OUTPUT_FORMAT` environment variables; the `examples/scenarios/` lint path and its `python3`
  prerequisite; and links to `RELEASING.md` and the CI recipe.
- **`record` can answer gates live** instead of pre-scripting every answer: `--decider-dir <dir>`
  (a driving agent answers in-band; single scenario), `--decider-llm [--intent "…"]` (a model answers),
  and `--on-unanswered fail|first`. This removes the discovery-run → encode-answers → record dance for
  cassette authoring. When a gate is actually answered by a live decider (or an `--on-unanswered first`
  auto-pick), the cassette is stamped with an `authoring.nonDeterministic` provenance field and a warning
  notes that re-recording may drift — the cassette itself still **replays deterministically** (the answers
  are frozen). `--decider-*` flags are rejected with `--rerecord-stale`, and `--decider-dir` with a
  directory batch. The `record` help also clarifies that `--allow-failing` only relaxes the post-run
  verdict gate — it does **not** salvage an unanswered gate.
- **`verify-run` now also checks answer coverage.** When a scenario declares `answers:`, `verify-run`
  validates that each scripted answer still matches a gate the kept run actually fired (parsed from the
  run's `events.jsonl`, which retains the offered option labels). A drifted `when_question` or a `choose:`
  that names an option the run never offered now fails in ~1s instead of on a paid re-record. ⚠️ This
  **changes verify-run's exit-code contract**: a run green on `assert:` can now exit `1` on an answer
  mismatch. A scenario with no `answers:` is unaffected (assert-only, exactly as before); if a scenario
  declares answers but the kept run dir has no `events.jsonl`, `verify-run` refuses (exit `2`) rather than
  vacuously passing.
- **`doctor` detects the macOS Keychain first-run trap.** A Claude Code login writes the OAuth token to the
  login Keychain, but the in-Docker agent can only read env / `.env`. When the env has no token **but** a
  `Claude Code-credentials` Keychain entry exists, `doctor` now points you straight at copying it into
  `./.env` instead of a dead-end "set a token" remedy. Read-only probe (status only; the secret is never
  read or printed).

### Changed

- **`lint` no longer requires a separately-installed PyYAML.** A pure-Python copy of PyYAML is bundled with
  the linter (`scenario.py`), so `cowork-harness lint` works on a stock `python3` with no `pip install`
  (npm consumers / bare CI). A system PyYAML is still preferred when present.

- Upgraded to **zod 4** (runtime dependency). Scenario/session validation behaviour is unchanged.
- Regenerated `schema/scenario.schema.json` and `schema/session.schema.json` with zod 4's native JSON Schema
  generator. The published schemas are now flat draft-07: the `#/definitions/CoworkHarnessScenario` /
  `CoworkHarnessSession` wrapper is gone; nullable fields render as `anyOf: [{string}, {null}]` rather than
  `type: ["string", "null"]`; loose objects use `additionalProperties: {}`. `required` still lists only
  genuinely-required fields (defaulted fields excluded), and strict objects keep `additionalProperties: false`.
- Retired deprecated zod-3 APIs internally (`.passthrough()` → `z.looseObject`, `.strict()` → `z.strictObject`,
  `z.ZodIssueCode.custom` → `"custom"`). No behavioural change.

### Fixed

- **Cassette writes are now atomic** (temp file + rename) at the `record` and `rehash` sites, so an
  interrupted write can no longer leave a truncated or corrupt cassette on disk.
- **`runs gc` ranks real runs ahead of empty scaffold dirs.** A run with a `result.json` or `events.jsonl`
  is retained ahead of a newer empty scaffold directory, so a completed run no longer loses a keep slot to a
  newer empty one. `--keep-last` remains a hard cap.
- **Reworded the `manifest-needs-snapshot` lint message** to a conditional caveat — the linter is static and
  cannot read the cassette, so the message no longer asserts a snapshot is missing when it may not be.
- **Corrected the `lint` help text's exit-code note.** `127` means `python3` itself is missing; a
  PyYAML-missing failure exits `2`. The previous help conflated the two (and PyYAML is now bundled anyway).

### Security

- Cleared 5 Dependabot advisories in the dev toolchain by upgrading vitest (2 → 4); also bumped the build
  toolchain (typescript 5 → 6, @types/node 22 → 26, actions/checkout 6 → 7). All dev/CI-only — not shipped in
  the published package.

## [0.9.0] — 2026-06-22

### Breaking changes

- **Cassette staleness fingerprint bumped to format v6 (re-record once).** The skill-hash boundary changed,
  so committed cassettes recorded before this release report `recorded under an older hash format — re-record
  once`. Drivers: (1) **OS-junk** files (`.DS_Store` / `Thumbs.db` / `desktop.ini`) are excluded from
  `skillHash` — an out-of-band OS metadata touch can no longer re-stale a cassette (the "fresh cassette is
  immediately stale" bug); (2) **`contentSig` is unified onto the same walk as `skillHash`** (same file set,
  plugin.json `version` stripped, in-tree symlinks hashed by target) — `rehash` cannot bridge this algorithm
  change, so a pre-v6 cassette gets an honest *"algorithm changed — re-record"* (not "content changed"); (3)
  the **git-tracked file set is the default boundary** (see Added).
- **Git-tracked staleness/mount boundary is now the DEFAULT.** When a skill/plugin source dir is in a git
  work tree, both the staleness hash and the sandbox mount use only its **git-tracked** files (untracked
  scratch / build output / OS-junk are excluded from both, so they can't drift the hash or leak into the
  sandbox). A dir that isn't a git repo falls back to the raw walk automatically. Opt out with
  `COWORK_HARNESS_GITSET=0`.
- **Removed the legacy CLI aliases.** `assert` → use `assertions`; `replay --cassette <file>` → pass the
  path positionally (`replay <file | dir/>`); `verify-cassettes --privacy-only` / `--staleness-only` →
  `--skip-privacy` / `--skip-staleness`. (0.8.0 had documented the latter two groups as renamed/removed but
  the code still accepted the old forms; they are now gone. Each removed alias exits `2` if used.)
- **`assertions --list --output-format json` now reports `command: "assertions"`** (was the stale
  `"assert"`) — a JSON-envelope contract fix for anything keying on the `command` field.
- **`decide` exits `2` (not `1`) on a runtime error**, matching the documented "usage / runtime → `2`"
  contract. No-match / abstain still exits `1`.

### Added

- **`cowork-harness/secrets` package export** — `scrubField` and `collectSecrets` are now importable as a
  declared subpath (`import { scrubField, collectSecrets } from "cowork-harness/secrets"`) for custom
  redaction pipelines, with the documented usage corrected to `scrubField(value, collectSecrets())` (a bare
  `[token]` array misses secrets embedded in encoded fields). Adding the `exports` map also **bounds the
  package's public surface to this one subpath** — deep imports into `dist/` (`cowork-harness/dist/...`),
  previously resolvable by accident, are now private. The CLI (`bin`) is unaffected.
- **`lint` accepts a directory** — it expands to the directory's `*.yaml` / `*.yml` scenarios
  (non-recursive, sorted), the same file-or-dir ergonomics as `replay` / `verify-cassettes`. An empty
  directory is a loud error, never a vacuous "0 files = clean" pass.
- **Staleness now names the EXACT changed file.** A per-file manifest (`fileSigs`) in the cassette fingerprint
  lets `verify-cassettes` report e.g. `skill files changed since record — 1 changed (skills/x/SKILL.md)`
  instead of a coarse bucket message (appended to the existing shared-vs-scoped diagnosis). Manifest paths are
  root-relative and are scanned + redacted with the same privacy layer as `skillSources`. Omitted (with a
  loud `fileSigsOmitted`) above an internal size cap.
- **`COWORK_HARNESS_DEBUG_SKILLHASH=1`** — on a staleness mismatch, dumps the exact file set feeding the hash
  to stderr and flags OS-junk, so a drift source is one line instead of a black-box hunt (a one-line hint
  points to it when the flag is off).
- **`COWORK_HARNESS_GITSET=0`** — opt out of the new default git-tracked boundary (see Breaking) back to the
  legacy raw filesystem walk for every dir.
- **`requires_capabilities` scenario assertion** — fail a scenario unless the running tier provides *and can
  verify* the declared capability families (e.g. `office_convert`, `pdf_tables`). The unmet set is persisted
  in the run result (`requiresCapabilityUnmet`), so `verify-run` can't false-fail; opt out with the
  `allow_missing_capability` verdict modifier when the skill's fallback is genuinely equivalent.
- **LLM decider `OTHER:` free-text directive** — on an options-bearing gate, a decider answer of
  `OTHER: <text>` is matched to a label first, else passed through as free text; a bare out-of-set value
  still fails loud.

### Fixed

- **`doctor --tier microvm` now checks the right prerequisites.** It previously probed the Docker daemon +
  agent image + egress-proxy image for every live tier, but the `microvm` (L2) tier runs on **Lima / Apple
  Virtualization.framework**, not Docker — so it could report "not ready" on a Lima-only host, or "ready"
  with no Lima installed. `microvm` now checks `limactl` (honoring `COWORK_LIMACTL`) + the staged agent
  binary, and skips the Docker checks; `container`/`hostloop`/`cowork` are unchanged.
- **A freshly recorded cassette no longer reports `[stale]` immediately** because the OS rewrote a `.DS_Store`
  (or other OS-junk) in the skill tree — OS-junk is excluded from the skill hash. A chronic false-positive
  that pushed consumers to WARN-only (which then masked real drift).
- A standalone verdict-modifier assertion (e.g. `allow_l0_plugin_divergence: true`) no longer false-fails
  as "empty assertion", and verdict modifiers no longer trigger a misleading "filesystem/egress skipped"
  warning on the replay lane. The verdict modifiers are now single-sourced from one list (`assert.ts`,
  `cassette.ts`, and the Python linter all derive from / are checked against it), guarded by a convention
  test against drift.
- **A tail-end transport drop is no longer conflated with an agent failure.** A connection closed *after* a
  clean result is classified as `resultErrorKind: "transport"` (vs `"agent"`) and surfaced as a
  lane/assertion-aware `transport_error` verdict — still a failure (no false-green), but distinguishable from
  a genuine skill error; a non-matching envelope falls back to the agent classification.
- **Clearer guard / capability legibility.** The run footer lists only guards that actually ran this lane
  (`capabilityProbe: definitive | unverified | skipped`) — never a false check-mark for a guard that didn't
  run; capability notices state their own safety net + all-clear with verdict-impact tags; the unbuilt `max`
  tier is dropped from capability hints; and Docker pool-exhaustion is reframed as a concurrency limit, not a
  leak.
- **Ordered interrupt cleanup.** A `SIGINT` / `SIGTERM` during a live run reaps in-flight egress resources in
  order (container thunks before network thunks) and announces itself, instead of leaving them dangling.

## [0.8.0] — 2026-06-21

### Breaking changes

- **Work folders now mount at `mnt/<folder-name>`, not `mnt/.projects/<id>`; the folder `to:` field is
  removed.** Binary-verified (asar 1.14271.0): real Cowork mounts each connected work folder at a
  collision-resolved **basename** of its canonical path (e.g. `mnt/project`) with no author-chosen name —
  so the session-schema `folders[].to` override is GONE (it had no Cowork analog; names are always derived).
  Same-basename folders are disambiguated tier-accurately (host-loop keeps the first bare, the VM/container
  tier escalates both with a `--parent` prefix). Plugins likewise move from the synthetic
  `mnt/.local-plugins/cache/<…>` to the real `mnt/.local-plugins/marketplaces/<marketplace>/<plugin>` (no
  `cache/`, no version segment). **Version-gated:** this applies to Desktop **≥ 1.14271.0** (current
  baselines); older baselines keep the legacy `.projects/<id>` + `cache/` paths. `user_visible_artifact`
  and the artifact manifest now derive their visible roots from the actual mount set (persisted as
  `RunResult.userVisibleRoots`), and the cassette format bumps **v3 → v4** to store them.
  - *Upgrade note:* remove `to:` from `folders[]` in session files (the name derives from the folder
    basename). Reference connected-folder artifacts as `<folder-name>/…` (e.g. `project/summary.md`) instead
    of `.projects/<id>/…`. A folder-artifact cassette recorded before v4 must be **re-recorded** (`rehash`
    cannot migrate it — it only re-hashes skill fingerprints). A connected folder whose basename collides
    with a reserved Cowork mount name (`outputs`, `uploads`, `.projects`, …) on the VM/container tier is now
    rejected loudly instead of silently shadowing the fixed dir — rename the folder.

- **Run output now defaults to `~/.cowork-harness/runs`, not `<cwd>/runs`.** A `run` / `skill` / `chat` /
  `record` launched from a repo no longer drops run artifacts (often sensitive skill inputs/outputs) into the
  working tree — the root moved out of any working tree, matching the `~/.cowork-harness/` convention already
  used for VM work dirs. The root is **flat and machine-global** (shared across every project on the machine),
  not per-project. The readers (`trace` / `scaffold` / `verify-run`) resolve the same default, so a bare
  `trace <run-id>` now works from any directory; the previous cwd-relative / repo-root resolution tiers were
  removed. A one-time `runs → <dir>` line prints on stderr when the default is used (suppressed under
  `--quiet` / `--output-format json`, or when an override is set).
  - *Upgrade note (CI / scripts):* anything that reads `./runs` after a run — a CI `upload-artifact path: runs/`,
    a glob over `runs/**`, a `.gitignore` entry — must now set **`COWORK_HARNESS_RUNS_DIR`** (or pass
    `--run-dir`) to a workspace path so output lands where it's expected. Otherwise the step finds an empty
    `./runs` (and, if it doesn't fail on empty, passes silently). The bundled CI recipe sets
    `COWORK_HARNESS_RUNS_DIR: runs` on the live-scenario job for exactly this reason.

- **Agent image bumped `cowork-agent-base:1` → `:2` — REBUILD REQUIRED.** The image now mirrors the real
  Cowork rootfs's preinstalled toolchain (binary-verified by mounting the rootfs): **Node 22.22.3** (was
  ubuntu's node 12), the full **Python document/data stack** (openpyxl/pandas/numpy/pdfplumber/python-docx/
  python-pptx/matplotlib/…), node doc-gen globals (pdf-lib/pptxgenjs/sharp/tsx/…), `ruby`/`ffmpeg`/`qpdf`,
  `C.UTF-8` locale, and it now runs as **uid 1000 (`ubuntu`)** like the real VM. Rebuild with the command
  `cowork-harness doctor --tier container` prints, or set `COWORK_AGENT_IMAGE` to your own tag. *(Why: the
  real rootfs ships openpyxl etc. preinstalled — omitting them made skills that read `.xlsx`/PDFs falsely
  appear degraded under the harness. "pypi blocked at runtime" ≠ "not preinstalled.")*
- **A green run that uses a capability the agent image OMITS now FAILS** (verdict signal `missing_capability`),
  mirroring `permissive_auto_allow`/`l0_plugin_divergence`. The default "core" image omits the heavy lane
  (OCR/LibreOffice/markitdown/opencv/PDF-tables); a run that uses one is a likely false negative (real Cowork
  ships it). Suppress per-scenario with **`allow_missing_capability: true`** (when the fallback is equivalent),
  rebuild full parity (`--build-arg COWORK_FULL_PARITY=1`), use the rootfs `max` tier, or skip the check with
  `COWORK_SKIP_CAPABILITY_PROBE=1`. Live tiers only (container/hostloop/microvm).
- **Stricter, fail-loud guardrails from the codebase bug-review sweep — a few previously-silent paths now
  error.** These close false-greens / false-accepts and can surface on an existing setup:
  - **Negative `verify-run` assertions fail on *missing* evidence instead of passing vacuously.**
    `tool_result_not_contains`, `tool_not_called`, `subagent_tool_absent`, `dispatch_count_max`,
    `subagent_declared_but_unused`, `no_delete_in_outputs`, `transcript_no_host_path`, and `self_heal_ran`
    now fail with an "evidence unavailable" reason when the underlying field is absent from a partial/older
    `result.json` (verify-run lane only — the live and replay lanes, where the evidence is always present,
    are unchanged). *Upgrade note:* re-run rather than re-assert against a fresh `result.json` if a verify-run
    flips to this failure.
  - **Non-strict cassette replay now fails on corrupt `controlOut`** — a malformed line, or a duplicate
    `request_id` with differing bodies — instead of warning and proceeding. Corruption is a protocol-fidelity
    failure, not advisory; `--strict` still additionally catches staleness/extra-data.
  - **`chat --raw` now rejects `--upload` / `--folder` / `--plugin` / `--fidelity`** (it can't honor them in
    native mode) instead of silently ignoring them, and an invalid `COWORK_HARNESS_FIDELITY` value is rejected
    loudly instead of silently falling back to `container`. An invalid `COWORK_HARNESS_MAX_ARTIFACT_BYTES` now
    errors (parity with the `--max-artifact-bytes` flag) instead of silently using the default.
  - **A `web_fetch` `approved_domains` / seed entry that isn't a bare host** (a URL, scheme, path, port, empty
    string, or `*` wildcard) is now rejected loudly instead of being added as an inert, never-matching entry.
  - **An over-cap (> 256 KiB) control-out frame now fails the live recording immediately** with a clear error,
    instead of writing an unreplayable truncation marker that only surfaced later as a replay failure.

### Added

- **Capability fidelity detection.** The harness probes the agent runtime (Docker image via `--network none`
  run, or the L2 microVM via `limactl shell`) for the document/OCR/Office capabilities the real Cowork rootfs
  ships, caches the result by `(tier, identity)`, and detects (from `events.jsonl`) when a skill used an
  omitted one — surfaced as the new `RunResult.missingCapabilityUse` field, a `::notice::`/`::warning::`, and
  the `missing_capability` verdict above. New assertion `allow_missing_capability`.
- **Opt-in full-parity image** (`docker build --build-arg COWORK_FULL_PARITY=1 -t cowork-agent-full:2`) adds
  tesseract / LibreOffice / opencv / onnxruntime+markitdown / camelot+tabula for OCR/Office/extraction skills.
- **Rootfs `max` tier (`npm run build:rootfs-image`)** — builds a Docker image from the user's OWN
  `rootfs.img` (local, byte-for-byte parity; cached by rootfs mtime+size); point `COWORK_AGENT_IMAGE` at it.
- **Provisioning drift gate (`npm run capture:rootfs`)** — captures the rootfs's toolchain to
  `baselines/provisioning/rootfs-provisioning.json`; `--check <image>` diffs a built image against it.
- **L2 (microVM) toolchain parity** — Lima provisioning now installs the same document/data stack
  (best-effort, with 24.04 version drift accepted).
- **`--run-dir <path>` global flag** to relocate the runs root (a thin shim over `COWORK_HARNESS_RUNS_DIR`).
  Precedence: `--run-dir` > `COWORK_HARNESS_RUNS_DIR` > `~/.cowork-harness/runs`. Keeps sensitive artifacts out
  of a working tree without the prior `cd`-into-a-scratch-dir workaround. Both spellings (`--run-dir <path>` and
  `--run-dir=<path>`) are accepted; unlike `--dotenv` it does not require the path to exist (it's an output dir).
- **Cross-project overwrite guard for pinned (`--session-id`) sessions.** On the flat shared root a pinned
  `sess-<id>` run dir is deterministic, so two projects can resolve to the same path. The writer now identifies
  a run by its **mounted-source content** (recorded in an `outDir/.origin` marker) and:
  - **errors instead of silently `rm -rf`-ing** a dir that belongs to a different project (the old behavior
    blind-deleted a colliding peer's persisted, resumable session);
  - **fails closed** on a missing/partial marker (a crashed prior run) — it throws with a "delete `<dir>` to
    reset" hint rather than deleting an unconfirmable dir;
  - treats a **sourceless inline scenario** (which has no content to identify it, only cwd) as unconfirmable —
    it throws rather than risk a cwd-collision delete (`skill <dir>` runs always mount the skill, so the common
    pinned workflow is unaffected);
  - blocks **`--resume`** onto a different project's session in place (override with
    `COWORK_HARNESS_ALLOW_FOREIGN_RESUME=1`).
- **`runs gc` never prunes pinned `sess-*` sessions** (and they don't consume a `--keep-last` slot — partitioned
  out before counting, so a retained pinned dir can't evict a newer ephemeral run). Only ephemeral `local_*`
  runs are pruned. Because the default root is now shared, a bare `runs gc` prunes ephemeral runs across **all**
  projects; pass an explicit `<runs-dir>` to scope it.
- **multiSelect `AskUserQuestion` gates are now answerable on every answer channel.** Scripted
  `choose: [list]` already worked; the in-band `--decider-dir` channel now accepts a repeated
  `--choose` (`answer <dir> --gate 1 --choose Auth --choose Audit`), and `--decider-cmd` helpers /
  hand-written `resp-N.json` accept a JSON-array reply (`{"answers":{"<q>":["Auth","Audit"]}}`). All
  channels deliver the binary-verified `", "`-joined wire shape; a member matching no option, an array
  on a single-select gate, or an empty array each fails loud. `cowork-harness answer`'s `--choose` is
  now repeatable for multiSelect gates (still single-only on single-select). Verified end-to-end
  against a live model (the real agent re-reads the joined answer as multiple selections).
- **`scaffold --from-run`** flags a delivered answer that looks like a multiSelect set (contains
  `", "`) with a loud comment telling the author to split `choose: "A, B"` into `choose: [A, B]`
  before replay (a scaffolded multiSelect answer would otherwise not match on replay).

### Fixed

- `doctor`'s staged-agent remedy now hints to put `COWORK_AGENT_BINARY` in `.env` so `--dotenv` covers it
  (like the auth token) — avoiding a misleading "red" when `doctor` is run without the same env/flags the real
  run uses.
- **`--decider-dir` / `--decider-cmd` no longer crash on a multiSelect array reply.** `coerceLabel`
  previously called `.trim()` on a non-string answer and threw a bare `TypeError`, aborting the run;
  it now throws a clear `UnansweredError` instead, and a multiSelect array is validated per-member and
  delivered as the joined wire shape.
- **Codebase bug-review sweep — 49 validated fixes across the harness** (beyond the behavior changes noted
  under Breaking):
  - **CLI parsing:** `vm status --output-format json` works and emits a JSON envelope, instead of misreading
    the flag as a baseline name; `skill` and common flags accept every documented `--flag=value` form;
    `boundary-check` reports a missing/malformed session as a clean (JSON-aware) usage error rather than an
    internal error; `chat` rejects extra positionals and empty/flag-looking value-flag arguments; `parseArgs`
    rejects empty `--flag ""` values.
  - **Path / boundary hardening:** named baselines can no longer escape `baselines/` via `../`; marketplace and
    staged-mount symlinks that resolve out of tree are rejected (realpath, not lexical); collected artifacts
    skip hardlinks (`nlink > 1`) that could inline out-of-root content into a cassette; a new
    `src/boundary-paths.ts` centralizes `safeNamedBaseline` / `containedRealPath` / `normalizeHost` /
    `validateBareDomain` so the egress allowlist and seed-domain paths share one policy.
  - **Protocol / replay integrity:** every control-request validates its `request_id` before replying; the
    AskUserQuestion body is validated at ingress (optionless / header-only gates still pass); a malformed
    cassette no longer aborts the whole replay batch; a `web_fetch` decision of the wrong kind is recorded as
    `mismatch→deny` with a warning; egress host matching is case- and trailing-dot-normalized.
  - **host-loop fidelity:** the `web_fetch` SSRF backstop pins the vetted address through connect (closing a
    DNS-rebind TOCTOU) and re-vets each redirect; a Docker infrastructure failure (daemon down, missing
    container, exit 125) is reported to the model as a generic harness error and logged raw, instead of
    leaking daemon text framed as a normal command exit.
  - **Fidelity drift checks:** the rootfs `--check` diffs the whole Layer-A pip set (generated from the
    Dockerfile) plus Node, the apt doc stack, and global npm; rootfs image tags are content-addressed; the
    capability cache keys on image content rather than a mutable tag; `sync` cleans its temp extraction dir and
    records a drift signal on a corrupt `config.json`.
  - **decider / schema / Python:** `allow_if` predicates accept non-identifier input keys (`input["file-path"]`);
    `choose`+`answer` and inert `grant` are rejected at schema time; optionless prompt/LLM gates are answerable;
    the Python wrapper returns a `BatchResult` for directory/replay runs so a later failure can't hide behind a
    passing first result.
- **Documentation audit sweep — stale references corrected, gaps filled.** Bumped the "current baseline" pins
  across README / DESIGN / SPEC / spawn-contract / skill docs to `desktop-1.14271.0` (agent ELF 2.1.181),
  re-verified end-to-end against the live staged agent at this baseline; added the missing
  `tool_result_contains` / `tool_result_not_contains` and `allow_missing_capability` assertion rows plus a
  verdict-signals (`prompt_asset_missing`) section to the docs; documented `doctor` / `rehash` / `runs gc` and
  exit code `3` in `llms.txt` and the README command table; corrected the SPEC §11 exit-code table
  (`boundary` → `3`), the `chat --folder` / `folders[].to` notes, the `trace --view tools` flag, and the
  skill-bootstrap version floor (`@>=0.7.1`). **CI fix:** the agent-base image build in
  `.github/workflows/ci.yml` was tagged `:1` while every code path defaults to `:2` — now `:2`.

## [0.7.1] — 2026-06-20

### Fixed

- **`file_exists` and `user_visible_artifact` now pass for truncated (large) cassette artifacts.**
  A truncated manifest entry (`truncated: true`) carries `path`, `bytes`, and `sha256` — positive
  proof the file existed at record time. 0.7.0 incorrectly failed these existence/promotion
  assertions with `"was truncated in the cassette — content was not committed; assertion cannot
  pass"`, producing false-REDs for any cassette whose artifacts exceeded the 64 KiB inline cap.
  Only **content** assertions (`artifact_json`) require the inlined body; existence assertions
  now correctly pass from the manifest. `artifact_json` on a truncated artifact continues to fail
  (the 0-byte placeholder is not valid JSON). Regression test added.

## [0.7.0] — 2026-06-19

### Added

- **`chat --plugin <dir>` (repeatable)** — load additional local plugins into a `chat` session alongside
  the primary skill folder. Each `--plugin <dir>` is appended to `plugins.local_plugins` so multi-plugin
  interactive debugging no longer requires a custom session YAML. In `--raw` mode (native Docker), `--plugin`
  flags are silently ignored with a warning: `chat --raw: --plugin flags are ignored in --raw mode`.
- **`/help` in the `chat` REPL** — typing `/help` in an interactive session now prints
  `Commands: /exit  /quit  /help` and continues rather than forwarding the text to the model. The startup
  prompt was updated from "type your message, /exit to quit" to "type your message (/help for commands)".
- **`scrubField(value, secrets)` exported from `src/secrets.ts`** — a new multi-pass field-level scrubber
  that covers token appearances beyond direct substring matches:
  - Pass 1: direct `scrub()` — catches literal, base64-encoded, and `encodeURIComponent`-encoded tokens.
  - Pass 2: whole-field base64 decode (≥20-char pure base64 strings) — if the decoded form contains a
    secret hit, returns `[REDACTED:base64]`.
  - Pass 3: whole-field URI decode (values containing `%`) — if the decoded form contains a secret hit,
    returns `[REDACTED:uri]`.
  Applied in `cassette.ts` artifact scrubbing: base64 artifacts (`encoding === "base64"`) are replaced
  wholesale with `[REDACTED:base64]`, the encoding marker is cleared (so replay decodes as UTF-8), and the
  sha256 is recomputed over the marker bytes (with a `::warning::` that artifact assertions will fail at
  replay). UTF-8 artifacts pass through `scrubField` safely.
- **`prompt_asset_missing` VerdictSignal** — `computeVerdict()` now pushes a `{ code: "prompt_asset_missing",
  severity: "warn" }` signal when `result.fidelityWarnings` contains a "referenced asset not found" entry,
  making a missing prompt asset visible in the verdict output rather than buried in the run log.
- **`onInfraError` callback in `makeWorkspaceHandler`** — an optional sixth parameter
  `onInfraError?: (message: string) => void` lets callers intercept infrastructure errors
  (ETIMEDOUT / killed / no code+stdout+stderr) separately from model-visible error text.
  `spawnHostLoop()` wires this to append `{ type: "infra_error", ts, message }` to `events.jsonl` so
  infrastructure failures are structured and queryable rather than only appearing in the model-visible
  response string.

### Fixed

- **`ExternalDecider` no longer coerces `"first"` to option 1.** `coerceLabel` gained an
  `enableFirstShorthand` parameter (default `true`). External deciders (`--decider-cmd`,
  `--decider-dir` helpers) now call `coerceLabel(raw, labels, false)`, so a helper script that
  accidentally returns the string `"first"` must match an actual label named `"first"` — it is no
  longer silently promoted to the first option. The shorthand remains active for internal (scripted)
  use.
- **`flagValue` and `chat --model` reject empty strings.** `flagValue()` in `src/cli.ts` now exits `2`
  with a clear message when the supplied value is blank or whitespace-only. `chat` additionally guards
  the `--model` value inline after parsing, so `--model ""` and `--model $UNSET_VAR` both fail loudly
  instead of passing an empty model ID to the runtime.
- **`redactCassette` skips `[REDACTED*]` marker bodies.** The per-line JSON redaction pass
  (`redactJsonLine`) is now bypassed for artifact bodies that already start with `[REDACTED` — preventing
  the sha256 from being corrupted by a second redaction pass over the marker string.
- **TLD list extended from 22 to 51 entries.** The domain scanner in `src/scan.ts` now recognises
  major European, Asian, and Latin American ccTLDs:
  `ch|nl|se|no|it|jp|br|nz|in|sg|kr|mx|es|pt|pl|be|at|dk|fi|ie|ru|cn|tw|hu|cz|ro|il|za|ar|cl|pe|tr`.
  Domain findings that were previously missed on these TLDs now fire correctly.

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

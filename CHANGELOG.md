# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses
[Semantic Versioning](https://semver.org/); pre-1.0 minor versions may include breaking changes.

## [Unreleased]

### Added

- **`RunResult.subagents[].reasoning`** — a sub-agent's own THINKING and TEXT turns, in transcript order,
  surfaced per dispatch. The SDK suppresses sub-agent thinking on the parent event stream entirely, so
  the only channel for "did the sub-agent reason over the right rubric" was previously unavailable; this
  reads the on-disk child session transcript the agent binary writes per `Task` dispatch
  (`<configDirRoot>/projects/**/subagents/agent-<id>.jsonl`), joined to its `RunResult.subagents[]` entry
  via the sibling `agent-<id>.meta.json`'s `toolUseId` (an exact match — no path reconstruction). Resolved
  per fidelity tier (hostloop vs. the container/microvm sandboxed config dir) at finalize, LIVE/record
  lane only — `undefined` on replay, same as `resources`/`mcpErrors`. Capped the same way the top-level
  `thinking[]` field is (~50 entries, ~10KB/entry each), with `reasoningElided` counting the overflow. A
  missing or malformed child transcript never fails the run — the affected dispatch's `reasoning` is just
  left absent.

- **`status --latest-for <scenario-name-or-slug>`** — resolves and prints the NEWEST run dir for a
  scenario by actual run time, replacing the fragile `ls -td runs/<scenario>/* | head -1` idiom: bare
  directory mtime is NOT run recency (it bumps on any later write inside the dir — an `inspect`, a `trace
  --translate-paths`, a slow finalize — independent of when the run itself happened), so it can readily
  return a stale prior-session dir instead of the one you actually just kept. Recency is instead resolved
  from the run's own `.origin` marker `createdAt` (pinned `--session-id` runs) or `result.json`'s mtime
  (the common ephemeral-run case), falling back to `status.json`'s `startedAt` for a run dir with neither
  yet; a run dir with no usable recency signal at all is skipped rather than silently falling back to its
  own mtime. `--output-format json` emits `{scenario, outDir, createdAt, verdict?}` — `verdict` surfaces
  opportunistically from a persisted `RunResult.verdict` when the kept run has one. A scenario with no
  runs on disk fails clean (a message naming the scenario + runs root, exit 2) rather than crashing.
  `outDir` (printed here and by every `run`/`skill`/`chat` invocation) is documented as the canonical
  run-dir handle in docs/scenario.md's "Output" section.

- **`RunResult.verdict`** — a kept run's `result.json` now persists the overall pass/fail: `{pass,
  exitCode, failures}`, the same pass/fail/exit-code `computeVerdict` (the single verdict source)
  computes for the run/skill exit, the footer, and the JSON envelope's `ok`. Previously the ONLY way to
  see why a kept run failed was to re-run `verify-run`; `jq '.verdict' result.json` now answers it
  directly, with `failures[]` naming the failing assertion key (when a failure traces to one) or a
  hard-verdict guard reason (an infra error, an unanswered gate, a scan-based host-path leak, …)
  otherwise. Populated on both the success path and a salvaged (unanswered-gate) partial run — a whiffed
  gate is itself a verdict fail, and its `failures[]` names the gate reason rather than a generic
  placeholder. Scope: the run/asserted lane only — `chat` carries no assertions and no verdict, so the
  field stays absent (undefined) there, same as it always has for every other verdict-adjacent field.

- **`probe-dispatch <skill-dir> "<prompt>"`** — a cheap, focused mechanics probe for a single `Task`
  dispatch. A THIN wrapper over `skill` (same inline session/scenario construction, same `runOneScenario`
  execution; default fidelity `hostloop`, since path-fidelity — this probe's whole reason to exist — only
  matters there): scope the prompt to trigger ONE dispatch, and it prints just that dispatch's
  `{resolvedAgentType, pathDenials, delivered}` instead of the full run transcript. No new `RunResult`
  field backs it — it's a pure projection of data `skill`/`run` already produce
  (`subagents[]`/`fileToolAttempts`/`pathDenials`/`toolResults`); `pathDenials` is scoped to the specific
  dispatch by joining a denial's own `toolUseId` through `fileToolAttempts[].parentToolUseId` (falling
  back to the run-level list, clearly labeled, when `fileToolAttempts` isn't available), and `delivered`
  mirrors the `subagent_dispatch_healthy` assertion's own paired-write computation. `--expect-write
  <suffix>` narrows `delivered` to a specific target path; `--output-format json` emits a compact
  `{dispatches: [...], verdict}` envelope. "One dispatch" is PROMPT-SCOPED, not enforced — Cowork imposes
  no in-conversation dispatch cap — so the probe just asserts it (`subagent_dispatched` +
  `dispatch_count_max: 1`) and reports a failed verdict if the prompt fanned out.

- **`RunResult.subagents[].referencesRead`** — the skill `references/*` / `scripts/*` files a SUB-AGENT
  dispatch actually **Read**, attributed per-dispatch (skill-relative, deduped in first-seen order, same
  filter as the existing top-level `referencesRead`). Previously a sub-agent's Reads were dropped
  entirely even though its `tool_use` blocks already ride the parent stream — this closes that gap
  without touching the top-level (main-agent-only) `referencesRead`, which is unchanged. Present on live
  and replay.

- **`analyze-skill <SKILL.md | skill-dir/>` — a token-free static ADVISORY scan for the "skill hands a
  `/sessions/...` path to a file tool" defect class.** Previously the only way to discover that a skill's
  dispatch prompt or file-tool directive points at a `/sessions/...` VM path — which production's
  host-loop path gate denies unconditionally, since the agent's file tools run on the host filesystem —
  was a paid live host-loop run. `analyze-skill` scans a SKILL.md's text and reuses the harness's own
  ported `/sessions` path-gate predicate (`isVmSessionsPath`, new export in `src/vm-paths.ts`) as the
  deny decision; only the extraction of candidate paths from markdown is heuristic, and it is
  conservative by design — a `/sessions` token inside a fenced bash/sh/shell/zsh block, an
  anti-instruction line ("never write to `/sessions/...`"), or plain prose with no file-tool/output
  context is never flagged. Findings from two rules (`sessions-path-to-file-tool`,
  `sessions-find-into-file-read`) print as advisory warnings and exit 0 by default — the extraction is
  heuristic enough that a hard gate would over-flag innocent documentation; pass `--strict` to fail
  (exit 1) on any finding instead, and put a line containing `analyze-skill: ignore` (bare, or inside an
  HTML comment) in a SKILL.md to silence every finding for that file, even under `--strict`. Exit 2 on a
  usage error. See [docs/subagents.md](./docs/subagents.md#static-path-fidelity-check-analyze-skill) — a
  clean/suppressed result is a PRE-FLIGHT signal only, not proof of on-tier resolution; the runtime
  `no_vm_path_file_op` / `vm_path_denied` assertions remain authoritative.

- **`scenario.py resolve-agent-types <plugin-dir>` + a `subagent_type` check folded into `lint-skill`
  — static resolution of a pinned `subagent_type` against a plugin's own agents.** A `Task` dispatch
  pinning a `subagent_type` that doesn't actually resolve (e.g. `founder-skills:cap-table` when the
  agent is named `captable`) fails a definition lookup at dispatch time — previously only discoverable
  by paying for a live run. `resolve-agent-types` reads a plugin's `name` from
  `.claude-plugin/plugin.json` (fallback `plugin.json`) and each `agents/*.md`'s `name:` frontmatter
  (filename-stem fallback) to build the plugin's valid `<plugin>:<agent>` set (`--json` for a machine
  array); `lint-skill` now extracts every pinned `subagent_type` in a SKILL.md (YAML and
  dispatch-prose forms, not limited to fenced blocks), resolves the enclosing plugin, and flags a
  value that doesn't resolve as `subagent-type-unresolvable` (belongs to another plugin) or
  `subagent-type-unknown` (unresolved bare value). Both are **INFO, never WARN** — there is no
  harness registry of built-in agent types to disprove an unknown value against (only
  `general-purpose` is harness-known), so an unresolved value is always surfaced, never failed. See
  [docs/subagents.md](./docs/subagents.md#static-subagent_type-resolution-resolve-agent-types--lint-skill).

- **`lint-skill` gained a `guard-pattern-mismatch` WARN: a `${CLAUDE_PLUGIN_ROOT}` self-heal `find`
  that targets a different skill/plugin than the one being linted.** The mount-discovery self-heal
  pattern recovers `${CLAUDE_PLUGIN_ROOT}` by `find`-ing the plugin's own mount at runtime, but a
  copy-pasted `-path` glob naming another skill's or plugin's directory silently fails to discover
  THIS skill's mount instead. `lint-skill` now extracts the `-path` glob's skill/plugin/scripts-segment
  token and compares it against the SKILL.md's own frontmatter `name:` (or parent-directory name) and
  enclosing plugin name, warning when they don't match. See
  [docs/plugin-root.md](./docs/plugin-root.md#catch-both-before-a-paid-run).

- **`lint-skill`'s `subagent_type` check gained a third outcome: `subagent-type-not-found-in-plugin`
  (INFO).** A pinned `subagent_type` whose `<plugin>:<agent>` prefix names THIS skill's own enclosing
  plugin, but whose `<agent>` isn't among that plugin's enumerated `agents/*.md`, can never be another
  binary's built-in — the namespace prefix already commits it to this plugin, and the plugin's agent
  set was fully enumerable — so it's reported as `subagent-type-not-found-in-plugin` rather than the
  more equivocal `subagent-type-unknown`. Still INFO, not WARN, consistent with the rest of the
  `subagent_type` ladder's honest-limit posture. See
  [docs/subagents.md](./docs/subagents.md#static-subagent_type-resolution-resolve-agent-types--lint-skill).

- **`subagent_dispatch_healthy: {type?, delivered?, path?, path_suffix?, no_vm_paths?}` — a composite
  assertion for a single dispatch's per-dispatch correlation.** `subagent_file_write` matches ANY
  sub-agent-origin write, so it can't distinguish a delivery from the SELECTED dispatch from one made by
  a sibling dispatch. `subagent_dispatch_healthy` selects dispatch(es) by `type` (same matching as
  `subagent_dispatched`; omit to require every dispatch healthy) and, for each, checks its OWN paired
  non-error write (`delivered`, default `true`, optionally narrowed by `path`/`path_suffix`) and its OWN
  freedom from any `/sessions` VM-path attempt (`no_vm_paths`, default `true`) — both tied to that
  dispatch's `parentToolUseId`, never any other dispatch's. Hostloop-only (the VM-path conjunct can't
  verify off that tier); content-class (`RunResult.fileToolAttempts` + `RunResult.toolResults`),
  replay-checkable without `controlOut`.

- **Docs: a "mechanics-only cheap-model" recipe for observing a skill's plumbing without paying for
  analytical quality.** No new code — this documents combining existing knobs (`--model <cheap-id>` on
  `skill`/`run`, a session's `model:` field, `run --matrix`'s `models:` axis for the main loop;
  `agent_env.subagent_model` for sub-agents) with the path/dispatch telemetry a run already produces
  (`fileToolAttempts`, `pathDenials`, `subagents[].resolvedAgentType`/`dispatchTypeOmitted`) and its
  matching assert keys (`no_vm_path_file_op`, `path_denied`/`vm_path_denied`, `subagent_dispatched`,
  `subagent_dispatch_healthy`) — none of which depend on model quality to be meaningful. Cross-links
  the static, token-free `analyze-skill` scan as the first line and the cheap live run as the second.
  Also states the honest limit: there is no scripted-step driver, so a cheap model still walks a
  skill's steps unassisted and may never reach the step you wanted to observe. See
  [docs/subagents.md](./docs/subagents.md#observing-mechanics-cheaply).

### Changed

- **`toolCounts` shape pinned + clarified.** `RunResult.toolCounts` is always a `{tool: number}`
  call-count map — the schema now strictly pins the value type (including the per-window
  `skillActivity[].toolCounts`, previously unconstrained), and the description distinguishes it from the
  separately-shaped `toolErrors` (`{tool: {calls, errors}}`) and `toolDurations`
  (`{tool: {calls, totalMs, maxMs}}`) so a `jq` recipe can't conflate the three rollups.
- **Breaking (pre-1.0): `verify-cassettes` now distinguishes "could not verify" from "verified and
  found a real problem" in its exit code.** Previously every non-clean outcome exited `1`, so a
  consumer's non-zero-exit tripwire couldn't tell a genuine finding apart from a cassette verification
  simply couldn't run against (e.g. one written by a newer harness) — a version-refused cassette could
  false-green an inverted "must-fail" canary for the wrong reason. Exit `1` is now reserved for
  verification that RAN and found a real problem (a PII finding, a genuine — non-`unverifiable-*` —
  staleness drift, or scenario-prompt drift); exit `3` covers everything that means verification could
  NOT complete (any `unverifiable-*`-class staleness finding, a cassette from a version this harness
  doesn't understand, or a per-file read error/crash). A real finding still wins exit `1` when both occur
  in the same run. The JSON envelope (`schema/verify-cassettes.json`) gained a matching `unverifiable[]`
  bucket per result, split out of what used to be a class-blind `staleness[]`; text output now marks
  those rows `[unverifiable]` instead of `[stale]`.

### Fixed

- **The `no_delete_in_outputs` outputs-delete scan (`isOutputsDelete`) now parses the actual delete
  TARGET by default, instead of flagging on whole-command token co-occurrence.** A binary-verified read
  of real Cowork's own enforcement showed it denies outputs deletes STRUCTURALLY, by the resolved
  target's mount (the `outputs` mount is `rw` without the delete bit) — not by scanning command text —
  so a target-based scan is MORE faithful, not less safe. Previously `T=$(mktemp); …; rm -f "$T"` was
  flagged just because "outputs" appeared elsewhere in the same command, even though the `rm` target was
  `/tmp`. Now each rm-family delete statement's own target(s) are checked; a delete is suppressed only
  when every target is *provably* outside outputs — an absolute/relative path clear of `outputs/`, or a
  path under a safe prefix. `/tmp/` and the literal `$TMPDIR`/`${TMPDIR}` idiom are safe by DEFAULT
  (including a `VAR=$(mktemp …)`-sourced `$VAR`, resolved by a narrow, source-order-aware pass);
  `COWORK_HARNESS_SAFE_STAGING_PREFIX` remains available to union in operator-specific prefixes. An
  unresolved/command-substituted target (anything other than the recognized `mktemp` idiom) still always
  flags — the guiding invariant, "prefer a false positive over a false negative when a target is
  genuinely unprovable," is unchanged. Also fixed in the same pass: `splitStatements` now joins bash
  backslash-newline line continuations before splitting, so a line-wrapped `mv \` / `outputs/a.txt \` /
  `/tmp/b.txt` is scanned as one logical statement instead of being shredded into fragments too small for
  the `mv`-direction check to see both operands (previously an under-detection).

- **The staged NATIVE agent binary (hostloop/cowork tiers) now tolerates a patch-level staging drift by
  default, instead of forcing `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1`.** A mid-session Claude Desktop
  auto-update prunes the pinned native version dir and stages a newer one; since the native binary
  carries no sha256 pin, a same-major.minor patch bump is now auto-accepted (with a loud stderr note
  naming the pinned and substituted versions) rather than hard-failing. A major/minor drift keeps the
  existing behavior — env-gated fallback or a hard throw. `doctor`'s native-binary check surfaces the
  same substitution as an `ok` status with a version-substitution note, sharing one classifier with the
  resolver so the two can't disagree. The sha256-pinned VM ELF resolver is unchanged — it keeps its
  strict exact-or-env-gated-or-throw behavior on a patch-only sibling, verified by a regression test.

- **`lint-skill --strict` no longer fails on an INFO-only result.** The `subagent_type` ladder
  (`subagent-type-unresolvable` / `-not-found-in-plugin` / `-unknown`) is always INFO by design — there
  is no harness registry of built-in agent types to disprove an unknown value against — but `--strict`
  was exiting non-zero on ANY finding, INFO included, contradicting its own `--help` text ("exit
  non-zero on WARN too, not just ERROR") and failing a correctly-authored skill that merely pins a
  built-in `subagent_type` (e.g. `Explore`). `--strict` now fails only on WARN or ERROR severity.

### Docs

- **`docs/subagents.md`: new "Stream observability" subsection.** Names the wire channels
  `RunResult`'s sub-agent and path telemetry are actually derived from — the `task_started` event
  family behind `subagents[].resolvedAgentType`/`dispatchTypeOmitted`, the `toolUseResult` envelope
  (`subagent_result_meta`) behind `resolvedModel`/`output`, the three filtered `pathDenials[]`
  producers (`pretooluse`/`can_use_tool`/`permission_denied`), and the `parent_tool_use_id`
  attribution mechanism behind `toolsUsed`/`referencesRead`. Documents the honest limit that
  sub-agent `thinking` blocks are parsed without a `parentToolUseId` at all, so sub-agent
  reasoning cannot be attributed to a dispatch and never appears in the run artifact — a real gap,
  not a harness omission.

## [0.30.0] — 2026-07-12

> **Upgrade notes.**
> - **Breaking (pre-1.0): `subagents[].agentType` renamed to `dispatchAgentType`, and
>   `subagents[].model` renamed to `dispatchModel`.** A consumer reading either old field name off
>   `result.json` now gets `undefined`. Both keep their original (dispatch-input) meaning — the
>   resolved counterparts (`resolvedAgentType`/`resolvedModel`, below) are new, separate fields.

### Added

- **Parity baseline for Claude Desktop 1.20186.1.** `baseline: latest` now resolves to `desktop-1.20186.1`
  — a patch-only Desktop release (egress allowlist, spawn config, and the Cowork system-prompt
  fingerprint are unchanged from 1.20186.0). The pinned VM agent ELF was re-synced from 2.1.202 to
  2.1.205 after a live Desktop self-update within the same Desktop build, restoring agreement between
  the pinned agent version and what's staged on disk so the host-loop live lane resolves its binary.
- **Cassette prompt-asset fingerprint.** Prompt identity was previously keyed on `appVersion` alone, so
  editing a committed prompt-asset file (`spawn.promptTemplate` / `subagentAppend` /
  `subagentAppendHostLoop`) under the *same* app version silently replayed old-prompt behavior. A cassette
  now records a hash over the referenced asset files (`fingerprint.promptAssetsHash`); a mismatch is a new
  warn-by-default staleness finding (`prompt-assets`, fails under `--strict`), an unhashable pointer is a
  distinct can't-verify finding (`unverifiable-prompt-assets`), and a cassette recorded before this field
  existed surfaces a non-failing informational note instead of either.
- **Host-loop sub-agent tool aliasing and gated `web_fetch`.** The host-loop initialize request now
  carries production's `Bash → mcp__workspace__bash` / `WebFetch → mcp__workspace__web_fetch` aliases
  (single-hop; an alias never grants a tool a sub-agent's frontmatter didn't already bind).
- **Five new assertion keys for sub-agent path fidelity.** `no_vm_path_file_op: true` (hostloop-only —
  no gated file tool attempted a `/sessions`-exact-or-prefixed path); `vm_path_denied: true`
  (hostloop-only — at least one recorded denial targeted a `/sessions` path; needs `controlOut` on
  replay); `path_denied: {tool?, path_matches?, source?, agent_scope?}` (hostloop-only — a denial
  matching all given matchers, `source` ∈ `pretooluse`/`can_use_tool`/`permission_denied`); `no_path_denied:
  true` (hostloop-only — no path denial recorded at all); and `subagent_file_write: {path?, path_suffix?,
  tool?}` (**tier-agnostic** — a sub-agent-origin write/edit attempt at the given path, exact or suffix,
  with a paired non-error tool result — the causal half of a delivery probe, pairs with `artifact_json` for
  content). The four hostloop-only keys fail "cannot verify" (never vacuous-pass) on any other tier, since
  `/sessions/...` is a valid path there.
- **`RunResult.fileToolAttempts`** — attempt-level telemetry (raw `file_path`/`path` as sent, the
  first-match gate path, and `origin: main|subagent|unknown`) for every gated file-tool call
  (Read/Write/Edit/Glob/Grep/MultiEdit), re-derivable on replay from the frozen tool_use stream.
- **`RunResult.pathDenials`** — decision-level path-denial telemetry merged from all three producers that
  can deny a gated file-tool call on path grounds: the PreToolUse path gate's own callback, a denied
  `can_use_tool` ask on a gated file tool with a path, and a pre-ask `permission_denied` correlated to a
  recorded attempt. The `can_use_tool` source is reconstructible on replay only when the cassette carries
  `controlOut`; without it the field is undefined (evidence-unavailable), never a vacuous `[]`.
- **`RunResult.subagents[].resolvedAgentType` / `.resolvedModel`.** The agent stream states the
  binary-*resolved* child type (via `task_started`) and the resolved child model (via the dispatch's own
  `tool_use_result` envelope) — previously discarded. Both are joined strictly by `toolUseId` and
  corroborate each other without overwriting stronger evidence. `subagent_dispatched` and
  `subagent_output_contains` now match on dispatch type, resolved type, *or* description, so a type-less
  dispatch that resolved to e.g. `general-purpose` is selectable by either assertion.
- **A loud warning on type-omitted sub-agent dispatches.** A `Task` dispatch that carries no
  `subagent_type` at all falls back to the built-in `general-purpose` agent (`tools:["*"]` — the wildcard
  surface, including workspace bash) — faithful production behavior, and one that fires routinely, not
  just at the edges. The harness now warns loudly when this fallback is observed (an *explicit*
  `subagent_type: "general-purpose"` is a deliberate author choice and does not warn) and records the
  omission on the run (`subagents[].dispatchTypeOmitted`), so it's visible in the run's own record, not
  only in a live terminal warning.
- **`agent_env` session config knob** (`subagent_model`, `tool_search: "auto"|"off"`,
  `disable_experimental_betas`) applies `CLAUDE_CODE_SUBAGENT_MODEL` / `ENABLE_TOOL_SEARCH` /
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` **uniformly across all four fidelity tiers**. Previously an
  operator-exported value of any of these three leaked into hostloop/protocol (which spawn over the full
  operator shell env) but never into container/microvm (a constructed allowlist) — the same session
  behaved differently depending only on which tier it ran at. The three keys are now also scrubbed from
  the operator layer on the two inheriting tiers before any baseline/knob overlay, so a stray shell value
  can never leak through on some tiers and not others; setting any `agent_env` field moves the session
  fingerprint so `verify-cassettes` surfaces the drift on an older cassette.
- **`sync` now guards sub-agent prompt and path-gate fidelity.** Two new structural sentinels pin the
  two-branch (`subagent_env_hl`/`subagent_env_vm`) sub-agent append — the branch-selection ternary,
  the per-branch content fingerprint, and the substitution map's keys *and* values (a host/VM cwd swap
  fails) — and the host-loop path gate's module-bounded shape (gated/excluded tool sets, every deny text,
  the read-only-guard-before-containment order). A separate pinned gate hard-stops the sync (not just
  warns) if production flips on a server-delivered override of the sub-agent append text, since that flip
  is invisible to the content sentinel and the harness has no captured override text to fall back to.
- **`docs/subagents.md`** — the sub-agent capability/path reference: the tier-qualified outputs-addressing
  contract (host-loop's cwd-relative `artifacts/...` vs. the VM loop's `mnt/outputs/artifacts/...` —
  there is no single cross-tier literal form), a full capability/path matrix, the sub-agent tool-composition
  rules (frontmatter allowlists, the `"*"` wildcard, `disallowedTools`, tool aliases, never-subagent
  tools), the type-less dispatch trap, model-resolution precedence, and lifecycle notes (no resume, a
  depth cap of 5 with no fan-out cap, fork-dispatch environment-append exclusion).

### Changed

- **Cassette v9 read floor.** `readCassette` now refuses cassettes recorded below v9
  (`MIN_SUPPORTED_CASSETTE_VERSION`) with a clear re-record error instead of silently tolerating
  legacy formats; the pre-v9 reconstruction branches (`contentSigAlgoOf`, `buildFolderPrefixMap`'s
  session-fallback, `cmdRehash`'s pre-v3/pre-v6 checks) are deleted as unreachable, and SPEC.md's
  stability contract states the floor. The superseded `schema/cassette.v2`–`v8.json` files are
  removed (v9/v10 remain).
- **`verify-run` fails closed on degraded evidence.** A `result.json` that parses but is
  structurally invalid (no `"success" | "error"` result field) refuses instead of being certified
  as success; an `events.jsonl` with unparseable lines, or one yielding fewer gates than
  `trace.json` recorded questions, refuses instead of passing answer coverage at a hollow 0/0.
- **Verdict honesty for missing scan evidence.** When post-run scan evidence is unavailable, the
  `host-path` / `outputs-delete` guards report `?` (unverified) instead of a false ✓, and a new
  warn-severity `scan_unavailable` signal surfaces in the verdict JSON.
- **Release gates hardened.** The CI scenario suite hard-fails on the canonical repo when
  `ANTHROPIC_API_KEY` is missing on non-PR events (fork and Dependabot PRs keep the warn+skip);
  image publishing now waits on ci.yml success for the tagged commit and verifies tag↔package
  lockstep via a composite action shared with the npm release gate (`workflow_dispatch` remains
  the documented manual-republish escape hatch). An admin can deliberately skip the live scenario
  suite for a single release by setting a `SKIP_LIVE_SCENARIOS` repo variable to that exact commit
  SHA — an explicit, auditable, per-commit override (a later commit can't inherit it), not a silent
  skip; see [RELEASING.md](./RELEASING.md).
- `ResourceSummary.probeFailures` (shipped at runtime in 0.29.0) is now declared on the RunResult
  type and JSON Schema; assertion-side consumption remains deferred.
- **Breaking (pre-1.0): `subagents[].agentType` renamed to `dispatchAgentType`, and `subagents[].model`
  renamed to `dispatchModel`.** Both keep their original (dispatch-input) meaning — the rename exists only
  because a *resolved* type/model now lands beside each (`resolvedAgentType`/`resolvedModel`, above) and
  the old names would have been ambiguous between "what the dispatch asked for" and "what the binary
  actually ran." No deprecation window; a consumer reading the old field names gets `undefined`.
- **The host-loop `PreToolUse` path gate is re-ported to Desktop 1.20186.1 semantics.** Plugin/skill
  content loses its blanket path exemption and becomes a read-only category instead (a mutating tool
  targeting it is now denied, with its own message, rather than silently passing through); the read-only
  guard gains the two other production categories — an uploads hardlink write-block and spooled tool
  results (`projects`) — each with per-session-type deny text; the spool dir joins the readable roots. The
  harness's own `mode: r` connected-folder extension and the `/sessions` MultiEdit message-selection
  nuance are preserved across the re-port.

### Fixed

- **Host-loop sub-agent dispatches now receive the correct environment description.** The harness always
  sent sub-agents the VM-branch environment text, telling them their files exist only in a sandbox while
  their file tools actually reach the real host filesystem — one of two prompt bugs that could seed
  `/sessions/...` paths into a host-loop sub-agent's dispatch. A new host-loop-specific append
  (`subagent_env_hl`) is now selected whenever `effectiveFidelity === "hostloop"` (container/microvm keep
  the existing VM-branch text; `protocol` sends neither, a documented divergence), delivered on **both**
  the `run`/`skill` and `chat` lanes (previously `chat` sent no sub-agent append at all).
- **The host-loop "Shell access" prompt's outputs bullet no longer teaches VM paths to native file tools.**
  Its file-tool side substituted the VM session root where production substitutes the host outputs
  directory — the other of the two prompt bugs behind stray `/sessions/...` sub-agent paths.
- **`web_fetch` on host-loop is now gated through a single `can_use_tool` decision, matching production**,
  instead of being pre-approved directly by the workspace handler. Bash stays pre-approved for the whole
  session; a fetch now emits a real permission ask, answered once by the shared provenance/domain
  decision (which marks provenance on allow) — closing the prior two-decision, self-approving shape.
- **Raw run logs are scrubbed on every exit path.** Previously only the success and
  unanswered-gate paths scrubbed `events.jsonl`/`control-out.jsonl`, and `agent.stderr.log` was
  never scrubbed — a mid-run fault kept raw (potentially secret-bearing) logs on disk. An
  outermost finally now scrubs all three on success, salvage, and every rethrown fault, in the
  run and chat lanes alike; leak/capability scanners still read the raw stream first.
- A truncated `present_files` result (fewer returned paths than inputs, or extras) now counts as
  malformed evidence, so `no_scratchpad_leak` fails "cannot verify" instead of green-lighting
  only the pairs that came back.
- Baseline pins caught up to `desktop-1.20186.1` (the parity sync landed the baseline file
  without bumping them, leaving `check:versions` red).
- `docker/Dockerfile.agent` preinstalls `pyyaml==6.0.3`, matching real rootfs provisioning (the
  container tier no longer exercises the vendored-YAML fallback the real environment never needs).

### Removed

- The subagent-grant canary (`src/canary/`, its fixture, test, and empty snapshot) — never wired
  to `sync`, and its drift snapshot could never fail.
- `scripts/boot-rootfs-vz.ts` — the tested-infeasible generic-VZ boot attempt; its finding is
  preserved in `docs/fidelity-gaps.md`.
- From the npm tarball: the 1.5 MB README banner and the compiled critique evaluator (relocated
  to `scripts/lib/critique/`, dev-only) — the package drops from 2.57 MB to ~1.05 MB compressed.

### Docs

- README's `## Status` section collapsed to the baseline-pin sentence (the perishable
  verification narrative lives in this changelog; the feature catalogue lives in the sections
  above it).
- `docs/cowork-spawn-contract-1.12603.1.md` is frozen as historical research and no longer a
  release version-pin; `check:versions` gates on the SKILL.md and README pins only.
- Dropped the stale first-run egress-race gotcha (proxy startup has been synchronous for a
  while); documented `verify-run`'s fail-closed refusal family in `docs/scenario.md` and the
  companion skill.
- `docs/subagents.md` (new — see Added) is cross-linked from `docs/boundary.md` and `docs/scenario.md`;
  `docs/plugin-root.md`'s tier table is corrected — `CLAUDE_PLUGIN_ROOT` is absent from a Bash-tool
  subprocess's env on **every** tier, not host-loop only, as the table previously implied.

## [0.29.0] — 2026-07-11

### Added

- **Parity baseline for Claude Desktop 1.20186.0.** `baseline: latest` now resolves to `desktop-1.20186.0`
  (VM agent ELF 2.1.202 unchanged; native host app 2.1.205). The 1.20186.0 asar was a minifier re-anchor —
  the value-resolved spawn contract is byte/behaviourally identical; the sync extractor's structural anchors
  were re-anchored to the new bundle shapes (hoisted helpers became namespace-method calls; const spreads
  became export aliases). Verified live across the `protocol`, `container`, and `hostloop` tiers.
- **`sync` now guards Cowork system-prompt drift.** Each sync fingerprints the prompt (a minifier-independent
  content hash plus a `{{placeholder}}` / `<section>` inventory) and **refuses to write** when the content
  drifts from the committed fingerprint until a new fingerprint entry is added, and **hard-fails** on a
  `{{placeholder}}` the renderer neither substitutes nor explicitly allowlists. This closes a gap where a
  prompt change (e.g. the deployment-gated `{{modelIdentity}}` placeholder added in 1.20186.0, which is
  stripped on first-party so the rendered prompt is unchanged) could slip past the coarse `asarFingerprint`.
- **Usage/quota-limit runs are now classified as `resultErrorKind: "usage_limit"`.** A session/weekly/model/
  spend/org quota-exhaustion arrives as an `is_error` result with the SDK's misleading `subtype: "success"`
  and HTTP 429 — previously an undifferentiated error, indistinguishable from a real skill regression.
  Detection is conjunctive (`api_error_status === 429` **and** a terminal usage-limit message; a bare 429 is
  a transient overload and is not reclassified). `resultSubtype` is kept verbatim (faithful SDK passthrough).
  Surfaced on `RunResult`, `status.json`, and a distinct verdict signal ("retry after reset") so a batch can
  halt-fast; the `claude -p` decider transport fails fast (non-retryable) on a usage limit instead of
  retrying into a spent quota.
- **`input_unmodified` can now guard uploaded files (`uploads/**`).** Uploads are captured as a read-only
  input root (hash-only in cassettes — a private upload is never inlined), so a scenario can assert the agent
  didn't mutate an uploaded file; a mutation is attributed to the agent (not excused as an external edit).
  Previously only connected-folder inputs were guardable.
- **`RunResult.command`** records the exact command that produced a result (`run`/`skill`/`record`/`chat`/
  `replay`) — finer than `mode` (which only distinguishes run vs. chat, so a `skill`/`record` run was
  indistinguishable from a plain `run`). `reindex` now prefers this field, so a rebuilt run index no longer
  relabels a `skill`/`record` run as `run`; it falls back to a prior index row, then to `mode`, on older
  results that predate the field.
- **`RunResult.evidenceErrors.egressParse`** counts proxy-log lines the egress sidecar dropped as malformed
  (bad JSON, missing host, unknown decision) — previously filtered out silently. Observability only (egress
  assertions are positive, so a dropped line already fails loud), but now visible.
- **`subagents[].outputTruncated` and `toolResults[].assertTextTruncated`** flag when a captured value was cut
  at the 10 KB assertion cap, so `subagent_output_contains` (and the equivalent substring checks) report
  "evidence unavailable" instead of a false "not found" when the searched text could lie past the cut.
- **`fingerprint.frozen`** marks, on the replay lane, that the staleness fingerprint is the cassette's
  record-time snapshot rather than a fresh recompute, so a consumer can't mistake one for the other.
- **Replay results now populate `prompt` and `toolResults`** (the scenario prompt that drove the re-drive and
  the tool-result records already built for evaluation) — both were previously always `undefined` on replay.
- **`ResourceSummary.probeFailures`** counts resource-sampling probes that actually failed (nonzero exit,
  timeout, parse error), distinct from a tier that was never sampleable (protocol/replay) — "sampling broke"
  is now told apart from "sampling wasn't attempted."
- **`chat` now samples real resources on the `container`/`hostloop` tiers.** Previously no `ResourceSampler`
  was ever started for a chat session on either tier, so `resources.jsonl` was always empty despite
  `chat-result.ts`'s doc-comment claiming resource parity with `run`; a protocol-tier chat legitimately has
  none (no container/process id to probe against the host `claude` binary).

### Changed

- **`input_unmodified` accepts a single glob string** as well as an array (`input_unmodified: 'uploads/**'`
  no longer errors "expected array").
- **`sessionFingerprintDrift` keeps an unresolvable session fingerprint non-failing (informational)** and
  downgrades a mismatch to a non-failing note when the cassette's session was only resolved via a
  name-lookup fallback (the SAME low-confidence signal `scenarioContentDrift` already downgrades on) —
  a relocated cassette whose relative-offset resolution lands on an unrelated same-named session file no
  longer reads as a false "session shape drifted."
- **`artifact_json`'s replay remedy names an uploaded input distinctly** — a body-less target that was
  captured hash-only because it's an *upload* now says so directly, instead of the prior combined
  readonly-or-over-cap wording that didn't cover the uploads case.
- **`scenario.py lint-skill`** downgrades a `${CLAUDE_PLUGIN_ROOT}`-in-VM-bash use to a `plugin-root-guarded`
  **INFO** (from WARN) when the same bash block self-heals it at runtime (`[ -d ] || find /sessions …`), so a
  correctly-guarded block no longer shares the alarming WARN class with a genuinely-unguarded use.
- **`no_unexpected_files` now requires a complete post-run filesystem walk.** An unreadable subtree
  (permission error, race) previously collapsed to "no files found there" and could vacuously pass; the check
  now fails "evidence unavailable" when any part of the tree couldn't be observed.
- **`semantic_matches` refuses to grade over incomplete authored-file evidence.** When a file the run authored
  was dropped at the capture-size budget or was unreadable at read-back (or, on `--resume`, the scratchpad was
  skipped to avoid misattributing a prior turn's files), the assertion fails "evidence unavailable" rather than
  trusting a judge grade made without that content. The judged document is also size-capped now (per-section
  and total, with an explicit truncation marker) so a long run can't overflow the judge's context; secret
  scrubbing runs before the cap, so a secret can never be exposed by falling on a truncation boundary.
- **`task_status` now honors corrupt task telemetry** — when a `TaskCreate` result was unparseable it fails
  "malformed" instead of matching against the surviving subset, consistent with `all_tasks_completed` /
  `task_count_min`.
- **Empty or regex/brace-expansion tool globs are rejected at load.** `tool_called` / `tool_not_called` /
  `subagent_tool_used` / `subagent_tool_absent` values that are empty or contain regex/brace metacharacters
  (`.*`, `|`, `[]`, `{}`, …) match no real tool name and used to pass a `_not_`/`_absent` assertion vacuously;
  they are now a hard schema error for authored scenarios and recorded cassettes alike.
- **`readRunStatus` validates the shape of `status.json`**, not just that it parses — a truncated or otherwise
  structurally-invalid write (e.g. `{}`) is reported malformed instead of being trusted as a valid status; a
  `--follow` loop resolves only after observing a genuinely valid status.
- **Answered gates reconcile against actual delivery.** A control-response that was optimistically reported
  delivered (queued) but whose write later failed before reaching the agent is corrected once the run
  completes, so delivery telemetry and `trace --view questions` read the true outcome.
- **A `TaskCreate` / `WebSearch` / `present_files` call whose result never arrived before the stream ended now
  counts as incomplete evidence** (`evidenceErrors.*`) instead of silently vanishing from the resolved set, so
  the dependent assertion fails "cannot verify" rather than grading a truncated subset as complete.
- **Bounded hashing/reads.** `classifyWorkspaceFiles` caps per-file hashing (50 MiB, matching the pre-run
  manifest) and reports `hashError: "over-cap"` instead of reading a huge file whole; authored-file capture
  reads only the bytes it retains.

### Fixed

- **`sync` no longer derives a phantom `nativeStagedPath`.** The native macOS agent app (`claude-code/`) and
  the container/microvm Linux ELF (`claude-code-vm/`) version on independent cadences; `sync` derived the
  native (hostloop) path from the VM `.sdk-version`, producing a path that did not exist whenever the two had
  drifted — and freezing that phantom into the written baseline. It now resolves the native path from the
  newest app actually staged under `claude-code/`, falling back to the version-derived convention only when no
  native app is staged at all.
- **Two anonymous sub-agent dispatches in different assistant turns could collide on the same synthesized id**
  (the fallback id was derived only from the block's position within its own message). It now derives from the
  message id plus block index — unique across the run and stable across record→replay — fixing dispatch nesting
  in `trace --view dispatches` for skills that dispatch multiple unnamed sub-agents.
- **The semantic judge's recorded model could name the wrong one.** `assertions[].judgeModel` was stamped from
  the requested alias (e.g. `opus`) before the call; the transport resolves an alias to a concrete model per
  call, so the resolved model is now recorded after the call completes.
- **`matrix --repeat`'s per-cell pass/fail glyph didn't honor `--allow-budget-stop`**, though the aggregate
  "N/M cells passed" count did — a cell that passed under a permitted budget stop could print as failed next to
  its own row while counting as a pass in the summary.
- **The resource sampler could miss a short run's only sample.** `stop()` now waits (bounded) for an in-flight
  probe before returning, so a run shorter than one sampling interval reliably records its first sample instead
  of racing teardown.
- **A corrupt `timeline.jsonl` header was indistinguishable from an absent timeline** — both read as "no
  timeline," so a corrupt read could be baked into a recorded cassette as a clean empty timeline. A corrupt
  header now reads as a distinct "present but corrupt" state, kept out of both live results and cassettes.
- **A malformed `system/init` frame** (a non-array `tools`/`mcp_servers`/`skills`, or a non-object content
  block) could crash with an uncaught `TypeError`; it is now rejected as a typed protocol error at parse time,
  and the `trace` reconstruction lane skips it instead of aborting.
- **`verify-cassettes` no longer aborts the whole batch on a nameless cassette.** A lenient cassette with
  no `scenario.name` (and no `scenarioSource`) threw inside the per-file verification, which aborted the
  entire run (`results: []` — a false-green by abort) instead of reporting that one file's error and
  continuing. Each file's verification is now wrapped so a per-file crash becomes that file's error row
  (mirrors `replay`'s existing per-file catch).

### Internal

- **Eval-gate hardening** (`scripts/eval-gate.ts`, maintainer instrument — not shipped with the skill): a
  missing/edited scenario or discriminating claim now fails the gate (opt-out `--allow-unmatched`); a mixed-model
  capture, a null candidate model against a concrete baseline, and a malformed profile/fraction are refused
  instead of silently collapsing; child runs are bounded by a timeout, output cap, and process-group kill.
- **Skill-critique hardening** (`scripts/skill-critique.ts`, `src/critique/*`): the reflection turn's exit,
  envelope, and session/output continuity are validated before evaluation; a corrupt or missing turn archive is
  reported rather than substituting turn-2 data; the untrusted self-report is fenced as inert data before the
  evaluator prompt; child turns are bounded and orphaned process groups are killed on interrupt.

## [0.28.0] — 2026-07-10

### Added

- **`trace --view tool-errors|files|usage`** — three new views: `tool-errors` (one row per errored
  tool call with the full multi-line stderr, capped at 4KB, vs. the 120-char preview in `tools`);
  `files` (`workspaceFiles` as a class-grouped tree with an added/modified/removed/unchanged diff
  column vs. `preRunHashes`); `usage` (the full per-model token/cost/cache breakdown behind the
  default view's combined cache-ratio footer).
- **`replay --explain`** — prints the concrete evidence behind every *passing* assert (which
  `computer://` link resolved, which file matched, which value satisfied a bound), so a green run can
  be told apart from a vacuous one (e.g. a presence-gated key that matched zero links).
  `--output-format json` already carried `assertions[].evidence`; `--explain` governs the text render.
- **`replay --reassert --write`** — persists a token-free-revalidated assert block back into the
  cassette when *only* the assert block changed, closing the gap where a pure assert-semantics edit
  (`max_tool_errors`, `task_count_min`, `computer_links_resolve_if_present`, `allow_stall`, …) cost a
  paid re-record. Refuses to write any added key that would silently skip on this cassette
  (evaluability guard), refuses a failing reassert verdict without `--allow-failing`, and redacts only
  the spliced assert block (events/controlOut/fingerprint stay byte-identical).
- **`verify-cassettes --margins`** — replays every cassette carrying a count-bound assert and reports
  recorded-vs-budget with a margin ratio (e.g. `recorded=15, budget=30` → `2.0×`), flagging a tight
  count budget without a paid `run --repeat`. Diagnostic only; never changes the gate verdict.
- **`scenario.py lint-skill <dir|SKILL.md>`** — catches two Cowork host-loop authoring footguns before
  a paid run: `${CLAUDE_PLUGIN_ROOT}` used as an in-VM bash path (it's unset in the host-loop VM), and
  a hook that writes env vars or `/tmp` for the in-VM agent to read (host-side hook writes aren't
  VM-visible). Consumer-aware — doesn't flag the token in host-side prose or `Read`/`Grep` directives.
- **Cassette format v10 — symlink/hardlink-aware recording.** Manifest entries gain `linkKind`; links
  record path-only (no dereference, sha256 `""`) and materialize on replay as placeholders. Pre-v10
  cassettes keep replaying unchanged (no forced re-record).
- **Cowork system-prompt drift fingerprint** (`baselines/prompts/cowork-system-prompt-fingerprints.json`):
  the SHA-256 + code-point/section-tag counts of the raw Cowork system-prompt constant per Desktop build,
  so prompt-append drift is detectable across releases without publishing the proprietary verbatim text.
  The append is verified **unchanged** from 1.18286.0 to 1.18286.2 (identical code-point count and section
  structure).
- **Execution-location taxonomy** — four additive, absent-compatible fields so a future cloud-run
  artifact can never be silently mislabeled as a local one, and filesystem-dependent guards degrade to
  evidence-unavailable rather than false-passing: `RunResult.execution` (`{location, environmentId?,
  taskKind?}`, stamped `location:"local"` on every locally-executed run, wired through all five
  `RunResult`-assembling call sites — a replay honestly passes through the recording's own location
  instead of guessing); `Cassette.environment` (recording-time provenance stamp, no `cassetteVersion`
  bump); a manifest-local `origin` field on the pre-run manifest (`"local-walk"` today; a
  `"remote-unavailable"` producer would make `no_unexpected_files`/`input_unmodified` fail loud instead
  of vacuously passing on an unwalkable tree); and a reserved `Scenario.execution` enum
  (`"local"` default | `"cloud-describe"`, which hard-errors at load time — like
  `replay_protocol_fidelity` — since no runner exists for it yet, rather than being silently accepted
  and ignored). No cloud execution capability is added; these are purely descriptive/forward-compat.
- **`semantic_matches` assertion** — a live-only, LLM-judged assertion that grades a fixed `rubric` of
  claims against the run's answer — the **union of the agent's final result text (`RunResult.finalMessage`),
  the transcript, and the final on-disk content of any files it authored during the run**, so a claim about
  content the skill led the agent to *write to a file* grades as reliably as one about inlined prose — one
  pass/fail per claim. Per-claim results are recorded on `RunResult.assertions[].semanticClaims`
  (`{index, claim, pass}`), so a candidate run's claim-level profile can be diffed against a baseline instead
  of only reading a single summary verdict; a rep whose grade can't be parsed (after one retry) is marked
  `RunResult.assertions[].judgeInvalid` and **never silently dropped** — it is excluded from the pass
  denominator, and the guard against a misleading score from that exclusion is the eval gate's
  minimum-valid-rep floor (`MIN_VALID` ≥ 4) plus this visibility, not a claim that denominator-shrinking
  inflation is impossible. Within a rep, a grade still unparseable after the retry fails that assert outright
  (evidence-unavailable, not a vacuous pass). Supports a
  `min_pass` threshold (default: all claims) and a per-assert `judge_model` override (default
  `claude-opus-4-8`, also settable via `COWORK_HARNESS_JUDGE_MODEL`) — the override is now actually
  honored per assert, and the model that graded is recorded on `RunResult.assertions[].judgeModel` so a
  before/after eval can verify the judge was held constant. Classified live-only alongside `egress_*` —
  stripped on replay (skipped-loud), never a vacuous pass.
- **`RunResult.referencesRead`** — the skill's `references/*` / `scripts/*` files the agent actually
  **Read** during the run (skill-relative, deduped in first-seen order): a progressive-disclosure signal
  for "did the agent reach this content?" skill-quality measurement. Main-agent Reads of `references/`/
  `scripts/` (not `assets/`, not sub-agent reads); `SKILL.md` is delivered whole (never Read as a file),
  so it never appears. Present on live and replay.
- **`RunResult.finalMessage`** — the agent's final answer text: the SDK result message's own designated
  answer, not the joined transcript of every assistant turn. Lets a consumer read what the agent actually
  answered without parsing `run.jsonl`. Threaded through every `RunResult` producer (live success and
  salvaged-partial, replay re-drive, `chat`); `undefined` on a truncated/error cassette.

### Fixed

- **`tool_called` / `tool_not_called` / `subagent_tool_used` / `subagent_tool_absent` are now GLOB-matched,
  not exact-string.** These four keys did an exact tool-name lookup, so a family pattern like
  `tool_called: mcp__workspace__*` was unsatisfiable (it searched for a tool literally named
  `mcp__workspace__*`). They now match a glob — `*` = any run, `?` = one char, everything else literal,
  anchored + case-sensitive — so `mcp__workspace__*` matches any workspace tool while an exact name (`Write`)
  still matches only that tool (no over-match: `Edit` ≠ `MultiEdit`). Existing exact-name asserts are
  unchanged. A pattern carrying a regex-only metacharacter (`.*`, `|`, `[…]`) is warned, since it matches no
  tool name under glob and could otherwise silently pass a `_not_`/`_absent` assert. Failure messages now
  list the tools that actually ran. (Distinct from `tool_available`, which stays a regex.)
- **A resumed turn no longer clobbers an earlier turn's `run.jsonl` / `result.json`.** Both were
  rewritten in full each turn, so after a `--session-id` + `--resume` session you could not recover
  turn 1's transcript or result — while `events.jsonl`/`timeline.jsonl` (append-mode) blended turns.
  `run.jsonl` and `result.json` now stay the **latest** turn (unchanged for their readers) and
  `RunResult` carries a `turn` number; each prior turn is preserved as `run.turn-<N>.jsonl` /
  `result.turn-<N>.json`, so every turn's transcript and result remain recoverable and attributable.
- **`sync`'s asar-bundle reader followed a stale assumption about Desktop's Vite build output.** A
  Desktop release that code-splits `.vite/build/index.js` into a small entry stub plus a
  content-hashed chunk file (rather than one monolithic bundle) was silently read as near-empty
  content, misreporting real spawn-contract/mount-mode/web_fetch facts as broken. `readMainBundle()`
  now follows the entry's local `require()` references transitively so both bundle layouts read
  correctly.

- **`--output-format json` output from `replay`/`record`/`verify-cassettes`/`rehash`/`doctor` no longer
  silently truncates past 64KB.** These commands wrote their JSON envelope via the async
  `process.stdout` stream then exited; on a pipe, the buffered tail past the ~64KB pipe buffer was
  dropped at exit — corrupting any `| jq` or `subprocess.run` consumer at exactly 65536 bytes (a file
  redirect drained fully, hiding the bug). 0.27.0's richer replay envelope pushed real cassettes past
  the threshold, exposing it. Both emitters now use synchronous `writeSync`, matching the CLI's
  existing mitigation.
- **Closed a symlink/hardlink blind spot spanning recording, containment, and assertions** that let an
  agent-created link silently pass (or a legitimate one silently fail):
  - `no_unexpected_files` and the pre-run baseline didn't see symlinks/hardlinks at all — a stray link
    could ship a false-green. Both now walk a link-aware path collector.
  - Live host-shaped and VM-shaped `computer://` containment checks were symlink-blind (lexical join,
    following the link on `existsSync`) — an in-tree symlink escaping the work root could resolve as
    contained. Both now realpath-resolve once the candidate exists.
  - `input_unmodified`'s pre-run manifest skipped hardlinked inputs entirely (a real inode with
    in-root content, common in `pnpm`/`cp -l` trees) — now hashed like any other file. Symlinks stay
    path-only (correctly excluded from content hashing).
  - On replay, a recorded link materialized as a placeholder file indistinguishable from a real one,
    so `file_exists`/`user_visible_artifact`/`computer_links_resolve` PASSED where live could RED a
    dangling or escaping symlink. These three now fail evidence-unavailable on a link path instead.
  - `verify-run`/`--resume` against a pre-v10 run dir now compares on the same links-blind basis as
    its baseline (new `RunResult.preRunLinkAware`), instead of false-straying every pre-existing
    symlink as "created".
  - A marketplace `entry.source` resolving to the marketplace root itself (`""`, `"."`, `"./"`) is now
    rejected at the traversal guard — it previously staged the entire marketplace as one plugin.
- **`CLAUDE_PLUGIN_ROOT` is left unset in the host-loop VM sidecar**, matching production (live-probed:
  real host-loop leaves it unset and the agent self-heals via `find`). The harness previously injected
  a bogus `/host/plugins/unmounted` sentinel that leaked a fake host path into guest bash. Skills that
  read the token in the wrong context are now caught by `lint-skill` above.
- **`remote_plugins` mounts to `.remote-plugins/plugin_<id>`**, matching a migrated Cowork install
  (UI-uploaded / org-remote plugins), not `.remote-plugins/<basename>` — which also fixes a basename
  collision when two `remote_plugins` entries shared a name. The synthetic id is derived from the
  *declared* source string (not a resolved absolute path), so it stays stable across machines/checkouts.
- **Nested sub-agent dispatch trees now reconstruct from `result.json`.** `parentToolUseId` was
  silently dropped when a sub-agent record was pushed, so `trace --view dispatches` couldn't nest a
  grandchild agent under its parent.
- **Nested connected folders now remap to the correct mount on replay** regardless of the order they
  were declared in (longest-prefix-first matching).
- Several evidence-honesty corrections so `result.json` doesn't misreport what was actually observed: a
  zero-task run now emits `tasks: []` (not `undefined`); `context.tools`/`context.mcpServers` are
  unseeded (not a false empty inventory) when a crash happens before init; a `tool_result_contains`
  match against a display-truncated result reports evidence-unavailable instead of claiming the string
  is absent; host-path leak detection also flags `/private/var/`, `/var/folders/`, and `/Volumes/`; an
  all-malformed resource log reports `malformedLines` instead of looking never-sampled; gate-provenance
  pairing in `trace --view questions` uses the persisted `requestId` (retry/duplicate-safe) instead of position.
- `record`/`replay`/`verify-cassettes`/`rehash`'s `--output-format json` **error paths** now conform to
  the shared error envelope (previously bare plain-text on some paths); `verify-run`/`assertions`/
  `trace`/`diff`'s **success** JSON is now wrapped in the same envelope for cross-command consistency
  (additive — every existing field and exit code is preserved).
- **Un-pinned the minified gate-check helper name in the spawn-env extractor.** Desktop 1.18286.2
  re-minified the renderer, renaming the GrowthBook gate-check helper (`At`→`et`). The extractor matched
  it by literal name at four sites in `src/sync/cowork-sync.ts`, so `sync` reported unknown deltas and —
  more importantly — one site silently failed open (an off-gate `MCP_CONNECTION_NONBLOCKING` spread would
  have leaked `"0"` over the base env with no flag). The extractor now matches the helper by shape, still
  guarded by the closed `SPAWN_GATES` set and the S18 anchor; a rename-regression test covers it.
- `artifact_json` no longer crashes on a stat race between the existence check and the read (fails the
  assertion instead). A `config_dir` that exists but isn't a directory now gets a clear error instead
  of a raw `ENOTDIR`. Protocol staging now fails loud (`BoundaryError`) if a *required* mount's source
  vanishes between plan-build and staging, instead of silently staging an empty tree.
- **The companion skill's own docs pointed at repo-only files** (`docs/`, `README.md`) that a
  marketplace-installed agent never receives — only `SKILL.md` + `references/` + `scripts/` are staged.
  Every such pointer is now prose describing where the fuller doc lives in the source repo, not a
  markdown link, so it can no longer render as a dangling link for an installed agent.

### Documentation

- Added `docs/plugin-root.md` — the `${CLAUDE_PLUGIN_ROOT}` two-namespace resolution model (host-side
  reads vs. in-VM bash), the single most common Cowork authoring footgun.
- Documented the assertion-edit-to-CI propagation chain (scenario edit → `--reassert`/`--assert-from`
  validates free → embed via re-record or `--reassert --write`) next to the frozen-vs-on-disk rules.
- Reorganized the skill's debugging guidance around the kept-run-dir → `trace`/`result.json` →
  `verify-run` loop as the primary, first-class debugging path (previously buried under interactive
  `chat`).
- **Companion skill restructured around the three loops — author → run → debug.** `SKILL.md` now reads
  Preflight → Orient → Part I (Author a scenario) → Part II (Run, record & lock) → Part III (Debug) →
  Gotchas → References, with debugging a first-class Part reachable from the top rather than a
  sub-section. Every prior section was re-homed, not dropped, and cross-references now cite stable
  section titles instead of numbers so a future move can't silently break them.
- **Single-source debug triage.** A link-free triage decision-table — which tool to reach for when "the
  skill misbehaved" vs. when "a green you don't trust" — is authored once and kept byte-identical
  between the shipped skill and `docs/debugging.md` by a test, so the two surfaces can't drift apart.
- **Documented how uncommitted skill edits are staged.** The harness stages git-*tracked* files but
  copies their *working-tree* content, so an uncommitted edit to an already-tracked skill file is tested
  without committing (only brand-new files must be `git add`-ed to appear). Because real Cowork installs
  the committed tree, commit before recording the locking cassette — a green on uncommitted edits isn't
  yet a green on what ships.
- **Companion skill: documented `semantic_matches` end to end, with a new recipe.** It walks authoring
  Q&A gate scenarios that install the skill, writing discriminating rubric claims verified against
  ground truth, confirming `skillsInvoked` (a rep where the skill never triggered measures the model's
  own priors, not the skill's guidance), running several reps and reading the per-claim pass profile
  rather than a single all-or-nothing run, and gating a change on the profile diff. Also documents two
  guarantees the harness already provided but hadn't stated: batch `record` writes each cassette
  atomically (same-directory temp file + rename, so an interrupted or OOM-killed batch never leaves a
  partial/corrupt cassette), and each scenario gets full isolation under `--concurrency` (its own egress
  sidecar network and proxy, its own run directory). And documents the actual
  `--allow-domain`/`-email`/`-path` matching semantics: whole-token anchored, but case-sensitive unless
  the pattern's regex carries an `i` flag.

### Internal

- **`schema/run-result.json` is now kept in sync with the `RunResult` type automatically.** A new
  name-level drift test derives the type's field set from `src/types.ts` (TS compiler API) and asserts
  the schema declares exactly those fields, both directions — closing the gap where an added type field
  could ship undeclared in the §12 schema (six such fields — `finalMessage`, `resources`,
  `contextEvents`, `mcpErrors`, `hookEvents`, `presentedFiles` — were backfilled). Complements the
  existing value-shape validation; the hand-authored descriptions/shapes are preserved (no fragile full
  regenerator).
- **Answer-quality regression gate** for the project's own companion skill — one tool
  (`scripts/eval-gate.ts`; `test/evals/`, not shipped as part of the skill; live, not in `npm run ci`).
  `--rebaseline` records a per-claim pass-rate baseline; `--calibrate` tags which claims the skill actually
  drives via skill-ablation (a claim that still passes without the skill is excluded from the gate); the
  default run gates a candidate skill edit with a one-sided Fisher-exact test per discriminating claim
  (α=0.05) plus a trigger-rate check. The baseline records the judge + answerer models it was captured
  under, and the gate refuses to diff across a model change (which would report model drift as a skill
  regression). Replaces an earlier per-claim diff + baseline-profile aggregator that never composed.
- **Reflective skill-critique loop** (`scripts/skill-critique.ts`; a maintainer discovery instrument,
  not shipped with the skill, never in CI) — runs a skill against a probe, resumes the session for the
  agent's own subjective account, then has a separate, log-grounded two-pass evaluator classify each idea
  against turn-1-only evidence (`grounded-and-actionable` / `already-covered` / `confabulated` /
  `not-adjudicable`) with mechanically-validated verbatim citations. Emits triaged, human-adjudicated
  recommendations; it never edits the skill and always exits 0.

- **Programmatic multi-turn (`cowork.skill(folder).conversation([...])`)** — feed N user turns to one
  persisted session and get a `Result` per turn: turn 1 pins `--session-id`, later turns add `--resume`
  so the agent reloads the conversation. Makes the natural "ask → inspect → follow-up" loop
  (self-report, iterative probing) a single first-class call instead of hand-stitched session/resume
  calls. Backed by a new **container-tier `--resume` continuity integration test** that proves the agent
  session actually survives the container boundary (a fresh turn-2 container recalls a fact established
  in turn 1) — the plumbing was argv-tested but never proven end-to-end before.
- **`--ablate-skill`** (on `run` / `skill`) — run the same prompt with the skill(s)-under-test removed:
  a deterministic negative control for skill-lift measurement (with-skill vs. without). All plugin/skill
  discovery is stripped so nothing mounts and the agent answers from its own priors; model/folders/egress
  are preserved. The result is stamped `RunResult.ablated: true` so a consumer never reads an ablated run
  as a real (with-skill) pass. Pairs with the `semantic_matches` per-claim profile to quantify how much a
  claim depends on the skill vs. the model's priors.
- **`prune --pinned-older-than <N>d|h|m`** — opt-in reclaim for pinned (`--session-id`) run dirs, which
  are otherwise retained unconditionally. A programmatic consumer that mints one pinned session per run
  (e.g. one per eval × rep) previously leaked them forever with no policy; this reclaims pinned sessions
  whose last activity is older than the window, while fresh ones survive. Nothing pinned is touched
  without the flag; `--dry-run` previews.

### Removed

- **`trace`'s legacy `--tools` / `--gates` / `--dispatches` flag aliases.** Use `--view tools` /
  `--view questions` / `--view dispatches` instead (the canonical form since the view set grew to seven
  views). The retired spellings now fail loud as an unknown flag (exit 2) rather than silently
  selecting a view, so a stale script surfaces immediately instead of tracing the wrong thing. Exit-code
  semantics (0/1/2/3/127) and the `--output-format json` envelope are unchanged. The shipped Python
  wrapper's `cowork.trace(..., tools=True)` now drives `--view tools` and keeps its signature.

### Changed

- **Synced the platform baseline to Claude Desktop 1.18286.2** (`baselines/desktop-1.18286.2.json`).
  The staged agent ELF moved to **2.1.202** (measured sha256 recorded). `sync` re-derived the volatile
  facts: the full spawn contract (env, mounts, egress, gates) is **byte-identical** to `1.18286.0` — only
  `appVersion`/`agentVersion`/`agentBinary`/`asarFingerprint` moved, no unknown deltas.

## [0.27.0] — 2026-07-07

An observability pass: `RunResult` now surfaces per-tool timing, error/redundancy rollups, model
attribution and spend, sub-agent and skill-level detail, context/progress/workspace panels,
in-place mutation detection, hook/MCP/egress/crash diagnostics, and sandbox resource usage — plus a
`chat` session now leaves the same trail (`result.json`, trace, run-index row) as a scripted run.

> **Upgrade notes.**
> - **`RunResult.subagents[].toolsUsed` changed from `string[]` to `Array<{ name, count }>`.** A
>   consumer reading a sub-agent's tool usage directly off `result.json` must update — the field now
>   carries per-tool call counts instead of a bare list of names.
> - **`RunResult.artifacts` is now a derived view of `workspaceFiles`.** Same shape
>   (`{ path, bytes }[]`), so no consumer action is needed unless you were relying on it being stored
>   independently.

### Added

- **Per-tool durations and per-message model attribution.** `RunResult.toolDurations` (per-tool call
  count / total ms / max ms) and `RunResult.models` (distinct model ids seen, first-seen order). New
  `trace --view tool-durations`.
- **Tool-error rollup, redundant-call detection, reasoning capture, and per-model usage.**
  `RunResult.toolErrors` (per-tool call/error counts), `RunResult.redundantToolCalls` (repeated
  identical `{name, args}` calls), `RunResult.thinking` (capped reasoning blocks), and
  `RunResult.modelUsage` (per-model tokens/cost/cache, denormalized from the SDK result). New
  assertions `tool_no_error`, `max_tool_errors`, `max_redundant_tool_calls`. New
  `stats --metric cache-tokens|model-cost` and a cache-ratio footer on `trace`.
- **Sub-agent enrichment.** `RunResult.subagents[]` entries gain `prompt`, `model`, `output`, and
  `attributedSkillId`. `trace --view dispatches` now prints each node's prompt/output/model. New
  assertion `subagent_output_contains`.
- **Skill-to-tool-call attribution.** `RunResult.skillActivity[]` — per-skill-activation-window tool
  tallies and durations. New assertion `skill_tool_used`.
- **Context, progress, and working-folder panels.** `RunResult.context` (the init manifest's `tools`,
  `mcpServers`, `availableSkills`), `RunResult.tasks[]` (from the agent's TaskCreate/TaskUpdate calls),
  and `RunResult.workspaceFiles[]` (every user-visible file, classified `output` | `mount` | `input`,
  with `bytes` and `sha256`). New assertions `all_tasks_completed`, `task_status`, `skill_available`,
  `connector_available`, `tool_available`.
- **`input_unmodified` assertion** — an in-place mutation detector backed by a new
  `RunResult.preRunHashes` (per-path sha256 of the pre-run tree, size-capped): every pre-existing file
  matching a glob must keep an unchanged content hash after the run. Complements
  `no_unexpected_files`, which only sees newly created files.
- **Hooks, MCP, egress, uncaught context events, and crash diagnostics.** `RunResult.hookEvents`
  (PreToolUse fire/block), `RunResult.mcpErrors` (failed MCP round-trips), `RunResult.contextEvents`
  (uncaught system events, including compaction boundaries); richer per-request egress detail
  (method/path/port/bytes plus deny reason and timestamps); a finer-grained `RunResult.errorSource`
  (spawn/protocol/exit/agent/result) and `RunResult.stderrLogPath`; the denied tool input is now
  recorded in `decisions[].detail`. New assertions `hook_blocked`, `no_hook_blocked`,
  `no_mcp_error`, `compaction_occurred`.
- **Sandbox resource-usage telemetry.** `RunResult.resources` (peak RSS, avg/peak CPU%) sampled while
  the run executes on every live tier (container/hostloop/microvm); sample interval tunable via
  `COWORK_HARNESS_RESOURCE_INTERVAL_MS`. New live-only assertion `max_peak_rss_bytes`.
- **`chat` sessions now write `result.json`, a trace, and a run-index row** (tagged `mode: "chat"`,
  no verdict), so an interactive exploration is visible to `stats`, `trace`, and `scaffold` the same
  way a scripted run is.

The timing/resource/model fields above are informational — they never affect a scenario's pass/fail
verdict on their own. `no_mcp_error` and `max_peak_rss_bytes` are live-only and excluded on replay;
`hook_blocked`/`no_hook_blocked` need a `controlOut` cassette on replay; `input_unmodified` needs the
pre-run hash manifest (container/hostloop — not captured on microvm). All new assertion keys are
additive: existing cassettes keep replaying with no cassette-version bump.

- **Legible terminal-error reasons.** A failed run no longer reads as a bare `error`. `RunResult` (and,
  new, `status.json`) now carry `errorSource` — extended with `no_result` (the stream ended with no
  terminal event, i.e. turn/time exhaustion) and `timeout` — plus `resultSubtype` (the SDK result
  subtype verbatim, e.g. `error_max_turns`) and `stderrLogPath`. The CLI failure line names the reason
  (`✗ error (error_max_turns)`, `✗ error (no_result)`, …). Diagnostic only — not read by the verdict.
- **Turn and wall-clock budgets.** Session `agent_max_turns` raises the agent's turn ceiling via the
  agent's own `--max-turns` (omitted by default → faithful to interactive Cowork, which passes none);
  scenario `timeout_ms` (or `skill --timeout <ms>`) sets a wall-clock budget — on expiry the harness
  kills the agent and the run ends `result:error` / `errorSource:timeout`. Both are distinct from the
  `max_turns` *assertion* (a post-hoc upper-bound check).
- **`verify-cassettes` now catches scenario prompt drift.** A committed scenario whose `prompt` diverged
  from the cassette's frozen prompt (invisible to the skill/baseline fingerprint) is a hard fail, in its
  own `scenarioDrift` envelope bucket; an unresolvable/unparseable source degrades to a non-failing note.
  Opt out with `--skip-scenario-drift`. `replay` surfaces the same drift as a non-failing notice.
- **`present_files` delivery is now served and observable on the container tier.** A new `cowork`
  sdk-MCP server promotes a scratchpad file to `mnt/outputs` on `present_files` (with realpath/symlink
  containment on the host-local copy), then injects a synthetic `notifySession` user turn so a
  multi-turn skill learns the promoted path instead of continuing to write to the stale scratchpad one.
  New `RunResult.presentedFiles` (one entry per presented file, classified `promoted` / `leaked` /
  passthrough) and the `no_scratchpad_leak` assertion, both content-class (re-derived from the ordinary
  `tool_use`/`tool_result` stream, so they replay identically). **Container tier only** — hostloop and
  microvm don't serve `present_files`, so a scratchpad-delivered file on those tiers is neither promoted
  nor detected; use `fidelity: container` for `present_files`-based delivery.
- **`RunResult.decisions[].questions`** — the full `AskUserQuestion` option set (label + description per
  offered option, plus `header`/`multiSelect`) as originally offered by the model, additive alongside
  the existing `detail` (flat chosen-answer) field.
- **Structured `WebSearch` capture.** `RunResult.webSearches` now carries the query and per-result
  `{title, url}` pairs, parsed from the paired tool_result's link listing, instead of being dropped as
  unrecoverable. Collapses to `undefined` (matching `models`/`thinking`/`tasks`) when the run made zero
  `WebSearch` calls — cross-reference `toolCounts.WebSearch` if a zero-calls vs. all-parses-failed
  distinction ever matters.
- **`RunResult.thinkingElided`** — count of reasoning blocks dropped past the 50-block cap on
  `thinking[]`, so a consumer can tell "this is everything" from "this is the tail of a much longer
  chain." `0` whenever `thinking[]` exists at all (a meaningful "never hit the cap" signal); `undefined`
  only on lanes where no run/record ever existed.

### Fixed

- **A non-interactive `chat` session (piped/redirected stdin) no longer crashes with a readline error
  before writing its result.** It now exits cleanly and still writes `result.json`.
- **`record` no longer prints a spurious `cassette stale: skill dirs not resolvable` warning on every
  redacted recording.** The redaction verdict-preservation self-check replayed the cassette without its
  directory, so the relocatable (relative) session path couldn't resolve and the skill-staleness check
  always reported "can't verify". It now threads the cassette dir through, exactly as `verify-cassettes`
  does — the warning fires only on genuine drift.
- **A `context:fork` skill's (or explicit `Agent(subagent_type:"fork")`) inner tool calls now count as
  main-agent work.** They carry `parentToolUseId` = the `Skill` call's id, but the `Skill` call was never
  a registered sub-agent dispatch, so they were silently dropped from `toolCounts`, `toolsCalled`,
  `toolErrors`, and `redundantToolCalls`. A fork inherits the main agent's context, so its tools are the
  run's own work; real (non-fork) sub-agent dispatches are unaffected — their inner tools stay isolated
  in `subagents[].toolsUsed` exactly as before.

### Changed — verification is now strict-by-default ("can't verify / incomplete is not green")

A hardening pass over the false-green surface. Several assertions and lanes that previously passed on
missing, malformed, or incomplete evidence now fail. This can flip a currently-green run to red — see
the upgrade notes below.

- **Missing/malformed telemetry fails "cannot verify"** instead of passing silently. Task tracking,
  `present_files`, `WebSearch` parse, and resource samples now record error counters
  (`RunResult.evidenceErrors`, and `resources.malformedLines`) that make the dependent assertion fail
  malformed rather than dropping the bad data; an unreadable workspace file records `hashError` instead
  of an empty hash.
- **Presence-required assertions.** `tool_no_error`, `all_tasks_completed`, and `computer_links_resolve`
  now require at least one matching element (a regex that matched nothing, zero tasks, or zero links
  fails, so a typo can't pass vacuously). New opt-in siblings preserve the lenient behavior:
  `tool_no_error_if_called`, `task_count_min`, `computer_links_resolve_if_present`.
- **`no_scratchpad_leak` is gated to the container tier** (the only tier that serves `present_files`);
  on any other tier it is evidence-unavailable, never a vacuous pass.
- **Verdict modifiers (`allow_*`) are `true`-only** — `allow_x: false` is now a schema error (it
  suppressed nothing but read as intentional). **`artifact_json` requires a non-empty `artifact`** and
  rejects an explicit empty `path`. **A typo'd `requires_capabilities` family hard-fails** as an
  authoring error instead of being silently ignored.
- **Incomplete batches fail by default.** A truncated `--matrix` and a budget-stopped `--repeat` now
  fail unless you pass `--allow-truncated-matrix` / `--allow-budget-stop`.
- **Strict replay.** A cassette from a NEWER format version fails unless `--best-effort-future-cassette`;
  an unrecognized/malformed assertion in a current-or-older cassette is rejected (it would otherwise
  drop silently from replay); the assertion schema rejects unknown keys at scenario parse too.
  `verify-cassettes` hard-fails **all** recording-shaping drift (baseline, fidelity, answers, skills,
  capabilities — not just prompt) when the persisted source resolves exactly.
- **`record --rerecord-stale` refuses the embedded-snapshot fallback** when no on-disk source resolves
  (it would silently drop scenario edits) — pass `--from-embedded` to opt in; `record` also refuses to
  overwrite a default-path cassette belonging to a different scenario (slug collision) unless `--force`.
- **Infrastructure errors (egress/VM sidecar crashes) are a hard verdict fail on both lanes** and are
  not author-suppressible — the run's evidence is contaminated.

> **Upgrade notes (verification strictness).**
> - Scenarios relying on any vacuous pass above will now fail; add the matching element, adopt the
>   `*_if_present`/`task_count_min` sibling, or pass the relevant opt-in flag.
> - **Cassette format v9.** New cassettes carry a session fingerprint and a persisted record-time folder
>   map, so replay resolves host-shaped `computer://` links against the recorded correspondence rather
>   than re-reading the current session. Existing v8-and-earlier cassettes keep replaying unchanged
>   (backward-compatible); re-record to adopt the new staleness checks.
> - `verify-cassettes`, `record --dry-run`, and `rehash` now emit the standard `{tool, version, ok,
>   error}` JSON envelope under `--output-format json`.
> - `verify-run` now treats `input_unmodified` as filesystem-bound (refuses "can't verify" when the work
>   dir is gone, instead of a spurious removed-file failure).

The additive pieces: new assertions `tool_no_error_if_called`, `computer_links_resolve_if_present`,
`task_count_min`; flags `--allow-truncated-matrix`, `--allow-budget-stop`, `--best-effort-future-cassette`,
`--from-embedded`, `--force`; `RunResult.infraErrors` and `RunResult.evidenceErrors`.

The corrections: `present_files` restricts mount presentation to the real Cowork root allowlist
(`outputs`/`uploads`/`.host-home`/`.auto-memory`/connected folders) instead of any `mnt/` path (binary-
verified); egress host-matching strips IPv6 brackets and supports `*.` wildcards in assertions, without
IDNA-folding allowlist entries (matching the sandbox proxy); resource sampling takes an immediate first
sample (short runs are no longer unmeasured) and warns on an invalid interval env var; the egress sidecar
no longer builds `dist/` at runtime and surfaces a fatal proxy error; `--run-dir ~/x` and session
`~user` paths expand correctly; a non-array `present_files` argument returns a structured MCP error
instead of throwing; output deletions via a script/non-bash tool are caught by a filesystem pre/post
diff; and a read-only connected-folder file changed mid-run is attributed as external mutation rather
than an agent violation.

## [0.26.0] — 2026-07-05

Cassette/run-result **format-freeze** pass before 1.0 — fixes the parts of these schemas that become
irreversible once 1.0's semver contract freezes them.

> **Upgrade notes.**
> - **Staleness-hash framing changed → `cassetteVersion` 8.** A pre-v8 cassette's staleness fingerprint
>   is non-comparable with v8, so `verify-cassettes`/`rehash` route a pre-v8 cassette to **re-record**
>   with an honest "algorithm changed" message (not a misleading "content changed"). Re-record your
>   committed cassettes. (Cassettes without a `skillHash` are unaffected and keep replaying.)
> - **`RunResult.unanswered` renamed to `nonReproducibleAnswers`.** Consumers reading
>   `result.unanswered` must switch to `result.nonReproducibleAnswers` (the field never held literally
>   unanswered gates — it holds gates answered by a non-reproducible source).
> - **Cassette-level `readonlyFolderRoots` removed** in favor of per-entry
>   `ManifestEntry.truncationReason`. No consumer action unless you parsed the cassette directly.

### Fixed

- **Two staleness-hash framing collisions (a false-negative — the risk the gate exists to prevent).**
  `skillHash` folded raw file content after a `F:<path>\0` marker, so a file whose content embedded that
  marker could hash identically to a two-file tree; it now folds the fixed-length content SHA
  (self-delimiting, charset disjoint from the `F:`/`L:` prefixes). `contentSig` lacked a type marker and
  used `:` between path and sha, so a file named `a:lnk` could collide with a symlink `a`; entries are now
  type-prefixed (`F:`/`L:`) and NUL-framed, and the `L:` link line NUL-separates path from target. Only
  fixable before the hash algorithm freezes at 1.0.

### Changed

- **Cassette format v7 → v8** (`CONTENTSIG_ALGO` 3 → 4). See the framing fix above and the upgrade note.
- **`RunResult.unanswered` → `nonReproducibleAnswers`** — a self-admitted misnomer in the frozen
  run-result envelope, renamed before the 1.0 freeze.
- **Body-less manifest entries now carry `ManifestEntry.truncationReason`** (`size` | `readonly` |
  `unreadable`) instead of a cassette-level `readonlyFolderRoots` list — self-describing and
  redaction-immune. Replay reads the reason to give `artifact_json` the precise remedy on every lane
  (assert on a deliverable vs. raise `--max-artifact-bytes`).
- **`schema/run-result.json` completed** (added `fingerprint`, `userVisibleRoots`, `readonlyFolderRoots`,
  `preRunPaths`, `toolResults`) and now strict-validated by a test, and the `cassette.v8.json`
  `ManifestEntry` shape is fully described — so the schemas frozen at 1.0 match what ships. Corrected the
  git-mode-default documentation (git is the default unless `COWORK_HARNESS_GITSET=0`).

## [0.25.0] — 2026-07-05

> **Upgrade notes.**
> - **`verify-cassettes --allow-file` was renamed to `--allow-patterns-file`** and the old spelling is
>   removed (exits 2). Update any CI step or allowlist wiring that passed `--allow-file`.
> - **`gate_answers_delivered: true` now passes vacuously when zero gates fired.** If you relied on it
>   as an implicit "a gate must fire" check, add `gate_answer_count_min: 1` alongside it.
> - **Read-only (`mode: r`) connected-folder inputs are now captured body-less.** Re-record affected
>   cassettes to drop the `--allow` entries they previously required and shrink them; an `artifact_json`
>   assertion pointed at a read-only input now reports evidence-unavailable (assert on a deliverable).
>   This changes committed cassette *contents* (not the staleness hash) — a re-record is cosmetic, not
>   required for correctness.

### Added

- **`gate_answer_count_min: <N>` assertion** — the presence companion to `gate_answers_delivered`:
  fails unless at least N `AskUserQuestion` gates fired AND were delivered non-error. Pairs with
  `gate_answers_delivered`'s new zero-gate vacuous-pass (below) the way `transcript_contains` pairs
  with `computer_links_resolve`'s zero-link vacuous-pass. Evaluated on replay only with a `controlOut`
  cassette, like the other gate keys; fails as evidence-unavailable (not vacuous-pass) when
  gate-delivery telemetry is absent from `result.json`.

### Changed

- **`gate_answers_delivered: true` now passes vacuously when zero `AskUserQuestion` gates fired**,
  instead of hard-failing. Whether a gate fires is model-dependent, so any skill with optional gating
  could not use the assertion under the old hard-fail. The bad-delivery check (an answered gate whose
  answer wasn't confirmed delivered) is unchanged — it only ever mattered when gates fired. Missing
  gate-delivery telemetry (an old/partial `result.json` on the verify-run lane) still fails loud as
  evidence-unavailable, never vacuous-pass — this is NOT the same as "no gate fired" and preserves the
  bug-#33 false-green fix. Pair with the new `gate_answer_count_min` (below) to also require presence.
- **`verify-cassettes --allow-file <path>` renamed to `--allow-patterns-file <path>`.** The old name
  read as "allow this file" and was routinely confused with `--allow <regex>` (a pattern matched
  against a finding) — reaching for `--allow-file <artifact-path>` failed with an ENOENT/invalid-regex
  error instead of doing what the user meant. `--allow-patterns-file <path>` is self-documenting: the
  path names a **file of patterns** (one regex per line), not a path to allow. Pre-1.0 rename with **no
  deprecation window** — the old `--allow-file` spelling is hard-removed and now exits 2 with an
  unknown-flag error. The binary-finding recourse message and both `--help` texts now spell out the
  distinction between the two flags.

### Fixed

- **Read-only (`mode: r`) connected-folder inputs are captured body-less (path + hash) instead of as
  full binary bodies.** `record` used to sweep a `mode: r` folder's files into the cassette
  `artifacts[]` as full base64 bodies — an input the agent only reads, not a deliverable — causing
  cassette bloat and a hard `binary` privacy finding that forced `--allow`. The manifest entry now
  carries `path` + `bytes` + `sha256` with `truncated: true` and no `body`, reusing the same
  representation the 64-KiB inline cap already produces. The entry still survives in the manifest (it
  is NOT excluded), so `computer_links_resolve`/`file_exists` resolve identically on live and replay.
  `artifact_json` against a body-less target (a read-only input, or any artifact over the body cap)
  reports a clear **evidence-unavailable** on every lane — live, verify-run, and replay all agree, so
  a cassette can't record green and replay red. The cassette persists the read-only-folder set
  (`readonlyFolderRoots`, a subset of `userVisibleRoots`), so replay knows *why* an entry is body-less
  and gives the **precise** remedy — "assert on a deliverable" for a read-only input, "raise
  `--max-artifact-bytes`" for an over-cap artifact — instead of a cryptic JSON parse error or a
  guessed hint. A `mode: rw`/`rwd` folder's contents are unaffected and keep their full body.
- **`trace --view questions` and the `scaffold` helper disagreed with `questions_count_max` on what
  "a question" counts.** The assertion counts **sub-questions** (one `AskUserQuestion` bundling K
  sub-questions counts as K — the better spam/burden budget, since per-tool-call counting would miss
  a 10-in-1 bundle), but `trace --view questions` collapsed a bundle into one row with no count, and
  the scaffold helper emitted `questions_count_max: <gate count>` — a budget that could start BELOW
  what the assertion computes and false-red on the first real run. No behavior change to the
  assertion itself: `trace --view questions` now annotates each gate row with its sub-question count
  and prints a footer total (`N gate(s), M sub-question(s) total`) that matches what
  `questions_count_max` compares against. The static `scaffold` helper can't know the sub-question
  count offline, so instead of fabricating a value it now emits `questions_count_max` **commented
  out** as a calibration TODO pointing at `trace --view questions` (a budget must come from
  observation, not a guess — a fabricated one either false-reds or is a dead tripwire). The count
  definition is now documented in `docs/scenario.md`, `docs/cassette.md`, `SPEC.md`, and the skill's
  `references/scenario-schema.md` / `SKILL.md` gotcha list.

## [0.24.0] — 2026-07-05

### Added

- **`no_unexpected_files` assertion** — per-scenario glob allowlist over **newly created** files under the
  user-visible roots (workRoot-relative paths; `**` matches any depth). Post-hoc stray-file / fabricated-
  artifact detection for the founder-skills hand-off contract (consumer ask, 2026-07-04); pairs with their
  script-side `_produced_by` / `UNVALIDATED_ARTIFACT` check for overwrite-in-place bypasses this key cannot
  see. Records a pre-run path baseline (`preRunPaths` on the cassette + `pre-run-manifest.json` on kept runs;
  optional field, no cassetteVersion bump). **Live/verify-run** without a baseline ⇒ evidence-unavailable
  hard-fail; **replay** without `preRunPaths` ⇒ loud exclude (pre-0.24 cassettes). **Microvm** does not
  capture (existing artifact-tree gap) — use container/hostloop. Live runs capture the baseline when the
  scenario asserts the key; recordings always capture it, so a later assert-add replays without re-record.

- **Two new documented fidelity gaps: guest runtime identity and session-slug shape.**
  Runtime forensics over a local install's Cowork VM disk images (coworkd's own logs) established
  that production provisions a **dedicated Unix user per session** inside the VM (`useradd`,
  name = session slug, uid=gid sequential ≥1014, `HOME=/sessions/<slug>`) and spawns the agent and
  every bash call as that user via `oneshot-<uuid>` supervisor jobs — where the harness's
  container/microvm tiers run static uid-1000 `ubuntu` with `HOME=/tmp`. Production's in-VM slugs
  are Docker-style name triples (`beautiful-bold-planck`), not the harness's `local_<hrtime36>`;
  the `local_<uuid>` shape exists in production only as Desktop's host-side session-record
  filenames. Both are recorded in `docs/fidelity-gaps.md` with observable consequences (`whoami`,
  `id -u`, `~`-relative writes, cwd shape); the `Dockerfile.agent` uid-1000 comment no longer
  claims runtime parity. Initial lead credit: the founder-skills project's journald forensics,
  independently re-verified here against this machine's own VM images before documenting.

- **The `verify-cassettes` JSON envelope is now a published, 1.0-covered contract surface.**
  SPEC §12's covered list previously named the RunResult envelope but was silent on §11.1's
  `verify-cassettes` envelope — even though the CI recipe and the packaged GitHub Action steer
  consumers to parse exactly that output, and an uncovered machine-output shape can rot a consumer's
  `jq` gate silently (a renamed key yields `null`, and the gate stops gating). The envelope is now:
  listed in §12 (rename/removal = MAJOR; additive growth stays MINOR), published as
  `schema/verify-cassettes.json` in the npm package, and pinned by
  `test/verify-envelope-schema.test.ts`, which validates real CLI output against the schema in both
  directions (a required key the CLI stops emitting fails, and — via a strictened copy — a key the
  CLI starts emitting without a schema update also fails). Writing the schema immediately caught one
  doc drift: the per-file `version[]` channel (newer-harness cassette → hard fail) was emitted but
  missing from §11.1's envelope block; the SPEC block, `ok` formula, and exit-code line now include it.

- **Skill-effectiveness workstream.** Three deliverables, all targeting the same failure mode
  observed in real skill adoption: the facts existed across the docs, but nothing composed them
  into the task a scenario author actually faces:
  - **`references/task-recipes.md`** — four end-to-end recipes that consumers previously had to
    reverse-engineer from scattered reference docs: evolve a cassette's `assert:` block (usually token-free via
    `replay --assert-from`; the recording-shaping-drift caveat spelled out), audit a fleet for tier
    drift (`effectiveFidelity` + the new `resolved-tier`/`unverifiable-tier` classes + a cassette
    anatomy table), set up redaction before the first hostloop/protocol record (`init-redact`,
    search set, scanner relationship, `--allow-*` scoping idioms), and derive budget assertions
    from an existing run instead of a two-pass record.
  - **Four new eval cases** (`evals/evals.json` 5 → 9, ids 6–9), each a question a real consumer
    hit, passing iff the agent reaches the cheap path: assert evolution without a
    fleet re-record, reading a cassette's recorded tier (with a fixture cassette via `files[]`),
    the exact `--allow-file` format (and its all-class scope trade-off), and batch `record`
    atomicity semantics.
  - **Doc-drift tripwire** (`test/skill-docs-sync.test.ts`), scoped to the kinds of drift that
    actually happened (NOT a naive new-CLI-flag gate, which would have caught neither motivating
    example): extends the `cassette-docs-sync` pattern to pin the skill's assertion catalog against
    `schema/scenario.schema.json` and the skill docs against the current cassette schema's
    top-level field list. Plus a CONTRIBUTING checklist line for consumer-visible workflow changes.

### Fixed

- **Gate `1648655587` was mislabeled as a Task-dispatch cap; it is the scheduled-task session
  limiter.** A binary-verified forensic pass (asar 1.18286.0, `class L9t "[ScheduledTasks]"`) plus one
  adversarial-review round established that gate `1648655587` (`{perTask:1, global:3}`) governs
  Cowork's **scheduled/recurring (cron) task** session scheduler — ≤1 concurrent session per
  scheduled task, ≤3 concurrent scheduled-task sessions globally — **not** the in-conversation
  `Task` tool. The Desktop imposes **no** cap on `Task`-tool sub-agent fan-out at all (the `Task`
  PreToolUse hook only blocks `run_in_background`). SPEC §10, `docs/fidelity-gaps.md`,
  `docs/scenario.md`, the skill (SKILL.md gotcha 6 + `references/scenario-schema.md`), the
  1.18286.0 baseline gate note, and `dispatch_count_max`'s failure message are all corrected;
  `dispatch_count_max` is now described as an author-chosen budget assertion, not enforcement of a
  (non-existent) production Task cap. The `PINNED_GATES` rename
  (`taskDispatchLimiter → scheduledTaskSessionLimiter`) also landed, regenerated through `sync`
  against the same Desktop 1.18286.0 install (never hand-edited): the 1.18286.0 baseline now
  carries the corrected gate key, older baselines keep the historical label, and the sync
  gate-merge now matches previous entries by gate **id** (not exact `name:id` key) so a rename
  carries the note/state across and can't resurrect the old key as a stale duplicate. This
  supersedes the earlier "faithful Task-dispatch runtime limiter is planned" language — there is
  no production behavior to mirror.

- **`schema/cassette.v7.json` was missing `userVisibleRoots` and `scenarioSource`** — both fields
  are written by `record` (since format v4 / 0.8.0 and 0.20.0 respectively); `userVisibleRoots` was
  even named in the schema's prose `description` while absent from `properties`. Found by the new
  skill-docs tripwire while pinning the field list.

- **Redaction preflight + `init-redact`.**
  `record` now warns (`::warning::`) **before the agent spawns** when a scenario about to record at a
  host-path-bearing tier (`hostloop`, or `protocol`) has an EMPTY assembled redaction policy — that
  combination commits real host paths, which `verify-cassettes`' `path` scanner then hard-fails; the
  empty-policy discovery used to happen only at the post-run policy load, after the run was paid for.
  Batch `record <dir>` and `--rerecord-stale` preflight ONCE for the whole batch, before the first
  spawn (never N interleaved duplicates). A malformed `.cowork-redact.json` now also fails pre-spawn.
  The reference `.cowork-redact.json` (generic local-path prefixes + email regex) now ships in the npm
  package, and the new `cowork-harness init-redact [--force]` copies it into the cwd — the copy is
  load-bearing, since the policy search set (now documented in `docs/cassette.md` and the skill's
  ci-recipe) is cwd → scenario dir → cassette dir (+ `COWORK_HARNESS_REDACT_*` env), never the package
  dir. The always-on privacy scanner remains the universal net — container-tier recordings can trip it
  too.

- **Lint catches fidelity/assert combinations that fail by design.**
  `scenario.py lint` (and the `cowork-harness lint` wrapper) now ERRORs on
  `transcript_no_host_path` + `fidelity: hostloop` or `protocol` (the agent legitimately runs on real
  host paths at those tiers — the assertion can never be a meaningful check there; lint is
  deliberately stricter than the runtime's run-start warning), WARNs on `transcript_no_host_path` +
  `fidelity: cowork` naming the host-loop gate-resolution dependency (the linter stays offline — the
  message carries gate id `1143815894` instead of reading a baseline, pinned against the
  `cowork-sync.ts` gate table by a sync test so a Desktop re-key can't rot it), and ERRORs on
  non-empty `requires_capabilities` + `fidelity: protocol` without `allow_missing_capability` (the
  capability probe can't run at protocol tier, so the run hard-fails as unverifiable).

- **Resolved-tier staleness detection.** A
  `fidelity: cowork` cassette records the tier the loop-decision gate resolved to
  (`effectiveFidelity`); `verify-cassettes` / `replay` now detect when the current baseline resolves
  that scenario differently (gate `1143815894` flipped since record) and emit a new `resolved-tier`
  staleness finding — the recording exercises the wrong tier. Resolution is baseline-only (the
  scenario's pinned `baseline:` when present, else `latest`; the `CLAUDE_FORCE_HOST_LOOP` env override
  is suppressed) so verify results can't differ across machines. A `cowork` cassette whose tier can't
  be verified (predates `effectiveFidelity`, or its pinned baseline fails to load) gets a loud
  `unverifiable-tier` finding — never a silent skip, never an aborted sweep. Both classes hard-fail
  `verify-cassettes` (class-blind gate) and warn-by-default on `replay` (`--strict` escalates;
  `--fail-on-skill-drift` ignores them — they are not skill-source drift). A pre-`effectiveFidelity`
  cassette with an *explicit* tier is statically knowable: it passes with a non-failing informational
  note in the new per-file `notes[]` of the `verify-cassettes` envelope (a `·` row in text output).
  `schema/run-result.json` now also declares `staleness` (full class enum) and `skippedAssertions`,
  closing a pre-existing gap vs SPEC §11.

## [0.23.0] — 2026-07-04

### Added

- **The baseline `spawn.env` is now binary-derived and drift-alarmed, not hand-transcribed.** `sync`
  enumerates the Desktop→agent spawn env directly from the `app.asar` construction (three windows +
  gate/const value resolution) and writes the resolved map into the baseline, guarded by a
  `checkSpawnContractFacts` sentinel over the scalar options/tools/prompt structure. Additions,
  removals, and value changes in the spawn contract now surface as loud `sync`-time signals instead of
  drifting silently. This closed real, already-present drift: seven env keys the production agent
  receives (`MCP_TOOL_TIMEOUT`, `API_TIMEOUT_MS`, `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`,
  `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`, `USE_STAGING_OAUTH`, `USE_LOCAL_OAUTH`)
  were missing from the committed baseline and are now pinned. A hand-transcribed golden fixture
  cross-checks the generator so a resolver bug can't silently rewrite the contract.
- **`sync` surfaces stale-allowlist prune hints instead of discarding them.** When a
  `SPAWN_ENV_ALLOWLIST` entry is no longer constructed anywhere in the asar, `partitionSpawnFlags`
  routes it into `SyncResult.notes` (distinct from the hard-fail deltas above) and the CLI prints it
  under a non-blocking `notes (non-blocking):` line — a prune candidate to review, not a drift alarm.
- **TUI forward-compatibility set** (three items hardening the display seam for future frontends):
  - **The display-policy seam is now an explicit contract.** `src/run/display-translate.ts`'s header
    states it is the single policy seam for translating model-visible VM paths for human display
    (hostloop-only / identity-without-ctx / identity-when-shareable), locked by a 20-row table-driven
    contract test; `docs/debugging.md` explains why hostloop shows `/Users/…` while other tiers show
    `/sessions/…`.
  - **Per-run `mounts.json`.** Every run dir now records the VM-path context (`{v:1, sessionId,
    effectiveFidelity, outputsHostDir, uploadsHostDir, folders}`) — best-effort, never load-bearing,
    derived from the same call that feeds the live display translator. `loadVmPathContext` lets any
    historical-run consumer rebuild the context (null → degrade to identity). First consumer:
    `trace --translate-paths` (text output only) renders hostloop runs with host paths, threaded into
    row construction pre-slice. Cassettes structurally cannot carry the file.
  - **OSC 8 terminal hyperlinks.** On a real TTY (not CI, not `--compact`/`--demo`, opt-out
    `COWORK_HARNESS_NO_HYPERLINKS=1`), host-shaped `computer://` links in assistant text render as
    clickable `file://` hyperlinks (`normalizeEncodePath`, decode-then-re-encode; backtick code spans
    and VM-shaped links pass through; tool lines are excluded — they truncate at ~80 chars and a
    sliced URL would link to a wrong target). Piped/non-TTY output stays byte-identical.

- **`machine-inventory` cassette privacy scan class.** `verify-cassettes` now flags the sentinel
  phrases a capability-manifest recording leaks ("applications on this machine", "installed
  integrations/apps/extensions", …) — prose mentions of an app never trip it — with a scoped
  `--allow-machine-inventory <regex>` to whitelist provably-synthetic values. The capability-manifest
  filter line is recognized so the manifest itself doesn't false-trip the other classes. Tightening the
  privacy gate before the 1.0 contract freezes keeps it from becoming a breaking change to consumers'
  committed cassettes later.
- **The 1.0 compatibility contract (SPEC.md §12).** Enumerates the surfaces semver covers from `1.0.0` —
  CLI commands/flags + exit codes, the scenario/session/baseline/`RunResult`/cassette(v7)/protocol
  schemas, the documented `COWORK_HARNESS_*` (+ `COWORK_AGENT_BINARY`/`COWORK_AGENT_IMAGE`) env vars, and
  the packaged Action's inputs/outputs — and states what is explicitly NOT covered (human-readable
  terminal text, `trace` row shapes, the paraphrased prompt append). Cross-linked from README and
  RELEASING.md.
- **First committed `hostloop`-tier replay cassette + live two-tier `computer_links_resolve`
  coverage.** `examples/replays/hostloop-computer-links.cassette.json` (from a new purpose-built
  `fidelity: hostloop` scenario) is the first committed cassette at the newest/headline tier — the one
  the token-free replay lane never exercised — and asserts that a `computer://` link the model shares
  resolves to its real collected artifact. Verified live at both `container` (VM-shaped link) and
  `hostloop` (host-shaped link); wired into CI's replay + privacy-scan gates.
- **Host-platform / workspace-host-paths identity env vars.** The spawn env now emits
  `CLAUDE_CODE_HOST_PLATFORM` (`process.platform`, on every tier that assembles the Cowork spawn env —
  container/microvm/hostloop; protocol (L0) spawns with the plain base env) and `CLAUDE_CODE_WORKSPACE_HOST_PATHS`
  (connected-folder host paths, hostloop only when folders are present) — matching what the real Cowork
  spawn sets, binary-verified against the in-VM ELF and Desktop asar. The account-identity and `OTEL_*`
  vars stay unset (they need live Desktop account state the headless harness can't know; documented in
  `docs/fidelity-gaps.md`).
- **Reserved exit code `4` on the `run`/`skill` family** for a future "needs input / surfaced question"
  outcome — documented in SPEC.md so a later addition is additive rather than a renumbering of the
  burned `0`/`1`/`2`/`3` space.

### Removed

- **The `profile:` scenario-field alias.** The top-level `profile:` key (an earlier name for
  `baseline:`) is no longer accepted — it was silently remapped with a deprecation warning; it now
  errors as an unknown key. Use `baseline:`.
- **The deprecated `Profile` re-export (library API).** The `Profile` const/type in `src/types.ts` was
  renamed to `PlatformBaseline` with a "remove next minor" promise that never fired; removed now so the
  1.0 API contract doesn't freeze retired vocabulary in. Import `PlatformBaseline`.
- **The `scaffold --from-run <id>` flag.** `scaffold` had two spellings for one thing; the canonical
  positional `scaffold <run-id | run-dir>` stays, and `--from-run` now errors as an unknown flag
  (exit 2) with the usage string pointing at the positional form.
- **The `-V` short form for `--verbose`.** `-v` (version, per `node -v`/`npm -v`) and `-V` (verbose)
  were a shift-key-typo collision that silently flipped meaning. `--verbose` is now long-only on every
  command that accepts it (`run`/`skill`/`chat`/`decide`/`record`/`replay`/`verify-cassettes`); `-v`
  still prints the version and `-q` still means `--quiet`.
- **The dead `forceDisableHostLoop` loop-decision key.** It was never populated by `sync` and its
  branch could never fire — a config key that silently does nothing is a trap in a 1.0 schema. The
  field and its branch are removed (re-add with real semantics if `sync` ever derives it).

### Changed

- **CI's boundary job now pulls the published GHCR agent image the packaged Action pins**, retagging it
  for the sandbox probes so a bad publish surfaces in our own CI instead of only in a consumer's runner
  (it previously only ever `docker build`t the image locally). A pull failure now hard-fails
  (`::error::` + `exit 1`) on the canonical repo instead of silently rebuilding; forks and pre-publish
  runs (no GHCR read access yet) keep the local-build fallback with a warning. Live-verified on the
  0.23.0 release PR's CI run: `docker pull ghcr.io/yaniv-golan/cowork-agent-base:2` resolved and
  retagged successfully (image name, `linux/arm64` platform, and the default `GITHUB_TOKEN`'s GHCR
  read access are all confirmed working, not just implemented).

### Fixed

- **Redaction could destroy a `computer://` link and manufacture a VACUOUS `computer_links_resolve`
  pass on replay.** The repo's local-path redaction pattern didn't exclude `)` from its character
  class, so it ate a markdown link's closing paren — replay's extractor then saw an unterminated link,
  found zero links, and the presence-gated assertion passed while checking nothing (the first committed
  hostloop cassette shipped exactly this). Three-part fix: the redaction patterns now redact only the
  machine-specific path prefix (stopping before `/mnt/`, so replay's structural-marker resolution still
  works) and exclude link delimiters; `record`'s verdict-preservation guard gained a fourth check that
  compares `computer://` link counts pre/post redaction and refuses to write a cassette whose links
  redaction destroyed; and the hostloop cassette was re-recorded — its replay now extracts and resolves
  the link for real.
- **Scenario-schema violations now surface as category `usage`, not `internal`.** A typo'd or retired
  key (e.g. `profile:`) threw an uncaught Zod error that the top-level catch labeled `internal` — a
  user mistake masquerading as a harness bug. `parseScenarioFile` now wraps schema errors in a
  `UsageError` that names the offending file; exit stays 2.
- **The `protocol-smoke` example no longer fails by design on a live run.** `protocol` (L0) runs the
  agent's file tools on the real host cwd with no sealed filesystem — exactly like `hostloop` — so a
  host path in a tool result is expected there, not a leak. The `host_path_leak` default-fail is now
  exempted at `protocol` as well as `hostloop` (emitting a notice), so the flagship example passes its
  own assertions on every advertised lane. The signal stays a hard fail at the sandboxed
  `container`/`microvm` tiers (where a host path IS a regression), and an explicit
  `transcript_no_host_path` assertion still enforces cleanliness at any tier.
- **The LLM decider prompt no longer travels via `argv`.** `claude -p <prompt>` put the gate/skill
  text in the process's argument vector, world-readable via `ps` on shared hosts. The prompt is now
  delivered on stdin (the same channel the microvm auth-token uses); argv carries only
  `-p --model … --output-format json`. Off-brand for a tool that privacy-scans its own cassettes.
- **Malformed decider env knobs now fail loud instead of silently reverting.**
  `COWORK_HARNESS_LLM_TIMEOUT_MS` / `COWORK_HARNESS_LLM_MAX_BYTES` went through `Number(…) || default`,
  so a typo (`5m`) or an explicit `0` silently became the default. Both now route through
  `envPositiveNumber`, which warns loud on a set-but-unparseable/non-positive value (an unset var still
  uses the same default).
- **The bundled `cowork-harness` skill's CI recipe no longer breaks under bash/zsh.** The recommended
  `npm i -g cowork-harness@>=0.22.0` was unquoted — `>=` is a shell redirection, so the snippet failed
  as written in bash (GitHub Actions' default `run:` shell) and zsh alike. Now quoted at all sites. Same pass corrected the skill's command inventory (`status` was
  missing), a wrong `CLAUDE_PLUGIN_ROOT` scaffold path, missing `requires_capabilities` /
  `extended_thinking` / `account_name` schema docs, stale gotcha citations, a `scenario.py` regex-lint
  false-positive, and thin eval coverage.
- **`doctor --tier microvm` now detects an unprovisioned Lima instance.** It previously checked only
  for `limactl` itself, not whether `vm init` had actually provisioned the instance for the current
  config — a missing VM image could slip past `doctor` and only surface as first-run VM-boot latency
  on the next live `microvm` run (which self-provisions). New `vm-instance` check is advisory (`warn`,
  non-blocking, matching `microvm.ts`'s self-provisioning behavior), skipped when `limactl` itself is
  already the reported problem. Live-verified against a real, unprovisioned Lima install.
- **Top-level `--help` printed an invalid combined flag shorthand.** `--allow-domain/-email/-path
  <regex>` is not something the parser accepts — the three flags are independent and parsed
  separately (`verify-cassettes`'s own usage string already had this right). Fixed to list the three
  flags separately, matching the dedicated usage string.

### Documentation

- **Documented the Task-dispatch cap divergence in `docs/fidelity-gaps.md`.** Real Cowork skips agent
  Task dispatches beyond `{perTask:1, global:3}` (a binary-verified gate); the harness does not cap at
  runtime, mitigated by the `dispatch_count_max` assertion. The faithful runtime limiter is deferred
  post-1.0.
- **Doc-vs-code audit (post-0.22.0) — corrected several doc claims that had drifted from the
  implementation, found by a systematic docs-and-skill sweep.**
  - **Baseline pin staleness.** README, DESIGN.md, SPEC.md, the companion skill's `SKILL.md`, and
    `docs/cowork-spawn-contract-1.12603.1.md` all still pinned `desktop-1.17377.1`/`.2` after the
    platform baseline had moved on to `desktop-1.18286.0`. Reconciled the plain "current baseline"
    pins; deliberately left DESIGN.md's point-in-time verification stamps (§ Control protocol /
    Spawn contract) untouched, since bumping those would assert re-verification work that hasn't
    actually happened. README's "Status" paragraph had the same unresolved tension one section
    down (claiming `1.18286.0` is latest two sentences after a `1.17377.1` verification stamp) —
    added a clarifying parenthetical instead of silently picking one number.
  - **`docs/chat.md` self-contradiction.** Its `--folder` behavior rows named `protocol`/`container`/
    `microvm` in two places despite `chat` never accepting `microvm` (already correctly excluded
    elsewhere in the same file).
  - **`docs/cassette.md`'s assertion table** was missing six replay-evaluated keys (`skill_triggered`,
    `no_skill_triggered`, `max_cost_usd`, `max_tokens`, `tool_calls_max`, `max_turns`) despite already
    documenting all six correctly in `docs/scenario.md`.
  - **`docs/session.md`** never documented the real, live `account_name` session field.
  - **`docs/scenario.md`'s `run --matrix` example** pointed `skill_dirs` at a fabricated
    `../variants/v1/…` path that doesn't exist anywhere in the repo. Repointed the section at the new
    `examples/matrices/csv-metrics-matrix.yaml` fixture (baselines-only axis — this repo has no second
    `csv-metrics` variant to matrix against, so the shipped example omits `skill_dirs` rather than
    inventing fake paths).
  - **`docs/discovery.md`** left the `<proj-slug>` placeholder in its "find the VM session log" path
    unexplained. Documented what it is (Claude Code's own project-slug derivation, opaque to this
    repo) and gave a practical `ls`-based workaround instead of guessing at undocumented CLI internals.
  - **Doc-index and cross-link gaps.** `docs/README.md`'s guide table and `llms.txt`'s command list
    were both missing `stats`/`status`/`diff`; the `decide` reference row cited only `decide --help`
    despite a full worked "dry-running a decider" subsection already existing in `docs/scenario.md`;
    the README architecture diagram had no `hostloop` representation; `docs/maintenance.md`'s
    `sync --diff` example (real but the two oldest baseline files in the repo) wasn't flagged as
    illustrative; and README's `doctor` section read as if bare `doctor` were more general than
    `--tier container`, when bare `doctor` **is** `--tier container` by default.
  - **README command-table / flag-reference gaps.** `--compact`/`--demo` (output trimmed for
    shareable screenshots/GIFs) were undocumented in the `skill`/`run` command-table rows;
    `record`'s row omitted `--no-redact`/`--allow-failing`/`--dry-run`; the reproducibility-knobs
    section omitted `COWORK_HARNESS_VERIFY_AGENT_SHA`; the exit-code summary claimed a uniform
    `0`/`1`/`2`/`3` "on every command" when `diff`/`lint` have documented per-command exceptions
    (SPEC.md already had the accurate table — README's summary now points at it instead of
    overstating); and a note was added near the Prerequisites block that the worked
    `examples/scenarios/...` commands need a source checkout, not a global `npm install -g`.
  - Added **`examples/matrices/csv-metrics-matrix.yaml`**, a worked example for `run --matrix` (no
    prior fixture existed) — live-verified: both baseline cells pass.

### Internal

- **`scripts/check-versions.ts`'s version-lockstep guard now also cross-checks the `(baseline
  desktop-X)` pins** across README/`SKILL.md`/the spawn-contract doc against the newest committed
  `baselines/*.json`, closing the exact class of drift the doc audit above found so it can't silently
  recur. Deliberately excludes DESIGN.md's verification-stamp lines (see above).
  - `alwaysContentKeys`/`questionGateKeys`/`manifestKeys` in `src/run/cassette.ts` are now exported
    (previously function-local); `test/cassette-docs-sync.test.ts` asserts `docs/cassette.md`'s
    assertion table stays in sync with their union.
  - `test/cli-help.test.ts` gained a check that every CLI command appears in README's "Commands at a
    glance" table, on the same "doc can't silently drift from code" principle.
- **`test/vm-path-ctx-file.test.ts` gained a structural cassette-privacy regression test.** Asserts
  the committed `examples/replays/example-pdf-skill.cassette.json`'s top-level key set is closed and
  contains no `mount`-named field — guards the cassette assembler itself (not just `buildManifest`'s
  walk scope), so a future edit that adds a mounts-bearing field to the cassette literal is caught
  without needing a live re-record.

## [0.22.0] — 2026-07-03

### Added

- **`computer://` link modeling — the prompt now instructs file links exactly as production does.**
  Four pieces landed together, grounded in binary research against the Desktop app:
  - `src/vm-paths.ts` — a faithful port of Desktop's display-side VM→host path transform
    (`deepTranslateVMPaths` / `mapVMPathToHostPath` / `encodeComputerUrlsForHostLoop`): markdown-link,
    backtick, bare-token, and prose rewrite positions; per-segment percent-encoding; traversal
    rejection; dormant `.host-home` / `.auto-memory` mount branches.
  - **Hostloop display translation** (`src/run/display-translate.ts`): at hostloop fidelity the
    `run`/`chat` renderer shows production-identical host paths in assistant text and tool lines.
    Hostloop-only by design (container staging paths would be less faithful than VM paths), identity on
    replay (no live ctx), suppressed in `--compact`/`--demo` (the shareable no-host-paths contract).
    Hostloop prompt tokens now render HOST paths (`{{cwd}}` / `{{workspaceFolder}}` / `{{skillsDir}}` +
    the dedicated `{{cwd}}/mnt/uploads` pre-replacement), matching the Desktop builder's own host-loop
    substitution recipe.
  - **New assertion `computer_links_resolve: true`** — every `computer://` link in the transcript must
    resolve to an artifact that exists (live/verify-run: filesystem; replay: the cassette's artifact
    manifest, with host-shaped links normalized via the recorded session folders). Zero links pass;
    dangling links report which target was checked. Assert links with this key, not literal link text.
  - The `sharing_files` prompt section now instructs `[View your X](computer://{{workspaceFolder}}/x.ext)`
    links faithfully — the prompt-reconstruction divergence for links is retired (docs/fidelity-gaps.md
    updated).
- **Dark-feature gate sentinels.** Four newly discovered GrowthBook gates pinned in the baseline
  (host-fs skeleton `2614807392`, standard-session auto-memory `123929380`, memory-guidelines env
  `1696890383`, memory extra-guidelines `2860753854`) — all dark or inert-default for standard cowork
  sessions today; pinned so a production flip surfaces as a `sync --diff` delta. Absent-from-fcache
  dark gates record an explicit `source:"absent"` marker (the fcache re-key guard's semantics are
  preserved).

- **`stats` command + cross-run result index.** Every `run`/`skill` invocation (and `record`'s live
  execution) now appends one JSON line to `<runsRoot>/index.jsonl` at the same moment it writes
  `result.json` — a durable, queryable history independent of whether the run dir itself survives a later
  `prune`. `cowork-harness stats [<scenario>]` reads it back: run count, pass rate, cost/duration/token/turn
  p50/p95, and the last-green timestamp, filterable by `--since`/`--baseline`/`--branch` and windowable by
  `--last <n>` (per-scenario, not globally). `--reindex` rebuilds the index from the physical run-dir tree
  — the migration path for runs that predate the index. `trace`/`inspect`/`scaffold`/`status`'s existing
  run-id/fragment resolution now checks the index FIRST (faster, and the source of truth going forward),
  falling through to the pre-index filesystem walk automatically and unchanged for any run that predates
  the index or was never indexed — same commands, same output, same ambiguity-handling behavior either
  way. See [docs/stats.md](./docs/stats.md).
- **`run --matrix` matrix runner.** Runs one scenario across the cross-product of baseline/model/skill_dir
  axes declared in a `matrix.yaml` file (any axis optional; an absent axis contributes one unmodified
  cell) and reports one row per cell instead of a single pass/fail. `--max-cells` caps the cross-product
  (default 16, warns and truncates rather than silently dropping cells); `--concurrency` (default 1, max 8)
  runs cells N at a time via the same bounded pool `record --concurrency` uses. Exit is non-zero if ANY
  cell fails — a real assertion failure or a cell-level infrastructure error (e.g. the pinned baseline's
  agent binary isn't staged), rendered as a distinct `cell error: …` line rather than a fake assertion
  failure. The `skill_dirs` axis substitutes the session's single `plugins.local_plugins` entry; candidates
  must share that entry's directory basename (the mount name derives from it, with no author-chosen
  override anywhere in the harness) — a mismatch is a loud, explicit usage error. `--concurrency > 1`
  cannot combine with `--decider-dir`/`--decider-cmd` (the external decider channel is one shared object
  across every cell, and every channel implementation is strictly serial over shared mutable state — not
  safe for concurrent gate answers; `--concurrency 1`, the default, is genuinely serial and fine). The
  JSON envelope gains an additive `matrix: {cells[]}` field; `ok`/the exit code are `!matrix.anyFail` for
  this mode.
- **`--matrix` composes with `--repeat`.** Each cell now runs as its own repeat batch (N iterations of that
  cell's axes-overridden scenario) through the same `runRepeatBatch` helper standalone `--repeat` uses —
  same unanswered-gate, error, and budget-cap handling — with `MatrixCellRepeatResult`/`MatrixRepeatRollup`
  carrying each cell's full `RepeatRollup` (pass rate, per-assertion attribution, signal histogram,
  stoppedEarly) rather than a single pass/fail. The matrix verdict judges each cell's rollup against
  `--min-pass-rate`; the JSON envelope gains an additive `matrixRepeat: {cells[]}` field, checked before
  `matrix`/`rollups` when present. Also closes the previously-ungated `--repeat` + `--decider-cmd`
  combination (rejected for the same live-decider reasoning as `--decider-dir`).
- **Packaged GitHub Action** (`uses: yaniv-golan/cowork-harness@v1`, [`action.yml`](./action.yml)) wrapping
  `replay`/`lint`/`verify-cassettes`/`run` with a PR job-summary reporter (verdict table, staleness
  findings, the skipped-live-only-assertions honesty line, cost/turns when available). Token-free lane runs
  on any `ubuntu-latest` runner; `run` (live lane) needs a self-hosted runner with Docker + the agent binary
  already provisioned — the action does not stage either, by design (staging Anthropic's binary is a call
  about your own distribution-terms relationship, so it stays a step in your own workflow, not something a
  third-party action automates for you). README and the companion skill's `ci-recipe.md` both carry a
  worked self-hosted-runner example for the live lane. Self-tested in CI (`uses: ./` against a packed
  tarball of the current commit, a passing case, a usage-error case, and a genuine assertion-failure case).
  A `publish-image.yml` workflow pushes `ghcr.io/yaniv-golan/cowork-agent-base:2`/`cowork-agent-full:2` on
  release tags for consumers (and this repo's own CI) to `docker pull` instead of building from scratch.
- **`skill_triggered` / `no_skill_triggered` assertions.** Skill invocation (the top-level `Skill` tool_use)
  is now a first-class assertable event, recorded as `RunResult.skillsInvoked[]` and evaluated as a regex
  match, matching the `subagent_dispatched` convention. Fails as evidence-unavailable (never a vacuous pass)
  when the agent's init tool list has no `Skill` tool (agent-version drift) or, for the negative form, when
  invocation data itself is absent (an old run predating this key). Replay-checkable (content key).
- **`max_cost_usd` / `max_tokens` / `tool_calls_max` / `max_turns` budget assertions**, built on Wave 0's
  cost/turns seam. Each fails as evidence-unavailable (never a vacuous pass) when the underlying telemetry
  is absent. `max_cost_usd`/`max_tokens` are honest about the replay lane: they assert the *frozen
  recording's* spend, not fresh spend — a live `run` is where a real budget regression is caught.
  `tool_calls_max`/`max_turns` are meaningfully replay-checkable (the re-drive recomputes `toolCounts`/turn
  count deterministically).
- **`diff <a> <b>` command.** Compares two committed platform baselines (`--changelog` renders known-field
  prose — agent/Desktop version bumps, egress allowlist changes, gate flips — from a proper recursive
  structural differ, replacing the old one-level diff that dumped a whole subtree on any nested change;
  `sync --diff` now uses the same differ), two runs, two cassettes, or a run and a cassette (kind
  auto-detected by CONTENT, not filename — a cassette-shaped file not literally named `*.cassette.json`
  still detects correctly). Run/cassette mode has four views (`tools`/`transcript`/`artifacts`/`meta`, or
  `all`) with normalization masking per-run noise (tool-use ids, UUIDs, session-dir markers, timestamps,
  host paths) so two runs of the *same* scenario diff as identical despite that noise; `--no-normalize`
  compares raw values for forensics. Comparing runs of two *different* scenarios is allowed (useful for
  skill-variant comparison) but warns on stderr — added/removed rows may then reflect scenario
  differences, not drift. Token-free — no live Desktop install or Docker needed either way.
- **`run --repeat N` variance rollup.** Runs each resolved scenario N times (2-100) and aggregates a
  rollup (pass rate, per-assertion pass/fail attribution, a verdict-signal histogram, cost/token totals,
  non-deterministic-run count) instead of a single pass/fail. `--min-pass-rate` sets the batch threshold
  (default 1.0 — no flakiness tolerance); `--stop-on-diverge` stops the loop as soon as both a pass and a
  fail are observed (that batch always fails — divergence IS the failure being measured for);
  `--max-budget-usd` stops the loop once cumulative cost would exceed it (an incomplete-but-clean stop is a
  warning, not a failure by itself). `--repeat` rejects `--decider-dir`/`--decider-cmd` (an interactive
  driving agent × N runs is not a measurement). The JSON envelope gains an optional `rollups[]` array;
  `ok`/the exit code are
  redefined for this mode from the rollups, not from `results.every(pass)` — `results[]` still holds every
  raw run.
- **E9: a hand-authored draft-07 JSON Schema for the harness's own control-channel wire protocol**
  (`schema/protocol.v1.json`) — the `initialize` handshake, `can_use_tool` permission/question gates
  (incl. AskUserQuestion's `questions[]`), `hook_callback`/`mcp_message` round-trips, and the nested
  `control_response` envelope + the `answers` wire-shape — formalizing the prose in DESIGN.md §6/SPEC.md
  §4-5. Deliberately does NOT schema the Claude Agent SDK's own event stream (Anthropic's surface).
  Ships with a golden vector pack (`fixtures/protocol/v1/*.json` — real cassette-extracted where
  possible, synthetic-via-the-real-`session.ts`-envelope-builders otherwise) and conformance tests
  (`test/protocol-schema.test.ts`) that validate every committed cassette's control-channel lines plus
  the real envelope-builder functions' actual output, and guard the schema/vector-pack lockstep. See
  [docs/protocol.md](./docs/protocol.md) for the versioning policy and the explicit
  descriptive-not-normative scope statement.

### Parity

- **Synced the platform baseline to Claude Desktop 1.18286.0** (`baselines/desktop-1.18286.0.json`).
  The staged agent ELF is unchanged (`2.1.197`; measured sha256 matches the official release manifest).
  `sync` re-derived egress/gates/mount/web_fetch facts — no unknown deltas; the egress allowlist (15
  domains) and all 6 pinned GrowthBook gates held. `asarFingerprint` moved (`0b2f2fb6 → edff6926`);
  the host-loop `## Shell access` generator and the subagent append were re-verified against the new
  asar (unconditional fragments still byte-faithful).
- **Re-authored the system-prompt append reconstruction for 1.18286.0**
  (`baselines/prompts/desktop-1.18286.0/system-prompt-append.md`). The real append was RESTRUCTURED
  at this release (constant `aui`, 37.9KB): a new `<claude_behavior>` wrapper plus new
  behavior-driving sections — AskUserQuestion-before-work, task-list/verification, citation,
  file-creation/computer-use guidance, web-fetch no-fallback restrictions, sharing/package/examples,
  an `<env>` block — and the skills/file-handling sections moved inside `<computer_use>`. The
  reconstruction (paraphrased per the no-bundling rule) now carries these; generic refusal/safety
  policy stays elided, and the deliberate divergences (artifacts renderer catalog trimmed,
  `computer://` links described-not-instructed) are logged in the asset header. New `<env>` tokens
  `{{currentDateTime}}` / `{{currentTimezone}}` / `{{accountName}}` (session `account_name`,
  default `"User"`) render in `src/prompt.ts`. New tests guard baseline→asset references, token
  hygiene, and the `/sessions/` link-leak trade.
- **Annotated `desktop-1.17377.2` as append-unverified** (`$comment_prompts_unverified`): its own
  asar was never prompt-spot-checked and is no longer obtainable locally, so whether the 1.18286.0
  restructure landed there or later is unverifiable; the pin carries the last-verified 1.15200.0
  reconstruction.

### Added

- **Agent-binary provenance in baselines.** Each baseline's `agentBinary` now records the Linux/arm64 ELF's
  `sha256` plus `shaProvenance` — `measured-local` (hashed from the staged binary at `sync` and cross-checked
  against the official release manifest) or `official-manifest` (copied from the manifest for a version not
  staged on the syncing machine; staging-identity unverified) — and, on measured rows, `manifestChecksumMatch`.
  `sync` computes these and stays offline-capable (an unreachable manifest records `"unknown"` and never fails
  the sync). All committed baselines back-filled. (No `nativeSha256`: the signed native Mach-O never equals a
  manifest hash.)
- **Default-on agent-ELF integrity check.** The resolved ELF is verified against the recorded `sha256` at run
  time **by default** (opt out with `COWORK_HARNESS_VERIFY_AGENT_SHA=0`; ELF only). Hard-fails only on a
  `measured-local` mismatch at the baseline's own staged path; intentional substitutions (`COWORK_AGENT_BINARY`
  / newest-sibling fallback) and `official-manifest` hashes advisory-warn. `doctor` now shows a
  `[sha256 ✓ vs baseline, …]` provenance line. Old agent versions are re-downloadable and verifiable — recovery
  runbook in `docs/maintenance.md`.

### Changed

- **`RunResult.cost`/`.usage` retyped** from opaque `Record<string, unknown>` to structured shapes.
  `cost` is now `{ usd?, raw? }`: `usd` is the SDK result message's `total_cost_usd`, newly extracted (was
  previously dropped on the floor); `raw` is the pre-existing `api_metrics` payload, now nested under `raw`
  instead of being the whole `cost` object. `usage` gains a `turns?: number` field, from the SDK's
  `num_turns` (also newly extracted). Breaking shape change for anything reading `result.json`'s `cost`
  field directly — see SPEC.md's `RunResult` reference for the new shape. No cassette-format bump (derived
  reporting, not a stored format change).

### Fixed

- **Replay now surfaces `usage`/`cost` in `result.json`.** `replayCassette` previously omitted both fields
  entirely from every replayed `RunResult`, regardless of what the cassette recorded — a replay-lane blind
  spot, not a live-only limitation. Both are now re-derived from the cassette's re-driven record, same as
  the live/partial-run lanes.

## [0.21.0] — 2026-07-03

### Added

- **`verify-cassettes`'s privacy scanner gained a `path` class** for local absolute filesystem paths
  (`/Users/`, `/home/`, `/root/`) — closing a real gap where a committed cassette's capability-manifest
  (`system/init`, the `initialize` registry) could leak the recording machine's username, plugin-cache
  paths, and installed-plugin/marketplace names with nothing to catch it (the existing `email`/`currency`/
  `domain` classes don't match a path shape at all, and `currency`/`domain` are additionally excluded on
  manifest lines by design). `path` runs on manifest lines too — unlike the noisy classes it isn't
  excluded there, since a real local path is never legitimate catalog boilerplate. New `--allow-path
  <regex>` flag, scoped like `--allow-domain`/`--allow-email`.
- **A default `.cowork-redact.json` recording-redaction policy at the repo root** (two pattern rules:
  local absolute paths — `/Users`, `/home`, `/root`, matching the scanner's `path` class roots so
  redaction and detection stay aligned — and email addresses). `record` has always applied content
  redaction uniformly to every event, including capability-manifest lines, but with no policy file
  anywhere in the repo it ran as a structural no-op; cassettes recorded here now get those classes
  redacted at the source, complementing the scanner's after-the-fact check. (Repo-local — the policy
  file is not part of the npm package.)
- **A committed synthetic multiSelect cassette** (`examples/replays/example-multiselect-gate.cassette.json`)
  covering the multiSelect AskUserQuestion gate / `controlOut` answer path on the replay lane, wired into
  CI. Its capability-manifest is a small synthetic catalog, not a live-recorded environment.

### Fixed

- **`hostloop` fidelity now spawns the agent loop as a native host process, matching production, closing a VM-absolute-path false-green.** Previously, `hostloop` ran the entire agent — including its native file tools — inside one Docker container, with connected folders copied in rather than bind-mounted. A skill that hardcoded a VM-absolute path (`/sessions/<id>/mnt/...`) in a `Read`/`Edit`/`Write` call would silently succeed under that design while genuinely failing in real Cowork, where the agent loop is a native macOS process and no such path exists on the host filesystem. `hostloop` now spawns the agent directly on the host (discovered via a second staged Desktop binary, `claude-code/<ver>/claude.app/Contents/MacOS/claude`); only `bash`/`web_fetch` still route into a Docker VM sidecar (which no longer runs an agent at all). Connected folders are bind-mounted — never copied — into both views, with a run-end snapshot preserving the existing artifact-collection pipeline unchanged.

  With no container around the native file tools, a new byte-faithful port of production's own PreToolUse path-containment hook (`src/hostloop/pretooluse-path-hook.ts`) is the security boundary, backed by a runtime tripwire that hard-fails a run if a gated tool call ever completes with no evidence the hook fired. Because this gives the agent genuine, software-checked-only host filesystem access when a connected folder is writable, that combination now requires explicit consent: a new **`allow_host_writes: true`** scenario field (and `--allow-host-writes` for `chat`) — the harness refuses to spawn otherwise. `docs/boundary.md` documents the full safety posture; see also `docs/scenario.md` and `docs/session.md`.

  `computeVerdict`'s `host_path_leak` default-fail is now skipped at `hostloop` fidelity (real host paths there are expected, not a leak); `transcript_no_host_path` is consequently incompatible with `hostloop` and the harness warns loud if a scenario asserts it there anyway. Live-verified end-to-end against the real staged native binary and Docker: the gate blocks a VM-path `Read` with the expected denial (and the model self-heals via `bash`), and allows/executes a real `Read`/`Write` against the actual host path, with the PreToolUse hook firing for both calls.

- **`--compact`/`--demo` no longer leak a host path via the `[status]` line.** 0.20.0's run-start
  `[status] <outDir>` line prints a raw, un-tildeified absolute path by machine-capture contract — but it
  was emitted unconditionally, so under `--demo` (the "shareable, no host paths" preset) it exposed
  `/Users/<name>/.cowork-harness/…`, the exact leak `--demo` exists to prevent. The line is now suppressed
  under `--compact`/`--demo` (a human sharing a clip isn't scripting `status`; a machine/CI caller that
  needs the path doesn't pass `--compact`, or reads `status.json` / `--session-id`). `status.json` is still
  written either way, so `cowork-harness status` is unaffected.
- **`--compact` now collapses the session-root in tool-result outcome lines too.** 0.20.0's new
  `tool_result` `→`/`✗` outcome lines (under each top-level tool call) bypassed the `--compact`
  `/sessions/<id>/mnt/ → mnt/` collapse that already applied to `-V` tool *inputs*, so shareable output
  showed long in-container paths on the outcome lines only. The collapse is now a shared `collapseSessionRoot`
  helper applied to both. Display-only; `run.jsonl` keeps the true paths.
- **All CLI usage/runtime errors now honor `--output-format json`.** Dozens of error sites in
  `cli.ts`/`doctor.ts` bypassed the shared JSON envelope and emitted plain stderr text even when JSON
  output was requested. Every remaining `log()`+`process.exit()` site now routes through the shared
  `fail()` helper (relocated to `src/run/envelope.ts`), preserving every existing exit code exactly.
  The two sites that legitimately keep a custom wire shape (`decide`'s ABSTAIN/catch and `main()`'s
  top-level catch) are explicitly marked, and a new CI guard bans any other bare `process.exit(1|2)`
  in those two files so the fix can't silently regress.
- **`doctor --tier hostloop` now validates the native macOS agent binary the tier actually spawns.**
  It only checked the Linux/arm64 agent ELF (`resolveAgentBinary`), never the separate native host
  binary (`resolveHostAgentBinary`) that `hostloop`'s agent loop runs directly on the host — so
  `doctor` could report ready while the one binary that tier needs was missing. New `hostAgent`
  check for the `hostloop`/`cowork` tiers, gated the same way as the existing agent check.
- **The npm package now ships `AGENTS.md`, `SPEC.md`, `DESIGN.md`, `llms.txt`, `SECURITY.md`, and
  `CONTRIBUTING.md`** — previously absent from the tarball's `files` allowlist, so links to them from
  the packaged `README.md`/`llms.txt` dangled in an installed copy.

### Parity

- **Synced the platform baseline to Claude Desktop 1.17377.2** (`baselines/desktop-1.17377.2.json`).
  The staged agent ELF is unchanged (`2.1.197`). `sync` re-derived egress/gates/mount/web_fetch facts —
  no unknown deltas; only `asarFingerprint` moved (`290341ff → 0b2f2fb6`), and none of the 6 pinned
  GrowthBook gates drifted. Re-verified: the live container-tier scenarios pass against the new
  baseline.
- **Added the missing `.claude/skills` row to the `1.17377.2` `mountLayout`.** VM-rootfs forensics
  (the `sessions-<name>-mnt-.claude-skills.mount` systemd unit in `rootfs.img`, reproduced across two
  independent investigations) show the real VM mounts skills as a dedicated read-only row; the original
  mount-fidelity plan had folded skills into the plugin mounts and never added one.

### Docs

- **`docs/invariants.md`** — a consolidated index of the harness's cross-cutting invariants, one row
  per invariant with its enforcement point and test anchor.
- **Scenario-schema description pass.** Every top-level scenario field in `schema/scenario.schema.json`
  now carries a description (for schema-driven editor tooling/autocomplete), including why the
  replay-only `replay_protocol_fidelity` is listed despite being rejected at load time; the `answers`
  and `baseline` descriptions were corrected (the tool-permission `when_tool` matcher was omitted;
  `baseline`'s `profile:` alias is deprecated, not retired).
- Doc-audit sweep (2026-07-03): stale `>=0.19.0` version floors bumped, wrong `BoundaryError` exit
  code (2 → 3), stale CI job name, `--decider-model` / `--allow-path` help-text coverage, the
  marketplace-install-bundles-same-files claim, and stale "not yet landed" notes.

### Internal

- CI's `parity-drift` job now fails if the newest committed baseline exceeds a 90-day staleness
  ceiling, so the parity promise can't silently rot.
- The multiselect decider smoke scenarios run in the live CI scenario suite.
- `npm pack`'s `files` array explicitly negates local gitignored cruft (`docs/superpowers`,
  `__pycache__`, `egg-info`) so the pre-tag `npm pack --dry-run` check is trustworthy regardless of
  working-directory state (published tarballs were never affected).

## [0.20.0] — 2026-07-01

### Added

- **`status.json` + `cowork-harness status <dir> [--follow]`.** Every run now writes a lightweight
  `status.json` into its output directory from the moment `outDir` is created through completion
  (`running` → `done`/`error`), with live tool/sub-agent counts. Two layers keep it from ever getting
  stuck reporting a dead run as `"running"`: an exit-handler crash-safety net for an uncaught
  throw/`SIGTERM`, and `updatedAt`-based staleness detection (both in `status` and `status --follow`) for
  a hard `SIGKILL`/OOM-kill, which no exit handler can catch. `cowork-harness status <run-id | run-dir>`
  reads it (one-shot, or `--follow` streaming one JSON line per change, bounded by a fail-loud
  timeout/staleness check rather than a silent hang) so a script or driving agent can check whether a
  background run is still alive WITHOUT `ps aux` — which only sees processes in the checker's own PID
  namespace and is unreliable from inside a sandbox/container. The harness prints `[status] <outDir>` to
  stderr as soon as it's known, so a caller doesn't need `--session-id` to discover the directory. See
  `docs/run-status.md`.
- **Gate provenance in run output.** `result.json` now carries a `gateProvenance` block (`total`,
  `bySource` histogram, per-gate `{question, answeredBy, answer, model?}`) recording how each
  AskUserQuestion gate was answered (scripted / decided(llm|external) / first-option / prompt). The
  verdict footer prints a counts-only one-liner (e.g. `gates: 3 · 2 decided(llm), 1 scripted`) and
  `trace --view questions` annotates each gate with its `by`/`model`. Informational — it never changes
  the verdict; it makes the residual non-determinism legible so a reviewer sees which assertions sit
  downstream of a decided (non-reproducible) gate. `bySource` keys are the raw decision sources, so e.g.
  a replay-lane decision reads `replay`; the block itself is a live/partial-lane surface and is absent on
  the replay lane (which reports reproducibility via `nonDeterministic: false`).
- **`--compact` and `--demo` for shareable output** (`skill`/`run` — `chat` has its own flag parser and
  isn't wired to either yet). `--compact` drops the
  informational `[capability]` `::notice::` lines (the pre-flight, the "image omits…", and the "not used"
  notes) — but the capability probe still runs and a real false-negative still **hard-fails**, unlike
  `COWORK_SKIP_CAPABILITY_PROBE=1` which disables the safety net. `--demo` is the shareable preset:
  `--compact` plus suppression of the `runs →` location header. Runs stay in the durable default location
  (no temp redirect), so `scaffold`/`trace`/`inspect <run-id>` still resolve the run afterward; combined
  with the `$HOME`→`~` collapse, demo output carries no host paths. Under `--compact`, `-V` tool inputs
  also collapse the ephemeral cowork session root (`/sessions/<id>/mnt/` → `mnt/`) — display-only, so the
  long in-container paths don't clutter shareable verbose output (`run.jsonl` keeps the true paths; the
  L0/`protocol` tier uses host `work/` paths and is unaffected).
- **`replay --assert-from <scenario.yaml>` / `--reassert` — token-free re-check against on-disk assertions.**
  By default `replay` still evaluates the assertions **frozen in the cassette** (byte-deterministic, ignores the
  working tree); a plain `replay` now prints a `::notice::` when a sibling scenario's `assert:` differs, instead
  of silently using the frozen copy. The new flags opt into re-evaluating against the **on-disk** `assert:`
  (+`expect_denied:`) — the "edit the assert, re-check without a paid re-record" loop. `--assert-from <file>`
  takes an explicit sibling scenario; `--reassert` auto-discovers it (persisted `scenarioSource`, else a
  name lookup) — no argument needed. The opt-in path is safe by
  construction: it **hard-fails** on recording-shaping drift (`prompt`/`baseline`/`fidelity`/`answers`/`skills`/
  `requires_capabilities`) and on skill-content staleness (it implies `--fail-on-skill-drift`, when a skill
  fingerprint was recorded), warns on on-disk assert keys that can't be evaluated on replay (filesystem/gate/egress)
  and on an edited `expect_denied`, and notes that the `session` (model/mounts/discovery) is **not** verified.
- **Per-result `verdict` in the `--output-format json` envelope.** Each entry in `results[]` now carries
  `verdict: { pass, exitCode, signals[], guards[] }` (a non-mutating projection of `computeVerdict`), so a consumer
  can read each result's pass/fail **and why** (e.g. an all-green-assertions run that is `pass:false` purely on a
  `stalled` signal) without recomputing. The top-level `ok` is derived from the same per-result verdicts.
- **`chat` / `skill` / `run --verbose` live-output legibility pass.** Six small, no-new-dependency
  improvements to the stderr renderer (`src/run/renderer.ts`) and `PromptDecider`'s TTY gate prompts
  (`src/decide/decider.ts`) — informational-only, nothing here touches verdicts, `result.json`, or replay.
  Tool call markers are now category-specific glyphs instead of a uniform `·`: `@` read (Read/Glob/Grep/…),
  `#` mutate (Write/Edit/…), `!` shell (Bash/…), `?` network (WebFetch/…). Truncated `-V` tool-input
  summaries now show how much was cut (`… [+N chars]` instead of a bare `…`). Each turn now ends with a
  `── +N.Ns ──` separator carrying that turn's elapsed time (derived from the SDK's per-turn `result`
  event, which the renderer previously dropped entirely). `tool_result` events — likewise previously
  dropped — now render a one-line `→ …` / `✗ …` outcome under each top-level tool call. Nested sub-agent
  dispatch lines (`--verbose`) now indent proportionally to dispatch depth instead of always rendering
  flat. And permission / `AskUserQuestion` TTY prompts now render inside a `┌─/│/└─` box so they visually
  stand out from the progress markers sharing the same stderr stream.

### Changed

- **`run` now accepts `--keep` as an explicit no-op** instead of erroring. `--keep` is meaningful on
  `skill` (which otherwise discards runs); `run` always keeps runs, so passing `--keep` (muscle memory
  from `skill`) prints a one-line note that it had no effect rather than the loud "unexpected argument"
  reject. Exact-token only — a genuinely unexpected flag still rejects loudly.
- **The default `--decider-llm` answering model now floats to the latest Sonnet** (the CLI alias `sonnet`)
  instead of the id pinned in 0.19.0 (`claude-sonnet-4-5`), so the default keeps tracking Anthropic's
  current Sonnet without a repo edit. `gateProvenance`/`result.json`'s `decisions[].model` is unaffected —
  it now records the CONCRETE model the alias resolved to for that run (via `claude -p --output-format
  json`'s `modelUsage`), never the literal string `"sonnet"`, so per-gate auditability is exactly as precise
  as it was under the old pinned default; an envelope that doesn't resolve to exactly one concrete model
  fails loud rather than recording an empty/ambiguous value. `--decider-model <id>` /
  `COWORK_HARNESS_DECIDER_MODEL` still pin an exact id — the way to get byte-for-byte reproducible decider
  behavior across runs (as much as a stochastic model allows), since the floating default can answer
  differently over time as Anthropic ships new Sonnet releases.

### Fixed

- **A blocking `--on-unanswered prompt` wait now announces itself immediately.** When `skill` blocks at
  the TTY for an unscripted question (the adaptive default when a human is attached), it prints a one-time
  `::notice:: [input] waiting for an answer…` the instant it blocks — instead of only the ~30 s heartbeat —
  so a recording/wrapper/automation context isn't left silently hung. The notice is per-run (a fresh
  decider per scenario, so a `run dir/` batch announces each blocking scenario), and only for the real TTY
  asker (the `chat` REPL's own prompt is left alone). For non-interactive use, `--on-unanswered fail`
  remains the way to never block.
- **Human output no longer prints absolute `$HOME` paths.** The `runs →` location line, the `--keep`
  run-dir/outputs lines, the `scaffold` tip, the failure `→ full run:` line, and the failure branch's
  own `→ outputs:` line now collapse a leading `$HOME` to `~`, so a screenshot / pasted log / bug report
  doesn't leak your username and filesystem layout. Display-only (`~` re-expands in a shell); set
  `COWORK_HARNESS_RUNS_DIR` for full neutralization.
- **A plugin/skill mounted from an untracked git working copy no longer fails silently.** Staging delivers
  the git-**tracked** set (the fidelity boundary — real Cowork installs from a repo and sees only committed
  files), but an all-untracked source used to mount **EMPTY** with no signal: the agent reported "the skill
  isn't installed" and did the work itself — a green-looking run where the skill never loaded. Now the filter
  is **visible in both directions**: a would-be-empty plugin/skill mount **hard-fails** with a `BoundaryError`
  (clean exit 3) naming the dir and the fix (`git add`, or `COWORK_HARNESS_GITSET=0`), and a partially-tracked
  source emits a loud `::notice:: [stage]` listing the excluded untracked files. The staged-set count and the
  delivered set now come from one `git ls-files` snapshot (no TOCTOU). The guard is correctly skipped on
  `--resume` (which re-stages nothing) — which also fixes a latent resume false-fail where a since-removed
  skill source would throw. The sibling symlink-escape staging errors are now `BoundaryError`s too (clean
  exit 3 instead of a stack trace).
- **`trace --view questions` no longer misattributes `by`/`model` after a denied gate.** It paired each
  gate row with `summarizeGateProvenance(...).gates[i]` by array index — but that array **drops**
  denied/mismatched gates (`mismatch→deny`), while the trace rows include every gate asked. One denied
  gate in the middle of a run shifted every later row's `by`/`model` onto the wrong question, and the true
  owner of that data got none. Now pairs against every question-kind decision (answered **or** denied,
  interleaved tool-permission decisions excluded), which keeps the common case aligned; a denied gate is
  correctly left unannotated instead of stealing the next answered gate's provenance. Informational display
  only — never affected pass/fail.
- **CLI `--help` drift.** The top-level `chat` summary now lists `protocol` (the command already accepted
  it); `--version` documents its `-v` alias; and the `gates` / `answer` / `scaffold` usage strings now show
  the `--output-format` flag they already parse.
- **`sync --diff` no longer goes silent on a genuine Desktop version bump.** It previously diffed `next`
  against `baselines/desktop-<NEW version>.json` — which doesn't exist yet on a real bump — so it always
  printed `(no committed baseline yet)` instead of the `appVersion`/`agentVersion`/etc. field diff
  `docs/maintenance.md` documents. It now diffs against `base` (the latest committed baseline `next` was
  actually merged onto), which is the previous version on a bump and the exact same content on a
  same-version re-sync. The diff header now names which baseline it's comparing against. `docs/
  maintenance.md`'s example output and noise callout (`$comment` also moves alongside `capturedAt` on every
  run) updated to match.

### Documentation

- **Doc-vs-code audit — corrected several doc claims that diverged from the implementation.**
  - **Host-loop tier wording.** README, `docs/boundary.md`, `docs/chat.md`, and the skill `SKILL.md` said
    the `hostloop`/`cowork` "agent loop runs host-side." It does not: the agent process runs **in the
    container** like `container`, but native Bash/WebFetch are disabled and routed host-side via the
    workspace SDK-MCP server (bash via `docker exec`, `web_fetch` via host `curl`). Only `protocol` runs
    the agent on the host. Reworded to describe the **tool-routing** split, not an agent-loop split, in
    README, `docs/boundary.md`, `docs/chat.md`, and `SKILL.md` — plus, in a 2026-07-01 follow-up, the three
    files this pass missed: `docs/scenario.md`, `docs/fidelity-gaps.md`, and the skill's
    `fidelity-and-answers.md` (and the misleading code comment in `src/runtime/hostloop.ts`).
  - **Artifact replay.** The skill references (`scenario-schema.md`, `ci-recipe.md`) claimed a replay PR
    gate "cannot verify an artifact's content." It can — `file_exists` / `user_visible_artifact` /
    `artifact_json` evaluate on replay **when the cassette carries an `artifacts` manifest** (already
    correct in `docs/cassette.md`). Fixed the two contradicting copies.
  - **`boundary-check` scope.** Clarified it probes the **L1 Docker** path only (covers `container` and
    `hostloop`, which share that sandbox); the `microvm` guest-iptables firewall is not exercised by it.
  - **`microvm` isolation.** `docs/scenario.md` said microvm "shares the container sandbox"; it actually
    enforces the same allowlist inside a real Lima/Apple-VZ VM via a guest firewall.
  - **Egress mechanism.** `docs/boundary.md` cited `docker/compose.yml` as the live enforcer; the runtime
    creates **per-run** Docker networks in `src/egress/sidecar.ts` and never invokes compose (now marked
    reference-only).
  - **Onboarding / DX.** Added a "Which path am I on?" box (replay / protocol / live tiers / invocation)
    and a three-names note to the README quick start; surfaced `doctor` / `python3` / `vm init` in the
    docs reading order; aligned `docs/discovery.md` with the worked examples; documented the previously
    undocumented `COWORK_*` / `PYTHON` env vars; noted the latest baseline is `desktop-1.15962.1`
    (runtime-identical to `…0`).
  - **Command/assertion reference.** Documented `doctor --tier cowork`, the `prune [<runs-dir>]`
    positional, the `sync --force` alias, the `artifact_json` bare-existence mode, the
    `tool_result_not_contains` fail-loud on truncated evidence, and that `expect_denied` is scenario-level
    shorthand (not an assertion key).

### Parity

- **Synced the platform baseline to Claude Desktop 1.17377.1** (`baselines/desktop-1.17377.1.json`). The
  staged agent ELF moved **2.1.187 → 2.1.197**. `sync` re-derived egress/gates/mount/web_fetch facts — **no
  unknown deltas**; only `asarFingerprint` moved (the mount-mode and web_fetch drift-guard regexes both
  still matched) and `api.claude.ai` joined `network.allowDomains`. None of the 6 pinned GrowthBook gates
  drifted (loop / dispatch-cap / web_fetch-routing / transport / plugin-sync / CLI-plugin-broker all held
  their prior on/off state). Re-verified end-to-end — the live scenario suite (`protocol` + `container`
  tiers) passes against the new baseline.
- **Spot-checked the reconstructed system-prompt / host-loop content against the new asar** (this is
  hand-authored, not something `sync` extracts): the `<application_details>` identity block — including the
  load-bearing "is NOT Claude Code" correction — the host-loop `## Shell access` marker, subagent-append
  gating, the `computer://` scheme, `request_cowork_directory`, and `coworkNativeFilePreview` are all
  present and substantively unchanged since the `1.15200.0` reconstruction (only non-substantive
  punctuation-level rewording). No re-authoring of `baselines/prompts/desktop-1.15200.0/` was needed.
- **Doc-pin sweep to `desktop-1.17377.1` / agent `2.1.197`** across README, DESIGN, SPEC, the spawn-contract
  doc, and the skill's reference docs.

## [0.19.0] — 2026-06-30

### Changed

- **The default `--decider-llm` answering model is now Sonnet (`claude-sonnet-4-5`), not Haiku.** A
  measurement on a real-doc skill with judgment-heavy gates found the prior Haiku default
  **prose-declined ~50% of them** (replying "I don't have information…" instead of picking an option →
  a fail-loud whiff); a Sonnet decider binds those gates and the run proceeds. ⚠️ This **raises per-gate
  token cost** for every `--decider-llm` run, and a gate a weaker model would have prose-declined (and
  failed fast) is now more likely to be answered and the run to continue (longer/costlier). Pin a
  cheaper model to restore the old cost/behavior: `--decider-model <haiku-id>` or
  `COWORK_HARNESS_DECIDER_MODEL`. (n is small — read this as "Haiku is too weak for judgment-heavy
  gates," not a precise rate.) The whiff error now also names the `--decider-model` lever.
  ⚠️ **False-green caveat (new guidance, no behavior change):** binding-and-proceeding is the upside,
  but a *decided* answer is the decider's best guess from the transcript tail — it never sees the
  mounted documents — so it can fabricate (oracle-less gate) or get a doc-answerable fact wrong, and a
  green run resting on it is a false pass. **Script any gate whose answer feeds a _semantic_ assertion
  (`--answer` / `--answer-policy`); reserve `--decider-llm` for structural-assertion runs.** See
  `references/fidelity-and-answers.md` in the skill.
- **Stall detector now also flags a stall AFTER an answered gate (H3).** The `stalled` verdict signal
  previously fired only when a run ended on a question having made *no tool calls at all*. It now fires
  when a run ends on a question and made **no productive tool call after its last `AskUserQuestion` gate** —
  catching the case where the agent answers a gate, then re-asks in plain text and stops with the
  deliverable never produced (previously a `result: "success"` false-green). The no-gate case is unchanged.
  Re-derives identically on replay. ⚠️ This can flip a previously-green scenario to red — set
  `allow_stall: true` to restore the prior verdict if ending on a question is the intended terminal state
  (e.g. a skill that writes its output and then ends on a confirmation/"anything else?" question). The signal
  is a *tool-position heuristic*, not deliverable detection, so it is imprecise in both directions: a post-gate
  tool *call* (successful or errored) clears the flag even if nothing useful was produced (false negative);
  and a deliverable produced *before* the final gate does NOT clear it, so a write-then-confirm-then-question
  run is flagged (false positive). Assertions are the real guard — assert the deliverable
  (`file_exists`/`artifact_json`), never `result` alone — and use `allow_stall` for a deliberate
  question-terminal skill.

### Fixed

- **`--decider-llm` now binds an echoed grant label on a `web_fetch` approval gate** instead of failing
  loud. The web_fetch permission-approval path matched the model's reply with an exact-label check only,
  so a reply that echoed the option plus a self-glossed tail past a `:` boundary (e.g.
  `Allow once: fetch this URL one time` against option `Allow once`) aborted the run — the same echo shape
  the `AskUserQuestion` path already tolerates. The permission path now applies the same `echoPrefixMatch`
  backstop, so the echoed label binds. Out-of-set replies still fail loud.
- **The three non-retried `--decider-llm` transport failures now name their mitigation in the error.** A
  timeout, a `maxBytes` overflow, and a spawn failure (e.g. `ENOENT`) forfeit the run by design — they are
  not transient — but the surfaced message previously named only the failure. It now points at the lever:
  `COWORK_HARNESS_LLM_TIMEOUT_MS`, `COWORK_HARNESS_LLM_MAX_BYTES`, and `PATH` / `COWORK_HARNESS_CLAUDE_BIN`
  respectively. No retry behavior changed.
- `doctor`'s "no token, but a Claude Code Keychain entry exists" remedy now also names the
  `--dotenv` workaround. The macOS Keychain branch previously printed only "copy the token into
  `./.env`", which led an operator whose token lived in a *different* file to conclude `doctor`
  ignores `--dotenv` — it does not (the global `--dotenv <path>` is honored by `doctor` exactly as
  by `skill`/`run`, since it loads into `process.env` before dispatch). The remedy now reads
  "… or, if the token is already in another file, point at it: `cowork-harness --dotenv <path> <cmd>`".

## [0.18.0] — 2026-06-27

### Fixed

- `sync` no longer flags an unknown delta when `coworkEgressAllowedHosts` is absent from
  `config.json` (the normal state for a fresh install with no user-configured custom egress
  hosts). Previously the absent key was treated the same as a wrong-typed value and blocked
  the baseline write entirely.
- `sync` now regenerates the baseline `$comment` with the current capture date instead of
  carrying the stale string forward from the prior baseline via the `...base` spread.
- A misplaced GLOBAL flag (the space form `--dotenv <path>` / `--run-dir <path>` placed *after* the
  subcommand, where the pre-0.17.0 docs put `--dotenv`) now fails with a position hint —
  `--dotenv is a GLOBAL flag and must come BEFORE the subcommand (e.g. \`cowork-harness --dotenv <path> doctor …\`)`
  — instead of a bare `unknown flag: --dotenv` (or, for some commands, an unrelated positional /
  "unexpected argument" error) that sent users hunting for a per-command flag that doesn't exist. The
  hint honors `--output-format json`, never pre-empts `--version`/`--help`, and only fires for a known
  subcommand (a junk command still gets the accurate "unknown command"). The `--dotenv=<path>` equals
  form is not matched — to avoid hijacking a legitimate value like `--answer "--dotenv=x=y"` — so a
  misplaced equals form still gets the plain unknown-flag rejection. (A bare `--dotenv`/`--run-dir`
  token used as another flag's omitted value, e.g. `decide --question --dotenv`, is pre-empted by the
  hint rather than the more specific "requires a value" error; both exit 2.)
- `doctor`'s no-token remedies now show `--dotenv` in its correct **leading** position
  (`cowork-harness --dotenv <path> <cmd>`). The git-worktree remedy previously printed the pre-0.17.0
  `<cmd> --dotenv` form — which the new position hint above now rejects — so `doctor` was suggesting a
  command the harness refuses. The generic no-token remedy also now advertises the
  `--dotenv <path> <cmd>` form, so pointing at a non-cwd `.env` is discoverable.
- `skill --help` / `run --help` now label `--run-dir` as a **GLOBAL** flag that must precede the
  subcommand. It was listed in each command's local "Output:" flag block, implying
  `skill … --run-dir <path>`, which the command rejects (`--run-dir` is honored only before the
  subcommand, like `--dotenv`).

### Changed

- Baseline bumped to `desktop-1.15962.0` (agent `2.1.187`). Content is unchanged from
  `1.15200.0` — host-loop generator, system prompt, identity, gates, and egress domains are
  all byte-identical per asar analysis. Version and fingerprint fields only. The live-contract
  suite was re-run green against the staged `2.1.187` agent on this baseline, so the
  "verified end-to-end" claims are earned. Cassettes recorded against the `1.15200.0` baseline will
  report a non-failing baseline-drift warning on `replay` (a hard fail under `--strict` /
  `verify-cassettes`); re-record to clear, or ignore it since the asar content is byte-identical.

### Documentation

- Audit-validated doc/DX fixes: corrected the `docs/cassette.md` cassette-version example
  (`6`→`7`); rewrote the `protocol-smoke` row to stop referencing a rejected
  `transcript_no_host_path: false` line; scoped the SKILL.md "agent binary" prerequisite to the
  sandboxed live tiers (protocol/replay need none); added `python3` to the README requirements
  (the `lint` linter shells out to it); moved the `/plugin` slash-command block off the `bash`
  fence; pinned `cowork-harness@>=0.17.0` in the CI recipe; noted that `chat` excludes
  `microvm`/`cowork`; and other small corrections from a full documentation audit.
- Refreshed all verification/version stamps that still pinned `1.15200.0` / `2.1.181`
  (README, DESIGN, SPEC, the spawn-contract reference, `docs/cassette.md` fingerprint example,
  and the `hostloop-prompt.ts` re-verified comment) to `1.15962.0` / `2.1.187`.

## [0.17.0] — 2026-06-26

### Upgrade notes

- **Re-record all cassettes after upgrading** (`cowork-harness record cassettes/ --rerecord-stale`).
  The skill-hash delimiter changed (v6 → v7); `verify-cassettes` reports which cassettes need it.
- **`transcript_no_host_path: false` is now rejected by the schema.** Remove the key or change it
  to `true`. (It was never meaningful as `false`.)
- **`is_null: false` on an absent path now fails loud** instead of silently passing. Add
  `exists: true` if you intend to assert presence before the null check.

### Fixed

- **The microVM egress proxy port is now allocated via bind-port-0 instead of freePort().** The
  previous approach (bind :0 → read port → close → re-bind real proxy) had a TOCTOU gap: another
  process could grab the port between the probe close and the proxy bind. The proxy now binds on `:0`
  directly; `actualPort` is read from the live socket and threaded into the guest firewall rule and
  `HTTP(S)_PROXY` env after the proxy is already bound. L1 (container/hostloop) was unaffected
  (uses a fixed port inside Docker's per-run network namespace); L0 (protocol) has no proxy.
- **Cassette fingerprint format is v7.** The skill-hash uses a NUL byte (`\0`) to delimit entries
  (`F:`, `D:`, `L:`) — unambiguous for all POSIX-valid filenames. `CONTENTSIG_ALGO` is 3.
  `verify-cassettes` reports `recorded under an older hash format (v6 → v7)` for stale cassettes;
  re-record with `--rerecord-stale` to clear.
- **`transcript_no_host_path` only accepts `true`.** Omit the key to skip the check; `false` is
  rejected by the schema (`const: true`).
- **`is_null: false` requires the path to be present.** An absent path fails loud. To assert "exists
  and is not null", write `exists: true` alongside `is_null: false`.
- **The egress proxy no longer crashes on a double-end or EPIPE.** When an upstream TLS error
  arrived after the response had already been ended (e.g. the client disconnected mid-stream),
  calling `res.writeHead(502)` on an already-sent response threw, taking down the proxy for the
  remainder of the run. The guard now skips the `writeHead` call when `res.headersSent` is true and
  swallows the resulting EPIPE.
- **L0 (protocol) containment check now uses `realpathSync` to guard against symlink escape.** The
  previous path comparison used the raw strings; a symlinked workspace folder could resolve outside
  the declared root and the check would miss it.
- **Session `enabledPlugins` now emits the correct `{ "name@mp": true }` object-map** that
  `claude --settings` requires, rather than an array of plugin-name strings that is silently ignored.
  Plugin loading via `--settings` was silently broken for any session with `enabled_plugins:` set.
- **`probeMicrovmOmitted` no longer issues a `limactl shell` probe when the Lima VM is not Running.**
  A cold (Absent) or stopped VM cannot be probed; the harness now skips the capability probe
  entirely and returns `null` rather than trying to shell into a non-running instance.
- **`is_null: true` on an absent path now directs to `absent: true`** with a clear error rather than
  silently treating absent-as-null (the two are semantically distinct: absent = the key doesn't
  exist; null = it exists with a JSON null value).
- **Boundary `/host` probe split into two independent checks.** The previous single-command probe
  could false-pass when the host filesystem was sealed but the `/host` directory existed and was
  empty. The probe now AND-combines a listing check and a no-denial text check.
- **`--decider-llm` transport now bounded-retries a transient `claude -p` exit and surfaces *why* it
  failed.** A single `claude -p` decider spawn can exit non-zero on a transient upstream hiccup
  (rate-limit/overload/network) during a long back-to-back batch — observed 1/8 live runs, not reproducible
  on demand. The non-zero-exit class is now retried (default 2 attempts, small linear backoff;
  `COWORK_HARNESS_LLM_RETRIES=0` to disable) so a transient exit doesn't kill a 10-minute paid run at the
  final gate. Retry never double-answers: the transport has no harness side effects, and a non-zero exit
  delivers no answer, so the gate is answered exactly once downstream of a successful call. The timeout /
  `maxBytes`-overflow / spawn-`ENOENT` classes are not transient and still fail loud on the first attempt.
  (A *deterministic* non-zero exit — bad `--decider-model`, auth — is also retried the full count before
  failing loud; the cost is bounded and the captured output names the cause.) The exit error now folds in the
  child's captured **stdout** (where `claude -p` writes its operational diagnosis — verified) and stderr, so
  `exited 1` is no longer undiagnosable.
- **`--decider-llm` now binds a markdown-/quote-wrapped `OTHER:` free-text directive.** A model often
  code-fences a verbatim directive (`` `OTHER: …` ``, `"OTHER: …"`); the leading backtick/quote previously
  defeated the `^\s*OTHER:` anchor and the gate whiffed → fail-loud stall (observed live). The sentinel now
  matches on the `trimNearMiss` form (wrapping quotes/backticks stripped, `:` preserved), so a real
  `OTHER:`-named option label still wins first via the exact-label tier.

## [0.16.0] — 2026-06-26

### Fixed

- **`--decider-llm` no longer whiffs when the answering model echoes the rendered option line (H10).** The
  model is now prompted to reply with the option **NUMBER** (the prompt renders options numbered, with
  descriptions on their own line) and the harness maps the number to the exact canonical label — so the
  reproduced `"Seed / AI/ML: Seed stage…"` (model parroting the `label: description` bullet) and similar
  whiffs can't occur on the common path. A backstop still binds a `label: description` echo (label is a
  boundary-prefix of the reply at a `:` boundary, longest-wins) and the `(Recommended)` suffix; conversational
  asides (`"No, I disagree…"`, `"Seed (probably) but Series A"`) and bare prose stay **loud, never a guess**.
  The LLM decider's unanswered error now also surfaces the `closest:` label.
- **`--decider-llm` now answers multi-select gates.** The LLM path had no `multiSelect` branch (a
  "select all that apply" gate could pick only one option); it now accepts a comma-list of option numbers
  (`1, 3`) and a mixed digit+label reply fails loud.

### Added

- **`--decider-model <id>`** (on `skill`, `decide`, and `record`) overrides the `--decider-llm` answering
  model — flag > env `COWORK_HARNESS_DECIDER_MODEL` > the Haiku default. Use a stronger model for genuinely
  ambiguous *judgment* gates; it does not make an under-specified gate deterministic. Requires `--decider-llm`.
- **Scripted `choose:` (and `--answer`) accepts a stable partial anchor** for skills whose option labels
  drift run-to-run: `choose: "Israeli company"` binds whichever single option starts with it (boundary-anchored,
  uniqueness-guarded). It **fails loud** if the anchor matches two options — drift-tolerance, not strict CI
  reproducibility (for that, pin a full exact label or use a free-text `answer:`).

### Docs

- **Added a debugging on-ramp (`docs/debugging.md`).** A router for "my skill misbehaved"
  (`inspect` → `trace` → `chat` → `verify-run`) vs. "I don't trust this green" (the false-green hunt:
  Gotchas, `lint`, `verify-cassettes`, `COWORK_HARNESS_DEBUG_SKILLHASH`), wired into every doc index
  (README, `docs/README.md`, `llms.txt`, the companion skill).
- **Documentation review sweep — doc-vs-code discrepancies corrected, DX/clarity/structure gaps closed
  (26 files).** Adversarially verified against `src/`. Highlights: startup `--folder` is a **staged fresh
  copy** (writes land in the run's `mnt/<folder>`, not the host original), not a live bind mount
  (`fidelity-gaps.md`, `chat.md`); `microvm` is **Lima + Apple-VZ**, not Docker (`python/README.md`);
  `llms.txt` command list corrected (`prune`/`inspect`, not the non-existent `runs gc`); the
  `verify-cassettes` JSON envelope documents its `coverage{}` field (`SPEC.md`); the discovery version-gate
  sits on **local** plugins while `.remote-plugins` is unconditional (`discovery.md`); `extra_allow` is
  **session-level** (`DESIGN.md`); same-repo release-branch PRs **do** run the live scenario suite
  (`RELEASING.md`); the `ci-recipe.md` live-lane gate uses a valid guard-step output (the prior
  `if: ${{ secrets.… }}` is not a valid Actions context); plus assertion-operator (`artifact_json`'s `in`),
  host-path-set, and exit-code corrections. DX: the `claude` CLI named as a prerequisite, the README
  reordered to a zero-infra-first ramp, and the three doc indexes reconciled by audience.

## [0.15.0] — 2026-06-25

### Fixed

- **Staleness no longer masks a scoped skill's own drift behind a co-occurring shared change.** For a
  `skills:`-scoped cassette, when BOTH the shared roots AND the scoped skill's own files changed, the
  diagnosis previously reported only `shared root changed` and never the skill — the two buckets were
  mutually exclusive (shared tested first). It now attributes drift per-bucket by the actual changed paths and
  emits BOTH a `shared-root` and a `skill` finding when both moved, each naming its own files. The same
  diagnosis (per-file `[N changed (…)]` detail and the `COWORK_HARNESS_DEBUG_SKILLHASH` hook) now also runs on
  the `replay` lane, which previously had a separate, less-detailed copy. With `COWORK_HARNESS_AGENT_SCOPE=skill`
  a changed `agents/<skill>.md` is attributed to that skill, matching the hash boundary.

### Changed

- **`replay --fail-on-skill-drift` no longer fails on a `COWORK_HARNESS_GITSET` / `COWORK_HARNESS_AGENT_SCOPE`
  flip.** A record-vs-verify mismatch in either setting is now classed `format` ("re-record under the same
  mode") rather than misattributed to skill/shared drift, so it is a non-failing warning under
  `--fail-on-skill-drift` (which targets skill-source drift only). It still fails under `--strict` and still
  reds `verify-cassettes`. Previously the `replay` lane mislabeled such a flip as `shared-root`/`skill` and
  failed the skill-drift gate.

## [0.14.0] — 2026-06-25

### Added

- **`replay` surfaces staleness + skipped assertions in JSON.** Each `--output-format json` result now carries
  `staleness[]` (class-tagged: `baseline` / `skill` / `shared-root` / `format` / `unverifiable-baseline` /
  `unverifiable-skill`) and `skippedAssertions` (`{full, partial}`), so a token-free CI gate can see a stale
  cassette or live-only assertions it didn't evaluate WITHOUT the verdict changing — a stale but otherwise
  passing replay stays `ok:true` by default. Previously these were stderr-only `::warning::` lines invisible
  to a JSON consumer.
- **`replay --fail-on-skill-drift`.** A narrower release gate than `--strict`: fails only on skill-source drift
  (`skill` / `shared-root` / `unverifiable-skill` — "can't verify the skill ⇒ not green"), while baseline /
  format / environment-level staleness stays a non-failing warning. `--strict` remains the superset (fails on
  every class).

### Fixed

- **Linter no longer false-flags `requires_capabilities`.** `cowork-harness lint` warned `unknown-top-key` on
  the valid scenario field `requires_capabilities` (its hand-maintained top-level-key list had drifted from the
  schema). The list is now generated from the Zod `ScenarioObject` schema (like the assertion-key list), so it
  can't drift; a parity test guards it.
- **SKILL.md capability pre-flight wording corrected.** It described `requires_capabilities` as skill-declared
  and said the harness "warns before the run"; it is a **scenario field** and the harness **aborts before the
  paid run (exit 3)** when the image omits a required capability (unless `allow_missing_capability: true`). The
  authoritative `docs/scenario.md` was already correct.

## [0.13.0] — 2026-06-25

### Added

- **`inspect <run-id | run-dir>` — see what a run produced.** Lists the run's artifacts and prints a shallow
  field preview of each JSON artifact (scalars inline, arrays as a count, nested objects collapsed), so
  "did it do the job?" is a first-class check instead of hand-parsing `…/mnt/outputs/...`. `--output-format
  json` emits a structured digest. When the work dir was torn down (a non-`--keep` container/microvm run),
  the artifact manifest still prints from `result.json` and the preview notes it's unavailable.
- **A whiffed gate no longer discards the paid run.** When a run exits on an unanswered gate
  (`on_unanswered: fail`), the harness now salvages a **PARTIAL** `result.json` (+ `run.jsonl`/`trace.json`)
  with the artifacts the agent wrote before the whiff, then still exits 2. The run dir is printed so you can
  `inspect` it. `partial` and `unansweredGate` are new `RunResult` fields; `verify-run` and `scaffold`
  refuse to treat a partial run's half-finished output as a passing result (scaffold still emits the gates,
  drops the artifact/result asserts, and warns loudly).
- **Capability pre-flight — fail fast.** A skill that declares `requires_capabilities` against an image that
  provably omits them now **aborts before the (paid) run** (`exit 3`) instead of running ~12 min to a verdict
  that's already known — unless the scenario asserts `allow_missing_capability: true`, which downgrades it to
  a notice and proceeds. `doctor` also surfaces the full-parity remedy on its agent-image line.

### Changed

- **LLM decider tolerates a near-miss label.** `--decider-llm` now binds a reply like `Confirmed.` or
  `"Confirmed"` to the label `Confirmed` (trailing sentence punctuation / surrounding quotes trimmed before
  matching) instead of failing loud — common on binary confirm gates. The `:` of the `OTHER:` free-text
  sentinel is never stripped, and fuzzy substring matching stays off, so the change can't mis-bind. The
  tolerance lives in `matchLabel` itself, so the web_fetch-approval path gets it too (a `Deny.` reply now
  binds `Deny`).
- **`runs gc` → top-level `prune`; the `runs` namespace is dropped.** Pruning accumulated run dirs is now
  `cowork-harness prune [--keep-last <n>] [--dry-run] [<runs-dir>]` (same flags). `runs` was a namespace with
  a single member and collided confusingly with `run` (execute); removing it leaves `run` = execute,
  inspection verbs (`trace`/`inspect`/`verify-run`/`scaffold`) top-level, and `prune` for cleanup.

### Fixed

- **Session-protocol over-cap test no longer flakes.** The over-cap control-out test read
  `control-out.jsonl` synchronously, but the stream opens it asynchronously (`createWriteStream`, flags
  `"a"`), so under load the file may not exist yet at the read — a flaky ENOENT. The over-cap frame is
  rejected before any write, so a missing file means nothing was written; the test now treats absence as
  empty.

### Docs

- **Documented the LLM-decider free-text path.** `--decider-llm` supplies free text via `OTHER: <value>`
  on an options-bearing gate; a bare out-of-set answer (no matching label, no `OTHER:`) fails loud
  (`UnansweredError` → exit 2), never stalling or guessing, and open-ended (no-option) gates need no
  prefix. Noted in the decider section of `fidelity-and-answers.md` and cross-referenced from the lone
  `OTHER:` mention in `SKILL.md` so the two don't drift.
- **Documented the live real-document validation workflow.** A new SKILL.md section covers driving a skill
  against real input documents (not recording a cassette): explore with `--decider-llm --intent`, script the
  load-bearing and binary-confirm gates, budget ~1 re-run per file (a whiffed gate now salvages a partial
  run), and `inspect` the outputs to judge correctness.

## [0.12.0] — 2026-06-24

### Added

- **`record` now shows the offered options when a scripted answer matches none.** A `choose:` that names no
  offered option previously failed with just "matched no offered option" — you had to dig through
  `events.jsonl` for the real labels. The error now lists the **valid labels** and suggests the **closest
  match**, so you can fix the anchor from the error alone. (The labels were already on the error object; the
  record path just wasn't printing them — `run`/`skill` already did.)
- **`doctor` detects the git-worktree `.env` trap.** Running from a git worktree where `./.env` is gitignored
  (so absent) yields "no token"; when the **main checkout** has a `.env`, `doctor` now points you at
  `--dotenv <main>/.env` instead of the generic remedy. (Keychain hint still takes precedence on macOS.)
- **`scaffold` stamps a provenance header on generated scenarios.** Output now carries a
  `# generated by cowork-harness v<ver> (scaffold)` comment (a comment, since the scenario schema is
  `additionalProperties: false`), mirroring the cassette's `generator`/`$schema`/`cassetteVersion` provenance.
  The shipped `example-pdf-skill` replay cassette — previously a hand-authored legacy fixture with no
  signature and a stale embedded scenario — was re-recorded live so it now carries a genuine v6 signature +
  fingerprint/artifacts/userVisibleRoots and matches the current scenario YAML (replays green;
  `verify-cassettes` clean).

### Changed

- **`verify-run` answer-coverage now refuses against a *stale* kept run.** Every run persists a skill
  fingerprint in `result.json`; on the answer-coverage path (`answers:` declared), `verify-run` recomputes it
  live and, if the skill source changed since the run was kept, **exits 2** ("the kept run predates the current
  skill") instead of vouching for answers against a stale gate snapshot. ⚠️ This closes a false-green: a
  reworded/moved gate after `--keep` would previously green against the old labels. The plain `assert:`-only
  re-eval (no `answers:`) is unaffected; a kept run recorded by an older harness (no fingerprint) → a warning,
  not a refusal. `RunResult.fingerprint` is the new persisted field.

### Parity

- **Synced the platform baseline to Claude Desktop 1.15200.0** (`baselines/desktop-1.15200.0.json`). The
  staged agent ELF is **unchanged (2.1.181)** — the bump is host-side: `sync` re-derived egress / gates /
  mount / web_fetch facts (no `unknown delta`; only the `asarFingerprint` moved). Re-verified end-to-end —
  the live scenario suite (`protocol` + `container` tiers) passes against the new baseline.
- **Re-paraphrased the reconstructed system-prompt + subagent appends for 1.15200.0**
  (`baselines/prompts/desktop-1.15200.0/`). Cowork's identity constant was rewritten **first→third person**
  (it no longer says "powering Cowork mode"; the load-bearing "is NOT Claude Code" correction is kept);
  `file_handling` became a scratchpad-vs-workspace split, and `working_with_user_files` / `product_information`
  blocks were added; the subagent-append VM clause changed to "not on the user's real computer." Host-only
  affordances (`request_cowork_directory`, `computer://` links) are described as behavior, **not** injected as
  instructions, so they don't induce dead tool calls on the container / microvm / protocol tiers. The host-loop
  `## Shell access` generator was re-verified **byte-identical** (one new conditional sentence stays omitted —
  our single-container topology never triggers it; comment + verification stamp refreshed).

### Fixed

- **Baseline-bump-stable staleness tests.** `staleness-roundtrip`, `manifest`, and `agent-scope` round-trip
  tests hardcoded the baseline version (`1.14271.0`), so adding a new latest baseline re-staled them; they now
  source it from `loadBaseline("latest")`, so a parity bump no longer breaks the green round-trips.
- **`example-pdf-skill` asserts the workspace deliverable correctly.** The scenario connects a folder, so
  `{{workspaceFolder}} = mnt/project` and the model writes the deliverable into the folder
  (`mnt/project/outputs/actions.md`), not `mnt/outputs` — but the assert was `file_exists: outputs/actions.md`
  (anchored at `mnt/`), so it failed. Switched to `user_visible_artifact: project/outputs/actions.md` (spans
  the user-visible roots). A pre-existing scenario bug (fails identically on the old prompt), not a parity
  regression; the `{{workspaceFolder}}` resolution is faithful to the Desktop builder `y8r`. Docs + skill now
  teach `user_visible_artifact` vs `file_exists` for folder-connected deliverables.

### Docs

- **Baseline-pin sweep to `desktop-1.15200.0`** across README / DESIGN / SPEC / spawn-contract / skill docs
  (agent ELF still 2.1.181). The `≥1.14271.0` mount/bare-name gate-boundary references are intentionally left
  as-is — that boundary did not move.
- Skill + scenario docs: the gate-centric answer-coverage currency rule; the cheap `--keep` → `trace
  --view questions`/`verify-run` authoring loop (no token-free gate probe exists — gates are model-decided);
  the mismatch-vs-unanswered hard-fail gotcha; "anchor only assert-relevant gates, prefer `on_unanswered:
  first` elsewhere"; the keep-going batch semantics (`record <dir>`/`--rerecord-stale` record all and report
  at the end — no one-at-a-time wrapper needed); and the git-worktree `.env` gotcha.

### Security

- **Hardened HTML-comment stripping in prompt assets (CodeQL `js/incomplete-multi-character-sanitization`).**
  A one-shot `.replace(/<!--[\s\S]*?-->/g, "")` is incomplete multi-character sanitization: removing an inner
  comment can recombine surrounding fragments into a fresh `<!--` the single pass leaves behind (e.g.
  `<!<!-- -->-- x -->` → `<!-- x -->`). `stripComments` now loops until the string stabilizes and is shared
  from `prompt.ts`; `hostloop.ts` reuses it instead of a duplicated inline regex. Resolves the finding at both
  call sites; a regression test covers the recombination case.

## [0.11.0] — 2026-06-24

### Added

- **`record --concurrency <N>` — parallel fleet re-records.** A directory batch (or `--rerecord-stale`) can
  now record N cassettes at a time (`record cassettes/ --rerecord-stale --concurrency 3`) instead of one ~7–8
  min run after another. Every run is already fully isolated (its own per-run Docker networks + egress proxy,
  its own session dir), so parallelism is safe; `--concurrency` is purely a **bound** against Docker's address
  pool and model API rate limits. Default `1` (unchanged behavior + ordered output), max `8`. A dir batch
  where two scenarios' `name:` slugify to the same cassette path is now rejected up front (they would clobber
  each other — a pre-existing footgun parallelism would have surfaced).
- **Opt-in per-skill agent scoping for cassette staleness (`COWORK_HARNESS_AGENT_SCOPE=skill`).** By default a
  plugin's `agents/` directory is a fleet-wide staleness root, so editing one skill's sub-agent contract
  (`agents/cap-table.md`) re-stales *every* cassette. With this env set, a **skill-named** `agents/<name>.md`
  is treated as skill `<name>`'s private input (refining a scenario's `skills:` scope), so it re-stales only
  that skill's cassettes; generic (non-skill-named) agents stay shared. The setting is stamped into the
  cassette fingerprint (`agentScope`), so flipping it is an honest one-time "re-record under the same setting"
  (like `COWORK_HARNESS_GITSET`); cassettes recorded without it are unaffected. Caveat: assumes an agent named
  after a skill belongs to that skill — keep it off if you share a skill-named agent across skills.

### Fixed

- **Clarified `verify-run` answer-coverage docs (gate-centric, not rule-centric).** `verify-run` checks that
  every gate the run *actually fired* is covered by a matching `answer`; it does **not** penalize answer rules
  that no fired gate matched (e.g. rules for conditional gates that didn't fire). The behavior was always
  correct; `docs/scenario.md` now states it precisely (a scenario with 5 rules whose run fired 2 gates passes
  at "2/2 matched").

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

- The npm tarball no longer ships internal planning notes that were accidentally being published.

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
  the `config_dir` write-guard caveat, the `boundary-check` (exit 1) vs `BoundaryError` (exit 3) exit-code
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

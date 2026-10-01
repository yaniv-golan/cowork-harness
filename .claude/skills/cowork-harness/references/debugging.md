# Debugging a run

Tracks `cowork-harness 4.2.0` (baseline `desktop-2.16120.0`). Read it when a run misbehaved or a green looks wrong: triage, the observability output, and `chat`.

## Part III — Debug

A run misbehaved, or greened when you don't trust it. Debugging is a first-class loop, not an
afterthought: the run already wrote its evidence, so you **localize the failure post-hoc** rather than
re-run and hope. Start at the triage below, then use the observability output and, when you need to
reproduce interactively, `chat`. (The fuller human-facing map is
[`docs/debugging.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/debugging.md) — repo-only,
not shipped with the installed skill.)

> **"Evidence" below means the run's own record** — events, trace, transcript; what `trace` / `inspect` /
> `diff` / `verify-run` / `replay --explain` read. `critique`'s **evaluator** grades against a separate,
> narrower record — `critique-evidence-package.txt`, what a grade was actually computed against — none of
> the five tools above surface it; see `references/critique.md`.

### Triage — a run misbehaved, or a green looks wrong

<!-- BEGIN triage-canonical -->
Two situations need different tools — figure out which one you're in first, then reach for the tool
instead of re-running and hoping. The run already wrote its evidence to a kept run dir (`--keep` prints
the path; `trace <run-id>` finds it), and every tool below reads that evidence **token-free** — no
Docker, no re-record.

| Situation | Symptom | Reach for (in order) |
|---|---|---|
| **The skill misbehaved** | wrong output, an unexpected gate, a denied tool, an opaque crash | `inspect` — what did it produce? · `trace <run-dir> --view <view>` — what did it actually do (tools, gates, sub-agent tree)? · `verify-run` — re-assert cheaply when only an assertion is wrong · `diff <old-run> <new-run>` — what changed since it worked · `chat` — reproduce it by hand |
| **A green you don't trust** | an assert that may have tested nothing, a stale cassette, an auto-answered or decided gate | `replay --explain` — the evidence trail behind each *passing* assert · `replay --mutate` — perturbs a CAPPED SAMPLE of recorded JSON values (10/file, 50 total) and reports which perturbations NOTHING caught; the report names the sample size, so read it as a sample not a total (reporting only; never moves the verdict/exit code) · `lint` — assertions on the wrong CI lane / mixed-class keys · `verify-cassettes` — privacy + staleness over committed cassettes · the Gotchas landmine catalog — how a check passes vacuously · `run --repeat N` / `skill --repeat N` — did it pass, or pass once? · `stats` — flaky or expensive over time |

A failed run also records `errorSource` (where the failure originated) and `stderrLogPath` (the captured
agent stderr) — read those before re-running; a re-record rarely tells you more than the captured stderr
already does.
<!-- END triage-canonical -->

**`verify-run` never calls the semantic judge**, so it cannot re-grade a `semantic_matches` assert. When the
rubric changed (or you want another judge model) on a run you already paid for, use
`cowork-harness regrade <run-dir> --scenario <scenario.yaml>` instead: it re-grades those asserts against the
kept run without re-running the agent — unlike the tools above it is not token-free (the judge call is its
spend) — writes the grade beside the run, and says whether the judge read the same document the live judge did.
Content the live judge never read (a widened `evidence_files` / `include_subagent_text` scope, or a larger
`--authored-total-bytes`) is refused unless you pass `--allow-unchecked`.

**microvm: "control-protocol write failed" with `env: 'claude': No such file or directory` in the agent
stderr** usually means the VM never finished provisioning (the agent never reached PATH). Check
`cowork-harness vm status` — a `provisioning` other than `ready` confirms it — and if a run does not
recover it on its own, `cowork-harness vm delete` and retry. A run on such a VM can also have cached an
empty toolchain for it in the capability probe's cache: `vm delete` drops that VM's entry (`vm prune`
forgets only the orphaned VMs it deletes, never the current one); otherwise delete `capability-cache.json`
from the runs root (`~/.cowork-harness/runs/` unless
`COWORK_HARNESS_RUNS_DIR` is set) so the next run probes again.

**Is it your skill's bug, or a known harness gap?** Before deep-debugging a wrong behavior, rule out a
**deliberate fidelity gap** — the harness intentionally does *not* reproduce a few real-Cowork behaviors,
so a "bug" you see here that real Cowork also has isn't yours to fix. The tier semantics are in
`references/fidelity-and-answers.md` (shipped); the specific deltas vs. real Cowork and the sandbox
boundary model live in [`docs/fidelity-gaps.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/fidelity-gaps.md) / [`docs/boundary.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/boundary.md) (repo-only, not in the installed
payload). If the behavior is on that gap list, it's expected — stop debugging your skill.

### Inspecting a run's observability output

A verdict is only the top of what a run records, and the run dir persists after the verdict
(`~/.cowork-harness/runs/…`). Beyond pass/fail, every `run`/`skill`/`chat` writes a `result.json` and a
trace you read back without a re-record — the debugging loop is *localize the failure from that
already-written evidence*, not re-run-and-hope. Use them to diagnose a failure (and, secondarily, to
decide which assertions from *Assertions: two orthogonal axes* in `assertions-guide.md` are worth adding):

- **`cowork-harness trace <run-dir> --view <view>`** — focuses one of the run's rollups (the per-tool
  call-count/timing table, the sub-agent dispatch tree, the gate lifecycle, the tool/error rollups, …);
  bare `trace` digests the whole run. The view set is actively being extended — run `trace --help` for
  the current list rather than relying on a fixed enumeration here.
- **`lane: local|remote`** (scenario key, default `local`) — which Cowork lane's DELIVERY CONTRACT the run
  is held to. Cowork picks the lane per session ("Run this task: In the cloud / On your computer") and
  cloud is the default for new sessions; the lanes disagree about what *delivered* means. On `remote`,
  location delivers nothing (a remote container has no auto-delivering outputs dir and is reclaimed at
  session end), `present_files` is NOT served, and `user_visible_artifact` /
  `present_files_called` / `no_scratchpad_leak` are rejected at LOAD time as unable to pass. Reach for it
  to check a skill's delivery survives the lane most new sessions get. Orthogonal to `fidelity` — a
  `lane: remote` scenario still runs locally.
- **`cowork-harness stats [--metric <m>]`** — aggregate across the run index: `cost`, `duration`,
  `tokens`, `cache-tokens`, `model-cost`, `turns`, `pass-rate`. Filters: `--since`/`--baseline`/`--branch`,
  plus `--skill-hash <prefix>`/`--label <tag>` to narrow to ONE skill generation and
  `--group-by scenario|skill-hash|label|fidelity` to split per generation — or per effective fidelity
  tier — instead of aggregating across them (a window spanning >1 generation warns, so an un-split A/B
  average announces itself rather than passing as one number;
  >1 tier warns too, independently, with `--group-by fidelity` as its own remedy). `--runs` lists the
  individual runs behind each summary with their `skillHash`/`runLabel`, so
  you can tell which arm a run belonged to without opening its `result.json`. `--last <n>` windows per group.
- **`result.json` carries the raw fields** the assertions read: `verdict`, `lane` (which Cowork delivery
  contract the run was held to — see gotcha 24 in `gotchas.md`), `scratchpadEvidenceComplete` (did a COMPLETE scratchpad
  walk observe this run — what distinguishes "nothing was left undelivered" from "cannot tell"), `cost` (`cost.usd` = the SDK's
  `total_cost_usd` for the run — the authoritative single-run spend of the agent session, which leaves out the `semantic_matches` judge and the LLM decider calls; NOT the same source as summing
  `modelUsage[].costUSD`, which is what `trace --view usage` reports, so the two can differ),
  `usage` (`input_tokens`/`output_tokens`/`turns`), `toolDurations` (with `toolDurationsBasis`), `models`,
  `toolCalls` (every tool call in stream order: `name`, top-level `input` fields each capped at 10 KB, and
  `origin` `main`/`subagent`/`unknown` — what the object form of `tool_called`/`tool_not_called` reads), `toolErrors`,
  `redundantToolCalls`, `modelUsage`, `thinking`, `skillActivity`, `subagents[]` (prompt/`dispatchModel`/
  `resolvedModel`/output/`attributedSkillId`, `outputTruncated`, `referencesRead`, `reasoning`/`reasoningElided`),
  `context` (tools/mcpServers/availableSkills), `tasks`,
  `workspaceFiles`, `presentedFiles`, `hookEvents`, `mcpErrors`, `contextEvents`, `resources`
  (`probeFailures` distinguishes a failed sample from a tier that was never sampleable). Provenance/
  evidence-health fields: `command` (`run`/`skill`/`record`/`chat`/`replay` — finer than `mode`),
  `gateProvenance` (per-gate `scripted`/`decided(llm|external)`/`first-option`/`prompt` with a
  `bySource` histogram), `evidenceErrors` (dropped/malformed telemetry lines per stream, incl.
  `egressParse`), `fingerprint.frozen` (replay only — marks the shown staleness fingerprint as the
  cassette's record-time value, not a fresh recompute), and `assertTextTruncated` (companion to
  `outputTruncated` on a matched tool result). Three separately-shaped rollups, easy to conflate in a
  `jq` recipe: `toolCounts` is a flat `{tool: number}` call-count map, `toolErrors` is
  `{tool: {calls, errors}}`, and `toolDurations` is `{tool: {calls, totalMs, maxMs, unpaired}}` — a wall
  gap over main-agent and sub-agent calls alike, where observed, not execution time (`calls` counts paired calls only;
  see `measurement.md`). (Full per-field
  semantics: [`docs/cli.md` → What you get out](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/cli.md#what-you-get-out-inspectable-output) (repo-only); [`schema/run-result.json`](https://github.com/yaniv-golan/cowork-harness/blob/main/schema/run-result.json) is the
  machine source.)
- **Opaque failure?** A failed run also records **`errorSource`** (where the failure originated) and
  **`stderrLogPath`** (the captured agent stderr) — read those and `trace <run-dir>` *before* re-running;
  a re-record rarely tells you more than the captured stderr already does. Also check
  **`resultErrorKind`** (`"transport" | "agent" | "usage_limit"`) before spending another paid run: a
  `"usage_limit"` failure is a quota exhaustion, not a skill bug — retry after the limit resets rather
  than debugging; `"transport"`/`"agent"` means something actually broke, worth localizing before
  re-running.
- **Attributing cost to sub-agent work.** `subagents[]` gives the dispatch tree — each sub-agent's
  `dispatchModel`/`resolvedModel`, `toolsUsed`, `prompt`/`output`, and `attributedSkillId` — but **not** its own token/cost;
  aggregate cost is per-**model** in `modelUsage` (and `trace --view usage`), not per-sub-agent. So a
  cost spike from fan-out reads as `trace --view dispatches` (how many, which agent) against that model's
  per-model usage — the harness doesn't line-item each sub-agent's tokens.
- **Debugging a wrong Cowork UI panel.** Each panel is reconstructed in `result.json`: **Progress** =
  `tasks[]`, **Working folder** = `workspaceFiles[]` (classified output/mount/input/scratchpad — the last being the agent's working area outside every user-visible root, with a
  `trace --view files` diff), **Context / Connectors** = `context` (tools / mcpServers / availableSkills),
  **Scratch-pad → outputs** = `presentedFiles[]`. If a panel looks wrong in a run, read its field. An
  **absent** `workspaceFiles`/`artifacts` (a replay result, or a run whose workspace root was missing at
  collection) is evidence **UNAVAILABLE**, not an empty run — `trace --view files` reports a loud
  UNAVAILABLE marker (`workspaceFilesRecorded: false` in JSON, and no phantom "removed" diff rows) and
  `inspect` prints `artifacts: UNAVAILABLE` (`artifactsRecorded: false`) instead of `artifacts (0):`.

### Debugging with `chat`

`cowork-harness chat` opens an interactive multi-turn REPL against a live Cowork session. It is
**not** an asserted test — no `assert:` block, no cassette. Use it to explore behavior, reproduce a
bug interactively, or test a prompt before committing it to a scenario.

Each session still writes an informational `result.json` (`mode: "chat"`, no `assertions`) plus a
trace and index row under its run dir — the same telemetry (tool durations, model usage, resources,
etc.) that `run`/`skill` produce — so `cowork-harness trace <chat-run-dir>` / `stats` work on a chat
session too, even though it never yields a verdict.

**`--plugin <dir>` flag (repeatable).** Load additional skill folders alongside the primary session
plugin. Each `--plugin <dir>` appends the folder to `local_plugins`. Useful when the skill-under-test
depends on a sibling plugin:

```bash
cowork-harness chat ./skills/report-gen --plugin ./skills/shared-utils --model claude-sonnet-5
```

**Note:** `--raw` mode (native `docker run -it`) can't honor the harness-managed flags, so `--upload`,
`--folder`, `--plugin`, and `--fidelity` are **rejected** with a usage error if combined with `--raw`;
only `--model` is carried through.

**`/help` in the REPL.** Type `/help` at the prompt to see available commands:

```
Commands: /exit  /quit  /help
```

The startup banner now reads `type your message (/help for commands)` as a reminder. `/exit` and
`/quit` both terminate the session.

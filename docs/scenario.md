# Scenario reference

A **scenario** (`scenarios/*.yaml`) is one test: a prompt, scripted answers to the agent's questions/permission requests, and assertions. It references a [session setup](./session.md) for the setup.

## Full schema

> **Machine-readable:** [`schema/scenario.schema.json`](../schema/scenario.schema.json) is generated from the zod source of truth (`npm run schema`) and pinned by a drift-guard test. Editors with a YAML language server validate scenarios against it automatically — the bundled examples carry a `# yaml-language-server: $schema=../../schema/scenario.schema.json` hint.

```yaml
name: my-test                             # OPTIONAL — defaults to the filename (sans ext); keys runs/<name>/
baseline: latest                          # platform baseline: "latest" or "desktop-<ver>"
session: ../sessions/default.yaml        # the pre-prompt setup (resolved relative to THIS file)
fidelity: container                      # protocol | container | microvm | hostloop | cowork (see below)
on_unanswered: fail                      # optional: policy for unscripted questions (fail | prompt | first | llm)

prompt: |                                # the user turn
  Summarize report.pdf and write action items to outputs/actions.md

answers:                                 # scripted answers (see below)
  - when_question: "Which output format"
    choose: "Markdown"
  - when_tool: Bash
    allow_if: "!command.includes('rm')"
    else: deny
  - when_tool: Write
    decide: allow
  - when_tool: "webfetch:example.com"     # a web_fetch approval (provenance-miss gate)
    decide: allow
    grant: domain                         # "Allow all for website" → approve example.com for the run
                                          # (omit or `grant: once` for a single-fetch allow)

expect_denied: ["evil.example.com"]     # egress hosts asserted to be DENIED

assert:                                  # pass/fail checks (see below)
  - result: success
  - file_exists: outputs/actions.md
  - transcript_contains: "action items"
  - tool_called: Write
  - egress_denied: evil.example.com
```

> **Use `baseline:`, not `profile:`.** `profile:` was an earlier name for this key; the harness still
> remaps a top-level `profile:` to `baseline:` and emits a `::warning::` if it sees one, but write
> `baseline:`.

## Fidelity tiers (`fidelity:`)

| Tier | What runs | Use it for |
|---|---|---|
| `protocol` | L0 — the agent on the host, no sandbox (no egress enforcement) | fastest control-loop checks; **rejected** if the scenario asserts egress/`expect_denied` (would false-pass) |
| `container` (default) | L1 — agent in a Docker container with a per-run default-deny egress proxy (VM-loop shape) | the everyday tier: real sandbox, real egress allowlist |
| `microvm` | L2 — agent in an Apple-VZ Lima microVM with a guest firewall | VM-grade escape isolation of untrusted code; network transport **equals `container`** (same allowlist proxy) — not for better network fidelity. macOS arm64 only; needs `cowork-harness vm init` |
| `hostloop` | host-loop: agent loop on the host, shell/web routed into the container via the workspace SDK-MCP server (`mcp__workspace__bash`) | reproduce Cowork's **production** split-execution model |
| `cowork` | auto-picks `hostloop` vs `container` the way Cowork itself does (gate `1143815894`, decoded from the synced baseline) | "do what real Cowork does for this release" |

`hostloop`/`cowork` are the production-faithful path (see [DESIGN.md](../DESIGN.md)); `container` is the
practical default. Boundary assertions are enforced at `container`, `microvm`, and `hostloop`.

## Scripted answers

Each rule resolves an inbound `can_use_tool` control request — the same channel Cowork's question UI uses.

### AskUserQuestion
```yaml
- when_question: "format|style"   # regex (case-insensitive) on the question text
  choose: "Markdown"              # the option label to select
```
`choose` tolerates the standard `(Recommended)` label suffix (write `choose: Approve` for an offered
`"Approve (Recommended)"`), and accepts the keywords `choose: recommended` / `choose: first`.

**multiSelect gates** — supply a list of labels; the harness validates each against the offered options and
delivers them as the binary-verified comma-joined wire shape (`"Auth, Billing"`):
```yaml
- when_question: "which features"
  choose: ["Auth", "Billing"]     # multiSelect: a list of labels
```
(If a member label itself contains a comma, the harness warns — the wire joins with `", "` unescaped, a
Cowork limitation that can't round-trip such a set.)

**Free-text "Other"** — Cowork offers an "Other" free-text path on every gate; supply an arbitrary string
with `answer:` (distinct from `choose:`, which stays validated against the offered labels):
```yaml
- when_question: "company name"
  answer: "Acme Holdings LLC"     # free-text; bypasses label validation by intent
```
`choose` and `answer` are mutually exclusive on one rule (setting both fails loud). *(Reserved for later: a
whole-gate freeform `response:` — "typed instead of selecting" — is a distinct future key; if added it will
have an explicit precedence vs `answer`/`choose`, so today's two-key model stays forward-compatible.)*

If no rule matches a question, the **`on_unanswered` policy** decides — the harness never silently
fabricates an answer. Set it per scenario (`on_unanswered: fail | prompt | first | llm`) or per run
(`--on-unanswered`). Default for `run` is **`fail`** (the error names the exact `--answer`/`choose`
to add); `first` picks option 1 and warns loudly; `prompt` asks at the TTY. (`run` rejects `prompt` —
it would break determinism.)

`llm` lets an **in-band LLM decider** answer the unscripted question (the scenario-YAML equivalent of
the CLI's `--decider-llm`). It is **non-deterministic** by construction, so a run that uses it is flagged
`nonDeterministic` in the record — keep it out of deterministic CI regressions; prefer scripted answers +
`fail` there. See the determinism note above and the decider flags in the [README](../README.md).

> **Where scripted answers hold up — and where they don't.** The `when_question` regex absorbs *wording*
> drift (an LLM phrases "confirm the stage" many ways), so scripting is robust for skills whose gates are
> structurally stable (the gate reliably appears). It does NOT cover *structural* stochasticity — a skill
> that decides run-to-run *whether* or *which* to ask: there, `on_unanswered: fail` will hard-error on a
> gate it didn't anticipate (correct, but flaky for that skill). For that case answer live instead —
> `--decider-llm` (a model answers, run flagged non-deterministic) or `--decider-dir` (you answer in-band)
> — accepting the run is then no longer a deterministic regression.

> **Batched gates are answered atomically.** A gate with several sub-questions is answered (and delivered)
> as one unit. If your scripted rules match only *some* sub-questions, the **whole gate** falls through to
> the `on_unanswered` policy (the warning names which sub-questions were unmatched, so you know which rule to
> add). *Current* behavior — don't build on "a partial match always sends the whole gate to the fallback":
> it may later become **opt-in composable** (script some sub-questions, let the fallback fill the rest in one
> envelope), which would be introduced behind an explicit flag so this default is preserved.

### Reusable answer policies (`--answer-policy`)

When you drive a skill directly with `cowork-harness skill … --answer-policy <yaml>` (rather than a
scenario file), you can keep its known AskUserQuestion gates in a reusable YAML policy instead of repeating
`--answer "<rx>=<choice>"` flags. The policy is the **same regex→label rules** a scenario's `answers:`
block uses — a bare list of `{ when_question, choose }` rules, or an `{ answers: [...] }` doc:

```yaml
- when_question: "output format|which format"   # case-insensitive regex on the question text
  choose: "Markdown"                             # the option label to select
- when_question: "confirm.*stage"
  choose: "Looks right"
```

A missing, unparseable, or non-list policy file **fails loud** at load time — a malformed policy is never
treated as "0 rules" (which would surface only when a gate went unanswered mid-run). A runnable copy is
[`examples/answer-policies/demo.yaml`](../examples/answer-policies/demo.yaml). Use it for declarative,
deterministic CI: scripted answers + `fail` for everything they don't cover.

### Tool permissions
```yaml
- when_tool: Write
  decide: allow                   # allow | deny

- when_tool: Bash
  allow_if: "!command.includes('rm') && !command.includes('curl')"  # JS predicate over the tool input
  else: deny                      # decision when the predicate is false (default: deny)

- when_tool: "webfetch:example.com"   # a web_fetch APPROVAL (raised on a provenance miss)
  decide: allow
  grant: domain                       # "Allow all for website" → approve example.com for the rest of the
                                      # run; `grant: once` (or omit) = a single-fetch allow. Deny = deny.
```
The predicate is evaluated with the tool's input fields as locals (e.g. `command`, `file_path`, `url`, `domain`). Unmatched tools fall to the **permission parity** default (set on the session setup): read-only tools (`Read`, `Glob`, `Grep`) always allow; for everything else, the default `cowork` parity **allows** the unscripted tool but records an `allow-unscripted` audit finding (matching real Cowork, which would have asked a human), while `strict` parity **denies** it (for adversarial tests). **Exception — `webfetch:<domain>`:** real Cowork *gates* a web_fetch provenance miss (it does not auto-allow), so it is carved out of cowork parity and is **fail-closed** unless answered (a scripted rule as above, `web_fetch.approved_domains`, or an LLM/external terminal). A URL you put in the **prompt** is provenanced → fetched with no gate at all.

## Assertions

**What to assert (the model is stochastic — assert the right things).** Scenarios are strongest for
**structural / boundary** checks: `subagent_dispatched`, `dispatch_count_max`, `egress_*`/`expect_denied`,
`file_exists`/`user_visible_artifact`, `no_delete_in_outputs`, `gate_answers_delivered`, `result`. These
test the *shape* of behavior and constraint-respect — robust to LLM phrasing drift, and impossible to test
without actually running the agent. For **content correctness**, match the assertion to the deliverable:
- a skill whose output is **prose** (a markdown report) → `transcript_matches` (a regex, drift-tolerant) or
  `transcript_contains` (a literal, for stable markers). Avoid pinning exact long phrases. `transcript_matches`
  is **case-insensitive**; **single-quote** the regex in YAML (double-quoted YAML eats a backslash, so
  `"\d"` breaks — use `'\d'` or a block scalar); the transcript is one concatenated string, so use `[\s\S]`,
  not `.`, to span turns.
- a skill that emits **structured JSON** → assert it in the **pytest `cowork` lane**
  (`assert_artifact_json(path, lambda d: …)`, a full Python predicate over the parsed object) rather than a
  transcript substring — see "Scenario YAML vs the pytest lane" below.

Each list item under `assert:` is one assertion. An item with **multiple keys is an AND** — it passes only
if *every* key passes (don't rely on the first; keep one concern per item unless you mean conjunction).

| Assertion | Passes when |
|---|---|
| `result: success \| error` | the run ended with that status |
| `transcript_contains: <str>` | the assistant transcript includes the literal string |
| `transcript_not_contains: <str>` | it does not |
| `transcript_matches: <regex>` | the transcript matches the regex (case-insensitive) — fuzzy content for stochastic prose, e.g. `'SOM:?\s*\$[0-9.]+\s*M'` |
| `transcript_not_matches: <regex>` | it does not match (e.g. no leaked stack trace / `undefined`) |
| `file_exists: <path>` | the path exists under the run's `work/` (e.g. `outputs/x.md`) |
| `user_visible_artifact: <path>` | the path exists **and** is under a user-visible prefix (`outputs/`, `.projects/`) — i.e. the deliverable the user actually sees in Cowork |
| `no_delete_in_outputs: true` | no delete op (`rm`/`mv`/…) touched `mnt/outputs` (forbidden in Cowork) |
| `self_heal_ran: <bool>` | a `/sessions/<id>/mnt` plugin script was (not) invoked — the plugin-root self-heal path |
| `tool_called: <Tool>` | the agent invoked the tool |
| `tool_not_called: <Tool>` | the agent never invoked it |
| `subagent_tool_used: <Tool>` | a sub-agent used the tool |
| `subagent_tool_absent: <Tool>` | no sub-agent used the tool |
| `subagent_dispatched: <regex>` | a sub-agent whose `agentType` **or dispatch `description`** matches was dispatched (skills often dispatch with only a `description` and no `subagent_type` → `agentType:"unknown"`, so match by description, e.g. `subagent_dispatched: "TOP_DOWN"`) |
| `subagent_declared_but_unused: <Tool>` | fails if a sub-agent declared the tool but never used **that** tool (even if it used others) — the v0.3.0 fabrication proxy |
| `dispatch_count_max: <N>` | at most N sub-agents were dispatched (real Cowork caps at `{global:3}`; the harness **records** the count and asserts on it but does **not** itself enforce Cowork's skip-on-cap — that enforcement is DEFERRED, see SPEC §10) |
| `question_asked: <regex>` | the agent asked an AskUserQuestion whose text matches |
| `questions_count_max: <N>` | the agent asked at most N questions |
| `gate_answers_delivered: true` | every answered AskUserQuestion gate's answer actually reached the model — requires a positive, observed `tool_result` (an **unobserved** delivery fails too, not only an errored one — no silent false-green) |
| `transcript_no_host_path: true` | no host path (`/Users`, `/opt`) leaked into model-visible text |
| `egress_denied: <host>` | the host was blocked by the egress proxy |
| `egress_allowed: <host>` | the host was allowed through |
| `artifact_json: {…}` | assert over a JSON artifact's contents — see below |

`expect_denied: [host, …]` is shorthand that adds an `egress_denied` assertion per host.

Run **`cowork-harness assert --list`** for this table from the live schema (it can't drift).

#### `artifact_json` — assert structured JSON in YAML

For a skill that emits structured JSON, assert its contents in the scenario lane (no Python needed). A
dotted `path` selects into the document; one operator decides the check:
```yaml
- artifact_json: { artifact: outputs/cap_state.json, path: me.run_id, equals: "r1" }
- artifact_json: { artifact: outputs/cap_state.json, path: rounds.0.amount, gt: 0 }
- artifact_json: { artifact: outputs/instruments.json, path: exclusivity_days, absent: true }   # anti-hallucination
```
Operators: `equals` (deep-equal) · `gt` (number) · `exists: <bool>` · `absent: <bool>` · `is_null: <bool>`.
The three states are **distinct**: `absent` (the final key is missing from a parent that resolved) vs
`is_null` (present but JSON `null`) vs an **unresolved intermediate** segment (the artifact is malformed for
that path) — which **fails loud**, never a vacuous pass. (No JSONPath/jq — a dotted path keeps it
dependency-free and side-effect-free.)

> **Boundary assertions** (`egress_*`, `expect_denied`) require a sandboxed fidelity — `container`, `microvm`, or `hostloop` (all share the container sandbox + egress proxy). Only `protocol` is rejected, to avoid a false pass — see [boundary.md](./boundary.md).

### Which assertions survive `replay` (CI placement)

A cassette (`record`/`replay`) has no filesystem or network. `replay` consumes BOTH recorded protocol
directions — the child→driver `events` stream and the driver→child `controlOut` decision responses —
and re-evaluates the **content** assertions. The authoritative list of content keys is `contentKeys` in
`src/run/cassette.ts`; the table below is derived from it.

**Evaluated on replay (content assertions):**
`transcript_*` (incl. `transcript_matches`), `tool_*`, `subagent_*`, `dispatch_count_max`,
`result`.

**`question_asked`, `questions_count_max`, and `gate_answers_delivered`** are also content
assertions, but they require the cassette to carry `controlOut` (full-fidelity replay). When
`controlOut` is present, the decision pipeline runs on replay and populates `rec.questions` /
`rec.gateDeliveries` — so these three keys are genuinely evaluated.
When `controlOut` is absent (old cassette), a **loud warning** fires and these keys are **excluded**
from evaluation (not vacuously passed). Re-record with a current harness to enable them.

**Filesystem assertions** (`file_exists`, `user_visible_artifact`, `artifact_json`) run on `replay` **when
the cassette carries an artifact manifest** — `record` snapshots `outputs/`/`​.projects/` (paths + hashes +
small JSON bodies) into the cassette, and `replay` materializes that snapshot to evaluate them token-free.
`artifact_json` needs the JSON body inlined (small files); a hash-only (oversized) entry still satisfies
`file_exists` but not `artifact_json`. Without a manifest (older cassettes), they are **skipped** (loud).
A green `replay` re-confirms *record-time* artifacts, **not** that the current skill still produces them —
that needs a live `run` (the cassette's `--strict` staleness fingerprint warns when the skill/baseline drifted).

**Egress + other filesystem** assertions (`no_delete_in_outputs`, `self_heal_ran`,
`transcript_no_host_path`, `egress_*`/`expect_denied`) are still **skipped** on `replay` — they only run on
a live `run`/`record` (token + Docker).

Two consequences for CI:
- Put the **always-on PR gate** on `replay` (token-free) and rely on `transcript_matches`/`transcript_*` +
  `subagent_*` + `question_asked`/`gate_answers_delivered` (with `controlOut`) for content/structure; put
  **filesystem/egress** checks in a **nightly/pre-release live job**.
  Don't assume a `replay`-based PR gate verifies an artifact's *content* — it can't read the file.
- On `replay`, skipped assertions are **absent** from `results[].assertions[]` (filtered before evaluation),
  not present-and-passing — so a CI script must not assume a fixed assertion count across the two lanes.

See [docs/cassette.md](./cassette.md) for the mental model, file shape, and the O7 `replay_protocol_fidelity` guard.

#### Mixed assertions on the replay lane

A multi-key assertion is an **AND** (every key must pass). That has a consequence on `replay`, where the
filesystem/egress keys can't be checked: before evaluating, `replay` **strips each assertion down to only
its content keys**, then drops any assertion left empty. So a mixed item like `{ result: success,
file_exists: outputs/x.md }` is evaluated on replay as `{ result: success }` alone — its `file_exists`
half is removed rather than AND-ed against a value `replay` can't read (which would false-fail). The full
object — every key checkable — is still evaluated on a live `run`/`record`.

Because that strip is silent on its own, `replay` is **loud about it in two classes** (a silent partial
false-green is the cardinal sin):
- **Full skip** — an assertion with no content key at all (pure filesystem/egress, plus every
  `expect_denied` host): a `::warning::` reports how many were skipped (not evaluated on replay).
- **Partial skip** — a **mixed** assertion whose content half *was* evaluated but whose genuine
  filesystem/egress half was dropped: a separate `::warning::` reports the count, so a mixed assertion
  can't quietly green on its content half alone. (Gate keys dropped only because `controlOut` is absent
  are already announced by the `controlOut` warning above and don't count as a partial skip.)

### Scenario YAML vs the pytest `cowork` lane — when to use which

Both run the skill under the real agent and assert; **neither replaces your unit tests** (keep those for
your skill's own scripts). Use **scenario YAML** for portable, declarative regression suites runnable via
`cowork-harness run` with **no Python toolchain** (CI exit code) — structural, boundary, and coarse-content
checks. Use the **pytest `cowork` lane** (`python/`) when you're already writing Python tests (you probably
are) or need a real predicate over a skill's **structured JSON output**:
`r.assert_artifact_json("artifacts/<slug>/sizing.json", lambda d: d["top_down"]["som"]["value"] > 0)` — a
full Python callable with autocomplete and `print(d)`, strictly richer than anything a YAML string can
express. **If you're checking structured JSON content and already write Python, prefer the pytest lambda**
(a YAML content-predicate would be equal power with worse tooling). Find an artifact's real field paths by
running once with `--keep` and inspecting the JSON under the run's `…/mnt/artifacts/…`.

## Output

Each run writes `runs/<name>/<sessionId>/`:

```
events.jsonl      full stream-json (child→driver; also the cassette source)
control-out.jsonl driver→child control_responses (the other cassette half)
run.jsonl         harness log: decisions (+who), sub-agent dispatch tree, egress, transcript, cost
trace.json        structured trace: steps, questions, sub-agents, egress, decisions, cost
egress.log        allow/deny per outbound connection (L1/L2)
result.json       assertion results + decisions + sub-agents + usage + status (incl. workDir/outputsDir)
session.json      session manifest (only when --session-id/--resume is used: id + the agent's session UUID)
```

(`run.jsonl`/`trace.json` replace the old `transcript.json`/`decisions.jsonl`. Secrets are scrubbed
from every persisted log by value.) To read a run's `events.jsonl` as a digest — tool calls, real
sub-agent dispatches (deduped), decisions — run **`cowork-harness trace <run-id | dir> [--tools]`**.
The deliverable a skill produces lands at the `outputsDir` (`…/mnt/outputs`), surfaced by `--keep` and
in the `--output-format json` envelope.

**Terminal output.** `run` is verdict-first and prints the **failing transcript inline** on a `FAIL`;
`--verbose`/`-V` shows the transcript for every scenario, `--quiet` shows only the verdict. `--output-format
json` emits the machine envelope `{tool, version, command, ok, results[], error}` on stdout (one
`RunResult` per scenario; overall pass = `result==="success" && assertions.every(pass)`) — full schema
in [SPEC §11](../SPEC.md). Human output is stderr; stdout stays machine-only under `--output-format json`.

## Running

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml   # one scenario
cowork-harness run examples/scenarios/                    # every *.yaml in the dir
```
Exit code is non-zero if any assertion fails or the run errors — CI-ready. (In your own skill repo
you'd keep these at the root, e.g. `run scenarios/`; the harness ships them under `examples/`.)

### Dry-running a decider (`decide`)

`cowork-harness decide` validates a decider against a **sample question in ~2s, with no run** — so you
don't discover a wire-protocol bug or a non-matching regex twelve minutes into a live skill. It builds one
synthetic `AskUserQuestion` and feeds it to whichever decider you point at: `--answer "<rx>=<choice>"` /
`--answer-policy <yaml>` (scripted rules — reports which rule matched, or exits non-zero if none did),
`--decider-cmd '<helper>'` (shows the exact request the helper received and its answer), or `--decider-llm`
(a live model answers; flagged non-deterministic). Override the prompt with `--question` and repeat
`--option` to set the choices.

```bash
# Does my answer-policy actually answer the gate I think it does?
cowork-harness decide \
  --question "Which output format do you want?" \
  --option Markdown --option PDF \
  --answer-policy examples/answer-policies/demo.yaml
# ✓ rule matched: "Which output format do you want?" → "Markdown"
```

### Shipped examples to read

The repo ships runnable scenarios you can copy from, under [`examples/`](../examples/) — each pairs with an `examples/sessions/*.yaml` and, for the skills, a folder under `examples/skills/`. (The harness's own fidelity self-tests live separately in `e2e/`.)

| Scenario | Shows |
|---|---|
| `examples/scenarios/example-pdf-skill.yaml` | the minimal shape — prompt + scripted answers + assertions (placeholder skill; harness plumbing only) |
| `examples/scenarios/csv-metrics.yaml` | a non-trivial skill running a **bundled producer** end-to-end, writing a structured `outputs/metrics.json` + a `summary.md` (paired with `python/test_csv_metrics_lane.py` for a JSON-content predicate) |
| `examples/scenarios/csv-fx-normalize.yaml` | **graceful degradation** under default-deny egress — the skill's real network step is blocked, so `egress_denied` is backed by genuine behavior and the skill falls back instead of crashing |
| `examples/scenarios/skill-loads.yaml` | an acceptance check that a local skill loads and the python toolchain is present |

## The `microvm` tier — `vm init` prerequisites & troubleshooting

The `microvm` (L2) tier runs the agent inside an **Apple Virtualization.framework microVM via Lima**
(`vmType: vz`) — the same hypervisor class as Cowork — for VM-grade filesystem/escape isolation. Egress is
**not** gVisor: the guest gets a default-deny **iptables** firewall (allow loopback + DNS + the host
gateway only) that funnels all traffic to the **same allowlist proxy as the `container` tier**, so L2's
network transport equals L1's. Reach for it for escape isolation of untrusted code, not for better network
fidelity.

**Prerequisites:**
- **macOS on arm64 (Apple silicon).** The generated Lima config pins `vmType: vz`, `arch: aarch64`, and an
  arm64 Ubuntu 24.04 cloud image — there is no x86 path.
- **Lima installed.** The harness invokes `limactl` at `/opt/homebrew/bin/limactl` (Homebrew default);
  `brew install lima`. Override the binary path with `COWORK_LIMACTL` if it lives elsewhere.

**Lifecycle.** Boot (or reuse) the VM once, then run scenarios at the tier:

```bash
cowork-harness vm init            # boot the L2 VM for the current config (slow first time)
cowork-harness vm status          # show the instance and its state
cowork-harness run my-scenario.yaml   # the tier comes from the scenario's `fidelity: microvm` field, NOT a flag
cowork-harness vm delete          # stop + remove this config's VM
cowork-harness vm prune           # remove orphaned cowork-vm-* VMs from past configs
```

The instance name is `cowork-vm-<config-hash>` — derived from a hash of the full Lima config (mounts,
image, staged agent version). A config or agent-version change yields a **new** name, so a stale VM is
never silently reused; the old one is orphaned until `vm prune` (or `limactl delete`). Pin a fixed name
with `COWORK_LIMA_INSTANCE`.

**Troubleshooting:**
- **`limactl … failed` / binary not found** — Lima isn't installed or isn't at the expected path. Install
  it (`brew install lima`) or set `COWORK_LIMACTL` to the real `limactl`.
- **A run errors with "not mounted — VM not provisioned for this harness config"** — the VM predates a
  config change (its mounts don't match). Recreate it: `cowork-harness vm delete && cowork-harness vm init`.
- **Egress allowed/denied looks wrong** — the guest firewall and the proxy URL must point at the same
  gateway. The default Apple-VZ user-network gateway is `192.168.5.2`; override with `COWORK_VM_GATEWAY`,
  and the proxy port (default `8899`) with `COWORK_VM_PROXY_PORT`. The harness threads one resolved
  gateway value into both the iptables allow rule and the agent's `HTTP(S)_PROXY`, so set the env var
  rather than editing one side.

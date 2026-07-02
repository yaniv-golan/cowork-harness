# Scenario reference

A **scenario** (`scenarios/*.yaml`) is one test: a prompt, scripted answers to the agent's questions/permission requests, and assertions. It references a [session setup](./session.md) for the setup.

**Minimal scenario** — `prompt` is the only required field; everything else has defaults:

```yaml
prompt: "Use the my-skill skill to do X."
assert:
  - result: success
```

The full schema below documents every optional field.

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

skills: [report-gen]                     # OPTIONAL — scope cassette-staleness hash to these skills only
                                         # (each is a `skills/<name>` dir under a mounted plugin-root);
                                         # fail-closed to whole-tree on an unknown name. Omit = whole tree.

requires_capabilities: [pdf]             # OPTIONAL — capability families the skill needs (a scenario FIELD,
                                         # not an assert key); a tier missing one fails unless allow_missing_capability

allow_host_writes: true                  # OPTIONAL — required consent to run `hostloop` with a WRITABLE
                                         # connected folder (session `folders:` mode rw/rwd): the native
                                         # agent process gets genuine host filesystem access there, gated
                                         # only by a software check, not a container/VM wall. See below.

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
| `hostloop` | host-loop: the agent LOOP is a native process spawned directly on the host (no container around the file tools — matching production); shell/web tool calls route host-side into a Docker VM sidecar via the workspace SDK-MCP server (`mcp__workspace__bash`) | reproduce Cowork's **production** split-execution model |
| `cowork` | auto-picks `hostloop` vs `container` the way Cowork itself does (gate `1143815894`, decoded from the synced baseline) | "do what real Cowork does for this release" |

`hostloop`/`cowork` are the production-faithful path (see [DESIGN.md](../DESIGN.md)); `container` is the
practical default. Boundary assertions are enforced at `container`, `microvm`, `hostloop`, and `cowork`
(`cowork` auto-resolves to a sandboxed tier — `hostloop` or `container` — never `protocol`).

**`hostloop` with a writable connected folder needs `allow_host_writes: true`.** With no container around
the native file tools, a `mode: rw`/`rwd` folder (see [session.md](./session.md)) gives the agent genuine,
software-checked-only host filesystem access at this tier — the scenario refuses to run (loud, before any
spawn) without this explicit opt-in. Read-only folders and folder-less/scratch `hostloop` runs need no
opt-in. See [boundary.md](./boundary.md) for the full safety posture.

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

> **For large unattended batches, script the stable gates.** A pure live decider re-asks the model
> once per gate; across a back-to-back batch that is more wall-clock, more paid calls, and more exposure to
> a transient `claude -p` exit (now bounded-retried, but not free). For unattended multi-doc completion
> prefer scripted `--answer` / `--answer-policy` on the gates you can name, and keep `--decider-llm` for
> exploration. **Also script any gate whose answer feeds a *semantic* assertion:** a decided answer can be a
> confident guess — the decider sees only the transcript tail, not the mounted documents, so it can get a
> doc-answerable fact wrong (a stronger model included) — and a green run resting on it is a false pass.
> The partial run on a stall already echoes the gate + numbered options — paste them straight into `--answer`.

> **Where scripted answers hold up — and where they don't.** The `when_question` regex absorbs *wording*
> drift (an LLM phrases "confirm the stage" many ways), so scripting is robust for skills whose gates are
> structurally stable (the gate reliably appears). It does NOT cover *structural* stochasticity — a skill
> that decides run-to-run *whether* or *which* to ask: there, `on_unanswered: fail` will hard-error on a
> gate it didn't anticipate (correct, but flaky for that skill). For that case answer live instead —
> `--decider-llm` (a model answers, run flagged non-deterministic) or `--decider-dir` (you answer in-band)
> — accepting the run is then no longer a deterministic regression.
>
> **Stochastic option *labels* (distinct from stochastic *structure*).** If a skill regenerates both the
> question wording *and* the option labels each run, you can still pin the gate **deterministically** —
> anchor on a stable **leading substring** of the label, or on **position**:
>
> - `choose:` (and `--answer`) accept a **stable partial anchor** — a leading substring bound to whichever
>   single option *starts with it at a word boundary* (the label's next char, after optional whitespace, is
>   one of `:` `(` `,` `—` `–` or end-of-label; a `/` or a bare space does **not** count, so `Seed` won't
>   match `Seed / AI/ML`). `choose: "Israeli company"` binds `"Israeli company (IL only)"`; `choose: "2
>   founders"` binds `"2 founders, ~5M each"`. It is **uniqueness-guarded**: if the anchor matches two
>   options — or none — it **fails loud** (the error lists the offered options), never a silent mis-pick.
>   **Prefer this over a positional index** when the leading text is stable: it rides label drift *and*
>   survives option **re-ordering** (it matches content, not slot).
> - `choose:` also accepts a **1-based index** (`choose: "2"` selects the second option), which survives
>   *fully* regenerated labels — the fallback when even the leading text drifts. (Index applies only when
>   `choose` is *entirely* digits; a pure-digit option *label* collides with index semantics — use
>   `answer:` for that rare gate.)
> - `when_question: ".*"` is a catch-all that matches any phrasing.
>
> So `when_question: ".*"` + `choose: "2"` pins a gate whose wording and labels both drift, with no live
> decider — **but only when the option *order* is stable.** A positional `choose` is robust to label drift,
> NOT to option *re-ordering*: if the gate can present its options in a different order run-to-run, the index
> lands on a different option (a silent re-record flake; `lint` flags positional `choose` with an advisory).
> Escalate only as far as you must: an **exact label** (`choose: "<label>"`) when labels are stable → a
> **partial anchor** (above) when only the label's tail drifts (robust to re-ordering) → a **positional
> index** only when even the leading text regenerates and the option order holds. **Caveat:** rules are evaluated in order and the *first* matching `when_question` wins, so `.*`
> answers *any* gate — use it only as a **last-resort fallback for a single expected gate per turn**, and
> always place it *after* more-specific rules. This covers stochastic *labels*; it does **not** cover
> structural stochasticity (whether/which gate appears), which still needs a live decider as above.

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
- when_question: ".*"                            # catch-all — LAST, after specific rules; single gate/turn
  choose: "2"                                    # 1-based position — survives regenerated option labels
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
  - **Use it only for stable lexical markers** — a number format, a header, a literal token the skill always
    emits. **Do NOT use it to assert semantic content the model paraphrases** ("the skill flagged the blank
    field"): a regex pinned to one phrasing passes on one record and fails on a re-record when the model
    rewords it, even though the behavior is identical (a re-record flake). If the fact also lands in a
    structured artifact, assert *that* field instead (next bullet) — it's phrasing-independent.
- a skill that emits **structured JSON** → assert it directly in the scenario YAML with **`artifact_json`**
  (a dotted `path` + an operator — no Python; see below). Reach for the **pytest `cowork` lane**
  (`assert_artifact_json(path, lambda d: …)`, a full Python predicate over the parsed object) only when the
  check is too complex for a dotted path + single operator. Either way, prefer a structured-field assert over
  a transcript substring for anything the skill writes to an artifact.
- a skill whose output is a **written file** (a report, a deliverable on disk) → `user_visible_artifact: <path>`,
  **not** `file_exists`, for the user-facing deliverable. When the session connects a folder, the deliverable
  lands in `mnt/<folder>` (that folder is `{{workspaceFolder}}`), **not** `mnt/outputs` — so a model told to
  write "outputs/foo" writes `mnt/<folder>/outputs/foo`. `user_visible_artifact` spans both visible roots
  (`outputs/` + each connected folder), while `file_exists` only checks `mnt/<path>` and does not check
  folder-relative deliverables. Reserve `file_exists` for a known fixed sandbox path (e.g. a folder-less session
  where `{{workspaceFolder}} = mnt/outputs`).

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
| `user_visible_artifact: <path>` | the path exists **and** is under a user-visible root (`outputs/` + each connected folder's mount name) — i.e. the deliverable the user actually sees in Cowork |
| `no_delete_in_outputs: true` | no delete op (`rm`/`mv`/…) touched `mnt/outputs` (forbidden in Cowork) — **only `true` is valid**; writing `false` is rejected by the schema (omit the key entirely to allow deletes in the test) |
| `self_heal_ran: <bool>` | a `/sessions/<id>/mnt` plugin script was (not) invoked — the plugin-root self-heal path |
| `tool_called: <Tool>` | the agent invoked the tool |
| `tool_not_called: <Tool>` | the agent never invoked it |
| `tool_result_contains: <str>` | a tool result includes the literal string (content / replay-checkable — substring match, **per individual result**, each scanned up to a 10 KB cap; a string spanning two separate results won't match) |
| `tool_result_not_contains: <str>` | no tool result includes the literal string — content / replay-checkable; **fails loud** if tool results are absent from `result.json` (absent ≠ empty) or display-truncated (no assertable text) — it never vacuously passes when it can't see the evidence |
| `subagent_tool_used: <Tool>` | a sub-agent used the tool |
| `subagent_tool_absent: <Tool>` | no sub-agent used the tool |
| `subagent_dispatched: <regex>` | a sub-agent whose `agentType` **or dispatch `description`** matches was dispatched (skills often dispatch with only a `description` and no `subagent_type` → `agentType:"unknown"`, so match by description, e.g. `subagent_dispatched: "TOP_DOWN"`) |
| `subagent_declared_but_unused: <Tool>` | fails if a sub-agent declared the tool but never used **that** tool (even if it used others) — the v0.3.0 fabrication proxy |
| `dispatch_count_max: <N>` | at most N sub-agents were dispatched (real Cowork caps at `{perTask:1, global:3}`; the harness **records** the count and asserts on it but does **not** itself enforce Cowork's skip-on-cap — that enforcement is DEFERRED, see SPEC §10) |
| `question_asked: <regex>` | the agent asked an AskUserQuestion whose text matches |
| `questions_count_max: <N>` | the agent asked at most N questions |
| `gate_answers_delivered: true` | every answered AskUserQuestion gate's answer actually reached the model — requires a positive, observed `tool_result` (an **unobserved** delivery fails too, not only an errored one — no silent false-green) |
| `gate_answers_delivered: false` | asserts that at least one answered gate's answer was **confirmed not delivered** (an observed delivery failure); an unobserved/null delivery does **not** satisfy this — useful for negative-path tests of delivery failures |
| `allow_permissive_auto_allow: true` | verdict modifier — suppresses the default-fail when the run recorded a cowork-parity permissive auto-allow; use this for tests that **deliberately** assert Cowork's permissive behavior rather than strict scripted coverage |
| `allow_missing_capability: true` | verdict modifier (**live tiers only**) — suppresses the default-fail when the lean/`core` agent image omits a capability the skill used but real Cowork ships (OCR/LibreOffice/markitdown/opencv/PDF-tables); assert only when the skill's fallback is genuinely equivalent, else rebuild full parity (`--build-arg COWORK_FULL_PARITY=1`). Also opts out of the `requires_capabilities` declared-need check below. |
| `allow_l0_plugin_divergence: true` | verdict modifier — opts into L0/protocol plugin divergence, suppressing the plugin-fidelity default-fail |
| `allow_stall: true` | verdict modifier — suppresses the default-fail when a run ends on a question having done no productive tool work after its last gate (the agent asked for input and stopped — incl. re-asking in plain text *after* answering an `AskUserQuestion`); assert only when ending on a question is the intended terminal state, otherwise script the answer (`answer:` / `--answer` / a decider) |
| `transcript_no_host_path: true` | no host path (`/Users/`, `/opt/cowork/`, `/home/`, `/root/`) leaked into model-visible text — **incompatible with `hostloop`**: its native file tools legitimately expose real host paths (that's the tier's whole point), so this assertion fails BY DESIGN there (the harness warns loud at run start if you assert it anyway); use `container`/`microvm` for this check |
| `egress_denied: <host>` | the host was blocked by the egress proxy |
| `egress_allowed: <host>` | the host was allowed through |
| `artifact_json: {…}` | assert over a JSON artifact's contents — see below |

`expect_denied: [host, …]` is shorthand that adds an `egress_denied` assertion per host.

### Declaring required capabilities (`requires_capabilities`)

A scenario-level `requires_capabilities: [<family>, …]` declares the capability families the skill's core
path **needs** (e.g. `office_convert`, `ocr`, `pdf_tables`, `ml_extract`, `cv`, `magick`). The run
**hard-fails** if the running tier:

- **omits** a declared family (the lean `core` image lacks it), or
- **cannot verify** it — `protocol`/`replay` or `COWORK_SKIP_CAPABILITY_PROBE=1`, where no live probe runs.

This closes the false-green for extraction-heavy skills: a PDF/Excel-ingestion skill that silently fell back
to manual parsing on a tier without the deps now fails loudly instead of passing. Unlike the *use*-detection
fail (which catches an omitted family the skill was observed using), this is a *declared-need* check, so it
fires even when the skill's fallback masks the gap. The check is computed at run time and persisted, so
`verify-run`/`replay` honor the recorded outcome — a clean full-parity run records nothing and never
false-fails later. Opt out with `allow_missing_capability: true` when the fallback is genuinely equivalent.

When `requires_capabilities` is declared, the harness probes the image **before** driving and, if a declared
family is omitted, **fails fast — it aborts the run (exit 3) before spending a single token**, instead of
running ~12 min to a post-run hard-fail that's already known. Rebuild full parity
(`--build-arg COWORK_FULL_PARITY=1`) and point `COWORK_AGENT_IMAGE` at it, or assert
`allow_missing_capability: true` (which downgrades the abort to a notice and proceeds, same as it opts out of
the post-run check).

```yaml
requires_capabilities: [office_convert, pdf_tables]   # fail unless the tier provides (and can verify) these
```

Run **`cowork-harness assertions --list`** for the authoritative *assertion* set from the live schema (it
can't drift) — that list covers `assert:` keys only, so the scenario *fields* that also appear above
(`expect_denied`, `requires_capabilities`) are not in it.

`replay_protocol_fidelity` is replay-synthesized and **not** authorable in a scenario — writing it
errors at load. See [docs/cassette.md](./cassette.md) for the O7 guard.

#### Verdict signals

Beyond pass/fail assertions, a run can surface **verdict signals** in `result.signals` — non-fatal
observations that nuance the verdict rather than flip it:

- `prompt_asset_missing` (**warn**) — the run proceeded with a missing prompt asset (e.g.
  `COWORK_HARNESS_ALLOW_MISSING_PROMPT=1`); fidelity is degraded (the agent ran, but not against the full
  faithful prompt surface).

See the skill reference [`scenario-schema.md`](../.claude/skills/cowork-harness/references/scenario-schema.md) for the full signal list.

#### `artifact_json` — assert structured JSON in YAML

For a skill that emits structured JSON, assert its contents in the scenario lane (no Python needed). A
dotted `path` selects into the document; one operator decides the check:
```yaml
- artifact_json: { artifact: outputs/cap_state.json, path: me.run_id, equals: "r1" }
- artifact_json: { artifact: outputs/cap_state.json, path: rounds.0.amount, gt: 0 }
- artifact_json: { artifact: outputs/instruments.json, path: exclusivity_days, absent: true }   # anti-hallucination
- artifact_json: { artifact: outputs/cap_state.json, path: stage, in: ["seed", "series-a"] }     # one of a stable set
```
Operators: `equals` (deep-equal) · `in: [<set>]` (deep-equal one of) · `gt` (number) · `exists: <bool>` · `absent: <bool>` · `is_null: <bool>`. **Omit every operator** to assert only that the `path` resolves (a bare existence check).
The three states are **distinct**: `absent` (the final key is missing from a parent that resolved) vs
`is_null` (present but JSON `null`) vs an **unresolved intermediate** segment (the artifact is malformed for
that path) — which **fails loud**, never a vacuous pass. (No JSONPath/jq — a dotted path keeps it
dependency-free and side-effect-free.)

> **`is_null: false` requires the path to be present.** If the path is absent, `is_null: false` fails loud
> (rather than vacuously passing). To assert "exists and is not null" write `exists: true` on one line and
> `is_null: false` on another. Use `absent: true` to assert the key does not exist at all.

> **Stable vs brittle asserts on stochastic (LLM-extracted) values.** A cassette freezes ONE stochastic
> output, so an `equals` on an LLM-extracted string will churn every time you re-record. Prefer **stable**
> operators for extracted values: `absent` / `exists` (the anti-hallucination negative is rock-stable),
> or `in: [<set>]` to accept any of a known-good set. Reserve `equals` for values the skill computes
> deterministically (ids, counts, enums). This pairs with record-time redaction: redaction rewrites the
> very strings an `equals` would pin, so `equals` on a redacted field would break on re-record anyway.

> **Boundary assertions** (`egress_*`, `expect_denied`) require a sandboxed fidelity — `container`, `microvm`, `hostloop`, or `cowork`. `container`'s and `hostloop`'s `bash` share the same Docker sandbox + egress proxy (though `hostloop`'s native file tools run with no container at all — see [boundary.md](./boundary.md)); `microvm` enforces the **same allowlist** inside a real Lima/Apple-VZ VM via a guest iptables firewall; `cowork` resolves to `hostloop` or `container`. Only `protocol` is rejected, to avoid a false pass — see [boundary.md](./boundary.md).

### Which assertions survive `replay` (CI placement)

A cassette (`record`/`replay`) has no filesystem or network. `replay` consumes BOTH recorded protocol
directions — the child→driver `events` stream and the driver→child `controlOut` decision responses —
and re-evaluates the **content** assertions. The authoritative list of content keys is `contentKeys` in
`src/run/cassette.ts`; the table below is derived from it.

**Evaluated on replay (content assertions):**
`transcript_*` (incl. `transcript_matches`), `tool_*`, `subagent_*`, `dispatch_count_max`,
`result`, and the verdict modifiers `allow_permissive_auto_allow` / `allow_missing_capability` /
`allow_l0_plugin_divergence` / `allow_stall` (kept on replay as no-op passes).

**`question_asked`, `questions_count_max`, and `gate_answers_delivered`** are also content
assertions, but they require the cassette to carry `controlOut` (full-fidelity replay). When
`controlOut` is present, the decision pipeline runs on replay and populates `rec.questions` /
`rec.gateDeliveries` — so these three keys are genuinely evaluated.
When `controlOut` is absent (old cassette), a **loud warning** fires and these keys are **excluded**
from evaluation (not vacuously passed). Re-record with a current harness to enable them.

**Filesystem assertions** (`file_exists`, `user_visible_artifact`, `artifact_json`) run on `replay` **when
the cassette carries an artifact manifest** — `record` snapshots `outputs/` + connected folders (paths + hashes +
small JSON bodies) into the cassette, and `replay` materializes that snapshot to evaluate them token-free.
`artifact_json` needs the JSON body inlined (small files); a hash-only (oversized) entry still satisfies
`file_exists` but not `artifact_json`. Without a manifest (older cassettes), they are **skipped** (loud).
A green `replay` re-confirms *record-time* artifacts, **not** that the current skill still produces them —
that needs a live `run` (the cassette's staleness fingerprint warns when the skill/baseline drifted; `replay
--strict` fails on any drift, `--fail-on-skill-drift` on skill-source drift only, and every result reports it
in `staleness[]` for a JSON gate).

**Egress + other filesystem** assertions (`no_delete_in_outputs`, `self_heal_ran`,
`transcript_no_host_path`, `egress_*`/`expect_denied`) are still **skipped** on `replay` — they only run on
a live `run`/`record` (token + Docker).

Two consequences for CI:
- Put the **always-on PR gate** on `replay` (token-free) and rely on `transcript_matches`/`transcript_*` +
  `subagent_*` + `question_asked`/`gate_answers_delivered` (with `controlOut`) for content/structure; put
  **filesystem/egress** checks in a **nightly/pre-release live job**.
  A `replay`-based PR gate verifies artifact *content* only when the cassette carries an artifact
  manifest (small inlined bodies, via `artifact_json`); without one it can't read the file, and
  oversized/hash-only entries satisfy `file_exists` but not `artifact_json`.
- On `replay`, skipped assertions are **absent** from `results[].assertions[]` (filtered before evaluation),
  not present-and-passing — so a CI script must not assume a fixed assertion count across the two lanes.

#### Where `replay` reads `assert:` from — frozen by default, on-disk by opt-in

By default `replay` evaluates the assertions **frozen inside the cassette** (the copy `record` captured), so a
plain `replay` is byte-deterministic and independent of the working tree — editing `scenarios/<name>.yaml`'s
`assert:` does **not** change a default replay. To keep that from being a *silent* trap, when a sibling
scenario resolves and its `assert:` differs from the frozen copy, replay prints a `::notice::` pointing at the
opt-in flag.

`--assert-from <scenario.yaml>` (explicit) / `--reassert` (auto-resolve the sibling) re-check the cassette
against the **on-disk** `assert:` (+`expect_denied:`) — the token-free "edit the assert, re-check without a
paid re-record" loop. Because re-asserting against frozen events is only sound if the recording still
corresponds to the scenario, this path is safe by construction:
- **Recording-shaping drift hard-fails** — if `prompt`, `answers`, `baseline`, `fidelity`, `skills`, or
  `requires_capabilities` differ from the recording, replay refuses (re-record instead).
- **The `session` is NOT verified** — it's excluded from the drift check (stored relative in the cassette,
  resolves absolute on disk) and is **not fingerprinted**, so a change to the **model**, data mounts, or
  discovery in the session between record and re-assert is **undetected**. The notice says so; re-record if the
  session changed. (Skill *content* under the session IS guarded — next bullet.)
- **Skill-content staleness hard-fails** on this path (it implies `--fail-on-skill-drift`), so an edited assert
  can't green against a skill that no longer produces the frozen events.
- **Sourcing ≠ evaluation:** `expect_denied` and the filesystem/egress keys are read from the on-disk block but
  stay **live-only** on replay — editing them re-checks nothing here (replay warns when you do). Use a live
  `run` to check egress/filesystem.

See [docs/cassette.md](./cassette.md) for the mental model, file shape, and the O7 `replay_protocol_fidelity` guard.

#### Mixed assertions on the replay lane

A multi-key assertion is an **AND** (every key must pass). That has a consequence on `replay`, where the
filesystem/egress keys can't be checked: before evaluating, `replay` **strips each assertion down to only
its content keys**, then drops any assertion left empty. So a mixed item like `{ result: success,
egress_denied: evil.com }` is evaluated on replay as `{ result: success }` alone — its `egress_denied`
half is removed rather than AND-ed against a value `replay` can't observe (which would false-fail).
(With an artifact manifest, `file_exists`/`user_visible_artifact`/`artifact_json` are **not** dropped —
they're replay-checkable; only the genuinely live-only keys above are stripped.) The full object —
every key checkable — is still evaluated on a live `run`/`record`.

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
running once with `--keep`, then `cowork-harness inspect <run-dir>` (a shallow field preview of each JSON
artifact) or by reading the JSON under the run's `…/mnt/outputs/…` directly.

## Output

Each run writes to `~/.cowork-harness/runs/<name>/<sessionId>/` (relocate with `--run-dir <path>` or `COWORK_HARNESS_RUNS_DIR`):

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
sub-agent dispatches (deduped), decisions — run **`cowork-harness trace <run-id | dir> [--view tools]`**.
The deliverable a skill produces lands at the `outputsDir` (`…/mnt/outputs`), surfaced by `--keep` and
in the `--output-format json` envelope.

**Terminal output.** `run` is verdict-first and prints the **failing transcript inline** on a `FAIL`;
`--verbose`/`-V` shows the transcript for every scenario, `--quiet` shows only the verdict. `--output-format
json` emits the machine envelope `{tool, version, command, ok, results[], error}` on stdout (one
`RunResult` per scenario; overall pass = `result==="success" && assertions.every(pass)` **AND a clean
`computeVerdict`** — a verdict signal like `stalled` (ended on a question with no productive work after its last gate), `transport_error`, or a
missing-capability/boundary signal can still fail a run whose `result` is `success` and whose assertions all
pass, unless the matching `allow_*` modifier is asserted) — full schema
in [SPEC §11](../SPEC.md). Human output is stderr; stdout stays machine-only under `--output-format json`.

## Running

```bash
cowork-harness run examples/scenarios/csv-metrics.yaml   # one scenario
cowork-harness run examples/scenarios/                    # every *.yaml in the dir
```
Exit code is non-zero if any assertion fails or the run errors — CI-ready. (In your own skill repo
you'd keep these at the root, e.g. `run scenarios/`; the harness ships them under `examples/`.)

Already have a run you like the shape of? `cowork-harness scaffold <run-id | run-dir>` turns a **kept**
run (`--keep`, or a `--session-id` run) into a starter scenario YAML — auto-filled from what it observed
(gates→answers, artifacts→file_exists) — instead of copying an existing example by hand and editing it to
match. Prints to stdout by default; add `--out <file.yaml>` to write it straight to `scenarios/`. Review
and tighten the generated `when_question` regexes before committing.

### Dry-running a decider (`decide`)

`cowork-harness decide` validates a decider against a **sample question in ~2s, with no run** — so you
don't discover a wire-protocol bug or a non-matching regex twelve minutes into a live skill. It builds one
synthetic `AskUserQuestion` and feeds it to whichever decider you point at: `--answer "<rx>=<choice>"` /
`--answer-policy <yaml>` (scripted rules — reports which rule matched, or exits non-zero if none did),
`--decider-cmd '<helper>'` (shows the exact request the helper received and its answer), or `--decider-llm`
(a live model answers; flagged non-deterministic). Override the prompt with `--question` and repeat
`--option` to set the choices. `decide` does **not** accept `--decider-dir` (the file-rendezvous channel
is a live-run concern) — passing it is a hard usage error (exit 2). The synthetic gate is **single-select
only** (there is no multiSelect flag), so the printed request shows `options[].label` but never
`multiSelect:true` — to exercise a helper's array reply path, run a real multiSelect gate or unit-test
the helper directly.

```bash
# Does my answer-policy actually answer the gate I think it does?
cowork-harness decide \
  --question "Which output format do you want?" \
  --option Markdown --option PDF \
  --answer-policy examples/answer-policies/demo.yaml
# ✓ rule matched: "Which output format do you want?" → "Markdown"
```

### Re-checking assertions without a re-record (`verify-run`)

When an assertion is wrong (a typo, the wrong path, an over-pinned regex) but the *run* itself was fine, you
don't need a fresh live run to fix it. `cowork-harness verify-run <run-dir> <scenario.yaml>` re-evaluates the
scenario's `assert:` block against an already-kept run dir — **no live agent, no tokens, no Docker** — in about
a second:

```bash
cowork-harness skill ~/my-plugin "..." --keep            # prints the run dir
cowork-harness verify-run ~/.cowork-harness/runs/<scenario>/<sessionId>/ my-scenario.yaml
# ✗ verify-run: 1/3 assertion(s) failed  → fix the assertion, re-run verify-run, repeat
```

It reconstructs the assert context (transcript, tool calls, egress, artifacts, questions) from the run's
persisted `result.json` + sidecars and uses the **same verdict path as a live record**. Two limits: it needs a
**kept** run dir (`--keep`, or a `--session-id` run), and filesystem assertions (`file_exists` /
`user_visible_artifact` / `artifact_json`) need the run's work dir still on disk — if it has been torn down,
`verify-run` refuses rather than reporting a false failure.

**Answer-coverage (when the scenario declares `answers:`).** The check is **gate-centric**: verify-run
confirms that **every gate the run actually fired** (parsed from the kept run's `events.jsonl`, which retains
the offered option labels) is covered by a matching `answer`, and that the answer's `choose:` named an option
the gate actually offered. It does **not** penalize answer rules that no fired gate matched — e.g. rules for
*conditional* gates that didn't fire this run. So a scenario with 5 answer rules whose run fired only 2 gates
passes at "2/2 gates matched". A **failure** means a *fired* gate had no matching answer, or a matched answer's
`choose:` named an option the run never offered (the model reworded the gate) — surfacing the drift in ~1s
instead of on a paid re-record. This **changes the exit-code contract**: a run that is green on `assert:` can
now exit `1` on such a mismatch. If the scenario declares answers but the kept run dir has no `events.jsonl`,
verify-run **refuses** (exit `2`, "can't verify ⇒ not green") rather than vacuously passing.
A scenario with no `answers:` is unaffected (assert-only, exactly as before). Scenarios using
`on_unanswered: first`/`llm` treat an unmatched gate as an acceptable auto-answer, not a failure.

**Currency — the kept run must be current vs the skill.** Answer-coverage validates against the kept run's
gate **snapshot** (its `events.jsonl`). If the skill changed *after* the run was kept — e.g. you reworded a
gate or moved its options — those recorded gates are stale, and a green here would be false confidence. Every
run persists a skill fingerprint in `result.json`; on the answer-coverage path `verify-run` recomputes it live
and, if the skill source drifted, **refuses** (exit `2`, "the kept run predates the current skill") instead of
vouching against stale labels — re-`--keep` a fresh run (or re-record). The plain `assert:`-only re-eval (no
`answers:`) is unaffected. A kept run recorded by an older harness (no fingerprint) → a warning, not a refusal.

> **The cheapest authoring loop:** `--keep` ONE run, then `trace --view questions` / `verify-run` read the
> gates + offered labels out of that run's `events.jsonl` for free — fix your `answers:` without re-paying for
> a record. Just re-`--keep` after a skill change that moves gate phrasing (per the currency rule above). A
> mismatched `choose:` is reported with the **offered options** so you can fix the anchor from the error alone.

### Debugging with `chat`

> See [chat.md](./chat.md) for the full `chat` reference and flags.

`cowork-harness chat <skill-folder>` is an interactive multi-turn REPL for **hand-debugging** a skill under
the runtime — reach for it to reproduce a gate/permission flow interactively, poke a stochastic multi-turn
skill, or explore before authoring a scenario. It is *not* an asserted test (that's `run`); it's the
exploratory loop.

- **Gates are answered interactively at the TTY** — `chat` carries no scripted `answers:`; an unscripted
  AskUserQuestion / permission request prompts you in the terminal.
- **It always writes a transcript** under `runs/chat/<sessionId>` (there is no `--keep` flag); inspect it
  afterward with `cowork-harness trace <dir>`. Exit with `/exit` or `/quit`.
- **Use plain `chat`, not `chat --raw`, for faithful debugging.** `--raw` is a native `docker run -it`
  session with **no egress sandbox** — convenient, but it does *not* reproduce Cowork's default-deny network,
  so behavior there isn't representative.
- **`chat` does not support `--session-id` / `--resume`** (those are `skill`-only; chat mints a throwaway
  session) — for checkpoint/resume debugging use `skill … --session-id … --resume`.
- **Promote a finding to a scenario to make it deterministic.** `chat` is live/non-deterministic and —
  unlike `skill`/`run` — prints no copy-pasteable `--answer` footer. Once you've reproduced a flow, re-express
  it as a `scenarios/*.yaml` with scripted `answers:` so it becomes a repeatable regression.

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

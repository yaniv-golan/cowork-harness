# Gotchas

Tracks `cowork-harness 4.2.1` (baseline `desktop-2.19675.0`). The full "✓ passed ≠ correct" landmine catalog.

## Gotchas — the "✓ passed ≠ correct" landmines

Stated as *symptom → why → fix*. This is the **workflow/record/answer-path** view — the broader of the
two lists, but **not a strict superset**: `references/scenario-schema.md`'s *Authoring gotcha list*
carries a few assertion-level landmines this one omits (`transcript_no_host_path`'s scan width,
`egress.extra_allow`'s no-op on the provenanced `web_fetch` path, `replay_protocol_fidelity` not being
authorable). Reach for this list when debugging a run's behavior, that one while authoring `assert:`.
**The two lists are numbered independently** — a bare "gotcha N" means the list you are reading.

1. **An assertion passed but tested nothing on the PR gate.** *Why:* on a manifest-less cassette
   `replay` skips filesystem/egress keys (`file_exists`, `user_visible_artifact`, `artifact_json`,
   `artifact_text`, `egress_*`, `no_delete_in_outputs`, `self_heal_ran`, `transcript_no_host_path`); a
   *mixed* item like
   `{result, egress_denied}` greens on `result` while its `egress_denied` half is dropped. (`record`
   snapshots an `artifacts` manifest, which makes
   `file_exists`/`user_visible_artifact`/`artifact_json`/`artifact_text`/`computer_links_resolve`
   replay-checkable — but the live-only egress keys stay skipped, and `file_absent` is never
   replay-checkable at all: proving absence needs an exhaustive, healthy walk a manifest does not record.) *Fix:* put egress/live-only checks on
   a live gate; keep one concern per `assert:` item; run the linter. The harness warns loudly on skip.

2. **A steered gate answer never reached the model.** *Why:* `serializeDecision` must emit
   `updatedInput: { questions, answers }`; a header-only gate (empty `question`) can never be keyed.
   *Fix:* give every gate a non-empty `question`. (multiSelect gates ARE supported on **every** answer
   channel: scripted `choose:` list, in-band `--decider-dir` via a repeated `--choose` / a JSON-array
   reply, and `--decider-cmd` via a JSON-array reply — all deliver the same `", "`-joined wire shape.
   Free-text "Other" via `answer:`. Do NOT hand-write a multiSelect reply as a bare comma-joined
   string — send an array; a scalar is treated as one selection.) `question_asked` / `question_options` / `question_context` / `question_option_count` /
   `questions_count_max` / `gate_answers_delivered` only evaluate on replay **with a `controlOut` cassette** — re-record an
   old cassette or they're excluded (loudly), not vacuously passed. `gate_answers_delivered` *fails*
   on unobserved delivery (absence of evidence is failure, not neutral).

3. **A multi-key `assert:` item is an AND.** A single list item with more than one key passes iff
   **every** key passes. *Fix:* one concern per item unless you genuinely mean conjunction (and a
   mixed-class conjunction still loses its filesystem half on replay — see gotcha 1 above).

4. **`tool_called` doesn't mean "attempted".** Tool counts are authoritative and de-duped: a tool
   that was *requested then denied* does **not** register as called. *Fix:* don't assert `tool_called`
   to prove an attempt; it proves the tool actually ran.

5. **`subagent_declared_but_unused` fires on declared-but-didn't-use-THAT-tool**, even if the
   sub-agent used other tools. `subagent_dispatched` / `subagent_output_contains` match on dispatch
   type (`dispatchAgentType`), the binary-*resolved* type (`resolvedAgentType`), *or* the dispatch
   **description** — so a type-less dispatch that resolved to e.g. `general-purpose` is still
   selectable, by either the resolved type or the description. A `Task` dispatch that carries NO
   `subagent_type` at all falls back to the built-in `general-purpose` agent with a **wildcard tool
   surface** (`tools:["*"]`, including workspace bash) — faithful production behavior, and it fires
   routinely. The harness warns loudly on this fallback and records `subagents[].dispatchTypeOmitted`;
   an *explicit* `subagent_type: "general-purpose"` is a deliberate author choice and does not warn.
   Implication: `subagent_tool_absent` on a type-less dispatch is weaker evidence (wildcard surface) —
   pin `subagent_type` explicitly when you need a tight tool-absence guarantee.

   **Cross-tier "no shell" caveat.** On `hostloop`, native `Bash` calls route through the
   `mcp__workspace__bash` alias, so a "sub-agent used no shell" check must glob **both** `Bash` and
   `mcp__workspace__*` to hold across every tier.

6. **`dispatch_count_max` is your author-chosen budget UNDER Cowork's production cap, not a
   reproduction of it.** It's a post-hoc count assertion: passing means "happened to dispatch ≤N this
   run." Cowork DOES cap `Task` fan-out **agent-side** (`taskRegistry`: concurrent **20** /
   per-session **200**, landed 2.1.212/2.1.217) — SEPARATE from the scheduled-task session limiter
   (gate `1648655587`'s `{perTask:1, global:3}`, a different mechanism; binary-verified, `SPEC.md` §10
   — repo-only). The harness **inherits** the production cap by spawning the real agent binary, so a
   `dispatch_count_max` pass means "your tighter budget held," not "near a real limit"; use it to catch
   a fan-out you don't want.

7. **`protocol` is rejected (not silently passed) if the scenario asserts egress** — boundary
   assertions need a sandboxed tier (`container`+). Good: this one fails loud by design.

8. **Read-only mounts are enforced; delete-deny is a HARNESS gap — production DOES enforce it.**
   `mode:r` mounts get a real `:ro` bind (a write fails in-guest). But `rw` vs `rwd`
   (write-but-no-delete on `outputs/` / connected folders) is *not* mount-enforced **in the harness** —
   `rm` succeeds and is only caught post-hoc by `no_delete_in_outputs`. **Real Cowork enforces it live:**
   outputs is a FUSE mount, and `unlink`/`rmdir` fail `Operation not permitted`; a skill must request
   approval via `allow_cowork_file_delete` (which re-mounts the folder `rwd` mid-session) to delete.
   **Only unlinking is denied.** Emptying a file in place — `truncate -s 0`, `> file`, `shred` without
   `-u` — and renaming *within* outputs both SUCCEED in production, so the harness does not flag them
   either. Renaming a file OUT of outputs fails (`EXDEV`, then `EPERM` on the copy-then-unlink
   fallback), so that stays a delete. Two consequences: a skill should not stage disposable scratch
   under `outputs/` (in production, cleanup there costs an approval prompt), and a skill's
   "catch-EPERM-then-request-approval" branch cannot be exercised at any harness tier (the `rm` just
   succeeds here). Do not read this gotcha as "delete-deny may not be real in production" — it is real.
   If a scenario's deletion IS intended, assert `allow_outputs_delete: true` rather than dropping
   `no_delete_in_outputs` — omitting it does not permit anything.

9. **Keep `.env` out of any mounted folder** — it is copied into the sandbox and the token could
   leak. Put it at a working-dir or install root (token resolution: env > `--dotenv` > `./.env` >
   install `.env`). **Inverse footgun — running from a git worktree:** a worktree's `./.env` is gitignored, so
   it's **absent** there and you'll get "no model credentials." *Fix:* pass `--dotenv <main-checkout>/.env`
   (or set the env var) — that's exactly what `--dotenv` is for.

10. **A base64 artifact that was scrubbed at record time will fail artifact assertions at replay.**
    When `record` detects a secret embedded in a base64 artifact, it replaces the entire artifact
    body with `[REDACTED:base64]` and emits a `::warning::`. Any `artifact_json` or content
    assertion targeting that artifact will fail at replay because the body no longer matches. *Fix:*
    do not let secrets flow into artifacts; if the artifact is intentionally opaque, drop the
    content assertion and gate on `file_exists` on the live lane instead.

11. **An external decider returning `"first"` does not select option 1.** The `"first"` keyword
    shorthand is disabled for `--decider-cmd` / `--decider-dir` helpers (see *Choose an answer path*
    → External deciders in `authoring.md`). If your helper
    accidentally emits `"first"` and no label named `"first"` exists, the gate fails — it does
    **not** silently pick the first option. This is intentional: a helper bug should fail loud, not
    green wrong. *Fix:* have helpers return a label name or numeric index.

12. **`prompt_asset_missing` is a WARN, not a hard failure — greens can hide it.** The
    `prompt_asset_missing` verdict signal (see *Interpreting verdict signals* in `run-record-replay.md`) does not block a green verdict. Scan the verdict
    signals section after every run; a run that greened with this signal ran against an incomplete
    prompt. *Fix:* treat `prompt_asset_missing` as a blocking error in CI by checking the signals
    array.
13. **`result: success` means the agent didn't error, NOT that the task completed — always assert on
    artifacts/content.**
    - A turn that ends on a plain-text re-ask ("which file did you mean?") still reports
      `result: success`.
    - The harness catches this with a **`stalled`** verdict signal: a run that ends asking for input and
      did **no productive work after its last gate** — both the no-gate case ("which file?" with no
      tool calls) AND the *answered-gate-then-re-ask* case (the agent answers an `AskUserQuestion`,
      then asks again in plain text and stops). Suppress with `allow_stall: true` if ending on a
      question is intended.
    - "Asking for input" is read from the final turn's **closing sentence**. It ends in `?` on the raw
      text; or, once an `AskUserQuestion` gate has fired: it ends in `?` after trailing bold, quotes, a
      `)` or an emoji; it is a `?` followed only by a `For example: …` or parenthetical aside; or it is
      a request that says the input comes back to the agent — `Please`/`Kindly` + share, provide, send,
      upload, attach, paste, confirm, specify, tell me, give me, reply with, choose, pick, select, or
      `Let me know which…`/`whether…`, WITH a cue (`so I…`, `and I'll…`, `to proceed`, `here`,
      `with me`, `to me`, `in chat`, `reply`, `you'd like me to`; `here` only after share/paste/upload/drop/
      reply/type/send or as the last word); `Once you share…, I'll…`; a whole
      sentence `I need X to proceed`/`…before I can Y`; or `Once I have the file, I'll…` right after a
      sentence asking for it. Never counted: polite closers and hand-offs (`Let me know if…`,
      `Feel free…`, `thoughts`, `feedback`, `with your`/`to your`, `before sending`, `whichever`,
      `how it goes`, `If you…`), a hand-off to a named third party (`with the team`, `to the founders`,
      `with the CFO`), a closing code block or `>` blockquote, or a request earlier than the
      closing sentence. With no gate only the raw `?` counts. The request test is English-only.
    - The signal is a **tool-position heuristic**, not deliverable detection, so it is imprecise both
      ways:
      - **False negative:** a post-gate tool *call* clears the flag whether it **succeeded or
        errored** — an agent that ran a tool after the gate and still stalled is not caught.
      - **False positive:** a deliverable written *before* a final confirmation gate does **not**
        clear it, so a write-then-confirm-then-question run is flagged — use `allow_stall: true` for a
        deliberate confirm-terminal skill.
    - The broad guard is therefore YOUR assertions — assert the deliverable (`file_exists` /
      `artifact_json` / `transcript_matches`), never just `result: success`.
    - `on_unanswered` governs **unanswered** `AskUserQuestion` gates; the `stalled` signal covers
      stalling *after* one is answered — two different failure modes.
    - **Free-text aside:** the scripted key for a "type-it-in-notes" option is **`answer:`** — an
      arbitrary string delivered verbatim, bypassing label validation by author intent (Cowork
      auto-provides an "Other" free-text path on every gate). Mutually exclusive with `choose:`; setting
      both fails loud. What has no scripted equivalent is the `OTHER:` *directive*
      (it works only on the LLM-decider path, not scripted `choose:`, and only on
      **single-select** gates — a **multi-select** gate is index-only, so `OTHER:` fails loud there; on an
      options-bearing single-select gate a bare out-of-set LLM answer also fails loud (exit 2) — see the
      LLM-decider free-text note in `references/fidelity-and-answers.md`). An LLM decision answered via
      `OTHER:` is marked `[via Other free-text]` in its `gateProvenance` rationale.
14. **A positional `choose` (`first` / index) is order-dependent.** `choose: "2"` survives label drift
    but NOT option *re-ordering* — if the gate presents its options in a different order run-to-run, the
    index lands on a different option (a silent re-record flake). Prefer an exact label when order is
    stable; `lint` flags positional `choose` with an advisory. Unstable option order is also what the
    **user** sees — a reordered gate puts a different choice in the default slot — so pin what was shown
    with `question_options`, rather than only hardening the answer rule against it.
15. **A scripted `choose:` matching no offered option HARD-fails the run — `on_unanswered: first` does NOT
    backstop it.** This is distinct from an *unanswered* gate (no rule matched → falls to `on_unanswered`): a
    rule that DID match the gate but whose `choose:` names a label the gate never offered (the model reworded
    it) is treated as an authoring bug and fails loud — `first`/`llm` won't absorb it. The error now prints the
    **offered options** (and a closest-match suggestion), so fix the anchor from the error alone — no need to
    dig through `events.jsonl`. (This is exactly the drift `verify-run` answer-coverage catches in ~1s; use it
    before a paid record.)
16. **Batch record keeps going — you don't need a one-at-a-time wrapper.** `record <dir>` and `record <dir>
    --rerecord-stale` run **every** scenario, collect failures, and report them at the end (non-zero exit on
    any failure) — a failing scenario does NOT abort the batch. So a single `cowork-harness record cassettes/
    --rerecord-stale` surfaces ALL stale anchors in one pass (add `--concurrency <N>` to parallelize); a shell
    wrapper that loops one cassette at a time with `set -e` defeats this and rediscovers stale anchors serially.
    Two durability properties make the batch safe to trust: each cassette is written **atomically** (a
    same-directory temp file + rename), so an interrupted or OOM-killed batch never leaves a partial/corrupt
    cassette — a failed scenario simply produces none; and under `--concurrency <N>` each scenario runs **fully
    isolated** (its own egress sidecar network + proxy, its own per-session run dir), so parallel records don't
    cross-talk — the concurrency bound exists only for the Docker address pool + API rate limits, not correctness.

17. **Editing `scenarios/*.yaml` does NOT change a plain `replay` — the WHOLE scenario is frozen, not just
    `assert:`.** *Why:* a cassette captures every key (`lane:`, `fidelity:`, `baseline:`, `prompt:`, `skills:` …)
    and `replay` evaluates all of them from that frozen copy — byte-deterministic, ignoring the working tree (so
    a committed cassette can't silently re-interpret against an uncommitted YAML). **Only `assert:`
    (+`expect_denied:`) can be opted back to disk; any other edited key reaches a replay only by re-recording.**
    This is *loud* rather than a *silent* no-op: plain `replay` prints a `::notice::` when a sibling's
    `assert:`/`prompt:` differs, and when the sibling **fails to load** at all (a typo'd or too-new key) — and
    points you at the fix.
    *Fix:* to re-check token-free against the edited block, `replay --assert-from <scenario.yaml>` (or
    `--reassert`). That opt-in path is safe by construction for the authored fields — it **hard-fails** if
    `prompt`/`answers`/`baseline`/`fidelity`/`lane`/`skills`/`requires_capabilities`/`workspace_fixture` (the dir, not
    its content — that is a `fixture` staleness finding) or the skill content (when a
    fingerprint exists) drifted from the recording (re-record then), and `expect_denied`/filesystem/egress keys
    are sourced but stay **live-only** (it warns; they don't move the replay verdict). **Caveat:** the session's
    `model:` IS in the cassette's `sessionFingerprint` (a `--model`/env model is not; `environment.model`
    records what ran). `verify-cassettes` reports a changed session as staleness (exit 1); `replay` never
    checks it — plain, `--strict` or `--assert-from` — so re-record if the session changed. `verify-run` reads
    on-disk `assert:` against a kept *run dir*; `replay --assert-from` is the equivalent for a *cassette*.

18. **`questions_count_max` counts sub-questions, not gates.** One `AskUserQuestion` tool call can
    bundle several sub-questions into a single gate; the assertion counts each sub-question, so a
    3-sub-question bundle counts as 3, not 1. `trace --view questions` shows the same per-gate
    sub-question count and a matching footer total — read that off instead of the tool-call count when
    sizing the budget.

19. **`gate_answers_delivered` passes vacuously when no gate fires — pair it, or drop it.** Whether a
    gate fires is model-dependent, so `gate_answers_delivered: true` alone can't catch "the gate never
    fired at all". If the scenario is meant to gate, pair it with `gate_answer_count_min: 1` (a floor of
    `0` witnesses nothing). If the scenario is gate-clean by design, drop the key — it asserts nothing
    there — and declare `questions_count_max: 0`, which fails loudly if a gate ever appears. Asserting
    `questions_count_max: 0` alongside a gate-presence key is unsatisfiable: `run`/`skill`/`record`
    refuse it before spending.

20. **A `mode: r` connected folder's contents are recorded body-less, not excluded.** `record` captures a
    read-only folder's files as path + hash only (`truncated: true`, no `body`) — it's an input the agent
    read, not a deliverable it wrote. `file_exists`/`computer_links_resolve` still pass against it on replay
    (the hash-only entry still materializes a placeholder); `artifact_json`/`artifact_text` report a clear
    evidence-unavailable on every lane (live/verify-run/replay agree — no green-record/red-replay). This is
    also why a `mode: r` input never trips the `binary` privacy finding or needs `--allow` — only a
    *committed* body is scanned. `scaffold` won't emit `file_exists` for one either (it's not in
    `RunResult.artifacts`). A `mode: rw`/`rwd` folder's contents are captured with a full body, same as
    `outputs/`.

21. **A `fidelity: cowork` cassette can go stale in a way `skill`/`format` drift won't catch.** Its recorded
    `effectiveFidelity` field pins which concrete tier (`hostloop` or `container`) the baseline resolved to
    AT RECORD TIME. If a later Desktop baseline flips that resolution, `verify-cassettes` reports it as a
    `resolved-tier` finding (re-record — the recording now exercises the wrong tier); a cassette with no
    `effectiveFidelity` at all, or an unloadable pinned `baseline:`, reports `unverifiable-tier` instead
    (couldn't check — also re-record). Both are `fidelity: cowork`-only; an explicit-tier scenario never
    produces them. (Details: [`docs/cassette.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/cassette.md) § tier staleness — repo-only.)

22. **`lint` floods CI with INFO advisories that don't apply to you.** *Why:* two rules —
    `manifest-needs-snapshot` and `gate-needs-controlout` — fire on the mere presence of manifest/gate
    assertion keys. The linter is **static** until you opt in to cassette evidence. With committed
    recordings, pass `lint --cassette-dir <dir>` (or one cassette file): it scans the same `*.cassette.json`
    shape as replay and verify-cassettes, resolves each exact `scenarioSource` relative to its cassette,
    and suppresses an advisory only when **all** matching cassettes carry the evidence the replay lane
    needs. A malformed, wrong-shaped, unsupported-version, or provenance-less cassette is reported as INFO
    and keeps the advisory visible — even beside a healthy sibling. The two dedicated diff assertions also
    require their respective `preRunPaths` / `preRunHashes` baselines, and a non-empty `controlOut` /
    artifact manifest is required where replay needs it. For a strict CI gate that keeps actionable INFO
    rules visible while suppressing only proven replay noise, use `lint --strict --min-severity INFO
    --cassette-dir <dir>`. Without the opt-in path, use `lint --min-severity WARN` in CI (≥1.11.0) to hide
    the INFO class.
    From 4.0.0 WARN is `--strict`'s default floor, so bare `lint --strict` hides and passes INFO; add
    `--min-severity INFO` to fail on it. `--strict --min-severity ERROR` behaves as a plain lint, not a
    contradiction.
23. **`verify-cassettes`/`replay` report a `discovery-surface` note on cassettes you just recorded fine.**
    *Why:* the cassette froze its `system/init` tool inventory from before the skills/plugins discovery
    servers existed at that tier (added 1.10.0). It is a non-gating **note**, never a finding — it cannot
    fail your gate. *Fix:* nothing, unless the scenario asserts `tool_available` on
    `mcp__skills__*`/`mcp__plugins__*`; then re-record. It stays silent at `microvm`/`protocol`, where
    re-recording would never produce those tools anyway.
    A sibling **`agent-version:` note** means the agent version the cassette's own `system/init` event
    reports differs from the one the baseline its `fingerprint.baseline` names pins for that tier: the
    `agentVersion` at `container`/`microvm`, the native agent in `agentBinary.nativeStagedPath` at
    `hostloop`. It never appears at `protocol`, which runs the unpinned `claude` on your `PATH`. *Why:* one
    of a fingerprint re-stamped by hand across an agent bump, a recording made under
    `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1`, an explicit binary override (`COWORK_AGENT_BINARY`, or
    `COWORK_HOST_AGENT_BINARY` at `hostloop`), or at `hostloop` the default patch-bump substitution of the
    native agent; the note lists that tier's causes and does not pick one. It is non-gating too:
    `verify-cassettes` puts it in the result's `notes[]`, and `replay` prints one
    `::notice:: [replay] <file> — … [agent-version]` line per cassette on stderr (also under
    `--output-format json`). *Fix:* re-record against the pinned agent.

24. **Never name the file-delivery tool in a `SKILL.md`.** *Why:* Cowork has **two**, one per product
    lane, and an agent only sees the one for the surface it is on. The desktop-local sandbox this harness
    emulates is served `mcp__cowork__present_files` (`{files:[{file_path}]}`); **remote** cloud-container
    Cowork instead gives the agent the native `SendUserFile` (`files: string[]`, required `status`,
    optional `caption`/`display`). A skill that hardcodes either name works on one lane and fails on the
    other — and probing a remote session makes this harness look like it emulates the wrong tool under the
    wrong schema. It doesn't; the lanes genuinely disagree. *Fix:* describe the **outcome** ("deliver the
    file to the user") and let the model pick its surface's tool. The `no_scratchpad_leak` /
    `present_files_called` assertion keys are harness-side names and stay valid either way.
    ([`docs/fidelity-gaps.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/fidelity-gaps.md)
    → "File delivery" has the binary-verified detail; repo-only.)

25. **Three host-inventory flags — two on `record`, one on `verify-cassettes`.** `record
    --allow-host-inventory-fixture` proceeds past the PRE-FLIGHT refusal when recording a host-inheriting
    (`protocol`/`hostloop`/`cowork`-resolving-to-hostloop) cassette into a repo-visible path — otherwise
    `record` refuses before it spends (freezing this machine's MCP servers/agents/account into a committed
    fixture is the risk). It bypasses that check and **nothing else**: the finished recording is still
    scanned, and a real finding still quarantines it, so you never have to audit the session by hand to
    pass it. Writing a recording the scan DID flag is the separate `record
    --allow-host-inventory-findings`. That pre-spend check **warns rather than refuses when the cassette already
    exists** — refusing would fire on every `--rerecord-stale` pass — and it reads the tier and the
    destination path, never the bytes. So `record` also scans the FINISHED recording, after redaction and
    before the write: a `host-inventory`/`machine-inventory` finding on a repo-visible path is
    **quarantined** to `<runs-root>/quarantine/` with a `.findings.txt` naming what leaked, and the command
    fails without writing the path you asked for (the recording is not discarded — you paid for it).
    `verify-cassettes --allow-host-inventory <regex>` is unrelated: a per-finding suppressor for the
    scanner's `host-inventory` class on an already-committed cassette. They don't interchange: passing one
    to the other command is a usage error that names the command owning it. Depth: `references/ci-recipe.md`.

26. **A `skill`-lane `PASS` does not mean the skill ran, or that the run was the one you wanted.** *Why:*
    an open-ended `skill` run has no `assert:` block, so its verdict reports only that **no guard fired**
    (no error, stall, host-path leak, `outputs/` delete, permissive auto-allow or capability gap). On
    `run` the same word additionally means *your assertions held*; on `skill --repeat N`, `PASS — N/N`
    means N runs cleared the guards — it says nothing about which model served them, whether the skill
    was invoked, or whether they were the ablated arm. *Fix:* read the three fields the record already
    carries before drawing any conclusion — `skillsInvoked` / `skillActivity` (was it invoked at all;
    a `/<skill> …` prompt runs the skill with NO `Skill` call, so read `slashInvokedSkills` too — and
    `models` is then just `["<synthetic>"]`, with the real model only in `modelUsage`),
    `models` (which model), `ablated` + `context.availableSkills` (which arm). An answer that reads
    exactly like skill output is not evidence: the skill's own source is mounted where the model can
    read it — in production too — so on a self-referential prompt it may read `SKILL.md` and answer
    directly, with `skillActivity` empty.

27. **`stalled` also fails a complete answer that closes by offering a follow-up.** *Why:* the
    `stalled` guard fires when a run's final message ends on a question (or a closing request for input
    — see gotcha 13) with no productive tool call after the last gate — which includes a complete answer
    that closes by *offering* a follow-up ("want me to run this through a structured pass?"). *Fix:* read
    the final message before believing `stalled`. If ending on a question is intended, opt out:
    `allow_stall: true` in a scenario's `assert:` block, or `--allow-stall` on `skill` /
    `probe-dispatch`, which have no `assert:` block. The failure message names the spelling for the lane
    you ran.

For the assertion catalog, the YAML schema, the fidelity/answer tables, and the CI recipe, read the
files in `references/` (the gotchas above are the full list; the references repeat only the
assertion/replay-relevant ones).

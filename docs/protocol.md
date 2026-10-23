# Control-protocol wire schema (`schema/protocol.v1.json`)

cowork-harness speaks a **stream-json control channel** to the staged agent CLI it drives — the
`initialize` handshake, `can_use_tool` permission/question gates (including AskUserQuestion's
`questions[]`), `hook_callback`/`mcp_message` round-trips, `request_user_dialog` and
`elicitation`/`side_question` gates, and the two `control_response` envelopes it answers them with — the
nested success envelope and the fail-closed `subtype:"error"` one. `schema/protocol.v1.json` is a hand-authored draft-07 JSON Schema for **that**
wire surface — the harness's *own* protocol, not Anthropic's.

## Scope: what this schemas, and what it deliberately doesn't

**In scope** — the five verified control-channel shapes documented in prose at
[DESIGN.md §6](../DESIGN.md#6-control-protocol-mapping) and [SPEC.md §4-5](../SPEC.md):

1. Spawn/handshake: the `initialize` `control_request` (`ControlRequestInitialize`).
2. Inbound permission/question gates: `can_use_tool` `control_request`s, including AskUserQuestion's
   `input.questions[]` (`ControlRequestCanUseTool`, `AskUserQuestionInput`, `QSpec`, `QSpecOption`).
3. Inbound `hook_callback` (PreToolUse hooks, e.g. hostloop's path-containment gate; the always-installed Task
   `run_in_background` block rides the same channel, but with background tasks off on every tier the agent's schema
   rejects that parameter, so it cannot fire on such a call)
   and `mcp_message` (host-loop MCP JSON-RPC) round-trips (`ControlRequestHookCallback`,
   `ControlRequestMcpMessage`).
4. The **nested** `control_response` success envelope every reply shares — payload sits under an
   *inner* `response` key; a flattened body is rejected by the agent with `ZodError: expected object,
   received undefined` (`ControlResponse`, `ControlResponseBody`, `AllowBody`, `DenyBody`,
   `McpResponseBody`, `HookOutputBody`).
5. The AskUserQuestion answer wire-shape: `updatedInput` requires **both** `questions` and `answers` —
   `answers` is `Record<questionText, answer>` with values always **strings**; a multiSelect answer is a
   single **comma-joined string** of the chosen labels (e.g. `"Auth, Audit"`), never an array (`Answers`,
   `QuestionAnswerUpdatedInput`).

**Out of scope, on purpose** — the Claude Agent SDK's own event stream (`assistant`/`result`/`user`
tool-result messages, `system/init` capability manifests, `api_metrics`). That surface is Anthropic's,
changes per SDK release, and is already covered by `parseMessage` (`src/agent/session.ts`) rather than a
frozen schema — freezing it here would either lag every SDK bump or force a spec change on every one.
`parseMessage` tolerates unknown or missing fields, but it fails closed on unsafe structural
malformation: a `system/init` frame whose `tools`/`mcp_servers`/`skills` is present but not an array, or
an assistant content-block entry that isn't an object, throws a typed `control-in: malformed …` protocol
error rather than propagating a shape that would crash downstream unguarded. Every caller catches it rather
than aborting, but they do **three different things** with it, and only one is a plain skip: the **live**
session surfaces a typed `{type:"error", source:"protocol"}` event; **cassette replay** records a protocol
error that becomes a FAILING `replay_protocol_fidelity` assertion and continues — a malformed frame could
conceal a failed assertion, so a silent skip would risk a false green; **`trace` reconstruction** is the one
that skips the frame loudly and moves on. (The frozen `schema/protocol.v1.json` control shapes documented below are
unaffected by this — `parseMessage`'s SDK-event handling is a separate code path.) The `{type:"user",
message:{role:"user", ...}}` turn-send message
(`sendUserTurn`) is mirrored into `control-out.jsonl` for full-fidelity replay but is also SDK input
shape, not a control-protocol shape — also out of scope (the conformance tests explicitly skip it).

## Descriptive, not normative — and version-scoped

**This schema describes what the harness has empirically observed and verified end-to-end against a
specific range of staged agent builds. It is not a normative specification Anthropic has published or
committed to.** A future agent release could change any of these shapes without notice; the harness's own
`sync` process is what catches that (see [docs/maintenance.md](./maintenance.md)) and this file — plus
its conformance tests — is the tripwire that would fail loud if a re-record ever produced a shape this
schema rejects.

Verified against, at the time `protocol.v1.json` was written (mirrors the version-scoping style of
[DESIGN.md §6](../DESIGN.md#6-control-protocol-mapping)'s own "Control protocol — VERIFIED end-to-end..."
note):

- **Baselines committed in this repo at the time of writing:** `baselines/desktop-1.17377.1.json` through
  `baselines/desktop-1.19367.0.json` (see `baselines/` for the current set — `sync` may have added newer
  ones since). The staged agent ELF is 2.1.197 through the `1.18286.0` baseline, then 2.1.202 from
  `1.18286.2` onward (see each baseline's `agentBinary.stagedPath`) — DESIGN.md's "Spawn contract +
  host-loop vs VM-loop" note already establishes the spawn contract itself is byte-identical/behaviorally
  identical across that ELF bump, so the verification below still covers the whole range despite the
  binary version change partway through.
- **Staged in-VM agent:** 2.1.197 (through `1.18286.0`), 2.1.202 (`1.18286.2` onward).
- **Host CLI used for the original end-to-end verification:** macOS build 2.1.177+.

If you're conformance-testing a *different* agent build against this schema and it fails, that's a signal
worth investigating (see "If a real recording fails to validate" below) — not necessarily a bug in your
implementation.

**Do not treat a validation failure as grounds to file a compatibility complaint against Anthropic.** This
schema exists so cowork-harness's own tests don't drift from its own recordings; it does not carry any
guarantee about future agent releases, and disputing an agent behavior change against this document isn't
a supported use.

## Definitions

| Definition | What it covers |
|---|---|
| `ControlRequestInitialize` | The driver's first control_request, before any user turn. |
| `ControlRequestCanUseTool` | Inbound permission/question gate (`can_use_tool`). |
| `AskUserQuestionInput` / `QSpec` / `QSpecOption` | The `input` body when `tool_name==="AskUserQuestion"`. |
| `ControlRequestHookCallback` | A fired PreToolUse hook awaiting a reply. |
| `ControlRequestMcpMessage` | A host-loop MCP JSON-RPC round-trip. |
| `ControlRequestUserDialog` | A `request_user_dialog` gate (~6s auto-cancel if nothing answers). Accepts `dialogKind` and `dialog_kind` — the parser reads either. |
| `ControlRequestElicitation` | An MCP `elicitation` **or** `side_question` gate. Each field has two accepted spellings (`mcp_server_name`/`server`, `message`/`prompt`). |
| `ControlRequest` | Union of the six request shapes above, discriminated on `request.subtype`. |
| `ControlResponse` | The nested `control_response` success envelope. |
| `ControlResponseError` | The fail-closed `subtype:"error"` envelope — a STRING under `error`, not an object under `response`. A distinct top-level shape, not a `ControlResponse` variant. |
| `ControlResponseBody` | Union of the reply-body shapes below (the inner `response.response` payload). |
| `AllowBody` / `DenyBody` | Permission/question allow-or-deny reply bodies. |
| `McpResponseBody` | Reply body to an `mcp_message` request (JSON-RPC 2.0 envelope, or `{}`). |
| `HookOutputBody` | Reply body to a `hook_callback` request (`{}` or `{decision:"block", reason}`). |
| `DialogResponseBody` | Reply body to a dialog (`{behavior:"ok"\|"cancelled", choice?}`). |
| `ElicitResponseBody` | Reply body to an elicitation (`{action:"accept"\|"decline"\|"cancel", content?}`). |
| `Answers` | `Record<string,string>` — the AskUserQuestion answer map. |
| `QuestionAnswerUpdatedInput` | `{questions, answers}` — the `updatedInput` of a question-allow reply. |
| `Message` | Root: any single line the harness reads/writes on the control channel (`ControlRequest \| ControlResponse \| ControlResponseError`). |

## Golden vector pack (`fixtures/protocol/v1/`)

One JSON file per message kind — `initialize.json`, `permission-request.json`, `question-request.json`
(exercises `multiSelect:true`), `allow-response.json`, `deny-response.json`,
`question-answer-response.json` (the multiSelect comma-joined answer), `hook-callback.json` and
`mcp-message.json` (request/response round-trip pairs, `{request, response}`) — plus, for the frames added
in the 2026-08-23 entry below, `user-dialog-request.json` / `dialog-response.json`,
`elicitation-request.json` / `elicit-response.json`, and `error-response.json`. That last one is the only
vector that must **not** validate as a success envelope, which `test/protocol-schema.test.ts` asserts
explicitly so the two response shapes cannot be quietly conflated.

- `question-request.json` and `question-answer-response.json` come from a real run of the committed,
  redaction-scanned `examples/replays/example-multiselect-gate.cassette.json` scenario — real bytes the
  replay gate already trusts, not hand-authored lookalikes. `question-request.json` still matches that
  cassette's `can_use_tool` frame field-for-field; `question-answer-response.json` matches in shape and
  content but carries the `request_id` of the run it was taken from, which is regenerated every time the
  fixture is re-recorded. Treat "verbatim" as a claim with a shelf life: per-run identifiers drift, the
  structure does not.
- `initialize.json` did **not** come from that cassette, despite once being described here as though it
  had. It carries an `appendSubagentSystemPrompt` holding the **VM** sub-agent text, and a session id
  (`local_94v9zwdeo`) that appears in no committed cassette. A `protocol`-tier run renders **no**
  sub-agent append at all (`readSubagentAppend`, `src/prompt.ts`), and that scenario has been
  `fidelity: protocol` for its entire history — so the frame must have been captured from a
  container-tier run that was never committed. It is a real captured frame, just not from the cassette
  named above.
- The rest are synthetic, but generated by calling the **real** envelope-builder functions in
  `src/agent/session.ts` (`serializeDecision`, `hookOutput`, `mcpResponseEnvelope`,
  `successEnvelope`) — never hand-rolled JSON that merely looks like their output.

`fixtures/` ships in the npm package (`package.json` `files`), so `npm i cowork-harness` gets the vector
pack without cloning the repo — a third-party implementation of the harness's control-channel contract
can validate against `schema/protocol.v1.json` + `fixtures/protocol/v1/*.json` directly.

`test/protocol-schema.test.ts` is the executable form of this document: it (a) validates every
`controlOut` line and every `control_request` event line in every committed cassette against the schema,
(b) validates the real envelope-builder functions' actual output for a synthetic decision matrix
(allow/deny/answer/multiSelect-answer/hook_callback/mcp_message), and (c) asserts the vector pack and the
schema stay in lockstep — every vector validates, and every schema `definitions` entry is exercised by at
least one vector.

## If a real recording fails to validate

1. Check whether the shape changed on purpose (a legitimate agent-version drift, caught by `sync`) or
   whether it's a harness bug (a shape the schema documents but the harness itself violates).
2. If it's a genuine, intentional shape change: this is an **additive discovery** (see below) if the old
   shape still round-trips, or a **breaking wire change** if it doesn't.
3. Either way, the conformance test failing is the point — it means a real re-record hit a shape this
   schema doesn't yet know about, exactly as designed.

## Versioning policy

- **`protocol.v1` is frozen.** Its `definitions` do not change shape once published — no rewriting
  existing required/type constraints, no removing a definition.
- **Additive discoveries** (a new optional field observed on the wire, a new `hook_callback` id, a new
  `ControlRequest`/`ControlResponseBody` variant that composes with the existing ones without changing
  what's already documented) are recorded as **v1 minor notes right here in this file**, in a dated
  changelog section below, and folded into `protocol.v1.json` as new optional properties / additional
  `oneOf`/`anyOf` branches — never as a breaking edit to an existing required field.
- **A breaking wire change** (an existing required field removed, a type changed, an envelope
  restructured) observed in a future staged agent gets a **new `schema/protocol.v2.json`** file, with its
  own vector pack under `fixtures/protocol/v2/`. `v1` and `v2` ship side by side — `v1` isn't deleted, so
  anything conformance-testing against the older agent range keeps working.

### v1 changelog

> **Entries are NOT in date order**, and cross-reference each other positionally ("the entry below").
> Read the whole list before editing it, and **append rather than splice** — a range edit anchored on
> two dates can silently swallow an entry that sits between them.
>
> **Current live scope lives in [DESIGN.md § Control protocol](../DESIGN.md#control-protocol--verified-end-to-end-against-the-live-host-cli-macos), not here** — that
> section's "Scope of that claim" note is the single authority for the live pin.
> Each dated entry below states the live pin **as it stood on that entry's date** and is never restamped,
> so the oldest-looking pin in this file is not a claim about today.

- **2026-09-19** — **coverage-log gap, recorded not closed.** Thirteen baselines have shipped since the
  2026-08-05 entry below with **no v1-changelog entry of their own**: `1.26832.0`, `1.28929.0`, `1.30096.1`,
  `1.32352.0`, `1.32885.1`, `1.34493.1`, `1.37937.1`, `1.40609.0`, `1.40609.1`, `1.44121.1`, `1.46388.3`,
  `1.46388.4`, `2.2553.1`. **This entry claims no verification of them.** It exists because the 2026-08-01
  entry below established the rule that silence here must never be ambiguous between "nothing additive was
  observed" and "nobody updated this file" — and for these thirteen the honest answer is the second. What
  *is* known: each shipped with a committed baseline and a green suite, and `sync` is the gate that would
  have reported an unknown delta; what was **not** done is the per-release protocol pass (asar subtype-set
  comparison, or a live tier re-run) that every entry below rests on. Treat the control-protocol facts in
  this file as verified through `desktop-1.25927.0` and *inherited, unverified*, past it. The last **live**
  end-to-end pass remains `2026-07-11 / desktop-1.20186.0`, unchanged.
- **2026-08-23** — **coverage correction, additive.** Three request subtypes the harness has always
  answered were undescribed — `request_user_dialog`, `elicitation`, `side_question` — as was the
  fail-closed `subtype:"error"` response envelope. Measured before the fix: all five representative frames
  were **rejected** by the published schema; a consumer validating real traffic against it saw failures on
  frames the harness handles correctly. Added as new `oneOf`/`anyOf` branches and one new top-level
  response shape, per the additive rule above — nothing existing was narrowed, and no frame the schema
  already accepted is affected. `SPEC.md` §12's control-protocol bullet now states that additive latitude
  explicitly, since its silence had read as a prohibition.
- **2026-07-03** — initial publication. Verified against staged agent 2.1.197 / baselines through
  `desktop-1.18286.0.json`.
- **2026-07-09** — baseline set extended through `desktop-1.19367.0` (staged agent 2.1.202). The `v1`
  control-protocol facts are unchanged across this bump — confirmed by the re-recorded conformance
  cassettes passing `test/protocol-schema.test.ts`. The 2026-07-03 verification above stays scoped to
  its stated 2.1.197 range (it is not restamped; newer baselines carry agent 2.1.202).
- **2026-07-11** — baseline set extended through `desktop-1.20186.0` (VM ELF 2.1.202 unchanged; native
  host app 2.1.205). The `v1` control-protocol facts are unchanged across this bump — the 1.20186.0
  asar was a minifier re-anchor with a byte/behaviourally-identical value-resolved spawn contract
  (extractor re-anchored in `src/sync/cowork-sync.ts`), confirmed by the live spawn-contract tests plus
  a live end-to-end pass across `protocol`/`container`/`hostloop`. The system-prompt source added a
  deployment-gated `{{modelIdentity}}` placeholder that is stripped on first-party, so the rendered
  prompt is byte-identical.
- **2026-07-12** — baseline set extended through `desktop-1.20186.1` (patch-only: egress allowlist,
  spawn config, and the system-prompt fingerprint unchanged from 1.20186.0; the staged VM ELF re-synced
  2.1.202 → 2.1.205). The `v1` control-protocol facts are expected unchanged — the native 2.1.205
  binary already passed the 2026-07-11 `hostloop` live lane — but the 2.1.205 in-VM ELF has had no
  dedicated protocol pass; the 2026-07-11 verification stays scoped to 1.20186.0 (not restamped).
- **2026-08-01** — baseline set extended through `desktop-1.24012.9`, covering six baselines shipped
  since the entry above (`1.20186.9`, `1.21459.0`, `1.22209.3`, `1.24012.0`, `1.24012.1`, `1.24012.9`),
  two of which moved the staged agent ELF to `2.1.219`. Each was verified the cheaper way described in
  DESIGN.md's "Scope of that claim" note — `sync` reporting no unknown deltas, asar analysis, and a full
  local test-suite pass — **not** by re-running the live `protocol`/`container`/`hostloop` tiers. No
  additive control-protocol discovery surfaced by that verification method across these six bumps; this
  entry records that inheritance explicitly rather than leaving the gap ambiguous between "nothing
  additive was observed" and "nobody updated this file." The last **live** end-to-end control-protocol
  pass remains `2026-07-11 / desktop-1.20186.0` (see DESIGN.md).
- **2026-08-04** — baseline set extended through `desktop-1.24012.11`. No control-protocol change:
  `can_use_tool`, `control_request`/`control_response`, `permissionDecision`, `sdkMcpServers`, `hooks`,
  `present_files` and the whole skills/plugins discovery region were occurrence-counted identical between
  the 1.24012.9 and 1.24012.11 asars, the staged agent ELF is unchanged (`2.1.219`, same sha), and the
  Cowork system-prompt constant is byte-identical (same sha256, code-point and section-tag counts — only
  the minifier-assigned constant id moved). The only substantive delta is a **server-side** GrowthBook
  flip of `proactiveSkillSuggestEnabled:1598976391`, which changes the `skills` SDK-MCP tool surface but
  not the control protocol. Verified the cheaper way, as above — **not** by re-running the live tiers, so
  the `2026-07-11 / desktop-1.20186.0` live scope above is unchanged.
- **2026-08-05** — baseline set extended through `desktop-1.25927.0` (agent ELF `2.1.221`). **Read the
  method note before trusting this entry's shape:** Desktop changed its *bundler* in this release — plain
  string literals are emitted with backticks, export names are mangled to one or two characters, and the
  graph split from 101 chunks to 341. That **invalidates the occurrence-counting technique** every entry
  above relies on: raw token counts move for reasons that have nothing to do with behaviour (here
  `control_request` +1, `hooks` +20, `allowedTools` +4, `interrupt` +1, all on a normalized read), and a
  literal that is still present can stop matching simply because the build emits it in a different form. Counting
  was therefore **not** used as the evidence here.
  What was compared instead is the **subtype set** — protocol-level text that survives minification. It
  yields exactly one additive discovery: a new `system` message subtype **`api_retry`**, sitting alongside
  `compact_boundary` in the stream-message filter. No harness change is required: unknown `system` subtypes
  are already surfaced structurally as a `system_event` rather than dropped (`src/agent/session.ts`), which
  is precisely the case this generic path was built for. `permission_request` / `permission_response` are
  **not** gone despite a first-pass reading that suggested it — both are still present; one construction
  site is merely reshaped past a `subtype:"…"` probe. `can_use_tool`,
  `control_response`, `permissionDecision`, `sdkMcpServers`, `present_files`, `tool_permission`,
  `set_permission_mode`, `mcp_message`, `supportedDialogKinds` and `refusal_fallback_prompt` are unchanged.
  The Cowork system-prompt constant and the sub-agent append are unchanged (their `sync` fingerprint guards
  did not fire). Verified the cheaper way — **not** by re-running the live tiers, so the
  `2026-07-11 / desktop-1.20186.0` live scope above is unchanged.

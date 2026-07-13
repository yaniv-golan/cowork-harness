# Control-protocol wire schema (`schema/protocol.v1.json`)

cowork-harness speaks a **stream-json control channel** to the staged agent CLI it drives — the
`initialize` handshake, `can_use_tool` permission/question gates (including AskUserQuestion's
`questions[]`), `hook_callback`/`mcp_message` round-trips, and the nested `control_response` envelope
it answers them with. `schema/protocol.v1.json` is a hand-authored draft-07 JSON Schema for **that**
wire surface — the harness's *own* protocol, not Anthropic's.

## Scope: what this schemas, and what it deliberately doesn't

**In scope** — the five verified control-channel shapes documented in prose at
[DESIGN.md §6](../DESIGN.md#6-control-protocol-mapping) and [SPEC.md §4-5](../SPEC.md):

1. Spawn/handshake: the `initialize` `control_request` (`ControlRequestInitialize`).
2. Inbound permission/question gates: `can_use_tool` `control_request`s, including AskUserQuestion's
   `input.questions[]` (`ControlRequestCanUseTool`, `AskUserQuestionInput`, `QSpec`, `QSpecOption`).
3. Inbound `hook_callback` (PreToolUse hooks, e.g. the always-installed Task `run_in_background` block)
   and `mcp_message` (host-loop MCP JSON-RPC) round-trips (`ControlRequestHookCallback`,
   `ControlRequestMcpMessage`).
4. The **nested** `control_response` success envelope every reply shares — payload sits under an
   *inner* `response` key; a flattened body is rejected by the agent with `ZodError: expected object,
   received undefined` (`ControlResponse`, `ControlResponseBody`, `AllowBody`, `DenyBody`,
   `McpResponseBody`, `HookOutputBody`).
5. The AskUserQuestion answer wire-shape: `updatedInput.answers` is `Record<questionText, answer>` —
   values are always **strings**; a multiSelect answer is a single **comma-joined string** of the chosen
   labels (e.g. `"Auth, Audit"`), never an array (`Answers`, `QuestionAnswerUpdatedInput`).

**Out of scope, on purpose** — the Claude Agent SDK's own event stream (`assistant`/`result`/`user`
tool-result messages, `system/init` capability manifests, `api_metrics`). That surface is Anthropic's,
changes per SDK release, and is already covered by `parseMessage` (`src/agent/session.ts`) rather than a
frozen schema — freezing it here would either lag every SDK bump or force a spec change on every one.
`parseMessage` tolerates unknown or missing fields, but it fails closed on unsafe structural
malformation: a `system/init` frame whose `tools`/`mcp_servers`/`skills` is present but not an array, or
an assistant content-block entry that isn't an object, throws a typed `control-in: malformed …` protocol
error rather than propagating a shape that would crash downstream unguarded. Every caller — the live
session, cassette replay, and `trace` reconstruction — catches that error and skips the offending frame
loudly rather than aborting. (The frozen `schema/protocol.v1.json` control shapes documented below are
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
| `ControlRequest` | Union of the four request shapes above, discriminated on `request.subtype`. |
| `ControlResponse` | The nested `control_response` success envelope. |
| `ControlResponseBody` | Union of the reply-body shapes below (the inner `response.response` payload). |
| `AllowBody` / `DenyBody` | Permission/question allow-or-deny reply bodies. |
| `McpResponseBody` | Reply body to an `mcp_message` request (JSON-RPC 2.0 envelope, or `{}`). |
| `HookOutputBody` | Reply body to a `hook_callback` request (`{}` or `{decision:"block", reason}`). |
| `Answers` | `Record<string,string>` — the AskUserQuestion answer map. |
| `QuestionAnswerUpdatedInput` | `{questions, answers}` — the `updatedInput` of a question-allow reply. |
| `Message` | Root: any single line the harness reads/writes on the control channel (`ControlRequest \| ControlResponse`). |

## Golden vector pack (`fixtures/protocol/v1/`)

One JSON file per message kind — `initialize.json`, `permission-request.json`, `question-request.json`
(exercises `multiSelect:true`), `allow-response.json`, `deny-response.json`,
`question-answer-response.json` (the multiSelect comma-joined answer), `hook-callback.json` and
`mcp-message.json` (request/response round-trip pairs, `{request, response}`).

- The three vectors extracted verbatim from a **committed, redaction-scanned** cassette
  (`examples/replays/example-multiselect-gate.cassette.json`) are `initialize.json`,
  `question-request.json`, and `question-answer-response.json` — real bytes the replay gate already
  trusts, not hand-authored lookalikes.
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

# Working in this repo — cowork-harness

> Canonical agent-instructions file. Read this before changing code. (Claude Code also reads a private
> local `CLAUDE.md` overlay when present; this file is the shared source of truth.)

A test harness that drives the **real** staged Claude Code agent — bind-mounted from the user's Claude
Desktop install at run time (nothing Anthropic-owned is bundled or distributed) — over the Agent SDK
**stream-json control protocol**, inside sandboxes of three isolation tiers + two loop-mode overlays (five
`fidelity:` values), to test Claude Code **skills**
the way Cowork runs them. It is a *fidelity fixture*, not the Desktop runtime.

**Architecture — route a change to the right seam:** `AgentSession` (the protocol, `src/agent/session.ts`)
→ `Decider` (policy, `src/decide/`) → `Run` (turn loop + `RunRecord`, `src/run/run.ts`). `executeScenario`
(`src/run/execute.ts`) is the library API; `src/cli.ts` is a thin wrapper over it. Don't put policy in the
protocol layer or run-loop bookkeeping in the CLI.

## Build & gates
- **`npm run ci`** (typecheck + build + test) is THE local gate before claiming done. It does **not**
  include `npm run format:check` — run that separately. (CI Stage 1 runs these steps individually rather
  than via `npm run ci`; see [CONTRIBUTING.md](./CONTRIBUTING.md).)
- Tests are **token-free & spawn-free** wherever possible (`cli-json` uses usage-errors + cassette replay).
  Don't add a test that needs a live model or Docker to the default suite; that's the `pytest -m cowork` /
  `npm run test:live` lane. Python fast lane (from `python/`): `pytest -m 'not cowork'`.
- CLI binary `cowork-harness`; env vars `COWORK_HARNESS_*` (+ `COWORK_AGENT_BINARY` / `COWORK_AGENT_IMAGE`).
  Node ≥ 20.
- `cowork-harness sync` is **local-only** (needs Desktop + `app.asar`; not on CI). The committed
  `baselines/*.json` are CI's source of truth — never hand-edit release facts into source; they come from
  `sync` (see `docs/maintenance.md`).
- **`cowork-harness lint` exit 127 is a hard failure** (python3 not installed — PyYAML is bundled, so it's
  never the cause). CI scripts MUST NOT swallow this exit code — treat it as a missing gate, not a vacuous pass.

## Invariants — do NOT break (each one cost a real bug)
> Full index (enforcement + test anchors for every invariant, including the CI-grep-only ones not
> repeated below): [docs/invariants.md](docs/invariants.md).

- **AskUserQuestion answer shape.** `serializeDecision` (`src/agent/session.ts`) MUST emit
  `updatedInput: { questions, answers }` — never `{ answers }` alone. The in-VM binary's handler does
  `questions.map(...)`; dropping `questions` throws `q.map`, the answer never reaches the model, and
  gate-steering silently no-ops (the O7 bug). ELF-verified; a regression test pins it.
- **"profile" is retired vocabulary.** Synced release ground truth = **`PlatformBaseline`** (`baseline:` /
  `baselines/`); authored setup = **`SessionConfig`** (`session:` / `sessions/`). The `profile:`
  scenario key is retired vocabulary — the alias is gone and it is now rejected as an unknown key — do
  not reintroduce the term.
- **A new assertion must pick its replay class.** *Content* assertions (read only `ctx.transcript` / the
  record) go in `src/run/cassette.ts` `contentKeys` so they run on the token-free `replay` PR gate;
  *filesystem / egress* assertions do NOT — they are excluded **by omission** from `contentKeys`, so they
  only run on live (non-replay) gates. `contentKeys` is the single source of truth; the README's "what
  replay checks" prose just describes it. The wrong choice is a **silent no-op in CI**.
- **`replay` consumes `controlOut` and re-serializes via `serializeDecision` to guard the AskUserQuestion
  answer shape (O7) on the token-free lane. A new decision *kind* must extend BOTH `serializeDecision`
  AND `deserializeDecision` (declared inverses in `src/agent/session.ts`) — they must not drift.**
- **`evaluate()` (`src/assert.ts`) is synchronous on purpose.** No model-call / LLM-judge assertion without
  an explicit async-refactor decision — it would also break determinism and the replay lane.
- **Answer paths are orthogonal** — scripted (`--answer` / `--answer-policy`), `--decider-llm`,
  `--decider-cmd` (any spawned shell helper — a Python `serve_decider` adapter is one option), `--decider-dir` (+ `gates` / `answer` + a Monitor), and policies
  `fail | first | prompt`. The LLM decider has two spellings — `--decider-llm` on the CLI and
  `on_unanswered: llm` in scenario YAML (same mechanism); the bare `--on-unanswered llm` CLI flag is
  rejected (redirects to `--decider-llm`) to keep deciders in the `--decider-*` family. Don't reintroduce overlap
  (the legacy stdio channel was deliberately removed).

## Ethos — decide by these
- **Binary-verify, don't infer.** Anything mirroring Cowork (spawn env, egress allowlist, GrowthBook gates,
  the AskUserQuestion shape) is verified against the in-VM ELF / `app.asar` and **cited in the change**. Pin
  the gate value / the exact string; don't guess from behavior.
- **Determinism is the value of `run`.** Scripted answers + `fail`; `run` rejects `prompt`; LLM / in-band
  answering flags the run `nonDeterministic`. Don't add non-determinism to the `run` path casually.
- **"✓ success ≠ correct" — no silent false-greens.** Anything that can silently no-op (skip on replay,
  default-answer a gate, an empty allowlist from a failed `sync`) MUST be loud about it. This is the
  project's core principle.

## Pointers
- Reference, don't duplicate here: `SPEC.md` (the authoritative contract), `docs/{scenario,session,boundary,
  maintenance}.md`, `DESIGN.md`.
- Authoring scenario/session YAML: the JSON Schemas in `schema/` describe every field.

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
- CLI binary `cowork-harness`; env vars `COWORK_HARNESS_*` (+ `COWORK_AGENT_BINARY` / `COWORK_AGENT_IMAGE`) —
  see the CLI guide's [Reproducibility knobs](./docs/cli.md#reproducibility-knobs) for the full env-var list.
  Node ≥ 22.
- `cowork-harness sync` is **local-only** (needs Desktop + `app.asar`; not on CI). The committed
  `baselines/*.json` are CI's source of truth — never hand-edit release facts into source; they come from
  `sync` (see `docs/maintenance.md`).
- **`cowork-harness lint` exit 127 is a hard failure** (python3 not installed — PyYAML is bundled, so it's
  never the cause). CI scripts MUST NOT swallow this exit code — treat it as a missing gate, not a vacuous pass.

## Traps — the tooling will mislead you (each one cost real agent-hours)

These are not invariants to preserve; they are places where a **reasonable default assumption is wrong
here**, and the failure is silent. Every one below was hit by an agent working in this repo.

- **`docs/internal/` is gitignored — `git status` / `git diff` are BLIND to it.** Verify work in that
  directory on the filesystem (mtimes, content), never via git. (An agent once concluded a completed
  154-file audit "hadn't run" because git reported a clean tree.) The same applies to `.env` and anything
  else in `.git/info/exclude`.
- **`npm test` does NOT typecheck.** It is `vitest run`, which strips types. **`tsconfig.json` includes
  only `src`** — test files are typechecked *solely* by `tsconfig.test.json`, i.e. only via
  **`npm run typecheck`** (which `npm run ci` runs). Consequence: a missing import in `src` does not fail
  `npm test`; it becomes a runtime `ReferenceError`, and if it lands inside a `catch` it becomes **silently
  wrong data** rather than a crash. After editing `src/`, run `npm run typecheck`, not just `npm test`.
- **Deriving anything that can throw belongs OUTSIDE a nearby broad `catch`.** Several best-effort blocks
  (`try { readdirSync(...) } catch { /* no dir — fine */ }`) will happily swallow a *different* exception
  and report an empty result. Fail-loud contracts (e.g. `gitTrackedSet`'s deliberate throw) are defeated by
  being called from inside one.
- **Token resolution has an `<install>/.env` fallback** (`src/cli.ts`, `dist/cli.js` → `../.env`), so
  running the CLI from *any* cwd still picks up **this repo's** `.env`. Scrubbing `process.env` and
  `cd`-ing elsewhere is NOT enough to test an unauthenticated path — only a packed install
  (`npm pack` + `npm i ./tgz`) isolates it. (Two live auth experiments "passed" against a token the author
  believed was removed.)
- **Only two `schema/*.json` are generated.** `npm run schema` writes `scenario.schema.json` +
  `session.schema.json` (+ the skill's `assertion-keys.json`). **Everything else in `schema/` is
  hand-maintained** — `cassette.v*.json`, `run-result.json`, `doctor.json`, `protocol.v1.json`,
  `critique-report.json`, `verify-cassettes.json`, `regrade.json`, `schedule-cost.json`. Adding a field to those means editing the TS type **and**
  the JSON by hand; nothing syncs them. Then regenerate the surface baseline (below).
- **Surface-baseline ordering:** edit the schema → `npm run check:surface` (review the diff, expect
  `+N -0 ~0`) → `npm run gen:surface` → `check:surface` again (now `+0 -0 ~0`). Running `gen:surface`
  first hides the very diff you were supposed to review.
- **A `RunResult` field is a 5-call-site change.** `assembleRunResult` has **5** call sites across
  `assemble-run-result.ts` / `execute.ts` / `cassette.ts` / `chat-result.ts`, plus the TS type, the
  hand-maintained `schema/run-result.json`, and 2 fixtures. `CompleteRunResult` makes every key
  mandatory-to-supply, so a new key touches all of them. Grep the count fresh — it has changed twice.
- **Some types lie at the seam.** `Cassette.events` is declared `string[]` but arrives `undefined` from
  several `computeStaleness` callers; partially-constructed cassettes are normal in tests and in the
  staleness path. Guard structurally (`Array.isArray`) rather than trusting the declaration.
- **Guards cover machine-readable structure, not prose.** `surface-contract` snapshots
  `schemas`/`action`/`env`; `skill-docs-sync` covers the assertion-key catalog and top-level cassette
  fields. Nothing checks that a new **CLI flag**, **message**, **behaviour**, or **version coupling** is
  documented anywhere a consumer reads. If your change is one of those, the docs are on you — see the
  release checklist in [RELEASING.md](./RELEASING.md).

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
  record) go in one of `src/run/cassette.ts`'s exported buckets — `ALWAYS_CONTENT_KEYS`, `QUESTION_GATE_KEYS`,
  or `MANIFEST_KEYS` — so they run on the token-free `replay` PR gate; *filesystem / egress* assertions go
  in `LIVE_ONLY_KEYS` instead, so they only run on live (non-replay) gates. These four exported constants
  are the single source of truth; the README's "what replay checks" prose just describes them. The wrong
  bucket is a **silent no-op in CI**.
- **A new scenario key must pick its cassette version.** `KEY_REQUIRED_VERSION` (`src/run/cassette.ts`)
  needs an entry for it (a coverage test enforces that), and the entry has to be RIGHT, which no test can
  check: if an older CLI would read a cassette carrying this key's value and reach a different verdict,
  return the new cassette version for that value (value-aware, like `lane: "remote"` → 11). Only a value
  that means what an older CLI already does may return `0`. A `0` is what makes an older `replay` ignore the
  frozen key; a meaning-changing key mis-tagged `0` is a silent false green on every older runner.
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

- **A recorded transcript's non-assistant/user lines are never committed.** A real run's transcripts carry
  agent-binary text that is not ours to publish (the built-in sub-agent prompt in a `prompt_snapshot`
  attachment, tool and agent listings, the sub-agent hand-back frame). A committed `.jsonl` fixture keeps its
  `assistant`/`user` lines only; `test/fixture-transcript-guard.test.ts` and the pre-commit hook enforce it.

## Parallel sessions — one worktree each

Two agents in ONE checkout share a HEAD: every `git checkout` moves it for both. **This fails silently.**
Nothing errors — your rebase just gets harder, because the base moved. Measured in one session: `main`
advanced under an in-flight rebase three times (`3a2f994` → `bc394b9` → `75bc440`), producing one real
`CHANGELOG.md` conflict and a `--contains` false negative that nearly justified a `reset --hard` over
commits that looked orphaned but weren't.

**The convention:**

- The **primary checkout stays on `main`** and is the integration point. Do no feature work there.
- Each session gets its own worktree: `git worktree add .worktrees/<name> -b <branch>`. `.worktrees/` is
  already gitignored (`.gitignore`) and excluded from test discovery (`vitest.config.ts`).
- **Land with `git merge --ff-only <branch>`, run IN the primary.** Rebase your branch onto `main` first
  so the merge is a strict fast-forward — no merge commit, no rebase during the merge, nothing to
  mis-resolve.

**Do NOT use the ref-update trick (`git fetch . <branch>:main`) under this convention.** It works only
while the target branch is checked out NOWHERE, and here the primary permanently holds `main`:

```
fatal: refusing to fetch into branch 'refs/heads/main' checked out at '…/cowork-harness'
```

(Both paths verified: the fetch succeeds into an unchecked-out branch and fails the moment a worktree
holds it; `merge --ff-only` succeeds in the holding worktree.) The ref-update is still the right tool for
the narrow case of advancing a branch nobody has checked out — it just cannot be the standard path.

**Why the split is the real fix:** a ref-update protects the *other* session's HEAD but does nothing for
`main` itself, so the base can still move under an in-flight rebase. Separate worktrees fix that half.

**Two one-time costs per worktree**, both benign: no `./.env` (use `--dotenv <primary>/.env` — `doctor`
detects this and prints the remedy, see `docs/gotchas.md`), and no `node_modules` — run **`npm ci`**.

**Do NOT symlink `node_modules` from the primary** to skip that install. `.gitignore`'s first line is
`node_modules/` — with a trailing slash, so it matches a *directory* only. A symlink is not a directory to
git, so it shows up as `?? node_modules` and breaks every clean-tree gate, `npm run preflight` included.
Verified both ways: a real `node_modules/` directory is correctly ignored; a symlink is not.

**Structural safety, not just etiquette:** git refuses to check out `main` in a second worktree
(`fatal: 'main' is already used by worktree at …`), so the integration branch cannot be double-held by
accident.

## Advisory design — the rules an emitted note/warning must satisfy

Added after 1.11.0 shipped an advisory that violated all three in the same release it fixed another one.

- **Actionable by construction, or aggregated.** An advisory that fires on every item is noise. If the
  tool cannot tell the applicable case from the inapplicable one, it must **aggregate to one line per run**
  (`N/M cassettes — <reason>`), not repeat a constant string per item. Precedent: the skill-hash hint
  (once per process) and the staleness notes (one summary per kind, `cmdReplay`).
- **Severity tracks ACTIONABILITY, not novelty.** `notes` are non-gating by construction ⇒ `::notice::`.
  `findings` gate ⇒ `::warning::`/failure. Getting this backwards makes a self-described-harmless line
  outrank the actionable one beside it on a CI annotation surface — which is exactly what shipped in
  1.11.0, against a comment that claimed otherwise.
- **"harmless otherwise" in an advisory's own text is a DESIGN SMELL.** It concedes the tool cannot
  distinguish the two cases. Either teach it to, or aggregate. Do not ship the concession.

Corollary: `warn()` (`src/io.ts`) auto-prefixes `::warning::` for an unprefixed message. If you mean
`::notice::`, say so explicitly — a comment claiming "plain-info" does not make it so.

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

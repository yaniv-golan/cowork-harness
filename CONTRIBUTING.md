# Contributing

Thanks for helping make Cowork skill-testing reproducible.

For the full documentation map, see [docs/README.md](./docs/README.md). Read [AGENTS.md](./AGENTS.md) —
the canonical agent/architecture contract (architecture seams, invariants) — before changing code.

## Development setup

```bash
npm ci
npm run format:check  # prettier over src/ + test/ .ts — the most common first-pass CI red
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run build         # -> dist/
npm run ci            # typecheck + build + test — the core TS gate (CI's `build` + `test` jobs run more; see below)
```

Before pushing: `npm run format:check` and `npm run ci` (see RELEASING.md's release checklist for the full pre-tag list).

Node ≥ 22. The project is ESM TypeScript; no transpiler magic — `tsc` only.

Extra prerequisites for specific stages:

- **python3** — required for `cowork-harness lint` (the scenario linter shells out to `python3`; it hard-fails with exit `127` when `python3` is missing). PyYAML is **bundled** with the linter — no separate install.
- **Docker (arm64)** — required for `boundary-check` and the **L1 `container`** + `hostloop` fidelity tiers (the container sandbox + agent image). **`hostloop` additionally needs a staged native macOS agent binary** (its agent loop is a host process, not a container one), so Docker alone is not enough for it and a Linux box cannot run it — see README Prerequisites.
- **Lima (`limactl`, macOS arm64)** — required only for the **L2 `microvm`** tier and the `vm` commands; the guest runs on Apple Virtualization.framework (`vmType: vz`). `microvm` does **not** use Docker. (`cowork-harness doctor --tier microvm` checks for Lima, not Docker.)

CI Stage 1 (the `build` job in `.github/workflows/ci.yml`) does **not** invoke `npm run ci`. It runs the
gate steps individually — e.g. `check:versions`, `check:skill-doc-links`, `format:check`, `typecheck`, `build`, a CLI smoke
(`node dist/cli.js list`), three token-free `replay` gate fixtures, `verify-cassettes`, `lint`, and
source-guard checks — while the unit suite runs separately as the 4-shard `test` job (see `ci.yml` for
the authoritative list). `npm run ci` runs in the `floor` job (on Node 22), in `release.yml`, and as
`prepublishOnly`. For a copy-paste GitHub Actions setup,
see [ci-recipe.md](./.claude/skills/cowork-harness/references/ci-recipe.md).

> **Cutting a release?** See [RELEASING.md](./RELEASING.md) for the branch → PR → tag → publish flow.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Project layout

```
src/
  cli.ts              command entry — thin wrapper over executeScenario (run / skill / sync / list / decide / …)
  types.ts            PlatformBaseline + Scenario zod schemas
  session.ts          SessionConfig schema + buildLaunchPlan
  baseline.ts         parity-baseline loader
  agent/              AgentSession — the stream-json control protocol (session.ts)
  decide/             Decider — answer policy (scripted / LLM / external-channel deciders)
  run/                Run — turn loop + RunRecord (run.ts); executeScenario (execute.ts); cassette replay
  runtime/            protocol (L0) / container (L1) / microvm (L2) / hostloop / lima
  hostloop/           Cowork host-loop handlers — can_use_tool gate, web_fetch dedup, workspace/path hooks
  critique/           critique — run a skill, then grade its self-report against a frozen run record
  staging/            agent-binary resolution + mount naming for the sandboxed live tiers
  egress/             default-deny allowlist proxy
  boundary.ts         sandbox self-test probes
  assert.ts           synchronous assertion evaluator
  sync/               cowork-sync — derive platform baselines from the live app
  prompt/ prompt.ts   system-prompt assembly (Cowork append, sub-agent append)
  redact.ts scan.ts   cassette redaction + the privacy scan behind `verify-cassettes`
test/                 vitest unit tests
  fixtures/           unit-test fixtures
baselines/             committed platform baselines (one per Desktop release)
examples/             user-facing worked examples (CI-verified): scenarios/ sessions/ skills/ data/
e2e/                  the harness's own fidelity self-tests: scenarios/ sessions/
fixtures/             harness runtime fixtures (protocol/ golden control-response vectors)
docs/                 guides + references (docs/internal/ is gitignored — never cite it from shipped files)
schema/                published JSON schemas; scenario.schema.json is GENERATED (`npm run schema`)
python/                the `cowork` pytest-lane helper package (its own README + tests)
docker/                Dockerfile.agent — the core/full-parity agent images
scripts/               release + drift checkers (check:versions, check:claims, check:surface, …)
action.yml             the packaged GitHub Action (docs/ci.md is its README)
.claude/skills/        the companion skill that ships to the plugin marketplace
.githooks/             pre-commit cassette gate (wired by `npm install`)
```

Paths inside a scenario/session resolve relative to that file (see [docs/session.md](./docs/session.md#path-expansion)), so each `examples/`/`e2e/` bundle is self-contained.

## Guidelines

- **Keep the seam.** Release-specific facts belong in `baselines/*.json` (synced), not in code. See [docs/maintenance.md](./docs/maintenance.md).
- **Don't weaken the boundary.** Changes to `src/runtime/container.ts`, `src/egress/sidecar.ts` (the live per-run network/egress enforcer — `docker/compose.yml` is a standalone reference shape only, not invoked), or `docker/compose.yml` must keep the default-deny network + sealed FS. Run `cowork-harness boundary-check` and add/adjust a probe in `src/boundary.ts` if you change the model.
- **Mark unverified code.** Anything not yet run end-to-end against a live agent gets a `// UNVERIFIED` comment so reviewers know.
- **Add a test.** New schema fields, `Decider` rules, or egress logic need a unit test in `test/`. Examples must validate (`test/examples.test.ts`).
- **Consumer-visible workflow changes update the skill.** A change a scenario author would act on — a new assertion key, cassette field, CLI command, or a changed record/replay/verify workflow — must land with a matching update to `.claude/skills/cowork-harness/` (SKILL.md or `references/`). The machine-checkable slices are enforced (`test/skill-docs-sync.test.ts` pins the skill against the assertion-key catalog and the cassette schema's field list; `test/cli-help.test.ts` pins the `docs/cli.md` command table); prose workflows are on you — this checklist line exists because `effectiveFidelity` shipped consumer-visible and stayed undocumented in the skill until an external consumer flagged it.
- **Typecheck.** `npm test` is `vitest run` — it strips types and does **not** typecheck. `tsconfig.json` covers only `src`; test files are typechecked solely by `tsconfig.test.json`, i.e. only via `npm run typecheck` (which `npm run ci` runs). After editing `src/`, run `npm run typecheck`, not just `npm test`.
- **Format.** `npm run format:check` must pass (`npm run format:write` to fix).

## Validating a companion-skill edit (answer quality)

A behavioral change to `.claude/skills/cowork-harness/` (a SKILL.md refactor, a moved reference) can quietly make the *advice* worse without failing any deterministic test. Two dev instruments over `test/evals/` (live, real money — not part of `npm run ci`, never gate a PR) catch that:

- `npm run eval-gate -- --rebaseline --dotenv .env` records a per-claim pass-rate baseline; `-- --calibrate` tags which claims the skill actually drives (skill-ablation); then a plain `npm run eval-gate -- --dotenv .env` gates a candidate edit with a per-claim Fisher-exact test and refuses to diff across a judge/answerer model change. Commit `test/evals/baseline/profile.json` when you intend to move the baseline.
- `npm run skill-critique -- <skill-dir> --prompt "…" --dotenv .env` surfaces triaged, evidence-grounded improvement *ideas* for a skill (it never edits anything, always exits 0) — a discovery aid, not a gate.

## Extending the sync extractor

When a Desktop release moves something `sync` doesn't read, it reports an `unknown delta`. Extend `src/sync/cowork-sync.ts` to parse the new shape, add the field to the baseline, and note it in the CHANGELOG.

## Commit & PR

- **A pre-commit hook gates cassettes, and it fails CLOSED.** `npm install` points `core.hooksPath` at
  `.githooks/`. Staging a `baselines/desktop-*.json`, any `*.cassette.json`, or any `.json` whose staged
  content carries the `"generator": "cowork-harness"` marker runs `verify-cassettes` — and **anything that
  is not a proven clean exit `0` blocks the commit**, including a missing `dist/cli.js`. That last one
  catches people out: `npm run build` does `rm -rf dist` first, so a tree with a failing typecheck has no
  built CLI at all. Run `npm run build` and re-commit. The check is scoped to commits that stage one of
  those files, so an ordinary source commit is unaffected.

  It is deliberately strict because for a maintainer it is the *only* pre-publication gate: CI triggers on
  `push: [main]` and `pull_request`, but the local flow lands with `merge --ff-only` and pushes afterwards,
  so by the time CI reds, a leaked recording is already in public history. `git commit --no-verify`
  bypasses it — if you need that for anything other than a broken hook, say so in the PR.
- Conventional, imperative commit subjects (`add …`, `fix …`, `parity: sync to <ver>`).
- Open PRs against `main`. CI runs the pipeline tabled under [This repo's own CI pipeline](#this-repos-own-ci-pipeline) on every PR, forks included (no secrets needed), except `live-key` and `scenarios`, which are skipped on a fork PR; live scenarios run only on same-repo PRs/pushes with `ANTHROPIC_API_KEY` set.
- **Which stages actually block a merge is narrower than the pipeline.** The branch ruleset requires two status *contexts*, not jobs: `typecheck · test · build`, which the `ci-green` aggregator carries (`needs: [build, test, floor, image-recipe, metric-runtimes]`), and `pytest helper lane (-m 'not cowork')`, which is the `python` job's name. So `action-self-test`, `boundary`, `live-key`, `scenarios`, and `parity-drift` run and report but do **not** gate. Read a red one as a real signal anyway: `boundary` in particular is the secrets-free proof that the sandbox enforces Cowork's limits.
- Describe *what changed and why*; link issues.

## Reporting issues

Use the issue templates. For anything security/sandbox related, see [SECURITY.md](./SECURITY.md).

## This repo's own CI pipeline

Contributor-facing. For *consuming* the harness in your own CI — the token-free gate and the packaged
Action — see [docs/ci.md](./docs/ci.md).

The provided [GitHub Actions workflow](https://github.com/yaniv-golan/cowork-harness/blob/main/.github/workflows/ci.yml) runs the pipeline below, one row per job. The **build** + **test** stages are the token-free gate you can copy into your skill repo; the rest are this repo's own fidelity self-tests and CI plumbing, and are not directly portable (they build the harness's Docker image and run harness-specific e2e scenarios — see [`ci-recipe.md`](./.claude/skills/cowork-harness/references/ci-recipe.md) for the skill-repo template):

| Stage | Runs | Needs | Gates |
|---|---|---|---|
| **build** | format check · version-lockstep guard · typecheck · source guards · build · CLI smoke · token-free `replay` · `verify-cassettes` · `lint` | nothing | every push/PR |
| **test** | the unit suite (vitest), sharded 4-way | nothing | every push/PR |
| **floor** | the unit suite once, unsharded, on Node 22 — the version `engines.node` declares — so the floor is exercised rather than asserted (other jobs run Node 24, the Active LTS line) | nothing | every push/PR; gates the merge context |
| **metric-runtimes** | the command-metric runtimes at their floors: every shipped Python metric file compiles on 3.9, the Python runner's audit hook and the closure tests run on 3.9, and the Node permission tests run on 22.12 (the `--experimental-permission` branch) | nothing | every push/PR; gates the merge context |
| **action-self-test** | packs this commit and runs the packaged `uses: ./` Action across its full case set — pass (committed example cassette), usage-error fail (nonexistent path), assertion fail (checks the reporter renders a ❌ row), `lint`, and `analyze-skill`; `ci.yml` currently runs the packaged action **5** times (3 × `replay`, then `lint` and `analyze-skill`) — count the `with: command:` keys, not a bare `grep -c 'command:'`, which also matches step names and log strings | nothing | every push/PR |
| **python** | `pytest` helper self-checks (`python/`, run with `-m 'not cowork'` — the token-free subset; the Docker/token `@pytest.mark.cowork` tests are excluded) | nothing (token-free assertions only) | every push/PR; gates the merge (its job name is the second required context) |
| **boundary** | pulls the agent image at the digest `docker/agent-image.json` pins (a fork without package read builds it locally instead), runs `boundary-check`, builds the device image's delete-shim stage with `-Werror` and runs `test/device-shim.test.ts` with `CWH_REQUIRE_DOCKER=1` (so a missing Docker fails rather than skips), then `npm run test:live` (live contract tests that guard the binary-resolution assumptions, no token needed on this runner) | Docker, arm64 runner | proves the sandbox enforces Cowork's limits — **no API key** |
| **image-recipe** | compiles `docker/Dockerfile.agent` in **both** variants (lean/core and `COWORK_FULL_PARITY=1`) on an arm64 runner, so a recipe change cannot reach the merge gate uncompiled | Docker, arm64 runner | every push/PR; gates the merge context |
| **live-key** | checks whether an `ANTHROPIC_API_KEY` secret is available and hands the answer to `scenarios`; the key itself never leaves the step. Always succeeds; without a key it warns and writes a "not live-validated" step summary, since a skipped job cannot print anything | nothing | skipped on fork PRs; not in `ci-green`'s `needs:` list, so it does not gate |
| **scenarios** | the live scenario suite (mixed `protocol` + `container` fidelity across `examples/scenarios/`), plus the `e2e/scenarios/*.yaml` smoke set (this repo's own L0/L1/hostloop self-tests, `microvm` excluded — needs a real VM); uploads transcripts/egress logs as artifacts; relies on a runner-local staged agent binary (no in-workflow download step). | `ANTHROPIC_API_KEY` | skipped as a whole job whenever `live-key` finds no key, fork PRs included, so a key-less run shows as skipped, never green; not in `ci-green`'s `needs:` list |
| **parity-drift** | reminder to re-`sync` when Desktop updates | nothing | **goes red** if the newest committed baseline is &gt; 90 days old, but sits outside `ci-green`'s `needs:` list, so a red run does not block a merge |
| **ci-green** | the aggregator that carries the `typecheck · test · build` status context the branch ruleset requires; it runs after `build`, `test`, `floor`, `image-recipe` and `metric-runtimes` (`needs: [build, test, floor, image-recipe, metric-runtimes]`) | nothing | green only when all five pass; gates the merge |

This ordering means cheap checks fail fast, the **boundary parity gate runs without secrets** (so forks get it too), and expensive live runs only happen when a key is present.


## The harness's own suite

```bash
npm run ci            # typecheck + build + test (run format:check separately; NOT the same set as CI's `build` job — see CONTRIBUTING.md)
npm test              # vitest: decider, egress allowlist, launch plan, example validation
cowork-harness boundary-check   # self-verify the sandbox (needs Docker; not part of `npm run ci`)
```

Unit tests cover the scripted-answer logic, the egress allowlist matcher, the session→launch-plan materialization (mounts + discovery settings + env-strip), and a **schema guard** that fails if any shipped baseline/session/scenario stops validating. Add a test alongside any new schema field or `Decider` rule.

> Copy your starting scenarios/sessions from **`examples/`**. The **`e2e/`** directory is the harness's *own* fidelity self-tests (smoke scenarios per tier) — not a template to copy.


# Contributing

Thanks for helping make Cowork skill-testing reproducible.

## Development setup

```bash
npm ci
npm run format:check  # prettier over src/ + test/ .ts — the most common first-pass CI red
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run build         # -> dist/
npm run ci            # typecheck + build + test — the core TS gate (CI's `unit` job runs more; see below)
```

Before pushing: `npm run format:check` and `npm run ci` (see RELEASING.md's release checklist for the full pre-tag list).

Node ≥ 20. The project is ESM TypeScript; no transpiler magic — `tsc` only.

Extra prerequisites for specific stages:

- **python3** — required for `cowork-harness lint` (the scenario linter shells out to `python3`; it hard-fails with exit `127` when `python3` is missing). PyYAML is **bundled** with the linter — no separate install.
- **Docker (arm64)** — required for `boundary-check` and the **L1 `container`** + `hostloop` fidelity tiers (the container sandbox + agent image).
- **Lima (`limactl`, macOS arm64)** — required only for the **L2 `microvm`** tier and the `vm` commands; the guest runs on Apple Virtualization.framework (`vmType: vz`). `microvm` does **not** use Docker. (`cowork-harness doctor --tier microvm` checks for Lima, not Docker.)

CI Stage 1 (the `unit` job in `.github/workflows/ci.yml`) does **not** invoke `npm run ci`. It runs the
gate steps individually — e.g. `check:versions`, `format:check`, `typecheck`, `npm test`, `build`, a CLI
smoke (`node dist/cli.js list`), three token-free `replay` gate fixtures, `verify-cassettes`, `lint`, and
source-guard checks (see `ci.yml` for the authoritative list). Only `release.yml` calls `npm run ci`.

> **Cutting a release?** See [RELEASING.md](./RELEASING.md) for the branch → PR → tag → publish flow.

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
  egress/             default-deny allowlist proxy
  boundary.ts         sandbox self-test probes
  assert.ts           synchronous assertion evaluator
  sync/               cowork-sync — derive platform baselines from the live app
test/                 vitest unit tests
  fixtures/           unit-test fixtures
baselines/             committed platform baselines (one per Desktop release)
examples/             user-facing worked examples (CI-verified): scenarios/ sessions/ skills/ data/
e2e/                  the harness's own fidelity self-tests: scenarios/ sessions/
fixtures/             harness runtime fixtures (e.g. subagent-grants.json)
docs/                 guides + references
```

Paths inside a scenario/session resolve relative to that file (see [docs/session.md](./docs/session.md#path-expansion)), so each `examples/`/`e2e/` bundle is self-contained.

## Guidelines

- **Keep the seam.** Release-specific facts belong in `baselines/*.json` (synced), not in code. See [docs/maintenance.md](./docs/maintenance.md).
- **Don't weaken the boundary.** Changes to `src/runtime/container.ts`, `src/egress/sidecar.ts` (the live per-run network/egress enforcer — `docker/compose.yml` is a standalone reference shape only, not invoked), or `docker/compose.yml` must keep the default-deny network + sealed FS. Run `cowork-harness boundary-check` and add/adjust a probe in `src/boundary.ts` if you change the model.
- **Mark unverified code.** Anything not yet run end-to-end against a live agent gets a `// UNVERIFIED` comment so reviewers know.
- **Add a test.** New schema fields, `Decider` rules, or egress logic need a unit test in `test/`. Examples must validate (`test/examples.test.ts`).
- **Consumer-visible workflow changes update the skill.** A change a scenario author would act on — a new assertion key, cassette field, CLI command, or a changed record/replay/verify workflow — must land with a matching update to `.claude/skills/cowork-harness/` (SKILL.md or `references/`). The machine-checkable slices are enforced (`test/skill-docs-sync.test.ts` pins the skill against the assertion-key catalog and the cassette schema's field list; `test/cli-help.test.ts` pins the README command table); prose workflows are on you — this checklist line exists because `effectiveFidelity` shipped consumer-visible and stayed undocumented in the skill until an external consumer flagged it.
- **Format.** `npm run format:check` must pass (`npx prettier --write "src/**/*.ts" "test/**/*.ts"` to fix).

## Extending the sync extractor

When a Desktop release moves something `sync` doesn't read, it reports an `unknown delta`. Extend `src/sync/cowork-sync.ts` to parse the new shape, add the field to the baseline, and note it in the CHANGELOG.

## Commit & PR

- Conventional, imperative commit subjects (`add …`, `fix …`, `parity: sync to <ver>`).
- Open PRs against `main`. CI runs a six-stage pipeline (`unit`, `action-self-test`, `python`, `boundary`, `scenarios`, `parity-drift` — see `ci.yml`) on every PR including forks (no secrets needed) except `scenarios`; live scenarios only run on same-repo PRs/pushes with `ANTHROPIC_API_KEY` set.
- Describe *what changed and why*; link issues.

## Reporting issues

Use the issue templates. For anything security/sandbox related, see [SECURITY.md](./SECURITY.md).

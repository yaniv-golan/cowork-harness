# Contributing

Thanks for helping make Cowork skill-testing reproducible.

## Development setup

```bash
npm ci
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run build         # -> dist/
npm run ci            # typecheck + build + test
```

Node ≥ 20. The project is ESM TypeScript; no transpiler magic — `tsc` only.

Two extra prerequisites for specific stages:

- **python3 + PyYAML** — required for `cowork-harness lint` (the scenario linter shells out to `python3`; it hard-fails with exit `127` when `python3` is missing).
- **Docker** — required for the `boundary-check` stage and the L1+ container/VM fidelity tiers.

CI Stage 1 (the `unit` job in `.github/workflows/ci.yml`) does **not** invoke `npm run ci`. It
runs those steps individually — `format:check`, `typecheck`, `npm test`, `build` — then a CLI smoke
(`node dist/cli.js list`) and the token-free `replay` gate. Only `release.yml` calls `npm run ci`.

> **Naming:** the repo folder `claude-cowork-headless-emulator`, the npm package + CLI `cowork-harness`,
> and the GitHub repo `yaniv-golan/cowork-harness` all refer to the same project.

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
- **Don't weaken the boundary.** Changes to `runtime/container.ts` or `docker/compose.yml` must keep the default-deny network + sealed FS. Run `cowork-harness boundary-check` and add/adjust a probe in `src/boundary.ts` if you change the model.
- **Mark unverified code.** Anything not yet run end-to-end against a live agent gets a `// UNVERIFIED` comment so reviewers know.
- **Add a test.** New schema fields, `Decider` rules, or egress logic need a unit test in `test/`. Examples must validate (`test/examples.test.ts`).
- **Format.** `npm run format:check` must pass (`npx prettier --write` to fix).

## Extending the sync extractor

When a Desktop release moves something `sync` doesn't read, it reports an `unknown delta`. Extend `src/sync/cowork-sync.ts` to parse the new shape, add the field to the baseline, and note it in the CHANGELOG.

## Commit & PR

- Conventional, imperative commit subjects (`add …`, `fix …`, `parity: sync to <ver>`).
- Open PRs against `main`. CI runs typecheck, tests, build, and (on the repo, not forks) boundary + live scenarios.
- Describe *what changed and why*; link issues.

## Reporting issues

Use the issue templates. For anything security/sandbox related, see [SECURITY.md](./SECURITY.md).

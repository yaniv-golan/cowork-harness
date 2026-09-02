<!-- extraction note: if this page becomes a standalone Action repo README, fix:
     ../.github/… → ./.github/…, repo-relative doc links (./cli.md, ./maintenance.md) → absolute
     https://github.com/yaniv-golan/cowork-harness/blob/main/… URLs, and drop the CONTRIBUTING.md
     pointer (this repo's own CI is not that repo's concern). action.yml is already an absolute URL. -->

# CI / the packaged GitHub Action

Run the harness in CI: the token-free gate you can copy into any skill repo, the packaged GitHub
Action, and the live lane that needs a real model.

- **Running the CLI locally?** → [docs/cli.md](./cli.md)
- **Action inputs and outputs** are canonically documented in [`action.yml`](https://github.com/yaniv-golan/cowork-harness/blob/main/action.yml); this page
  gives the usage-shaped version (which lane to pick, and the snippets to copy).
- **Fidelity tiers** are defined in the [README](../README.md#fidelity-tiers-pick-per-scenario--per-ci-job).

> This page is written to stand alone: it documents the Action as a consumer sees it, not this repo's
> own CI. The harness's own pipeline and contributor suite live in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Testing & CI/CD

The harness is built to *be* your skills' test suite, and it ships with its own. Two layers:

### Your skills' suite

Author scenarios in your own `scenarios/` dir, run the lot, get a non-zero exit on any failure:

```bash
cowork-harness run scenarios/            # your repo's scenarios; runs every *.yaml/*.yml, CI-ready exit code
```


## Packaged GitHub Action

The fastest path to CI: a composite action wrapping the token-free lane, with a PR job-summary reporter.

> **The `uses:` ref pins the Action, not the CLI.** `@main`, `@v1` and a commit SHA all select which
> *Action* runs; which *CLI* it installs is the separate `version:` input below, which defaults to
> `latest`. The two move independently — so a workflow whose `uses:` ref has not changed in months still
> picks up a CLI **major** the moment one is promoted to `latest`. That is not hypothetical: `@v1` points
> at 1.24.0 and has not moved, yet an `@v1` workflow without a `version:` input installs 3.x today.
> **To hold a major, pin the input** — `version: "^3"` for the current major, `"^2"`/`"^1"` to stay on an
> older one — not the `uses:` ref.
>
> Upgrading across the 1.x → 2.x boundary this way means the hash-format epoch: cassettes recorded before
> format v12 need `cowork-harness rehash <dir/>` (no re-record). See the 2.0.0 entry in
> [CHANGELOG.md](../CHANGELOG.md).

```yaml
- uses: yaniv-golan/cowork-harness@v3
  with:
    command: replay              # replay | lint | lint-skill | analyze-skill | verify-cassettes | run
    path: cassettes/my-skill.cassette.json
    version: "^3"                # hold the CLI major; the input defaults to `latest`
    summary: true                # already the default — shown so the CI self-test twin matches verbatim
```

| Lane | Commands | Runner requirements | What you get |
|---|---|---|---|
| **Token-free** (the headline lane) | `replay`, `lint`, `lint-skill`, `analyze-skill`, `verify-cassettes` | any `ubuntu-latest` | deterministic, no Docker, no API key, no agent binary — this is what most skill repos want. `lint`/`lint-skill` are thin passthroughs to the bundled `scenario.py` (python3, preinstalled on `ubuntu-latest`); `analyze-skill` is pure TS (no python3 needed) |
| **Live** (`command: run`) | `run` | Docker + a provisioned agent binary + `anthropic-api-key` input | real inference against a live scenario — the action does **not** provision the agent binary or build the image for you (see [Fidelity tiers](../README.md#fidelity-tiers-pick-per-scenario--per-ci-job) and the agent-binary provenance runbook in [`docs/maintenance.md`](./maintenance.md)); this is for a self-hosted runner that already has both staged, not a stock GitHub-hosted runner |

**Live lane, by design not oversight:** the action never downloads or stages the agent ELF itself.
Pulling Anthropic's binary is a call about your own relationship with their distribution terms, so it
stays a step in *your* workflow, not something a third-party action automates for you. A self-hosted-runner
example:

```yaml
jobs:
  live:
    runs-on: [self-hosted, linux, arm64]   # needs Docker + the ELF staged below; not stock GitHub-hosted
    steps:
      - uses: actions/checkout@v4
      - name: Stage the agent binary (official channel, sha256-verified — see docs/maintenance.md)
        run: |
          V=2.1.255   # match your scenario's pinned baseline's agentVersion
          # The expected digest is baselines/desktop-<ver>.json -> agentBinary.sha256. Paste it here,
          # or read it with jq if you vendor the baseline. An unverified download is an unverified
          # agent: this step FAILS rather than staging one, which is the point of calling it verified.
          EXPECTED=<paste agentBinary.sha256 for $V>
          curl -fSL "https://downloads.claude.ai/claude-code-releases/$V/linux-arm64/claude" -o "$RUNNER_TEMP/claude-$V"
          echo "$EXPECTED  $RUNNER_TEMP/claude-$V" | sha256sum -c -
          chmod +x "$RUNNER_TEMP/claude-$V"
          echo "COWORK_AGENT_BINARY=$RUNNER_TEMP/claude-$V" >> "$GITHUB_ENV"
      - uses: yaniv-golan/cowork-harness@v3
        with:
          command: run
          path: scenarios/
          version: "^3"
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Every run writes a Markdown verdict table (scenario, pass/fail, signals, cost/turns when available, staleness findings, and the replay-skipped-assertions honesty line) to the job summary. Inputs: `command`, `path` (required), `version` (npm dist-tag/version, default `latest` — the recipes above pin `^3` instead, because leaving it at `latest` takes a CLI major the moment it is promoted even though your `uses:` ref never changed; pin an exact version for byte-reproducible CI. The companion skill's `cowork-harness@^3.2.1` floor guidance applies to ad-hoc CLI installs, not this input), `strict` (applies to `replay` (staleness findings), `lint`/`lint-skill` (WARN/INFO), and `analyze-skill` (any **`error`**-severity finding — advisory findings are precisely the class that does NOT gate); IGNORED — not forwarded — for `verify-cassettes`/`run`, which don't accept the flag), `fail-on-skill-drift` (**`replay`-only** — never forwarded to the analyzers), `extra-args`, `summary` (default `true`), `anthropic-api-key` (live lane only). Outputs: `ok` (`"true"`/`"false"`, mirrors the exit code), `envelope-path` (path to the raw JSON envelope, for post-processing), `summary-md` (the rendered verdict table, exposed as an output — not just written to `$GITHUB_STEP_SUMMARY` — because that file is scoped to this action's own invocation and a caller's later step gets a fresh, empty one). See [`action.yml`](https://github.com/yaniv-golan/cowork-harness/blob/main/action.yml) for the full input/output reference.

CI uses `ANTHROPIC_API_KEY` specifically because there's no interactive browser available to run
`claude setup-token`'s OAuth flow in a GitHub Actions runner; locally, the OAuth token is preferred because
it mirrors what Desktop itself uses (no separate API-billing setup).

## Versioning: two independent pins

A CI job that uses this Action pins **two different things**, and confusing them is the usual source of
"why did my pipeline change when I didn't touch it".

| Pin | What it selects | Recommended |
|---|---|---|
| the `uses:` ref — `@v3` | which **Action** runs (this repo's composite action + its reporter) | `@v3` — a floating major alias, moved to each release, so you get fixes without editing your workflow |
| the `version:` input | which **CLI** the Action installs from npm | `"^3"` — holds the major. The input's own default is `latest`, which takes a new CLI major the moment it is promoted, even though your `uses:` ref never changed |

`@v3.0` exists too (floating minor), and an exact `@v3.0.0` is the maximally reproducible choice. The
same spectrum applies to `version:`: `"^3"` for fixes, an exact `"3.0.0"` for byte-reproducible CI.

> **The Marketplace install box says something different, and both are correct.** GitHub's Marketplace
> listing renders its own auto-generated snippet pinned to the latest *exact release tag* (e.g.
> `@v3.0.0`), shown beside this page's `@v3` guidance. They are not in conflict — they are two points on
> the same pinning spectrum. `@v3` auto-adopts patch and minor fixes and is right for most consumers;
> the exact tag never moves and is right for security-sensitive or audit-bound pipelines.

The Action's inputs and outputs are a semver-covered surface — see [SPEC.md](https://github.com/yaniv-golan/cowork-harness/blob/main/SPEC.md) §12.


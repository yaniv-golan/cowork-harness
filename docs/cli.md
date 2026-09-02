# The CLI

Everything you need to run `cowork-harness` locally: install, prerequisites, the commands, the two
files you author, what a run leaves on disk, and the environment knobs.

New here? [README](../README.md) is the router across the three ways to use this project (CLI,
companion skill, CI). This page is the CLI one.

- **Fidelity tiers** — defined once in the [README](../README.md#fidelity-tiers-pick-per-scenario--per-ci-job); this page assumes that vocabulary.
- **Scenario / session reference** — [docs/scenario.md](./scenario.md), [docs/session.md](./session.md), [SPEC.md](../SPEC.md).
- **Companion skill** — install and orientation in [docs/companion-skill.md](./companion-skill.md).
- **CI / GitHub Action** — [docs/ci.md](./ci.md).

---

## Quick start

**Install from npm:**

```bash
npm install -g "cowork-harness@^3.3.0"    # puts the `cowork-harness` command on your PATH
```

**Or build from source:**

```bash
git clone https://github.com/yaniv-golan/cowork-harness && cd cowork-harness
npm ci && npm run build && npm link    # puts the `cowork-harness` command on your PATH
# …or skip the link and call it directly: node dist/cli.js <cmd>
```

**Then try it — one line, still no token, no Docker:**

```bash
# From a source checkout — works whether or not you ran `npm link` above:
node dist/cli.js replay examples/replays/example-pdf-skill.cassette.json
```

> **Installed globally instead?** Once linked/installed, the same command is `cowork-harness replay
> <cassette>` — but the relative path above only resolves from a source checkout's `examples/replays/`.
> From a global install (`npm i -g "cowork-harness@^3.3.0"`), point at the package root instead:
> `cowork-harness replay "$(npm root -g)/cowork-harness/examples/replays/example-pdf-skill.cassette.json"`
> (or copy the cassette into your own project and pass that path).

Live `run`/`skill` need the prerequisites in the next section — note the `protocol` tier skips Docker and the staged agent but **still calls a real model** (via the host `claude`), so it needs the auth token.

> **Which path am I on?**
> - **Replay only (zero setup):** `cowork-harness replay <cassette>` — no token, no Docker, no agent. The command above.
> - **`protocol` (real model, no Docker):** needs only the auth token (item 3 below).
> - **Live `container` / `microvm` / `hostloop` / `cowork`:** needs Docker (or Lima for `microvm`), a staged agent, and the token — run `cowork-harness doctor` first.
> - **Invocation:** from a source checkout, `node dist/cli.js <cmd>` (or `npm link` to get the `cowork-harness` command); from a global install, `cowork-harness <cmd>`; the companion skill falls back to `npx "cowork-harness@^3.3.0"`.

Two more worked examples worth knowing about: `examples/scenarios/protocol-smoke.yaml` (zero-Docker smoke
test) and `examples/scenarios/skill-loads.yaml` (container-tier acceptance check) — see
[examples/README.md](../examples/README.md).

> **Testing a local skill folder?** Untracked files are invisible to the mount (`git add` them first) — see
> [Test a local skill in one command](#test-a-local-skill-in-one-command) below for why.


## Prerequisites for anything above `protocol` fidelity

(The `protocol` tier skips items 1–2 — no Docker, no staged agent — but still calls a real model via the host `claude`, so it needs item 3, the auth token; only a committed-cassette `replay` needs nothing at all):

**Platform × tier support** (live tiers are **arm64-only** — there is no x86_64 container/microvm image):

| Tier | macOS arm64 | Linux arm64 | Windows | Runtime | Token |
|---|---|---|---|---|---|
| `replay` | ✓ | ✓ | ✓ | none | no |
| `protocol` | ✓ | ✓ | ✓ | none | yes |
| `container` | ✓ | ✓ | ✗ | Docker | yes |
| `microvm` | ✓ | ✗ | ✗ | Lima (Apple-VZ) | yes |
| `hostloop` | ✓ | ✗ | ✗ | Docker + native macOS agent | yes |
| `cowork` | ✓ | ✗ | ✗ | Docker + native macOS agent | yes |

So **Linux live == `container` only**: `microvm` is Apple-VZ (macOS), and `hostloop`/`cowork` need the native macOS agent binary. Linux `container` needs a staged Linux **ELF** agent (see the CI recipe below + [docs/maintenance.md](./maintenance.md)); Windows is `replay`/`protocol` only.

1. **Claude Desktop, opened once.** The Cowork agent binary is **bind-mounted from your own install** at run time — nothing Anthropic-owned is bundled. Open Cowork once so the agent ELF is staged (`…/claude-code-vm/<ver>/claude`); the harness auto-detects it, or set `COWORK_AGENT_BINARY=<path>` to point at it. Without a staged agent, the sandboxed live tiers (container/microvm/hostloop/cowork) fail with "Open Cowork once to stage it…". (`protocol` and a committed-cassette `replay` need no staged agent.) For the `hostloop` tier specifically, a **second, separate native macOS binary** is required (`…/claude-code/<ver>/claude.app/Contents/MacOS/claude` — distinct from the container ELF above); the same "open Cowork once" step stages both, and `cowork-harness doctor --tier hostloop` checks for it explicitly.
2. **A runtime + agent image, matching your tier:**
   - **`container` / `hostloop` (Docker, arm64):**
     ```bash
     # Preferred — the image this release pins, digest-addressed so it cannot drift:
     docker pull ghcr.io/yaniv-golan/cowork-agent-base:2-r1
     docker tag  ghcr.io/yaniv-golan/cowork-agent-base:2-r1 cowork-agent-base:2
     # Or build it yourself (offline / customised). Either way `doctor` will not report it as pinned:
     # with the classic image store a local build has no registry digest at all (freshness = skipped),
     # while with the containerd image store it carries one that cannot match the published pin, so
     # freshness warns "not the digest this harness version pins". Both are warnings, not failures:
     docker build --platform linux/arm64 -t cowork-agent-base:2 -f docker/Dockerfile.agent .
     ```
     This **core** image mirrors the real Cowork rootfs's document/data toolchain (Node 22, openpyxl/pandas/pdf/docx/pptx, …); override the tag with `COWORK_AGENT_IMAGE`. For OCR / LibreOffice / markitdown / opencv / PDF-table skills, use the **full-parity** image instead and point `COWORK_AGENT_IMAGE` at it. It is published and pinned exactly like the core image:
     ```bash
     # Preferred — pinned, so `doctor` can verify it:
     docker pull ghcr.io/yaniv-golan/cowork-agent-full:2-r1
     docker tag  ghcr.io/yaniv-golan/cowork-agent-full:2-r1 cowork-agent-full:2
     # Or build it yourself (same unpinnable caveat as the core image — and note that this variant is
     # the one whose pin check was silently skipped before 1.21.1):
     docker build --platform linux/arm64 --build-arg COWORK_FULL_PARITY=1 -t cowork-agent-full:2 -f docker/Dockerfile.agent .
     ```
     (A run on the core image that uses an omitted capability is flagged with a `missing_capability`
     verdict signal — see [`requires_capabilities`](./scenario.md#declaring-required-capabilities-requires_capabilities)
     in docs/scenario.md, or the `COWORK_SKIP_CAPABILITY_PROBE` var under
     [Reproducibility knobs](#reproducibility-knobs) below.) Both `-f docker/Dockerfile.agent .` paths are **repo-relative** — run from a source checkout, not a global `npm install -g`. On a global install, run `cowork-harness doctor --tier container` instead — it prints the exact `docker build` command with the correct package-local Dockerfile path.
   - **`microvm` (Lima / Apple-VZ, no Docker):**
     ```bash
     brew install lima
     cowork-harness vm init   # one-time: provisions the Lima VM image
     ```
     `cowork-harness doctor --tier microvm` checks for Lima (not Docker) and warns — non-fatally — if `vm init` hasn't run yet (a live run self-provisions on first use, just with extra VM-boot latency).

> The `pytest` lane (`python/README.md`) has its own, slightly different prerequisite list (adds `pytest`
> + package importability) — see there if you're driving tests via `pytest` instead of the CLI directly.
3. **An auth token** — either `export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)` (the `claude setup-token` step needs the **`claude` CLI**: `npm i -g @anthropic-ai/claude-code`) or a **`.env`** file (copy `.env.example` → `.env`; gitignored). `.env.example` lists all three accepted vars — `CLAUDE_CODE_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN` — in that precedence order.
   - **Resolution order:** exported env > `--dotenv <path>` > `./.env` (cwd) > `<install>/.env` (the package root) — so a `npm link`ed install works from any directory. (Use `--dotenv`, not `--env-file` — Node reserves the latter.)
   - **Explicit beats best-effort:** that chain is about *precedence*, not error recovery. A `--dotenv` path you passed explicitly must be readable — if it is missing, unreadable, or a directory, the run stops with a usage error rather than quietly falling through to `./.env` and running against different credentials. The automatic `./.env` / `<install>/.env` locations remain best-effort.
   - **Placement:** keep `.env` at a working-dir or install root, never inside a mounted skill/project folder.
   - **Global install:** find the package root with `` `$(npm root -g)/cowork-harness` `` (e.g. `$(npm root -g)/cowork-harness/.env`) — or simpler, just use `--dotenv <path>` / `./.env` in your working directory, which take priority over the package root anyway.

> `sync` (below) is **optional for a first run** — the repo ships `baselines/desktop-*.json`, so `baseline: latest` already resolves. Run `sync` only to refresh the platform baseline after Claude Desktop updates. (`sync` is **macOS-only** today; on Linux/Windows use the committed baselines — they work cross-platform.)

> **Global install?** The `examples/scenarios/…` paths below all ship, along with the `sessions/`, `skills/` and `data/` they resolve — but a global install puts them under `$(npm root -g)/cowork-harness/`, not in your working directory, so the bare relative paths below need either a source checkout or that prefix. `matrices/`, `answer-policies/` and `probes/` are not published at all. (See the "What ships" table above for the full package contents; `package.json` `files`.)

```bash
# 0. Before the first live run: check prerequisites (Docker, staged agent, token, baseline).
cowork-harness doctor                      # read-only: what's present, what's missing (defaults to --tier container)
cowork-harness doctor --tier container     # same as bare `doctor` above — spell it out, or pick a different tier (microvm/hostloop/cowork)

# 1. (Optional · macOS-only) Sync a platform baseline from your installed Claude Desktop.
#    Skippable on a first run — the repo ships baselines; `baseline: latest` already resolves.
cowork-harness sync            # writes baselines/desktop-<appVersion>.json
cowork-harness sync --diff     # show what changed vs the committed baseline

# 2. Run a scenario (L1 container by default)
cowork-harness run examples/scenarios/example-pdf-skill.yaml   # minimal: plumbing only
cowork-harness run examples/scenarios/csv-metrics.yaml         # worked example: a real skill runs a bundled producer end-to-end
cowork-harness run examples/scenarios/csv-fx-normalize.yaml    # graceful degradation: the skill's network step is blocked, it falls back

# 3. Run every top-level *.yaml scenario (non-recursive; machine-readable results, CI-ready exit code)
cowork-harness run examples/scenarios/ --output-format json

# 4. Record a cassette once, then replay it deterministically (no token, no Docker)
#    (without --out, the cassette is named after the scenario — its `name:`, or the filename)
#    Commit cassettes under examples/replays/ (this repo) or cassettes/ (conventional skill-repo name).
cowork-harness record examples/scenarios/example-pdf-skill.yaml --out examples/replays/example-pdf-skill.cassette.json
cowork-harness replay examples/replays/example-pdf-skill.cassette.json

# Cassettes are COMMITTED fixtures — record against synthetic data, and gate them in CI:
cowork-harness verify-cassettes examples/replays/   # privacy scan (email/currency/domain/path/machine-inventory) + staleness; exit 1 = verified & failed, exit 3 = could not verify

# 5. Lint scenarios before committing (catches silent false-greens in assertion placement)
#    Needs python3 (the linter shells out to the bundled scenario.py; PyYAML is bundled. exit 127 if python3 is missing).
#    NOTE: examples/scenarios/ ships in the SOURCE CHECKOUT only — the npm package carries
#    examples/replays/ but not scenarios/. From an install, point this at your own scenarios/.
cowork-harness lint examples/scenarios/*.yaml --strict --min-severity WARN
#    (non-recursive: this glob skips subdirectory scenarios like examples/scenarios/trigger-accuracy-sweep/;
#    lint that one explicitly if you copy it)
```

> **Privacy:** a cassette snapshots the transcript and the `outputs/` JSON bodies, so it's committed PII
> surface. Record against synthetic inputs; opt into record-time **redaction** with a `.cowork-redact.json`
> (verdict-preserving — `record` refuses to write if redaction would flip an assertion); and gate every
> commit with `verify-cassettes` (the always-on scan, `--allow <regex>` for synthetic/public names). See
> [docs/cassette.md](./cassette.md).

> **What replay checks.** A cassette freezes the WHOLE scenario (`lane:`, `fidelity:`, `baseline:` and the
> rest — not just `assert:`), and a plain `replay` evaluates all of it from that frozen copy; editing the
> YAML cannot change a replay's verdict, and `--assert-from` opts both `assert:` and `expect_denied:` back to
> disk — though `expect_denied:` stays live-only on replay, so it is sourced from disk but never evaluated
> there, only producing a drift warning when it differs from the frozen copy.
> `replay` re-evaluates a scenario's `assert:` against the frozen recording, split
> into four buckets:
>
> | When | Assertions |
> |---|---|
> | Always | `transcript_*`, `tool_*`, `subagent_*`, `no_vm_path_file_op`, `dispatch_count_max`, `skill_triggered`/`no_skill_triggered`, `reference_read`/`no_observed_reference_access`, `max_cost_usd`/`max_tokens`/`tool_calls_max`/`max_turns` (against the *frozen recording's* spend, not fresh spend — a live `run` catches a real budget regression), `max_tool_errors`, `max_redundant_tool_calls`, `skill_available`, `connector_available`, `skill_tool_used`, `compaction_occurred`, `all_tasks_completed`, `task_count_min`, `task_status`, `no_scratchpad_leak`, `present_files_called`, `result`, the verdict modifiers |
> | Only if the cassette carries `controlOut` | `question_asked`, `question_options`, `question_context`, `questions_count_max`, `gate_answers_delivered`, `gate_answer_count_min`, `hook_blocked`, `no_hook_blocked`, `vm_path_denied`, `path_denied`, `no_path_denied` |
> | Only if the cassette carries an `artifacts` manifest | `file_exists`, `artifact_text`, `user_visible_artifact`, `artifact_json`, `computer_links_resolve`, `computer_links_resolve_if_present`, `no_unexpected_files`, `input_unmodified` |
> | Always skipped (live-only) | `file_absent`, `egress_*`, `expect_denied`, `no_delete_in_outputs`, `no_delete_in_mounts`, `self_heal_ran`, `transcript_no_host_path`, `no_mcp_error`, `max_peak_rss_bytes`, `semantic_matches`, `no_lost_write_back` — keep these in a periodic live `run` |
>
> Authoritative list: `ALWAYS_CONTENT_KEYS` / `QUESTION_GATE_KEYS` / `MANIFEST_KEYS` (composed per-replay) / `LIVE_ONLY_KEYS` (excluded) in `src/run/cassette.ts`. Full per-key reference:
> [docs/cassette.md → Assertion table](./cassette.md#assertion-table). Full rules/rationale:
> [docs/scenario.md → Which assertions survive replay](./scenario.md#which-assertions-survive-replay-ci-placement).

**Drive it from pytest** — the `cowork` lane (see [`python/README.md`](../python/README.md)):
`@pytest.mark.cowork` + a `cowork` fixture over the `--output-format json` surface, selectable with
`-m cowork` (opt-in, beside your fast tests).


## Test a local skill in one command

> **First time here?** The commands below assume the `cowork-harness` CLI is installed and a token is set —
> see [Quick start](#quick-start) for both, and run `cowork-harness doctor` to check what's missing. For the
> zero-infra path (no Docker, no token), start with the token-free [`replay` demo](#quick-start).

The fastest path — point at a **local folder**, no repo, no `claude plugin install`, no marketplace, no version bump, no cache layers. The folder is copied **fresh into the session on every run**, so you edit and re-run and your changes are live immediately. (Inside a git repo it stages the **git-tracked** files — the fidelity boundary, since real Cowork installs from a repo and sees only committed files; so `git add` a brand-new skill or it would mount empty (staging is enough for local runs — committing matters only for what you publish). The harness now **hard-fails loudly** on a would-be-empty mount and **notices** excluded untracked files, rather than silently staging nothing — `COWORK_HARNESS_GITSET=0` copies untracked files instead.)

```bash
# Auth once — export it, OR put it in a .env file (resolved: env > --dotenv > ./.env > <install>/.env):
#   cp .env.example .env   &&   echo "CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)" >> .env
export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)

cowork-harness skill ~/my-plugin 'Use my-skill to do X'                    # single-quote: no $ expansion
cowork-harness skill ~/my-plugin --prompt-file ./prompt.txt               # prompt verbatim (raw bytes)
cowork-harness skill ~/my-plugin "..." --answer "which format=Markdown"   # script AskUserQuestion
cowork-harness skill ~/my-plugin "..." --answer-policy policy.yaml        # reusable file of regex→choice rules
cowork-harness skill ~/my-plugin "..." --timeout 300000                  # wall-clock budget in ms; kills the agent on expiry
cowork-harness skill ~/my-plugin "..." --fidelity protocol                # fast, no sandbox (plugin IS delivered; its hooks run natively)
cowork-harness skill ~/my-plugin "..." --dry-run                          # resolve & print the launch plan, don't run
cowork-harness skill ~/my-plugin "..." --output-format json                      # machine-readable result on stdout
cowork-harness skill ~/my-plugin "..." --on-unanswered fail               # never fabricate an answer (CI/agents)
cowork-harness skill ~/my-plugin "..." --decider-cmd 'node answer.js'     # answer LIVE stochastic questions via a helper
cowork-harness skill ~/my-plugin "..." --decider-dir "$(mktemp -d)"       # …or answer them YOURSELF, in-band, while the run is live
#   then, from a second terminal / a Monitor:
#   cowork-harness gates <dir> --follow                       # stream each pending gate as JSON
#   cowork-harness answer <dir> --gate 1 --choose "<label>"   # reply (never hand-write resp-N.json)
#   cowork-harness decide --decider-dir "$(mktemp -d)"        # rehearse that channel in ~2s, no run
cowork-harness skill ~/my-plugin 'review this deck' --upload deck.pdf      # attach a file → mnt/uploads (deck-review etc.)
cowork-harness skill ~/my-plugin "..." --session-id s1                     # pin a session…
cowork-harness skill ~/my-plugin '<next turn>' --session-id s1 --resume    # …then resume it (gated/checkpoint skills)
cowork-harness skill ~/my-plugin "..." --keep                            # keep the run dir, then: trace it
cowork-harness trace <run-id> --view tools                                # tool calls + sub-agent dispatches from events.jsonl
cowork-harness skill --help                                               # full per-command flag reference

cowork-harness chat ~/my-plugin                  # interactive multi-turn REPL (full harness: egress sandbox + control protocol)
# chat --raw  → native interactive cowork mode via `docker run -it` (needs Docker + the arm64
#               cowork-agent-base:2 image; the egress sandbox is NOT applied in --raw)
# chat writes turns/1/result.json (mode:"chat", no pass/fail verdict), so chat sessions appear in `stats`/`trace`/`scaffold`
```

**Input policy — no silent false-greens.** When an AskUserQuestion arrives with no scripted
`--answer`, the policy is explicit: `fail` (error + the exact `--answer` to add, plus a note that a
scenario can instead set `on_unanswered: llm` as a secondary escape valve for a gate whose wording
drifts run-to-run — the default for `run`/CI), `prompt` (ask at the TTY — the default for `skill`
when interactive), or `first` (pick
option 1, loudly warn). Pick with `--on-unanswered`; left unset, `skill` is **adaptive** (`prompt` on
a TTY, `fail` when piped/CI) and `run` is always `fail`.

## Exit codes

**Exit-code space is per-command, not global** — the same number means different things on different
commands, so a CI script branching across commands must not conflate them. [SPEC.md](../SPEC.md) §11 is
the contract; this is the summary.

| Code | `run` / `skill` / `chat` / `record` | `verify-cassettes` | `doctor` | `rehash` |
|---|---|---|---|---|
| `0` | pass — every evaluated assertion passed | clean | all required checks passed | all migrated (or nothing needed it) |
| `1` | assertion or agent failure | verification RAN and found a real problem | a required check failed | nothing migrated, ≥1 could not |
| `2` | usage / unanswered-under-`fail` / runtime | usage | usage | usage |
| `3` | boundary/integrity (a typed `BoundaryError`) | **could not verify** — unrelated to the `run` family's `3` | — | — |
| `4` | *reserved* (a future "needs input" outcome; currently unused) | — | — | **PARTIAL** — some migrated, some could not |

Two footnotes the table cannot carry:

- the `boundary-check` **command**'s own probe failures follow the assertion convention and exit `1` —
  distinct from the `run`-family `3`, which is a typed `BoundaryError` raised *during* a run (SPEC §11);
- `rehash`'s `4` and the `run`/`skill` family's reserved `4` are unrelated. Because the space is
  per-command, `rehash` spending `4` on PARTIAL does not consume that reservation (SPEC §11).

After a run, the footer **echoes every auto-answered
question as a copy-pasteable `--answer "<q>=<choice>"` line** — run once exploratorily, then paste them
back to lock in a deterministic re-run.

**Output.** `skill` renders the agent's work (assistant text + tool calls) plus a metered footer — you
see *what it did*, not just a green; `run` is verdict-first but prints the failing transcript inline on a
`FAIL` (no spelunking `runs/…`). Human-readable output goes to stderr, machine output to stdout, so
`--output-format json` always pipes cleanly; it honors `NO_COLOR` too.

| Flag | Effect |
|---|---|
| `--quiet` | Verdict only |
| `--verbose` | + thinking blocks, tool inputs, sub-agent tree |
| `--compact` | Drops informational `[capability]` notices (the probe + its hard-fail safety net still run), the `[provenance]` banner, **and the `[status] <outDir>` line** (a raw host path) — for shareable screenshots/GIFs. `status.json` is still written, so `cowork-harness status` still works; pass the run-dir root, or use `--session-id`, to locate it |
| `--demo` | `--compact` (including its `[status]` suppression) + hides the `runs →` host-path header (runs still land in the durable location, so `scaffold`/`trace` still work) + collapses `$HOME` → `~` — leaks no host paths |
| `--output-format json` | Stable machine envelope on stdout: `{tool, version, command, ok, results[], error}`; each result carries `verdict: {pass, exitCode, signals[], guards[], failures[]}` so you can read per-result pass/fail **and why** without recomputing; errors are `{ok:false, error:{category,message,hint}}`. This is the shape for the main `results[]`-bearing commands (`run`/`skill`/`record`/`replay`) — several other commands use a dedicated or payload-shaped envelope instead (and some, like `chat`, emit no stdout JSON envelope); see [SPEC §11](../SPEC.md) for the per-command breakdown by envelope family |

**Test a specific local plugin version** — just point at the folder at that version (it's copied fresh — git-tracked files inside a repo; no install, no version bump). Add more with `--plugin`:
```bash
cowork-harness skill ~/my-plugin "..." --plugin ~/other-plugin
```

**Test a specific local marketplace version** — point at the marketplace dir (the one with `.claude-plugin/marketplace.json`) with `--marketplace`, and name what to load with `--enable name@marketplace`; the harness reads its `marketplace.json` and **mounts** the referenced plugins at the Cowork plugin path — the marketplace registry is inert in cowork mode, so there is no `claude plugin marketplace add`, clone, or cache:
```bash
cowork-harness skill --marketplace ~/my-marketplace --enable my-skill@my-marketplace "Use my-skill"
```

It mounts the folder(s) at the Cowork plugin path, runs the staged agent in cowork mode, and prints PASS/RESULT (add `--keep` to print the run dir, or `--output-format json` for the machine-readable result). No YAML to author. (Author `scenarios/*.yaml` only for repeatable, asserted regression tests.)

> **What a `skill`-lane PASS means, and what it doesn't.** An open-ended `skill` run has no `assert:` block, so its PASS says *no guard fired* — the run didn't error, stall, leak a host path, delete in `outputs/`, auto-allow something real Cowork blocks, or hit a capability gap. It does **not** say the skill was invoked, that the answer was right, or which variant you ran. On `run`, the same word additionally means *your assertions held*. When the question is "did my skill actually run?", read `skillsInvoked` / `skillActivity` in `result.json` — see [debugging.md → hunt the false-green](./debugging.md#the-run-was-green-but-you-dont-trust-it--hunt-the-false-green).

---


## Commands at a glance

Skill testing is the headline use, but the tool is a general harness over the Cowork runtime. Run any command with `--help` for its full flag reference.

| Command | What it does | Reach for it when… |
|---|---|---|
| `skill <folder> "<prompt>"` | Run a local skill/plugin folder once against the staged agent; an unanswered gate's `--on-unanswered` defaults adaptively (`prompt` on a TTY, `fail` in CI/non-TTY); `--compact`/`--demo` trim output for shareable screenshots/GIFs; `--ablate-skill` runs **this one invocation** with the skill removed — the control arm of a with/without comparison, not both arms (run it a second time without the flag for the treatment arm; composed with `--repeat N` it produces N *ablated* runs — the rollup's verdict line names the arm, `PASS [ABLATED — control arm] — 5/5 passed`, so a one-armed batch cannot be misread as a finished A/B); `--label <tag>` stamps a generation name for the iterate-across-fixes loop (surfaced in `result.json`/index/`inspect`); `--repeat N` (2-100) runs the same skill+prompt N times and aggregates a variance rollup — "did this finding reproduce, or did it pass once?"; `--allow-missing-capability` stops a capability false-negative on the lean `core` image from failing the verdict (open-ended equivalent of asserting `allow_missing_capability: true`); `--allow-host-writes` consents to a writable `hostloop`-fidelity connected folder (same consent as clicking "connect folder" in Desktop; no effect off `hostloop` or without a writable `--folder`); `--allow-host-hooks` consents to running a staged plugin's hooks as native host processes at `protocol` (L0 passes `--plugin-dir`, so the CLI executes them on your machine with no sandbox — refused loud otherwise; plugins without hooks need no opt-in). The scenario-file equivalent is the top-level `allow_host_hooks: true`, which needs **cowork-harness ≥ 3.0.0** — an older CLI hard-errors `Unrecognized key` (exit 2) rather than defaulting it | ad-hoc "is the skill alive / does it do X?" — the fast inner loop |
| `run <scenario.yaml \| dir/>` | Run authored scenarios with `assert:` + a CI-ready exit code; a decider can answer unscripted gates; `--repeat`/`--matrix` add variance runs / a compatibility matrix (detail below); `--ablate-skill` runs **this one invocation** with the skill removed — the control arm only, not both arms | you want a repeatable, **asserted regression test** — to **measure flakiness** instead of trusting one green — or to **test a compatibility matrix** (multiple baselines/models/skill variants) in one run |
| `chat <folder> [prompt]` | Interactive multi-turn REPL against a skill (TTY); optional seed prompt is sent as the first turn. `--upload <file>` / `--folder <dir>` (repeatable) attach files/project folders; `--verbose` shows thinking blocks + tool inputs; `--fidelity protocol\|container\|hostloop` (no `microvm`/`cowork` in the REPL); `--allow-host-writes` consents to a writable `hostloop`-fidelity connected folder (same consent as clicking "connect folder" in Desktop); `--allow-host-hooks` consents to a staged plugin's hooks running as native host processes at `protocol`; `--raw` skips the control protocol for native `docker run -it` (rejects `--upload`/`--folder`/`--plugin`/`--fidelity`) | debugging a multi-turn flow by hand |
| `record` / `replay` | **Record a live run once → replay it token-free, Docker-free thereafter** (key flags below; `replay --explain` prints the evidence behind every passing assert) | **token-free, Docker-free CI** from a once-recorded run |
| `verify-cassettes <file\|dir>` | Token-free CI gate over committed cassettes: a privacy scan (email/currency/domain/path/machine-inventory) + a staleness check (allowlist and skip flags below); a dir argument scans `*.cassette.json` non-recursively | gating **committed cassettes** against PII leaks + "edited the skill, forgot to re-record" |
| `verify-run <run-dir> <scenario.yaml>` | Re-evaluate a scenario's `assert:` (and, when the scenario declares `answers:`, whether they still match the run's actual gates) against an already-kept run dir — **no live agent, no tokens, no Docker** (~1s) | iterating on a wrong assertion or a drifted `answer` without a full live re-record |
| `trace <run-id>` | Digest a run's `events.jsonl` (`--view tools\|questions\|dispatches\|tool-durations\|tool-errors\|files\|usage\|subagent-research`; `--translate-paths` rewrites VM paths to host paths in the text `tools`/default views; `--full-results` captures the full input + result of every tool call — successful ones too, not just errors — so an external grader can ground a self-critique finding against the call it cites) | "how many sub-agents *actually* dispatched, and which?" — per-tool call/timing stats with `--view tool-durations`, full stderr per failed call with `--view tool-errors`, a workspace-file diff with `--view files`, per-model token/cost with `--view usage`, or each dispatch's WebSearch query+result with `--view subagent-research` — including a search made by a *nested* dispatch, attributed to its nearest ancestor and marked `[via nested agent …]` (live/record lane) |
| `inspect <run-id>` | Show what a run **produced**: the artifacts + a shallow field preview of each JSON artifact (`--output-format json` for a digest). Works on a salvaged partial run too | "did it do the job?" — without hand-parsing `…/mnt/outputs/…` |
| `scaffold <run-id>` | Turn a kept run into a starter scenario YAML (gates→answers, artifacts→`file_exists`) | authoring a scenario from a real run instead of guessing |
| `python3 …/scenario.py scaffold --name <name> --skill <dir>` | Generate a starter scenario skeleton from scratch (the `…` is `.claude/skills/cowork-harness/scripts/`) | starting a new scenario when you have no prior run |
| `lint <scenario.yaml \| dir/>…` | Check scenarios for silent false-greens — assertions placed on the wrong CI lane, mixed content/live keys, missing `controlOut`-required keys (files or a directory of `*.yaml`/`*.yml`; bundled `scenario.py`; needs python3 — PyYAML is bundled); `--json` emits findings as machine-readable JSON instead of the text report; `--min-severity ERROR|WARN|INFO` drops findings below a floor **before** both the report and the exit computation (so `--strict --min-severity ERROR` behaves as a plain lint), which is the way to mute the unconditional INFO advisories in CI | before committing a new scenario or after changing assertions |
| `lint-skill <SKILL.md \| skill-dir/>…` | Lint a skill body (and any sibling `hooks.json`) for two Cowork host-loop footguns — a `${CLAUDE_PLUGIN_ROOT}` path used in an in-VM bash context, and a hook command that exports an env var or writes into `/tmp` for the in-VM agent — plus static resolution of any pinned `subagent_type` against the enclosing plugin's `agents/*.md` (bundled `scenario.py`; needs python3); the two footguns are WARN-only, and of the three `subagent_type` outcomes, an in-plugin-prefixed agent missing from the enclosing plugin's fully-enumerated `agents/*.md` (`subagent-type-not-found-in-plugin`) is a **provable typo and is WARN too**, while a cross-plugin (`subagent-type-unresolvable`) or unknown-bare (`subagent-type-unknown`) value stays INFO (no built-in agent-type registry to disprove it against); it also sizes the skill's own content — `SKILL.md` + every file under `references/` (any extension) + a plugin skill's `agents/<name>.md`, the same three classes the ceiling governs — against the 512 KiB `critique` evidence ceiling — `skill-corpus-near-evidence-ceiling` at ≥ 80% is INFO, and `skill-corpus-over-evidence-ceiling` past it is **WARN**, so a corpus a critique would cut fails `--strict` — pass `--strict` (the CI-recommended invocation; plain `lint-skill` is advisory-only) to fail on any WARN, or `--json` for machine-readable findings | authoring or reviewing a skill before a paid Cowork host-loop run exposes the footgun, or before a pinned `subagent_type` typo breaks a `Task` dispatch |
| `python3 …/scenario.py resolve-agent-types <plugin-dir> [--json]` | Token-free: print a plugin's valid `<plugin>:<agent>` subagent types, resolved from `.claude-plugin/plugin.json` + `agents/*.md` frontmatter (filename-stem fallback when an agent file has no `name:`); the `…` is `.claude/skills/cowork-harness/scripts/` | "does `founder-skills:deck-review` resolve within this plugin?" without a live dispatch |
| `analyze-skill <SKILL.md \| skill-dir/ \| glob>…` | Token-free ADVISORY scan: flags a `/sessions/...` path handed to a file tool or used as a dispatch/sub-agent output path — that path class is DENIED on host-loop. Accepts multiple positionals (files, dirs, or a simple `*`/`**` glob), walked recursively across a plugin's `SKILL.md`/`agents/`/`references/`/`commands/`. Findings print but exit 0 by default; `--strict` (the CI-recommended invocation) fails on any unsuppressed **`error`-severity** finding — advisory findings never gate, and `ok` mirrors the exit code rather than the finding count. Three per-file ignore markers (`ignore-next-line`, `ignore-start`/`ignore-end`, file-wide `ignore`) and a `--output-format json` payload are supported. **It also flags interactive-artifact write-backs lost under Cowork**: it statically analyzes `.html`/`.js`/`.py` sources under the target (`.ts`/`.tsx`/`.jsx` are out of scope — the in-process parser cannot read them; a directory walk over a TypeScript generator therefore reports nothing, and naming the file as a positional is what surfaces the skip under `unscannedArtifactSources`) for a relative `fetch`/XHR/`sendBeacon`/`<form method=post>` write-back that silently fails when the artifact is served from Cowork's own origin (`artifact-write-back-lost` gates under `--strict`; `artifact-write-back-suspect` is advisory; a candidate that can't be parsed is a could-not-verify exit `3`). `--runtime` adds an optional headless-DOM confirmation (needs `jsdom`) that *observes* the lost write-back. Full reference — ignore-marker syntax, directory-walk rules, JSON shape, and the artifact detector: [docs/subagents.md](./subagents.md#static-path-fidelity-check-analyze-skill) | catching the exact "skill hands `/sessions/...` to a file tool" defect — or an artifact whose Submit silently fails under Cowork — statically, before paying for a live run to discover it |
| `probe-dispatch <skill-dir> "<prompt>"` | Cheap single-dispatch mechanics probe: a THIN wrapper over `skill` (fidelity `container`/`microvm`/`hostloop`, default `hostloop`) that scopes a prompt to trigger ONE `Task` dispatch, then prints just that dispatch's `{resolvedAgentType, pathDenials, delivered}` — no new data model, a pure projection of the same `RunResult` `skill` already produces; `--expect-write <suffix>` narrows `delivered`; "one dispatch" is prompt-scoped, not enforced (`--output-format json` for machine consumption); also inherits the common decider/answer flags — `--decider-cmd`, `--decider-dir`, `--on-unanswered`, `--ablate-skill` | "did THIS dispatch resolve to the type I expect, avoid a path denial, and actually deliver its write?" without hand-writing a scenario or reading `trace --view dispatches` |
| `assertions --list` | List the available scenario assertions (generated from the schema) | "what can I assert?" without grepping the source |
| `decide` | Validate a decider against a sample question in ~2 s (no run) — including `--decider-dir`, which fires a real gate and blocks until you answer it with `gates`/`answer` | sanity-check a `--decider-*` / `--answer` wiring before a long run, or rehearse the in-band protocol once |
| `gates` / `answer` | Stream / answer in-band gates for `--decider-dir` | a **driving agent** answers live questions via a Monitor |
| `status <run-id \| run-dir> [--follow]` \| `status --latest-for <scenario>` | Check whether a background run is alive (state/elapsed/tool counts) by reading `status.json` — no `ps aux` needed (unreliable across sandbox/PID-namespace boundaries). Pointing it at a run-dir **root** (no `status.json` of its own) resolves to the newest session under it (scanned up to two levels deep) instead of failing with "no status.json". `--follow` streams one line per change until done/error; staleness detection catches a `SIGKILL`'d process. `--latest-for <scenario-name-or-slug>` resolves and prints the NEWEST run dir for a scenario by actual run time (its `.origin`/`result.json` timestamps) — NOT `ls -td`'s directory mtime, which can return a stale prior-session dir. The text summary goes to **stderr** (stdout stays empty); `--output-format json` and `--follow` write to stdout, so poll with `--follow` rather than a shell loop over stdout | a **driving agent** (or script) checking on a run it launched in the background, or locating the run it just kept |
| `stats [<scenario>]` | Queryable summary over every indexed `run`/`skill`/`record` invocation — run count, pass rate, cost/duration/token/turn p50/p95, `total=` group spend (the only figure that prices a `critique` whole), last-green timestamp; `--skill-hash`/`--label`/`--group-by` compare skill generations — or, via `--group-by fidelity`, the tier a run actually executed at — instead of averaging across them; an aggregate spanning more than one generation or tier says so rather than averaging silently. `--runs` lists the individual runs behind each summary (filters and `--reindex` below). See [docs/stats.md](./stats.md) | "is this scenario flaky/expensive over time?" without hand-aggregating `result.json` files |
| `boundary-check [baseline] [--session <file>]` | Prove the **L1 Docker** sandbox enforces Cowork's limitations (sealed FS + default-deny public egress, which deliberately does **not** intercept loopback; `container`/`hostloop` share this sandbox, and `hostloop`'s bash sidecar is probed explicitly — `microvm`'s guest firewall is not probed here); `--session` folds a session's `egress.extra_allow` into the probe allowlist | verifying the harness's own fidelity |
| `sync` / `list` | Derive/refresh (`sync [--diff] [--allow-empty\|--force]`) & list platform baselines from the Desktop install | after Claude Desktop updates (baselines ship, so it's optional otherwise) |
| `diff <a> <b>` | Compare two baselines, two runs, two cassettes, or a run+cassette — kind auto-detected by content (view/normalization flags below). Token-free, no live Desktop/Docker needed | "what changed between two runs/cassettes/baselines?" |
| `critique <skill-folder>` | **EXPERIMENTAL.** Run a skill, ask the agent what confused it, then grade that self-report against a frozen record of the run — blinded evaluator, mechanical citation checking. Accepts the `skill` flags a graded run needs — `--upload`/`--folder`/`--plugin` reach both spawned turns, `--answer`/`--decider-*` the graded turn only; anything that can't work is refused with a reason (full table in `critique --help`). Runs at `--fidelity container` (default), `hostloop` (a writable `--folder` there additionally needs `--allow-host-writes`), or `cowork` — which resolves once via the baseline's loop gate to one of those two and pins BOTH turns to it; `microvm`/`protocol` are refused, each with a stated reason. A multi-skill plugin needs `--skill <name>` (refused pre-spend otherwise). Persists `critique-report.json` + the armored evidence package to the run dir (`--out` copies the report; a salvage file lands on exit 2), reports per-critique cost across all four workloads (and appends a roll-up row to the run index so a batch's spend is trendable — the two evaluator passes produce no run of their own; read it back as `stats`' `total=`, never the cost percentiles, which are per-run), and stamps each finding with a cross-input `findingFingerprint`. Discovery instrument, never a gate (findings always exit 0). Advisory — a discovery lead, not an independent attestation (the skill under review can steer the grade). See [docs/critique.md](./critique.md) | "what confused the agent about my skill?" — including "does it even see the attached document?" |
| `doctor [--tier <t>]` | Read-only prerequisite check, per tier (Docker + agent image for `container`/`hostloop`/`cowork`; **Lima** for `microvm`; plus staged agent, token, baseline); prints the exact `docker build` line if the agent image is missing, and — for a **pulled** agent image — warns (advisory, best-effort) when its digest doesn't match the current published GHCR `:2`, so you can re-pull | "can I run the live tiers — what's missing?" before a first live run |
| `migrate-run-dir [<runs-dir>] [--scenario <name>] [--write]` | Convert pre-layout run dirs (artifacts at the run-dir root) to the per-turn `turns/<N>/` layout, in place — **dry-run by default**, preserving the mtimes `stats`/`--latest-for` rank by, and refusing any dir it cannot resolve rather than guessing | upgrading a runs root written by an older version, so `verify-run`/`diff`/`inspect` can read it again; `--scenario` scopes it so you can migrate one, verify, then do the rest |
| `prune [<runs-dir>] [--keep-last <n>] [--pinned-older-than <N>d\|h\|m]` | Prune accumulated run dirs (keeps the N most recent per scenario; pinned `--session-id` runs are never pruned unless `--pinned-older-than` opts in to reclaiming stale ones by last-activity age); the optional positional overrides the runs root; `--dry-run` | the machine-global runs root has grown and you want space back |
| `rehash <dir/>` | Migrate cassette fingerprints to the current format version when the content is provably unchanged (`--dry-run`); no re-record needed. **Upgrading to 2.0.0 requires this** — the hash-format epoch fails a bare `replay` on every cassette carrying a `skillHash` until it is migrated; use `rehash <file> --session <session.yaml>` if the cassette has moved. See the 2.0.0 entry in [CHANGELOG.md](../CHANGELOG.md) | a cassette-format bump flagged committed fixtures as stale |
| `init-redact [--force]` | Copy the packaged reference `.cowork-redact.json` (local-path prefixes + a generic email regex) into the cwd; refuses to overwrite without `--force`. Review + tailor before recording | `record` warned that a `hostloop`/`protocol` recording has no redaction policy |
| `vm <init\|status\|delete\|prune>` | Manage the L2 Apple-VZ / Lima microVM (`prune` removes orphaned VMs left by config/agent-version changes) | running `--fidelity microvm` |

**Flags worth knowing** (the full list is always `<command> --help`):
- `run`/`record`: `--model <id>` pins the model for that invocation, overriding the session's `model:` (a matrix `models:` axis outranks it; `COWORK_HARNESS_MODEL` fills the gap only when nothing else pins one). A run that resolves no model warns — omitting it is deprecated and becomes an error in the next major, and an unpinned run's model is a property of the machine, since the agent binary picks its own default.
- `run`: a decider (`--decider-cmd <helper>`/`--decider-dir <dir>`, or a scenario's `on_unanswered: llm` — a scenario-YAML key, not a CLI flag; `run` rejects `--on-unanswered llm`) can answer unscripted gates; `--repeat N` (2-100) runs each scenario N times and aggregates a variance rollup instead of a single pass/fail (`--min-pass-rate`, `--stop-on-diverge`, `--max-budget-usd` tune the batch verdict/loop — and `--max-budget-usd` applies without `--repeat` too, as a pre-flight refusal from the scenario's cost history); `--matrix <matrix.yaml>` runs ONE scenario across the cross-product of baseline/model/skill_dir axes (worked example: `examples/matrices/csv-metrics-matrix.yaml`; `--max-cells`/`--concurrency` tune the cap/pool — any cell failing, assertion or infra, fails the run); `--compact`/`--demo` trim `run`/`skill` output for shareable screenshots/GIFs; `--label <tag>` (both `run` and `skill`) stamps a generation name for the iterate-across-fixes loop — surfaced in `result.json` (`runLabel`), the run-index row, `inspect`, and `status.json`, alongside the auto-recorded `skillCommit` (git provenance) and the authoritative `fingerprint.skillHash` a harvest step should pair critiques by.
- `record`/`replay`: `replay --explain` prints the evidence trail behind every passing assert (the flagship false-green tool — text mode; `--output-format json` already carries `assertions[].evidence`); `--decider-llm`/`--decider-dir` answer gates live during recording; `record <dir/>` is itself a first-class batch input (recording a whole directory of scenarios), and `--rerecord-stale` re-records everything stale in one pass — `--concurrency <N>` bounds the parallelism for either; `--assert-from <scenario.yaml>`/`--reassert` re-check the on-disk `assert:` instead of the frozen one; `--strict`/`--fail-on-skill-drift` control staleness handling on replay; `--no-redact` skips record-time redaction; `--allow-failing` relaxes the post-run verdict gate; `--dry-run` resolves without recording — it runs the REAL loader, so it is also the token-free way to check whether a scenario still loads (exit 2 on a schema error for a single file; a directory reports each broken file and exits 1). **A single-file dry-run also applies the real pre-spend policy refusals, and the two arms answer the same codes**: `2` means the scenario did not load (absent file, bad YAML, unknown key, invalid enum value — same as `run`), `1` means it loaded fine but this record was refused (a scenario no run could satisfy, `on_unanswered: prompt`, the host-inventory destination refusal, a slug collision). `--max-budget-usd` is the exception: it refuses with exit 2 (`runtime` category) on both. The scenario is parsed before the credential guard, so "does this load?" never depends on holding a token. On a directory, only the path-INDEPENDENT refusals join the broken files in exiting 1 (`broken[]` / `refusals[]` in the JSON payload); the path-dependent ones — host-inventory, portability — are advisory `notes[]` and leave the exit code at 0, since a dir target takes no `--out` to check against; `--max-budget-usd <x>` refuses before spending when prior-run history says this scenario — or, on a batch, the whole batch — has cost more than x (at `--concurrency 1` a running total also stops the batch once x is reached; above that it is a pre-flight estimate only, and says so); `--force` overrides the refusal to overwrite a default-path cassette that belongs to a *different* scenario (a slug collision) — not a general overwrite-anything flag; `record` also **scans the finished recording** after redaction and before the write, and quarantines it to `<runs-root>/quarantine/` (with a `.findings.txt` naming what leaked) rather than writing a `host-inventory`/`machine-inventory` leak to a repo-visible path — `--allow-host-inventory-fixture` bypasses only the *pre-flight* refusal (tier + destination path, checked before the spend) and deliberately leaves that scan in force — writing a recording the scan flagged needs the separate `--allow-host-inventory-findings`; `replay --best-effort-future-cassette` lets a cassette from a newer format version replay anyway (warn instead of the default hard error). `replay` also prints an **advisory** note — never a failure — when the rootfs agent image differs from the one the cassette recorded (`environment.agentImage`): the image decides which capabilities exist, so replaying against a different one can move a verdict with nothing in the cassette having changed. It compares the registry digest first (the only identity comparable across machines) and falls back to the local image config id only when neither side has one; cassettes recorded before that field existed simply carry no image to compare.
- `verify-cassettes`: privacy scan (email/currency/domain/path/machine-inventory) + staleness — exit 1 when verification RAN and found a real problem (a finding, a genuine drift, or scenario-prompt drift), exit 3 when it could NOT complete (an unverifiable-class staleness finding, a too-new cassette format, or a read error) — note that a cassette which fails SHAPE validation is still **privacy-scanned**, because the scan needs a readable transcript rather than a valid document, and each result carries `privacyScanned` saying whether it actually ran (`findings: []` with `privacyScanned: false` is an absence of evidence, not evidence of absence); whole-token allows via `--allow <regex>` (a pattern) / class-scoped `--allow-domain` / `--allow-email` / `--allow-path` / `--allow-machine-inventory` / `--allow-patterns-file <path>` (a **file** of patterns, one regex per line); `--skip-privacy` or `--skip-staleness` runs only part of the gate; a diverged scenario `prompt` vs. the cassette's frozen prompt is also a hard fail (its own `scenarioDrift` bucket), opt out with `--skip-scenario-drift`; `--margins` adds a per-cassette recorded-vs-budget report for count-bound assertions (a single-sample estimate — diagnostic only, never changes the gate verdict); `--allow-empty` makes an **existing but cassette-free directory** exit 0 instead of the default loud exit 2 — for a repo that deliberately commits no cassettes (a *missing* path still fails, so the flag can never green a typo'd path).
- `stats`: reads `<runsRoot>/index.jsonl`, written automatically at every result; `--since`/`--baseline`/`--branch` filter; `--skill-hash <prefix>`/`--label <tag>` narrow to one generation of the iterate-across-fixes loop and `--group-by scenario|skill-hash|label|fidelity` splits per generation — or per effective fidelity tier — instead of aggregating across them (a window spanning >1 generation or >1 tier warns; under `skill-hash`/`label` grouping, rows lacking the field are excluded from grouping and counted, never bucketed blank — the `fidelity` key is total, so nothing is ever excluded under that grouping); `--runs` lists the individual runs behind each summary with their `skillHash`/`runLabel` (each `runs[]` entry also carries `fidelity` — the tier that run actually executed at, `effectiveFidelity ?? fidelity` — in the `--output-format json` envelope only; the text listing is unchanged); `--last <n>` windows per-group; `--reindex` rebuilds the index from the physical run-dir tree (the migration path for pre-index runs), reconstructing each critique's cost roll-up from its run dir along the way.
- `diff`: `--changelog` renders known-field prose for a baseline diff; `--view tools|transcript|artifacts|meta` narrows a run/cassette diff to one section; normalization (default on) masks per-run noise (ids/timestamps/session markers/host paths) so two runs of the same scenario diff as identical — `--no-normalize` compares raw values.

There's also a **Python `cowork` pytest lane** (`python/`) for driving any of this from `pytest` beside your normal tests — see [`python/README.md`](../python/README.md).

---


## Two files: session + scenario

Configuration splits the way Cowork itself splits — *what you set up before the first prompt* vs. *what you ask*:

- **Session setup** (`sessions/*.yaml`) — everything you'd configure in Cowork's pre-prompt setup: model, effort (`low|medium|high|xhigh|max`, per-model; `extra` is accepted as an alias for `xhigh`), extended thinking (on/off), permission mode, **mounted work folders / projects**, uploaded files, and **discovery** (marketplaces, plugins, skills, MCP servers). Hand-authored, one per project, reused across scenarios.
- **Scenario** (`scenarios/*.yaml`) — the prompt, the **scripted answers**, and the assertions. References a session.

> **Worked examples to copy** live under [`examples/`](../examples/) (see [examples/README.md](../examples/README.md)). `examples/skills/csv-metrics/` + `examples/sessions/csv-metrics.yaml` + `examples/scenarios/csv-metrics.yaml` is a complete, non-trivial skill running end-to-end: the agent loads the skill, runs its **bundled producer** (`scripts/metrics.py`, stdlib-only so it works under default-deny egress), and writes a structured `outputs/metrics.json` + a `outputs/summary.md`. The scenario asserts the structure (skill loaded, producer ran, artifacts exist); the paired [`python/test_csv_metrics_lane.py`](../python/test_csv_metrics_lane.py) adds a predicate over the JSON content (`assert_artifact_json`). Read those files to see the whole loop — discovery → run → deliverable → assert — that every real skill follows. (`examples/scenarios/example-pdf-skill.yaml` is the minimal counterpart: harness plumbing, placeholder skill.)
>
> **Worked example #2 — graceful degradation under the sealed network.** `examples/skills/csv-fx-normalize/` + `examples/scenarios/csv-fx-normalize.yaml` shows the property you can *only* test by running against the real boundary: the skill's job needs the network (fetch an FX rate to convert EUR→USD), Cowork's default-deny egress blocks it, and the skill **falls back to source currency instead of crashing or hanging**. Its `egress_denied: api.frankfurter.app` assertion is backed by a *real* fetch the skill makes — not a synthetic probe — and `result: success` + the delivered artifact prove the fallback. This is the right way to assert egress: cause a genuine denial through real behavior.

```yaml
# scenarios/pdf.yaml   ← the filename is the test's identity (name: is an optional override)
baseline: latest                       # platform baseline (auto-synced from Desktop)
session: ../sessions/default.yaml     # pre-prompt setup, resolved relative to THIS file
fidelity: container                   # protocol | container | microvm | hostloop | cowork
lane: local                           # OPTIONAL — which Cowork lane's DELIVERY CONTRACT to hold the run to:
                                      # local (default) | remote. On remote, location delivers nothing and
                                      # present_files isn't served (see docs/scenario.md → Lanes)

prompt: |
  Summarize report.pdf and write the action items to outputs/actions.md

# Scripted answers — the can_use_tool control channel, same as Desktop's question UI
answers:
  - when_question: "Which output format"   # regex (case-insensitive) on AskUserQuestion
    choose: "Markdown"                      # by label; or choose: "2" for the 2nd option BY POSITION
                                            # (index survives label drift but NOT option re-ordering — prefer a
                                            # label when order is stable; `lint` advises on positional choose;
                                            # ".*" matches any phrasing — last-resort, single gate/turn, after specific rules)
  - when_tool: Bash                        # tool-permission decisions
    allow_if: "!command.includes('rm -rf')"
    else: deny
  - when_tool: Write
    decide: allow

expect_denied: ["evil.example.com"]       # assert this host is denied egress

assert:
  - transcript_contains: "action items"
  - user_visible_artifact: project/outputs/actions.md   # resolved against workRoot exactly like file_exists, so a connected-folder deliverable still needs the <mount>/ prefix — this key additionally requires the path sit under a user-visible root
  - tool_called: Write
  - egress_denied: evil.example.com
  - result: success
```

```yaml
# examples/sessions/default.yaml  (abridged — see the file for every field)
# Relative paths below resolve from THIS file's dir (absolute and ~ are used as-is).
model: claude-opus-4-8
effort: high                            # low | medium | high | xhigh | max (extra = alias for xhigh) — validated against the model
extended_thinking: true                 # on/off toggle (default on). debug.max_thinking_tokens is a fenced, non-Cowork override
permission_mode: default
permission_parity: cowork                   # cowork (allow unscripted tool calls, the default) | strict (deny unscripted)
folders:
  - { from: ~/code/myproject }              # a work folder / Space -> mnt/myproject (collision-resolved basename)
uploads:
  - ~/Downloads/report.pdf                  # -> mnt/uploads
plugins:
  marketplaces: ["https://github.com/anthropics/claude-code.git"]
  # local_marketplaces: ["../my-marketplace"]  # LOCAL marketplace dirs (each with a marketplace.json)
  local_plugins: ["../skills/my-pdf-skill"] # mounted at mnt/.local-plugins/marketplaces/local-desktop-app-uploads/<name>
  enabled: ["my-pdf-skill@local"]           # name@marketplace: a local_plugins entry is referenced as <plugin>@local
mcp:
  config: ../data/mcp.json                  # standard mcpServers map (--mcp-config) — the way to attach an MCP server
egress:
  extra_allow: ["api.github.com"]
```

Multiple scenarios × sessions × platform baselines = your regression matrix. Drop YAML in `scenarios/` and CI runs them all.

### Assert on the run, not the output

The assertions above that check a file or a phrase are the familiar half. The half that's hard to get any
other way asserts on **how the run behaved** — a property of the execution that leaves no trace in the
deliverable:

| Claim | Key |
|---|---|
| no sub-agent ever got `Bash` (a deliberately tool-restricted dispatch stayed restricted) | `subagent_tool_absent: Bash` |
| nothing was deleted from the outputs mount | `no_delete_in_outputs: true` |
| the dispatch count stayed bounded — no fan-out blow-up | `dispatch_count_max: <N>` |
| a sub-agent wrote the file, rather than the main loop doing it for them | `subagent_file_write: {path}` |
| the skill actually ran, rather than the model answering from its mounted source | `skill_triggered: <rx>` |
| the sandbox really blocked the network | `egress_denied: <host>` |

**You cannot diff your way to "no sub-agent used `Bash`."** A correct run and a run that quietly gave a
restricted sub-agent shell access produce byte-identical outputs; the difference exists only in the event
stream. This is the class of property that matters most for a skill whose sub-agents are deliberately
tool-restricted, or whose safety story is "it can't reach X" — and it is exactly what an output-diffing
test, or a human reading the final answer, will always report as fine.

The full catalog is `cowork-harness assertions --list`; [scenario.md → Which assertion for which question](./scenario.md#which-assertion-for-which-question-goal--key)
is the goal-first chooser. Mind the two axes in each key's row: which **tier** it needs, and whether it
**survives `replay`** (several of the above are live-only — keep them in a periodic live `run`).


## What you get out (inspectable output)

Every run writes to `~/.cowork-harness/runs/<scenario>/<sessionId>/` (out of any working tree; relocate with the global `--run-dir <path>` flag — it goes *before* the subcommand — or `COWORK_HARNESS_RUNS_DIR`). A `chat` run instead writes to `runs/chat/<sessionId>/` — the first path segment is the literal `chat`, not a scenario name:

```
events.jsonl        full stream-json event log (child→driver; the cassette source)
control-out.jsonl   driver→child control_responses (the other cassette half)
turns/<N>/          ONE DIRECTORY PER TURN — written once, never renamed or overwritten as later
                    turns arrive. A run dir holds several turns whenever you use
                    --session-id + --resume, and always for `critique` (task turn + reflection
                    turn), and — as of 1.7.0 — for `chat` too (always turns/1/, since chat mints
                    a fresh session per invocation and never resumes). Each turn dir holds that
                    turn's:
                      result.json     the turn's own result (see the fields below)
                      run.jsonl       harness-observability log: decisions (+who decided), sub-agent
                                      dispatch tree, egress, transcript, cost, `turn` number
                      trace.json      structured run trace: steps, questions, sub-agents, egress
                      resources.jsonl per-sample resource telemetry
                    A single-turn run has just turns/1/. There is NO root compat copy of any of
                    these — `<run-dir>/result.json` does not exist. Prefer turns/<N>/ paths (or,
                    for `critique`, the `*.graded.json` aliases below): they mean the same thing
                    forever, unlike a "latest turn" pointer that would shift under you.
egress.log          raw allow/deny per outbound connection (microvm: at top level; container: under
                    proxy/ — the allow/deny decisions are also folded into run.jsonl/result.json)
agent.stderr.log    the agent process's stderr (auth errors, flag rejects)
```

A run dir written before this layout existed (or before 1.6.0 for `chat`) is a different, older shape —
root `result.json`/`run.jsonl`, or a name-mangled `result.turn-<N>.json` archive, no `turns/`. The CLI
detects this and REFUSES every command that needs a specific turn's result (`verify-run`, `inspect`,
`scaffold`, `diff`, `status --latest-for`, and a resumed `--session-id`), naming the shape found rather
than silently misreading it; `stats --reindex` counts such dirs as skipped instead of dropping them
quietly. Its `events.jsonl`/`egress.log` still fully support `trace`, which never refuses — which is why
every refusal points there. Convert one in place with `cowork-harness migrate-run-dir` (dry-run by
default), which preserves the file timestamps `stats` and `status --latest-for` rank by.

Secrets (the injected OAuth token / API key) are scrubbed from every persisted log by value.

**Observability fields** — `result.json` (i.e. **the turn's own** `turns/<N>/result.json`, or a
`critique` dir's `result.graded.json`) carries a lot more than the basics above:

- **Timing & model:** `toolDurations` (per-tool call count / total / max ms), `models` (distinct model ids seen) — `trace <id> --view tool-durations` renders these as a table.
- **Tool health:** `toolErrors` (per-tool call/error counts), `redundantToolCalls` (wasted repeated `{name,args}` calls), `thinking` (reasoning blocks, capped at the last 50 — on newer models like Opus 4.8/Sonnet 5 the API omits thinking text by default, so blocks arrive as `{text:"", redacted:true}`; read that as "reasoned, text omitted by request", not "no reasoning"), `modelUsage` (per-model tokens/cost/cache, denormalized from the SDK's own field). Don't conflate the three per-tool rollups: `toolCounts` is a flat `{tool: number}` call-count map, `toolErrors` is `{tool: {calls, errors}}`, and `toolDurations` is `{tool: {calls, totalMs, maxMs}}`. `trace <id> --view tool-errors` renders one row per errored tool call with the full multi-line stderr (capped 4KB), vs. the 120-char preview `--view tools` shows.
- **Verdict:** `verdict` — a kept run's overall `{pass, exitCode, signals, guards, failures}`, the same `computeVerdict` source that also drives the run/skill exit code, the footer, and the JSON envelope's `ok`; persisted and streamed verdict are one shape, so they can never diverge. Each `failures[]` entry carries a **`kind`** — `assertion` (one of yours), `guard` (an infra error, an unanswered gate, a scan-based host-path leak, …), `staleness` (skill/baseline drift on a `--strict`/`--assert-from` replay), `cassette-format`, or `coverage` (a `verify-run` answer-coverage miss) — so "did my assertions pass?" and "is the cassette stale?" are separable without scraping stderr. Filter on `kind`, not on whether `assertion` is set. `jq '.verdict' result.json` answers "did it pass, and why" without re-running `verify-run`. The same `kind` query works unchanged against **both** `run` and `verify-run` — `jq '[.results[]? | .verdict.failures[]? | select(.kind=="assertion")]'` over either command's `--output-format json` envelope answers "did MY assertions fail?" (`verify-run` emits a one-entry `results[]` alongside its flat `pass`/`assertions[]`/`signals[]` keys; through 1.24.0 it was flat-only, so that query silently returned `[]` there — an empty answer indistinguishable from "nothing failed" — against a failing run). Scope: the run/asserted lane only — `chat` carries no assertions and no verdict, so the field is absent there. (New in 0.31.0.)
- **Sub-agents & skills:** `subagents[]` now also carries `prompt`, `dispatchModel`/`resolvedModel` (the dispatch-input vs binary-resolved model), `output`, and `attributedSkillId`; `skillActivity[]` attributes tool calls to whichever skill was active when they ran; `referencesRead[]` lists the skill's `references/*`/`scripts/*` files the agent's **main agent** actually **Read** (a progressive-disclosure signal — `SKILL.md` is delivered whole so it never appears, `assets/` is untracked; present on live and replay). `subagents[].referencesRead` is the per-dispatch counterpart, tracking a **sub-agent's own** reference/script Reads (new in 0.31.0) — top-level `referencesRead[]` remains main-agent-only.
- **Panels:** `context` (available tools/mcpServers/skills), `tasks[]` (the agent's to-do list), `workspaceFiles[]` (every file the run produced or read, classified `output`/`mount`/`input`/`scratchpad`, with size + sha256 — `scratchpad` is the agent's working area OUTSIDE every user-visible root, i.e. produced but not delivered by location). `trace <id> --view files` renders `workspaceFiles[]` as a class-grouped tree plus a diff against `preRunHashes` (added/modified/removed/unchanged); needs a run dir. When `workspaceFiles` is absent (a replay result, or a run whose workspace root was missing at collection) the view reports evidence **UNAVAILABLE** (`workspaceFilesRecorded: false`) rather than an empty tree — distinct from a run that genuinely wrote nothing (`workspaceFilesRecorded: true`, zero rows). `trace <id> --view usage` renders per-model tokens/cost/cache-read ratio from `modelUsage`; also needs a run dir.
- **Runtime signals:** `hookEvents` (PreToolUse block/allow decisions), `mcpErrors` (failed MCP round-trips), `contextEvents` (incl. context-compaction boundaries), per-request `egress` detail (method/path/port/bytes + deny reason), `resources` (peak RSS, avg/peak CPU% — live lane only), `errorSource`/`stderrLogPath` (crash triage), `preRunHashes` (pre-run file hashes backing in-place-mutation checks), `resultErrorKind` (`transport`/`agent`/`usage_limit` — a usage/quota-limit failure is a spent quota surfaced distinctly, so a batch or CI job can halt-fast and retry after reset instead of treating it as a skill regression).
- **Execution location:** `execution` — `{location:"local"|"cloud", environmentId?, taskKind?:"interactive"|"scheduled"}`, orthogonal to `fidelity` (a local privilege tier). Stamped `location:"local"` on every locally-executed run; absence is **not** a "local" signal — it means a pre-taxonomy result or the error-replay lane, not a positive local claim.
- **Provenance & evidence health:** `command` records the exact command that produced the result (`run`/`skill`/`record`/`chat`/`replay`) — finer than `mode` (`skill` and `record` both report `mode:"run"`), so a rebuilt run index can tell them apart. On replay, `fingerprint.frozen: true` marks the shown staleness fingerprint as the cassette's record-time value, not a fresh recompute. `evidenceErrors` counts dropped/malformed lines per telemetry stream (`taskTracking`, `webSearchParse`, `presentFilesMalformed`, `egressParse`); a non-zero count makes the dependent assertion fail evidence-unavailable rather than grade a partial signal. A dispatch's `output` and a matched result's `assertText` carry companion `outputTruncated` / `assertTextTruncated` flags when cut at the assert cap, so a substring miss against truncated evidence is reported unverifiable, never a proven absence.

`cowork-harness assertions --list` is the full, always-current catalog built on these fields (e.g. `input_unmodified`, `tool_no_error`, `max_tool_errors`, `max_redundant_tool_calls`, `skill_tool_used`, `subagent_output_contains`, `all_tasks_completed`, `task_status`, `skill_available`, `connector_available`, `tool_available`, `hook_blocked`, `no_hook_blocked`, `no_mcp_error`, `compaction_occurred`, `max_peak_rss_bytes`); see [docs/scenario.md](./scenario.md) for the same catalog with descriptions.

`input_unmodified` accepts either a glob array or a single glob string (`input_unmodified: 'uploads/**'`), and can guard uploaded files as well as connected-folder inputs — uploads are captured as a read-only input root (hash-only in cassettes, never inlined), so a mutation to an uploaded file is attributed to the agent instead of silently passing.

**Gate provenance** — `result.json` carries a `gateProvenance` block recording, per AskUserQuestion gate, *how* it was answered — `scripted`, `decided(llm|external)`, `first-option`, or `prompt` — with a `bySource` histogram and per-gate `{question, answeredBy, answer, model?}`. The verdict footer shows a counts-only one-liner and `trace <id> --view questions` annotates each gate with its `by`/`model`, so you can see which assertions sit downstream of a non-reproducible (decided) gate:

```
✓ success [container] · 4 tools · 12.3s · $0.0463 ⚠ non-deterministic (LLM-decided)
   gates: 3 · 2 decided(llm), 1 scripted
   → result: ~/.cowork-harness/runs/my-scenario/s1/turns/1/result.json
```

It is informational — it never changes the verdict. The block is a live/`partial`-lane surface (absent on the replay lane, which reports reproducibility via `nonDeterministic: false`). The `→ result:` pointer itself prints on every kept run (success or failure) since the run directory is always retained on disk — it's suppressed only on the replay lane, which never writes a `result.json`.

**Debugging a run** — when a run misbehaves or a green looks too good to trust, [docs/debugging.md](./debugging.md) is the map: `inspect` → `trace` → `verify-run` → `diff` → `chat` for a misbehaving skill, and the false-green hunt for a green you don't trust. `replay --explain` is the flagship false-green tool: it prints the evidence trail behind every passing assert (which link resolved, which file matched, which value satisfied a bound), text mode only (`--output-format json` already carries `assertions[].evidence`).

---


## Reproducibility knobs

Most runs need **none** of these — the defaults are correct. They're grouped by theme below (container/runtime, networking/loop, strictness, staleness, secret-scrubbing, L2 microVM, `skill`/`chat` defaults); reach for one only when a default doesn't fit. Every var name is `COWORK_*` / `CLAUDE_*` — except `PYTHON` (see "Advanced / internal escape hatches" below) — so a search across this section finds nearly all of it fast.

- `COWORK_LOCKDOWN=off` — relax container hardening for debugging (default `on`). With it `on`, an L2 microVM whose guest egress firewall fails to apply **aborts loudly** rather than running un-isolated.
- `COWORK_CONTAINER_RUNTIME=podman` — use Podman instead of Docker.
- `COWORK_AGENT_IMAGE=<tag>` — override the agent image name (default `cowork-agent-base:2`; set to an empty or blank value, it falls back to the default rather than passing an empty ref to the container runtime); `COWORK_AGENT_BINARY=<path>` — override the auto-detected staged agent ELF; `COWORK_HOST_AGENT_BINARY=<path>` — override the auto-detected staged **native macOS** agent binary the `hostloop` tier spawns directly (distinct from `COWORK_AGENT_BINARY`, the container ELF). `COWORK_HARNESS_VERIFY_AGENT_SHA=0` — skip the default sha256 integrity check of the resolved agent ELF against the baseline's recorded hash (on by default).
- `COWORK_SKIP_CAPABILITY_PROBE=1` — skip the per-run capability probe (the harness otherwise probes the agent image/VM for the document/OCR/Office capabilities the real Cowork rootfs ships and **fails a run that uses one the image omits** — a likely false negative; suppress per-scenario with `allow_missing_capability: true`, or rebuild full parity).
- `COWORK_HARNESS_DECIDER_MODEL` — the default `--decider-llm` answering model (overridden by the `--decider-model` flag; falls back to the Sonnet default — pin a cheaper model for simple gates to cut cost). `COWORK_HARNESS_DECIDER_DIR_POLL_MS` / `_TIMEOUT_MS` — tune the `--decider-dir` rendezvous poll/backstop (poll defaults: 300 ms for the run-side rendezvous, 500 ms for `gates --follow`); `COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS` / `COWORK_HARNESS_LLM_TIMEOUT_MS` — backstop a hung `--decider-cmd` helper / `--decider-llm` model call (default 600 s, fail loud); `COWORK_HARNESS_LLM_RETRIES` — bounded retries for a transient non-zero `claude -p` exit in the `--decider-llm` transport (default 2, clamped to 0–10; set `0` to disable, e.g. deterministic CI; a usage/quota-limit exit is treated as non-retryable and bypasses this budget — retrying a spent quota is futile); `COWORK_HARNESS_LLM_MAX_BYTES` — stdout cap on a `--decider-llm` model call (default 8 MiB, fail loud past it); `COWORK_HARNESS_DIALOG_TIMEOUT_MS` — override the 6 s dialog auto-cancel.
- `COWORK_HARNESS_JUDGE_MODEL` — the default model for `semantic_matches`' LLM judge (overridden by a
  per-assertion `judge_model`; falls back to the pinned default `claude-opus-4-8`). Pin it alongside `judge_model` for a
  reproducible before/after comparison across re-records.
- `COWORK_HARNESS_EVALUATOR_MODEL` — the default `critique` grading model (overridden by the `--evaluator-model` flag;
  falls back to the pinned default `claude-opus-4-8`).
- `COWORK_HARNESS_RUNS_DIR` (or the `--run-dir <path>` flag — a **global** flag that must precede the subcommand — `--dotenv` follows the same rule everywhere except `critique`, which also takes it per-command) — override the default run-output root `~/.cowork-harness/runs` (kept out of any working tree so sensitive skill inputs/outputs don't land in a repo). Precedence: `--run-dir` > env > default. The root is flat and machine-global (shared across projects); pinned `--session-id` runs are guarded against cross-project overwrite, and `prune` never prunes them. In CI, set it to a workspace path (e.g. `runs`) so artifact upload can collect the runs. `COWORK_HARNESS_ALLOW_FOREIGN_RESUME=1` overrides the guard that blocks `--resume` onto another project's pinned session.
- **Networking / loop:** `COWORK_PROXY_IMAGE` overrides the egress proxy Docker image name (default `cowork-egress-proxy:4`). The egress proxy URL and Docker network are **not** overridable: each run builds its own per-run sidecar and network, and pointing a run at outside infrastructure would move the boundary `boundary-check` verifies. `CLAUDE_FORCE_HOST_LOOP=1` forces the host-loop path regardless of the baseline's loop decision (the `cowork` tier's auto-pick). `COWORK_LIMACTL` overrides the `limactl` binary path (default `/opt/homebrew/bin/limactl`).
- `COWORK_HARNESS_PRERUN_HASH_CAP` — override the default cap on pre-run file hashing (bytes); raise it if `input_unmodified`/`no_unexpected_files` report evidence unavailable on a large connected folder.
- `COWORK_HARNESS_MAX_ARTIFACT_BYTES` — override the inline-artifact-body cap (default 65536 bytes;
  same knob as `record --max-artifact-bytes`, which takes precedence) so a large structured deliverable
  stays replay-checkable instead of being truncated.
- **Status/resource polling:** `COWORK_HARNESS_STATUS_INTERVAL_MS` — how often `status.json` is
  refreshed during a run (default 5000ms). `COWORK_HARNESS_STATUS_POLL_MS` / `_FIRST_SEEN_TIMEOUT_MS` /
  `_STALE_MS` / `_CORRUPT_TIMEOUT_MS` tune `status --follow`'s polling/timeout/staleness/corrupt-file thresholds (see
  [docs/run-status.md](./run-status.md) for the full reference). `COWORK_HARNESS_RESOURCE_INTERVAL_MS`
  tunes the resource sampler's polling cadence (default 1000ms; an invalid value warns and falls back to
  the default rather than silently sampling on the wrong cadence — see
  [docs/maintenance.md](./maintenance.md)).
- `COWORK_HARNESS_NO_HYPERLINKS` — disable OSC-8 terminal hyperlinks in CLI output (auto-disabled outside a TTY, under CI, or with `--compact`/`--demo`).
- **Strictness escape hatches** (the harness fails loud by default): `COWORK_HARNESS_SOFT_MISSING=1` downgrades a missing mount source from a hard error to warn-and-exclude; `COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE=1` permits writing into an existing pinned `plugins.config_dir` (otherwise refused, to avoid clobbering a real Claude config).
- **Staleness boundary** (the git-tracked-files-only default and its `git add`/hard-fail rationale are explained in [Test a local skill](#test-a-local-skill-in-one-command)): a **non-repo** source dir falls back to a raw walk instead; OS-junk like `.DS_Store` is always excluded; a partial exclusion emits a `::notice:: [stage]`. `COWORK_HARNESS_GITSET=0` opts out to a raw walk for every dir (and copies untracked files too); `COWORK_HARNESS_DEBUG_SKILLHASH=1` dumps the exact file set feeding the staleness hash on a mismatch (and flags OS-junk) so a drift source is one line. Declare per-plugin non-runtime paths in a `.cowork-hashignore` file (or the session `staleness.hash_ignore`). `COWORK_HARNESS_AGENT_SCOPE=skill` (opt-in) refines a scenario's `skills:` scope so a **skill-named** `agents/<name>.md` re-stales only that skill's cassettes instead of the whole fleet (generic agents stay shared; stamped into the fingerprint, so flipping it is a one-time re-record like `GITSET`).
- **`skill` / `chat` defaults:** `COWORK_HARNESS_FIDELITY` sets the default fidelity tier for ad-hoc `skill`/`chat` runs (a `--fidelity` flag or a scenario's `fidelity:` still wins); `COWORK_HARNESS_MODEL` sets the default model on every lane that takes `--model` (`run`, `record`, `skill`, `probe-dispatch`, `chat`), where an explicit flag and a matrix `models:` axis both outrank it; `COWORK_HARNESS_OUTPUT_FORMAT` (`text`|`json`) sets the default output format. Each is overridden by the matching explicit flag. **Caveat:** `chat` only accepts `protocol`/`container`/`hostloop` — `microvm` and `cowork` are rejected (no Lima/auto-pick plumbing in the interactive REPL), so a `COWORK_HARNESS_FIDELITY` set to either is rejected loudly for `chat` even though `skill` accepts the full tier set.
- **Secret scrubbing:** `COWORK_HARNESS_SCRUB_KEYS=<KEY1,KEY2>` adds extra env-var names whose values are redacted from logs (beyond the known auth tokens + `ANTHROPIC_CUSTOM_HEADERS`); `COWORK_HARNESS_SCRUB_VALUES=<v1,v2>` redacts literal values regardless of env. **Committed-cassette redaction:** `COWORK_HARNESS_REDACT_PATTERNS=<rx1,rx2>` / `COWORK_HARNESS_REDACT_KEYS=<k1,k2>` extend the privacy layer that scrubs recorded `controlOut` before a cassette is written for commit.
- L2 microVM: `COWORK_VM_GATEWAY` overrides the Lima host-proxy gateway IP (default `192.168.5.2`; must be a canonical IPv4 literal — an invalid value is rejected, since it is interpolated into the guest firewall rule); `COWORK_VM_PROXY_PORT` pins the egress-proxy port (unset, the host binds an OS-assigned free port and threads that same value into the guest firewall + `HTTP(S)_PROXY`). The Lima instance is named `cowork-vm-<config-hash>` (a config change → a fresh VM); `COWORK_LIMA_INSTANCE` pins a fixed name, and `vm prune` removes orphaned ones.
- **Advanced / internal escape hatches** (rarely needed): `PYTHON` overrides the interpreter for `lint` / scenario tooling (default `python3`); `COWORK_HARNESS_DEBUG=1` surfaces which `.env` files were loaded; `COWORK_HARNESS_CLAUDE_BIN=<path>` points the `--decider-llm` transport at a specific `claude` binary; `COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1` lets the harness use the newest sibling agent binary when the baseline-pinned version is missing (a fidelity compromise — off by default) — a same-major.minor **patch** bump of the staged NATIVE binary is auto-accepted without this flag (the native binary carries no sha256 pin, so a patch drift is safe by default; it prints a loud stderr note naming the pinned and substituted versions). At `hostloop`, and at `cowork` **only when it resolves to host-loop** on the synced baseline, the staged **VM ELF** is auto-accepted on a patch bump too, because on that path it's a non-executed parity mount into the bash sidecar; a `cowork` baseline that resolves to VM-loop instead executes the ELF directly, so it keeps the strict sha-pinned exact-version match, same as `container`/`microvm`, which always keep it (the ELF is the executed agent there), so the flag remains required for any ELF drift on those tiers/paths, and for a major/minor gap everywhere; `COWORK_MANAGED_CONFIG=1` forces the managed-config path on `protocol` and `=0` suppresses the token-derived managed branch there (leaving the `ANTHROPIC_API_KEY` CI path intact); any other value is rejected rather than silently picking a branch; `COWORK_HARNESS_ALLOW_MISSING_PROMPT=1` downgrades a missing prompt asset to a warning; `COWORK_HARNESS_SAFE_STAGING_PREFIX=<a,b>` whitelists prefixes under which a delete in `outputs/` is allowed (otherwise delete-in-outputs fails loud); `COWORK_HARNESS_NO_HEARTBEAT=1` disables the idle-run heartbeat, `COWORK_HARNESS_HEARTBEAT_MS` tunes its interval (default 30000ms / 30s); `COWORK_HARNESS_CLI=/path/to/cli.js` overrides which built CLI the Python `cowork` pytest lane drives (see python/README.md); `COWORK_HARNESS_PYTEST_LANE=1` opts that lane in without `-m cowork` — the lane spawns node, Docker and a real model, so a run that did not ask for it by marker skips those tests, and this is the switch for a suite you want run whole.
- Pin `baseline: desktop-<ver>` and `model:` in a session for byte-stable runs; use `latest` to track.


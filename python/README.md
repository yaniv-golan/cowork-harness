# The `cowork` pytest lane

Drive the cowork-harness from pytest — test your skills in a Cowork-faithful sandbox
beside your normal Python tests. This is an **opt-in lane** (mark tests `@pytest.mark.cowork`),
not the fast inner loop: each call spawns the node CLI (and Docker at `container`/`hostloop`/`cowork`,
or Lima for `microvm`).

> **Just want to replay a committed cassette via pytest, no Docker/token?** `cowork.replay(cassette_path)`
> is deterministic and needs neither Docker nor an auth token — see the `cowork.replay(...)` entry under
> [API](#api) below. You still need Prerequisites 1 (build the CLI), 4 (pytest), and 5 (make
> `cowork_harness` importable); only 2 (Docker) and 3 (auth token) don't apply to `replay`.

## Prerequisites

1. **Build the CLI** — the helper drives `dist/cli.js`:
   ```bash
   npm ci && npm run build        # from the repo root, produces dist/cli.js
   ```
   Override the path with `COWORK_HARNESS_CLI=/path/to/cli.js` if it lives elsewhere.
2. **Docker** + the agent image — for `container`, `hostloop`, and `cowork` (which auto-picks one of those):
   ```bash
   docker build --platform linux/arm64 -t cowork-agent-base:2 -f docker/Dockerfile.agent .
   ```
   The `microvm` tier uses **Lima + Apple Virtualization.framework** instead (macOS arm64 only), **not**
   Docker — `brew install lima`. Run `cowork-harness doctor --tier microvm` to see what's missing.
3. **An auth token** for runs that actually call the model. Precedence: `process.env` > `--dotenv <path>` >
   `./.env` (auto-loaded from the dir you run `pytest` from) > `<install>/.env`. Simplest: put it in a `.env`
   file in the dir you run `pytest` from (it's gitignored, host-side, never mounted):
   ```bash
   export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)   # or: echo "CLAUDE_CODE_OAUTH_TOKEN=…" >> .env
   ```
4. **pytest**: `pip install pytest` (or `uv add --dev pytest`).
5. **Make `cowork_harness` importable.** The helper module sits beside these tests in `python/`. Either run
   `pytest` **from the `python/` directory** (pytest adds it to `sys.path`, which is what `conftest.py`'s
   `from cowork_harness import Cowork` relies on), or `pip install -e ./python` to put it on the path from
   anywhere.

   **cwd note for the `cowork` lane:** the live-lane tests (`test_csv_fx_lane.py`,
   `test_csv_metrics_lane.py`) use `Path(__file__).resolve().parents[1]` to locate
   `examples/` paths, so they work from both `python/` and the repo root.
   The fast lane (`-m 'not cowork'`) is always cwd-independent.

## Usage

This is the real shipped lane (`python/test_csv_metrics_lane.py`), verbatim — copy it and adapt:

```python
from pathlib import Path

import pytest

# Resolve example paths relative to the repo root regardless of the cwd pytest is invoked from.
REPO_ROOT = Path(__file__).resolve().parents[1]

PROMPT = (
    "Use the csv-metrics skill to analyze sales.csv from your uploads. Run the skill's "
    "bundled producer to write outputs/metrics.json and outputs/summary.md, then reply "
    "with a one-line confirmation that includes the path to the metrics file."
)


@pytest.mark.cowork
def test_csv_metrics_end_to_end(cowork):
    r = (
        cowork.skill(str(REPO_ROOT / "examples/skills/csv-metrics")).run(
            PROMPT,
            upload=str(REPO_ROOT / "examples/data/sales.csv"),
            fidelity="container",
            on_unanswered="first",  # the skill shouldn't ask; don't hard-fail the demo if it does
        )
    )
    r.assert_success()
    r.assert_tool_called("Skill")          # the skill loaded
    r.assert_tool_called("Bash")           # the bundled producer ran
    # The payoff: a full predicate over the producer's structured output — the thing YAML can't express.
    r.assert_artifact_json(
        "outputs/metrics.json",
        lambda d: (
            d["rows"] == 5
            and d["columns"]["amount"]["sum"] == 4200
            and d["columns"]["amount"]["median"] == 800
            and d["columns"]["units"]["sum"] == 75
        ),
    )
```

For sub-agent assertions (`assert_subagent_dispatched`, `assert_dispatch_count_max`), see the
resume example below — csv-metrics dispatches no sub-agents, so it can't demonstrate them.

Run it:
```bash
pytest -m cowork            # the lane (needs build + Docker + token)
pytest -m 'not cowork'      # the fast loop (skips this lane) — the CI default
```

## API

**At a glance** (full reference in the bullets below):

| Call | Returns | Key params |
|---|---|---|
| `cowork.skill(folder).run(prompt, …)` | `Result` | `answers`, `on_unanswered`, `fidelity`, `upload`, `folder`, `session_id`+`resume`, `decider_cmd`, `prompt_file`, `check` |
| `cowork.run_scenario(path, …)` | `Result` \| `BatchResult` | `on_unanswered`, `check` (fidelity/answers are scenario-authored) |
| `cowork.replay(cassette, …)` | `Result` \| `BatchResult` | — (deterministic; content assertions only) |
| `cowork.trace(run_id_or_dir, …)` | `list[dict]` | `tools` |

`check=True` (on `run` / `run_scenario`) raises on a failed/enveloped-error run instead of returning it.

- `cowork.skill(folder).run(...)` → `Result`. Parameters:
  - `prompt` (or `prompt_file=` for a verbatim file — avoids shell `$`-expansion)
  - `answers={q: choice}` — pre-script AskUserQuestions; `on_unanswered="fail|first|prompt"`
  - `fidelity="container"` (also `protocol|microvm|hostloop|cowork`)
  - `upload=` (str or list) — attach files at `mnt/uploads/` (deck-review, financial-model-review)
  - `folder=` (str or list) — connect folders at `mnt/<basename>` (collision-resolved; older baselines use `.projects/<id>`)
  - `session_id="…"` + `resume=True` — pin then resume a session (checkpoint-and-resume gated skills)
  - `decider_cmd="python decider.py"` — answer **live** (stochastic) questions via a spawned helper. The
    helper owns its own pipes, so this composes with `--output-format json` (the fixture parses the one envelope
    like every other run). Write the helper with `serve_decider` (below) — no wire-protocol boilerplate.
- `serve_decider(fn)` — the pre-built `--decider-cmd` loop, so a helper script writes ONLY the decision:
  ```python
  # decider.py — point --decider-cmd / decider_cmd= at:  python decider.py
  from cowork_harness import serve_decider
  def decide(req):                       # req = the self-describing decision_request dict
      q = req["questions"][0]
      label = q["question"]              # key the answer on the question text
      opts = [o["label"] for o in q.get("options", [])]   # enumerate valid labels off the wire
      if q.get("multiSelect"):           # multiSelect → return a LIST of labels/indices
          return {label: opts}           # (here: select all; a scalar would be one selection)
      pick = next((o for o in opts if "markdown" in o.lower()), 1)
      return {label: pick}               # {q: label/index} mapping, or a bare label/index
  serve_decider(decide)
  ```
  `req` is self-describing: each `questions[N]` carries `question`, optional `header`, `options[].label`
  (absent for free-text gates), and `multiSelect`; a literal `reply_with` template states the reply
  shape. `fn(request)` is called once per gate; the adapter reads each request line, echoes the `id`,
  and flushes the reply. (This is the spawn-helper analogue of the CLI's `gates`/`answer` commands.)
  To preview the exact request a gate produces before a full run, use `cowork-harness decide
  --decider-cmd 'python decider.py'` (it prints `helper received: …`) — note it only builds a
  single-select sample, so it shows `options[].label` but not `multiSelect`.
- `cowork.run_scenario(path, *, on_unanswered="fail", check=False)` → `Result`
  — run an **authored scenario YAML** (its prompt + scripted answers + `assert:`) and get the typed
  `Result` back, without the subprocess-spawn + JSON-parse + outputs-dir boilerplate. Fidelity and answers
  are **scenario-authored** (the YAML's `fidelity:` / `answers:` fields) — `run` takes no `--fidelity` /
  `--answer` flags, so the wrapper doesn't accept them either. `check=True` raises on a failed/enveloped-error
  run. The `Result` also exposes `.effective_fidelity` and `.artifacts` (the ENV-MANIFEST) so a test can prove
  which tier actually ran (e.g. `cowork` → `hostloop`). A module-level `run_scenario(path, …, cli=None)` is
  exported for the one-call case:
  ```python
  from cowork_harness import run_scenario
  r = run_scenario("scenarios/cap_table.yaml")
  r.assert_success()
  assert r.effective_fidelity == "hostloop"   # prove which tier ran
  ```
- `cowork.replay(cassette_path)` → `Result` (deterministic, no token/Docker — content assertions only)
- A **directory** input to `run_scenario` / `replay` (a `dir/` of scenarios or cassettes) produces more than
  one run, so the wrapper returns a **`BatchResult`** instead of a single `Result`: it holds every per-run
  `Result` (`len()`, iteration, indexing), and `.assert_success()` fails if **any** constituent run failed —
  a later failure can't hide behind a passing first result. The single-result accessors (`.result`,
  `.failed_assertions()`, transcript/artifact helpers) raise on a `BatchResult` directing you to iterate
  `.results`. A single-file input still returns a plain `Result`.
- `cowork.trace(run_id_or_dir, tools=False)` → `list[dict]` of trace rows (tool calls, sub-agent
  dispatches, decisions) — for asserting the *real* dispatch count vs. todo items named after sub-agents.
  Pass `tools=True` to include tool rows (runs `trace --view tools`; the CLI view set is
  `--view tools|questions|dispatches|tool-durations|tool-errors|files|usage`).
- `Result`: `.assert_success()`, `.assert_transcript_contains(s)`, `.assert_tool_called(name)`,
  `.assert_subagent_dispatched(agent_type)`, `.assert_dispatch_count_max(n)`,
  `.assert_artifact_json(rel_path, predicate)`; plus `.result`, `.out_dir`, `.work_dir`, `.outputs_dir`
  (the `mnt/outputs` deliverable path), `.subagents`, `.failed_assertions()`, and from the json envelope
  `.ok` (overall pass) / `.error` (`{category, message, hint?}` if the run threw).

Resume example (deck-review's checkpoint gate):
```python
sid = "deck-acme"
cowork.skill(PLUGIN).run("Review this pitch deck.", upload="decks/acme.pdf",
                         session_id=sid, fidelity="cowork")          # run 1: ingests + hits the gate
# … answer the gate (write gate_state.json, or carry the RUN_ID in the next prompt) …
r = cowork.skill(PLUGIN).run("Continue review for RUN_ID …; stage confirmed.",
                             session_id=sid, resume=True, fidelity="cowork")  # run 2: resumes → report
assert len([s for s in r.subagents]) >= 1
```

## Sharp edges

- **`assert_artifact_json(rel_path, …)`**:
  - Resolves under `.work_dir` — the `mnt/` root the json envelope reports (`workDir`).
  - This is fidelity-correct: sandboxed tiers nest under `work/session/mnt`; `protocol` flattens under
    `work/`.
  - `rel_path` is e.g. `"artifacts/<slug>/sizing.json"` — a skill's structured output usually lands under
    `mnt/artifacts/`, while `mnt/outputs/` holds the user-visible deliverable.
  - `rel_path` omits the `mnt/` prefix, so pass `"outputs/metrics.json"`, not `"mnt/outputs/metrics.json"`.
  - This Python predicate (full callable, autocomplete, `print(d)`) is the **structured-content** path —
    strictly richer than a YAML scenario's content assertions; prefer it over a YAML predicate when
    you're already in Python.
  - Use **scenario YAML** instead when you want a portable, toolchain-free regression suite run via
    `cowork-harness run` (see
    [docs/scenario.md](../docs/scenario.md#scenario-yaml-vs-the-pytest-cowork-lane--when-to-use-which) →
    "Scenario YAML vs the pytest `cowork` lane").
- **`on_unanswered=` takes `fail | first | prompt`.** `on_unanswered="llm"` is **rejected** by the CLI
  (exit 2) — the LLM terminal isn't exposed through this flag. To answer live questions from the lane, pass
  `decider_cmd=` (e.g. a `serve_decider(fn)` helper, above); to let a scenario use the model, set
  `on_unanswered: llm` in the scenario **YAML** (flags the run non-deterministic). This wrapper's own
  default is `"fail"` (an unanswered gate is a hard error) rather than the bare CLI's own
  terminal-adaptive default — a deliberate choice so a `pytest` run never blocks on an interactive
  prompt or silently picks an answer.
- Each call shells out to node (and Docker) — treat this as a slow lane, not per-keystroke.

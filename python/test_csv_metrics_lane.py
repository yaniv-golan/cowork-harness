"""Worked `cowork` lane example for the csv-metrics skill.

Pairs with examples/scenarios/csv-metrics.yaml: the YAML scenario asserts the *structural*
facts (skill loaded, producer ran, artifacts exist) with no Python toolchain, while
this lane adds the thing YAML can't express — a real predicate over the producer's
**structured JSON output** (assert_artifact_json).

Run:  pytest python -m cowork        # needs `npm run build` + Docker + a token
      (cwd can be the repo root or python/; paths are resolved relative to the repo root)
The fast lane (`-m 'not cowork'`, the CI default) skips it.
"""
from pathlib import Path

import pytest

# Resolve paths relative to the repo root regardless of the cwd pytest is invoked from (#D).
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
    # The payoff: a full predicate over the producer's structured output. These values are
    # deterministic for examples/data/sales.csv (verified by the producer's own stdlib math).
    r.assert_artifact_json(
        "outputs/metrics.json",
        lambda d: (
            d["rows"] == 5
            and d["columns"]["amount"]["sum"] == 4200
            and d["columns"]["amount"]["median"] == 800
            and d["columns"]["units"]["sum"] == 75
        ),
    )

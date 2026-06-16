"""Worked `cowork` lane example for the csv-fx-normalize skill — graceful degradation.

Pairs with scenarios/csv-fx-normalize.yaml. The skill's only network call (fetch the
EUR->USD rate) is blocked by Cowork's default-deny egress, so the producer falls back to
source currency. This lane asserts the structured result of that fallback over the
producer's JSON output.

Run:  pytest python -m cowork        # needs `npm run build` + Docker + a token
      (cwd can be the repo root or python/; paths are resolved relative to the repo root)
"""
from pathlib import Path

import pytest

# Resolve paths relative to the repo root regardless of the cwd pytest is invoked from (#D).
REPO_ROOT = Path(__file__).resolve().parents[1]

PROMPT = (
    "Use the csv-fx-normalize skill to normalize sales_eur.csv from your uploads to USD. "
    "Run the skill's bundled producer, then tell me whether it converted the amounts or "
    "fell back to the source currency, and the path to the output JSON."
)


@pytest.mark.cowork
def test_csv_fx_normalize_degrades_offline(cowork):
    r = (
        cowork.skill(str(REPO_ROOT / "examples/skills/csv-fx-normalize")).run(
            PROMPT,
            upload=str(REPO_ROOT / "examples/data/sales_eur.csv"),
            fidelity="container",
            on_unanswered="first",
        )
    )
    r.assert_success()
    r.assert_tool_called("Skill")
    r.assert_tool_called("Bash")
    # Under default-deny egress the FX fetch is blocked, so the producer falls back:
    # converted is False, amounts stay in EUR, and the structural totals are deterministic.
    r.assert_artifact_json(
        "outputs/normalized.json",
        lambda d: (
            d["rows"] == 5
            and d["converted"] is False
            and d["fx"]["status"] == "unavailable_offline"
            and d["totals"]["amount_eur"]["sum"] == 4000
        ),
    )

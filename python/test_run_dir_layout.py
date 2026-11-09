"""A run dir from before the turns/<N>/ layout has no run.jsonl to read — no marker, so this runs in the fast lane."""
import pytest

from cowork_harness import Result


def test_a_pre_layout_run_dir_names_the_release_that_can_convert_it(tmp_path):
    result = Result({"outDir": str(tmp_path)}, "")
    with pytest.raises(FileNotFoundError, match=r"npx cowork-harness@4 migrate-run-dir"):
        result._latest_run_jsonl()

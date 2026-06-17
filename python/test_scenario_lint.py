"""Tests for the bundled linter (scenario.py): its assertion-key list is generated from the Zod schema
(no drift), and its replay-class warnings account for manifest-backed assertions.

Run via the repo's pytest lane: `pytest -m 'not cowork'` from python/.
"""
import importlib.util
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCENARIO_PY = REPO / ".claude/skills/cowork-harness/scripts/scenario.py"
KEYS_JSON = REPO / ".claude/skills/cowork-harness/scripts/assertion-keys.json"


def _load_scenario_module():
    spec = importlib.util.spec_from_file_location("scenario_lint_under_test", SCENARIO_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


scenario = _load_scenario_module()


def _rules(yaml_body, tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return {fnd.rule for fnd in scenario.lint_file(str(f))}


def test_assert_keys_loaded_from_generated_file():
    generated = set(json.loads(KEYS_JSON.read_text(encoding="utf-8"))["keys"])
    assert scenario.ASSERT_KEYS == generated
    # the two keys that used to drift are present
    assert {"artifact_json", "allow_permissive_auto_allow"} <= scenario.ASSERT_KEYS


def test_embedded_fallback_equals_generated_list():
    # the in-code fallback must equal the generated list, else a missing file silently reintroduces drift
    generated = set(json.loads(KEYS_JSON.read_text(encoding="utf-8"))["keys"])
    assert scenario._CLASSIFIED_KEYS == generated


def test_every_key_is_classified_self_check():
    assert scenario.UNCLASSIFIED_KEYS == []


def test_artifact_json_is_not_unknown(tmp_path):
    rules = _rules("assert:\n  - artifact_json: {artifact: outputs/x.json, path: a, equals: 1}\n", tmp_path)
    assert "unknown-assert-key" not in rules
    assert "manifest-needs-snapshot" in rules  # it IS manifest-backed on replay


def test_allow_permissive_auto_allow_is_not_unknown(tmp_path):
    rules = _rules("assert:\n  - allow_permissive_auto_allow: true\n", tmp_path)
    assert "unknown-assert-key" not in rules


def test_file_exists_only_is_not_replay_noop(tmp_path):
    rules = _rules("assert:\n  - file_exists: outputs/x.md\n", tmp_path)
    assert "replay-noop" not in rules  # manifest-backed → replay-checkable with a manifest
    assert "manifest-needs-snapshot" in rules


def test_egress_only_is_replay_noop(tmp_path):
    rules = _rules("assert:\n  - egress_denied: evil.com\n", tmp_path)
    assert "replay-noop" in rules  # truly live-only → skipped on replay


def test_invented_key_still_flagged(tmp_path):
    rules = _rules("assert:\n  - file_not_empty: outputs/x\n", tmp_path)
    assert "unknown-assert-key" in rules

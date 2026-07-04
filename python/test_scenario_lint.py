"""Tests for the bundled linter (scenario.py): its assertion-key list is generated from the Zod schema
(no drift), and its replay-class warnings account for manifest-backed assertions.

Run via the repo's pytest lane: `pytest -m 'not cowork'` from python/.
"""
import contextlib
import importlib.util
import io
import json
import types as _types
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


# --- verdict-modifier single-source parity + replay-class behavior (Step 7) ---


def _findings(yaml_body, tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return scenario.lint_file(str(f))


def test_verdict_modifier_keys_parity_with_generated():
    # the hardcoded Python set must equal the generated subset (TS VERDICT_MODIFIER_KEYS is authoritative).
    # NB: JSON value is an array, the Python value is a set — wrap in set(), like the keys parity above.
    generated = set(json.loads(KEYS_JSON.read_text(encoding="utf-8"))["verdictModifierKeys"])
    assert scenario.VERDICT_MODIFIER_KEYS == generated


def test_modifier_only_scenario_is_replay_noop(tmp_path):
    # a standalone verdict modifier verifies nothing on the replay lane (it's a no-op pass), so it SHOULD
    # still trip replay-noop — modifiers are deliberately NOT in CONTENT_KEYS.
    for mod in scenario.VERDICT_MODIFIER_KEYS:
        rules = _rules(f"assert:\n  - {mod}: true\n", tmp_path)
        assert "replay-noop" in rules, mod


def test_replay_noop_message_names_verdict_modifiers(tmp_path):
    # guards the broadened warning text against a silent revert (a rule-fires test alone wouldn't catch it).
    findings = _findings("assert:\n  - allow_l0_plugin_divergence: true\n", tmp_path)
    msg = next(f.message for f in findings if f.rule == "replay-noop")
    assert "verdict modifier" in msg


def test_content_plus_modifier_item_is_not_mixed(tmp_path):
    # {result, allow_x} is NOT a mixed-class item — a modifier isn't a dropped live-only half, and `result`
    # makes the set replay-checkable, so neither mixed-assert-item nor replay-noop should fire.
    rules = _rules("assert:\n  - {result: success, allow_missing_capability: true}\n", tmp_path)
    assert "mixed-assert-item" not in rules
    assert "replay-noop" not in rules


# --- lint accepts a directory (mirrors resolveInputs: combined sort, empty dir = loud error) ---


def _lint_cmd(files, json_out=True, strict=False):
    args = _types.SimpleNamespace(files=[str(x) for x in files], json=json_out, strict=strict)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.cmd_lint(args)
    out = buf.getvalue()
    return code, (json.loads(out) if json_out else out)


def _write_scenario(path, body="assert:\n  - egress_denied: a.com\n"):
    path.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )


def test_lint_accepts_a_directory(tmp_path):
    # both *.yaml and *.yml under the dir are expanded + linted (2 distinct replay-noop findings prove it).
    _write_scenario(tmp_path / "a.yaml", body="assert:\n  - egress_denied: a.com\n")
    _write_scenario(tmp_path / "b.yml", body="assert:\n  - egress_denied: b.com\n")
    code, findings = _lint_cmd([tmp_path], json_out=True)
    files = {f["file"] for f in findings if f["rule"] == "replay-noop"}
    assert len(files) == 2


def test_lint_empty_directory_is_loud_error(tmp_path):
    code, findings = _lint_cmd([tmp_path], json_out=True)
    assert code == 1
    assert any(f["rule"] == "no-scenarios" for f in findings)


def test_lint_single_file_still_works(tmp_path):
    f = tmp_path / "one.yaml"
    _write_scenario(f, body="assert:\n  - result: success\n")
    code, out = _lint_cmd([f], json_out=False)
    assert code == 0


def test_positional_choose_emits_order_advisory(tmp_path):
    # H1: a positional `choose` (index or `first`) is order-dependent → INFO advisory.
    idx = _rules('answers:\n  - when_question: ".*"\n    choose: "2"\n', tmp_path)
    assert "positional-choose-order" in idx
    first = _rules('answers:\n  - when_question: ".*"\n    choose: first\n', tmp_path)
    assert "positional-choose-order" in first


def test_label_choose_no_order_advisory(tmp_path):
    # by-label is reproducible → no advisory.
    rules = _rules('answers:\n  - when_question: ".*"\n    choose: "Markdown"\n', tmp_path)
    assert "positional-choose-order" not in rules


# --- regex-quoting: odd vs even backslash runs (a correctly-escaped "\\d" is NOT a mistake) ---


def test_double_quoted_odd_backslash_is_flagged(tmp_path):
    # a single backslash in a double-quoted regex is a real footgun — YAML eats/mangles it.
    rules = _rules('assert:\n  - transcript_matches: "\\d+ items"\n', tmp_path)
    assert "regex-double-quoted" in rules


def test_double_quoted_even_backslash_is_not_flagged(tmp_path):
    # "\\d+ items" is a CORRECTLY double-quote-escaped regex (YAML decodes it to `\d+ items`) — the
    # linter must not false-positive on properly paired backslashes.
    rules = _rules('assert:\n  - transcript_matches: "\\\\d+ items"\n', tmp_path)
    assert "regex-double-quoted" not in rules


def test_single_quoted_regex_never_flagged(tmp_path):
    rules = _rules("assert:\n  - transcript_matches: '\\d+ items'\n", tmp_path)
    assert "regex-double-quoted" not in rules


# --- D2: fidelity/assert compatibility rules (readiness plan D2) ---


def _rules_at(tier, yaml_body, tmp_path):
    """Like _rules but with an explicit fidelity tier."""
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\n"
        f"fidelity: {tier}\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return {fnd.rule for fnd in scenario.lint_file(str(f))}


def test_host_path_assert_on_hostloop_is_error(tmp_path):
    body = "assert:\n  - transcript_no_host_path: true\n"
    assert "host-path-assert-tier" in _rules_at("hostloop", body, tmp_path)
    assert "host-path-assert-tier" in _rules_at("protocol", body, tmp_path)


def test_host_path_assert_on_container_is_clean(tmp_path):
    body = "assert:\n  - transcript_no_host_path: true\n"
    rules = _rules_at("container", body, tmp_path)
    assert "host-path-assert-tier" not in rules
    assert "host-path-assert-cowork" not in rules


def test_host_path_assert_on_cowork_is_warn_naming_the_gate(tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: cowork\n"
        "prompt: hi\nassert:\n  - transcript_no_host_path: true\n",
        encoding="utf-8",
    )
    findings = scenario.lint_file(str(f))
    hit = [x for x in findings if x.rule == "host-path-assert-cowork"]
    assert len(hit) == 1
    assert hit[0].severity == "WARN"
    # offline gate fact: the message carries the gate id instead of reading a baseline
    assert scenario.HOST_LOOP_GATE_ID in hit[0].message


def test_requires_capabilities_on_protocol_is_error(tmp_path):
    rules = _rules_at(
        "protocol", "requires_capabilities: [ocr]\nassert:\n  - result: success\n", tmp_path
    )
    assert "capabilities-on-protocol" in rules


def test_requires_capabilities_on_protocol_with_optout_is_clean(tmp_path):
    body = (
        "requires_capabilities: [ocr]\n"
        "assert:\n  - {result: success, allow_missing_capability: true}\n"
    )
    assert "capabilities-on-protocol" not in _rules_at("protocol", body, tmp_path)


def test_requires_capabilities_on_container_is_clean(tmp_path):
    rules = _rules_at(
        "container", "requires_capabilities: [ocr]\nassert:\n  - result: success\n", tmp_path
    )
    assert "capabilities-on-protocol" not in rules


def test_empty_requires_capabilities_on_protocol_is_clean(tmp_path):
    rules = _rules_at(
        "protocol", "requires_capabilities: []\nassert:\n  - result: success\n", tmp_path
    )
    assert "capabilities-on-protocol" not in rules

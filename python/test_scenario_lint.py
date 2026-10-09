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

import pytest

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
    findings = _findings("assert:\n  - allow_l0_host_config_contamination: true\n", tmp_path)
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


# --- fidelity/assert compatibility rules ---


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


# --- present_files tier keys off their serving tiers -------------------------------------------------
# The two keys are deliberately NOT the same tier class:
#   no_scratchpad_leak  -- container-only ON THE MERITS. Production's host-loop branch validates a path
#                          and passes it through WITHOUT promoting, so at hostloop there is no
#                          scratch->outputs copy that could ever leak.
#   present_files_called -- asserts the harness-side DELIVERY RECORD, served at container AND hostloop
#                          (src/assert.ts: `!== "container" && !== "hostloop"`). Only protocol and
#                          microvm deterministically cannot serve it.
# `fidelity: cowork` resolves to hostloop|container ONLY (src/run/execute.ts), so present_files_called
# is clean there -- no advisory, per AGENTS.md "Advisory design".

SCRATCHPAD_ERROR_TIERS = ("protocol", "microvm", "hostloop")
PRESENT_FILES_ERROR_TIERS = ("protocol", "microvm")


@pytest.mark.parametrize("tier", SCRATCHPAD_ERROR_TIERS)
def test_no_scratchpad_leak_off_container_is_error(tier, tmp_path):
    body = "assert:\n  - no_scratchpad_leak: true\n"
    findings = [
        f
        for f in scenario.lint_file(str(_write_at(tmp_path, tier, body)))
        if f.rule == "container-only-key-off-container"
    ]
    assert len(findings) == 1, tier
    assert findings[0].severity == "ERROR"
    assert "no_scratchpad_leak" in findings[0].message
    assert tier in findings[0].message


@pytest.mark.parametrize("tier", PRESENT_FILES_ERROR_TIERS)
def test_present_files_called_off_serving_tiers_is_error(tier, tmp_path):
    body = "assert:\n  - present_files_called: true\n"
    findings = [
        f for f in scenario.lint_file(str(_write_at(tmp_path, tier, body))) if f.rule == "present-files-key-off-tier"
    ]
    assert len(findings) == 1, tier
    assert findings[0].severity == "ERROR"
    assert "present_files_called" in findings[0].message
    assert tier in findings[0].message


@pytest.mark.parametrize("tier", ("container", "hostloop", "cowork", None))
def test_present_files_called_on_serving_tiers_is_clean(tier, tmp_path):
    """The regression this task exists for: the runtime accepts hostloop, so the linter must not flag it.
    `cowork` resolves to hostloop|container -- both serve the tool -- so it is clean too. `None` =
    omitted fidelity, which defaults to container."""
    body = "assert:\n  - present_files_called: true\n"
    if tier is None:
        f = tmp_path / "sc.yaml"
        f.write_text("name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n" + body, encoding="utf-8")
        findings = scenario.lint_file(str(f))
    else:
        findings = scenario.lint_file(str(_write_at(tmp_path, tier, body)))
    assert not any(f.rule in ("present-files-key-off-tier", "container-only-key-off-container") for f in findings)


def test_no_scratchpad_leak_on_hostloop_still_errors(tmp_path):
    """Mutation guard: a fix that lifted BOTH keys would green the test above and be wrong."""
    body = "assert:\n  - no_scratchpad_leak: true\n"
    findings = [
        f
        for f in scenario.lint_file(str(_write_at(tmp_path, "hostloop", body)))
        if f.rule == "container-only-key-off-container"
    ]
    assert len(findings) == 1


def test_no_scratchpad_leak_on_cowork_is_warn_naming_the_gate_dependency(tmp_path):
    body = "assert:\n  - no_scratchpad_leak: true\n"
    findings = [
        f
        for f in scenario.lint_file(str(_write_at(tmp_path, "cowork", body)))
        if f.rule == "container-only-key-off-container"
    ]
    assert len(findings) == 1
    assert findings[0].severity == "WARN"
    assert "no_scratchpad_leak" in findings[0].message
    # offline gate fact: the message names the gate-resolution dependency (mirrors host-path-assert-cowork)
    assert scenario.HOST_LOOP_GATE_ID in findings[0].message


@pytest.mark.parametrize("tier", ("container", None))
def test_no_scratchpad_leak_on_container_or_omitted_is_clean(tier, tmp_path):
    body = "assert:\n  - no_scratchpad_leak: true\n"
    if tier is None:
        f = tmp_path / "sc.yaml"
        f.write_text("name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n" + body, encoding="utf-8")
        findings = scenario.lint_file(str(f))
    else:
        findings = scenario.lint_file(str(_write_at(tmp_path, tier, body)))
    assert not any(f.rule == "container-only-key-off-container" for f in findings)


def _write_at(tmp_path, tier, yaml_body, name="sc.yaml"):
    f = tmp_path / name
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\n"
        f"fidelity: {tier}\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return f


def _write_lane(tmp_path, lane, yaml_body, tier="container", name="sc.yaml"):
    f = tmp_path / name
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\n"
        f"fidelity: {tier}\nlane: {lane}\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return f


# The runtime (src/run/lane-notice.ts `laneRemoteLoadRefusal`) throws at scenario LOAD time for these on
# `lane: remote`: each can never pass there. The linter must catch it offline, before a paid run.
LANE_REMOTE_ITEMS = {
    "present_files_called": "present_files_called: true",
    "no_scratchpad_leak": "no_scratchpad_leak: true",
    "user_visible_artifact": "user_visible_artifact: outputs/x.md",
    "artifact_text": "artifact_text: {artifact: outputs/x.md, contains: [a]}",
    "artifact_json": "artifact_json: {artifact: outputs/x.json, path: a, equals: 1}",
    "file_absent": "file_absent: outputs/x.md",
    "no_unexpected_files": "no_unexpected_files: [outputs/x.md]",
    "computer_links_resolve": "computer_links_resolve: true",
    "computer_links_resolve_if_present": "computer_links_resolve_if_present: true",
    "no_lost_write_back": "no_lost_write_back: true",
    "semantic_matches": "semantic_matches: {rubric: [x], evidence_files: [outputs/x.md]}",
    "semantic_pairwise": "semantic_pairwise: {refs: [r], evidence_files: [outputs/x.md]}",
    "file_exists": "file_exists: {path: outputs/x.md, authored: true}",
}
LANE_REMOTE_KEYS = tuple(LANE_REMOTE_ITEMS)


@pytest.mark.parametrize("key", LANE_REMOTE_KEYS)
def test_lane_remote_incompatible_key_is_error(key, tmp_path):
    body = f"assert:\n  - {LANE_REMOTE_ITEMS[key]}\n"
    findings = [f for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body))) if f.rule == "lane-remote-incompatible-key"]
    assert len(findings) == 1, key
    assert findings[0].severity == "ERROR"
    assert key in findings[0].message
    assert "lane: local" in findings[0].fix or "lane: local" in findings[0].message
    # The old remedy pointed at a key that does not exist on this lane.
    assert "Assert the delivery itself" not in findings[0].fix


@pytest.mark.parametrize("key", LANE_REMOTE_KEYS)
@pytest.mark.parametrize("lane", ("local", None))
def test_lane_local_or_omitted_is_clean(key, lane, tmp_path):
    """`local` is the default; neither it nor an omitted lane may trip the rule."""
    body = f"assert:\n  - {LANE_REMOTE_ITEMS[key]}\n"
    f = _write_lane(tmp_path, lane, body) if lane else _write_at(tmp_path, "container", body)
    assert not any(x.rule == "lane-remote-incompatible-key" for x in scenario.lint_file(str(f)))


def test_lane_remote_semantic_without_evidence_files_is_clean(tmp_path):
    """Judged on the transcript only on `lane: remote`: it loads, so lint must not refuse it."""
    body = "assert:\n  - semantic_matches: {rubric: [x]}\n"
    assert not any(x.rule == "lane-remote-incompatible-key" for x in scenario.lint_file(str(_write_lane(tmp_path, "remote", body))))


def test_lane_remote_unobservable_warn_is_retired():
    """4.6.0's WARN for artifact_json/artifact_text/file_absent became this ERROR: the keys now fail at load."""
    assert "lane-remote-unobservable-key" not in scenario.LINT_RULES


def test_lane_remote_suppresses_the_tier_rule(tmp_path):
    """`present_files_called` on `lane: remote` + `fidelity: protocol` must report ONLY the lane
    finding. The tier advice ('use container or hostloop') is unreachable -- the lane rejection fires
    first, at load, regardless of tier."""
    body = "assert:\n  - present_files_called: true\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body, tier="protocol")))}
    assert "lane-remote-incompatible-key" in rules
    assert "present-files-key-off-tier" not in rules


def test_lane_remote_still_flags_tier_rule_when_lane_is_local(tmp_path):
    """Mutation guard: a suppression that fired unconditionally would green the test above and be wrong."""
    body = "assert:\n  - present_files_called: true\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "local", body, tier="protocol")))}
    assert "present-files-key-off-tier" in rules


def test_lane_remote_key_error_gates_without_strict(tmp_path):
    f = _write_lane(tmp_path, "remote", "assert:\n  - user_visible_artifact: outputs/x.md\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert code != 0
    assert any(x["rule"] == "lane-remote-incompatible-key" and x["severity"] == "ERROR" for x in findings)


def test_tier_keys_are_a_subset_of_the_lane_incompatible_keys():
    """THE invariant that makes whole-block tier suppression safe (Step 4).

    Suppressing the tier blocks wholesale on `lane: remote` is only correct because every key those
    blocks can flag is ALSO lane-rejected -- so the author still gets an ERROR naming that key, just a
    more fundamental one. If a key is ever added to a tier set WITHOUT being lane-rejected, the
    `if lane != "remote"` guard would silently swallow a REACHABLE tier finding, and no other test here
    would notice (they all exercise `present_files_called`). Pin the invariant, not the instance."""
    tier_keys = scenario.CONTAINER_ONLY_KEYS | scenario.CONTAINER_HOSTLOOP_KEYS
    assert tier_keys <= scenario.LANE_REMOTE_INCOMPATIBLE_KEYS, (
        f"{sorted(tier_keys - scenario.LANE_REMOTE_INCOMPATIBLE_KEYS)} can be flagged by a tier rule but "
        "is not lane-rejected -- whole-block suppression in lint_file would hide a reachable finding. "
        "Either add the key to LANE_REMOTE_INCOMPATIBLE_KEYS, or make the suppression per-key."
    )


def test_lane_remote_suppresses_manifest_needs_snapshot_for_the_lane_rejected_key(tmp_path):
    """`user_visible_artifact` on `lane: remote` gets `lane-remote-incompatible-key` (ERROR, load-time
    rejection) -- the `manifest-needs-snapshot` INFO's "re-record so this evaluates" advice is
    unreachable for this key: it can never reach a replay to re-record for. Same rationale as the
    tier-rule suppression above."""
    body = "assert:\n  - user_visible_artifact: outputs/x.md\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body)))}
    assert "lane-remote-incompatible-key" in rules
    assert "manifest-needs-snapshot" not in rules


def test_lane_remote_still_flags_manifest_needs_snapshot_for_other_manifest_keys(tmp_path):
    """Mutation guard: `file_exists` is manifest-backed but NOT lane-rejected (only
    `user_visible_artifact` overlaps `LANE_REMOTE_INCOMPATIBLE_KEYS` within `MANIFEST_KEYS`), so it stays
    genuinely reachable on `lane: remote` and the advisory must still fire -- a blanket per-lane
    suppression (instead of the per-key filter) would wrongly swallow this one too."""
    body = "assert:\n  - file_exists: outputs/x.md\n"
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", body)))}
    assert "lane-remote-incompatible-key" not in rules
    assert "manifest-needs-snapshot" in rules


@pytest.mark.parametrize(
    "item",
    [
        "artifact_json: {artifact: outputs/x.json, path: a, equals: 1}",
        "artifact_text: {artifact: outputs/x.md, contains: [a]}",
    ],
)
def test_lane_remote_drops_manifest_needs_snapshot_for_the_body_reading_keys(item, tmp_path):
    """`artifact_json` / `artifact_text` fail at assertion time on `lane: remote` (no observable body), so a
    manifest cannot make them evaluate there: "re-record so they evaluate" is advice for a key that can't pass."""
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "remote", f"assert:\n  - {item}\n")))}
    assert "manifest-needs-snapshot" not in rules
    # Mutation guard: on lane: local the advisory still fires for them.
    rules = {f.rule for f in scenario.lint_file(str(_write_lane(tmp_path, "local", f"assert:\n  - {item}\n")))}
    assert "manifest-needs-snapshot" in rules


def test_present_files_key_error_gates_without_strict(tmp_path):
    # ERROR always gates -- nonzero exit even without --strict (mirrors host-path-assert-tier's exit class).
    f = _write_at(tmp_path, "protocol", "assert:\n  - present_files_called: true\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert code != 0
    assert any(x["rule"] == "present-files-key-off-tier" and x["severity"] == "ERROR" for x in findings)


def test_container_only_key_warn_gates_only_under_strict(tmp_path):
    # WARN (no_scratchpad_leak on cowork) is zero-exit without --strict, nonzero with --strict.
    f = _write_at(tmp_path, "cowork", "assert:\n  - no_scratchpad_leak: true\n")
    code_plain, findings_plain = _lint_cmd([f], json_out=True, strict=False)
    assert code_plain == 0
    assert any(x["rule"] == "container-only-key-off-container" and x["severity"] == "WARN" for x in findings_plain)

    code_strict, _ = _lint_cmd([f], json_out=True, strict=True)
    assert code_strict != 0


def test_container_only_key_error_gates_without_strict(tmp_path):
    # ERROR (no_scratchpad_leak on protocol) is nonzero-exit even without --strict (mirrors
    # present-files-key-off-tier's exit class -- the WARN test above only covers the cowork/gated case).
    f = _write_at(tmp_path, "protocol", "assert:\n  - no_scratchpad_leak: true\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert code != 0
    assert any(x["rule"] == "container-only-key-off-container" and x["severity"] == "ERROR" for x in findings)


# --- lint --min-severity (1.11.0) -------------------------------------------------------------------
def _lint_cli(tmp_path, *flags, body="assert:\n  - file_exists: outputs/x.json\n"):
    """Drive cmd_lint through its real argparse path and capture (exit_code, stdout)."""
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint", str(f), *flags])
    return code, buf.getvalue()


def test_min_severity_defaults_to_unchanged(tmp_path):
    """Default floor is INFO — the existing INFO advisories still fire (no silent behavior change)."""
    code, out = _lint_cli(tmp_path)
    assert "manifest-needs-snapshot" in out
    assert code == 0


def test_min_severity_warn_drops_info(tmp_path):
    code, out = _lint_cli(tmp_path, "--min-severity", "WARN")
    assert "manifest-needs-snapshot" not in out
    assert code == 0


def test_strict_with_min_severity_error_is_not_a_contradiction(tmp_path):
    """`--strict --min-severity ERROR` behaves like a plain lint.

    --strict keys off the finding set. If the filter applied only at render, this would print
    "0 findings" and still exit 1 — indistinguishable from a bug. The filter runs before BOTH the
    render and the exit computation, so the two agree.
    """
    strict_info, _ = _lint_cli(tmp_path, "--strict", "--min-severity", "INFO")
    assert strict_info == 1  # an INFO exists at an explicit INFO floor, so --strict fails
    filtered, out = _lint_cli(tmp_path, "--strict", "--min-severity", "ERROR")
    assert filtered == 0
    assert "manifest-needs-snapshot" not in out


# --- lint --strict defaults its floor to WARN (4.0.0) -----------------------------------------------
# `--strict` without `--min-severity` fails only on ERROR and WARN and hides INFO, matching
# `lint-skill --strict`, which never failed on INFO. An explicit `--min-severity` always wins, so
# `--strict --min-severity INFO` keeps the old gate.
def test_strict_default_floor_is_warn_info_only_scenario_passes(tmp_path):
    code, out = _lint_cli(tmp_path, "--strict")
    assert code == 0
    assert "manifest-needs-snapshot" not in out


def test_strict_default_floor_json_hides_info(tmp_path):
    code, out = _lint_cli(tmp_path, "--strict", "--json")
    assert code == 0
    assert json.loads(out) == []


def test_strict_with_explicit_info_floor_keeps_the_old_gate(tmp_path):
    code, out = _lint_cli(tmp_path, "--strict", "--min-severity", "INFO")
    assert code == 1
    assert "manifest-needs-snapshot" in out


def test_strict_default_floor_still_fails_on_warn(tmp_path):
    # the WARN half of the new default: a WARN still fails `--strict` with no `--min-severity`.
    code, out = _lint_cli(tmp_path, "--strict", body="assert:\n  - gate_answers_delivered: true\n")
    assert code == 1
    assert "vacuous-gate-assert" in out
    assert "gate-needs-controlout" not in out  # the INFO beside it is hidden


def test_plain_lint_default_floor_is_still_info(tmp_path):
    # without --strict the default floor stays INFO: INFO is printed, exit 0.
    code, out = _lint_cli(tmp_path)
    assert code == 0
    assert "manifest-needs-snapshot" in out


def test_min_severity_filters_json_identically(tmp_path):
    """--json sees the same filtered set, or the two output modes disagree."""
    _, full = _lint_cli(tmp_path, "--json")
    _, filtered = _lint_cli(tmp_path, "--json", "--min-severity", "WARN")
    assert any(f["rule"] == "manifest-needs-snapshot" for f in json.loads(full))
    assert all(f["severity"] in ("ERROR", "WARN") for f in json.loads(filtered))


# --- opt-in cassette evidence for replay advisories -----------------------------------------------


def _write_cassette(path, scenario_source, **fields):
    cassette = {"cassetteVersion": 13, "scenarioSource": scenario_source, **fields}
    path.write_text(json.dumps(cassette), encoding="utf-8")


def _lint_with_cassettes(tmp_path, body, cassettes):
    scenarios = tmp_path / "scenarios"
    cassettes_dir = tmp_path / "cassettes"
    scenarios.mkdir()
    cassettes_dir.mkdir()
    f = scenarios / "authored.yaml"
    f.write_text(
        "name: a different display name\nbaseline: latest\nsession: (inline)\nfidelity: container\n"
        "prompt: hi\n" + body,
        encoding="utf-8",
    )
    for name, fields in cassettes:
        _write_cassette(cassettes_dir / name, "../scenarios/authored.yaml", **fields)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint", str(f), "--cassette-dir", str(cassettes_dir), "--json"])
    return code, json.loads(buf.getvalue()), f


def _valid_artifact(path="outputs/result.json"):
    return [{"path": path, "bytes": 2, "sha256": "a" * 64, "body": "{}"}]


def test_cassette_evidence_suppresses_only_proven_replay_advice(tmp_path):
    body = (
        "answers:\n  - when_question: '.*'\n    choose: first\n"
        "assert:\n  - file_exists: outputs/result.json\n  - question_asked: '.*'\n"
    )
    code, findings, _ = _lint_with_cassettes(
        tmp_path,
        body,
        [("healthy.cassette.json", {"artifacts": _valid_artifact(), "controlOut": ["{}"]})],
    )
    rules = {f["rule"] for f in findings}
    assert code == 0
    assert "manifest-needs-snapshot" not in rules
    assert "gate-needs-controlout" not in rules
    assert "positional-choose-order" in rules


def test_cassette_provenance_must_resolve_to_the_linted_file(tmp_path):
    body = "assert:\n  - file_exists: outputs/result.json\n  - question_asked: '.*'\n"
    scenarios = tmp_path / "scenarios"
    cassettes_dir = tmp_path / "cassettes"
    scenarios.mkdir()
    cassettes_dir.mkdir()
    f = scenarios / "authored.yaml"
    f.write_text(
        "name: same-name\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )
    _write_cassette(
        cassettes_dir / "wrong-source.cassette.json",
        "../scenarios/other.yaml",
        artifacts=_valid_artifact(),
        controlOut=["{}"],
    )
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        scenario.main(["lint", str(f), "--cassette-dir", str(cassettes_dir), "--json"])
    rules = {finding["rule"] for finding in json.loads(buf.getvalue())}
    assert "manifest-needs-snapshot" in rules
    assert "gate-needs-controlout" in rules


def test_duplicate_matching_cassettes_must_all_prove_each_advisory(tmp_path):
    body = "assert:\n  - file_exists: outputs/result.json\n  - question_asked: '.*'\n"
    code, findings, _ = _lint_with_cassettes(
        tmp_path,
        body,
        [
            ("healthy.cassette.json", {"artifacts": _valid_artifact(), "controlOut": ["{}"]}),
            ("legacy.cassette.json", {"artifacts": [], "controlOut": []}),
        ],
    )
    rules = {f["rule"] for f in findings}
    assert code == 0
    assert "manifest-needs-snapshot" in rules
    assert "gate-needs-controlout" in rules


def test_empty_manifest_with_baselines_is_checkable_for_diff_assertions(tmp_path):
    body = (
        "assert:\n  - no_unexpected_files: true\n  - input_unmodified: outputs/result.json\n"
        "  - question_asked: '.*'\n"
    )
    code, findings, _ = _lint_with_cassettes(
        tmp_path,
        body,
        [
            (
                "clean.cassette.json",
                {"artifacts": [], "preRunPaths": [], "preRunHashes": {}, "controlOut": ["{}"]},
            )
        ],
    )
    rules = {f["rule"] for f in findings}
    assert code == 0
    assert "manifest-needs-snapshot" not in rules
    assert "gate-needs-controlout" not in rules


def test_malformed_cassette_evidence_fails_closed(tmp_path):
    body = "assert:\n  - file_exists: outputs/result.json\n  - question_asked: '.*'\n"
    code, findings, _ = _lint_with_cassettes(
        tmp_path,
        body,
        [("malformed.cassette.json", {"artifacts": {"path": "outputs/result.json"}, "controlOut": "{}"})],
    )
    rules = {f["rule"] for f in findings}
    assert code == 0
    assert "manifest-needs-snapshot" in rules
    assert "gate-needs-controlout" in rules


def test_healthy_matching_cassette_suppresses_replay_advice(tmp_path):
    body = "assert:\n  - file_exists: outputs/result.json\n  - question_asked: '.*'\n"
    code, findings, _ = _lint_with_cassettes(
        tmp_path,
        body,
        [("healthy.cassette.json", {"artifacts": _valid_artifact(), "controlOut": ["{}"]})],
    )
    rules = {f["rule"] for f in findings}
    assert code == 0
    assert "manifest-needs-snapshot" not in rules
    assert "gate-needs-controlout" not in rules


def test_skipped_cassette_is_visible_and_keeps_advice_with_healthy_sibling(tmp_path):
    body = "assert:\n  - file_exists: outputs/result.json\n  - question_asked: '.*'\n"
    scenarios = tmp_path / "scenarios"
    cassettes = tmp_path / "cassettes"
    scenarios.mkdir()
    cassettes.mkdir()
    f = scenarios / "authored.yaml"
    f.write_text(
        "name: a\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )
    _write_cassette(cassettes / "healthy.cassette.json", "../scenarios/authored.yaml", artifacts=_valid_artifact(), controlOut=["{}"], cassetteVersion=13)
    (cassettes / "broken.cassette.json").write_text("{ not valid json", encoding="utf-8")

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint", str(f), "--cassette-dir", str(cassettes), "--json"])
    findings = json.loads(buf.getvalue())
    rules = {finding["rule"] for finding in findings}
    skipped = next(finding for finding in findings if finding["rule"] == "cassette-evidence-skipped")
    assert code == 0
    assert "broken.cassette.json" in skipped["message"]
    assert "manifest-needs-snapshot" in rules
    assert "gate-needs-controlout" in rules


def test_unreadable_cassette_is_visible_and_keeps_advice_with_healthy_sibling(tmp_path, monkeypatch):
    body = "assert:\n  - file_exists: outputs/result.json\n"
    scenarios = tmp_path / "scenarios"
    cassettes = tmp_path / "cassettes"
    scenarios.mkdir()
    cassettes.mkdir()
    f = scenarios / "authored.yaml"
    f.write_text(
        "name: a\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )
    _write_cassette(cassettes / "healthy.cassette.json", "../scenarios/authored.yaml", artifacts=_valid_artifact(), cassetteVersion=13)
    broken = cassettes / "unreadable.cassette.json"
    broken.write_text("{}", encoding="utf-8")
    original_read_text = Path.read_text

    def deny_broken(path, *args, **kwargs):
        if path == broken:
            raise OSError("permission denied")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", deny_broken)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint", str(f), "--cassette-dir", str(cassettes), "--json"])
    findings = json.loads(buf.getvalue())
    skipped = next(finding for finding in findings if finding["rule"] == "cassette-evidence-skipped")
    rules = {finding["rule"] for finding in findings}
    assert code == 0
    assert "permission denied" in skipped["message"]
    assert "manifest-needs-snapshot" in rules


@pytest.mark.parametrize(
    "cassette_body, reason",
    [
        ("[]", "top level is not a JSON object"),
        ('{"cassetteVersion": 13}', "missing or empty scenarioSource"),
        ('{"cassetteVersion": 13, "scenarioSource": "/tmp/authored.yaml"}', "scenarioSource is absolute"),
        ('{"cassetteVersion": 16, "scenarioSource": "../scenarios/authored.yaml"}', "outside the supported range"),
    ],
)
def test_skipped_cassette_names_why_and_never_suppresses(tmp_path, cassette_body, reason):
    body = "assert:\n  - file_exists: outputs/result.json\n"
    scenarios = tmp_path / "scenarios"
    cassettes = tmp_path / "cassettes"
    scenarios.mkdir()
    cassettes.mkdir()
    f = scenarios / "authored.yaml"
    f.write_text(
        "name: a\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body,
        encoding="utf-8",
    )
    (cassettes / "bad.cassette.json").write_text(cassette_body, encoding="utf-8")

    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint", str(f), "--cassette-dir", str(cassettes), "--json"])
    findings = json.loads(buf.getvalue())
    skipped = next(finding for finding in findings if finding["rule"] == "cassette-evidence-skipped")
    assert code == 0
    assert reason in skipped["message"]
    assert any(finding["rule"] == "manifest-needs-snapshot" for finding in findings)


def test_missing_cassette_dir_is_a_usage_error(tmp_path):
    f = tmp_path / "scenario.yaml"
    _write_scenario(f, body="assert:\n  - result: success\n")
    with pytest.raises(SystemExit) as exc:
        scenario.main(["lint", str(f), "--cassette-dir", str(tmp_path / "missing"), "--json"])
    assert exc.value.code == 2


def test_empty_cassette_dir_is_a_usage_error(tmp_path):
    # An empty value must not silently fall back to lint without cassettes.
    f = tmp_path / "scenario.yaml"
    _write_scenario(f, body="assert:\n  - result: success\n")
    with pytest.raises(SystemExit) as exc:
        scenario.main(["lint", str(f), "--cassette-dir=", "--json"])
    assert exc.value.code == 2


# --- vacuous-gate-assert: gate_answers_delivered needs a PRESENCE companion -------------------------
# `gate_answers_delivered` checks that every gate which fired was delivered non-error, and ZERO gates
# fired passes VACUOUSLY (gate firing is model-dependent). So the assertion that looks like it guards
# "the skill still asks its questions" stays green when the skill stops asking altogether -- the exact
# regression a real corpus had sit green for weeks against a 0-gate recording.
#
# A companion is any key that FAILS rather than vacuously passes on an empty gate set. The exemption
# list is load-bearing in both directions: too narrow and the rule reds `scaffold`'s own output (which
# emits question_asked alongside this key); too wide and it exempts `questions_count_max`, a MAX that
# passes vacuously at zero and leaves the hole open.

RULE = "vacuous-gate-assert"
CONTRA = "assert-contradiction"


def _findings(yaml_body, tmp_path):
    """Like _rules but returns the Finding objects, so a test can assert on message/fix TEXT.
    The one-sided remedy this rule shipped with was invisible to every rule-id-only assertion."""
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + yaml_body,
        encoding="utf-8",
    )
    return list(scenario.lint_file(str(f)))


def _one(rule, yaml_body, tmp_path):
    """The single finding for `rule`, or None."""
    return next((f for f in _findings(yaml_body, tmp_path) if f.rule == rule), None)


def test_gate_answers_delivered_alone_warns(tmp_path):
    assert RULE in _rules("assert:\n  - gate_answers_delivered: true\n", tmp_path)


@pytest.mark.parametrize(
    "companion",
    [
        "gate_answer_count_min: 1",  # the explicit floor
        "gate_answer_count_min: 2",  # any floor >= 1 witnesses presence
        'question_asked: "which format"',  # fails "no question matched" on an empty set
        'tool_called: "AskUserQuestion"',  # fails "tool not called"
    ],
)
def test_presence_companion_silences_it(companion, tmp_path):
    body = f"assert:\n  - gate_answers_delivered: true\n  - {companion}\n"
    assert RULE not in _rules(body, tmp_path)


def test_questions_count_max_is_NOT_a_companion(tmp_path):
    # A MAX is satisfied by zero gates, so it cannot witness presence -- pairing it must still warn.
    body = "assert:\n  - gate_answers_delivered: true\n  - questions_count_max: 3\n"
    assert RULE in _rules(body, tmp_path)


def test_tool_called_for_an_unrelated_tool_is_not_a_companion(tmp_path):
    body = 'assert:\n  - gate_answers_delivered: true\n  - tool_called: "Bash"\n'
    assert RULE in _rules(body, tmp_path)


# --- D1: the rule must read the assertion's VALUE, not just its key --------------------------------
# `gate_answers_delivered: false` is the INVERSE assertion: it demands at least one gate whose answer
# was confirmed NOT delivered (src/assert.ts, the `failedConfirmed.length > 0` branch). Zero gates FAILS
# it. So it is not the vacuous direction, and `gate_answer_count_min` -- which counts delivered === true
# -- is not its companion. Firing here reds a correct negative-path scenario under CI's
# `--strict --min-severity WARN`, with a message whose stated premise is inverted.


def test_gate_answers_delivered_false_does_not_warn(tmp_path):
    assert RULE not in _rules("assert:\n  - gate_answers_delivered: false\n", tmp_path)


def test_gate_answers_delivered_false_with_unrelated_key_does_not_warn(tmp_path):
    body = "assert:\n  - gate_answers_delivered: false\n  - result: success\n"
    assert RULE not in _rules(body, tmp_path)


def test_both_true_and_false_authored_still_warns(tmp_path):
    # The `true` half still needs a companion; the `false` half does not excuse it.
    body = "assert:\n  - gate_answers_delivered: true\n  - gate_answers_delivered: false\n"
    assert RULE in _rules(body, tmp_path)


# --- D1b: the COMPANION side is value-blind too, and that one is a fail-open -----------------------
# `gate_answer_count_min: 0` is legal (the schema is nonnegative) and always true (`delivered >= 0`),
# so it witnesses nothing -- yet name-only membership let it silence this rule. That is a silent
# false-green wearing the paired idiom's clothes: strictly worse than D1's loud false positive.


def test_gate_answer_count_min_zero_is_not_a_companion(tmp_path):
    body = "assert:\n  - gate_answers_delivered: true\n  - gate_answer_count_min: 0\n"
    assert RULE in _rules(body, tmp_path)


def test_gate_answer_count_min_true_is_not_a_companion(tmp_path):
    # Python's `True >= 1` is true -- without an explicit bool exclusion a schema-invalid `: true`
    # would read as a floor of 1 and silence the rule.
    body = "assert:\n  - gate_answers_delivered: true\n  - gate_answer_count_min: true\n"
    assert RULE in _rules(body, tmp_path)


def test_gate_answer_count_min_negative_is_not_a_companion(tmp_path):
    body = "assert:\n  - gate_answers_delivered: true\n  - gate_answer_count_min: -1\n"
    assert RULE in _rules(body, tmp_path)


@pytest.mark.parametrize("floor", ["1.0", "1e0"])
def test_yaml_1_1_numeric_spellings_still_count_as_a_floor(floor, tmp_path):
    # THE DIALECT TRAP. This linter parses with PyYAML (YAML 1.1): `1.0` arrives as a float and `1e0`
    # as a STRING. The harness loads scenarios with the npm `yaml` package (YAML 1.2 core), which
    # resolves both to the integer 1, and `z.number().int()` accepts them. So both are fully loadable
    # scenarios with a real floor of 1 -- an `isinstance(v, int)` test would red them under --strict,
    # a NEW false positive of exactly the class this rule exists to remove.
    body = f"assert:\n  - gate_answers_delivered: true\n  - gate_answer_count_min: {floor}\n"
    assert RULE not in _rules(body, tmp_path)


# --- D3: `tool_called` is a GLOB, not a regex ------------------------------------------------------
# `tool_called` is glob-matched by the harness (src/types.ts `toolGlob`, src/assert.ts `toolMatches`):
# anchored, case-SENSITIVE, only `*` and `?` special, and a value carrying a regex metacharacter is
# REJECTED at scenario load. Reading it as a case-insensitive `re.search` was wrong on three axes at
# once and produced four false positives plus a fail-open.


@pytest.mark.parametrize(
    "glob",
    [
        "AskUserQuestion",  # exact
        "Ask*Question",     # `*` = any run within a segment
        "*Question",        # leading wildcard
        "**/AskUserQuestion",  # whole-segment `**` matches ZERO segments
        "**/*",
    ],
)
def test_tool_called_glob_matching_the_gate_tool_counts(glob, tmp_path):
    body = f'assert:\n  - gate_answers_delivered: true\n  - tool_called: "{glob}"\n'
    assert RULE not in _rules(body, tmp_path)


def test_tool_called_wrong_case_is_not_a_companion(tmp_path):
    # THE FAIL-OPEN. Glob matching is case-sensitive, so this pattern can never match the real tool --
    # a scenario that looks paired but whose companion cannot fire. `re.IGNORECASE` exempted it.
    body = 'assert:\n  - gate_answers_delivered: true\n  - tool_called: "askuserquestion"\n'
    assert RULE in _rules(body, tmp_path)


def test_tool_called_regexish_value_is_not_a_companion(tmp_path):
    # `Ask.*Question` is REJECTED by `toolGlob` at load, so a scenario carrying it can never run. The
    # old test enshrined it as the way to pair by pattern -- teaching an unloadable scenario. Under
    # glob semantics the `.` is literal, it matches nothing, and the rule correctly still fires.
    body = 'assert:\n  - gate_answers_delivered: true\n  - tool_called: "Ask.*Question"\n'
    assert RULE in _rules(body, tmp_path)


def test_malformed_tool_called_value_does_not_crash_the_linter(tmp_path):
    # `[unclosed` is likewise toolGlob-rejected at load. Under glob semantics there is nothing to
    # compile, so the linter cannot raise -- it just doesn't match. (The old name said "regex"; the
    # field was never a regex.)
    body = 'assert:\n  - gate_answers_delivered: true\n  - tool_called: "[unclosed"\n'
    assert RULE in _rules(body, tmp_path)


def test_non_string_tool_called_does_not_crash_the_linter(tmp_path):
    body = "assert:\n  - gate_answers_delivered: true\n  - tool_called: [a, b]\n"
    assert RULE in _rules(body, tmp_path)


def test_glob_port_matches_the_typescript_engine():
    """Differential guard: `_tool_glob_matches` is a port of globToRegExp (src/glob.ts). The expected
    column was produced by running `anyGlobMatches([p], "AskUserQuestion")` against the TS engine.

    A flat per-character loop passes most of this table but gets every `**/` row wrong: a whole-segment
    `**` matches ZERO segments, so `**/AskUserQuestion` matches a bare `AskUserQuestion`. That is a
    property of the PATTERN's segments, not of the subject, so "a tool name contains no `/`" does not
    make the flat form equivalent.

    Known-benign engine differences, all inert against a constant ASCII subject: `re.escape` escapes a
    superset of globToRegExp's escape set; Python's `$` also matches before a trailing newline; and JS
    `[^/]` is a UTF-16 code UNIT while Python's is a code POINT, so `?` would diverge on an astral
    subject -- relevant only if this helper is ever reused against real tool names.
    """
    expected = {
        "AskUserQuestion": True,
        "Ask*Question": True,
        "*Question": True,
        "askuserquestion": False,
        "**/AskUserQuestion": True,
        "**/*": True,
        "**/**": True,
        "**/**/AskUserQuestion": True,
        "*/AskUserQuestion": False,
        "**": True,
        "*": True,
        "?skUserQuestion": True,
        "AskUserQuestio?": True,
        "Ask**Question": True,
        "": False,
        "Ask/Question": False,
        "**/": False,
        "/AskUserQuestion": False,
        "Ask\\Question": False,
        "AskUserQuestion*": True,
        "A*n": True,
        "mcp__x__*": False,
        "Ask?*Question": True,
        "AskUserQuestioné": False,
        "**//AskUserQuestion": False,
        "AskUserQuestion/": False,
        "Ask.*Question": False,
        "??????????????????": False,
        "******************": True,
        # Backslash handling: globToRegExp normalizes `\` to `/` before splitting, so `**\*` is really
        # `**/*` (matches) while `\**` is `/**` (a leading empty segment, so it cannot).
        "\\**": False,
        "**\\*": True,
        # Control characters are literal under both engines.
        "Ask\nQuestion": False,
        "Ask\tQuestion": False,
        # Non-BMP and fullwidth: the docstring's code-unit-vs-code-point caveat is about `?` against an
        # ASTRAL SUBJECT, which cannot arise while the subject is a fixed ASCII tool name. These pin
        # that non-ASCII in the PATTERN is simply literal, and agree with the TS engine.
        "\U0001d504skUserQuestion": False,
        "Ａｓｋ*": False,
    }
    actual = {p: scenario._tool_glob_matches(p, "AskUserQuestion") for p in expected}
    assert actual == expected


# --- D4: a statically unsatisfiable gate pair -------------------------------------------------------
# `questions_count_max: 0` says "no sub-question was ever asked". Any DELIVERED gate records at least
# one question (the harness pushes one entry per sub-question before answering, and a zero-question
# gate throws), so pairing it with a presence assertion can never be satisfied. Both sides read the
# same control channel, which is what makes the contradiction provable from the YAML alone.


@pytest.mark.parametrize(
    "presence",
    [
        "gate_answer_count_min: 1",
        "gate_answer_count_min: 5",
        'question_asked: "which format"',
        "gate_answers_delivered: false",  # demands a CONFIRMED delivery failure => >= 1 gate
    ],
)
def test_zero_questions_plus_presence_is_a_contradiction(presence, tmp_path):
    body = f"assert:\n  - questions_count_max: 0\n  - {presence}\n"
    assert CONTRA in _rules(body, tmp_path)


def test_contradiction_is_detected_within_a_single_assert_entry(tmp_path):
    body = "assert:\n  - {questions_count_max: 0, gate_answer_count_min: 1}\n"
    assert CONTRA in _rules(body, tmp_path)


@pytest.mark.parametrize(
    "body",
    [
        "assert:\n  - questions_count_max: 0\n",  # alone: a legitimate zero-gate declaration
        "assert:\n  - questions_count_max: 1\n  - gate_answer_count_min: 1\n",  # satisfiable
        "assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 0\n",  # >= 0 holds at zero
        "assert:\n  - questions_count_max: 0\n  - gate_answers_delivered: true\n",  # both vacuous at 0
        "assert:\n  - gate_answer_count_min: 1\n  - question_asked: \"x\"\n",
    ],
)
def test_satisfiable_gate_combinations_are_not_flagged(body, tmp_path):
    assert CONTRA not in _rules(body, tmp_path)


# The same shape on the other two evidence channels: one assertion demands a record exist, its sibling
# demands none exist, and both read one list (hookEvents for the hook pair, pathDenials for the denial
# pairs). Verified against the assertion implementations rather than the schema prose -- a scope split
# would have made them satisfiable, and there is none.


@pytest.mark.parametrize(
    "body",
    [
        "assert:\n  - hook_blocked: \"Bash\"\n  - no_hook_blocked: true\n",
        "assert:\n  - path_denied: {}\n  - no_path_denied: true\n",
        "assert:\n  - vm_path_denied: true\n  - no_path_denied: true\n",
        "assert:\n  - {hook_blocked: \"Bash\", no_hook_blocked: true}\n",
    ],
)
def test_denial_and_hook_presence_absence_pairs_are_contradictions(body, tmp_path):
    assert CONTRA in _rules(body, tmp_path)


@pytest.mark.parametrize(
    "body",
    [
        'assert:\n  - hook_blocked: "Bash"\n',
        "assert:\n  - no_hook_blocked: true\n",
        "assert:\n  - no_path_denied: true\n",
        # two POSITIVE denial assertions can both be satisfied by one run
        "assert:\n  - vm_path_denied: true\n  - path_denied: {}\n",
        # two negatives on different channels are jointly satisfiable
        "assert:\n  - no_hook_blocked: true\n  - no_path_denied: true\n",
    ],
)
def test_satisfiable_hook_and_denial_combinations_are_not_flagged(body, tmp_path):
    assert CONTRA not in _rules(body, tmp_path)


def test_contradiction_is_an_error_so_lint_fails_without_strict(tmp_path):
    # Severity mirrors the runtime refusal: `run`/`skill`/`record` reject this scenario before
    # spending, so the linter must not need `--strict` to say so.
    f = _one(CONTRA, "assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n", tmp_path)
    assert f is not None and f.severity == "ERROR"


# --- WS2: the remedy must carry BOTH branches -------------------------------------------------------
# The shipped fix line only ever said "add a presence companion". For a scenario that is gate-clean by
# design every branch of it is wrong, and the correct fix -- drop the key, it asserts nothing there --
# was never named. A consumer followed it into a contradiction and paid for a live run to find out.


def test_remedy_offers_both_pairing_and_dropping(tmp_path):
    f = _one(RULE, "assert:\n  - gate_answers_delivered: true\n", tmp_path)
    assert f is not None
    assert "gate_answer_count_min: 1" in f.fix, "the pairing branch went missing"
    assert "questions_count_max: 0" in f.fix, "the zero-gate-intent branch went missing"
    assert "drop" in f.fix.lower() or "remove" in f.fix.lower(), "the drop-it branch went missing"


def test_zero_gate_declaration_switches_the_message_to_drop_it(tmp_path):
    # The scenario has already said it expects no gates, so "add a companion" is wrong advice: the key
    # is inert here. Same rule id, different message -- and it must NOT go silent, because
    # `questions_count_max: 0` is still not a presence companion.
    body = "assert:\n  - gate_answers_delivered: true\n  - questions_count_max: 0\n"
    f = _one(RULE, body, tmp_path)
    assert f is not None
    assert "inert" in f.message.lower() or "asserts nothing" in f.message.lower()


# --- fidelity-missing ----------------------------------------------------------
# `fidelity:` is REQUIRED since 4.0.0 (it defaulted to `container` before, with a warning from 2.4.0). The
# old default modelled VM-LOOP while production runs HOST-LOOP by default (gate 1143815894 — per-account,
# read from the fcache, so the finding must not assert it as a live fact). The loader refuses the file; on a
# direct `scenario.py lint` this ERROR is the only coverage.


def _mk(tmp_path, body, rule="fidelity-missing"):
    f = tmp_path / "sc.yaml"
    f.write_text(body, encoding="utf-8")
    return [x for x in scenario.lint_file(str(f)) if x.rule == rule]


def test_fidelity_missing_is_an_error_when_the_key_is_absent(tmp_path):
    found = _mk(tmp_path, "name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n")
    assert len(found) == 1
    assert found[0].severity == "ERROR"


def test_the_retired_warning_is_gone(tmp_path):
    assert _mk(tmp_path, "name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n", rule="fidelity-defaulted") == []


def test_fidelity_missing_fails_lint_without_strict(tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text("name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\nassert:\n  - result: success\n", encoding="utf-8")
    code, _out = _lint_cmd([f], json_out=False)
    assert code == 1


# Only a SCENARIO needs a tier. A session or matrix YAML has no `prompt:` and no `fidelity:` by design;
# reporting it as a missing tier would be a false red on a file that is correct.
@pytest.mark.parametrize(
    "body",
    ["model: claude-sonnet-5\nfolders:\n  - from: ./data\n", "baselines: [latest]\nmodels: [claude-sonnet-5]\n"],
    ids=["session", "matrix"],
)
def test_fidelity_missing_is_silent_on_a_non_scenario_doc(tmp_path, body):
    assert _mk(tmp_path, body) == []


# The rule reads the KEY: any named tier satisfies it.
@pytest.mark.parametrize("tier", ["container", "hostloop", "cowork", "microvm", "protocol"])
def test_fidelity_missing_silent_when_a_tier_is_named(tmp_path, tier):
    body = "name: t\nbaseline: latest\nsession: (inline)\nfidelity: %s\nprompt: hi\n" % tier
    assert _mk(tmp_path, body) == []


# A refusal that does not say what to do, or why, trains people to guess.
def test_fidelity_missing_fix_names_the_lanes_the_gate_and_every_tier(tmp_path):
    f = _mk(tmp_path, "name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n")[0]
    assert "required" in f.message
    assert "VM-LOOP" in f.fix
    assert "HOST-LOOP" in f.fix
    assert "1143815894" in f.fix, "cite the gate, so the claim is checkable"
    assert "fidelity: hostloop" in f.fix, "offer the production-matching tier"
    assert "fidelity: cowork" in f.fix, "offer the auto-picking tier"
    assert "fidelity: container" in f.fix, "let an author keep the pre-4.0 behaviour"
    assert "re-record" in f.fix, "a scenario with a cassette must add the tier it recorded"


# Without a tier the tier-dependent rules have nothing to compare against. Running them against a phantom
# `container` reported findings about a lane the author never chose: `tool_not_called: mcp__workspace__bash`
# is tier-vacuous at container only, so the old code warned about it on a file that named no tier.
def test_tier_rules_are_skipped_when_the_key_is_absent(tmp_path):
    body = "assert:\n  - result: success\n  - tool_not_called: mcp__workspace__bash\n"
    with_tier = tmp_path / "with.yaml"
    with_tier.write_text("name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n" + body, encoding="utf-8")
    assert any(x.rule == "tool-not-called-tier-vacuous" for x in scenario.lint_file(str(with_tier))), "canary: fires when named"
    f = tmp_path / "without.yaml"
    f.write_text("name: t\nbaseline: latest\nsession: (inline)\nprompt: hi\n" + body, encoding="utf-8")
    rules = {x.rule for x in scenario.lint_file(str(f))}
    assert "tool-not-called-tier-vacuous" not in rules
    assert "fidelity-missing" in rules


# --- prompt-slash-not-leading -------------------------------------------------
# A slash command is expanded only when the TRIMMED prompt starts with `/`; named mid-sentence it reaches
# the model as prose and the skill is never preloaded. The negative cases are the point of the rule: an
# earlier lookahead-based pattern backtracked and matched `/mn` inside `/mnt/uploads`.

def _slash_names(prompt):
    return [
        f.message.split("`/")[1].split("`")[0]
        for f in scenario._lint_prompt_slash({"prompt": prompt}, "x")
    ]


@pytest.mark.parametrize(
    "prompt",
    [
        "/deck-review deck.pdf",  # the working case — leading slash
        "   /deck-review deck.pdf",  # leading whitespace is trimmed first
        "Read /mnt/uploads/deck.pdf and summarize",  # a path, not a command
        "Save the notes to /tmp/scratch.md",  # a path with a filename
        "Open /deck.pdf",  # a filename
        "See https://example.com/docs for context",  # a URL
        "Pick red and/or blue",  # slash mid-word
        "Due 8/22 at noon",  # a date
        "Write the report to /outputs",  # a known single-segment path word
        "hi",  # no slash at all
    ],
)
def test_prompt_slash_quiet(prompt):
    assert _slash_names(prompt) == []


@pytest.mark.parametrize(
    "prompt,expected",
    [
        ("Please use /deck-review on the attached deck.", ["deck-review"]),
        ("Run /founder-skills:deck-review now", ["founder-skills:deck-review"]),
        ("Use /deck-review.", ["deck-review"]),  # trailing sentence period is not part of the name
        ("Wrap it (/deck-review) please", ["deck-review"]),
        ('Say "/deck-review" first', ["deck-review"]),
        ("Use /a and /a again", ["a"]),  # deduped
        ("First /alpha then /beta", ["alpha", "beta"]),
    ],
)
def test_prompt_slash_flagged(prompt, expected):
    assert _slash_names(prompt) == expected


def test_prompt_slash_surfaces_through_lint_file(tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        'name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\n'
        'prompt: "Please use /deck-review on the deck"\n',
        encoding="utf-8",
    )
    found = [x for x in scenario.lint_file(str(f)) if x.rule == "prompt-slash-not-leading"]
    assert len(found) == 1
    assert found[0].severity == "WARN"


def test_prompt_slash_absent_when_leading(tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        'name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\n'
        'prompt: "/deck-review deck.pdf"\n',
        encoding="utf-8",
    )
    assert [x for x in scenario.lint_file(str(f)) if x.rule == "prompt-slash-not-leading"] == []


# --- slash-prompt-forked-result-anchor -------------------------------------------------------------
# `completed (forked execution)` is the `Skill` TOOL RESULT a `context: fork` skill returns. A prompt that
# starts with `/<skill>` runs the skill with no `Skill` call, so that text never exists: a positive
# tool_result_* anchored on it fails on a working skill, and a negative one passes vacuously. Measured on
# three real hostloop runs of the same fork skill (bare slash, qualified slash, no slash).

_FORK_RULE = "slash-prompt-forked-result-anchor"


def _fork_findings(tmp_path, prompt, assert_yaml):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: hostloop\n"
        f"prompt: {prompt}\nassert:\n{assert_yaml}",
        encoding="utf-8",
    )
    return [x for x in scenario.lint_file(str(f)) if x.rule == _FORK_RULE]


_FORK_MATCH = "  - tool_result_matches: 'completed \\(forked execution\\)[\\s\\S]*exit code 2'\n"


@pytest.mark.parametrize(
    "prompt",
    [
        "'/claude-code-internals What does exit code 2 from a PreToolUse hook do?'",
        "'/claude-code-internals:claude-code-internals What does exit code 2 do?'",
    ],
)
def test_fork_anchor_flagged_on_slash_prompt(tmp_path, prompt):
    found = _fork_findings(tmp_path, prompt, _FORK_MATCH)
    assert len(found) == 1
    assert found[0].severity == "WARN"
    assert "skill_triggered" in found[0].fix


@pytest.mark.parametrize(
    "assert_yaml",
    [
        "  - tool_result_contains: 'completed (forked execution)'\n",
        "  - tool_result_not_contains: 'forked execution'\n",
        "  - tool_result_not_matches: 'forked execution'\n",
        # regex spellings of the same anchor
        "  - tool_result_matches: 'completed \\(forked\\s+execution\\)'\n",
        "  - tool_result_matches: 'forked.execution'\n",
        "  - tool_result_matches: 'Forked\\sExecution'\n",
    ],
)
def test_fork_anchor_flagged_for_every_tool_result_key(tmp_path, assert_yaml):
    assert len(_fork_findings(tmp_path, "'/my-skill go'", assert_yaml)) == 1


@pytest.mark.parametrize(
    "prompt,assert_yaml",
    [
        # no slash: the model invokes the Skill tool, whose result carries the anchor — the working case
        ("'What does exit code 2 do?'", _FORK_MATCH),
        # slash named mid-prompt is never expanded (prompt-slash-not-leading's concern, not this rule's)
        ("'Please use /claude-code-internals on this'", _FORK_MATCH),
        # slash prompt, but the tool_result assert does not anchor on the fork result
        ("'/claude-code-internals go'", "  - tool_result_matches: 'exit code 2'\n"),
        # slash prompt asserting the skill itself — the right key, nothing to warn about
        ("'/claude-code-internals go'", "  - skill_triggered: 'claude-code-internals'\n"),
        # a leading slash that is a path, not a command
        ("'/mnt/uploads/deck.pdf summarize this'", _FORK_MATCH),
    ],
)
def test_fork_anchor_quiet(tmp_path, prompt, assert_yaml):
    assert _fork_findings(tmp_path, prompt, assert_yaml) == []


# --- enum-value-invalid: generic enum validation (top-level + nested answers[]/assert[]) ------------
#
# The bug this rule fixes: `lint --strict` reported these scenarios CLEAN while `record --dry-run`
# hard-rejected them (zod `invalid_value`, exit 2) — the exact silent-false-green class `lint` exists to
# catch. Each test asserts on the finding's `rule`/`severity` from JSON, and checks the EXIT CODE
# WITHOUT `--strict` — `--strict` exits 1 on ANY finding (including INFO), so a `--strict`-gated
# assertion would still pass with this rule reverted and proves nothing (measured:
# `cowork-harness lint examples/scenarios/protocol-smoke.yaml --strict` exits 1 on 0 errors/0 warnings/2
# info alone).


def test_enum_value_invalid_on_fidelity(tmp_path):
    f = _write_at(tmp_path, "bogus", "assert:\n  - result: success\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1
    assert hits[0]["severity"] == "ERROR"
    assert "fidelity: bogus" in hits[0]["message"]
    assert code == 1  # ERROR alone (no --strict) already fails the run


def test_enum_value_invalid_on_metrics_better(tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nfidelity: protocol\nprompt: hi\n"
        "metrics:\n  - {id: words, artifact: outputs/m.json, path: words, better: hgher, scale: 100}\n"
        "assert:\n  - result: success\n",
        encoding="utf-8",
    )
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1
    assert "metrics.better: hgher" in hits[0]["message"]
    assert code == 1


def test_enum_value_invalid_on_present_but_null_value(tmp_path):
    # `fidelity:` with nothing after it parses as null. The loader rejects it; the rule must too.
    # The retired on_unanswered check guarded with `.get(...) is not None`, which skipped exactly this
    # case -- so the rule reads key MEMBERSHIP. An ABSENT key must stay clean (it defaults legitimately),
    # which test_enum_value_valid_values_stay_clean and the whole example corpus cover.
    f = tmp_path / "sc.yaml"
    f.write_text("name: t\nbaseline: latest\nsession: (inline)\nfidelity:\nprompt: hi\nassert:\n  - result: success\n", encoding="utf-8")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1
    assert hits[0]["severity"] == "ERROR"
    # rendered as YAML `null`, not Python `None`
    assert "fidelity: null" in hits[0]["message"]
    assert code == 1


def test_enum_value_invalid_on_nested_assert_result(tmp_path):
    # `result: succes` — the single most-authored typo of the most-authored assertion key.
    f = _write_at(tmp_path, "container", "assert:\n  - result: succes\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1
    assert hits[0]["severity"] == "ERROR"
    assert "assert.result: succes" in hits[0]["message"]
    assert "success" in hits[0]["fix"] and "error" in hits[0]["fix"]
    assert code == 1


def test_enum_value_invalid_on_hook_keys_string_and_object_forms(tmp_path):
    # `hook_event_blocked` takes a bare event OR `{event, ...}`: each form is checked against its own field id,
    # and a valid object is never reported as an invalid bare event.
    body = (
        "assert:\n"
        "  - hook_event_blocked: Stopp\n"
        "  - hook_event_blocked: {event: Stopp, max: 0}\n"
        "  - hook_event_blocked: {event: Stop, max: 0}\n"
        "  - hook_event_blocked: {event: Stop, via: stdout}\n"
        "  - hook_event_blocked: {event: Stop, via: json}\n"
        "  - no_hook_event_blocked: {event: Nope}\n"
        "  - no_hook_event_blocked: true\n"
        "  - hook_decision: {event: PreToolUse, decision: denied}\n"
        "  - hook_decision: {event: PreToolUse, decision: block}\n"
        "  - hook_event_fired: Stop\n"
    )
    f = _write_at(tmp_path, "container", body)
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = sorted(x["message"] for x in findings if x["rule"] == "enum-value-invalid")
    assert hits == sorted(
        [
            "`assert.hook_event_blocked: Stopp` is not a valid value.",
            "`assert.hook_event_blocked.event: Stopp` is not a valid value.",
            "`assert.hook_event_blocked.via: stdout` is not a valid value.",
            "`assert.no_hook_event_blocked.event: Nope` is not a valid value.",
            "`assert.hook_decision.decision: denied` is not a valid value.",
        ]
    )
    assert code == 1


def test_enum_value_invalid_on_answers_decide(tmp_path):
    body = "answers:\n  - when_tool: Bash\n    decide: bogus\nassert:\n  - result: success\n"
    f = _write_at(tmp_path, "container", body)
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1
    assert hits[0]["severity"] == "ERROR"
    assert "answers.decide: bogus" in hits[0]["message"]
    assert code == 1


def test_enum_value_invalid_on_unanswered_agent_gets_rename_hint(tmp_path):
    # regression: the retired bespoke on-unanswered-invalid check's `agent` -> `llm` rename hint must
    # survive the generalization to enum-value-invalid.
    f = _write_at(tmp_path, "container", "on_unanswered: agent\nassert:\n  - result: success\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1
    assert hits[0]["severity"] == "ERROR"
    assert "renamed to `llm`" in hits[0]["message"]
    assert code == 1


def test_enum_value_invalid_valid_values_are_clean(tmp_path):
    # regression guard: every schema-valid value across the covered fields must stay silent.
    body = (
        "on_unanswered: llm\n"
        "answers:\n"
        "  - when_tool: Bash\n"
        "    decide: allow\n"
        "assert:\n"
        "  - result: success\n"
        "  - path_denied: {source: pretooluse, agent_scope: any}\n"
        "  - question_options: {equals: [a, b], order: any}\n"
    )
    f = _write_at(tmp_path, "hostloop", body)
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert [x for x in findings if x["rule"] == "enum-value-invalid"] == []


def test_enum_value_invalid_execution_fix_never_offers_cloud_describe(tmp_path):
    # the trap: `cloud-describe` IS a valid schema enum value for `execution`, but the runtime REJECTS it
    # at load as reserved (no cloud runner exists yet) -- offering it back as the FIX for some other
    # invalid `execution:` value would just relocate the failure to `record --dry-run`.
    f = _write_at(tmp_path, "container", "execution: bogus\nassert:\n  - result: success\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1
    assert "cloud-describe" not in hits[0]["fix"]
    assert "local" in hits[0]["fix"]
    assert code == 1


def test_enum_value_invalid_execution_cloud_describe_itself_is_schema_valid(tmp_path):
    # `execution: cloud-describe` is NOT an enum-value-invalid finding -- it IS a valid schema value.
    # (The runtime's load-time reject of it is a separate, already-existing concern this linter's
    # generic enum check does not need to duplicate: `record --dry-run` already refuses it loudly.)
    f = _write_at(tmp_path, "container", "execution: cloud-describe\nassert:\n  - result: success\n")
    code, findings = _lint_cmd([f], json_out=True, strict=False)
    assert [x for x in findings if x["rule"] == "enum-value-invalid"] == []


def test_on_unanswered_invalid_rule_id_retired():
    # the bespoke check this generalizes is gone -- VALID_ON_UNANSWERED must not linger unused.
    assert not hasattr(scenario, "VALID_ON_UNANSWERED")


def test_valid_tiers_derived_from_enum_map_not_hand_copied():
    assert scenario.VALID_TIERS == tuple(scenario.ENUM_VALUES["fidelity"])


def test_enum_values_parity_with_generated():
    generated = json.loads(KEYS_JSON.read_text(encoding="utf-8"))["enums"]
    assert scenario.ENUM_VALUES == generated


def test_embedded_enums_equals_generated():
    # the in-code fallback must equal the generated map, else a missing file silently reintroduces drift
    generated = json.loads(KEYS_JSON.read_text(encoding="utf-8"))["enums"]
    assert scenario._EMBEDDED_ENUMS == generated


# ── Cross-language pin: _resolve_corpus_agents ↔ resolveDispatchableAgents (TS) ──────────────────
#
# `critique` packaged exactly ONE `agents/<skill>.md` through 3.6.0 while mounting the whole plugin, so a
# second skill-scoped agent ran with its authored body absent from the evaluator's evidence. Fixing the TS
# packager without the Python corpus sizing would leave `skill-corpus-*-evidence-ceiling` under-reporting
# for exactly the multi-agent plugins that need the warning — so both sides resolve the same set, and this
# executes the SHARED fixture to prove it.
#
# The expectations in the fixture are hand-written literals. Deriving them from either implementation would
# make this a tautology that passes while the two disagree.
#
# NOTE: this lane is CI-only — `npm run ci` is typecheck+build+test and never runs pytest.

DISPATCHABLE_AGENTS_FIXTURE = REPO / "test/fixtures/dispatchable-agents.json"


def _materialize(tree, root):
    for rel, content in tree.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    return root


def _fixture_cases():
    data = json.loads(DISPATCHABLE_AGENTS_FIXTURE.read_text(encoding="utf-8"))
    return data["cases"]


def test_fixture_is_non_trivial():
    """A fixture that lost its cases must not read as a clean pass on either side."""
    assert len(_fixture_cases()) >= 10


@pytest.mark.parametrize("case", _fixture_cases(), ids=lambda c: c["name"])
def test_resolve_corpus_agents_matches_shared_fixture(case, tmp_path):
    root = _materialize(case["tree"], tmp_path / "plugin")
    resolved = scenario._resolve_corpus_agents(root / "skills" / case["skill"])
    got = sorted(p.relative_to(root).as_posix() for p in resolved)
    assert got == sorted(case["expected"])


def test_corpus_sizing_counts_every_dispatchable_agent(tmp_path):
    """The ceiling warning must size what the packager actually ships. Sizing one agent while the packager
    shipped N under-reported precisely the multi-agent plugins the warning exists for."""
    root = _materialize(
        {
            "plugin.json": '{"name": "plug"}',
            "skills/ms/SKILL.md": '# ms\nsubagent_type: "plug:ms-redteam"\n',
            "agents/ms.md": "a" * 1000,
            "agents/ms-redteam.md": "b" * 2000,
        },
        tmp_path / "plugin",
    )
    agents = scenario._resolve_corpus_agents(root / "skills" / "ms")
    assert sorted(p.name for p in agents) == ["ms-redteam.md", "ms.md"]
    assert sum(p.stat().st_size for p in agents) == 3000


def test_nested_agents_move_subagent_type_severity_in_both_directions(tmp_path):
    """Making agent enumeration recursive is not a one-way strictness relaxation.

    Direction 1: a literal naming a NESTED agent stops being a `subagent-type-not-found-in-plugin` WARN,
    because the agent really is dispatchable and that WARN was a false positive.

    Direction 2: a plugin whose `agents/` holds ONLY subdirectories used to enumerate to the EMPTY set,
    which sent every same-plugin literal down `_classify_subagent_type`'s falsy-`plugin_agent_types`
    branch to `subagent-type-unknown` (INFO). It is now enumerable, so a typo'd literal surfaces as the
    WARN it always was -- a true positive that was suppressed, and a NEW --strict failure on an unchanged
    tree. Pinned here because the first version of this change claimed it could not happen."""
    root = _materialize(
        {
            "plugin.json": '{"name": "plug"}',
            "skills/ms/SKILL.md": '# ms\nsubagent_type: "plug:deep"\nsubagent_type: "plug:typoed-name"\n',
            "agents/sub/deep.md": "---\nname: deep\n---\nnested only\n",
        },
        tmp_path / "plugin",
    )
    skill_md = root / "skills/ms/SKILL.md"
    rules = [f.rule for f in scenario._lint_subagent_types(str(skill_md), skill_md.read_text().splitlines())]
    # the nested agent resolves cleanly -> no finding for it at all
    assert "subagent-type-unresolvable" not in rules
    # and the typo is now a provable one rather than an unconfirmable unknown
    assert rules == ["subagent-type-not-found-in-plugin"]


# ── Cross-language pin: _resolve_corpus_root_references ↔ resolveRootReferences (TS) ────────────────
#
# The critique packager now puts a multi-skill plugin's SHARED plugin-root `references/` files into the
# evaluator corpus when the graded skill's authored text (or a dispatchable agent) points at them.
# `_lint_skill_corpus_size` must size the same files or the ceiling warning under-reports exactly the
# plugins this feature targets. Verified against the real founder-skills tree during development (all
# six multi-skill plugins there matched exactly: cap-table 1, competitive-positioning 4, deck-review 1,
# financial-model-review 6, ic-sim 1, market-sizing 1) -- that tree lives outside this repo, so these
# tests exercise the same rules against small, self-contained fixtures instead.


def test_root_references_arming_form(tmp_path):
    """`From \\`${CLAUDE_PLUGIN_ROOT}/references/\\` (shared): \\`a.md\\`, \\`b.md\\`` -- the dominant real
    shape, where only the DIRECTORY token carries a separator and the filenames are bare. The armed line
    matches its bare basenames against the plugin root; an unmentioned root file is left out."""
    root = _materialize(
        {
            "plugin.json": '{"name": "plug"}',
            "skills/ms/SKILL.md": (
                "# ms\nFrom `${CLAUDE_PLUGIN_ROOT}/references/` (shared): `shared-a.md`, `shared-b.md`\n"
            ),
            "references/shared-a.md": "a",
            "references/shared-b.md": "b",
            "references/shared-c.md": "c",  # never mentioned -- must stay out
        },
        tmp_path / "plugin",
    )
    resolved = scenario._resolve_corpus_root_references(root / "skills" / "ms", [])
    assert sorted(p.name for p in resolved) == ["shared-a.md", "shared-b.md"]


def test_bare_references_path_does_not_match_root_basename(tmp_path):
    """A slash-bearing token (`references/x.md`) is resolved by PATH, never by basename, even when a
    plugin-root file happens to share that basename. It resolves relative to the file's own directory
    (the skill's own references/, which doesn't have this file here), so it must NOT fall back to
    matching the plugin root's `x.md` -- that fallback is bare-token-only, and this line is never armed."""
    root = _materialize(
        {
            "plugin.json": '{"name": "plug"}',
            "skills/ms/SKILL.md": "# ms\nSee references/x.md for details.\n",
            "references/x.md": "root x",
        },
        tmp_path / "plugin",
    )
    resolved = scenario._resolve_corpus_root_references(root / "skills" / "ms", [])
    assert resolved == []


def test_unbalanced_trailing_paren_stripped(tmp_path):
    """`(Mitigation 2 — see plug/references/shared-a.md).` -- the trailing punctuation run `).` (an
    UNBALANCED lone `)` plus a sentence-ending `.`) must be stripped without requiring bracket balance,
    same as `TRAILING_PUNCT` in resolve-references.ts."""
    root = _materialize(
        {
            "plugin.json": '{"name": "plug"}',
            "skills/ms/SKILL.md": "# ms\n(Mitigation 2 — see plug/references/shared-a.md).\n",
            "references/shared-a.md": "a",
        },
        tmp_path / "plugin",
    )
    resolved = scenario._resolve_corpus_root_references(root / "skills" / "ms", [])
    assert [p.name for p in resolved] == ["shared-a.md"]


def test_link_found_only_in_skill_own_references(tmp_path):
    """A root reference is counted when only the SKILL's own references/** text links it, never
    mind SKILL.md itself -- clause 1 covers the whole `references/**` tree, not just SKILL.md."""
    root = _materialize(
        {
            "plugin.json": '{"name": "plug"}',
            "skills/ms/SKILL.md": "# ms\nnothing relevant here\n",
            "skills/ms/references/local.md": (
                "See `${CLAUDE_PLUGIN_ROOT}/references/shared-a.md` for shared context.\n"
            ),
            "references/shared-a.md": "shared",
        },
        tmp_path / "plugin",
    )
    resolved = scenario._resolve_corpus_root_references(root / "skills" / "ms", [])
    assert [p.name for p in resolved] == ["shared-a.md"]


def test_linked_binary_excluded(tmp_path):
    """Link-first, THEN utf8: a plugin-root file that IS linked but is not valid UTF-8 must be excluded
    from the packaged set entirely, not merely skipped for byte counting."""
    root = _materialize(
        {
            "plugin.json": '{"name": "plug"}',
            "skills/ms/SKILL.md": "# ms\nFrom `${CLAUDE_PLUGIN_ROOT}/references/` (shared): `binary.bin`\n",
            "references/binary.bin": "placeholder",
        },
        tmp_path / "plugin",
    )
    (root / "references" / "binary.bin").write_bytes(b"\xff\xfe\x00\x01broken")
    resolved = scenario._resolve_corpus_root_references(root / "skills" / "ms", [])
    assert resolved == []


def test_same_directory_skip(tmp_path):
    """SKIP (not "dedupe") the standalone-skill shape where the plugin root and the skill dir are the
    same directory: those files are already packaged as skill-local, so running this pass too would
    double-count them under two different display keys. Exercised directly against the low-level
    `_resolve_root_references` worker so the guard is tested independent of how a caller derives
    `plugin_dir` (the `skills/<name>` heuristic in `_resolve_corpus_root_references` never actually
    produces `plugin_dir == skill_dir`, so this shape can't be reached through the public entry point)."""
    root = _materialize(
        {
            "plugin.json": '{"name": "solo"}',
            "SKILL.md": "# solo\nFrom `${CLAUDE_PLUGIN_ROOT}/references/` (shared): `shared-a.md`\n",
            "references/shared-a.md": "a",
        },
        tmp_path / "plugin",
    )
    resolved = scenario._resolve_root_references(root, root, [])
    assert resolved == []


# ── Cross-language pin: _resolve_corpus_root_references ↔ resolveRootReferences (TS) ────────────
#
# The packager and this linter agreeing on one real tree today is not a pin. This executes the SAME
# hand-written fixture both sides run, so a rule change that moves one and not the other fails on
# behaviour rather than on text. Clauses 1-2 only: clause 3 (a reference the graded agent READ during
# the turn) is run-dependent and a static lint has no run to mirror.
#
# CI-only, like the fixture above: `npm run ci` is typecheck+build+test and never runs pytest.

ROOT_REFERENCES_FIXTURE = REPO / "test/fixtures/root-references.json"


def _root_reference_cases():
    return json.loads(ROOT_REFERENCES_FIXTURE.read_text(encoding="utf-8"))["cases"]


def test_root_reference_fixture_is_non_trivial():
    assert len(_root_reference_cases()) >= 10


@pytest.mark.parametrize("case", _root_reference_cases(), ids=lambda c: c["name"])
def test_resolve_corpus_root_references_matches_shared_fixture(case, tmp_path):
    root = _materialize(case["tree"], tmp_path / "plugin")
    skill_dir = root / "skills" / case["skill"]
    agents = scenario._resolve_corpus_agents(skill_dir)
    resolved = scenario._resolve_corpus_root_references(skill_dir, agents)
    got = sorted(p.relative_to(root).as_posix() for p in resolved)
    assert got == sorted(case["expected"])


# ── Loader findings handed over by the `cowork-harness lint` wrapper ──────────────────────────────
#
# The CLI wrapper runs the harness's own scenario loader before spawning this linter and passes what it
# rejects through a JSON file named by COWORK_HARNESS_LINT_EXTRA_FINDINGS. They must flow through the
# same --min-severity filter, renderer and exit rule as this linter's own findings. The variable is
# honoured only together with COWORK_HARNESS_PROG (which the wrapper always sets), so a direct
# `python3 scenario.py lint` never reads it.

EXTRA_VAR = "COWORK_HARNESS_LINT_EXTRA_FINDINGS"


def _extra_file(tmp_path, entries):
    p = tmp_path / "extra.json"
    p.write_text(entries if isinstance(entries, str) else json.dumps(entries), encoding="utf-8")
    return str(p)


def _loader_entry(file, severity="ERROR", rule="scenario-invalid"):
    return {"severity": severity, "rule": rule, "message": "the loader rejects this", "fix": "fix it", "file": file, "line": None}


def test_extra_findings_are_merged_filtered_and_gate(tmp_path, monkeypatch):
    sc = tmp_path / "sc.yaml"
    extra = _extra_file(tmp_path, [_loader_entry(str(sc)), _loader_entry(str(sc), severity="INFO", rule="loader-info")])
    monkeypatch.setenv("COWORK_HARNESS_PROG", "cowork-harness")
    monkeypatch.setenv(EXTRA_VAR, extra)
    code, out = _lint_cli(tmp_path, body="assert:\n  - result: success\n")
    assert code == 1
    assert "scenario-invalid" in out and "loader-info" in out
    code, out = _lint_cli(tmp_path, "--min-severity", "WARN", body="assert:\n  - result: success\n")
    assert code == 1
    assert "scenario-invalid" in out and "loader-info" not in out
    code_text, text_out = _lint_cli(tmp_path, body="assert:\n  - result: success\n")
    code, out = _lint_cli(tmp_path, "--json", body="assert:\n  - result: success\n")
    assert code == 1 == code_text
    found = json.loads(out)
    assert {"scenario-invalid", "loader-info"} <= {x["rule"] for x in found}
    # Same content in both modes: every JSON finding is rendered in the text report, and the text summary
    # counts exactly the JSON findings.
    for x in found:
        assert f'{x["severity"]} [{x["rule"]}] {x["file"]}' in text_out
        assert x["message"] in text_out
    n_err = sum(1 for x in found if x["severity"] == "ERROR")
    n_warn = sum(1 for x in found if x["severity"] == "WARN")
    n_info = sum(1 for x in found if x["severity"] == "INFO")
    assert f"{n_err} error(s), {n_warn} warning(s), {n_info} info" in text_out


@pytest.mark.parametrize(
    "payload",
    ["{not json", json.dumps({"not": "a list"}), json.dumps([{"severity": "FATAL", "rule": "x", "message": "m", "fix": "f", "file": "a"}])],
    ids=["bad-json", "not-a-list", "bad-severity"],
)
def test_malformed_extra_findings_is_an_error_not_a_crash(tmp_path, monkeypatch, payload):
    monkeypatch.setenv("COWORK_HARNESS_PROG", "cowork-harness")
    monkeypatch.setenv(EXTRA_VAR, _extra_file(tmp_path, payload))
    code, out = _lint_cli(tmp_path, body="assert:\n  - result: success\n")
    assert code == 1
    assert "linter-extra-findings-invalid" in out


def test_unreadable_extra_findings_is_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv("COWORK_HARNESS_PROG", "cowork-harness")
    monkeypatch.setenv(EXTRA_VAR, str(tmp_path / "missing.json"))
    code, out = _lint_cli(tmp_path, body="assert:\n  - result: success\n")
    assert code == 1
    assert "linter-extra-findings-invalid" in out


def test_extra_findings_ignored_on_direct_invocation(tmp_path, monkeypatch):
    """Without COWORK_HARNESS_PROG this is a direct `python3 scenario.py lint`: the variable is not read."""
    monkeypatch.delenv("COWORK_HARNESS_PROG", raising=False)
    monkeypatch.setenv(EXTRA_VAR, _extra_file(tmp_path, [_loader_entry("x.yaml")]))
    code, out = _lint_cli(tmp_path, body="assert:\n  - result: success\n")
    assert code == 0
    assert "scenario-invalid" not in out


def test_blank_extra_findings_value_is_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("COWORK_HARNESS_PROG", "cowork-harness")
    monkeypatch.setenv(EXTRA_VAR, "   ")
    code, out = _lint_cli(tmp_path, body="assert:\n  - result: success\n")
    assert code == 0


def test_lint_skill_ignores_extra_findings(tmp_path, monkeypatch):
    skill = tmp_path / "skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Clean\n\nNothing to see.\n", encoding="utf-8")
    monkeypatch.setenv("COWORK_HARNESS_PROG", "cowork-harness")
    monkeypatch.setenv(EXTRA_VAR, _extra_file(tmp_path, [_loader_entry("x.yaml")]))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint-skill", str(skill)])
    assert code == 0
    assert "scenario-invalid" not in buf.getvalue()


# --- the object form of tool_called / tool_not_called, and the transcript_* command-shape rule ------

CMD_RULE = "transcript-command-shaped"


@pytest.mark.parametrize(
    "key,value",
    [
        ("transcript_matches", "python3 scripts/x.py 129"),
        ("transcript_matches", "fetch-lesson\\\\.js\\\\s+129"),  # a script filename, regex-escaped
        ("transcript_contains", "ran fetch-lesson.js 129"),
        ("transcript_not_matches", "ok && node build\\\\.mjs"),
        ("transcript_not_contains", "$(bash deploy)"),
    ],
)
def test_command_shaped_transcript_value_warns(key, value, tmp_path):
    assert CMD_RULE in _rules(f"assert:\n  - {key}: '{value}'\n", tmp_path)


@pytest.mark.parametrize(
    "value",
    [
        "node count",  # bare interpreter word in prose: no operator before it, not at the start with an arg shape
        "metrics\\\\.json",  # data files are not scripts
        "the report\\\\.md was written",
        "config\\\\.yaml",
        "flagged the blank",
        "nodes",
    ],
)
def test_prose_transcript_value_is_clean(value, tmp_path):
    assert CMD_RULE not in _rules(f"assert:\n  - transcript_matches: '{value}'\n", tmp_path)


def test_command_shaped_fix_points_at_the_object_form(tmp_path):
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n"
        "assert:\n  - transcript_matches: 'python3 scripts/x.py 129'\n",
        encoding="utf-8",
    )
    [hit] = [x for x in scenario.lint_file(str(f)) if x.rule == CMD_RULE]
    assert hit.severity == "WARN"
    assert "tool_called" in hit.fix and "input" in hit.fix


RED_RULE = "tool-input-regex-redactable"


def test_negative_input_regex_naming_a_home_path_warns(tmp_path):
    body = "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'rm\\s+-rf\\s+/Users/acme' } }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_negative_input_any_naming_an_email_warns(tmp_path):
    body = "assert:\n  - tool_not_called: { tool: '*', input_any: 'alice@example\\.com' }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_positive_or_clean_negative_is_not_redactable(tmp_path):
    assert RED_RULE not in _rules("assert:\n  - tool_called: { tool: Bash, input: { command: '/Users/acme' } }\n", tmp_path)
    assert RED_RULE not in _rules("assert:\n  - tool_not_called: { tool: Bash, input: { command: 'git\\s+push' } }\n", tmp_path)


def test_redactable_rule_reads_a_policy_next_to_the_scenario(tmp_path):
    # A custom policy literal the built-in shapes do not know about.
    (tmp_path / ".cowork-redact.json").write_text(json.dumps({"patterns": [{"regex": "Acme(?:Corp)?", "label": "customer"}]}))
    body = "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'deploy AcmeCorp' } }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_redactable_rule_survives_the_repos_own_policy(tmp_path):
    # Every pattern in the repo's .cowork-redact.json uses variable-width lookbehind, which Python's `re`
    # cannot compile. The rule must not crash, and must still fire on a home-path literal.
    (tmp_path / ".cowork-redact.json").write_text((REPO / ".cowork-redact.json").read_text())
    body = "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'cat /Users/acme/notes' } }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_dict_tool_not_called_is_held_to_the_tier_table(tmp_path):
    assert "tool-not-called-tier-vacuous" in _rules_at("hostloop", "assert:\n  - tool_not_called: { tool: Bash }\n", tmp_path)
    assert "tool-not-called-tier-vacuous" in _rules_at(
        "hostloop", "assert:\n  - tool_not_called: { tool: [Bash, WebFetch], input: { command: x } }\n", tmp_path
    )
    # one served member keeps it satisfiable
    assert "tool-not-called-tier-vacuous" not in _rules_at(
        "hostloop", "assert:\n  - tool_not_called: { tool: [Bash, mcp__workspace__bash] }\n", tmp_path
    )


def test_dict_tool_called_still_arms_the_gate_witness(tmp_path):
    body = "assert:\n  - gate_answers_delivered: true\n  - tool_called: { tool: AskUserQuestion }\n"
    assert RULE not in _rules(body, tmp_path)
    # ...but a floor of zero witnesses nothing
    body0 = "assert:\n  - gate_answers_delivered: true\n  - tool_called: { tool: AskUserQuestion, count: { min: 0 } }\n"
    assert RULE in _rules(body0, tmp_path)


def test_literal_bash_command_check_at_hostloop_suggests_both_shells(tmp_path):
    body = "assert:\n  - tool_called: { tool: Bash, input: { command: 'build\\.py' } }\n"
    assert "tool-input-shell-tier" in _rules_at("hostloop", body, tmp_path)
    assert "tool-input-shell-tier" in _rules_at("cowork", body, tmp_path)
    assert "tool-input-shell-tier" not in _rules_at("container", body, tmp_path)
    listed = "assert:\n  - tool_called: { tool: [Bash, mcp__workspace__bash], input: { command: 'build\\.py' } }\n"
    assert "tool-input-shell-tier" not in _rules_at("hostloop", listed, tmp_path)


# --- the redaction policy, read OFFLINE: JS-only syntax is translated, never silently skipped --------


def test_every_pattern_in_the_repos_policy_translates_to_python():
    pats = json.loads((REPO / ".cowork-redact.json").read_text())["patterns"]
    compiled = [scenario._compile_js_redaction_pattern(p["regex"], p.get("flags", "")) for p in pats]
    assert all(c is not None for c in compiled), [p["regex"] for p, c in zip(pats, compiled) if c is None]
    assert len(compiled) == 18


def test_translated_slug_pattern_matches_a_project_slug():
    pats = json.loads((REPO / ".cowork-redact.json").read_text())["patterns"]
    slug = scenario._compile_js_redaction_pattern(pats[16]["regex"], pats[16].get("flags", ""))
    assert slug.search("cat /root/.claude/projects/-Users-acme-secret/x.jsonl")


def test_project_slug_literal_in_a_negative_regex_warns(tmp_path):
    body = "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'projects/-Users-acme' } }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_an_untranslatable_policy_pattern_warns_instead_of_staying_silent(tmp_path):
    (tmp_path / ".cowork-redact.json").write_text(json.dumps({"patterns": [{"regex": "\\p{Lu}{3,}Corp", "flags": "gu"}]}))
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n"
        "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'deploy' } }\n",
        encoding="utf-8",
    )
    hits = [x for x in scenario.lint_file(str(f)) if x.rule == RED_RULE]
    assert len(hits) == 1
    assert hits[0].severity == "WARN"
    assert "could not be checked offline" in hits[0].message


def test_untranslatable_pattern_is_quiet_without_a_negative_input_regex(tmp_path):
    (tmp_path / ".cowork-redact.json").write_text(json.dumps({"patterns": [{"regex": "\\p{Lu}{3,}Corp", "flags": "gu"}]}))
    assert RED_RULE not in _rules("assert:\n  - tool_called: { tool: Bash, input: { command: 'deploy' } }\n", tmp_path)


@pytest.mark.parametrize(
    "value",
    [
        "Node\\.js",
        "uses Next\\.js",
        "python 3\\.12",
        "python 3\\.11 or newer",
        "node v22\\.1 is installed",
        "the \\.ts files",
        "make sure the totals match",  # `make` is deliberately NOT a command verb: prose starts with it
        "node count",
    ],
)
def test_prose_about_tools_is_not_command_shaped(value, tmp_path):
    assert CMD_RULE not in _rules(f"assert:\n  - transcript_matches: '{value}'\n", tmp_path)


@pytest.mark.parametrize(
    "value",
    [
        "npm test",
        "npx tsc --noEmit",
        "git push origin main",
        "pip install requests",
        "curl https://example\\.com/x",
        "bash deploy",
        "ran npm test and it passed; then git push origin main",
    ],
)
def test_tool_invocations_are_command_shaped(value, tmp_path):
    assert CMD_RULE in _rules(f"assert:\n  - transcript_matches: '{value}'\n", tmp_path)


@pytest.mark.parametrize("key", ["tool_called", "tool_not_called"])
def test_object_form_scope_enum_is_checked_offline(key, tmp_path):
    # The scope enum lives inside an anyOf arm of the published schema; the generated enum map must reach it.
    assert "enum-value-invalid" in _rules(f"assert:\n  - {key}: {{ tool: Bash, scope: everywhere }}\n", tmp_path)
    assert "enum-value-invalid" not in _rules(f"assert:\n  - {key}: {{ tool: Bash, scope: any }}\n", tmp_path)


def test_generated_enum_map_reaches_union_arms():
    enums = json.loads(KEYS_JSON.read_text(encoding="utf-8"))["enums"]
    assert enums["assert.tool_called.scope"] == ["main", "subagent", "any"]
    assert enums["assert.tool_not_called.scope"] == ["main", "subagent", "any"]


def test_negative_regex_naming_an_anthropic_key_prefix_warns(tmp_path):
    # The operator-secret scrubber rewrites the whole key to [REDACTED], so `sk-ant-` is never visible offline.
    body = "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'sk-ant-' } }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_negative_regex_naming_a_scrub_value_warns(tmp_path, monkeypatch):
    monkeypatch.setenv("COWORK_HARNESS_SCRUB_VALUES", "hunter2-proxy-pass")
    body = "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'hunter2-proxy' } }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_negative_regex_naming_a_scrub_key_value_warns(tmp_path, monkeypatch):
    monkeypatch.setenv("MY_PROXY_TOKEN", "tok-9f8e7d6c5b")
    monkeypatch.setenv("COWORK_HARNESS_SCRUB_KEYS", "MY_PROXY_TOKEN")
    body = "assert:\n  - tool_not_called: { tool: Bash, input: { command: 'tok-9f8e7d' } }\n"
    assert RED_RULE in _rules(body, tmp_path)


def test_count_min_zero_without_max_is_flagged_as_always_passing(tmp_path):
    body = "assert:\n  - tool_called: { tool: Bash, count: { min: 0 } }\n"
    assert "tool-called-always-passes" in _rules(body, tmp_path)
    assert "tool-called-always-passes" not in _rules("assert:\n  - tool_called: { tool: Bash, count: { min: 0, max: 2 } }\n", tmp_path)


# --------------------------------------------------------------------------- #
# lint-skill size caps: the SKILL.md body the agent re-attaches after a compaction, and a reference
# file a whole-file Read can return. Behaviour, not just the constants — a sync test on the numbers
# stays green with the rule deleted.
# --------------------------------------------------------------------------- #

def _size_skill(tmp_path, body_bytes, ref_bytes=None, frontmatter="---\nname: t\ndescription: d\n---\n"):
    d = tmp_path / "sk"
    d.mkdir()
    (d / "SKILL.md").write_text(frontmatter + "x" * body_bytes, encoding="utf-8")
    if ref_bytes is not None:
        (d / "references").mkdir()
        (d / "references" / "big.md").write_text("y" * ref_bytes, encoding="utf-8")
    return d


def _size_rules(d):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = scenario.main(["lint-skill", "--json", str(d)])
    return code, {f["rule"] for f in json.loads(buf.getvalue())}


def _strict_exit(d):
    with contextlib.redirect_stdout(io.StringIO()):
        return scenario.main(["lint-skill", "--strict", str(d)])


def test_skill_body_25k_warns_over_reattach_cap(tmp_path):
    _, rules = _size_rules(_size_skill(tmp_path, 25_000))
    assert "skill-body-over-reattach-cap" in rules


def test_skill_body_15k_is_clean(tmp_path):
    _, rules = _size_rules(_size_skill(tmp_path, 15_000))
    assert not any(r.startswith("skill-body-") for r in rules)


def test_skill_body_cap_counts_the_body_not_the_frontmatter(tmp_path):
    # A long description is billed to the listing budget, not the re-attached body.
    big_fm = "---\nname: t\ndescription: " + "d" * 8_000 + "\n---\n"
    _, rules = _size_rules(_size_skill(tmp_path, 15_000, frontmatter=big_fm))
    assert not any(r.startswith("skill-body-") for r in rules)


def test_skill_body_notice_band_is_info_and_never_fails_strict(tmp_path):
    cap = scenario._SKILL_BODY_REATTACH_CAP
    d = _size_skill(tmp_path, int(cap * scenario._SKILL_BODY_NOTICE_RATIO) + 1)
    _, rules = _size_rules(d)
    assert "skill-body-near-reattach-cap" in rules
    assert "skill-body-over-reattach-cap" not in rules
    assert _strict_exit(d) == 0


def test_skill_body_boundary_exactly_at_cap_is_not_over(tmp_path):
    cap = scenario._SKILL_BODY_REATTACH_CAP
    _, at = _size_rules(_size_skill(tmp_path, cap))
    assert "skill-body-over-reattach-cap" not in at
    (tmp_path / "sk").rename(tmp_path / "sk-at")
    _, over = _size_rules(_size_skill(tmp_path, cap + 1))
    assert "skill-body-over-reattach-cap" in over


def test_skill_body_over_cap_fails_strict(tmp_path):
    assert _strict_exit(_size_skill(tmp_path, 25_000)) == 1


def test_skill_body_cap_counts_utf8_bytes(tmp_path):
    # 7,000 three-byte characters = 21,000 B but only 7,000 UTF-16 units. Bytes >= units, so the WARN
    # errs early — never late — against the agent's character-based cut.
    d = tmp_path / "sk"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: t\ndescription: d\n---\n" + "—" * 7_000, encoding="utf-8")
    _, rules = _size_rules(d)
    assert "skill-body-over-reattach-cap" in rules


def test_reference_95k_warns_over_read_cap(tmp_path):
    _, rules = _size_rules(_size_skill(tmp_path, 1_000, ref_bytes=95_000))
    assert "skill-reference-over-read-cap" in rules


def test_reference_under_read_cap_is_clean(tmp_path):
    _, rules = _size_rules(_size_skill(tmp_path, 1_000, ref_bytes=55_000))
    assert "skill-reference-over-read-cap" not in rules


def test_reference_65k_warns_before_25k_real_tokens(tmp_path):
    # Measured on this repo's markdown: ~2.65 B per real token (count_tokens), so 25,000 real tokens is
    # ~66 KB. A 65 KB reference sits just under that and must already warn — a cap in chars/4 terms
    # (100 KB) would stay silent on a file the Read gate truncates.
    _, rules = _size_rules(_size_skill(tmp_path, 1_000, ref_bytes=65_000))
    assert "skill-reference-over-read-cap" in rules


def test_reference_cap_message_says_partial_view_not_throw(tmp_path):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        scenario.main(["lint-skill", "--json", str(_size_skill(tmp_path, 1_000, ref_bytes=95_000))])
    msgs = [f["message"] for f in json.loads(buf.getvalue()) if f["rule"] == "skill-reference-over-read-cap"]
    assert msgs and "partial view" in msgs[0] and "throw" not in msgs[0]


def test_nested_reference_is_checked(tmp_path):
    d = _size_skill(tmp_path, 1_000)
    (d / "references" / "deep").mkdir(parents=True)
    (d / "references" / "deep" / "huge.md").write_text("z" * 95_000, encoding="utf-8")
    _, rules = _size_rules(d)
    assert "skill-reference-over-read-cap" in rules


def test_size_caps_carry_a_binary_verification_stamp():
    # The caps come from reading one agent build; the stamp names it, so check:claims can report its age.
    import re as _re

    assert _re.fullmatch(
        r"binary-verified against agent \d+\.\d+\.\d+ \(VM ELF and native, both read\)",
        scenario._SKILL_SIZE_CAPS_VERIFIED,
    )


# --- workspace_fixture (top-level key) and the object form of file_exists ---


def test_workspace_fixture_is_a_known_top_level_key(tmp_path):
    rules = _rules("workspace_fixture: fixtures/after-step-1\nassert:\n  - file_exists: outputs/step2.md\n", tmp_path)
    assert "unknown-top-key" not in rules
    assert "workspace_fixture" in scenario._EMBEDDED_TOP_LEVEL_KEYS


def test_metrics_is_a_known_top_level_key(tmp_path):
    rules = _rules(
        "metrics:\n  - {id: words, artifact: outputs/m.json, path: words, better: higher, scale: 100}\n"
        "assert:\n  - file_exists: outputs/m.json\n",
        tmp_path,
    )
    assert "unknown-top-key" not in rules
    assert "metrics" in scenario._EMBEDDED_TOP_LEVEL_KEYS


def test_file_exists_object_form_is_not_unknown_and_joins_the_absent_contradiction(tmp_path):
    rules = _rules("assert:\n  - file_exists: {path: outputs/x.md, authored: true}\n", tmp_path)
    assert "unknown-assert-key" not in rules
    rules = _rules(
        "assert:\n  - file_exists: {path: outputs/x.md, authored: true}\n  - file_absent: outputs/x.md\n",
        tmp_path,
    )
    assert "file-absent-contradiction" in rules


# hook_output_* needles: the harness's loader refuses a control character (a double-quoted YAML `\\b` is a
# backspace); the bundled linter must refuse what `run` refuses.
@pytest.mark.parametrize("key", ["hook_output_contains", "hook_output_not_contains"])
@pytest.mark.parametrize("field", ["text", "matches"])
def test_hook_output_control_char_is_an_error(tmp_path, key, field):
    found = [f for f in _findings(f'assert:\n  - {key}: {{ event: Stop, {field}: "\\bfailed open" }}\n', tmp_path)
             if f.rule == "hook-output-control-char"]
    assert len(found) == 1 and found[0].severity == "ERROR"
    assert f"{key}.{field}" in found[0].message


def test_hook_output_single_quoted_word_boundary_is_clean(tmp_path):
    rules = _rules("assert:\n  - hook_output_not_contains: { event: Stop, matches: '\\bfailed open\\b' }\n", tmp_path)
    assert "hook-output-control-char" not in rules


def test_hook_output_yaml11_booleans_are_not_a_contradiction(tmp_path):
    # `yes` and `on` both load as True under PyYAML but stay distinct strings in the harness
    body = "assert:\n  - hook_output_not_contains: { event: Stop, text: yes }\n  - hook_output_contains: { event: Stop, text: on }\n"
    assert "assert-contradiction" not in _rules(body, tmp_path)
    same = 'assert:\n  - hook_output_not_contains: { event: Stop, text: "x" }\n  - hook_output_contains: { event: Stop, text: "x" }\n'
    assert "assert-contradiction" in _rules(same, tmp_path)


# --- slash-skill-name-differs-from-plugin ----------------------------------------------------------
#
# Real Cowork's app resolves a typed slash command before the agent and refused a bare skill name that
# differs from its plugin's name. The rule reads the scenario's session file and its plugin directories.

_SLASH_RULE = "slash-skill-name-differs-from-plugin"


def _make_plugin(root, plugin_name, skill_dir, fm_name=None, manifest=True):
    d = root / f"plugin-{plugin_name}"
    if manifest:
        (d / ".claude-plugin").mkdir(parents=True)
        (d / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": plugin_name}), encoding="utf-8")
    sd = d / "skills" / skill_dir
    sd.mkdir(parents=True)
    (sd / "SKILL.md").write_text(
        f"---\nname: {fm_name or skill_dir}\ndescription: x\n---\nbody\n", encoding="utf-8"
    )
    return d


def _slash_findings(tmp_path, prompt, plugin_name="founder-skills", skill="deck-review", local_skill=None, key="local_plugins"):
    _make_plugin(tmp_path, plugin_name, skill)
    session = f"plugins:\n  {key}: [./plugin-{plugin_name}]\n"
    if local_skill:
        sd = tmp_path / "user-skills" / local_skill
        sd.mkdir(parents=True)
        (sd / "SKILL.md").write_text(f"---\nname: {local_skill}\n---\nbody\n", encoding="utf-8")
        session += f"skills:\n  local: [./user-skills/{local_skill}]\n"
    (tmp_path / "session.yaml").write_text(session, encoding="utf-8")
    f = tmp_path / "sc.yaml"
    f.write_text(
        "name: t\nbaseline: latest\nsession: session.yaml\nfidelity: container\n"
        f"prompt: {json.dumps(prompt)}\n",
        encoding="utf-8",
    )
    return [x for x in scenario.lint_file(str(f)) if x.rule == _SLASH_RULE]


def test_slash_skill_differs_from_plugin_is_flagged(tmp_path):
    found = _slash_findings(tmp_path, "/deck-review deck.pdf")
    assert len(found) == 1
    assert found[0].severity == "WARN"
    assert "`/founder-skills:deck-review`" in found[0].fix
    assert "may not in Cowork" in found[0].message


def test_slash_skill_differs_flagged_for_remote_plugins_and_bare_prompt(tmp_path):
    assert len(_slash_findings(tmp_path, "/deck-review", key="remote_plugins")) == 1


def _lint_slash_with(tmp_path, plugin_dir_name, prompt):
    (tmp_path / "session.yaml").write_text(f"plugins:\n  local_plugins: [./{plugin_dir_name}]\n", encoding="utf-8")
    f = tmp_path / "sc.yaml"
    f.write_text(
        f"name: t\nbaseline: latest\nsession: session.yaml\nfidelity: container\nprompt: {json.dumps(prompt)}\n",
        encoding="utf-8",
    )
    return [x for x in scenario.lint_file(str(f)) if x.rule == _SLASH_RULE]


def _write_skill(sd, fm_name=None):
    sd.mkdir(parents=True)
    (sd / "SKILL.md").write_text(f"---\nname: {fm_name or sd.name}\ndescription: x\n---\nbody\n", encoding="utf-8")


def test_slash_skill_quiet_on_frontmatter_name(tmp_path):
    # A plugin skill registers under its DIRECTORY name; a frontmatter `name:` that differs is not what
    # the agent registers, so `/fm-name` names no staged plugin skill.
    _make_plugin(tmp_path, "pkg", "dir-name", fm_name="fm-name")
    assert _lint_slash_with(tmp_path, "plugin-pkg", "/fm-name go") == []
    assert len(_lint_slash_with(tmp_path, "plugin-pkg", "/dir-name go")) == 1


def test_slash_skill_root_plugin_json_is_ignored_when_it_would_match(tmp_path):
    # A root-level plugin.json is not read by the agent: the plugin is named after its directory.
    d = tmp_path / "deck-review"
    d.mkdir()
    (d / "plugin.json").write_text(json.dumps({"name": "founder-skills"}), encoding="utf-8")
    _write_skill(d / "skills" / "deck-review")
    assert _lint_slash_with(tmp_path, "deck-review", "/deck-review x") == []


def test_slash_skill_root_plugin_json_is_ignored_when_it_would_hide(tmp_path):
    d = tmp_path / "founder-skills"
    d.mkdir()
    (d / "plugin.json").write_text(json.dumps({"name": "deck-review"}), encoding="utf-8")
    _write_skill(d / "skills" / "deck-review")
    found = _lint_slash_with(tmp_path, "founder-skills", "/deck-review x")
    assert len(found) == 1
    assert "`founder-skills`" in found[0].message


def test_slash_skill_honours_custom_skills_path(tmp_path):
    d = tmp_path / "plugin-pkg"
    (d / ".claude-plugin").mkdir(parents=True)
    (d / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "pkg", "skills": "./my-skills"}), encoding="utf-8")
    _write_skill(d / "my-skills" / "deck-review")
    _write_skill(d / "skills" / "also-loaded")
    assert len(_lint_slash_with(tmp_path, "plugin-pkg", "/deck-review x")) == 1
    # The agent loads skills/ whenever it exists, beside the manifest's paths.
    assert len(_lint_slash_with(tmp_path, "plugin-pkg", "/also-loaded x")) == 1


def test_slash_skill_custom_skills_path_list_and_schema(tmp_path):
    d = tmp_path / "plugin-pkg"
    (d / ".claude-plugin").mkdir(parents=True)
    (d / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "pkg", "skills": ["./a", "b"]}), encoding="utf-8"
    )
    _write_skill(d / "a" / "in-a")
    _write_skill(d / "b" / "in-b")
    assert len(_lint_slash_with(tmp_path, "plugin-pkg", "/in-a x")) == 1
    # An entry that is not "." or "./"-prefixed is refused by the agent's manifest schema.
    assert _lint_slash_with(tmp_path, "plugin-pkg", "/in-b x") == []


def test_slash_skill_matches_sanitized_directory_name(tmp_path):
    d = tmp_path / "plugin-pkg"
    (d / ".claude-plugin").mkdir(parents=True)
    (d / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "pkg"}), encoding="utf-8")
    _write_skill(d / "skills" / "my.skill")
    assert len(_lint_slash_with(tmp_path, "plugin-pkg", "/my-skill x")) == 1


def test_slash_skill_quiet_when_plugin_name_equals_skill(tmp_path):
    assert _slash_findings(tmp_path, "/deck-review deck.pdf", plugin_name="deck-review") == []


def test_slash_skill_quiet_when_qualified(tmp_path):
    assert _slash_findings(tmp_path, "/founder-skills:deck-review deck.pdf") == []


def test_slash_skill_quiet_for_user_skill(tmp_path):
    # A `skills.local` user skill of that name is not a plugin skill.
    assert _slash_findings(tmp_path, "/deck-review deck.pdf", local_skill="deck-review") == []


def test_slash_skill_quiet_for_user_skill_alone(tmp_path):
    # The only skill answering to the name is a `skills.local` user skill; the plugin's skill is another.
    assert _slash_findings(tmp_path, "/my-notes go", local_skill="my-notes") == []


def test_slash_skill_quiet_when_no_staged_skill_matches(tmp_path):
    assert _slash_findings(tmp_path, "/other-skill go") == []


@pytest.mark.parametrize("prompt", ["Review the deck with deck-review", "Use /deck-review on it", "/deck-review.", "/deck-reviewer x"])
def test_slash_skill_quiet_without_a_leading_bare_match(tmp_path, prompt):
    assert _slash_findings(tmp_path, prompt) == []


@pytest.mark.parametrize("session", ["(inline)", "missing.yaml"])
def test_slash_skill_quiet_when_session_unreadable(tmp_path, session):
    f = tmp_path / "sc.yaml"
    f.write_text(
        f"name: t\nbaseline: latest\nsession: {json.dumps(session)}\nfidelity: container\nprompt: /deck-review x\n",
        encoding="utf-8",
    )
    assert [x for x in scenario.lint_file(str(f)) if x.rule == _SLASH_RULE] == []


def test_hook_event_not_served_names_the_tiers_each_event_was_verified_at(tmp_path):
    # Each live-verified event says where it was observed firing, not a blanket "container and hostloop":
    # Stop and PreToolUse were recorded at container only.
    hooks = tmp_path / "plug" / "hooks"
    hooks.mkdir(parents=True)
    f = hooks / "hooks.json"
    f.write_text(json.dumps({"hooks": {"Stop": [], "PostToolUse": [], "TaskCreated": []}}), encoding="utf-8")
    msgs = {
        x.message.split("`")[1]: x.message
        for x in scenario._lint_hook_events(str(f))
        if x.rule == "hook-event-not-served"
    }
    assert "live-verified at `container`)" in msgs["Stop"]
    assert "hostloop" not in msgs["Stop"]
    assert "live-verified at `container` and `hostloop`)" in msgs["PostToolUse"]
    assert "has not been verified here" in msgs["TaskCreated"]


# --- unpaired-gates-all-scripted: say whether gates were expected -----------------------------------
# `gates_all_scripted` passes when no gate fired (nothing needed a person). A skill that stops asking
# then keeps the key green, so the author pairs it with a key that states the expectation: a delivered-
# gate floor (gate_answer_count_min >= 1, "gates were expected") or a question bound (questions_count_max).

UNPAIRED = "unpaired-gates-all-scripted"


@pytest.mark.parametrize("form", ["gates_all_scripted: true", "gates_all_scripted: {include_permissions: true}"])
def test_gates_all_scripted_alone_warns(form, tmp_path):
    f = _one(UNPAIRED, f"assert:\n  - {form}\n", tmp_path)
    assert f is not None and f.severity == "WARN"
    assert "gate_answer_count_min" in f.fix and "questions_count_max" in f.fix


@pytest.mark.parametrize("pair", ["gate_answer_count_min: 1", "questions_count_max: 0", "questions_count_max: 2"])
def test_gates_all_scripted_paired_is_silent(pair, tmp_path):
    assert UNPAIRED not in _rules(f"assert:\n  - gates_all_scripted: true\n  - {pair}\n", tmp_path)


def test_gates_all_scripted_with_a_zero_floor_still_warns(tmp_path):
    # `gate_answer_count_min: 0` always holds, so it states nothing about whether gates were expected.
    assert UNPAIRED in _rules("assert:\n  - gates_all_scripted: true\n  - gate_answer_count_min: 0\n", tmp_path)


# --- artifact-json-match: a glob `artifact` needs `match`, a literal one refuses it (the loader's rule) ---------


def _aj(tmp_path, art, extra=""):
    body = f'assert:\n  - artifact_json: {{artifact: "{art}", path: status, equals: ok{extra}}}\n'
    return _lint_cmd([_write_at(tmp_path, "container", body)], json_out=True, strict=False)


def test_artifact_json_glob_without_match_is_an_error(tmp_path):
    code, findings = _aj(tmp_path, "outputs/runs/*/run_status.json")
    hits = [x for x in findings if x["rule"] == "artifact-json-match"]
    assert len(hits) == 1 and hits[0]["severity"] == "ERROR"
    assert "match: each" in hits[0]["fix"] and "match: any" in hits[0]["fix"]
    assert code == 1


def test_artifact_json_literal_with_match_is_an_error(tmp_path):
    code, findings = _aj(tmp_path, "outputs/a.json", ", match: each")
    hits = [x for x in findings if x["rule"] == "artifact-json-match"]
    assert len(hits) == 1 and "literal" in hits[0]["message"]
    assert code == 1


def test_artifact_json_glob_with_match_is_clean_and_bracket_is_literal(tmp_path):
    for art, extra in (("outputs/runs/?/run_status.json", ", match: any"), ("outputs/[a].json", "")):
        _, findings = _aj(tmp_path, art, extra)
        assert not [x for x in findings if x["rule"] in ("artifact-json-match", "enum-value-invalid")], art


def test_artifact_json_match_enum(tmp_path):
    code, findings = _aj(tmp_path, "outputs/runs/*/run_status.json", ", match: all")
    hits = [x for x in findings if x["rule"] == "enum-value-invalid"]
    assert len(hits) == 1 and "assert.artifact_json.match: all" in hits[0]["message"]
    assert code == 1


def test_artifact_json_glob_with_trailing_slash_is_an_error(tmp_path):
    code, findings = _aj(tmp_path, "outputs/*/", ", match: each")
    hits = [x for x in findings if x["rule"] == "artifact-json-match"]
    assert len(hits) == 1 and "ends in" in hits[0]["message"]
    assert code == 1


def test_replay_noop_advice_names_only_keys_the_lane_allows(tmp_path):
    """On `lane: remote` user_visible_artifact and artifact_json are refused at load: the advice must not offer them."""
    body = "assert:\n  - egress_denied: example.com\n"
    for lane, offered in (("remote", False), ("local", True)):
        found = [f for f in scenario.lint_file(str(_write_lane(tmp_path, lane, body))) if f.rule == "replay-noop"]
        assert len(found) == 1, lane
        assert ("artifact_json" in found[0].fix) is offered, lane
        assert "file_exists" in found[0].fix

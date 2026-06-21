"""Example `cowork` lane tests. Run with: `pytest -m cowork` (from `python/`; needs `npm run build` + Docker + a token).

The non-marked test below is a self-check that the helper imports and the CLI path resolves —
it runs in the fast lane (no node/Docker), so CI's default `-m 'not cowork'` still exercises it.
"""
import io
import json
import os
from pathlib import Path

import pytest

from cowork_harness import BatchResult, Cowork, Result, serve_decider


def _serve(fn, request: dict) -> dict:
    """Drive serve_decider over one in-memory request line; return the parsed reply."""
    out = io.StringIO()
    serve_decider(fn, _in=io.StringIO(json.dumps(request) + "\n"), _out=out)
    return json.loads(out.getvalue().strip())


def test_serve_decider_bare_label_keys_first_question():
    req = {"id": "req_3", "questions": [{"question": "Which format?", "options": [{"label": "PDF"}]}]}
    # a bare label is keyed to the first question; the id is echoed back (harness rejects a mismatch)
    assert _serve(lambda r: "PDF", req) == {"id": "req_3", "answers": {"Which format?": "PDF"}}


def test_serve_decider_mapping_and_index_passthrough():
    req = {"id": "x", "questions": [{"question": "Which format?", "options": [{"label": "MD"}, {"label": "PDF"}]}]}
    # a mapping (multi-question / explicit) and a 1-based index both pass through verbatim
    assert _serve(lambda r: {"Which format?": 2}, req) == {"id": "x", "answers": {"Which format?": 2}}


def test_serve_decider_omits_id_when_absent():
    req = {"questions": [{"question": "Go?", "options": [{"label": "Yes"}]}]}
    assert _serve(lambda r: "Yes", req) == {"answers": {"Go?": "Yes"}}


def test_serve_decider_skips_malformed_line_keeps_serving(capsys):
    # #60: a malformed stdin line must NOT crash the helper — it warns to stderr and continues,
    # so a subsequent valid request is still answered (no bogus response envelope for the bad line).
    bad = "{ not json"
    good = {"id": "ok", "questions": [{"question": "Go?", "options": [{"label": "Yes"}]}]}
    out = io.StringIO()
    serve_decider(lambda r: "Yes", _in=io.StringIO(bad + "\n" + json.dumps(good) + "\n"), _out=out)
    # exactly ONE response line (the valid request); the bad line produced none.
    lines = [ln for ln in out.getvalue().splitlines() if ln.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0]) == {"id": "ok", "answers": {"Go?": "Yes"}}
    # and the skip was loud on stderr
    assert "::warning::" in capsys.readouterr().err


def test_helper_imports_and_cli_resolves():
    c = Cowork()
    # the CLI path resolves to <repo>/dist/cli.js (or COWORK_HARNESS_CLI)
    assert c.cli.endswith("cli.js") or os.environ.get("COWORK_HARNESS_CLI")


def test_result_assertions_are_pure():
    r = Result({"result": "success", "assertions": [], "subagents": [{"agentType": "researcher"}]}, "", ok=True)
    r.assert_success().assert_subagent_dispatched("researcher").assert_dispatch_count_max(3)


# ---- #M3: effective_fidelity and non_deterministic accessors ----

def test_result_effective_fidelity_accessor():
    r = Result({"result": "success", "effectiveFidelity": "container"}, "")
    assert r.effective_fidelity == "container"


def test_result_non_deterministic_accessor():
    r = Result({"result": "success", "nonDeterministic": True}, "")
    assert r.non_deterministic is True


def test_result_new_accessors_absent_returns_none():
    r = Result({"result": "success"}, "")
    assert r.effective_fidelity is None
    assert r.non_deterministic is None


# ---- #12: assert_tool_called reads toolCounts first ----

def test_assert_tool_called_reads_tool_counts_authoritative():
    # A tool in toolCounts with count > 0 must pass even when decisions[] is empty.
    r = Result({"result": "success", "toolCounts": {"Bash": 3, "Read": 1}, "decisions": []}, "")
    r.assert_tool_called("Bash")
    r.assert_tool_called("Read")


def test_assert_tool_called_fails_when_tool_counts_zero_and_not_in_decisions():
    r = Result({"result": "success", "toolCounts": {"Bash": 0}, "decisions": []}, "")
    with pytest.raises(AssertionError, match="tool not called"):
        r.assert_tool_called("Bash")


def test_assert_tool_called_uses_toolcounts_not_decisions():
    # toolCounts is authoritative: a prompted-but-not-executed tool (recorded only in decisions[]) must
    # NOT count as called — the old decisions[] fallback was a false positive.
    called = Result({"result": "success", "toolCounts": {"Read": 1}, "decisions": [{"name": "Read"}]}, "")
    called.assert_tool_called("Read")

    requested_not_run = Result({"result": "success", "toolCounts": {}, "decisions": [{"name": "Bash", "decision": "deny"}]}, "")
    with pytest.raises(AssertionError, match="tool not called"):
        requested_not_run.assert_tool_called("Bash")

    # An envelope with no toolCounts at all raises informatively rather than silently falling back.
    no_counts = Result({"result": "success", "decisions": [{"name": "Read"}]}, "")
    with pytest.raises(AssertionError, match="toolCounts missing"):
        no_counts.assert_tool_called("Read")


# ---- run_scenario must not pass --fidelity/--answer (they are scenario-authored) ----
# The `run` command takes exactly one <scenario.yaml|dir/> plus common flags and REJECTS extra
# arguments (fidelity is the scenario's `fidelity:` field; answers are its `answers:`). These tests pin
# the wrapper to that contract so it can't drift back to emitting flags `run` would reject.


def test_run_scenario_does_not_pass_fidelity_or_answer_flags(monkeypatch):
    captured: dict = {}
    c = Cowork.__new__(Cowork)  # skip __init__/_find_cli — we only inspect the built argv
    c.cli = "dist/cli.js"
    monkeypatch.setattr(c, "_invoke", lambda args, check=False: captured.setdefault("args", args))
    c.run_scenario("scenarios/x.yaml")
    args = captured["args"]
    assert args[:2] == ["run", "scenarios/x.yaml"]
    assert "--fidelity" not in args, "fidelity is scenario-authored; `run` rejects --fidelity"
    assert "--answer" not in args, "answers are scenario-authored; `run` rejects --answer"
    # the contract it DOES keep: json envelope + deterministic on-unanswered policy
    assert "--output-format" in args and "json" in args
    assert "--on-unanswered" in args


def test_run_scenario_signature_drops_fidelity_and_answers():
    # The params themselves are gone (not just unused) — a stale caller passing them must fail loudly,
    # not be silently accepted and then trip `run`'s usage error at the CLI boundary.
    import inspect

    params = inspect.signature(Cowork.run_scenario).parameters
    assert "fidelity" not in params
    assert "answers" not in params


# ---- #11: trace() raises on bad target / nonzero exit ----

def test_trace_raises_on_nonexistent_target():
    c = Cowork()
    with pytest.raises(RuntimeError, match="trace exited"):
        c.trace("/nonexistent/path/that/does/not/exist")


# ---- Honorable mention C: serve_decider wire shapes for permission / dialog / elicit ----

def test_serve_decider_permission_allow():
    req = {"id": "p1", "kind": "permission", "tool": "Bash", "input": {}}
    reply = _serve(lambda r: "allow", req)
    assert reply == {"id": "p1", "behavior": "allow"}


def test_serve_decider_permission_deny():
    req = {"id": "p2", "kind": "permission", "tool": "Write", "input": {}}
    reply = _serve(lambda r: "deny", req)
    assert reply == {"id": "p2", "behavior": "deny"}


def test_serve_decider_permission_deny_is_default_on_unknown():
    req = {"id": "p3", "kind": "permission", "tool": "Write", "input": {}}
    reply = _serve(lambda r: "something-else", req)
    assert reply["behavior"] == "deny"


def test_serve_decider_permission_mapping():
    req = {"id": "p4", "kind": "permission", "tool": "Bash"}
    reply = _serve(lambda r: {"behavior": "allow"}, req)
    assert reply == {"id": "p4", "behavior": "allow"}


def test_serve_decider_dialog_ok():
    req = {"id": "d1", "kind": "dialog", "dialogKind": "confirm"}
    reply = _serve(lambda r: "ok", req)
    assert reply == {"id": "d1", "behavior": "ok"}


def test_serve_decider_dialog_cancelled():
    req = {"id": "d2", "kind": "dialog", "dialogKind": "confirm"}
    reply = _serve(lambda r: "cancelled", req)
    assert reply == {"id": "d2", "behavior": "cancelled"}


def test_serve_decider_dialog_default_is_cancelled():
    req = {"id": "d3", "kind": "dialog"}
    reply = _serve(lambda r: "anything-else", req)
    assert reply["behavior"] == "cancelled"


def test_serve_decider_elicit_accept():
    req = {"id": "e1", "kind": "elicit", "prompt": "Enable feature?"}
    reply = _serve(lambda r: "accept", req)
    assert reply == {"id": "e1", "action": "accept"}


def test_serve_decider_elicit_decline():
    req = {"id": "e2", "kind": "elicit", "prompt": "Enable feature?"}
    reply = _serve(lambda r: "decline", req)
    assert reply == {"id": "e2", "action": "decline"}


def test_serve_decider_elicit_bare_cancel():
    # The bare-string form must be able to produce "cancel" (the TS side accepts accept|cancel|decline),
    # not collapse it to "decline".
    req = {"id": "e3c", "kind": "elicit"}
    reply = _serve(lambda r: "cancel", req)
    assert reply == {"id": "e3c", "action": "cancel"}


def test_serve_decider_elicit_default_is_decline():
    req = {"id": "e3", "kind": "elicit"}
    reply = _serve(lambda r: "anything-else", req)
    assert reply["action"] == "decline"


def test_serve_decider_elicit_mapping():
    req = {"id": "e4", "kind": "elicit"}
    reply = _serve(lambda r: {"action": "accept"}, req)
    assert reply == {"id": "e4", "action": "accept"}


# ---- #34: a multi-result run must NOT hide a later failure ----
# A directory run / replay can emit >1 RunResult. _invoke() used to keep only results[0]; a passing
# first result then masked a failing second. These tests pin the BatchResult path that surfaces it.


class _FakeProc:
    def __init__(self, stdout: str, returncode: int = 0, stderr: str = ""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


def _stub_cli_envelope(monkeypatch, envelope: dict, returncode: int = 0):
    """Make every node-CLI spawn return one JSON envelope on stdout (no real subprocess)."""
    import cowork_harness

    monkeypatch.setattr(
        cowork_harness.subprocess,
        "run",
        lambda *a, **k: _FakeProc(json.dumps(envelope), returncode=returncode),
    )


def _two_result_envelope(ok: bool):
    # ONE passing + ONE failing RunResult in a single envelope (the directory/replay shape).
    return {
        "ok": ok,
        "results": [
            {"result": "success", "assertions": [{"name": "a", "pass": True}]},
            {"result": "failure", "assertions": [{"name": "b", "pass": False}]},
        ],
    }


def test_invoke_returns_batchresult_for_multiple_results(monkeypatch):
    _stub_cli_envelope(monkeypatch, _two_result_envelope(ok=False))
    r = Cowork("dist/cli.js").run_scenario("scenarios/")
    assert isinstance(r, BatchResult)
    assert len(r) == 2


def test_batch_failure_is_surfaced_not_hidden(monkeypatch):
    # The crux of #34: one pass + one fail must NOT report success. The envelope ok is true here, so
    # ONLY the per-result inspection (not the envelope-level guard) can catch it — proving results[1:]
    # is no longer discarded.
    _stub_cli_envelope(monkeypatch, _two_result_envelope(ok=True))
    r = Cowork("dist/cli.js").run_scenario("scenarios/")
    assert isinstance(r, BatchResult)
    failed = r.failed_results()
    assert len(failed) == 1 and failed[0].result == "failure"
    with pytest.raises(AssertionError, match="1 of 2 results failed"):
        r.assert_success()


def test_batch_check_true_raises_on_later_failure(monkeypatch):
    # check=True must propagate the batch failure (a careless caller skipping assert_success()).
    _stub_cli_envelope(monkeypatch, _two_result_envelope(ok=True))
    with pytest.raises(AssertionError, match="results failed"):
        Cowork("dist/cli.js").run_scenario("scenarios/", check=True)


def test_batch_all_pass_succeeds(monkeypatch):
    env = {
        "ok": True,
        "results": [
            {"result": "success", "assertions": []},
            {"result": "success", "assertions": []},
        ],
    }
    _stub_cli_envelope(monkeypatch, env)
    r = Cowork("dist/cli.js").run_scenario("scenarios/")
    assert isinstance(r, BatchResult)
    r.assert_success()  # both passed → no raise


def test_single_result_still_returns_plain_result(monkeypatch):
    # A single-result envelope is unchanged: a Result, not a BatchResult (no behavior regression).
    _stub_cli_envelope(monkeypatch, {"ok": True, "results": [{"result": "success", "assertions": []}]})
    r = Cowork("dist/cli.js").run_scenario("scenarios/one.yaml")
    assert isinstance(r, Result)
    r.assert_success()


def test_batch_scalar_accessor_is_ambiguous_not_index0(monkeypatch):
    # The old collapse read index 0's `.result`. On a batch, `.result` must REFUSE (point at .results)
    # rather than silently report the first result's verdict and mask the rest.
    _stub_cli_envelope(monkeypatch, _two_result_envelope(ok=True))
    r = Cowork("dist/cli.js").run_scenario("scenarios/")
    for attr in ("result", "data", "artifacts", "out_dir"):
        with pytest.raises(RuntimeError, match="ambiguous"):
            getattr(r, attr)


def test_batch_iteration_exposes_each_result(monkeypatch):
    _stub_cli_envelope(monkeypatch, _two_result_envelope(ok=True))
    r = Cowork("dist/cli.js").run_scenario("scenarios/")
    verdicts = [res.result for res in r]
    assert verdicts == ["success", "failure"]
    assert r[1].failed_assertions() == [{"name": "b", "pass": False}]


@pytest.mark.cowork
def test_example_skill_runs(cowork):
    # Replace with a real skill folder; this documents the API.
    skill_dir = os.environ.get("COWORK_TEST_SKILL")
    if not skill_dir or not Path(skill_dir).exists():
        pytest.skip("set COWORK_TEST_SKILL to a skill folder to run this lane")
    r = cowork.skill(skill_dir).run("do something useful", fidelity="container", on_unanswered="first")
    r.assert_success()

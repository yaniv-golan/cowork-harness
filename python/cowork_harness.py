"""
cowork-harness pytest helper (B1) — the `cowork` lane.

Meets skill authors in pytest: drives the node CLI in `--output-format json` mode and exposes
assertions over the RunResult. This is an OPT-IN lane (mark tests `@pytest.mark.cowork`),
not the inner loop — each call spawns the node CLI (and Docker at container fidelity).

    def test_csv_metrics(cowork):
        # REPO_ROOT = Path(__file__).resolve().parents[1]
        r = cowork.skill(str(REPO_ROOT / "examples/skills/csv-metrics")).run(
            "compute the metrics", answers={"format": "Markdown"}, fidelity="container"
        )
        r.assert_success()
        r.assert_transcript_contains("metrics")
        r.assert_artifact_json("outputs/metrics.json", lambda d: d["rows"] == 5)
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Union


def _find_cli() -> str:
    env = os.environ.get("COWORK_HARNESS_CLI")
    if env:
        return env
    # default: <repo>/dist/cli.js (this file lives at <repo>/python/)
    repo = Path(__file__).resolve().parent.parent
    cli = repo / "dist" / "cli.js"
    return str(cli)


def _as_list(v) -> list[str]:
    if v is None:
        return []
    return [v] if isinstance(v, str) else list(v)


class Result:
    def __init__(self, data: dict[str, Any], stderr: str, ok: Optional[bool] = None, error: Optional[dict] = None):
        self.data = data  # a flat RunResult dict
        self.stderr = stderr
        # From the envelope: overall pass and the structured error (if the run threw).
        self.ok = ok
        self.error = error

    @property
    def result(self) -> str:
        return self.data.get("result", "error")

    @property
    def effective_fidelity(self) -> Optional[str]:
        """The tier actually used — differs from authored fidelity when scenario.fidelity='cowork' (#24)."""
        return self.data.get("effectiveFidelity")

    @property
    def non_deterministic(self) -> Optional[bool]:
        """True when the run was answered by an LLM, external, or human decider (#47/#48)."""
        return self.data.get("nonDeterministic")

    @property
    def out_dir(self) -> str:
        return self.data.get("outDir", "")

    @property
    def work_dir(self) -> str:
        # the agent's mnt/ root inside the run dir; falls back to the known layout for older envelopes
        return self.data.get("workDir") or str(Path(self.out_dir) / "work" / "session" / "mnt")

    @property
    def outputs_dir(self) -> str:
        # where the skill's user-visible deliverables land (mnt/outputs)
        return self.data.get("outputsDir") or str(Path(self.work_dir) / "outputs")

    @property
    def subagents(self) -> list[dict]:
        return self.data.get("subagents", []) or []

    @property
    def artifacts(self) -> list[dict]:
        """ENV-MANIFEST: files written under the user-visible prefixes (relative path + bytes).
        An EMPTY list on a run that should have produced a deliverable is the all-or-nothing
        truncated-run signal (necessary, not sufficient — pair with assert_success())."""
        return self.data.get("artifacts", []) or []

    def failed_assertions(self) -> list[dict]:
        return [a for a in self.data.get("assertions", []) if not a.get("pass")]

    # ---- assertions ----
    def assert_success(self) -> "Result":
        assert self.result == "success", f"run result was {self.result}\n{self.stderr[-1000:]}"
        assert not self.failed_assertions(), f"failed assertions: {self.failed_assertions()}"
        # `ok` is the authoritative SEAM-B verdict (same as the process exit code): it also fails on a
        # cowork-parity permissive auto-allow or a recorded delete/host-path leak the scenario didn't
        # assert about. Without this a Python-lane run would green where the CLI exits non-zero.
        assert self.ok, "run envelope ok=false (permissive auto-allow or an unasserted delete/host-path leak — see the run's signals)"
        return self

    def assert_transcript_contains(self, needle: str) -> "Result":
        t = self._transcript()
        assert needle in t, f'transcript missing "{needle}"'
        return self

    def assert_tool_called(self, name: str) -> "Result":
        # toolCounts is the authoritative O6 signal: a tool present with count > 0 was called. An older
        # decisions[]-based fallback matched a name that was merely REQUESTED (a prompted-then-denied tool
        # records its name in decisions) → a false positive. Rely on toolCounts only (the fallback is gone).
        tool_counts = self.data.get("toolCounts")
        if tool_counts is None:
            raise AssertionError(
                f"toolCounts missing from envelope — re-run/re-record to assert tool execution for {name!r}"
            )
        assert tool_counts.get(name, 0) > 0, f"tool not called: {name}"
        return self

    def assert_subagent_dispatched(self, agent_type: str) -> "Result":
        assert any(agent_type in s.get("agentType", "") for s in self.subagents), f"no sub-agent of type {agent_type} dispatched"
        return self

    def assert_dispatch_count_max(self, n: int) -> "Result":
        # SPEC §10 ceiling {global:3}
        assert len(self.subagents) <= n, f"dispatched {len(self.subagents)} sub-agents, max {n}"
        return self

    def assert_artifact_json(self, rel_path: str, predicate: Callable[[Any], bool]) -> "Result":
        # artifacts live under the work dir (mnt/); e.g. "outputs/cap.json"
        p = Path(self.work_dir) / rel_path
        assert p.exists(), f"artifact not found: {rel_path} (at {p})"
        data = json.loads(p.read_text())
        assert predicate(data), f"artifact predicate failed for {rel_path}"
        return self

    def _transcript(self) -> str:
        # prefer run.jsonl's transcript line
        rj = Path(self.out_dir) / "run.jsonl"
        if rj.exists():
            for line in rj.read_text().splitlines():
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if obj.get("t") == "transcript":
                    return obj.get("text", "")
        return ""


class BatchResult:
    """A multi-result run (directory input / replay producing >1 RunResult).

    The single-result accessors on `Result` read index 0 only, so collapsing a multi-result
    envelope to its first entry would hide every later result — a passing first result would
    mask a failing second one. `BatchResult` instead holds ALL results and refuses to answer
    a single-result question: `assert_success()` fails if ANY result failed (or the envelope
    `ok` is false), and the scalar accessors raise rather than silently picking index 0.
    """

    def __init__(self, results: list["Result"], stderr: str, ok: Optional[bool] = None, error: Optional[dict] = None):
        self.results = results  # one Result per RunResult, in envelope order
        self.stderr = stderr
        self.ok = ok
        self.error = error

    def __len__(self) -> int:
        return len(self.results)

    def __iter__(self):
        return iter(self.results)

    def __getitem__(self, i: int) -> "Result":
        return self.results[i]

    def failed_results(self) -> list["Result"]:
        """The constituent runs whose result was not "success" or that carry failed assertions."""
        return [r for r in self.results if r.result != "success" or r.failed_assertions()]

    def assert_success(self) -> "BatchResult":
        """Pass only when EVERY result passed and the envelope ok=true.

        A later failure can never be hidden: the first failing result (and the count) is reported.
        """
        failures = self.failed_results()
        assert not failures, (
            f"{len(failures)} of {len(self.results)} results failed; "
            f"first failure: result={failures[0].result} "
            f"assertions={failures[0].failed_assertions()}\n{self.stderr[-1000:]}"
        )
        # Envelope-level ok also catches a permissive auto-allow / unasserted host-path leak (see Result).
        assert self.ok, "run envelope ok=false (permissive auto-allow or an unasserted delete/host-path leak — see the run's signals)"
        return self

    # The scalar/index-0 accessors that `Result` exposes are ambiguous across multiple results. Refuse
    # them loudly (directing the caller to iterate `.results`) instead of silently reading index 0.
    # NB: raise RuntimeError, not AttributeError — an AttributeError from a property/__getattr__ would
    # be swallowed by Python's attribute-lookup fallback and re-surface as an opaque "no attribute".
    _AMBIGUOUS_ATTRS = frozenset({
        "result", "data", "out_dir", "outputs_dir", "work_dir", "artifacts", "subagents",
        "effective_fidelity", "non_deterministic", "failed_assertions",
        "assert_transcript_contains", "assert_tool_called", "assert_subagent_dispatched",
        "assert_dispatch_count_max", "assert_artifact_json",
    })

    def __getattr__(self, name: str):
        if name in BatchResult._AMBIGUOUS_ATTRS:
            raise RuntimeError(
                f"{name!r} is ambiguous on a multi-result run ({len(self.results)} results); "
                f"iterate `.results` (or index it) and inspect each Result, or call .assert_success()"
            )
        raise AttributeError(name)


class Skill:
    def __init__(self, runner: "Cowork", folder: str):
        self._runner = runner
        self._folder = folder

    def run(
        self,
        prompt: Optional[str] = None,
        answers: Optional[Mapping[str, str]] = None,
        fidelity: str = "container",
        on_unanswered: str = "fail",
        upload=None,        # str or list → --upload (attach files at mnt/uploads)
        folder=None,        # str or list → --folder (connect folders at mnt/.projects)
        session_id: Optional[str] = None,   # pin a stable session (for resume)
        resume: bool = False,               # continue a prior session_id (gated/checkpoint skills)
        decider_cmd: Optional[str] = None,  # answer LIVE questions via a spawned helper (stochastic gates)
        prompt_file: Optional[str] = None,  # pass the prompt verbatim from a file (vs inline)
        check: bool = False,                # raise on a failed/enveloped-error run instead of returning it
    ) -> Result:
        args = ["skill", self._folder]
        if prompt_file:
            args += ["--prompt-file", prompt_file]
        elif prompt is not None:
            args.append(prompt)
        args += ["--fidelity", fidelity]
        # Every channel keeps stdout free, so --decider-cmd composes with --output-format json like everything else.
        args += ["--output-format", "json", "--on-unanswered", on_unanswered]
        for q, choice in (answers or {}).items():
            args += ["--answer", f"{q}={choice}"]
        for u in _as_list(upload):
            args += ["--upload", u]
        for p in _as_list(folder):
            args += ["--folder", p]
        if session_id:
            args += ["--session-id", session_id]
        if resume:
            args.append("--resume")
        if decider_cmd:
            args += ["--decider-cmd", decider_cmd]
        return self._runner._invoke(args, check=check)


class Cowork:
    def __init__(self, cli: Optional[str] = None):
        self.cli = cli or _find_cli()

    def skill(self, folder: str) -> Skill:
        return Skill(self, folder)

    def run_scenario(
        self,
        path: str,
        *,
        on_unanswered: str = "fail",  # run's deterministic default
        check: bool = False,  # raise on a failed/enveloped-error run
    ) -> Union[Result, "BatchResult"]:
        """#2: run an authored scenario YAML (or a directory of them) and return the typed result.

        A single scenario returns a `Result`; a DIRECTORY input (multiple scenarios → multiple
        RunResults) returns a `BatchResult` holding every result, so a later failure is never hidden
        behind a passing first one. Call `.assert_success()` on either — on a BatchResult it
        fails if ANY constituent run failed.

        Removes the subprocess-spawn + JSON-parse + outputs-dir-resolution boilerplate every consumer
        otherwise reinvents. The Result exposes `.outputs_dir` (the resolved artifacts dir),
        `.artifacts` (the ENV-MANIFEST), `.effective_fidelity`, and the assertions — so a test can also
        prove which tier actually ran (e.g. cowork → hostloop).

        Fidelity and AskUserQuestion answers are SCENARIO-AUTHORED, not wrapper arguments: set them in
        the scenario YAML's `fidelity:` / `answers:` fields. The `run` command deliberately rejects
        `--fidelity` / `--answer` (it takes one <scenario.yaml|dir/> plus common flags only), so the
        wrapper must never pass them — doing so trips a usage error. To vary fidelity or answers per run,
        author distinct scenario files (or edit the YAML) rather than overriding from Python."""
        args = ["run", str(path), "--output-format", "json", "--on-unanswered", on_unanswered]
        return self._invoke(args, check=check)

    def replay(self, cassette: str) -> Union[Result, "BatchResult"]:
        # A cassette/directory replay producing >1 RunResult returns a BatchResult.
        return self._invoke(["replay", cassette, "--output-format", "json"])

    def trace(self, target: str, tools: bool = False) -> list[dict]:
        """Digest a run's events.jsonl → rows (tool calls, sub-agent dispatches, decisions).

        Raises RuntimeError on a nonzero exit code or unparseable stdout so that a failed
        trace is never silently indistinguishable from a legitimately empty trace (#11).
        """
        args = ["trace", target, "--output-format", "json"] + (["--tools"] if tools else [])
        proc = subprocess.run(["node", self.cli, *args], capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(
                f"cowork-harness trace exited {proc.returncode}\n"
                f"stderr: {proc.stderr.strip()}\n"
                f"stdout: {proc.stdout.strip()}"
            )
        try:
            return json.loads(proc.stdout).get("rows", [])
        except ValueError as exc:
            raise RuntimeError(
                f"cowork-harness trace returned unparseable stdout: {exc!r}\n"
                f"stdout: {proc.stdout[:500]}"
            ) from exc

    def _invoke(self, args: list[str], check: bool = False) -> Union[Result, BatchResult]:
        proc = subprocess.run(["node", self.cli, *args], capture_output=True, text=True)
        # --output-format json emits exactly one envelope on stdout (all channels keep stdout free). Take the
        # last envelope-shaped line defensively in case anything else prints.
        env: dict = {}
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and ("results" in obj or "ok" in obj):
                env = obj
        # Surface a nonzero exit code when no well-formed envelope was parsed (#10).
        # When the envelope IS present (even with result:"error"), assert_success() handles it —
        # preserve that path and don't raise on envelope-level errors.
        if proc.returncode != 0 and not env:
            raise RuntimeError(
                f"cowork-harness exited {proc.returncode} with no parseable JSON envelope\n"
                f"stderr: {proc.stderr.strip()}\n"
                f"stdout: {proc.stdout.strip()}"
            )
        results = env.get("results") or []
        ok = env.get("ok")
        error = env.get("error")
        # A directory run / replay can produce >1 RunResult. Collapsing to results[0] would discard
        # results[1:] and hide any later failure: the single-result accessors only read index 0.
        # Return a BatchResult that holds every result and whose assert_success() fails if ANY failed.
        if len(results) > 1:
            batch = BatchResult(
                [Result(d, proc.stderr, ok=ok, error=error) for d in results], proc.stderr, ok=ok, error=error
            )
            if check:
                batch.assert_success()
            return batch
        data = results[0] if results else {"result": "error", "raw": proc.stdout.strip()}
        result = Result(data, proc.stderr, ok=ok, error=error)
        # Opt-in (#10 default is non-raising): check=True raises on a failed/enveloped-error run so a
        # careless caller that skips assert_success() doesn't treat a failed-but-enveloped run as success.
        if check:
            result.assert_success()
        return result


def run_scenario(
    path: str,
    *,
    on_unanswered: str = "fail",
    check: bool = False,
    cli: Optional[str] = None,
) -> Union[Result, BatchResult]:
    """#2: module-level convenience — run an authored scenario YAML in one call.

    A directory input (multiple scenarios) returns a `BatchResult`; see `Cowork.run_scenario`.

        from cowork_harness import run_scenario
        r = run_scenario("scenarios/cap_table.yaml")  # fidelity/answers live in the YAML
        r.assert_success()
        assert r.effective_fidelity == "hostloop"   # prove which tier ran (fidelity is the tiebreaker)
        assert any(a["path"] == "outputs/cap_state.json" for a in r.artifacts)

    Fidelity and answers are scenario-authored (the scenario YAML's `fidelity:` / `answers:` fields);
    the `run` command rejects `--fidelity` / `--answer`, so they are not wrapper arguments.
    """
    return Cowork(cli).run_scenario(path, on_unanswered=on_unanswered, check=check)


def serve_decider(fn: Callable[[dict], Any], *, _in=None, _out=None) -> None:
    """Run the `--decider-cmd` wire protocol so a helper writes ONLY the decision.

    This is the spawn-helper counterpart to the CLI's `gates`/`answer` commands (which pre-built
    the loop for `--decider-dir`): instead of hand-writing the readline → JSON-parse → answer-envelope
    → flush loop, a `--decider-cmd` helper is just::

        # my_decider.py
        from cowork_harness import serve_decider
        serve_decider(lambda req: {"Which format?": "PDF"})

    then `…run(decider_cmd="python my_decider.py")`. `fn(request)` is called once per gate with the
    decision_request dict. Dispatch is by `request["kind"]`:

      - `"question"`: return a mapping {question_text: label_or_1based_index} (full control,
        multi-question), or a bare label/index applied to the FIRST question (the common case).
        Reply shape: `{"answers": {...}}`.
      - `"permission"`: return `"allow"` or `"deny"` (a bare string) OR a dict with `"behavior"`.
        Reply shape: `{"behavior": "allow"|"deny"}`.
      - `"dialog"`: return `"ok"` or `"cancelled"` OR a dict with `"behavior"`.
        Reply shape: `{"behavior": "ok"|"cancelled"}`.
      - `"elicit"`: return `"accept"` or `"decline"` OR a dict with `"action"`.
        Reply shape: `{"action": "accept"|"decline"}`.

    The adapter echoes `request["id"]` back and flushes per line. (The id echo only matters for the
    `--decider-dir` rendezvous; the spawn channel is single-outstanding-request, so it's a no-op there.)

    Wire shapes confirmed against `ExternalDecider.normalize` (`src/decide/decider.ts`):
      - permission: `normalize` reads `parsed.behavior === "allow"` → allow/deny.
      - dialog:     `normalize` reads `parsed.behavior === "ok"` → ok/cancelled.
      - elicit:     `normalize` reads `parsed.action === "accept"` / `=== "cancel"` → accept/cancel/decline.
    """
    import sys

    rin = _in or sys.stdin
    rout = _out or sys.stdout
    for raw in rin:
        line = raw.strip()
        if not line:
            continue
        # #60: a malformed stdin line must not kill the helper mid-stream — warn loudly to stderr and
        # skip it (no bogus response envelope), so subsequent gates are still served.
        try:
            req = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            sys.stderr.write(f"::warning:: serve_decider: skipping malformed request line: {line[:200]}\n")
            sys.stderr.flush()
            continue
        kind = req.get("kind", "question")
        ans = fn(req)

        if kind == "permission":
            # fn may return "allow"/"deny" (bare string) or {"behavior": "allow"|"deny", "grant": ...}
            if isinstance(ans, Mapping):
                reply: dict = {"behavior": ans.get("behavior", "deny")}
                # preserve the web_fetch grant scope so a domain-wide approval isn't silently
                # downgraded to "once" on the TS side (decider.ts reads parsed.grant === "domain").
                grant = ans.get("grant")
                if grant in ("once", "domain"):
                    reply["grant"] = grant
            else:
                reply = {"behavior": "allow" if str(ans) == "allow" else "deny"}
        elif kind == "dialog":
            # fn may return "ok"/"cancelled" (bare string) or {"behavior": "ok"|"cancelled"}
            if isinstance(ans, Mapping):
                reply = {"behavior": ans.get("behavior", "cancelled")}
            else:
                reply = {"behavior": "ok" if str(ans) == "ok" else "cancelled"}
        elif kind == "elicit":
            # fn may return "accept"/"cancel"/"decline" (bare string) or {"action": ...}. The TS side
            # accepts all three; the bare form must be able to produce "cancel", not collapse it to decline.
            if isinstance(ans, Mapping):
                reply = {"action": ans.get("action", "decline")}
            else:
                a = str(ans)
                reply = {"action": a if a in ("accept", "cancel", "decline") else "decline"}
        else:
            # Default: question kind — fn returns a mapping or a bare label/index
            if not isinstance(ans, Mapping):
                # bare label/index → key it to the first question (question text, else header)
                q = (req.get("questions") or [{}])[0]
                ans = {(q.get("question") or q.get("header") or ""): ans}
            reply = {"answers": dict(ans)}

        if req.get("id") is not None:
            reply["id"] = req["id"]
        rout.write(json.dumps(reply) + "\n")
        rout.flush()

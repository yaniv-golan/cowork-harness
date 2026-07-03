#!/usr/bin/env python3
"""scenario.py — author and check cowork-harness scenarios without hallucinating the schema.

Two subcommands:

  scenario.py scaffold  ...   emit a VALID scenario skeleton (real keys, correct tier,
                              content vs live-only assertions split one-per-item). The
                              generator self-lints its own output and refuses to emit a
                              scenario its own linter would reject.

  scenario.py lint  FILE...   catch silent false-greens in existing scenarios. The
                              cowork-harness has several ways to make a check *silently
                              do nothing*; this encodes those invariants so they fail at
                              author time / in CI instead of rotting as a green-but-empty
                              assertion.

lint flags (see references/scenario-schema.md for the why of each):
  E  egress assertion on `fidelity: protocol`        (the harness rejects this run)
  E  on_unanswered: agent / invalid value            (schema rejects `agent`)
  E  authored `replay_protocol_fidelity` assertion   (replay-synthesized only)
  E  `assertions:` instead of `assert:`              (block ignored → every check no-ops)
  W  no content assertion → no-op on a replay gate    (every assertion is fs/egress)
  W  mixed-class assert item → fs/egress half dropped on replay
  W  unknown top-level / assertion key                (typo or hallucinated schema)
  W  double-quoted regex with a backslash             (YAML eats the backslash)
  I  gate key present → needs a controlOut cassette on replay

Designed for agents and CI: non-interactive, --help, --json, meaningful exit codes,
idempotent. `lint` exits 1 on any ERROR (or any finding with --strict); else 0.

Uses PyYAML — a pure-Python copy is bundled under `_vendor/`, so no separate install is needed; a
system PyYAML is preferred when present.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# --- the replay-class taxonomy ---
# NB: this is NOT a 1:1 mirror of `contentKeys` in src/run/cassette.ts. cassette.ts keeps the verdict
# modifiers (VERDICT_MODIFIER_KEYS) in its content set so they replay as no-op passes; the linter
# deliberately keeps them OUT of CONTENT_KEYS so a modifier-only scenario still trips the `replay-noop`
# warning below (a no-op pass verifies nothing real — exactly what that warning is for).
CONTENT_KEYS = {
    "result",
    "transcript_contains",
    "transcript_not_contains",
    "transcript_matches",
    "transcript_not_matches",
    "tool_result_contains",
    "tool_result_not_contains",
    "tool_called",
    "tool_not_called",
    "subagent_tool_used",
    "subagent_tool_absent",
    "subagent_dispatched",
    "subagent_declared_but_unused",
    "dispatch_count_max",
    "skill_triggered",
    "no_skill_triggered",
    "max_cost_usd",
    "max_tokens",
    "tool_calls_max",
}
# content keys, but only evaluated on replay when the cassette carries controlOut
GATE_KEYS = {"question_asked", "questions_count_max", "gate_answers_delivered"}
# manifest-backed: replay-checkable when the cassette carries an `artifacts` manifest (record snapshots one);
# a manifest-less cassette skips them. Since the 0.3.0 artifact-manifest these are NOT always live-only.
MANIFEST_KEYS = {"file_exists", "user_visible_artifact", "artifact_json"}
# live-only: ALWAYS skipped on replay, with a loud warning (no filesystem, no network on the token-free lane)
LIVE_ONLY_KEYS = {
    "egress_denied",
    "egress_allowed",
    "no_delete_in_outputs",
    "self_heal_ran",
    "transcript_no_host_path",
}
EGRESS_KEYS = {"egress_denied", "egress_allowed"}
# verdict modifiers — don't verify anything themselves (e.g. suppress a default-fail)
VERDICT_MODIFIER_KEYS = {
    "allow_permissive_auto_allow",
    "allow_l0_plugin_divergence",
    "allow_missing_capability",
    "allow_stall",
}

# Every key the replay-class logic knows how to handle. `replay_protocol_fidelity` is valid-but-not-authorable
# (errored separately below). This is also the embedded fallback for ASSERT_KEYS — kept EQUAL to the generated
# list (test-enforced) so a missing assertion-keys.json can't silently reintroduce key drift.
_CLASSIFIED_KEYS = CONTENT_KEYS | GATE_KEYS | MANIFEST_KEYS | LIVE_ONLY_KEYS | VERDICT_MODIFIER_KEYS | {"replay_protocol_fidelity"}


def _load_assert_keys():
    """The authoritative `assert:` key set, generated from the Zod Assertion schema into a sibling
    `assertion-keys.json` (so the unknown-key check can't drift). Falls back to the embedded
    `_CLASSIFIED_KEYS` (kept equal to the generated list) with a loud warning if the file is missing."""
    p = Path(__file__).resolve().parent / "assertion-keys.json"
    try:
        return set(json.loads(p.read_text(encoding="utf-8"))["keys"])
    except Exception:
        print(
            f"::warning:: assertion-keys.json not found next to scenario.py ({p}) — "
            "using a built-in key list that may be stale (run `npm run schema`).",
            file=sys.stderr,
        )
        return set(_CLASSIFIED_KEYS)


# every valid key inside an `assert:` list item (generated from the zod schema; see _load_assert_keys)
ASSERT_KEYS = _load_assert_keys()

# Self-check: every valid assertion key must be classified, else the replay-class lint logic mishandles it.
# Surfaced loudly at load AND as a lint ERROR in cmd_lint (so --strict / exit codes flow). Never sys.exit here.
UNCLASSIFIED_KEYS = sorted(ASSERT_KEYS - _CLASSIFIED_KEYS)
if UNCLASSIFIED_KEYS:
    print(
        f"::warning:: scenario.py: assertion key(s) {UNCLASSIFIED_KEYS} are in the schema but not classified "
        "— add them to the linter's CONTENT/GATE/MANIFEST/LIVE_ONLY/VERDICT_MODIFIER sets.",
        file=sys.stderr,
    )
# Embedded fallback for the top-level scenario keys — kept EQUAL to the generated `topLevelKeys`
# (test-enforced, like _CLASSIFIED_KEYS for assert keys) so a missing assertion-keys.json can't silently
# reintroduce key drift. `profile`/`assertions` are NOT here — they are deprecated aliases handled by the
# special-cases in the unknown-key check below (`k != "assertions" and k != "profile"`).
_EMBEDDED_TOP_LEVEL_KEYS = {
    "name",
    "baseline",
    "session",
    "fidelity",
    "on_unanswered",
    "prompt",
    "answers",
    "expect_denied",
    "assert",
    "skills",  # F-6: opt-in skill-staleness hash scope
    "requires_capabilities",  # Fix 4b: scenario-level required-capability declaration (pre-flight gate)
    "allow_host_writes",  # hostloop native-split: consent for a writable connected folder (pre-run gate)
}


def _load_top_level_keys():
    """The authoritative top-level scenario-key set, generated from the Zod ScenarioObject schema into
    `assertion-keys.json` (so the unknown-key check can't drift and false-flag a valid key). Falls back to
    the embedded `_EMBEDDED_TOP_LEVEL_KEYS` (kept equal to the generated list) with a loud warning if the
    file is missing or predates the `topLevelKeys` field."""
    p = Path(__file__).resolve().parent / "assertion-keys.json"
    try:
        keys = json.loads(p.read_text(encoding="utf-8")).get("topLevelKeys")
        if not keys:
            raise KeyError("topLevelKeys")
        return set(keys)
    except Exception:
        print(
            f"::warning:: assertion-keys.json missing or has no topLevelKeys next to scenario.py ({p}) — "
            "using a built-in top-level-key list that may be stale (run `npm run schema`).",
            file=sys.stderr,
        )
        return set(_EMBEDDED_TOP_LEVEL_KEYS)


# every valid top-level scenario key (generated from the zod ScenarioObject schema; see _load_top_level_keys)
TOP_LEVEL_KEYS = _load_top_level_keys()
REGEX_KEYS = {
    "transcript_matches",
    "transcript_not_matches",
    "when_question",
    "subagent_dispatched",
    "question_asked",
}
VALID_ON_UNANSWERED = {"fail", "prompt", "first", "llm"}
VALID_TIERS = ("protocol", "container", "microvm", "hostloop", "cowork")


class Finding:
    __slots__ = ("severity", "rule", "message", "fix", "file", "line")

    def __init__(self, severity, rule, message, fix, file, line=None):
        self.severity = severity  # "ERROR" | "WARN" | "INFO"
        self.rule = rule
        self.message = message
        self.fix = fix
        self.file = file
        self.line = line

    def as_dict(self):
        return {
            "severity": self.severity,
            "rule": self.rule,
            "message": self.message,
            "fix": self.fix,
            "file": self.file,
            "line": self.line,
        }


def _assert_items(doc):
    """Return the list of assert items (each a dict), tolerating shapes."""
    a = doc.get("assert")
    if a is None:
        return []
    if isinstance(a, dict):  # someone wrote a single mapping instead of a list
        return [a]
    if isinstance(a, list):
        return [x for x in a if isinstance(x, dict)]
    return []


def _all_assert_keys(items):
    keys = set()
    for item in items:
        keys |= set(item.keys())
    return keys


def _is_positional_choose(choose):
    """True if a `choose` value selects by POSITION — `first` or a 1-based index (scalar or in a
    multiSelect list) — as opposed to an exact label. Positional answers are order-dependent (H1)."""
    vals = choose if isinstance(choose, list) else [choose]
    return any(isinstance(v, str) and (v == "first" or v.isdigit()) for v in vals)


def lint_doc(doc, path, raw_lines):
    findings = []
    if not isinstance(doc, dict):
        findings.append(
            Finding(
                "ERROR",
                "parse",
                "scenario is not a YAML mapping (expected top-level keys like prompt/assert)",
                "Check the file is a single scenario document.",
                path,
            )
        )
        return findings

    fidelity = (doc.get("fidelity") or "container")
    items = _assert_items(doc)
    assert_keys = _all_assert_keys(items)
    has_expect_denied = bool(doc.get("expect_denied"))

    # E: `assertions:` instead of `assert:` — a common hallucination. The block is
    # silently ignored by the harness, so every "assertion" is a no-op (false-green).
    if "assertions" in doc and "assert" not in doc:
        findings.append(
            Finding(
                "ERROR",
                "assertions-key",
                "scenario uses `assertions:` — the real key is `assert:`. The harness ignores "
                "`assertions:`, so NONE of these checks run (a guaranteed silent false-green).",
                "Rename the block to `assert:` and use flat keys (e.g. `- file_exists: outputs/x.md`).",
                path,
            )
        )

    # W: unknown top-level keys (typo or hallucinated schema)
    for k in doc:
        if k not in TOP_LEVEL_KEYS and k != "assertions" and k != "profile":
            findings.append(
                Finding(
                    "WARN",
                    "unknown-top-key",
                    f"unknown scenario key `{k}` — not part of the schema (typo or hallucination?).",
                    f"Valid top-level keys: {', '.join(sorted(TOP_LEVEL_KEYS))}.",
                    path,
                )
            )

    # W: unknown assertion keys inside assert items (e.g. invented file_not_empty, kind, path)
    unknown_assert = sorted(assert_keys - ASSERT_KEYS)
    for k in unknown_assert:
        findings.append(
            Finding(
                "WARN",
                "unknown-assert-key",
                f"unknown assertion key `{k}` — not in the assertion catalog (the harness would "
                "ignore it, so it silently does nothing).",
                "Use a real assertion key — see references/scenario-schema.md for the full catalog.",
                path,
            )
        )

    # E: egress assertion on protocol fidelity (the harness rejects the run)
    egress_used = bool(assert_keys & EGRESS_KEYS) or has_expect_denied
    if fidelity == "protocol" and egress_used:
        findings.append(
            Finding(
                "ERROR",
                "egress-on-protocol",
                "egress assertion (egress_*/expect_denied) on `fidelity: protocol` — the harness "
                "rejects this run because protocol has no egress enforcement (it would false-pass).",
                "Use fidelity: container (or microvm/hostloop) for any egress/expect_denied check.",
                path,
            )
        )

    # E: retired/invalid on_unanswered
    ou = doc.get("on_unanswered")
    if ou is not None and ou not in VALID_ON_UNANSWERED:
        extra = " (`agent` was renamed to `llm`)" if ou == "agent" else ""
        findings.append(
            Finding(
                "ERROR",
                "on-unanswered-invalid",
                f"on_unanswered: {ou} is not a valid value{extra}.",
                "Use one of: fail | prompt | first | llm (YAML). For a live model use on_unanswered: llm.",
                path,
            )
        )

    # E: authored replay_protocol_fidelity
    if "replay_protocol_fidelity" in assert_keys:
        findings.append(
            Finding(
                "ERROR",
                "authored-replay-fidelity",
                "`replay_protocol_fidelity` is synthesized by the replay lane only and cannot be authored.",
                "Remove it — on a live run it evaluates as an empty assertion.",
                path,
            )
        )

    # W: nothing replay-checkable → a replay PR gate verifies nothing. Content/gate are replay-checkable, and
    # manifest-backed keys are too WHEN the cassette carries an artifacts manifest — so only an all-live-only
    # (egress / no_delete / self_heal / host-path) assert set genuinely no-ops on replay.
    if items:
        replay_checkable = bool(assert_keys & (CONTENT_KEYS | GATE_KEYS | MANIFEST_KEYS))
        if not replay_checkable:
            findings.append(
                Finding(
                    "WARN",
                    "replay-noop",
                    "every assertion is live-only (egress / no_delete_in_outputs / self_heal_ran / "
                    "transcript_no_host_path) or a verdict modifier (allow_*, a no-op pass) — on the "
                    "token-free `replay` lane the live-only ones are skipped (with a loud warning) and the verdict "
                    "modifiers verify nothing, so a replay PR gate would verify nothing.",
                    "Add a content assertion (result / transcript_* / tool_* / subagent_*) or a "
                    "manifest-backed one (file_exists / user_visible_artifact / artifact_json), or run this "
                    "scenario only on the live (run/record) lane.",
                    path,
                )
            )

    # W: mixed-class assert item → the live-only half is dropped on replay (manifest-backed keys are NOT)
    for idx, item in enumerate(items):
        ks = set(item.keys())
        kept_half = ks & (CONTENT_KEYS | GATE_KEYS | MANIFEST_KEYS)
        live_half = ks & LIVE_ONLY_KEYS
        if kept_half and live_half:
            findings.append(
                Finding(
                    "WARN",
                    "mixed-assert-item",
                    f"assert item #{idx} mixes replay-checkable {sorted(kept_half)} with "
                    f"live-only {sorted(live_half)} — on replay the live-only half is dropped "
                    "(only the replay-checkable half is evaluated).",
                    "Split into separate list items: one per concern.",
                    path,
                )
            )

    # I: manifest-backed keys need an artifacts manifest on replay
    manifest_present = sorted(assert_keys & MANIFEST_KEYS)
    if manifest_present:
        findings.append(
            Finding(
                "INFO",
                "manifest-needs-snapshot",
                f"assertion(s) {manifest_present} evaluate on replay only when the cassette carries an "
                "`artifacts` manifest (`record` snapshots one). A manifest-less cassette skips them "
                "(with a loud warning).",
                "If the cassette carries no `artifacts` manifest (recorded by an older harness), re-record "
                "so these assertions evaluate against the captured artifacts; a current cassette already has one.",
                path,
            )
        )

    # I (H1): a positional `choose` (first / 1-based index) is robust to LABEL drift but NOT to option
    # RE-ORDERING — the gate's option order can vary run-to-run, so the index can land on a different option.
    # Advisory only: a stable-order gate IS reproducible, and the linter can't tell stable from unstable order.
    answers = doc.get("answers")
    positional = []
    if isinstance(answers, list):  # a scenario's `answers:` is always a bare list of rules
        for idx, rule in enumerate(answers):
            if isinstance(rule, dict) and _is_positional_choose(rule.get("choose")):
                positional.append(idx)
    if positional:
        findings.append(
            Finding(
                "INFO",
                "positional-choose-order",
                f"answer rule(s) {positional} use a positional `choose` (first / index) — robust to label "
                "drift but NOT to option re-ordering: the gate's option order can vary run-to-run, so the "
                "index can land on a different option (a silent re-record flake).",
                'If the gate\'s option order is stable, pin by exact label (choose: "<label>"); use a '
                "positional index only when labels drift but order holds.",
                path,
            )
        )

    # I: gate keys need a controlOut cassette on replay
    gate_present = sorted(assert_keys & GATE_KEYS)
    if gate_present:
        findings.append(
            Finding(
                "INFO",
                "gate-needs-controlout",
                f"gate assertion(s) {gate_present} only evaluate on replay when the cassette has "
                "controlOut (full-fidelity). An old cassette excludes them (with a loud warning).",
                "Re-record with a current harness so the cassette carries controlOut.",
                path,
            )
        )

    # W: double-quoted regex with a backslash (raw-text scan — the parser already ate it)
    findings.extend(_lint_regex_quoting(path, raw_lines))

    return findings


_DQ_REGEX_LINE = re.compile(
    r'^\s*-?\s*(' + "|".join(sorted(REGEX_KEYS)) + r')\s*:\s*"([^"]*\\[^"]*)"'
)


def _lint_regex_quoting(path, raw_lines):
    out = []
    for i, line in enumerate(raw_lines, start=1):
        m = _DQ_REGEX_LINE.match(line)
        if m:
            out.append(
                Finding(
                    "WARN",
                    "regex-double-quoted",
                    f"`{m.group(1)}` uses a DOUBLE-quoted regex containing a backslash "
                    f'("{m.group(2)}") — YAML strips the backslash, so the regex is wrong.',
                    "Single-quote the regex (e.g. '\\d+') or use a block scalar. Use [\\s\\S] not . to span turns.",
                    path,
                    i,
                )
            )
    return out


def _require_yaml():
    # Prefer a system PyYAML (uses the faster libyaml build when present); otherwise fall back to the
    # pure-Python copy bundled under _vendor/ so `lint` works on a stock python3 with no pip install
    # (npm consumers / bare CI runners that lack site-packages).
    try:
        import yaml  # type: ignore

        return yaml
    except ImportError:
        vendor = str(Path(__file__).resolve().parent / "_vendor")
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
        try:
            import yaml  # type: ignore

            return yaml
        except ImportError:
            print("scenario.py needs PyYAML and the bundled copy could not be loaded. Install it: pip install pyyaml", file=sys.stderr)
            sys.exit(2)


def lint_file(path):
    yaml = _require_yaml()
    p = Path(path)
    if not p.is_file():
        return [Finding("ERROR", "not-found", f"file not found: {path}", "Check the path.", path)]
    text = p.read_text(encoding="utf-8")
    raw_lines = text.splitlines()
    # The regex-quoting scan runs on raw text, so it works even when YAML parsing fails —
    # and a bad double-quoted regex (e.g. "\d") is exactly a case that can fail to parse.
    quoting = _lint_regex_quoting(path, raw_lines)
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as e:  # noqa
        msg = str(e).splitlines()[0]
        return quoting + [
            Finding("ERROR", "parse", f"YAML parse error: {msg}", "Fix the YAML syntax.", path)
        ]
    return lint_doc(doc, path, raw_lines)


SEV_ORDER = {"ERROR": 0, "WARN": 1, "INFO": 2}


def _print_findings(findings, n_files):
    if not findings:
        print(f"✓ {n_files} scenario(s) clean — no silent-false-green findings.")
        return
    for x in sorted(findings, key=lambda f: (str(f.file), SEV_ORDER[f.severity])):
        loc = f"{x.file}:{x.line}" if x.line else x.file
        glyph = {"ERROR": "✗", "WARN": "⚠", "INFO": "ℹ"}[x.severity]
        print(f"{glyph} {x.severity} [{x.rule}] {loc}")
        print(f"    {x.message}")
        print(f"    fix: {x.fix}")
    n_err = sum(1 for x in findings if x.severity == "ERROR")
    n_warn = sum(1 for x in findings if x.severity == "WARN")
    n_info = sum(1 for x in findings if x.severity == "INFO")
    print(f"\n{n_err} error(s), {n_warn} warning(s), {n_info} info across {n_files} file(s).")


def cmd_lint(args):
    all_findings = []
    # Expand directory args to their scenario files — mirrors src/run/inputs.ts `resolveInputs`: a SINGLE
    # combined-sorted `*.yaml` + `*.yml` listing (non-recursive), a single file kept as-is, and an EMPTY dir
    # as a loud ERROR (never a vacuous "0 files = clean"). Done in place so the lint loop AND the count below
    # both see the expanded list.
    expanded = []
    for arg in args.files:
        p = Path(arg)
        if p.is_dir():
            matches = sorted(str(q) for q in (list(p.glob("*.yaml")) + list(p.glob("*.yml"))))
            if matches:
                expanded.extend(matches)
            else:
                all_findings.append(
                    Finding(
                        "ERROR",
                        "no-scenarios",
                        f"no .yaml/.yml files under {arg} — nothing to do (loud non-zero, not a vacuous pass)",
                        "Point lint at a scenario file or a directory containing *.yaml / *.yml scenarios.",
                        arg,
                    )
                )
        else:
            expanded.append(arg)
    args.files = expanded
    # Linter self-check (B3): a valid schema key the replay-class sets don't classify can't be linted
    # correctly — surface it as a hard ERROR so it fails the gate (and --strict) until someone classifies it.
    if UNCLASSIFIED_KEYS:
        all_findings.append(
            Finding(
                "ERROR",
                "linter-unclassified-key",
                f"linter is out of date: assertion key(s) {UNCLASSIFIED_KEYS} are valid (in the schema) but "
                "scenario.py doesn't classify their replay behavior, so they can't be linted.",
                "Add them to the linter's CONTENT/GATE/MANIFEST/LIVE_ONLY/VERDICT_MODIFIER sets.",
                "(scenario.py)",
            )
        )
    for f in args.files:
        all_findings.extend(lint_file(f))
    if args.json:
        print(json.dumps([x.as_dict() for x in all_findings], indent=2))
    else:
        _print_findings(all_findings, len(args.files))
    has_error = any(x.severity == "ERROR" for x in all_findings)
    if has_error or (args.strict and all_findings):
        return 1
    return 0


# --------------------------------------------------------------------------- #
# scaffold
# --------------------------------------------------------------------------- #

def _sq(s):
    """Single-quote a YAML scalar (doubling internal single quotes). Single quotes keep
    regex backslashes literal — double quotes would eat them (the regex-quoting gotcha)."""
    return "'" + str(s).replace("'", "''") + "'"


def _split_kv(spec, flag):
    if "=" not in spec:
        print(f"{flag} expects '<regex>=<choice>', got: {spec}", file=sys.stderr)
        sys.exit(2)
    k, v = spec.split("=", 1)
    return k.strip(), v.strip()


def build_scenario(args):
    """Return (yaml_text, notes[]). Encodes the convergent skeleton: container by default,
    scripted answers + on_unanswered: fail, content-class assertions first then live-only,
    one concern per item."""
    notes = []
    tier = args.tier
    egress_asserted = bool(args.egress_denied or args.egress_allowed)

    # Never emit a scenario the linter would reject: protocol + egress is rejected by the harness.
    if tier == "protocol" and egress_asserted:
        tier = "container"
        notes.append(
            "tier auto-upgraded protocol → container: egress assertions need a sandboxed tier "
            "(protocol is rejected by the harness)."
        )

    gates = [_split_kv(g, "--gate") for g in (args.gate or [])]

    L = []
    L.append(f"# {args.name} — cowork-harness scenario (scaffolded; edit the TODOs).")
    L.append(f"# Tier '{tier}': "
             + ("sandbox + real default-deny egress." if tier == "container"
                else "see references/fidelity-and-answers.md.")
             + " on_unanswered: fail keeps this deterministic for CI.")
    if args.skill:
        L.append(f"# Mount the skill under test ({args.skill}) via a session: e.g.")
        L.append("#   plugins:")
        L.append(f"#     local_plugins: [{args.skill}]")
        L.append("#     enabled: [<plugin-name>@local]")
    L.append("")
    L.append(f"name: {args.name}")
    L.append("baseline: latest")
    if args.session:
        L.append(f"session: {args.session}")
    L.append(f"fidelity: {tier}")
    L.append("on_unanswered: fail")
    L.append("")
    L.append("prompt: |")
    for line in (args.prompt or "TODO: the user turn that drives the skill.").splitlines() or [""]:
        L.append(f"  {line}")

    # answers (scripted gates + web_fetch approvals) — the only deterministic path
    if gates or args.web_fetch:
        L.append("")
        L.append("answers:")
        for rx, choice in gates:
            L.append(f"  - when_question: {_sq(rx)}")
            L.append(f"    choose: {_sq(choice)}")
        for dom in (args.web_fetch or []):
            L.append(f'  - when_tool: "webfetch:{dom}"   # web_fetch approval (provenance-miss gate)')
            L.append("    decide: allow")
            L.append("    grant: domain")

    # assertions: content/structure first (replay PR gate), then live-only (filesystem/egress)
    content_lines = ["  - result: success"]
    for rx in (args.content or []):
        content_lines.append(f"  - transcript_matches: {_sq(rx)}")
    for tool in (args.tool or []):
        content_lines.append(f"  - tool_called: {tool}")
    for rx in (args.subagent or []):
        content_lines.append(f"  - subagent_dispatched: {_sq(rx)}   # matches agentType OR dispatch description")
    if gates:
        for rx, _ in gates:
            content_lines.append(f"  - question_asked: {_sq(rx)}   # gate key: replay only with a controlOut cassette")
        content_lines.append(f"  - questions_count_max: {len(gates)}")
        content_lines.append("  - gate_answers_delivered: true   # the steered answers actually reached the model")

    live_lines = []
    for p in (args.file or []):
        live_lines.append(f"  - file_exists: {p}")
    for p in (args.artifact or []):
        live_lines.append(f"  - user_visible_artifact: {p}")
    if args.no_delete:
        live_lines.append("  - no_delete_in_outputs: true")
    for h in (args.egress_allowed or []):
        live_lines.append(f"  - egress_allowed: {h}")
    for h in (args.egress_denied or []):
        live_lines.append(f"  - egress_denied: {h}")

    L.append("")
    L.append("assert:")
    L.append("  # --- content / structure: evaluate on the token-free replay PR gate AND live ---")
    L.extend(content_lines)
    if live_lines:
        L.append("  # --- filesystem / egress: LIVE-only (skipped on replay, with a loud warning) ---")
        L.extend(live_lines)
    else:
        L.append("  # TODO add filesystem/egress checks (file_exists / user_visible_artifact /")
        L.append("  #      egress_denied / no_delete_in_outputs) — they run on the LIVE lane only.")

    if args.web_fetch:
        notes.append(
            "web_fetch: put the URL in the prompt so it is provenanced (the deterministic way to make a "
            "fetch succeed). egress.extra_allow is a NO-OP on the provenanced path — provenance is the gate."
        )
    if not (args.content or args.tool or args.subagent or gates):
        notes.append("only `result: success` is a content assertion — add a transcript_matches / tool_called "
                     "so the replay PR gate verifies something real.")

    return "\n".join(L) + "\n", notes


def cmd_scaffold(args):
    yaml = _require_yaml()
    text, notes = build_scenario(args)

    # Dogfood: self-lint the generated scenario; refuse to emit something the linter rejects.
    if not args.no_validate:
        doc = yaml.safe_load(text)
        findings = lint_doc(doc, "<scaffold>", text.splitlines())
        errors = [f for f in findings if f.severity == "ERROR"]
        if errors:
            print("scaffold produced a scenario its own linter rejects (this is a bug):", file=sys.stderr)
            for e in errors:
                print(f"  ✗ [{e.rule}] {e.message}", file=sys.stderr)
            return 2

    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"✓ wrote {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)

    for n in notes:
        print(f"note: {n}", file=sys.stderr)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="scenario.py",
        description="Author (scaffold) and check (lint) cowork-harness scenarios.",
    )
    sub = ap.add_subparsers(dest="command", required=True)

    lp = sub.add_parser("lint", help="lint scenario(s) for silent-false-green invariants")
    lp.add_argument("files", nargs="+", help="scenario YAML file(s) or director(ies) of *.yaml/*.yml to lint")
    lp.add_argument("--json", action="store_true", help="emit findings as JSON")
    lp.add_argument("--strict", action="store_true", help="exit non-zero on WARN/INFO too, not just ERROR")
    lp.set_defaults(func=cmd_lint)

    sp = sub.add_parser("scaffold", help="emit a valid scenario skeleton (self-linted)")
    sp.add_argument("--name", default="my-scenario", help="scenario name (default: my-scenario)")
    sp.add_argument("--prompt", help="the user turn (the prompt: block)")
    sp.add_argument("--tier", choices=VALID_TIERS, default="container", help="fidelity tier (default: container)")
    sp.add_argument("--session", help="path for the session: field (discovery/setup file)")
    sp.add_argument("--skill", help="skill folder under test — adds a session-mount comment")
    sp.add_argument("--content", action="append", metavar="REGEX", help="transcript_matches assertion (repeatable)")
    sp.add_argument("--tool", action="append", metavar="TOOL", help="tool_called assertion (repeatable)")
    sp.add_argument("--subagent", action="append", metavar="REGEX", help="subagent_dispatched assertion (repeatable)")
    sp.add_argument("--gate", action="append", metavar="REGEX=CHOICE", help="scripted AskUserQuestion answer (repeatable)")
    sp.add_argument("--web-fetch", dest="web_fetch", action="append", metavar="DOMAIN", help="web_fetch approval rule (repeatable)")
    sp.add_argument("--file", action="append", metavar="PATH", help="file_exists assertion (repeatable)")
    sp.add_argument("--artifact", action="append", metavar="PATH", help="user_visible_artifact assertion (repeatable)")
    sp.add_argument("--no-delete", action="store_true", help="add no_delete_in_outputs: true")
    sp.add_argument("--egress-allowed", dest="egress_allowed", action="append", metavar="HOST", help="egress_allowed assertion (repeatable)")
    sp.add_argument("--egress-denied", dest="egress_denied", action="append", metavar="HOST", help="egress_denied assertion (repeatable)")
    sp.add_argument("--out", help="write to this file (default: stdout)")
    sp.add_argument("--no-validate", action="store_true", help="skip the self-lint of the generated scenario")
    sp.set_defaults(func=cmd_scaffold)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

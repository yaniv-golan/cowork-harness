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
  E  `transcript_no_host_path` on hostloop/protocol  (fails BY DESIGN at those tiers)
  E  `requires_capabilities` on `fidelity: protocol` (probe can't run → hard-fails
                                                      unless allow_missing_capability)
  E  on_unanswered: agent / invalid value            (schema rejects `agent`)
  E  authored `replay_protocol_fidelity` assertion   (replay-synthesized only)
  E  `assertions:` instead of `assert:`              (block ignored → every check no-ops)
  W  `transcript_no_host_path` on `fidelity: cowork` (tier resolves per baseline gate —
                                                      incompatible if it lands hostloop)
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
import functools
import json
import re
import sys
from pathlib import Path

# --- the replay-class taxonomy ---
# NB: this is NOT a 1:1 mirror of the ALWAYS_CONTENT_KEYS/QUESTION_GATE_KEYS/MANIFEST_KEYS buckets in src/run/cassette.ts. cassette.ts keeps the verdict
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
    "subagent_output_contains",
    "no_vm_path_file_op",
    "subagent_file_write",
    "subagent_dispatch_healthy",
    "dispatch_count_max",
    "skill_triggered",
    "no_skill_triggered",
    "skill_available",
    "connector_available",
    "tool_available",
    "skill_tool_used",
    "max_cost_usd",
    "max_tokens",
    "tool_calls_max",
    "tool_no_error",
    "tool_no_error_if_called",
    "max_tool_errors",
    "max_redundant_tool_calls",
    "max_turns",
    "compaction_occurred",
    "all_tasks_completed",
    "task_count_min",
    "task_status",
    "no_scratchpad_leak",
    "present_files_called",
}
# content keys, but only evaluated on replay when the cassette carries controlOut
GATE_KEYS = {
    "question_asked",
    "questions_count_max",
    "gate_answers_delivered",
    "gate_answer_count_min",
    "hook_blocked",
    "no_hook_blocked",
    "vm_path_denied",
    "path_denied",
    "no_path_denied",
}
# manifest-backed: replay-checkable when the cassette carries an `artifacts` manifest (record snapshots one);
# a manifest-less cassette skips them. Since the 0.3.0 artifact-manifest these are NOT always live-only.
# computer_links_resolve joins this bucket (not CONTENT_KEYS): resolving a non-empty link set needs
# either a live filesystem or the cassette's artifacts manifest — see cassette.ts's manifestKeys comment.
MANIFEST_KEYS = {
    "file_exists",
    "user_visible_artifact",
    "artifact_json",
    "computer_links_resolve",
    "computer_links_resolve_if_present",
    "no_unexpected_files",
    "input_unmodified",
}
# live-only: ALWAYS skipped on replay, with a loud warning (no filesystem, no network on the token-free lane)
LIVE_ONLY_KEYS = {
    "egress_denied",
    "egress_allowed",
    "no_delete_in_outputs",
    "self_heal_ran",
    "transcript_no_host_path",
    "no_mcp_error",
    "max_peak_rss_bytes",
    "semantic_matches",
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
# reintroduce key drift. `assertions` is NOT here — it's a hard error handled by its own special-case
# in the unknown-key check below (`k != "assertions"`). `profile` is retired vocabulary and now falls
# through to that same unknown-key check like any other typo — no special-case for it.
_EMBEDDED_TOP_LEVEL_KEYS = {
    "name",
    "baseline",
    "session",
    "fidelity",
    "execution",  # execution-location axis, orthogonal to fidelity; "cloud-describe" is reserved (load-time error)
    "on_unanswered",
    "prompt",
    "timeout_ms",  # wall-clock budget → kill + errorSource:timeout on expiry
    "answers",
    "expect_denied",
    "assert",
    "skills",  # opt-in skill-staleness hash scope
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
    "hook_blocked",
}
VALID_ON_UNANSWERED = {"fail", "prompt", "first", "llm"}
VALID_TIERS = ("protocol", "container", "microvm", "hostloop", "cowork")

# Gate-id tripwire: the `host-path-assert-cowork` WARN below embeds Cowork's
# host-loop gate id in offline Python (the linter never reads a baseline). The
# id is pinned by test/scenario-lint-gate-id.test.ts against the PINNED_GATES
# entry in src/sync/cowork-sync.ts, so a Desktop gate re-key fails loud there
# instead of silently rotting this message.
HOST_LOOP_GATE_ID = "1143815894"


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
        if k not in TOP_LEVEL_KEYS and k != "assertions":
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

    # E/W: transcript_no_host_path is tier-incompatible with hostloop/protocol — the agent
    # legitimately runs on real host paths there, so the assertion fails BY DESIGN (the runtime only
    # warns at run start, after authoring). Lint is deliberately STRICTER than the runtime: the docs
    # declare the combination incompatible, so authoring it is a bug even if a tool-free run could
    # accidentally pass. `cowork` gets a WARN naming the baseline-gate resolution dependency (the
    # linter stays offline — the message carries the gate fact instead of reading a baseline).
    if "transcript_no_host_path" in assert_keys:
        if fidelity in ("hostloop", "protocol"):
            findings.append(
                Finding(
                    "ERROR",
                    "host-path-assert-tier",
                    f"`transcript_no_host_path` on `fidelity: {fidelity}` — the agent runs on real "
                    "host paths at this tier, so this assertion FAILS BY DESIGN (it can never be a "
                    "meaningful check here).",
                    "Run this assertion at fidelity: container (or microvm), or drop it for this tier.",
                    path,
                )
            )
        elif fidelity == "cowork":
            findings.append(
                Finding(
                    "WARN",
                    "host-path-assert-cowork",
                    "`transcript_no_host_path` on `fidelity: cowork` — the tier resolves per the "
                    f"baseline's host-loop gate ({HOST_LOOP_GATE_ID}); if it resolves to hostloop "
                    "this assertion fails by design (and a later gate flip re-stales the cassette).",
                    "Pin fidelity: container if the assertion is load-bearing; keep cowork only if "
                    "you accept the gate-resolution dependency.",
                    path,
                )
            )

    # E: requires_capabilities on protocol — the capability probe cannot run at protocol tier
    # (clause b of the requires_capabilities contract), so the run HARD-FAILS unless an assert item
    # opts out via allow_missing_capability: true. Offline-detectable fails-by-design, same class as
    # the tier/assert rules above.
    req_caps = doc.get("requires_capabilities")
    if req_caps and fidelity == "protocol":
        opted_out = any(item.get("allow_missing_capability") is True for item in items)
        if not opted_out:
            findings.append(
                Finding(
                    "ERROR",
                    "capabilities-on-protocol",
                    "non-empty `requires_capabilities` on `fidelity: protocol` — the capability "
                    "probe cannot run at protocol tier, so the run hard-fails as unverifiable "
                    "(fails by design).",
                    "Use a sandboxed tier (container/microvm/hostloop), or add "
                    "`allow_missing_capability: true` to an assert item to opt out explicitly.",
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
# A run of an EVEN number of consecutive backslashes in a double-quoted YAML scalar is a properly
# paired escape (`\\` -> a literal `\`), so e.g. "\\d+ items" decodes to the valid regex `\d+ items` —
# not a mistake. An ODD run leaves one backslash unpaired, which is the actual footgun (YAML either
# eats it or errors, depending on what follows). Only flag the odd case.
_ODD_BACKSLASH_RUN = re.compile(r"\\+")


def _has_unpaired_backslash(s):
    return any(len(m.group(0)) % 2 == 1 for m in _ODD_BACKSLASH_RUN.finditer(s))


def _lint_regex_quoting(path, raw_lines):
    out = []
    for i, line in enumerate(raw_lines, start=1):
        m = _DQ_REGEX_LINE.match(line)
        if m and _has_unpaired_backslash(m.group(2)):
            out.append(
                Finding(
                    "WARN",
                    "regex-double-quoted",
                    f"`{m.group(1)}` uses a DOUBLE-quoted regex containing an unescaped backslash "
                    f'("{m.group(2)}") — YAML strips it, so the regex is wrong.',
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


def _print_findings(findings, n_files, kind="scenario", clean_suffix=" — no silent-false-green findings."):
    if not findings:
        print(f"✓ {n_files} {kind}(s) clean{clean_suffix}")
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
    # Linter self-check: a valid schema key the replay-class sets don't classify can't be linted
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
# lint-skill — SKILL.md-body checks for two Cowork host-loop footguns
# --------------------------------------------------------------------------- #
#
# HONEST LIMITS (v1 is deliberately narrow to bound false positives):
# Telling an "in-VM bash" usage apart from a correct host-side reference in freeform
# markdown is heuristic. v1 only treats these as in-VM bash contexts:
#   * a fenced ```bash / ```sh / ```shell (or ```zsh) code block,
#   * a JSON `"command": "..."` value in a hooks config (a fenced ```json block or a hooks.json file),
#   * a `Bash(...)` tool-directive line.
# It NEVER inspects host-side prose or a `Read`/`Grep` directive — reading a reference via
# `${CLAUDE_PLUGIN_ROOT}/references/x.md` in prose is the CORRECT, common idiom and is left alone.
# Consequence: false negatives are expected. A `${CLAUDE_PLUGIN_ROOT}` path in an INDENTED (4-space)
# or otherwise UNFENCED shell snippet won't be caught, because v1 keys entirely off fenced blocks +
# hooks JSON. Widening the shell heuristic would trade those false negatives for false positives, which
# v1 declines to do.

_PLUGIN_ROOT_TOKEN = re.compile(r"\$\{?CLAUDE_PLUGIN_ROOT\}?")
# A runtime SELF-HEAL for a dead ${CLAUDE_PLUGIN_ROOT}: discovering the real mount under /sessions at run
# time (the prescribed pattern — e.g. `[ -d "$X" ] || X=$(find /sessions ... -name ...)`, or an inline
# `|| python3 "$(find /sessions ...)"`). When a bash block that uses the token ALSO contains a `find` over
# /sessions, the token is dead but the block rescues it → downgrade the WARN to INFO (Item 4). Conservative:
# we do NOT verify the find pattern actually matches the plugin's layout (hence the INFO's "not validated").
_SELF_HEAL = re.compile(r"\bfind\b[^\n]*/sessions")
# Opening/closing fence: ``` or ~~~ (>=3), optional info string (language).
_FENCE = re.compile(r"^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$")
# A hooks-config command string: `"command": "<value>"` (value may contain escaped quotes).
_HOOK_CMD = re.compile(r'"command"\s*:\s*"((?:[^"\\]|\\.)*)"')
# A Bash(...) tool directive, e.g. `Bash(git status)` or an allowed-tools entry.
_BASH_DIRECTIVE = re.compile(r"Bash\(([^)]*)\)")
# `export NAME=...` anywhere in a command string (start, or after ; & | or whitespace).
_HOOK_EXPORT = re.compile(r"(?:^|[;&|]|\s)export\s+[A-Za-z_][A-Za-z0-9_]*=")
# A redirect (`>` / `>>`) into /tmp, or a `tee [flags] /tmp/...`.
_HOOK_TMP_REDIRECT = re.compile(r">>?\s*/tmp/")
_HOOK_TMP_TEE = re.compile(r"\btee\b(?:\s+-\S+)*\s+/tmp/")

_BASH_FENCE_LANGS = {"bash", "sh", "shell", "zsh"}
_JSON_FENCE_LANGS = {"json", "jsonc", "json5"}


def _finding_plugin_root(path, line, ctx_label):
    return Finding(
        "WARN",
        "plugin-root-in-vm-bash",
        f"`${{CLAUDE_PLUGIN_ROOT}}` used as a path in an in-VM bash context ({ctx_label}): "
        "dead in host-loop VM; discover the mount at runtime instead.",
        "In VM-executed bash, don't hardcode ${CLAUDE_PLUGIN_ROOT} — resolve the skill/plugin mount at "
        "runtime (e.g. derive it from the script's own location) instead.",
        path,
        line,
    )


def _finding_plugin_root_guarded(path, line, ctx_label):
    return Finding(
        "INFO",
        "plugin-root-guarded",
        f"`${{CLAUDE_PLUGIN_ROOT}}` used in an in-VM bash context ({ctx_label}), but the same block "
        "self-heals it (a runtime `find` under /sessions) — the dead token is harmless here.",
        "Guard not validated: the linter does not check the `find` pattern actually matches the plugin's "
        "layout. Prefer resolving the mount from the script's own location over a find-fallback.",
        path,
        line,
    )


# A self-heal `find`'s `-path '<glob>'` / `-path "<glob>"` value (same-quote char, non-greedy so a
# quote inside the glob — unlikely in practice — doesn't get swallowed).
_FIND_PATH_VALUE = re.compile(r"""-path\s+(['"])(.*?)\1""")
# The skill segment out of a `*/skills/<name>/...` glob.
_FIND_PATH_SKILLS_SEG = re.compile(r"/skills/([A-Za-z0-9_.-]+)/")
# The plugin segment out of a `*/plugins/<name>/...` glob.
_FIND_PATH_PLUGINS_SEG = re.compile(r"/plugins/([A-Za-z0-9_.-]+)/")
# A generic `*/<name>/scripts` glob (no `skills/`/`plugins/` literal prefix) — the segment right
# before a `/scripts` path component. This is what a plugin-level self-heal targeting its own
# `<plugin>/scripts/...` layout looks like once the real mount path (e.g. `mnt/.local-plugins/...`)
# is glob-abbreviated to `*/<plugin>/scripts`.
_FIND_PATH_SCRIPTS_SEG = re.compile(r"/([A-Za-z0-9_.-]+)/scripts\b")


def _extract_find_path_token(find_cmd_line):
    """Pull the skill/plugin-naming token out of a self-heal `find`'s `-path` glob (on the SAME
    line as the `find`, matching how `_SELF_HEAL` itself is line-scoped), or None if there's no
    `-path` clause or none of the recognized glob shapes match. A bare glob wildcard segment (e.g.
    `*/scripts/*`, no name between the slashes) intentionally does not match the `[A-Za-z0-9_.-]+`
    character class — that's a real absence of an extractable token, not a token, so it stays
    conservative (INFO) rather than manufacturing a bogus `*` token to compare."""
    m = _FIND_PATH_VALUE.search(find_cmd_line)
    if not m:
        return None
    glob = m.group(2)
    for pat in (_FIND_PATH_SKILLS_SEG, _FIND_PATH_PLUGINS_SEG, _FIND_PATH_SCRIPTS_SEG):
        seg = pat.search(glob)
        if seg:
            return seg.group(1)
    return None


def _finding_guard_pattern_mismatch(path, line, ctx_label, token, skill_name, plugin_name):
    plugin_part = f" (plugin `{plugin_name}`)" if plugin_name else ""
    return Finding(
        "WARN",
        "guard-pattern-mismatch",
        f"`${{CLAUDE_PLUGIN_ROOT}}` used in an in-VM bash context ({ctx_label}); the block's self-heal "
        f"`find` targets `{token}`, but this skill is `{skill_name}`{plugin_part} — the guard won't "
        "discover THIS skill's mount (likely a copy-pasted self-heal).",
        f"Fix the `find` pattern's `-path` to match this skill/plugin's own layout (`{skill_name}`"
        f"{plugin_part}), not `{token}`.",
        path,
        line,
    )


def _finding_hook_host_write(path, line, what):
    return Finding(
        "WARN",
        "hook-host-side-write",
        f"hook command {what}: host-side hook write is not VM-visible in Cowork "
        "(works in CLI, silently no-ops in Cowork).",
        "A host-side hook can't seed env vars or /tmp for the in-VM agent. Provision inside the VM "
        "(e.g. do the work in the skill body / a VM-run script), not in a host hook.",
        path,
        line,
    )


def _check_hook_command(path, line_no, cmd, findings):
    """Apply both checks to a single hooks-config command string."""
    if _PLUGIN_ROOT_TOKEN.search(cmd):
        findings.append(_finding_plugin_root(path, line_no, "hooks command"))
    if _HOOK_EXPORT.search(cmd):
        findings.append(_finding_hook_host_write(path, line_no, "`export`s an env var"))
    if _HOOK_TMP_REDIRECT.search(cmd) or _HOOK_TMP_TEE.search(cmd):
        findings.append(_finding_hook_host_write(path, line_no, "writes into /tmp"))


def _lint_skill_text(path, raw_lines, force_json=False):
    """Scan one file. `force_json=True` treats every line as a hooks-config JSON body
    (used for standalone hooks.json files); otherwise fences drive the context."""
    findings = []
    in_fence = False
    fence_char = ""
    fence_len = 0
    fence_lang = ""
    # Per-bash-fence buffer (Item 4): plugin-root token hit line numbers + the whole block's text, so a
    # ${CLAUDE_PLUGIN_ROOT} use that is self-healed elsewhere IN THE SAME BLOCK downgrades WARN -> INFO.
    # Emission is deferred to fence close (or EOF) but original 1-based line numbers are preserved.
    bash_token_lines = []
    bash_block_text = []

    # Self-heal find-pattern guard: identity of the skill/plugin under lint, used to check a self-heal `find -path`
    # actually names THIS skill or its enclosing plugin (not a copy-pasted mismatch). Only
    # meaningful when linting an actual SKILL.md (force_json=False is exactly that case here — a
    # hooks.json body never enters the "bash" ctx below, so this is otherwise unused).
    skill_name = None
    plugin_name = None
    self_plugin_tokens = set()
    if not force_json:
        dir_name = Path(path).resolve().parent.name
        fm_name = _agent_name_from_frontmatter(path, _require_yaml())
        # Prefer the frontmatter `name:` (the skill's declared identity) for display when present;
        # the parent-dir name is always in the match set as a cross-check (both count as "this
        # skill" — a self-heal naming either is not a mismatch).
        skill_name = fm_name or dir_name
        self_plugin_tokens.add(dir_name)
        if fm_name:
            self_plugin_tokens.add(fm_name)
        plugin_dir = _find_enclosing_plugin_dir(path)
        if plugin_dir is not None:
            plugin_name = _read_plugin_name(plugin_dir)
            if plugin_name:
                self_plugin_tokens.add(plugin_name)
            self_plugin_tokens.add(Path(plugin_dir).name)

    def flush_bash():
        if bash_token_lines:
            self_heal_line = next((bl for bl in bash_block_text if _SELF_HEAL.search(bl)), None)
            healed = self_heal_line is not None
            token = _extract_find_path_token(self_heal_line) if healed else None
            for ln in bash_token_lines:
                if not healed:
                    findings.append(_finding_plugin_root(path, ln, "```bash block"))
                elif token is not None and token not in self_plugin_tokens:
                    findings.append(
                        _finding_guard_pattern_mismatch(
                            path, ln, "```bash block", token, skill_name, plugin_name
                        )
                    )
                else:
                    findings.append(_finding_plugin_root_guarded(path, ln, "```bash block"))
        bash_token_lines.clear()
        bash_block_text.clear()

    for i, line in enumerate(raw_lines, start=1):
        m = _FENCE.match(line)
        if m:
            marker, lang = m.group(1), m.group(2).lower()
            if not in_fence:
                in_fence, fence_char, fence_len, fence_lang = True, marker[0], len(marker), lang
                continue
            # A closing fence uses the same char, is at least as long, and carries no language.
            if marker[0] == fence_char and len(marker) >= fence_len and not lang:
                if fence_lang in _BASH_FENCE_LANGS:
                    flush_bash()  # decide WARN vs INFO now that the whole block is known
                in_fence = fence_char = ""
                fence_len = 0
                fence_lang = ""
                continue
            # otherwise: a fence-looking line inside a block — fall through as content

        if force_json:
            ctx = "json"
        elif in_fence and fence_lang in _BASH_FENCE_LANGS:
            ctx = "bash"
        elif in_fence and fence_lang in _JSON_FENCE_LANGS:
            ctx = "json"
        elif in_fence:
            ctx = "other-fence"  # e.g. ```python / ```yaml — not a shell context, leave alone
        else:
            ctx = "prose"

        if ctx == "bash":
            bash_block_text.append(line)  # buffer the block; token hits emit on flush (self-heal aware)
            if _PLUGIN_ROOT_TOKEN.search(line):
                bash_token_lines.append(i)
        elif ctx == "json":
            for cm in _HOOK_CMD.finditer(line):
                _check_hook_command(path, i, cm.group(1), findings)
        elif ctx == "prose":
            # Only a Bash(...) tool directive counts as in-VM bash here — plain prose and
            # Read/Grep directives are intentionally left alone.
            for bm in _BASH_DIRECTIVE.finditer(line):
                if _PLUGIN_ROOT_TOKEN.search(bm.group(1)):
                    findings.append(_finding_plugin_root(path, i, "Bash() directive"))
    # A bash fence left unclosed at EOF still has buffered token hits — flush them (else a real WARN/INFO
    # would be silently dropped).
    if in_fence and fence_lang in _BASH_FENCE_LANGS:
        flush_bash()
    return findings


# --------------------------------------------------------------------------- #
# subagent_type static resolution
# --------------------------------------------------------------------------- #
#
# A pinned `subagent_type:` value that doesn't resolve to a real agent fails a definition lookup at
# dispatch time — but that's only discoverable via a live dispatch today. Resolve it statically from
# a plugin's own `.claude-plugin/plugin.json` (or `plugin.json`) + `agents/*.md` frontmatter instead.
#
# HONEST LIMIT: there is no harness registry of built-in agent types (the built-in set is
# agent-binary-version-dependent) — only `general-purpose` is harness-known. So an unresolved bare
# value is surfaced as INFO, never failed as WARN/ERROR; the linter can't disprove it's a real
# built-in. Do NOT add a committed built-in agent-type list here — that would silently go stale and
# either false-warn a real built-in or false-clear a typo.

_SUBAGENT_TYPE_RE = re.compile(r"subagent_type\s*[:=]\s*['\"]?([A-Za-z0-9_.:/-]+)['\"]?")


def _read_plugin_name(plugin_dir):
    """Return the `name` field from `<plugin_dir>/.claude-plugin/plugin.json` (fallback
    `<plugin_dir>/plugin.json`), or None if neither file exists or is parsable. Never raises."""
    p = Path(plugin_dir)
    for candidate in (p / ".claude-plugin" / "plugin.json", p / "plugin.json"):
        if candidate.is_file():
            try:
                data = json.loads(candidate.read_text(encoding="utf-8"))
            except Exception:
                return None
            name = data.get("name") if isinstance(data, dict) else None
            return name if isinstance(name, str) and name.strip() else None
    return None


_AGENT_FRONTMATTER = re.compile(r"^---\s*\n(.*?\n)---\s*(?:\n|$)", re.DOTALL)


def _agent_name_from_frontmatter(md_path, yaml_mod):
    """Return a markdown file's `name:` frontmatter value, or None if there's no frontmatter, no
    `name:` field, or it fails to parse. Originally for `agents/*.md` (caller falls back to the
    filename stem there); also reused by the self-heal find-pattern guard for a SKILL.md, whose frontmatter has the same
    `---\\nname: ...\\n---` shape — the parser itself is generic, only the name is agent-specific."""
    try:
        text = Path(md_path).read_text(encoding="utf-8")
    except Exception:
        return None
    m = _AGENT_FRONTMATTER.match(text)
    if not m:
        return None
    try:
        data = yaml_mod.safe_load(m.group(1))
    except Exception:
        return None
    if isinstance(data, dict):
        name = data.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return None


def _resolve_plugin_agents(plugin_dir):
    """Resolve in-plugin agent types: return the set of valid `<plugin>:<agent>` subagent types defined WITHIN plugin_dir.
    Reads the plugin name from plugin.json and each agents/*.md's `name:` frontmatter (filename stem
    fallback). Returns an empty set (never crashes) when no plugin.json is found — a bare SKILL.md
    dir with no plugin manifest has nothing to resolve against."""
    plugin_name = _read_plugin_name(plugin_dir)
    if not plugin_name:
        return set()
    agents_dir = Path(plugin_dir) / "agents"
    if not agents_dir.is_dir():
        return set()
    yaml = _require_yaml()
    types = set()
    for md in sorted(agents_dir.glob("*.md")):
        agent_name = _agent_name_from_frontmatter(md, yaml) or md.stem
        types.add(f"{plugin_name}:{agent_name}")
    return types


def cmd_resolve_agent_types(args):
    types = sorted(_resolve_plugin_agents(args.plugin_dir))
    if args.json:
        print(json.dumps(types))
    else:
        for t in types:
            print(t)
    return 0


def _find_enclosing_plugin_dir(skill_md_path):
    """Resolve the enclosing plugin: walk up from a SKILL.md to the nearest ancestor dir containing
    `.claude-plugin/plugin.json` or `plugin.json` — that's the enclosing plugin. None if no ancestor
    has one (a bare SKILL.md dir with no plugin manifest anywhere above it)."""
    start = Path(skill_md_path).resolve().parent
    for anc in [start, *start.parents]:
        if (anc / ".claude-plugin" / "plugin.json").is_file() or (anc / "plugin.json").is_file():
            return anc
    return None


def _finding_subagent_unresolvable(path, line, value):
    return Finding(
        "INFO",
        "subagent-type-unresolvable",
        f"pinned type `{value}` belongs to another plugin — can't confirm it resolves from here",
        "Verify it resolves in that plugin's own agents/ dir (e.g. `scenario.py resolve-agent-types "
        "<that-plugin-dir>`), or dispatch without pinning a cross-plugin type.",
        path,
        line,
    )


def _finding_subagent_unknown(path, line, value):
    return Finding(
        "INFO",
        "subagent-type-unknown",
        f"pinned type `{value}` is not defined in this plugin and is not the `general-purpose` "
        "built-in — can't confirm statically (may be an agent-binary built-in)",
        "If it's meant to be an in-plugin agent, add `agents/<name>.md` with a `name:` frontmatter "
        "matching the pinned value (or rely on the filename-stem fallback). If it's a real built-in "
        "agent type, this INFO is expected — the linter has no built-in registry to check it against.",
        path,
        line,
    )


def _finding_subagent_not_found_in_plugin(path, line, value, plugin_name, agent, sorted_agents):
    """A pinned `<this-plugin>:<agent>` value whose prefix names the RESOLVED plugin (this SKILL.md's
    own enclosing plugin) but whose agent isn't in its enumerated agents/*.md set. Unlike
    `subagent-type-unknown`, this can never be another binary's built-in — the namespace prefix
    already commits it to this plugin, and the plugin's agent set was fully enumerable — so it's a
    provable typo, not an unconfirmable unknown."""
    return Finding(
        "INFO",
        "subagent-type-not-found-in-plugin",
        f"pinned type `{value}` names this plugin (`{plugin_name}`) but `{agent}` is not among its "
        f"agents [{', '.join(sorted_agents)}] — likely a typo.",
        "Fix the agent name to match one of the listed agents, or add `agents/<agent>.md` with a "
        "`name:` frontmatter matching the pinned value (or rely on the filename-stem fallback) if it "
        "was meant to exist. Check `scenario.py resolve-agent-types <plugin-dir>` to confirm.",
        path,
        line,
    )


def _classify_subagent_type(value, plugin_name, plugin_agent_types):
    """subagent_type severity ladder. Returns a Finding-builder (path, line, value) -> Finding, or None if
    clean. Severity is ALWAYS INFO — see the HONEST LIMIT note above this section; never WARN/ERROR.

    Precedence:
      1. Resolves in-plugin, or is `general-purpose` -> clean (None).
      2. Has a `<prefix>:<agent>` shape whose prefix EQUALS the resolved plugin's own name AND the
         plugin's agent set was non-empty (i.e. enumerable) -> `subagent-type-not-found-in-plugin`.
         A value namespaced under this plugin's own name can never be another binary's built-in, so
         once the plugin is fully enumerated a miss here is a provable typo, not an unconfirmable
         unknown.
      3. Has a `<prefix>:<agent>` shape whose prefix does NOT equal the resolved plugin's name (or
         there's no resolved plugin at all) -> `subagent-type-unresolvable` (belongs to another
         plugin, or an empty plugin_name means we truly can't tell whose namespace it is).
      4. Otherwise (no colon, or same-plugin prefix but the plugin set was empty/unenumerable) ->
         `subagent-type-unknown` — genuinely can't confirm statically.
    """
    if value == "general-purpose" or value in plugin_agent_types:
        return None
    if ":" in value:
        prefix, agent = value.split(":", 1)
        if plugin_name is not None and prefix == plugin_name:
            if plugin_agent_types:
                sorted_agents = sorted(
                    t.split(":", 1)[1] for t in plugin_agent_types if t.split(":", 1)[0] == plugin_name
                )
                return functools.partial(
                    _finding_subagent_not_found_in_plugin,
                    plugin_name=plugin_name,
                    agent=agent,
                    sorted_agents=sorted_agents,
                )
            # Plugin set is empty — couldn't enumerate (e.g. no agents/ dir) — genuinely can't confirm.
            return _finding_subagent_unknown
        return _finding_subagent_unresolvable
    return _finding_subagent_unknown


def _lint_subagent_types(path, raw_lines):
    """Scan a SKILL.md's raw text (not limited to fenced blocks — a pinned `subagent_type`
    can appear in prose or YAML frontmatter) for pinned `subagent_type` values and classify each
    against the enclosing plugin's in-plugin agent set."""
    matches = []
    for i, line in enumerate(raw_lines, start=1):
        for m in _SUBAGENT_TYPE_RE.finditer(line):
            matches.append((i, m.group(1)))
    if not matches:
        return []

    plugin_dir = _find_enclosing_plugin_dir(path)
    plugin_name = _read_plugin_name(plugin_dir) if plugin_dir else None
    plugin_agent_types = _resolve_plugin_agents(plugin_dir) if plugin_dir else set()

    findings = []
    for line_no, value in matches:
        builder = _classify_subagent_type(value, plugin_name, plugin_agent_types)
        if builder is not None:
            findings.append(builder(path, line_no, value))
    return findings


def _resolve_skill_targets(arg):
    """Return (skill_md_path_or_None, [hooks.json paths]) for a directory or file arg."""
    p = Path(arg)
    if p.is_dir():
        md = p / "SKILL.md"
        hooks = sorted(str(q) for q in p.rglob("hooks.json"))
        return (str(md) if md.is_file() else None), hooks
    if p.is_file():
        if p.suffix == ".json":
            return None, [str(p)]
        # a SKILL.md (or any markdown handed in directly); also pick up sibling hooks.json
        hooks = sorted(str(q) for q in p.parent.rglob("hooks.json"))
        return str(p), hooks
    return None, []


def cmd_lint_skill(args):
    all_findings = []
    n_files = 0
    for arg in args.paths:
        md, hooks = _resolve_skill_targets(arg)
        if md is None and not hooks:
            all_findings.append(
                Finding(
                    "ERROR",
                    "no-skill",
                    f"no SKILL.md or hooks.json found at {arg} — nothing to inspect.",
                    "Point lint-skill at a SKILL.md file or a skill directory containing one.",
                    arg,
                )
            )
            continue
        if md is not None:
            n_files += 1
            md_lines = Path(md).read_text(encoding="utf-8").splitlines()
            all_findings.extend(_lint_skill_text(md, md_lines))
            all_findings.extend(_lint_subagent_types(md, md_lines))
        for hp in hooks:
            n_files += 1
            all_findings.extend(
                _lint_skill_text(hp, Path(hp).read_text(encoding="utf-8").splitlines(), force_json=True)
            )
    if args.json:
        print(json.dumps([x.as_dict() for x in all_findings], indent=2))
    else:
        _print_findings(all_findings, n_files, kind="skill file", clean_suffix=" — no Cowork host-loop footguns.")
    has_error = any(x.severity == "ERROR" for x in all_findings)
    # --strict fails on WARN too, per its own --help text ("exit non-zero on WARN too, not just ERROR")
    # — but NEVER on INFO. The subagent_type ladder (subagent-type-unresolvable /
    # -not-found-in-plugin / -unknown) and plugin-root-guarded are always INFO by design (there is no
    # harness registry to disprove an unknown value against — see the subparser help above), so they
    # must always be surfaced, never failed, even under --strict.
    has_warn = any(x.severity == "WARN" for x in all_findings)
    if has_error or (args.strict and has_warn):
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
        # questions_count_max counts SUB-questions at runtime (assert.ts/trace-view.ts), but this
        # scaffold is STATIC — it only knows the number of --gate rules (per-tool-call), never how many
        # sub-questions each gate bundles. Any number emitted here would be a guess: too low false-reds
        # on the first run, too high is a dead tripwire. A budget must come from observation, not
        # fabrication — so emit it COMMENTED OUT with the calibration path, not a made-up value.
        content_lines.append(
            "  # - questions_count_max: <N>   # BUDGET — calibrate from a real run: `trace --view "
            "questions` prints the SUB-question total (what this asserts); set N to that + headroom."
        )
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

    lsp = sub.add_parser(
        "lint-skill",
        help="lint SKILL.md bodies for Cowork host-loop footguns + static subagent_type resolution",
        description=(
            "Inspect skill bodies (SKILL.md + any sibling hooks.json) for two antipatterns a paid "
            "Cowork host-loop run would expose:\n"
            "  (a) ${CLAUDE_PLUGIN_ROOT} used as a PATH in an in-VM bash context — dead in the host-loop VM;\n"
            "  (b) a hook command that exports an env var or writes into /tmp for the in-VM agent — a "
            "host-side hook write is not VM-visible (works in the CLI, silently no-ops in Cowork).\n\n"
            "HONEST LIMITS (v1 is deliberately narrow to bound false positives): an in-VM bash context is "
            "ONLY a fenced ```bash/```sh/```shell block, a hooks-config JSON \"command\" value, or a "
            "Bash(...) directive. Host-side prose and Read/Grep directives (the correct way to read a "
            "reference via ${CLAUDE_PLUGIN_ROOT}/...) are left alone. False negatives are expected: a token "
            "in an indented/unfenced shell snippet won't be caught.\n\n"
            "Also statically resolves any pinned `subagent_type` value in the SKILL.md against the "
            "enclosing plugin's `agents/*.md` (see `resolve-agent-types`): a value that resolves in-plugin "
            "or is `general-purpose` is clean; a `<this-plugin>:<agent>` whose agent is missing from an "
            "enumerable plugin is a provable typo, reported as `subagent-type-not-found-in-plugin`; a "
            "`<other-plugin>:<agent>` is reported as `subagent-type-unresolvable`; any other unresolved "
            "value (including a same-plugin prefix the linter couldn't enumerate) is "
            "`subagent-type-unknown` — all three are always INFO, never WARN, since there is no harness "
            "registry of built-in agent types to disprove an unknown value against."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    lsp.add_argument("paths", nargs="+", help="SKILL.md file(s) or skill director(ies) to inspect")
    lsp.add_argument("--json", action="store_true", help="emit findings as JSON")
    lsp.add_argument("--strict", action="store_true", help="exit non-zero on WARN too, not just ERROR")
    lsp.set_defaults(func=cmd_lint_skill)

    rap = sub.add_parser(
        "resolve-agent-types",
        help="print a plugin's valid <plugin>:<agent> subagent types (from plugin.json + agents/*.md)",
        description=(
            "Statically resolve the set of `<plugin>:<agent>` subagent types defined WITHIN a plugin "
            "dir: the plugin name comes from `.claude-plugin/plugin.json` (fallback `plugin.json`), "
            "each agent name comes from `agents/*.md`'s `name:` frontmatter (filename-stem fallback "
            "when a file has no `name:`). Prints an empty result (exit 0) for a dir with no "
            "plugin.json — nothing to resolve against. This is the token-free 'does "
            "`<plugin>:<agent>` resolve within this plugin?' answer that backs the `subagent_type` "
            "check folded into `lint-skill`."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    rap.add_argument("plugin_dir", help="plugin directory (containing .claude-plugin/plugin.json or plugin.json)")
    rap.add_argument("--json", action="store_true", help="emit the resolved types as a JSON array instead of one per line")
    rap.set_defaults(func=cmd_resolve_agent_types)

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

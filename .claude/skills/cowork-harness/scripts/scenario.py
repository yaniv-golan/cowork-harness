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
  E  `no_scratchpad_leak` off container            (container-only: hostloop serves the tool but never promotes)
  E  `present_files_called` on protocol/microvm    (served at container+hostloop)
  E  `present_files_called`/`no_scratchpad_leak`/`user_visible_artifact` on `lane: remote`
                                                  (runtime rejects at LOAD time; tier rules suppressed)
  E  `requires_capabilities` on `fidelity: protocol` (probe can't run → hard-fails
                                                      unless allow_missing_capability)
  E  `fidelity-missing`        a scenario (it has `prompt:`) with no `fidelity:` key -- required since
                               4.0.0 (the loader refuses the file); the tier-dependent rules are skipped
  E  `enum-value-invalid`      any enum-valued field carries a value the schema rejects (fidelity,
                               execution, lane, on_unanswered, answers[].decide/else/grant,
                               assert[].result/path_denied.*/question_options.order) — `agent` gets a
                               `on_unanswered: agent` → `llm` rename hint
  E  authored `replay_protocol_fidelity` assertion   (replay-synthesized only)
  E  `assertions:` instead of `assert:`              (block ignored → every check no-ops)
  E  `hook-output-control-char` a control char in a hook_output_* text/matches (YAML `\\b`; run refuses it)
  E  a presence assert + its absence sibling            (unsatisfiable; run/skill/record refuse it:
                                                       questions_count_max:0 vs gate presence,
                                                       no_hook_blocked vs hook_blocked,
                                                       no_path_denied vs path_denied/vm_path_denied)
  W  `transcript_no_host_path` on `fidelity: cowork` (tier resolves per baseline gate —
                                                      incompatible if it lands hostloop)
  W  `no_scratchpad_leak` on `fidelity: cowork`    (tier resolves per baseline gate)
  W  no content assertion → no-op on a replay gate    (every assertion is fs/egress)
  W  mixed-class assert item → fs/egress half dropped on replay
  W  unknown top-level / assertion key                (typo or hallucinated schema)
  W  double-quoted regex with a backslash             (YAML eats the backslash)
  I  gate key present → needs a controlOut cassette on replay

lint-skill flags (skill bodies + any sibling hooks.json):
  E  `hook-event-unknown`      hooks.json declares a name that is not a hook event (typo → never runs)
  W  `hooks-json-misplaced`    hooks.json not under `hooks/` — the agent reads <plugin>/hooks/hooks.json,
                               so a root-level file is SILENTLY ignored and nothing fires
  I  `hook-event-not-served`   a real hook event that DOES fire (plugin hooks are executed by the agent,
                               live-verified) but has no assertion key, so a scenario can't gate on it
  W  `plugin-root-in-vm-bash`  a bare `$CLAUDE_PLUGIN_ROOT` in a VM bash step: the agent does not replace
                               it, and the VM shell reads it empty at host-loop
  I  `plugin-root-braced-in-vm-bash`  `${CLAUDE_PLUGIN_ROOT}` in a VM bash step: replaced at load with a HOST
                               path, which the host-loop bash tool rewrites to the VM mount (its own word only)
  W  `plugin-root-forwarded-from-vm-bash`  the whole `${CLAUDE_PLUGIN_ROOT}` as the value of a location option
                               (root/dir/path/plugin/base): a program that passes it on hands a host-side
                               reader a VM path it refuses at host-loop (a standalone skill's braced form, with
                               no plugin.json above it, is the `plugin-root-in-vm-bash` WARN: nothing replaces it)
  W  `hook-host-side-write`    a hook command that exports a var or writes /tmp for the in-VM agent
  W  `skill-body-over-reattach-cap`   SKILL.md body (frontmatter excluded) over 19,000 B — after a
                               compaction the agent re-attaches only the first ~19,900 chars (INFO from 80%)
  W  `skill-reference-over-read-cap` a references/**.md over 60,000 B — a whole-file Read past 25,000 real
                               tokens returns only a partial view with a paging notice

lint-skill suppression (judgement-call WARN/INFO rules only; a provable rule is refused with exit 2):
  --ignore-rule RULE[=GLOB]    repeatable; a run-level decision, e.g. an accepted size cap
  --suppressions FILE          repeatable; a JSON file of reviewed sites {rule, file, match?, reason},
                               each entry suppressing at most one finding (keep it outside the plugin)
  --strict-ignores             a suppression that suppressed nothing is WARN, so --strict fails on it
  <!-- lint-skill: ignore-start RULE[,RULE…]: reason -->  …  <!-- lint-skill: ignore-end -->
                               in a SKILL.md, outside any fence (wrap the whole fence); same file only
  A suppressed finding is still printed and kept in --json with a `suppressed` record; it just stops
  gating. W `lint-skill-ignore-invalid` / `lint-skill-ignore-unclosed`, I `lint-skill-ignore-unused`.

Through the `cowork-harness lint` CLI wrapper (not when this script is run directly), lint ALSO reports
every file the harness's own scenario loader rejects -- the check `run`/`record` apply before anything
runs:
  E  `scenario-invalid`   the loader refuses the file (schema, value types, unknown keys, bad regex,
                          reserved values) -- including a non-scenario YAML in a linted directory
  E  `baseline-unknown`   `baseline:` names no baseline this installed cowork-harness ships
  E  `workspace-fixture-invalid` / `workspace-fixture-vacuous-assert`   the run refuses the scenario's
                          `workspace_fixture`, or a presence assertion on a fixture file that states no `authored:`
Run directly, this script stays offline and never parses with the loader, so prefer the CLI wrapper
when it is installed.

Designed for agents and CI: non-interactive, --help, --json, meaningful exit codes,
idempotent. `lint` exits 1 on any ERROR, or with --strict on any finding at or above the
--min-severity floor (WARN by default under --strict); else 0.

Uses PyYAML — a pure-Python copy is bundled under `_vendor/`, so no separate install is needed; a
system PyYAML is preferred when present.
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import functools
import json
import re
import sys
from pathlib import Path, PureWindowsPath


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
    "tool_result_matches",
    "tool_result_not_matches",
    "tool_called",
    "tool_not_called",
    # Replay re-derives these from the SAME frozen tool inputs the live run used (a cassette stores whole
    # tool inputs), so they are content keys, not live-only.
    "reference_read",
    "no_observed_reference_access",
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
    "hook_event_fired",
    "hook_event_blocked",
    "hook_output_contains",
    "hook_output_not_contains",
    "all_tasks_completed",
    "task_count_min",
    "task_status",
    "no_scratchpad_leak",
    "present_files_called",
}
# content keys, but only evaluated on replay when the cassette carries controlOut
GATE_KEYS = {
    "question_asked",
    "question_options",
    "question_context",
    "question_option_count",
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
    "artifact_text",
    "user_visible_artifact",
    "artifact_json",
    "computer_links_resolve",
    "computer_links_resolve_if_present",
    "no_unexpected_files",
    "input_unmodified",
}
# live-only: ALWAYS skipped on replay, with a loud warning (no filesystem, no network on the token-free lane)
LIVE_ONLY_KEYS = {
    "file_absent",
    "egress_denied",
    "egress_allowed",
    "no_delete_in_outputs",
    "no_delete_in_mounts",
    "self_heal_ran",
    "transcript_no_host_path",
    "no_mcp_error",
    "max_peak_rss_bytes",
    "semantic_matches",
    "semantic_pairwise",
    "no_lost_write_back",
}
EGRESS_KEYS = {"egress_denied", "egress_allowed"}
# container-only: promotion/leak semantics exist only at fidelity: container. Production's host-loop
# branch validates a path and passes it through WITHOUT promoting, so at hostloop there is no
# scratch->outputs copy that could ever leak -- cannot-verify, not a meaningful pass/fail.
CONTAINER_ONLY_KEYS = {"no_scratchpad_leak"}
# container+hostloop: the harness serves present_files at BOTH tiers, so the DELIVERY RECORD this key
# asserts is meaningful at both. Only protocol (no /sessions/ layout) and microvm (stages into a
# different tree than the artifact scan walks) deterministically cannot serve it.
CONTAINER_HOSTLOOP_KEYS = {"present_files_called"}
# `lane: remote` + any of these is rejected at scenario LOAD time by the runtime (src/run/execute.ts):
# that lane serves no present_files and delivers nothing by location, so the key can only ever report
# cannot-verify. Catching it offline is the whole point of the linter -- otherwise the author finds out
# when a paid run refuses to start.
LANE_REMOTE_INCOMPATIBLE_KEYS = {"present_files_called", "no_scratchpad_leak", "user_visible_artifact"}
# verdict modifiers — don't verify anything themselves (e.g. suppress a default-fail)
VERDICT_MODIFIER_KEYS = {
    "allow_permissive_auto_allow",
    "allow_l0_host_config_contamination",
    "allow_missing_capability",
    "allow_stall",
    "allow_undelivered_deliverables",
    "allow_outputs_delete",
    "allow_delete_in",
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

# Hook events the harness SERVES vs every event the agent binary KNOWS. Both come from the same generated
# sidecar as ASSERT_KEYS (single source of truth: SERVED_HOOK_EVENTS / KNOWN_HOOK_EVENTS in
# src/agent/session.ts). The embedded fallbacks are parity-tested against the generated file for the same
# reason the key lists are: a hand-copied served-set silently stops warning about the event it was later
# extended to cover — the exact drift this check exists to prevent.
_FALLBACK_SERVED_HOOK_EVENTS = {"PreToolUse"}
# Re-sourced 2026-09-06 from the agent's OWN hooks-config validator array (ELF 2.1.260), not from a grep
# for event-name constants. The previous 9-name set reported the other 24 -- PostCompact and
# MessageDisplay among them -- identically to a misspelling, at ERROR severity below.
# Ordered exactly like the TS `KNOWN_HOOK_EVENTS` array: the `hook_event_fired`/`hook_event_blocked` enum
# values in _EMBEDDED_ENUMS are derived from this list and must compare equal to the generated map.
_FALLBACK_KNOWN_HOOK_EVENTS_ORDERED = [
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
    "Notification", "UserPromptSubmit", "UserPromptExpansion", "SessionStart",
    "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
    "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch",
    "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle",
    "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult",
    "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded",
    "CwdChanged", "FileChanged", "DirectoryAdded", "MessageDisplay",
]
_FALLBACK_KNOWN_HOOK_EVENTS = set(_FALLBACK_KNOWN_HOOK_EVENTS_ORDERED)
# The subset a plugin hook has been OBSERVED to fire for here (live-verified 2026-08-01, container +
# hostloop). Kept apart from the known set because the message wording depends on which claim we can
# make: accepted-by-the-validator is not reached-by-a-run.
_FALLBACK_LIVE_VERIFIED_HOOK_EVENTS = {"SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"}


def _load_hook_events():
    """(served, known, live-verified) hook-event sets, from the generated assertion-keys.json sidecar."""
    p = Path(__file__).resolve().parent / "assertion-keys.json"
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        served, known = set(d["servedHookEvents"]), set(d["knownHookEvents"])
        # Tolerate a sidecar generated before liveVerifiedHookEvents existed: fall back rather than
        # dropping to the embedded KNOWN set wholesale, which would undo the 33-name fix. Membership
        # test, NOT truthiness: an explicitly EMPTY list means the firing receipt was withdrawn, and
        # `or` would silently restore the 3-name claim -- widening a receipt, which is the one direction
        # this constant exists to prevent.
        live = set(d["liveVerifiedHookEvents"]) if "liveVerifiedHookEvents" in d else set(_FALLBACK_LIVE_VERIFIED_HOOK_EVENTS)
        if served and known:
            return served, known, live
    except Exception:
        pass
    return (
        set(_FALLBACK_SERVED_HOOK_EVENTS),
        set(_FALLBACK_KNOWN_HOOK_EVENTS),
        set(_FALLBACK_LIVE_VERIFIED_HOOK_EVENTS),
    )


SERVED_HOOK_EVENTS, KNOWN_HOOK_EVENTS, LIVE_VERIFIED_HOOK_EVENTS = _load_hook_events()

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
    "lane",  # Cowork product-lane axis: which delivery contract the run is held to (local | remote)
    "on_unanswered",
    "prompt",
    "timeout_ms",  # wall-clock budget → kill + errorSource:timeout on expiry
    "answers",
    "expect_denied",
    "assert",
    "skills",  # opt-in skill-staleness hash scope
    "requires_capabilities",  # Fix 4b: scenario-level required-capability declaration (pre-flight gate)
    "allow_host_writes",
    "allow_host_hooks",  # protocol consent: a staged plugin's hooks run as NATIVE HOST processes  # hostloop native-split: consent for a writable connected folder (pre-run gate)
    "workspace_fixture",  # a saved outputs tree staged into outputs/ before turn 1 (scenario-file-relative dir)
    "metrics",  # numbers read from JSON files the run wrote, reported beside the verdict (RunResult.metrics)
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
    "matches",
    "transcript_matches",
    "transcript_not_matches",
    "when_question",
    "subagent_dispatched",
    "question_asked",
    "hook_blocked",
    "tool_result_matches",
    "tool_result_not_matches",
    "reference_read",
    "no_observed_reference_access",
}
# The authoritative enum-value map: field id -> allowed values, generated from the Zod schemas into
# `assertion-keys.json`'s `enums` block by walking BOTH the top-level ScenarioObject fields and the
# nested answers[]/assert[] item shapes (gen-schema.ts's buildEnumMap). Backs the generic
# `enum-value-invalid` lint rule below, and replaces two independent hand-copies that used to drift from
# the schema on their own: VALID_TIERS (now `ENUM_VALUES["fidelity"]`) and the old bespoke
# on_unanswered check's VALID_ON_UNANSWERED set (now `ENUM_VALUES["on_unanswered"]`).
_EMBEDDED_ENUMS = {
    "fidelity": ["protocol", "container", "microvm", "hostloop", "cowork"],
    # "cloud-describe" IS a valid schema value here -- the runtime rejects it as RESERVED at load
    # (src/run/execute.ts: no cloud runner exists yet), so it must never be handed back to an author as
    # the FIX for some other invalid `execution:` value. See _enum_fix_values below, which is where that
    # carve-out is applied -- this map itself stays a faithful mirror of what the schema accepts.
    "execution": ["local", "cloud-describe"],
    "lane": ["local", "remote"],
    "on_unanswered": ["fail", "prompt", "llm", "first"],
    "metrics.better": ["higher", "lower"],
    "answers.decide": ["allow", "deny"],
    "answers.else": ["allow", "deny"],
    "answers.grant": ["once", "domain"],
    "assert.result": ["success", "error"],
    "assert.path_denied.source": ["pretooluse", "can_use_tool", "permission_denied"],
    "assert.path_denied.agent_scope": ["main", "subagent", "any"],
    "assert.question_options.order": ["exact", "any"],
    "assert.tool_called.scope": ["main", "subagent", "any"],
    "assert.tool_not_called.scope": ["main", "subagent", "any"],
    "assert.semantic_pairwise.pass_if": ["win", "not_worse", "any"],
    "assert.semantic_pairwise.order": ["random", "both"],
    "assert.hook_event_fired": list(_FALLBACK_KNOWN_HOOK_EVENTS_ORDERED),
    "assert.hook_event_blocked": list(_FALLBACK_KNOWN_HOOK_EVENTS_ORDERED),
    "assert.hook_output_contains.event": list(_FALLBACK_KNOWN_HOOK_EVENTS_ORDERED),
    "assert.hook_output_contains.stream": ["stdout", "stderr", "any"],
    "assert.hook_output_not_contains.event": list(_FALLBACK_KNOWN_HOOK_EVENTS_ORDERED),
    "assert.hook_output_not_contains.stream": ["stdout", "stderr", "any"],
}


def _load_enums():
    """The authoritative enum-value map, from the generated assertion-keys.json sidecar. Falls back to
    the embedded `_EMBEDDED_ENUMS` (kept equal to the generated map) with a loud warning if the file is
    missing or predates the `enums` field."""
    p = Path(__file__).resolve().parent / "assertion-keys.json"
    try:
        enums = json.loads(p.read_text(encoding="utf-8")).get("enums")
        if not enums:
            raise KeyError("enums")
        return enums
    except Exception:
        print(
            f"::warning:: assertion-keys.json missing or has no enums next to scenario.py ({p}) — "
            "using a built-in enum-value map that may be stale (run `npm run schema`).",
            file=sys.stderr,
        )
        return dict(_EMBEDDED_ENUMS)


# field id -> allowed values (generated from the zod schemas; see _load_enums)
ENUM_VALUES = _load_enums()
VALID_TIERS = tuple(ENUM_VALUES.get("fidelity", _EMBEDDED_ENUMS["fidelity"]))


def _enum_fix_values(field, allowed):
    """Allowed values to SHOW an author as the fix for an invalid `field`. Identical to the validation
    set except for `execution`, where `cloud-describe` is schema-valid but runtime-RESERVED (a load-time
    error at record/run/skill — src/run/execute.ts) — offering it as a remedy would just relocate the
    failure from `lint` to `record --dry-run` rather than resolve it."""
    if field == "execution":
        return [v for v in allowed if v != "cloud-describe"]
    return allowed


def _enum_finding(field, value, path):
    """An `enum-value-invalid` Finding if `value` is not in `field`'s allowed set, else None. Unknown
    `field`s (not in ENUM_VALUES) are silently skipped -- that would be a linter bug, not an authoring
    one, and every field this is called with is a schema enum by construction."""
    allowed = ENUM_VALUES.get(field)
    if not allowed or value in allowed:
        return None
    hint = " (`agent` was renamed to `llm`)" if field == "on_unanswered" and value == "agent" else ""
    # A present-but-null key reads as `fidelity: None` in Python; show the YAML the author wrote.
    shown = "null" if value is None else value
    return Finding(
        "ERROR",
        "enum-value-invalid",
        f"`{field}: {shown}` is not a valid value{hint}.",
        f"Use one of: {' | '.join(_enum_fix_values(field, allowed))}.",
        path,
    )

# Gate-id tripwire: the `host-path-assert-cowork` WARN below embeds Cowork's
# host-loop gate id in offline Python (the linter never reads a baseline). The
# id is pinned by test/scenario-lint-gate-id.test.ts against the PINNED_GATES
# entry in src/sync/cowork-sync.ts, so a Desktop gate re-key fails loud there
# instead of silently rotting this message.
HOST_LOOP_GATE_ID = "1143815894"


class Finding:
    __slots__ = ("severity", "rule", "message", "fix", "file", "line", "suppressed")

    def __init__(self, severity, rule, message, fix, file, line=None):
        self.severity = severity  # "ERROR" | "WARN" | "INFO"
        self.rule = rule
        self.message = message
        self.fix = fix
        self.file = file
        self.line = line
        # lint-skill only: {"by": "flag"|"marker"|"file", "marker_line": int|None, "reason": str|None} when a
        # reviewed suppression covers this finding ("file" adds `source`: "<suppressions file>#<entry index>"). The finding is still reported with its own severity;
        # it only leaves the exit computation.
        self.suppressed = None

    def as_dict(self):
        d = {
            "severity": self.severity,
            "rule": self.rule,
            "message": self.message,
            "fix": self.fix,
            "file": self.file,
            "line": self.line,
        }
        # Emitted only when set, so a run that uses no suppression prints exactly the six keys it always has.
        if self.suppressed is not None:
            d["suppressed"] = self.suppressed
        return d


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


def _assert_values(items, key):
    """Every value authored for `key` across the assert items (a key may repeat across entries).

    `_all_assert_keys` sees only NAMES, which is how this linter shipped two value-blind gate checks:
    one firing on an assertion whose premise it inverted, one exempting a floor of zero."""
    return [item[key] for item in items if isinstance(item, dict) and key in item]


def _numeric(v):
    """The number the HARNESS would see for a YAML scalar, or None if it isn't one.

    NOT `isinstance(v, int)`. This linter parses with PyYAML (YAML 1.1); the harness loads scenarios
    with the npm `yaml` package (YAML 1.2 core). `1.0` reaches Python as a float and `1e0` as a STRING,
    yet npm yaml resolves both to the integer 1 and `z.number().int()` accepts them -- so both are
    loadable scenarios that an int-only test would mis-read.

    The dialect cuts the other way too, benignly: PyYAML resolves `1_000` -> 1000 and `1:30` -> 90
    (sexagesimal), which npm yaml leaves as strings that `z.number()` REJECTS at load. Those read as a
    number here and are refused by the loader -- silent lint, loud load. Same shape as `no`/`off`
    resolving to False in 1.1 but staying strings in 1.2."""
    if isinstance(v, bool):
        return None  # `True >= 1` is true in Python; a schema-invalid `: true` is not a floor
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _tool_glob_matches(pattern, name):
    """Port of `globToRegExp` (src/glob.ts) for a tool name.

    `tool_called` is a GLOB, not a regex (src/types.ts `toolGlob`, src/assert.ts `toolMatches`):
    anchored, CASE-SENSITIVE, only `*` and `?` special, every other character literal. A value carrying
    a regex metacharacter is rejected at scenario load, so reading this field with `re.search` was wrong
    on three axes at once -- it flagged valid globs, and exempted a wrong-case glob that can never match.

    Segment-aware on purpose: a whole-segment `**` matches ZERO segments, so `**/AskUserQuestion`
    matches a bare `AskUserQuestion`. That is a property of the pattern's segments, not the subject's,
    which is why "a tool name contains no `/`" does not make a flat per-character loop equivalent."""
    segments = pattern.replace("\\", "/").split("/")
    rx = "^"
    for i, seg in enumerate(segments):
        last = i == len(segments) - 1
        if seg == "**":
            rx += "(?:[^/]+(?:/[^/]+)*)?" if last else "(?:[^/]+/)*"
            continue
        for ch in seg:
            rx += "[^/]*" if ch == "*" else "[^/]" if ch == "?" else re.escape(ch)
        if not last:
            rx += "/"
    return re.match(rx + "$", name) is not None


def _is_positional_choose(choose):
    """True if a `choose` value selects by POSITION — `first` or a 1-based index (scalar or in a
    multiSelect list) — as opposed to an exact label. Positional answers are order-dependent (H1)."""
    vals = choose if isinstance(choose, list) else [choose]
    return any(isinstance(v, str) and (v == "first" or v.isdigit()) for v in vals)


# Cassette evidence is deliberately opt-in. A scenario linter run commonly has no committed recordings,
# and guessing a cassette from the scenario name would be wrong when `record --out` chose a custom path.
# When a caller supplies `--cassette-dir`, the records below are matched by the cassette's persisted
# `scenarioSource`, never by filename. This is the Python-side equivalent of replay's evidence-shape gate;
# keeping it here means text/JSON output and the exit code agree. A skipped cassette is still visible and
# keeps the INFO advisory: a healthy sibling cannot prove that the skipped recording was safe to ignore.
_MISSING = object()

# Keep these values in sync with src/run/cassette.ts. The sync test below makes a format-range change
# fail loudly instead of allowing lint to suppress an advisory from a cassette replay would refuse.
CASSETTE_VERSION = 14
MIN_SUPPORTED_CASSETTE_VERSION = 9


def _valid_string_list(value):
    return isinstance(value, list) and all(isinstance(x, str) for x in value)


def _valid_manifest(value):
    """Return whether `artifacts` has enough shape to be trusted as replay evidence.

    Presence alone is not evidence: a malformed list must not make the linter hide an advisory. An empty
    manifest is valid for the two diff assertions whose replayable green case is an empty tree.
    """
    if not isinstance(value, list):
        return False
    for entry in value:
        if not isinstance(entry, dict):
            return False
        if not isinstance(entry.get("path"), str):
            return False
        size = entry.get("bytes")
        if isinstance(size, bool) or not isinstance(size, (int, float)):
            return False
        if not isinstance(entry.get("sha256"), str):
            return False
    return True


def _valid_pre_run_hashes(value):
    return isinstance(value, dict) and all(
        isinstance(key, str) and (item is None or isinstance(item, str)) for key, item in value.items()
    )


def _cassette_checkability(raw):
    """Mirror replay's cassette evidence preconditions for the advisory keys.

    The returned map is intentionally per-key. `no_unexpected_files` and `input_unmodified` need their
    own pre-run baselines; they cannot share the generic non-empty-artifacts test used by other manifest
    assertions. Invalid field shapes are never treated as present evidence.
    """
    artifacts = raw.get("artifacts", _MISSING)
    if artifacts is _MISSING:
        artifact_state = "missing"
    elif _valid_manifest(artifacts):
        artifact_state = "empty" if not artifacts else "present"
    else:
        artifact_state = "invalid"

    control_out = raw.get("controlOut", _MISSING)
    if control_out is _MISSING:
        control_state = "missing"
    elif _valid_string_list(control_out):
        control_state = "present" if control_out else "empty"
    else:
        control_state = "invalid"

    pre_run_paths = raw.get("preRunPaths", _MISSING)
    pre_paths_valid = pre_run_paths is not _MISSING and _valid_string_list(pre_run_paths)
    pre_run_hashes = raw.get("preRunHashes", _MISSING)
    pre_hashes_valid = pre_run_hashes is not _MISSING and _valid_pre_run_hashes(pre_run_hashes)

    return {
        key: (
            (artifact_state == "present")
            if key not in ("no_unexpected_files", "input_unmodified")
            else (artifact_state in ("empty", "present") and pre_paths_valid)
            if key == "no_unexpected_files"
            else (artifact_state in ("empty", "present") and pre_hashes_valid)
        )
        for key in MANIFEST_KEYS
    } | {key: control_state == "present" for key in GATE_KEYS}


def _cassette_records(location):
    """Read an opt-in cassette file or a non-recursive cassette directory.

    Directory mode follows the repository's existing cassette-directory convention and considers only
    `*.cassette.json` files. A custom extension can be supplied directly as a file. Every file that cannot
    become trusted evidence is retained as a skipped record and reported as an INFO finding: otherwise a
    healthy sibling could incorrectly suppress the replay advisory.
    """
    if not location:
        return [], []
    root = Path(location)
    try:
        if root.is_file():
            paths = [root]
        elif root.is_dir():
            paths = sorted(p for p in root.glob("*.cassette.json") if p.is_file())
        else:
            return [], []
    except OSError:
        return [], [
            Finding(
                "INFO",
                "cassette-evidence-skipped",
                f"cassette directory could not be read: {location}",
                "Point `--cassette-dir` at a readable cassette file or directory.",
                str(location),
            )
        ]

    records = []
    findings = []

    def skipped(path, reason):
        records.append({"source": None, "checkable": {}, "skipped": True})
        findings.append(
            Finding(
                "INFO",
                "cassette-evidence-skipped",
                f"cassette {path} was skipped: {reason}; it cannot suppress replay-evidence advice",
                "Repair or remove the cassette, then rerun lint with `--cassette-dir`.",
                str(path),
            )
        )

    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError) as e:
            skipped(path, f"unreadable ({e})")
            continue
        except ValueError as e:
            skipped(path, f"invalid JSON ({e})")
            continue
        if not isinstance(raw, dict):
            skipped(path, "the top level is not a JSON object")
            continue

        recorded_version = raw.get("cassetteVersion", 0)
        if (
            isinstance(recorded_version, bool)
            or not isinstance(recorded_version, int)
            or not (MIN_SUPPORTED_CASSETTE_VERSION <= recorded_version <= CASSETTE_VERSION)
        ):
            skipped(
                path,
                f"cassetteVersion {recorded_version!r} is outside the supported range "
                f"{MIN_SUPPORTED_CASSETTE_VERSION}..{CASSETTE_VERSION}",
            )
            continue

        source = raw.get("scenarioSource")
        if not isinstance(source, str) or not source:
            skipped(path, "missing or empty scenarioSource")
            continue
        if Path(source).is_absolute() or PureWindowsPath(source).is_absolute() or source.startswith(("/", "\\")):
            skipped(path, "scenarioSource is absolute; it must be relative to the cassette")
            continue
        source_path = os.path.normcase(os.path.abspath(os.path.normpath(str(path.parent / source))))
        records.append({"source": source_path, "checkable": _cassette_checkability(raw), "skipped": False})
    return records, findings


def _all_matching_cassettes_prove(records, scenario_path, key):
    """True only when at least one exact-provenance cassette exists and every one proves `key`."""
    if any(record.get("skipped") for record in records):
        return False
    target = os.path.normcase(os.path.abspath(os.path.normpath(str(scenario_path))))
    matching = [record for record in records if record["source"] == target]
    return bool(matching) and all(record["checkable"].get(key, False) for record in matching)


# Single-segment absolute paths that legitimately appear in prompt prose. A `/word` from this set is a
# path, not a slash command, so it never raises the not-leading warning below.
_SLASH_PATH_WORDS = frozenset(
    {"outputs", "mnt", "tmp", "home", "users", "var", "etc", "usr", "bin", "dev", "opt", "workspace", "root", "srv"}
)
# A `/`-prefixed token at a word start (start-of-string or whitespace), captured WHOLE up to the next
# space. An opening bracket or quote also counts as a word start, so "(/deck-review)" is seen; `and/or`,
# `8/22` and `https://x` still cannot match, because their slash follows a letter, digit or colon. The
# token is then classified in Python rather than by a lookahead: an earlier lookahead-based pattern
# BACKTRACKED, matching `/mn` inside `/mnt/uploads` because a shorter prefix satisfied the lookahead.
_SLASH_TOKEN_RE = re.compile(r"""(?:^|[\s(\[{"'])/(\S+)""")
# What a slash command may look like once trailing sentence punctuation is stripped: a bare name, or a
# plugin-qualified `plugin:skill`. Anchored, so any residual `/` or `.` disqualifies it as a path/filename.
_SLASH_CMD_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z][A-Za-z0-9_-]*)?$")


def _lint_prompt_slash(doc, path):
    """W: `prompt:` names a slash command somewhere other than position 0.

    The agent binary resolves a slash command only when the TRIMMED prompt starts with `/` — its parser
    trims, then requires `startsWith("/")` (verified against agent 2.1.239 in the harness's own spawn
    shape: `-p --input-format stream-json --output-format stream-json --setting-sources user`). A slash
    named mid-sentence is never expanded. It reaches the model as ordinary prose, and the model may then
    reach for the `Skill` tool on its own — the model-invocation path, i.e. exactly the unreliable
    auto-trigger a slash is normally used to bypass. The scenario still runs and can still pass, so the
    failure mode is a scenario that silently tests something other than what it reads as.

    Deliberately silent when the prompt DOES start with `/`: that is the working case. Registration is not
    checkable statically (it depends on how the skill is staged), so an unresolvable leading name is left
    to the run itself, where it shows up as `Unknown command: /x` with `num_turns: 0`.
    """
    findings = []
    prompt = doc.get("prompt")
    if not isinstance(prompt, str) or prompt.lstrip().startswith("/"):
        return findings
    seen = []
    for m in _SLASH_TOKEN_RE.finditer(prompt):
        # Trailing sentence punctuation is not part of the name, so "use /deck-review." still counts.
        name = m.group(1).rstrip(".,;:!?)]}\"'")
        if not _SLASH_CMD_NAME_RE.match(name):
            continue  # a path (`/mnt/uploads`), a filename (`/deck.pdf`), or not command-shaped
        if name.lower() in _SLASH_PATH_WORDS or name in seen:
            continue
        seen.append(name)
    for name in seen:
        findings.append(
            Finding(
                "WARN",
                "prompt-slash-not-leading",
                f"`prompt:` names `/{name}` but does not START with it. A slash command is expanded only "
                "when the trimmed prompt begins with `/`, so here it reaches the model as ordinary prose "
                "and the skill is NOT preloaded — the model may or may not reach for it on its own, which "
                "is the auto-trigger path a slash is normally used to bypass.",
                f'Put the command first — `prompt: "/{name} <args>"` — or drop the slash if the scenario '
                "means to test auto-triggering from a natural request.",
                path,
            )
        )
    return findings


_TOOL_RESULT_KEYS = ("tool_result_contains", "tool_result_not_contains", "tool_result_matches", "tool_result_not_matches")
# `forked execution` as a literal or as a regex spells the gap: a space, an escaped space, `\s`, `.`, or
# `[\s\S]`, optionally quantified (`\s+`, `.*`).
_FORKED_EXECUTION_RE = re.compile(r"forked(?: |\\ |\\s|\.|\[\\s\\S\])[+*?]?execution", re.IGNORECASE)


def _lint_slash_prompt_forked_anchor(doc, items, path):
    """W: a `/<skill>` prompt paired with a tool_result_* anchored on `forked execution`.

    `Skill "<name>" completed (forked execution).` is the `Skill` TOOL RESULT a `context: fork` skill
    returns when the MODEL invokes it. A prompt whose first character is `/` naming a staged skill is
    expanded by the agent binary itself: no `Skill` tool_use is emitted and the fork runs directly, so that
    result text never exists. A positive tool_result_* anchored on it then fails on a working skill, and a
    negative one passes vacuously. Measured on real hostloop runs of one fork skill (agent 2.1.284): the
    bare and plugin-qualified slash prompts both ran the skill with no `Skill` call; a plain prompt got one.

    Registration is not checkable statically, so the rule fires on any command-shaped leading token and the
    message says "if". It is deliberately narrow: only the fork-result anchor, since `skill_triggered` /
    `no_skill_triggered` already count a slash-invoked skill. First character only, matching the harness's
    own slash detector (a prompt with leading whitespace is not expanded).
    """
    prompt = doc.get("prompt")
    if not isinstance(prompt, str):
        return []
    m = re.match(r"/(\S+)", prompt)
    if not m:
        return []
    name = m.group(1)
    if not _SLASH_CMD_NAME_RE.match(name) or name.lower() in _SLASH_PATH_WORDS:
        return []
    findings = []
    for key in _TOOL_RESULT_KEYS:
        for v in _assert_values(items, key):
            if not isinstance(v, str) or not _FORKED_EXECUTION_RE.search(v):
                continue
            findings.append(
                Finding(
                    "WARN",
                    "slash-prompt-forked-result-anchor",
                    f"`prompt:` starts with `/{name}` and `{key}` anchors on `forked execution`. If `/{name}` is a "
                    "staged skill, the agent expands the command itself — no `Skill` tool call, so the "
                    "`completed (forked execution)` tool result never exists: a positive check fails on a working "
                    "skill and a negative one passes vacuously.",
                    f"Assert the invocation with `skill_triggered: '{name.split(':')[-1]}'` (it counts a slash-invoked "
                    "skill) and the answer with `transcript_matches`; or drop the slash if "
                    "the scenario means to test the model invoking the skill through the `Skill` tool.",
                    path,
                )
            )
    return findings


# --- the object form of tool_called / tool_not_called, and transcript_* values shaped like a command ---

# `transcript_*` reads top-level assistant prose ONLY — never a tool_use — so a value shaped like a shell
# command checks what the agent SAID it ran, not what ran. A command shape is recognised at the START of the
# value, after a shell operator (`;` `&&` `||` `|` `$(`), or after "ran"/"run"/"then", in three forms:
#   · a tool verb that never opens English prose (npm, npx, pnpm, yarn, pip, git, curl, wget, docker, uv),
#     followed by an argument;
#   · a shell (bash, sh, zsh) followed by any non-version argument (`bash deploy`);
#   · an interpreter (python3?, node, tsx, deno) followed by a flag or a file/path argument — NOT a bare
#     word (`node count`) and NOT a version (`python 3.12`, `node v22.1`), which is how prose names them.
# Plus a script FILENAME anywhere: a lowercase stem + .js/.mjs/.cjs/.ts/.py/.sh (`fetch-lesson.js`) — not a
# product name (`Node.js`, `Next.js`), not a bare extension (`the .ts files`), not a data file (.json .md).
# Deliberately NOT verbs: `make` (prose starts "make sure …"), so `make build` stays clean; and `node build`
# stays clean for the same reason `node count` must.
_CMD_LEAD = r"(?:^|;|&&|\|\||\||\$\(|\b(?:ran|run|then)\b)\s*"
_VERSION_ARG = r"v?\d[\d.]*\b"
_CMD_TOOL = re.compile(_CMD_LEAD + r"(?:npm|npx|pnpm|yarn|pip3?|git|curl|wget|docker|uv)\s+(?!" + _VERSION_ARG + r")[\w./:-]")
_CMD_SHELL = re.compile(_CMD_LEAD + r"(?:bash|sh|zsh)\s+(?!" + _VERSION_ARG + r")[\w./-]")
_CMD_INTERP = re.compile(
    _CMD_LEAD + r"(?:python3?|node|tsx|deno)\s+(?!" + _VERSION_ARG + r")(?:-{1,2}[A-Za-z]|[\w.-]*/|[\w-]+\.\w)"
)
_PRODUCT_JS = r"(?:node|next|nuxt|vue|react|express|three|d3|chart|moment|angular|ember|svelte|solid)\.js"
_SCRIPT_FILE_STEM_LOWER = re.compile(r"(?:^|(?<=[\s/'\"`(=]))[a-z0-9_][\w-]*\.(?:js|mjs|cjs|ts|py|sh)\b")


def _command_shaped(lit):
    if _CMD_TOOL.search(lit) or _CMD_SHELL.search(lit) or _CMD_INTERP.search(lit):
        return True
    # a script filename with a lowercase-led stem that is not a product name
    for m in _SCRIPT_FILE_STEM_LOWER.finditer(lit):
        if not re.fullmatch(_PRODUCT_JS, m.group(0), re.IGNORECASE):
            return True
    return False


_TRANSCRIPT_KEYS = ("transcript_matches", "transcript_not_matches", "transcript_contains", "transcript_not_contains")


def _lint_transcript_command_shaped(items, path):
    out = []
    for key in _TRANSCRIPT_KEYS:
        for v in _assert_values(items, key):
            if not isinstance(v, str):
                continue
            # Read the regex as prose: a class escape (`\s`, `\d`) becomes a space, and an escaped
            # punctuation mark (`\.`, or an over-escaped `\\.`) becomes itself — `fetch-lesson\.js\s+129`
            # reads as `fetch-lesson.js +129`.
            lit = re.sub(r"\\+([^A-Za-z0-9])", r"\1", re.sub(r"\\+[A-Za-z]", " ", v))
            if _command_shaped(lit):
                out.append(
                    Finding(
                        "WARN",
                        "transcript-command-shaped",
                        f"`{key}: {v!r}` looks like a shell command, but `{key}` reads the agent's top-level "
                        "PROSE only — never a tool call. It passes when the agent merely SAYS it ran this "
                        "(a false green), and cannot see the command that actually ran.",
                        "Assert the call itself: `tool_called: {tool: [Bash, mcp__workspace__bash], input: "
                        "{command: '<regex>'}}` (and `tool_not_called` for the negative).",
                        path,
                    )
                )
    return out


# Literal shapes the reference redaction policy scrubs (home/temp paths, mount roots, emails). Mirrors
# src/redactable-literal.ts; used when no policy is found, AND alongside a found policy, because a JS
# policy (the shipped one uses variable-width lookbehind) often cannot be compiled by Python's `re`.
_REDACTABLE_SHAPES = [
    re.compile(r"/(?:Users|home|root)/[^/\s]"),
    re.compile(r"/private/(?:tmp|var)/"),
    re.compile(r"/var/folders/"),
    re.compile(r"/Volumes/[^/\s]"),
    re.compile(r"/System/Volumes/"),
    re.compile(r"(?:^|[/\"'\s])-(?:Users|home|root)-[^/\s]"),  # a Claude project slug (-Users-acme-repo)
    re.compile(r"sk-ant-"),  # an Anthropic key: the operator-secret scrubber rewrites it whole to [REDACTED]
    re.compile(r"[A-Za-z0-9._%+-]@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
]


def _strip_lookbehinds(src):
    """Drop every `(?<=…)` / `(?<!…)` group, honouring escapes, character classes and nested parens.
    Python's `re` needs fixed-width lookbehind; the shipped policy's are variable-width. A lookbehind only
    NARROWS a match, so dropping it makes the pattern match MORE — the safe direction for a warning."""
    out = []
    i, n = 0, len(src)
    while i < n:
        if src.startswith("(?<=", i) or src.startswith("(?<!", i):
            depth, j, in_class = 0, i, False
            while j < n:
                c = src[j]
                if c == "\\":
                    j += 2
                    continue
                if in_class:
                    if c == "]":
                        in_class = False
                elif c == "[":
                    in_class = True
                elif c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            i = j + 1
            continue
        if src[i] == "\\" and i + 1 < n:
            out.append(src[i : i + 2])
            i += 2
            continue
        out.append(src[i])
        i += 1
    return "".join(out)


def _compile_js_redaction_pattern(src, flags=""):
    """Compile a `.cowork-redact.json` (JavaScript) pattern with Python `re`, translating what can be
    translated: variable-width lookbehinds are dropped (see _strip_lookbehinds), `(?<name>` becomes
    `(?P<name>`, and the i/s/m flags map across (g/u/y have no Python meaning here). Returns None when the
    result still does not compile (e.g. a `\\p{…}` property escape) — the caller must say so, not skip it."""
    py = _strip_lookbehinds(src)
    py = re.sub(r"\(\?<(?![=!])([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", py)
    fl = 0
    if "i" in flags:
        fl |= re.IGNORECASE
    if "s" in flags:
        fl |= re.DOTALL
    if "m" in flags:
        fl |= re.MULTILINE
    try:
        return re.compile(py, fl)
    except re.error:
        return None


def _redaction_policy_patterns(path):
    """`(compiled, uncheckable)` for `.cowork-redact.json` in cwd and the scenario's own dir, plus
    COWORK_HARNESS_REDACT_PATTERNS. `record` searches cwd, the scenario dir AND the cassette's dir, so this
    can miss a policy that sits only next to the cassette; the record-time comparison is the exact guard.
    JS-only syntax is translated (_compile_js_redaction_pattern); a pattern that still will not compile
    is returned in `uncheckable`, so the caller can say so instead of silently skipping it."""
    pats = []
    bad = []
    seen = set()
    for d in (Path.cwd(), Path(path).resolve().parent):
        f = d / ".cowork-redact.json"
        if f in seen or not f.is_file():
            continue
        seen.add(f)
        try:
            cfg = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for p in cfg.get("patterns") or []:
            src = p.get("regex") if isinstance(p, dict) else None
            if not isinstance(src, str):
                continue
            c = _compile_js_redaction_pattern(src, str(p.get("flags", "g")))
            if c is not None:
                pats.append(c)
            else:
                bad.append(src)
    # The operator-secret scrubber (src/secrets.ts) rewrites these LITERALLY, everywhere, before any cassette
    # or verify-run sees the stream: COWORK_HARNESS_SCRUB_VALUES, and the values of the variables named in
    # COWORK_HARNESS_SCRUB_KEYS. Matched as literals, so a regex naming one (or a prefix of one) is flagged.
    _csv = lambda v: [x.strip() for x in (v or "").split(",") if x.strip()]  # noqa: E731
    for lit in _csv(os.environ.get("COWORK_HARNESS_SCRUB_VALUES")) + [
        os.environ[k] for k in _csv(os.environ.get("COWORK_HARNESS_SCRUB_KEYS")) if os.environ.get(k)
    ]:
        # a secret prefix of 6+ chars named in the regex is as good as the secret: match either direction
        pats.append(re.compile("|".join(re.escape(lit[:n]) for n in range(min(len(lit), 6), len(lit) + 1))))
    for src in [x.strip() for x in os.environ.get("COWORK_HARNESS_REDACT_PATTERNS", "").split(",") if x.strip()]:
        c = _compile_js_redaction_pattern(src, "g")
        if c is not None:
            pats.append(c)
        else:
            bad.append(src)
    return pats, bad


def _lint_tool_call_object_form(items, fidelity, path):
    out = []
    policy = None
    for key in ("tool_called", "tool_not_called"):
        for v in _assert_values(items, key):
            if not isinstance(v, dict):
                continue
            inp = v.get("input") if isinstance(v.get("input"), dict) else {}
            regexes = [(f"input.{k}", r) for k, r in inp.items() if isinstance(r, str)]
            if isinstance(v.get("input_any"), str):
                regexes.append(("input_any", v["input_any"]))
            # W: the negative form is the dangerous direction under redaction — the committed cassette's
            # inputs are rewritten, so a regex naming a rewritten literal finds nothing and PASSES on replay.
            if key == "tool_not_called" and regexes:
                if policy is None:
                    policy, uncheckable = _redaction_policy_patterns(path)
                    if uncheckable:
                        out.append(
                            Finding(
                                "WARN",
                                "tool-input-regex-redactable",
                                f"{len(uncheckable)} redaction policy pattern(s) could not be checked offline "
                                f"(not compilable by Python even after translation: {uncheckable[0]!r}"
                                f"{', …' if len(uncheckable) > 1 else ''}), so this scenario's negative "
                                "tool-input regexes were not checked against them.",
                                "`record` checks exactly and refuses a cassette whose negative check the "
                                "policy rewrote; or simplify the pattern to syntax Python also accepts.",
                                path,
                            )
                        )
                for where, src in regexes:
                    lit = re.sub(r"\\(.)", r"\1", src)
                    if any(p.search(lit) for p in _REDACTABLE_SHAPES + policy):
                        out.append(
                            Finding(
                                "WARN",
                                "tool-input-regex-redactable",
                                f"`tool_not_called.{where}: {src!r}` names a literal the cassette's redaction "
                                "policy rewrites. On a committed (redacted) cassette the recorded input no "
                                "longer carries it, so this negative check cannot see what it looks for — "
                                "replay reports it evidence-unavailable and `record` refuses the write.",
                                "Match a part of the input redaction leaves alone (the verb and flags, a "
                                "workspace-relative path), or keep this check on a live gate.",
                                path,
                            )
                        )
            # I: `count: {min: 0}` with no max is satisfied by any number of calls, including none.
            _cnt = v.get("count") if key == "tool_called" else None
            if isinstance(_cnt, dict) and _numeric(_cnt.get("min")) == 0 and "max" not in _cnt:
                out.append(
                    Finding(
                        "INFO",
                        "tool-called-always-passes",
                        "`tool_called` with `count: {min: 0}` and no `max` is satisfied by any number of calls, "
                        "including none — it asserts nothing.",
                        "Add a `max` (e.g. `count: {max: 0}` means \"never\"), raise `min`, or drop the assertion.",
                        path,
                    )
                )
            # I: a literal `Bash` command check at a tier that routes shell through the workspace tool.
            tools = v.get("tool")
            tools = [tools] if isinstance(tools, str) else tools
            if (
                fidelity in ("hostloop", "cowork")
                and isinstance(tools, list)
                and "Bash" in tools
                and "mcp__workspace__bash" not in tools
                and "command" in inp
            ):
                out.append(
                    Finding(
                        "INFO",
                        "tool-input-shell-tier",
                        f"`{key}: {{tool: Bash, input: {{command: ...}}}}` on `fidelity: {fidelity}` — the host "
                        "loop runs shell through `mcp__workspace__bash` (same `command` field), so a literal "
                        "`Bash` sees no call there.",
                        "List both shells: `tool: [Bash, mcp__workspace__bash]`.",
                        path,
                    )
                )
    return out


def lint_doc(doc, path, raw_lines, cassette_records=None):
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

    # No `fidelity:` → no tier. The tier-dependent rules below compare against named tiers, so `None`
    # leaves every one of them silent: running them against a phantom `container` would report
    # findings about a lane the author never chose. The ERROR just below covers the missing key.
    # A key that is present but null keeps the old reading; `enum-value-invalid` reports it.
    fidelity = (doc.get("fidelity") or "container") if "fidelity" in doc else None
    lane = (doc.get("lane") or "local")

    # E: no `fidelity:` — the key is REQUIRED since 4.0.0 (it defaulted to `container` before, with a
    # warning from 2.4.0). The loader refuses the file too; under the `cowork-harness lint` wrapper that
    # shows up again as `scenario-invalid` (a duplicate, like `enum-value-invalid`), and on a direct
    # `scenario.py lint` this is the only coverage.
    # `container` models VM-loop; production runs HOST-LOOP, gate 1143815894 is force-ON in every
    # shipped baseline: the file tools resolve a bare relative path differently, the shell starts
    # somewhere else, and the offered tool set differs (measured 2026-08-27).
    # Read the KEY, not a resolved value. Only on a SCENARIO (it has `prompt:`, the loader's own signal): a
    # session or matrix YAML in a linted set carries no tier by design.
    if "prompt" in doc and "fidelity" not in doc:
        findings.append(
            Finding(
                "ERROR",
                "fidelity-missing",
                "no `fidelity:` — the key is required (since 4.0.0); `run`, `record` and the loader "
                "refuse this scenario.",
                "Add a tier: `fidelity: container` keeps the pre-4.0 behaviour (it was the default) and "
                "models the VM-LOOP lane; production runs HOST-LOOP by default (gate 1143815894), so "
                "`fidelity: hostloop` matches it and `fidelity: cowork` auto-picks the way Cowork does. "
                "Switching tiers can COST you assertions: `no_scratchpad_leak` is container-only (an "
                "error elsewhere) and `transcript_no_host_path` fails by design at hostloop/protocol. "
                "If this scenario already has a cassette, add the tier it recorded — a different tier "
                "is a recording-shaping change and needs a re-record.",
                path,
            )
        )
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

    # W: a slash command named mid-prompt is never expanded — see _lint_prompt_slash.
    findings.extend(_lint_prompt_slash(doc, path))

    # W: unknown assertion keys inside assert items (e.g. invented file_not_empty, kind, path)
    unknown_assert = sorted(assert_keys - ASSERT_KEYS)
    for k in unknown_assert:
        findings.append(
            Finding(
                "WARN",
                "unknown-assert-key",
                f"unknown assertion key `{k}` — not in the assertion catalog. `run`/`skill`/`record` "
                "REJECT the scenario at load (zod `unrecognized_keys`), so this is a hard failure "
                "waiting to happen, not a silently-ignored line.",
                "Use a real assertion key — `cowork-harness assertions --list` is the authoritative "
                "catalog (references/scenario-schema.md documents the same set). Check for a near-miss "
                "first: the negative forms are `tool_not_called`, `no_skill_triggered`, "
                "`subagent_tool_absent`, `transcript_not_contains`.",
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
    # `tool_not_called` naming a tool the TIER does not serve can never be violated — it passes
    # vacuously and verifies nothing. Expressible offline because the mapping is a harness constant
    # (WORKSPACE_TOOL_ALIASES / VM_LOOP_TOOL_ALIASES), NOT a baseline read. Deliberately literals only,
    # and deliberately a closed table: `--tools` gates the BUILT-IN set alone while every tier separately
    # passes --mcp-config, so a session-MCP tool name is offered without appearing in any tool list and
    # must never be flagged here. The harness refuses these at load; this catches them before any run.
    _TIER_VACUOUS = {
        "hostloop": {"Bash": "mcp__workspace__bash", "WebFetch": "mcp__workspace__web_fetch", "NotebookEdit": None},
        "container": {"mcp__workspace__bash": "Bash"},
        "microvm": {"mcp__workspace__bash": "Bash", "mcp__workspace__web_fetch": "WebFetch"},
        # `protocol` absent on purpose: it passes no tool flags, so its surface is the operator's own
        # host CLI registry — machine-dependent and about a different product.
    }
    # BOTH negative tool keys: `subagent_tool_absent` is judged against the tools sub-agents actually
    # USED, not a per-dispatch declared list, so a tool the tier never serves makes it equally vacuous.
    for _key in ("tool_not_called", "subagent_tool_absent"):
        for _raw in _assert_values(items, _key):
            # The object form of tool_not_called (`{tool: X | [X, Y], input: ...}`) is vacuous only when
            # EVERY listed tool is unserved — `[Bash, mcp__workspace__bash]` is the portable spelling. An
            # input/result predicate cannot rescue a tool the tier never serves. Mirrors
            # objectFormTierVacuous (src/run/tier-vacuous-tools.ts); the harness refuses these at load.
            if isinstance(_raw, dict) and _key == "tool_not_called":
                _tools = _raw.get("tool")
                _tools = [_tools] if isinstance(_tools, str) else _tools
                if not isinstance(_tools, list) or not _tools or not all(isinstance(t, str) for t in _tools):
                    continue
                if any("*" in t or "?" in t or t not in _TIER_VACUOUS.get(fidelity, {}) for t in _tools):
                    continue
                _v = _tools[0]
            else:
                _v = _raw
            if not isinstance(_v, str) or "*" in _v or "?" in _v:
                continue  # a glob is not a literal claim about one tool
            _repl = _TIER_VACUOUS.get(fidelity, {})
            if _v not in _repl:
                continue
            _instead = _repl[_v]
            findings.append(
                Finding(
                    "WARN",
                    "tool-not-called-tier-vacuous",
                    f"`{_key}: {_v}` on `fidelity: {fidelity}` — that tier does not serve "
                    f"`{_v}` at all, so this can never be violated and verifies nothing.",
                    (
                        f"Assert `{_key}: {_instead}` instead — that is what the tier serves in its place."
                        if _instead
                        else f"The {fidelity} tier removes `{_v}` outright; drop this assertion."
                    ),
                    path,
                )
            )

    # linter stays offline — the message carries the gate fact instead of reading a baseline).
    findings.extend(_lint_tool_call_object_form(items, fidelity, path))
    findings.extend(_lint_transcript_command_shaped(items, path))
    # W: a `/<skill>` prompt never produces the `Skill` fork tool result — see _lint_slash_prompt_forked_anchor.
    findings.extend(_lint_slash_prompt_forked_anchor(doc, items, path))
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

    # E: keys the runtime rejects outright on `lane: remote` (load-time throw, before any spend).
    lane_incompatible = sorted(assert_keys & LANE_REMOTE_INCOMPATIBLE_KEYS)
    if lane == "remote" and lane_incompatible:
        findings.append(
            Finding(
                "ERROR",
                "lane-remote-incompatible-key",
                f"{lane_incompatible} on `lane: remote` -- that lane serves no present_files and "
                "delivers nothing by location, so these keys can only report cannot-verify. The "
                "runtime rejects this at scenario LOAD time, before the run starts.",
                "Assert the delivery itself, or set `lane: local` if this scenario models the desktop lane.",
                path,
            )
        )

    # `lane: remote` already rejected these above; tier advice there is unreachable (the lane check
    # fires first, at load, regardless of tier) -- do not tell an author to change a tier that cannot help.
    if lane != "remote":
        # E/W: CONTAINER_ONLY_KEYS (no_scratchpad_leak) -- promotion/leak semantics are container-shaped.
        # NOT a harness coverage gap: the harness serves present_files at hostloop too, but production's
        # host-loop branch validates a path and passes it through WITHOUT promoting, so there is no
        # scratch->outputs copy that could ever leak there.
        container_only_present = sorted(assert_keys & CONTAINER_ONLY_KEYS)
        if container_only_present:
            if fidelity in ("protocol", "microvm", "hostloop"):
                findings.append(
                    Finding(
                        "ERROR",
                        "container-only-key-off-container",
                        f"{container_only_present} on `fidelity: {fidelity}` -- promotion/leak semantics "
                        "apply only at the container tier (hostloop serves present_files but never "
                        "promotes, so there is no scratch->outputs copy to leak); off container it "
                        "reports cannot-verify.",
                        "Use fidelity: container (or drop the assertion for this tier).",
                        path,
                    )
                )
            elif fidelity == "cowork":
                findings.append(
                    Finding(
                        "WARN",
                        "container-only-key-off-container",
                        f"{container_only_present} on `fidelity: cowork` -- the tier resolves to "
                        f"container or hostloop per gate {HOST_LOOP_GATE_ID}; on hostloop this key "
                        "reports cannot-verify (no promotion happens there).",
                        "Pin fidelity: container if you need this asserted deterministically.",
                        path,
                    )
                )

        # E: CONTAINER_HOSTLOOP_KEYS (present_files_called) -- served at container AND hostloop, so only
        # protocol and microvm are flagged. Deliberately NO `cowork` arm: cowork resolves to
        # hostloop|container ONLY (src/run/execute.ts), and both serve the tool -- an advisory there would
        # fire on every applicable scenario with no inapplicable case to distinguish (AGENTS.md, Advisory
        # design: "actionable by construction, or aggregated").
        present_files_present = sorted(assert_keys & CONTAINER_HOSTLOOP_KEYS)
        if present_files_present and fidelity in ("protocol", "microvm"):
            findings.append(
                Finding(
                    "ERROR",
                    "present-files-key-off-tier",
                    f"{present_files_present} on `fidelity: {fidelity}` -- present_files is served only "
                    "at container/hostloop (protocol has no /sessions/ layout for the handler's path "
                    "model; microvm stages into a different tree than the artifact scan walks); there it "
                    "reports cannot-verify.",
                    "Use fidelity: container or hostloop (or drop the assertion for this tier).",
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

    # E: enum-value-invalid — every enum-valued scenario field, top-level and nested. Schema-invalid
    # values here are refused at load (`run`/`skill`/`record` all raise zod's `invalid_value`, exit 2)
    # regardless of what `lint` says, so a scenario `lint --strict` calls clean while the loader hard-
    # rejects it is exactly the false-green class this linter exists to catch. Generalizes what used to
    # be a single bespoke check for `on_unanswered` alone — a fifth of the schema's actual enum surface
    # (see ENUM_VALUES above); the `agent` -> `llm` rename hint survives as a field-specific case in
    # _enum_finding.
    # Membership, NOT `.get(...) is not None`: a key present with an empty value (`fidelity:` and
    # nothing after it -- a one-keystroke slip) parses as null, which the loader rejects and which the
    # retired on_unanswered check let through. Absent keys stay absent; they default legitimately.
    for _field in ("fidelity", "execution", "lane", "on_unanswered"):
        if _field in doc:
            _value = doc[_field]
            _f = _enum_finding(_field, _value, path)
            if _f is not None:
                findings.append(_f)
    _metrics = doc.get("metrics")
    if isinstance(_metrics, list):
        for _m in _metrics:
            if isinstance(_m, dict) and "better" in _m:
                _f = _enum_finding("metrics.better", _m["better"], path)
                if _f is not None:
                    findings.append(_f)
    _answers = doc.get("answers")
    if isinstance(_answers, list):
        for _rule in _answers:
            if not isinstance(_rule, dict):
                continue
            for _key in ("decide", "else", "grant"):
                if _key in _rule:
                    _value = _rule[_key]
                    _f = _enum_finding(f"answers.{_key}", _value, path)
                    if _f is not None:
                        findings.append(_f)
    for _item in items:
        if "result" in _item:
            _value = _item["result"]
            _f = _enum_finding("assert.result", _value, path)
            if _f is not None:
                findings.append(_f)
        _path_denied = _item.get("path_denied")
        if isinstance(_path_denied, dict):
            for _key in ("source", "agent_scope"):
                if _key in _path_denied:
                    _value = _path_denied[_key]
                    _f = _enum_finding(f"assert.path_denied.{_key}", _value, path)
                    if _f is not None:
                        findings.append(_f)
        for _tk in ("tool_called", "tool_not_called"):
            _tv = _item.get(_tk)
            if isinstance(_tv, dict) and "scope" in _tv:
                _f = _enum_finding(f"assert.{_tk}.scope", _tv["scope"], path)
                if _f is not None:
                    findings.append(_f)
        _question_options = _item.get("question_options")
        if isinstance(_question_options, dict):
            if "order" in _question_options:
                _value = _question_options["order"]
                _f = _enum_finding("assert.question_options.order", _value, path)
                if _f is not None:
                    findings.append(_f)

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

    # W: gate_answers_delivered with no presence companion → vacuous the moment the skill stops asking.
    #
    # `gate_answers_delivered` checks that every gate that fired was delivered non-error, and ZERO gates
    # fired passes VACUOUSLY (gate firing is model-dependent, so failing there would red every run of a
    # skill that legitimately doesn't ask). The consequence is the failure mode this rule exists for: a
    # skill that silently STOPS asking keeps a green assertion forever. A real corpus had a recording with
    # 0 gates sit green for weeks against a scenario asserting exactly this key.
    #
    # A companion is anything that FAILS (rather than vacuously passes) on an empty gate set:
    #   · gate_answer_count_min WITH A FLOOR >= 1 — the explicit floor. The value matters: `: 0` is legal
    #     (the schema is nonnegative) and `delivered >= 0` always holds, so a zero floor witnesses nothing
    #     and must not silence this rule. Reading the key NAME alone made the "looks paired" scenario a
    #     silent false-green — worse than the loud one this rule was written for.
    #   · question_asked — fails "no question matched" against an empty question list, for ANY pattern
    #     (`.some` over an empty list is false, so no value gate is needed here).
    #   · question_options — same: with zero gates recorded it fails "no question ... was asked", never
    #     passes vacuously, so it witnesses a gate just as well.
    #   · tool_called whose GLOB matches AskUserQuestion — fails "tool not called".
    # `questions_count_max` is deliberately NOT a companion: a MAX passes vacuously at zero, so pairing it
    # leaves the hole wide open. The harness's own `scaffold` emits `question_asked` alongside this key,
    # which is why the exemption must include it — otherwise this rule reds the tool's own output.
    #
    # VALUE, not just key. `gate_answers_delivered: false` is the INVERSE assertion — it demands at least
    # one gate whose answer was confirmed NOT delivered, so zero gates FAILS it. It is not the vacuous
    # direction, and `gate_answer_count_min` (which counts delivered === true) is not its companion.
    # Firing there reds a correct negative-path scenario under CI's `--strict --min-severity WARN`, with a
    # message whose premise is inverted. Skip on `is False` specifically, so a schema-invalid non-bool
    # still warns rather than opening a new hole. (`no`/`off` also reach here as False under PyYAML's
    # YAML 1.1 but are rejected by the loader as strings — see _numeric for the same dialect gap.)
    delivered_values = _assert_values(items, "gate_answers_delivered")
    if any(v is not False for v in delivered_values):
        has_companion = (
            "question_asked" in assert_keys
            or "question_options" in assert_keys
            or "question_context" in assert_keys
            or "question_option_count" in assert_keys
        ) or any(
            (n := _numeric(v)) is not None and n >= 1 for v in _assert_values(items, "gate_answer_count_min")
        )
        if not has_companion:
            for item in items:
                tc = item.get("tool_called")
                # A GLOB, not a regex (src/types.ts toolGlob) — ask whether THEIR pattern would match the
                # gate tool under the harness's own matching rules. The object form witnesses a gate the
                # same way (`{tool: AskUserQuestion}` fails "not called" on zero gates) unless its
                # `count.min` is 0, which zero gates satisfies. Other value shapes are somebody else's
                # finding; a glob cannot fail to compile, so there is nothing to guard against here.
                if isinstance(tc, dict):
                    _cnt = tc.get("count")
                    _min = _numeric(_cnt.get("min")) if isinstance(_cnt, dict) and "min" in _cnt else 1.0
                    _tl = tc.get("tool")
                    _tl = [_tl] if isinstance(_tl, str) else _tl
                    if (
                        _min is not None
                        and _min >= 1
                        and isinstance(_tl, list)
                        and any(isinstance(g, str) and _tool_glob_matches(g, "AskUserQuestion") for g in _tl)
                    ):
                        has_companion = True
                        break
                elif isinstance(tc, str) and _tool_glob_matches(tc, "AskUserQuestion"):
                    has_companion = True
                    break
        if not has_companion:
            # The scenario may already have DECLARED that it expects no gates. Then "add a companion" is
            # wrong advice — the key is inert, and the fix is to drop it. Same rule id, different message;
            # it must not go silent, because `questions_count_max: 0` is still not a presence companion.
            declares_zero_gates = any(_numeric(v) == 0 for v in _assert_values(items, "questions_count_max"))
            if declares_zero_gates:
                findings.append(
                    Finding(
                        "WARN",
                        "vacuous-gate-assert",
                        "`gate_answers_delivered` is inert here — this scenario already declares it expects "
                        "no gates (`questions_count_max: 0`), and zero gates fired passes "
                        "`gate_answers_delivered` VACUOUSLY, so the key asserts nothing.",
                        "Drop `gate_answers_delivered` — `questions_count_max: 0` already states the intent "
                        "and fails loudly if a gate ever appears. If the scenario is meant to gate after all, "
                        "drop `questions_count_max: 0` and pair the delivery check with "
                        "`gate_answer_count_min: 1`.",
                        path,
                    )
                )
            else:
                findings.append(
                    Finding(
                        "WARN",
                        "vacuous-gate-assert",
                        "`gate_answers_delivered` has no presence companion — zero gates fired passes it "
                        "VACUOUSLY, so this assertion stays green if the skill stops asking altogether "
                        "(exactly the regression it looks like it is guarding).",
                        "If the scenario is meant to gate, pair it with `gate_answer_count_min: 1` (a floor "
                        'of 0 witnesses nothing) — or a `question_asked: "<rx>"`, or `tool_called: '
                        '"AskUserQuestion"` — so a gate must actually fire. If the scenario is gate-clean by '
                        "design, DROP `gate_answers_delivered` (it asserts nothing there) and declare the "
                        "intent with `questions_count_max: 0` (or `tool_not_called: \"AskUserQuestion\"`), "
                        "which fails loudly if a gate ever appears.",
                        path,
                    )
                )

    # E: a statically unsatisfiable assert pairing — the scenario can never pass, on any lane.
    #
    # Each group pairs ONE assertion demanding a record NOT exist with the assertions demanding the SAME
    # record does exist, on a single evidence channel:
    #   · questions_count_max: 0 vs gate presence — a delivered gate records at least one question (the
    #     harness pushes one entry per sub-question BEFORE answering, and a zero-question gate throws).
    #   · no_hook_blocked vs hook_blocked — one hook-event list.
    #   · no_path_denied vs path_denied / vm_path_denied — one path-denial list.
    # Verified against the assertion implementations, not the schema prose: a scope split would make a
    # pair satisfiable, and there is none. Where the evidence is missing BOTH halves fail
    # evidence-unavailable rather than passing, and the denial keys are hostloop-only so a wrong tier
    # fails both too — no combination yields a both-pass.
    #
    # Deliberately NOT extended to `tool_not_called` as a gate witness: it reads the tool log while the
    # gate keys read the control channel, and a fixture-driven `protocol` run can gate on the control
    # channel alone, so that cross-channel contradiction is not provable from the YAML.
    #
    # ERROR because `run`/`skill`/`record` refuse the scenario outright (assertContradiction in
    # src/run/execute.ts) — the same reason `on_unanswered: agent` is an ERROR. Note the pairing is
    # unsatisfiable, not always-red: on a lane where the evidence is absent it is not evaluated at all
    # (verify-run fails evidence-unavailable; a controlOut-less cassette SKIPS these keys on replay).
    # Either way it guards nothing.
    contradiction_groups = [
        (
            "`questions_count_max: 0`",
            any(_numeric(v) == 0 for v in _assert_values(items, "questions_count_max")),
            [
                (
                    "gate_answer_count_min: >= 1",
                    any((n := _numeric(v)) is not None and n >= 1 for v in _assert_values(items, "gate_answer_count_min")),
                ),
                ("question_asked", "question_asked" in assert_keys),
                ("question_options", "question_options" in assert_keys),
                ("question_context", "question_context" in assert_keys),
                ("question_option_count", "question_option_count" in assert_keys),
                ("gate_answers_delivered: false", any(v is False for v in _assert_values(items, "gate_answers_delivered"))),
            ],
            "a delivered gate records at least one question, so requiring a gate to be present contradicts requiring zero questions",
        ),
        (
            "`no_hook_blocked: true`",
            any(v is True for v in _assert_values(items, "no_hook_blocked")),
            [("hook_blocked", "hook_blocked" in assert_keys)],
            "both read the same hook-event list — the block `hook_blocked` requires is the one `no_hook_blocked` requires not to exist",
        ),
        (
            "`no_path_denied: true`",
            any(v is True for v in _assert_values(items, "no_path_denied")),
            [
                ("path_denied", "path_denied" in assert_keys),
                ("vm_path_denied: true", any(v is True for v in _assert_values(items, "vm_path_denied"))),
            ],
            "both read the same path-denial list — the denial the positive key requires is one `no_path_denied` requires not to exist",
        ),
    ]
    clauses = []
    for absence_label, absent, presences, why in contradiction_groups:
        if not absent:
            continue
        hits = [label for label, present in presences if present]
        # Report EVERY contradictory group, not just the first — a scenario can carry more than one.
        if hits:
            clauses.append(f"{absence_label} alongside {' and '.join(hits)} ({why})")
    # Value-level, so not a group above (mirrors hookOutputContradictions in src/run/execute.ts): the same event
    # and needle in hook_output_not_contains and hook_output_contains, where the negative's stream covers the
    # positive's (equal, or `any`). `contains: any` + `not_contains: stderr` is satisfiable — not flagged.
    for n in _assert_values(items, "hook_output_not_contains"):
        for p in _assert_values(items, "hook_output_contains"):
            if not isinstance(n, dict) or not isinstance(p, dict):
                continue
            n_stream = n.get("stream", "any")
            p_stream = p.get("stream", "any")
            # Only str needles compare: PyYAML (YAML 1.1) reads `yes` / `on` as True where the harness's loader keeps
            # the strings, so `text: yes` and `text: on` would compare equal here and not there.
            same_needle = any(
                isinstance(n.get(f), str) and isinstance(p.get(f), str) and n.get(f) == p.get(f) for f in ("text", "matches")
            )
            if n.get("event") != p.get("event") or not same_needle or not (n_stream == "any" or n_stream == p_stream):
                continue
            needle = f"text {json.dumps(n['text'])}" if "text" in n else f"matches {json.dumps(n['matches'])}"
            clauses.append(
                f"`hook_output_not_contains` alongside `hook_output_contains` for {n.get('event')} {needle} "
                f"(stream {n_stream} / {p_stream}) (both read the same hook_response frames — the output "
                f"`hook_output_contains` requires is the output `hook_output_not_contains` requires not to exist)"
            )
    if clauses:
        findings.append(
            Finding(
                "ERROR",
                "assert-contradiction",
                # "both" is wrong once more than one group is named -- and a scenario carrying two is
                # exactly the one whose message gets read carefully.
                f"{'; and '.join(clauses)} — "
                + ("no run can satisfy both." if len(clauses) == 1 else "no run can satisfy all of them."),
                "Keep the negative assertion and drop the positive one, or drop the negative if the "
                "scenario really does expect the record.",
                path,
            )
        )
    # E: a control character in a hook_output_* needle. The harness's loader refuses it (src/types.ts, CONTROL_CHAR):
    # it is almost always a YAML double-quoted escape (`"\bfailed\b"` loads a backspace), and a needle no hook
    # prints makes the negative key pass silently. Mirrored so this linter rejects what `run` rejects.
    for key in ("hook_output_contains", "hook_output_not_contains"):
        for v in _assert_values(items, key):
            if not isinstance(v, dict):
                continue
            for f in ("text", "matches"):
                s = v.get(f)
                if isinstance(s, str) and _HOOK_NEEDLE_CONTROL_CHAR.search(s):
                    findings.append(
                        Finding(
                            "ERROR",
                            "hook-output-control-char",
                            f"`{key}.{f}` {json.dumps(s)} contains a control character — in a double-quoted YAML "
                            f"string `\\b` is a backspace, not a word boundary. The harness refuses this scenario at load.",
                            "Single-quote the value (e.g. '\\bfailed open\\b').",
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

    # I: manifest-backed keys need an artifacts manifest on replay. On `lane: remote`, a key that is ALSO
    # in LANE_REMOTE_INCOMPATIBLE_KEYS (user_visible_artifact) already got the ERROR above and is rejected
    # at scenario-LOAD time -- it can never reach a replay to re-record for, so "re-record so it evaluates"
    # is unreachable advice for that key (same rationale as the tier-rule suppression above). Filtered
    # per-key, not the whole block: the other manifest keys (file_exists, artifact_json, ...) are NOT
    # lane-rejected and stay genuinely reachable and worth advising about on `lane: remote`.
    manifest_present = sorted(assert_keys & MANIFEST_KEYS)
    if lane == "remote":
        manifest_present = [k for k in manifest_present if k not in LANE_REMOTE_INCOMPATIBLE_KEYS]
    if cassette_records is not None:
        manifest_present = [
            key for key in manifest_present if not _all_matching_cassettes_prove(cassette_records, path, key)
        ]
    if manifest_present:
        findings.append(
            Finding(
                "INFO",
                "manifest-needs-snapshot",
                f"assertion(s) {manifest_present} evaluate on replay only when the cassette carries an "
                "`artifacts` manifest (`record` snapshots one). A manifest-less cassette skips them "
                "(with a loud warning).",
                "No action is needed when every matching cassette carries the evidence required by each "
                "listed assertion: a non-empty `artifacts` manifest for file/content assertions, or "
                "the appropriate pre-run baseline for diff assertions. Pass `--cassette-dir <dir>` "
                "(or one cassette file) to let lint prove that; otherwise re-record only if the cassette "
                "predates the manifest. "
                "`lint --min-severity WARN` silences the whole INFO class in CI.",
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
                "positional index only when labels drift but order holds. Worth a second look for a "
                "different reason: unstable option order is also what the USER sees — a reordered gate "
                "puts a different choice in the default slot. Pin what the user was shown with "
                "`question_options: {when_question: ..., equals: [...]}` (order is compared by default).",
                path,
            )
        )

    # I: gate keys need a controlOut cassette on replay
    gate_present = sorted(assert_keys & GATE_KEYS)
    if cassette_records is not None:
        gate_present = [key for key in gate_present if not _all_matching_cassettes_prove(cassette_records, path, key)]
    if gate_present:
        findings.append(
            Finding(
                "INFO",
                "gate-needs-controlout",
                f"gate assertion(s) {gate_present} only evaluate on replay when the cassette has "
                "controlOut (full-fidelity). An old cassette excludes them (with a loud warning).",
                "No action is needed when every matching cassette has non-empty `controlOut` evidence. "
                "Pass `--cassette-dir <dir>` (or one cassette file) to let lint prove that; otherwise "
                "re-record only if the cassette is old. `lint --min-severity WARN` silences the whole "
                "INFO class in CI.",
                path,
            )
        )

    # E: `file_exists: X` and `file_absent: X` on the SAME path cannot both hold. Checked here rather
    # than in the TS contradiction groups because those match on key PRESENCE across the array and
    # cannot compare values; the linter already has the parsed YAML, so the value comparison is free.
    # `file_exists` has a string form and an object form `{path, authored}` — both name the same path.
    exists_paths = {
        v if isinstance(v, str) else v.get("path")
        for v in _assert_values(items, "file_exists")
        if isinstance(v, str) or (isinstance(v, dict) and isinstance(v.get("path"), str))
    }
    absent_paths = {v for v in _assert_values(items, "file_absent") if isinstance(v, str)}
    both = sorted(exists_paths & absent_paths)
    if both:
        findings.append(
            Finding(
                "ERROR",
                "file-absent-contradiction",
                f"assert requires {both} to both exist (`file_exists`) and not exist (`file_absent`) — "
                "no run can satisfy that, so this would spend a run to fail.",
                "Drop whichever half the scenario does not mean. If you meant 'this file must be replaced', "
                "assert the new content with `artifact_text`/`artifact_json` instead.",
                path,
            )
        )

    # Same shape for the reference-access pair: `reference_read: R` and `no_observed_reference_access: R`
    # with the IDENTICAL regex cannot both hold. Compared as raw pattern strings — two different regexes
    # that happen to match the same path are NOT a contradiction (the linter cannot know the paths), so
    # this only fires on the case that is unambiguously self-defeating.
    read_pats = {v for v in _assert_values(items, "reference_read") if isinstance(v, str)}
    unread_pats = {v for v in _assert_values(items, "no_observed_reference_access") if isinstance(v, str)}
    both_refs = sorted(read_pats & unread_pats)
    if both_refs:
        findings.append(
            Finding(
                "ERROR",
                "reference-access-contradiction",
                f"assert requires {both_refs} to be both accessed (`reference_read`) and never observed "
                "(`no_observed_reference_access`) — no run can satisfy that, so this would spend a run to fail.",
                "Drop whichever half the scenario does not mean. To check that ONE reference is reached while "
                "another is not, give the two keys different patterns.",
                path,
            )
        )

    # W: double-quoted regex with a backslash (raw-text scan — the parser already ate it)
    findings.extend(_lint_regex_quoting(path, raw_lines))

    return findings


# The same class as the harness's CONTROL_CHAR (src/types.ts): tab, newline and carriage return are allowed.
_HOOK_NEEDLE_CONTROL_CHAR = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

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


def lint_file(path, cassette_records=None):
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
    return lint_doc(doc, path, raw_lines, cassette_records)


SEV_ORDER = {"ERROR": 0, "WARN": 1, "INFO": 2}


def _print_findings(
    findings, n_files, kind="scenario", clean_suffix=" — no silent-false-green findings.", suppression=False
):
    """`suppression=True` is lint-skill's renderer: a suppressed finding gets the ⊘ glyph and a note, the
    counts cover only the findings still in play, and the summary names what was suppressed. `lint` never
    passes it, so its output is unchanged."""
    if not findings:
        print(f"✓ {n_files} {kind}(s) clean{clean_suffix}")
        return
    for x in sorted(findings, key=lambda f: (str(f.file), SEV_ORDER[f.severity])):
        loc = f"{x.file}:{x.line}" if x.line else x.file
        sup = x.suppressed if suppression else None
        if sup is None:
            glyph = {"ERROR": "✗", "WARN": "⚠", "INFO": "ℹ"}[x.severity]
            print(f"{glyph} {x.severity} [{x.rule}] {loc}")
        elif sup["by"] == "marker":
            why = f" — {sup['reason']}" if sup["reason"] else ""
            print(f"⊘ {x.severity} [{x.rule}] {loc} (suppressed by marker at :{sup['marker_line']}{why})")
        elif sup["by"] == "file":
            print(f"⊘ {x.severity} [{x.rule}] {loc} (suppressed by {sup['source']}: {sup['reason']})")
        else:
            print(f"⊘ {x.severity} [{x.rule}] {loc} (suppressed by --ignore-rule)")
        print(f"    {x.message}")
        print(f"    fix: {x.fix}")
    active = [x for x in findings if not (suppression and x.suppressed is not None)]
    n_err = sum(1 for x in active if x.severity == "ERROR")
    n_warn = sum(1 for x in active if x.severity == "WARN")
    n_info = sum(1 for x in active if x.severity == "INFO")
    tail = "."
    suppressed = [x for x in findings if suppression and x.suppressed is not None]
    if suppressed:
        groups = {}
        for x in suppressed:
            by = x.suppressed["by"]
            key = (x.rule, "marker" if by == "marker" else "suppressions file" if by == "file" else "--ignore-rule")
            groups[key] = groups.get(key, 0) + 1
        parts = ", ".join(f"{rule} ×{n} by {by}" for (rule, by), n in sorted(groups.items()))
        tail = f"; {len(suppressed)} suppressed ({parts})."
    print(f"\n{n_err} error(s), {n_warn} warning(s), {n_info} info across {n_files} file(s){tail}")


_EXTRA_FINDINGS_ENV = "COWORK_HARNESS_LINT_EXTRA_FINDINGS"


def _wrapper_loader_findings():
    """Findings from the harness's own scenario loader, handed over by the `cowork-harness lint` wrapper.

    The wrapper runs the loader `run`/`record` use before spawning this script and writes what it rejects
    (`scenario-invalid`, `baseline-unknown`) to a JSON file named by COWORK_HARNESS_LINT_EXTRA_FINDINGS.
    Merged here so ONE renderer, ONE --min-severity filter and ONE exit rule apply to both sets.

    Honoured only together with COWORK_HARNESS_PROG, which the wrapper always sets: a direct
    `python3 scenario.py lint` never reads the variable, even if the shell happens to carry it. A blank
    value is unset. A file that can't be read or doesn't have the expected shape is an ERROR, never a
    silent drop -- a dropped loader finding would be a false green."""
    path = (os.environ.get(_EXTRA_FINDINGS_ENV) or "").strip()
    if not path or not os.environ.get("COWORK_HARNESS_PROG"):
        return []

    def bad(why):
        return [
            Finding(
                "ERROR",
                "linter-extra-findings-invalid",
                f"could not read the scenario-loader findings handed over by cowork-harness: {why}",
                "This is a harness bug, not a scenario problem -- please report it. "
                "`cowork-harness record <file> --dry-run` checks that a scenario loads.",
                "(scenario.py)",
            )
        ]

    try:
        entries = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return bad(str(e))
    if not isinstance(entries, list):
        return bad("expected a JSON array")
    out = []
    for i, x in enumerate(entries):
        if (
            not isinstance(x, dict)
            or x.get("severity") not in SEV_ORDER
            or not all(isinstance(x.get(k), str) for k in ("rule", "message", "fix", "file"))
            or not (x.get("line") is None or (isinstance(x.get("line"), int) and not isinstance(x.get("line"), bool)))
        ):
            return bad(f"entry {i} is not a finding")
        out.append(Finding(x["severity"], x["rule"], x["message"], x["fix"], x["file"], x.get("line")))
    return out


# Every rule id `lint` can emit, with the highest severity it is emitted at. Nothing reads this at run time
# (`lint` has no rule suppression); it exists so a test can check that every `Finding("<SEV>", "<id>", …)`
# in this file is claimed by exactly one of this and LINT_SKILL_RULES. The loader findings the wrapper hands
# over (`scenario-invalid`, `baseline-unknown`, `workspace-fixture-*`) are built in TypeScript and are not listed.
LINT_RULES = {
    "assert-contradiction": "ERROR",
    "assertions-key": "ERROR",
    "authored-replay-fidelity": "ERROR",
    "capabilities-on-protocol": "ERROR",
    "cassette-evidence-skipped": "INFO",
    "container-only-key-off-container": "ERROR",
    "egress-on-protocol": "ERROR",
    "enum-value-invalid": "ERROR",
    "fidelity-missing": "ERROR",
    "file-absent-contradiction": "ERROR",
    "gate-needs-controlout": "INFO",
    "hook-output-control-char": "ERROR",
    "host-path-assert-cowork": "WARN",
    "host-path-assert-tier": "ERROR",
    "lane-remote-incompatible-key": "ERROR",
    "linter-extra-findings-invalid": "ERROR",
    "linter-unclassified-key": "ERROR",
    "manifest-needs-snapshot": "INFO",
    "mixed-assert-item": "WARN",
    "no-scenarios": "ERROR",
    "not-found": "ERROR",
    "parse": "ERROR",
    "positional-choose-order": "INFO",
    "present-files-key-off-tier": "ERROR",
    "prompt-slash-not-leading": "WARN",
    "reference-access-contradiction": "ERROR",
    "regex-double-quoted": "WARN",
    "replay-noop": "WARN",
    "slash-prompt-forked-result-anchor": "WARN",
    "tool-called-always-passes": "INFO",
    "tool-input-regex-redactable": "WARN",
    "tool-input-shell-tier": "INFO",
    "tool-not-called-tier-vacuous": "WARN",
    "transcript-command-shaped": "WARN",
    "unknown-assert-key": "WARN",
    "unknown-top-key": "WARN",
    "vacuous-gate-assert": "WARN",
}


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
    # Cassette inspection is opt-in: without the flag the linter remains entirely static, preserving the
    # existing CI behavior. With it, one index is shared across all scenario files in this invocation.
    cassette_location = getattr(args, "cassette_dir", None)
    if cassette_location:
        cassette_records, cassette_findings = _cassette_records(cassette_location)
        all_findings.extend(cassette_findings)
    else:
        cassette_records = None
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
        all_findings.extend(lint_file(f, cassette_records))
    all_findings.extend(_wrapper_loader_findings())
    # Filter BEFORE rendering AND before the exit computation — deliberately, so --min-severity narrows
    # what the run actually cares about. Filtering at render only would make `--strict --min-severity ERROR`
    # print "0 findings" and still exit 1 (because --strict keys off the unfiltered set), which is
    # indistinguishable from a bug. Applied identically to --json so the two output modes never disagree.
    # The DEFAULT floor depends on --strict: WARN under --strict (it fails on ERROR and WARN and hides INFO,
    # so it fails on the same classes as `lint-skill --strict`, which still prints INFO), INFO otherwise. An explicit --min-severity always wins, so
    # `--strict --min-severity INFO` still prints and fails on INFO.
    min_severity = getattr(args, "min_severity", None) or ("WARN" if args.strict else "INFO")
    floor = SEV_ORDER[min_severity]
    all_findings = [x for x in all_findings if SEV_ORDER[x.severity] <= floor]
    if args.json:
        print(json.dumps([x.as_dict() for x in all_findings], indent=2))
    else:
        _print_findings(all_findings, len(args.files))
    # Run directly (no COWORK_HARNESS_PROG — the wrapper always sets it), this script never ran the scenario
    # loader `run`/`record` use, so "clean" here is weaker than `cowork-harness lint`'s. Say so on stderr only:
    # stdout carries the --json array, and the exit code must not change.
    if not os.environ.get("COWORK_HARNESS_PROG"):
        print(
            "note: scenario loader skipped — this direct run checks the lint rules only. "
            "Run `cowork-harness lint` to also check that each file loads the way `run`/`record` load it.",
            file=sys.stderr,
        )
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
#   * a `Bash(...)` tool-directive line.
# A JSON `"command": "..."` value in a hooks config (a fenced ```json block or a hooks.json file) is checked
# for host-side writes only: a plugin hook gets a plugin-root path valid where it runs, so the token is fine
# there.
# It NEVER inspects host-side prose or a `Read`/`Grep` directive — reading a reference via
# `${CLAUDE_PLUGIN_ROOT}/references/x.md` in prose is the CORRECT, common idiom and is left alone.
# Consequence: false negatives are expected. A `${CLAUDE_PLUGIN_ROOT}` path in an INDENTED (4-space)
# or otherwise UNFENCED shell snippet won't be caught, because v1 keys entirely off fenced blocks +
# hooks JSON. Widening the shell heuristic would trade those false negatives for false positives, which
# v1 declines to do.

_PLUGIN_ROOT_TOKEN = re.compile(r"\$\{?CLAUDE_PLUGIN_ROOT\}?")
# A runtime SELF-HEAL for a plugin-root path the VM shell cannot use (a bare $CLAUDE_PLUGIN_ROOT, a skill
# outside a plugin, a path glued to other text the host-loop rewrite leaves alone): discovering the
# real mount under /sessions at run time (the prescribed pattern — e.g.
# `[ -d "$X" ] || X=$(find /sessions ... -name ...)`, or an inline `|| python3 "$(find /sessions ...)"`).
# When a bash block that uses the token ALSO contains a `find` over /sessions, the block rescues that path
# → report it as INFO. Conservative: we do NOT verify the find pattern actually matches the
# plugin's layout (hence the INFO's "not validated").
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


# The agent replaces only the literal BRACED token in a plugin skill's text when the skill loads; a bare
# `$CLAUDE_PLUGIN_ROOT` (or `${CLAUDE_PLUGIN_ROOT:-…}`) is left for the shell, which reads the environment.
_PLUGIN_ROOT_BRACED = re.compile(r"\$\{CLAUDE_PLUGIN_ROOT\}")
# Every form the agent does NOT replace, as written: `${CLAUDE_PLUGIN_ROOT:-…}` or a bare `$CLAUDE_PLUGIN_ROOT`.
_PLUGIN_ROOT_UNREPLACED = re.compile(r"\$\{CLAUDE_PLUGIN_ROOT[^}]+\}|\$CLAUDE_PLUGIN_ROOT\b")
# The forwarding shape: the whole braced root, with nothing appended, as the value of a long option whose name
# says it carries a location (`--plugin-root-agent "${CLAUDE_PLUGIN_ROOT}"`, `--root=${CLAUDE_PLUGIN_ROOT}`). A
# program handed the bare plugin root under such an option most often passes it on (into a sub-agent's prompt,
# say) rather than opening it, and at host-loop the value it receives is the rewritten VM path. A positional
# argument, a heredoc line, an assignment, an option with another name (`ls --color "${…}"`, which takes no
# value) and the agent CLI's own `claude --plugin-dir` are left alone: those are as often a path the program
# opens, which works, and the text cannot tell them apart.
_PLUGIN_ROOT_OPTION = re.compile(
    r"""--([A-Za-z0-9][A-Za-z0-9_-]*)(?:=|[ \t]+)(["']?)\$\{CLAUDE_PLUGIN_ROOT\}\2(?=[\s;|&)]|$)"""
)
_LOCATION_OPTION_NAME = re.compile(r"root|dir|path|plugin|base", re.IGNORECASE)
# Where the command that owns an option starts: after a shell separator or an opening subshell.
_COMMAND_SEPARATOR = re.compile(r"[;|&\n(]")
# A shell comment (a `#` at the start or after whitespace, to end of line). Stripped before the forwarding
# check: prose in a comment names the token without passing it anywhere.
_SHELL_COMMENT = re.compile(r"(^|\s)#.*$")
_IGNORE_MARKER_EXAMPLE = (
    "`<!-- lint-skill: ignore-start <rule>: <why this site is correct> -->` … "
    "`<!-- lint-skill: ignore-end -->`"
)


# The host-loop bash rewrite's boundary sets (src/hostloop/plugin-path-rewrite.ts), spelled the same way: a
# substituted path is rewritten only when the character before it is not a left blocker (or is an opening
# quote) and the character after it is in the right-boundary set or the end of the command.
_REWRITE_LEFT_BLOCKERS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + "_./\\-" + ")}~" + "`'\"")
_REWRITE_RIGHT_BOUNDARY = set("`'\"" + "&|;<>" + "()[]{}" + "/")
_REWRITE_QUOTE_OPENER_PRECEDERS = set("=&|;(<{")
_REWRITE_QUOTES = set("`'\"")
# JavaScript's `\s`, which the rewrite tests with (Python's str.isspace also counts \x1c-\x1f, `\s` does not).
_JS_WHITESPACE = set("\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff") | {chr(c) for c in range(0x2000, 0x200B)}


def _rewrite_is_opening_quote(text, idx):
    quote = text[idx - 1]
    if text[:idx].count(quote) % 2 != 1:
        return False
    before = text[idx - 2] if idx >= 2 else None
    return before is None or before in _JS_WHITESPACE or before in _REWRITE_QUOTE_OPENER_PRECEDERS


def _glued_plugin_root(text):
    """True when some braced `${CLAUDE_PLUGIN_ROOT}` in `text` is glued to other text on either side, so the
    host-loop bash tool does not rewrite the path substituted for it, and the VM shell gets a host path."""
    for m in _PLUGIN_ROOT_BRACED.finditer(text):
        prev = text[m.start() - 1] if m.start() > 0 else None
        nxt = text[m.end()] if m.end() < len(text) else None
        left_ok = (
            prev is None
            or prev not in _REWRITE_LEFT_BLOCKERS
            or (prev in _REWRITE_QUOTES and _rewrite_is_opening_quote(text, m.start()))
        )
        right_ok = nxt is None or nxt in _JS_WHITESPACE or nxt in _REWRITE_RIGHT_BOUNDARY
        if not (left_ok and right_ok):
            return True
    return False


def _command_word(before):
    """The program of the command an option at the end of `before` belongs to (its basename), skipping
    leading `NAME=value` assignments; "" when there is none."""
    segment = _COMMAND_SEPARATOR.split(before)[-1].split()
    words = [w for w in segment if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w)]
    return words[0].rsplit("/", 1)[-1] if words else ""


def _is_forwarded_plugin_root(text):
    code = _SHELL_COMMENT.sub(r"\1", text)
    for m in _PLUGIN_ROOT_OPTION.finditer(code):
        if not _LOCATION_OPTION_NAME.search(m.group(1)):
            continue
        before = code[: m.start()]
        # Inside an open quote the option is text (an `echo` of instructions, say), not an argument. The
        # count is naive, as is the host-loop rewrite's own.
        if before.count('"') % 2 or before.count("'") % 2:
            continue
        # The agent CLI loads the plugin from the path itself; it does not pass it on.
        if _command_word(before) == "claude":
            continue
        return True
    return False


def _finding_plugin_root_forwarded(path, line, ctx_label):
    return Finding(
        "WARN",
        "plugin-root-forwarded-from-vm-bash",
        f"`${{CLAUDE_PLUGIN_ROOT}}` passed whole as a location option's value in an in-VM bash context ({ctx_label}) "
        "likely breaks at host-loop — a host-side reader it is passed to (a sub-agent's Read, say) receives a VM "
        "path it refuses. At host-loop (Cowork's default) the bash tool rewrites the plugin's host path to its VM "
        "mount before the command runs, so the program receives, and passes on, a `/sessions/…` path.",
        "Do not route the plugin root through bash for a host-side reader: have the reader name "
        "`${CLAUDE_PLUGIN_ROOT}` in its own text, for example a plugin agent's definition, whose body is "
        "substituted with the plugin's host path when the agent loads. If the program opens the path itself, "
        f"the site works: suppress it with {_IGNORE_MARKER_EXAMPLE.replace('<rule>', 'plugin-root-forwarded-from-vm-bash')}.",
        path,
        line,
    )


def _findings_plugin_root(path, line, ctx_label, text, in_plugin=True):
    """The findings for a plugin-root token in an in-VM bash context, one per form written in `text`:
    - the braced `${CLAUDE_PLUGIN_ROOT}` is replaced at skill load with a path, a HOST path at host-loop, which
      the host-loop bash tool rewrites to the plugin's VM mount when it stands as its own word. Passed whole as
      a location option's value it is most likely forwarded, and a forwarded VM path breaks a host-side reader: WARN.
      Otherwise it most likely works: INFO, since whether the receiving program opens the value or forwards
      it is not visible in the skill text;
    - a form the agent does not replace (bare `$CLAUDE_PLUGIN_ROOT`, `${CLAUDE_PLUGIN_ROOT:-…}`) reads the
      environment variable, empty at host-loop: WARN."""
    findings = []
    if _PLUGIN_ROOT_BRACED.search(text) and not in_plugin:
        findings.append(
            Finding(
                "WARN",
                "plugin-root-in-vm-bash",
                f"`${{CLAUDE_PLUGIN_ROOT}}` in an in-VM bash context ({ctx_label}) in a skill outside a plugin (no "
                "plugin.json above it): nothing replaces the token in a standalone skill's text, so the VM shell "
                "reads the environment variable, which is empty at host-loop (Cowork's default); a path built from "
                "it points nowhere.",
                "Ship the skill inside a plugin, or resolve its files at run time (see the plugin-root guide), for "
                "example by finding this skill's SKILL.md under /sessions.",
                path,
                line,
            )
        )
    elif _PLUGIN_ROOT_BRACED.search(text):
        glued = _glued_plugin_root(text)
        if glued:
            findings.append(
                Finding(
                    "WARN",
                    "plugin-root-in-vm-bash",
                    f"`${{CLAUDE_PLUGIN_ROOT}}` glued to other text in an in-VM bash context ({ctx_label}): the path "
                    "the agent substitutes is not rewritten here. At host-loop (Cowork's default) the bash tool "
                    "rewrites the plugin's host path to its VM mount only when the path is a word of its own, so this "
                    "command gets the HOST path, which does not exist in the VM.",
                    "Keep the path its own word: follow it with `/`, whitespace, a quote or the end of the command, "
                    "and put nothing but whitespace, `=`, `:` or an opening quote right before it "
                    "(`${CLAUDE_PLUGIN_ROOT}-v2` and `x${CLAUDE_PLUGIN_ROOT}` are not rewritten).",
                    path,
                    line,
                )
            )
        if _is_forwarded_plugin_root(text):
            findings.append(_finding_plugin_root_forwarded(path, line, ctx_label))
        elif not glued:
            findings.append(
                Finding(
                    "INFO",
                    "plugin-root-braced-in-vm-bash",
                    f"`${{CLAUDE_PLUGIN_ROOT}}` in an in-VM bash context ({ctx_label}): in a plugin skill the agent "
                    "replaces it with a path when the skill loads; at host-loop (Cowork's default) that is a HOST "
                    "path, which the bash tool rewrites to the plugin's VM mount before the command runs, so a "
                    "shell step or VM-run program that opens it works when the path stands as its own word. A value "
                    "only forwarded through the shell to a host-side file tool arrives there as a VM path, which "
                    "host-loop file tools refuse; the linter flags that only for the whole root passed as an option "
                    "value, and cannot tell a positional forward from a path the program opens.",
                    "Keep the path its own word: follow it with `/`, whitespace, a quote or the end of the command "
                    "(`${CLAUDE_PLUGIN_ROOT}-x`, `${CLAUDE_PLUGIN_ROOT}:…` and `x${CLAUDE_PLUGIN_ROOT}` are not "
                    "rewritten). If the value only reaches a host-side file tool, do not pass it through bash: have "
                    "the reader name `${CLAUDE_PLUGIN_ROOT}` in its own text, for example a plugin agent's "
                    "definition. A site you have checked can be suppressed with "
                    f"{_IGNORE_MARKER_EXAMPLE.replace('<rule>', 'plugin-root-braced-in-vm-bash')}.",
                    path,
                    line,
                )
            )
    m = _PLUGIN_ROOT_UNREPLACED.search(text)
    # One `plugin-root-in-vm-bash` per line: a standalone or glued braced form already reported it.
    if any(f.rule == "plugin-root-in-vm-bash" for f in findings):
        return findings
    if m or not findings:
        written = m.group(0) if m else "$CLAUDE_PLUGIN_ROOT"
        findings.append(
            Finding(
                "WARN",
                "plugin-root-in-vm-bash",
                f"`{written}` in an in-VM bash context ({ctx_label}): the agent does not replace this "
                "form in a skill's text (only the exact braced `${CLAUDE_PLUGIN_ROOT}`), so the VM shell reads the "
                "environment variable, which is empty at host-loop (Cowork's default); a path built from it "
                "points nowhere.",
                "Use the braced `${CLAUDE_PLUGIN_ROOT}` as a word of its own, or resolve the plugin's VM mount at "
                "run time (see the plugin-root guide), for example from the script's own location or by finding "
                "this skill's SKILL.md under /sessions.",
                path,
                line,
            )
        )
    return findings


def _finding_plugin_root_guarded(path, line, ctx_label):
    return Finding(
        "INFO",
        "plugin-root-guarded",
        f"`${{CLAUDE_PLUGIN_ROOT}}` used in an in-VM bash context ({ctx_label}), but the same block "
        "self-heals it (a runtime `find` under /sessions), so the block works whether or not the braced path "
        "is rewritten.",
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
    # No plugin-root check here: a plugin hook is not an in-VM bash step. The agent substitutes the token
    # when it runs the hook and also sets the variable, so the hook gets a path valid where it runs (the
    # host at host-loop, the VM at VM-loop).
    if _HOOK_EXPORT.search(cmd):
        findings.append(_finding_hook_host_write(path, line_no, "`export`s an env var"))
    if _HOOK_TMP_REDIRECT.search(cmd) or _HOOK_TMP_TEE.search(cmd):
        findings.append(_finding_hook_host_write(path, line_no, "writes into /tmp"))


def _lint_hook_events(path):
    """Flag hook events a plugin DECLARES that this harness does not SERVE.

    Why this exists: the harness installs `PreToolUse` only, while real Cowork installs three event types
    and the agent binary accepts thirty-three. A plugin declaring `UserPromptSubmit` therefore mounted, ran,
    and produced no comment of any kind — the surface was discoverable only by grepping the harness's own
    compiled output, which is exactly what one consumer had to do.

    Severity is three-way and each level means something different. A name the agent's validator ACCEPTS
    but this harness does not serve is INFO, not a skill defect: the agent loads a plugin's hooks.json
    through its own `--plugin-dir` channel, which the harness neither serves nor blocks. Of those, only
    the events in LIVE_VERIFIED_HOOK_EVENTS have been observed firing here, so the confident wording is
    scoped to them and every other accepted name says so. A name the validator REJECTS is ERROR — that
    one genuinely never runs on any surface. Claiming "this will not fire" for an accepted event would
    assert more than is known; claiming nothing
    leaves the consumer to reverse-engineer it. So say precisely what is known.
    """
    findings = []
    try:
        raw = Path(path).read_text(encoding="utf-8")
        doc = json.loads(raw)
    except Exception:
        return findings  # unparseable hooks.json — the text linter still scans it line-wise
    # PLACEMENT. The agent binary reads a plugin's hooks from `hooks/hooks.json` — a `hooks.json` sitting
    # at the plugin ROOT is silently ignored and NOTHING fires. Live-verified: the identical file fired all
    # three declared events from `hooks/hooks.json` and fired nothing from the root. Silent, so it looks
    # exactly like "hooks don't work in Cowork" — which is how this probe nearly drew the wrong conclusion.
    p = Path(path)
    if p.name == "hooks.json" and p.parent.name != "hooks":
        findings.append(Finding(
            "WARN", "hooks-json-misplaced",
            f"`{path}` is not in a `hooks/` directory — the agent reads plugin hooks from "
            f"`<plugin>/hooks/hooks.json`, so a root-level `hooks.json` is silently ignored and none of "
            f"its hooks ever run. Live-verified at `container` and `hostloop`.",
            f"Move it to `{p.parent.name}/hooks/hooks.json`.",
            path, 1,
        ))
    if not isinstance(doc, dict):
        return findings
    # `{"hooks": {...}}` (settings.json shape) and a bare `{...}` event map are both seen in the wild.
    events = doc.get("hooks") if isinstance(doc.get("hooks"), dict) else doc
    if not isinstance(events, dict):
        return findings
    # Line number for the event key, so the finding points at something the reader can jump to.
    lines = raw.splitlines()
    for name in events:
        if not isinstance(name, str) or name in SERVED_HOOK_EVENTS:
            continue
        line_no = next((i for i, ln in enumerate(lines, 1) if f'"{name}"' in ln), 1)
        if name in KNOWN_HOOK_EVENTS:
            fires = (
                "fires here — a plugin's own `hooks/hooks.json` is loaded and executed by the agent "
                "binary (live-verified at both `container` and `hostloop`)"
                if name in LIVE_VERIFIED_HOOK_EVENTS
                else "is a hook event the agent accepts, and it loads a plugin's own `hooks/hooks.json` "
                     "itself — though whether a harness run ever reaches this event's trigger has not "
                     "been verified here"
            )
            findings.append(Finding(
                "INFO", "hook-event-not-served",
                f"`{name}` {fires} — but cowork-harness "
                f"itself installs only {', '.join(sorted(SERVED_HOOK_EVENTS))} on `initialize`. "
                f"`hook_event_fired: {name}` / `hook_event_blocked: {name}` (and `hook_output_*` for what it "
                f"printed) grade it from the agent's own "
                f"hook_response frames (the harness passes --include-hook-events because this plugin declares "
                f"hooks); but if real Cowork installs a `{name}` hook of its own, the harness does not reproduce "
                f"it, so anything driven by that is absent here. (Cowork installs hooks of its own for "
                f"PreToolUse, PostToolUse and UserPromptSubmit only.)",
                "The harness does not block your hook — this is about what is reproduced, not breakage. Assert "
                "the hook with those keys, and its OBSERVABLE result as well (a file it writes, a tool it blocks) "
                "for anything Cowork's own hooks would have driven.",
                path, line_no,
            ))
        elif name.lower() in {e.lower() for e in KNOWN_HOOK_EVENTS}:
            correct = next(e for e in KNOWN_HOOK_EVENTS if e.lower() == name.lower())
            findings.append(Finding(
                "ERROR", "hook-event-unknown",
                f"`{name}` is a hook event name with the wrong capitalization — matching is case-sensitive, "
                f"so this hook never runs.",
                f"Use `{correct}`.",
                path, line_no,
            ))
        else:
            findings.append(Finding(
                "ERROR", "hook-event-unknown",
                f"`{name}` is not a hook event the agent recognizes — an unrecognized event name is "
                f"ignored, so this hook would never run on any surface.",
                f"Check spelling and capitalization. Valid events: {', '.join(sorted(KNOWN_HOOK_EVENTS))}.",
                path, line_no,
            ))
    return findings


def _lint_skill_text(path, raw_lines, force_json=False):
    """Scan one file. `force_json=True` treats every line as a hooks-config JSON body
    (used for standalone hooks.json files); otherwise fences drive the context."""
    findings = []
    in_fence = False
    fence_char = ""
    fence_len = 0
    fence_lang = ""
    # Per-bash-fence buffer (Item 4): plugin-root token hit line numbers + the whole block's text, so a
    # ${CLAUDE_PLUGIN_ROOT} use that is self-healed elsewhere IN THE SAME BLOCK is reported as the INFO
    # `plugin-root-guarded` instead of its per-form finding.
    # Emission is deferred to fence close (or EOF) but original 1-based line numbers are preserved.
    bash_token_lines = []
    bash_block_text = []

    # Self-heal find-pattern guard: identity of the skill/plugin under lint, used to check a self-heal `find -path`
    # actually names THIS skill or its enclosing plugin (not a copy-pasted mismatch). Only
    # meaningful when linting an actual SKILL.md (force_json=False is exactly that case here — a
    # hooks.json body never enters the "bash" ctx below, so this is otherwise unused).
    skill_name = None
    plugin_name = None
    in_plugin = False
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
        in_plugin = plugin_dir is not None
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
            for ln, text in bash_token_lines:
                # A forwarded value breaks a host-side reader whether or not the block self-heals: a heal
                # repairs a path the shell opens, not one it passes on.
                if in_plugin and _PLUGIN_ROOT_BRACED.search(text) and _is_forwarded_plugin_root(text):
                    findings.extend(_findings_plugin_root(path, ln, "```bash block", text, in_plugin))
                elif not healed:
                    findings.extend(_findings_plugin_root(path, ln, "```bash block", text, in_plugin))
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
            # A fully commented-out line runs nothing, so it gets no finding.
            if _PLUGIN_ROOT_TOKEN.search(line) and not line.lstrip().startswith("#"):
                bash_token_lines.append((i, line))
        elif ctx == "json":
            for cm in _HOOK_CMD.finditer(line):
                _check_hook_command(path, i, cm.group(1), findings)
        elif ctx == "prose":
            # Only a Bash(...) tool directive counts as in-VM bash here — plain prose and
            # Read/Grep directives are intentionally left alone.
            for bm in _BASH_DIRECTIVE.finditer(line):
                if _PLUGIN_ROOT_TOKEN.search(bm.group(1)):
                    findings.extend(_findings_plugin_root(path, i, "Bash() directive", bm.group(1), in_plugin))
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


def _enumerate_plugin_agents(plugin_dir):
    """Every agent markdown under `<plugin_dir>/agents/`, RECURSIVELY, as (declared_name, Path) pairs.

    Recursive on purpose. Claude Code discovers `agents/sub/x.md` (see src/run/analyze-skill.ts:981-983)
    and skill-hash.ts's `agentSkillName` already attributes both the flat and nested shapes, so a nested
    agent is dispatchable, hash-attributed and analyze-scanned. The old non-recursive `glob("*.md")` made
    it invisible to BOTH this linter's subagent_type resolution and the critique corpus.

    This CAN change a severity in both directions, verified, not assumed:
      - a literal naming a nested agent stops being a `subagent-type-not-found-in-plugin` WARN (it really
        is dispatchable, so that WARN was a false positive); and
      - for a plugin whose `agents/` holds ONLY subdirectories, the agent set was previously EMPTY, which
        sent every same-plugin literal down the `plugin_agent_types` falsy branch in
        `_classify_subagent_type` to `subagent-type-unknown` (INFO). The set is now non-empty, so a
        genuinely typo'd literal is reported as the WARN it always was -- a true positive that used to be
        suppressed, but a NEW `--strict` failure on an unchanged tree."""
    agents_dir = Path(plugin_dir) / "agents"
    if not agents_dir.is_dir():
        return []
    yaml = _require_yaml()
    out = []
    for md in sorted(agents_dir.rglob("*.md")):
        if not md.is_file():
            continue
        out.append((_agent_name_from_frontmatter(md, yaml) or md.stem, md))
    return out


def _resolve_plugin_agents(plugin_dir):
    """Resolve in-plugin agent types: return the set of valid `<plugin>:<agent>` subagent types defined WITHIN plugin_dir.
    Reads the plugin name from plugin.json and each agents/**.md's `name:` frontmatter (filename stem
    fallback). Returns an empty set (never crashes) when no plugin.json is found — a bare SKILL.md
    dir with no plugin manifest has nothing to resolve against."""
    plugin_name = _read_plugin_name(plugin_dir)
    if not plugin_name:
        return set()
    return {f"{plugin_name}:{name}" for name, _ in _enumerate_plugin_agents(plugin_dir)}


def _literal_to_agent_name(value, plugin_name):
    """Map a pinned `subagent_type` literal to a declared agent name WITHIN this plugin, or None.

    A colon-bearing literal is namespaced (`<plugin>:<agent>`) and its prefix MUST equal this plugin's
    name, or a cross-plugin `other:market-sizing` would match THIS plugin's `market-sizing`. A bare
    literal matches a declared name directly. MIRRORED in src/critique/resolve-agents.ts; the two are
    pinned by test/fixtures/dispatchable-agents.json, which both sides execute."""
    if ":" not in value:
        return value or None
    if not plugin_name:
        return None
    prefix, _, suffix = value.partition(":")
    return suffix if prefix == plugin_name and suffix else None


def _resolve_corpus_agents(skill_dir):
    """Every agent file the critique packager will put in THIS skill's evidence corpus, as a sorted list
    of Paths. Mirrors `resolveDispatchableAgents` in src/critique/resolve-agents.ts -- union of:
      1. `agents/<skillname>.md` by FILENAME (what the packager did through 3.6.0),
      2. every in-plugin agent a pinned `subagent_type` literal in SKILL.md / references/** resolves to,
      3. every agent whose DECLARED name equals the skill name,
    then a transitive closure over the resolved agent bodies (an agent that dispatches another agent).

    The union is the SAFETY property: this can never resolve to less than the single agents/<skill>.md
    the old sizing counted, so a skill's reported corpus never shrinks under this change."""
    skill_dir = Path(skill_dir)
    # Walk UP for the manifest, exactly as the TypeScript side does (`findEnclosingPluginDir`). The
    # old `parent.name == "skills"` LAYOUT rule disagreed with the packager outside the
    # `<root>/skills/<name>` shape: a skill at `<root>/foo/SKILL.md` with a manifest at `<root>` made the
    # packager size a corpus this sized as ZERO, which is the packager-vs-linter divergence 0003e38
    # closed in one shape and left open in another.
    # Nearest MANIFEST first (matching the TypeScript `findEnclosingPluginDir`), falling back to the
    # `<root>/skills/<name>` LAYOUT. Manifest-only diverged from the packager for a manifest-less plugin,
    # where the TS side still enumerates agents because it is handed the root explicitly; layout-only
    # diverged for a skill that is not under `skills/` but does have a manifest above it, which the
    # packager sizes and this sized as ZERO. Neither rule alone matches; the union does.
    plugin_dir = _find_enclosing_plugin_dir(skill_dir / "SKILL.md") or (
        skill_dir.parent.parent if skill_dir.parent.name == "skills" else None
    )
    if plugin_dir is None or not (plugin_dir / "agents").is_dir():
        return []
    all_agents = _enumerate_plugin_agents(plugin_dir)
    if not all_agents:
        return []
    plugin_name = _read_plugin_name(plugin_dir)
    skill_name = skill_dir.name
    picked = {}
    sources = []  # declared before `add`: every picked agent is itself a dispatch SOURCE

    def add(path):
        """Record an agent AND queue its body as a dispatch source.

        Clauses 1 and 3 used to record without queueing, so a skill's own primary agent -- the most
        likely dispatcher of a second agent -- was never scanned and the transitive closure did not run
        for the dominant real shape. `scanned` below still guarantees termination."""
        if str(path) in picked:
            return
        picked[str(path)] = path
        sources.append(path)

    for name, md in all_agents:
        # clause 1 (filename) and clause 3 (declared name)
        if md == plugin_dir / "agents" / f"{skill_name}.md" or name == skill_name:
            add(md)

    skill_md = skill_dir / "SKILL.md"
    if skill_md.is_file():
        sources.append(skill_md)
    refs = skill_dir / "references"
    if refs.is_dir():
        sources.extend(p for p in sorted(refs.rglob("*")) if p.is_file())
    scanned = set()
    while sources:
        src = sources.pop(0)
        if str(src) in scanned:
            continue
        scanned.add(str(src))
        try:
            text = src.read_text(encoding="utf-8")
        except Exception:
            continue
        for m in _SUBAGENT_TYPE_RE.finditer(text):
            agent_name = _literal_to_agent_name(m.group(1), plugin_name)
            if not agent_name:
                continue
            for name, md in all_agents:
                if name == agent_name:
                    add(md)  # queues the body too -- transitive: this agent may dispatch another
    return [picked[k] for k in sorted(picked)]


# --------------------------------------------------------------------------- #
# plugin-root references/ resolution, for corpus sizing only
#
# Mirrors `resolveRootReferences` in src/critique/resolve-references.ts (clauses 1 + 2 only -- see the
# docstring on `_resolve_corpus_root_references` below for why clause 3 cannot be mirrored here). The TS
# packager now puts a multi-skill plugin's SHARED plugin-root `references/` files into the evaluator
# corpus when the graded skill's own text (or a sub-agent it can dispatch) points at them, so
# `_lint_skill_corpus_size` must size the same files or the ceiling warning under-reports exactly the
# plugins this feature targets.
# --------------------------------------------------------------------------- #

# Trailing punctuation a prose or markdown token picks up, stripped as a RUN and WITHOUT requiring
# balance -- byte-identical rule to TRAILING_PUNCT in resolve-references.ts.
_TRAILING_PUNCT_RE = re.compile(r"""[)\]}>.,;:!?'"]+$""")
_LEADING_QUOTE_RE = re.compile(r"""^["'<([]+""")
_HASH_QUERY_RE = re.compile(r"[#?].*$")
_BACKTICK_SPAN_RE = re.compile(r"`([^`]+)`")
_MD_LINK_TARGET_RE = re.compile(r"\]\(([^)\s]+)")
_HREF_TARGET_RE = re.compile(r"""href=["']([^"']+)["']""")


def _line_tokens(line):
    """Candidate tokens on one line: backticked spans, markdown/href link targets, and bare whitespace-
    delimited runs. Only those containing `/` are resolved as paths (`pathish`); the bare ones matter only
    for the ARMED basename pass. Mirrors `lineTokens()` in resolve-references.ts."""
    pathish = []
    bare = []
    raw = (
        _BACKTICK_SPAN_RE.findall(line)
        + _MD_LINK_TARGET_RE.findall(line)
        + _HREF_TARGET_RE.findall(line)
        + line.split()
    )
    for t0 in raw:
        t = _HASH_QUERY_RE.sub("", t0)
        t = _LEADING_QUOTE_RE.sub("", t)
        t = _TRAILING_PUNCT_RE.sub("", t)
        t = t.replace("\\", "/")
        if not t:
            continue
        if "/" in t:
            pathish.append(t)
        else:
            bare.append(t)
    return pathish, bare


def _token_to_abs(token, plugin_root, plugin_name, file_dir):
    """Resolve one path-ish token to an absolute (not yet realpath'd) host path. `${CLAUDE_PLUGIN_ROOT}`
    and a leading `<pluginName>/` both mean the plugin root; everything else is relative to the
    directory of the file the token was found in. Mirrors `tokenToAbs()`."""
    if "${CLAUDE_PLUGIN_ROOT}" in token:
        return os.path.normpath(token.replace("${CLAUDE_PLUGIN_ROOT}", plugin_root))
    if plugin_name and token.startswith(plugin_name + "/"):
        return os.path.normpath(os.path.join(plugin_root, token[len(plugin_name) + 1 :]))
    if os.path.isabs(token):
        return os.path.normpath(token)
    return os.path.normpath(os.path.join(file_dir, token))


def _realpath_strict(path):
    """Mirrors node's `realpathSync`: resolves symlinks and raises if any path component doesn't exist
    (unlike `os.path.realpath`, which resolves lexically even against a nonexistent path)."""
    return str(Path(path).resolve(strict=True))


def _links_in(text, file_dir, plugin_root, plugin_name, by_basename):
    """Every plugin-root reference `text` (from a file at `file_dir`) points at, mapped to the 1-based
    line it was pointed at from. Mirrors `linksIn()` -- including the ARMING rule: a token resolving to
    the plugin-root `references/` DIRECTORY ITSELF arms bare-basename matching for THAT LINE ONLY; it
    never recurses and never carries to the next line."""
    try:
        refs_dir = _realpath_strict(os.path.join(plugin_root, "references"))
    except OSError:
        return {}
    hits = {}
    for i, line in enumerate(text.splitlines()):
        pathish, bare = _line_tokens(line)
        armed = False
        for t in pathish:
            abs_path = _token_to_abs(t, plugin_root, plugin_name, file_dir)
            try:
                rp = _realpath_strict(abs_path)
            except OSError:
                continue  # most prose tokens are not paths at all
            if rp == refs_dir:
                armed = True
                continue
            if rp.startswith(refs_dir + os.sep):
                rel = "references/" + rp[len(refs_dir) + 1 :].replace(os.sep, "/")
                if rel not in hits:
                    hits[rel] = i + 1
        if not armed:
            continue
        for b in bare:
            rel = by_basename.get(b)
            if rel is not None and rel not in hits:
                hits[rel] = i + 1
    return hits


def _is_clean_utf8(path):
    """Valid UTF-8, decided by the decoder rather than by scanning the decoded string -- mirrors
    `isCleanUtf8()` (a `TextDecoder("utf-8", { fatal: true })` decode). `bytes.decode("utf-8")` is
    strict by default, so a decode failure (not a scan of the result) is what disqualifies a file."""
    try:
        path.read_bytes().decode("utf-8")
        return True
    except (OSError, UnicodeDecodeError):
        return False


def _resolve_root_references(skill_dir, plugin_dir, agents):
    """Low-level worker, taking an explicit `plugin_dir` so the same-directory guard below is directly
    unit-testable regardless of how a caller derives `plugin_dir`. Mirrors `resolveRootReferences()`,
    clauses 1 + 2 only:
      1. the skill's own authored text (SKILL.md + its own `references/**`), and
      2. every sub-agent body already in the corpus (`agents`, from `_resolve_corpus_agents`).

    Clause 3 in the TS packager (files the graded AGENT actually read during a live run) is
    run-dependent -- it needs a recorded turn's access log -- and CANNOT be mirrored by a static lint
    pass with no run to inspect, so it is deliberately NOT reproduced here. This makes this function's
    count a floor, never an exact match, relative to what a real critique run would package; that is the
    same "warn early, the packager's report is the authority" posture the rest of this linter already
    has for the ceiling.

    Two further known, deliberate divergences (not fixed here -- out of scope for this change):
      - byte counting: the packager measures UTF-8-DECODED string length while `_lint_skill_corpus_size`
        (like its pre-existing SKILL.md/references/agents counting) sums `stat().st_size` -- raw bytes
        on disk. These agree for pure single-byte UTF-8 text and diverge slightly otherwise.
      - cleanliness filtering: this module's existing `references/` walks (`rglob("*")`, used here and
        for the skill's own references/** in `_lint_skill_corpus_size`) have no git-tracked-set or
        symlink-containment filter, unlike `listSkillFilesRecursive` in corpus-walk.ts. This function
        reuses that same untared posture for consistency with the rest of this linter, not because it is
        provably safe against a hostile references/ tree."""
    skill_dir = Path(skill_dir)
    plugin_dir = Path(plugin_dir)
    # SKIP (not "dedupe") the standalone-skill shape: those files are already packaged as skill-local,
    # and running this pass too would double-count them under two different display keys.
    try:
        same = skill_dir.resolve(strict=True) == plugin_dir.resolve(strict=True)
    except OSError:
        same = skill_dir.resolve() == plugin_dir.resolve()
    if same:
        return []
    refs_root = plugin_dir / "references"
    if not refs_root.is_dir():
        return []
    all_files = sorted(p for p in refs_root.rglob("*") if p.is_file())
    if not all_files:
        return []
    plugin_name = _read_plugin_name(plugin_dir) or plugin_dir.name
    # Later (sorted) entries win on a real basename collision -- matches the TS `Map` construction,
    # where each duplicate key overwrites the previous.
    by_basename = {}
    for p in all_files:
        rel = "references/" + p.relative_to(refs_root).as_posix()
        by_basename[p.name] = rel

    linked = set()
    sources = [skill_dir / "SKILL.md"]
    local_refs = skill_dir / "references"
    if local_refs.is_dir():
        sources.extend(p for p in sorted(local_refs.rglob("*")) if p.is_file())
    sources.extend(Path(a) for a in agents)
    for src in sources:
        try:
            text = src.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for rel in _links_in(text, str(src.parent), str(plugin_dir), plugin_name, by_basename):
            linked.add(rel)

    packaged = []
    for p in all_files:
        rel = "references/" + p.relative_to(refs_root).as_posix()
        if rel not in linked:
            continue
        if not _is_clean_utf8(p):
            continue
        packaged.append(p)
    return packaged


def _resolve_corpus_root_references(skill_dir, agents):
    """Every plugin-root `references/` file the critique packager will put in THIS skill's evidence
    corpus, as a sorted list of Paths. Derives `plugin_dir` the same way `_resolve_corpus_agents` does
    (the `skills/<name>` multi-skill-plugin shape); a standalone skill (no `skills/` parent) has no
    plugin-root references pass and is unaffected."""
    skill_dir = Path(skill_dir)
    # Walk UP for the manifest, exactly as the TypeScript side does (`findEnclosingPluginDir`). The
    # old `parent.name == "skills"` LAYOUT rule disagreed with the packager outside the
    # `<root>/skills/<name>` shape: a skill at `<root>/foo/SKILL.md` with a manifest at `<root>` made the
    # packager size a corpus this sized as ZERO, which is the packager-vs-linter divergence 0003e38
    # closed in one shape and left open in another.
    # Nearest MANIFEST first (matching the TypeScript `findEnclosingPluginDir`), falling back to the
    # `<root>/skills/<name>` LAYOUT. Manifest-only diverged from the packager for a manifest-less plugin,
    # where the TS side still enumerates agents because it is handed the root explicitly; layout-only
    # diverged for a skill that is not under `skills/` but does have a manifest above it, which the
    # packager sizes and this sized as ZERO. Neither rule alone matches; the union does.
    plugin_dir = _find_enclosing_plugin_dir(skill_dir / "SKILL.md") or (
        skill_dir.parent.parent if skill_dir.parent.name == "skills" else None
    )
    if plugin_dir is None:
        return []
    return _resolve_root_references(skill_dir, plugin_dir, agents)


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
    provable typo, not an unconfirmable unknown. Provable means it can be a hard gate: WARN (not
    INFO), so `lint-skill --strict` fails on it."""
    return Finding(
        "WARN",
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
    clean. Only ONE outcome is a hard gate: `subagent-type-not-found-in-plugin` is WARN (a provable
    typo, so `lint-skill --strict` fails on it); the two unconfirmable outcomes
    (`subagent-type-unresolvable`, `subagent-type-unknown`) stay INFO — see the HONEST LIMIT note
    above this section for why those two can never be proven.

    Precedence:
      1. Resolves in-plugin, or is `general-purpose` -> clean (None).
      2. Has a `<prefix>:<agent>` shape whose prefix EQUALS the resolved plugin's own name AND the
         plugin's agent set was non-empty (i.e. enumerable) -> `subagent-type-not-found-in-plugin`
         (WARN — provable typo, gates under `--strict`). A value namespaced under this plugin's own
         name can never be another binary's built-in, so once the plugin is fully enumerated a miss
         here is a provable typo, not an unconfirmable unknown.
      3. Has a `<prefix>:<agent>` shape whose prefix does NOT equal the resolved plugin's name (or
         there's no resolved plugin at all) -> `subagent-type-unresolvable` (INFO — belongs to another
         plugin, or an empty plugin_name means we truly can't tell whose namespace it is).
      4. Otherwise (no colon, or same-plugin prefix but the plugin set was empty/unenumerable) ->
         `subagent-type-unknown` (INFO) — genuinely can't confirm statically.
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


# Mirrors SKILL_CORPUS_CEILING in the packager (src/critique/package-evidence.ts). A cross-language
# test pins the two together, so change both or the test fails.
_EVIDENCE_CORPUS_CEILING = 512 * 1024
# Warn well before the valve: a corpus this close is one reference file away from being cut mid-grade.
_EVIDENCE_CORPUS_NOTICE_RATIO = 0.8


def _lint_skill_corpus_size(md_path):
    """Total skill-authored bytes against the critique evidence ceiling.

    Counts the SAME FOUR CLASSES the ceiling governs: SKILL.md, every file under references/ (any
    extension -- the packager applies no extension filter, so JSON schemas and rule packs count), for a
    skill inside a multi-skill plugin every <root>/agents/**.md the skill can dispatch, and -- also for a
    multi-skill plugin -- every <root>/references/** file the skill's authored text (or a dispatchable
    agent) links (see `_resolve_corpus_root_references`; the run-dependent fourth TS clause, files the
    agent actually read live, is out of scope for a static lint).

    Omitting the agents md is not a rounding error: a plugin whose SKILL.md + references sit in the INFO
    band while the agents md carries the corpus past the ceiling reported INFO and PASSED --strict on
    content the packager would cut. A proximity check that greens a corpus destined to be cut is worse
    than no check.

    It diverges from what a critique actually packages on four axes, two each way. OVER-counts: an untracked reference that staging would never deliver (the
    packager applies staging's git-tracked filter; this walk does not), and a symlink pointing outside
    the plugin, which the packager's containment rule refuses to follow. UNDER-counts: a plugin-root
    reference the graded agent only reaches by reading it during the run (added to the corpus at
    critique time -- invisible to any static count), and any byte that fails strict UTF-8 decoding, which
    the packager replaces with a 3-byte U+FFFD that st_size never sees (clean multibyte text round-trips
    byte-exact, so this axis is zero on ordinary markdown). `cowork-harness critique
    <folder> --corpus-only` runs the packager's own packageEvidence call over an empty run and prints the
    six corpus fields directly: the packager's own git filter, containment rule and byte measurement,
    and a stated FLOOR for the run-time-read clause (a read can only add to it)."""
    skill_dir = Path(md_path).parent
    total = 0
    files = [Path(md_path)]
    refs = skill_dir / "references"
    if refs.is_dir():
        files.extend(p for p in sorted(refs.rglob("*")) if p.is_file())
    # Multi-skill plugin layout: skillDir is <root>/skills/<name> and the skill's dispatchable sub-agent
    # prompts live under <root>/agents/ -- the same resolution the critique command performs, via the
    # shared `_resolve_corpus_agents`. This counted exactly ONE file (agents/<name>.md) while the packager
    # shipped N, which under-reported the ceiling for precisely the multi-agent plugins that need the
    # warning most. A standalone skill (no `skills/` parent) has no agents and is unaffected.
    agents = _resolve_corpus_agents(skill_dir)
    files.extend(agents)
    # The packager also puts a multi-skill plugin's SHARED plugin-root `references/` files into the
    # evidence corpus when the graded skill's own text (or a dispatchable agent) points at them -- see
    # `_resolve_corpus_root_references`. Omitting this would under-report the ceiling for exactly the
    # plugins that feature targets, the same failure mode the agents fix above was written to close.
    files.extend(_resolve_corpus_root_references(skill_dir, agents))
    for p in files:
        try:
            total += p.stat().st_size
        except OSError:
            continue  # unreadable file: same posture as the packager's per-file degrade
    pct = total * 100.0 / _EVIDENCE_CORPUS_CEILING
    if total > _EVIDENCE_CORPUS_CEILING:
        return [
            Finding(
                "WARN",
                "skill-corpus-over-evidence-ceiling",
                f"skill content is {total:,} B ({pct:.0f}% of the {_EVIDENCE_CORPUS_CEILING:,} B critique "
                f"evidence ceiling) — a critique will cut it before grading.",
                "Split or trim the largest references/ files. This counts SKILL.md + references/** + "
                "agents/** (every agent the skill can dispatch) + linked plugin-root references/** "
                "(the shared files the skill's own text or a dispatchable agent points at), the same "
                "classes the ceiling governs; it does not apply staging's git-tracked filter, so an "
                "untracked reference inflates it. The critique report's corpusCuts names exactly which "
                "files lose bytes.",
                str(skill_dir),
            )
        ]
    if total >= _EVIDENCE_CORPUS_CEILING * _EVIDENCE_CORPUS_NOTICE_RATIO:
        return [
            Finding(
                "INFO",
                "skill-corpus-near-evidence-ceiling",
                f"skill content is {total:,} B ({pct:.0f}% of the {_EVIDENCE_CORPUS_CEILING:,} B critique "
                f"evidence ceiling).",
                "No action needed yet; adding a large reference file would push a critique into cutting content.",
                str(skill_dir),
            )
        ]
    return []


# Skill size caps. SINGLE SOURCE: nothing in the TypeScript side consumes these, so there is deliberately
# no mirror to keep in sync (a mirror plus a sync test would be satisfiable by copy-paste). The numbers come
# from reading the agent binary, not from an observed truncation; the stamp below names the build, and
# `npm run check:claims` reports its age against the pinned agent.
#
#   * After a context compaction the agent re-attaches each invoked skill capped at 5,000 tokens, cutting
#     the content to 5000*4 - len(sentinel) characters of the JS string (about 19,900) and appending a
#     "[... skill content truncated for compaction; use Read on the skill path ...]" sentinel. All re-attached
#     skills together are capped at 25,000 tokens, and a skill over that combined cap is dropped.
#   * The Read tool is capped at 25,000 tokens. A whole-file Read past it returns only a partial view with a
#     paging notice ("showing lines 1-N of M total (T tokens, cap 25000). Call Read with offset=…"), so the
#     agent must page; only an offset/limit read that is itself over the cap throws. Above ~6,250 ESTIMATED
#     tokens the gate asks the API's count_tokens for the REAL count, so the cap is in real tokens, not in
#     chars/4. Measured 2026-09-28 with count_tokens (model claude-sonnet-5) on this skill's own references:
#     scenario-schema.md 88,487 B = 33,130 tokens, ci-recipe.md 36,216 B = 13,656, run-record-replay.md
#     28,649 B = 10,603, gotchas.md 24,756 B = 9,226 — about 2.65-2.70 B per token for this markdown, so
#     25,000 tokens is about 66,000 B. The WARN sits at 60,000 B (2.4 B per token), a margin for denser text.
#
# Body cap only: the re-attach estimate counts UTF-16 units and the rule counts UTF-8 BYTES, which are never
# fewer, so it errs early. The reference cap has no such guarantee — it rests on the measured ratio above.
_SKILL_SIZE_CAPS_VERIFIED = "binary-verified against agent 2.1.284 (VM ELF and native, both read)"
_SKILL_BODY_REATTACH_CAP = 19_000
_SKILL_BODY_NOTICE_RATIO = 0.8
_SKILL_REFERENCE_READ_CAP = 60_000


def _skill_body_bytes(text):
    """UTF-8 size of a SKILL.md with its YAML frontmatter stripped. The frontmatter (name + description) is
    billed to the skill LISTING, not to the body the agent re-attaches after a compaction."""
    body = text
    if text.startswith("---\n") or text.startswith("---\r\n"):
        lines = text.splitlines(keepends=True)
        for i in range(1, len(lines)):
            if lines[i].rstrip("\r\n") == "---":
                body = "".join(lines[i + 1:])
                break
    return len(body.encode("utf-8"))


def _lint_skill_sizes(md_path):
    """The SKILL.md body against the post-compaction re-attach cap, and each references/**.md file against
    the Read tool's cap. See the constants above for where both numbers come from."""
    findings = []
    md = Path(md_path)
    try:
        body = _skill_body_bytes(md.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        body = None
    if body is not None:
        cap = _SKILL_BODY_REATTACH_CAP
        if body > cap:
            findings.append(
                Finding(
                    "WARN",
                    "skill-body-over-reattach-cap",
                    f"SKILL.md body is {body:,} B, over the {cap:,} B cap — after a context compaction the agent "
                    "re-attaches only the first ~19,900 characters of an invoked skill; move detail to references/.",
                    "Keep SKILL.md to routing, the invariants whose absence causes a false green, and short "
                    "workflows; link the detail from references/*.md, which the agent reads on demand. The "
                    f"frontmatter is not counted. Cap {_SKILL_SIZE_CAPS_VERIFIED}.",
                    str(md),
                )
            )
        elif body >= cap * _SKILL_BODY_NOTICE_RATIO:
            findings.append(
                Finding(
                    "INFO",
                    "skill-body-near-reattach-cap",
                    f"SKILL.md body is {body:,} B ({body * 100.0 / cap:.0f}% of the {cap:,} B re-attach cap).",
                    "No action needed yet; growing the body past the cap means a compaction cuts its tail.",
                    str(md),
                )
            )
    refs = md.parent / "references"
    if refs.is_dir():
        for p in sorted(refs.rglob("*.md")):
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if p.is_file() and size > _SKILL_REFERENCE_READ_CAP:
                findings.append(
                    Finding(
                        "WARN",
                        "skill-reference-over-read-cap",
                        f"{p.name} is {size:,} B, over the {_SKILL_REFERENCE_READ_CAP:,} B cap — a whole-file Read past "
                        "25,000 real tokens returns only a partial view with a paging notice; the agent must page.",
                        f"Split the file by topic and link the parts from SKILL.md. Cap {_SKILL_SIZE_CAPS_VERIFIED}.",
                        str(p),
                    )
                )
    return findings


# --------------------------------------------------------------------------- #
# lint-skill rule registry + per-rule suppression
# --------------------------------------------------------------------------- #
#
# id -> (highest severity it is emitted at, suppressible). Only a judgement-call rule is suppressible: a
# heuristic whose true and false positives look the same in the skill text, or a size cap the author may
# accept. A PROVABLE rule is not: an ERROR (nothing was linted, or the hook never runs), a hooks.json the
# agent never reads, a pinned `<this-plugin>:<agent>` missing from the plugin's own agents. Nor are the
# suppression diagnostics themselves. A test checks this table against every `Finding(...)` literal.
LINT_SKILL_RULES = {
    "no-skill": ("ERROR", False),
    "hook-event-unknown": ("ERROR", False),
    "hooks-json-misplaced": ("WARN", False),
    "subagent-type-not-found-in-plugin": ("WARN", False),
    "hook-event-not-served": ("INFO", True),
    "hook-host-side-write": ("WARN", True),
    "plugin-root-in-vm-bash": ("WARN", True),
    "plugin-root-braced-in-vm-bash": ("INFO", True),
    "plugin-root-forwarded-from-vm-bash": ("WARN", True),
    "plugin-root-guarded": ("INFO", True),
    "guard-pattern-mismatch": ("WARN", True),
    "subagent-type-unresolvable": ("INFO", True),
    "subagent-type-unknown": ("INFO", True),
    "skill-corpus-over-evidence-ceiling": ("WARN", True),
    "skill-corpus-near-evidence-ceiling": ("INFO", True),
    "skill-body-over-reattach-cap": ("WARN", True),
    "skill-body-near-reattach-cap": ("INFO", True),
    "skill-reference-over-read-cap": ("WARN", True),
    "lint-skill-ignore-invalid": ("WARN", False),
    "lint-skill-ignore-unclosed": ("WARN", False),
    "lint-skill-ignore-unused": ("INFO", False),  # INFO; WARN only under --strict-ignores
}

# Suppressible rules whose findings never carry a line (the size caps). A suppressions-file entry with `match`
# can never match them, so naming one with `match` is a usage error rather than an entry that silently matches
# nothing. A test checks every emission of these rules has no line.
LINELESS_SKILL_RULES = frozenset({
    "skill-body-over-reattach-cap",
    "skill-body-near-reattach-cap",
    "skill-reference-over-read-cap",
    "skill-corpus-over-evidence-ceiling",
    "skill-corpus-near-evidence-ceiling",
})


def _suppressible_rules():
    return sorted(k for k, (_, ok) in LINT_SKILL_RULES.items() if ok)


def _why_not_suppressible(rule):
    """None when `rule` is a known, suppressible lint-skill rule; else the reason it cannot be suppressed."""
    if rule not in LINT_SKILL_RULES:
        return f"unknown lint-skill rule: {rule}; suppressible rules: {', '.join(_suppressible_rules())}"
    if not LINT_SKILL_RULES[rule][1]:
        return (
            f"`{rule}` cannot be suppressed: it reports a provable fact (or is a suppression diagnostic), not a "
            "judgement call — fix the skill instead"
        )
    return None


def _ignore_rule_spec(value):
    """argparse `type=` for `--ignore-rule <id>[=<glob>]`: a typo or a provable rule is a usage error (exit 2),
    never a suppression that silently matches nothing."""
    rule, sep, glob = value.partition("=")
    rule = rule.strip()
    why = _why_not_suppressible(rule)
    if why:
        raise argparse.ArgumentTypeError(why)
    if sep and not glob.strip():
        raise argparse.ArgumentTypeError(f"empty glob in `{value}` — use `{rule}` alone to apply it to every file")
    return {"raw": value, "rule": rule, "glob": glob.strip() if sep else None, "used": False}


_SUPPRESSIONS_TOP_KEYS = {"version", "suppressions"}
_SUPPRESSIONS_ENTRY_KEYS = {"rule", "file", "match", "reason"}


def _suppressions_file(value):
    """argparse `type=` for `--suppressions <file>`: load and validate a reviewed-suppressions file. Any problem
    (unreadable, malformed JSON, a wrong `version`, an unknown key, an unknown or provable rule, a missing
    `reason`, a `match` on a rule whose findings carry no line) is a usage error (exit 2) naming the file and the
    entry index, never an entry that silently matches nothing."""

    def bad(msg):
        raise argparse.ArgumentTypeError(f"--suppressions {value}: {msg}")

    try:
        doc = json.loads(Path(value).read_text(encoding="utf-8-sig"))
    except OSError as e:
        bad(f"cannot read the file ({e.strerror or e})")
    except RecursionError:
        bad("not valid JSON (nested too deeply)")
    except (UnicodeDecodeError, ValueError) as e:
        bad(f"not valid JSON ({e})")
    if not isinstance(doc, dict):
        bad('the top level must be an object: {"version": 1, "suppressions": [...]}')
    extra = sorted(set(doc) - _SUPPRESSIONS_TOP_KEYS)
    if extra:
        bad(f"unknown top-level key(s): {', '.join(extra)}; allowed: version, suppressions")
    if not (type(doc.get("version")) is int and doc.get("version") == 1):
        bad(f"`version` must be 1 (got {json.dumps(doc.get('version'))})")
    items = doc.get("suppressions")
    if not isinstance(items, list):
        bad("`suppressions` must be a list of entries")
    entries = []
    for i, e in enumerate(items):
        where = f"entry #{i}"
        if not isinstance(e, dict):
            bad(f"{where} must be an object with rule, file, reason and an optional match")
        extra = sorted(set(e) - _SUPPRESSIONS_ENTRY_KEYS)
        if extra:
            bad(f"{where}: unknown key(s): {', '.join(extra)}; allowed: rule, file, match, reason")
        rule = e.get("rule")
        if not isinstance(rule, str) or not rule.strip():
            bad(f"{where}: `rule` is required")
        rule = rule.strip()
        why = _why_not_suppressible(rule)
        if why:
            bad(f"{where}: {why}")
        file = e.get("file")
        if not isinstance(file, str) or not file.strip():
            bad(f"{where}: `file` is required (the finding's file as printed, or relative to the skill's parent directory)")
        reason = e.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            bad(f"{where}: `reason` is required and must say why the finding is accepted")
        match = e.get("match")
        if match is not None:
            if not isinstance(match, str) or not match.strip():
                bad(f"{where}: `match` must be a non-empty string (the finding's source line, compared exactly)")
            if rule in LINELESS_SKILL_RULES:
                bad(f"{where}: `{rule}` findings carry no line, so a `match` can never apply — drop `match`")
            match = match.strip()
        entries.append({
            "index": i, "rule": rule, "file": Path(file.strip()).as_posix(), "match": match,
            "reason": reason.strip(), "source": f"{value}#{i}", "used": False,
        })
    return {"path": value, "entries": entries}


# A marker line, outside any fence: an HTML comment (recommended), a `[//]: # (…)` link comment, or a bare
# line, each optionally as a list item, indented at most 3 spaces (4 is indented code in CommonMark). A `>`
# blockquote line never matches. The reason separator is `:`,
# because an HTML comment may not contain `--`.
# `ignore-start: reason` (no rule) still parses as a marker, so it is reported rather than silently inert.
_MARKER_WORD = r"lint-skill:\s*(ignore-start|ignore-end)(?:(?:\s+|(?=:))(.*?))?"
_MARKER_RES = (
    re.compile(r"^ {0,3}(?:[-*]\s+)?<!--\s*" + _MARKER_WORD + r"\s*-->\s*$"),
    re.compile(r"^ {0,3}(?:[-*]\s+)?\[[^\]]*\]:\s*#\s*\(\s*" + _MARKER_WORD + r"\s*\)\s*$"),
    re.compile(r"^ {0,3}(?:[-*]\s+)?" + _MARKER_WORD + r"\s*$"),
)


def _match_marker(line):
    for rx in _MARKER_RES:
        m = rx.match(line)
        if m:
            return m.group(1), (m.group(2) or "").strip()
    return None


def _lint_skill_markers(path, raw_lines):
    """Parse `lint-skill: ignore-start <rule>[,<rule>…]: <reason>` … `lint-skill: ignore-end` ranges in one
    SKILL.md. Returns (ranges, diagnostic findings). A marker inside a fenced block is documentation and is
    skipped, using the same fence rule as `_lint_skill_text`. Ranges do not nest."""
    ranges = []
    diags = []
    open_rg = None
    in_fence = False
    fence_char = ""
    fence_len = 0

    def invalid(line_no, message, fix):
        diags.append(Finding("WARN", "lint-skill-ignore-invalid", message, fix, path, line_no))

    for i, line in enumerate(raw_lines, start=1):
        m = _FENCE.match(line)
        if m:
            marker, lang = m.group(1), m.group(2)
            if not in_fence:
                in_fence, fence_char, fence_len = True, marker[0], len(marker)
                continue
            if marker[0] == fence_char and len(marker) >= fence_len and not lang:
                in_fence, fence_char, fence_len = False, "", 0
                continue
        if in_fence:
            continue
        hit = _match_marker(line)
        if hit is None:
            continue
        word, rest = hit
        if word == "ignore-end":
            if open_rg is None:
                invalid(i, "`lint-skill: ignore-end` with no open `ignore-start` — it closes nothing.",
                        "Remove it, or add the matching `ignore-start <rule>: <reason>` above the lines it covers.")
            else:
                open_rg["end"] = i
                ranges.append(open_rg)
                open_rg = None
            continue
        if open_rg is not None:
            invalid(i, f"`lint-skill: ignore-start` while the range opened at :{open_rg['start']} is still open — "
                    "ranges do not nest; this marker is ignored.",
                    "Close the first range with `lint-skill: ignore-end` before opening another, or list both rules "
                    "in one marker: `ignore-start <rule>,<rule>: <reason>`.")
            continue
        ids_part, sep, reason = rest.partition(":")
        ids = [x.strip() for x in ids_part.split(",") if x.strip()]
        rules = []
        if not ids:
            invalid(i, "`lint-skill: ignore-start` names no rule, so it suppresses nothing.",
                    "Name the rule(s) it is for: `<!-- lint-skill: ignore-start <rule>[,<rule>…]: <reason> -->`.")
        for rid in ids:
            why = _why_not_suppressible(rid)
            if why is None:
                rules.append(rid)
            elif rid in LINT_SKILL_RULES:
                invalid(i, f"`lint-skill: ignore-start` names {why}.", "Remove the rule from the marker.")
            else:
                invalid(i, f"`lint-skill: ignore-start` names an unknown lint-skill rule `{rid}`; suppressible "
                        f"rules: {', '.join(_suppressible_rules())}.", "Fix the rule id (see the `rule` field in `--json`).")
        open_rg = {"file": path, "start": i, "end": None, "rules": rules,
                   "reason": reason.strip() or None, "used": set()}
    if open_rg is not None:
        open_rg["end"] = len(raw_lines)
        ranges.append(open_rg)
        diags.append(Finding(
            "WARN", "lint-skill-ignore-unclosed",
            "`lint-skill: ignore-start` has no `ignore-end` before the end of the file, so it suppresses "
            "everything after it.",
            "Add `<!-- lint-skill: ignore-end -->` right after the lines it is meant to cover.",
            path, open_rg["start"],
        ))
    return ranges, diags


def _glob_matches(glob, file, bases):
    """`--ignore-rule <id>=<glob>`: fnmatch (a `*` also crosses `/`) against the finding's `file` as printed,
    or against that path relative to the PARENT of the skill directory it came from, so the relative form
    always starts with the skill's own directory name (`deck-review/SKILL.md`). A bare `SKILL.md` therefore
    cannot silently cover every skill in a run that passes one directory per skill."""
    return any(fnmatch.fnmatchcase(c, glob) for c in _file_candidates(file, bases))


def _file_candidates(file, bases):
    """The forms a finding's `file` can be named by: as printed, and relative to the PARENT of the skill
    directory of each argument that reached the file (so it starts with the skill's own directory name,
    `deck-review/SKILL.md`). Every such argument counts, so the verdict never depends on argument order."""
    cand = [Path(file).as_posix()]
    for base in bases:
        try:
            rel = Path(os.path.relpath(Path(file).resolve(), base)).as_posix()
        except ValueError:
            continue
        if rel not in cand:
            cand.append(rel)
    return cand


def _apply_suppressions(tagged, ranges, specs, files=(), lines_by_file=None):
    """Mark each finding a marker, a suppressions-file entry or an --ignore-rule covers, in that order of
    precedence for the `suppressed` record. A marker applies to the SAME file, a rule it names, and a line
    inside its range. A suppressions-file entry suppresses at most ONE finding: its rule, its exact file, and,
    when it has `match`, the finding's exact source line (surrounding whitespace stripped). A finding a marker
    already covers consumes no entry. Returns the unused-diagnostics."""
    lines_by_file = lines_by_file or {}

    def line_text(f):
        lines = lines_by_file.get(f.file)
        if f.line is None or lines is None or not (1 <= f.line <= len(lines)):
            return None
        return lines[f.line - 1].strip()

    suppressible = [(f, roots) for f, roots in tagged if LINT_SKILL_RULES.get(f.rule, ("", False))[1]]
    for f, _roots in suppressible:
        for rg in ranges:
            if (rg["file"] == f.file and f.rule in rg["rules"] and f.line is not None
                    and rg["start"] <= f.line <= rg["end"]):
                rg["used"].add(f.rule)
                if f.suppressed is None:
                    f.suppressed = {"by": "marker", "marker_line": rg["start"], "reason": rg["reason"]}

    # Suppressions file: findings in a fixed order (file, line, rule; a line-less finding last), each taking the
    # first unconsumed matching entry in file order, entries WITH `match` before entries without, so a broad
    # entry never takes a site a specific one was written for. Exact matching puts every entry with `match` in
    # one (rule, file, line text) class, so this greedy order is optimal.
    entries = [e for sf in files for e in sf["entries"]]
    if entries:
        order = sorted(
            (pair for pair in suppressible if pair[0].suppressed is None),
            key=lambda p: (str(p[0].file), p[0].line is None, p[0].line or 0, p[0].rule),
        )
        for f, roots in order:
            cand = _file_candidates(f.file, roots)
            text = line_text(f)
            fitting = [e for e in entries if not e["used"] and e["rule"] == f.rule and e["file"] in cand]
            pick = next((e for e in fitting if e["match"] is not None and e["match"] == text), None)
            if pick is None:
                pick = next((e for e in fitting if e["match"] is None), None)
            if pick is not None:
                pick["used"] = True
                f.suppressed = {"by": "file", "marker_line": None, "reason": pick["reason"], "source": pick["source"]}
    for f, roots in suppressible:
        for sp in specs:
            if sp["rule"] == f.rule and (sp["glob"] is None or _glob_matches(sp["glob"], f.file, roots)):
                sp["used"] = True
                if f.suppressed is None:
                    f.suppressed = {"by": "flag", "marker_line": None, "reason": None}
    if entries:
        # A class with more findings than entries reds on one of them, which need not be the newly added site:
        # name every line of the class on each unsuppressed one.
        for f, roots in suppressible:
            text = line_text(f)
            if f.suppressed is not None or text is None:
                continue
            cand = _file_candidates(f.file, roots)
            n_entries = sum(1 for e in entries if e["rule"] == f.rule and e["file"] in cand and e["match"] == text)
            if n_entries == 0:
                continue
            same = sorted(g.line for g, _ in suppressible if g.rule == f.rule and g.file == f.file and line_text(g) == text)
            f.message += (
                f" (Suppressions file: {n_entries} entr{'y' if n_entries == 1 else 'ies'} for this exact line text, "
                f"{len(same)} finding(s) on lines {', '.join(str(n) for n in same)} — the unsuppressed one need "
                "not be the newest site.)"
            )
    unused = []
    for rg in ranges:
        for rid in rg["rules"]:
            if rid not in rg["used"]:
                unused.append(Finding(
                    "INFO", "lint-skill-ignore-unused",
                    f"`lint-skill: ignore-start` for `{rid}` suppressed nothing in its range (:{rg['start']}-:{rg['end']}).",
                    "Remove it if the finding it was added for is gone; otherwise check the rule id and that the "
                    "range wraps the whole fence.",
                    rg["file"], rg["start"],
                ))
    for e in entries:
        if not e["used"]:
            what = f"`{e['rule']}` in {e['file']}" + (f" matching {json.dumps(e['match'], ensure_ascii=False)}" if e["match"] is not None else "")
            unused.append(Finding(
                "INFO", "lint-skill-ignore-unused",
                f"suppressions entry #{e['index']} ({what}) suppressed nothing.",
                "Remove the entry if the finding it was written for is gone; otherwise check `file` against the "
                "finding's `file` in `--json` (or the path relative to the skill's parent directory) and `match` "
                "against its source line (exact, surrounding whitespace ignored). Lint every skill the file covers "
                "in one invocation, or another skill's entries report as unused.",
                e["source"].rsplit("#", 1)[0],
            ))
    for sp in specs:
        if not sp["used"]:
            unused.append(Finding(
                "INFO", "lint-skill-ignore-unused",
                f"`--ignore-rule {sp['raw']}` suppressed nothing.",
                "Remove it if the finding it was added for is gone; otherwise check the glob against the finding's "
                "`file` in `--json` (fnmatch, where `*` also crosses `/`).",
                "(--ignore-rule)",
            ))
    return unused


def cmd_lint_skill(args):
    all_findings = []
    # (finding, the parents of the skill dirs of every argument that reached its file) — the bases a relative
    # `file` or --ignore-rule glob is also tried against
    tagged = []
    ranges = []
    # The exact lines each finding was computed from, so a suppressions-file `match` compares against the same
    # text the linter saw (never a re-read that could differ).
    lines_by_file = {}
    # A file reached through two arguments (`sk` and `$PWD/sk`, a symlinked alias) is linted once, so its findings,
    # markers and suppressions are never doubled. Each later argument still adds its base, shared by reference with
    # the findings already tagged, so a relative name matches whichever argument came first.
    roots_by_file = {}

    def first_visit(target, root):
        key = str(Path(target).resolve())
        roots = roots_by_file.get(key)
        if roots is not None:
            if root not in roots:
                roots.append(root)
            return None
        roots_by_file[key] = [root]
        return roots_by_file[key]
    n_files = 0
    for arg in args.paths:
        start = len(all_findings)
        root = (Path(arg) if Path(arg).is_dir() else Path(arg).parent).resolve().parent
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
            continue  # an ERROR, never suppressible, so it needs no tag
        md_roots = first_visit(md, root) if md is not None else None
        hooks = [(hp, r) for hp in hooks if (r := first_visit(hp, root)) is not None]
        if md_roots is not None:
            n_files += 1
            md_lines = Path(md).read_text(encoding="utf-8").splitlines()
            lines_by_file.setdefault(md, md_lines)
            md_ranges, md_diags = _lint_skill_markers(md, md_lines)
            ranges.extend(md_ranges)
            all_findings.extend(md_diags)
            all_findings.extend(_lint_skill_text(md, md_lines))
            all_findings.extend(_lint_subagent_types(md, md_lines))
            all_findings.extend(_lint_skill_corpus_size(md))
            all_findings.extend(_lint_skill_sizes(md))
            tagged.extend((f, md_roots) for f in all_findings[start:])
        for hp, hp_roots in hooks:
            start = len(all_findings)
            n_files += 1
            hp_lines = Path(hp).read_text(encoding="utf-8").splitlines()
            lines_by_file.setdefault(hp, hp_lines)
            all_findings.extend(_lint_skill_text(hp, hp_lines, force_json=True))
            all_findings.extend(_lint_hook_events(hp))
            tagged.extend((f, hp_roots) for f in all_findings[start:])
    # The same suppressions file named twice must not double its entries (a repeated CI glob would then absorb a
    # new paste): each file counts once.
    files, seen_files = [], set()
    for sf in args.suppressions or []:
        key = str(Path(sf["path"]).resolve())
        if key not in seen_files:
            seen_files.add(key)
            files.append(sf)
    unused = _apply_suppressions(tagged, ranges, args.ignore_rule or [], files, lines_by_file)
    # --strict-ignores: a suppression that suppressed nothing (marker, --ignore-rule or file entry) is a WARN
    # for this run, so `--strict` fails on it and the printed severity says why.
    if args.strict_ignores:
        for u in unused:
            u.severity = "WARN"
    all_findings.extend(unused)
    if args.json:
        print(json.dumps([x.as_dict() for x in all_findings], indent=2))
    else:
        _print_findings(
            all_findings, n_files, kind="skill file", clean_suffix=" — no Cowork host-loop footguns.", suppression=True
        )
    # A suppressed finding is reported but does not gate.
    all_findings = [x for x in all_findings if x.suppressed is None]
    has_error = any(x.severity == "ERROR" for x in all_findings)
    # --strict fails on WARN too, per its own --help text ("exit non-zero on WARN too, not just ERROR")
    # — but NEVER on INFO. Of the subagent_type ladder, only `subagent-type-not-found-in-plugin` is
    # WARN (a provable in-plugin typo — see the subparser help above); `subagent-type-unresolvable` and
    # `subagent-type-unknown` stay INFO by design (there is no harness registry to disprove an unknown
    # value against), so those two must always be surfaced, never failed, even under --strict.
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
    if args.session:
        L.append(f"# Model: {args.session} must set `model:`, or run with `--model <id>` or COWORK_HARNESS_MODEL set.")
    else:
        L.append("# Model: the inline session pins none — add `session:` with a file that sets `model:`, or run")
        L.append("# with `--model <id>` or COWORK_HARNESS_MODEL set. A run that resolves no model is refused.")
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
        # `<N> >= 1` is not decoration: this block also emits gate-PRESENCE assertions, and
        # `questions_count_max: 0` alongside one of those is unsatisfiable — refused by run/skill/record
        # and flagged as `assert-contradiction`. Zero is the natural value to reach for on a
        # gate-clean scenario, so the hint has to say where it does NOT belong.
        content_lines.append(
            "  # - questions_count_max: <N>   # BUDGET (N >= 1 — `0` contradicts the gate assertions "
            "below; use it only in a scenario with none) — calibrate from a real run: `trace --view "
            "questions` prints the SUB-question total (what this asserts); set N to that + headroom."
        )
        content_lines.append("  - gate_answers_delivered: true   # the steered answers actually reached the model")

    # Two buckets, not one. `file_exists`/`user_visible_artifact` are MANIFEST_KEYS above — they DO
    # evaluate on replay whenever the cassette carries an artifacts manifest, which `record` has
    # snapshotted since 0.24. Filing them under a "LIVE-only" heading taught the reader the opposite of
    # what this file's own taxonomy says, and of what the `manifest-needs-snapshot` INFO tells them.
    manifest_lines = []
    for p in (args.file or []):
        manifest_lines.append(f"  - file_exists: {p}")
    for p in (args.artifact or []):
        manifest_lines.append(f"  - user_visible_artifact: {p}")
    live_lines = []
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
    if manifest_lines:
        L.append("  # --- artifacts: replay-checkable WHEN the cassette carries an artifacts manifest ---")
        L.extend(manifest_lines)
    if live_lines:
        L.append("  # --- egress / deletes: LIVE-only (skipped on replay, with a loud warning) ---")
        L.extend(live_lines)
    if not manifest_lines and not live_lines:
        L.append("  # TODO add artifact checks (file_exists / user_visible_artifact — these replay from")
        L.append("  #      the cassette's artifacts manifest) and filesystem/egress checks")
        L.append("  #      (egress_denied / no_delete_in_outputs — LIVE lane only).")

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
    # The wrapper (`cowork-harness lint`) sets COWORK_HARNESS_PROG so usage/error lines name a command the
    # user can actually run. Default = the script's own basename, because scenario.py is ALSO documented as
    # directly runnable (SKILL.md;
    # https://github.com/yaniv-golan/cowork-harness/blob/main/docs/gotchas.md,
    # https://github.com/yaniv-golan/cowork-harness/blob/main/docs/plugin-root.md,
    # https://github.com/yaniv-golan/cowork-harness/blob/main/docs/subagents.md — repo-only, not
    # shipped with the installed skill) — hardcoding
    # "cowork-harness lint" would lie on that path.
    prog = os.environ.get("COWORK_HARNESS_PROG")
    sub = ap.add_subparsers(dest="command", required=True)

    lp = sub.add_parser("lint", prog=f"{prog} lint" if prog else None, help="lint scenario(s) for silent-false-green invariants")
    lp.add_argument("files", nargs="+", help="scenario YAML file(s) or director(ies) of *.yaml/*.yml to lint")
    lp.add_argument("--json", action="store_true", help="emit findings as JSON")
    lp.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero on WARN too, not just ERROR. Under --strict the default --min-severity is "
        "WARN, so INFO findings are neither printed nor failing. It fails on the same classes as "
        "`lint-skill --strict` (which still prints INFO). Pass `--min-severity INFO` to see and fail on "
        "INFO too.",
    )
    lp.add_argument(
        "--min-severity",
        choices=("ERROR", "WARN", "INFO"),
        default=None,
        help="drop findings below this severity BEFORE printing and before the exit computation "
        "(default: INFO = keep everything; WARN under --strict). --json is filtered identically. So "
        "`--strict --min-severity ERROR` behaves exactly like a plain lint, rather than reporting "
        "0 findings and still exiting 1.",
    )
    lp.add_argument(
        "--cassette-dir",
        metavar="PATH",
        help="optionally inspect a cassette file or a directory of *.cassette.json cassettes by exact scenarioSource; "
        "INFO advice is suppressed only when every matching cassette proves the relevant replay evidence",
    )
    lp.set_defaults(func=cmd_lint)

    lsp = sub.add_parser(
        "lint-skill",
        prog=f"{prog} lint-skill" if prog else None,
        help="lint SKILL.md bodies for Cowork host-loop footguns + static subagent_type resolution",
        description=(
            "Inspect skill bodies (SKILL.md + any sibling hooks.json) for two antipatterns a paid "
            "Cowork host-loop run would expose:\n"
            "  (a) $CLAUDE_PLUGIN_ROOT in an in-VM bash context — a bare $CLAUDE_PLUGIN_ROOT is not replaced "
            "and is empty in the VM shell at host-loop (WARN plugin-root-in-vm-bash); the braced form is "
            "replaced at load with a HOST path that the host-loop bash tool rewrites to the plugin's VM mount "
            "when it stands as its own word (INFO plugin-root-braced-in-vm-bash), so a value forwarded through "
            "bash to a host-side file tool arrives as a VM path (WARN plugin-root-forwarded-from-vm-bash, for "
            "the whole root as the value of an option named root/dir/path/plugin/base, not inside an open quoted "
            "string (such as an echo'd sentence) and not for `claude` itself). The braced form glued to other "
            "text (${CLAUDE_PLUGIN_ROOT}-v2, x${CLAUDE_PLUGIN_ROOT}) is not rewritten, and in a standalone skill "
            "(no plugin.json above it) nothing replaces it, so both are the WARN plugin-root-in-vm-bash too. A fully commented-out line is skipped. Suppress a reviewed site with a "
            "marker (below);\n"
            "  (b) a hook command that exports an env var or writes into /tmp for the in-VM agent — a "
            "host-side hook write is not VM-visible (works in the CLI, silently no-ops in Cowork).\n\n"
            "HONEST LIMITS (v1 is deliberately narrow to bound false positives): an in-VM bash context is "
            "ONLY a fenced ```bash/```sh/```shell block or a Bash(...) directive (a hook command gets a "
            "plugin-root path valid where it runs, so it is checked for (b) only). Every `\"command\"` value in "
            "a ```json/```jsonc/```json5 fence in SKILL.md is read as a hook command, so a JSON example of a "
            "Bash tool input there is not checked for (a). Host-side prose and Read/Grep directives (the correct way to read a "
            "reference via ${CLAUDE_PLUGIN_ROOT}/...) are left alone. False negatives are expected: a token "
            "in an indented/unfenced shell snippet won't be caught.\n\n"
            "Also statically resolves any pinned `subagent_type` value in the SKILL.md against the "
            "enclosing plugin's `agents/*.md` (see `resolve-agent-types`): a value that resolves in-plugin "
            "or is `general-purpose` is clean; a `<this-plugin>:<agent>` whose agent is missing from an "
            "enumerable plugin is a provable typo, reported as `subagent-type-not-found-in-plugin` "
            "(WARN — gates under `--strict`, since the namespace prefix already commits it to this "
            "plugin and its agent set was fully enumerated); a `<other-plugin>:<agent>` is reported as "
            "`subagent-type-unresolvable` (INFO); any other unresolved value (including a same-plugin "
            "prefix the linter couldn't enumerate) is `subagent-type-unknown` (INFO) — those two stay "
            "INFO, never WARN, since there is no harness registry of built-in agent types to disprove "
            "an unknown value against.\n\n"
            "Also sizes the skill against two agent caps: a SKILL.md body (frontmatter excluded) over "
            "19,000 B is `skill-body-over-reattach-cap` (WARN; INFO from 80%) — after a context compaction "
            "the agent re-attaches only the first ~19,900 characters of an invoked skill — and a "
            "references/**.md over 60,000 B is `skill-reference-over-read-cap` (WARN) — a whole-file Read "
            "past 25,000 real tokens returns only a partial view with a paging notice, so the agent must "
            "page. The body cap counts UTF-8 bytes, never fewer than the UTF-16 units the agent estimates "
            "from, so it warns early; the reference cap rests on a measured ~2.65 B per real token for "
            "markdown, with a margin.\n\n"
            "SUPPRESSION: a reviewed judgement-call WARN/INFO finding can be suppressed so `--strict` stays the "
            "gate. `--ignore-rule RULE[=GLOB]` (repeatable) is run-wide, or limited to files matching GLOB — the "
            "only form for a finding without a line, such as the size caps. In a SKILL.md, "
            "`<!-- lint-skill: ignore-start RULE[,RULE...]: reason -->` ... `<!-- lint-skill: ignore-end -->` "
            "suppresses the named rules on the lines between, in that file only; a marker inside a fenced block "
            "is ignored, so wrap the whole fence. references/ files are not linted, so a marker there does "
            "nothing. A suppressed finding is still printed (glyph ⊘) and kept in --json with its severity and "
            "a `suppressed` record ({by, marker_line, reason}, plus `source` for a suppressions-file entry); it "
            "only stops gating. `--suppressions FILE` (repeatable) reads reviewed sites from a JSON file kept "
            "OUTSIDE the plugin, so editing it changes no skill bytes: "
            '{"version": 1, "suppressions": [{"rule", "file", "match"?, "reason"}]}. Each entry suppresses AT '
            "MOST ONE finding: its rule, in exactly that file (as printed, or relative to the skill's parent "
            "directory), and, with `match`, on exactly that source line (surrounding whitespace ignored). A new "
            "copy of an accepted line therefore still fails `--strict`. `--strict-ignores` makes a marker, "
            "`--ignore-rule` or entry that suppressed nothing a WARN instead of INFO. Provable rules (ERROR, "
            "`hooks-json-misplaced`, `subagent-type-not-found-in-plugin`) cannot be suppressed. A bad marker "
            "is WARN `lint-skill-ignore-invalid` (unknown or provable rule, no rule, nested, stray end), an "
            "unclosed one WARN `lint-skill-ignore-unclosed`, and one that suppressed nothing INFO "
            "`lint-skill-ignore-unused`.\n\n"
            "Plain `lint-skill` (no `--strict`) is ADVISORY — it prints findings but exits 0 on "
            "WARN/INFO. CI should invoke `lint-skill --strict` to actually gate on the WARN-class "
            "findings above (the two host-loop footguns, the provable subagent_type typo and the two "
            "size caps)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    lsp.add_argument("paths", nargs="+", help="SKILL.md file(s) or skill director(ies) to inspect")
    lsp.add_argument("--json", action="store_true", help="emit findings as JSON")
    lsp.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero on WARN too, not just ERROR (CI-recommended invocation; plain lint-skill is "
        "advisory-only). NEVER fails on INFO — the same default as `lint --strict` (which, unlike this "
        "flag, can be widened with `--min-severity INFO`). See the subparser description for why the "
        "INFO-class subagent_type findings are deliberately unfailable.",
    )
    lsp.add_argument(
        "--ignore-rule",
        action="append",
        type=_ignore_rule_spec,
        metavar="RULE[=GLOB]",
        help="suppress a reviewed WARN/INFO rule (repeatable). With `=GLOB`, only in files whose path matches "
        "(fnmatch; `*` also crosses `/`), either as printed or relative to the parent of the skill directory, "
        "so the relative form starts with the skill's directory name: `deck-review/SKILL.md`, "
        "`deck-review/references/*`. A bare `SKILL.md` matches no skill passed as `<dir>/`. A suppressed finding is "
        "still reported (it keeps its severity; `--json` adds a `suppressed` record) but no longer gates. "
        "An unknown rule, or a provable one (ERROR, `hooks-json-misplaced`, `subagent-type-not-found-in-plugin`), "
        "is a usage error. Unscoped, it also hides the next new finding of that rule in any file.",
    )
    lsp.add_argument(
        "--suppressions",
        action="append",
        type=_suppressions_file,
        metavar="FILE",
        help="a JSON file of reviewed suppressions (repeatable): "
        '{"version": 1, "suppressions": [{"rule": ..., "file": ..., "match": ..., "reason": ...}]}. '
        "Each entry suppresses at most one finding of `rule` in exactly `file` (as printed, or relative to the "
        "skill's parent directory); with `match`, only on the source line equal to it (surrounding whitespace "
        "ignored). `reason` is required. Entries with `match` are used before entries without. A size-cap rule "
        "has no line, so its entry takes no `match`. A malformed file, an unknown or provable rule, a missing "
        "reason or an unknown key is a usage error. Keep the file outside the plugin (or list it in "
        ".cowork-hashignore): the cassette hash covers the plugin, so editing it there would stale cassettes.",
    )
    lsp.add_argument(
        "--strict-ignores",
        action="store_true",
        help="report a marker, `--ignore-rule` or suppressions entry that suppressed nothing as WARN instead of "
        "INFO, so `--strict --strict-ignores` fails on a stale suppression. Lint every skill a suppressions file "
        "covers in one invocation, or the other skills' entries report as unused.",
    )
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

    sp = sub.add_parser("scaffold", prog=f"{prog} scaffold" if prog else None, help="emit a valid scenario skeleton (self-linted)")
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
    sp.add_argument("--no-delete", action="store_true", help="add no_delete_in_outputs: true (checks outputs deletes on every baseline; from Desktop 2.16120.0 Cowork itself allows them)")
    sp.add_argument("--egress-allowed", dest="egress_allowed", action="append", metavar="HOST", help="egress_allowed assertion (repeatable)")
    sp.add_argument("--egress-denied", dest="egress_denied", action="append", metavar="HOST", help="egress_denied assertion (repeatable)")
    sp.add_argument("--out", help="write to this file (default: stdout)")
    sp.add_argument("--no-validate", action="store_true", help="skip the self-lint of the generated scenario")
    sp.set_defaults(func=cmd_scaffold)

    # parse_known_args + the subparser's own error(): argparse bubbles unknown args to the TOP-LEVEL
    # parser, whose usage line lists {lint,lint-skill,resolve-agent-types,scaffold} — a set that is
    # meaningless (and partly wrong) through the `cowork-harness` wrapper. Reporting on the subparser keeps
    # the message about the command the user actually typed.
    args, extras = ap.parse_known_args(argv)
    if extras:
        target = sub.choices.get(getattr(args, "command", "") or "")
        # `--min-severity` is `lint`-only (it filters lint's severity-classed findings; `lint-skill`'s two
        # footgun checks have no severity ladder to filter). Passing it to `lint-skill` used to fall through
        # to the bare "unrecognized arguments" message below and leave the user hunting for a flag that DOES
        # exist, just on the sibling command — name it explicitly, same as the `--output-format` translation
        # `runLintLike` (src/run/scenario-tool.ts) already does for the other lint/lint-skill flag mismatch.
        if getattr(args, "command", None) == "lint-skill" and any(
            e == "--min-severity" or e.startswith("--min-severity=") for e in extras
        ):
            (target or ap).error("unrecognized arguments: " + " ".join(extras) + " (--min-severity is a `lint` flag, not `lint-skill` — rerun with `cowork-harness lint` instead)")
        if getattr(args, "command", None) == "lint":
            for flag in ("--ignore-rule", "--suppressions", "--strict-ignores"):
                if any(e == flag or e.startswith(flag + "=") for e in extras):
                    (target or ap).error(
                        "unrecognized arguments: " + " ".join(extras) + f" ({flag} is a `lint-skill` flag; `lint` has no rule suppression)"
                    )
        (target or ap).error("unrecognized arguments: " + " ".join(extras))
    if getattr(args, "command", None) == "lint" and getattr(args, "cassette_dir", None) == "":
        sub.choices["lint"].error("--cassette-dir needs a path")
    if getattr(args, "command", None) == "lint" and getattr(args, "cassette_dir", None):
        cassette_path = Path(args.cassette_dir)
        if not cassette_path.is_file() and not cassette_path.is_dir():
            sub.choices["lint"].error(f"--cassette-dir path does not exist or is not readable: {args.cassette_dir}")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

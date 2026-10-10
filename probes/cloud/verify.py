#!/usr/bin/env python3
"""Verify a downloaded cloud-probe capture: integrity first, then redaction.

usage: verify.py --probe p0|p0f|p6 <download folder> [<line count from the transcript>]

0. The download folder must hold export.jsonl and export.sha256 and NOTHING else. Any other file (above all the
   capture's .salt, which would make every fingerprint dictionary-attackable) voids the export: delete the folder.
1. Integrity: export.jsonl's sha256 must equal the first 64-hex run in export.sha256 (so "sha256:<hex>" or a
   back-ticked hash both work), and its line count must equal the `wc -l` the task printed, when given. A
   mismatch voids the probe. A 64-hex string INSIDE export.jsonl is a redaction failure (no field holds one).
2. Redaction: every line must pass validate_record(): only the fields capture.py writes, each with the expected
   type or pattern. Anything else (a path, an id, a free-text value) fails the whole file.
3. Answerability: a capture that cannot answer its probe is void, not a result. P0 needs at least one
   PostToolUse record for a remote-devices tool; P0F (a failing device command) needs at least one
   PostToolUseFailure record for one; P6 needs at least one record with a recognised permission mode.
   "<hook-error>" lines are allowed (they carry only an exception class name) and are counted in the summary.
Exit 0 ok, 1 integrity failure, 2 redaction failure or a stray file, 3 usage, 4 the capture cannot answer the probe.
The summary printed on success names tools verbatim; keep it out of any repository.
"""
import hashlib
import json
import os
import re
import sys

TOP_KEYS = {
    "v", "event", "error", "permission_mode", "tool", "cwd", "payload_keys", "input_keys", "input_key_count",
    "input_timeout_ms", "response_shape", "response_text_chars_le", "response_text_sha12", "response_exit_code",
    "response_is_error", "failure_shape", "failure_text_chars_le", "failure_text_sha12", "failure_exit_code",
    "failure_is_interrupt", "failure_duration_ms_le",
}
FAILURE_KEYS = {k for k in TOP_KEYS if k.startswith("failure_")}
EXPORT_FILES = {"export.jsonl", "export.sha256"}
IGNORED_FILES = {".DS_Store"}  # Finder writes it when the folder is opened; never part of an export
MAX_INPUT_KEYS = 40
# Kept in step with capture.py's BUILTIN_TOOLS / COWORK_TOOLS.
BUILTIN_TOOLS = (
    "Bash|Read|Write|Edit|MultiEdit|Glob|Grep|LS|NotebookEdit|NotebookRead|WebFetch|WebSearch|TodoWrite|Task|Agent"
    "|ToolSearch|Skill|AskUserQuestion|ExitPlanMode|EnterPlanMode|KillShell|KillBash|BashOutput|TaskOutput|TaskStop"
    "|SendUserFile|ListMcpResourcesTool|ReadMcpResourceTool|ListMcpResources|ReadMcpResource|SlashCommand|Monitor"
    "|Brief|ListPeers|SendMessage"
)
COWORK_TOOLS = "present_files|request_cowork_directory|save_skill|allow_cowork_file_delete"
EVENTS = {"PreToolUse", "PostToolUse", "PostToolUseFailure", "<other>", "<oversize>", "<hook-error>"}
RECOGNISED_MODES = {"default", "auto", "plan", "acceptEdits", "bypassPermissions", "dontAsk"}
HEX64 = re.compile(r"[0-9a-f]{64}")
MODES = {"default", "auto", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "<other-or-absent>"}
CWDS = {"/home/claude", "/root", "/tmp", "<other>"}
H12 = r"[0-9a-f]{12}"
REMOTE_DEVICE_TOOLS = (
    "list_devices|get_device_info|device_list_dir|device_stage_files|device_commit_files|device_bash"
    "|device_request_folder_access|device_request_delete_permission|create_artifact|update_artifact"
    "|list_artifacts|list_legacy_live_artifacts|project_memory_read|project_memory_write"
)
RD = r"(?:mcp|internal)__remote-devices__"
# capture.py's REMOTE_DEVICE_GROUP_RE: no "__" inside, so a bridged "<server>__<tool>" never passes as product vocabulary.
GROUP = r"computer_[a-z]+(?:_[a-z]+){0,6}|Claude_Browser__[a-z]+(?:_[a-z]+){0,6}"
VOCAB_TOOL_RE = re.compile(
    rf"^(?:{BUILTIN_TOOLS}|mcp__cowork__(?:{COWORK_TOOLS})"
    rf"|{RD}(?:{REMOTE_DEVICE_TOOLS}|{GROUP}))$"
)
TOOL_RE = re.compile(
    rf"^(?:{BUILTIN_TOOLS}|mcp__cowork__(?:{COWORK_TOOLS})|mcp__cowork__<tool:{H12}>"
    rf"|{RD}(?:{REMOTE_DEVICE_TOOLS}|{GROUP})"
    rf"|{RD}<srv:{H12}>__<tool:{H12}>|{RD}<tool:{H12}>"
    rf"|mcp__<srv:{H12}>__<tool:{H12}>|<tool:{H12}>|<none>)$"
)
REMOTE_DEVICE_TOOL_RE = re.compile(rf"^{RD}(?:{REMOTE_DEVICE_TOOLS})$")
KEY_RE = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]{0,40}|<key:[0-9a-f]{12}>)$")


def _shape_ok(s, depth=0):
    if depth > 6:
        return False
    if isinstance(s, str):
        return s in {"bool", "number", "null"} or re.fullmatch(r"[A-Za-z_]{1,20}", s) is not None
    if isinstance(s, dict) and len(s) == 1:
        (k, v), = s.items()
        if k == "str_le" and isinstance(v, int) and v >= 0 and (v & (v - 1)) == 0:
            return True
        if k == "dict" and isinstance(v, int):
            return True
        if k == "dict" and isinstance(v, dict):
            return all(KEY_RE.match(kk) and _shape_ok(vv, depth + 1) for kk, vv in v.items())
        if k == "list" and isinstance(v, int):
            return True
    if isinstance(s, dict) and set(s) == {"list", "items"} and isinstance(s["list"], int) and isinstance(s["items"], list):
        return all(isinstance(i, str) and _shape_ok(json.loads(i), depth + 1) for i in s["items"])
    return False


def validate_record(rec):
    """Returns a list of problems (empty = clean)."""
    p = []
    if not isinstance(rec, dict):
        return ["not an object"]
    extra = set(rec) - TOP_KEYS
    if extra:
        p.append(f"unexpected fields {sorted(extra)}")
    if rec.get("v") != 1:
        p.append("v != 1")
    if rec.get("event") not in EVENTS:
        p.append("event not allowed")
    if "permission_mode" in rec and rec["permission_mode"] not in MODES:
        p.append("permission_mode not allowed")
    if "tool" in rec and not (isinstance(rec["tool"], str) and TOOL_RE.match(rec["tool"])):
        p.append("tool name not in redacted form")
    if "cwd" in rec and rec["cwd"] not in CWDS:
        p.append("cwd not structural")
    if "payload_keys" in rec and not (
        isinstance(rec["payload_keys"], list)
        and len(rec["payload_keys"]) <= MAX_INPUT_KEYS
        and all(isinstance(x, str) and re.fullmatch(r"[a-z_]{1,40}", x) for x in rec["payload_keys"])
    ):
        p.append("payload_keys malformed")
    if "input_keys" in rec:
        # The mirror of capture.py: verbatim field names only for a vocabulary tool, fingerprints for every other.
        vocab = isinstance(rec.get("tool"), str) and VOCAB_TOOL_RE.match(rec["tool"]) is not None
        key_re = rf"[A-Za-z_][A-Za-z0-9_]{{0,40}}|<key:{H12}>" if vocab else rf"<key:{H12}>"
        keys = rec["input_keys"]
        if not (isinstance(keys, list) and len(keys) <= MAX_INPUT_KEYS and all(isinstance(x, str) and re.fullmatch(key_re, x) for x in keys)):
            p.append("input_keys malformed (verbatim names only for builtin/device/cowork tools; at most 40)")
    if "input_key_count" in rec and not (isinstance(rec["input_key_count"], int) and rec["input_key_count"] > MAX_INPUT_KEYS):
        p.append("input_key_count malformed")
    if "response_text_chars_le" in rec and not (
        isinstance(rec["response_text_chars_le"], int) and rec["response_text_chars_le"] >= 0
        and (rec["response_text_chars_le"] & (rec["response_text_chars_le"] - 1)) == 0
    ):
        p.append("response_text_chars_le not a power-of-two bucket")
    for k in ("input_timeout_ms", "response_exit_code"):
        if k in rec and not isinstance(rec[k], int):
            p.append(f"{k} not int")
    if "response_text_sha12" in rec and not (rec["response_text_sha12"] is None or re.fullmatch(H12, str(rec["response_text_sha12"]))):
        p.append("response_text_sha12 malformed")
    if "response_is_error" in rec and not isinstance(rec["response_is_error"], bool):
        p.append("response_is_error not bool")
    if "response_shape" in rec and not _shape_ok(rec["response_shape"]):
        p.append("response_shape malformed")
    # The failure fields belong to a PostToolUseFailure line only, and each holds a type, a size class or a number.
    if FAILURE_KEYS & set(rec) and rec.get("event") != "PostToolUseFailure":
        p.append("failure fields on a line that is not PostToolUseFailure")
    if "failure_shape" in rec and not _shape_ok(rec["failure_shape"]):
        p.append("failure_shape malformed")
    for k in ("failure_text_chars_le", "failure_duration_ms_le"):
        if k in rec and not (isinstance(rec[k], int) and not isinstance(rec[k], bool) and rec[k] >= 0 and (rec[k] & (rec[k] - 1)) == 0):
            p.append(f"{k} not a power-of-two bucket")
    if "failure_text_sha12" in rec and not (rec["failure_text_sha12"] is None or re.fullmatch(H12, str(rec["failure_text_sha12"]))):
        p.append("failure_text_sha12 malformed")
    if "failure_exit_code" in rec and not (isinstance(rec["failure_exit_code"], int) and not isinstance(rec["failure_exit_code"], bool)):
        p.append("failure_exit_code not int")
    if "failure_is_interrupt" in rec and not isinstance(rec["failure_is_interrupt"], bool):
        p.append("failure_is_interrupt not bool")
    if "error" in rec and not (rec.get("event") == "<hook-error>" and isinstance(rec["error"], str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,39}", rec["error"])):
        p.append("error field malformed or on a non-error line")
    return p


def main(argv):
    if len(argv) not in (4, 5) or argv[1] != "--probe" or argv[2] not in ("p0", "p0f", "p6") or not os.path.isdir(argv[3]):
        print(__doc__, file=sys.stderr)
        return 3
    probe, folder = argv[2], argv[3]
    present = set(os.listdir(folder)) - IGNORED_FILES
    stray = sorted(present - EXPORT_FILES)
    if stray:
        print(f"STRAY FILE(S) in the download folder: {stray} — the export must carry only {sorted(EXPORT_FILES)}. "
              "Void: delete the whole folder.", file=sys.stderr)
        return 2
    if present != EXPORT_FILES:
        print(f"usage: the download folder needs both {sorted(EXPORT_FILES)}", file=sys.stderr)
        return 3
    links = sorted(n for n in EXPORT_FILES if os.path.islink(os.path.join(folder, n)))
    if links:
        print(f"SYMLINK in the download folder: {links} — void, delete the folder", file=sys.stderr)
        return 2
    # Exactly one short line holding exactly one 64-hex run: anything more (a salt appended, junk before the hash)
    # is a second value that must not ride along.
    raw = open(os.path.join(folder, "export.sha256"), "rb").read()
    text = raw.decode("utf-8", "replace").lower()
    runs = HEX64.findall(text)
    if len(raw) > 200 or len(text.strip().splitlines()) != 1 or len(runs) != 1 or re.search(r"[0-9a-f]{65,}", text):
        print("STRAY CONTENT in export.sha256: it must be one line, at most 200 bytes, with exactly one sha256 — "
              "void, delete the folder", file=sys.stderr)
        return 2
    expected = runs[0]
    data = open(os.path.join(folder, "export.jsonl"), "rb").read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        print(f"INTEGRITY FAIL: sha256 {actual} != transcript {expected} — probe void", file=sys.stderr)
        return 1
    # Belt and braces: no field validate_record() accepts can hold 64 hex characters, so a salt or a full hash
    # pasted into a line already fails redaction below. This says why, before the per-line report.
    if HEX64.search(data.decode("utf-8", "replace").lower()):
        print("REDACTION FAIL: a 64-hex string inside export.jsonl (no field holds one) — void, delete the folder", file=sys.stderr)
        return 2
    lines = data.decode("utf-8").splitlines()
    if len(argv) == 5:
        m = re.search(r"\d+", argv[4])
        if not m or int(m.group(0)) != len(lines):
            print(f"INTEGRITY FAIL: {len(lines)} line(s) != transcript wc -l {argv[4]!r} — probe void", file=sys.stderr)
            return 1
    tools, modes, events, bad = {}, {}, {}, 0
    device_results, device_failures, recognised_modes, hook_errors = 0, 0, 0, 0
    for n, line in enumerate(lines, 1):
        try:
            rec = json.loads(line)
        except ValueError:
            print(f"line {n}: not JSON", file=sys.stderr)
            bad += 1
            continue
        problems = validate_record(rec)
        if problems:
            print(f"line {n}: {'; '.join(problems)}", file=sys.stderr)
            bad += 1
            continue
        # "<none>" for a line without the field (a <hook-error> or <oversize> line): a None key cannot be sorted.
        tool, mode, event = (rec.get(k) or "<none>" for k in ("tool", "permission_mode", "event"))
        tools[tool] = tools.get(tool, 0) + 1
        modes[mode] = modes.get(mode, 0) + 1
        events[event] = events.get(event, 0) + 1
        if rec.get("event") == "PostToolUse" and REMOTE_DEVICE_TOOL_RE.match(rec.get("tool", "")):
            device_results += 1
        if rec.get("event") == "PostToolUseFailure" and REMOTE_DEVICE_TOOL_RE.match(rec.get("tool", "")):
            device_failures += 1
        if rec.get("permission_mode") in RECOGNISED_MODES:
            recognised_modes += 1
        if rec.get("event") == "<hook-error>":
            hook_errors += 1
    if bad:
        print(f"REDACTION FAIL: {bad} line(s) rejected — do not keep or share this file", file=sys.stderr)
        return 2
    if probe == "p0" and device_results == 0:
        print("UNANSWERABLE: no PostToolUse record for a remote-devices tool — P0 void", file=sys.stderr)
        return 4
    if probe == "p0f" and device_failures == 0:
        print("UNANSWERABLE: no PostToolUseFailure record for a remote-devices tool — P0F void", file=sys.stderr)
        return 4
    if probe == "p6" and recognised_modes == 0:
        print("UNANSWERABLE: no record with a recognised permission mode — P6 void", file=sys.stderr)
        return 4
    print(json.dumps({"ok": True, "probe": probe, "sha256": actual, "lines": len(lines), "hook_errors": hook_errors,
                      "events": events, "permission_modes": modes, "tools": tools}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""Cloud-lane probe capture hook (PreToolUse, PostToolUse and PostToolUseFailure, matcher ".*").

Records the SHAPE of every tool call in a real cloud task, never its content. One JSON line per hook call is
appended to $HOME/cwh-cloud-probe/capture.jsonl. Everything is redacted at capture time: a value that is not on
an allowlist below is never written, only its type, its size or a salted 12-character fingerprint.

Fingerprints are HMAC-SHA256 under a random salt kept in $HOME/cwh-cloud-probe/.salt, which is never exported and
is shredded by the export step. Without the salt a fingerprint cannot be matched against a dictionary of likely
names. Only product vocabulary is kept verbatim: the builtin tools, the remote-devices tools and the known cowork
tools (explicit allowlists below), and the input field NAMES of those tools. Every other tool name and input key is
fingerprinted, because a connector's names and schema keys can identify the user's services (a "to"/"subject"/"body"
input is an email send) or carry user data (an input keyed by client names). String lengths are bucketed to the
next power of two, so a length cannot identify a device name or a home directory.

Inert outside a Claude Desktop cloud task: an app-installed plugin is synced to the account, so this hook also
fires in local Claude Code sessions and in other cloud sessions. It writes nothing unless CLAUDE_CODE_REMOTE is
"true" AND CLAUDE_CODE_ENTRYPOINT is "remote_cowork". Stdin is always drained first, so a writer never blocks.

Never prints to stdout (a hook's stdout can steer the agent) and always exits 0 (a failing hook must not block a
tool call). A failure inside the hook is recorded as a "<hook-error>" line carrying only the exception's class
name, so "the hook crashed" is distinguishable from "the hook never fired".
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sys

MAX_STDIN = 4 * 1024 * 1024

# The remote-devices tools served on Desktop 2.19675.x (the 14-name list).
REMOTE_DEVICE_TOOLS = {
    "list_devices", "get_device_info", "device_list_dir", "device_stage_files", "device_commit_files",
    "device_bash", "device_request_folder_access", "device_request_delete_permission", "create_artifact",
    "update_artifact", "list_artifacts", "list_legacy_live_artifacts", "project_memory_read",
    "project_memory_write",
}
# Product tool groups under remote-devices, kept verbatim: computer use and Claude's browser. Lower-case words
# joined by single underscores, never "__": a bridged private server is "<server>__<tool>", so "computer_vision__x"
# or "Claude_Browser__AcmePortal" must not pass as product vocabulary.
REMOTE_DEVICE_GROUP_RE = re.compile(r"^(?:computer_[a-z]+(?:_[a-z]+){0,6}|Claude_Browser__[a-z]+(?:_[a-z]+){0,6})$")
# Builtin tool names, explicitly: a bare CamelCase name is not proof of a builtin ("Gmail", "AcmeCapitalCRM").
BUILTIN_TOOLS = {
    "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit", "NotebookRead", "WebFetch",
    "WebSearch", "TodoWrite", "Task", "Agent", "ToolSearch", "Skill", "AskUserQuestion", "ExitPlanMode",
    "EnterPlanMode", "KillShell", "KillBash", "BashOutput", "TaskOutput", "TaskStop", "SendUserFile",
    "ListMcpResourcesTool", "ReadMcpResourceTool", "ListMcpResources", "ReadMcpResource", "SlashCommand", "Monitor",
    "Brief", "ListPeers", "SendMessage",
}
COWORK_TOOLS = {"present_files", "request_cowork_directory", "save_skill", "allow_cowork_file_delete"}
MAX_INPUT_KEYS = 40
PERMISSION_MODES = {"default", "auto", "plan", "acceptEdits", "bypassPermissions", "dontAsk"}
EVENTS = {"PreToolUse", "PostToolUse", "PostToolUseFailure"}
STRUCTURAL_CWDS = {"/home/claude", "/root", "/tmp"}
# ASCII digits only: `\d` would also match Arabic-Indic or fullwidth digits, which int() converts.
EXIT_CODE_RE = re.compile(r"^Exit code (-?[0-9]{1,4})(?![0-9])")
TOOL_NAME_IN_RAW_RE = re.compile(rb'"tool_name"\s*:\s*"([^"\\]{1,200})"')
# Response-schema key names kept verbatim; any other key (which could be user data, e.g. a dict keyed by folder
# names) is replaced by its salted fingerprint.
SCHEMA_KEYS = {
    "content", "type", "text", "isError", "structuredContent", "stdout", "stderr", "exitCode", "interrupted",
    "platform", "arch", "appVersion", "electronVersion", "nodeVersion", "deviceName", "connectedFolders",
    "scratchFolder", "homeDirectories", "localMcpServers", "timestamp", "entries", "name", "size", "mtimeMs",
    "depth", "depthCapped", "protected", "cloudOnly", "truncated", "resolvedPath", "staged", "stagedPath",
    "written", "rejected", "error", "error_type", "code", "message", "path", "devicePath", "fileUuid", "mode",
    "folder", "folders", "granted", "status", "result", "files", "file", "filenames", "numFiles", "durationMs",
}

_SALT = b""


def load_salt(out_dir: str) -> bytes:
    path = os.path.join(out_dir, ".salt")
    try:
        with open(path, "rb") as f:
            salt = f.read()
        if len(salt) == 32:
            return salt
    except OSError:
        pass
    salt = secrets.token_bytes(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(salt)
    return salt


def h12(value: str) -> str:
    return hmac.new(_SALT, value.encode("utf-8", "replace"), hashlib.sha256).hexdigest()[:12]


def bucket(n: int) -> int:
    """The next power of two at or above n (0 for 0): a size class, never an exact length."""
    b = 1
    while b < n:
        b *= 2
    return b if n else 0


def vocabulary_tool(name: object) -> bool:
    """A tool whose name, and so whose input field names, are product vocabulary rather than the user's."""
    if not isinstance(name, str):
        return False
    if name in BUILTIN_TOOLS:
        return True
    if name.startswith("mcp__cowork__"):
        return name[len("mcp__cowork__"):] in COWORK_TOOLS
    for prefix in ("mcp__remote-devices__", "internal__remote-devices__"):
        if name.startswith(prefix):
            rest = name[len(prefix):]
            return rest in REMOTE_DEVICE_TOOLS or bool(REMOTE_DEVICE_GROUP_RE.match(rest))
    return False


def redact_tool_name(name: object) -> str:
    if not isinstance(name, str) or not name:
        return "<none>"
    if vocabulary_tool(name):
        return name
    for prefix in ("mcp__remote-devices__", "internal__remote-devices__"):
        if name.startswith(prefix):
            rest = name[len(prefix):]
            parts = rest.split("__", 1)
            if len(parts) == 2:
                return f"{prefix}<srv:{h12(parts[0])}>__<tool:{h12(parts[1])}>"
            return f"{prefix}<tool:{h12(rest)}>"
    if name.startswith("mcp__cowork__"):
        return f"mcp__cowork__<tool:{h12(name[len('mcp__cowork__'):])}>"
    if name.startswith("mcp__"):
        parts = name[len("mcp__"):].split("__", 1)
        return f"mcp__<srv:{h12(parts[0])}>__<tool:{h12(parts[1] if len(parts) > 1 else '')}>"
    return f"<tool:{h12(name)}>"


def shape(value: object, depth: int = 0) -> object:
    """Type and size only, recursively for dicts (key names kept only from SCHEMA_KEYS, else fingerprinted)."""
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "number"
    if value is None:
        return "null"
    if isinstance(value, str):
        return {"str_le": bucket(len(value))}
    if isinstance(value, list):
        return {"list": len(value), "items": sorted({json.dumps(shape(v, depth + 1), sort_keys=True) for v in value[:20]})[:5]}
    if isinstance(value, dict):
        if depth >= 3:
            return {"dict": len(value)}
        out = {}
        for k in sorted(value, key=str)[:40]:
            key = k if k in SCHEMA_KEYS else f"<key:{h12(str(k))}>"
            out[key] = shape(value[k], depth + 1)
        return {"dict": out}
    return type(value).__name__


def text_of(response: object) -> str:
    if isinstance(response, str):
        return response
    if isinstance(response, dict):
        content = response.get("content")
        if isinstance(content, list):
            return "".join(c.get("text", "") for c in content if isinstance(c, dict) and isinstance(c.get("text"), str))
        if isinstance(content, str):
            return content
    if isinstance(response, list):
        return "".join(c.get("text", "") for c in response if isinstance(c, dict) and isinstance(c.get("text"), str))
    return ""


def record(payload: dict) -> dict:
    event = payload.get("hook_event_name")
    rec = {
        "v": 1,
        "event": event if event in EVENTS else "<other>",
        "permission_mode": payload.get("permission_mode") if payload.get("permission_mode") in PERMISSION_MODES else "<other-or-absent>",
        "tool": redact_tool_name(payload.get("tool_name")),
        "cwd": payload.get("cwd") if payload.get("cwd") in STRUCTURAL_CWDS else "<other>",
        "payload_keys": sorted(k for k in payload if isinstance(k, str) and re.fullmatch(r"[a-z_]{1,40}", k))[:MAX_INPUT_KEYS],
    }
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict):
        keys = [str(k) for k in tool_input]
        if vocabulary_tool(payload.get("tool_name")):
            # A plain identifier is the tool's own field name; anything else (a path, a file name) is data: fingerprint
            # it rather than drop it, so the key count stays true.
            shown = sorted(k if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,40}", k) else f"<key:{h12(k)}>" for k in keys)
        else:
            shown = sorted(f"<key:{h12(k)}>" for k in keys)
        rec["input_keys"] = shown[:MAX_INPUT_KEYS]
        if len(keys) > MAX_INPUT_KEYS:
            rec["input_key_count"] = len(keys)
        if isinstance(tool_input.get("timeout_ms"), int):
            rec["input_timeout_ms"] = tool_input["timeout_ms"]
    if event == "PostToolUse":
        response = payload.get("tool_response")
        text = text_of(response)
        rec["response_shape"] = shape(response)
        rec["response_text_chars_le"] = bucket(len(text))
        rec["response_text_sha12"] = h12(text) if text else None
        m = EXIT_CODE_RE.match(text)
        if m:
            rec["response_exit_code"] = int(m.group(1))
        if isinstance(response, dict) and isinstance(response.get("isError"), bool):
            rec["response_is_error"] = response["isError"]
    if event == "PostToolUseFailure":
        # A failed call's `error` is free text: a device_bash failure carries the command's own output (paths, file
        # names, whatever it printed). Only its shape, size class, a salted fingerprint and a leading exit code are kept.
        error = payload.get("error")
        text = error if isinstance(error, str) else text_of(error)
        rec["failure_shape"] = shape(error)
        rec["failure_text_chars_le"] = bucket(len(text))
        rec["failure_text_sha12"] = h12(text) if text else None
        m = EXIT_CODE_RE.match(text)
        if m:
            rec["failure_exit_code"] = int(m.group(1))
        if isinstance(payload.get("is_interrupt"), bool):
            rec["failure_is_interrupt"] = payload["is_interrupt"]
        if isinstance(payload.get("duration_ms"), (int, float)) and not isinstance(payload.get("duration_ms"), bool):
            rec["failure_duration_ms_le"] = bucket(int(payload["duration_ms"]))
    return rec


def main() -> int:
    global _SALT
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN + 1)
    except Exception:
        raw = b""
    if os.environ.get("CLAUDE_CODE_REMOTE") != "true" or os.environ.get("CLAUDE_CODE_ENTRYPOINT") != "remote_cowork":
        return 0
    out_dir = os.path.join(os.environ.get("HOME", "/root"), "cwh-cloud-probe")
    try:
        os.makedirs(out_dir, exist_ok=True)
        _SALT = load_salt(out_dir)
        if len(raw) > MAX_STDIN:
            m = TOOL_NAME_IN_RAW_RE.search(raw[:65536])
            name = m.group(1).decode("utf-8", "replace") if m else None
            rec = {"v": 1, "event": "<oversize>", "tool": redact_tool_name(name)}
        else:
            payload = json.loads(raw.decode("utf-8", "replace"))
            if not isinstance(payload, dict):
                raise TypeError("payload is not an object")
            rec = record(payload)
    except Exception as e:
        rec = {"v": 1, "event": "<hook-error>", "error": type(e).__name__[:40]}
    try:
        with open(os.path.join(out_dir, "capture.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

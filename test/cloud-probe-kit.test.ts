import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The cloud-lane probe kit (probes/cloud/): the capture hook must record shapes only, stay inert outside a
// Desktop cloud task, and the verifier must reject a wrong checksum, any line carrying a value it should not, a
// download folder holding anything but the two export files, and a capture that cannot answer its probe.
const KIT = join(process.cwd(), "probes/cloud");
const HOOK = join(KIT, "plugin/hooks/capture.py");
const VERIFY = join(KIT, "verify.py");
const PAYLOADS = readFileSync(join(process.cwd(), "test/fixtures/cloud-probe/payloads.jsonl"), "utf8").trim().split("\n");
const CLOUD = { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_ENTRYPOINT: "remote_cowork" };
// Every value in the fixtures that must never reach a capture. The connector names are fictional.
const HAZARDS = [
  "cse_01HZZSECRETSESSION9",
  "0a1b2c3d-4e5f-6789-abcd-ef0123456789",
  "/Users/alice",
  "alice@example.com",
  "bob@example.com",
  "ProjectZebra",
  "Alice-MacBook-Pro",
  "salaries.csv",
  "rcw-01hzzsecret",
  "Gmail",
  "orbit-ledger",
  "lookup_contacts",
  "update_records",
  "AcmeCapitalCRM",
  "AcmeCapital",
  "Dana_Levi",
  "subject",
  "sk-ant-fake-123",
  "ANTHROPIC_API_KEY",
  "1a2b3c4d-secret",
  "investors",
  "weirdMode",
  "computer_vision",
  "find_faces",
  "AcmeCapitalPortal",
  "Q3 forecast.xlsx",
  "fail-secret-token-77",
  "toolu_01FAILSECRET",
  "E_NOPE",
  "ledger",
];
const H12 = "[0-9a-f]{12}";

function runHook(input: string, env: Record<string, string | undefined>) {
  return spawnSync("python3", [HOOK], { input, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
}

function captureOf(payloads: string[], extraEnv: Record<string, string> = {}): { home: string; file: string; body: string } {
  const home = mkdtempSync(join(tmpdir(), "cwh-probe-"));
  for (const p of payloads) {
    const r = runHook(p, { HOME: home, ...CLOUD, ...extraEnv });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  }
  const file = join(home, "cwh-cloud-probe/capture.jsonl");
  return { home, file, body: existsSync(file) ? readFileSync(file, "utf8") : "" };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A download folder as the README leaves it: export.jsonl and export.sha256, and nothing else. */
function downloads(body: string, hashLine = `${sha(body)}  /home/claude/export.jsonl\n`): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-probe-dl-"));
  writeFileSync(join(dir, "export.jsonl"), body);
  writeFileSync(join(dir, "export.sha256"), hashLine);
  return dir;
}

function verify(probe: string, dir: string, lines?: string) {
  return spawnSync("python3", [VERIFY, "--probe", probe, dir, ...(lines === undefined ? [] : [lines])], { encoding: "utf8" });
}

const recsOf = (body: string) =>
  body
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("cloud probe kit: capture hook", () => {
  it("records every payload as shape only — no hazard value reaches the capture", () => {
    const { body: cap, home } = captureOf(PAYLOADS);
    expect(cap.trim().split("\n")).toHaveLength(PAYLOADS.length);
    for (const h of HAZARDS) expect(cap.includes(h), `leaked: ${h}`).toBe(false);
    const recs = recsOf(cap);
    expect(recs[0].tool).toBe("mcp__remote-devices__device_bash");
    expect(recs[0].input_keys).toEqual(["command", "timeout_ms"]);
    expect(recs[0].permission_mode).toBe("auto");
    expect(recs[1].response_exit_code).toBe(1);
    expect(recs[1].response_is_error).toBe(true);
    expect(recs[3].cwd).toBe("<other>");
    expect(recs[4].tool).toMatch(new RegExp(`^mcp__<srv:${H12}>__<tool:${H12}>$`));
    expect(recs[5].tool).toMatch(new RegExp(`^mcp__remote-devices__<srv:${H12}>__<tool:${H12}>$`));
    expect(recs[7].permission_mode).toBe("<other-or-absent>");
    // no timestamps: a time is not needed to read a capture, and must not reach anything committed
    for (const r of recs) expect(r).not.toHaveProperty("ts");
    // the salt stays beside the capture and never inside it
    const salt = readFileSync(join(home, "cwh-cloud-probe/.salt"));
    expect(salt).toHaveLength(32);
    expect(cap.includes(salt.toString("hex"))).toBe(false);
    const v = verify("p0", downloads(cap));
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout).ok).toBe(true);
  });

  it("keeps input field names only for builtins and the device tools; fingerprints the rest", () => {
    const recs = recsOf(captureOf(PAYLOADS).body);
    // a connector's schema keys reveal its category ("to"/"subject"/"body" is an email send)
    expect(recs[4].input_keys.length).toBeGreaterThan(0);
    for (const k of recs[4].input_keys) expect(k).toMatch(new RegExp(`^<key:${H12}>$`));
    // a private MCP input keyed by client names
    for (const k of recs[9].input_keys) expect(k).toMatch(new RegExp(`^<key:${H12}>$`));
    // a builtin keeps its schema keys
    expect(recs[6].tool).toBe("Bash");
    expect(recs[6].input_keys).toEqual(["command"]);
  });

  it("caps input keys at 40 and records how many there were", () => {
    const input = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Client${i}Fund`, i]));
    const rec = recsOf(captureOf([JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__x__y", tool_input: input })]).body)[0];
    expect(rec.input_keys).toHaveLength(40);
    expect(rec.input_key_count).toBe(60);
    for (const k of rec.input_keys) expect(k).toMatch(new RegExp(`^<key:${H12}>$`));
  });

  it("fingerprints a tool name that is not on the builtin or cowork allowlist, even if it looks like one", () => {
    const names = ["AcmeCapitalCRM", "Gmail", "mcp__cowork__secret_export"];
    const tools = recsOf(
      captureOf(names.map((n) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: n, tool_input: {} }))).body,
    ).map((r) => r.tool);
    expect(tools[0]).toMatch(new RegExp(`^<tool:${H12}>$`));
    expect(tools[1]).toMatch(new RegExp(`^<tool:${H12}>$`));
    expect(tools[2]).toMatch(new RegExp(`^mcp__cowork__<tool:${H12}>$`));
    const kept = ["Bash", "ToolSearch", "mcp__cowork__present_files"];
    expect(
      recsOf(captureOf(kept.map((n) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: n, tool_input: {} }))).body).map(
        (r) => r.tool,
      ),
    ).toEqual(kept);
  });

  it("buckets string lengths, so a device name or a home directory's length does not identify it", () => {
    const resp = {
      content: [{ type: "text", text: JSON.stringify({ deviceName: "Alice-MacBook-Pro" }) }],
      structuredContent: { deviceName: "Alice-MacBook-Pro" },
    };
    const rec = recsOf(
      captureOf([
        JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "mcp__remote-devices__get_device_info",
          tool_input: {},
          tool_response: resp,
        }),
      ]).body,
    )[0];
    expect(JSON.stringify(rec.response_shape)).toContain('"deviceName":{"str_le":32}');
    expect(rec.response_text_chars_le).toBe(64);
    expect(rec).not.toHaveProperty("response_text_chars");
  });

  it("salts fingerprints per capture: the same connector name hashes differently in two captures", () => {
    const a = JSON.parse(captureOf([PAYLOADS[4]]).body.trim());
    const b = JSON.parse(captureOf([PAYLOADS[4]]).body.trim());
    expect(a.tool).toMatch(/^mcp__<srv:/);
    expect(a.tool).not.toBe(b.tool);
    // the unsalted (dictionary-recoverable) fingerprint of the server name is not what is written
    expect(a.tool.includes(sha("Gmail").slice(0, 12))).toBe(false);
  });

  it("keeps product tool vocabulary verbatim: internal__ spellings, computer use and the browser group", () => {
    const names = [
      "internal__remote-devices__device_bash",
      "mcp__remote-devices__computer_screenshot",
      "mcp__remote-devices__Claude_Browser__navigate",
    ];
    expect(
      recsOf(captureOf(names.map((n) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: n, tool_input: {} }))).body).map(
        (r) => r.tool,
      ),
    ).toEqual(names);
  });

  it("is inert outside a Desktop cloud task: needs CLAUDE_CODE_REMOTE=true AND CLAUDE_CODE_ENTRYPOINT=remote_cowork", () => {
    for (const env of [
      {},
      { CLAUDE_CODE_REMOTE: "1", CLAUDE_CODE_ENTRYPOINT: "remote_cowork" },
      { CLAUDE_CODE_REMOTE: "true" },
      { CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_ENTRYPOINT: "cli" },
      { CLAUDE_CODE_ENTRYPOINT: "remote_cowork" },
    ]) {
      const home = mkdtempSync(join(tmpdir(), "cwh-probe-"));
      const r = runHook(PAYLOADS[0], { HOME: home, ...env });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(existsSync(join(home, "cwh-cloud-probe")), JSON.stringify(env)).toBe(false);
    }
  });

  it("records a failure as a <hook-error> line with only the exception class, and never fails the tool call", () => {
    const recs = recsOf(captureOf(["not json", "[1,2]", ""]).body);
    expect(recs.map((r) => r.event)).toEqual(["<hook-error>", "<hook-error>", "<hook-error>"]);
    for (const r of recs) expect(Object.keys(r).sort()).toEqual(["error", "event", "v"]);
  });

  it("keeps the (redacted) tool name on an oversize record", () => {
    const big = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "mcp__remote-devices__device_bash",
      tool_response: { content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024 + 10) }] },
    });
    const rec = JSON.parse(captureOf([big]).body.trim());
    expect(rec.event).toBe("<oversize>");
    expect(rec.tool).toBe("mcp__remote-devices__device_bash");
  });
});

describe("cloud probe kit: a failed tool call (PostToolUseFailure)", () => {
  // A failed call reaches PostToolUseFailure, not PostToolUse, so without it a failing command's result shape and exit
  // code are never seen. Its `error` is free text (a device_bash failure carries the command's own output: paths, file
  // names, whatever the command printed), so only its size class, a salted fingerprint and a leading exit code are kept.
  const failures = PAYLOADS.filter((p) => JSON.parse(p).hook_event_name === "PostToolUseFailure");

  it("records a failure as shape only: no hazard from the error text or the input reaches the capture", () => {
    expect(failures).toHaveLength(2);
    const cap = captureOf(failures).body;
    for (const h of HAZARDS) expect(cap.includes(h), `leaked: ${h}`).toBe(false);
    const [dev, conn] = recsOf(cap);
    expect(dev).toMatchObject({
      event: "PostToolUseFailure",
      tool: "mcp__remote-devices__device_bash",
      input_keys: ["command"],
      permission_mode: "acceptEdits",
      failure_exit_code: 1,
      failure_is_interrupt: false,
      failure_duration_ms_le: 2048,
      failure_text_chars_le: 256,
    });
    expect(dev.failure_shape).toEqual({ str_le: 256 });
    expect(dev.failure_text_sha12).toMatch(new RegExp(`^${H12}$`));
    expect(conn.tool).toMatch(new RegExp(`^mcp__<srv:${H12}>__<tool:${H12}>$`));
    expect(conn.failure_is_interrupt).toBe(true);
    expect(conn).not.toHaveProperty("failure_exit_code");
    expect(JSON.stringify(conn.failure_shape)).toMatch(/^\{"dict":\{"code":\{"str_le":\d+\},"message":\{"str_le":\d+\}\}\}$/);
  });

  it("the verifier accepts a failure capture, and --probe p0f needs a device-tool failure (else exit 4)", () => {
    const body = captureOf(failures).body;
    const v = verify("p0f", downloads(body));
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout).events.PostToolUseFailure).toBe(2);
    expect(verify("p0", downloads(body)).status).toBe(4);
    expect(verify("p0f", downloads(captureOf([failures[1]]).body)).status).toBe(4);
    expect(verify("p0f", downloads(captureOf(PAYLOADS.slice(0, 10)).body)).status).toBe(4);
  });

  it("the verifier rejects a failure line carrying a value (exit 2)", () => {
    const clean = captureOf(failures).body;
    for (const tamper of [
      { failure_text: "Exit code 1 cat: /Users/alice" },
      { failure_exit_code: "1" },
      { failure_is_interrupt: "no" },
      { failure_duration_ms_le: 1234 },
      { failure_text_chars_le: 100 },
      { failure_text_sha12: "/Users/alice" },
      { failure_shape: { dict: { "/Users/alice": "null" } } },
      { failure_exit_code: 1, event: "PostToolUse" },
    ]) {
      const lines = clean.trim().split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), ...tamper });
      expect(verify("p0f", downloads(lines.join("\n") + "\n")).status, JSON.stringify(tamper)).toBe(2);
    }
  });
});

describe("cloud probe kit: re-review findings", () => {
  it("a bridged private server that looks like the computer-use or browser group is fingerprinted, input keys included", () => {
    const names = ["mcp__remote-devices__computer_vision__find_faces", "mcp__remote-devices__Claude_Browser__AcmeCapitalPortal"];
    const { body } = captureOf(
      names.map((n) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: n, tool_input: { AcmeCapital: 1 } })),
    );
    for (const h of ["computer_vision", "find_faces", "AcmeCapitalPortal", "AcmeCapital"]) expect(body.includes(h), h).toBe(false);
    for (const r of recsOf(body)) expect(r.tool).toMatch(new RegExp(`^mcp__remote-devices__<srv:${H12}>__<tool:${H12}>$`));
    // and the verifier refuses either name written verbatim
    const lines = captureOf(PAYLOADS).body.trim().split("\n");
    for (const n of names) {
      const t = [...lines];
      t[0] = JSON.stringify({ ...JSON.parse(t[0]), tool: n });
      expect(verify("p0", downloads(t.join("\n") + "\n")).status, n).toBe(2);
    }
  });

  it("a vocabulary tool's input key that is not a plain identifier is fingerprinted, never dropped", () => {
    const rec = recsOf(
      captureOf([
        JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "x", "Q3 forecast.xlsx": 1 } }),
      ]).body,
    )[0];
    expect(rec.input_keys).toHaveLength(2);
    expect(rec.input_keys).toContain("file_path");
    expect(rec.input_keys.some((k: string) => new RegExp(`^<key:${H12}>$`).test(k))).toBe(true);
    expect(JSON.stringify(rec)).not.toContain("forecast");
  });

  it("export.sha256 must be one line, at most 200 bytes, with exactly one 64-hex run, and not a symlink", () => {
    const { body } = captureOf(PAYLOADS);
    const h = sha(body);
    expect(verify("p0", downloads(body, `${h}  /home/claude/export.jsonl\n${"b".repeat(64)}\n`)).status).toBe(2); // a salt appended
    expect(verify("p0", downloads(body, `${"c".repeat(64)} ${h}\n`)).status).toBe(2); // junk before it
    expect(verify("p0", downloads(body, `${h} ${"x".repeat(300)}\n`)).status).toBe(2); // oversize
    const dir = downloads(body);
    const real = join(mkdtempSync(join(tmpdir(), "cwh-probe-elsewhere-")), "hash");
    writeFileSync(real, `${h}\n`);
    rmSync(join(dir, "export.sha256"));
    symlinkSync(real, join(dir, "export.sha256"));
    expect(verify("p0", dir).status).toBe(2);
  });

  it("a Finder .DS_Store in the download folder is ignored, not a void", () => {
    const { body } = captureOf(PAYLOADS);
    const dir = downloads(body);
    writeFileSync(join(dir, ".DS_Store"), "finder");
    expect(verify("p0", dir).status).toBe(0);
  });

  it("the export step removes the salt even without shred, and says output without both lines is void", () => {
    const readme = readFileSync(join(KIT, "README.md"), "utf8");
    expect(readme).toContain("shred -u /root/cwh-cloud-probe/.salt 2>/dev/null || rm -f /root/cwh-cloud-probe/.salt");
    expect(readme).toMatch(/without both lines[^.]*void/i);
  });
});

describe("cloud probe kit: verifier", () => {
  it("accepts the hash file however the hash is written: bare, sha256:-prefixed or back-ticked", () => {
    const { body } = captureOf(PAYLOADS);
    const h = sha(body);
    for (const line of [`${h}  /home/claude/export.jsonl\n`, `sha256:${h}\n`, "`" + h + "`\n"])
      expect(verify("p0", downloads(body, line)).status, line).toBe(0);
  });

  it("rejects a checksum or a line count that is not the one printed in the transcript (exit 1)", () => {
    const { body } = captureOf(PAYLOADS);
    expect(verify("p0", downloads(body, "0".repeat(64) + "\n")).status).toBe(1);
    const n = body.trim().split("\n").length;
    expect(verify("p0", downloads(body), `${n} /home/claude/export.jsonl`).status).toBe(0);
    expect(verify("p0", downloads(body), `${n + 1} /home/claude/export.jsonl`).status).toBe(1);
  });

  it("passes a capture with a device result, a hook error and an oversize line (exit 0, hook_errors 1)", () => {
    const big = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "mcp__remote-devices__device_bash",
      tool_response: { content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024 + 10) }] },
    });
    const { body } = captureOf([PAYLOADS[1], "not json", big]);
    const v = verify("p0", downloads(body));
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout).hook_errors).toBe(1);
  });

  it("voids the download if anything but the two export files is there: the salt, a stray file, a 64-hex string (exit 2)", () => {
    const { body, home } = captureOf(PAYLOADS);
    const withSalt = downloads(body);
    writeFileSync(join(withSalt, ".salt"), readFileSync(join(home, "cwh-cloud-probe/.salt")));
    expect(verify("p0", withSalt).status).toBe(2);
    const stray = downloads(body);
    writeFileSync(join(stray, "notes.txt"), "x");
    expect(verify("p0", stray).status).toBe(2);
    const lines = body.trim().split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), response_text_sha12: "a".repeat(64) });
    const hexBody = lines.join("\n") + "\n";
    expect(verify("p0", downloads(hexBody)).status).toBe(2);
  });

  it("is a usage error (exit 3) without the hash file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-probe-dl-"));
    writeFileSync(join(dir, "export.jsonl"), "");
    expect(verify("p0", dir).status).toBe(3);
  });

  it("rejects a line carrying a value even when the checksum matches (exit 2)", () => {
    const { body: clean } = captureOf(PAYLOADS);
    for (const [index, tamper] of [
      [0, { cwd: "/Users/alice/Documents" }],
      [0, { tool: "mcp__Gmail__send_email" }],
      [0, { tool: "AcmeCapitalCRM" }],
      [0, { tool: "mcp__cowork__secret_export" }],
      [0, { command: "cat /etc/passwd" }],
      [0, { input_keys: ["/Users/alice"] }],
      // a connector's line with verbatim (not fingerprinted) input keys
      [4, { input_keys: ["body", "subject", "to"] }],
      [0, { input_keys: Array.from({ length: 41 }, (_, i) => `k${i}`) }],
      [0, { response_shape: { dict: { "/Users/alice": "null" } } }],
      [1, { response_shape: { str: 17 } }],
      [0, { ts: 1760000000 }],
      [0, { error: "/Users/alice" }],
    ] as const) {
      const lines = clean.trim().split("\n");
      lines[index] = JSON.stringify({ ...JSON.parse(lines[index]), ...tamper });
      const body = lines.join("\n") + "\n";
      expect(verify("p0", downloads(body)).status, JSON.stringify(tamper)).toBe(2);
    }
  });

  it("voids a capture that cannot answer its probe (exit 4): empty, PreToolUse-only, hook errors only, no recognised mode", () => {
    const pre = PAYLOADS.filter((p) => JSON.parse(p).hook_event_name === "PreToolUse");
    for (const [probe, payloads] of [
      ["p0", pre],
      ["p0", ["not json"]],
      ["p6", ["not json"]],
    ] as const) {
      const { body } = captureOf(payloads as string[]);
      expect(verify(probe, downloads(body)).status, `${probe} ${payloads.length}`).toBe(4);
    }
    expect(verify("p0", downloads("")).status).toBe(4);
    expect(verify("p6", downloads("")).status).toBe(4);
    const noMode = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, permission_mode: "weirdMode" });
    expect(verify("p6", downloads(captureOf([noMode]).body)).status).toBe(4);
  });
});

describe("cloud probe kit: plugin layout", () => {
  it("wires PreToolUse, PostToolUse and PostToolUseFailure (matcher .*) in hooks/hooks.json only, to a capture hook that exists", () => {
    const m = JSON.parse(readFileSync(join(KIT, "plugin/.claude-plugin/plugin.json"), "utf8"));
    expect(m.hooks).toBeUndefined();
    const h = JSON.parse(readFileSync(join(KIT, "plugin/hooks/hooks.json"), "utf8"));
    for (const ev of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      expect(h.hooks[ev][0].matcher).toBe(".*");
      expect(h.hooks[ev][0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/capture.py");
    }
    expect(existsSync(HOOK)).toBe(true);
  });

  it("the repo ignores what a sitting downloads", () => {
    const ignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    for (const p of ["export.jsonl", "export.sha256", "cwh-cloud-probe*"]) expect(ignore, p).toContain(p);
  });
});

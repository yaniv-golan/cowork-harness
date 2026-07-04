import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  parseSessionFile,
  parseScenarioFile,
  scanEvents,
  parseDialogTimeout,
  slugForPath,
  isOutputsDelete,
  collectArtifacts,
  readSessionManifest,
  parseEnvPort,
} from "../src/run/execute.js";
import { loadSession, resolveSessionPaths } from "../src/session.js";
import { spawnEnv, hostNativeSpawnEnv } from "../src/runtime/argv.js";
import { loadBaseline } from "../src/baseline.js";

describe("slugForPath keeps the run dir inside runs/", () => {
  it("neutralizes traversal and separators, preserves normal names", () => {
    expect(slugForPath("skill-my-skill")).toBe("skill-my-skill"); // normal name unchanged
    expect(slugForPath("v1.2.0")).toBe("v1.2.0"); // single dots kept
    expect(slugForPath("../x")).not.toContain("/"); // no separator survives
    expect(slugForPath("../x")).not.toContain(".."); // no parent-traversal survives
    expect(slugForPath("a/b/c")).toBe("a-b-c"); // separators flattened
    expect(slugForPath("")).toBe("scenario"); // never empty
  });
});

// Regression guard for the `run <scenario>` path: parseSessionFile must parse a YAML session
// file in this ESM package (an earlier `require("yaml")` here threw `require is not defined`
// and crashed every file-based `run` before any spawn). Token-free, no Docker.
describe("execute — parseSessionFile (run path, ESM-safe)", () => {
  it("parses a real YAML session file and loadSession accepts it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-sess-"));
    const f = join(dir, "s.yaml");
    writeFileSync(f, "model: claude-opus-4-8\negress:\n  extra_allow: [api.github.com]\n");
    const parsed = parseSessionFile(f) as Record<string, unknown>;
    expect(parsed.model).toBe("claude-opus-4-8");
    const session = loadSession(parsed);
    expect(session.model).toBe("claude-opus-4-8");
    expect(session.egress.extra_allow).toContain("api.github.com");
  });

  it("returns an inline stub for the (inline) sentinel", () => {
    expect(parseSessionFile("(inline)")).toEqual({});
  });
});

// Relocatable bundles: a scenario's `session:` resolves relative to the SCENARIO file, and a
// session's host paths resolve relative to the SESSION file — so `run` works from any cwd.
describe("execute — file-relative path resolution", () => {
  it("parseScenarioFile resolves session: relative to the scenario file's dir", () => {
    const root = mkdtempSync(join(tmpdir(), "cowork-bundle-"));
    mkdirSync(join(root, "scenarios"));
    mkdirSync(join(root, "sessions"));
    writeFileSync(join(root, "sessions", "s.yaml"), "permission_mode: default\n");
    writeFileSync(
      join(root, "scenarios", "c.yaml"),
      "name: c\nbaseline: latest\nsession: ../sessions/s.yaml\nfidelity: container\nprompt: hi\n",
    );
    const scenario = parseScenarioFile(join(root, "scenarios", "c.yaml"));
    // sibling ../sessions/s.yaml resolved to an absolute path under the SAME bundle root
    expect(isAbsolute(scenario.session)).toBe(true);
    expect(scenario.session).toBe(join(root, "sessions", "s.yaml"));
  });

  it("rejects an authored `replay_protocol_fidelity` assertion (synthesized by the replay lane only)", () => {
    const root = mkdtempSync(join(tmpdir(), "cowork-rpf-"));
    writeFileSync(
      join(root, "bad.yaml"),
      "name: bad\nbaseline: latest\nsession: (inline)\nfidelity: protocol\nprompt: hi\nassert:\n  - replay_protocol_fidelity: true\n",
    );
    expect(() => parseScenarioFile(join(root, "bad.yaml"))).toThrow(/replay_protocol_fidelity/);
  });

  it("defaults a scenario's name to its filename (sans extension) when omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "cowork-name-"));
    writeFileSync(join(root, "my-test.yaml"), "baseline: latest\nsession: (inline)\nfidelity: protocol\nprompt: hi\n");
    expect(parseScenarioFile(join(root, "my-test.yaml")).name).toBe("my-test");
    writeFileSync(join(root, "named.yaml"), "name: explicit\nsession: (inline)\nfidelity: protocol\nprompt: hi\n");
    expect(parseScenarioFile(join(root, "named.yaml")).name).toBe("explicit"); // explicit override wins
  });

  it("resolveSessionPaths anchors relative host paths to the session dir; leaves ~ and absolute alone", () => {
    const base = "/bundle/sessions";
    const session = loadSession({
      uploads: ["../data/x.csv"],
      plugins: { local_plugins: ["../skills/my-skill"], config_dir: "~/.claude" },
      folders: [{ from: "/abs/proj" }],
    });
    const r = resolveSessionPaths(session, base);
    expect(r.uploads[0]).toBe("/bundle/data/x.csv");
    expect(r.plugins.local_plugins[0]).toBe("/bundle/skills/my-skill");
    expect(r.plugins.config_dir).toBe("~/.claude"); // ~ untouched
    expect(r.folders[0].from).toBe("/abs/proj"); // absolute untouched
  });
});

// regression guard — env-channel race: spawnEnv must use the explicit proxyHost arg, not
// process.env.COWORK_EGRESS_PROXY; the calling layer (execute.ts/chat.ts) must NOT mutate
// process.env. We test via the pure contract layer (spawnEnv in argv.ts) which is what
// container.ts/hostloop.ts now delegate to with the explicit opts value.
describe("execute — no process.env mutation for egress proxy/network", () => {
  it("spawnEnv uses the explicit proxyHost arg (not process.env) so proxy is concurrency-safe", () => {
    const baseline = loadBaseline("desktop-1.12603.1");
    const configGuest = "/sessions/TEST/mnt/.claude";
    const explicitProxy = "http://cowork-proxy-testrun-abc:8080";

    // Save any existing env value and set a DIFFERENT sentinel so we can detect if the old path
    // (reading process.env inside spawnEnv) were taken.
    const savedProxy = process.env.COWORK_EGRESS_PROXY;
    process.env.COWORK_EGRESS_PROXY = "http://WRONG-from-process-env:8080";
    try {
      const env = spawnEnv(baseline, { configGuest, proxyHost: explicitProxy });
      // The explicit arg must win — not the process.env sentinel
      expect(env.HTTP_PROXY).toBe(explicitProxy);
      expect(env.HTTPS_PROXY).toBe(explicitProxy);
      expect(env.http_proxy).toBe(explicitProxy);
      expect(env.https_proxy).toBe(explicitProxy);
      // Confirm the process.env sentinel was NOT used
      expect(env.HTTP_PROXY).not.toBe("http://WRONG-from-process-env:8080");
    } finally {
      if (savedProxy === undefined) delete process.env.COWORK_EGRESS_PROXY;
      else process.env.COWORK_EGRESS_PROXY = savedProxy;
    }
  });

  it("process.env.COWORK_EGRESS_PROXY / COWORK_DOCKER_NETWORK are not set by the execute.ts contract layer", () => {
    // Verify that the module-level code in execute.ts (imported above) does not assign these
    // at import time, and that calling the pure helpers does not touch the env.
    const beforeProxy = process.env.COWORK_EGRESS_PROXY;
    const beforeNet = process.env.COWORK_DOCKER_NETWORK;

    // Call parseSessionFile (the only non-side-effecting execute export) to exercise the module
    expect(parseSessionFile("(inline)")).toEqual({});

    expect(process.env.COWORK_EGRESS_PROXY).toBe(beforeProxy);
    expect(process.env.COWORK_DOCKER_NETWORK).toBe(beforeNet);
  });
});

// Readiness item C5 — pin the exact host-identity env vars binary-verified as faithfully derivable
// headless (docs/cowork-spawn-contract-1.12603.1.md). CLAUDE_CODE_HOST_PLATFORM is emitted at BOTH
// the container/microvm seam (spawnEnv) and the hostloop seam (hostNativeSpawnEnv);
// CLAUDE_CODE_WORKSPACE_HOST_PATHS is hostloop-only and only when connected folders are present —
// container/microvm stage folders as copies with no real host path to disclose. The account-identity
// (CLAUDE_CODE_ACCOUNT_UUID/_USER_EMAIL/_ORGANIZATION_UUID) and OTEL_* vars require live Desktop
// state the harness never has, and must stay absent — a drift toward fabricating them should fail loud.
describe("execute — C5 host-identity env vars (spawnEnv / hostNativeSpawnEnv)", () => {
  const baseline = loadBaseline("desktop-1.12603.1");
  const NOT_EMITTED = [
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_METRICS_EXPORTER",
  ];

  it("spawnEnv (container/microvm) emits CLAUDE_CODE_HOST_PLATFORM and none of the unknowable identity vars", () => {
    const env = spawnEnv(baseline, { configGuest: "/sessions/TEST/mnt/.claude", proxyHost: "http://proxy:8080" });
    expect(env.CLAUDE_CODE_HOST_PLATFORM).toBe(process.platform);
    expect(env.CLAUDE_CODE_WORKSPACE_HOST_PATHS).toBeUndefined(); // no real host paths at this tier — folders are staged copies
    for (const key of NOT_EMITTED) expect(env[key]).toBeUndefined();
  });

  it("spawnEnv: an explicit extra value for CLAUDE_CODE_HOST_PLATFORM still wins (extra is the outermost spread)", () => {
    const env = spawnEnv(baseline, {
      configGuest: "/sessions/TEST/mnt/.claude",
      proxyHost: "http://proxy:8080",
      extra: { CLAUDE_CODE_HOST_PLATFORM: "custom-override" },
    });
    expect(env.CLAUDE_CODE_HOST_PLATFORM).toBe("custom-override");
  });

  it("hostNativeSpawnEnv emits CLAUDE_CODE_HOST_PLATFORM but omits WORKSPACE_HOST_PATHS with no connected folders", () => {
    const env = hostNativeSpawnEnv(baseline, { configDir: "/HOST/CFG" });
    expect(env.CLAUDE_CODE_HOST_PLATFORM).toBe(process.platform);
    expect(env.CLAUDE_CODE_WORKSPACE_HOST_PATHS).toBeUndefined();
    for (const key of NOT_EMITTED) expect(env[key]).toBeUndefined();
  });

  it("hostNativeSpawnEnv: an empty folderHostPaths array also omits WORKSPACE_HOST_PATHS (presence-guarded, like production)", () => {
    const env = hostNativeSpawnEnv(baseline, { configDir: "/HOST/CFG", folderHostPaths: [] });
    expect(env.CLAUDE_CODE_WORKSPACE_HOST_PATHS).toBeUndefined();
  });

  it("hostNativeSpawnEnv joins connected folders' real host paths with '|' when present", () => {
    const env = hostNativeSpawnEnv(baseline, {
      configDir: "/HOST/CFG",
      folderHostPaths: ["/Users/dev/project-a", "/Users/dev/project-b"],
    });
    expect(env.CLAUDE_CODE_HOST_PLATFORM).toBe(process.platform);
    expect(env.CLAUDE_CODE_WORKSPACE_HOST_PATHS).toBe("/Users/dev/project-a|/Users/dev/project-b");
  });

  it("hostNativeSpawnEnv: an explicit extra value for either new key still wins over the computed value", () => {
    const env = hostNativeSpawnEnv(baseline, {
      configDir: "/HOST/CFG",
      folderHostPaths: ["/Users/dev/project-a"],
      extra: { CLAUDE_CODE_HOST_PLATFORM: "custom-override", CLAUDE_CODE_WORKSPACE_HOST_PATHS: "custom|paths" },
    });
    expect(env.CLAUDE_CODE_HOST_PLATFORM).toBe("custom-override");
    expect(env.CLAUDE_CODE_WORKSPACE_HOST_PATHS).toBe("custom|paths");
  });
});

describe("execute — scanEvents host-path leak detection", () => {
  const writeEvents = (lines: object[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-scan-"));
    const f = join(dir, "events.jsonl");
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
    return f;
  };

  it("trips hostPathLeaked on a host path inside a tool_result (Bash output), not just assistant text", () => {
    const f = writeEvents([
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pwd" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "/Users/yaniv/secret/path" }] }] } },
    ]);
    expect(scanEvents(f).hostPathLeaked).toBe(true);
  });

  it("trips hostPathLeaked on a string-form tool_result content", () => {
    const f = writeEvents([{ type: "user", message: { content: [{ type: "tool_result", content: "ran in /opt/cowork/work" }] } }]);
    expect(scanEvents(f).hostPathLeaked).toBe(true);
  });

  it("does not trip on clean output", () => {
    const f = writeEvents([
      { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "/sessions/x/mnt/outputs/ok" }] }] } },
    ]);
    expect(scanEvents(f).hostPathLeaked).toBe(false);
  });

  it("trips on a host path that appears ONLY in a thinking block", () => {
    const f = writeEvents([
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "the file is at /Users/yaniv/secret" }] } },
    ]);
    expect(scanEvents(f).hostPathLeaked).toBe(true);
  });

  it("trips on a host path in a standalone system message", () => {
    const f = writeEvents([{ type: "system", content: "cwd is /home/agent/work but host is /Users/yaniv" }]);
    expect(scanEvents(f).hostPathLeaked).toBe(true);
  });

  // backstop: outputs-delete detection must cover BOTH bash surfaces — native `Bash`
  // (container/microvm) AND `mcp__workspace__bash` (host-loop), where native Bash is disabled.
  it("catches an outputs delete via native Bash", () => {
    const f = writeEvents([
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rm mnt/outputs/a.md" } }] } },
    ]);
    expect(scanEvents(f).outputsDeletes.length).toBe(1);
  });

  it("catches an outputs delete via mcp__workspace__bash (host-loop) — not just native Bash", () => {
    const f = writeEvents([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "mcp__workspace__bash", input: { command: "rm outputs/draft.txt" } }] },
      },
    ]);
    expect(scanEvents(f).outputsDeletes.length).toBe(1);
  });
});

// outputs-delete detector: mv-direction (default) + opt-in /tmp suppression
describe("isOutputsDelete — mv direction + opt-in safe-prefix suppression", () => {
  const setEnv = (v?: string) => {
    if (v === undefined) delete process.env.COWORK_HARNESS_SAFE_STAGING_PREFIX;
    else process.env.COWORK_HARNESS_SAFE_STAGING_PREFIX = v;
  };
  afterEach(() => setEnv(undefined));

  it("mv: standalone move INTO outputs is not a delete", () => {
    expect(isOutputsDelete("mv tmp/x outputs/x")).toBe(false);
  });
  it("mv: move OUT of outputs is a delete", () => {
    expect(isOutputsDelete("mv outputs/x tmp/x")).toBe(true);
  });
  it("mv: dst MENTIONS but is not UNDER outputs → still a delete (UNDER_OUTPUTS fix)", () => {
    expect(isOutputsDelete('mv outputs/a "/tmp/outputs-backup/a"')).toBe(true);
  });
  it("mv: ambiguous -t mentioning outputs → conservative flag", () => {
    expect(isOutputsDelete("mv -t /tmp outputs/a outputs/b")).toBe(true);
  });

  it("default (no env): flags every rm co-occurrence", () => {
    expect(isOutputsDelete("rm -rf /tmp/s.* ; cat outputs/y")).toBe(true);
    expect(isOutputsDelete("rm mnt/outputs/a.md")).toBe(true);
    expect(isOutputsDelete("cd outputs && rm -rf *")).toBe(true);
  });
  it("mv INTO outputs co-located with an unrelated rm/tmp still flags by the rm default", () => {
    expect(isOutputsDelete("mv tmp/x outputs/x && rm /tmp/y")).toBe(true);
  });

  it("opt-in (/tmp): suppresses provably-safe staging cleanups", () => {
    setEnv("/tmp");
    expect(isOutputsDelete("rm -rf /tmp/cap.staging.* ; cat /mnt/outputs/x.csv")).toBe(false);
    expect(isOutputsDelete('STAGING=/tmp/x.123 && cp "$STAGING/o.csv" mnt/outputs/o.csv && rm -rf "$STAGING"')).toBe(false);
  });
  it("opt-in (/tmp): STILL flags true positives", () => {
    setEnv("/tmp");
    expect(isOutputsDelete("rm mnt/outputs/a.md")).toBe(true);
    expect(isOutputsDelete("find outputs -delete")).toBe(true);
    expect(isOutputsDelete("cd outputs && rm -rf *")).toBe(true);
    expect(isOutputsDelete("rm -rf scratch/* && cp x mnt/outputs/y")).toBe(true);
    expect(isOutputsDelete('rm -rf "$UNDEFINED/data" ; cp a mnt/outputs/b')).toBe(true); // unresolved var
  });

  it("redirect truncation: a statement-leading bare `>` into outputs is a delete", () => {
    expect(isOutputsDelete("echo > outputs/report.json")).toBe(true);
    expect(isOutputsDelete("make && > outputs/report.json")).toBe(true);
    expect(isOutputsDelete("> outputs/report.json")).toBe(true);
    expect(isOutputsDelete("cat x.csv ; > outputs/data.csv")).toBe(true);
  });
  it("redirect truncation: a normal deliverable WRITE / append is NOT a delete", () => {
    expect(isOutputsDelete("jq '.' input.json > outputs/report.json")).toBe(false);
    expect(isOutputsDelete('echo "data" > outputs/report.json')).toBe(false);
    expect(isOutputsDelete("cmd >> outputs/log.txt")).toBe(false); // append, not truncate
    expect(isOutputsDelete("cmd &> outputs/log.txt")).toBe(false); // single & is not a boundary
  });

  it("mv N-ary: moving multiple files INTO outputs/ is not a delete", () => {
    expect(isOutputsDelete("mv a.pdf b.pdf outputs/")).toBe(false);
  });
  it("mv N-ary: moving multiple files OUT of outputs is a delete", () => {
    expect(isOutputsDelete("mv outputs/a.pdf outputs/b.pdf /tmp/")).toBe(true);
  });

  it("source-order expansion: a later reassignment does not mask an earlier outputs delete", () => {
    expect(isOutputsDelete('D=outputs; rm "$D/file.txt"; D=/sandbox; echo "$D"')).toBe(true);
  });
});

// dialog timeout parsing (pure function, token-free)
describe("execute — parseDialogTimeout", () => {
  it("returns Infinity for 'inf'", () => expect(parseDialogTimeout("inf")).toBe(Infinity));
  it("returns Infinity for 'infinite'", () => expect(parseDialogTimeout("infinite")).toBe(Infinity));
  it("returns Infinity for '-1'", () => expect(parseDialogTimeout("-1")).toBe(Infinity));
  it("returns Infinity for ' inf ' (trimmed)", () => expect(parseDialogTimeout(" inf ")).toBe(Infinity));
  it("returns the numeric value for a positive number", () => expect(parseDialogTimeout("5000")).toBe(5000));
  it("returns undefined for '0' (not > 0)", () => expect(parseDialogTimeout("0")).toBeUndefined());
  it("returns undefined for empty string", () => expect(parseDialogTimeout("")).toBeUndefined());
  it("returns undefined for absent (empty)", () => expect(parseDialogTimeout("")).toBeUndefined());
  // reject unsafe/invalid values
  it("throws for a decimal '1.5'", () => expect(() => parseDialogTimeout("1.5")).toThrow(/no decimals/));
  it("throws for 'NaN'", () => expect(() => parseDialogTimeout("NaN")).toThrow());
  it("throws for 'Infinity'", () => expect(() => parseDialogTimeout("Infinity")).toThrow());
  it("throws for a negative value '-5' (not the -1 sentinel)", () => expect(() => parseDialogTimeout("-5")).toThrow());
  it("throws for an overflow value beyond 3_600_000", () => expect(() => parseDialogTimeout("3600001")).toThrow(/exceeds maximum/));
  it("accepts the maximum allowed value 3_600_000", () => expect(parseDialogTimeout("3600000")).toBe(3_600_000));
  it("accepts 1 ms (minimum positive)", () => expect(parseDialogTimeout("1")).toBe(1));
});

// parseEnvPort (pure function, token-free)
describe("execute — parseEnvPort", () => {
  const setEnv = (v?: string) => {
    if (v === undefined) delete process.env.TEST_PORT_VAR;
    else process.env.TEST_PORT_VAR = v;
  };
  afterEach(() => setEnv(undefined));

  it("returns defaultValue when env var is absent", () => {
    setEnv(undefined);
    expect(parseEnvPort("TEST_PORT_VAR", 8899)).toBe(8899);
  });
  it("returns defaultValue when env var is empty", () => {
    setEnv("");
    expect(parseEnvPort("TEST_PORT_VAR", 8899)).toBe(8899);
  });
  it("accepts a valid port (1)", () => {
    setEnv("1");
    expect(parseEnvPort("TEST_PORT_VAR", 8899)).toBe(1);
  });
  it("accepts a valid port (65535)", () => {
    setEnv("65535");
    expect(parseEnvPort("TEST_PORT_VAR", 8899)).toBe(65535);
  });
  it("accepts a typical port (8080)", () => {
    setEnv("8080");
    expect(parseEnvPort("TEST_PORT_VAR", 8899)).toBe(8080);
  });
  it("throws for NaN", () => {
    setEnv("NaN");
    expect(() => parseEnvPort("TEST_PORT_VAR", 8899)).toThrow(/must be an integer in 1..65535/);
  });
  it("throws for 0", () => {
    setEnv("0");
    expect(() => parseEnvPort("TEST_PORT_VAR", 8899)).toThrow(/must be an integer in 1..65535/);
  });
  it("throws for a negative value", () => {
    setEnv("-1");
    expect(() => parseEnvPort("TEST_PORT_VAR", 8899)).toThrow(/must be an integer in 1..65535/);
  });
  it("throws for 65536 (out of range)", () => {
    setEnv("65536");
    expect(() => parseEnvPort("TEST_PORT_VAR", 8899)).toThrow(/must be an integer in 1..65535/);
  });
  it("throws for a decimal '8080.5'", () => {
    setEnv("8080.5");
    expect(() => parseEnvPort("TEST_PORT_VAR", 8899)).toThrow(/must be an integer in 1..65535/);
  });
});

// readSessionManifest session ID verification
describe("execute — readSessionManifest session ID mismatch", () => {
  const writeManifest = (content: object): string => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-manifest-"));
    const f = join(dir, "session.json");
    writeFileSync(f, JSON.stringify(content));
    return f;
  };

  it("returns agentSessionId when sessionId matches", () => {
    const f = writeManifest({ sessionId: "abc", agentSessionId: "uuid-123", createdAt: "2024-01-01T00:00:00.000Z" });
    expect(readSessionManifest(f, "abc")).toBe("uuid-123");
  });
  it("throws when manifest sessionId does not match the requested sessionId", () => {
    const f = writeManifest({ sessionId: "abc", agentSessionId: "uuid-123", createdAt: "2024-01-01T00:00:00.000Z" });
    expect(() => readSessionManifest(f, "xyz")).toThrow(/manifest session ID mismatch/);
    expect(() => readSessionManifest(f, "xyz")).toThrow(/abc/);
    expect(() => readSessionManifest(f, "xyz")).toThrow(/xyz/);
  });
  it("allows through a legacy manifest with no sessionId field (backward compat)", () => {
    const f = writeManifest({ agentSessionId: "uuid-legacy" });
    expect(readSessionManifest(f, "anyid")).toBe("uuid-legacy");
  });
  it("throws for corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-manifest-bad-"));
    const f = join(dir, "session.json");
    writeFileSync(f, "not json{{");
    expect(() => readSessionManifest(f, "abc")).toThrow(/corrupt manifest/);
  });
  it("throws when agentSessionId is missing", () => {
    const f = writeManifest({ sessionId: "abc" });
    expect(() => readSessionManifest(f, "abc")).toThrow(/missing agentSessionId/);
  });
});

// collectArtifacts must not follow symlinks (no escape out of workRoot, no cycle).
describe("collectArtifacts skips symlinks (lstat, no out-of-root follow, cycle-safe)", () => {
  it("records real files but skips a symlink that points OUT of workRoot", () => {
    const outside = mkdtempSync(join(tmpdir(), "cwh-outside-"));
    writeFileSync(join(outside, "secret.txt"), "OUT-OF-TREE SECRET");

    const root = mkdtempSync(join(tmpdir(), "cwh-b31-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "real.txt"), "hello");
    // a symlink under outputs/ pointing at a file OUTSIDE the work root
    symlinkSync(join(outside, "secret.txt"), join(root, "outputs", "escape.txt"));

    const got = collectArtifacts(root, ["outputs"]);
    const paths = got.map((g) => g.path);
    expect(paths).toContain("outputs/real.txt"); // the real file is recorded
    expect(paths).not.toContain("outputs/escape.txt"); // the symlink is NOT followed/recorded
  });

  it("skips a symlinked subdirectory (would otherwise follow into / cycle outside the tree)", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "cwh-outsidedir-"));
    writeFileSync(join(outsideDir, "leak.json"), "{}");

    const root = mkdtempSync(join(tmpdir(), "cwh-b31d-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "ok.json"), "{}");
    symlinkSync(outsideDir, join(root, "outputs", "linkdir")); // dir symlink out of tree

    const got = collectArtifacts(root, ["outputs"]);
    const paths = got.map((g) => g.path);
    expect(paths).toEqual(["outputs/ok.json"]); // only the real file; the symlinked dir is skipped
  });

  it("does not infinite-loop on a directory cycle (self-referential symlink)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-b31c-"));
    mkdirSync(join(root, "outputs", "a"), { recursive: true });
    writeFileSync(join(root, "outputs", "a", "f.txt"), "x");
    // a symlink that loops back to its own parent — must be skipped (it's a symlink) and never recurse
    symlinkSync(join(root, "outputs"), join(root, "outputs", "a", "loop"));
    const got = collectArtifacts(root, ["outputs"]);
    expect(got.map((g) => g.path)).toEqual(["outputs/a/f.txt"]); // terminates, records only the real file
  });

  // a HARDLINK to an out-of-root file reads as an ordinary regular file — the symlink and
  // realpath-containment guards CANNOT catch it (realpathSync of a hardlink returns the path unchanged
  // inside workRoot). It must be rejected via nlink > 1.
  it("rejects a hardlink into outputs/ that points at an out-of-root file (nlink > 1)", () => {
    const outside = mkdtempSync(join(tmpdir(), "cwh-hl-outside-"));
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "OUT-OF-TREE SECRET");

    const root = mkdtempSync(join(tmpdir(), "cwh-b25-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "real.txt"), "hello");
    // hardlink the out-of-root file INTO outputs/. realpathSync returns the in-root path unchanged
    // (a hardlink is a second inode name, not path indirection), so only nlink > 1 catches it.
    linkSync(outsideFile, join(root, "outputs", "hard.txt"));

    const got = collectArtifacts(root, ["outputs"]);
    const paths = got.map((g) => g.path);
    expect(paths).toContain("outputs/real.txt"); // the genuine single-link file is still recorded
    expect(paths).not.toContain("outputs/hard.txt"); // the hardlink (nlink=2) is rejected, not read
  });
});

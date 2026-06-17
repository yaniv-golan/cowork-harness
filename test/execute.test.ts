import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { parseSessionFile, parseScenarioFile, scanEvents, parseDialogTimeout, slugForPath, isOutputsDelete } from "../src/run/execute.js";
import { loadSession, resolveSessionPaths } from "../src/session.js";
import { spawnEnv } from "../src/runtime/argv.js";
import { loadBaseline } from "../src/baseline.js";

describe("#17 — slugForPath keeps the run dir inside runs/", () => {
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
      folders: [{ from: "/abs/proj", to: "p" }],
    });
    const r = resolveSessionPaths(session, base);
    expect(r.uploads[0]).toBe("/bundle/data/x.csv");
    expect(r.plugins.local_plugins[0]).toBe("/bundle/skills/my-skill");
    expect(r.plugins.config_dir).toBe("~/.claude"); // ~ untouched
    expect(r.folders[0].from).toBe("/abs/proj"); // absolute untouched
  });
});

// #43 regression guard — env-channel race: spawnEnv must use the explicit proxyHost arg, not
// process.env.COWORK_EGRESS_PROXY; the calling layer (execute.ts/chat.ts) must NOT mutate
// process.env. We test via the pure contract layer (spawnEnv in argv.ts) which is what
// container.ts/hostloop.ts now delegate to with the explicit opts value.
describe("execute — #43 no process.env mutation for egress proxy/network", () => {
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

describe("execute — scanEvents host-path leak detection (#32)", () => {
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

  // #9 backstop: outputs-delete detection must cover BOTH bash surfaces — native `Bash`
  // (container/microvm) AND `mcp__workspace__bash` (host-loop), where native Bash is disabled.
  it("catches an outputs delete via native Bash", () => {
    const f = writeEvents([
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rm mnt/outputs/a.md" } }] } },
    ]);
    expect(scanEvents(f).outputsDeletes.length).toBe(1);
  });

  it("#9: catches an outputs delete via mcp__workspace__bash (host-loop) — not just native Bash", () => {
    const f = writeEvents([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "mcp__workspace__bash", input: { command: "rm outputs/draft.txt" } }] },
      },
    ]);
    expect(scanEvents(f).outputsDeletes.length).toBe(1);
  });
});

// H-A — outputs-delete detector: mv-direction (default) + opt-in /tmp suppression
describe("isOutputsDelete — mv direction + opt-in safe-prefix suppression", () => {
  const setEnv = (v?: string) => {
    if (v === undefined) delete process.env.COWORK_HARNESS_SAFE_STAGING_PREFIX;
    else process.env.COWORK_HARNESS_SAFE_STAGING_PREFIX = v;
  };
  afterEach(() => setEnv(undefined));

  it("mv: standalone move INTO outputs is not a delete (Bug 34)", () => {
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
});

// #45 — dialog timeout parsing (pure function, token-free)
describe("execute — #45 parseDialogTimeout", () => {
  it("returns Infinity for 'inf'", () => expect(parseDialogTimeout("inf")).toBe(Infinity));
  it("returns Infinity for 'infinite'", () => expect(parseDialogTimeout("infinite")).toBe(Infinity));
  it("returns Infinity for '-1'", () => expect(parseDialogTimeout("-1")).toBe(Infinity));
  it("returns Infinity for ' inf ' (trimmed)", () => expect(parseDialogTimeout(" inf ")).toBe(Infinity));
  it("returns the numeric value for a positive number", () => expect(parseDialogTimeout("5000")).toBe(5000));
  it("returns undefined for '0' (not > 0)", () => expect(parseDialogTimeout("0")).toBeUndefined());
  it("returns undefined for empty string", () => expect(parseDialogTimeout("")).toBeUndefined());
  it("returns undefined for absent (empty)", () => expect(parseDialogTimeout("")).toBeUndefined());
});

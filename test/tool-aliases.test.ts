import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { baseAgentArgs } from "../src/runtime/argv.js";
import { loadBaseline } from "../src/baseline.js";
import { WORKSPACE_TOOL_ALIASES } from "../src/runtime/hostloop.js";
import { LiveAgentSession } from "../src/agent/session.js";
import type { LaunchPlan } from "../src/session.js";

const baseline = loadBaseline("latest");

function minimalPlan(over: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    configDir: "/HOST/CFG",
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    ...over,
  };
}

describe("toolAliases + bash-only pre-approval (production hostloop contract)", () => {
  it("the alias map is exactly the production pair", () => {
    expect(WORKSPACE_TOOL_ALIASES).toEqual({ Bash: "mcp__workspace__bash", WebFetch: "mcp__workspace__web_fetch" });
  });

  it("baseAgentArgs: extraAllowedTools decouples --allowedTools from --tools", () => {
    const args = baseAgentArgs(baseline, minimalPlan(), {
      mntRoot: "/m",
      extraTools: ["mcp__workspace__bash", "mcp__workspace__web_fetch"],
      extraAllowedTools: ["mcp__workspace__bash"],
    });
    const tools = args.slice(args.indexOf("--tools") + 1, args.indexOf("--allowedTools"));
    const allowed = args.slice(args.indexOf("--allowedTools") + 1);
    expect(tools).toContain("mcp__workspace__web_fetch");
    expect(allowed).toContain("mcp__workspace__bash");
    expect(allowed).not.toContain("mcp__workspace__web_fetch"); // production pre-approves bash ONLY
  });

  it("omitting extraAllowedTools pre-approves NOTHING extra (no hidden tools→allowedTools coupling)", () => {
    const args = baseAgentArgs(baseline, minimalPlan(), { mntRoot: "/m", extraTools: ["x"] });
    expect(args.slice(args.indexOf("--tools") + 1, args.indexOf("--allowedTools"))).toContain("x");
    expect(args.slice(args.indexOf("--allowedTools") + 1)).not.toContain("x");
  });
});

/** A minimal fake ChildProcessByStdio: EventEmitter + stdin/stdout/stderr PassThroughs (mirrors
 *  test/session-protocol.test.ts's pattern) — used to capture the `initialize` control_request's
 *  stdin frame (control-out.jsonl mirrors it verbatim) without spawning a real child. */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  return proc;
}

/** Poll a file until it contains `needle` (or the deadline passes) — mirrors
 *  test/session-protocol.test.ts's waitForFileContent (the pump()/write-callback confirmation lands a
 *  tick after init() returns, so a synchronous read can race an empty/missing file). */
async function waitForFileContent(path: string, needle: string, deadlineMs = 3000): Promise<string> {
  const end = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < end) {
    try {
      last = readFileSync(path, "utf8");
      if (last.includes(needle)) return last;
    } catch {
      /* file not written yet */
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return last;
}

/** Write `session.init(opts)` and read back the JSON-parsed `initialize` request body from
 *  control-out.jsonl (the mirrored driver→child frame). */
async function captureInitFrames(opts: Record<string, unknown>): Promise<{ request: Record<string, unknown> }[]> {
  const proc = fakeProc();
  const outDir = mkdtempSync(join(tmpdir(), "init-frame-"));
  const session = new LiveAgentSession(proc as any, outDir);
  proc.stdin.resume(); // drain writes (no real child reads them)
  session.init(opts as never);
  const path = join(outDir, "control-out.jsonl");
  const content = await waitForFileContent(path, "initialize");
  const lines = content.trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

describe("initialize control_request — toolAliases serialization", () => {
  it("carries toolAliases only when provided", async () => {
    const frames = await captureInitFrames({ toolAliases: WORKSPACE_TOOL_ALIASES });
    expect(frames[0].request.toolAliases).toEqual(WORKSPACE_TOOL_ALIASES);
    const bare = await captureInitFrames({});
    expect(bare[0].request.toolAliases).toBeUndefined();
  });
});

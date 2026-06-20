import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { loadBaseline } from "../src/baseline.js";
import { resolveAgentBinary } from "../src/baseline.js";

/**
 * Live contract tests — assert the real staged agent STILL behaves as the SPEC + the
 * golden snapshots assume (SPEC.md §8). These guard the binary-derived
 * facts that a Desktop update could silently break. Gated on Docker + the staged binary;
 * the token-requiring case additionally needs CLAUDE_CODE_OAUTH_TOKEN. Skips cleanly.
 *
 * Run in CI on `sync`, or locally: CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.cowork-harness-token) vitest run live-contract
 */

// F: derive agent path from the baseline so the suite doesn't silently self-skip when the Desktop
// binary advances (a hardcoded version would make binOk false → describe.skipIf skips the whole
// suite, self-disabling the binary-drift guard).
let AGENT: string;
try {
  AGENT = resolveAgentBinary(loadBaseline("latest"));
} catch {
  AGENT = ""; // baseline or binary missing — binOk will be false below
}

const IMAGE = "cowork-agent-base:2";
const dockerOk = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const imageOk = dockerOk && spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const binOk = !!AGENT && existsSync(AGENT);
const TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  (existsSync(`${homedir()}/.cowork-harness-token`) ? readFileSync(`${homedir()}/.cowork-harness-token`, "utf8").trim() : "");
const CAN = dockerOk && imageOk && binOk;

interface AgentRun {
  init?: any;
  toolUses: string[];
  result?: any;
  stderr: string;
}

/** Drive the agent in a container; capture the init message (+ optionally a full turn). */
function runAgent(opts: {
  extraArgs?: string[];
  env?: Record<string, string>;
  userText?: string;
  initRequest?: any;
  onMcp?: (jr: any) => any;
  waitForResult?: boolean;
  mounts?: string[]; // extra `-v` specs (e.g. a mounted --mcp-config dir)
}): Promise<AgentRun> {
  return new Promise((resolve) => {
    const env = { HOME: "/tmp", CLAUDE_CODE_IS_COWORK: "1", ...(opts.env ?? {}) };
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const args = [
      "run",
      "--rm",
      "-i",
      "--platform",
      "linux/arm64",
      "-v",
      `${AGENT}:/usr/local/bin/claude:ro`,
      ...(opts.mounts ?? []).flatMap((m) => ["-v", m]),
      "--tmpfs",
      "/tmp",
      ...envFlags,
      IMAGE,
      "claude",
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      ...(opts.extraArgs ?? []),
    ];
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: AgentRun = { toolUses: [], stderr: "" };
    const write = (o: any) => child.stdin.write(JSON.stringify(o) + "\n");
    write({ type: "control_request", request_id: "init-1", request: opts.initRequest ?? { subtype: "initialize" } });
    setTimeout(
      () => write({ type: "user", message: { role: "user", content: [{ type: "text", text: opts.userText ?? "reply: ok" }] } }),
      400,
    );
    child.stderr.on("data", (d) => (out.stderr += d.toString()));
    const rl = readline.createInterface({ input: child.stdout });
    // F: settled guard — a Promise ignores all resolves after the first, but re-killing a dead child
    // is sloppy and emits noise. One boolean flag prevents redundant kill+resolve calls.
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(out);
    };
    rl.on("line", (l) => {
      if (!l.trim()) return;
      let m: any;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (m.type === "system" && m.subtype === "init") {
        out.init = m;
        if (!opts.waitForResult) setTimeout(done, 150);
      } else if (m.type === "control_request" && m.request?.subtype === "mcp_message" && opts.onMcp) {
        const jr = m.request.message ?? {};
        const result = opts.onMcp(jr);
        const hasId = jr.id !== undefined && jr.id !== null && jr.method;
        write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: m.request_id,
            response: hasId ? { mcp_response: { jsonrpc: "2.0", id: jr.id, result } } : {},
          },
        });
      } else if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
        let updatedInput = m.request.input;
        if (m.request.tool_name === "AskUserQuestion") {
          const answers: Record<string, string> = {};
          for (const q of m.request.input?.questions ?? []) answers[q.question ?? q.header ?? ""] = q.options?.[0]?.label ?? "";
          updatedInput = { ...m.request.input, answers };
        }
        write({
          type: "control_response",
          response: { subtype: "success", request_id: m.request_id, response: { behavior: "allow", updatedInput } },
        });
      } else if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) if (b.type === "tool_use") out.toolUses.push(b.name);
      } else if (m.type === "result") {
        out.result = m;
        done();
      }
    });
    child.on("exit", () => done());
    setTimeout(done, 60000);
  });
}

describe.skipIf(!CAN)("live contract (Docker + staged binary)", () => {
  beforeAll(() => {
    if (!CAN) console.warn("skipping live-contract: need Docker + cowork-agent-base:2 + staged agent");
  });

  it("SPEC §3.1 flags are accepted by the staged binary", async () => {
    const r = await runAgent({ extraArgs: ["--setting-sources", "user", "--effort", "medium", "--tools", "Bash", "Read"] });
    expect(r.stderr).not.toMatch(/unknown option/i);
    expect(r.init).toBeTruthy();
  }, 60000);

  it("SPEC §C cowork registry excludes TodoWrite (parity)", async () => {
    const r = await runAgent({ extraArgs: ["--tools", "Task", "Bash", "Read", "Skill"] });
    expect(r.init?.tools ?? []).not.toContain("TodoWrite");
  }, 60000);

  it("SPEC §9 cowork mode sets cwd under /sessions/<id>", async () => {
    const r = await runAgent({});
    expect(String(r.init?.cwd ?? "")).toMatch(/^\/sessions\//);
  }, 60000);

  it("SPEC §6 sdkMcpServers connects + surfaces mcp__workspace__bash", async () => {
    const r = await runAgent({
      initRequest: { subtype: "initialize", sdkMcpServers: ["workspace"] },
      onMcp: (jr) =>
        jr.method === "tools/list"
          ? {
              tools: [
                {
                  name: "bash",
                  description: "x",
                  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
                },
              ],
            }
          : jr.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "workspace", version: "1" } }
            : {},
    });
    expect((r.init?.mcp_servers ?? []).some((s: any) => s.name === "workspace" && s.status === "connected")).toBe(true);
    expect(r.init?.tools ?? []).toContain("mcp__workspace__bash");
  }, 60000);

  // SPEC §6 (corrected 2026-06-13): --mcp-config is HONORED in plain cowork mode; the drop is
  // SAFE/HERMETIC-gated. A *valid* config populates mcp_servers; the same config under
  // CLAUDE_CODE_REMOTE+CLAUDE_CODE_REMOTE_HERMETIC_MODE is dropped to []. (A nonexistent file
  // errors with "Invalid MCP configuration" — that is NOT inertness; the old test asserted it.)
  const probeDir = mkdtempSync(join(tmpdir(), "cc-mcp-"));
  writeFileSync(
    join(probeDir, "mini-mcp.js"),
    // node-12-safe minimal stdio MCP server
    'function s(o){process.stdout.write(JSON.stringify(o)+"\\n")}var b="";process.stdin.on("data",function(d){b+=d.toString();var i;while((i=b.indexOf("\\n"))>=0){var l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;var m;try{m=JSON.parse(l)}catch(e){continue}if(m.method==="initialize")s({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"probe",version:"1"}}});else if(m.method==="tools/list")s({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"ping",description:"p",inputSchema:{type:"object",properties:{}}}]}});else if(m.method&&m.id!==undefined&&m.id!==null)s({jsonrpc:"2.0",id:m.id,result:{}})}});process.stdin.resume();',
  );
  writeFileSync(join(probeDir, "mcp.json"), JSON.stringify({ mcpServers: { probe: { command: "node", args: ["/probe/mini-mcp.js"] } } }));
  const mcpMounts = [`${probeDir}:/probe:ro`];

  it("SPEC §6 --mcp-config is HONORED in plain cowork mode (server appears)", async () => {
    const r = await runAgent({ extraArgs: ["--mcp-config", "/probe/mcp.json"], mounts: mcpMounts, waitForResult: false });
    expect(r.stderr).not.toMatch(/Invalid MCP configuration/i);
    expect((r.init?.mcp_servers ?? []).some((s: any) => s.name === "probe")).toBe(true);
  }, 60000);

  it("SPEC §6 --mcp-config is DROPPED under hermetic mode (mcp_servers empty)", async () => {
    const r = await runAgent({
      extraArgs: ["--mcp-config", "/probe/mcp.json"],
      mounts: mcpMounts,
      env: { CLAUDE_CODE_REMOTE: "1", CLAUDE_CODE_REMOTE_HERMETIC_MODE: "1" },
    });
    expect(r.init?.mcp_servers ?? []).toEqual([]);
  }, 60000);
});

describe.skipIf(!CAN || !TOKEN)("live contract — full turn (needs token)", () => {
  it("SPEC §5 scripted AskUserQuestion answer drives the model", async () => {
    const r = await runAgent({
      env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      extraArgs: ["--allowedTools", "AskUserQuestion"],
      userText: "Use AskUserQuestion to ask which fruit: Mango or Kiwi. After my answer reply exactly: You picked <fruit>.",
      waitForResult: true,
    });
    // our runAgent auto-allows; for AskUserQuestion the answer must carry updatedInput.answers
    expect(r.result?.is_error).toBe(false);
  }, 90000);
});

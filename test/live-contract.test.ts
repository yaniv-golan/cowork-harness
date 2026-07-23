import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { loadBaseline } from "../src/baseline.js";
import { resolveAgentBinary, resolveHostAgentBinary } from "../src/baseline.js";

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
/** Minimal `.env` probe for ONE key — the skip-gate must mirror the CLI's own token-resolution chain
 *  (env > dotenv > ./.env > install .env) or it under-detects: on a dev machine whose token lives only in
 *  the repo `.env`, the gate said "no token" and silently skipped 12 live tests that the spawned CLI
 *  would have authenticated fine (observed). Not a general dotenv parser: one key, quotes stripped. */
function tokenFromDotenv(): string {
  try {
    const m = readFileSync(".env", "utf8").match(/^CLAUDE_CODE_OAUTH_TOKEN=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}
const TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  (existsSync(`${homedir()}/.cowork-harness-token`) ? readFileSync(`${homedir()}/.cowork-harness-token`, "utf8").trim() : "") ||
  tokenFromDotenv();
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

// F: hostloop additionally needs the NATIVE host agent binary (resolveHostAgentBinary) alongside the
// Linux/arm64 ELF + sidecar image the suite above already gates on — a container-only CAN would let
// this describe attempt a hostloop run with no native binary staged.
let NATIVE_AGENT = "";
try {
  NATIVE_AGENT = resolveHostAgentBinary(loadBaseline("latest"));
} catch {
  /* nativeOk false below */
}
const nativeOk = !!NATIVE_AGENT && existsSync(NATIVE_AGENT);
const PROBE_CAN = dockerOk && imageOk && binOk && nativeOk && !!TOKEN; // hostloop needs BOTH agents + image + token

describe.skipIf(!PROBE_CAN)("live: sub-agent relative-Write acceptance probe (hostloop)", () => {
  it("the causal chain holds: dispatch -> child Write -> non-error result -> artifact content, zero VM paths", () => {
    const r = spawnSync("node", ["dist/cli.js", "run", "examples/probes/subagent-write-probe.scenario.yaml", "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      timeout: 600_000,
    });
    const out = JSON.parse(r.stdout);
    const assertions = (out.results ?? []).flatMap(
      (res: { assertions?: { pass: boolean; assertion?: unknown; message?: string }[] }) => res.assertions ?? [],
    );
    const failed = assertions.filter((a: { pass: boolean }) => !a.pass);
    expect(assertions.length, "no assertions evaluated — did the run reach the assert phase?").toBeGreaterThan(0);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(r.status).toBe(0);
  }, 620_000);
});

// The empirical proof named by critique's `container-tier-only` limitation (src/critique/limitations.ts):
// "a live resume-continuity proof at hostloop (its NATIVE agent binary, not the container ELF)". critique
// pins itself to container because its reflection turn must RESUME the same mounted skill + conversation as
// the task turn, and that continuity has only ever been proven for the container Linux ELF. This drives the
// SAME two-turn shape at hostloop's NATIVE binary and asserts both halves independently:
//   (1) conversation continuity — turn 2 recalls a codeword given ONLY in turn 1's conversation (native
//       session store restored across --resume);
//   (2) mount survival — turn 2 freshly READS references/passphrase.txt (a value that appears in NO prompt,
//       only in the mounted skill), captured in referencesRead, proving the staged skill tree survived the
//       resume rather than being remembered.
// A green here satisfies the EVIDENCE half of `liftedBy`; it does not by itself remove the pin (the
// `thenRequires` work — unpinning three sites, a manifest tier stamp, host-write consent — is separate).
const RC_SKILL = "examples/probes/resume-continuity-probe";
const CODEWORD = "ZEPHYR-NINE-CORAL"; // planted in turn 1's conversation only
const PASSPHRASE = "TANGERINE-42-OBELISK"; // lives only in the mounted skill's references/passphrase.txt

function runSkillTurn(sessionId: string, prompt: string, resume: boolean) {
  const args = [
    "dist/cli.js",
    "skill",
    RC_SKILL,
    prompt,
    "--fidelity",
    "hostloop",
    "--session-id",
    sessionId,
    ...(resume ? ["--resume"] : []),
    "--on-unanswered",
    "first",
    "--output-format",
    "json",
  ];
  const r = spawnSync("node", args, {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    timeout: 600_000,
  });
  let env: any;
  try {
    env = JSON.parse(r.stdout);
  } catch {
    throw new Error(`turn (resume=${resume}) did not emit a JSON envelope.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  }
  // The `skill` command wraps the RunResult in {ok, results:[…], error?}. Surface a boundary/infra error
  // (empty results) legibly rather than letting a later `res.finalMessage` read undefined.
  if (!env.results?.length) throw new Error(`turn (resume=${resume}) produced no run: ${JSON.stringify(env.error ?? env)}`);
  return { r, res: env.results[0] as any };
}

describe.skipIf(!PROBE_CAN)("live: resume-continuity proof at hostloop (native binary) — critique's pin", () => {
  it("turn 2 (--resume) recalls turn-1 conversation AND re-reads the mounted skill", () => {
    // A UNIQUE session id per run: a fresh (non-resume) turn 1 into an already-populated session dir is
    // refused by executeScenario ("same-project non-resume run must be FRESH"), so a fixed id would fail
    // on the second CI run.
    const sessionId = `probe-resume-continuity-${Date.now()}`;

    // ---- Turn 1: load the skill, plant a conversation codeword, do NOT open the passphrase file ----
    const t1 = runSkillTurn(
      sessionId,
      `You are running an internal resume-continuity probe. Do exactly two things and nothing else: ` +
        `(1) Invoke the resume-continuity-probe skill via the Skill tool so it is loaded. ` +
        `(2) Remember this conversation codeword for a later turn: ${CODEWORD}. ` +
        `Do NOT open the passphrase file on this turn. ` +
        `Then reply with exactly this single line and nothing else: LOADED ${CODEWORD}`,
      false,
    );
    expect(t1.r.status, `turn 1 exited nonzero.\nstderr:\n${t1.r.stderr}`).toBe(0);
    expect(String(t1.res.finalMessage ?? ""), "turn 1 did not echo the planted codeword").toContain(CODEWORD);

    // ---- Turn 2: resume the SAME session; recall the codeword + fetch the passphrase from disk ----
    const t2 = runSkillTurn(
      sessionId,
      `This is a resumed session. Answer using only what is available now. Do two things: ` +
        `(1) State the conversation codeword I gave you on the previous turn. ` +
        `(2) Obtain the vault passphrase by following the resume-continuity-probe skill's instructions — ` +
        `read its references/passphrase.txt file with the Read tool and report the exact contents. ` +
        `Reply with exactly one line and nothing else: CODEWORD=<the codeword> PASSPHRASE=<the passphrase>`,
      true,
    );
    expect(t2.r.status, `turn 2 (resume) exited nonzero.\nstderr:\n${t2.r.stderr}`).toBe(0);

    const t2final = String(t2.res.finalMessage ?? "");
    const refsRead: string[] = t2.res.referencesRead ?? [];

    // (1) CONVERSATION CONTINUITY: the codeword existed only in turn 1's conversation. Turn 2 knowing it
    //     proves the native agent's session store was restored by --resume.
    expect(
      t2final,
      `turn 2 lost the turn-1 codeword — NO conversation continuity across native resume.\nfinalMessage: ${t2final}`,
    ).toContain(CODEWORD);

    // (2) MOUNT SURVIVAL: the passphrase appears in NO prompt — only in the mounted skill's reference file.
    //     A fresh Read of it on turn 2 (captured in referencesRead) proves the staged skill tree survived
    //     the resume. Both signals must hold: the value reported AND the file actually read this turn.
    expect(t2final, `turn 2 did not report the on-disk passphrase.\nfinalMessage: ${t2final}`).toContain(PASSPHRASE);
    expect(
      refsRead.some((p) => /passphrase\.txt/.test(p)),
      `turn 2 never READ references/passphrase.txt on the resumed turn — mounted skill did not survive resume.\nreferencesRead: ${JSON.stringify(refsRead)}`,
    ).toBe(true);
  }, 1_260_000);
});

// End-to-end proof that the unpin works: `critique --fidelity hostloop` runs its full two-turn protocol
// (task turn -> reflection RESUME at the native binary -> evaluator) and produces a report, not an
// instrument failure. Folder-less (skill dir + no writable --folder), so no --allow-host-writes needed.
// Gated on PROBE_CAN like the other hostloop probes; four model workloads, so a generous timeout.
describe.skipIf(!PROBE_CAN)("live: critique runs at hostloop (the unpinned tier)", () => {
  it("critique --fidelity hostloop yields a report (exit 0, no instrument failure)", () => {
    const r = spawnSync(
      "node",
      [
        "dist/cli.js",
        "critique",
        RC_SKILL,
        "--prompt",
        "Invoke the resume-continuity-probe skill, then reply with exactly: DONE",
        "--fidelity",
        "hostloop",
        "--output-format",
        "json",
      ],
      { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, timeout: 900_000 },
    );
    // critique exits 0 whenever a critique was PRODUCED (any findings); exit 2 = no critique (usage or
    // instrument failure). The unpin is proven iff the hostloop two-turn protocol produced a report.
    expect(r.status, `critique exited ${r.status} (2 = no critique produced).\nstderr:\n${r.stderr}`).toBe(0);
    // A produced critique report carries the graded session and has NEITHER an instrument failure nor an
    // evaluator error (buildJsonReport's shape — there is no top-level `ok`).
    const env = JSON.parse(r.stdout);
    expect(env.infraFailure, `critique hit an instrument failure: ${JSON.stringify(env.infraFailure)}`).toBeUndefined();
    expect(env.evaluatorError, `evaluator errored: ${JSON.stringify(env.evaluatorError)}`).toBeUndefined();
    expect(typeof env.sessionId, "critique report has no sessionId").toBe("string");
    expect(typeof env.outDir, "critique report has no outDir").toBe("string");
  }, 920_000);
});

// The hostloop uploads-bullet fix, proven end-to-end: the shell-access section now advertises the STAGED
// uploads dir (the path-containment-allowed Read root) instead of dirname(upload.hostPath) — an agent
// following the prompt must be able to Read the attached file directly, with no bash and no
// copy-into-outputs workaround (the field failure this guards against ended in a spurious outputs-delete).
describe.skipIf(!PROBE_CAN)("live: hostloop uploads are Read-able at the advertised path", () => {
  it("the agent Reads the upload with the Read tool (no bash), and no outputs-delete fires", () => {
    const r = spawnSync(
      "node",
      [
        "dist/cli.js",
        "skill",
        "examples/probes/upload-read-probe",
        "Use the Read tool (not bash) to read the attached uploaded file and reply with its first line verbatim.",
        "--fidelity",
        "hostloop",
        "--upload",
        "examples/probes/upload-probe.txt",
        "--keep",
        "--output-format",
        "json",
      ],
      { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, timeout: 600_000 },
    );
    const env = JSON.parse(r.stdout);
    expect(env.results?.length, `no run produced: ${JSON.stringify(env.error ?? env)}`).toBeGreaterThan(0);
    const res = env.results[0];
    expect(res.finalMessage ?? "").toContain("MARKER-UPLOAD-READ-PROBE");
    // The full result carries the tool + scan evidence.
    const full = JSON.parse(readFileSync(join(res.outDir, "turns", "1", "result.json"), "utf8"));
    expect(full.toolCounts?.Read ?? 0, "the Read tool never ran").toBeGreaterThan(0);
    expect(full.toolCounts?.Bash ?? 0, "native bash ran — the workaround path").toBe(0);
    expect(full.toolCounts?.["mcp__workspace__bash"] ?? 0, "workspace bash ran — the workaround path").toBe(0);
    expect(full.scan?.outputsDeletes ?? [], "outputs-delete fired — the workaround chain is back").toEqual([]);
    expect(r.status).toBe(0);
  }, 620_000);
});

// Sub-agent WebSearch capture, proven against a REAL child session transcript (the unit tests use
// synthetic transcripts; this is the live proof that the actual on-disk tool_use/tool_result shape a
// dispatched sub-agent writes is what subagents[].webSearches parses).
describe.skipIf(!PROBE_CAN)("live: sub-agent WebSearch is captured as subagents[].webSearches", () => {
  it("a dispatched sub-agent's search lands with query + result text", () => {
    const r = spawnSync(
      "node",
      [
        "dist/cli.js",
        "skill",
        "examples/probes/subagent-research-probe",
        "Research this using the skill's dispatch instructions: in what year was the first iPhone released?",
        "--fidelity",
        "hostloop",
        "--keep",
        "--output-format",
        "json",
      ],
      { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, timeout: 600_000 },
    );
    const env = JSON.parse(r.stdout);
    expect(env.results?.length, `no run produced: ${JSON.stringify(env.error ?? env)}`).toBeGreaterThan(0);
    const res = env.results[0];
    const full = JSON.parse(readFileSync(join(res.outDir, "turns", "1", "result.json"), "utf8"));
    const subs = full.subagents ?? [];
    expect(subs.length, "no sub-agent was dispatched — the probe prompt failed to trigger a Task").toBeGreaterThan(0);
    const withSearch = subs.filter((s: { webSearches?: unknown[] }) => (s.webSearches?.length ?? 0) > 0);
    expect(
      withSearch.length,
      `no dispatch captured a WebSearch (subagents: ${JSON.stringify(subs.map((s: { toolsUsed?: unknown }) => s.toolsUsed))})`,
    ).toBeGreaterThan(0);
    const ws = (withSearch[0] as { webSearches: Array<{ query: string; resultText: string }> }).webSearches[0];
    expect(typeof ws.query).toBe("string");
    expect(ws.query.length).toBeGreaterThan(0);
    expect(typeof ws.resultText).toBe("string");
    expect(ws.resultText.length, "a query with EMPTY result text — the tool_result pairing failed").toBeGreaterThan(0);
    expect(r.status).toBe(0);
  }, 620_000);
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgentSession, hookOutput, parseMessage, type AgentEvent } from "../src/agent/session.js";

/** A minimal fake ChildProcessByStdio: EventEmitter + stdin/stdout/stderr PassThroughs. */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  return proc;
}

function newSession() {
  const proc = fakeProc();
  const outDir = mkdtempSync(join(tmpdir(), "sess-"));
  const session = new LiveAgentSession(proc as any, outDir);
  return { proc, outDir, session };
}

const tick = () => new Promise((r) => setImmediate(r));
async function drain(it: AsyncIterator<AgentEvent>) {
  while (!(await it.next()).done) void 0;
}
/** Poll a file until it contains `needle` (or the deadline passes). control-out.jsonl logs the
 *  incoming control_request immediately but flushes the reply a tick later; under full-suite load a
 *  single `tick()` can read before the reply settles (flaky). Deterministic with a deadline guard. */
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
  return last; // return whatever we have so the expect() produces a clear diff
}

// Capture ::warning:: lines written to stderr.
let warnings: string[];
let origWrite: typeof process.stderr.write;
beforeEach(() => {
  warnings = [];
  origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => {
    warnings.push(String(s));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = origWrite;
});

describe("parseMessage — init event skills capture (§6.2, O1 fix)", () => {
  it("a system/init message carrying a skills array maps onto the init AgentEvent's skills field verbatim (bare + <plugin>:<skill> ids)", () => {
    const ev = parseMessage({ type: "system", subtype: "init", tools: ["Skill"], mcp_servers: [], skills: ["a", "b:c"], cwd: "/tmp" });
    expect(ev).toEqual([{ type: "init", tools: ["Skill"], mcpServers: [], skills: ["a", "b:c"], cwd: "/tmp" }]);
  });

  it("defaults skills to [] when the raw init message carries no skills field", () => {
    const ev = parseMessage({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
    expect((ev[0] as { skills: string[] }).skills).toEqual([]);
  });
});

describe("session protocol loud-failure fixes", () => {
  it("a spawn error makes start() yield a typed {type:'error', source:'spawn'} (no hang)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick(); // let start() reach the Promise.race (errorPromise now wired)
    proc.emit("error", new Error("boom"));
    const { value } = await firstP;
    expect(value).toEqual({ type: "error", source: "spawn", message: "boom" });
  });

  it("an mcp_message with no sdkMcp handler replies with a JSON-RPC error (not a silent drop)", async () => {
    const { proc, outDir, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "mcp-1",
        request: { subtype: "mcp_message", server_name: "srv", message: { jsonrpc: "2.0", id: 7, method: "tools/call" } },
      }) + "\n",
    );
    proc.stdout.end(); // flushes the buffered line to readline → translate() processes it
    await drain(it); // generator drains to completion → flushes/closes control-out.jsonl
    await firstP.catch(() => {});
    // Poll until the reply settles (the request is logged immediately, the reply a flush-tick later) —
    // deterministic under full-suite load, unlike the prior fixed `tick()` (which flaked).
    const controlOut = await waitForFileContent(join(outDir, "control-out.jsonl"), "mcp_response");
    expect(controlOut).toContain("mcp_response");
    expect(controlOut).toContain("no sdkMcp handler configured");
    expect(warnings.some((w) => w.includes("no sdkMcp handler"))).toBe(true);
  });

  it("the init request declares the PreToolUse Task hook; a run_in_background callback is BLOCKED", async () => {
    const { proc, outDir, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    // the agent fires the PreToolUse hook for a backgrounded Task
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "hook-1",
        request: {
          subtype: "hook_callback",
          callback_id: "cowork-task-bg-block",
          input: { hook_event_name: "PreToolUse", tool_name: "Task", tool_input: { run_in_background: true } },
        },
      }) + "\n",
    );
    proc.stdout.end();
    await drain(it);
    await firstP.catch(() => {});
    const controlOut = await waitForFileContent(join(outDir, "control-out.jsonl"), "Background agents disabled");
    expect(controlOut).toContain('"matcher":"Task"'); // init declared the hook
    expect(controlOut).toContain('"hookCallbackIds"');
    expect(controlOut).toContain('"decision":"block"'); // the backgrounded Task was blocked
    expect(controlOut).toContain("Background agents disabled");
  });

  it("hookOutput blocks Task run_in_background, allows everything else", () => {
    expect(hookOutput("cowork-task-bg-block", { tool_name: "Task", tool_input: { run_in_background: true } })).toEqual({
      decision: "block",
      reason: "Background agents disabled",
    });
    expect(hookOutput("cowork-task-bg-block", { tool_name: "Task", tool_input: {} })).toEqual({}); // foreground Task → allow
    expect(hookOutput("unknown-id", { tool_input: { run_in_background: true } })).toEqual({}); // unknown id → allow
  });

  it("respond() for an unknown decision id warns loudly (does not silently no-op)", () => {
    const { session } = newSession();
    session.respond("does-not-exist", { kind: "permission", behavior: "allow" });
    expect(warnings.some((w) => w.includes("unknown decision id") && w.includes("does-not-exist"))).toBe(true);
  });

  it("an mcp_message with a missing request_id yields a typed protocol error event then ends the generator", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    // request_id omitted — a malformed control frame. The hook/mcp branches must not echo an unchecked id;
    // on the LIVE path the throw is caught by start() and yielded as a typed {type:"error",source:"protocol"}
    // event; the generator then returns (fail-closed).
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request: { subtype: "mcp_message", server_name: "srv", message: { jsonrpc: "2.0", id: 1, method: "tools/call" } },
      }) + "\n",
    );
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "error", source: "protocol" });
    expect((first.value as any).message).toMatch(/malformed request_id/);
    // the generator must have returned after yielding the error event
    const second = await it.next();
    expect(second.done).toBe(true);
  });

  it("a hook_callback with a non-string request_id yields a typed protocol error event then ends the generator", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: 123, // non-string → malformed
        request: { subtype: "hook_callback", callback_id: "x", input: {} },
      }) + "\n",
    );
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "error", source: "protocol" });
    expect((first.value as any).message).toMatch(/malformed request_id/);
    const second = await it.next();
    expect(second.done).toBe(true);
  });

  it("a malformed AskUserQuestion body (option missing label) becomes a typed protocol error, not trusted decider input", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "q-bad",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          // options[0] has no `label` — previously cast to QSpec[] unchecked, flowing into deciders.
          input: { questions: [{ question: "Pick?", options: [{ description: "no label here" }] }] },
        },
      }) + "\n",
    );
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "error", source: "protocol" });
    expect((first.value as any).message).toMatch(/malformed AskUserQuestion questions/);
    const second = await it.next();
    expect(second.done).toBe(true);
  });

  it("questions not an array yields a typed protocol error event then ends the generator", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "q-bad2",
        request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: "not-an-array" } },
      }) + "\n",
    );
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "error", source: "protocol" });
    expect((first.value as any).message).toMatch(/malformed AskUserQuestion questions/);
    const second = await it.next();
    expect(second.done).toBe(true);
  });

  it("a well-formed AskUserQuestion body still yields a decision event (no over-strict regression)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "q-ok",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_ok",
          input: { questions: [{ question: "Pick?", options: [{ label: "A" }, { label: "B" }] }] },
        },
      }) + "\n",
    );
    const { value } = await firstP;
    expect(value).toMatchObject({ type: "decision" });
    expect((value as any).request.kind).toBe("question");
    proc.stdout.end();
    await drain(it).catch(() => {});
  });

  // Regression guard: QSpecSchema must NOT be stricter than the protocol the
  // deciders already accept. An optionless / free-text gate (no `options`) and a header-only gate (no
  // `question`) are real shapes — the deciders handle optionless gates and Run owns the
  // header-only diagnostic. Both must reach a `decision` event at ingress, NOT throw "malformed" here.
  it("an optionless AskUserQuestion frame is NOT rejected at ingress (reaches a decision event)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "q-noopts",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_noopts",
          input: { questions: [{ question: "Free text?" }] }, // no `options` key
        },
      }) + "\n",
    );
    const { value } = await firstP;
    expect(value).toMatchObject({ type: "decision" });
    expect((value as any).request.kind).toBe("question");
    proc.stdout.end();
    await drain(it).catch(() => {});
  });

  it("a header-only AskUserQuestion frame (no `question`) is NOT rejected at ingress (Run owns that diagnostic)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "q-header",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_header",
          input: { questions: [{ header: "Heads up", options: [{ label: "OK" }] }] }, // no `question` key
        },
      }) + "\n",
    );
    const { value } = await firstP;
    expect(value).toMatchObject({ type: "decision" });
    expect((value as any).request.kind).toBe("question");
    proc.stdout.end();
    await drain(it).catch(() => {});
  });

  it("an option missing its `label` IS still rejected at ingress (the real malformed case)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "q-badopt",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: { questions: [{ question: "Pick?", options: [{ description: "no label here" }] }] },
        },
      }) + "\n",
    );
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "error", source: "protocol" });
    expect((first.value as any).message).toMatch(/malformed AskUserQuestion questions/);
    const second = await it.next();
    expect(second.done).toBe(true);
  });

  it("an over-cap control-out frame FAILS the live recording (the unreplayable truncation marker never reaches a cassette)", async () => {
    const { proc, outDir, session } = newSession();
    proc.stdin.resume(); // drain stdin so the pump's large write completes (no real child reads it)
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next(); // resolves with the decision event
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "perm-big",
        request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "x" } },
      }) + "\n",
    );
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "decision" });
    // Respond with an >256KiB control payload (updatedInput body) — too large to mirror verbatim.
    const huge = "Z".repeat(300 * 1024);
    // The over-cap frame routes through rejectError → start()'s readline race loses to the error, which is
    // surfaced as a typed {type:"error"} event (the same path as a spawn/stdin error).
    const nextP = it.next();
    session.respond("perm-big", { kind: "permission", behavior: "allow", updatedInput: { blob: huge } });
    const { value } = await nextP;
    expect(value).toMatchObject({ type: "error" });
    expect((value as any).message).toMatch(/control-out frame too large/);
    // The unreplayable truncation marker must NEVER have been written to control-out.jsonl. The
    // over-cap frame is rejected BEFORE any write, so the file stays empty — and the stream opens the
    // file ASYNCHRONOUSLY (createWriteStream, flags "a"), so under load it may not exist yet at this
    // synchronous read (was a flaky ENOENT). A missing file ⇒ nothing was written ⇒ no marker; treat as "".
    const controlOutPath = join(outDir, "control-out.jsonl");
    const controlOut = existsSync(controlOutPath) ? readFileSync(controlOutPath, "utf8") : "";
    expect(controlOut).not.toContain("control_out_truncated");
    proc.stdout.end();
    await drain(it).catch(() => {});
  });

  it("a kind-mismatched decider response warns (agent silently got a deny otherwise)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next(); // resolves with the decision event once we feed the control_request
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "perm-1",
        request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "x" } },
      }) + "\n",
    );
    const first = await firstP; // decision event yielded; reqById now has perm-1 (streams still open)
    expect(first.value).toMatchObject({ type: "decision" });
    // respond with the WRONG kind (question) for a permission request — streams open, so write() is safe
    session.respond("perm-1", { kind: "question", answers: {} } as never);
    expect(warnings.some((w) => w.includes('returned kind "question"') && w.includes('"permission" request'))).toBe(true);
    proc.stdout.end();
    await drain(it);
  });

  it("a single assistant line with one tool_use block writes one timeline.jsonl entry with seq 0, line 0", async () => {
    const { proc, outDir, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] },
      }) + "\n",
    );
    proc.stdout.end();
    await drain(it);
    await firstP.catch(() => {});
    const timelinePath = join(outDir, "timeline.jsonl");
    const lines = readFileSync(timelinePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 entry
    const header = JSON.parse(lines[0]);
    expect(header.v).toBe(1);
    const entry = JSON.parse(lines[1]);
    expect(entry).toMatchObject({ seq: 0, line: 0, type: "tool_use", toolUseId: "toolu_1", name: "Bash" });
  });

  it("a single line whose tool_use ALSO triggers a subagent_dispatch writes two timeline entries sharing line 0 with consecutive seq", async () => {
    const { proc, outDir, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_2", name: "Agent", input: { subagent_type: "general-purpose", description: "d", prompt: "p" } },
          ],
        },
      }) + "\n",
    );
    proc.stdout.end();
    await drain(it);
    await firstP.catch(() => {});
    const lines = readFileSync(join(outDir, "timeline.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3); // header + tool_use + subagent_dispatch
    const toolUse = JSON.parse(lines[1]);
    const dispatch = JSON.parse(lines[2]);
    expect(toolUse).toMatchObject({ seq: 0, line: 0, type: "tool_use", toolUseId: "toolu_2", name: "Agent" });
    expect(dispatch).toMatchObject({ seq: 1, line: 0, type: "subagent_dispatch", toolUseId: "toolu_2", agentType: "general-purpose" });
  });
});

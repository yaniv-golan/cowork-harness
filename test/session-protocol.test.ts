import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgentSession, hookOutput, type AgentEvent } from "../src/agent/session.js";

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

describe("session protocol loud-failure fixes", () => {
  it("#9: a spawn error makes start() yield a typed {type:'error', source:'spawn'} (no hang)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick(); // let start() reach the Promise.race (errorPromise now wired)
    proc.emit("error", new Error("boom"));
    const { value } = await firstP;
    expect(value).toEqual({ type: "error", source: "spawn", message: "boom" });
  });

  it("#10: an mcp_message with no sdkMcp handler replies with a JSON-RPC error (not a silent drop)", async () => {
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

  it("#8: the init request declares the PreToolUse Task hook; a run_in_background callback is BLOCKED", async () => {
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

  it("#8: hookOutput blocks Task run_in_background, allows everything else", () => {
    expect(hookOutput("cowork-task-bg-block", { tool_name: "Task", tool_input: { run_in_background: true } })).toEqual({
      decision: "block",
      reason: "Background agents disabled",
    });
    expect(hookOutput("cowork-task-bg-block", { tool_name: "Task", tool_input: {} })).toEqual({}); // foreground Task → allow
    expect(hookOutput("unknown-id", { tool_input: { run_in_background: true } })).toEqual({}); // unknown id → allow
  });

  it("#13: respond() for an unknown decision id warns loudly (does not silently no-op)", () => {
    const { session } = newSession();
    session.respond("does-not-exist", { kind: "permission", behavior: "allow" });
    expect(warnings.some((w) => w.includes("unknown decision id") && w.includes("does-not-exist"))).toBe(true);
  });

  it("an mcp_message with a missing request_id throws a typed protocol error (no unaddressable reply)", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    // request_id omitted — a malformed control frame. The hook/mcp branches must not echo an unchecked id;
    // on the LIVE path the throw propagates out of the generator (fail-closed), so it.next() rejects.
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request: { subtype: "mcp_message", server_name: "srv", message: { jsonrpc: "2.0", id: 1, method: "tools/call" } },
      }) + "\n",
    );
    await expect(firstP).rejects.toThrow(/malformed request_id/);
  });

  it("a hook_callback with a non-string request_id throws a typed protocol error", async () => {
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
    await expect(firstP).rejects.toThrow(/malformed request_id/);
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
    await expect(firstP).rejects.toThrow(/malformed AskUserQuestion questions/);
  });

  it("questions not an array is a typed protocol error", async () => {
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
    await expect(firstP).rejects.toThrow(/malformed AskUserQuestion questions/);
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

  // Regression guard for the adversarial-review P0: QSpecSchema must NOT be stricter than the protocol the
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
    await expect(firstP).rejects.toThrow(/malformed AskUserQuestion questions/);
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
    // The unreplayable truncation marker must NEVER have been written to control-out.jsonl.
    const controlOut = readFileSync(join(outDir, "control-out.jsonl"), "utf8");
    expect(controlOut).not.toContain("control_out_truncated");
    proc.stdout.end();
    await drain(it).catch(() => {});
  });

  it("#14: a kind-mismatched decider response warns (agent silently got a deny otherwise)", async () => {
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
});

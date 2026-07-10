import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveAgentSession, parseMessage, type AgentEvent, type DecisionDelivery } from "../src/agent/session.js";

/**
 * Regression tests for four crash/correctness bugs found in `src/agent/session.ts`'s protocol parsing
 * and control-write paths:
 *  - F1: a non-array `system/init` array field (`tools`/`mcp_servers`/`skills`) survived `?? []` and
 *    crashed a later `.map()` call downstream instead of failing as a typed protocol error.
 *  - F2: an assistant `tool_use` block's `input` was fed to the `in` operator unnormalized — a scalar
 *    input (e.g. `42`) threw `Cannot use 'in' operator`.
 *  - F3: the fallback id synthesized for an id-less sub-agent-dispatch block (`unpaired-${blockIndex}`)
 *    reset per assistant message, so anonymous dispatches in different messages collided.
 *  - F4: `respond()` reports `{delivered:true}` as soon as a frame is queued, before the async stdin
 *    write callback confirms it — an EPIPE discovered later was unreconcilable against that optimism.
 */

/** A minimal fake ChildProcessByStdio: EventEmitter + stdin/stdout/stderr PassThroughs (mirrors the
 *  helper in test/session-protocol.test.ts). */
function fakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  return proc;
}

function newSession() {
  const proc = fakeProc();
  const outDir = mkdtempSync(join(tmpdir(), "sess-parse-guards-"));
  const session = new LiveAgentSession(proc as any, outDir);
  return { proc, outDir, session };
}

const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// F1 — system/init array-field guard
// ---------------------------------------------------------------------------
describe("F1: parseMessage — system/init array-field guard (crash fix)", () => {
  it("a `skills` field that is a number is rejected as a typed protocol error, not silently coerced", () => {
    expect(() => parseMessage({ type: "system", subtype: "init", tools: [], mcp_servers: [], skills: 42 })).toThrow(
      /malformed system\/init frame.*"skills".*number/,
    );
  });

  it("a `skills` field that is a plain object is also rejected as a typed protocol error", () => {
    expect(() => parseMessage({ type: "system", subtype: "init", tools: [], mcp_servers: [], skills: { not: "an array" } })).toThrow(
      /malformed system\/init frame.*"skills".*object/,
    );
  });

  it("a non-array `tools` or `mcp_servers` field is likewise rejected (not just `skills`)", () => {
    expect(() => parseMessage({ type: "system", subtype: "init", tools: "nope", mcp_servers: [], skills: [] })).toThrow(
      /malformed system\/init frame.*"tools"/,
    );
    expect(() => parseMessage({ type: "system", subtype: "init", tools: [], mcp_servers: 7, skills: [] })).toThrow(
      /malformed system\/init frame.*"mcp_servers"/,
    );
  });

  it("a well-formed init frame is unaffected (regression guard)", () => {
    const ev = parseMessage({ type: "system", subtype: "init", tools: ["Skill"], mcp_servers: [], skills: ["a", "b:c"], cwd: "/tmp" });
    expect(ev).toEqual([{ type: "init", tools: ["Skill"], mcpServers: [], skills: ["a", "b:c"], cwd: "/tmp" }]);
  });

  it("end-to-end via LiveAgentSession: a malformed init frame surfaces as a typed protocol error event, not an uncaught crash", async () => {
    const { proc, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [], skills: 42 }) + "\n");
    const { value } = await firstP;
    expect(value).toMatchObject({ type: "error", source: "protocol" });
    expect((value as any).message).toMatch(/malformed system\/init frame/);
    // the generator terminates cleanly after the typed error — no hang, no uncaught exception.
    const second = await it.next();
    expect(second.done).toBe(true);
    proc.stdout.end();
  });
});

// ---------------------------------------------------------------------------
// F2 — assistant content block / tool_use input guard
// ---------------------------------------------------------------------------
describe("F2: parseMessage — assistant content block guards (crash fix)", () => {
  it("a tool_use block with a scalar `input` (a non-dispatch tool) does not throw on the `in` operator check", () => {
    const events = parseMessage({
      type: "assistant",
      message: { model: "claude-x", content: [{ type: "tool_use", id: "toolu_1", name: "SomeTool", input: 42 }] },
    });
    expect(events).toEqual([
      { type: "tool_use", name: "SomeTool", input: 42, parentToolUseId: undefined, toolUseId: "toolu_1", model: "claude-x" },
    ]);
  });

  it("an Agent-tool dispatch block whose `input` is a scalar does not throw, and normalizes to an empty/unknown dispatch", () => {
    const events = parseMessage({
      type: "assistant",
      message: { model: "claude-x", content: [{ type: "tool_use", id: "toolu_2", name: "Agent", input: 42 }] },
    });
    const dispatch = events.find((e) => e.type === "subagent_dispatch");
    expect(dispatch).toMatchObject({ type: "subagent_dispatch", toolUseId: "toolu_2", agentType: "unknown", declaredTools: [] });
  });

  it("a null entry in the assistant content array is rejected as a typed protocol error (not an uncaught 'Cannot read properties of null')", () => {
    expect(() => parseMessage({ type: "assistant", message: { content: [null] } })).toThrow(/malformed assistant content block/);
  });

  it("a scalar entry in the assistant content array is likewise rejected", () => {
    expect(() => parseMessage({ type: "assistant", message: { content: ["not-an-object"] } })).toThrow(/malformed assistant content block/);
  });
});

// ---------------------------------------------------------------------------
// F3 — synthesized dispatch id uniqueness across messages
// ---------------------------------------------------------------------------
describe("F3: parseMessage — synthesized dispatch id uniqueness across messages (bug fix)", () => {
  it("two anonymous Agent dispatches in two SEPARATE assistant messages get DISTINCT synthesized toolUseIds", () => {
    const anonymousDispatch = (label: string) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Agent", input: { description: label } }] }, // no `id` → synthesized
    });
    const firstDispatch = parseMessage(anonymousDispatch("first")).find((e) => e.type === "subagent_dispatch") as any;
    const secondDispatch = parseMessage(anonymousDispatch("second")).find((e) => e.type === "subagent_dispatch") as any;
    expect(firstDispatch?.toolUseId).toBeTruthy();
    expect(secondDispatch?.toolUseId).toBeTruthy();
    expect(firstDispatch.toolUseId).not.toEqual(secondDispatch.toolUseId);
  });

  it("two anonymous dispatches within the SAME message also get distinct ids (existing blockIndex behavior preserved)", () => {
    const events = parseMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Agent", input: { description: "a" } },
          { type: "tool_use", name: "Agent", input: { description: "b" } },
        ],
      },
    });
    const dispatches = events.filter((e) => e.type === "subagent_dispatch") as any[];
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0].toolUseId).not.toEqual(dispatches[1].toolUseId);
  });
});

// ---------------------------------------------------------------------------
// F4 — respond() delivery reconciliation across an async EPIPE
// ---------------------------------------------------------------------------
describe("F4: respond() delivery reconciliation across an async stdin EPIPE (bug fix)", () => {
  it("respond() optimistically reports delivered:true when the frame is queued, but a later stdin EPIPE is reconciled (decisionId-tagged control_undelivered + hasUndeliveredReconciliation)", async () => {
    const { proc, outDir, session } = newSession();
    const it = session.start()[Symbol.asyncIterator]();
    const firstP = it.next();
    await tick();
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "perm-epipe",
        request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "x" } },
      }) + "\n",
    );
    const first = await firstP;
    expect(first.value).toMatchObject({ type: "decision" });

    // Simulate a pipe that breaks between write()'s synchronous writability check and the actual OS
    // write: the stdin stream still reports writable/not-destroyed (write() only queues), but the
    // write callback receives an EPIPE-shaped error — exactly like a dead child's stdin.
    (proc.stdin as any).write = (_chunk: unknown, cb: (err: Error | null) => void) => {
      queueMicrotask(() => cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
      return true;
    };

    const nextP = it.next(); // the pump's write failure routes through rejectError → a typed error event
    const delivery: DecisionDelivery = session.respond("perm-epipe", { kind: "permission", behavior: "allow" });
    // Documented, pre-existing optimism (see DecisionDelivery's doc comment): delivered:true here means
    // "queued successfully", not "the child confirmed receipt" — a synchronous respond() cannot know the
    // async write outcome yet. This is the behavior the reconciliation mechanism below exists to correct.
    expect(delivery).toEqual({ delivered: true });

    const { value } = await nextP.catch((e) => ({ value: { type: "error", message: String(e) } }));
    expect(value).toMatchObject({ type: "error" });

    // Ground truth, reconciled asynchronously once the write callback actually fires.
    expect((session as any).hasUndeliveredReconciliation("perm-epipe")).toBe(true);
    // An unrelated/unanswered decisionId must NOT be reported as reconciled-undelivered.
    expect((session as any).hasUndeliveredReconciliation("some-other-decision")).toBe(false);
    proc.stdout.end();
  });
});

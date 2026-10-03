// A sub-agent's system turn: an inline `system` turn at each dispatch, holding the harness's sub-agent append ONLY
// when the child's own prompt snapshot ends with exactly the append the session sent
// (initialize.appendSubagentSystemPrompt). Anthropic's built-in sub-agent prompt (the snapshot's other parts) is
// never read into memory past the transcript reader, and never written.
//
// Every line here is SYNTHETIC: built from the frame shapes (a child transcript's `attachment`/`prompt_snapshot`
// line, control-out.jsonl's initialize request) with placeholder text, never copied from a real run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChildTranscripts, sentSubagentAppend, turnsFromEvents, type ChildTranscript } from "../src/hillclimb/trace.js";

const BUILTIN = ["BUILTIN-PART-0", "BUILTIN-PART-1", "BUILTIN-PART-2", "BUILTIN-PART-3"];
const APPEND = "SYNTHETIC harness sub-agent append";

const snapshotLine = (last: string) =>
  JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: [...BUILTIN, last] } });
const childText = JSON.stringify({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "child says hi" }] } });
const dispatch = JSON.stringify({
  type: "assistant",
  message: { id: "m1", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "general-purpose" } }] },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hc-sys-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const child = (lines: string[]): ChildTranscript[] => {
  writeFileSync(join(dir, "agent-a.meta.json"), JSON.stringify({ toolUseId: "toolu_1", agentType: "general-purpose" }));
  writeFileSync(join(dir, "agent-a.jsonl"), lines.join("\n"));
  return readChildTranscripts(dir);
};
const trace = (children: ChildTranscript[], subagentAppend?: string) =>
  turnsFromEvents({
    events: [dispatch],
    prompt: "p",
    children,
    sidecarPrefix: "x/",
    redact: (t) => t,
    ...(subagentAppend !== undefined ? { subagentAppend } : {}),
  });

describe("sub-agent system turns", () => {
  it("received: the child's snapshot ends with the sent append → a system turn with the append, built-in parts withheld", () => {
    const t = trace(child([snapshotLine(APPEND), childText]), APPEND).turns;
    const i = t.findIndex((x) => x.role === "tool_call");
    expect(t[i + 1]).toEqual({
      role: "system",
      content: `[sub-agent general-purpose#1 system — harness append as received; Anthropic's built-in sub-agent prompt (4 parts) withheld]\n\n${APPEND}`,
    });
    expect(t[i + 2].content).toBe("[sub-agent general-purpose#1] child says hi");
  });

  it("the child's snapshot ends with something else → none received, never the session's append stamped on it (a forked skill is judged the same way: by its own snapshot)", () => {
    const t = trace(child([snapshotLine("SOMETHING ELSE"), childText]), APPEND).turns;
    const sys = t.filter((x) => x.role === "system");
    expect(sys).toEqual([{ role: "system", content: "[sub-agent general-purpose#1 system — harness append: none received]" }]);
  });

  it("protocol: the session sent no append → none received", () => {
    const t = trace(child([snapshotLine(APPEND), childText])).turns;
    expect(t.filter((x) => x.role === "system").map((x) => x.content)).toEqual([
      "[sub-agent general-purpose#1 system — harness append: none received]",
    ]);
  });

  it("no snapshot in the transcript → not recorded (it cannot be said what the child received)", () => {
    const t = trace(child([childText]), APPEND).turns;
    expect(t.filter((x) => x.role === "system").map((x) => x.content)).toEqual([
      "[sub-agent general-purpose#1 system — not recorded in its transcript]",
    ]);
  });

  it("no built-in part reaches the transcript object or any turn", () => {
    const kids = child([snapshotLine(APPEND), childText]);
    const out = JSON.stringify([kids, trace(kids, APPEND)]);
    for (const p of BUILTIN) expect(out).not.toContain(p);
  });
});

describe("sentSubagentAppend", () => {
  it("reads initialize.appendSubagentSystemPrompt from control-out.jsonl", () => {
    writeFileSync(
      join(dir, "control-out.jsonl"),
      [
        JSON.stringify({
          type: "control_request",
          request_id: "1",
          request: { subtype: "initialize", appendSubagentSystemPrompt: APPEND },
        }),
        JSON.stringify({ type: "control_request", request_id: "2", request: { subtype: "interrupt" } }),
      ].join("\n"),
    );
    expect(sentSubagentAppend(dir)).toBe(APPEND);
  });

  it("no control-out.jsonl, or no append in it → undefined", () => {
    expect(sentSubagentAppend(dir)).toBeUndefined();
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "x", "control-out.jsonl"), JSON.stringify({ type: "control_request", request: { subtype: "initialize" } }));
    expect(sentSubagentAppend(join(dir, "x"))).toBeUndefined();
  });
});

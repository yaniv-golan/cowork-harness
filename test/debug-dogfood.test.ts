import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTrace, formatTrace, buildToolErrors, formatToolErrors, buildGateTrace } from "../src/run/trace-view.js";

// Dogfood the Part III debug triage: inject a NAMED defect into a synthetic run and prove the very tools
// the triage table points at actually LOCALIZE it — token-free (operates on the run's frozen
// events.jsonl, no live run, no Docker, no re-record). This is the safety net behind "reach for `trace
// --view tool-errors` when a tool errored" etc.: if a tool stopped surfacing a real injected defect, the
// triage would send an agent to a dead end, and this test fails.

function eventsFile(lines: unknown[], controlOut?: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-dogfood-"));
  const f = join(dir, "events.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  if (controlOut) writeFileSync(join(dir, "control-out.jsonl"), controlOut.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}
const assistant = (blocks: unknown[]) => ({ type: "assistant", message: { content: blocks } });
const userResult = (toolUseId: string, isError: boolean, text: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: text }] },
});

const ERR_SIGNATURE = "ENOSPC: no space left on device";

describe("debug triage localizes an injected tool error", () => {
  const brokenRun = eventsFile([
    assistant([{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }]),
    userResult("toolu_1", false, "file contents"),
    assistant([{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "dd if=/dev/zero of=/big" } }]),
    userResult("toolu_2", true, ERR_SIGNATURE),
    { type: "result", is_error: false },
  ]);

  it("`trace --view tool-errors` surfaces the errored tool by its exact stderr signature", () => {
    const rows = buildToolErrors(brokenRun);
    expect(rows.length, "exactly the one errored call, not the clean Read").toBe(1);
    expect(rows[0].name).toBe("Bash");
    expect(formatToolErrors(rows)).toContain(ERR_SIGNATURE);
  });

  it("the default `trace` view marks the errored tool's result status (not a silent green)", () => {
    const tools = buildTrace(brokenRun).filter((r) => r.kind === "tool");
    expect(tools.find((t) => t.name === "Bash")).toMatchObject({ resultStatus: "error" });
    expect(tools.find((t) => t.name === "Read")).toMatchObject({ resultStatus: "ok" });
    expect(formatTrace(buildTrace(brokenRun))).toContain("✗ error");
  });
});

describe("debug triage localizes an injected gate-delivery failure", () => {
  it("`trace --view questions` pins the gate whose answer never reached the model", () => {
    const run = eventsFile(
      [
        {
          type: "control_request",
          request_id: "uuid-9",
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_g",
            input: { questions: [{ question: "Which format?", options: [{ label: "PDF" }] }] },
          },
        },
        userResult("toolu_g", true, "delivery errored"), // is_error → the injected defect
        { type: "result", is_error: false },
      ],
      [
        {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "uuid-9",
            response: {
              behavior: "allow",
              updatedInput: { questions: [{ question: "Which format?" }], answers: { "Which format?": "PDF" } },
            },
          },
        },
      ],
    );
    const gates = buildGateTrace(run);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ question: "Which format?", delivered: "error" });
  });
});

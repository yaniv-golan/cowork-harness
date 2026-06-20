import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTrace, formatTrace, buildGateTrace, resolveEventsFile } from "../src/run/trace-view.js";

function eventsFile(lines: unknown[], controlOut?: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-trace-"));
  const f = join(dir, "events.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  if (controlOut) writeFileSync(join(dir, "control-out.jsonl"), controlOut.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}

// E — resolveEventsFile: exact match preferred over fragment, ambiguous fragment warns loudly
describe("trace — E resolveEventsFile exact vs fragment resolution", () => {
  // resolveEventsFile resolves under runsRoot(); we point COWORK_HARNESS_RUNS_DIR at a temp runs/ tree
  // (the runs root is now an absolute path, not cwd-relative) and restore the env after each test.
  const origEnv = process.env.COWORK_HARNESS_RUNS_DIR;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
    else process.env.COWORK_HARNESS_RUNS_DIR = origEnv;
  });

  function makeRunsTree(layout: { scen: string; run: string }[]): string {
    const runsRoot = join(mkdtempSync(join(tmpdir(), "cwh-runs-")), "runs");
    for (const { scen, run } of layout) {
      const runDir = join(runsRoot, scen, run);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "events.jsonl"), "");
    }
    process.env.COWORK_HARNESS_RUNS_DIR = runsRoot;
    return runsRoot;
  }

  it("exact run-dir name is preferred over a fragment match", () => {
    makeRunsTree([
      { scen: "my-scenario", run: "exact-run-id" },
      { scen: "my-scenario", run: "abc-exact-run-id-xyz" }, // contains the exact name as fragment
    ]);
    const f = resolveEventsFile("exact-run-id");
    expect(f).toContain(`my-scenario/exact-run-id/events.jsonl`);
  });

  it("single unambiguous fragment resolves without warning", () => {
    makeRunsTree([{ scen: "skill-a", run: "run-unique-abc123" }]);
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: any[]) => {
      stderrChunks.push(s);
      return origWrite(s, ...rest);
    };
    try {
      const f = resolveEventsFile("unique-abc123");
      expect(f).toContain("events.jsonl");
      expect(stderrChunks.join("")).not.toMatch(/ambiguous/);
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  it("ambiguous fragment warns loudly and picks most recent (deterministic)", () => {
    makeRunsTree([
      { scen: "skill-a", run: "local_aaaa" },
      { scen: "skill-a", run: "local_bbbb" },
    ]);
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: any[]) => {
      stderrChunks.push(s);
      return origWrite(s, ...rest);
    };
    try {
      const f = resolveEventsFile("local_");
      expect(f).toContain("events.jsonl");
      const combined = stderrChunks.join("");
      expect(combined).toMatch(/ambiguous trace fragment/);
      expect(combined).toMatch(/2 run dirs/);
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });
});

const assistant = (blocks: unknown[], parent?: string) => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: blocks },
});
const userResult = (toolUseId: string, isError: boolean, text: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: text }] },
});

describe("trace view (item 8)", () => {
  it("dedupes the Agent dispatch (one dispatch row, not also a tool row) and excludes TaskCreate todos", () => {
    const f = eventsFile([
      { type: "system", subtype: "init", tools: ["Agent", "Task"], mcp_servers: [] },
      assistant([
        { type: "tool_use", id: "a1", name: "Agent", input: { description: "orchestrate", subagent_type: "general-purpose", prompt: "…" } },
      ]),
      assistant([{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "step 0", description: "d", activeForm: "doing" } }]),
      assistant([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x" } }]),
      { type: "result", is_error: false },
    ]);
    const rows = buildTrace(f);
    const dispatch = rows.filter((r) => r.kind === "dispatch");
    const tools = rows.filter((r) => r.kind === "tool");
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0].agentType).toBe("general-purpose");
    // the Agent block does NOT also appear as a tool row; TaskCreate + Read do
    expect(tools.map((t) => t.name).sort()).toEqual(["Read", "TaskCreate"]);
    expect(formatTrace(rows)).toContain("1 sub-agent dispatch(es)");
  });

  it("--tools filters to tool/dispatch rows only", () => {
    const f = eventsFile([
      assistant([{ type: "text", text: "thinking out loud" }]),
      assistant([{ type: "tool_use", id: "r1", name: "Grep", input: { pattern: "x" } }]),
      { type: "result", is_error: false },
    ]);
    const rows = buildTrace(f, { tools: true });
    expect(rows.every((r) => r.kind === "tool" || r.kind === "dispatch")).toBe(true);
    expect(rows.find((r) => r.kind === "text")).toBeUndefined();
  });

  it("Part 4: a tool row carries its result STATUS (ok/error) from the paired tool_result", () => {
    const f = eventsFile([
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "x" } }]),
      userResult("toolu_1", true, "boom: permission denied"),
      assistant([{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } }]),
      userResult("toolu_2", false, "file contents"),
      { type: "result", is_error: false },
    ]);
    const tools = buildTrace(f).filter((r) => r.kind === "tool");
    expect(tools.find((t) => t.name === "Bash")).toMatchObject({ resultStatus: "error", resultText: "boom: permission denied" });
    expect(tools.find((t) => t.name === "Read")).toMatchObject({ resultStatus: "ok" });
    expect(formatTrace(buildTrace(f))).toContain("✗ error: boom");
  });

  it("Part 4: --gates pairs question → injected answer → delivered result (bridging UUID↔toolu_ keys)", () => {
    const f = eventsFile(
      [
        // gate: control_request carries BOTH the UUID request_id AND the toolu_ tool_use_id
        {
          type: "control_request",
          request_id: "uuid-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            tool_use_id: "toolu_g",
            input: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
          },
        },
        userResult("toolu_g", false, "delivered"),
        { type: "result", is_error: false },
      ],
      [
        // control-out.jsonl: the injected answer, keyed by request_id (UUID)
        {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "uuid-1",
            response: { behavior: "allow", updatedInput: { questions: [{ question: "Proceed?" }], answers: { "Proceed?": "Yes" } } },
          },
        },
      ],
    );
    const gates = buildGateTrace(f);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ question: "Proceed?", injectedAnswer: '{"Proceed?":"Yes"}', delivered: "ok" });
  });

  it("Part 4: --gates flags an O7-style delivery failure (errored tool_result)", () => {
    const f = eventsFile([
      {
        type: "control_request",
        request_id: "uuid-2",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_b",
          input: { questions: [{ question: "Branch?", options: [{ label: "A" }] }] },
        },
      },
      userResult("toolu_b", true, "undefined is not an object (evaluating 'q.map')"),
      { type: "result", is_error: false },
    ]);
    const gates = buildGateTrace(f);
    expect(gates[0]).toMatchObject({ question: "Branch?", delivered: "error" });
    expect(gates[0].error).toContain("q.map");
  });
});

// #6 — trace --dispatches: the sub-agent dispatch tree + the real total (read off dispatch_count_max).
import { buildDispatchTree, formatDispatchTree } from "../src/run/trace-view.js";
describe("trace --dispatches (#6 — dispatch tree + total)", () => {
  it("builds the tree with depth from parentToolUseId nesting and a total", () => {
    const f = eventsFile([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Task",
              input: { subagent_type: "explorer", description: "explore", tools: ["Read", "Grep"] },
            },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_1",
        message: { content: [{ type: "tool_use", id: "toolu_2", name: "Task", input: { subagent_type: "child" } }] },
      },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_3", name: "Task", input: { subagent_type: "writer" } }] } },
    ]);
    const tree = buildDispatchTree(f);
    expect(tree.total).toBe(3);
    expect(tree.nodes.map((n) => [n.agentType, n.depth])).toEqual([
      ["explorer", 0],
      ["child", 1],
      ["writer", 0],
    ]);
    const txt = formatDispatchTree(tree);
    expect(txt).toMatch(/dispatch_count_max: 3/);
    expect(txt).toContain("[Read,Grep]");
  });

  it("no dispatches → friendly message", () => {
    const f = eventsFile([{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }]);
    expect(formatDispatchTree(buildDispatchTree(f))).toMatch(/no sub-agent dispatches/);
  });
});

// #8 — assert --list is generated from the Zod Assertion schema; every key MUST carry a description so
// the list can never drift (and the published JSON schema is enriched).
import { Assertion } from "../src/types.js";
describe("assert --list (#8 — every Assertion key has a description, drift guard)", () => {
  it("no Assertion field is missing its .describe()", () => {
    const shape = Assertion.shape as Record<string, { description?: string }>;
    const missing = Object.keys(shape).filter((k) => !shape[k].description);
    expect(missing).toEqual([]);
  });
});

// SCAFFOLD-FROM-RUN — turn a kept run into a starter scenario YAML.
import { buildScaffold } from "../src/run/scaffold.js";
import { parse as parseYaml } from "yaml";
describe("scaffold --from-run (SCAFFOLD-FROM-RUN)", () => {
  it("emits a scenario from observed gates, artifacts, and prompt", () => {
    const reqId = "r1";
    const tuid = "toolu_G1";
    const dir = mkdtempSync(join(tmpdir(), "cwh-scaffold-"));
    const eventsFilePath = join(dir, "events.jsonl");
    const events = [
      { type: "system", subtype: "init", tools: ["AskUserQuestion"] },
      {
        type: "control_request",
        request_id: reqId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: tuid,
          input: { questions: [{ question: "Which format?", options: [{ label: "PDF" }] }] },
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: tuid, is_error: false, content: "PDF" }] } },
      { type: "result", subtype: "success", is_error: false },
    ];
    writeFileSync(eventsFilePath, events.map((e) => JSON.stringify(e)).join("\n"));
    writeFileSync(
      join(dir, "control-out.jsonl"),
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: {
            behavior: "allow",
            updatedInput: { questions: [{ question: "Which format?", options: [{ label: "PDF" }] }], answers: { "Which format?": "PDF" } },
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        prompt: "make a report",
        fidelity: "container",
        result: "success",
        artifacts: [{ path: "outputs/report.pdf", bytes: 10 }],
        subagents: [],
      }),
    );
    const parsed = parseYaml(buildScaffold(eventsFilePath));
    expect(parsed.prompt).toBe("make a report");
    expect(parsed.fidelity).toBe("container");
    expect(parsed.answers[0].choose).toBe("PDF");
    expect(parsed.answers[0].when_question).toMatch(/Which format/);
    expect(parsed.assert.some((a: any) => a.file_exists === "outputs/report.pdf")).toBe(true);
    expect(parsed.assert.some((a: any) => a.result === "success")).toBe(true);
  });
});

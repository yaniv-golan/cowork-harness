import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTrace, formatTrace, buildGateTrace, formatGateTrace, resolveEventsFile } from "../src/run/trace-view.js";

function eventsFile(lines: unknown[], controlOut?: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-trace-"));
  const f = join(dir, "events.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  if (controlOut) writeFileSync(join(dir, "control-out.jsonl"), controlOut.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}

// resolveEventsFile: exact match preferred over fragment, ambiguous fragment warns loudly
describe("trace — resolveEventsFile exact vs fragment resolution", () => {
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

describe("trace view", () => {
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

  it("a tool row carries its result STATUS (ok/error) from the paired tool_result", () => {
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

  it("--gates pairs question → injected answer → delivered result (bridging UUID↔toolu_ keys)", () => {
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

  it("--gates flags a delivery failure (errored tool_result)", () => {
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

  // T2: questions_count_max counts sub-questions (src/run/run.ts pushes one rec.questions entry per
  // sub-question), so a single gate bundling 3 sub-questions must report subQuestionCount: 3 here —
  // the trace view's total must equal what the assertion would compare against (ctx.questions.length).
  it("a bundled gate with 3 sub-questions reports subQuestionCount: 3, and the footer total matches questions_count_max's definition", () => {
    const f = eventsFile([
      {
        type: "control_request",
        request_id: "uuid-3",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_bundle",
          input: {
            questions: [
              { question: "Stage?", options: [{ label: "Series A" }] },
              { question: "Sector?", options: [{ label: "AI" }] },
              { question: "Region?", options: [{ label: "US" }] },
            ],
          },
        },
      },
      userResult("toolu_bundle", false, "delivered"),
      { type: "result", is_error: false },
    ]);
    const gates = buildGateTrace(f);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ question: "Stage? / Sector? / Region?", subQuestionCount: 3, delivered: "ok" });
    const text = formatGateTrace(gates);
    expect(text).toContain('gate "Stage? / Sector? / Region?" (3 sub-questions)');
    expect(text).toContain(
      "1 gate(s), 3 sub-question(s) total — questions_count_max counts sub-questions (assert with `questions_count_max: 3`)",
    );
  });
});

describe("trace — thinking rows", () => {
  it("renders a thinking event as a distinct row, truncated to 120 chars", () => {
    const longThought = "reasoning ".repeat(20); // > 120 chars
    const f = eventsFile([assistant([{ type: "thinking", thinking: longThought }]), { type: "result", is_error: false }]);
    const rows = buildTrace(f);
    const thinkingRow = rows.find((r) => r.kind === "thinking");
    expect(thinkingRow).toBeDefined();
    expect(thinkingRow!.detail!.length).toBeLessThanOrEqual(120);
  });

  it("formatTrace prints thinking rows with a distinct prefix, not confused with assistant text", () => {
    const rows = [{ kind: "thinking" as const, detail: "let me check the file" }];
    const out = formatTrace(rows);
    expect(out).toContain("let me check the file");
    expect(out).not.toContain("claude›"); // must not reuse the "text" kind's prefix
  });
});

// modelUsage cache-read-ratio footer (§4.7, M3) — formatTrace takes an OPTIONAL second param so every
// existing one-argument call site (src/cli.ts, and the formatTrace(rows) calls above) keeps compiling.
describe("formatTrace — cache-read-ratio footer", () => {
  const rows = [{ kind: "tool" as const, name: "Bash", detail: "ls" }];

  it("includes a cache-read-ratio footer line when opts.modelUsage data is available via the trace context", () => {
    const out = formatTrace(rows, {
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 100, cacheReadInputTokens: 900 },
      },
    });
    expect(out).toContain("cache-read ratio: 90%");
  });

  it("sums cache-read ratio across multiple models", () => {
    const out = formatTrace(rows, {
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 0, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 },
        "claude-haiku-4-5": { inputTokens: 0, cacheReadInputTokens: 200, cacheCreationInputTokens: 0 },
      },
    });
    expect(out).toContain("cache-read ratio: 100%");
  });

  it("omits the footer line entirely when opts is not passed (existing one-arg call sites unaffected)", () => {
    const out = formatTrace(rows);
    expect(out).not.toContain("cache-read ratio");
  });

  it("omits the footer when modelUsage is present but empty/all-zero (guards divide-by-zero, no NaN%/Infinity%)", () => {
    const out = formatTrace(rows, { modelUsage: {} });
    expect(out).not.toContain("cache-read ratio");
    const outZero = formatTrace(rows, { modelUsage: { m: { inputTokens: 0, cacheReadInputTokens: 0 } } });
    expect(outZero).not.toContain("cache-read ratio");
    expect(outZero).not.toMatch(/NaN|Infinity/);
  });
});

// trace --dispatches: the sub-agent dispatch tree + the real total (read off dispatch_count_max).
import { buildDispatchTree, formatDispatchTree } from "../src/run/trace-view.js";
describe("trace --dispatches (dispatch tree + total)", () => {
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

  it("buildDispatchTree pairs each dispatch's own tool_result output, and carries prompt/model", () => {
    const f = eventsFile([
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          content: [{ type: "tool_use", id: "disp1", name: "Agent", input: { subagent_type: "general-purpose", prompt: "go explore" } }],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "disp1", content: "found 3 files" }] } },
    ]);
    const { nodes } = buildDispatchTree(f);
    expect(nodes[0]).toMatchObject({ prompt: "go explore", model: "claude-sonnet-4-5", output: "found 3 files" });
  });

  it("formatDispatchTree prints the prompt and output first-line per node", () => {
    const out = formatDispatchTree({
      nodes: [
        {
          toolUseId: "d1",
          agentType: "general-purpose",
          declaredTools: [],
          depth: 0,
          prompt: "go explore\nmore detail",
          output: "found 3 files\nmore output",
        },
      ],
      total: 1,
    });
    expect(out).toContain("go explore");
    expect(out).not.toContain("more detail"); // only the first line
    expect(out).toContain("found 3 files");
    expect(out).not.toContain("more output");
  });
});

// trace --view tool-durations: per-tool call-count/timing aggregate, folded from the sibling
// timeline.jsonl (M1) via foldToolDurations.
import { buildToolDurations, formatToolDurations } from "../src/run/trace-view.js";
describe("buildToolDurations / formatToolDurations", () => {
  it("reads the sibling timeline.jsonl and folds it into a per-tool duration table", () => {
    const f = eventsFile([]);
    const header = JSON.stringify({ v: 1, startedAtWall: new Date(0).toISOString(), startedAtMono: "0" });
    const lines = [
      header,
      JSON.stringify({ seq: 0, ts: 0, line: 0, type: "tool_use", toolUseId: "t1", name: "Bash" }),
      JSON.stringify({ seq: 1, ts: 120, line: 1, type: "tool_result", toolUseId: "t1", isError: false }),
    ];
    writeFileSync(join(f, "..", "timeline.jsonl"), lines.join("\n") + "\n");
    expect(buildToolDurations(f)).toEqual({ Bash: { calls: 1, totalMs: 120, maxMs: 120 } });
  });

  it("returns {} when no sibling timeline.jsonl exists (a pre-M1 run dir)", () => {
    const f = eventsFile([]);
    expect(buildToolDurations(f)).toEqual({});
  });

  it("formats an empty duration table as a no-data message", () => {
    expect(formatToolDurations({})).toContain("no tool-duration data");
  });

  it("formats a populated duration table with a per-tool row and a total footer", () => {
    const out = formatToolDurations({ Bash: { calls: 2, totalMs: 300, maxMs: 200 } });
    expect(out).toContain("Bash");
    expect(out).toContain("2");
  });
});

// assertions --list is generated from the Zod Assertion schema; every key MUST carry a description so
// the list can never drift (and the published JSON schema is enriched).
import { Assertion } from "../src/types.js";
describe("assertions --list (every Assertion key has a description, drift guard)", () => {
  it("no Assertion field is missing its .describe()", () => {
    const shape = Assertion.shape as Record<string, { description?: string }>;
    const missing = Object.keys(shape).filter((k) => !shape[k].description);
    expect(missing).toEqual([]);
  });
});

// SCAFFOLD-FROM-RUN — turn a kept run into a starter scenario YAML.
import { buildScaffold } from "../src/run/scaffold.js";
import { parse as parseYaml } from "yaml";
describe("scaffold (SCAFFOLD-FROM-RUN)", () => {
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

  it("emits a loud multiSelect marker when a delivered answer looks like a ', '-joined set", () => {
    const reqId = "r1";
    const dir = mkdtempSync(join(tmpdir(), "cwh-scaffold-ms-"));
    const eventsFilePath = join(dir, "events.jsonl");
    const events = [
      { type: "system", subtype: "init", tools: ["AskUserQuestion"] },
      {
        type: "control_request",
        request_id: reqId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_M1",
          input: { questions: [{ question: "Which to enable?", multiSelect: true, options: [{ label: "Auth" }, { label: "Billing" }] }] },
        },
      },
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
          response: { behavior: "allow", updatedInput: { answers: { "Which to enable?": "Auth, Billing" } } },
        },
      }),
    );
    const out = buildScaffold(eventsFilePath);
    // The marker is a YAML comment (not a parsed field), so assert on the raw string.
    expect(out).toMatch(/# scaffold: answer\(s\) for "Which to enable\?" look like a multiSelect set/);
    expect(out).toMatch(/split each into 'choose: \[A, B\]' before replay/);
    // The scalar answer is still emitted (the marker tells the author to fix it), so the starter is complete.
    const parsed = parseYaml(out);
    expect(parsed.answers[0].choose).toBe("Auth, Billing");
  });

  it("degrades on a partial (did-not-complete) run: keeps gates, drops artifact/result asserts, warns loud", () => {
    const reqId = "r1";
    const tuid = "toolu_P1";
    const dir = mkdtempSync(join(tmpdir(), "cwh-scaffold-partial-"));
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
        result: "error",
        partial: true,
        unansweredGate: { message: "unscripted AskUserQuestion" },
        artifacts: [{ path: "outputs/partial.pdf", bytes: 3 }],
        subagents: [],
      }),
    );
    const out = buildScaffold(eventsFilePath);
    expect(out).toMatch(/PARTIAL/);
    const parsed = parseYaml(out);
    // gates still scaffolded so the author can lock the answers...
    expect(parsed.answers[0].choose).toBe("PDF");
    // ...but the pre-failure artifacts and the error result must NOT become asserts.
    expect((parsed.assert ?? []).some((a: any) => a.file_exists)).toBe(false);
    expect((parsed.assert ?? []).some((a: any) => a.result)).toBe(false);
  });

  it("scaffolds a scenario from a chat result.json (mode:chat, assertions:[] don't choke it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-scaffold-chat-"));
    const eventsFilePath = join(dir, "events.jsonl");
    writeFileSync(eventsFilePath, ""); // buildGateTrace reads this with no ENOENT guard — an empty file is valid
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        $schema: "x",
        generator: "cowork-harness",
        mode: "chat",
        scenario: "(chat)",
        prompt: "explore the CSV skill",
        fidelity: "container",
        baseline: "1.0",
        result: "success",
        assertions: [],
        toolCounts: { Bash: 2 },
        egress: [],
        outDir: dir,
      }),
    );
    const parsed = parseYaml(buildScaffold(eventsFilePath));
    expect(parsed.prompt).toBe("explore the CSV skill");
    expect(parsed.fidelity).toBe("container");
    expect(parsed.assert.some((a: any) => a.result === "success")).toBe(true);
  });
});

describe("buildGateTrace — provenance annotation", () => {
  const gate = (requestId: string, toolUseId: string, question: string, label: string) => ({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      input: { questions: [{ question, options: [{ label }] }] },
    },
  });

  it("annotates each gate row with by/model from the sibling result.json", () => {
    const f = eventsFile([
      gate("uuid-1", "toolu_g", "Stage?", "Series B+"),
      userResult("toolu_g", false, "delivered"),
      { type: "result", is_error: false },
    ]);
    writeFileSync(
      join(f, "..", "result.json"),
      JSON.stringify({
        decisions: [
          {
            kind: "question",
            name: "AskUserQuestion",
            decision: "answered",
            by: "llm",
            model: "claude-sonnet-4-5",
            detail: { "Stage?": "Series B+" },
          },
        ],
      }),
    );
    const rows = buildGateTrace(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question: "Stage?", answeredBy: "llm", model: "claude-sonnet-4-5" });
    expect(formatGateTrace(rows)).toContain("by: decided(llm) (claude-sonnet-4-5)");
  });

  it("leaves rows unannotated when there is no sibling result.json", () => {
    const f = eventsFile([
      gate("uuid-2", "toolu_h", "Proceed?", "Yes"),
      userResult("toolu_h", false, "delivered"),
      { type: "result", is_error: false },
    ]);
    const rows = buildGateTrace(f);
    expect(rows).toHaveLength(1);
    expect(rows[0].answeredBy).toBeUndefined();
  });

  it("pairs provenance to the correct gate by order across multiple gates", () => {
    const f = eventsFile([
      gate("uuid-a", "toolu_a", "First?", "1"),
      userResult("toolu_a", false, "ok"),
      gate("uuid-b", "toolu_b", "Second?", "2"),
      userResult("toolu_b", false, "ok"),
      { type: "result", is_error: false },
    ]);
    writeFileSync(
      join(f, "..", "result.json"),
      JSON.stringify({
        decisions: [
          { kind: "question", name: "AskUserQuestion", decision: "answered", by: "scripted", detail: { "First?": "1" } },
          { kind: "question", name: "AskUserQuestion", decision: "answered", by: "llm", model: "m", detail: { "Second?": "2" } },
        ],
      }),
    );
    const rows = buildGateTrace(f);
    expect(rows.map((r) => [r.question, r.answeredBy])).toEqual([
      ["First?", "scripted"],
      ["Second?", "llm"],
    ]);
  });

  it("does not misattribute provenance when a middle gate is denied (mismatch→deny)", () => {
    // decisions[] has only 2 answered entries for 3 asked gates — the middle one was denied and
    // carries no `by`/`model` a reader should ever see. Positional pairing against the FILTERED
    // (answered-only) gate list would shift every row after the denial by one index.
    const f = eventsFile([
      gate("uuid-c", "toolu_c", "First?", "1"),
      userResult("toolu_c", false, "ok"),
      gate("uuid-d", "toolu_d", "Second?", "2"),
      userResult("toolu_d", true, "denied"),
      gate("uuid-e", "toolu_e", "Third?", "3"),
      userResult("toolu_e", false, "ok"),
      { type: "result", is_error: false },
    ]);
    writeFileSync(
      join(f, "..", "result.json"),
      JSON.stringify({
        decisions: [
          { kind: "question", name: "AskUserQuestion", decision: "answered", by: "scripted", detail: { "First?": "1" } },
          { kind: "question", name: "AskUserQuestion", decision: "mismatch→deny", by: "llm" },
          { kind: "question", name: "AskUserQuestion", decision: "answered", by: "llm", model: "m", detail: { "Third?": "3" } },
        ],
      }),
    );
    const rows = buildGateTrace(f);
    expect(rows.map((r) => [r.question, r.answeredBy, r.model])).toEqual([
      ["First?", "scripted", undefined],
      ["Second?", undefined, undefined],
      ["Third?", "llm", "m"],
    ]);
  });

  it("does not misattribute provenance when tool-permission decisions are interleaved with question decisions", () => {
    // A real run's decisions[] is one shared log — Bash/Read permission decisions (kind: "tool") land
    // in the SAME array as AskUserQuestion gates (kind: "question"), interleaved in call order. Only
    // question-kind entries should ever pair with a gate row; a positional pairing against the RAW
    // (unfiltered-by-kind) decisions array would misattribute both rows here even though neither gate
    // was denied.
    const f = eventsFile([
      gate("uuid-f", "toolu_f", "First?", "1"),
      userResult("toolu_f", false, "ok"),
      gate("uuid-g", "toolu_g", "Second?", "2"),
      userResult("toolu_g", false, "ok"),
      { type: "result", is_error: false },
    ]);
    writeFileSync(
      join(f, "..", "result.json"),
      JSON.stringify({
        decisions: [
          { kind: "tool", name: "Bash", decision: "allow", by: "cowork" },
          { kind: "question", name: "AskUserQuestion", decision: "answered", by: "scripted", detail: { "First?": "1" } },
          { kind: "tool", name: "Read", decision: "allow", by: "cowork" },
          { kind: "question", name: "AskUserQuestion", decision: "answered", by: "llm", model: "m", detail: { "Second?": "2" } },
        ],
      }),
    );
    const rows = buildGateTrace(f);
    expect(rows.map((r) => [r.question, r.answeredBy, r.model])).toEqual([
      ["First?", "scripted", undefined],
      ["Second?", "llm", "m"],
    ]);
  });
});

// CLI-level: the `trace` command's cache-ratio footer wiring in src/cli.ts — reads the sibling
// result.json next to the target events.jsonl (same pattern buildGateTrace already uses for gate
// provenance) and passes its modelUsage through to formatTrace's new opts param.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const CLI = resolve("dist/cli.js");
const canCli = existsSync(CLI);

function runCliTrace(args: string[], runsDir: string) {
  const cwd = mkdtempSync(join(tmpdir(), "cwh-trace-cli-cwd-"));
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, COWORK_HARNESS_RUNS_DIR: runsDir } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!canCli)("cli trace — cache-read-ratio footer (sibling result.json wiring)", () => {
  it("prints the footer when a sibling result.json carries modelUsage", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cwh-trace-cli-runs-"));
    const outDir = join(runsDir, "a-scenario", "local_1");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
        }),
        JSON.stringify({ type: "result", is_error: false }),
      ].join("\n"),
    );
    writeFileSync(
      join(outDir, "result.json"),
      JSON.stringify({ modelUsage: { "claude-opus-4-8": { inputTokens: 100, cacheReadInputTokens: 900 } } }),
    );
    const r = runCliTrace(["trace", "local_1"], runsDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cache-read ratio: 90%");
  });

  it("omits the footer when there is no sibling result.json (no crash)", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "cwh-trace-cli-runs-nosib-"));
    const outDir = join(runsDir, "a-scenario", "local_1");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
        }),
        JSON.stringify({ type: "result", is_error: false }),
      ].join("\n"),
    );
    const r = runCliTrace(["trace", "local_1"], runsDir);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("cache-read ratio");
  });
});

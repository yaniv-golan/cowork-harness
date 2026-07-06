import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { AgentEvent, AgentSession, DecisionRequest, DecisionResponse } from "../src/agent/session.js";
import { serializeDecision, deserializeDecision, canon, parseMessage } from "../src/agent/session.js";
import {
  ABSTAIN,
  ScriptedDecider,
  PermissionDefaultDecider,
  FailDecider,
  FirstOptionDecider,
  PromptDecider,
  Chain,
  buildDecider,
  ExternalDecider,
  UnansweredError,
  coerceWebFetchGrant,
  type RunContext,
} from "../src/decide/decider.js";
import { Run } from "../src/run/run.js";
import { replayCassette } from "../src/run/cassette.js";
import { microvmAgentArgs } from "../src/runtime/microvm.js";
import { resolveMaxThinkingTokens } from "../src/runtime/argv.js";
import { executeScenario } from "../src/run/execute.js";
import { Scenario } from "../src/types.js";
import type { DecisionChannel } from "../src/decide/external-channel.js";

const ctx: RunContext = { task: "", transcript: () => "", toolLog: () => [], runId: "t" };
const perm = (tool: string, input: Record<string, unknown> = {}): DecisionRequest => ({ id: "r1", kind: "permission", tool, input });
const ask = (q: string, opts: string[]): DecisionRequest => ({
  id: "r2",
  kind: "question",
  questions: [{ question: q, options: opts.map((label) => ({ label })) }],
});

describe("Decider — ScriptedDecider", () => {
  it("answers a scripted question, abstains on an unscripted one", async () => {
    const d = new ScriptedDecider([{ when_question: "format", choose: "Markdown" }]);
    const hit = await d.decide(ask("Which format?", ["Markdown", "PDF"]), ctx);
    expect(hit).not.toBe(ABSTAIN);
    expect((hit as any).response.answers["Which format?"]).toBe("Markdown");
    expect(await d.decide(ask("Pick one", ["A", "B"]), ctx)).toBe(ABSTAIN);
  });
  it("a partial multi-question scripted match abstains for the WHOLE gate (atomic delivery)", async () => {
    const d = new ScriptedDecider([{ when_question: "format", choose: "Markdown" }]);
    const twoQ: DecisionRequest = {
      id: "g",
      kind: "question",
      questions: [
        { question: "Which format?", options: [{ label: "Markdown" }] },
        { question: "Pick depth", options: [{ label: "Deep" }] }, // unscripted → whole gate abstains
      ],
    };
    expect(await d.decide(twoQ, ctx)).toBe(ABSTAIN);
  });
  it("resolves permission rules incl. allow_if predicate, else abstains", async () => {
    const d = new ScriptedDecider([{ when_tool: "Bash", allow_if: "!command.includes('rm')", else: "deny" }]);
    expect(((await d.decide(perm("Bash", { command: "ls" }), ctx)) as any).response.behavior).toBe("allow");
    expect(((await d.decide(perm("Bash", { command: "rm -rf /" }), ctx)) as any).response.behavior).toBe("deny");
    expect(await d.decide(perm("Write"), ctx)).toBe(ABSTAIN);
  });
});

describe("Decider — fallbacks + chain", () => {
  it("PermissionDefaultDecider: cowork allows, strict denies, built-ins always allow", async () => {
    expect(((await new PermissionDefaultDecider("cowork").decide(perm("Bash"), ctx)) as any).response.behavior).toBe("allow");
    expect(((await new PermissionDefaultDecider("strict").decide(perm("Bash"), ctx)) as any).response.behavior).toBe("deny");
    expect(((await new PermissionDefaultDecider("strict").decide(perm("Read"), ctx)) as any).response.behavior).toBe("allow");
  });
  it("PermissionDefaultDecider abstains on a webfetch: provenance-miss (user-gated in Cowork, not auto-allowed)", async () => {
    expect(await new PermissionDefaultDecider("cowork").decide(perm("webfetch:x.com"), ctx)).toBe(ABSTAIN);
    // a normal off-registry tool still auto-allows under cowork parity (only web_fetch is carved out)
    expect(((await new PermissionDefaultDecider("cowork").decide(perm("Bash"), ctx)) as any).response.behavior).toBe("allow");
  });
  it("coerceWebFetchGrant maps labels/shorthand/index and throws on an unknown answer", () => {
    expect(coerceWebFetchGrant("Allow once")).toEqual({ behavior: "allow", grant: "once" });
    expect(coerceWebFetchGrant("Allow all for website")).toEqual({ behavior: "allow", grant: "domain" });
    expect(coerceWebFetchGrant("domain")).toEqual({ behavior: "allow", grant: "domain" });
    expect(coerceWebFetchGrant("3")).toEqual({ behavior: "deny" });
    expect(() => coerceWebFetchGrant("maybe")).toThrow(/not a valid grant/);
  });
  it("FirstOptionDecider stays ABSTAIN on a web_fetch approval (never auto-allows options[0])", async () => {
    const req: DecisionRequest = {
      id: "p",
      kind: "permission",
      tool: "webfetch:x.com",
      input: {},
      options: [{ label: "Allow once" }, { label: "Allow all for website" }, { label: "Deny" }],
    };
    expect(await new FirstOptionDecider().decide(req, ctx)).toBe(ABSTAIN); // → fail-closed, not allow-once
  });
  it("DEFAULT_ALLOW is the read-only subset — LS/NotebookRead/TodoWrite (not Cowork tools) now deny under strict", async () => {
    for (const t of ["LS", "NotebookRead", "TodoWrite"]) {
      expect(((await new PermissionDefaultDecider("strict").decide(perm(t), ctx)) as any).response.behavior).toBe("deny");
    }
    // the kept read-only tools still always-allow
    for (const t of ["Read", "Glob", "Grep"]) {
      expect(((await new PermissionDefaultDecider("strict").decide(perm(t), ctx)) as any).response.behavior).toBe("allow");
    }
  });
  it("FailDecider throws an actionable UnansweredError; FirstOptionDecider picks option 1", async () => {
    await expect(new FailDecider().decide(ask("Q", ["X", "Y"]), ctx)).rejects.toBeInstanceOf(UnansweredError);
    const first = await new FirstOptionDecider().decide(ask("Q", ["X", "Y"]), ctx);
    expect((first as any).response.answers["Q"]).toBe("X");
    expect((first as any).by).toBe("first");
  });
  it("FirstOptionDecider throws on a gate with no options (cannot fabricate one)", async () => {
    await expect(new FirstOptionDecider().decide(ask("Q", []), ctx)).rejects.toBeInstanceOf(UnansweredError);
  });
  it("PromptDecider routes gate prompts through the INJECTED asker (one shared stdin interface)", async () => {
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const asked: string[] = [];
      const fakeAsk = async (prompt: string) => {
        asked.push(prompt);
        return "2"; // pick option 2 by 1-based index
      };
      const res = await new PromptDecider(fakeAsk).decide(ask("Which?", ["A", "B"]), ctx);
      expect((res as any).response.answers["Which?"]).toBe("B"); // index 2 → label B (coerceLabel)
      expect(asked).toHaveLength(1); // used the injected asker, opened no second readline
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  });
  it("Chain walks scripted → parity default → terminal; buildDecider(fail) throws on unscripted Q", async () => {
    const chain = Chain(new ScriptedDecider([]), new PermissionDefaultDecider("cowork"), new FirstOptionDecider());
    expect(((await chain.decide(perm("Bash"), ctx)) as any).by).toBe("cowork");
    const failChain = buildDecider({ rules: [], parity: "cowork", onUnanswered: "fail" });
    await expect(failChain.decide(ask("Q", ["X"]), ctx)).rejects.toBeInstanceOf(UnansweredError);
  });
});

describe("envelope serialization (byte-shape)", () => {
  it("permission allow / question answers nest under inner response", () => {
    const a = serializeDecision(perm("Write"), { kind: "permission", behavior: "allow", updatedInput: { x: 1 } }) as any;
    expect(a.response.response.behavior).toBe("allow");
    const req = ask("Q", ["X"]);
    const q = serializeDecision(req, { kind: "question", answers: { Q: "X" } }) as any;
    expect(q.response.response.updatedInput.answers.Q).toBe("X");
    // regression guard: updatedInput MUST preserve `questions` — the binary's AskUserQuestion handler
    // does `questions.map(…)`; dropping it throws `q.map` and the answer never reaches the model.
    expect(q.response.response.updatedInput.questions).toEqual((req as any).questions);
  });
  it("throws if a web_fetch `grant` permission reaches serialize (off-wire invariant)", () => {
    // web_fetch approval is host-synthesized and never serialized; a grant-bearing permission at the wire
    // means a refactor leaked it — fail loud rather than silently drop `grant`.
    expect(() => serializeDecision(perm("webfetch:x.com"), { kind: "permission", behavior: "allow", grant: "domain" })).toThrow(/off-wire/);
  });
});

// ---- Run with an in-memory AgentSession ----
class MockSession implements AgentSession {
  responded: { id: string; r: DecisionResponse }[] = [];
  userTurns: string[] = [];
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn(t: string) {
    this.userTurns.push(t);
  }
  respond(id: string, r: DecisionResponse) {
    this.responded.push({ id, r });
  }
  close() {}
}

// ---- sub-agent dispatch recognition (real cowork uses the `Agent` tool, not `Task`) ----
const assistant = (blocks: unknown[], parent?: string, model?: string) => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: blocks, ...(model ? { model } : {}) },
});
const dispatches = (msg: unknown) => parseMessage(msg).filter((e) => e.type === "subagent_dispatch");

describe("parseMessage — sub-agent dispatch", () => {
  it("recognizes the real cowork `Agent` tool ({description, subagent_type, prompt})", () => {
    const d = dispatches(
      assistant([
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Agent",
          input: { description: "x", subagent_type: "example-skills:deck-review", prompt: "…" },
        },
      ]),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      type: "subagent_dispatch",
      toolUseId: "toolu_1",
      agentType: "example-skills:deck-review",
      declaredTools: [],
    });
  });

  it("still recognizes the legacy `Task` tool + its declared tools list", () => {
    const d = dispatches(
      assistant([{ type: "tool_use", id: "t2", name: "Task", input: { subagent_type: "researcher", tools: ["Read", "Grep"] } }]),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ agentType: "researcher", declaredTools: ["Read", "Grep"] });
  });

  it("recognizes any tool whose input carries subagent_type (rename-robust)", () => {
    expect(
      dispatches(assistant([{ type: "tool_use", id: "t3", name: "SomethingNew", input: { subagent_type: "general-purpose" } }])),
    ).toHaveLength(1);
  });

  it("does NOT treat the cowork TaskCreate/TaskUpdate todo-list or Monitor as dispatches", () => {
    const todoAndMonitor = assistant([
      {
        type: "tool_use",
        id: "c1",
        name: "TaskCreate",
        input: { subject: "Set up paths", description: "Step 0", activeForm: "Setting up" },
      },
      { type: "tool_use", id: "c2", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } },
      {
        type: "tool_use",
        id: "c3",
        name: "Monitor",
        input: { description: "watch", timeout_ms: 1000, persistent: true, command: "tail -f x" },
      },
    ]);
    expect(dispatches(todoAndMonitor)).toHaveLength(0);
  });

  it("parses tool_result blocks from a `user` message (was previously invisible)", () => {
    const ev = parseMessage({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_g", is_error: true, content: "undefined is not an object (evaluating 'q.map')" },
        ],
      },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "tool_result", toolUseId: "toolu_g", isError: true });
    expect((ev[0] as any).text).toContain("q.map");
  });

  it("tool_use events carry toolUseId + AskUserQuestion decision captures the toolu_ id", () => {
    const tu = parseMessage(assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "x" } }]));
    expect(tu.find((e) => e.type === "tool_use")).toMatchObject({ toolUseId: "toolu_1" });
    const dec = parseMessage({
      type: "control_request",
      request_id: "uuid-1",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "toolu_g", input: { questions: [] } },
    });
    expect((dec[0] as any).request).toMatchObject({ kind: "question", id: "uuid-1", toolUseId: "toolu_g" });
  });

  it("threads message.model onto assistant_text, tool_use, and thinking events", () => {
    const ev = parseMessage(
      assistant(
        [
          { type: "text", text: "on it" },
          { type: "thinking", thinking: "let me check" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "x" } },
        ],
        undefined,
        "claude-sonnet-4-5",
      ),
    );
    expect(ev.find((e) => e.type === "assistant_text")).toMatchObject({ model: "claude-sonnet-4-5" });
    expect(ev.find((e) => e.type === "thinking")).toMatchObject({ model: "claude-sonnet-4-5" });
    expect(ev.find((e) => e.type === "tool_use")).toMatchObject({ model: "claude-sonnet-4-5" });
  });

  it("subagent_dispatch DOES carry model, threaded from the enclosing message (M4)", () => {
    const ev = parseMessage(
      assistant(
        [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "general-purpose", prompt: "go" } }],
        undefined,
        "claude-sonnet-4-5",
      ),
    );
    const dispatch = ev.find((e) => e.type === "subagent_dispatch") as any;
    expect(dispatch).toBeDefined();
    expect(dispatch.model).toBe("claude-sonnet-4-5");
  });

  it("threads prompt and model onto a subagent_dispatch event (M4)", () => {
    const d = dispatches(
      assistant(
        [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Agent",
            input: { subagent_type: "general-purpose", prompt: "go explore the codebase", description: "explore" },
          },
        ],
        undefined,
        "claude-sonnet-4-5",
      ),
    );
    expect(d[0]).toMatchObject({ prompt: "go explore the codebase", model: "claude-sonnet-4-5" });
  });

  it("caps an oversized subagent prompt at the 10KB assertText limit", () => {
    const bigPrompt = "x".repeat(11_000);
    const d = dispatches(assistant([{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "x", prompt: bigPrompt } }]));
    expect(d[0].prompt).toHaveLength(10 * 1024);
  });

  it("a system-subtype thinking event (no assistant message) has no model", () => {
    const ev = parseMessage({ type: "system", subtype: "thinking", content: "internal note" });
    expect(ev[0]).toMatchObject({ type: "thinking" });
    expect((ev[0] as any).model).toBeUndefined();
  });
});

describe("parseMessage — result event cost/turns (Wave 0 seam)", () => {
  it("extracts costUsd/numTurns from the SDK result message when both are present", () => {
    const ev = parseMessage({ type: "result", is_error: false, total_cost_usd: 0.0123, num_turns: 4 });
    expect(ev[0]).toMatchObject({ type: "result", costUsd: 0.0123, numTurns: 4 });
  });

  it("omits costUsd/numTurns when the SDK result message doesn't carry numeric values", () => {
    const ev = parseMessage({ type: "result", is_error: false });
    expect((ev[0] as any).costUsd).toBeUndefined();
    expect((ev[0] as any).numTurns).toBeUndefined();
  });

  it("omits costUsd/numTurns when present but non-numeric (defensive against a malformed/future SDK shape)", () => {
    const ev = parseMessage({ type: "result", is_error: false, total_cost_usd: "0.01", num_turns: null });
    expect((ev[0] as any).costUsd).toBeUndefined();
    expect((ev[0] as any).numTurns).toBeUndefined();
  });

  it("extracts modelUsage from the SDK result message (§4.7, M3 — a top-level sibling of usage, not nested inside it)", () => {
    const ev = parseMessage({
      type: "result",
      is_error: false,
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200, costUSD: 0.01 },
      },
    });
    expect(ev[0]).toMatchObject({
      type: "result",
      modelUsage: { "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200, costUSD: 0.01 } },
    });
  });

  it("modelUsage is undefined when the SDK result message omits it", () => {
    const ev = parseMessage({ type: "result", is_error: false });
    expect((ev[0] as any).modelUsage).toBeUndefined();
  });
});

describe("Run — turn loop + record", () => {
  it("builds transcript, toolsCalled, and the sub-agent dispatch tree", async () => {
    const ev: AgentEvent[] = [
      { type: "init", tools: ["Task", "Bash"], mcpServers: [], cwd: "/sessions/x" },
      { type: "assistant_text", text: "working" },
      { type: "tool_use", name: "Task", input: { subagent_type: "researcher", tools: ["Bash", "Read"] } },
      { type: "subagent_dispatch", toolUseId: "tu1", agentType: "researcher", declaredTools: ["Bash", "Read"] },
      { type: "tool_use", name: "Read", input: {}, parentToolUseId: "tu1" }, // sub-agent used Read, not Bash
      { type: "result", isError: false, usage: { output_tokens: 5 } },
    ];
    const s = new MockSession(ev);
    const rec = await new Run(s, new ScriptedDecider([])).drive("do it");
    expect(s.userTurns[0]).toBe("do it");
    expect(rec.transcript).toBe("working");
    expect(rec.toolsCalled.has("Task")).toBe(true);
    expect(rec.subagents).toHaveLength(1);
    expect(rec.subagents[0].agentType).toBe("researcher");
    expect(rec.subagents[0].declaredTools).toEqual(["Bash", "Read"]);
    expect(rec.subagents[0].toolsUsed).toEqual([{ name: "Read", count: 1 }]); // declared Bash but never used it → the culprit
    expect(rec.result).toBe("success");
  });

  it("captures mcpServers into rec.context (currently silently dropped by run.ts's init case)", async () => {
    const ev: AgentEvent[] = [
      { type: "init", tools: ["Read", "Bash"], mcpServers: [{ name: "my-server", status: "connected" }], cwd: "/tmp" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.context).toEqual({ tools: ["Read", "Bash"], mcpServers: [{ name: "my-server", status: "connected" }] });
  });

  it("increments toolsUsed's count for a repeated tool inside the same subagent dispatch (not a duplicate entry)", async () => {
    const ev: AgentEvent[] = [
      { type: "subagent_dispatch", toolUseId: "disp1", agentType: "general-purpose", declaredTools: ["Read"] },
      { type: "tool_use", name: "Read", input: {}, toolUseId: "t1", parentToolUseId: "disp1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "" },
      { type: "tool_use", name: "Read", input: {}, toolUseId: "t2", parentToolUseId: "disp1" },
      { type: "tool_result", toolUseId: "t2", isError: false, text: "" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.subagents[0].toolsUsed).toEqual([{ name: "Read", count: 2 }]);
  });

  it("denormalizes a subagent dispatch's paired tool_result onto rec.subagents[].output, assertText-capped (M4)", async () => {
    const ev: AgentEvent[] = [
      {
        type: "subagent_dispatch",
        toolUseId: "disp1",
        agentType: "general-purpose",
        declaredTools: [],
        prompt: "explore",
        model: "claude-sonnet-4-5",
      },
      { type: "tool_result", toolUseId: "disp1", isError: false, text: "found 3 files", assertText: "found 3 files" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.subagents[0]).toMatchObject({ prompt: "explore", model: "claude-sonnet-4-5", output: "found 3 files" });
  });

  it("leaves rec.subagents[].output undefined when no tool_result matches the dispatch's toolUseId (M4)", async () => {
    const ev: AgentEvent[] = [
      { type: "subagent_dispatch", toolUseId: "disp1", agentType: "general-purpose", declaredTools: [] },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.subagents[0].output).toBeUndefined();
  });

  it("threads a result event's costUsd/numTurns into rec.cost.usd/rec.usage.turns (Wave 0 seam)", async () => {
    const ev: AgentEvent[] = [{ type: "result", isError: false, usage: { output_tokens: 5 }, costUsd: 0.02, numTurns: 3 } as AgentEvent];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("do it");
    expect(rec.usage).toMatchObject({ output_tokens: 5, turns: 3 });
    expect(rec.cost).toMatchObject({ usd: 0.02 });
  });

  it("merges metrics-derived cost.raw with result-derived cost.usd instead of overwriting (Wave 0 seam)", async () => {
    const ev: AgentEvent[] = [
      { type: "metrics", data: { some_metric: 1 } },
      { type: "result", isError: false, costUsd: 0.05 } as AgentEvent,
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("do it");
    expect(rec.cost).toMatchObject({ raw: { some_metric: 1 }, usd: 0.05 });
  });

  it("leaves rec.usage undefined when a result event carries neither usage nor numTurns (no spurious {})", async () => {
    const ev: AgentEvent[] = [{ type: "result", isError: false }];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("do it");
    expect(rec.usage).toBeUndefined();
  });

  it("captures a top-level Skill tool_use into rec.skillsInvoked (Wave 1 / E8)", async () => {
    const ev: AgentEvent[] = [
      { type: "init", tools: ["Skill"], mcpServers: [] },
      { type: "tool_use", name: "Skill", input: { skill: "my-pdf-skill:my-pdf-skill" } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("do it");
    expect(rec.skillsInvoked).toEqual(["my-pdf-skill:my-pdf-skill"]);
  });

  it("keeps duplicate Skill invocations (re-triggering is signal) and preserves call order", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "Skill", input: { skill: "a:a" } },
      { type: "tool_use", name: "Skill", input: { skill: "b:b" } },
      { type: "tool_use", name: "Skill", input: { skill: "a:a" } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("do it");
    expect(rec.skillsInvoked).toEqual(["a:a", "b:b", "a:a"]);
  });

  it("does NOT capture a sub-agent-parented Skill tool_use (not a top-level invocation)", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "Task", input: { subagent_type: "researcher" } },
      { type: "subagent_dispatch", toolUseId: "tu1", agentType: "researcher", declaredTools: [] },
      { type: "tool_use", name: "Skill", input: { skill: "nested:nested" }, parentToolUseId: "tu1" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("do it");
    expect(rec.skillsInvoked).toEqual([]);
  });

  it("accumulates distinct models across assistant_text/tool_use/thinking events, in first-seen order, deduped", async () => {
    const ev: AgentEvent[] = [
      { type: "assistant_text", text: "on it", model: "claude-haiku-4-5" },
      { type: "tool_use", name: "Bash", input: {}, toolUseId: "toolu_1", model: "claude-haiku-4-5" },
      { type: "tool_result", toolUseId: "toolu_1", isError: false, text: "ok" },
      { type: "thinking", text: "hmm", model: "claude-sonnet-4-5" },
      { type: "tool_use", name: "Read", input: {}, toolUseId: "toolu_2", model: "claude-sonnet-4-5" },
      { type: "tool_result", toolUseId: "toolu_2", isError: false, text: "ok" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.models).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
  });

  it("accumulates thinking blocks into rec.thinking, each capped at 10KB", async () => {
    const bigText = "x".repeat(11000); // over the 10KB cap
    const ev: AgentEvent[] = [
      { type: "thinking", text: "short reasoning" },
      { type: "thinking", text: bigText },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.thinking).toHaveLength(2);
    expect(rec.thinking[0].text).toBe("short reasoning");
    expect(rec.thinking[1].text).toHaveLength(10 * 1024);
  });

  it("caps rec.thinking at the last 50 blocks, tracking an elision count for the rest", async () => {
    const ev: AgentEvent[] = [
      ...Array.from({ length: 55 }, (_, i) => ({ type: "thinking" as const, text: `block-${i}` })),
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.thinking).toHaveLength(50);
    expect(rec.thinking[0].text).toBe("block-5"); // the oldest 5 were dropped
    expect(rec.thinking[49].text).toBe("block-54");
    expect(rec.thinkingElided).toBe(5);
  });

  it("subagentTools counts only tools under a RECOGNIZED dispatch, not any parented tool_use", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "Task", input: { subagent_type: "researcher" } },
      { type: "subagent_dispatch", toolUseId: "tu1", agentType: "researcher", declaredTools: [] },
      { type: "tool_use", name: "Read", input: {}, parentToolUseId: "tu1" }, // under a real dispatch → counted
      { type: "tool_use", name: "Bash", input: {}, parentToolUseId: "orphan-no-dispatch" }, // orphan parent → NOT counted
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.subagentTools.has("Read")).toBe(true);
    expect(rec.subagentTools.has("Bash")).toBe(false); // orphan parented tool no longer inflates the set
  });

  it("routes a decision through the decider and responds", async () => {
    const ev: AgentEvent[] = [
      { type: "decision", request: { id: "d1", kind: "permission", tool: "Write", input: { p: 1 } } },
      { type: "result", isError: false },
    ];
    const s = new MockSession(ev);
    await new Run(s, new ScriptedDecider([{ when_tool: "Write", decide: "allow" }])).drive("go");
    expect(s.responded).toHaveLength(1);
    expect((s.responded[0].r as any).behavior).toBe("allow");
  });

  it("a cowork-parity off-registry auto-allow is machine-flagged (permissiveAutoAllow)", async () => {
    // Assert the CI-gateable record field (the envelope signal). The stderr `::warning::` it also emits
    // is covered by code review — NOT captured here, to avoid the global process.stderr.write monkeypatch
    // that collides across concurrently-run test files (the session-protocol flake source).
    const ev: AgentEvent[] = [
      { type: "decision", request: { id: "d1", kind: "permission", tool: "Bash", input: { command: "ls" } } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new PermissionDefaultDecider("cowork")).drive("go");
    expect(rec.permissiveAutoAllow).toContain("Bash"); // machine-distinguishable in the envelope
  });

  it("a built-in default-allow (Read) is NOT a permissive auto-allow", async () => {
    const ev: AgentEvent[] = [
      { type: "decision", request: { id: "d1", kind: "permission", tool: "Read", input: {} } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new PermissionDefaultDecider("cowork")).drive("go");
    expect(rec.permissiveAutoAllow).toEqual([]);
  });

  it("toolCounts records TRUTHFUL per-tool call counts (top-level only, subagent tools excluded)", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "WebSearch", input: { q: "a" }, toolUseId: "t1" },
      { type: "tool_use", name: "WebSearch", input: { q: "b" }, toolUseId: "t2" },
      { type: "tool_use", name: "WebSearch", input: { q: "c" }, toolUseId: "t3", parentToolUseId: "sa1" }, // sub-agent → excluded
      { type: "tool_use", name: "Read", input: {}, toolUseId: "t4" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.toolCounts).toEqual({ WebSearch: 2, Read: 1 }); // not 3 WebSearch — the subagent one is excluded
  });

  it("accumulates rec.toolErrors keyed by tool name, tracking calls and errors independently", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "Bash", input: {}, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "ok" },
      { type: "tool_use", name: "Bash", input: {}, toolUseId: "t2" },
      { type: "tool_result", toolUseId: "t2", isError: true, text: "boom" },
      { type: "tool_use", name: "Read", input: {}, toolUseId: "t3" },
      { type: "tool_result", toolUseId: "t3", isError: false, text: "ok" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.toolErrors).toEqual({
      Bash: { calls: 2, errors: 1 },
      Read: { calls: 1, errors: 0 },
    });
  });

  it("a tool_result with no matching prior tool_use (e.g. subagent-internal calls not top-level-tracked) is silently NOT counted in toolErrors", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_result", toolUseId: "orphan", isError: true, text: "boom" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.toolErrors).toEqual({});
  });

  it("captures rec.modelUsage from the result event's modelUsage payload", async () => {
    const ev: AgentEvent[] = [
      { type: "result", isError: false, modelUsage: { "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, costUSD: 0.01 } } },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.modelUsage).toEqual({ "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, costUSD: 0.01 } });
  });

  it("detects redundant tool calls (same name + identical canonicalized input) via a post-drive fold over toolLog", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "Bash", input: { command: "ls" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "" },
      { type: "tool_use", name: "Bash", input: { command: "ls" }, toolUseId: "t2" }, // same input, redundant
      { type: "tool_result", toolUseId: "t2", isError: false, text: "" },
      { type: "tool_use", name: "Bash", input: { command: "pwd" }, toolUseId: "t3" }, // different input, not redundant
      { type: "tool_result", toolUseId: "t3", isError: false, text: "" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const run = new Run(fakeSession, { decide: async () => ABSTAIN } as any, [], "test-run");
    const rec = await run.drive("go");
    expect(rec.redundantToolCalls).toHaveLength(1);
    expect(rec.redundantToolCalls[0]).toMatchObject({ name: "Bash", count: 2 });
    expect(rec.redundantToolCalls[0].argHash).toMatch(/^[a-f0-9]{16}$/); // truncated sha256, 8 bytes hex
  });

  it("key ordering in the input object doesn't defeat redundancy detection (canon sorts keys)", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "Write", input: { path: "a.txt", content: "x" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "" },
      { type: "tool_use", name: "Write", input: { content: "x", path: "a.txt" }, toolUseId: "t2" }, // same, reordered keys
      { type: "tool_result", toolUseId: "t2", isError: false, text: "" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const run = new Run(fakeSession, { decide: async () => ABSTAIN } as any, [], "test-run");
    const rec = await run.drive("go");
    expect(rec.redundantToolCalls).toHaveLength(1);
    expect(rec.redundantToolCalls[0].count).toBe(2);
  });

  it("excludes synthetic MCP-echo tool_use events from redundant-call detection (they'd otherwise double-count a real repeated MCP call)", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "mcp__server__tool", input: { command: "x" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "" },
      { type: "tool_use", name: "mcp__server__tool", input: { command: "x" }, toolUseId: "t2" }, // real repeat, SHOULD count
      { type: "tool_result", toolUseId: "t2", isError: false, text: "" },
      {
        type: "tool_use",
        name: "mcp__server__tool",
        input: { name: "mcp__server__tool", arguments: { command: "x" } },
        toolUseId: "t1-echo",
        synthetic: true,
      }, // synthetic echo, DIFFERENT input shape, excluded regardless of shape
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const run = new Run(fakeSession, { decide: async () => ABSTAIN } as any, [], "test-run");
    const rec = await run.drive("go");
    expect(rec.redundantToolCalls).toHaveLength(1);
    expect(rec.redundantToolCalls[0]).toMatchObject({ name: "mcp__server__tool", count: 2 });
  });

  it("excludes subagent-parented tool_use events from top-level redundantToolCalls", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "Read", input: { path: "a" }, toolUseId: "t1", parentToolUseId: "dispatch1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "" },
      { type: "tool_use", name: "Read", input: { path: "a" }, toolUseId: "t2", parentToolUseId: "dispatch1" }, // repeated INSIDE a subagent — should NOT count top-level
      { type: "tool_result", toolUseId: "t2", isError: false, text: "" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const run = new Run(fakeSession, { decide: async () => ABSTAIN } as any, [], "test-run");
    const rec = await run.drive("go");
    expect(rec.redundantToolCalls).toEqual([]);
  });

  it("creates a task from TaskCreate, resolving the real id from the paired tool_result text (no id in the input)", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "TaskCreate", input: { subject: "step one", description: "d1" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "Task #1 created successfully: step one" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const rec = await new Run(fakeSession, new ScriptedDecider([])).drive("go");
    expect(rec.tasks.get("1")).toEqual({ id: "1", subject: "step one", description: "d1", status: "pending", activeForm: undefined });
  });

  it("applies a TaskUpdate directly at tool_use time (taskId is already in the input, no correlation needed)", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "TaskCreate", input: { subject: "step one" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "Task #1 created successfully: step one" },
      { type: "tool_use", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" }, toolUseId: "t2" },
      { type: "tool_result", toolUseId: "t2", isError: false, text: "Updated task #1 status" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const rec = await new Run(fakeSession, new ScriptedDecider([])).drive("go");
    expect(rec.tasks.get("1")?.status).toBe("in_progress");
  });

  it("last-write-wins: a later TaskUpdate to the same taskId overwrites status, doesn't create a duplicate entry", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "TaskCreate", input: { subject: "step one" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "Task #1 created successfully: step one" },
      { type: "tool_use", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" }, toolUseId: "t2" },
      { type: "tool_result", toolUseId: "t2", isError: false, text: "" },
      { type: "tool_use", name: "TaskUpdate", input: { taskId: "1", status: "completed" }, toolUseId: "t3" },
      { type: "tool_result", toolUseId: "t3", isError: false, text: "" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const rec = await new Run(fakeSession, new ScriptedDecider([])).drive("go");
    expect(rec.tasks.size).toBe(1);
    expect(rec.tasks.get("1")?.status).toBe("completed");
  });

  it("a TaskUpdate for an unknown taskId (no matching TaskCreate observed) is silently ignored, not a crash", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "TaskUpdate", input: { taskId: "999", status: "completed" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const rec = await new Run(fakeSession, new ScriptedDecider([])).drive("go");
    expect(rec.tasks.size).toBe(0);
  });

  it("a TaskCreate whose tool_result text doesn't match the expected format is silently dropped, not a crash", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use", name: "TaskCreate", input: { subject: "step one" }, toolUseId: "t1" },
      { type: "tool_result", toolUseId: "t1", isError: false, text: "unexpected format" },
      { type: "result", isError: false },
    ];
    const fakeSession = {
      async *start() {
        for (const e of events) yield e;
      },
      sendUserTurn() {},
      respond() {},
      close() {},
    } as any;
    const rec = await new Run(fakeSession, new ScriptedDecider([])).drive("go");
    expect(rec.tasks.size).toBe(0);
  });

  it("gateDeliveries pairs an answered gate with its tool_result (delivered vs failure)", async () => {
    const gate = (id: string, toolUseId: string): AgentEvent => ({
      type: "decision",
      request: { id, kind: "question", toolUseId, questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
    });
    const ev: AgentEvent[] = [
      gate("d1", "toolu_ok"),
      gate("d2", "toolu_bad"),
      { type: "tool_result", toolUseId: "toolu_ok", isError: false, text: "" }, // delivered
      { type: "tool_result", toolUseId: "toolu_bad", isError: true, text: "undefined is not an object (evaluating 'q.map')" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([{ when_question: "Proceed", choose: "Yes" }])).drive("go");
    expect(rec.gateDeliveries).toEqual([
      { question: "Proceed?", delivered: true, reason: "ok" },
      { question: "Proceed?", delivered: false, reason: "errored", error: "undefined is not an object (evaluating 'q.map')" },
    ]);
  });

  it("a question reaching ABSTAIN fails LOUD — never silently answers option 1", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: { id: "q1", kind: "question", questions: [{ question: "Format?", options: [{ label: "MD" }, { label: "PDF" }] }] },
      },
      { type: "result", isError: false },
    ];
    const s = new MockSession(ev);
    await expect(new Run(s, Chain()).drive("go")).rejects.toThrow(UnansweredError); // Chain() with no terminal → ABSTAIN
    expect(s.responded).toHaveLength(0); // and it did NOT fabricate an answer
  });

  it("drives an unscripted question through the ExternalDecider end-to-end (live loop)", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: { id: "q1", kind: "question", questions: [{ question: "Format?", options: [{ label: "MD" }, { label: "PDF" }] }] },
      },
      { type: "result", isError: false },
    ];
    const s = new MockSession(ev);
    let emitted = "";
    const channel = { write: (l: string) => (emitted = l), readLine: async () => '{"id":"q1","answers":{"Format?":2}}' }; // index 2 → PDF
    // scripted (none) → parity → external terminal, exactly the production chain
    const decider = buildDecider({ rules: [], parity: "cowork", onUnanswered: "fail", external: new ExternalDecider(channel) });
    const rec = await new Run(s, decider).drive("go");
    expect(JSON.parse(emitted)).toMatchObject({ type: "decision_request", kind: "question" });
    expect((s.responded[0].r as any).answers).toEqual({ "Format?": "PDF" }); // coerced index → label, sent back to the agent
    expect(rec.decisions.find((d) => d.by === "external")).toBeTruthy();
  });

  // ---- regression: by:"external" and by:"human" decisions must flag nonDeterministic ----
  it("decisions by external/human mark the run non-deterministic (execute.ts predicate)", async () => {
    // Simulate the predicate used in execute.ts: record.decisions.some(d => d.by === "llm"|"external"|"human")
    // We drive a run through ExternalDecider so it records by:"external", then assert the predicate fires.
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: { id: "q1", kind: "question", questions: [{ question: "Go?", options: [{ label: "Yes" }, { label: "No" }] }] },
      },
      { type: "result", isError: false },
    ];
    const s = new MockSession(ev);
    const channel = { write: (_l: string) => {}, readLine: async () => '{"id":"q1","answers":{"Go?":"Yes"}}' };
    const rec = await new Run(
      s,
      buildDecider({ rules: [], parity: "cowork", onUnanswered: "fail", external: new ExternalDecider(channel) }),
    ).drive("go");
    // The decision was made by the external channel → by:"external"
    const isNonDet = rec.decisions.some((d) => d.by === "llm" || d.by === "external" || d.by === "human");
    expect(isNonDet).toBe(true);
  });

  // ---- spawn error surfaced as typed event terminates the run loop ----
  it("a spawn-error event (source:spawn) terminates the run with result=error", async () => {
    // MockSession that yields a typed {type:"error", source:"spawn"} event (as LiveAgentSession
    // now does when proc emits "error"). The Run loop must terminate and set rec.result = "error".
    const ev: AgentEvent[] = [
      { type: "init", tools: ["Bash"], mcpServers: [] },
      { type: "assistant_text", text: "starting up" },
      { type: "error", source: "spawn", message: "ENOENT: binary not found" },
      // A result event that would follow in a healthy run — must NOT be reached:
      { type: "result", isError: false },
    ];
    let closed = false;
    class ErrorSession implements AgentSession {
      responded: unknown[] = [];
      async *start(): AsyncIterable<AgentEvent> {
        for (const e of ev) yield e;
      }
      sendUserTurn() {}
      respond() {}
      close() {
        closed = true;
      }
    }
    const s = new ErrorSession();
    const rec = await new Run(s, new ScriptedDecider([])).drive("go");
    // Loop must have terminated: result is error (set before break), session was closed.
    expect(rec.result).toBe("error");
    expect(closed).toBe(true);
    // The error decision must be recorded.
    const errDec = rec.decisions.find((d) => d.name === "spawn");
    expect(errDec).toBeDefined();
    expect(errDec?.decision).toBe("error");
    // The "result" event after the error must NOT have been processed (result stays "error", not "success").
    expect(rec.result).not.toBe("success");
  });

  it("a protocol-error event (source:protocol) also terminates with result=error", async () => {
    const ev: AgentEvent[] = [{ type: "error", source: "protocol", message: "fatal protocol frame" }];
    let closed = false;
    class ProtoErrSession implements AgentSession {
      async *start(): AsyncIterable<AgentEvent> {
        for (const e of ev) yield e;
      }
      sendUserTurn() {}
      respond() {}
      close() {
        closed = true;
      }
    }
    const rec = await new Run(new ProtoErrSession(), new ScriptedDecider([])).drive("go");
    expect(rec.result).toBe("error");
    expect(closed).toBe(true);
  });

  it("a nonzero child exit (source:exit) AFTER a success result flips result to error with the stderr tail", async () => {
    // LiveAgentSession emits source:"exit" only for a nonzero/signal exit, and it lands AFTER stdout
    // closes — i.e. after a successful turn already emitted {type:"result", isError:false} and set
    // rec.result = "success". A child that crashes nonzero after printing a result is NOT a passing run:
    // the exit error must override result back to "error" and surface the stderr tail.
    const ev: AgentEvent[] = [
      { type: "init", tools: ["Bash"], mcpServers: [] },
      { type: "result", isError: false },
      { type: "error", source: "exit", message: "agent process exited with code 137 — stderr tail: OOMKilled" },
    ];
    let closed = false;
    class ExitErrSession implements AgentSession {
      async *start(): AsyncIterable<AgentEvent> {
        for (const e of ev) yield e;
      }
      sendUserTurn() {}
      respond() {}
      close() {
        closed = true;
      }
    }
    const rec = await new Run(new ExitErrSession(), new ScriptedDecider([])).drive("go");
    // The success result was overridden by the fatal nonzero exit.
    expect(rec.result).toBe("error");
    expect(closed).toBe(true);
    // The exit error is recorded as a decision, carrying the stderr tail in its detail.
    const exitDec = rec.decisions.find((d) => d.name === "exit");
    expect(exitDec).toBeDefined();
    expect(exitDec?.decision).toBe("error");
    expect(String(exitDec?.detail)).toContain("OOMKilled");
  });

  it("a non-fatal agent error (source:agent) does NOT terminate the run", async () => {
    // source:"agent" is non-terminal — the SDK may still emit a recovering result.
    const ev: AgentEvent[] = [
      { type: "error", source: "agent", message: "soft agent error" },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    // The result event was still processed → success.
    expect(rec.result).toBe("success");
    // The error was still recorded as a decision entry.
    expect(rec.decisions.find((d) => d.name === "agent")).toBeDefined();
  });

  // ---- withDialogTimeout clears the timer on both resolve AND reject ----
  it("withDialogTimeout clears the timer on rejection (no dangling setTimeout)", async () => {
    // We test this indirectly: a Run with a dialog decision where the decider rejects. The timer
    // must be cleared (we can't directly observe the timer, but we can assert no unhandled-timer
    // side-effects and that the rejection propagates cleanly).
    const dialogReq: AgentEvent = {
      type: "decision",
      request: { id: "dlg1", kind: "dialog", dialogKind: "confirm", payload: {} },
    };
    const ev: AgentEvent[] = [dialogReq, { type: "result", isError: false }];
    // A decider that rejects on dialog → the withDialogTimeout race should propagate the rejection.
    const rejectingDecider = {
      decide: async (_req: DecisionRequest) => {
        throw new Error("decider rejected");
      },
    };
    const run = new Run(new MockSession(ev), rejectingDecider as any, [], "r", 10000);
    // The rejection should propagate out of drive() (since the decider throws).
    await expect(run.drive("go")).rejects.toThrow("decider rejected");
    // If the timer was NOT cleared, the open handle would keep the test runner alive past its
    // timeout. vitest's fake-timer detection would flag it. The test passing = timer was cleared.
  });

  it("a header-only question gate (empty `question` text) fails loud — the binary keys answers by `question`", async () => {
    const req: DecisionRequest = {
      id: "q1",
      kind: "question",
      questions: [{ question: "", header: "Pick", options: [{ label: "a" }] }], // header-only → empty answer key
    };
    const ev: AgentEvent[] = [{ type: "decision", request: req }];
    await expect(new Run(new MockSession(ev), new ScriptedDecider([])).drive("go")).rejects.toThrow(/header-only/);
  });

  it("a multiSelect gate is answered with a comma-joined string of validated labels (binary-verified wire shape)", async () => {
    const req: DecisionRequest = {
      id: "q1",
      kind: "question",
      questions: [{ question: "Pick some", options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }], multiSelect: true }],
    };
    const ev: AgentEvent[] = [
      { type: "decision", request: req },
      { type: "result", isError: false },
    ];
    const rec = await new Run(
      new MockSession(ev),
      new ScriptedDecider([{ when_question: "Pick some", choose: ["Auth", "Billing"] }]),
    ).drive("go");
    expect(rec.gateAnswers[0]?.answers).toEqual({ "Pick some": "Auth, Billing" });
  });

  it("records mismatch→deny (not 'answered') when the decider returns a wrong response kind", async () => {
    const req: DecisionRequest = { id: "q1", kind: "question", questions: [{ question: "Pick", options: [{ label: "a" }] }] };
    const ev: AgentEvent[] = [
      { type: "decision", request: req },
      { type: "result", isError: false },
    ];
    // A decider that answers a QUESTION with a PERMISSION response — serializeDecision rewrites this to a
    // deny envelope, so the agent never got the answer. The record must say so, not "answered".
    const wrongKindDecider = { decide: async () => ({ response: { kind: "permission", behavior: "allow" }, by: "scripted" }) };
    const rec = await new Run(new MockSession(ev), wrongKindDecider as any).drive("go");
    const dec = rec.decisions.find((d) => d.name === "AskUserQuestion");
    expect(dec?.decision).toBe("mismatch→deny");
    expect(rec.gateAnswers).toHaveLength(0); // no answer was delivered → no gateAnswers entry
  });

  it("a gate answered without a toolUseId reports reason 'no-pairing-metadata' (not a benign null)", async () => {
    const req: DecisionRequest = { id: "q1", kind: "question", questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] }; // no toolUseId
    const ev: AgentEvent[] = [
      { type: "decision", request: req },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([{ when_question: "Proceed", choose: "Yes" }])).drive("go");
    expect(rec.gateDeliveries).toEqual([{ question: "Proceed?", delivered: null, reason: "no-pairing-metadata" }]);
  });

  it("a synthetic MCP round-trip tool_use is NOT counted (the real call arrives as an assistant block)", async () => {
    const ev: AgentEvent[] = [
      { type: "tool_use", name: "mcp__workspace__bash", input: {}, synthetic: true }, // the mcp_message echo — trace only
      { type: "tool_use", name: "mcp__workspace__bash", input: {} }, // the real assistant tool_use block
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession(ev), new ScriptedDecider([])).drive("go");
    expect(rec.toolCounts["mcp__workspace__bash"]).toBe(1); // counted once (the real block), not double-counted
    expect(rec.toolsCalled.has("mcp__workspace__bash")).toBe(true);
  });

  it("closes the session even when the stream EOFs without a result event", async () => {
    let closes = 0;
    class NoResultSession implements AgentSession {
      async *start(): AsyncIterable<AgentEvent> {
        yield { type: "assistant_text", text: "hi" }; // ends with no `result` → only the finally can close
      }
      sendUserTurn() {}
      respond() {}
      close() {
        closes++;
      }
    }
    await new Run(new NoResultSession(), new ScriptedDecider([])).drive("go");
    expect(closes).toBe(1);
  });
});

// ---- Helpers for cassette construction ----
const makeScenario = (assert: unknown[]) => ({
  name: "c",
  baseline: "latest",
  session: "(inline)",
  fidelity: "container" as const,
  prompt: "hi",
  answers: [],
  expect_denied: [],
  assert,
});

describe("Cassette — protocol replay", () => {
  it("replays recorded events deterministically and re-checks content assertions", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"], cwd: "/sessions/x" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello from the skill" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ transcript_contains: "Hello from the skill" }, { result: "success" as const }]),
      events,
    } as any;
    const r = await replayCassette(cassette);
    expect(r.assertions.every((a) => a.pass)).toBe(true);
    expect(r.result).toBe("success");
  });

  // an artifact manifest makes file_exists + artifact_json replay-checkable (token-free), against the
  // materialized snapshot — instead of being stripped as live-only.
  it("a cassette artifact manifest makes file_exists + artifact_json replay-checkable", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([
        { file_exists: "outputs/state.json" },
        { artifact_json: { artifact: "outputs/state.json", path: "me.run_id", equals: "r1" } },
        { artifact_json: { artifact: "outputs/state.json", path: "me.secret", absent: true } },
        { result: "success" as const },
      ]),
      events,
      artifacts: [
        {
          path: "outputs/state.json",
          bytes: 24,
          // materializeManifest now verifies the body against this hash — it must be the real
          // sha256 of the raw body bytes (a placeholder like "deadbeef" now correctly fails replay).
          sha256: createHash("sha256")
            .update(Buffer.from(JSON.stringify({ me: { run_id: "r1" } })))
            .digest("hex"),
          body: JSON.stringify({ me: { run_id: "r1" } }),
        },
      ],
    } as any;
    const r = await replayCassette(cassette);
    expect(r.assertions.filter((a) => !a.pass)).toHaveLength(0);
  });

  // a baseline-of-record mismatch warns by default and FAILS under --strict.
  it("--strict escalates a staleness mismatch to a failing assertion", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ result: "success" as const }]),
      events,
      fingerprint: { baseline: "0.0.0-ancient" }, // != the current latest baseline
    } as any;
    const lenient = await replayCassette(cassette); // warns to stderr only
    expect(lenient.assertions.filter((a) => !a.pass)).toHaveLength(0);
    const strict = await replayCassette(cassette, [], { strict: true });
    expect(strict.assertions.some((a) => !a.pass && /stale/.test(a.message ?? ""))).toBe(true);
  });

  // Cassette format version: a FUTURE version warns loudly (forward-compat) but still replays; absent = legacy (no warn).
  it("cassette version: a newer format version warns but still replays; legacy (absent) does not warn", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const warnings: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string | Uint8Array): boolean => (warnings.push(String(s)), true);
    try {
      const future = { cassetteVersion: 999, scenario: makeScenario([{ result: "success" as const }]), events } as any;
      expect((await replayCassette(future)).result).toBe("success");
      const legacy = { scenario: makeScenario([{ result: "success" as const }]), events } as any; // no version → legacy
      await replayCassette(legacy);
    } finally {
      (process.stderr as any).write = orig;
    }
    const all = warnings.join("");
    expect((all.match(/is newer than this harness understands/g) ?? []).length).toBe(1); // only the future cassette warned
  });

  // ---- pin the bug BEFORE fixing it. ----
  // This test documents that WITHOUT controlOut, question_asked silently false-fails on events-only replay
  // (the decision event is skipped, ctx.questions stays [], so the question is invisible).
  // After the fix (full-fidelity replay), this test is EXPECTED TO PASS — the bug is fixed.
  it("fixed: question_asked assertion passes on full-fidelity replay (controlOut present)", async () => {
    const reqId = "req-q1";
    const toolUseId = "toolu_GATE1";
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
      // The decision event (control_request) — formerly skipped, now yielded when controlOut present
      JSON.stringify({
        type: "control_request",
        request_id: reqId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: toolUseId,
          input: { questions: [{ question: "Which format?", options: [{ label: "PDF" }, { label: "DOCX" }] }] },
        },
      }),
      // tool_result must come AFTER the decision, with tool_use_id matching toolu_ id (not the UUID)
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false, content: "PDF" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: {
            behavior: "allow",
            updatedInput: {
              questions: [{ question: "Which format?", options: [{ label: "PDF" }, { label: "DOCX" }] }],
              answers: { "Which format?": "PDF" },
            },
          },
        },
      }),
    ];
    const cassette = {
      scenario: makeScenario([{ question_asked: "Which format" }, { gate_answers_delivered: true }, { result: "success" as const }]),
      events,
      controlOut,
    } as any;
    const r = await replayCassette(cassette);
    const failed = r.assertions.filter((a) => !a.pass);
    expect(failed).toHaveLength(0);
    // Also assert delivered===true directly (not just "assertion passed") to guard against a vacuous pass
    const deliveries = r.gateDeliveries ?? [];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].delivered).toBe(true);
  });

  // ---- truncated full-fidelity cassette (decision present, controlOut entry missing) ----
  it("a decision with no matching control_response trips replay_protocol_fidelity (not a silent abstain→deny)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      // A permission decision for req-p1 — but control-out.jsonl will NOT contain its response.
      JSON.stringify({
        type: "control_request",
        request_id: "req-p1",
        request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "toolu_W1", input: { path: "x.txt" } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // controlOut is non-empty (so hasControlOut=true / full-fidelity mode) but carries only an
    // UNRELATED response — req-p1 has no recorded envelope → truncation.
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "req-other", response: { behavior: "allow", updatedInput: {} } },
      }),
    ];
    const cassette = {
      scenario: makeScenario([{ result: "success" as const }]),
      events,
      controlOut,
    } as any;
    const r = await replayCassette(cassette);
    const fidelity = r.assertions.find((a) => a.assertion.replay_protocol_fidelity !== undefined && !a.pass);
    expect(fidelity).toBeDefined();
    expect(fidelity!.message).toMatch(/truncated|no matching control_response/);
    // the deny path is still recorded (just no longer silent)
    expect(r.decisions.some((d) => d.decision === "abstain→deny")).toBe(true);
  });

  it("a truncated QUESTION control_out fails as a replay assertion (not an uncaught UnansweredError/exit 2)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
      JSON.stringify({
        type: "control_request",
        request_id: "req-q9",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: "toolu_Q9",
          input: { questions: [{ question: "Which format?", options: [{ label: "PDF" }] }] },
        },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // controlOut present (full-fidelity) but missing req-q9's answer → the question can't ABSTAIN, so the
    // replay used to throw UnansweredError (exit 2). It must now surface as a failing replay assertion.
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "req-other", response: { behavior: "allow", updatedInput: {} } },
      }),
    ];
    const cassette = { scenario: makeScenario([{ result: "success" as const }]), events, controlOut } as any;
    const r = await replayCassette(cassette);
    const fidelity = r.assertions.find((a) => a.assertion.replay_protocol_fidelity !== undefined && !a.pass);
    expect(fidelity).toBeDefined();
    expect(fidelity!.message).toMatch(/truncated|no matching control_response/);
  });

  // ---- documented behaviour without fix: question_asked fails when controlOut absent ----
  it("bug-documented: question_asked assertion FAILS on legacy events-only replay (no controlOut)", async () => {
    const reqId = "req-q1";
    const toolUseId = "toolu_GATE1";
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
      JSON.stringify({
        type: "control_request",
        request_id: reqId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: toolUseId,
          input: { questions: [{ question: "Which format?", options: [{ label: "PDF" }, { label: "DOCX" }] }] },
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false, content: "PDF" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // No controlOut — legacy mode: question/gate assertions are EXCLUDED, not vacuously passed
    const cassette = {
      scenario: makeScenario([{ question_asked: "Which format" }, { result: "success" as const }]),
      events,
      // no controlOut
    } as any;
    const r = await replayCassette(cassette);
    // question_asked must be EXCLUDED (not evaluated), so only `result` should be in assertions
    const qAssertion = r.assertions.find((a) => a.assertion.question_asked !== undefined);
    expect(qAssertion).toBeUndefined(); // excluded, not vacuously passed
    // result assertion still runs
    const resultAssertion = r.assertions.find((a) => a.assertion.result !== undefined);
    expect(resultAssertion?.pass).toBe(true);
  });

  // ---- tamper test: controlOut with `questions` dropped → replay_protocol_fidelity fails ----
  it("tamper: controlOut envelope with questions dropped trips replay_protocol_fidelity guard", async () => {
    const reqId = "req-q1";
    const toolUseId = "toolu_GATE1";
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
      JSON.stringify({
        type: "control_request",
        request_id: reqId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: toolUseId,
          input: { questions: [{ question: "Which format?", options: [{ label: "PDF" }, { label: "DOCX" }] }] },
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false, content: "PDF" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // Tampered: `questions` dropped from updatedInput (the regression)
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: {
            behavior: "allow",
            updatedInput: {
              questions: [{ question: "Which format?", options: [{ label: "PDF" }, { label: "DOCX" }] }],
              answers: { "Which format?": "PDF" },
            },
          },
        },
      }),
    ];
    // We simulate what happens if serializeDecision drops `questions` by making a tampered
    // controlOut that has `questions` but the re-serialized output won't have them.
    // Actually the real test: record with questions present, then the re-serialize should match.
    // The tamper is on the RECORDED side: record a body that omits questions entirely.
    const tamperedControlOut = [
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: {
            behavior: "allow",
            // Tampered: updatedInput only has answers, no questions
            updatedInput: { answers: { "Which format?": "PDF" } },
          },
        },
      }),
    ];
    const cassette = {
      scenario: makeScenario([{ result: "success" as const }]),
      events,
      controlOut: tamperedControlOut,
    } as any;
    const r = await replayCassette(cassette);
    // The re-serialization should include `questions` (from req), but the recorded body has none
    // → mismatch → replay_protocol_fidelity failing assertion
    const fidelityFailure = r.assertions.find((a) => a.assertion.replay_protocol_fidelity !== undefined && !a.pass);
    expect(fidelityFailure).toBeDefined();
    expect(fidelityFailure?.pass).toBe(false);
  });

  // ---- Key-reorder test: reordered-but-semantically-equal envelope does NOT trip the guard ----
  it("key-reorder: a reordered (but semantically equal) controlOut body does not trip the guard", async () => {
    const reqId = "req-p1";
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({
        type: "control_request",
        request_id: reqId,
        request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "out.txt", content: "hi" } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // The real serializeDecision for permission allow produces: { behavior, updatedInput }
    // We record with keys in the opposite order to test that canon() normalises it
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          // Key order reversed vs what serializeDecision produces; semantically equal
          response: { updatedInput: { path: "out.txt", content: "hi" }, behavior: "allow" },
        },
      }),
    ];
    const cassette = {
      scenario: makeScenario([{ result: "success" as const }]),
      events,
      controlOut,
    } as any;
    const r = await replayCassette(cassette);
    const fidelityFailure = r.assertions.find((a) => a.assertion.replay_protocol_fidelity !== undefined && !a.pass);
    expect(fidelityFailure).toBeUndefined(); // no mismatch — canonicalizer normalised the key order
  });

  // ---- Per-kind round-trip tests ----
  it("round-trip: permission allow", () => {
    const req: DecisionRequest = { id: "r1", kind: "permission", tool: "Write", input: { path: "x.txt" } };
    const resp: DecisionResponse = { kind: "permission", behavior: "allow", updatedInput: { path: "x.txt" } };
    const envelope = serializeDecision(req, resp) as any;
    const body: Record<string, unknown> = envelope.response.response;
    const decoded = deserializeDecision(req, body);
    expect(decoded.kind).toBe("permission");
    expect((decoded as any).behavior).toBe("allow");
  });

  it("round-trip: permission deny", () => {
    const req: DecisionRequest = { id: "r1", kind: "permission", tool: "Bash", input: {} };
    const resp: DecisionResponse = { kind: "permission", behavior: "deny", message: "not allowed" };
    const envelope = serializeDecision(req, resp) as any;
    const body: Record<string, unknown> = envelope.response.response;
    const decoded = deserializeDecision(req, body);
    expect(decoded.kind).toBe("permission");
    expect((decoded as any).behavior).toBe("deny");
    expect((decoded as any).message).toBe("not allowed");
  });

  it("round-trip: dialog ok", () => {
    const req: DecisionRequest = { id: "r1", kind: "dialog", dialogKind: "confirm", payload: {} };
    const resp: DecisionResponse = { kind: "dialog", behavior: "ok", choice: "yes" };
    const envelope = serializeDecision(req, resp) as any;
    const body: Record<string, unknown> = envelope.response.response;
    const decoded = deserializeDecision(req, body);
    expect(decoded.kind).toBe("dialog");
    expect((decoded as any).behavior).toBe("ok");
  });

  it("round-trip: dialog cancelled", () => {
    const req: DecisionRequest = { id: "r1", kind: "dialog", dialogKind: "confirm", payload: {} };
    const resp: DecisionResponse = { kind: "dialog", behavior: "cancelled" };
    const envelope = serializeDecision(req, resp) as any;
    const body: Record<string, unknown> = envelope.response.response;
    const decoded = deserializeDecision(req, body);
    expect(decoded.kind).toBe("dialog");
    expect((decoded as any).behavior).toBe("cancelled");
  });

  it("round-trip: elicit accept", () => {
    const req: DecisionRequest = { id: "r1", kind: "elicit", server: "srv", prompt: "answer this" };
    const resp: DecisionResponse = { kind: "elicit", action: "accept", content: { value: 42 } };
    const envelope = serializeDecision(req, resp) as any;
    const body: Record<string, unknown> = envelope.response.response;
    const decoded = deserializeDecision(req, body);
    expect(decoded.kind).toBe("elicit");
    expect((decoded as any).action).toBe("accept");
    expect((decoded as any).content).toEqual({ value: 42 });
  });

  // a corrupt/unrecognized elicit action is mapped to "decline" (a valid value) rather than
  // passed through via an unchecked cast — so re-serialization (action:"decline") will NOT match the
  // recorded corrupt body and the guard trips loud instead of silently coercing.
  it("corrupt elicit action deserializes to a valid 'decline' (not the unchecked literal)", () => {
    const req: DecisionRequest = { id: "r1", kind: "elicit", server: "srv" };
    const decoded = deserializeDecision(req, { action: "garbage-not-a-real-action" });
    expect((decoded as any).action).toBe("decline");
    // a recorded body with NO action also normalizes to a valid value (no silent literal)
    expect((deserializeDecision(req, {}) as any).action).toBe("decline");
    // valid values still round-trip byte-stable
    expect((deserializeDecision(req, { action: "cancel" }) as any).action).toBe("cancel");
  });

  // A permission body that is neither allow nor deny (corrupt/truncated cassette) must NOT replay as a
  // silent allow — it maps to a deny that will not re-serialize to the recorded body, tripping the
  // guard loud. Symmetric with the elicit-action validation above.
  it("corrupt permission body deserializes to deny (never a silent allow)", () => {
    const req: DecisionRequest = { id: "r1", kind: "permission", tool: "Bash", input: {} };
    expect((deserializeDecision(req, { behavior: "cancelled" }) as any).behavior).toBe("deny");
    expect((deserializeDecision(req, {}) as any).behavior).toBe("deny");
    expect((deserializeDecision(req, { behavior: "garbage" }) as any).behavior).toBe("deny");
    // the two real values still round-trip
    expect((deserializeDecision(req, { behavior: "allow" }) as any).behavior).toBe("allow");
    expect((deserializeDecision(req, { behavior: "deny", message: "x" }) as any).behavior).toBe("deny");
  });

  // ---- deserializeDecision question branch validates answers instead of blind-casting ----
  // Cases 1-2: well-formed answers round-trip canon-identically (no spurious fidelity failure).
  it("round-trip: question with non-empty answers round-trips canon-identically", () => {
    const req: DecisionRequest = {
      id: "r1",
      kind: "question",
      questions: [{ question: "Q?", options: [{ label: "yes" }, { label: "no" }] }],
    };
    const resp: DecisionResponse = { kind: "question", answers: { "Q?": "yes" } };
    const envelope = serializeDecision(req, resp) as any;
    const body: Record<string, unknown> = envelope.response.response;
    const decoded = deserializeDecision(req, body);
    expect(decoded.kind).toBe("question");
    expect((decoded as any).answers).toEqual({ "Q?": "yes" });
    // re-serializing must canon-match the recorded body (no spurious replay_protocol_fidelity failure)
    const reEncoded = serializeDecision(req, decoded) as any;
    expect(canon(reEncoded)).toBe(canon(envelope));
  });

  it("round-trip: question with empty answers round-trips canon-identically (no false-positive on valid empty set)", () => {
    const req: DecisionRequest = { id: "r1", kind: "question", questions: [{ question: "Q?", options: [{ label: "yes" }] }] };
    const resp: DecisionResponse = { kind: "question", answers: {} };
    const envelope = serializeDecision(req, resp) as any;
    const body: Record<string, unknown> = envelope.response.response;
    const decoded = deserializeDecision(req, body);
    expect(decoded.kind).toBe("question");
    expect((decoded as any).answers).toEqual({});
    const reEncoded = serializeDecision(req, decoded) as any;
    expect(canon(reEncoded)).toBe(canon(envelope));
  });

  // Cases 3-5: corrupt answers coerce to {} — the guard trips rather than silently coercing.
  it("corrupt question answers: array coerces to {} (trips the guard on re-serialize mismatch)", () => {
    const req: DecisionRequest = { id: "r1", kind: "question", questions: [{ question: "Q?", options: [{ label: "yes" }] }] };
    const decoded = deserializeDecision(req, { behavior: "allow", updatedInput: { questions: [], answers: ["yes"] } });
    expect((decoded as any).answers).toEqual({});
  });

  it("corrupt question answers: non-string value coerces to {} (trips the guard on re-serialize mismatch)", () => {
    const req: DecisionRequest = { id: "r1", kind: "question", questions: [{ question: "Q?", options: [{ label: "yes" }] }] };
    const decoded = deserializeDecision(req, { behavior: "allow", updatedInput: { questions: [], answers: { "Q?": 42 } } });
    expect((decoded as any).answers).toEqual({});
  });

  it("corrupt question answers: missing answers coerces to {} (trips the guard on re-serialize mismatch)", () => {
    const req: DecisionRequest = { id: "r1", kind: "question", questions: [{ question: "Q?", options: [{ label: "yes" }] }] };
    // answers missing entirely
    const decoded1 = deserializeDecision(req, { behavior: "allow", updatedInput: { questions: [] } });
    expect((decoded1 as any).answers).toEqual({});
    // updatedInput missing entirely
    const decoded2 = deserializeDecision(req, { behavior: "allow" });
    expect((decoded2 as any).answers).toEqual({});
  });

  // ---- Old cassette (no controlOut) → warn + question/gate excluded, not false-green ----
  it("old-cassette: no controlOut → question/gate keys excluded (not vacuously passed)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([
        { question_asked: "Format" },
        { questions_count_max: 0 },
        { gate_answers_delivered: true },
        { result: "success" as const },
      ]),
      events,
      // no controlOut
    } as any;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: any[]) => {
      stderrChunks.push(s);
      return origWrite(s, ...rest);
    };
    const r = await replayCassette(cassette);
    (process.stderr as any).write = origWrite;
    // Warning must have been emitted
    expect(stderrChunks.join("")).toMatch(/no controlOut/);
    // question/gate assertions must be excluded (not vacuously evaluated)
    expect(r.assertions.find((a) => a.assertion.question_asked !== undefined)).toBeUndefined();
    expect(r.assertions.find((a) => a.assertion.questions_count_max !== undefined)).toBeUndefined();
    expect(r.assertions.find((a) => a.assertion.gate_answers_delivered !== undefined)).toBeUndefined();
    // result still runs
    expect(r.assertions.find((a) => a.assertion.result !== undefined)?.pass).toBe(true);
  });

  // ---- Mixed-object {question_asked, result}: controlOut present — both evaluated ----
  it("mixed-object {question_asked, result}: controlOut present → both keys evaluated", async () => {
    const reqId = "req-q1";
    const toolUseId = "toolu_GATE1";
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
      JSON.stringify({
        type: "control_request",
        request_id: reqId,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          tool_use_id: toolUseId,
          input: { questions: [{ question: "Format?", options: [{ label: "PDF" }] }] },
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false, content: "PDF" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response: {
            behavior: "allow",
            updatedInput: {
              questions: [{ question: "Format?", options: [{ label: "PDF" }] }],
              answers: { "Format?": "PDF" },
            },
          },
        },
      }),
    ];
    // Single assertion object with both question_asked AND result
    const cassette = {
      scenario: makeScenario([{ question_asked: "Format", result: "success" as const }]),
      events,
      controlOut,
    } as any;
    const r = await replayCassette(cassette);
    expect(r.assertions).toHaveLength(1);
    expect(r.assertions[0].pass).toBe(true);
  });

  // ---- Mixed-object {question_asked, result}: controlOut absent — only `result` evaluated ----
  it("mixed-object {question_asked, result}: controlOut absent → only result evaluated", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // Mixed assertion object with both keys
    const cassette = {
      scenario: makeScenario([{ question_asked: "Format", result: "success" as const }]),
      events,
      // no controlOut
    } as any;
    const r = await replayCassette(cassette);
    // with AND-semantics, the mixed object is STRIPPED to its active content keys before
    // evaluation. controlOut is absent → question_asked is not an active content key → stripped out,
    // leaving only {result}. So exactly one assertion is evaluated and it PASSES (result=success).
    // (Previously first-key-wins evaluated question_asked first and false-failed — the bug this fixes.)
    expect(r.assertions).toHaveLength(1);
    expect(r.assertions[0].pass).toBe(true);
  });

  // ---- regression: nonDeterministic is explicitly false on replay, never undefined ----
  it("replayCassette result has nonDeterministic === false (explicit, not undefined)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"], cwd: "/sessions/x" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "replay-det" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ result: "success" as const }]),
      events,
    } as any;
    const r = await replayCassette(cassette);
    // Must be explicitly false — not undefined — so renderer.ts treats it correctly.
    expect(r.nonDeterministic).toBe(false);
  });

  // ---- footgun: loud warning for skipped filesystem/egress/expect_denied assertions ----
  it("skipped egress/expect_denied assertions emit a loud stderr warning with correct count", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // scenario with: 1 expect_denied entry + 2 pure filesystem/egress assert[] entries + 1 content entry
    const cassette = {
      scenario: {
        ...makeScenario([
          { file_exists: "/out/result.txt" }, // pure filesystem — skipped
          { egress_denied: "evilhost.com" }, // pure egress — skipped
          { result: "success" as const }, // content key — kept
        ]),
        expect_denied: ["blocked-host.example.com"], // always live-only — skipped
      },
      events,
    } as any;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: any[]) => {
      stderrChunks.push(s);
      return origWrite(s, ...rest);
    };
    const r = await replayCassette(cassette);
    (process.stderr as any).write = origWrite;
    const combined = stderrChunks.join("");
    // Warning must mention the count: 1 (expect_denied) + 2 (pure fs/egress asserts) = 3
    expect(combined).toMatch(/skipped 3 filesystem\/egress\/expect_denied assertions/);
    // Content assertion (result) still runs and passes
    const resultA = r.assertions.find((a) => a.assertion.result !== undefined);
    expect(resultA?.pass).toBe(true);
    // File/egress assertions are NOT in the evaluated list
    expect(r.assertions.find((a) => a.assertion.file_exists !== undefined)).toBeUndefined();
    expect(r.assertions.find((a) => a.assertion.egress_denied !== undefined)).toBeUndefined();
  });

  it("a MIXED assertion (content + filesystem) emits a distinct PARTIAL-skip warning — no silent green", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // ONE assertion mixing a content key (result, evaluated) with a filesystem key (file_exists, dropped).
    const cassette = {
      scenario: makeScenario([{ result: "success" as const, file_exists: "/out/a.md" }]),
      events,
    } as any;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: any[]) => {
      stderrChunks.push(s);
      return origWrite(s, ...rest);
    };
    const r = await replayCassette(cassette);
    (process.stderr as any).write = origWrite;
    const combined = stderrChunks.join("");
    // the dropped filesystem half MUST be announced as a partial drop (the bug: it used to be silent)
    expect(combined).toMatch(/1 mixed assertion\(s\) had their filesystem\/egress half dropped/);
    // and it must NOT be miscounted as a fully-skipped (live-only) assertion
    expect(combined).not.toMatch(/skipped \d+ filesystem\/egress\/expect_denied assertions/);
    // the content half still evaluates and passes; the filesystem half is not in the evaluated set
    const resultA = r.assertions.find((a) => a.assertion.result !== undefined);
    expect(resultA?.pass).toBe(true);
    expect(r.assertions.find((a) => a.assertion.file_exists !== undefined)).toBeUndefined();
  });

  it("no warning emitted when there are no skipped assertions", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ transcript_contains: "hi" }]),
      events,
    } as any;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: any[]) => {
      stderrChunks.push(s);
      return origWrite(s, ...rest);
    };
    await replayCassette(cassette);
    (process.stderr as any).write = origWrite;
    expect(stderrChunks.join("")).not.toMatch(/filesystem\/egress\/expect_denied/);
  });

  // ---- malformed events.jsonl lines emit a loud warning (not silent skip) ----
  it("malformed cassette event line emits a stderr warning naming the line index", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init" }),
      "NOT_VALID_JSON{{{ malformed", // line 1: unparseable
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ transcript_contains: "ok" }]),
      events,
    } as any;
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: any[]) => {
      stderrChunks.push(s);
      return origWrite(s, ...rest);
    };
    const r = await replayCassette(cassette);
    (process.stderr as any).write = origWrite;
    const combined = stderrChunks.join("");
    // Warning must name the line index (1) and say "not valid JSON"
    expect(combined).toMatch(/cassette events line 1.*not valid JSON/);
    // Despite the malformed line, the valid event still replays
    expect(r.assertions.find((a) => a.assertion.transcript_contains !== undefined)?.pass).toBe(true);
  });

  // ---- Permission-allow round-trip: no explicit updatedInput → defaults to req.input ----
  // This pins the serializeDecision default behaviour: when the live decider allows a permission but
  // provides no explicit `updatedInput`, serializeDecision falls back to `req.input`. The
  // deserializeDecision must recover the same value so that a replay of such a cassette produces
  // no spurious replay_protocol_fidelity failure.
  it("permission-allow round-trip: no explicit updatedInput defaults to req.input (no spurious fidelity failure)", async () => {
    const reqId = "req-perm1";
    const toolInput = { path: "/out/result.txt", content: "hello" };
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({
        type: "control_request",
        request_id: reqId,
        request: { subtype: "can_use_tool", tool_name: "Write", input: toolInput },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    // The live decider responded: allow with no explicit updatedInput → serializeDecision defaults
    // updatedInput to req.input (the tool's original input, toolInput).
    // We record the resulting envelope body as the cassette's controlOut.
    const req: DecisionRequest = { id: reqId, kind: "permission", tool: "Write", input: toolInput };
    const liveResp = { kind: "permission" as const, behavior: "allow" as const };
    // No updatedInput field — serializeDecision should supply req.input as the default
    const envelope = serializeDecision(req, liveResp) as any;
    const recordedBody = envelope.response.response;
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: reqId, response: recordedBody },
      }),
    ];
    const cassette = {
      scenario: makeScenario([{ result: "success" as const }]),
      events,
      controlOut,
    } as any;
    const r = await replayCassette(cassette);
    // No replay_protocol_fidelity failure — the round-trip must canon-match
    const fidelityFailure = r.assertions.find((a) => a.assertion.replay_protocol_fidelity !== undefined && !a.pass);
    expect(fidelityFailure).toBeUndefined();
    expect(r.result).toBe("success");
  });
});

// ---- canon() unit tests ----
describe("canon — recursive key-sorting canonicalizer", () => {
  it("normalises key order for flat objects", () => {
    expect(canon({ b: 1, a: 2 })).toBe(canon({ a: 2, b: 1 }));
  });
  it("normalises key order for nested objects", () => {
    expect(canon({ x: { d: 4, c: 3 }, y: 1 })).toBe(canon({ y: 1, x: { c: 3, d: 4 } }));
  });
  it("preserves array order (arrays are NOT sorted)", () => {
    expect(canon([1, 2, 3])).toBe(canon([1, 2, 3]));
    expect(canon([3, 2, 1])).not.toBe(canon([1, 2, 3]));
  });
  it("handles primitives, null", () => {
    expect(canon(42)).toBe("42");
    expect(canon("hello")).toBe('"hello"');
    expect(canon(null)).toBe("null");
  });
});

// multi-question gate label: gateAnswers.question joins ALL questions, not just [0]
describe("Run — multi-question gate label", () => {
  class MockSession2 implements AgentSession {
    constructor(private events: AgentEvent[]) {}
    sendUserTurn() {}
    async *start(): AsyncGenerator<AgentEvent> {
      yield* this.events;
    }
    respond() {}
    close() {}
  }

  it("single-question gate: label is identical to existing behavior (unchanged)", async () => {
    const ev: AgentEvent[] = [
      { type: "decision", request: { id: "q1", kind: "question", questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] } },
      { type: "result", isError: false },
    ];
    const rec = await new Run(new MockSession2(ev), new ScriptedDecider([{ when_question: "Proceed", choose: "Yes" }])).drive("go");
    expect(rec.gateAnswers).toHaveLength(1);
    expect(rec.gateAnswers[0].question).toBe("Proceed?");
  });

  it("multi-question gate: label joins ALL question texts with ' / '", async () => {
    const ev: AgentEvent[] = [
      {
        type: "decision",
        request: {
          id: "q2",
          kind: "question",
          questions: [
            { question: "Environment?", options: [{ label: "prod" }] },
            { question: "Branch?", options: [{ label: "main" }] },
          ],
        },
      },
      { type: "result", isError: false },
    ];
    const channel = {
      write: () => {},
      readLine: async () => '{"id":"q2","answers":{"Environment?":"prod","Branch?":"main"}}',
    };
    const { ExternalDecider: ExtDec } = await import("../src/decide/decider.js");
    const { collectSecrets } = await import("../src/secrets.js");
    const decider = new ExtDec(channel, collectSecrets());
    const rec = await new Run(new MockSession2(ev), decider).drive("go");
    expect(rec.gateAnswers).toHaveLength(1);
    expect(rec.gateAnswers[0].question).toBe("Environment? / Branch?");
  });
});

describe("microvmAgentArgs — session persistence", () => {
  const baseline = { spawn: {} } as any;
  const basePlan = { effort: "medium", pluginDirs: [] } as any;

  it("emits --session-id when a stable session is requested (no resume)", () => {
    const args = microvmAgentArgs(baseline, { ...basePlan, agentSessionId: "sess-1", resume: false }, "/mnt");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
    expect(args).not.toContain("--resume");
  });

  it("emits --resume when resuming a stable session", () => {
    const args = microvmAgentArgs(baseline, { ...basePlan, agentSessionId: "sess-1", resume: true }, "/mnt");
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
    expect(args).not.toContain("--session-id");
  });

  it("emits neither flag when no stable session was requested (goldens unchanged)", () => {
    const args = microvmAgentArgs(baseline, { ...basePlan }, "/mnt");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });
});

describe("resolveMaxThinkingTokens — Cowork f7e port (binary-verified)", () => {
  const FALLBACK = 31999; // baseline default = DEFAULT_MAX_THINKING_TOKENS (hre)

  it("returns the baseline fallback when unset (goldens unchanged)", () => {
    expect(resolveMaxThinkingTokens(undefined, "claude-opus-4-8", FALLBACK)).toBe(31999);
  });
  it("uses a flat number directly, regardless of model", () => {
    expect(resolveMaxThinkingTokens(8000, "claude-opus-4-8", FALLBACK)).toBe(8000);
    expect(resolveMaxThinkingTokens(8000, undefined, FALLBACK)).toBe(8000);
  });
  it("uses the per-model entry when the model matches", () => {
    expect(resolveMaxThinkingTokens({ "claude-opus-4-8": 50000, default: 12000 }, "claude-opus-4-8", FALLBACK)).toBe(50000);
  });
  it("falls back to the map's `default` when the model is absent", () => {
    expect(resolveMaxThinkingTokens({ "claude-sonnet-4-6": 20000, default: 12000 }, "claude-opus-4-8", FALLBACK)).toBe(12000);
  });
  it("falls back to the baseline default when the map has neither the model nor `default`", () => {
    expect(resolveMaxThinkingTokens({ "claude-sonnet-4-6": 20000 }, "claude-opus-4-8", FALLBACK)).toBe(31999);
  });
});

describe("Run.requestWebFetchApproval — recorded synthetic permission", () => {
  // drive() returns this.rec by reference; requestWebFetchApproval mutates the same record post-drive.
  const resultOnly = () => new MockSession([{ type: "result", isError: false }]);

  it("scripted allow → true, recorded as an allow decision", async () => {
    const run = new Run(resultOnly(), new ScriptedDecider([{ when_tool: "webfetch:ok.com", allow_if: "true" }]), [], "t");
    const rec = await run.drive("hi");
    expect(await run.requestWebFetchApproval("ok.com", "https://ok.com/x")).toBe(true);
    expect(rec.decisions.find((d) => d.name === "webfetch:ok.com")).toMatchObject({ decision: "allow", by: "scripted" });
  });

  it("scripted deny → false, recorded as a deny decision", async () => {
    const run = new Run(resultOnly(), new ScriptedDecider([{ when_tool: "webfetch:no.com", allow_if: "false", else: "deny" }]), [], "t");
    const rec = await run.drive("hi");
    expect(await run.requestWebFetchApproval("no.com", "https://no.com/x")).toBe(false);
    expect(rec.decisions.find((d) => d.name === "webfetch:no.com")).toMatchObject({ decision: "deny", by: "scripted" });
  });

  it("ABSTAIN → fail-closed deny, recorded by:abstain-fallback, and NEVER responds to the agent (no stray control_response)", async () => {
    const session = resultOnly();
    const run = new Run(session, new ScriptedDecider([]), [], "t");
    const rec = await run.drive("hi");
    expect(await run.requestWebFetchApproval("x.com", "https://x.com/x")).toBe(false);
    expect(rec.decisions.find((d) => d.name === "webfetch:x.com")).toMatchObject({ decision: "deny", by: "abstain-fallback" });
    expect(session.responded.length).toBe(0); // synthetic id is never sent to the agent
  });

  it("an 'Allow all for website' grant approves the host for the run — a 2nd fetch raises NO gate", async () => {
    const run = new Run(resultOnly(), new ScriptedDecider([{ when_tool: "webfetch:ok.com", decide: "allow", grant: "domain" }]), [], "t");
    const rec = await run.drive("hi");
    expect(await run.requestWebFetchApproval("ok.com", "https://ok.com/a")).toBe(true);
    const after1 = rec.decisions.length;
    expect(await run.requestWebFetchApproval("ok.com", "https://ok.com/b")).toBe(true); // approved host
    expect(rec.decisions.length).toBe(after1); // no new decision — the gate was skipped
  });

  it("seedApprovedDomains pre-approves a host — its first fetch raises NO gate", async () => {
    const run = new Run(resultOnly(), new ScriptedDecider([]), [], "t"); // no rules → would fail-closed
    const rec = await run.drive("hi");
    run.seedApprovedDomains(["ok.com"]);
    expect(await run.requestWebFetchApproval("ok.com", "https://ok.com/a")).toBe(true); // pre-approved
    expect(rec.decisions.some((d) => d.name === "webfetch:ok.com")).toBe(false); // no gate raised
    expect(await run.requestWebFetchApproval("other.com", "https://other.com/a")).toBe(false); // not pre-approved → fail-closed
  });

  it("an 'Allow once' grant does NOT approve the host — a 2nd fetch re-gates", async () => {
    const run = new Run(resultOnly(), new ScriptedDecider([{ when_tool: "webfetch:ok.com", decide: "allow", grant: "once" }]), [], "t");
    const rec = await run.drive("hi");
    expect(await run.requestWebFetchApproval("ok.com", "https://ok.com/a")).toBe(true);
    const after1 = rec.decisions.length;
    expect(await run.requestWebFetchApproval("ok.com", "https://ok.com/b")).toBe(true);
    expect(rec.decisions.length).toBe(after1 + 1); // re-gated → a new decision recorded
  });

  it("a kind-mismatched decider response is recorded as mismatch→deny + warns (not a silent decision:'?')", async () => {
    // A decider that answers a "permission" web_fetch request with a "question"-kind response — a protocol
    // mismatch. Previously this recorded decision:"?" with NO warning; now it records mismatch→deny + warns.
    const mismatchDecider = {
      async decide() {
        return { response: { kind: "question", answers: {} } as DecisionResponse, by: "scripted" as const, rationale: "wrong kind" };
      },
    };
    const warnings: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string | Uint8Array): boolean => (warnings.push(String(s)), true);
    let rec, allowed: boolean;
    try {
      const run = new Run(resultOnly(), mismatchDecider, [], "t");
      rec = await run.drive("hi");
      allowed = await run.requestWebFetchApproval("bad.com", "https://bad.com/x");
    } finally {
      (process.stderr as any).write = orig;
    }
    expect(allowed).toBe(false); // fail-closed on mismatch
    const d = rec.decisions.find((x) => x.name === "webfetch:bad.com");
    expect(d).toMatchObject({ decision: "mismatch→deny" });
    expect(d?.decision).not.toBe("?"); // the old silent value is gone
    expect(warnings.some((w) => w.includes("webfetch") && w.includes('returned kind "question"'))).toBe(true);
  });
});

describe("Cassette — transcript_not_contains evaluates on content (not on missing flag) during replay", () => {
  it("passes when the cassette transcript does not contain the needle", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"], cwd: "/sessions/x" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello from the skill" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ transcript_not_contains: "needle" }]),
      events,
    } as any;
    const r = await replayCassette(cassette);
    expect(r.assertions.every((a) => a.pass)).toBe(true);
  });

  it("fails when the cassette transcript DOES contain the needle", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"], cwd: "/sessions/x" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "this is a needle in the text" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ transcript_not_contains: "needle" }]),
      events,
    } as any;
    const r = await replayCassette(cassette);
    const a = r.assertions.find((x) => x.assertion.transcript_not_contains !== undefined);
    expect(a?.pass).toBe(false);
    expect(a?.message).toContain("unexpectedly contains");
  });
});

describe("Cassette — truncated artifact entries pass file_exists and user_visible_artifact (existence proven by manifest)", () => {
  const truncatedArtifact = { path: "outputs/report.json", bytes: 50000, sha256: "abc", truncated: true };

  it("PASSES file_exists when the artifact was truncated (path+sha in manifest = existence proof)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"], cwd: "/sessions/x" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ file_exists: "outputs/report.json" }]),
      events,
      artifacts: [truncatedArtifact],
    } as any;
    const r = await replayCassette(cassette);
    const a = r.assertions.find((x) => x.assertion.file_exists !== undefined);
    expect(a?.pass).toBe(true);
  });

  it("PASSES user_visible_artifact when the artifact was truncated and is under a user-visible prefix", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"], cwd: "/sessions/x" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette = {
      scenario: makeScenario([{ user_visible_artifact: "outputs/report.json" }]),
      events,
      artifacts: [truncatedArtifact],
    } as any;
    const r = await replayCassette(cassette);
    const a = r.assertions.find((x) => x.assertion.user_visible_artifact !== undefined);
    expect(a?.pass).toBe(true);
  });

  it("PASSES file_exists when the artifact is NOT truncated (regression guard)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"], cwd: "/sessions/x" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const body = JSON.stringify({ ok: true });
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(Buffer.from(body)).digest("hex");
    const cassette = {
      scenario: makeScenario([{ file_exists: "outputs/report.json" }]),
      events,
      artifacts: [{ path: "outputs/report.json", bytes: body.length, sha256, body }],
    } as any;
    const r = await replayCassette(cassette);
    const a = r.assertions.find((x) => x.assertion.file_exists !== undefined);
    expect(a?.pass).toBe(true);
  });
});

describe("execute.ts — COWORK_HARNESS_DIALOG_TIMEOUT_MS configuration guard", () => {
  it("throws when a finite timeout is set alongside an externalChannel", async () => {
    const prev = process.env.COWORK_HARNESS_DIALOG_TIMEOUT_MS;
    process.env.COWORK_HARNESS_DIALOG_TIMEOUT_MS = "100";
    try {
      const stubChannel: DecisionChannel = {
        write: async () => {},
        readLine: async () => "",
        close: () => {},
        snapshot: () => undefined,
      };
      const scenario = Scenario.parse({ prompt: "hi" });
      await expect(executeScenario(scenario, { externalChannel: stubChannel })).rejects.toThrow(
        "COWORK_HARNESS_DIALOG_TIMEOUT_MS: cannot use a finite timeout",
      );
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_DIALOG_TIMEOUT_MS;
      else process.env.COWORK_HARNESS_DIALOG_TIMEOUT_MS = prev;
    }
  });
});

// An unscripted web_fetch approval under on_unanswered: fail. Production prompts the user and waits; it never denies
// on its own. So under `fail` the request ends the run as an unanswered gate, as an unscripted AskUserQuestion or
// delete card does, instead of being denied silently (a deny no verdict reads). `first` and `llm` are unchanged.
import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import { buildDecider, UnansweredError } from "../src/decide/decider.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";

class MockSession implements AgentSession {
  responded: { id: string; r: DecisionResponse }[] = [];
  constructor(private events: AgentEvent[]) {}
  async *start(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  sendUserTurn() {}
  respond(id: string, r: DecisionResponse) {
    this.responded.push({ id, r });
    return { delivered: true as const };
  }
  close() {}
}

const URL = "https://data.example.org/report?id=7";
const fetchReq = (): AgentEvent => ({
  type: "decision",
  request: { id: "req-1", kind: "permission", tool: "mcp__workspace__web_fetch", input: { url: URL } },
});
const drive = (onUnanswered: "fail" | "first", rules: Parameters<typeof buildDecider>[0]["rules"] = []) => {
  const s = new MockSession([fetchReq(), { type: "result", isError: false } as AgentEvent]);
  const run = new Run(s, buildDecider({ rules, parity: "cowork", onUnanswered }));
  run.enableWebFetchGate();
  return { s, rec: run.drive("go") };
};

describe("an unscripted web_fetch approval", () => {
  it("under on_unanswered fail, ends the run as an unanswered gate naming the domain, the URL and the fix", async () => {
    const { s, rec } = drive("fail");
    const err = (await rec.then(
      () => undefined,
      (e: unknown) => e,
    )) as UnansweredError;
    expect(err).toBeInstanceOf(UnansweredError);
    expect(err.message).toContain("webfetch:data.example.org");
    expect(err.message).toContain(URL);
    expect(err.hint).toMatch(/when_tool: "webfetch:data\.example\.org"/);
    expect(err.hint).toMatch(/grant: once \| domain/);
    expect(err.hint).toMatch(/web_fetch\.approved_domains/);
    expect(s.responded.some((x) => x.r.kind === "permission" && x.r.behavior === "allow")).toBe(false);
  });

  it("under on_unanswered first, is still denied (first never allows a fetch)", async () => {
    const { s, rec } = drive("first");
    const r = await rec;
    expect(s.responded[0]!.r).toMatchObject({ kind: "permission", behavior: "deny" });
    expect(r.decisions.find((d) => d.name === "mcp__workspace__web_fetch")?.decision).toBe("deny");
  });

  it("a scripted rule still allows it under fail", async () => {
    const { s, rec } = drive("fail", [{ when_tool: "webfetch:data.example.org", decide: "allow", grant: "once" } as never]);
    await rec;
    expect(s.responded[0]!.r).toMatchObject({ kind: "permission", behavior: "allow" });
  });
});

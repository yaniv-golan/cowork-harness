import { describe, it, expect } from "vitest";
import { Run } from "../src/run/run.js";
import type { AgentEvent, AgentSession, DecisionRequest, DecisionResponse } from "../src/agent/session.js";
import { ABSTAIN, type Decider, type Decision } from "../src/decide/decider.js";

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

// approves any webfetch:<domain> with an "Allow all for website" (domain) grant
const domainApprover: Decider = {
  async decide(req: DecisionRequest): Promise<Decision | typeof ABSTAIN> {
    return req.kind === "permission" && req.tool.startsWith("webfetch:")
      ? { response: { kind: "permission", behavior: "allow", grant: "domain" }, by: "scripted" }
      : ABSTAIN;
  },
};

const canUseWebFetch = (url: string): AgentEvent => ({
  type: "decision",
  request: { id: `req-${url}`, kind: "permission", tool: "mcp__workspace__web_fetch", input: { url } },
});

describe("web_fetch through can_use_tool — exactly one decision, no synthetic handler approval", () => {
  it("first fetch to an un-approved domain records ONE decision (the can_use_tool), zero webfetch: synthetics", async () => {
    const s = new MockSession([canUseWebFetch("https://a.com/x")]);
    const run = new Run(s, domainApprover as never);
    run.enableWebFetchGate();
    const rec = await run.drive("go");
    const webfetchDecisions = rec.decisions.filter((d) => d.name === "mcp__workspace__web_fetch");
    const synthetic = rec.decisions.filter((d) => d.name.startsWith("webfetch:"));
    expect(webfetchDecisions).toHaveLength(1);
    expect(webfetchDecisions[0].decision).toBe("allow");
    expect(synthetic).toHaveLength(0); // the shared decision was recorded as the can_use_tool, not twice
    expect(run.provenanceHas("https://a.com/x")).toBe(true); // allow marked provenance
    // the response the agent received is a plain allow (no off-wire grant leaked onto the wire)
    expect(s.responded[0].r).toMatchObject({ kind: "permission", behavior: "allow" });
  });

  it("a second fetch to the now-approved domain auto-allows and records NOTHING new (no re-prompt, no synthetic)", async () => {
    const s = new MockSession([canUseWebFetch("https://a.com/1"), canUseWebFetch("https://a.com/2")]);
    const run = new Run(s, domainApprover as never);
    run.enableWebFetchGate();
    const rec = await run.drive("go");
    // first miss records one; second is an approved-domain auto-allow → responded allow, NOT recorded
    expect(rec.decisions.filter((d) => d.name === "mcp__workspace__web_fetch")).toHaveLength(1);
    expect(s.responded.map((x) => x.r).every((r) => r.kind === "permission" && r.behavior === "allow")).toBe(true);
    expect(s.responded).toHaveLength(2); // both fetches were answered allow; only the first was a recorded decision
  });

  it("a provenance-hit URL auto-allows with no recorded decision (deterministic, no prompt)", async () => {
    const s = new MockSession([canUseWebFetch("https://seed.com/x")]);
    const run = new Run(s, domainApprover as never);
    run.enableWebFetchGate();
    run.provenanceAdd("https://seed.com/x"); // the URL already appeared in a user turn / prior fetch
    const rec = await run.drive("go");
    expect(rec.decisions.filter((d) => d.name === "mcp__workspace__web_fetch")).toHaveLength(0);
    expect(s.responded[0].r).toMatchObject({ kind: "permission", behavior: "allow" });
  });
});

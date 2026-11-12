import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Run } from "../src/run/run.js";
import { webFetchGateEnabled } from "../src/run/execute.js";
import type { AgentEvent, AgentSession, DecisionRequest, DecisionResponse } from "../src/agent/session.js";
import { ABSTAIN, type Decider, type Decision } from "../src/decide/decider.js";

// `web_fetch.approved_domains` is consumed only by the web_fetch approval gate, so where it applies is exactly where
// that gate is enabled. That is `container` and `hostloop` with the baseline's web_fetch-via-API gate on — and never
// `microvm` or `protocol`. There is no spawn-free seam for executeScenario at container, so this pins the three parts
// separately: the tier predicate, the Run-level behaviour (seeded host: no gate; unseeded host: a gate — the positive
// control, without which the seeded arm passes vacuously), and that execute.ts still wires both.

describe("webFetchGateEnabled — which tiers raise the web_fetch approval gate", () => {
  const cases: [string, boolean, boolean][] = [
    ["container", true, true],
    ["hostloop", true, true],
    ["microvm", true, false],
    ["protocol", true, false],
    ["container", false, false],
    ["hostloop", false, false],
    ["microvm", false, false],
    ["protocol", false, false],
  ];
  it.each(cases)("%s with the via-API gate %s ⇒ %s", (tier, viaApiOn, expected) => {
    expect(webFetchGateEnabled(tier, viaApiOn)).toBe(expected);
  });
});

class OneFetchSession implements AgentSession {
  responded: { id: string; r: DecisionResponse }[] = [];
  constructor(private url: string) {}
  async *start(): AsyncIterable<AgentEvent> {
    yield { type: "decision", request: { id: "req-1", kind: "permission", tool: "mcp__workspace__web_fetch", input: { url: this.url } } };
  }
  sendUserTurn() {}
  respond(id: string, r: DecisionResponse) {
    this.responded.push({ id, r });
    return { delivered: true as const };
  }
  close() {}
}

/** Records every request it is asked about, and denies web_fetch domain requests (so a consult is visible). */
function recordingDecider(): Decider & { asked: DecisionRequest[] } {
  const asked: DecisionRequest[] = [];
  return {
    asked,
    async decide(req: DecisionRequest): Promise<Decision | typeof ABSTAIN> {
      asked.push(req);
      return req.kind === "permission" ? { response: { kind: "permission", behavior: "deny", message: "no" }, by: "scripted" } : ABSTAIN;
    },
  };
}

describe("approved_domains at the Run: a seeded host raises no gate, an unseeded one does", () => {
  // The URL is NOT in the prompt or any tool result, so it is absent from provenance: the gate is the only thing
  // that can decide it. Without that, both arms would auto-allow on a provenance hit for the wrong reason.
  const URL_ = "https://docs.example.org/page";
  const PROMPT = "fetch the page"; // no URL in it

  it("seeded: no decider consult, no recorded decision, the fetch is allowed", async () => {
    const s = new OneFetchSession(URL_);
    const d = recordingDecider();
    const run = new Run(s, d);
    run.enableWebFetchGate();
    run.seedApprovedDomains(["docs.example.org"]);
    const rec = await run.drive(PROMPT);
    expect(run.provenanceHas(URL_)).toBe(true);
    expect(d.asked).toEqual([]);
    expect(rec.decisions.filter((x) => x.name === "mcp__workspace__web_fetch")).toHaveLength(0);
    expect(s.responded[0]?.r).toMatchObject({ kind: "permission", behavior: "allow" });
  });

  it("unseeded (positive control): the gate raises a webfetch:<host> request to the decider", async () => {
    const s = new OneFetchSession(URL_);
    const d = recordingDecider();
    const run = new Run(s, d);
    run.enableWebFetchGate();
    const rec = await run.drive(PROMPT);
    expect(d.asked.map((r) => (r.kind === "permission" ? r.tool : r.kind))).toEqual(["webfetch:docs.example.org"]);
    expect(rec.decisions.filter((x) => x.name === "mcp__workspace__web_fetch")).toHaveLength(1);
    expect(s.responded[0]?.r).toMatchObject({ kind: "permission", behavior: "deny" });
  });
});

describe("execute.ts wiring: the seed and the extracted predicate are both still called", () => {
  const SRC = readFileSync(join(import.meta.dirname, "..", "src", "run", "execute.ts"), "utf8");

  it("seeds approved_domains on every tier (the gate decides whether anything reads it)", () => {
    expect(SRC).toContain("run.seedApprovedDomains(session.web_fetch.approved_domains);");
  });

  it("enables the gate through webFetchGateEnabled, and nowhere else", () => {
    expect(SRC).toContain("if (webFetchGateEnabled(effectiveFidelity, viaApiOn)) {");
    expect(SRC.match(/run\.enableWebFetchGate\(\)/g)).toHaveLength(1);
  });
});

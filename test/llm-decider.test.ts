import { describe, it, expect } from "vitest";
import { LlmDecider, ABSTAIN, UnansweredError, type RunContext, type Complete } from "../src/decide/decider.js";
import type { DecisionRequest } from "../src/agent/session.js";

const ctx = (t = ""): RunContext => ({ task: "", transcript: () => t, toolLog: () => [], runId: "x" });
const ask = (q: string, opts: string[]): DecisionRequest => ({
  id: "r",
  kind: "question",
  questions: [{ question: q, options: opts.map((label) => ({ label })) }],
});

describe("LlmDecider", () => {
  it("picks the option the model returns; by:'llm' + model recorded", async () => {
    const complete: Complete = async () => "PDF";
    const d = await new LlmDecider(complete, undefined, "haiku-test").decide(ask("Format?", ["Markdown", "PDF"]), ctx());
    expect(d).not.toBe(ABSTAIN);
    expect((d as any).response).toEqual({ kind: "question", answers: { "Format?": "PDF" } });
    expect((d as any).by).toBe("llm");
    expect((d as any).model).toBe("haiku-test");
  });

  it("puts the --intent into the model prompt and matches a label inside a prose answer", async () => {
    let seenPrompt = "";
    const complete: Complete = async (p) => ((seenPrompt = p), "I would choose Series A here.");
    const d = await new LlmDecider(complete, "test the not_ai branch").decide(ask("Confirm the stage?", ["Seed", "Series A"]), ctx());
    expect(seenPrompt).toContain("test the not_ai branch");
    expect((d as any).response.answers).toEqual({ "Confirm the stage?": "Series A" }); // matched inside prose
  });

  it("FAILS LOUD on an out-of-set answer — never a silent default to option 1", async () => {
    const complete: Complete = async () => "Banana";
    await expect(new LlmDecider(complete).decide(ask("Format?", ["Markdown", "PDF"]), ctx())).rejects.toThrow(UnansweredError);
  });

  it("abstains on an ORDINARY (optionless) permission request (parity default handles it)", async () => {
    const complete: Complete = async () => "x";
    const r = await new LlmDecider(complete).decide({ id: "p", kind: "permission", tool: "Bash", input: {} }, ctx());
    expect(r).toBe(ABSTAIN);
  });

  it("answers a web_fetch approval (options) with the chosen grant scope", async () => {
    let seenPrompt = "";
    const complete: Complete = async (p) => ((seenPrompt = p), "Allow all for website");
    const req: DecisionRequest = {
      id: "p",
      kind: "permission",
      tool: "webfetch:x.com",
      input: { domain: "x.com", url: "https://x.com/a" },
      options: [{ label: "Allow once" }, { label: "Allow all for website" }, { label: "Deny" }],
    };
    const d = await new LlmDecider(complete).decide(req, ctx());
    expect(seenPrompt).toContain("https://x.com/a"); // the judge saw the URL
    expect((d as any).response).toMatchObject({ kind: "permission", behavior: "allow", grant: "domain" });
    expect((d as any).by).toBe("llm");
  });

  it("FAILS LOUD on an out-of-set web_fetch answer", async () => {
    const req: DecisionRequest = {
      id: "p",
      kind: "permission",
      tool: "webfetch:x.com",
      input: { domain: "x.com", url: "https://x.com/a" },
      options: [{ label: "Allow once" }, { label: "Allow all for website" }, { label: "Deny" }],
    };
    await expect(new LlmDecider(async () => "Maybe later").decide(req, ctx())).rejects.toThrow(UnansweredError);
  });

  it("answers each question of a multi-question request independently (one call per question)", async () => {
    let calls = 0;
    const complete: Complete = async () => (calls++, calls === 1 ? "Markdown" : "Deep");
    const req: DecisionRequest = {
      id: "r",
      kind: "question",
      questions: [
        { question: "Format?", options: [{ label: "Markdown" }, { label: "PDF" }] },
        { question: "Depth?", options: [{ label: "Shallow" }, { label: "Deep" }] },
      ],
    };
    const d = await new LlmDecider(complete).decide(req, ctx());
    expect(calls).toBe(2);
    expect((d as any).response.answers).toEqual({ "Format?": "Markdown", "Depth?": "Deep" });
  });
});

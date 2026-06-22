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

  it("puts the --intent into the model prompt; requires an exact label (not a prose answer) — ", async () => {
    let seenPrompt = "";
    // fix: matchLabel defaults to fuzzy=false, so a prose answer is no longer accepted.
    // The LLM prompt says "Reply with ONLY the exact label" — a well-behaved model should return the
    // exact label, not a prose sentence. A prose answer must now fail loud (not silently accept it).
    const completeProse: Complete = async (p) => ((seenPrompt = p), "I would choose Series A here.");
    await expect(
      new LlmDecider(completeProse, "test the not_ai branch").decide(ask("Confirm the stage?", ["Seed", "Series A"]), ctx()),
    ).rejects.toThrow(UnansweredError);
    expect(seenPrompt).toContain("test the not_ai branch");

    // A well-behaved LLM returning the exact label still works.
    const completeExact: Complete = async () => "Series A";
    const d = await new LlmDecider(completeExact, "test the not_ai branch").decide(ask("Confirm the stage?", ["Seed", "Series A"]), ctx());
    expect((d as any).response.answers).toEqual({ "Confirm the stage?": "Series A" });
  });

  it("FAILS LOUD on an out-of-set answer — never a silent default to option 1", async () => {
    const complete: Complete = async () => "Banana";
    await expect(new LlmDecider(complete).decide(ask("Format?", ["Markdown", "PDF"]), ctx())).rejects.toThrow(UnansweredError);
  });

  it("Fix 1 — supplies free text for an options-bearing gate via the OTHER: directive (Cowork's 'Other' path)", async () => {
    let seenPrompt = "";
    const complete: Complete = async (p) => ((seenPrompt = p), "OTHER: Acme Robotics");
    const d = await new LlmDecider(complete, "name it after the customer").decide(
      ask("What should I name it?", ["Project Alpha", "Project Beta"]),
      ctx(),
    );
    expect((d as any).response).toEqual({ kind: "question", answers: { "What should I name it?": "Acme Robotics" } });
    expect((d as any).by).toBe("llm");
    // the prompt advertises the OTHER affordance
    expect(seenPrompt).toContain("OTHER:");
  });

  it("Fix 1 — matches a LABEL first, so a real option whose label starts 'OTHER:' is not hijacked to free text", async () => {
    const complete: Complete = async () => "OTHER: pick me";
    const d = await new LlmDecider(complete).decide(ask("Which?", ["OTHER: pick me", "Something else"]), ctx());
    // selected as the literal label, not parsed as a free-text "pick me"
    expect((d as any).response.answers).toEqual({ "Which?": "OTHER: pick me" });
  });

  it("Fix 1 — a bare out-of-set value (no OTHER: prefix, not a label) still FAILS LOUD", async () => {
    const complete: Complete = async () => "Acme Robotics";
    await expect(new LlmDecider(complete).decide(ask("Name it?", ["Project Alpha", "Project Beta"]), ctx())).rejects.toThrow(
      UnansweredError,
    );
  });

  it("Fix 1 — an empty OTHER: directive FAILS LOUD (no empty free-text answer)", async () => {
    const complete: Complete = async () => "OTHER:   ";
    await expect(new LlmDecider(complete).decide(ask("Name it?", ["Project Alpha", "Project Beta"]), ctx())).rejects.toThrow(
      UnansweredError,
    );
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

  it("answers an open-ended (no-option) question with free text via updatedInput:{questions,answers}", async () => {
    let seenPrompt = "";
    const complete: Complete = async (p) => ((seenPrompt = p), "I'd ship a concise weekly digest.");
    const req: DecisionRequest = {
      id: "r",
      kind: "question",
      questions: [{ question: "What should we build?", options: [] }],
    };
    const d = await new LlmDecider(complete, "be pragmatic").decide(req, ctx());
    expect(d).not.toBe(ABSTAIN);
    // The free-text prompt is used (not the label-pick prompt), and the intent is steered in.
    expect(seenPrompt).toContain("no preset options");
    expect(seenPrompt).toContain("be pragmatic");
    expect((d as any).response).toEqual({
      kind: "question",
      answers: { "What should we build?": "I'd ship a concise weekly digest." },
    });
    expect((d as any).by).toBe("llm");
  });

  it("FAILS LOUD when the model returns an empty free-text answer for a no-option question", async () => {
    const complete: Complete = async () => "   ";
    const req: DecisionRequest = { id: "r", kind: "question", questions: [{ question: "Open?", options: [] }] };
    await expect(new LlmDecider(complete).decide(req, ctx())).rejects.toThrow(UnansweredError);
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

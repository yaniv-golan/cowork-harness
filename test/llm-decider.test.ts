import { describe, it, expect } from "vitest";
import { LlmDecider, ABSTAIN, UnansweredError, type RunContext, type Complete, type CompleteResult } from "../src/decide/decider.js";
import type { DecisionRequest } from "../src/agent/session.js";

const ctx = (t = ""): RunContext => ({ task: "", transcript: () => t, toolLog: () => [], runId: "x" });
const ask = (q: string, opts: string[]): DecisionRequest => ({
  id: "r",
  kind: "question",
  questions: [{ question: q, options: opts.map((label) => ({ label })) }],
});
// Every mock below reports a fixed "test-model" resolution unless a test specifically cares what model
// gets recorded — LlmDecider now requires every Complete call to state which model answered.
const reply = (text: string, model = "test-model"): CompleteResult => ({ text, model });

describe("LlmDecider", () => {
  it("picks the option the model returns; by:'llm' + model recorded", async () => {
    const complete: Complete = async () => reply("PDF");
    const d = await new LlmDecider(complete, undefined, "haiku-test").decide(ask("Format?", ["Markdown", "PDF"]), ctx());
    expect(d).not.toBe(ABSTAIN);
    expect((d as any).response).toEqual({ kind: "question", answers: { "Format?": "PDF" } });
    expect((d as any).by).toBe("llm");
    expect((d as any).model).toBe("test-model");
  });

  it("records the RESOLVED model the transport reports — not the requested id", async () => {
    const complete: Complete = async () => reply("PDF", "claude-sonnet-5");
    const d = await new LlmDecider(complete, undefined, "sonnet").decide(ask("Format?", ["Markdown", "PDF"]), ctx());
    expect((d as any).model).toBe("claude-sonnet-5");
  });

  it("defaults the answering model to the floating 'sonnet' alias when none is supplied", async () => {
    // The default resolves from `process.env.COWORK_HARNESS_DECIDER_MODEL || <literal>`, so unset the
    // env first or this asserts the env value (false green/red in a CI that sets it). The mock echoes
    // back whatever `model` it was asked to use, so this proves the DEFAULT REQUEST value; the SEPARATE
    // "records the RESOLVED model" test above already proves resolution is recorded, not the alias.
    const prev = process.env.COWORK_HARNESS_DECIDER_MODEL;
    delete process.env.COWORK_HARNESS_DECIDER_MODEL;
    try {
      let requested = "";
      const complete: Complete = async (_p, model) => ((requested = model), reply("PDF", model));
      await new LlmDecider(complete).decide(ask("Format?", ["Markdown", "PDF"]), ctx());
      expect(requested).toBe("sonnet");
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_DECIDER_MODEL;
      else process.env.COWORK_HARNESS_DECIDER_MODEL = prev;
    }
  });

  it("a prose decline fails loud with a hint naming the --decider-model lever", async () => {
    const prose: Complete = async () => reply("I don't have information about that");
    try {
      await new LlmDecider(prose, undefined, "haiku-test").decide(ask("Jurisdiction?", ["Delaware", "Israeli"]), ctx());
      throw new Error("expected UnansweredError");
    } catch (e) {
      expect(e).toBeInstanceOf(UnansweredError);
      expect((e as UnansweredError).hint).toContain("--decider-model");
    }
  });

  it("puts the --intent into the model prompt; requires an exact label (not a prose answer)", async () => {
    let seenPrompt = "";
    // fix: matchLabel defaults to fuzzy=false, so a prose answer is no longer accepted.
    // The LLM prompt says "Reply with ONLY the exact label" — a well-behaved model should return the
    // exact label, not a prose sentence. A prose answer must now fail loud (not silently accept it).
    const completeProse: Complete = async (p) => ((seenPrompt = p), reply("I would choose Series A here."));
    await expect(
      new LlmDecider(completeProse, "test the not_ai branch").decide(ask("Confirm the stage?", ["Seed", "Series A"]), ctx()),
    ).rejects.toThrow(UnansweredError);
    expect(seenPrompt).toContain("test the not_ai branch");

    // A well-behaved LLM returning the exact label still works.
    const completeExact: Complete = async () => reply("Series A");
    const d = await new LlmDecider(completeExact, "test the not_ai branch").decide(ask("Confirm the stage?", ["Seed", "Series A"]), ctx());
    expect((d as any).response.answers).toEqual({ "Confirm the stage?": "Series A" });
  });

  it("FAILS LOUD on an out-of-set answer — never a silent default to option 1", async () => {
    const complete: Complete = async () => reply("Banana");
    await expect(new LlmDecider(complete).decide(ask("Format?", ["Markdown", "PDF"]), ctx())).rejects.toThrow(UnansweredError);
  });

  it("supplies free text for an options-bearing gate via the OTHER: directive (Cowork's 'Other' path)", async () => {
    let seenPrompt = "";
    const complete: Complete = async (p) => ((seenPrompt = p), reply("OTHER: Acme Robotics"));
    const d = await new LlmDecider(complete, "name it after the customer").decide(
      ask("What should I name it?", ["Project Alpha", "Project Beta"]),
      ctx(),
    );
    expect((d as any).response).toEqual({ kind: "question", answers: { "What should I name it?": "Acme Robotics" } });
    expect((d as any).by).toBe("llm");
    // the prompt advertises the OTHER affordance
    expect(seenPrompt).toContain("OTHER:");
  });

  it("OTHER directive — a markdown-/quote-wrapped OTHER: still binds (model code-fences the directive)", async () => {
    // Observed live: the model replied `` `OTHER: Sector not specified in document` ``; the
    // leading backtick defeated the `^\s*OTHER:` anchor → whiff → fail-loud stall. The wrapping fence is now
    // stripped before the sentinel test.
    for (const raw of ["`OTHER: Sector not specified in document`", '"OTHER: Sector not specified"']) {
      const complete: Complete = async () => reply(raw);
      const d = await new LlmDecider(complete).decide(ask("What sector?", ["Health tech", "B2B SaaS"]), ctx());
      expect((d as any).response.answers["What sector?"]).toMatch(/^Sector not specified/);
    }
  });

  it("OTHER directive — a wrapping fence is stripped but the value's OWN trailing punctuation is preserved", async () => {
    // Only the wrapper is removed (not trailing sentence punctuation like trimNearMiss): the free-text VALUE
    // is delivered verbatim, so a trailing period inside the value must survive.
    const complete: Complete = async () => reply("`OTHER: Acme Inc.`");
    const d = await new LlmDecider(complete).decide(ask("Name it?", ["Project Alpha", "Project Beta"]), ctx());
    expect((d as any).response.answers["Name it?"]).toBe("Acme Inc.");
  });

  it("OTHER directive — only a MATCHED wrapping pair is stripped; a value's own trailing quote/backtick survives", async () => {
    // Regression guard: an unconditional trailing-quote strip would mangle a value that legitimately ends in a
    // quote. Unfenced replies must pass through verbatim; only a same-char wrapping pair is removed.
    const cases: [string, string][] = [
      ['OTHER: the field is labeled "Status"', 'the field is labeled "Status"'], // no wrapper → verbatim
      ["OTHER: run `ls`", "run `ls`"], // trailing backtick belongs to the value
      ["`OTHER: code-fenced value`", "code-fenced value"], // matched fence → stripped
    ];
    for (const [raw, expected] of cases) {
      const complete: Complete = async () => reply(raw);
      const d = await new LlmDecider(complete).decide(ask("Name it?", ["Project Alpha", "Project Beta"]), ctx());
      expect((d as any).response.answers["Name it?"]).toBe(expected);
    }
  });

  it("OTHER directive — a QUOTED real option whose label starts 'OTHER:' still binds as the label (not free text)", async () => {
    // Ordering guard: matchLabel (which quote-trims internally) must bind the literal label before the OTHER
    // sentinel is ever reached, even when the model wraps its reply in a code fence.
    const complete: Complete = async () => reply("`OTHER: pick me`");
    const d = await new LlmDecider(complete).decide(ask("Which?", ["OTHER: pick me", "Something else"]), ctx());
    expect((d as any).response.answers).toEqual({ "Which?": "OTHER: pick me" });
  });

  it("matches a LABEL first, so a real option whose label starts 'OTHER:' is not hijacked to free text", async () => {
    const complete: Complete = async () => reply("OTHER: pick me");
    const d = await new LlmDecider(complete).decide(ask("Which?", ["OTHER: pick me", "Something else"]), ctx());
    // selected as the literal label, not parsed as a free-text "pick me"
    expect((d as any).response.answers).toEqual({ "Which?": "OTHER: pick me" });
  });

  it("a bare out-of-set value (no OTHER: prefix, not a label) still FAILS LOUD", async () => {
    const complete: Complete = async () => reply("Acme Robotics");
    await expect(new LlmDecider(complete).decide(ask("Name it?", ["Project Alpha", "Project Beta"]), ctx())).rejects.toThrow(
      UnansweredError,
    );
  });

  it("an empty OTHER: directive FAILS LOUD (no empty free-text answer)", async () => {
    const complete: Complete = async () => reply("OTHER:   ");
    await expect(new LlmDecider(complete).decide(ask("Name it?", ["Project Alpha", "Project Beta"]), ctx())).rejects.toThrow(
      UnansweredError,
    );
  });

  it("binds a near-miss label with trailing punctuation (e.g. 'Confirmed.') instead of failing loud", async () => {
    const complete: Complete = async () => reply("Confirmed.");
    const d = await new LlmDecider(complete).decide(ask("Use the extracted cap table?", ["Confirmed", "Different"]), ctx());
    expect((d as any).response.answers).toEqual({ "Use the extracted cap table?": "Confirmed" });
    expect((d as any).by).toBe("llm");
  });

  it("the trailing-punctuation trim does NOT swallow the OTHER: sentinel (colon is preserved)", async () => {
    // A 2-option gate still honors OTHER: free text — the dropped suppression must not regress.
    const complete: Complete = async () => reply("OTHER: CSV");
    const d = await new LlmDecider(complete).decide(ask("Format?", ["PDF", "DOCX"]), ctx());
    expect((d as any).response.answers).toEqual({ "Format?": "CSV" });
  });

  it("abstains on an ORDINARY (optionless) permission request (parity default handles it)", async () => {
    const complete: Complete = async () => reply("x");
    const r = await new LlmDecider(complete).decide({ id: "p", kind: "permission", tool: "Bash", input: {} }, ctx());
    expect(r).toBe(ABSTAIN);
  });

  it("answers a web_fetch approval (options) with the chosen grant scope", async () => {
    let seenPrompt = "";
    const complete: Complete = async (p) => ((seenPrompt = p), reply("Allow all for website"));
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

  it("binds an echoed grant label (option + self-glossed description tail) instead of failing loud", async () => {
    const req: DecisionRequest = {
      id: "p",
      kind: "permission",
      tool: "webfetch:x.com",
      input: { domain: "x.com", url: "https://x.com/a" },
      options: [{ label: "Allow once" }, { label: "Allow all for website" }, { label: "Deny" }],
    };
    // The model parrots the option plus a self-glossed description tail past the `:` boundary.
    const d = await new LlmDecider(async () => reply("Allow once: fetch this URL one time")).decide(req, ctx());
    expect((d as any).response).toMatchObject({ kind: "permission", behavior: "allow", grant: "once" });
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
    await expect(new LlmDecider(async () => reply("Maybe later")).decide(req, ctx())).rejects.toThrow(UnansweredError);
  });

  it("answers an open-ended (no-option) question with free text via updatedInput:{questions,answers}", async () => {
    let seenPrompt = "";
    const complete: Complete = async (p) => ((seenPrompt = p), reply("I'd ship a concise weekly digest."));
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
    const complete: Complete = async () => reply("   ");
    const req: DecisionRequest = { id: "r", kind: "question", questions: [{ question: "Open?", options: [] }] };
    await expect(new LlmDecider(complete).decide(req, ctx())).rejects.toThrow(UnansweredError);
  });

  it("multi-select rejects OTHER: free text — index-only, no free-text escape hatch on this path", async () => {
    // Pin the documented gap: unlike single-select, the multi-select branch (decider.ts:540-567) only accepts
    // a comma-list of bare option numbers. An OTHER: reply is not a valid index list, so it must fail loud —
    // this is a deliberate decision, not an oversight.
    const complete: Complete = async () => reply("OTHER: custom value");
    const req: DecisionRequest = {
      id: "r",
      kind: "question",
      questions: [{ question: "Pick features?", options: [{ label: "A" }, { label: "B" }], multiSelect: true }],
    };
    await expect(new LlmDecider(complete).decide(req, ctx())).rejects.toThrow(UnansweredError);
  });

  it("rationale is marked '[via Other free-text]' when an OTHER: answer was used, and NOT marked on a plain label pick", async () => {
    const req: DecisionRequest = {
      id: "r",
      kind: "question",
      questions: [{ question: "Name it?", options: [{ label: "Project Alpha" }, { label: "Project Beta" }] }],
    };
    const other: Complete = async () => reply("OTHER: Acme Robotics");
    const dOther = await new LlmDecider(other, "name it after the customer").decide(req, ctx());
    expect((dOther as any).rationale).toContain("[via Other free-text]");

    const labelPick: Complete = async () => reply("2"); // index protocol → "Project Beta"
    const dLabel = await new LlmDecider(labelPick, "name it after the customer").decide(req, ctx());
    expect((dLabel as any).response.answers).toEqual({ "Name it?": "Project Beta" });
    expect((dLabel as any).rationale).not.toContain("[via Other free-text]");
  });

  it("answers each question of a multi-question request independently (one call per question)", async () => {
    let calls = 0;
    const complete: Complete = async () => (calls++, reply(calls === 1 ? "Markdown" : "Deep"));
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

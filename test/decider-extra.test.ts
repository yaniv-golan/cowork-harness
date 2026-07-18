import { describe, it, expect } from "vitest";
import {
  matchLabel,
  coerceLabel,
  ScriptedDecider,
  PromptDecider,
  ABSTAIN,
  UnansweredError,
  type RunContext,
} from "../src/decide/decider.js";
import { spawnChannel } from "../src/decide/external-channel.js";
import type { DecisionRequest } from "../src/agent/session.js";
import type { AnswerRule } from "../src/types.js";

const ctx = (): RunContext => ({ task: "", transcript: () => "", toolLog: () => [], runId: "local_x" });
const perm = (input: Record<string, unknown>): DecisionRequest => ({ id: "p1", kind: "permission", tool: "Bash", input });

// matchLabel: substring heuristic is opt-in (fuzzy=true). Default (fuzzy=false) requires exact match.
describe("matchLabel — exact-only by default; substring is opt-in via fuzzy=true", () => {
  it("exact match wins regardless of fuzzy flag", () => {
    // The old code returned "No" (first substring) for reply "Notation" — a mis-steer. Both "No" and
    // "Notation" are contained in "Notation", so the substring tier must decline.
    expect(matchLabel("Notation", ["No", "Notation"])).toBe("Notation"); // exact wins, not the substring tier
    expect(matchLabel("Notation", ["No", "Notation"], true)).toBe("Notation"); // same with fuzzy=true
  });

  it("without fuzzy flag: reply containing a single label substring does NOT match (returns null)", () => {
    expect(matchLabel("Markdown format please", ["Markdown", "PDF"])).toBe(null);
  });

  it("with fuzzy=true: single substring → match (the lenient case is preserved for opt-in callers)", () => {
    expect(matchLabel("Markdown format please", ["Markdown", "PDF"], true)).toBe("Markdown");
  });

  it("with fuzzy=true: ambiguous substrings → null (fail loud, not a guess)", () => {
    expect(matchLabel("xNotationx", ["No", "Notation"], true)).toBe(null); // both substrings, no exact → null
  });

  it("exact and case-insensitive-exact tiers win before the substring tier (both modes)", () => {
    expect(matchLabel("PDF", ["Markdown", "PDF"])).toBe("PDF"); // exact
    expect(matchLabel("pdf", ["Markdown", "PDF"])).toBe("PDF"); // case-insensitive exact
    expect(matchLabel("PDF", ["Markdown", "PDF"], true)).toBe("PDF"); // exact with fuzzy
    expect(matchLabel("pdf", ["Markdown", "PDF"], true)).toBe("PDF"); // case-insensitive exact with fuzzy
  });

  it("tolerates surrounding quotes and trailing sentence punctuation (a near-miss label), case-insensitively", () => {
    expect(matchLabel("Confirmed.", ["Confirmed", "Different"])).toBe("Confirmed"); // trailing period
    expect(matchLabel('"Confirmed"', ["Confirmed"])).toBe("Confirmed"); // surrounding quotes
    expect(matchLabel("confirmed!", ["Confirmed"])).toBe("Confirmed"); // punctuation + case
  });

  it("never strips a colon — preserves the OTHER: sentinel so a near-miss can't swallow it", () => {
    expect(matchLabel("Confirmed:", ["Confirmed"])).toBe(null); // ':' is NOT trailing punctuation we strip
  });

  it("no match at all → null (both modes)", () => {
    expect(matchLabel("CSV", ["Markdown", "PDF"])).toBe(null);
    expect(matchLabel("CSV", ["Markdown", "PDF"], true)).toBe(null);
  });
});

// allow_if predicate errors must THROW (loud), not silently deny. Valid predicates still evaluate.
describe("evalPredicate via ScriptedDecider (broken predicate throws, never silent-deny)", () => {
  const rule = (allow_if: string): AnswerRule[] => [{ when_tool: "Bash", allow_if } as AnswerRule];

  it("a syntactically broken predicate (compile error) throws", async () => {
    const d = new ScriptedDecider(rule("command.("));
    await expect(d.decide(perm({ command: "ls" }), ctx())).rejects.toThrow(/allow_if predicate failed to compile/);
  });

  it("an eval-time throw (reference to an undefined symbol) throws", async () => {
    const d = new ScriptedDecider(rule("nope.includes('x')"));
    await expect(d.decide(perm({ command: "ls" }), ctx())).rejects.toThrow(/allow_if predicate threw at eval time/);
  });

  it("a valid predicate that returns true → allow; falsy → deny (only ERRORS throw)", async () => {
    const allow = await new ScriptedDecider(rule("!command.includes('rm')")).decide(perm({ command: "ls" }), ctx());
    expect((allow as any).response).toMatchObject({ kind: "permission", behavior: "allow" });
    const deny = await new ScriptedDecider(rule("!command.includes('rm')")).decide(perm({ command: "rm -rf /" }), ctx());
    expect((deny as any).response).toMatchObject({ kind: "permission", behavior: "deny" });
  });
});

// evalPredicate exposes a single `input` object (reaching non-identifier keys) AND keeps binding
// each identifier-shaped key as a bare parameter (the form shipped example scenarios + docs rely on).
describe("evalPredicate — additive input object + bare identifiers", () => {
  const rule = (allow_if: string): AnswerRule[] => [{ when_tool: "Bash", allow_if } as AnswerRule];
  const permWith = (input: Record<string, unknown>): DecisionRequest => ({ id: "p1", kind: "permission", tool: "Bash", input });

  it("a non-identifier key (file-path) no longer hard-fails compilation — reachable via input[...]", async () => {
    const d = new ScriptedDecider(rule("input['file-path'].endsWith('.ts')"));
    const allow = await d.decide(permWith({ "file-path": "/a/b.ts" }), ctx());
    expect((allow as any).response).toMatchObject({ kind: "permission", behavior: "allow" });
    const deny = await new ScriptedDecider(rule("input['file-path'].endsWith('.ts')")).decide(permWith({ "file-path": "/a/b.png" }), ctx());
    expect((deny as any).response).toMatchObject({ kind: "permission", behavior: "deny" });
  });

  it("a dotted key (foo.bar) is reachable via input['foo.bar'] without a compile crash", async () => {
    const d = new ScriptedDecider(rule("input['foo.bar'] === 1"));
    const allow = await d.decide(permWith({ "foo.bar": 1 }), ctx());
    expect((allow as any).response).toMatchObject({ kind: "permission", behavior: "allow" });
  });

  it("the bare-identifier form STILL works (command.includes — shipped example scenarios/docs)", async () => {
    const allow = await new ScriptedDecider(rule("!command.includes('rm')")).decide(permWith({ command: "ls" }), ctx());
    expect((allow as any).response).toMatchObject({ kind: "permission", behavior: "allow" });
    const deny = await new ScriptedDecider(rule("!command.includes('rm')")).decide(permWith({ command: "rm -rf /" }), ctx());
    expect((deny as any).response).toMatchObject({ kind: "permission", behavior: "deny" });
  });

  it("the bare identifier and the input object see the same value for an identifier-shaped key", async () => {
    const d = new ScriptedDecider(rule("command === input.command && command === 'ls'"));
    const allow = await d.decide(permWith({ command: "ls" }), ctx());
    expect((allow as any).response).toMatchObject({ kind: "permission", behavior: "allow" });
  });

  it("a reserved-word input key (class/for/new/in) no longer breaks an UNRELATED allow_if compilation", async () => {
    // `class`/`for`/... are identifier-SHAPED but illegal as `new Function` parameter names → they used to
    // crash compilation of a predicate that merely referenced an unrelated key. The predicate must still
    // evaluate; the reserved-word key stays reachable via input[...].
    for (const reserved of ["class", "for", "new", "in", "let", "yield", "static", "eval", "arguments"]) {
      const d = new ScriptedDecider(rule("command === 'ls'"));
      const allow = await d.decide(permWith({ command: "ls", [reserved]: "whatever" }), ctx());
      expect((allow as any).response, `reserved key ${reserved} broke compilation`).toMatchObject({
        kind: "permission",
        behavior: "allow",
      });
    }
  });

  it("a reserved-word input key is still reachable via input['class'] (excluded only from bare binding)", async () => {
    const d = new ScriptedDecider(rule("input['class'] === 'gold'"));
    const allow = await d.decide(permWith({ class: "gold" }), ctx());
    expect((allow as any).response).toMatchObject({ kind: "permission", behavior: "allow" });
    const deny = await new ScriptedDecider(rule("input['class'] === 'gold'")).decide(permWith({ class: "silver" }), ctx());
    expect((deny as any).response).toMatchObject({ kind: "permission", behavior: "deny" });
  });

  it("an input key literally named `input` does not double-bind (the explicit object wins, no compile error)", async () => {
    // `input` must not be bound twice (a duplicate parameter is a "use strict" compile error). The explicit
    // object wins, so `input.command` is reachable even when there is also an `input` key.
    const d = new ScriptedDecider(rule("input.command === 'ls'"));
    const allow = await d.decide(permWith({ command: "ls", input: "ignored-shadow" }), ctx());
    expect((allow as any).response).toMatchObject({ kind: "permission", behavior: "allow" });
  });
});

// PromptDecider question paths guard empty option lists (mirrors the permission-path guard and
// FirstOptionDecider). Single-select/no-options is open-ended free text; multi-select/no-options is a
// protocol contradiction. WITHOUT the guard the do/while loop spins forever (coerceLabel([]) never matches).
describe("PromptDecider — optionless question guard, no infinite loop", () => {
  const withTTY = async (fn: () => Promise<void>): Promise<void> => {
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await fn();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  };

  it("a single-select question with NO options accepts free text (does not loop forever)", async () => {
    await withTTY(async () => {
      const asked: string[] = [];
      const ask = async (p: string) => (asked.push(p), "Acme Holdings LLC");
      const req: DecisionRequest = { id: "q", kind: "question", questions: [{ question: "Company name?", options: [] }] };
      const res = await new PromptDecider(ask).decide(req, ctx());
      expect((res as any).response.answers["Company name?"]).toBe("Acme Holdings LLC");
      expect(asked).toHaveLength(1); // answered on the first non-empty input, did not spin
    });
  });

  it("an empty answer is re-prompted, then a non-empty one is accepted", async () => {
    await withTTY(async () => {
      const replies = ["", "  ", "real answer"];
      let i = 0;
      const ask = async () => replies[i++];
      const req: DecisionRequest = { id: "q", kind: "question", questions: [{ question: "Open?", options: [] }] };
      const res = await new PromptDecider(ask).decide(req, ctx());
      expect((res as any).response.answers["Open?"]).toBe("real answer");
      expect(i).toBe(3); // re-prompted past the two empties
    });
  });

  it("a MULTI-select question with NO options fails loud (protocol contradiction, no loop)", async () => {
    await withTTY(async () => {
      const ask = async () => "anything";
      const req: DecisionRequest = { id: "q", kind: "question", questions: [{ question: "Pick?", options: [], multiSelect: true }] };
      await expect(new PromptDecider(ask).decide(req, ctx())).rejects.toThrow(UnansweredError);
    });
  });
});

describe("PromptDecider — boxed prompts", () => {
  // `withTTY` is NOT module-scoped in this file — it's a `const` local to the
  // "optionless question guard" describe block above, invisible to a sibling describe. Redefine it
  // here (`ctx()` at module scope IS safely reusable).
  const withTTY = async (fn: () => Promise<void>): Promise<void> => {
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      await fn();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  };

  it("frames a permission prompt in a box (visually distinct from plain progress lines)", async () => {
    await withTTY(async () => {
      let captured = "";
      const ask = async (p: string) => ((captured = p), "1");
      // PromptDecider's permission path is web_fetch-approval-only — the coerced label is always run
      // through coerceWebFetchGrant (decider.ts:724), which accepts ONLY the grant vocabulary
      // ("allow once"/"once"/"1", "allow all for website"/"all"/"domain"/"2", "deny"/"3") and throws
      // on anything else (decider.ts:431-440). Options here MUST use real grant labels.
      const req: DecisionRequest = {
        id: "p",
        kind: "permission",
        tool: "webfetch",
        input: {},
        options: [{ label: "Allow once" }, { label: "Allow all for website" }, { label: "Deny" }],
      };
      await new PromptDecider(ask).decide(req, ctx());
      expect(captured).toContain("┌");
      expect(captured).toContain("└");
      expect(captured).toContain("webfetch?");
      expect(captured).toContain("1) Allow once");
    });
  });

  it("frames a multi-select question prompt in a box", async () => {
    await withTTY(async () => {
      let captured = "";
      const ask = async (p: string) => ((captured = p), "1");
      const req: DecisionRequest = {
        id: "q",
        kind: "question",
        questions: [{ question: "Pick one or more", options: [{ label: "A" }, { label: "B" }], multiSelect: true }],
      };
      await new PromptDecider(ask).decide(req, ctx());
      expect(captured).toContain("┌");
      expect(captured).toContain("Pick one or more");
      expect(captured).toContain("1) A");
    });
  });
});

// spawnChannel readLine bounds the wait on a hung-but-alive helper (loud reject, never silent hang).
// Borderline: spawns a real `sh` stub that never answers; env shrinks the timeout to ~50ms.
describe("spawnChannel readLine timeout (borderline, spawn-based)", () => {
  it("rejects LOUD when the helper never answers within the timeout", async () => {
    const prev = process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS;
    process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS = "50";
    // `sleep 30` stays alive but never reads stdin or writes stdout → readLine must time out, not hang
    // forever. (`cat` would echo our request back and resolve early; `sleep` produces no output.)
    const ch = spawnChannel("sleep 30");
    try {
      ch.write("{}");
      await expect(ch.readLine()).rejects.toThrow(/timed out before answering/);
    } finally {
      ch.close?.();
      if (prev === undefined) delete process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS;
      else process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS = prev;
    }
  });
});

// AskUserQuestion answer shapes (binary-verified 2026-06-17): CHOOSE-SUFFIX, MULTISELECT, FREE-TEXT.
const ques = (questions: any[]): DecisionRequest => ({ id: "q1", kind: "question", questions });
async function answersOf(rules: AnswerRule[], questions: any[]): Promise<Record<string, string> | "abstain"> {
  const r = await new ScriptedDecider(rules).decide(ques(questions), ctx());
  if (r === ABSTAIN) return "abstain";
  return (r as any).response.answers;
}

describe("coerceLabel — non-string/number input fails LOUD (no bare TypeError crash)", () => {
  const labels = ["Auth", "Billing"];
  it("an array argument throws UnansweredError, not 'a.trim is not a function'", () => {
    expect(() => coerceLabel([] as any, labels)).toThrow(UnansweredError);
    expect(() => coerceLabel(["Auth"] as any, labels)).toThrow(/must be a label string or a 1-based index/);
  });
  it("an object / null argument throws UnansweredError", () => {
    expect(() => coerceLabel({} as any, labels)).toThrow(UnansweredError);
    expect(() => coerceLabel(null as any, labels)).toThrow(UnansweredError);
  });
  it("valid string and number inputs are unchanged", () => {
    expect(coerceLabel("Billing", labels)).toEqual({ value: "Billing", matched: true });
    expect(coerceLabel(1, labels)).toEqual({ value: "Auth", matched: true });
    expect(coerceLabel("nope", labels).matched).toBe(false);
  });
});

describe("CHOOSE-SUFFIX — tolerate the (Recommended) suffix + recommended/first keywords", () => {
  const opts = [{ label: "Approve (Recommended)" }, { label: "Reject" }];
  it("a bare label matches its (Recommended)-suffixed option and delivers the FULL canonical label", async () => {
    expect(await answersOf([{ when_question: "go", choose: "Approve" }], [{ question: "go?", options: opts }])).toEqual({
      "go?": "Approve (Recommended)",
    });
  });
  it("`recommended` keyword picks the (Recommended) option", async () => {
    expect(await answersOf([{ when_question: "go", choose: "recommended" }], [{ question: "go?", options: opts }])).toEqual({
      "go?": "Approve (Recommended)",
    });
  });
  it("`first` keyword picks option 1", async () => {
    expect(await answersOf([{ when_question: "go", choose: "first" }], [{ question: "go?", options: opts }])).toEqual({
      "go?": "Approve (Recommended)",
    });
  });
});

describe("MULTISELECT — list of labels delivered comma-joined (verified wire shape)", () => {
  const opts = [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }];
  it("an array choose on a multiSelect gate joins validated labels with ', '", async () => {
    expect(
      await answersOf([{ when_question: "pick", choose: ["Auth", "Billing"] }], [{ question: "pick?", options: opts, multiSelect: true }]),
    ).toEqual({ "pick?": "Auth, Billing" });
  });
  it("an array choose on a SINGLE-select gate fails loud", async () => {
    await expect(
      new ScriptedDecider([{ when_question: "pick", choose: ["Auth", "Billing"] }]).decide(
        ques([{ question: "pick?", options: opts }]),
        ctx(),
      ),
    ).rejects.toThrow(/single-select/);
  });
  it("an unknown member label fails loud (per-element guard preserved)", async () => {
    await expect(
      new ScriptedDecider([{ when_question: "pick", choose: ["Auth", "Nope"] }]).decide(
        ques([{ question: "pick?", options: opts, multiSelect: true }]),
        ctx(),
      ),
    ).rejects.toThrow(/matched no offered option/);
  });
});

describe("FREE-TEXT — answer: delivers an arbitrary string, bypassing label validation", () => {
  const opts = [{ label: "Yes" }, { label: "No" }];
  it("answer: is delivered verbatim even though it is not an offered option", async () => {
    expect(await answersOf([{ when_question: "name", answer: "Acme Holdings LLC" }], [{ question: "name?", options: opts }])).toEqual({
      "name?": "Acme Holdings LLC",
    });
  });
  it("setting both choose and answer on the same rule fails loud", async () => {
    await expect(
      new ScriptedDecider([{ when_question: "name", choose: "Yes", answer: "x" }]).decide(
        ques([{ question: "name?", options: opts }]),
        ctx(),
      ),
    ).rejects.toThrow(/both choose and answer/);
  });
});

describe("a partial batched-gate match names the UNMATCHED sub-questions then abstains", () => {
  it("abstains the whole gate and the warning lists the unmatched question text", async () => {
    const writes: string[] = [];
    const spy = (s: string | Uint8Array): boolean => (writes.push(String(s)), true);
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = spy;
    try {
      const out = await answersOf(
        [{ when_question: "first one", choose: "A" }],
        [
          { question: "first one?", options: [{ label: "A" }] },
          { question: "second one?", options: [{ label: "B" }] },
        ],
      );
      expect(out).toBe("abstain");
    } finally {
      (process.stderr as any).write = orig;
    }
    const warn = writes.join("");
    expect(warn).toMatch(/UNMATCHED:/);
    expect(warn).toMatch(/second one\?/);
  });
});

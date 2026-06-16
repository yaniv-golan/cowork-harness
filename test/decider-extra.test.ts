import { describe, it, expect } from "vitest";
import { matchLabel, ScriptedDecider, type RunContext } from "../src/decide/decider.js";
import { spawnChannel } from "../src/decide/external-channel.js";
import type { DecisionRequest } from "../src/agent/session.js";
import type { AnswerRule } from "../src/types.js";

const ctx = (): RunContext => ({ task: "", transcript: () => "", toolLog: () => [], runId: "local_x" });
const perm = (input: Record<string, unknown>): DecisionRequest => ({ id: "p1", kind: "permission", tool: "Bash", input });

// #6 — matchLabel: ambiguous substring → null (fail loud), single substring → match, exact tiers win first.
describe("matchLabel (#6 — substring tier only fires on a UNIQUE substring)", () => {
  it("ambiguous: two labels are substrings of the reply → null (caller fails loud)", () => {
    // The old code returned "No" (first substring) for reply "Notation" — a mis-steer. Both "No" and
    // "Notation" are contained in "Notation", so the substring tier must decline.
    expect(matchLabel("Notation", ["No", "Notation"])).toBe("Notation"); // exact wins, not the substring tier
    expect(matchLabel("xNotationx", ["No", "Notation"])).toBe(null); // both substrings, no exact → null
  });

  it("single substring → match (the useful lenient case is preserved)", () => {
    expect(matchLabel("Markdown format please", ["Markdown", "PDF"])).toBe("Markdown");
  });

  it("exact and case-insensitive-exact tiers win before the substring tier", () => {
    expect(matchLabel("PDF", ["Markdown", "PDF"])).toBe("PDF"); // exact
    expect(matchLabel("pdf", ["Markdown", "PDF"])).toBe("PDF"); // case-insensitive exact
  });

  it("no match at all → null", () => {
    expect(matchLabel("CSV", ["Markdown", "PDF"])).toBe(null);
  });
});

// #7 — allow_if predicate errors must THROW (loud), not silently deny. Valid predicates still evaluate.
describe("evalPredicate via ScriptedDecider (#7 — broken predicate throws, never silent-deny)", () => {
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

// #53 — spawnChannel readLine bounds the wait on a hung-but-alive helper (loud reject, never silent hang).
// Borderline: spawns a real `sh` stub that never answers; env shrinks the timeout to ~50ms.
describe("spawnChannel readLine timeout (#53 — borderline, spawn-based)", () => {
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

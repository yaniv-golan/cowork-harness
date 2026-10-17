import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { replayCassette, redactCassette, redactionRewroteNegativeToolInputs, type Cassette } from "../src/run/cassette.js";
import { loadRedactionPolicy } from "../src/redact.js";
import type { Scenario } from "../src/types.js";

// THE HAZARD. A committed cassette is redacted by default, and redaction rewrites the frozen tool_use
// inputs. A NEGATIVE input check naming a literal the policy rewrites (a home path) then looks for bytes
// that are gone and would pass VACUOUSLY on replay — the CI lane — while it FAILS live. The positive form
// merely fails on replay (loud). These pin every guard: replay must not pass, and `record` must say why.
//
// The cassette is built directly with `redactCassette` — `record` would refuse a run whose negative check
// failed live before it ever reached redaction, so recording one is not how the hazard is reached in
// practice (it is reached by `--allow-failing`, by a later edit replayed with `--assert-from`, or by a
// regex the policy itself rewrites).

const POLICY = loadRedactionPolicy([resolve(".")]); // the repo's own .cowork-redact.json
const NEG = { tool_not_called: { tool: "Bash", input: { command: "rm\\s+-rf\\s+/Users/acme" } } };

const line = (o: unknown) => JSON.stringify(o);
const INIT = line({ type: "system", subtype: "init", tools: ["Bash"] });
const BASH = line({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "rm -rf /Users/acme/project/tmp" } }],
  },
});
const RESULT = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "" }] } });
const DONE = line({ type: "result", subtype: "success", is_error: false });

function cassette(assert: Record<string, unknown>[]): Cassette {
  return {
    scenario: {
      name: "redaction-hazard",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "clean up",
      answers: [],
      expect_denied: [],
      assert,
    } as unknown as Scenario,
    events: [INIT, BASH, RESULT, DONE],
    controlOut: [],
  } as unknown as Cassette;
}

const verdictOf = async (c: Cassette) => (await replayCassette(c, [])).assertions.find((a) => "tool_not_called" in a.assertion)!;

describe("negative object form over a redacted cassette", () => {
  it("sanity: the policy really rewrites the command, and the UNREDACTED replay fails the negative", async () => {
    expect(POLICY.patterns.length).toBeGreaterThan(0);
    const red = redactCassette(cassette([NEG]), POLICY);
    expect(red.events[1]).toContain("[REDACTED:");
    expect((await verdictOf(cassette([NEG]))).pass).toBe(false);
  });

  it("replay of the redacted cassette does NOT pass (frozen regex rewritten by the same policy)", async () => {
    const red = redactCassette(cassette([NEG]), POLICY);
    const v = await verdictOf(red);
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("replay with an UNREDACTED regex against the redacted stream (the --assert-from shape) does NOT pass", async () => {
    const red = redactCassette(cassette([NEG]), POLICY);
    const reasserted = { ...red, scenario: { ...red.scenario, assert: [NEG] } } as Cassette;
    const v = await verdictOf(reasserted);
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("the cost, stated: ANY redacted text in a candidate's field makes a negative miss unknown — even a regex redaction never touches", async () => {
    // `git push` cannot be hidden inside `/Users/acme/project/tmp`, but the evaluator cannot know what a
    // token replaced, so it does not guess. A negative still PASSES when no in-scope candidate carries a
    // token (next case) — only a call whose bytes were rewritten is "could not look".
    const clean = { tool_not_called: { tool: "Bash", input: { command: "git\\s+push" } } };
    const red = redactCassette(cassette([clean]), POLICY);
    const v = await verdictOf(red);
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("a negative over a redacted cassette still passes when no candidate of THAT tool carries a token", async () => {
    const red = redactCassette(cassette([{ tool_not_called: { tool: "Write", input: { content: "secret" } } }]), POLICY);
    expect((await verdictOf(red)).pass).toBe(true);
  });
});

describe("the tool_called {count: {max: 0}} spelling is the same negative under redaction", () => {
  const NEG_MAX0 = { tool_called: { tool: "Bash", input: { command: "rm\\s+-rf\\s+/Users/acme" }, count: { max: 0 } } };
  const verdictOfMax0 = async (c: Cassette) => (await replayCassette(c, [])).assertions.find((a) => "tool_called" in a.assertion)!;

  it("a redacted candidate field is evidence-unavailable on replay, never a pass", async () => {
    const red = redactCassette(cassette([NEG_MAX0]), POLICY);
    const v = await verdictOfMax0(red);
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("record's redaction explainer names it by its spelling", () => {
    const base = cassette([NEG_MAX0]);
    const findings = redactionRewroteNegativeToolInputs(base, redactCassette(base, POLICY));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join("\n")).toMatch(/tool_called \(count\.max 0\)/);
    // One assert item carrying both spellings: each is explained.
    const both = cassette([{ ...NEG, ...NEG_MAX0 }]);
    const out = redactionRewroteNegativeToolInputs(both, redactCassette(both, POLICY)).join("\n");
    expect(out).toMatch(/tool_not_called\.input\.command/);
    expect(out).toMatch(/tool_called \(count\.max 0\)/);
    // A positive tool_called is not a negative check and is not explained here.
    const pos = cassette([{ tool_called: { tool: "Bash", input: { command: "rm\\s+-rf\\s+/Users/acme" } } }]);
    expect(redactionRewroteNegativeToolInputs(pos, redactCassette(pos, POLICY))).toEqual([]);
  });
});

describe("record-time warning (the exact guard)", () => {
  it("names the assertion whose pre-redaction match redaction rewrote, and the regex the policy rewrote", () => {
    const base = cassette([NEG]);
    const red = redactCassette(base, POLICY);
    const findings = redactionRewroteNegativeToolInputs(base, red);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join("\n")).toMatch(/tool_not_called\.input\.command/);
    expect(findings.join("\n")).toMatch(/b1/);
  });

  it("is silent when redaction touches neither the regex nor any field the check reads", () => {
    // The command carries no redactable literal, so nothing the check reads was rewritten.
    const clean = {
      ...cassette([{ tool_not_called: { tool: "Bash", input: { command: "git\\s+push" } } }]),
      events: streamWith("git status", "ok"),
    } as Cassette;
    expect(redactionRewroteNegativeToolInputs(clean, redactCassette(clean, POLICY))).toEqual([]);
  });

  it("ignores positive forms and string forms", () => {
    const c = cassette([{ tool_called: { tool: "Bash", input: { command: "/Users/acme" } } }, { tool_not_called: "Write" }]);
    expect(redactionRewroteNegativeToolInputs(c, redactCassette(c, POLICY))).toEqual([]);
  });
});

// ---- the --assert-from shape: a FRESH, unredacted regex against a redacted stream -----------------
// The frozen-regex guard cannot help here (the regex was never redacted), and a shape heuristic cannot
// know every policy. So for the NEGATIVE-direction predicates — tool_not_called's input / input_any /
// result.matches, and a positive result.not_matches — a miss over text carrying a redaction token is
// "could not look", whatever the regex looks like.

function streamWith(command: string, resultText: string): string[] {
  return [
    INIT,
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command } }] },
    }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: resultText }] } }),
    DONE,
  ];
}

async function assertFrom(
  policy: Parameters<typeof redactCassette>[1],
  command: string,
  resultText: string,
  assertion: Record<string, unknown>,
) {
  const base = { ...cassette([{ result: "success" }]), events: streamWith(command, resultText) } as Cassette;
  const red = redactCassette(base, policy);
  const reasserted = { ...red, scenario: { ...red.scenario, assert: [assertion] } } as Cassette;
  const r = await replayCassette(reasserted, []);
  return { red, v: r.assertions[0] };
}

const custom = { patterns: [{ re: /AcmeCorp/g, label: "customer" }], keyNames: [] as string[] };

describe("--assert-from over a redacted stream: negative-direction misses on redacted text are unknown", () => {
  it("(a) a custom-policy literal in tool_not_called.input", async () => {
    const { red, v } = await assertFrom(custom, "deploy AcmeCorp now", "ok", {
      tool_not_called: { tool: "Bash", input: { command: "AcmeCorp" } },
    });
    expect(red.events[1]).toContain("[REDACTED:customer:");
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("(b) a custom-policy literal in a positive result.not_matches", async () => {
    const { v } = await assertFrom(custom, "echo hi", "deployed to AcmeCorp", {
      tool_called: { tool: "Bash", result: { not_matches: "AcmeCorp" } },
    });
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("(b') the same literal in tool_not_called.result.matches", async () => {
    const { v } = await assertFrom(custom, "echo hi", "deployed to AcmeCorp", {
      tool_not_called: { tool: "Bash", result: { matches: "AcmeCorp" } },
    });
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("(c) keys: [command] redacts the whole value, so `rm -rf build` is unreadable", async () => {
    const { red, v } = await assertFrom({ patterns: [], keyNames: ["command"] }, "rm -rf build", "ok", {
      tool_not_called: { tool: "Bash", input: { command: "rm\\s+-rf" } },
    });
    expect(red.events[1]).toContain("[REDACTED:key:");
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("(d) the shipped project-slug pattern over a /root/.claude path", async () => {
    const { red, v } = await assertFrom(POLICY, "cat /root/.claude/projects/-Users-acme-secret/x.jsonl", "ok", {
      tool_not_called: { tool: "Bash", input: { command: "projects/-Users-acme" } },
    });
    expect(red.events[1]).toContain("[REDACTED:");
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/evidence unavailable/);
  });

  it("a passing evidence line never carries a redaction token", async () => {
    const { v } = await assertFrom(custom, "deploy AcmeCorp now", "ok", { tool_called: { tool: "Bash", input: { command: "^deploy" } } });
    expect(v.pass).toBe(true);
    expect(v.evidence ?? "").not.toContain("[REDACTED:");
  });
});

describe("record-time guard: the common hostloop case", () => {
  // A host path in every command is redacted, so a negative check whose regex has nothing to do with the
  // path (`git\s+push`) still becomes evidence-unavailable on replay. The guard must SAY so — before, it
  // returned [] and the generic verdict-divergence refusal was all the author saw.
  it("names the tokened candidate and the fix options", () => {
    const neg = { tool_not_called: { tool: "Bash", input: { command: "git\\s+push" } } };
    const base = { ...cassette([neg]), events: streamWith("cd /Users/acme/proj/mnt/outputs && git status", "ok") } as Cassette;
    const findings = redactionRewroteNegativeToolInputs(base, redactCassette(base, POLICY));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/Bash call.*carr(y|ies) a redaction token in `command`/);
    expect(findings[0]).toMatch(/evidence-unavailable/);
    expect(findings[0]).toMatch(/scope/);
    expect(findings[0]).toMatch(/string form/);
    expect(findings[0]).toMatch(/live/);
  });

  it("covers a negative result.matches over a redacted result", () => {
    const neg = { tool_not_called: { tool: "Bash", result: { matches: "FATAL" } } };
    const base = { ...cassette([neg]), events: streamWith("ls", "listing /Users/acme/proj/mnt/outputs") } as Cassette;
    const findings = redactionRewroteNegativeToolInputs(base, redactCassette(base, POLICY));
    expect(findings.join("\n")).toMatch(/redaction token in the paired result/);
  });
});

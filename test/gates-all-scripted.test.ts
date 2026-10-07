// `gates_all_scripted`: every gate that fired was answered by a scripted rule — not the LLM decider, `first`, an
// external/human decider, or a permissive cowork-parity auto-allow. The decision streams below are copied from
// kept run dirs (test/fixtures/gates-all-scripted/kept-run-decisions.json), not composed for the test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkGatesAllScripted, type GateEvidence } from "../src/gates-scripted.js";
import type { AnswerRule, RunResult } from "../src/types.js";

type Decisions = RunResult["decisions"];
const KEPT = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "gates-all-scripted", "kept-run-decisions.json"), "utf8"),
) as Record<string, { decisions: Decisions }>;
const decisionsOf = (k: string): Decisions => structuredClone(KEPT[k]!.decisions);

/** The sub-question labels the run recorded as asked (`RunRecord.questions`): one per sub-question of every gate. */
const askedOf = (ds: Decisions): string[] =>
  ds
    .filter((d) => d.kind === "question")
    .flatMap((d) => d.questions?.map((q) => q.question || q.header || "") ?? Object.keys((d.detail ?? {}) as object));

const live = (ds: Decisions | undefined, over: Partial<GateEvidence> = {}): GateEvidence => ({
  decisions: ds,
  questions: ds ? askedOf(ds) : [],
  ...over,
});

/** What the replay re-drive records for the same stream: every answer comes back `by: "replay"`, with no rationale. */
const asReplayed = (ds: Decisions): Decisions => ds.map(({ rationale: _r, model: _m, ...d }) => ({ ...d, by: "replay" }));

// examples/scenarios/protocol-smoke.yaml's `answers:` — the run the "scripted-question-and-permission" stream came from.
const PROTOCOL_SMOKE_ANSWERS: AnswerRule[] = [
  { when_question: ".*", choose: "first" },
  { when_tool: "Write", decide: "allow" },
  { when_tool: "Bash", decide: "deny" },
];

describe("gates_all_scripted over kept-run decision streams (live)", () => {
  it("a run whose only gate was answered by a scripted rule passes", () => {
    const r = checkGatesAllScripted(true, live(decisionsOf("scripted-question")));
    expect(r.pass).toBe(true);
    expect(r.message).toMatch(/1 question gate/);
  });

  it("an LLM-answered gate fails, and the failure names that gate and who answered it", () => {
    const r = checkGatesAllScripted(true, live(decisionsOf("llm-question")));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("How should the skill handle big CSVs and messy data?");
    expect(r.message).toMatch(/\bllm\b/);
    expect(r.message).not.toMatch(/evidence unavailable/);
  });

  it("a `first`-answered gate fails even beside a scripted one, naming only the `first` gate", () => {
    const r = checkGatesAllScripted(true, live(decisionsOf("first-then-scripted")));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("Is this a flip-focused engagement");
    expect(r.message).toMatch(/\bfirst\b/);
    expect(r.message).not.toContain("Series A term sheet");
  });

  it("question gates only by default: a run with no question gate passes even with a permissive tool allow", () => {
    const r = checkGatesAllScripted(true, live(decisionsOf("cowork-permissive-allow")));
    expect(r.pass).toBe(true);
    expect(r.message).toMatch(/no question gate/);
  });

  it("include_permissions: a permissive cowork-parity auto-allow is not scripted, and is named", () => {
    const r = checkGatesAllScripted({ include_permissions: true }, live(decisionsOf("cowork-permissive-allow")));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("Bash");
    expect(r.message).toMatch(/permissive/);
  });

  it("include_permissions: scripted question + scripted permission passes", () => {
    const r = checkGatesAllScripted({ include_permissions: true }, live(decisionsOf("scripted-question-and-permission")));
    expect(r.pass).toBe(true);
  });

  it("include_permissions: a registry allow and a strict-parity deny are fixed rules and count as scripted", () => {
    const ds: Decisions = [
      { kind: "tool", name: "Read", decision: "allow", by: "cowork", rationale: "default-allow built-in" },
      { kind: "tool", name: "Bash", decision: "deny", by: "strict", rationale: "deny (strict parity)" },
    ];
    expect(checkGatesAllScripted({ include_permissions: true }, live(ds)).pass).toBe(true);
  });

  it("include_permissions: an agent error row is not a permission gate", () => {
    const ds = decisionsOf("scripted-question-and-permission");
    ds.push({ kind: "tool", name: "exit", decision: "error", by: "agent", detail: "exited 1" });
    const r = checkGatesAllScripted({ include_permissions: true }, live(ds));
    expect(r.pass).toBe(true);
    expect(r.message).toMatch(/, 1 permission decision\(s\)/); // the Write allow only, not the error row
  });

  it("an LLM-answered permission fails under include_permissions but not in the question-only form", () => {
    const ds = decisionsOf("scripted-question-and-permission");
    ds[1] = { ...ds[1]!, by: "llm" };
    expect(checkGatesAllScripted(true, live(ds)).pass).toBe(true);
    const r = checkGatesAllScripted({ include_permissions: true }, live(ds));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("Write");
  });
});

describe("gates_all_scripted never passes on missing evidence", () => {
  it("a result with no decisions channel (an older result.json) is evidence-unavailable", () => {
    const r = checkGatesAllScripted(true, live(undefined));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable/);
  });

  it("a question decision with no `by` is evidence-unavailable", () => {
    const ds = decisionsOf("scripted-question");
    delete ds[0]!.by;
    const r = checkGatesAllScripted(true, live(ds));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable/);
  });

  it("an unknown `by` is evidence-unavailable, not scripted", () => {
    const ds = decisionsOf("scripted-question");
    ds[0]!.by = "someday";
    expect(checkGatesAllScripted(true, live(ds)).message).toMatch(/^evidence unavailable/);
  });

  it("a gate that was asked but has no recorded answer fails, naming it — it is not a zero-gate run", () => {
    const r = checkGatesAllScripted(true, live([], { questions: ["Which plan?"] }));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("Which plan?");
  });

  it("a lane that could not read the asked questions is evidence-unavailable", () => {
    const r = checkGatesAllScripted(true, live(decisionsOf("scripted-question"), { questionsMissing: true }));
    expect(r.message).toMatch(/^evidence unavailable/);
  });
});

describe("gates_all_scripted on replay: re-classified against the cassette's frozen answers", () => {
  it("a replayed gate the frozen rules cover is scripted", () => {
    const ds = asReplayed(decisionsOf("scripted-question-and-permission"));
    const r = checkGatesAllScripted({ include_permissions: true }, live(ds, { frozenAnswers: PROTOCOL_SMOKE_ANSWERS }));
    expect(r.pass).toBe(true);
  });

  it("a replayed gate no frozen rule covers fails, naming the gate", () => {
    const ds = asReplayed(decisionsOf("llm-question"));
    const r = checkGatesAllScripted(true, live(ds, { frozenAnswers: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("How should the skill handle big CSVs and messy data?");
  });

  it("a replayed gate the frozen rules cover only PART of fails (the whole batch went to the fallback live)", () => {
    const ds = asReplayed(decisionsOf("llm-question"));
    const r = checkGatesAllScripted(
      true,
      live(ds, { frozenAnswers: [{ when_question: "big CSVs", choose: "Minimal instructions only" }] }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toContain("Any output preferences for the markdown tables?");
  });

  it("a replayed `by` with no frozen answers to classify against is evidence-unavailable", () => {
    const r = checkGatesAllScripted(true, live(asReplayed(decisionsOf("scripted-question"))));
    expect(r.message).toMatch(/^evidence unavailable/);
  });

  it("include_permissions on replay: an off-registry allow no frozen rule covers is the permissive auto-allow", () => {
    const ds = asReplayed(decisionsOf("cowork-permissive-allow"));
    const r = checkGatesAllScripted({ include_permissions: true }, live(ds, { frozenAnswers: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("Bash");
  });

  it("include_permissions live: the harness's own fixed denies count (a malformed web_fetch request, the fail-closed deny)", () => {
    const ds: Decisions = [
      { kind: "tool", name: "mcp__workspace__web_fetch", decision: "deny", by: "agent" },
      { kind: "tool", name: "Bash", decision: "abstain→deny", by: "none", requestId: "r1" },
    ];
    const r = checkGatesAllScripted({ include_permissions: true }, live(ds));
    expect(r.pass, r.message).toBe(true);
  });

  it("include_permissions live: a parity default with a rationale this build does not know is evidence-unavailable", () => {
    const ds: Decisions = [{ kind: "tool", name: "Bash", decision: "allow", by: "cowork", rationale: "something new" }];
    expect(checkGatesAllScripted({ include_permissions: true }, live(ds)).message).toMatch(/^evidence unavailable/);
  });

  // The hostloop web_fetch gate records whatever answered its `webfetch:<domain>` request, with no rationale
  // (run.ts resolveWebFetchGate). The parity default abstains on that request (decider.ts PermissionDefaultDecider),
  // so the answer comes from a scripted rule or the terminal decider.
  it("include_permissions live: an LLM-decided web_fetch deny with no rationale is not scripted", () => {
    const ds: Decisions = [{ kind: "tool", name: "mcp__workspace__web_fetch", decision: "deny", by: "llm" }];
    const r = checkGatesAllScripted({ include_permissions: true }, live(ds));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("answered by llm");
  });

  it("include_permissions live: a parity-attributed web_fetch row with no rationale is evidence-unavailable, never a pass", () => {
    // No producer writes this row; if one ever does, nothing on it says which rule answered.
    for (const [by, decision] of [
      ["strict", "deny"],
      ["cowork", "allow"],
    ] as const) {
      const ds: Decisions = [{ kind: "tool", name: "mcp__workspace__web_fetch", decision, by }];
      expect(checkGatesAllScripted({ include_permissions: true }, live(ds)).message).toMatch(/^evidence unavailable/);
    }
  });

  it("include_permissions on replay: an off-registry deny no frozen rule covers is a fixed rule (strict parity, the path gate)", () => {
    const ds: Decisions = [{ kind: "tool", name: "Bash", decision: "deny", by: "replay" }];
    expect(checkGatesAllScripted({ include_permissions: true }, live(ds, { frozenAnswers: [] })).pass).toBe(true);
  });

  it("include_permissions on replay: a registry allow (Read/Glob/Grep) counts", () => {
    const ds: Decisions = [{ kind: "tool", name: "Read", decision: "allow", by: "replay" }];
    expect(checkGatesAllScripted({ include_permissions: true }, live(ds, { frozenAnswers: [] })).pass).toBe(true);
  });

  // The hostloop web_fetch gate records its one decision under the can_use_tool name (run.ts handleDecision), not
  // the synthetic `webfetch:<domain>` request its decider saw.
  it("include_permissions on replay: a web_fetch permission cannot be attributed and is evidence-unavailable", () => {
    const ds: Decisions = [{ kind: "tool", name: "mcp__workspace__web_fetch", decision: "allow", by: "replay" }];
    expect(checkGatesAllScripted({ include_permissions: true }, live(ds, { frozenAnswers: [] })).message).toMatch(/^evidence unavailable/);
  });

  it("include_permissions on replay: a when_tool rule naming web_fetch does not attribute it (live, that rule never fires)", () => {
    // Live, the web_fetch gate's decider is asked about `webfetch:<domain>`, so a rule for the tool name never
    // answers it; replay must not read the rule's presence as who answered.
    const ds: Decisions = [{ kind: "tool", name: "mcp__workspace__web_fetch", decision: "allow", by: "replay" }];
    const r = checkGatesAllScripted(
      { include_permissions: true },
      live(ds, { frozenAnswers: [{ when_tool: "mcp__workspace__web_fetch", decide: "allow" }] }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable/);
  });

  it("include_permissions on replay: a permission the recording never answered (by: none) is evidence-unavailable, not a fixed rule", () => {
    // Replay abstains when the cassette holds no answer for a request; run.ts records that as abstain→deny by none.
    const ds: Decisions = [{ kind: "tool", name: "Bash", decision: "abstain→deny", by: "none", requestId: "r1" }];
    const r = checkGatesAllScripted({ include_permissions: true }, live(ds, { frozenAnswers: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable/);
  });

  it("on replay, frozen answers carrying a redaction token cannot classify a gate (a redacted pattern no longer means what it did)", () => {
    // `[REDACTED:label:hash]` read as a regex is a character class that matches nearly any question.
    const r = checkGatesAllScripted(
      true,
      live(asReplayed(decisionsOf("llm-question")), {
        frozenAnswers: [{ when_question: "[REDACTED:customer:ab12cd34ef56]", choose: "first" }],
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable/);
    expect(r.message).toContain("redact");
  });

  it("on replay, a cassette that records a live decider answering, whose frozen rules nonetheless cover every gate, is evidence-unavailable", () => {
    // authoring.nonDeterministic says an llm/external/human/first answer happened at record time; frozen rules that
    // cover every gate contradict it, so they are not the rules that answered.
    const r = checkGatesAllScripted(
      { include_permissions: true },
      live(asReplayed(decisionsOf("scripted-question-and-permission")), {
        frozenAnswers: PROTOCOL_SMOKE_ANSWERS,
        recordedNonDeterministic: true,
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable/);
  });

  it("on replay, a non-deterministic recording whose frozen rules miss a gate still names that gate", () => {
    const r = checkGatesAllScripted(
      true,
      live(asReplayed(decisionsOf("llm-question")), { frozenAnswers: [], recordedNonDeterministic: true }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toContain("How should the skill handle big CSVs and messy data?");
  });

  it("each kept stream gets the same verdict live and replayed against its run's rules", () => {
    const cases: Array<[string, AnswerRule[]]> = [
      ["scripted-question-and-permission", PROTOCOL_SMOKE_ANSWERS],
      ["llm-question", []],
      ["cowork-permissive-allow", []],
    ];
    for (const [k, rules] of cases)
      for (const opt of [true, { include_permissions: true }] as const) {
        const liveR = checkGatesAllScripted(opt, live(decisionsOf(k)));
        const replayR = checkGatesAllScripted(opt, live(asReplayed(decisionsOf(k)), { frozenAnswers: rules }));
        expect({ k, opt, pass: replayR.pass }).toEqual({ k, opt, pass: liveR.pass });
      }
  });
});

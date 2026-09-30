import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { slashCommandSkillInvocation, slashInvokedSkillIds } from "../src/critique/skill-invocation.js";
import { assertContextFromRunDir } from "../src/run/verify-context.js";
import { replayCassette } from "../src/run/cassette.js";
import { runProvenance, formatProvenanceLine } from "../src/run/provenance.js";
import type { RunResult, Scenario } from "../src/types.js";

// A slash-command prompt (`/<skill> …` or `/<plugin>:<skill> …`) makes the agent binary expand the skill
// itself — no `Skill` tool_use is ever emitted, and a `context: fork` skill forks directly. The fixtures are
// three REAL hostloop runs of the same `context: fork` plugin skill (agent 2.1.284), cut down to the fields
// these checks read and scrubbed of host paths and ids:
//   s1 — `/claude-code-internals <question>`                         (bare slash; the skill ran)
//   s2 — `/claude-code-internals:claude-code-internals <question>`   (qualified slash; the skill ran)
//   s3 — a plain question; the model invoked the skill through the `Skill` tool (the control)
// In s1/s2 the record carries `skillsInvoked: []` and `models: ["<synthetic>"]` although the skill ran.

interface Fixture {
  result: {
    scenario: string;
    prompt: string;
    result: "success" | "error";
    skillsInvoked: string[];
    skillToolAvailable: boolean;
    models: string[];
    modelUsage: Record<string, unknown>;
    subagents: unknown[];
    toolCounts: Record<string, number>;
    context: { availableSkills: Array<{ id: string }> };
  };
  events: unknown[];
}
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", "slash-skill-invocation", `${name}.json`), "utf8")) as Fixture;
const S1 = load("s1-bare-slash");
const S2 = load("s2-qualified-slash");
const S3 = load("s3-no-slash");
const QUALIFIED = "claude-code-internals:claude-code-internals";

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    mountDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    slashInvokedSkills: [],
    skillToolAvailable: true,
    ...over,
  };
}
/** The ctx a lane builds from one fixture: the record's own fields, plus the slash channel derived from the
 *  turn's prompt and the init frame's skill inventory. */
const ctxOf = (f: Fixture) =>
  ctx({
    skillsInvoked: f.result.skillsInvoked,
    skillToolAvailable: f.result.skillToolAvailable,
    availableSkills: f.result.context.availableSkills,
    slashInvokedSkills: slashInvokedSkillIds(f.result.prompt, f.result.context.availableSkills),
  });
const only = (r: ReturnType<typeof evaluate>) => {
  expect(r).toHaveLength(1);
  return r[0];
};
const evidenceUnavailable = (m: string | undefined) => /^evidence unavailable/.test(m ?? "");

describe("slashCommandSkillInvocation — a prompt with no leading slash is a real negative", () => {
  it("is `none` even when the inventory is absent (nothing to expand, so nothing to resolve)", () => {
    expect(slashCommandSkillInvocation("What determines which files are displayed?", undefined)).toEqual({ kind: "none" });
  });
  it("still `unobservable` for a slash prompt with no inventory, and for an absent prompt", () => {
    expect(slashCommandSkillInvocation("/claude-code-internals x", undefined)).toEqual({ kind: "unobservable" });
    expect(slashCommandSkillInvocation(undefined, undefined)).toEqual({ kind: "unobservable" });
  });
});

describe("slashInvokedSkillIds — the detector's tri-state as a record field", () => {
  it("resolves the real s1 (bare) and s2 (qualified) prompts to the staged skill; s3 to none", () => {
    expect(slashInvokedSkillIds(S1.result.prompt, S1.result.context.availableSkills)).toEqual([QUALIFIED]);
    expect(slashInvokedSkillIds(S2.result.prompt, S2.result.context.availableSkills)).toEqual([QUALIFIED]);
    expect(slashInvokedSkillIds(S3.result.prompt, S3.result.context.availableSkills)).toEqual([]);
  });
  it("is undefined (cannot tell) for an ambiguous bare name or a slash prompt with no inventory", () => {
    const two = [{ id: "a:claude-code-internals" }, { id: "b:claude-code-internals" }];
    expect(slashInvokedSkillIds(S1.result.prompt, two)).toBeUndefined();
    expect(slashInvokedSkillIds(S1.result.prompt, undefined)).toBeUndefined();
  });
});

describe("skill_triggered / no_skill_triggered count a slash-invoked skill", () => {
  it("s1 (bare slash): skill_triggered PASSES though no Skill tool_use was recorded", () => {
    const r = only(evaluate([{ skill_triggered: "claude-code-internals" }], ctxOf(S1)));
    expect(r.message).toBeUndefined();
    expect(r.pass).toBe(true);
  });
  it("s2 (qualified slash): skill_triggered PASSES", () => {
    expect(only(evaluate([{ skill_triggered: "claude-code-internals" }], ctxOf(S2))).pass).toBe(true);
  });
  it("s1: no_skill_triggered FAILS — the skill ran, so a negative control must not go green", () => {
    const r = only(evaluate([{ no_skill_triggered: "claude-code-internals" }], ctxOf(S1)));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/slash command/);
    expect(evidenceUnavailable(r.message)).toBe(false);
  });
  it("s3 (control, Skill tool): skill_triggered passes, and an unrelated no_skill_triggered passes", () => {
    expect(only(evaluate([{ skill_triggered: "claude-code-internals" }], ctxOf(S3))).pass).toBe(true);
    expect(only(evaluate([{ no_skill_triggered: "deep-research" }], ctxOf(S3))).pass).toBe(true);
  });
  it("s1 with no skill staged under that name is a real negative both ways", () => {
    const c = ctxOf(S1);
    expect(only(evaluate([{ skill_triggered: "deep-research" }], c)).pass).toBe(false);
    expect(evidenceUnavailable(only(evaluate([{ skill_triggered: "deep-research" }], c)).message)).toBe(false);
    expect(only(evaluate([{ no_skill_triggered: "deep-research" }], c)).pass).toBe(true);
  });
  it("an unobservable slash channel (ambiguous bare name) is evidence-unavailable for BOTH keys", () => {
    const c = ctx({ skillsInvoked: [], slashInvokedSkills: undefined });
    const pos = only(evaluate([{ skill_triggered: "claude-code-internals" }], c));
    const neg = only(evaluate([{ no_skill_triggered: "claude-code-internals" }], c));
    expect(pos.pass).toBe(false);
    expect(evidenceUnavailable(pos.message)).toBe(true);
    expect(neg.pass).toBe(false);
    expect(evidenceUnavailable(neg.message)).toBe(true);
  });
  it("a Skill-tool match still decides skill_triggered when the slash channel is unobservable", () => {
    const c = ctx({ skillsInvoked: ["claude-code-internals"], slashInvokedSkills: undefined });
    expect(only(evaluate([{ skill_triggered: "claude-code-internals" }], c)).pass).toBe(true);
    expect(only(evaluate([{ no_skill_triggered: "claude-code-internals" }], c)).pass).toBe(false);
  });
});

describe("an anchored bare regex matches the slash channel the way it matches a bare Skill call", () => {
  // The slash channel records the inventory's QUALIFIED id; the Skill-tool channel records what the model
  // passed, often bare (s3: `skill: "claude-code-internals"`). A regex written against the bare name must
  // see the slash invocation too, or `no_skill_triggered: '^name$'` passes on a run where the skill ran.
  it("no_skill_triggered: '^claude-code-internals$' FAILS on s1", () => {
    expect(only(evaluate([{ no_skill_triggered: "^claude-code-internals$" }], ctxOf(S1))).pass).toBe(false);
  });
  it("skill_triggered: '^claude-code-internals$' PASSES on s1 and s2", () => {
    expect(only(evaluate([{ skill_triggered: "^claude-code-internals$" }], ctxOf(S1))).pass).toBe(true);
    expect(only(evaluate([{ skill_triggered: "^claude-code-internals$" }], ctxOf(S2))).pass).toBe(true);
  });
  it("the qualified form still matches, and an unrelated anchored name still does not", () => {
    expect(only(evaluate([{ skill_triggered: "^claude-code-internals:claude-code-internals$" }], ctxOf(S1))).pass).toBe(true);
    expect(only(evaluate([{ no_skill_triggered: "^deep-research$" }], ctxOf(S1))).pass).toBe(true);
  });
  it("the skill_triggered FAIL message names the slash channel too", () => {
    const r = only(evaluate([{ skill_triggered: "^deep-research$" }], ctxOf(S1)));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("claude-code-internals:claude-code-internals");
  });
});

describe("a slash command the binary REFUSED is not an invocation", () => {
  // Agent 2.1.284 refuses a resolved slash command in two ways, and answers with one of these texts
  // (copied verbatim from the binary's strings; no kept run exhibits either, so these frames are built):
  //   userInvocable === false → `This skill can only be invoked by Claude, not directly by users. Ask
  //                             Claude to use the "<name>" skill for you.`
  //   an unresolvable name    → `Unknown command: /<name>`
  const INV = S1.result.context.availableSkills;
  const NOT_USER_INVOCABLE =
    'This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "claude-code-internals" skill for you.';
  it("the not-user-invocable refusal in the run's text demotes the channel to []", () => {
    expect(slashInvokedSkillIds(S1.result.prompt, INV, [NOT_USER_INVOCABLE, ""])).toEqual([]);
  });
  it("`Unknown command: /<token>` demotes it too", () => {
    expect(slashInvokedSkillIds(S1.result.prompt, INV, [undefined, "Unknown command: /claude-code-internals"])).toEqual([]);
  });
  it("an Unknown-command line for a DIFFERENT token does not", () => {
    expect(slashInvokedSkillIds(S1.result.prompt, INV, ["Unknown command: /other"])).toEqual([QUALIFIED]);
  });
  it("the real s1 answer text does not demote", () => {
    const answer = (S1.events.find((e: any) => e.type === "result") as { result: string }).result;
    expect(slashInvokedSkillIds(S1.result.prompt, INV, [answer, answer])).toEqual([QUALIFIED]);
  });
  it("end to end on replay: a refused slash is a real negative, so no_skill_triggered passes", async () => {
    const saved = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const events = [
        S1.events[0],
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: NOT_USER_INVOCABLE }] },
        },
        { type: "result", subtype: "success", is_error: false, num_turns: 0, result: NOT_USER_INVOCABLE },
      ];
      const cassette: any = {
        scenario: {
          name: "refused",
          baseline: "latest",
          session: "(inline)",
          fidelity: "hostloop",
          prompt: S1.result.prompt,
          answers: [],
          expect_denied: [],
          assert: [{ no_skill_triggered: "claude-code-internals" }],
        },
        events: events.map((e) => JSON.stringify(e)),
        controlOut: [],
      };
      const r = await replayCassette(cassette);
      expect(r.slashInvokedSkills).toEqual([]);
      expect(r.assertions.every((a) => a.pass)).toBe(true);
    } finally {
      process.stderr.write = saved;
    }
  });
});

describe("verify-run over a kept run dir recovers the slash channel from result.json", () => {
  const scenario = (assert: unknown[]): Scenario =>
    ({
      name: "s1",
      baseline: "latest",
      session: "(inline)",
      fidelity: "hostloop",
      prompt: S1.result.prompt,
      answers: [],
      expect_denied: [],
      assert,
    }) as unknown as Scenario;
  const keptDir = (result: Record<string, unknown>) => {
    const runDir = mkdtempSync(join(tmpdir(), "cwh-slash-"));
    mkdirSync(join(runDir, "turns", "1"), { recursive: true });
    writeFileSync(join(runDir, "turns", "1", "result.json"), JSON.stringify(result));
    return runDir;
  };
  it("a result.json written before the field existed: skill_triggered passes, no_skill_triggered fails", () => {
    const dir = keptDir(S1.result); // the real record: no slashInvokedSkills key
    const pos = assertContextFromRunDir(dir, scenario([{ skill_triggered: "claude-code-internals" }]));
    expect(pos.ok).toBe(true);
    if (!pos.ok) return;
    expect(pos.ctx.slashInvokedSkills).toEqual([QUALIFIED]);
    expect(only(evaluate([{ skill_triggered: "claude-code-internals" }], pos.ctx)).pass).toBe(true);
    expect(only(evaluate([{ no_skill_triggered: "claude-code-internals" }], pos.ctx)).pass).toBe(false);
  });
  it("a persisted field is read, not re-derived", () => {
    const dir = keptDir({ ...S3.result, slashInvokedSkills: [] });
    const r = assertContextFromRunDir(dir, scenario([{ skill_triggered: "x" }]));
    expect(r.ok && r.ctx.slashInvokedSkills).toEqual([]);
  });
});

describe("replay yields the same slash channel the live lane computes", () => {
  let saved: typeof process.stderr.write | undefined;
  afterEach(() => {
    if (saved) process.stderr.write = saved;
    saved = undefined;
  });
  const mute = () => {
    saved = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  };
  const cassetteOf = (f: Fixture, assert: unknown[]): any => ({
    scenario: {
      name: f.result.scenario,
      baseline: "latest",
      session: "(inline)",
      fidelity: "hostloop",
      prompt: f.result.prompt,
      answers: [],
      expect_denied: [],
      assert,
    },
    events: f.events.map((e) => JSON.stringify(e)),
    controlOut: [],
  });
  it("s1: RunResult.slashInvokedSkills is the staged id, and skill_triggered passes on replay", async () => {
    mute();
    const r = await replayCassette(cassetteOf(S1, [{ skill_triggered: "claude-code-internals" }]));
    expect(r.slashInvokedSkills).toEqual(slashInvokedSkillIds(S1.result.prompt, S1.result.context.availableSkills));
    expect(r.slashInvokedSkills).toEqual([QUALIFIED]);
    expect(r.skillsInvoked).toEqual([]);
    expect(r.assertions.every((a) => a.pass)).toBe(true);
  });
  it("s3: the Skill-tool control replays with an empty slash channel", async () => {
    mute();
    const r = await replayCassette(cassetteOf(S3, [{ skill_triggered: "claude-code-internals" }]));
    expect(r.slashInvokedSkills).toEqual([]);
    expect(r.skillsInvoked).toEqual(["claude-code-internals"]);
    expect(r.assertions.every((a) => a.pass)).toBe(true);
  });
});

describe("provenance banner", () => {
  const rr = (f: Fixture, over: Partial<RunResult> = {}) =>
    ({
      ...f.result,
      slashInvokedSkills: slashInvokedSkillIds(f.result.prompt, f.result.context.availableSkills),
      ...over,
    }) as unknown as RunResult;
  it("s1: the skill is shown invoked by slash, never offered,NOT-invoked", () => {
    expect(runProvenance(rr(S1)).skill).toBe("offered,invoked(slash)");
  });
  it("s3: an ordinary Skill-tool invocation stays offered,invoked", () => {
    expect(runProvenance(rr(S3)).skill).toBe("offered,invoked");
  });
  it("an old record with no field recomputes from prompt + inventory (no-slash prompt stays NOT-invoked)", () => {
    const old = { ...S3.result, skillsInvoked: [] } as unknown as RunResult;
    expect(runProvenance(old).skill).toBe("offered,NOT-invoked");
    expect(runProvenance(S1.result as unknown as RunResult).skill).toBe("offered,invoked(slash)");
  });
  it("a chat records only its seed prompt, so its slash channel is never re-derived from it", () => {
    const chat = { ...S3.result, mode: "chat", skillsInvoked: [] } as unknown as RunResult;
    expect(runProvenance(chat).skill).toBe("offered,unknown");
  });
  it("an unobservable slash channel is offered,unknown, never NOT-invoked", () => {
    expect(runProvenance(rr(S1, { slashInvokedSkills: undefined, prompt: undefined })).skill).toBe("offered,unknown");
  });
  it("s1: JSON model stays unknown; the banner names the non-main-loop model usage it can see", () => {
    expect(runProvenance(rr(S1)).model).toBe("unknown");
    expect(formatProvenanceLine(rr(S1))).toBe(
      "[provenance] model=unknown (main loop synthetic; modelUsage: claude-sonnet-5)  skill=offered,invoked(slash)  ablated=false",
    );
  });
  it("s3: a real main-loop model prints plainly", () => {
    expect(formatProvenanceLine(rr(S3))).toBe("[provenance] model=claude-sonnet-5  skill=offered,invoked  ablated=false");
  });
});

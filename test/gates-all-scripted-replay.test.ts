// gates_all_scripted: the replay verdict equals the live one. Each case freezes a kept run's real gate frames (its
// can_use_tool requests and the answers the harness sent, test/fixtures/gates-all-scripted/<case>/) into a cassette
// with the run's own `answers:`, replays it, and compares against the verdict over that run's live decisions.
import { describe, it, expect, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeRecordedRun, readCassette, replayCassette } from "../src/run/cassette.js";
import { checkGatesAllScripted } from "../src/gates-scripted.js";
import { ScenarioObject, type Assertion, type RunResult, type Scenario } from "../src/types.js";

const FIX = join(import.meta.dirname, "fixtures", "gates-all-scripted");
const KEPT = JSON.parse(readFileSync(join(FIX, "kept-run-decisions.json"), "utf8")) as Record<
  string,
  { decisions: RunResult["decisions"] }
>;
const LIVE = "2.26454.0";

const FORMS: Assertion[] = [{ gates_all_scripted: true }, { gates_all_scripted: { include_permissions: true } }] as Assertion[];

const CASES = [
  {
    name: "scripted",
    kept: "scripted-question-and-permission", // protocol-smoke: a scripted question and a scripted Write allow
    answers: [
      { when_question: ".*", choose: "first" },
      { when_tool: "Write", decide: "allow" },
      { when_tool: "Bash", decide: "deny" },
    ],
    nonDeterministic: false,
  },
  { name: "llm", kept: "llm-question", answers: [], nonDeterministic: true }, // create-skill: one LLM-answered 3-question gate
];

async function replayed(c: (typeof CASES)[number], dropAnswerTo?: string): Promise<RunResult["assertions"]> {
  const outDir = mkdtempSync(join(tmpdir(), "gates-all-scripted-"));
  cpSync(join(FIX, c.name), outDir, { recursive: true });
  if (dropAnswerTo) {
    const co = join(outDir, "control-out.jsonl");
    const kept = readFileSync(co, "utf8")
      .split("\n")
      .filter((l) => l && !l.includes(dropAnswerTo));
    writeFileSync(co, kept.join("\n") + "\n");
  }
  const scenario = ScenarioObject.parse({
    name: `gates-all-scripted-${c.name}`,
    fidelity: "container",
    prompt: "hi",
    answers: c.answers,
    assert: FORMS,
  }) as unknown as Scenario;
  const result = {
    mode: "run",
    command: "record",
    scenario: scenario.name,
    prompt: scenario.prompt,
    fidelity: "container",
    effectiveFidelity: "container",
    result: "success",
    baseline: LIVE,
    outDir,
    userVisibleRoots: ["outputs"],
    fingerprint: { baseline: LIVE, hashFormat: "jcs1" },
    assertions: [],
    egress: [],
    nonDeterministic: c.nonDeterministic,
  } as unknown as RunResult;
  const cassettePath = join(outDir, "c.cassette.json");
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await freezeRecordedRun(scenario, { noRedact: true, allowFailing: true, cassettePath }, [], result);
    const r = readCassette(cassettePath);
    if ("error" in r) throw new Error(r.error);
    return (await replayCassette(r.cassette)).assertions.filter((a) => a.assertion.gates_all_scripted !== undefined);
  } finally {
    errSpy.mockRestore();
  }
}

describe("gates_all_scripted: replay agrees with live on real gate frames", () => {
  for (const c of CASES)
    it(`${c.name}: each form gets the live verdict on replay`, async () => {
      const decisions = KEPT[c.kept]!.decisions;
      const questions = decisions
        .filter((d) => d.kind === "question")
        .flatMap((d) => d.questions?.map((q) => q.question || q.header || "") ?? []);
      const rep = await replayed(c);
      expect(rep).toHaveLength(FORMS.length);
      FORMS.forEach((form, i) => {
        const live = checkGatesAllScripted(form.gates_all_scripted!, { decisions, questions });
        expect({ form: form.gates_all_scripted, pass: rep[i]!.pass }).toEqual({ form: form.gates_all_scripted, pass: live.pass });
      });
    });

  it("the LLM-answered gate is the predicted red on replay: it names the gate, not missing evidence", async () => {
    const [q] = await replayed(CASES[1]!);
    expect(q!.pass).toBe(false);
    expect(q!.message).toContain("How should the skill handle big CSVs and messy data?");
    expect(q!.message).not.toMatch(/evidence unavailable/);
  });

  it("a cassette stamped non-deterministic whose frozen rules cover every gate is evidence-unavailable, not a pass", async () => {
    // freezeRecordedRun writes authoring.nonDeterministic from the run; replay reads it back into the check.
    const [q] = await replayed({ ...CASES[0]!, nonDeterministic: true });
    expect(q!.pass).toBe(false);
    expect(q!.message).toMatch(/^evidence unavailable/);
  });

  it("a truncated recording (a gate with no recorded answer) is evidence-unavailable, never a zero-gate pass", async () => {
    const [q] = await replayed(CASES[0]!, "034e563d-8c67-4309-84df-2944d9a3ddb7"); // the question's request id
    expect(q!.pass).toBe(false);
    expect(q!.message).toMatch(/^evidence unavailable/);
  });
});

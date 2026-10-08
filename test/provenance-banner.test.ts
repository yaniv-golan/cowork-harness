import { describe, it, expect } from "vitest";
import { renderFooter, type RenderPlan } from "../src/run/renderer.js";
import { runProvenance, formatProvenanceLine } from "../src/run/provenance.js";
import { jsonEnvelope } from "../src/run/envelope.js";
import { buildRepeatRollup } from "../src/run/repeat.js";
import type { RunResult } from "../src/types.js";

// The provenance banner exists because three separate multi-run measurements were silently scoped to
// the WRONG THING, and in every case the run record already held the answer: a finding measured on
// claude-sonnet-5 because the session omitted `model:`; a 10-run "A/B" that was 10 control runs; an
// answer that read like skill output from a run where the skill was never invoked (the model read the
// mounted SKILL.md instead). `models`, `ablated`, `context.availableSkills` and `skillsInvoked` were
// all already in result.json — nowhere anyone looks. One printed line kills all three.
//
// The load-bearing rule, same as the guards roster: NEVER print a confident negative from a missing
// field. Absent evidence renders `unknown`, not `NOT-invoked`.

const plan = (over: Partial<RenderPlan> = {}): RenderPlan => ({
  live: true,
  progress: true,
  verbose: false,
  color: false,
  compact: false,
  ...over,
});

function sink() {
  const out: string[] = [];
  return { write: (s: string) => out.push(s), text: () => out.join("") };
}

const base: RunResult = {
  scenario: "s",
  fidelity: "container",
  baseline: "p",
  result: "success",
  decisions: [],
  egress: [],
  assertions: [{ assertion: {}, pass: true }],
  outDir: "runs/s/x",
} as unknown as RunResult;

const r = (over: Partial<RunResult>): RunResult => ({ ...base, ...over }) as RunResult;

describe("runProvenance — model", () => {
  it("a single pinned model", () => {
    expect(runProvenance(r({ models: ["claude-opus-5"] })).model).toBe("claude-opus-5");
  });

  // THE trap. `<synthetic>` is the agent's own constant for a LOCALLY fabricated turn (no API call) —
  // an agent marker, not a model id. An unfiltered join prints "claude-opus-5,<synthetic>" and reads
  // as a two-model run. scripts/eval-gate.ts already learned this the hard way.
  it("drops `<synthetic>` — and any other `<…>` agent marker — before display", () => {
    expect(runProvenance(r({ models: ["claude-opus-5", "<synthetic>"] })).model).toBe("claude-opus-5");
    expect(runProvenance(r({ models: ["<synthetic>", "claude-opus-5"] })).model).toBe("claude-opus-5");
  });

  it("a genuinely multi-model run still reports both", () => {
    expect(runProvenance(r({ models: ["claude-opus-5", "claude-haiku-4-5"] })).model).toBe("claude-opus-5,claude-haiku-4-5");
  });

  it("only markers, or no models at all, is `unknown` — never an empty value", () => {
    expect(runProvenance(r({ models: ["<synthetic>"] })).model).toBe("unknown");
    expect(runProvenance(r({ models: [] })).model).toBe("unknown");
    expect(runProvenance(r({})).model).toBe("unknown");
  });
});

describe("runProvenance — skill", () => {
  it("offered and invoked", () => {
    expect(runProvenance(r({ context: { availableSkills: [{ id: "p:s" }] }, skillsInvoked: ["p:s"] })).skill).toBe("offered,invoked");
  });

  // The exact failure that produced a believable-looking answer with an empty skillActivity: the skill
  // was mounted and offered, and the model read SKILL.md as a file instead of invoking it.
  it("offered and NOT invoked", () => {
    expect(runProvenance(r({ context: { availableSkills: [{ id: "p:s" }] }, skillsInvoked: [], slashInvokedSkills: [] })).skill).toBe(
      "offered,NOT-invoked",
    );
  });

  it("nothing offered — an ablated or skill-less run", () => {
    expect(runProvenance(r({ context: { availableSkills: [] }, skillsInvoked: [] })).skill).toBe("not-offered");
  });

  // Evidence-unavailable must NOT render as a negative. `skillsInvoked` is optional and absent on an
  // older result.json; `availableSkills` is absent when the inventory could not be read at all.
  it("offered, but invocation evidence absent ⇒ offered,unknown (never NOT-invoked)", () => {
    const p = runProvenance(r({ context: { availableSkills: [{ id: "p:s" }] } }));
    expect(p.skill).toBe("offered,unknown");
    expect(p.skill).not.toContain("NOT-invoked");
  });

  it("no inventory evidence at all ⇒ unknown", () => {
    expect(runProvenance(r({})).skill).toBe("unknown");
    expect(runProvenance(r({ context: {} })).skill).toBe("unknown");
  });
});

describe("runProvenance — ablated", () => {
  it("true when the run was ablated", () => {
    expect(runProvenance(r({ ablated: true })).ablated).toBe(true);
  });

  // Absent means "not ablated" for this field (see RunResult.ablated: "Absent/false on a normal run"),
  // and the banner's whole value is that the line is present on EVERY run — so false must print.
  it("false when absent — the field is opt-in on the record, not the banner", () => {
    expect(runProvenance(r({})).ablated).toBe(false);
    expect(formatProvenanceLine(r({}))).toContain("ablated=false");
  });
});

describe("formatProvenanceLine", () => {
  it("renders all three fields on one line", () => {
    const line = formatProvenanceLine(
      r({
        models: ["claude-sonnet-5"],
        context: { availableSkills: [{ id: "p:s" }] },
        skillsInvoked: [],
        slashInvokedSkills: [],
        ablated: false,
      }),
    );
    expect(line).toBe("[provenance] model=claude-sonnet-5  skill=offered,NOT-invoked  ablated=false");
  });
});

describe("renderFooter — the banner is on every verdict", () => {
  const measured = r({
    models: ["claude-sonnet-5"],
    context: { availableSkills: [{ id: "p:s" }] },
    skillsInvoked: [],
    slashInvokedSkills: [],
  });

  it("prints on a PASSING run", () => {
    const s = sink();
    renderFooter(measured, plan(), { write: s.write });
    expect(s.text()).toContain("[provenance] model=claude-sonnet-5  skill=offered,NOT-invoked  ablated=false");
  });

  // A failing run is arguably the more important one: "why did this fail" is often "it ran the wrong thing".
  it("prints on a FAILING run", () => {
    const s = sink();
    renderFooter({ ...measured, assertions: [{ assertion: { tool_called: "Bash" }, pass: false, message: "no" }] } as RunResult, plan(), {
      write: s.write,
    });
    expect(s.text()).toContain("[provenance]");
    expect(s.text()).toContain("skill=offered,NOT-invoked");
  });

  // Replay's provenance is the RECORDED run's, which is exactly what a replay consumer needs to know.
  // Contrast `cost`, which IS suppressed on replay because printing it would misreport fresh spend —
  // provenance has no such hazard.
  it("prints on the replay lane", () => {
    const s = sink();
    renderFooter(measured, plan(), { write: s.write, lane: "replay" });
    expect(s.text()).toContain("[provenance]");
  });

  // Same suppression contract as the `[status]` line, so shareable screenshots/GIFs stay clean.
  it("is suppressed by --compact (and therefore --demo, which implies it)", () => {
    const s = sink();
    renderFooter(measured, plan({ compact: true }), { write: s.write });
    expect(s.text()).not.toContain("[provenance]");
  });

  it("an ablated run says so on the line", () => {
    const s = sink();
    renderFooter(r({ models: ["claude-opus-5"], context: { availableSkills: [] }, skillsInvoked: [], ablated: true }), plan(), {
      write: s.write,
    });
    expect(s.text()).toContain("ablated=true");
    expect(s.text()).toContain("skill=not-offered");
  });
});

describe("provenance in the JSON envelope", () => {
  it("each result carries a derived `provenance` object beside `verdict`", () => {
    const env = JSON.parse(
      jsonEnvelope("run", [
        r({ models: ["claude-opus-5", "<synthetic>"], context: { availableSkills: [{ id: "p:s" }] }, skillsInvoked: ["p:s"] }),
      ]),
    );
    expect(env.results[0].provenance).toEqual({ model: "claude-opus-5", skill: "offered,invoked", ablated: false });
  });

  // The whole point of publishing the DERIVED object rather than leaving consumers to read the raw
  // fields: the `<synthetic>` filter and the four-state skill machine are applied once, here.
  it("the envelope's model is already marker-filtered — a consumer never re-derives it", () => {
    const env = JSON.parse(jsonEnvelope("run", [r({ models: ["<synthetic>"] })]));
    expect(env.results[0].provenance.model).toBe("unknown");
  });
});

describe("provenance on the --repeat rollup", () => {
  const batch = (over: Partial<RunResult>, n = 3) => Array.from({ length: n }, () => r(over));

  it("summarizes the batch: model, skill state, ablated count", () => {
    const roll = buildRepeatRollup(
      "s",
      3,
      batch({ models: ["claude-sonnet-5"], context: { availableSkills: [{ id: "p:s" }] }, skillsInvoked: [], slashInvokedSkills: [] }),
    );
    expect(roll.provenance).toEqual({ models: ["claude-sonnet-5"], skills: ["offered,NOT-invoked"], ablatedRuns: 0 });
  });

  // A batch that silently spans two models is the multi-run version of the single-run defect.
  it("a batch spanning two models reports BOTH — it must not collapse to the first", () => {
    const roll = buildRepeatRollup("s", 2, [r({ models: ["claude-opus-5"] }), r({ models: ["claude-sonnet-5"] })]);
    expect(roll.provenance.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("counts ablated runs", () => {
    const roll = buildRepeatRollup("s", 3, batch({ ablated: true, context: { availableSkills: [] }, skillsInvoked: [] }));
    expect(roll.provenance.ablatedRuns).toBe(3);
  });
});

describe("renderFooter — the no-answer-channel label", () => {
  it("names a headless run as not Cowork on the footer line, pass or fail", () => {
    const pass = sink();
    renderFooter(r({ answerChannel: "none" }), plan(), { write: pass.write });
    expect(pass.text()).toContain("[headless, no answer channel — not Cowork]");
    const fail = sink();
    renderFooter(r({ answerChannel: "none", result: "error" }), plan(), { write: fail.write });
    expect(fail.text()).toContain("[headless, no answer channel — not Cowork]");
  });
  it("prints nothing extra for a default-channel run", () => {
    const s = sink();
    renderFooter(r({}), plan(), { write: s.write });
    expect(s.text()).not.toContain("answer channel");
  });
});

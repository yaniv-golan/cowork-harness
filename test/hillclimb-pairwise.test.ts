// semantic_pairwise inside a hillclimb flow: the references a pass finds, the win columns a row carries, how
// they are declared, and that `hillclimb check` accepts a flow carrying them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFlowRefs, flowPairwiseOptions, metricRefNames, pairwiseRowValues } from "../src/hillclimb/pairwise.js";
import { caseKeyDecls, flowMetricDecls } from "../src/hillclimb/grade-keys.js";
import { presentCompanionOf } from "../src/hillclimb/present.js";
import { checkFlowSnapshot, loadFlowSnapshot, UNTRUSTED_JUDGE_PREFIX, type FlowSnapshot } from "../src/hillclimb/schema-check.js";
import { pairwiseHints, pairwiseRefFindings } from "../src/hillclimb/check.js";
import { stateTemplate } from "../src/hillclimb/state-template.js";
import type { Assertion, RunResult } from "../src/types.js";

type Entry = RunResult["assertions"][number];
type Outcome = NonNullable<Entry["pairwise"]>[number];

const PW = { semantic_pairwise: { rubric: ["r"] } } as unknown as Assertion;
const OTHER = { file_exists: "outputs/a.md" } as unknown as Assertion;
const entry = (assertion: Assertion, pairwise?: Outcome[], extra: Partial<Entry> = {}): Entry =>
  ({ assertion, pass: true, ...(pairwise ? { pairwise } : {}), ...extra }) as Entry;
const graded = (ref: string, outcome: "win" | "tie" | "loss" | "both_bad", rationale = "why"): Outcome => ({
  ref,
  status: "graded",
  outcome,
  value: outcome === "win" ? 1 : outcome === "loss" ? 0 : 0.5,
  rationale,
  ...(ref === "baseline" ? {} : { gate: false as const }),
});

describe("pairwiseRowValues", () => {
  const run = (entries: Entry[], assertions: Assertion[], metricRefs: string[] = [], agentFailed = false) =>
    pairwiseRowValues({ assertions, entries, metricRefs, agentFailed });

  it("win is the mean over the case's pairwise asserts vs the baseline; both_bad when any judged both bad", () => {
    const r = run([entry(OTHER), entry(PW, [graded("baseline", "win")]), entry(PW, [graded("baseline", "both_bad")])], [OTHER, PW, PW]);
    expect(r.grade).toEqual({
      win_present: 1,
      win: 0.75,
      a1_win_present: 1,
      a1_win: 1,
      a2_win_present: 1,
      a2_win: 0.5,
      both_bad: 1,
    });
    expect(r.explanation).toBe(`${UNTRUSTED_JUDGE_PREFIX}a1 win: why | a2 both_bad: why`);
  });

  it("a neutral baseline row is 0.5, carries no explanation, and both_bad 0", () => {
    const r = run([entry(PW, [{ ref: "baseline", status: "neutral", value: 0.5 }])], [PW]);
    expect(r.grade).toMatchObject({ win_present: 1, win: 0.5, both_bad: 0 });
    expect(r.explanation).toBeUndefined();
  });

  it.each([
    ["a missing baseline reference", { ref: "baseline", status: "missing", why: "absent" } as Outcome],
    ["a damaged one", { ref: "baseline", status: "integrity", why: "sha" } as Outcome],
  ])("%s omits win and both_bad, with win_present 0", (_n, o) => {
    const r = run([entry(PW, [o])], [PW]);
    expect(r.grade).toEqual({ win_present: 0, a0_win_present: 0 });
  });

  it("refused candidate evidence omits win", () => {
    const r = run([entry(PW, undefined, { semanticEvidence: { reason: "scope_matched_nothing", paths: [] } as never })], [PW]);
    expect(r.grade).toEqual({ win_present: 0, a0_win_present: 0 });
  });

  it("a later reference is its own column: unreadable, it blanks only win_<vN>", () => {
    const r = run([entry(PW, [graded("baseline", "win"), { ref: "v3", gate: false, status: "invalid", why: "garbled" }])], [PW], ["v3"]);
    expect(r.grade).toEqual({
      win_present: 1,
      win: 1,
      a0_win_present: 1,
      a0_win: 1,
      win_v3_present: 0,
      a0_win_v3_present: 0,
      both_bad: 0,
    });
  });

  it("an agent failure scores 0 everywhere, measured", () => {
    const r = run([entry(PW, undefined)], [PW], ["v3"], true);
    expect(r.grade).toEqual({
      win_present: 1,
      win: 0,
      a0_win_present: 1,
      a0_win: 0,
      win_v3_present: 1,
      win_v3: 0,
      a0_win_v3_present: 1,
      a0_win_v3: 0,
      both_bad: 0,
    });
    expect(r.explanation).toBeUndefined();
  });

  it("a case without a pairwise assert, in a flow with some, carries every companion as 0", () => {
    expect(run([entry(OTHER)], [OTHER], ["v3"]).grade).toEqual({ win_present: 0, win_v3_present: 0 });
  });
});

describe("declarations", () => {
  it("pass stays first (the headline); both_bad follows win; companions precede graded keys", () => {
    const ids = caseKeyDecls([OTHER, PW], [], { metricRefs: ["v3"] }).map((d) => d.id);
    expect(ids[0]).toBe("pass");
    expect(ids).toEqual([
      "pass",
      "pass_present",
      "claims_present",
      "win_present",
      "win_v3_present",
      "a1_present",
      "a1_win_present",
      "a1_win_v3_present",
      "claims",
      "win",
      "win_v3",
      "both_bad",
      "a0",
      "a1",
      "a1_win",
      "a1_win_v3",
    ]);
  });

  it("a flow declares the per-assert win keys only when every case has the same assertion list", () => {
    const same = flowMetricDecls([{ assertions: [PW] }, { assertions: [PW] }]).map((d) => d.id);
    expect(same).toContain("a0_win");
    const differ = flowMetricDecls([{ assertions: [PW] }, { assertions: [OTHER, PW] }]).map((d) => d.id);
    expect(differ).toContain("win");
    expect(differ).not.toContain("a0_win");
    expect(differ).not.toContain("a1_win");
  });

  it("a flow with no pairwise assert declares no win column", () => {
    expect(flowMetricDecls([{ assertions: [OTHER] }]).map((d) => d.id)).not.toContain("win_present");
  });

  it("each omittable key has a companion the row carries", () => {
    expect(presentCompanionOf("both_bad")).toBe("win_present");
    expect(presentCompanionOf("win")).toBe("win_present");
    expect(presentCompanionOf("win_v3")).toBe("win_v3_present");
    expect(presentCompanionOf("a2_win")).toBe("a2_win_present");
    expect(presentCompanionOf("a2_win_v3")).toBe("a2_win_v3_present");
  });
});

// The schema checker reads the same companion map: a flow whose rows carry the win columns, declared by the same
// producer, is clean — and an omitted key without its companion at 0 is the error it exists to catch.
describe("hillclimb check over a flow with pairwise rows", () => {
  const FIXTURE = join(resolve(dirname(fileURLToPath(import.meta.url))), "fixtures", "hillclimb-flow");
  const withPairwise = (mut?: (grade: Record<string, unknown>, i: number) => void): FlowSnapshot => {
    const s = structuredClone(loadFlowSnapshot(FIXTURE));
    const st = JSON.parse(s.state!);
    st.metrics = [...st.metrics, ...flowMetricDecls([{ assertions: [PW] }]).filter((d) => /win|both_bad/.test(d.id))];
    s.state = JSON.stringify(st);
    for (const v of Object.keys(s.variants)) {
      const rows = s.variants[v]!.results!.trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      rows.forEach((r, i) => {
        r.grade = { ...r.grade, win_present: 1, win: 0.5, a0_win_present: 1, a0_win: 0.5, both_bad: 0 };
        mut?.(r.grade, i);
      });
      s.variants[v]!.results = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    }
    return s;
  };

  it("is clean with every win column present", () => {
    const r = checkFlowSnapshot(withPairwise());
    expect(
      r.findings.filter((f) => f.level === "error"),
      JSON.stringify(r.findings, null, 1),
    ).toEqual([]);
  });

  it("is clean when win and both_bad are omitted under win_present 0", () => {
    const r = checkFlowSnapshot(
      withPairwise((g) => {
        g.win_present = 0;
        delete g.win;
        delete g.both_bad;
      }),
    );
    expect(
      r.findings.filter((f) => f.level === "error"),
      JSON.stringify(r.findings, null, 1),
    ).toEqual([]);
  });

  it("errors when both_bad is omitted while win_present says it was measured", () => {
    const r = checkFlowSnapshot(withPairwise((g) => delete g.both_bad));
    expect(r.findings.some((f) => f.level === "error" && /both_bad/.test(f.message))).toBe(true);
  });
});

describe("discoverFlowRefs", () => {
  let flow: string;
  beforeEach(() => {
    flow = realpathSync(mkdtempSync(join(tmpdir(), "hc-pw-flow-")));
  });
  afterEach(() => rmSync(flow, { recursive: true, force: true }));

  it("baseline always, then every vN with a ref/, in numeric order; a symlinked ref is listed (read then fails integrity)", () => {
    for (const d of ["baseline", "v2/ref", "v10/ref", "v3", "vX/ref"]) mkdirSync(join(flow, d), { recursive: true });
    mkdirSync(join(flow, "v4"));
    symlinkSync(join(flow, "v2", "ref"), join(flow, "v4", "ref"));
    const refs = discoverFlowRefs(flow);
    expect(refs.map((r) => r.name)).toEqual(["baseline", "v2", "v4", "v10"]);
    expect(refs[0]!.store).toBe(join(flow, "baseline", "ref"));
    expect(metricRefNames(refs)).toEqual(["v2", "v4", "v10"]);
  });

  it("the run setup gates on the baseline and is neutral against its own variant", () => {
    const refs = discoverFlowRefs(flow);
    expect(flowPairwiseOptions("c1", "v2", refs)).toEqual({ caseId: "c1", refs, neutralRefs: ["v2"], gateRefs: ["baseline"] });
  });
});

describe("check: the second-reference hint and a changed reference", () => {
  const snap = (
    variants: Record<string, Array<Record<string, unknown>>>,
    refFiles: string[] = ["baseline/ref/c1/ref.json"],
  ): FlowSnapshot => ({
    entries: [],
    variants: Object.fromEntries(
      Object.entries(variants).map(([v, rows]) => [v, { results: rows.map((r) => JSON.stringify(r)).join("\n"), traces: {} }]),
    ),
    files: refFiles,
  });
  const row = (grade: Record<string, unknown>, meta: Record<string, unknown> = {}, prompt_id = "c1", rep = 0) => ({
    prompt_id,
    rep,
    status: "ok",
    grade,
    meta,
  });

  it("hints to freeze a variant that wins on 90% or more against the newest reference — warn-only text", () => {
    const s = snap({
      baseline: [row({ win_present: 1, win: 0.5 })],
      v1: [row({ win_present: 1, win: 1 }), row({ win_present: 1, win: 0.9 }, {}, "c2")],
    });
    const h = pairwiseHints(s, "flow");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(/^note: v1 scores 0\.95 on win over 2 row\(s\)/);
    expect(h[0]).toContain("hillclimb freeze-ref <scenarios> --flow flow --variant v1");
  });

  it("no hint below 0.9, none over unmeasured rows, and none for variants before the newest reference", () => {
    expect(pairwiseHints(snap({ v1: [row({ win_present: 1, win: 0.85 })] }))).toEqual([]);
    expect(pairwiseHints(snap({ v1: [row({ win_present: 0 })] }))).toEqual([]);
    const s = snap({ v1: [row({ win_present: 1, win: 1 })], v2: [row({ win_v2_present: 1, win_v2: 0.5 })] }, [
      "baseline/ref/c1/ref.json",
      "v2/ref/c1/ref.json",
    ]);
    // v2's reference is the newest: v1 (before it) and v2 (its own) are not hinted.
    expect(pairwiseHints(s)).toEqual([]);
  });

  it("a reference document that changed between rows is an error", () => {
    const s = snap({
      baseline: [row({}, { pairwise_ref_sha256: { "a0/baseline": "aaa" } })],
      v1: [row({}, { pairwise_ref_sha256: { "a0/baseline": "bbb" } }, "c1", 0)],
    });
    expect(pairwiseRefFindings(s)).toMatchObject([{ level: "error", rule: "pairwise.ref_changed" }]);
    const same = snap({
      baseline: [row({}, { pairwise_ref_sha256: { "a0/baseline": "aaa" } })],
      v1: [row({}, { pairwise_ref_sha256: { "a0/baseline": "aaa" } })],
    });
    expect(pairwiseRefFindings(same)).toEqual([]);
  });
});

describe("state-template", () => {
  it("declares win_<vN> only when no scored row lacks it, and says why otherwise", () => {
    const t = stateTemplate({
      cases: [{ assertions: [PW] }],
      harnessPaths: [],
      decider: false,
      pairwiseRefs: [
        { ref: "v2", rowsMissing: 0 },
        { ref: "v3", rowsMissing: 4 },
      ],
    });
    const ids = t.state.metrics.map((m) => m.id);
    expect(ids).toContain("win_v2");
    expect(ids).not.toContain("win_v3");
    expect(t.notes.join("\n")).toMatch(/win_v3 is not declared: 4 scored row\(s\)/);
    expect(t.metricsMd).toContain("`win_v2`");
    expect(t.metricsMd).toContain("`a0_win`");
  });

  it("without --flow it declares win alone and says to pass --flow", () => {
    const t = stateTemplate({ cases: [{ assertions: [PW] }], harnessPaths: [], decider: false });
    expect(t.state.metrics.map((m) => m.id)).toContain("win");
    expect(t.notes.join("\n")).toMatch(/pass --flow/);
  });
});

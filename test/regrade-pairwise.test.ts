import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import { candidateFirst, type CompleteStructured } from "../src/decide/pairwise-judge.js";
import { regradeRuns } from "../src/run/regrade.js";
import { freezeCaseRef } from "../src/hillclimb/freeze-ref.js";
import { discoverFlowRefs, flowPairwiseOptions } from "../src/hillclimb/pairwise.js";
import { latestTurn, turnArtifactPath } from "../src/run/turn-layout.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

// `regrade` over semantic_pairwise, on REAL kept run dirs (the real executeScenario with the agent and the judge
// transport stubbed): the same seeded order as the live pass, the neutral run drift-checked against composedDoc,
// and a fill that judges only the named references while every other outcome is the live one.

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const ANSWER = "REGRADE-CANDIDATE: the answer is 42.";
const STUB = [
  line({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: ANSWER }] },
    session_id: "stub",
  }),
  line({ type: "result", subtype: "success", is_error: false, result: ANSWER, session_id: "stub", num_turns: 1 }),
  "cat >/dev/null",
].join("\n");

let f: StubFixture;
let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}
beforeEach(() => {
  f = makeStubFixture(STUB);
  dir = mkdtempSync(join(tmpdir(), "regrade-pw-"));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("COWORK_MANAGED_CONFIG", "1");
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    setEnv(k, k === "CLAUDE_CODE_OAUTH_TOKEN" ? "stub-not-a-real-token" : "");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  f.cleanup();
});

const JUDGE = "claude-haiku-4-5-20251001";
/** A non-judged assert FIRST, so the pairwise assert sits at index 1: the seeded order depends on that index. */
function scenario(extra: string[] = []): string {
  const file = join(dir, "evals", "alpha.yaml");
  mkdirSync(join(dir, "evals"), { recursive: true });
  writeFileSync(
    file,
    [
      "name: alpha",
      "baseline: latest",
      "session: (inline)",
      "fidelity: protocol",
      "prompt: what is the answer?",
      "assert:",
      "  - result: success",
      "  - semantic_pairwise:",
      "      rubric: ['gives the answer']",
      `      judge_model: ${JUDGE}`,
      ...extra,
      "",
    ].join("\n"),
  );
  return file;
}

/** A judge that prefers the candidate, recording each call and the order it was shown. */
const judge =
  (calls: Array<{ candidateFirst: boolean }>): CompleteStructured =>
  async (c) => {
    const candidateFirst = c.user.indexOf("REGRADE-CANDIDATE") < c.user.lastIndexOf("REGRADE-CANDIDATE");
    calls.push({ candidateFirst });
    return { structured: { rationale: "A states it.", verdict: candidateFirst ? "A" : "B" }, model: JUDGE, subtype: "success" };
  };

const rowFor = (outDir: string) => ({
  prompt_id: "alpha",
  rep: 0,
  status: "ok",
  grade: { pass: 1, pass_present: 1, win_present: 1, win: 0.5 },
  meta: { scenario_name: "alpha", run_id: outDir.split("/").pop(), run_dir: outDir },
});
const resultBytes = (runDir: string) => readFileSync(turnArtifactPath(runDir, latestTurn(runDir)!, "result.json"));

/** A flow with a frozen baseline reference, and a v1 run judged against it. */
async function flowWithV1() {
  const file = scenario();
  const sc = parseScenarioFile(file);
  const flow = join(dir, "flow");
  mkdirSync(join(flow, "baseline"), { recursive: true });
  const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
  const frozen = freezeCaseRef({
    flowAbs: flow,
    variant: "baseline",
    caseId: "alpha",
    scenarioFile: file,
    assertions: sc.assert,
    prompt: sc.prompt,
    results: JSON.stringify(rowFor(base.outDir)) + "\n",
    secrets: [],
    command: "hillclimb run",
  });
  expect(frozen.status).toBe("frozen");
  const liveCalls: Array<{ candidateFirst: boolean }> = [];
  // A run id whose seeded order differs between assert index 0 and 1, so a re-grade that lost the assert's index
  // in the scenario (judging a filtered list) shows the OTHER order — deterministically, never by a coin flip.
  let k = 0;
  while (candidateFirst(`local_seed${k}`, 0, "baseline") === candidateFirst(`local_seed${k}`, 1, "baseline")) k++;
  const v1 = await executeScenario(sc, {
    runId: `local_seed${k}`,
    pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
    pairwiseComplete: judge(liveCalls),
  });
  return { file, sc, flow, base, v1, liveCalls };
}

describe.runIf(POSIX)("regrade: semantic_pairwise", () => {
  it("re-grades with the live seeded order and outcome; result.json stays byte-identical", async () => {
    const { file, flow, v1, liveCalls } = await flowWithV1();
    const live = v1.assertions[1]!;
    expect(live.pairwise).toMatchObject([{ ref: "baseline", status: "graded" }]);
    const before = resultBytes(v1.outDir);
    const calls: Array<{ candidateFirst: boolean }> = [];
    const r = await regradeRuns({
      runDirs: [v1.outDir],
      scenarioFile: file,
      secrets: [],
      pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
      pairwiseComplete: judge(calls),
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const g = r.runs[0]!.assertions.find((a) => a.assertionIndex === 1)!;
    expect(g.pairwise![0]).toMatchObject({
      ref: "baseline",
      status: "graded",
      order: live.pairwise![0]!.order,
      outcome: live.pairwise![0]!.outcome,
    });
    expect(calls.map((c) => c.candidateFirst)).toEqual(liveCalls.map((c) => c.candidateFirst));
    expect(g.docMatchesLive).toBe(true);
    expect(resultBytes(v1.outDir).equals(before)).toBe(true);
  });

  it("an all-neutral baseline run is drift-checked against its composedDoc (not 'unknown')", async () => {
    const { file, flow, base } = await flowWithV1();
    const r = await regradeRuns({
      runDirs: [base.outDir],
      scenarioFile: file,
      secrets: [],
      pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)),
      pairwiseComplete: judge([]),
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.runs[0]!.docMatchesLive).toBe(true);
  });

  it("a fill judges ONLY the named reference; the gate outcome is the live one, copied, and pass cannot move", async () => {
    const { file, sc, flow, v1 } = await flowWithV1();
    // Freeze v1's own reference, then fill v1's run as a v2 row would be filled: the v1 column is judged, the baseline
    // (gate) outcome is the live one.
    expect(
      freezeCaseRef({
        flowAbs: flow,
        variant: "v1",
        caseId: "alpha",
        scenarioFile: file,
        assertions: sc.assert,
        prompt: sc.prompt,
        results: JSON.stringify(rowFor(v1.outDir)) + "\n",
        secrets: [],
        command: "hillclimb freeze-ref",
      }).status,
    ).toBe("frozen");
    const live = v1.assertions[1]!;
    const calls: Array<{ candidateFirst: boolean }> = [];
    const r = await regradeRuns({
      runDirs: [v1.outDir],
      scenarioFile: file,
      secrets: [],
      pairwise: { ...flowPairwiseOptions("alpha", "v2", discoverFlowRefs(flow)), onlyRefs: ["v1"] },
      pairwiseComplete: judge(calls),
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const g = r.runs[0]!.assertions.find((a) => a.assertionIndex === 1)!;
    expect(calls).toHaveLength(1); // only v1 was judged
    expect(g.pairwise).toMatchObject([
      { ...live.pairwise![0], copied: true },
      { ref: "v1", gate: false, status: "graded" },
    ]);
    expect(g.pass).toBe(live.pass);
  });

  it("a scenario whose only judged assert is semantic_pairwise is not 'no semantic asserts'", async () => {
    const { file, flow, v1 } = await flowWithV1();
    const r = await regradeRuns({
      runDirs: [v1.outDir],
      scenarioFile: file,
      secrets: [],
      pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
      pairwiseComplete: judge([]),
    });
    expect(r.ok).toBe(true);
  });

  it("a gate reference that cannot be read is refused before any judge call", async () => {
    const { file, v1 } = await flowWithV1();
    const calls: Array<{ candidateFirst: boolean }> = [];
    const r = await regradeRuns({
      runDirs: [v1.outDir],
      scenarioFile: file,
      secrets: [],
      pairwise: { caseId: "alpha", refs: [{ name: "baseline", store: join(dir, "nowhere") }], neutralRefs: [], gateRefs: ["baseline"] },
      pairwiseComplete: judge(calls),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/refusing before the run spends anything/);
    expect(calls).toEqual([]);
  });
});

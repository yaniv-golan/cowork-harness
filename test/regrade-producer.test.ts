// `regrade` against a run dir the REAL producer wrote. test/regrade.test.ts builds its "live" side from the
// same functions the live run calls, which is strong but still hand-assembled: this file drives a real `run`
// (executeScenario, the live semantic judge, the result.json/run.jsonl writers) with only the agent and the
// judge transport replaced by the stub `claude` on PATH (test/helpers/stub-agent.ts). No agent, no spend.
// The re-grade then runs in-process with a judge double, and its `docMatchesLive` is measured against the
// `judgedDoc` the producer persisted.
//
// No sub-agents here on purpose: this pins the main-loop sections (final answer, transcript, authored files).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, credentialLeaks, exited, makeStubFixture, runDir, spawnCli, type StubFixture } from "./helpers/stub-agent.js";
import { regradeRuns } from "../src/run/regrade.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import type { SemanticJudge } from "../src/assert.js";

const can = POSIX && existsSync(CLI);

const JUDGE_MODEL = "claude-judge-stub-1";
// The agent (stream-json) writes one deliverable into its cwd — the run's work dir — then answers. The live
// judge's call (`-p --output-format json`) grades every claim as passing.
const STUB = [
  `case " $* " in *" --output-format json "*)`,
  `  cat >/dev/null; printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\\"results\\":[{\\"index\\":0,\\"pass\\":true}]}","total_cost_usd":0.001,"modelUsage":{"${JUDGE_MODEL}":{"inputTokens":1,"outputTokens":1,"costUSD":0.001}}}'`,
  `  exit 0;;`,
  `esac`,
  `mkdir -p outputs && printf '# Report\\nThe main risk is customer concentration.\\n' > outputs/report.md`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"I wrote outputs/report.md."}]},"session_id":"stub"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"The report is in outputs/report.md.","session_id":"stub","num_turns":1,"total_cost_usd":0.0123,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  "cat >/dev/null",
].join("\n");

// One scoped and one unscoped assert, so both the priority-glob and the default capture are exercised. The
// stub reads no config dir, so the L0 host-config guard is opted out to keep the exit code a real signal.
const SCENARIO =
  `baseline: latest\nfidelity: protocol\nprompt: write the report\nassert:\n  - allow_l0_host_config_contamination: true\n` +
  `  - semantic_matches:\n      rubric: ["the report names the risk"]\n      evidence_files: ["outputs/report.md"]\n` +
  `  - semantic_matches:\n      rubric: ["the answer points at the report"]\n`;

function judgeDouble(calls: string[]) {
  return (o?: { model?: string }): SemanticJudge => {
    const j: SemanticJudge = async (rubric, answer) => {
      calls.push(answer);
      j.lastCostUsd = 0.002;
      return rubric.map((claim, index) => ({ index, claim, pass: true }));
    };
    j.model = o?.model ?? JUDGE_MODEL;
    j.promptHash = JUDGE_PROMPT_HASH;
    return j;
  };
}

async function producedRun(): Promise<{ f: StubFixture; dir: string; live: any }> {
  const f = makeStubFixture(STUB, { COWORK_HARNESS_JUDGE_MODEL: JUDGE_MODEL });
  writeFileSync(f.scenario, SCENARIO);
  const cli = spawnCli(f, ["run", f.scenario, "--output-format", "json"]);
  const r = await exited(cli, 30_000);
  expect(credentialLeaks(f.envDump)).toEqual([]);
  expect(r.code, cli.stderrText()).toBe(0);
  const dir = runDir(f)!;
  const live = JSON.parse(readFileSync(join(dir, "turns", "1", "result.json"), "utf8"));
  return { f, dir, live };
}

describe.runIf(can)("regrade over a producer-written run dir", () => {
  it("rebuilds the document the live judge read — docMatchesLive true against the persisted judgedDoc", async () => {
    const { f, dir, live } = await producedRun();
    try {
      const liveSemantic = live.assertions.filter((a: any) => a.assertion.semantic_matches);
      expect(liveSemantic).toHaveLength(2);
      // The producer really recorded what the comparison needs: a fingerprint with an authored section.
      for (const a of liveSemantic) expect(a.judgedDoc?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(liveSemantic[0].judgedDoc.sections.map((s: any) => s.kind)).toEqual(["final", "transcript", "authored"]);
      expect(live.authoredCapture?.totalBytes).toBeGreaterThan(0);

      const calls: string[] = [];
      const out = await regradeRuns({ runDirs: [dir], scenarioFile: f.scenario, makeJudge: judgeDouble(calls), judgeModel: JUDGE_MODEL });
      if (!out.ok) throw new Error(out.message);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("## Authored file: outputs/report.md");
      const run = out.runs[0];
      expect(run.differingSections).toEqual([]);
      expect(run.docMatchesLive).toBe(true);
      // Byte-for-byte the producer's fingerprints, assert by assert.
      expect(run.assertions.map((a) => a.judgedDoc?.sha256)).toEqual(liveSemantic.map((a: any) => a.judgedDoc.sha256));
      expect(run.judgeCostUsd).toBeCloseTo(0.004);
      // result.json is left as the producer wrote it.
      expect(JSON.parse(readFileSync(join(dir, "turns", "1", "result.json"), "utf8"))).toEqual(live);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("the same comparison reports false once the authored file changes (the instrument can say no)", async () => {
    const { f, dir, live } = await producedRun();
    try {
      writeFileSync(join(live.workDir, "outputs", "report.md"), "# Report\nThe main risk is churn.\n");
      const out = await regradeRuns({
        runDirs: [dir],
        scenarioFile: f.scenario,
        makeJudge: judgeDouble([]),
        judgeModel: JUDGE_MODEL,
      });
      if (!out.ok) throw new Error(out.message);
      expect(out.runs[0].docMatchesLive).toBe(false);
      expect(out.runs[0].differingSections).toContainEqual({
        assertionIndex: 1,
        kind: "authored",
        path: "outputs/report.md",
        change: "changed",
      });
    } finally {
      f.cleanup();
    }
  }, 60_000);
});

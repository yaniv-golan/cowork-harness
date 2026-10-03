// A run dir copied or moved after its run still carries a result.json whose absolute evidence paths (`outDir`,
// `workDir`, `outputsDir`) name the ORIGINAL location. Every command that re-grades or verifies a kept run reads
// through those paths, so on a copy it would judge the original's evidence while reporting (and writing a
// regrade file into) the copy. These tests pin the refusal, built over a run dir the real producer wrote (the
// stub `claude` on PATH stands in for the agent and the live judge — no agent, no spend).
import { describe, it, expect } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, runDir, spawnCli, type StubFixture } from "./helpers/stub-agent.js";
import { regradeRuns } from "../src/run/regrade.js";
import { reevaluateFromRun } from "../src/hillclimb/regrade.js";
import { composeFromRunDir } from "../src/refs/compose.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { relocatedRunDirRefusal } from "../src/run/run-dir-identity.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import type { SemanticJudge } from "../src/assert.js";
import type { HillclimbCase } from "../src/hillclimb/cases.js";

const can = POSIX && existsSync(CLI);

const JUDGE_MODEL = "claude-judge-stub-1";
const STUB = [
  `case " $* " in *" --output-format json "*)`,
  `  cat >/dev/null; printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"{\\"results\\":[{\\"index\\":0,\\"pass\\":true}]}","total_cost_usd":0.001,"modelUsage":{"${JUDGE_MODEL}":{"inputTokens":1,"outputTokens":1,"costUSD":0.001}}}'`,
  `  exit 0;;`,
  `esac`,
  `mkdir -p outputs && printf '# Insights\\nThe main risk is customer concentration.\\n' > outputs/insights.md`,
  `printf '{"risk":"concentration"}' > outputs/metrics.json`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"I wrote outputs/insights.md."}]},"session_id":"stub"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"The insights are in outputs/insights.md.","session_id":"stub","num_turns":1,"total_cost_usd":0.0123,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  "cat >/dev/null",
].join("\n");

// A filesystem assert and a judged one, so both the verify path and the semantic path read the work dir.
const SCENARIO =
  `baseline: latest\nfidelity: protocol\nprompt: write the insights\nassert:\n  - allow_l0_host_config_contamination: true\n` +
  `  - file_exists: outputs/insights.md\n` +
  `  - semantic_matches:\n      rubric: ["the insights name the risk"]\n      evidence_files: ["outputs/insights.md"]\n`;

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

/** A producer-written run, plus a copy of it whose authored deliverable is edited (what a user iterating on a
 *  kept run does). The copy sits under the fixture root, so `f.cleanup()` removes it. */
async function runAndCopy(): Promise<{ f: StubFixture; dir: string; copy: string }> {
  const f = makeStubFixture(STUB, { COWORK_HARNESS_JUDGE_MODEL: JUDGE_MODEL });
  writeFileSync(f.scenario, SCENARIO);
  const cli = spawnCli(f, ["run", f.scenario, "--output-format", "json"]);
  const r = await exited(cli, 30_000);
  expect(r.code, cli.stderrText()).toBe(0);
  const dir = runDir(f)!;
  const copy = join(f.root, "copied-runs", basename(dir));
  mkdirSync(dirname(copy), { recursive: true });
  cpSync(dir, copy, { recursive: true, verbatimSymlinks: true });
  // The copy's own deliverable, at the same place under the copy as the work dir sits under the original.
  const live = JSON.parse(readFileSync(join(dir, "turns", "1", "result.json"), "utf8"));
  writeFileSync(join(copy, relative(live.outDir, live.outputsDir), "insights.md"), "# Insights\nThe main risk is churn.\n");
  writeFileSync(join(copy, relative(live.outDir, live.outputsDir), "metrics.json"), '{"risk":"churn"}');
  return { f, dir, copy };
}

const noRegradeFile = (d: string) => expect(existsSync(join(d, "turns", "1", "regrade"))).toBe(false);

const hcCase = (f: StubFixture): HillclimbCase =>
  ({ id: "stub", stem: "stub", name: "stub", file: f.scenario, scenario: parseScenarioFile(f.scenario) }) as HillclimbCase;

describe.runIf(can)("a copied run dir is refused by every command that grades or verifies it", () => {
  it("regrade: refused before any judge call, naming both dirs; no regrade file written anywhere", async () => {
    const { f, dir, copy } = await runAndCopy();
    try {
      const calls: string[] = [];
      const out = await regradeRuns({ runDirs: [copy], scenarioFile: f.scenario, makeJudge: judgeDouble(calls), judgeModel: JUDGE_MODEL });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.message).toMatch(/copied or moved from/);
      expect(out.message).toContain(copy);
      expect(out.message).toContain(dir); // the original, as its result.json records it
      expect(out.message).toMatch(/Re-run the scenario/);
      expect(calls).toHaveLength(0);
      noRegradeFile(copy);
      noRegradeFile(dir);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("verify-run: exit 2 with the refusal", async () => {
    const { f, dir, copy } = await runAndCopy();
    try {
      const cli = spawnCli(f, ["verify-run", copy, f.scenario]);
      const r = await exited(cli, 30_000);
      expect(r.code).toBe(2);
      expect(cli.stderrText()).toMatch(/verify-run: .* was copied or moved from/);
      expect(cli.stderrText()).toContain(dir);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("hillclimb regrade: the row is listed as refused, never re-evaluated over the original's tree", async () => {
    const { f, copy } = await runAndCopy();
    try {
      const re = reevaluateFromRun(copy, hcCase(f));
      expect(re).toMatchObject({ listed: expect.stringMatching(/^refused: hillclimb regrade: .* was copied or moved from/) });
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("ref freeze / hillclimb freeze-ref / --fill-refs: the composition is refused", async () => {
    const { f, copy } = await runAndCopy();
    try {
      const out = composeFromRunDir(copy, f.scenario, [], { command: "hillclimb freeze-ref" });
      expect(out).toMatchObject({ refused: expect.stringMatching(/was copied or moved from/) });
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("diff: a copied side is refused (exit 2) rather than hashed through the original's tree", async () => {
    const { f, dir, copy } = await runAndCopy();
    try {
      const cli = spawnCli(f, ["diff", dir, copy, "--view", "artifacts"]);
      const r = await exited(cli, 30_000);
      expect(r.code).toBe(2);
      expect(cli.stderrText()).toMatch(/diff: .* was copied or moved from/);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("inspect (a view): warns, and previews nothing from the original's tree", async () => {
    const { f, copy } = await runAndCopy();
    try {
      const cli = spawnCli(f, ["inspect", copy]);
      const r = await exited(cli, 30_000);
      expect(r.code, cli.stderrText()).toBe(0);
      const all = cli.stdoutText() + cli.stderrText();
      expect(all).toMatch(/was copied or moved from/);
      expect(all).toContain("outputs/metrics.json");
      expect(all).not.toMatch(/risk: concentration/);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("a MOVED run dir (the original is gone) is refused too", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = join(f.root, "moved-run");
      renameSync(dir, moved);
      const cli = spawnCli(f, ["verify-run", moved, f.scenario]);
      const r = await exited(cli, 30_000);
      expect(r.code).toBe(2);
      expect(cli.stderrText()).toMatch(/was copied or moved from/);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("the SAME run reached through a symlinked parent is not refused", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const link = join(f.root, "runs-link");
      symlinkSync(dirname(dirname(dir)), link);
      const viaLink = join(link, basename(dirname(dir)), basename(dir));
      expect(realpathSync.native(viaLink)).toBe(realpathSync.native(dir));
      // verify-run calls no judge, so it grades the scenario's deterministic asserts only.
      const deterministic = join(f.root, "deterministic.yaml");
      writeFileSync(deterministic, SCENARIO.slice(0, SCENARIO.indexOf("  - semantic_matches:")));
      const cli = spawnCli(f, ["verify-run", viaLink, deterministic]);
      const r = await exited(cli, 30_000);
      expect(cli.stderrText()).not.toMatch(/copied or moved/);
      expect(r.code, cli.stderrText()).toBe(0);
      const calls: string[] = [];
      const out = await regradeRuns({
        runDirs: [viaLink],
        scenarioFile: f.scenario,
        makeJudge: judgeDouble(calls),
        judgeModel: JUDGE_MODEL,
      });
      if (!out.ok) throw new Error(out.message);
      expect(out.runs[0].docMatchesLive).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 60_000);
});

describe("relocatedRunDirRefusal — the rule", () => {
  function tree(): { root: string; run: string; done: () => void } {
    const root = mkdtempSync(join(tmpdir(), "relocated-"));
    const run = join(root, "runs", "scen", "abc");
    mkdirSync(join(run, "work", "session", "mnt", "outputs"), { recursive: true });
    return { root, run, done: () => rmSync(root, { recursive: true, force: true }) };
  }
  const paths = (outDir: string) => ({
    outDir,
    workDir: join(outDir, "work", "session", "mnt"),
    outputsDir: join(outDir, "work", "session", "mnt", "outputs"),
    stderrLogPath: join(outDir, "agent.stderr.log"),
  });

  it("passes the run's own dir, given as recorded or through /var ↔ /private/var", () => {
    const t = tree();
    try {
      expect(relocatedRunDirRefusal(t.run, paths(t.run), "x")).toBeUndefined();
      expect(relocatedRunDirRefusal(realpathSync.native(t.run), paths(t.run), "x")).toBeUndefined();
      expect(relocatedRunDirRefusal(t.run, paths(realpathSync.native(t.run)), "x")).toBeUndefined();
    } finally {
      t.done();
    }
  });

  it("passes a work dir that was torn down (it still sits inside the run dir)", () => {
    const t = tree();
    try {
      rmSync(join(t.run, "work"), { recursive: true });
      expect(relocatedRunDirRefusal(t.run, paths(t.run), "x")).toBeUndefined();
    } finally {
      t.done();
    }
  });

  it("refuses a sibling whose name only shares a string prefix", () => {
    const t = tree();
    try {
      const sib = `${t.run}2`;
      mkdirSync(sib);
      expect(relocatedRunDirRefusal(sib, paths(t.run), "x")).toMatch(/copied or moved from/);
    } finally {
      t.done();
    }
  });

  it("refuses an evidence path outside the recorded run dir, and a relative one", () => {
    const t = tree();
    try {
      expect(relocatedRunDirRefusal(t.run, { ...paths(t.run), workDir: join(t.root, "elsewhere") }, "x")).toMatch(/workDir .* outside/);
      expect(relocatedRunDirRefusal(t.run, { ...paths(t.run), outputsDir: `${t.run}2/outputs` }, "x")).toMatch(/outputsDir .* outside/);
      expect(relocatedRunDirRefusal(t.run, { ...paths(t.run), workDir: "work/session/mnt" }, "x")).toMatch(/not an absolute path/);
    } finally {
      t.done();
    }
  });

  it("refuses evidence paths with no recorded run dir; passes when nothing is recorded at all", () => {
    const t = tree();
    try {
      const { outDir: _o, ...noOut } = paths(t.run);
      expect(relocatedRunDirRefusal(t.run, noOut, "x")).toMatch(/but no outDir/);
      expect(relocatedRunDirRefusal(t.run, {}, "x")).toBeUndefined();
    } finally {
      t.done();
    }
  });

  it("folds no case itself: the same dir named in another case passes only where the filesystem says it is the same dir", () => {
    const t = tree();
    try {
      const upper = join(dirname(t.run), basename(t.run).toUpperCase());
      // realpath.native returns the on-disk spelling, so a case-insensitive volume resolves both to one dir; a
      // case-sensitive one has no such dir, and a recorded dir that is not this one is refused.
      if (existsSync(upper)) expect(relocatedRunDirRefusal(upper, paths(t.run), "x")).toBeUndefined();
      else expect(relocatedRunDirRefusal(t.run, paths(upper), "x")).toMatch(/copied or moved from/);
    } finally {
      t.done();
    }
  });

  it("reads a result.json written by an older harness as-is: the message names the original", () => {
    const t = tree();
    try {
      const msg = relocatedRunDirRefusal(t.run, paths("/Users/someone/.cowork-harness/runs/scen/abc"), "regrade");
      expect(msg).toMatch(/^regrade: /);
      expect(msg).toContain("/Users/someone/.cowork-harness/runs/scen/abc");
      expect(msg).toContain(t.run);
    } finally {
      t.done();
    }
  });
});

// A run dir copied or moved after its run still carries a result.json whose absolute evidence paths (`outDir`,
// `workDir`, `outputsDir`) name the ORIGINAL location. Read through those paths, a copy beside its original would be
// judged on the original's evidence while reported as (and written into) the copy — refused. A run dir whose recorded
// location is gone (moved, a downloaded CI artifact) has nothing there to read: it is read from where it now is.
// Built over run dirs the real producer wrote (the stub `claude` on PATH stands in for the agent and the live judge —
// no agent, no spend).
import { describe, it, expect, vi } from "vitest";
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
import { decideRunDir } from "../src/run/run-dir-identity.js";
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

/** The run moved away: nothing is left at its recorded location. */
function moveAway(f: StubFixture, dir: string): string {
  const moved = join(f.root, "moved-runs", "stub", basename(dir));
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(dir, moved);
  return moved;
}
const outputsOf = (d: string) => {
  const live = JSON.parse(readFileSync(join(d, "turns", "1", "result.json"), "utf8"));
  return join(d, relative(live.outDir, live.outputsDir));
};
/** Rewrite a run dir's recorded paths (a test fixture only), e.g. to the shape a downloaded CI artifact records. */
function rewriteRecorded(d: string, edit: (r: Record<string, string>) => void): void {
  const p = join(d, "turns", "1", "result.json");
  const r = JSON.parse(readFileSync(p, "utf8"));
  edit(r);
  writeFileSync(p, JSON.stringify(r));
}
const DETERMINISTIC = SCENARIO.slice(0, SCENARIO.indexOf("  - semantic_matches:"));
const CONTENT_ONLY = DETERMINISTIC.replace("  - file_exists: outputs/insights.md\n", "  - result: success\n");
const JUDGE_STUB =
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi\n` +
  `if [ "$1" = "--help" ]; then for x in --safe-mode --strict-mcp-config --no-session-persistence "--setting-sources <s>" "--tools <tools...>" "--effort <level>" "--settings <s>"; do echo "  $x   x"; done; exit 0; fi\nexit 1\n`;
async function verify(f: StubFixture, dir: string, yaml: string) {
  const sc = join(f.root, `verify-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(sc, yaml);
  const cli = spawnCli(f, ["verify-run", dir, sc]);
  const r = await exited(cli, 30_000);
  return { code: r.code, err: cli.stderrText(), out: cli.stdoutText() };
}

const hcCase = (f: StubFixture): HillclimbCase =>
  ({ id: "stub", stem: "stub", name: "stub", file: f.scenario, scenario: parseScenarioFile(f.scenario) }) as HillclimbCase;

describe.runIf(can)("(B) a run dir copied beside its original is refused by every command that grades or verifies it", () => {
  it("regrade: refused before any judge call, naming both dirs; no regrade file written anywhere", async () => {
    const { f, dir, copy } = await runAndCopy();
    try {
      const calls: string[] = [];
      const out = await regradeRuns({ runDirs: [copy], scenarioFile: f.scenario, makeJudge: judgeDouble(calls), judgeModel: JUDGE_MODEL });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.message).toMatch(/was copied from .*, which is still there/);
      expect(out.message).toContain(copy);
      expect(out.message).toContain(dir);
      expect(out.message).toMatch(/Re-run the scenario, or regrade the original at /);
      expect(calls).toHaveLength(0);
      noRegradeFile(copy);
      noRegradeFile(dir);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("regrade on the CLI: exit 2 with the refusal, no regrade file", async () => {
    const { f, dir, copy } = await runAndCopy();
    try {
      const judge = join(f.root, "judge.sh");
      writeFileSync(judge, JUDGE_STUB, { mode: 0o755 });
      const cli = spawnCli(f, ["regrade", copy, "--scenario", f.scenario, "--judge-model", JUDGE_MODEL], {
        COWORK_HARNESS_CLAUDE_BIN: judge,
      });
      const r = await exited(cli, 30_000);
      expect(r.code, cli.stderrText()).toBe(2);
      expect(cli.stderrText()).toMatch(/regrade: .* was copied from/);
      noRegradeFile(copy);
      noRegradeFile(dir);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("verify-run: exit 2 with the refusal", async () => {
    const { f, dir, copy } = await runAndCopy();
    try {
      const v = await verify(f, copy, DETERMINISTIC);
      expect(v.code).toBe(2);
      expect(v.err).toMatch(/verify-run: .* was copied from/);
      expect(v.err).toContain(dir);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("hillclimb regrade: the row is listed as refused, with the runs-root remedy", async () => {
    const { f, copy } = await runAndCopy();
    try {
      const re = reevaluateFromRun(copy, hcCase(f));
      expect(re).toMatchObject({
        listed: expect.stringMatching(/^refused: hillclimb regrade: .* was copied from .* point --run-dir at the runs root/),
      });
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("ref freeze and hillclimb freeze-ref compose through the refusal, prefixed once", async () => {
    const { f, copy } = await runAndCopy();
    try {
      const out = composeFromRunDir(copy, f.scenario, [], { command: "hillclimb freeze-ref" });
      expect(out).toMatchObject({ refused: expect.stringMatching(/was copied from/) });
      expect((out as { refused: string }).refused).not.toMatch(/^hillclimb freeze-ref: /);
      const store = join(f.root, "store");
      const ref = spawnCli(f, ["ref", "freeze", copy, "--scenario", f.scenario, "--out", store]);
      const rr = await exited(ref, 30_000);
      expect(rr.code).toBe(2);
      expect(ref.stderrText()).toMatch(/^ref freeze: .* was copied from/m);
      expect(ref.stderrText()).not.toMatch(/ref freeze: ref freeze:/);
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
      expect(cli.stderrText()).toMatch(/diff: .* was copied from/);
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
      expect(all).toMatch(/was copied from/);
      expect(all).toContain("outputs/metrics.json");
      expect(all).not.toMatch(/risk: concentration/);
      expect(all).toMatch(/previews skipped/);
    } finally {
      f.cleanup();
    }
  }, 60_000);
});

describe.runIf(can)("(C) a run dir whose recorded location is gone is read from where it is", () => {
  it("regrade grades the MOVED tree's edited file and writes its regrade file there", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      writeFileSync(join(outputsOf(moved), "insights.md"), "# Insights\nThe main risk is churn.\n");
      const calls: string[] = [];
      const drift = await regradeRuns({
        runDirs: [moved],
        scenarioFile: f.scenario,
        makeJudge: judgeDouble(calls),
        judgeModel: JUDGE_MODEL,
      });
      // The edit is seen: refused as drift against what the live judge read, before any judge call.
      expect(drift).toMatchObject({ ok: false });
      expect(calls).toHaveLength(0);
      const out = await regradeRuns({
        runDirs: [moved],
        scenarioFile: f.scenario,
        makeJudge: judgeDouble(calls),
        judgeModel: JUDGE_MODEL,
        allowDocDrift: true,
      });
      if (!out.ok) throw new Error(out.message);
      expect(calls[0]).toContain("The main risk is churn.");
      expect(calls[0]).not.toContain("customer concentration");
      expect(out.runs[0].docMatchesLive).toBe(false);
      expect(existsSync(join(moved, "turns", "1", "regrade"))).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("an unedited moved run regrades with docMatchesLive true, noting the move once though it opens the dir several times", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      const calls: string[] = [];
      const written: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => (written.push(String(c)), true));
      let out;
      try {
        out = await regradeRuns({ runDirs: [moved], scenarioFile: f.scenario, makeJudge: judgeDouble(calls), judgeModel: JUDGE_MODEL });
      } finally {
        spy.mockRestore();
      }
      if (!out.ok) throw new Error(out.message);
      expect(out.runs[0].docMatchesLive).toBe(true);
      expect(written.join("").match(/no longer there\); reading its evidence from /g)).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("verify-run reads the moved tree, and says once where the run was recorded", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      writeFileSync(join(outputsOf(moved), "only-here.md"), "x");
      const v = await verify(f, moved, DETERMINISTIC + "  - file_exists: outputs/only-here.md\n");
      expect(v.code, v.err).toBe(0);
      const notes = v.err.match(/note: .* was recorded at .* \(no longer there\); reading its evidence from /g) ?? [];
      expect(notes).toHaveLength(1);
      expect(v.err).toContain(`was recorded at ${dir}`);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("a downloaded CI artifact (recorded under /home/runner/…, absent here) verifies where it is", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      const ci = "/home/runner/work/repo/repo/.cowork-harness/runs/stub/" + basename(dir);
      rewriteRecorded(moved, (r) => {
        for (const k of ["outDir", "workDir", "outputsDir", "stderrLogPath"]) r[k] = r[k].replace(dir, ci);
      });
      expect((await verify(f, moved, CONTENT_ONLY)).code).toBe(0);
      const v = await verify(f, moved, DETERMINISTIC);
      expect(v.code, v.err).toBe(0);
      expect(v.err).toContain(`was recorded at ${ci}`);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("a recorded work dir outside the recorded run dir is unavailable — never read at its recorded path", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      // An existing tree outside, holding the file the assert wants: read through the recorded path, it would pass.
      const outside = join(f.root, "outside-work");
      mkdirSync(join(outside, "outputs"), { recursive: true });
      writeFileSync(join(outside, "outputs", "insights.md"), "x");
      rewriteRecorded(moved, (r) => {
        r.workDir = outside;
        r.outputsDir = join(outside, "outputs");
      });
      const v = await verify(f, moved, DETERMINISTIC);
      expect(v.code).toBe(2);
      expect(v.err).toMatch(/work dir not found \(<unset>\)/);
      expect(v.err).toMatch(/unavailable: workDir \(outside the recorded run dir\)/);
      expect((await verify(f, moved, CONTENT_ONLY)).code).toBe(0);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("a symlink in the moved tree pointing outside it makes that evidence unavailable", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      const outsideWork = join(f.root, "outside-tree");
      renameSync(join(moved, "work"), outsideWork);
      symlinkSync(outsideWork, join(moved, "work"));
      const v = await verify(f, moved, DETERMINISTIC);
      expect(v.code).toBe(2);
      expect(v.err).toMatch(/unavailable: workDir \(resolves outside this run dir/);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("diff hashes a moved side from its own tree", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      // A second dir recorded at the same (gone) location, its metrics.json edited.
      const other = join(f.root, "other-runs", basename(dir));
      mkdirSync(dirname(other), { recursive: true });
      cpSync(moved, other, { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(outputsOf(other), "metrics.json"), '{"risk":"something else entirely"}');
      const cli = spawnCli(f, ["diff", moved, other, "--view", "artifacts", "--output-format", "json"]);
      await exited(cli, 30_000);
      expect(cli.stdoutText()).toContain("metrics.json");
      expect(cli.stdoutText()).not.toMatch(/size:/);
    } finally {
      f.cleanup();
    }
  }, 60_000);

  it("inspect previews the moved tree", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const moved = moveAway(f, dir);
      writeFileSync(join(outputsOf(moved), "metrics.json"), '{"risk":"churn"}');
      const cli = spawnCli(f, ["inspect", moved]);
      expect((await exited(cli, 30_000)).code).toBe(0);
      expect(cli.stdoutText() + cli.stderrText()).toMatch(/risk: churn/);
    } finally {
      f.cleanup();
    }
  }, 60_000);
});

describe.runIf(can)("(A) the run's own dir", () => {
  it("the SAME run reached through a symlinked parent is graded", async () => {
    const { f, dir } = await runAndCopy();
    try {
      const link = join(f.root, "runs-link");
      symlinkSync(dirname(dirname(dir)), link);
      const viaLink = join(link, basename(dirname(dir)), basename(dir));
      expect(realpathSync.native(viaLink)).toBe(realpathSync.native(dir));
      const v = await verify(f, viaLink, DETERMINISTIC);
      expect(v.err).not.toMatch(/copied from|no longer there/);
      expect(v.code, v.err).toBe(0);
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

describe("decideRunDir — the rule", () => {
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
  const kind = (d: ReturnType<typeof decideRunDir>) => d.kind;
  const msg = (d: ReturnType<typeof decideRunDir>) => (d.kind === "refuse" ? d.message : `(${d.kind})`);

  it("(A) the run's own dir, given as recorded or through /var ↔ /private/var: its recorded paths", () => {
    const t = tree();
    try {
      expect(decideRunDir(t.run, paths(t.run), "x")).toEqual({ kind: "same", paths: paths(t.run) });
      expect(kind(decideRunDir(realpathSync.native(t.run), paths(t.run), "x"))).toBe("same");
      expect(kind(decideRunDir(t.run, paths(realpathSync.native(t.run)), "x"))).toBe("same");
      rmSync(join(t.run, "work"), { recursive: true }); // torn down: still inside
      expect(kind(decideRunDir(t.run, paths(t.run), "x"))).toBe("same");
    } finally {
      t.done();
    }
  });

  it("(A) refuses an evidence path outside the run dir, a relative one, and one a link inside resolves outside", () => {
    const t = tree();
    try {
      expect(msg(decideRunDir(t.run, { ...paths(t.run), workDir: join(t.root, "elsewhere") }, "x"))).toMatch(/workDir .* outside/);
      expect(msg(decideRunDir(t.run, { ...paths(t.run), outputsDir: `${t.run}2/outputs` }, "x"))).toMatch(/outputsDir .* outside/);
      expect(msg(decideRunDir(t.run, { ...paths(t.run), workDir: "work/session/mnt" }, "x"))).toMatch(/not an absolute path/);
      mkdirSync(join(t.root, "elsewhere"));
      symlinkSync(join(t.root, "elsewhere"), join(t.run, "work", "linked"));
      expect(msg(decideRunDir(t.run, { ...paths(t.run), workDir: join(t.run, "work", "linked") }, "x"))).toMatch(/outside/);
    } finally {
      t.done();
    }
  });

  it("refuses a recorded path with `..` that a symlink inside the run dir would carry outside it", () => {
    const t = tree();
    try {
      // run/lnk -> outside/a/b: lexically run/lnk/../evil is run/evil, but the kernel reads outside/a/evil.
      const outside = join(t.root, "outside");
      mkdirSync(join(outside, "a", "b"), { recursive: true });
      mkdirSync(join(outside, "a", "evil"));
      writeFileSync(join(outside, "a", "evil", "secret.txt"), "outside");
      symlinkSync(join(outside, "a", "b"), join(t.run, "lnk"));
      const evil = `${t.run}/lnk/../evil`;
      expect(readFileSync(`${evil}/secret.txt`, "utf8")).toBe("outside"); // the read really escapes
      expect(msg(decideRunDir(t.run, { ...paths(t.run), workDir: evil }, "x"))).toMatch(/not a normalized path/);
      expect(msg(decideRunDir(t.run, { ...paths(t.run), outputsDir: `${t.run}//work` }, "x"))).toMatch(/not a normalized path/);
      expect(msg(decideRunDir(t.run, { ...paths(t.run), outputsDir: `${t.run}/./work` }, "x"))).toMatch(/not a normalized path/);
      // The same in a relocated dir: never re-rooted.
      const gone = join(t.root, "gone", "abc");
      expect(msg(decideRunDir(t.run, { ...paths(gone), workDir: `${gone}/lnk/../evil` }, "x"))).toMatch(/not a normalized path/);
    } finally {
      t.done();
    }
  });

  it("(B) refuses a recorded dir that exists and is another — a string-prefix sibling included", () => {
    const t = tree();
    try {
      const sib = `${t.run}2`;
      mkdirSync(sib);
      expect(msg(decideRunDir(sib, paths(t.run), "x"))).toMatch(/was copied from .*, which is still there/);
    } finally {
      t.done();
    }
  });

  it("(B) names the way out: the original for a run-dir command, the runs root for hillclimb", () => {
    const t = tree();
    try {
      const sib = `${t.run}-copy`;
      mkdirSync(sib);
      expect(msg(decideRunDir(sib, paths(t.run), "regrade"))).toContain(`Re-run the scenario, or regrade the original at ${t.run}.`);
      const hc = msg(decideRunDir(sib, paths(t.run), "hillclimb regrade"));
      expect(hc).toContain(`point --run-dir at the runs root it was written under (${dirname(dirname(t.run))})`);
      expect(hc).not.toMatch(/hillclimb regrade the original/);
      expect(msg(decideRunDir(sib, paths(t.run), "hillclimb freeze-ref"))).toContain("--run-dir");
    } finally {
      t.done();
    }
  });

  it("(C) a gone recorded dir: each path inside it is re-rooted; one outside is unavailable", () => {
    const t = tree();
    try {
      const gone = "/home/runner/work/r/r/.cowork-harness/runs/scen/abc";
      const d = decideRunDir(t.run, { ...paths(gone), stderrLogPath: "/home/runner/elsewhere.log" }, "x");
      if (d.kind !== "relocated") throw new Error(msg(d));
      expect(d.paths).toEqual({
        outDir: t.run,
        workDir: join(t.run, "work", "session", "mnt"),
        outputsDir: join(t.run, "work", "session", "mnt", "outputs"),
      });
      expect(d.unavailable).toEqual([
        { field: "stderrLogPath", recorded: "/home/runner/elsewhere.log", why: "outside the recorded run dir" },
      ]);
      expect(d.note).toBe(
        `note: ${t.run} was recorded at ${gone} (no longer there); reading its evidence from ${t.run}; unavailable: stderrLogPath (outside the recorded run dir)`,
      );
    } finally {
      t.done();
    }
  });

  it("(C) a re-rooted path a link carries outside the dir is unavailable", () => {
    const t = tree();
    try {
      mkdirSync(join(t.root, "elsewhere"));
      rmSync(join(t.run, "work"), { recursive: true });
      symlinkSync(join(t.root, "elsewhere"), join(t.run, "work"));
      const d = decideRunDir(t.run, paths("/gone/runs/scen/abc"), "x");
      if (d.kind !== "relocated") throw new Error(msg(d));
      expect(d.paths.workDir).toBeUndefined();
      expect(d.paths.outputsDir).toBeUndefined();
      expect(d.unavailable.map((u) => u.field)).toEqual(["workDir", "outputsDir"]);
    } finally {
      t.done();
    }
  });

  it("refuses evidence paths with no recorded run dir; nothing recorded at all is the dir given", () => {
    const t = tree();
    try {
      const { outDir: _o, ...noOut } = paths(t.run);
      expect(msg(decideRunDir(t.run, noOut, "x"))).toMatch(/but no outDir/);
      expect(decideRunDir(t.run, {}, "x")).toEqual({ kind: "same", paths: {} });
    } finally {
      t.done();
    }
  });

  it("folds no case itself: the same dir named in another case is the same only where the filesystem says so", () => {
    const t = tree();
    try {
      const upper = join(dirname(t.run), basename(t.run).toUpperCase());
      // realpath.native returns the on-disk spelling, so a case-insensitive volume resolves both to one dir; on a
      // case-sensitive one the upper-case dir does not exist, so it is a gone recorded dir (relocated), never "same".
      if (existsSync(upper)) expect(kind(decideRunDir(upper, paths(t.run), "x"))).toBe("same");
      else expect(kind(decideRunDir(t.run, paths(upper), "x"))).toBe("relocated");
    } finally {
      t.done();
    }
  });
});

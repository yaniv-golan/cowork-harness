import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// F-1: verify-run re-evaluates a scenario's assert: against a kept run dir with NO live agent. Spawn-based
// (like cli-help.test.ts); needs dist/cli.js (the `ci` script builds before testing); skips otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

/** Build a kept-run dir: result.json + run.jsonl + trace.json + a workDir with one JSON artifact. */
function keptRun(): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-vr-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  writeFileSync(join(workDir, "outputs", "report.json"), JSON.stringify({ detected_stage: "seed" }));
  const result = {
    scenario: "smoke",
    fidelity: "container",
    baseline: "desktop-1.13576.1",
    result: "success",
    decisions: [],
    toolCounts: { Read: 2, Bash: 1 },
    gateDeliveries: [],
    egress: [{ host: "tracker.evil.com", decision: "deny" }],
    assertions: [],
    subagents: [{ agentType: "x", declaredTools: [], toolsUsed: ["Read"] }],
    outDir: root,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  };
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(
    join(root, "run.jsonl"),
    [
      JSON.stringify({ t: "run", scenario: "smoke" }),
      JSON.stringify({ t: "transcript", text: "the skill flagged the blank exclusivity field" }),
    ].join("\n"),
  );
  writeFileSync(join(root, "trace.json"), JSON.stringify({ questions: [], steps: ["Read", "Bash"] }));
  return root;
}

function scenarioFile(dir: string, assertYaml: string): string {
  const f = join(dir, "scenario.yaml");
  writeFileSync(f, `name: smoke\nprompt: do the thing\nfidelity: container\nassert:\n${assertYaml}`);
  return f;
}

function verifyRun(runDir: string, scenario: string) {
  const r = spawnSync("node", [CLI, "verify-run", runDir, scenario], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cwh-vrcwd-")) });
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

describe.skipIf(!can)("F-1: verify-run re-asserts a kept run dir without a live agent", () => {
  it("passes when every assertion holds (transcript + artifact_json + expect_denied)", () => {
    const run = keptRun();
    const sc = scenarioFile(
      run,
      [
        "  - transcript_matches: 'flagged the blank'",
        '  - artifact_json: { artifact: outputs/report.json, path: detected_stage, equals: "seed" }',
        "  - file_exists: outputs/report.json",
      ].join("\n") + "\nexpect_denied:\n  - tracker.evil.com\n",
    );
    const { code, text } = verifyRun(run, sc);
    expect(text).toContain("verify-run: all");
    expect(code).toBe(0);
  });

  it("FAILS (exit 1) when an assertion is wrong — and flips back to pass when corrected, no re-record", () => {
    const run = keptRun();
    const bad = scenarioFile(run, '  - artifact_json: { artifact: outputs/report.json, path: detected_stage, equals: "series-a" }');
    const fail = verifyRun(run, bad);
    expect(fail.code).toBe(1);
    expect(fail.text).toContain("failed");
    // Fix the assertion and re-verify the SAME run dir — proves iteration without a live agent.
    const good = scenarioFile(run, '  - artifact_json: { artifact: outputs/report.json, path: detected_stage, equals: "seed" }');
    const pass = verifyRun(run, good);
    expect(pass.code).toBe(0);
  });

  it("refuses (exit 2) a filesystem assertion when the work dir is gone (no false-fail)", () => {
    const run = keptRun();
    // Point result.workDir at a non-existent path to simulate container teardown.
    const result = JSON.parse(require("node:fs").readFileSync(join(run, "result.json"), "utf8"));
    result.workDir = join(run, "gone", "work");
    writeFileSync(join(run, "result.json"), JSON.stringify(result));
    const sc = scenarioFile(run, "  - file_exists: outputs/report.json");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(2);
    expect(text).toContain("work dir not found");
  });

  it("errors (exit 2) on a dir with no result.json", () => {
    const empty = mkdtempSync(join(tmpdir(), "cwh-empty-"));
    const sc = scenarioFile(empty, "  - result: success");
    const { code, text } = verifyRun(empty, sc);
    expect(code).toBe(2);
    expect(text).toContain("no result.json");
  });
});

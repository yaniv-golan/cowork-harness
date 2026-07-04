import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// verify-run re-evaluates a scenario's assert: against a kept run dir with NO live agent. Spawn-based
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

/** Build a kept-run dir for `no_unexpected_files`: one pre-existing artifact (carried in `preRunPaths`,
 *  so it does not count as newly created) plus one stray file the pre-run manifest never saw. */
function keptRunForUnexpectedFiles(): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-vr-nuf-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  writeFileSync(join(workDir, "outputs", "report.json"), JSON.stringify({ ok: true }));
  writeFileSync(join(workDir, "outputs", "stray.txt"), "unexpected");
  const result = {
    scenario: "smoke",
    fidelity: "container",
    baseline: "desktop-1.13576.1",
    result: "success",
    decisions: [],
    toolCounts: { Read: 1 },
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [],
    outDir: root,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
    userVisibleRoots: ["outputs"],
    preRunPaths: ["outputs/report.json"],
  };
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(root, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  writeFileSync(join(root, "trace.json"), JSON.stringify({ questions: [], steps: ["Read"] }));
  return root;
}

/** Build a kept-run dir that is missing one sidecar file. */
function keptRunWithout(sidecar: "transcript" | "questions"): string {
  const root = keptRun();
  if (sidecar === "transcript") require("node:fs").unlinkSync(join(root, "run.jsonl"));
  if (sidecar === "questions") require("node:fs").unlinkSync(join(root, "trace.json"));
  return root;
}

/** Build a kept-run dir whose transcript is present but empty (zero-length run.jsonl with no transcript line). */
function keptRunWithEmptyTranscript(): string {
  const root = keptRun();
  writeFileSync(join(root, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  return root;
}

/** Kept-run dir with a file written into a connected work folder mounted at the BARE name `project`.
 *  `withRoots` controls whether result.json persists userVisibleRoots (the new field) or omits it. */
function keptRunWithFolder(withRoots: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-vrf-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "project"), { recursive: true });
  writeFileSync(join(workDir, "project", "summary.md"), "MOUNTOK");
  const result: Record<string, unknown> = {
    scenario: "folder",
    fidelity: "cowork",
    baseline: "desktop-1.14271.0",
    result: "success",
    decisions: [],
    toolCounts: { Write: 1 },
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [],
    outDir: root,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  };
  if (withRoots) result.userVisibleRoots = ["outputs", "project"];
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(root, "run.jsonl"), JSON.stringify({ t: "run", scenario: "folder" }) + "\n");
  writeFileSync(join(root, "trace.json"), JSON.stringify({ questions: [], steps: ["Write"] }));
  return root;
}

/** Build a kept-run dir whose result.json OMITS one evidence field (simulates a partial/old result.json).
 *  In the verify-run lane an undefined field is "evidence absent", not "empty set". */
function keptRunWithout_field(field: "toolCounts" | "toolResults" | "subagents" | "scan"): string {
  const root = keptRun();
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(join(root, "result.json"), "utf8"));
  delete result[field];
  fs.writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  return root;
}

/** Build a kept-run dir whose result.json carries the evidence field PRESENT-but-EMPTY (proof-of-absence,
 *  the shape a real run with no tools/sub-agents/deletes produces). Must still green a negative assertion. */
function keptRunWithEmpty_field(field: "toolCounts" | "toolResults" | "subagents" | "scan"): string {
  const root = keptRun();
  const fs = require("node:fs");
  const result = JSON.parse(fs.readFileSync(join(root, "result.json"), "utf8"));
  if (field === "toolCounts") result.toolCounts = {};
  else if (field === "scan") result.scan = { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false };
  else result[field] = [];
  fs.writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
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

describe.skipIf(!can)("verify-run re-asserts a kept run dir without a live agent", () => {
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

  it("refuses a PARTIAL run (did not complete) rather than verifying its half-finished output", () => {
    const run = keptRun();
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(join(run, "result.json"), "utf8"));
    result.partial = true;
    result.result = "error";
    fs.writeFileSync(join(run, "result.json"), JSON.stringify(result, null, 2));
    // An assertion that WOULD pass on this kept run, so a non-zero exit can only come from the partial
    // guard — not an assertion miss.
    const sc = scenarioFile(run, "  - transcript_matches: 'flagged the blank'\n");
    const { code, text } = verifyRun(run, sc);
    expect(text).toMatch(/PARTIAL/);
    expect(code).toBe(2);
  });

  it("verify lane: user_visible_artifact under a BARE folder name passes via persisted userVisibleRoots", () => {
    const run = keptRunWithFolder(true);
    const sc = scenarioFile(run, "  - user_visible_artifact: project/summary.md");
    const { code, text } = verifyRun(run, sc);
    expect(text).toContain("verify-run: all");
    expect(code).toBe(0);
  });

  it("verify lane: the SAME artifact FAILS when userVisibleRoots is absent (legacy `.projects` fallback)", () => {
    // Proves the persisted roots are load-bearing: without them the bare-named folder file is invisible.
    const run = keptRunWithFolder(false);
    const sc = scenarioFile(run, "  - user_visible_artifact: project/summary.md");
    const { code } = verifyRun(run, sc);
    expect(code).toBe(1);
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

  it("FAILS with 'evidence unavailable' when run.jsonl is absent and transcript_not_contains is asserted", () => {
    const run = keptRunWithout("transcript");
    const sc = scenarioFile(run, '  - transcript_not_contains: "needle"');
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("run.jsonl");
  });

  it("FAILS with 'evidence unavailable' when trace.json is absent and questions_count_max: 0 is asserted", () => {
    const run = keptRunWithout("questions");
    const sc = scenarioFile(run, "  - questions_count_max: 0");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("trace.json");
  });

  it("PASSES when run.jsonl is present but empty-transcript and transcript_not_contains is asserted (absent ≠ empty)", () => {
    const run = keptRunWithEmptyTranscript();
    const sc = scenarioFile(run, '  - transcript_not_contains: "needle"');
    const { code } = verifyRun(run, sc);
    expect(code).toBe(0);
  });

  // evidence manifest in the verify-run lane: a partial/old result.json that OMITS an evidence
  // field must FAIL the corresponding negative/absence assertion loud (no false-green), while a field that
  // is present-but-empty (the real proof-of-absence shape) must still GREEN it.
  it("FAILS with 'evidence unavailable' when toolResults is absent and tool_result_not_contains is asserted", () => {
    const run = keptRunWithout_field("toolResults");
    const sc = scenarioFile(run, '  - tool_result_not_contains: "secret"');
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("tool_result_not_contains");
  });
  it("PASSES when toolResults is present-but-empty and tool_result_not_contains is asserted (absent ≠ empty)", () => {
    const run = keptRunWithEmpty_field("toolResults");
    const sc = scenarioFile(run, '  - tool_result_not_contains: "secret"');
    expect(verifyRun(run, sc).code).toBe(0);
  });

  it("FAILS with 'evidence unavailable' when toolCounts is absent and tool_not_called is asserted", () => {
    const run = keptRunWithout_field("toolCounts");
    const sc = scenarioFile(run, "  - tool_not_called: Bash");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("tool_not_called");
  });
  it("PASSES when toolCounts is present-but-empty and tool_not_called is asserted (absent ≠ empty)", () => {
    const run = keptRunWithEmpty_field("toolCounts");
    const sc = scenarioFile(run, "  - tool_not_called: Bash");
    expect(verifyRun(run, sc).code).toBe(0);
  });

  it("FAILS with 'evidence unavailable' when subagents is absent and subagent_tool_absent is asserted", () => {
    const run = keptRunWithout_field("subagents");
    const sc = scenarioFile(run, "  - subagent_tool_absent: Bash");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("subagent_tool_absent");
  });
  it("FAILS with 'evidence unavailable' when subagents is absent and dispatch_count_max is asserted", () => {
    const run = keptRunWithout_field("subagents");
    const sc = scenarioFile(run, "  - dispatch_count_max: 3");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("dispatch_count_max");
  });
  it("FAILS with 'evidence unavailable' when subagents is absent and subagent_declared_but_unused is asserted", () => {
    const run = keptRunWithout_field("subagents");
    const sc = scenarioFile(run, "  - subagent_declared_but_unused: Bash");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("subagent_declared_but_unused");
  });
  it("PASSES when subagents is present-but-empty and the subagent negatives are asserted (absent ≠ empty)", () => {
    const run = keptRunWithEmpty_field("subagents");
    const sc = scenarioFile(
      run,
      ["  - subagent_tool_absent: Bash", "  - dispatch_count_max: 3", "  - subagent_declared_but_unused: Bash"].join("\n"),
    );
    expect(verifyRun(run, sc).code).toBe(0);
  });

  it("FAILS with 'evidence unavailable' when scan is absent and no_delete_in_outputs is asserted", () => {
    const run = keptRunWithout_field("scan");
    const sc = scenarioFile(run, "  - no_delete_in_outputs: true");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("no_delete_in_outputs");
  });
  it("FAILS with 'evidence unavailable' when scan is absent and transcript_no_host_path is asserted", () => {
    const run = keptRunWithout_field("scan");
    const sc = scenarioFile(run, "  - transcript_no_host_path: true");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("transcript_no_host_path");
  });
  it("FAILS with 'evidence unavailable' when scan is absent and self_heal_ran is asserted", () => {
    const run = keptRunWithout_field("scan");
    const sc = scenarioFile(run, "  - self_heal_ran: false");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(1);
    expect(text).toContain("evidence unavailable");
    expect(text).toContain("self_heal_ran");
  });
  it("PASSES when scan is present-but-empty and the scan-derived negatives are asserted (absent ≠ empty)", () => {
    const run = keptRunWithEmpty_field("scan");
    const sc = scenarioFile(
      run,
      ["  - no_delete_in_outputs: true", "  - transcript_no_host_path: true", "  - self_heal_ran: false"].join("\n"),
    );
    expect(verifyRun(run, sc).code).toBe(0);
  });

  it("verify-run evaluates no_unexpected_files live on a kept run", () => {
    const run = keptRunForUnexpectedFiles();
    // Empty allowlist: the pre-existing report.json is carried in preRunPaths (not "created"), but
    // stray.txt is not — it must fail, naming the stray file.
    const bad = scenarioFile(run, "  - no_unexpected_files: []\n");
    const fail = verifyRun(run, bad);
    expect(fail.code).toBe(1);
    expect(fail.text).toContain("stray.txt");
    // Widen the allowlist to cover the stray file — same kept run dir, no re-record — and it flips green.
    const good = scenarioFile(run, "  - no_unexpected_files: ['outputs/stray.txt']\n");
    const pass = verifyRun(run, good);
    expect(pass.code).toBe(0);
  });

  it("refuses (exit 2) no_unexpected_files when the work dir is gone (no vacuous pass)", () => {
    const run = keptRunForUnexpectedFiles();
    // Point result.workDir at a non-existent path to simulate container teardown. Without this refusal,
    // a missing workRoot would walk to [] created files and vacuously PASS an empty allowlist — the
    // worse failure mode (false-green), unlike the other FS keys which false-fail safe.
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(join(run, "result.json"), "utf8"));
    result.workDir = join(run, "gone", "work");
    fs.writeFileSync(join(run, "result.json"), JSON.stringify(result));
    const sc = scenarioFile(run, "  - no_unexpected_files: []\n");
    const { code, text } = verifyRun(run, sc);
    expect(code).toBe(2);
    expect(text).toContain("work dir not found");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { regradeRuns, regradeEnvelope, type RegradeOptions } from "../src/run/regrade.js";
import { captureAuthoredFilesWithHealth, authoredFilesHealthNonEmpty, DEFAULT_AUTHORED_TOTAL_BYTES } from "../src/run/artifacts.js";
import { authoredCaptureOpts } from "../src/run/authored-capture-opts.js";
import { capturePreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { evaluate, runSemanticJudges, type AssertContext, type SemanticJudge } from "../src/assert.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import { collectSecrets } from "../src/secrets.js";
import { parseScenarioFile } from "../src/run/execute.js";
import type { LaunchPlan } from "../src/session.js";
import { slashInvokedSkillIds } from "../src/critique/skill-invocation.js";

// `regrade` re-grades a KEPT run's semantic_matches asserts. Every fixture is a real tree: a pre-run manifest
// captured by the production function, files authored after it, and a result.json whose `assertions[]` and
// `authoredCapture` come from the LIVE chain — the live capture (same option derivation execute.ts uses),
// `runSemanticJudges`, then `evaluate` — so `judgedDoc` is what a live run persists, not a hand-written copy.
// The regrade side never sees that chain: it rebuilds everything from the run dir. That is what makes
// `docMatchesLive: true` evidence rather than a function compared with itself.

const ENV_KEYS = [
  "COWORK_HARNESS_SCRUB_VALUES",
  "COWORK_HARNESS_AUTHORED_TOTAL_BYTES",
  "COWORK_HARNESS_JUDGE_MODEL",
  "COWORK_HARNESS_RUNS_DIR",
];
let saved: Record<string, string | undefined> = {};
let runsRoot: string;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  runsRoot = mkdtempSync(join(tmpdir(), "cwh-rg-runs-"));
  process.env.COWORK_HARNESS_RUNS_DIR = runsRoot;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function minimalPlan(): LaunchPlan {
  return {
    configDir: mkdtempSync(join(tmpdir(), "cwh-rg-cfg-")),
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    resume: false,
    capturePreRun: true,
  };
}

interface JudgeCall {
  model: string | undefined;
  rubric: string[];
  answer: string;
}

/** A judge double in the `judgesForRun` factory shape. `pass` decides each claim; every call is recorded
 *  with the document it was handed. */
function judgeFactory(pass: (claim: string, answer: string) => boolean, calls: JudgeCall[] = []) {
  const make = (o?: { model?: string }): SemanticJudge => {
    const j: SemanticJudge = async (rubric, answer) => {
      calls.push({ model: j.model, rubric, answer });
      j.lastCostUsd = 0.0123;
      j.lastUsage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      return rubric.map((claim, index) => ({ index, claim, pass: pass(claim, answer), rationale: `double says ${pass(claim, answer)}` }));
    };
    j.model = o?.model ?? "claude-opus-4-8";
    j.promptHash = JUDGE_PROMPT_HASH;
    return j;
  };
  return { make, calls };
}

const FINAL = "The report is in outputs/report.md.";
const TRANSCRIPT = "I read the input and wrote the report.";

function scenarioAt(dir: string, assertYaml: string): string {
  const f = join(dir, "scenario.yaml");
  writeFileSync(f, `name: rg\nprompt: write the report\nfidelity: container\nassert:\n${assertYaml}`);
  return f;
}

const SCOPED = `  - semantic_matches:\n      rubric: ["the report names the risk"]\n      evidence_files: ["outputs/report.md"]\n`;
const WIDER = `  - semantic_matches:\n      rubric: ["the report names the risk"]\n      evidence_files: ["outputs/report.md", "outputs/appendix.md"]\n`;
const WITH_OTHERS = `${SCOPED}  - file_exists: outputs/report.md\n  - tool_called: Write\n`;

interface Kept {
  runDir: string;
  workRoot: string;
  scenarioFile: string;
  resultPath: string;
}

/** A kept single-turn run, graded LIVE by `liveJudge` through the real chain. */
async function keptRun(opts: {
  author: (workRoot: string) => void;
  assertYaml?: string;
  liveJudge?: ReturnType<typeof judgeFactory>;
  /** The live capture's total budget (default: the default). */
  totalBytes?: number;
}): Promise<Kept> {
  const runDir = mkdtempSync(join(tmpdir(), "cwh-rg-"));
  const workRoot = join(runDir, "work", "session", "mnt");
  mkdirSync(join(workRoot, "outputs"), { recursive: true });
  writeFileSync(join(workRoot, "outputs", "input.md"), "pre-existing input\n");
  capturePreRunManifest(minimalPlan(), workRoot, runDir, "container");
  opts.author(workRoot);

  const scenarioFile = scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scn-")), opts.assertYaml ?? SCOPED);
  const scenario = parseScenarioFile(scenarioFile);
  // Exactly the live derivation (execute.ts): the evidence_files union, the env/default total budget.
  const priorityGlobs = [...new Set(scenario.assert.flatMap((a) => a.semantic_matches?.evidence_files ?? []))];
  const authored = captureAuthoredFilesWithHealth(
    workRoot,
    ["outputs"],
    [],
    readPreRunManifestHashes(runDir),
    authoredCaptureOpts({ workRoot, runDir, priorityGlobs, totalBytes: opts.totalBytes ?? DEFAULT_AUTHORED_TOTAL_BYTES }),
  );
  // The live producer's value for this prompt (no leading slash command, no staged skills).
  const slashInvokedSkills = slashInvokedSkillIds(scenario.prompt, [], { resultText: FINAL });
  const liveCtx: AssertContext = {
    transcript: TRANSCRIPT,
    finalMessage: FINAL,
    authoredFiles: authored.files,
    authoredFilesHealth: authoredFilesHealthNonEmpty(authored.health) ? authored.health : undefined,
    secrets: collectSecrets(),
    toolsCalled: new Set(["Write"]),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills,
  };
  const live = opts.liveJudge ?? judgeFactory(() => false);
  const j = live.make();
  await runSemanticJudges(scenario.assert, liveCtx, j);
  const assertions = evaluate(scenario.assert, liveCtx);

  const result = {
    scenario: "rg",
    prompt: scenario.prompt,
    slashInvokedSkills,
    fidelity: "container",
    result: "success",
    decisions: [],
    toolCounts: { Write: 1 },
    gateDeliveries: [],
    egress: [],
    assertions,
    subagents: [],
    finalMessage: FINAL,
    outDir: runDir,
    workDir: workRoot,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
    userVisibleRoots: ["outputs"],
    readonlyFolderRoots: [],
    preRunHashes: readPreRunManifestHashes(runDir),
    authoredCapture: { ...authored.budget, scratchpadWalked: authored.scratchpadWalked },
  };
  const t1 = join(runDir, "turns", "1");
  mkdirSync(t1, { recursive: true });
  const resultPath = join(t1, "result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  writeFileSync(
    join(t1, "run.jsonl"),
    [JSON.stringify({ t: "run", scenario: "rg" }), JSON.stringify({ t: "transcript", text: TRANSCRIPT })].join("\n"),
  );
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [] }));
  return { runDir, workRoot, scenarioFile, resultPath };
}

const REPORT = "# Report\nThe main risk is customer concentration.\n";
const writeReport = (w: string) => writeFileSync(join(w, "outputs", "report.md"), REPORT);

function opts(k: Kept, extra: Partial<RegradeOptions> = {}): RegradeOptions {
  return { runDirs: [k.runDir], scenarioFile: k.scenarioFile, ...extra };
}

function regradeFiles(k: Kept): string[] {
  const d = join(k.runDir, "turns", "1", "regrade");
  return existsSync(d) ? readdirSync(d).sort() : [];
}

describe("regrade: writes a new grade beside the run, never over it", () => {
  it("the regrade file carries the new grade; result.json is byte-identical; no run-index row", async () => {
    const k = await keptRun({ author: writeReport }); // live judge failed every claim
    const before = readFileSync(k.resultPath);
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    if (!out.ok) throw new Error(out.message);
    expect(out.exitCode).toBe(0);
    expect(readFileSync(k.resultPath).equals(before)).toBe(true);
    expect(existsSync(join(runsRoot, "index.jsonl"))).toBe(false);

    const files = regradeFiles(k);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^${JUDGE_PROMPT_HASH}-claude-opus-4-8-[0-9TZ.-]+\\.json$`));
    const file = JSON.parse(readFileSync(join(k.runDir, "turns", "1", "regrade", files[0]), "utf8"));
    expect(file.assertions).toHaveLength(1);
    const a = file.assertions[0];
    expect(a.pass).toBe(true);
    expect(a.semanticClaims).toEqual([{ index: 0, claim: "the report names the risk", pass: true, rationale: "double says true" }]);
    expect(a.judgeModel).toBe("claude-opus-4-8");
    expect(a.judgeCostUsd).toBeCloseTo(0.0123);
    expect(a.judgeUsage).toMatchObject({ input_tokens: 100, output_tokens: 10 });
    expect(a.judgePromptHash).toBe(JUDGE_PROMPT_HASH);
    expect(a.judgedDoc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.original.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    // The live grade stays what it was.
    expect(JSON.parse(before.toString()).assertions[0].pass).toBe(false);
  });

  it("two regrades with different judge models coexist", async () => {
    const k = await keptRun({ author: writeReport });
    const judge = judgeFactory(() => true);
    const a = await regradeRuns(opts(k, { makeJudge: judge.make, judgeModel: "claude-opus-4-8" }));
    const b = await regradeRuns(opts(k, { makeJudge: judge.make, judgeModel: "claude-sonnet-4-5-20250929" }));
    if (!a.ok || !b.ok) throw new Error("unexpected refusal");
    const files = regradeFiles(k);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes("-claude-opus-4-8-"))).toBe(true);
    expect(files.some((f) => f.includes("-claude-sonnet-4-5-20250929-"))).toBe(true);
    expect(judge.calls.map((c) => c.model)).toEqual(["claude-opus-4-8", "claude-sonnet-4-5-20250929"]);
  });

  it("the same model twice in a row does not overwrite the first file", async () => {
    const k = await keptRun({ author: writeReport });
    const judge = judgeFactory(() => true);
    const fixed = () => new Date("2026-09-30T12:00:00.000Z");
    await regradeRuns(opts(k, { makeJudge: judge.make, now: fixed }));
    await regradeRuns(opts(k, { makeJudge: judge.make, now: fixed }));
    expect(regradeFiles(k)).toHaveLength(2);
  });

  it("exit 1 when a re-graded assert fails; other asserts are reported, not re-graded", async () => {
    const k = await keptRun({ author: writeReport, assertYaml: WITH_OTHERS });
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => false).make }));
    if (!out.ok) throw new Error(out.message);
    expect(out.exitCode).toBe(1);
    expect(out.runs[0].assertions).toHaveLength(1);
    expect(out.runs[0].notRegraded).toEqual([
      { assertionIndex: 1, keys: ["file_exists"] },
      { assertionIndex: 2, keys: ["tool_called"] },
    ]);
  });
});

describe("regrade: is the judged document the one the live judge read?", () => {
  it("an untouched kept run → docMatchesLive true", async () => {
    const k = await keptRun({ author: writeReport });
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].docMatchesLive).toBe(true);
    expect(out.runs[0].differingSections).toEqual([]);
  });

  it("one authored file mutated in the kept mnt/ → false, naming that path (graded only with allowDocDrift)", async () => {
    const k = await keptRun({ author: writeReport });
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const judge = judgeFactory(() => true);
    const refused = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(refused).toMatchObject({ ok: false, kind: "runtime" });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.message).toMatch(/^regrade: .*the rebuilt judged document differs from the one the live judge read/);
    expect(refused.message).toContain("assert 0: changed authored outputs/report.md");
    expect(refused.message).toContain("--allow-doc-drift");
    expect(refused.message).toMatch(/\(can't verify ⇒ not green\)$/);
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(k)).toEqual([]);

    const out = await regradeRuns(opts(k, { makeJudge: judge.make, allowDocDrift: true }));
    if (!out.ok) throw new Error(out.message);
    expect(judge.calls).toHaveLength(1);
    expect(out.runs[0].docMatchesLive).toBe(false);
    expect(out.runs[0].differingSections).toEqual([{ assertionIndex: 0, kind: "authored", path: "outputs/report.md", change: "changed" }]);
    const file = JSON.parse(readFileSync(join(k.runDir, "turns", "1", "regrade", regradeFiles(k)[0]), "utf8"));
    expect(file.docMatchesLive).toBe(false);
    expect(file.differingSections).toEqual(out.runs[0].differingSections);
  });

  it("evidence_files changed in the scenario → scope_changed, with the section it added", async () => {
    // Live, the rubric was scoped to report.md; the new scenario widens it to the appendix too.
    const wider = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
      assertYaml: SCOPED,
    });
    const out = await regradeRuns({
      runDirs: [wider.runDir],
      scenarioFile: scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scn2-")), WIDER),
      makeJudge: judgeFactory(() => true).make,
    });
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].docMatchesLive).toBe("scope_changed");
    expect(out.runs[0].differingSections).toContainEqual({
      assertionIndex: 0,
      kind: "authored",
      path: "outputs/appendix.md",
      change: "added",
    });
  });

  it("the live run's persisted budget and priority globs are what the re-grade captures with", async () => {
    // A 1 KiB budget, and an intermediates dir that sorts before the deliverable: only the priority glob gets
    // the report captured whole, and only the persisted budget cuts the intermediates where the live run did.
    const k = await keptRun({
      author: (w) => {
        mkdirSync(join(w, "outputs", "_work"), { recursive: true });
        writeFileSync(join(w, "outputs", "_work", "junk.md"), "j".repeat(3000));
        writeReport(w);
      },
      assertYaml: `${SCOPED}  - semantic_matches:\n      rubric: ["the intermediates exist"]\n`,
      totalBytes: 1024,
    });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    expect(r.authoredCapture.totalBytes).toBe(1024);
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].docMatchesLive).toBe(true);
    // Overriding the budget is a changed scope, reported as such rather than as a match or a drift.
    const over = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make, authoredTotalBytes: 4096 }));
    if (!over.ok) throw new Error(over.message);
    expect(over.runs[0].docMatchesLive).toBe("scope_changed");
  });

  it("a secret this process does not scrub, but the live run did, is refused as drift before it reaches the judge", async () => {
    const SECRET = "sk-test-live-only-91f0";
    process.env.COWORK_HARNESS_SCRUB_VALUES = SECRET;
    const k = await keptRun({ author: (w) => writeFileSync(join(w, "outputs", "report.md"), `token: ${SECRET}\nrisk: concentration\n`) });
    delete process.env.COWORK_HARNESS_SCRUB_VALUES; // this process no longer knows it
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("COWORK_HARNESS_SCRUB_VALUES");
    expect(out.message).not.toContain(SECRET);
    expect(judge.calls).toHaveLength(0);
  });

  it("scope_changed and unknown are not drift: both grade", async () => {
    const k = await keptRun({ author: writeReport });
    const judge = judgeFactory(() => true);
    const scoped = await regradeRuns(opts(k, { makeJudge: judge.make, authoredTotalBytes: 4096 }));
    if (!scoped.ok) throw new Error(scoped.message);
    expect(scoped.runs[0].docMatchesLive).toBe("scope_changed");
    // An edited file under a changed scope is still scope_changed, never refused.
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const scopedDrift = await regradeRuns(opts(k, { makeJudge: judge.make, authoredTotalBytes: 4096 }));
    if (!scopedDrift.ok) throw new Error(scopedDrift.message);
    expect(scopedDrift.runs[0].docMatchesLive).toBe("scope_changed");

    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    for (const a of r.assertions) delete a.judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const unknown = await regradeRuns(opts(k, { makeJudge: judge.make }));
    if (!unknown.ok) throw new Error(unknown.message);
    expect(unknown.runs[0].docMatchesLive).toBe("unknown");
    expect(judge.calls).toHaveLength(3);
  });

  it("a batch whose second dir drifts judges nothing, not even the first", async () => {
    const good = await keptRun({ author: writeReport });
    const drifted = await keptRun({ author: writeReport });
    writeFileSync(join(drifted.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({ runDirs: [good.runDir, drifted.runDir], scenarioFile: good.scenarioFile, makeJudge: judge.make });
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain(drifted.runDir);
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(good)).toEqual([]);
  });

  it("a run with no persisted judgedDoc → unknown, never true", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    for (const a of r.assertions) delete a.judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].docMatchesLive).toBe("unknown");
  });
});

describe("regrade: refusals (exit 2), all before any judge call", () => {
  it("a run with no persisted authoredCapture is refused as evidence unavailable", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.authoredCapture;
    for (const a of r.assertions) delete a.judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toMatch(/^regrade: /);
    expect(out.message).toContain("evidence unavailable");
    expect(out.message).toContain("--authored-total-bytes");
    expect(judge.calls).toHaveLength(0);

    // ...and accepted with an explicit budget.
    const ok = await regradeRuns(opts(k, { makeJudge: judge.make, authoredTotalBytes: DEFAULT_AUTHORED_TOTAL_BYTES }));
    if (!ok.ok) throw new Error(ok.message);
    expect(ok.runs[0].docMatchesLive).toBe("unknown");
    expect(judge.calls).toHaveLength(1);
  });

  it("a pruned work dir is refused", async () => {
    const k = await keptRun({ author: writeReport });
    rmSync(join(k.runDir, "work"), { recursive: true, force: true });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toMatch(/^regrade: work dir not found/);
    expect(judge.calls).toHaveLength(0);
  });

  it("a missing transcript sidecar is refused, not graded over an empty transcript", async () => {
    const k = await keptRun({ author: writeReport });
    rmSync(join(k.runDir, "turns", "1", "run.jsonl"));
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toMatch(/^regrade: no readable transcript sidecar/);
    expect(out.message).toMatch(/\(can't verify ⇒ not green\)$/);
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(k)).toEqual([]);
  });

  it("a multi-turn run dir is refused", async () => {
    const k = await keptRun({ author: writeReport });
    mkdirSync(join(k.runDir, "turns", "2"));
    writeFileSync(join(k.runDir, "turns", "2", "run.jsonl"), "");
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toMatch(/^regrade: .* holds 2 turns/);
  });

  it("one bad run dir in a batch refuses the whole batch before the first judge call", async () => {
    const good = await keptRun({ author: writeReport });
    const bad = await keptRun({ author: writeReport });
    rmSync(join(bad.runDir, "work"), { recursive: true, force: true });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({ runDirs: [good.runDir, bad.runDir], scenarioFile: good.scenarioFile, makeJudge: judge.make });
    expect(out.ok).toBe(false);
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(good)).toEqual([]);
  });

  it("an alias judge model is refused", async () => {
    const k = await keptRun({ author: writeReport });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make, judgeModel: "opus" }));
    expect(out).toMatchObject({ ok: false, kind: "usage" });
    const perAssert = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(
        mkdtempSync(join(tmpdir(), "cwh-rg-scn3-")),
        `  - semantic_matches:\n      rubric: ["x"]\n      evidence_files: ["outputs/report.md"]\n      judge_model: sonnet\n`,
      ),
      makeJudge: judge.make,
    });
    expect(perAssert).toMatchObject({ ok: false, kind: "usage" });
    expect(judge.calls).toHaveLength(0);
  });

  it("a scenario with no semantic_matches assert is refused", async () => {
    const k = await keptRun({ author: writeReport });
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scn4-")), `  - file_exists: outputs/report.md\n`),
      makeJudge: judgeFactory(() => true).make,
    });
    expect(out).toMatchObject({ ok: false, kind: "usage" });
  });
});

describe("regrade: secrets", () => {
  it("a secret planted in an authored file never reaches the judge", async () => {
    const SECRET = "sk-test-planted-regrade-7c1e9a";
    process.env.COWORK_HARNESS_SCRUB_VALUES = SECRET;
    const k = await keptRun({ author: (w) => writeFileSync(join(w, "outputs", "report.md"), `token: ${SECRET}\nrisk: concentration\n`) });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    if (!out.ok) throw new Error(out.message);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].answer).toContain("## Authored file: outputs/report.md");
    expect(judge.calls[0].answer).toContain("[REDACTED]");
    expect(judge.calls[0].answer).not.toContain(SECRET);
    // Scrubbed identically on both sides, so the document still matches the live one.
    expect(out.runs[0].docMatchesLive).toBe(true);
  });
});

describe("regrade: spend, provenance and invalid grades", () => {
  it("the regrade file carries harnessVersion, the per-run judge spend, and the counts", async () => {
    const k = await keptRun({ author: writeReport, assertYaml: `${SCOPED}  - semantic_matches:\n      rubric: ["another claim"]\n` });
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    if (!out.ok) throw new Error(out.message);
    const file = JSON.parse(readFileSync(out.runs[0].regradeFile, "utf8"));
    expect(file.harnessVersion).toBe(JSON.parse(regradeEnvelope(out)).version);
    expect(file.judgeCostUsd).toBeCloseTo(0.0246);
    expect(file.unpricedGrades).toBe(0);
    expect(file).toMatchObject({ regraded: 2, invalidGrades: 0 });
    expect(out.runs[0].judgeCostUsd).toBeCloseTo(0.0246);
  });

  it("an unpriced grade leaves the total a floor, and none priced leaves it absent — never $0", async () => {
    const k = await keptRun({ author: writeReport, assertYaml: `${SCOPED}  - semantic_matches:\n      rubric: ["another claim"]\n` });
    let n = 0;
    const half = (o?: { model?: string }): SemanticJudge => {
      const j = judgeFactory(() => true).make(o);
      const inner: SemanticJudge = async (rubric, answer) => {
        const r = await j(rubric, answer);
        inner.lastCostUsd = n++ === 0 ? 0.01 : undefined;
        return r;
      };
      inner.model = j.model;
      inner.promptHash = j.promptHash;
      return inner;
    };
    const out = await regradeRuns(opts(k, { makeJudge: half }));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].judgeCostUsd).toBeCloseTo(0.01);
    expect(out.runs[0].unpricedGrades).toBe(1);

    const none = (o?: { model?: string }): SemanticJudge => {
      const j = judgeFactory(() => true).make(o);
      const inner: SemanticJudge = async (rubric, answer) => j(rubric, answer);
      inner.model = j.model;
      inner.promptHash = j.promptHash;
      return inner;
    };
    const unpriced = await regradeRuns(opts(k, { makeJudge: none }));
    if (!unpriced.ok) throw new Error(unpriced.message);
    expect(unpriced.runs[0].judgeCostUsd).toBeUndefined();
    expect(unpriced.runs[0].unpricedGrades).toBe(2);
    const env = JSON.parse(regradeEnvelope(unpriced));
    expect(env.judgeCostUsd).toBeUndefined();
    expect(env.unpricedGrades).toBe(2);
  });

  it("the envelope carries the overall spend across run dirs", async () => {
    const a = await keptRun({ author: writeReport });
    const b = await keptRun({ author: writeReport });
    const out = await regradeRuns({
      runDirs: [a.runDir, b.runDir],
      scenarioFile: a.scenarioFile,
      makeJudge: judgeFactory(() => true).make,
    });
    if (!out.ok) throw new Error(out.message);
    const env = JSON.parse(regradeEnvelope(out));
    expect(env.judgeCostUsd).toBeCloseTo(0.0246);
    expect(env.unpricedGrades).toBe(0);
    expect(env.runs.map((r: { judgeCostUsd: number }) => r.judgeCostUsd)).toEqual([expect.closeTo(0.0123), expect.closeTo(0.0123)]);
  });

  it("an all-invalid round is written, exits 1, and says so in the file", async () => {
    const k = await keptRun({ author: writeReport });
    const broken = (o?: { model?: string }): SemanticJudge => {
      const j: SemanticJudge = async () => {
        j.lastCostUsd = 0.002; // a failed attempt is still paid
        throw new Error("judge transport down");
      };
      j.model = o?.model ?? "claude-opus-4-8";
      j.promptHash = JUDGE_PROMPT_HASH;
      return j;
    };
    const out = await regradeRuns(opts(k, { makeJudge: broken }));
    if (!out.ok) throw new Error(out.message);
    expect(out.exitCode).toBe(1);
    expect(out.runs[0].invalidGrades).toBe(1);
    const file = JSON.parse(readFileSync(out.runs[0].regradeFile, "utf8"));
    expect(file).toMatchObject({ regraded: 1, invalidGrades: 1 });
    expect(file.assertions[0].judgeInvalid).toBe(true);
    expect(file.judgeCostUsd).toBeCloseTo(0.004); // two attempts
  });

  it("the written file is scrubbed as a whole document with this process's secrets", async () => {
    // A secret the judged document never carries (it is only in the scenario's rubric) still leaves the file scrubbed.
    const SECRET = "sk-test-rubric-only-4b2d";
    process.env.COWORK_HARNESS_SCRUB_VALUES = SECRET;
    const k = await keptRun({ author: writeReport });
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(
        mkdtempSync(join(tmpdir(), "cwh-rg-scn5-")),
        `  - semantic_matches:\n      rubric: ["the report never mentions ${SECRET}"]\n      evidence_files: ["outputs/report.md"]\n`,
      ),
      makeJudge: judgeFactory(() => true).make,
    });
    if (!out.ok) throw new Error(out.message);
    const text = readFileSync(out.runs[0].regradeFile, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[REDACTED]");
  });

  it("the same run dir named twice is graded once", async () => {
    const k = await keptRun({ author: writeReport });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({ runDirs: [k.runDir, join(k.runDir, ".")], scenarioFile: k.scenarioFile, makeJudge: judge.make });
    if (!out.ok) throw new Error(out.message);
    expect(out.runs).toHaveLength(1);
    expect(judge.calls).toHaveLength(1);
    expect(regradeFiles(k)).toHaveLength(1);
  });
});

describe("regrade: JSON envelope", () => {
  it("is payload-shaped: {tool, version, command, ok, runs[], error:null}", async () => {
    const k = await keptRun({ author: writeReport });
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => false).make }));
    if (!out.ok) throw new Error(out.message);
    const env = JSON.parse(regradeEnvelope(out));
    expect(env).toMatchObject({ tool: "cowork-harness", command: "regrade", ok: false, error: null });
    expect(typeof env.version).toBe("string");
    expect(env.results).toBeUndefined();
    expect(env.runs).toHaveLength(1);
    expect(env.runs[0]).toMatchObject({ pass: false, docMatchesLive: true });
    expect(env.runs[0].regradeFile).toContain(join("turns", "1", "regrade"));
    expect(env.runs[0].assertions[0]).toMatchObject({ assertionIndex: 0, pass: false });
  });
});

// The CLI wiring, on paths that never reach a judge (the unit lane must not spawn one).
const CLI = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI))("regrade CLI", () => {
  const cli = (args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, COWORK_HARNESS_OUTPUT_FORMAT: undefined };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("--scenario is required (usage, exit 2, JSON error envelope)", () => {
    const r = cli(["regrade", "somedir", "--output-format", "json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: "regrade", ok: false, error: { category: "usage" } });
  });

  it("a pre-release run is refused with exit 2 and a runtime envelope; stdout is empty in text mode", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.authoredCapture;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const j = cli(["regrade", k.runDir, "--scenario", k.scenarioFile, "--output-format", "json"]);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.stdout)).toMatchObject({ command: "regrade", ok: false, error: { category: "runtime" } });
    const t = cli(["regrade", k.runDir, "--scenario", k.scenarioFile]);
    expect(t.code).toBe(2);
    expect(t.stdout).toBe("");
    expect(t.stderr).toContain("evidence unavailable");
  });

  it("--allow-doc-drift is accepted (the refusal that follows is the run's, not a usage error)", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.authoredCapture;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const j = cli(["regrade", k.runDir, "--scenario", k.scenarioFile, "--allow-doc-drift", "--output-format", "json"]);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.stdout)).toMatchObject({ command: "regrade", ok: false, error: { category: "runtime" } });
  });

  it("a non-numeric --authored-total-bytes is a usage error", () => {
    const r = cli(["regrade", "somedir", "--scenario", "s.yaml", "--authored-total-bytes", "0.5"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--authored-total-bytes");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  compareWithLive,
  regradeRuns,
  regradeEnvelope,
  regradeFileStem,
  regradeTextReport,
  regradeErrorEnvelope,
  type RegradeOptions,
} from "../src/run/regrade.js";
import Ajv from "ajv";
import { jsonError } from "../src/run/envelope.js";
import { captureAuthoredFilesWithHealth, authoredFilesHealthNonEmpty, DEFAULT_AUTHORED_TOTAL_BYTES } from "../src/run/artifacts.js";
import { authoredCaptureOpts } from "../src/run/authored-capture-opts.js";
import { capturePreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { composeJudgedDocument, evaluate, runSemanticJudges, type AssertContext, type SemanticJudge } from "../src/assert.js";
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
  /** Record a `judgedDoc` for every live assert that refused its evidence, as a run recorded while the harness
   *  still called the judge before deciding a refusal did — the fingerprint of the document that judge was
   *  handed, composed by the production function. Off, a refused assert records none (the judge is not called). */
  oldRunRefusedJudgedDoc?: boolean;
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
  if (opts.oldRunRefusedJudgedDoc) {
    expect(liveCtx.semanticRefused?.size ?? 0).toBeGreaterThan(0);
    for (const a of liveCtx.semanticRefused!.keys())
      liveCtx.judgedDocs!.set(
        a,
        composeJudgedDocument(liveCtx, a.semantic_matches!.include_subagent_text === true, a.semantic_matches!.evidence_files).fingerprint,
      );
  }
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

/** Capture what the code under test writes to stderr (the `::warning::` lines). */
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return { text: () => buf, restore: () => void (process.stderr.write = orig) };
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
    expect(refused.message).toMatch(/^regrade: .*the judged document differs from the one the live judge read/);
    expect(refused.message).toContain("live assert 0: changed authored outputs/report.md");
    expect(refused.message).toContain("--allow-doc-drift");
    expect(refused.message).toMatch(/\(can't verify ⇒ not green\)$/);
    expect(refused.code).toBe("doc_drift");
    expect(refused.refusals).toEqual([
      {
        runDir: k.runDir,
        code: "doc_drift",
        liveDocDrift: [{ liveAssertionIndex: 0, sections: [{ kind: "authored", path: "outputs/report.md", change: "changed" }] }],
      },
    ]);
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(k)).toEqual([]);

    // --allow-doc-drift alone grades it: the mutated bytes ARE in the document rebuilt from the live inputs, so they
    // are drift (accepted and reported), not unchecked content.
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns(opts(k, { makeJudge: judge.make, allowDocDrift: true }));
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    // Said before the spend, naming the file.
    expect(stderr.text()).toMatch(
      /::warning:: regrade: .*the kept evidence differs from what the live judge read \(live assert 0: changed authored outputs\/report\.md\) — grading anyway \(--allow-doc-drift\)/,
    );
    expect(judge.calls).toHaveLength(1);
    expect(out.runs[0].docMatchesLive).toBe(false);
    expect(out.runs[0].uncheckedSections).toEqual([]);
    expect(out.runs[0].uncheckedCount).toBe(0);
    expect(out.runs[0].liveDocDrift).toEqual([
      { liveAssertionIndex: 0, sections: [{ kind: "authored", path: "outputs/report.md", change: "changed" }] },
    ]);
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
      allowUnchecked: true, // the appendix is content the live judge never read
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
    // Live, the 1 KiB budget cut the intermediates, so the unscoped assert refused and its judge was not called.
    expect(r.assertions[1].semanticEvidence.reason).toBe("evidence_incomplete");
    expect(r.assertions[1].judgedDoc).toBeUndefined();
    const judge = judgeFactory(() => true);
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    // The scoped assert's document is the live one (the priority glob kept the report whole); the unscoped one
    // refuses exactly as it did live — proof the persisted 1 KiB budget, not the default, cut the intermediates.
    expect(out.runs[0].assertions.map((a) => a.docMatchesLive)).toEqual([true, "not_graded"]);
    expect(out.runs[0].assertions[1].semanticEvidence?.reason).toBe("evidence_incomplete");
    expect(out.runs[0].docMatchesLive).toBe(true);
    expect(judge.calls).toHaveLength(1);
    // Nothing is sent for the refusing assert, so nothing about its document is warned about.
    expect(stderr.text()).not.toContain("::warning:: regrade:");
    // Overriding the budget is a changed scope, reported as such rather than as a match or a drift; the larger
    // budget lets the unscoped assert grade, against a live assert that refused with no fingerprint — live_refused,
    // which outranks scope_changed at the run level.
    // The larger budget brings in intermediates no live judge read: refused without --allow-unchecked.
    const refusedOver = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make, authoredTotalBytes: 4096 }));
    expect(refusedOver).toMatchObject({ ok: false, kind: "runtime", code: "unchecked_content" });
    const over = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make, authoredTotalBytes: 4096, allowUnchecked: true }));
    if (!over.ok) throw new Error(over.message);
    expect(over.runs[0].assertions.map((a) => a.docMatchesLive)).toEqual(["scope_changed", "live_refused"]);
    expect(over.runs[0].docMatchesLive).toBe("live_refused");
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

  it("a changed scope does not hide a secret the live run scrubbed: the live document is rebuilt and checked too", async () => {
    // Live: unscoped, with the secret known and scrubbed. Re-grade: the secret unknown, and the scope narrowed
    // to the file — the graded document is scope_changed by design, but the LIVE one no longer rebuilds.
    const SECRET = "sk-test-scope-probe-5e7a";
    process.env.COWORK_HARNESS_SCRUB_VALUES = SECRET;
    const k = await keptRun({
      author: (w) => writeFileSync(join(w, "outputs", "report.md"), `token: ${SECRET}\nrisk: concentration\n`),
      assertYaml: `  - semantic_matches:\n      rubric: ["the report names the risk"]\n`,
    });
    delete process.env.COWORK_HARNESS_SCRUB_VALUES;
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scn6-")), SCOPED),
      makeJudge: judge.make,
    });
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("live assert 0: changed authored outputs/report.md");
    expect(judge.calls).toHaveLength(0);
    // The budget override is a changed scope too, and gets the same check.
    const flagged = await regradeRuns(opts(k, { makeJudge: judge.make, authoredTotalBytes: 4096 }));
    expect(flagged).toMatchObject({ ok: false, kind: "runtime" });
    expect(judge.calls).toHaveLength(0);
  });

  it("content only a larger budget brings in is refused, and with --allow-unchecked graded, warned about and listed", async () => {
    // Live: a 150-byte budget cuts z-notes.md (it sorts last), outside the live assert's scope, so the live grade
    // stands. Re-grade: unscoped, with a far larger budget that captures it whole — content the live judge never
    // read, so no live fingerprint can vouch for it.
    const SECRET = "sk-test-budget-probe-3f19";
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "z-notes.md"), `notes: ${SECRET}\n${"n".repeat(400)}\n`);
      },
      assertYaml: SCOPED,
      totalBytes: 150,
    });
    expect(JSON.parse(readFileSync(k.resultPath, "utf8")).assertions[0].semanticEvidence.reason).toBe("graded");
    const judge = judgeFactory(() => true);
    const scenarioFile = scenarioAt(
      mkdtempSync(join(tmpdir(), "cwh-rg-scn11-")),
      `  - semantic_matches:\n      rubric: ["the report names the risk"]\n`,
    );
    const refused = await regradeRuns({ runDirs: [k.runDir], scenarioFile, makeJudge: judge.make, authoredTotalBytes: 1_000_000 });
    expect(refused).toMatchObject({ ok: false, kind: "runtime", code: "unchecked_content" });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.message).toContain("assert 0: authored outputs/z-notes.md");
    expect(refused.message).toContain("--allow-unchecked");
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(k)).toEqual([]);
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns({
        runDirs: [k.runDir],
        scenarioFile,
        makeJudge: judge.make,
        authoredTotalBytes: 1_000_000,
        allowUnchecked: true,
      });
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(judge.calls).toHaveLength(1);
    expect(out.runs[0].docMatchesLive).toBe("scope_changed");
    expect(out.runs[0].uncheckedSections).toContainEqual({ assertionIndex: 0, kind: "authored", path: "outputs/z-notes.md" });
    expect(out.runs[0].uncheckedCount).toBe(out.runs[0].uncheckedSections.length);
    expect(stderr.text()).toMatch(
      /::warning:: regrade: .*never read by the live judge.*outputs\/z-notes\.md.*never checked for drift or for a secret the live run scrubbed/s,
    );
    const file = JSON.parse(readFileSync(out.runs[0].regradeFile, "utf8"));
    expect(file.uncheckedSections).toEqual(out.runs[0].uncheckedSections);
    expect(file.uncheckedCount).toBe(out.runs[0].uncheckedCount);
  });

  it("content only a widened scope brings in is refused, and with --allow-unchecked warned about and listed", async () => {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
      assertYaml: SCOPED,
    });
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns({
        runDirs: [k.runDir],
        scenarioFile: scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scn9-")), WIDER),
        makeJudge: judgeFactory(() => true).make,
        allowUnchecked: true,
      });
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].uncheckedSections).toEqual([{ assertionIndex: 0, kind: "authored", path: "outputs/appendix.md" }]);
    expect(stderr.text()).toContain("outputs/appendix.md");
  });

  it("an unchanged scope has no unchecked sections and no warning", async () => {
    const k = await keptRun({ author: writeReport });
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].uncheckedSections).toEqual([]);
    expect(stderr.text()).not.toContain("never read by the live judge");
  });

  it("a live scope on a file over the per-file cap, re-graded unscoped, is not refused as drift", async () => {
    // Live, the scope exempts report.md from the 16 KiB per-file cap. The live document must be rebuilt with
    // the LIVE union as priority globs, or it would read the file capped and report a false drift.
    const big = `# Report\n${"The main risk is customer concentration.\n".repeat(600)}`;
    expect(big.length).toBeGreaterThan(16 * 1024);
    const k = await keptRun({ author: (w) => writeFileSync(join(w, "outputs", "report.md"), big), assertYaml: SCOPED });
    const judge = judgeFactory(() => true);
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns({
        runDirs: [k.runDir],
        scenarioFile: scenarioAt(
          mkdtempSync(join(tmpdir(), "cwh-rg-scn10-")),
          `  - semantic_matches:\n      rubric: ["the report names the risk"]\n`,
        ),
        makeJudge: judge.make,
      });
    } finally {
      stderr.restore();
    }
    // No drift refusal: the live (scoped) document was rebuilt with the live union and matched. The re-grade's
    // own unscoped assert then refuses the capped file on its own terms (evidence-unavailable) — visible in its
    // pass/message — so no judge is called and nothing is compared.
    if (!out.ok) throw new Error(out.message);
    expect(judge.calls).toHaveLength(0);
    const a = out.runs[0].assertions[0];
    expect(a.semanticEvidence?.reason).toBe("evidence_incomplete");
    expect(a.pass).toBe(false);
    expect(a.docMatchesLive).toBe("not_graded");
    expect(out.runs[0].docMatchesLive).toBe("not_graded");
    // The capped report is in a document no judge receives: no "never read by the live judge" warning for it.
    expect(stderr.text()).not.toContain("::warning:: regrade:");
  });

  it("unknown: graded, warned before the judge call that nothing was drift- or secret-checked", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    for (const a of r.assertions) delete a.judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const judge = judgeFactory(() => true);
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(out.exitCode).toBe(0);
    expect(out.runs[0].docMatchesLive).toBe("unknown");
    expect(stderr.text()).toMatch(
      /::warning:: regrade: .*assert 0: unknown.*could not be checked for drift or for a secret the live run scrubbed/s,
    );
    expect(judge.calls).toHaveLength(1);
  });

  it("a live assert that refused its evidence but recorded a judgedDoc is still drift-checked", async () => {
    // A harness that called the judge before refusing recorded the document that judge read: valid evidence.
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    r.assertions[0].semanticEvidence = { reason: "in_scope_omitted", paths: ["outputs/report.md"] };
    expect(r.assertions[0].judgedDoc).toBeDefined();
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("live assert 0: changed authored outputs/report.md");
    expect(judge.calls).toHaveLength(0);
  });

  it("live_refused: the live assert refused its evidence and recorded no fingerprint — graded and warned", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    r.assertions[0].semanticEvidence = { reason: "in_scope_omitted", paths: ["outputs/report.md"] };
    delete r.assertions[0].judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    // An edit that would be drift against a graded live assert is not refused here: there is nothing to check it against.
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const judge = judgeFactory(() => true);
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].assertions[0].docMatchesLive).toBe("live_refused");
    expect(out.runs[0].docMatchesLive).toBe("live_refused");
    expect(out.runs[0].differingSections).toEqual([]);
    expect(stderr.text()).toContain("assert 0: live_refused");
    expect(regradeTextReport(out).join("\n")).toContain("the live assert refused its evidence and no fingerprint was recorded");
  });

  // An unscoped assert over a file past the 16 KiB per-file cap refuses evidence-unavailable, and no judge is
  // called for it, live or re-graded. A run recorded while the harness still called the judge before refusing
  // DID record a judgedDoc for it, and such kept runs are still re-graded: `overCapRun` builds one.
  const BIG = `# Notes\n${"Concentration is the main risk.\n".repeat(700)}`;
  const UNSCOPED = `  - semantic_matches:\n      rubric: ["the notes name the risk"]\n`;
  async function overCapRun(assertYaml: string): Promise<Kept> {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "big.md"), BIG);
      },
      assertYaml,
      oldRunRefusedJudgedDoc: true,
    });
    const live = JSON.parse(readFileSync(k.resultPath, "utf8")).assertions.find(
      (a: { assertion: { semantic_matches?: { evidence_files?: string[] } } }) =>
        a.assertion.semantic_matches && !a.assertion.semantic_matches.evidence_files,
    );
    expect(live.semanticEvidence.reason).not.toBe("graded");
    expect(live.judgedDoc).toBeDefined();
    writeFileSync(join(k.workRoot, "outputs", "big.md"), BIG.replace("Concentration", "Churn"));
    return k;
  }

  it("an old run whose refused live assert recorded a judgedDoc: a drift in its document is refused before any judge call", async () => {
    const k = await overCapRun(UNSCOPED);
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("live assert 0: changed authored outputs/big.md");
    expect(judge.calls).toHaveLength(0);
  });

  it("an old run's drifted refused assert, re-graded with --allow-doc-drift, still refuses: not_graded, no judge call", async () => {
    const k = await overCapRun(UNSCOPED);
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make, allowDocDrift: true }));
    if (!out.ok) throw new Error(out.message);
    const a = out.runs[0].assertions[0];
    expect(a.pass).toBe(false); // the refusal stays visible on the assert itself
    expect(a.semanticEvidence?.reason).toBe("evidence_incomplete");
    expect(a.docMatchesLive).toBe("not_graded");
    expect(a.judgedDoc).toBeUndefined();
    // The per-assert value describes the assert's own document (none was handed to a judge). The run level
    // reports the drift that was detected and accepted, naming the file, even though nothing was graded.
    expect(out.runs[0].docMatchesLive).toBe(false);
    expect(out.runs[0].liveDocDrift).toEqual([
      { liveAssertionIndex: 0, sections: [{ kind: "authored", path: "outputs/big.md", change: "changed" }] },
    ]);
    expect(out.runs[0].differingSections).toEqual([]);
    expect(judge.calls).toHaveLength(0);
    expect(regradeTextReport(out).join("\n")).toContain("live assert 0: changed authored outputs/big.md");
  });

  it("an old run with a graded sibling: the drift in the refused assert's document is still refused", async () => {
    // The scoped sibling's document matches; the refused assert's recorded one does not. The drift check runs over
    // every live assert with a judgedDoc, refused or not, so the sibling's match cannot hide it.
    const k = await overCapRun(`${UNSCOPED}${SCOPED}`);
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make }));
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("live assert 0: changed authored outputs/big.md");
    expect(out.message).not.toContain("live assert 1");
    expect(judge.calls).toHaveLength(0);
    // Accepting the drift: only the sibling is graded, and its document IS the live one. The refused assert sent
    // nothing, so it contributes nothing to the run's value.
    const allowed = await regradeRuns(opts(k, { makeJudge: judge.make, allowDocDrift: true }));
    if (!allowed.ok) throw new Error(allowed.message);
    // The sibling's own document IS the live one, so it stays true; the run level never reports true over a drift
    // that was detected and accepted, and names the file.
    expect(allowed.runs[0].assertions.map((x) => x.docMatchesLive)).toEqual(["not_graded", true]);
    expect(allowed.runs[0].docMatchesLive).toBe(false);
    expect(allowed.runs[0].liveDocDrift).toEqual([
      { liveAssertionIndex: 0, sections: [{ kind: "authored", path: "outputs/big.md", change: "changed" }] },
    ]);
    expect(allowed.runs[0].uncheckedSections).toEqual([]);
    expect(regradeTextReport(allowed).join("\n")).toContain("outputs/big.md");
    expect(judge.calls).toHaveLength(1);
  });

  it("not_graded only when the re-grade's assert refused AND no document was handed to a judge", async () => {
    // End to end every refusal is not_graded now (no judge is called for it); the compare-first rule for a
    // refusal that DID come with a document is pinned on the comparison.
    const k = await keptRun({ author: writeReport });
    const live = JSON.parse(readFileSync(k.resultPath, "utf8"));
    const sc = parseScenarioFile(k.scenarioFile);
    const a = sc.assert[0];
    const side = { liveSemantic: live.assertions, captureMoved: false };
    expect(compareWithLive(a, 0, 0, undefined, side, true).match).toBe("not_graded");
    expect(compareWithLive(a, 0, 0, live.assertions[0].judgedDoc, side, true).match).toBe(true);
    expect(compareWithLive(a, 0, 0, undefined, side, false).match).toBe("unknown");
  });

  it("an assert whose own scope has no live fingerprint is unknown and warned, even when another scope has one", async () => {
    const k = await keptRun({ author: writeReport, assertYaml: `${SCOPED}${UNSCOPED}` });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.assertions[1].judgedDoc; // the unscoped one; the scoped one keeps its fingerprint
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].assertions.map((x) => x.docMatchesLive)).toEqual([true, "unknown"]);
    expect(out.runs[0].docMatchesLive).toBe("unknown");
    expect(stderr.text()).toContain("assert 1: unknown");
  });

  it("the run level ranks the unchecked values above scope_changed", async () => {
    const k = await keptRun({ author: writeReport, assertYaml: `${SCOPED}${UNSCOPED}` });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.assertions[1].judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    // A budget override makes every comparable assert scope_changed; the unscoped one stays unknown.
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make, authoredTotalBytes: 4096 }));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].assertions.map((x) => x.docMatchesLive)).toEqual(["scope_changed", "unknown"]);
    expect(out.runs[0].docMatchesLive).toBe("unknown");
  });

  it("the file-name rule for a round in which no judge ran: the requested model, else not-graded", () => {
    // Not reachable end to end while a judge model is always recorded; this pins the naming rule itself.
    const at = "2026-10-01T00:00:00.000Z";
    expect(regradeFileStem([{}], undefined, at)).toBe("no-prompt-hash-not-graded-2026-10-01T00-00-00.000Z");
    expect(regradeFileStem([{}], "claude-opus-4-8", at)).toBe("no-prompt-hash-claude-opus-4-8-2026-10-01T00-00-00.000Z");
    expect(regradeFileStem([{ judgeModel: "m1", judgePromptHash: "h" }, {}], undefined, at)).toBe("h-m1-2026-10-01T00-00-00.000Z");
  });

  it("scope_changed and unknown are not drift: both grade", async () => {
    const k = await keptRun({ author: writeReport });
    const judge = judgeFactory(() => true);
    const scoped = await regradeRuns(opts(k, { makeJudge: judge.make, authoredTotalBytes: 4096 }));
    if (!scoped.ok) throw new Error(scoped.message);
    expect(scoped.runs[0].docMatchesLive).toBe("scope_changed");
    // A changed scope does not excuse drift: the live document, rebuilt from the live inputs, no longer matches.
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const scopedDrift = await regradeRuns(opts(k, { makeJudge: judge.make, authoredTotalBytes: 4096 }));
    expect(scopedDrift).toMatchObject({ ok: false, kind: "runtime" });

    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    for (const a of r.assertions) delete a.judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const unknown = await regradeRuns(opts(k, { makeJudge: judge.make }));
    if (!unknown.ok) throw new Error(unknown.message);
    expect(unknown.runs[0].docMatchesLive).toBe("unknown");
    expect(judge.calls).toHaveLength(2);
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

  it("a secret only in the rubric reaches none of the outputs: file, envelope, text report", async () => {
    const SECRET = "sk-test-rubric-sinks-0c3d";
    process.env.COWORK_HARNESS_SCRUB_VALUES = SECRET;
    const k = await keptRun({ author: writeReport });
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(
        mkdtempSync(join(tmpdir(), "cwh-rg-scn7-")),
        `  - semantic_matches:\n      rubric: ["the report never mentions ${SECRET}"]\n      evidence_files: ["outputs/report.md"]\n`,
      ),
      makeJudge: judgeFactory(() => false).make, // a failing claim, so the message echoes it too
    });
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].assertions[0].semanticClaims?.[0].claim).toContain(SECRET); // the in-memory report is raw
    const sinks = {
      file: readFileSync(out.runs[0].regradeFile, "utf8"),
      envelope: regradeEnvelope(out),
      text: regradeTextReport(out).join("\n"),
    };
    for (const [name, text] of Object.entries(sinks)) {
      expect(text, name).not.toContain(SECRET);
      expect(text, name).toContain("[REDACTED]");
    }
  });

  it("a refusal message is scrubbed too", async () => {
    const SECRET = "sk-test-in-a-path-77aa";
    process.env.COWORK_HARNESS_SCRUB_VALUES = SECRET;
    const k = await keptRun({ author: writeReport });
    const dir = join(mkdtempSync(join(tmpdir(), "cwh-rg-scn8-")), SECRET);
    mkdirSync(dir);
    const out = await regradeRuns({ runDirs: [k.runDir], scenarioFile: scenarioAt(dir, `  - file_exists: outputs/report.md\n`) });
    expect(out).toMatchObject({ ok: false, kind: "usage" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).not.toContain(SECRET);
    expect(out.message).toContain("[REDACTED]");
  });

  it("a run dir reached through a symlink is graded once", async () => {
    const k = await keptRun({ author: writeReport });
    const link = join(mkdtempSync(join(tmpdir(), "cwh-rg-link-")), "run");
    symlinkSync(k.runDir, link);
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({ runDirs: [k.runDir, link], scenarioFile: k.scenarioFile, makeJudge: judge.make });
    if (!out.ok) throw new Error(out.message);
    expect(out.runs).toHaveLength(1);
    expect(judge.calls).toHaveLength(1);
  });

  it("the file and each runs[] entry carry the scenario file's sha256", async () => {
    const k = await keptRun({ author: writeReport });
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    if (!out.ok) throw new Error(out.message);
    const want = createHash("sha256").update(readFileSync(k.scenarioFile)).digest("hex");
    expect(out.runs[0].scenarioSha256).toBe(want);
    expect(JSON.parse(readFileSync(out.runs[0].regradeFile, "utf8")).scenarioSha256).toBe(want);
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

describe("regrade: content the live judge never read, and accepted drift", () => {
  const widerScenario = () => scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-uc-")), WIDER);
  const withAppendix = (w: string) => {
    writeReport(w);
    writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
  };
  const APPENDIX_UNCHECKED = { assertionIndex: 0, kind: "authored", path: "outputs/appendix.md" };
  const REPORT_DRIFT = [{ liveAssertionIndex: 0, sections: [{ kind: "authored", path: "outputs/report.md", change: "changed" }] }];

  it("a widened evidence_files scope is refused before any judge call, naming the section and the flag", async () => {
    const k = await keptRun({ author: withAppendix, assertYaml: SCOPED });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({ runDirs: [k.runDir], scenarioFile: widerScenario(), makeJudge: judge.make });
    expect(out).toMatchObject({ ok: false, kind: "runtime", code: "unchecked_content" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toMatch(/^regrade: /);
    expect(out.message).toContain("never read by the live judge");
    expect(out.message).toContain("assert 0: authored outputs/appendix.md");
    expect(out.message).toContain("include_subagent_text");
    expect(out.message).toContain("--allow-unchecked");
    expect(out.message).toMatch(/\(can't verify ⇒ not green\)$/);
    expect(out.refusals).toEqual([
      { runDir: k.runDir, code: "unchecked_content", uncheckedCount: 1, uncheckedSections: [APPENDIX_UNCHECKED] },
    ]);
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(k)).toEqual([]);
  });

  it("a batch with one clean dir and one unchecked dir judges nothing, not even the clean one", async () => {
    const clean = await keptRun({ author: withAppendix, assertYaml: WIDER });
    const widened = await keptRun({ author: withAppendix, assertYaml: SCOPED });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({ runDirs: [clean.runDir, widened.runDir], scenarioFile: widerScenario(), makeJudge: judge.make });
    expect(out).toMatchObject({ ok: false, code: "unchecked_content" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.refusals?.map((r) => r.runDir)).toEqual([widened.runDir]);
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(clean)).toEqual([]);
  });

  it("every refused dir is listed: drift in one, unchecked content in another, both in a third; error.code is doc_drift", async () => {
    const drifted = await keptRun({ author: withAppendix, assertYaml: WIDER });
    writeFileSync(join(drifted.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const widened = await keptRun({ author: withAppendix, assertYaml: SCOPED });
    const both = await keptRun({ author: withAppendix, assertYaml: SCOPED });
    writeFileSync(join(both.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({
      runDirs: [drifted.runDir, widened.runDir, both.runDir],
      scenarioFile: widerScenario(),
      makeJudge: judge.make,
    });
    expect(out).toMatchObject({ ok: false, kind: "runtime", code: "doc_drift" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.refusals?.map((r) => [r.runDir, r.code])).toEqual([
      [drifted.runDir, "doc_drift"],
      [widened.runDir, "unchecked_content"],
      [both.runDir, "doc_drift"],
      [both.runDir, "unchecked_content"],
    ]);
    expect(out.refusals?.[0].liveDocDrift).toEqual(REPORT_DRIFT);
    for (const d of [drifted, widened, both]) expect(out.message).toContain(d.runDir);
    expect(judge.calls).toHaveLength(0);
  });

  it("--allow-doc-drift alone does not admit unchecked content", async () => {
    const k = await keptRun({ author: withAppendix, assertYaml: SCOPED });
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: widerScenario(),
      makeJudge: judgeFactory(() => true).make,
      allowDocDrift: true,
    });
    expect(out).toMatchObject({ ok: false, code: "unchecked_content" });
  });

  it("--allow-unchecked alone does not admit drift", async () => {
    const k = await keptRun({ author: writeReport });
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make, allowUnchecked: true }));
    expect(out).toMatchObject({ ok: false, code: "doc_drift" });
  });

  it("with both flags: the assert whose widened document reads the drifted file is false, not scope_changed", async () => {
    const k = await keptRun({ author: withAppendix, assertYaml: SCOPED });
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: widerScenario(),
      makeJudge: judgeFactory(() => true).make,
      allowDocDrift: true,
      allowUnchecked: true,
    });
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].assertions[0].docMatchesLive).toBe(false);
    expect(out.runs[0].docMatchesLive).toBe(false);
    expect(out.runs[0].liveDocDrift).toEqual(REPORT_DRIFT);
    expect(out.runs[0].uncheckedSections).toEqual([APPENDIX_UNCHECKED]);
  });

  it("--allow-doc-drift with no drift changes nothing: liveDocDrift is empty and the value stays true", async () => {
    const k = await keptRun({ author: writeReport });
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make, allowDocDrift: true }));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].liveDocDrift).toEqual([]);
    expect(out.runs[0].docMatchesLive).toBe(true);
  });

  it("a run with no live fingerprint at all only warns about a widened scope: nothing to measure against", async () => {
    const k = await keptRun({ author: withAppendix, assertYaml: SCOPED });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    for (const a of r.assertions) delete a.judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns({ runDirs: [k.runDir], scenarioFile: widerScenario(), makeJudge: judgeFactory(() => true).make });
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].docMatchesLive).toBe("unknown");
    expect(out.runs[0].uncheckedSections).toEqual([]);
    expect(stderr.text()).toContain("assert 0: unknown");
  });

  it("a blind assert beside a comparable sibling is measured against the sibling's rebuilt document", async () => {
    // The asymmetry with an all-blind run (warned only): here there IS a rebuilt live document, and the blind
    // assert's notes.md is in none of it.
    const UNSCOPED_ALL = `  - semantic_matches:\n      rubric: ["the outputs name the risk"]\n`;
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "notes.md"), "side notes\n");
      },
      assertYaml: `${SCOPED}${UNSCOPED_ALL}`,
    });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.assertions[1].judgedDoc;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    expect(out).toMatchObject({ ok: false, code: "unchecked_content" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).toContain("assert 1: authored outputs/notes.md");
  });

  it("a smaller --authored-total-bytes: content it truncates refuses its own assert, so no truncated section is graded", async () => {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "notes.md"), `${"n".repeat(600)}\n`);
      },
      assertYaml: `${SCOPED}  - semantic_matches:\n      rubric: ["the outputs name the risk"]\n`,
    });
    const out = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make, authoredTotalBytes: 300 }));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].uncheckedSections).toEqual([]);
    for (const a of out.runs[0].assertions) expect(["scope_changed", "not_graded"]).toContain(a.docMatchesLive);
    // The cut content never reaches a judge: an assert whose evidence a smaller budget truncates refuses it, so no
    // truncated section is ever graded (and none needs a truncation exemption).
    expect(out.runs[0].assertions.map((a) => [a.docMatchesLive, a.semanticEvidence?.reason])).toEqual([
      ["scope_changed", "graded"],
      ["not_graded", "evidence_incomplete"],
    ]);
  });

  it("a smaller budget that adds an evidence-health note to a GRADED document is not unchecked content", async () => {
    // The scoped assert still grades (its file is a priority glob), but notes.md no longer fits, so its document
    // gains the harness's evidence-health note, which no live document had. That note is fixed text and paths.
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "notes.md"), `${"n".repeat(600)}\n`);
      },
      assertYaml: SCOPED,
    });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns(opts(k, { makeJudge: judge.make, authoredTotalBytes: 50 }));
    if (!out.ok) throw new Error(out.message);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].answer).toContain("## Evidence health");
    expect(out.runs[0].assertions.map((a) => [a.docMatchesLive, a.semanticEvidence?.reason])).toEqual([["scope_changed", "graded"]]);
    expect(out.runs[0].uncheckedSections).toEqual([]);
    expect(out.runs[0].differingSections).toContainEqual({ assertionIndex: 0, kind: "health", change: "added" });
  });

  it("extra content only in an assert that refuses its own evidence is not refused as unchecked", async () => {
    // The new unscoped assert would read big.md and notes.md, which no live document had, but big.md is over the
    // per-file cap, so the assert refuses its evidence: no judge receives that document.
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "notes.md"), "side notes\n");
        writeFileSync(join(w, "outputs", "big.md"), `# Big\n${"Concentration is the main risk.\n".repeat(700)}`);
      },
      assertYaml: SCOPED,
    });
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(
        mkdtempSync(join(tmpdir(), "cwh-rg-t6-")),
        `${SCOPED}  - semantic_matches:\n      rubric: ["the outputs name the risk"]\n`,
      ),
      makeJudge: judge.make,
    });
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].assertions.map((a) => [a.docMatchesLive, a.semanticEvidence?.reason])).toEqual([
      [true, "graded"],
      ["not_graded", "evidence_incomplete"],
    ]);
    expect(out.runs[0].uncheckedSections).toEqual([]);
    expect(judge.calls).toHaveLength(1);
  });

  it("the refusal lists the first 20 unchecked sections and counts the rest", async () => {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        mkdirSync(join(w, "outputs", "extra"), { recursive: true });
        for (let i = 0; i < 25; i++) writeFileSync(join(w, "outputs", "extra", `e${String(i).padStart(2, "0")}.md`), `extra ${i}\n`);
      },
      assertYaml: SCOPED,
    });
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(
        mkdtempSync(join(tmpdir(), "cwh-rg-cap-")),
        `  - semantic_matches:\n      rubric: ["the report names the risk"]\n      evidence_files: ["outputs/report.md", "outputs/extra/*.md"]\n`,
      ),
      makeJudge: judgeFactory(() => true).make,
    });
    expect(out).toMatchObject({ ok: false, code: "unchecked_content" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.refusals?.[0].uncheckedCount).toBe(25);
    expect(out.refusals?.[0].uncheckedSections).toHaveLength(25);
    expect(out.message).toContain("outputs/extra/e19.md");
    expect(out.message).not.toContain("outputs/extra/e20.md");
    expect(out.message).toContain("… and 5 more");
  });

  it("sub-agent text an include_subagent_text opt-in brings in is unchecked content", async () => {
    const k = await keptRun({ author: writeReport, assertYaml: SCOPED });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    r.subagents = [{ description: "researcher", reasoning: [{ kind: "text", text: "The sub-agent found the risk." }] }];
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const out = await regradeRuns({
      runDirs: [k.runDir],
      scenarioFile: scenarioAt(
        mkdtempSync(join(tmpdir(), "cwh-rg-sa-")),
        `  - semantic_matches:\n      rubric: ["the report names the risk"]\n      evidence_files: ["outputs/report.md"]\n      include_subagent_text: true\n`,
      ),
      makeJudge: judgeFactory(() => true).make,
    });
    expect(out).toMatchObject({ ok: false, code: "unchecked_content" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.refusals?.[0].uncheckedSections).toEqual([{ assertionIndex: 0, kind: "subagent" }]);
  });

  it("a secret matching JSON syntax refuses cleanly: the refusals are scrubbed field by field", async () => {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
      assertYaml: SCOPED,
    });
    const SECRET = 'md"}';
    process.env.COWORK_HARNESS_SCRUB_VALUES = SECRET;
    let out;
    try {
      out = await regradeRuns({ runDirs: [k.runDir], scenarioFile: widerScenario(), makeJudge: judgeFactory(() => true).make });
    } finally {
      delete process.env.COWORK_HARNESS_SCRUB_VALUES;
    }
    expect(out).toMatchObject({ ok: false, code: "unchecked_content" });
    if (out.ok) throw new Error("expected a refusal");
    expect(out.message).not.toContain(SECRET);
    expect(JSON.stringify(out.refusals)).not.toContain("[REDACTED]"); // no field held the secret
    expect(out.refusals?.[0].uncheckedSections).toEqual([APPENDIX_UNCHECKED]);
  });

  it("a failure writing a regrade file after an earlier dir was graded returns the completed runs", async () => {
    const a = await keptRun({ author: writeReport });
    const b = await keptRun({ author: writeReport });
    writeFileSync(join(b.runDir, "turns", "1", "regrade"), "a file where the regrade dir goes\n");
    const judge = judgeFactory(() => true);
    const out = await regradeRuns({ runDirs: [a.runDir, b.runDir], scenarioFile: a.scenarioFile, makeJudge: judge.make });
    expect(out).toMatchObject({ ok: false, kind: "runtime" });
    if (out.ok) throw new Error("expected a failure");
    expect(out.code).toBeUndefined();
    expect(out.message).toContain(b.runDir);
    expect(out.completed?.map((r) => r.runDir)).toEqual([a.runDir]);
    expect(regradeFiles(a)).toHaveLength(1);
    expect(judge.calls).toHaveLength(2); // the second dir was graded (and paid) before its write failed
  });
});

// The covered `--output-format json` surface (SPEC §12): pinned two ways — against the published schema
// (permissive), and against a copy strictened at the frame and run levels, so a key emitted without a schema
// update fails too — plus exact key sets.
const regradeSchema = JSON.parse(readFileSync(resolve("schema/regrade.json"), "utf8")) as Record<string, unknown>;
/** additionalProperties:false at each branch's frame and at the `runs[]` entry (`definitions.Run`). The assertion
 *  entry is NOT closed: only the keys the contract names are covered there. */
function strictRegradeSchema(): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(regradeSchema)) as {
    $id?: string;
    oneOf: Array<{ additionalProperties?: boolean }>;
    definitions: { Run: { additionalProperties?: boolean } };
  };
  delete s.$id; // ajv rejects two compilations under one $id
  for (const branch of s.oneOf) branch.additionalProperties = false;
  s.definitions.Run.additionalProperties = false;
  return s as unknown as Record<string, unknown>;
}
const ajv = new Ajv({ strict: true });
const validatePublished = ajv.compile(regradeSchema);
const validateStrict = ajv.compile(strictRegradeSchema());
const checkSchema = (env: unknown): void => {
  expect(validatePublished(env), ajv.errorsText(validatePublished.errors)).toBe(true);
  expect(validateStrict(env), ajv.errorsText(validateStrict.errors)).toBe(true);
};

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
    checkSchema(env);
  });

  it("schema/regrade.json ajv strict-compiles", () => {
    expect(typeof validatePublished).toBe("function");
  });

  it("a rich envelope matches the schema and the covered key sets exactly", async () => {
    // Dir 1: the scope widened (scope_changed, a differing and an unchecked section). Dir 2: an accepted drift and a
    // judge outage (judge-invalid, unpriced). The scenario carries a non-semantic assert (notRegraded).
    const one = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
      assertYaml: SCOPED,
    });
    const two = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
      assertYaml: WIDER,
    });
    writeFileSync(join(two.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    let calls = 0;
    const flaky = (o?: { model?: string }): SemanticJudge => {
      const inner = judgeFactory(() => true).make(o);
      const j: SemanticJudge = async (rubric, answer) => {
        if (++calls > 1) {
          j.lastCostUsd = undefined;
          throw new Error("judge transport down");
        }
        const r = await inner(rubric, answer);
        j.lastCostUsd = inner.lastCostUsd;
        j.lastUsage = inner.lastUsage;
        return r;
      };
      j.model = inner.model;
      j.promptHash = inner.promptHash;
      return j;
    };
    const out = await regradeRuns({
      runDirs: [one.runDir, two.runDir],
      scenarioFile: scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-env-")), `${WIDER}  - file_exists: outputs/report.md\n`),
      makeJudge: flaky,
      allowDocDrift: true,
      allowUnchecked: true,
    });
    if (!out.ok) throw new Error(out.message);
    const env = JSON.parse(regradeEnvelope(out));
    checkSchema(env);

    expect(Object.keys(env).sort()).toEqual(["command", "error", "judgeCostUsd", "ok", "runs", "tool", "unpricedGrades", "version"]);
    const RUN_KEYS = [
      "assertions",
      "authoredCapture",
      "differingSections",
      "docMatchesLive",
      "invalidGrades",
      "liveDocDrift",
      "notRegraded",
      "pass",
      "regradeFile",
      "runDir",
      "scenarioSha256",
      "turn",
      "uncheckedCount",
      "uncheckedSections",
      "unpricedGrades",
    ];
    expect(Object.keys(env.runs[0]).sort()).toEqual([...RUN_KEYS, "judgeCostUsd"].sort());
    expect(Object.keys(env.runs[1]).sort()).toEqual(RUN_KEYS);
    const [r1, r2] = env.runs;
    expect(r1).toMatchObject({ docMatchesLive: "scope_changed", uncheckedCount: 1, liveDocDrift: [] });
    expect(r1.uncheckedCount).toBe(r1.uncheckedSections.length);
    expect(r1.differingSections).toContainEqual({ assertionIndex: 0, kind: "authored", path: "outputs/appendix.md", change: "added" });
    expect(r1.notRegraded).toEqual([{ assertionIndex: 1, keys: ["file_exists"] }]);
    expect(r1.authoredCapture).toMatchObject({ source: "persisted" });
    expect(r2).toMatchObject({ docMatchesLive: false, invalidGrades: 1, unpricedGrades: 1, uncheckedCount: 0 });
    expect(r2.liveDocDrift).toEqual([
      { liveAssertionIndex: 0, sections: [{ kind: "authored", path: "outputs/report.md", change: "changed" }] },
    ]);
    // TRIPWIRE, not a contract: the assertion entry's covered keys are assertionIndex, docMatchesLive, pass,
    // judgeInvalid, judgeModel, judgeCostUsd and semanticClaims (SPEC §12); the rest follow the RunResult
    // assertion entry, which is not pinned field by field. A new key here is a prompt to review, then update.
    // `evidence` rides in from the shared assertion result (`evaluate`), as on RunResult.assertions[].
    const ASSERTION_KEYS_GRADED = [
      "assertion",
      "assertionIndex",
      "docMatchesLive",
      "evidence",
      "judgeCostUsd",
      "judgeModel",
      "judgePromptHash",
      "judgeUsage",
      "judgedDoc",
      "pass",
      "semanticClaims",
      "semanticEvidence",
    ];
    const ASSERTION_KEYS_INVALID = [
      "assertion",
      "assertionIndex",
      "docMatchesLive",
      "judgeInvalid",
      "judgeModel",
      "judgePromptHash",
      "judgedDoc",
      "message",
      "pass",
    ];
    expect(Object.keys(r1.assertions[0]).sort()).toEqual(ASSERTION_KEYS_GRADED);
    expect(Object.keys(r2.assertions[0]).sort()).toEqual(ASSERTION_KEYS_INVALID);
    expect(r2.assertions[0].judgeInvalid).toBe(true);
  });

  it("with no grade priced, the top-level judgeCostUsd is absent and the document still validates", async () => {
    const k = await keptRun({ author: writeReport });
    const unpriced = (o?: { model?: string }): SemanticJudge => {
      const inner = judgeFactory(() => true).make(o);
      const j: SemanticJudge = async (rubric, answer) => inner(rubric, answer);
      j.model = inner.model;
      j.promptHash = inner.promptHash;
      return j;
    };
    const out = await regradeRuns(opts(k, { makeJudge: unpriced }));
    if (!out.ok) throw new Error(out.message);
    const env = JSON.parse(regradeEnvelope(out));
    expect(Object.keys(env).sort()).toEqual(["command", "error", "ok", "runs", "tool", "unpricedGrades", "version"]);
    checkSchema(env);
  });

  it("the refusal envelopes validate: usage, runtime, a coded refusal with refusals[], a write failure with runs[]", async () => {
    checkSchema(JSON.parse(jsonError("regrade", "usage", "usage: regrade …")));
    checkSchema(JSON.parse(jsonError("regrade", "runtime", "regrade: evidence unavailable")));
    const k = await keptRun({ author: writeReport });
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const refused = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    if (refused.ok) throw new Error("expected a refusal");
    const coded = JSON.parse(regradeErrorEnvelope(refused));
    expect(coded).toMatchObject({ ok: false, error: { category: "runtime", code: "doc_drift" }, refusals: [{ code: "doc_drift" }] });
    checkSchema(coded);

    const a = await keptRun({ author: writeReport });
    const b = await keptRun({ author: writeReport });
    writeFileSync(join(b.runDir, "turns", "1", "regrade"), "x\n");
    const failed = await regradeRuns({
      runDirs: [a.runDir, b.runDir],
      scenarioFile: a.scenarioFile,
      makeJudge: judgeFactory(() => true).make,
    });
    if (failed.ok) throw new Error("expected a failure");
    const partial = JSON.parse(regradeErrorEnvelope(failed));
    expect(partial.runs).toHaveLength(1);
    expect(partial.error.code).toBeUndefined();
    checkSchema(partial);
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

  it("a coded refusal reaches stdout with error.code and refusals[], and validates against the schema", async () => {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
      assertYaml: SCOPED,
    });
    const wider = scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-cli-")), WIDER);
    const j = cli(["regrade", k.runDir, "--scenario", wider, "--output-format", "json"]);
    expect(j.code).toBe(2);
    const env = JSON.parse(j.stdout);
    expect(env).toMatchObject({
      ok: false,
      error: { category: "runtime", code: "unchecked_content" },
      refusals: [{ code: "unchecked_content" }],
    });
    checkSchema(env);
    const t = cli(["regrade", k.runDir, "--scenario", wider]);
    expect(t.code).toBe(2);
    expect(t.stderr).toContain("--allow-unchecked");
  });

  it("--allow-unchecked is accepted (the refusal that follows is the run's, not a usage error)", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.authoredCapture;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const j = cli(["regrade", k.runDir, "--scenario", k.scenarioFile, "--allow-unchecked", "--output-format", "json"]);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.stdout)).toMatchObject({ command: "regrade", ok: false, error: { category: "runtime" } });
  });

  it("a non-numeric --authored-total-bytes is a usage error", () => {
    const r = cli(["regrade", "somedir", "--scenario", "s.yaml", "--authored-total-bytes", "0.5"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--authored-total-bytes");
  });
});

describe("regrade checkOnly: every pre-spend step, then stop", () => {
  /** A judge factory that fails the test if a judge is ever constructed (judgesForRun builds eagerly). */
  const noJudge = (): SemanticJudge => {
    throw new Error("checkOnly constructed a judge");
  };
  /** The two outcomes compared as a caller reads them: the refusal fields, not the per-call message order. */
  const refusalOf = (o: { ok: boolean }) => {
    if (o.ok) throw new Error("expected a refusal");
    const r = o as Extract<Awaited<ReturnType<typeof regradeRuns>>, { ok: false }>;
    return { ok: r.ok, kind: r.kind, code: r.code, refusals: r.refusals, message: r.message };
  };

  it("a clean run → ok, checkOnly, no judge constructed, no regrade file; the per-run evidence fields are reported", async () => {
    const k = await keptRun({ author: writeReport });
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns({ ...opts(k, { makeJudge: noJudge }), checkOnly: true as const });
    } finally {
      stderr.restore();
    }
    if (!out.ok) throw new Error(out.message);
    expect(out).toMatchObject({ ok: true, checkOnly: true });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]).toEqual({
      runDir: k.runDir,
      turn: 1,
      scenarioSha256: createHash("sha256").update(readFileSync(k.scenarioFile)).digest("hex"),
      uncheckedSections: [],
      uncheckedCount: 0,
      liveDocDrift: [],
      blind: [],
      authoredCapture: expect.objectContaining({ source: "persisted" }),
    });
    expect(regradeFiles(k)).toEqual([]);
    expect(existsSync(join(k.runDir, "turns", "1", "regrade"))).toBe(false);
    expect(stderr.text()).toBe("");
  });

  it("a drifted run → the same doc_drift refusal a real regrade returns, with no judge", async () => {
    const k = await keptRun({ author: writeReport });
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const judge = judgeFactory(() => true);
    const real = await regradeRuns(opts(k, { makeJudge: judge.make }));
    const check = await regradeRuns({ ...opts(k, { makeJudge: noJudge }), checkOnly: true as const });
    expect(refusalOf(check)).toEqual(refusalOf(real));
    expect(refusalOf(check).code).toBe("doc_drift");
    expect(judge.calls).toHaveLength(0);
    expect(regradeFiles(k)).toEqual([]);
  });

  it("unchecked content → the same unchecked_content refusal a real regrade returns", async () => {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
    });
    const scenarioFile = scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scnco-")), WIDER);
    const real = await regradeRuns({ runDirs: [k.runDir], scenarioFile, makeJudge: judgeFactory(() => true).make });
    const check = await regradeRuns({ runDirs: [k.runDir], scenarioFile, makeJudge: noJudge, checkOnly: true });
    expect(refusalOf(check)).toEqual(refusalOf(real));
    expect(refusalOf(check).code).toBe("unchecked_content");
    expect(regradeFiles(k)).toEqual([]);
  });

  it("a multi-dir batch → the same refusals[] (every dir, both codes) as the real path", async () => {
    const withAppendix = (w: string) => {
      writeReport(w);
      writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
    };
    const clean = await keptRun({ author: withAppendix });
    const drifted = await keptRun({ author: withAppendix });
    writeFileSync(join(drifted.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const scenarioFile = scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scnco2-")), WIDER);
    const runDirs = [clean.runDir, drifted.runDir];
    const judge = judgeFactory(() => true);
    const real = await regradeRuns({ runDirs, scenarioFile, makeJudge: judge.make });
    const check = await regradeRuns({ runDirs, scenarioFile, makeJudge: noJudge, checkOnly: true });
    expect(refusalOf(check)).toEqual(refusalOf(real));
    const r = refusalOf(check);
    expect(r.code).toBe("doc_drift");
    expect(r.refusals!.map((x) => [x.runDir, x.code])).toEqual([
      [clean.runDir, "unchecked_content"],
      [drifted.runDir, "doc_drift"],
      [drifted.runDir, "unchecked_content"],
    ]);
    expect(judge.calls).toHaveLength(0);
  });

  it("a non-evidence refusal (a dir with no persisted budget) is the real path's refusal too", async () => {
    const k = await keptRun({ author: writeReport });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    delete r.authoredCapture;
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const real = await regradeRuns(opts(k, { makeJudge: judgeFactory(() => true).make }));
    // Options built in a variable: `checkOnly` widens to boolean (the widened overload, exercised at runtime).
    const o = { ...opts(k, { makeJudge: noJudge }), checkOnly: true };
    const check = await regradeRuns(o);
    expect(refusalOf(check)).toEqual(refusalOf(real));
  });

  it("allowDocDrift / allowUnchecked → success, reporting what the real run would accept", async () => {
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
    });
    writeFileSync(join(k.workRoot, "outputs", "report.md"), REPORT.replace("concentration", "churn"));
    const scenarioFile = scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scnco3-")), WIDER);
    const base = { runDirs: [k.runDir], scenarioFile, makeJudge: noJudge, checkOnly: true as const };
    expect(await regradeRuns({ ...base, allowDocDrift: true })).toMatchObject({ ok: false, code: "unchecked_content" });
    expect(await regradeRuns({ ...base, allowUnchecked: true })).toMatchObject({ ok: false, code: "doc_drift" });
    // A real re-grade warns here ("grading anyway", "never read by the live judge"); the preflight prints nothing.
    const stderr = captureStderr();
    let out;
    try {
      out = await regradeRuns({ ...base, allowDocDrift: true, allowUnchecked: true });
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toBe("");
    if (!out.ok) throw new Error(out.message);
    if (!("checkOnly" in out)) throw new Error("expected a preflight outcome");
    expect(out.checkOnly).toBe(true);
    expect(out.runs[0].liveDocDrift).toEqual([
      { liveAssertionIndex: 0, sections: [{ kind: "authored", path: "outputs/report.md", change: "changed" }] },
    ]);
    expect(out.runs[0].uncheckedSections).toEqual([{ assertionIndex: 0, kind: "authored", path: "outputs/appendix.md" }]);
    expect(out.runs[0].uncheckedCount).toBe(1);
    expect(regradeFiles(k)).toEqual([]);
  });

  it("types: the overloads never type a preflight's success as a regrade's (checked by typecheck, not run)", () => {
    // Compiled under tsconfig.test.json; the bodies are never called. An unused @ts-expect-error fails typecheck.
    const widened = async (k: Kept) => {
      const o = { runDirs: [k.runDir], scenarioFile: k.scenarioFile, checkOnly: true };
      const r = await regradeRuns(o);
      // @ts-expect-error a widened checkOnly may return RegradeCheckPassed, which has no exitCode
      if (r.ok) void r.exitCode;
    };
    const literal = async (k: Kept) => {
      const r = await regradeRuns({ runDirs: [k.runDir], scenarioFile: k.scenarioFile, checkOnly: true });
      // @ts-expect-error a literal checkOnly: true may return RegradeCheckPassed, which has no exitCode
      if (r.ok) void r.exitCode;
    };
    const plain = async (k: Kept) => {
      for (const o of [opts(k), { ...opts(k), checkOnly: false as const }]) {
        const r = await regradeRuns(o);
        if (r.ok) void r.exitCode; // no checkOnly (or false): the plain RegradeOutcome
      }
    };
    expect([widened, literal, plain].every((f) => typeof f === "function")).toBe(true);
  });

  /** The real path's blind-assert warning for the same run, and the preflight's `blind` for it. */
  async function blindBoth(k: Kept, assertYaml?: string) {
    const scenarioFile = assertYaml ? scenarioAt(mkdtempSync(join(tmpdir(), "cwh-rg-scnbl-")), assertYaml) : k.scenarioFile;
    const stderr = captureStderr();
    let check;
    try {
      check = await regradeRuns({ runDirs: [k.runDir], scenarioFile, makeJudge: noJudge, checkOnly: true });
    } finally {
      stderr.restore();
    }
    expect(stderr.text()).toBe("");
    if (!check.ok || !("checkOnly" in check)) throw new Error("expected a passed preflight");
    const real = captureStderr();
    try {
      const out = await regradeRuns({ runDirs: [k.runDir], scenarioFile, makeJudge: judgeFactory(() => true).make });
      if (!out.ok) throw new Error(out.message);
    } finally {
      real.restore();
    }
    const warned = /(\d+) assert\(s\) have no live document to compare with \(([^)]*)\)/.exec(real.text());
    return { blind: check.runs[0].blind, warned: warned ? { count: Number(warned[1]), list: warned[2] } : undefined };
  }

  it("blind: a run with no live fingerprint lists exactly the asserts a real re-grade warns about", async () => {
    // Two scopes, so each assert is judged against its own live counterpart: 0 graded live but unfingerprinted
    // (unknown), 1 refused live with no fingerprint (live_refused).
    const k = await keptRun({
      author: (w) => {
        writeReport(w);
        writeFileSync(join(w, "outputs", "appendix.md"), "appendix\n");
      },
      assertYaml: `${SCOPED}  - semantic_matches:\n      rubric: ["the appendix exists"]\n      evidence_files: ["outputs/appendix.md"]\n`,
    });
    const r = JSON.parse(readFileSync(k.resultPath, "utf8"));
    for (const a of r.assertions) delete a.judgedDoc;
    r.assertions[1].semanticEvidence = { reason: "in_scope_omitted", paths: ["outputs/report.md"] };
    writeFileSync(k.resultPath, JSON.stringify(r, null, 2));
    const { blind, warned } = await blindBoth(k);
    expect(blind).toEqual([
      { assertionIndex: 0, docMatch: "unknown" },
      { assertionIndex: 1, docMatch: "live_refused" },
    ]);
    expect(warned).toEqual({ count: 2, list: "assert 0: unknown, assert 1: live_refused" });
  });

  it("blind: a clean fingerprinted run → [] and no real warning", async () => {
    const k = await keptRun({ author: writeReport });
    const { blind, warned } = await blindBoth(k);
    expect(blind).toEqual([]);
    expect(warned).toBeUndefined();
  });
});

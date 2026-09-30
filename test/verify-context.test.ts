import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertContextFromRunDir } from "../src/run/verify-context.js";
import { captureAuthoredFilesWithHealth } from "../src/run/artifacts.js";
import { authoredCaptureOpts } from "../src/run/authored-capture-opts.js";
import { capturePreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { composeJudgedDocument } from "../src/assert.js";
import { parseScenarioFile } from "../src/run/execute.js";
import type { LaunchPlan } from "../src/session.js";

// Record every call into the real capture (it still runs — this only observes the options it was given).
const captureCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("../src/run/artifacts.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/run/artifacts.js")>();
  return {
    ...orig,
    captureAuthoredFilesWithHealth: (...args: Parameters<typeof orig.captureAuthoredFilesWithHealth>) => {
      captureCalls.push(args);
      return orig.captureAuthoredFilesWithHealth(...args);
    },
  };
});
beforeEach(() => {
  captureCalls.length = 0;
});

// The kept-run AssertContext rebuild shared by verify-run and anything else that re-grades a kept run.
// Every fixture here is a REAL tree on disk: a pre-run manifest captured by the production function over a
// staged work dir, files authored after it, and a result.json carrying the manifest's own hashes — so the
// capture this module runs walks the same bytes the live capture would.

function minimalPlan(): LaunchPlan {
  return {
    configDir: mkdtempSync(join(tmpdir(), "cwh-vc-cfg-")),
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

interface Kept {
  runDir: string;
  workRoot: string;
}

/** A kept single-turn run dir. `author` runs AFTER the pre-run manifest is captured, so what it writes is
 *  classified authored; `outputs/input.md` exists before it and is not. */
function keptRun(author: (workRoot: string) => void, extra: Record<string, unknown> = {}): Kept {
  const runDir = mkdtempSync(join(tmpdir(), "cwh-vc-"));
  const workRoot = join(runDir, "work", "session", "mnt");
  mkdirSync(join(workRoot, "outputs"), { recursive: true });
  writeFileSync(join(workRoot, "outputs", "input.md"), "pre-existing input\n");
  capturePreRunManifest(minimalPlan(), workRoot, runDir, "container");
  author(workRoot);
  const result = {
    scenario: "vc",
    fidelity: "container",
    result: "success",
    decisions: [],
    toolCounts: { Write: 2 },
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [],
    outDir: runDir,
    workDir: workRoot,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
    userVisibleRoots: ["outputs"],
    readonlyFolderRoots: [],
    preRunHashes: readPreRunManifestHashes(runDir),
    ...extra,
  };
  const t1 = join(runDir, "turns", "1");
  mkdirSync(t1, { recursive: true });
  writeFileSync(join(t1, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(
    join(t1, "run.jsonl"),
    [JSON.stringify({ t: "run", scenario: "vc" }), JSON.stringify({ t: "transcript", text: "wrote the report" })].join("\n"),
  );
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [] }));
  return { runDir, workRoot };
}

function scenarioFile(dir: string, assertYaml: string): string {
  const f = join(dir, "scenario.yaml");
  writeFileSync(f, `name: vc\nprompt: write the report\nfidelity: container\nassert:\n${assertYaml}`);
  return f;
}

const SEMANTIC_ONLY = `  - semantic_matches:\n      rubric: ["the report names the risk"]\n      evidence_files: ["outputs/report.md"]\n`;

describe("assertContextFromRunDir: refuses a pruned work dir", () => {
  it("refuses (runtime) when a filesystem assert needs the work dir and it is gone", () => {
    const k = keptRun((w) => writeFileSync(join(w, "outputs", "report.md"), "r"));
    rmSync(join(k.runDir, "work"), { recursive: true, force: true });
    const s = parseScenarioFile(scenarioFile(k.runDir, `  - file_exists: outputs/report.md\n`));
    const r = assertContextFromRunDir(k.runDir, s);
    expect(r.ok).toBe(false);
    if (r.ok || r.kind === "scenario") throw new Error("expected a refusal");
    expect(r.kind).toBe("runtime");
    expect(r.message).toMatch(/^verify-run: work dir not found \(/);
    expect(r.message).toContain(k.workRoot);
  });

  it("refuses a semantic re-grade over a pruned work dir when authored files are to be recaptured", () => {
    const k = keptRun((w) => writeFileSync(join(w, "outputs", "report.md"), "r"));
    rmSync(join(k.runDir, "work"), { recursive: true, force: true });
    const s = parseScenarioFile(scenarioFile(k.runDir, SEMANTIC_ONLY));
    const r = assertContextFromRunDir(k.runDir, s, { recomputeAuthored: "semantic", command: "other-cmd" });
    if (r.ok || r.kind === "scenario") throw new Error("expected a refusal");
    expect(r.kind).toBe("runtime");
    expect(r.message).toMatch(/^other-cmd: work dir not found \(/);
    expect(r.message).toContain("semantic_matches");
  });

  it("default mode keeps verify-run's behaviour: a semantic-only scenario over a pruned dir is NOT refused", () => {
    const k = keptRun((w) => writeFileSync(join(w, "outputs", "report.md"), "r"));
    rmSync(join(k.runDir, "work"), { recursive: true, force: true });
    const s = parseScenarioFile(scenarioFile(k.runDir, SEMANTIC_ONLY));
    const r = assertContextFromRunDir(k.runDir, s);
    if (!r.ok) throw new Error(`unexpected refusal: ${JSON.stringify(r)}`);
    expect(r.ctx.authoredFiles).toBeUndefined();
  });

  it("returns a scenario-loader failure unformatted, after the run-dir refusals (which win)", () => {
    const k = keptRun(() => {});
    const boom = () => {
      throw new Error("nope");
    };
    const r = assertContextFromRunDir(k.runDir, boom);
    expect(r).toMatchObject({ ok: false, kind: "scenario" });
    // A partial run is refused before the loader is ever called.
    const p = keptRun(() => {});
    const rp = join(p.runDir, "turns", "1", "result.json");
    writeFileSync(rp, JSON.stringify({ result: "success", partial: true }));
    const r2 = assertContextFromRunDir(p.runDir, boom);
    expect(r2).toMatchObject({ ok: false, kind: "runtime" });
  });
});

describe("assertContextFromRunDir: recomputeAuthored 'semantic' reproduces the live capture", () => {
  // The report is 20 KiB: over the default 16 KiB per-file cap unless a priority glob exempts it. The
  // intermediates dir sorts first and holds 30 KiB, so without the priority glob it spends the budget
  // before the report is reached. The 30 KiB total is below the 64 KiB default, so after the report only
  // a truncated slice of the intermediates fits. Each option changes the captured set — the test fails if
  // either is dropped on the way to the capture.
  const author = (w: string) => {
    mkdirSync(join(w, "outputs", "_work"), { recursive: true });
    writeFileSync(join(w, "outputs", "_work", "junk.md"), "j".repeat(30 * 1024));
    writeFileSync(join(w, "outputs", "report.md"), `# Report\n${"the risk is concentration. ".repeat(800)}`);
    // A relative shell write at the session root: the scratchpad walk the live capture also runs.
    writeFileSync(join(dirname(w), "notes.txt"), "scratch notes\n");
  };
  const priorityGlobs = ["outputs/report.md"];
  const totalBytes = 30 * 1024;

  it("the live run builds its capture options with the shared derivation", () => {
    // What makes the oracle below the LIVE code rather than a copy of it.
    const exec = readFileSync(resolve("src/run/execute.ts"), "utf8");
    const call = exec.slice(exec.indexOf("const authored = captureAuthoredFilesWithHealth("));
    expect(call.length, "execute.ts's authored capture moved or was renamed — re-anchor").toBeLessThan(exec.length);
    // The whole options argument IS the shared call — a spread-and-override (`{ ...authoredCaptureOpts(…),
    // priorityGlobs: [] }`) or a trailing extra argument would diverge the live capture from the re-grade.
    expect(call.slice(0, call.indexOf(");\n"))).toMatch(/,\s*authoredCaptureOpts\(\{[^{}]*\}\),?\s*$/);
  });

  it("calls the capture with exactly the shared live option derivation", () => {
    const k = keptRun(author);
    const s = parseScenarioFile(scenarioFile(k.runDir, SEMANTIC_ONLY));
    const r = assertContextFromRunDir(k.runDir, s, { recomputeAuthored: "semantic", priorityGlobs, totalBytes });
    if (!r.ok) throw new Error(`unexpected refusal: ${JSON.stringify(r)}`);

    // The builder's one capture call, argument for argument, against what the live run would pass for the
    // same tree (a kept run is never a resume: multi-turn dirs are refused).
    expect(captureCalls).toHaveLength(1);
    const hashes = readPreRunManifestHashes(k.runDir);
    const liveOpts = authoredCaptureOpts({ workRoot: k.workRoot, runDir: k.runDir, priorityGlobs, totalBytes });
    expect(captureCalls[0]).toEqual([k.workRoot, ["outputs"], [], hashes, liveOpts]);

    const live = captureAuthoredFilesWithHealth(k.workRoot, ["outputs"], [], hashes, liveOpts);
    expect(r.ctx.authoredFiles).toEqual(live.files);
    const report = r.ctx.authoredFiles!.find((f) => f.path === "outputs/report.md");
    expect(report).toBeDefined();
    expect(report!.truncated).toBeFalsy();
    // Same health too — including the scratchpad file the spent budget left out, which proves the
    // scratchpad walk ran on both sides.
    expect(r.ctx.authoredFilesHealth).toEqual(live.health);
    expect(live.health.omittedPaths).toContain("scratchpad/notes.txt");

    // The options are load-bearing: without them the capture is a different set.
    const plain = assertContextFromRunDir(k.runDir, s, { recomputeAuthored: "semantic" });
    if (!plain.ok) throw new Error("unexpected refusal");
    expect(plain.ctx.authoredFiles).not.toEqual(live.files);
  });

  it("passes perFileBytes through to the capture", () => {
    const k = keptRun(author);
    const s = parseScenarioFile(scenarioFile(k.runDir, SEMANTIC_ONLY));
    const r = assertContextFromRunDir(k.runDir, s, { recomputeAuthored: "semantic", priorityGlobs, totalBytes, perFileBytes: 512 });
    if (!r.ok) throw new Error("unexpected refusal");
    const expected = captureAuthoredFilesWithHealth(
      k.workRoot,
      ["outputs"],
      [],
      readPreRunManifestHashes(k.runDir),
      authoredCaptureOpts({ workRoot: k.workRoot, runDir: k.runDir, priorityGlobs, totalBytes, perFileBytes: 512 }),
    );
    expect(r.ctx.authoredFiles).toEqual(expected.files);
    // The non-priority intermediates file is cut at the per-file cap, not at the remaining total.
    const junk = r.ctx.authoredFiles!.find((f) => f.path === "outputs/_work/junk.md");
    expect(junk?.truncated).toBe(true);
    expect(Buffer.byteLength(junk!.content, "utf8")).toBeLessThanOrEqual(512);
  });

  it("the default mode does not capture for a semantic-only scenario (verify-run unchanged)", () => {
    const k = keptRun(author);
    const s = parseScenarioFile(scenarioFile(k.runDir, SEMANTIC_ONLY));
    const r = assertContextFromRunDir(k.runDir, s, { priorityGlobs, totalBytes });
    if (!r.ok) throw new Error("unexpected refusal");
    expect(r.ctx.authoredFiles).toBeUndefined();
    expect(r.ctx.authoredFilesHealth).toBeUndefined();
    expect("secrets" in r.ctx).toBe(false);
  });
});

describe("assertContextFromRunDir: secrets scrub the authored-file section", () => {
  it("a secret planted only in an authored file is redacted from the judged document when secrets are passed", () => {
    const SECRET = "sk-test-planted-4f9a1c7e2b";
    const k = keptRun((w) => writeFileSync(join(w, "outputs", "report.md"), `token used: ${SECRET}\n`));
    const s = parseScenarioFile(scenarioFile(k.runDir, SEMANTIC_ONLY));

    const withSecrets = assertContextFromRunDir(k.runDir, s, { recomputeAuthored: "semantic", secrets: [SECRET] });
    if (!withSecrets.ok) throw new Error("unexpected refusal");
    const doc = composeJudgedDocument(withSecrets.ctx).doc;
    expect(doc).toContain("outputs/report.md");
    expect(doc).toContain("[REDACTED]");
    expect(doc).not.toContain(SECRET);

    // Negative control: the same ctx without secrets carries the raw value, so the redaction above came
    // from the authored section, not from a section that never held it.
    const without = assertContextFromRunDir(k.runDir, s, { recomputeAuthored: "semantic" });
    if (!without.ok) throw new Error("unexpected refusal");
    expect(composeJudgedDocument(without.ctx).doc).toContain(SECRET);
  });
});

const WRITE_BACK_ONLY = `  - no_lost_write_back: true\n`;

describe("assertContextFromRunDir: which asserted keys recapture authored files", () => {
  const author = (w: string) => writeFileSync(join(w, "outputs", "report.md"), "# Report\n");
  const cases: Array<[mode: "no_lost_write_back" | "semantic" | "both" | undefined, yaml: string, captures: boolean]> = [
    [undefined, WRITE_BACK_ONLY, true],
    [undefined, SEMANTIC_ONLY, false],
    ["semantic", SEMANTIC_ONLY, true],
    // "semantic" is semantic-only: it does not recapture for no_lost_write_back.
    ["semantic", WRITE_BACK_ONLY, false],
    ["both", SEMANTIC_ONLY, true],
    ["both", WRITE_BACK_ONLY, true],
  ];
  for (const [mode, yaml, captures] of cases) {
    it(`mode ${mode ?? "(default)"} + ${yaml === SEMANTIC_ONLY ? "semantic_matches" : "no_lost_write_back"} → ${captures ? "captures" : "no capture"}`, () => {
      const k = keptRun(author);
      const s = parseScenarioFile(scenarioFile(k.runDir, yaml));
      const r = assertContextFromRunDir(k.runDir, s, mode ? { recomputeAuthored: mode } : {});
      if (!r.ok) throw new Error(`unexpected refusal: ${JSON.stringify(r)}`);
      expect(captureCalls).toHaveLength(captures ? 1 : 0);
      if (captures) expect(r.ctx.authoredFiles?.map((f) => f.path)).toEqual(["outputs/report.md"]);
      else expect(r.ctx.authoredFiles).toBeUndefined();
    });
  }
});

describe("assertContextFromRunDir: the final answer reaches the judged document", () => {
  it("carries result.json's finalMessage, so the rebuilt document has the live run's Final answer section", () => {
    const FINAL = "The concentration risk is 62% in one customer.";
    const k = keptRun((w) => writeFileSync(join(w, "outputs", "report.md"), "# Report\n"), { finalMessage: FINAL });
    const s = parseScenarioFile(scenarioFile(k.runDir, SEMANTIC_ONLY));
    const r = assertContextFromRunDir(k.runDir, s, { recomputeAuthored: "semantic" });
    if (!r.ok) throw new Error(`unexpected refusal: ${JSON.stringify(r)}`);
    expect(r.ctx.finalMessage).toBe(FINAL);
    expect(composeJudgedDocument(r.ctx).doc).toContain(`## Final answer\n${FINAL}`);
  });
});

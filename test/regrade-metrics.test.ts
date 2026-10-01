// regrade re-extracts the scenario's declared metrics from the kept work dir into the regrade file and runs[],
// reading a file only while its bytes still match the run's own recorded post-run hash (RunResult.workspaceFiles):
// a file edited after the run — even under --allow-doc-drift — is `pruned`, never the edited number.
// The kept run is a real tree: a pre-run manifest captured by the production function, then the run's writes.
// Synthetic data only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { regradeEnvelope, regradeRuns } from "../src/run/regrade.js";
import { capturePreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { DEFAULT_AUTHORED_TOTAL_BYTES } from "../src/run/artifacts.js";
import type { SemanticJudge } from "../src/assert.js";
import type { LaunchPlan } from "../src/session.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let savedRuns: string | undefined;
beforeEach(() => {
  savedRuns = process.env.COWORK_HARNESS_RUNS_DIR;
  process.env.COWORK_HARNESS_RUNS_DIR = mkdtempSync(join(tmpdir(), "rgm-runs-"));
});
afterEach(() => {
  if (savedRuns === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
  else process.env.COWORK_HARNESS_RUNS_DIR = savedRuns;
});

const judge = (): SemanticJudge => {
  const j: SemanticJudge = async (rubric) => rubric.map((claim, index) => ({ index, claim, pass: true, rationale: "ok" }));
  j.model = "claude-opus-4-8";
  return j;
};

const SEM = `  - semantic_matches:\n      rubric: ["the report names the risk"]\n`;
function keptRun(metricsYaml: string, recordHashes = true) {
  const runDir = mkdtempSync(join(tmpdir(), "rgm-"));
  const workRoot = join(runDir, "work", "session", "mnt");
  mkdirSync(join(workRoot, "outputs"), { recursive: true });
  const plan = {
    configDir: mkdtempSync(join(tmpdir(), "rgm-cfg-")),
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    resume: false,
    capturePreRun: true,
  } as unknown as LaunchPlan;
  capturePreRunManifest(plan, workRoot, runDir, "container");
  const m = '{"words": 1200}';
  writeFileSync(join(workRoot, "outputs", "m.json"), m);
  const scenarioFile = join(mkdtempSync(join(tmpdir(), "rgm-scn-")), "s.yaml");
  writeFileSync(scenarioFile, `name: rg\nprompt: p\nfidelity: container\nassert:\n${SEM}${metricsYaml}`);
  const t1 = join(runDir, "turns", "1");
  mkdirSync(t1, { recursive: true });
  writeFileSync(
    join(t1, "result.json"),
    JSON.stringify({
      scenario: "rg",
      fidelity: "container",
      result: "success",
      decisions: [],
      assertions: [],
      egress: [],
      subagents: [],
      gateDeliveries: [],
      outDir: runDir,
      workDir: workRoot,
      scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
      userVisibleRoots: ["outputs"],
      readonlyFolderRoots: [],
      preRunHashes: readPreRunManifestHashes(runDir),
      authoredCapture: { totalBytes: DEFAULT_AUTHORED_TOTAL_BYTES, scratchpadWalked: false },
      ...(recordHashes ? { workspaceFiles: [{ path: "outputs/m.json", bytes: m.length, sha256: sha(m), class: "output" }] } : {}),
    }),
  );
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "transcript", text: "wrote it" }));
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [] }));
  return { runDir, workRoot, scenarioFile };
}
const METRIC = `metrics:\n  - {id: words, artifact: outputs/m.json, path: words, better: higher, scale: 5000}\n`;
const regrade = (k: ReturnType<typeof keptRun>, extra = {}) =>
  regradeRuns({ runDirs: [k.runDir], scenarioFile: k.scenarioFile, makeJudge: () => judge(), allowUnchecked: true, ...extra });

describe("regrade: metrics", () => {
  it("a re-extracted metric is in the regrade file and in runs[]; the envelope validates", async () => {
    const k = keptRun(METRIC);
    const out = await regrade(k);
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].metrics).toEqual([{ id: "words", value: 1200 }]);
    const file = JSON.parse(readFileSync(out.runs[0].regradeFile, "utf8"));
    expect(file.metrics).toEqual([{ id: "words", value: 1200 }]);
    const validate = new Ajv({ strict: true }).compile(JSON.parse(readFileSync(resolve("schema/regrade.json"), "utf8")));
    const env = JSON.parse(regradeEnvelope(out, []));
    expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
  });

  it("a file edited after the run is pruned, with or without --allow-doc-drift — never the edited number", async () => {
    for (const allowDocDrift of [false, true]) {
      const k = keptRun(METRIC);
      writeFileSync(join(k.workRoot, "outputs", "m.json"), '{"words": 99999}');
      const out = await regrade(k, { allowDocDrift });
      if (!out.ok) throw new Error(out.message);
      expect(out.runs[0].metrics, `allowDocDrift=${allowDocDrift}`).toEqual([{ id: "words", unavailable: "pruned" }]);
    }
  });

  it("a run that recorded no post-run hashes: pruned (nothing to anchor the kept bytes to)", async () => {
    const out = await regrade(keptRun(METRIC, false));
    if (!out.ok) throw new Error(out.message);
    expect(out.runs[0].metrics).toEqual([{ id: "words", unavailable: "pruned" }]);
  });

  it("absent when none are declared, and for metrics: []", async () => {
    for (const yaml of ["", "metrics: []\n"]) {
      const out = await regrade(keptRun(yaml));
      if (!out.ok) throw new Error(out.message);
      expect(out.runs[0]).not.toHaveProperty("metrics");
      expect(JSON.parse(readFileSync(out.runs[0].regradeFile, "utf8"))).not.toHaveProperty("metrics");
    }
  });
});

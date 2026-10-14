import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertContextFromRunDir } from "../src/run/verify-context.js";
import { capturePreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import type { LaunchPlan } from "../src/session.js";
import type { Scenario } from "../src/types.js";

// Re-grading a kept run on a search_corpus_* key: a run with no frozen corpus is refused (usage); one recorded before
// the corpus kept its tool-use counts is refused (runtime). Never a pass, never a skip.
function keptRun(searchCorpus?: unknown): string {
  const runDir = mkdtempSync(join(tmpdir(), "cwh-scr-"));
  const workRoot = join(runDir, "work", "session", "mnt");
  mkdirSync(join(workRoot, "outputs"), { recursive: true });
  const plan: LaunchPlan = {
    configDir: mkdtempSync(join(tmpdir(), "cwh-scr-cfg-")),
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
  capturePreRunManifest(plan, workRoot, runDir, "container");
  const result = {
    scenario: "sc",
    fidelity: "container",
    result: "success",
    decisions: [],
    toolCounts: {},
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
    ...(searchCorpus ? { searchCorpus } : {}),
  };
  const t1 = join(runDir, "turns", "1");
  mkdirSync(t1, { recursive: true });
  writeFileSync(join(t1, "result.json"), JSON.stringify(result));
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "sc" }));
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [] }));
  return runDir;
}
const scenario = (assert: Scenario["assert"]) => ({ name: "sc", prompt: "p", fidelity: "container", assert }) as Scenario;
const base = { poolId: "p", sha256: "a".repeat(64), label: "l", miss: "empty", interposition: "proxy-env+ca", credentialSource: "env" };

describe("re-grading a search_corpus_* key", () => {
  it("refuses (usage) a run that had no frozen search corpus, naming the key", () => {
    const r = assertContextFromRunDir(keptRun(), scenario([{ search_corpus_max_miss_rate: 0.5 }]), { command: "regrade" });
    expect(r).toMatchObject({ ok: false, kind: "usage" });
    expect((r as { message: string }).message).toMatch(
      /regrade: `search_corpus_max_miss_rate` needs a run served from a frozen search corpus/,
    );
  });
  it("refuses (runtime) a run recorded before the corpus kept its tool-use counts and calls", () => {
    const old = {
      ...base,
      metrics: { requests: 1, served: 1, miss: 0, refused: 0, retriesFolded: 0, unfinished: 0, passedThroughWithSearchTool: 0 },
    };
    const r = assertContextFromRunDir(keptRun(old), scenario([{ search_corpus_nearby_citations: { path: "outputs/r.md" } }]));
    expect(r).toMatchObject({ ok: false, kind: "runtime" });
    expect((r as { message: string }).message).toMatch(/recorded by an older harness.*re-run it/);
  });
  it("builds the context, with the run's corpus record, for a current frozen run; a scenario without the keys is untouched", () => {
    const cur = {
      ...base,
      metrics: {
        requests: 0,
        served: 0,
        miss: 0,
        refused: 0,
        retriesFolded: 0,
        unfinished: 0,
        passedThroughWithSearchTool: 0,
        toolUses: 0,
        noRequest: 0,
      },
      calls: [],
    };
    const r = assertContextFromRunDir(keptRun(cur), scenario([{ search_corpus_max_miss_rate: 0 }]));
    expect(r.ok).toBe(true);
    expect((r as { ctx: { searchCorpus?: unknown } }).ctx.searchCorpus).toMatchObject({ poolId: "p" });
    expect(assertContextFromRunDir(keptRun(), scenario([{ result: "success" }])).ok).toBe(true);
  });
});

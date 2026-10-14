// `eval --search-corpus`, driven in-process with a FAKE runner (no agent, no token): the pin, the private pool copy,
// the provenance refusal, the two buckets and their round trip through runs.jsonl, the per-arm metrics, the asymmetry
// marker and the exit code. The pin refusal is a REAL `SearchPoolPinError` thrown by the runner and written by the
// runs.jsonl producer, never a hand-written line.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { buildFingerprint } from "../src/run/cassette.js";
import { runOutDir } from "../src/run/execute.js";
import { runEval, parseEvalArgs, type EvalJobSpec } from "../src/eval/command.js";
import { readManifest } from "../src/eval/manifest.js";
import { buildEvalReport } from "../src/eval/report.js";
import { readRunsLines } from "../src/eval/runs.js";
import { evalJobExecuteOptions } from "../src/eval/job-runner.js";
import { SearchPoolPinError, PoolBuildError } from "../src/search-corpus/pool.js";
import { poolRecord, writeFixturePool } from "./search-corpus-fixture-pool.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
const fixture = (name: string): RunResult => JSON.parse(readFileSync(join(FX, `${name}.json`), "utf8")) as RunResult;
const CSV_ASSERTS = `assert:
  - result: success
  - tool_called: Skill
`;

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pe-sc-")));
  for (const k of ["COWORK_HARNESS_RUNS_DIR", "COWORK_HARNESS_MODEL", "COWORK_HARNESS_JUDGE_MODEL"]) saved[k] = process.env[k];
  process.env.COWORK_HARNESS_RUNS_DIR = join(root, "runs");
  delete process.env.COWORK_HARNESS_MODEL;
  delete process.env.COWORK_HARNESS_JUDGE_MODEL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(dir: string, body: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "csv-metrics" }));
  mkdirSync(join(dir, "skills", "csv-metrics"), { recursive: true });
  writeFileSync(join(dir, "skills", "csv-metrics", "SKILL.md"), `---\nname: csv-metrics\ndescription: d\n---\n${body}\n`);
}

function setup() {
  const scen = join(root, "scenarios");
  mkdirSync(scen, { recursive: true });
  writePlugin(join(root, "declared", "csv-metrics"), "declared");
  writePlugin(join(root, "a", "csv-metrics"), "version A");
  writePlugin(join(root, "b", "csv-metrics"), "version B");
  writeFileSync(join(root, "session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared/csv-metrics\n`);
  writeFileSync(
    join(scen, "csv-metrics.yaml"),
    `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: analyze\n${CSV_ASSERTS}`,
  );
  return { scen, a: join(root, "a", "csv-metrics"), b: join(root, "b", "csv-metrics") };
}

/** A pool of a third variant's records for the eval's scenario: disjoint from both arms. */
function disjointPool(o: { dups?: number } = { dups: 0 }) {
  const dir = join(root, "pool");
  writeFixturePool(
    dir,
    Array.from({ length: 4 }, () => poolRecord({ scenario: "csv-metrics", variantHash: "third-variant" })),
    o,
  );
  return dir;
}

type Behaviour = (spec: EvalJobSpec, r: RunResult) => RunResult;

/** The fake runner: a kept-run excerpt, fingerprinted over the job's session, served from the job's pinned corpus. */
function fakeRunner(behaviour: Behaviour = (_s, r) => r, calls: EvalJobSpec[] = []) {
  return async (spec: EvalJobSpec): Promise<RunResult> => {
    calls.push(spec);
    const baseline = loadBaseline(spec.scenario.baseline);
    const outDir = runOutDir(spec.scenario.name, spec.job.runId);
    mkdirSync(outDir, { recursive: true });
    const sc = spec.searchCorpus!;
    const r = {
      ...fixture("public-scenario-pinned"),
      scenario: spec.scenario.name,
      modelPinHonored: true,
      outDir,
      fingerprint: buildFingerprint(spec.scenario.session, baseline.appVersion, undefined, spec.scenario.skills, baseline, spec.session),
      searchCorpus: {
        poolId: "fixture",
        sha256: sc.expect!.sha256,
        label: "frozen search corpus fixture@test",
        miss: sc.miss,
        interposition: "proxy-env+ca",
        credentialSource: "env",
        metrics: { requests: 12, served: 12, miss: 0, refused: 0, meanTopScore: 0.7, toolUses: 12, noRequest: 0 },
        calls: [],
      },
    } as unknown as RunResult;
    return behaviour(spec, r);
  };
}

const args = (scen: string, a: string, b: string, extra: string[] = []) =>
  parseEvalArgs([
    scen,
    "--arm",
    `before=${a}`,
    "--arm",
    `after=${b}`,
    "--out",
    join(root, "eval"),
    "--quiet",
    "--concurrency",
    "1",
    ...extra,
  ]);

const deps = (runJob: (s: EvalJobSpec) => Promise<RunResult>, log: string[] = []) => ({
  runJob,
  tokenCheck: () => ({ id: "token", title: "Auth token", status: "ok" as const, detail: "found", required: true }),
  isolationCheck: () => undefined,
  log: (s: string) => log.push(s),
  evalId: "sc1",
  now: () => new Date("2026-10-15T00:00:00Z"),
  searchCorpusPreflight: () => null,
});

const refusedSearch = (r: RunResult): RunResult =>
  ({ ...r, searchCorpus: { ...r.searchCorpus!, metrics: { ...r.searchCorpus!.metrics, refused: 1 } } }) as RunResult;

describe("eval --search-corpus: the pin and the copy", () => {
  it("pins the pool, copies it into the eval dir, and serves every rep from the copy with the pin attached", async () => {
    const { scen, a, b } = setup();
    const pool = disjointPool();
    const calls: EvalJobSpec[] = [];
    const out = await runEval(args(scen, a, b, ["--search-corpus", pool]), deps(fakeRunner(undefined, calls)));
    const m = readManifest(out.evalDir);
    expect(m.schemaVersion).toBe(1);
    expect(m.pins.searchCorpus).toMatchObject({ poolId: "fixture", miss: "empty", copy: "search-pool" });
    expect(m.searchCorpusProvenance?.class).toBe("disjoint");
    expect(calls).toHaveLength(10);
    for (const c of calls) {
      // what each rep's ExecuteOptions carries: the copy, never the source, and the pin
      const opts = evalJobExecuteOptions(c);
      expect(opts.searchCorpus).toEqual({
        pool: join(out.evalDir, "search-pool"),
        miss: "empty",
        expect: { sha256: m.pins.searchCorpus!.sha256, miss: "empty" },
      });
    }
    expect(out.report.summary.exitCode).toBe(0);
    expect(out.report.summary.searchPoolMismatch).toEqual({ reps: 0, byArm: { before: 0, after: 0 } });
  });

  it("a manifest without the pin under schemaVersion 1 is refused as inconsistent", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b, ["--search-corpus", disjointPool()]), deps(fakeRunner()));
    const p = join(out.evalDir, "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    delete m.pins.searchCorpus;
    writeFileSync(p, JSON.stringify(m));
    expect(() => readManifest(out.evalDir)).toThrow(/inconsistent with schemaVersion 1/);
  });
});

describe("eval --search-corpus: provenance before any spend", () => {
  it("a pool drawn from one arm is refused before any run, and runs labelled CONFOUNDED with --allow-confounded-pool", async () => {
    const { scen, a, b } = setup();
    // First run to learn arm B's signature for the scenario (the same fingerprint call a rep makes).
    const first = await runEval(args(scen, a, b, ["--search-corpus", disjointPool()]), deps(fakeRunner()));
    const sigB = first.manifest.arms[1].sigs["csv-metrics"]!;
    rmSync(join(root, "eval"), { recursive: true, force: true });
    const oneSided = join(root, "pool-b");
    writeFixturePool(
      oneSided,
      Array.from({ length: 3 }, () => poolRecord({ scenario: "csv-metrics", variantHash: sigB })),
      { dups: 0 },
    );
    const calls: EvalJobSpec[] = [];
    await expect(runEval(args(scen, a, b, ["--search-corpus", oneSided]), deps(fakeRunner(undefined, calls)))).rejects.toThrow(
      /come from after .*--allow-confounded-pool/,
    );
    expect(calls).toHaveLength(0);
    const out = await runEval(args(scen, a, b, ["--search-corpus", oneSided, "--allow-confounded-pool"]), deps(fakeRunner()));
    expect(out.report.summary.confounded).toEqual({ provenance: "one-sided" });
    expect(readFileSync(join(out.evalDir, "report.md"), "utf8")).toMatch(/CONFOUNDED: pool drawn from after \(--allow-confounded-pool\)/);
    expect(out.report.summary.exitCode).toBe(0); // CONFOUNDED never gates
  });

  it("a mixed pool needs --allow-mixed-pool", async () => {
    const { scen, a, b } = setup();
    const dir = join(root, "mixed");
    writeFixturePool(dir, [poolRecord({ scenario: "csv-metrics", variantHash: "x" })], { dups: 0, mixed: true });
    await expect(runEval(args(scen, a, b, ["--search-corpus", dir]), deps(fakeRunner()))).rejects.toThrow(/mixed pool.*--allow-mixed-pool/);
  });
});

describe("eval --search-corpus: the pin refusal survives runs.jsonl", () => {
  it("ONE rep refused before it ran (a real SearchPoolPinError) is search_pool_mismatch, named, and the eval exits 1", async () => {
    const { scen, a, b } = setup();
    const runner = fakeRunner();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(async (s) => {
        if (s.job.arm === "after" && s.job.rep === 2)
          throw new SearchPoolPinError(
            s.searchCorpus!.expect!,
            { sha256: "e".repeat(64), miss: "empty" },
            "the copy is not the pinned one",
          );
        return runner(s);
      }),
    );
    // The report is rebuilt from runs.jsonl alone: the producer wrote the kind and the record, the reader revived them.
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    const line = lines.find((l) => l.thrown)!;
    expect(line.thrown!.kind).toBe("search_pool_pin");
    expect(line.searchPoolMismatch?.got).toEqual({ sha256: "e".repeat(64), miss: "empty" });
    const rep = buildEvalReport(out.evalDir);
    const r = rep.reps.find((x) => x.arm === "after" && x.rep === 2)!;
    expect(r).toMatchObject({ bucket: "search_pool_mismatch", rule: "thrown_search_pool_pin", unclassified: false });
    expect(rep.arms[1].errorSources["thrown:search_pool_pin"]).toBe(1);
    expect(rep.summary.searchPoolMismatch).toEqual({ reps: 1, byArm: { before: 0, after: 1 } });
    // exit 1 from the single-rep term, not from comparedNothing: the arm's other reps compared
    expect(rep.summary.erroredArms).toEqual([]);
    expect(rep.summary.exitCode).toBe(1);
    expect(readFileSync(join(out.evalDir, "report.md"), "utf8")).toMatch(/1 rep\(s\) were not served from the pinned pool/);
  });

  it("a copy that could not be read (PoolBuildError) is the same bucket, recorded with nothing observed", async () => {
    const { scen, a, b } = setup();
    const runner = fakeRunner();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(async (s) => {
        if (s.job.arm === "before" && s.job.rep === 1) throw new PoolBuildError("the pool copy could not be read");
        return runner(s);
      }),
    );
    const line = readRunsLines(join(out.evalDir, "runs.jsonl")).lines.find((l) => l.thrown)!;
    expect(line.searchPoolMismatch).toMatchObject({ got: null, expected: { sha256: out.manifest.pins.searchCorpus!.sha256 } });
    expect(buildEvalReport(out.evalDir).summary.searchPoolMismatch!.reps).toBe(1);
  });

  it("a persisted mismatched hash beside an infra stop is still search_pool_mismatch, and keeps the infra rule", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(
        fakeRunner((s, r) =>
          s.job.arm === "after" && s.job.rep === 1
            ? ({
                ...r,
                result: "error",
                errorSource: "result",
                resultErrorKind: "usage_limit",
                searchCorpus: { ...r.searchCorpus!, sha256: "d".repeat(64) },
              } as RunResult)
            : r,
        ),
      ),
    );
    const r = out.report.reps.find((x) => x.arm === "after" && x.rep === 1)!;
    expect(r).toMatchObject({ bucket: "search_pool_mismatch", rule: "kind_usage_limit" });
  });

  it("every rep of an arm mismatched is comparedNothing and named", async () => {
    const { scen, a, b } = setup();
    const runner = fakeRunner();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(async (s) => {
        if (s.job.arm === "after") throw new SearchPoolPinError(s.searchCorpus!.expect!, null, "unreadable copy");
        return runner(s);
      }),
    );
    expect(out.report.summary.erroredArms).toMatchObject([
      { arm: "after", scenario: "csv-metrics", rowsInsufficient: true, dominant: { bucket: "search_pool_mismatch" } },
    ]);
    expect(out.report.summary.exitCode).toBe(1);
  });
});

describe("eval --search-corpus: a refused search excludes the rep (R10-4)", () => {
  it("search_refused outranks an agent error, joins the errored arms, and is excluded from every row", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(
        fakeRunner((s, r) =>
          s.job.arm === "after"
            ? (refusedSearch({ ...r, result: "error", errorSource: "result", resultErrorKind: "agent" } as RunResult) as RunResult)
            : r,
        ),
      ),
    );
    expect(out.report.arms[1].buckets).toEqual({ search_refused: 5 });
    expect(out.report.summary.erroredArms).toMatchObject([
      { arm: "after", rowsInsufficient: true, dominant: { bucket: "search_refused" } },
    ]);
    expect(out.report.searchCorpus!.arms.after!.refusedReps).toBe(5);
    expect(out.report.summary.exitCode).toBe(1);
  });

  it("a rep with no frozen corpus is never search_refused", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(fakeRunner((s, r) => (s.job.arm === "after" && s.job.rep === 1 ? ({ ...r, searchCorpus: undefined } as RunResult) : r))),
    );
    // under a pin, a result with no corpus ran live: that is a mismatch, not a refusal
    expect(out.report.reps.find((x) => x.arm === "after" && x.rep === 1)!.bucket).toBe("search_pool_mismatch");
  });
});

describe("eval --search-corpus: per-arm metrics and the asymmetry marker", () => {
  it("prints both arms side by side and marks an asymmetric comparison CONFOUNDED without gating", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(
        fakeRunner((s, r) =>
          s.job.arm === "after"
            ? ({ ...r, searchCorpus: { ...r.searchCorpus!, metrics: { ...r.searchCorpus!.metrics, served: 8, miss: 4 } } } as RunResult)
            : r,
        ),
      ),
    );
    const sc = out.report.searchCorpus!;
    expect(sc.arms.before!.total).toMatchObject({ served: 60, miss: 0, missRate: 0 });
    expect(sc.arms.after!.total.missRate).toBeCloseTo(20 / 60);
    expect(sc.asymmetry.total).toMatchObject({ judged: true, fires: true });
    expect(sc.asymmetry.thresholds).toEqual({ missGap: 0.1, topRatio: 0.8, minSearches: 11, placeholder: true });
    expect(out.report.summary.confounded).toEqual({ asymmetry: true });
    expect(out.report.summary.exitCode).toBe(0);
    const md = readFileSync(join(out.evalDir, "report.md"), "utf8");
    expect(md).toMatch(/Search: \[frozen search corpus fixture@/);
    expect(md).toMatch(/a placeholder threshold.*CONFOUNDED/);
    expect(md).toMatch(/search \(scored reps\): 60 served, 0 miss/);
  });

  it("counts the reps graded by a judge on recorded searches, per arm", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b, ["--search-corpus", disjointPool()]),
      deps(
        fakeRunner(
          (s, r) =>
            ({
              ...r,
              verdict: { ...(r.verdict ?? {}), signals: [{ code: "search_corpus_semantic_judge", severity: "warn", message: "x" }] },
            }) as unknown as RunResult,
        ),
      ),
    );
    expect(out.report.searchCorpus!.arms.before!.judgeWarned).toBe(5);
    expect(readFileSync(join(out.evalDir, "report.md"), "utf8")).toMatch(/5 rep\(s\) graded by a judge on recorded searches/);
  });
});

describe("the pin evidence channels, each on its own", () => {
  it("the line's searchPoolMismatch record alone buckets the rep (the revived error is the other channel)", async () => {
    const { classifyRep } = await import("../src/eval/classify.js");
    const { repEvidenceOf } = await import("../src/eval/runs.js");
    const line = {
      v: 0 as const,
      index: 0,
      arm: "after",
      scenario: "csv-metrics",
      rep: 1,
      runId: "x",
      runDir: null,
      searchPoolMismatch: { expected: { sha256: "a".repeat(64), miss: "empty" }, got: null, message: "unreadable copy" },
      grades: [],
    };
    const ev = repEvidenceOf(line);
    expect(ev.searchPoolMismatch).toEqual(line.searchPoolMismatch);
    expect(classifyRep(ev, {}).bucket).toBe("search_pool_mismatch");
  });
});

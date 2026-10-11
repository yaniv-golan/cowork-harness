import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDirEvidence, isRealRun } from "../src/run/runs-gc.js";
import { runLabelOf } from "../src/run/run-labels.js";
import { reindexFromRunsTree, type RunIndexRow } from "../src/run/run-index.js";
import { findLatestRunForScenario, findLatestRunUnderRoot } from "../src/run/latest-run.js";
import { resolveEventsFile } from "../src/run/trace-view.js";
import { assessRunDir } from "../src/run/migrate-run-dir.js";
import { legTreeRoot } from "../src/run/turn-layout.js";
import { assertContextFromRunDir } from "../src/run/verify-context.js";
import { exportFixture } from "../src/fixture/export.js";
import { MultiLegRunDirError } from "../src/errors.js";
import { SCENARIO_RESULT_SCHEMA } from "../src/run/scenario-result.js";
import type { Scenario } from "../src/types.js";

// Every reader that meets a multi-leg run dir either understands the `legs` shape or refuses it loudly; none reads
// leg 1 alone, or nothing. These drive the real readers over real on-disk trees.

let root: string;
let prevRuns: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "multi-leg-readers-"));
  prevRuns = process.env.COWORK_HARNESS_RUNS_DIR;
  process.env.COWORK_HARNESS_RUNS_DIR = root;
});
afterEach(() => {
  if (prevRuns === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
  else process.env.COWORK_HARNESS_RUNS_DIR = prevRuns;
  rmSync(root, { recursive: true, force: true });
});

const write = (p: string, body: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};
const verdict = (pass: boolean) => ({ pass, exitCode: pass ? 0 : 1, signals: [], guards: [], failures: [] });
const setMtime = (p: string, iso: string) => utimesSync(p, new Date(iso), new Date(iso));

/** A multi-leg scenario root under <root>/<slug>/<runId>: legs ask (prompt), apply (action), resume (prompt). */
function legsRun(
  slug: string,
  runId: string,
  opts: { complete?: boolean; workdir?: "persistent" | "cowork-task"; status?: string; label?: string; finishedAt?: string } = {},
): string {
  const dir = join(root, slug, runId);
  mkdirSync(dir, { recursive: true });
  if (opts.status !== undefined) write(join(dir, "status.json"), opts.status);
  const workdir = opts.workdir ?? "persistent";
  const legs: Array<[string, "prompt" | "action"]> = [
    ["ask", "prompt"],
    ["apply", "action"],
    ["resume", "prompt"],
  ];
  legs.forEach(([id, kind], index) => {
    const ld = join(dir, "legs", id);
    write(join(ld, "leg.json"), JSON.stringify({ scenarioRoot: "../..", id, index, kind, workdir }));
    if (kind === "prompt") {
      write(join(ld, "events.jsonl"), "");
      write(join(ld, "turns", "1", "run.jsonl"), "");
      write(
        join(ld, "turns", "1", "result.json"),
        JSON.stringify({ scenario: slug, verdict: verdict(true), outputsDir: join(dir, "work", "outputs") }),
      );
      if (workdir === "cowork-task") mkdirSync(join(ld, "work", "outputs"), { recursive: true });
    } else write(join(ld, "action.json"), "{}");
  });
  if (workdir === "persistent") mkdirSync(join(dir, "work", "outputs"), { recursive: true });
  if (opts.complete !== false) {
    const indexRow: RunIndexRow = {
      v: 1,
      ts: "2026-10-12T00:00:00.000Z",
      command: "run",
      scenario: slug,
      slug,
      runId,
      fidelity: "container",
      baseline: "b",
      result: "success",
      pass: true,
      multiLeg: true,
      signals: [],
      partial: false,
      nonDeterministic: false,
      outDir: dir,
      git: { branch: null, sha: null },
      ...(opts.label ? { runLabel: opts.label } : {}),
    } as RunIndexRow;
    const sr = join(dir, "scenario-result.json");
    write(
      sr,
      JSON.stringify({
        schema: SCENARIO_RESULT_SCHEMA,
        version: 1,
        scenario: slug,
        verdict: verdict(true),
        legs: legs.map(([id, kind]) => ({ id, kind, status: "passed" })),
        startedAt: "2026-10-12T00:00:00.000Z",
        finishedAt: opts.finishedAt ?? "2026-10-12T00:10:00.000Z",
        durationMs: 1,
        ...(opts.label ? { runLabel: opts.label } : {}),
        indexRow,
      }),
    );
    if (opts.finishedAt) setMtime(sr, opts.finishedAt);
  }
  return dir;
}

/** An ordinary single run dir, finished at `finishedAt`. */
function singleRun(slug: string, runId: string, finishedAt: string): string {
  const dir = join(root, slug, runId);
  write(join(dir, "status.json"), JSON.stringify({ startedAt: "2026-10-11T00:00:00.000Z" }));
  write(join(dir, "events.jsonl"), "");
  write(join(dir, "turns", "1", "run.jsonl"), "");
  const rp = join(dir, "turns", "1", "result.json");
  write(rp, JSON.stringify({ scenario: slug, verdict: verdict(false) }));
  setMtime(rp, finishedAt);
  return dir;
}

describe("prune: a multi-leg root is a real run, finished or not", () => {
  it("an in-flight root (leg markers only, no events anywhere yet) is real", () => {
    const dir = legsRun("s", "local_1", { complete: false });
    rmSync(join(dir, "legs", "ask", "events.jsonl"));
    rmSync(join(dir, "legs", "resume", "events.jsonl"));
    expect(runDirEvidence(dir).legs).toBe(true);
    expect(isRealRun(dir)).toBe(true);
  });
  it("a leg's events.jsonl counts as the run's events evidence", () => {
    const dir = legsRun("s", "local_1", { complete: false });
    expect(runDirEvidence(dir).events).toBe(true);
  });
  it("runLabelOf never throws on a multi-leg root: damaged status.json, unfinished → undefined; finished → its label", () => {
    const inflight = legsRun("s", "local_1", { complete: false, status: "{not json" });
    expect(() => runLabelOf(inflight)).not.toThrow();
    expect(runLabelOf(inflight)).toBeUndefined();
    const done = legsRun("s", "local_2", { status: "{not json", label: "exp-a" });
    expect(runLabelOf(done)).toBe("exp-a");
  });
});

describe("run-index: one roll-up row per multi-leg run", () => {
  it("a finished two-prompt-leg run yields exactly one row, from scenario-result.json, never one per leg", () => {
    legsRun("s", "local_1");
    const r = reindexFromRunsTree(root);
    const mine = r.rows.filter((x) => x.slug === "s");
    expect(mine).toHaveLength(1);
    expect(mine[0].multiLeg).toBe(true);
    expect(r.skippedInFlightLegs).toBe(0);
  });
  it("an unfinished one yields no row and is counted, not half-indexed and not an abort", () => {
    legsRun("s", "local_1", { complete: false });
    const r = reindexFromRunsTree(root); // returning at all is the "no abort" half: listTurns throws on this root
    expect(r.skippedInFlightLegs).toBe(1);
    expect(r.rows.filter((x) => x.multiLeg === true)).toHaveLength(0);
  });
});

describe("status --latest-for: ranks a multi-leg run by its END, never throws", () => {
  it("a newer-ending multi-leg run beats an older single run, and the other way round", () => {
    singleRun("s", "local_1", "2026-10-12T01:00:00.000Z");
    legsRun("s", "local_2", { finishedAt: "2026-10-12T02:00:00.000Z" });
    expect(findLatestRunForScenario(root, "s")?.outDir).toBe(join(root, "s", "local_2"));
    expect(findLatestRunForScenario(root, "s")?.verdict?.pass).toBe(true);
    singleRun("s", "local_3", "2026-10-12T03:00:00.000Z");
    expect(findLatestRunForScenario(root, "s")?.outDir).toBe(join(root, "s", "local_3"));
  });
  it("an in-flight multi-leg root does not throw (it falls to the in-flight start-time fallback)", () => {
    legsRun("s", "local_1", { complete: false, status: JSON.stringify({ startedAt: "2026-10-12T00:00:00.000Z" }) });
    expect(() => findLatestRunForScenario(root, "s")).not.toThrow();
    expect(() => findLatestRunUnderRoot(root)).not.toThrow();
  });
});

describe("resolveEventsFile: a multi-leg candidate is refused, never skipped", () => {
  it("a fragment whose newest match is a multi-leg run refuses rather than picking the older single run", () => {
    const single = singleRun("scn", "local_old", "2026-10-11T00:00:00.000Z");
    utimesSync(single, new Date("2026-10-11T00:00:00Z"), new Date("2026-10-11T00:00:00Z"));
    const legs = legsRun("scn", "local_new");
    utimesSync(legs, new Date("2026-10-12T00:00:00Z"), new Date("2026-10-12T00:00:00Z"));
    expect(() => resolveEventsFile("scn")).toThrow(MultiLegRunDirError);
    expect(() => resolveEventsFile("scn")).toThrow(/matches multi-leg run/);
  });
  it("a fragment matching only a single run resolves", () => {
    singleRun("other", "local_x", "2026-10-11T00:00:00.000Z");
    legsRun("scn", "local_new");
    expect(resolveEventsFile("other")).toBe(join(root, "other", "local_x", "events.jsonl"));
  });
  it("a multi-leg root named directly, or by its exact run id, is refused; a leg dir resolves", () => {
    const legs = legsRun("scn", "local_new");
    expect(() => resolveEventsFile(legs)).toThrow(MultiLegRunDirError);
    expect(() => resolveEventsFile("local_new")).toThrow(MultiLegRunDirError);
    expect(resolveEventsFile(join(legs, "legs", "ask"))).toBe(join(legs, "legs", "ask", "events.jsonl"));
  });
});

describe("migrate-run-dir and the tree-reading readers", () => {
  it("migrate is a no-op on a multi-leg root and on an action leg", () => {
    const dir = legsRun("s", "local_1");
    expect(assessRunDir(dir)).toMatchObject({ kind: "noop" });
    expect(assessRunDir(join(dir, "legs", "apply"))).toMatchObject({ kind: "noop" });
  });

  it("legTreeRoot: persistent last leg → the scenario root's tree; earlier persistent leg → refused; cowork-task → its own", () => {
    const p = legsRun("s", "local_1");
    expect(legTreeRoot(join(p, "legs", "resume"), "x")).toEqual({ root: join(p, "legs", "resume", "..", "..") });
    expect(legTreeRoot(join(p, "legs", "ask"), "x")).toEqual({
      refused: `x: ${join(p, "legs", "ask")} is leg ask of a multi-leg run; its session tree is shared and was changed by later legs, so its post-state is only in post-run-manifest.json.`,
    });
    const unfinished = legsRun("s", "local_2", { complete: false });
    expect("refused" in legTreeRoot(join(unfinished, "legs", "resume"), "x")).toBe(true);
    const c = legsRun("s", "local_3", { workdir: "cowork-task" });
    expect(legTreeRoot(join(c, "legs", "ask"), "x")).toEqual({ root: join(c, "legs", "ask") });
  });

  it("verify-run: the root is refused with the shared message; an earlier persistent leg is refused", () => {
    const p = legsRun("s", "local_1");
    const scn = { name: "s", assert: [] } as unknown as Scenario;
    const atRoot = assertContextFromRunDir(p, scn);
    expect(atRoot).toMatchObject({ ok: false, kind: "runtime" });
    if (!atRoot.ok && "message" in atRoot) expect(atRoot.message).toContain("is a multi-leg run dir (legs: ask, apply, resume)");
    const leg1 = assertContextFromRunDir(join(p, "legs", "ask"), scn);
    expect(leg1).toMatchObject({ ok: false, kind: "runtime" });
    if (!leg1.ok && "message" in leg1) expect(leg1.message).toContain("its session tree is shared");
  });

  it("fixture export: the root and an earlier persistent leg are refused", () => {
    const p = legsRun("s", "local_1");
    const out = join(root, "..", "export-out-" + Date.now());
    const atRoot = exportFixture({ runDir: p, out, allowHostPaths: false, secrets: [] });
    expect(atRoot.exitCode).toBe(2);
    expect(atRoot.message).toContain("multi-leg run dir");
    const leg1 = exportFixture({ runDir: join(p, "legs", "ask"), out, allowHostPaths: false, secrets: [] });
    expect(leg1.exitCode).toBe(2);
    expect(leg1.message).toContain("its session tree is shared");
  });
});

describe("CLI: a refused multi-leg dir is a clean `runtime` refusal, never a stack", () => {
  const CLI = join(process.cwd(), "dist", "cli.js");
  const cli = (args: string[]) => {
    const r = spawnSync("node", [CLI, ...args, "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  it.skipIf(!existsSync(CLI))("inspect, scaffold and verify-run on a multi-leg root", () => {
    const dir = legsRun("s", "local_1");
    for (const args of [
      ["inspect", dir],
      ["scaffold", dir],
      ["verify-run", dir, join(root, "none.yaml")],
    ]) {
      const r = cli(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr + r.stdout, args.join(" ")).not.toMatch(/\n\s+at /); // no stack frames
      expect(r.stdout + r.stderr, args.join(" ")).toMatch(/multi-leg run dir|multi-leg run/);
    }
  });
});

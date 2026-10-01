// `hillclimb regrade` in-process over a flow the REAL CLI built (stub agent, a fake host-`claude` judge replaying a
// captured envelope): the seams a CLI run cannot reach — the core re-grade, the metrics merge — are injected here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
  cpSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLI, POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";
import { mergeMetrics, regradeFlow, type HillclimbRegradeArgs, type RegradeFlowDeps } from "../src/hillclimb/regrade.js";
import { regradeRuns, type RegradeOptions, type RegradeRunReport } from "../src/run/regrade.js";
import { metricSigs } from "../src/hillclimb/metric-keys.js";
import type { ScenarioMetric } from "../src/types.js";
import type { CompleteStructured } from "../src/decide/pairwise-judge.js";
import { checkReport, stateTemplateFor } from "../src/hillclimb/cli.js";

const MODEL = "claude-sonnet-5";
const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const STUB = [
  line({ type: "system", subtype: "init", session_id: "stub", model: MODEL, tools: [], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: { id: "m1", role: "assistant", model: MODEL, content: [{ type: "text", text: "All done." }] },
    session_id: "stub",
  }),
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "All done.",
    session_id: "stub",
    num_turns: 1,
    stop_reason: "end_turn",
    modelUsage: { [MODEL]: { inputTokens: 10, outputTokens: 5, costUSD: 0.01 } },
  }),
  "cat >/dev/null",
].join("\n");
const ENVELOPE = join(import.meta.dirname, "fixtures", "pairwise-judge", "claude-p-json-schema-envelope.json");
const JUDGE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  for f in "--safe-mode" "--strict-mcp-config" "--no-session-persistence" "--setting-sources <s>" "--tools <tools...>"; do echo "  $f   x"; done
  exit 0
fi
cat >/dev/null
cat "${ENVELOPE}"
`;

let f: StubFixture;
let work: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  f = makeStubFixture(STUB);
  work = realpathSync(mkdtempSync(join(tmpdir(), "hc-regrade-")));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  f.cleanup();
  rmSync(work, { recursive: true, force: true });
});

/** A flow: `alpha` (pairwise), and with `withBeta` a deterministic-only `beta`; baseline + v1 passes (`reps` each). */
function buildFlow(opts: { withBeta?: boolean; reps?: number; noPairwise?: boolean; metrics?: string[] } = {}) {
  const plugin = join(work, "plugin", "my-plugin");
  mkdirSync(join(plugin, "skills", "x"), { recursive: true });
  writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
  const evals = join(f.cwd, "evals");
  mkdirSync(evals);
  writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
  const head = "baseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: hi\nassert:\n  - result: success\n";
  const metrics = opts.metrics?.length ? `metrics:\n${opts.metrics.join("\n")}\n` : "";
  writeFileSync(
    join(evals, "alpha.yaml"),
    (opts.noPairwise
      ? `name: alpha\n${head}`
      : `name: alpha\n${head}  - semantic_pairwise:\n      rubric: ['answers']\n      judge_model: claude-haiku-4-5-20251001\n`) + metrics,
  );
  if (opts.withBeta) writeFileSync(join(evals, "beta.yaml"), `name: beta\n${head}`);
  const judge = join(work, "judge.sh");
  writeFileSync(judge, JUDGE, { mode: 0o755 });
  const env = { ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token", COWORK_HARNESS_CLAUDE_BIN: judge };
  const cli = (...a: string[]) =>
    spawnSync(process.execPath, [CLI, "hillclimb", ...a], { cwd: f.cwd, env, encoding: "utf8", timeout: 60_000 });
  const reps = String(opts.reps ?? 1);
  expect(cli("run", "evals", "--flow", "flow", "--approve-harness", "--concurrency", "1", "--reps", reps).status).toBe(0);
  expect(cli("run", "evals", "--flow", "flow", "--variant", "v1", "--concurrency", "1", "--reps", reps).status).toBe(0);
  // In-process calls read the same runs root and judge binary.
  for (const [k, v] of Object.entries({
    COWORK_HARNESS_RUNS_DIR: f.runsDir,
    COWORK_HARNESS_CLAUDE_BIN: judge,
    HOME: f.env.HOME!,
    COWORK_MANAGED_CONFIG: "1",
  })) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
  const flow = join(f.cwd, "flow");
  const rows = (v: string) =>
    readFileSync(join(flow, v, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { prompt_id: string; rep: number; grade: Record<string, number>; meta: Record<string, unknown> });
  return { cli, flow, rows, evals };
}

const ARGS = (over: Partial<HillclimbRegradeArgs> = {}): HillclimbRegradeArgs => ({
  target: "evals",
  flow: "flow",
  variant: "all",
  cases: [],
  fillRefs: false,
  approveHarness: false,
  allowDocDrift: false,
  allowUnchecked: false,
  ...over,
});
const verdict =
  (v: "A" | "B"): CompleteStructured =>
  async () => ({ structured: { rationale: "r", verdict: v }, model: "claude-haiku-4-5", subtype: "success" });
const DEPS = (over: Partial<RegradeFlowDeps> = {}): RegradeFlowDeps => ({
  cwd: f.cwd,
  env: process.env,
  secrets: [],
  stderr: () => {},
  isolationCheck: () => undefined,
  ...over,
});
/** Every entry under `dir`, with each file's bytes (a link's target): equal before and after = nothing was written. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[r] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) {
        out[r + "/"] = "";
        walk(p, r);
      } else out[r] = readFileSync(p, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

describe.runIf(POSIX)("hillclimb regrade (in-process)", () => {
  it("a fill rebuilds every scored row — a case with no judged assert too — so state-template declares win_v1", async () => {
    const { cli, rows } = buildFlow({ withBeta: true });
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const out = await regradeFlow(ARGS({ fillRefs: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const beta = rows(v).find((r) => r.prompt_id === "beta")!;
      expect(beta.grade).toMatchObject({ win_present: 0, win_v1_present: 0 });
    }
    const t = stateTemplateFor(
      "evals",
      f.cwd,
      { ...process.env, ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" },
      "flow",
    );
    expect(t.state.metrics.map((m) => m.id)).toContain("win_v1");
  }, 180_000);

  it("a full re-grade whose judge now says both bad moves pass (the verdict is recomputed, not the saved one)", async () => {
    const { rows } = buildFlow();
    // pass_if win, so a loss fails the assert.
    const sc = join(f.cwd, "evals", "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("rubric: ['answers']", "rubric: ['answers']\n      pass_if: win"));
    const deps = DEPS({
      // Both outputs bad: under pass_if win that fails the assert, whatever order the judge saw them in.
      regradeOptions: {
        pairwiseComplete: async () => ({
          structured: { rationale: "r", verdict: "both_bad" },
          model: "claude-haiku-4-5",
          subtype: "success",
        }),
      },
    });
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out.variants)).toBe(0);
    expect(rows("v1")[0]!.grade.pass).toBe(0);
  }, 180_000);

  it("--allow-unchecked reaches the core only when passed; the metrics seam is called once per rewritten row", async () => {
    buildFlow();
    const seen: RegradeOptions[] = [];
    const merged: string[] = [];
    const deps = DEPS({
      regrade: (async (o: RegradeOptions) => {
        seen.push(o);
        return regradeRuns({ ...o, pairwiseComplete: verdict("A") });
      }) as typeof regradeRuns,
      mergeMetrics: (row) => void merged.push(Object.keys(row.grade).join(",")),
    });
    const out = await regradeFlow(ARGS(), deps);
    expect(out.exitCode).toBe(0);
    expect(seen.every((o) => !("allowUnchecked" in o))).toBe(true);
    expect(merged).toHaveLength(2);
    seen.length = 0;
    await regradeFlow(ARGS({ allowUnchecked: true }), deps);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((o) => o.allowUnchecked === true)).toBe(true);
  }, 180_000);

  it("a failure after the judge calls began is a runtime error naming what was written, never a refusal", async () => {
    buildFlow();
    const out = await regradeFlow(
      ARGS(),
      DEPS({
        regradeOptions: { pairwiseComplete: verdict("A") },
        mergeMetrics: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(out.error).toMatchObject({ category: "runtime", message: expect.stringMatching(/stopped after its judge calls began: boom/) });
  }, 180_000);

  it("one rep's run dir the core refuses (multi-turn) costs only that rep; its sibling is re-graded", async () => {
    const { rows } = buildFlow({ reps: 2 });
    const rep1 = rows("v1").find((r) => r.rep === 1)!;
    const dir = join(f.runsDir, "alpha", rep1.meta.run_id as string);
    cpSync(join(dir, "turns", "1"), join(dir, "turns", "2"), { recursive: true });
    const out = await regradeFlow(ARGS({ variant: "v1" }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    const v1 = out.variants.find((v) => v.variant === "v1")!;
    expect(v1.rewritten).toBe(1);
    expect(v1.listed).toMatchObject([{ rep: 1, why: expect.stringMatching(/refused/) }]);
  }, 180_000);

  it("a flow whose session names no model (run with --model) is not refused for an agent model", async () => {
    const { evals } = buildFlow();
    writeFileSync(join(evals, "_session.yaml"), readFileSync(join(evals, "_session.yaml"), "utf8").replace(`model: ${MODEL}\n`, ""));
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    expect(out.error?.message ?? "").not.toMatch(/--model/);
    expect(readdirSync(join(f.cwd, "flow", "v1")).some((n) => n.endsWith(".bak.jsonl"))).toBe(true);
  }, 180_000);
});

describe.runIf(POSIX)("hillclimb regrade leaves what it should not touch", () => {
  it("a flow without semantic_pairwise: a fill rewrites nothing (exit 0, results.jsonl byte for byte, no win keys)", async () => {
    const { flow } = buildFlow({ noPairwise: true });
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const out = await regradeFlow(ARGS({ fillRefs: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
    expect(before).not.toContain("win_present");
  }, 180_000);

  it("a full re-grade after a fill leaves no fill keys behind", async () => {
    const { cli, rows } = buildFlow();
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    expect((await regradeFlow(ARGS({ fillRefs: true }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }))).exitCode).toBe(0);
    expect(rows("baseline")[0]!.meta).toHaveProperty("regrade_fill");
    expect((await regradeFlow(ARGS(), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }))).exitCode).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const meta = rows(v)[0]!.meta;
      expect(meta).not.toHaveProperty("regrade_fill");
      expect(meta).toHaveProperty("regrade_doc_matches_live");
    }
  }, 240_000);

  it("a row whose scenario gained an assertion since its run is listed before any judge call", async () => {
    const { flow, evals } = buildFlow();
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("assert:\n", "assert:\n  - transcript_contains: done\n"));
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    let calls = 0;
    const out = await regradeFlow(
      ARGS({ approveHarness: true }),
      DEPS({
        regradeOptions: {
          pairwiseComplete: async () => {
            calls++;
            return { structured: { rationale: "r", verdict: "A" }, model: "claude-haiku-4-5", subtype: "success" };
          },
        },
      }),
    );
    expect(out.exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(out.variants.find((v) => v.variant === "v1")!.listed).toMatchObject([
      { why: expect.stringMatching(/now has 3 assertion\(s\), its run graded 2/) },
    ]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
  }, 180_000);
});

// A host `claude` too old to run the judge isolated: its `--help` (exit 0, as the real CLI's) lacks the isolation flags.
const OLD_JUDGE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.0.0 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then echo "  --print   x"; echo "  --model <model>   x"; exit 0; fi
echo "should not be called" >&2
exit 1
`;

describe.runIf(POSIX)("hillclimb regrade's judge isolation preflight", () => {
  it("refuses up front (exit 2) before any lock, row or backup, when the host claude cannot run the judge isolated", async () => {
    const { flow } = buildFlow();
    const before = tree(flow);
    const locksAtCheck: boolean[] = [];
    let regradeCalls = 0;
    const lines: string[] = [];
    const out = await regradeFlow(
      ARGS({ approveHarness: true }),
      DEPS({
        stderr: (l) => lines.push(l),
        isolationCheck: () => {
          for (const v of ["baseline", "v1"]) locksAtCheck.push(existsSync(join(flow, v, ".lock")));
          return "the host claude cannot run isolated (SYNTHETIC refusal)";
        },
        regrade: async () => {
          regradeCalls++;
          throw new Error("the core re-grade must not run");
        },
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.error).toEqual({
      category: "usage",
      message: "refusing to regrade: the host claude cannot run isolated (SYNTHETIC refusal)",
    });
    expect(lines.join("\n")).toContain("refusing to regrade: the host claude cannot run isolated (SYNTHETIC refusal)");
    expect(locksAtCheck).toEqual([false, false]);
    expect(regradeCalls).toBe(0);
    expect(tree(flow)).toEqual(before);
  }, 180_000);

  // Which modes ask at all: a fill never calls the semantic_matches judge, so only a pairwise assert needs the check there.
  it.each([
    ["no judged assert, full", { noPairwise: true }, false, false],
    ["no judged assert, fill", { noPairwise: true }, true, false],
    ["semantic_pairwise, fill", {}, true, true],
    ["semantic_matches only, fill", { noPairwise: true, matches: true }, true, false],
    ["semantic_matches only, full", { noPairwise: true, matches: true }, false, true],
  ] as const)(
    "%s: the isolation check is asked only when a judge would run",
    async (_n, flowOpts, fillRefs, asked) => {
      const { evals } = buildFlow(flowOpts);
      // The fixture's stub judge answers only pairwise, so a semantic_matches assert joins the scenario after the runs;
      // the check reads the scenario as it is now.
      if ("matches" in flowOpts)
        appendFileSync(
          join(evals, "alpha.yaml"),
          "  - semantic_matches:\n      rubric: ['answers']\n      judge_model: claude-haiku-4-5-20251001\n",
        );
      let calls = 0;
      const out = await regradeFlow(
        ARGS({ approveHarness: true, fillRefs }),
        DEPS({
          isolationCheck: () => {
            calls++;
            return "the host claude cannot run isolated (SYNTHETIC refusal)";
          },
        }),
      );
      expect(calls, JSON.stringify(out)).toBe(asked ? 1 : 0);
      if (asked) expect(out.exitCode).toBe(2);
      else expect(out.error?.message ?? "").not.toMatch(/refusing to regrade/);
    },
    180_000,
  );

  it("the CLI refuses with the usage envelope when the host claude is too old (no judge call, nothing written)", () => {
    const { cli, flow } = buildFlow();
    const before = tree(flow);
    writeFileSync(join(work, "judge.sh"), OLD_JUDGE, { mode: 0o755 });
    const r = cli("regrade", "evals", "--flow", "flow", "--output-format", "json");
    expect(r.status, r.stderr).toBe(2);
    const env = JSON.parse(r.stdout) as { command: string; ok: boolean; error: { category: string; message: string } };
    expect(env).toMatchObject({ command: "hillclimb regrade", ok: false, error: { category: "usage" } });
    expect(env.error.message).toMatch(
      /^refusing to regrade: the host `claude` \(.*judge\.sh, 2\.0\.0 \(Claude Code\)\) does not accept --safe-mode/,
    );
    expect(tree(flow)).toEqual(before);
  }, 180_000);
});

describe("mergeMetrics: a re-measure's sigs and unavailable reasons onto a rebuilt row", () => {
  const words: ScenarioMetric = { id: "words", artifact: "outputs/m.json", path: "words", better: "higher", scale: 2000 };
  const gone: ScenarioMetric = { id: "gone", artifact: "outputs/none.json", path: "x", better: "higher", scale: 1 };
  const report = (metrics: RegradeRunReport["metrics"]) => ({ metrics }) as unknown as RegradeRunReport;

  it("a now-measured metric: its sig, and its old unavailable reason gone (the key omitted when nothing is left)", () => {
    const row = {
      grade: { words_present: 1, words: 1200 },
      meta: { metrics_unavailable: { words: "missing_artifact" } } as Record<string, unknown>,
    };
    mergeMetrics(row, report([{ id: "words", value: 1200 }]), [words]);
    expect(row.meta.metric_sigs).toEqual(metricSigs([words]));
    expect(row.meta).not.toHaveProperty("metrics_unavailable");
    expect(row.grade).toEqual({ words_present: 1, words: 1200 });
  });

  it("a still-missing metric keeps its reason; a reason for an id no longer declared goes; a row predating both gains their sigs", () => {
    const row = {
      grade: { words_present: 1, words: 3, gone_present: 0 },
      meta: { metrics_unavailable: { old: "pruned" } } as Record<string, unknown>,
    };
    mergeMetrics(
      row,
      report([
        { id: "words", value: 3 },
        { id: "gone", unavailable: "missing_artifact" },
      ]),
      [words, gone],
    );
    // `run` never writes a reason for an id outside the declarations, so neither does a re-measure keep one.
    expect(row.meta.metrics_unavailable).toEqual({ gone: "missing_artifact" });
    expect(row.meta.metric_sigs).toEqual(metricSigs([words, gone]));
  });

  it("a re-measure that lost a value the run measured (the grade still reads it measured) adds no reason", () => {
    const row = { grade: { words_present: 1, words: 9 }, meta: {} as Record<string, unknown> };
    mergeMetrics(row, report([{ id: "words", unavailable: "pruned" }]), [words]);
    expect(row.meta).not.toHaveProperty("metrics_unavailable");
  });

  it("metric_sigs is exactly the declarations', as `run` writes it: a removed metric's sig goes with its column", () => {
    const row = { grade: { words_present: 1, words: 9 }, meta: { metric_sigs: { removed: "x" } } as Record<string, unknown> };
    mergeMetrics(row, report([{ id: "words", value: 9 }]), [words]);
    expect(row.meta.metric_sigs).toEqual(metricSigs([words]));
    const none = { grade: {}, meta: { metric_sigs: { removed: "x" } } as Record<string, unknown> };
    mergeMetrics(none, report(undefined), []);
    expect(none.meta).not.toHaveProperty("metric_sigs");
  });

  it("an agent-failed row gains no unavailable reason and keeps its grade; its sigs are the declarations', as `run` writes them", () => {
    const meta = { failure_class: "errored_agent", termination_rule: "r" };
    const row = { grade: { words_present: 0 }, meta: { ...meta } as Record<string, unknown> };
    mergeMetrics(row, report([{ id: "words", unavailable: "missing_artifact" }]), [words]);
    expect(row.meta).toEqual({ ...meta, metric_sigs: metricSigs([words]) });
    expect(row.grade).toEqual({ words_present: 0 });
  });
});

describe.runIf(POSIX)("hillclimb regrade re-measures a flow's metrics", () => {
  const OTHER = "  - { id: other, artifact: outputs/m.json, path: words, better: higher, scale: 2000 }";
  const WORDS = "  - { id: words, artifact: outputs/m.json, path: words, better: higher, scale: 2000 }";
  const GONE = "  - { id: gone, artifact: outputs/none.json, path: x, better: higher, scale: 1 }";
  const writing = () => {
    // The stub writes a SYNTHETIC metrics file in the run's work root, before its frames.
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' '{"words":1200}' > outputs/m.json\n${STUB}`);
  };

  it("the CLI's regrade keeps every metric column: a metric added since the rows were written is measured, sigged and present", () => {
    writing();
    const { cli, rows, evals } = buildFlow({ metrics: [OTHER] });
    expect(rows("v1")[0]!.meta.metric_sigs).toEqual({ other: expect.any(String) });
    // Two metrics added after the rows were written: one the kept run's file holds, one it never wrote.
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8") + `${WORDS}\n${GONE}\n`);
    const r = cli("regrade", "evals", "--flow", "flow", "--approve-harness");
    expect(r.status, r.stderr).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const row = rows(v)[0]!;
      expect(row.grade).toMatchObject({ other_present: 1, other: 1200, words_present: 1, words: 1200, gone_present: 0 });
      expect(row.grade).not.toHaveProperty("gone");
      expect(Object.keys(row.meta.metric_sigs as object).sort()).toEqual(["gone", "other", "words"]);
      expect(row.meta.metrics_unavailable).toEqual({ gone: "missing_artifact" });
    }
  }, 240_000);

  it("a metric removed from the scenarios: a regraded row drops its column AND its sig, so check reads it as `run`'s rows", () => {
    writing();
    const { cli, flow, rows, evals } = buildFlow({ metrics: [OTHER, WORDS] });
    // _state.json declares both metrics (the loop merged state-template's entries), and keeps them after the removal.
    const env = { ...process.env, ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" };
    const t = stateTemplateFor("evals", f.cwd, env, "flow");
    const st = JSON.parse(readFileSync(join(flow, "_state.json"), "utf8"));
    writeFileSync(join(flow, "_state.json"), JSON.stringify({ ...st, ...t.state }));
    expect(checkReport("flow", f.cwd).exitCode).toBe(0);
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace(`${WORDS}\n`, ""));
    const r = cli("regrade", "evals", "--flow", "flow", "--variant", "v1", "--approve-harness");
    expect(r.status, r.stderr).toBe(0);
    const row = rows("v1")[0]!;
    expect(row.grade).not.toHaveProperty("words_present");
    expect(Object.keys(row.meta.metric_sigs as object)).toEqual(["other"]);
    const c = checkReport("flow", f.cwd);
    // As a row `run` wrote after the removal reads: at most the predate note, never an error.
    const words = c.report.findings.filter((x) => /words/.test(JSON.stringify(x)));
    expect(words.map((x) => x.level)).toEqual(["note"]);
    expect(words[0]!.message).toMatch(/1 rows predate metric words \(v1 1\)/);
    expect(c.exitCode).toBe(0);
  }, 240_000);

  it("a fill's row rebuilt with no judge call (no re-measure) loses a removed metric's sig with its column, gains no new one", () => {
    writing();
    // LOST is never measured (no file), so the run records its unavailable reason; it is removed below with WORDS.
    const LOST = "  - { id: lost, artifact: outputs/lost.json, path: x, better: higher, scale: 1 }";
    const { cli, flow, rows, evals } = buildFlow({ metrics: [OTHER, WORDS, LOST] });
    expect(rows("v1")[0]!.meta.metrics_unavailable).toEqual({ lost: "missing_artifact" });
    const env = { ...process.env, ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" };
    const st = JSON.parse(readFileSync(join(flow, "_state.json"), "utf8"));
    writeFileSync(join(flow, "_state.json"), JSON.stringify({ ...st, ...stateTemplateFor("evals", f.cwd, env, "flow").state }));
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    // WORDS removed, GONE added: v1's row lacks only its own reference, so the fill rebuilds it with no judge call.
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace(`${WORDS}\n`, `${GONE}\n`).replace(`${LOST}\n`, ""));
    // _state.json declares the added metric (the loop merged state-template's new entry); `run`'s rows predate it.
    const st2 = JSON.parse(readFileSync(join(flow, "_state.json"), "utf8"));
    const added = stateTemplateFor("evals", f.cwd, env, "flow").state as { metrics: Array<{ id: string }> };
    st2.metrics = [...st2.metrics, ...added.metrics.filter((m) => !st2.metrics.some((x: { id: string }) => x.id === m.id))];
    writeFileSync(join(flow, "_state.json"), JSON.stringify(st2));
    const r = cli("regrade", "evals", "--flow", "flow", "--fill-refs", "--approve-harness");
    expect(r.status, r.stderr).toBe(0);
    const v1 = rows("v1")[0]!;
    expect(v1.meta).not.toHaveProperty("regrade_doc_matches_live");
    expect(v1.grade).toHaveProperty("win_v1");
    expect(v1.grade).not.toHaveProperty("words_present");
    // Not re-measured, so the row still predates GONE: no column, no presence key (a `_present: 0` would read as
    // "measured: no"), exactly as `run` left it — and no reason for the removed LOST.
    expect(v1.grade).not.toHaveProperty("gone");
    expect(v1.grade).not.toHaveProperty("gone_present");
    expect(v1.meta).not.toHaveProperty("metrics_unavailable");
    expect(Object.keys(v1.meta.metric_sigs as object)).toEqual(["other"]);
    // The re-measured baseline row: the added metric is sigged, with its reason.
    expect(Object.keys(rows("baseline")[0]!.meta.metric_sigs as object).sort()).toEqual(["gone", "other"]);
    expect(rows("baseline")[0]!.meta.metrics_unavailable).toEqual({ gone: "missing_artifact" });
    const c = checkReport("flow", f.cwd);
    expect(
      c.report.findings.filter((x) => x.level === "error"),
      JSON.stringify(c.report.findings),
    ).toEqual([]);
    // check still reads v1's row as predating the added metric.
    expect(c.report.findings.map((x) => x.message)).toContainEqual(expect.stringMatching(/1 rows predate metric gone \(v1 1\)/));
  }, 240_000);

  it("in-process with no metricDecls dep, the flow's union is still the default (no caller can drop the columns)", async () => {
    writing();
    const { rows } = buildFlow({ metrics: [OTHER] });
    const out = await regradeFlow(ARGS({ variant: "v1" }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ other_present: 1, other: 1200 });
    expect(rows("v1")[0]!.meta.regrade_doc_matches_live).toBeDefined();
  }, 240_000);

  it("a metric whose declaration changed since the rows were written is refused before any judge call, nothing written", async () => {
    writing();
    const { flow, evals } = buildFlow({ metrics: [OTHER] });
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("scale: 2000", "scale: 3000"));
    const before = tree(flow);
    let calls = 0;
    const out = await regradeFlow(
      ARGS({ approveHarness: true }),
      DEPS({
        regradeOptions: {
          pairwiseComplete: async () => {
            calls++;
            return { structured: { rationale: "r", verdict: "A" }, model: "claude-haiku-4-5", subtype: "success" };
          },
        },
      }),
    );
    expect(out.exitCode).toBe(2);
    expect(out.error?.message).toMatch(/metric "other" is declared differently from the rows already in baseline, v1/);
    expect(calls).toBe(0);
    expect(tree(flow)).toEqual(before);
  }, 240_000);
});

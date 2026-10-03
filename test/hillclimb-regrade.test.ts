// `hillclimb regrade` in-process over a flow the REAL CLI built (stub agent, a fake host-`claude` judge replaying a
// captured envelope): the seams a CLI run cannot reach — the core re-grade, the metrics merge — are injected here.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CLI, POSIX, makeStubFixture, stubSessionTranscript, type StubFixture } from "./helpers/stub-agent.js";
import { mergeMetrics, regradeFlow, type HillclimbRegradeArgs, type RegradeFlowDeps } from "../src/hillclimb/regrade.js";
import { regradeRuns, type RegradeOptions, type RegradeRunReport } from "../src/run/regrade.js";
import { metricSigs } from "../src/hillclimb/metric-keys.js";
import type { ScenarioMetric } from "../src/types.js";
import type { CompleteStructured } from "../src/decide/pairwise-judge.js";
import { checkReport, stateTemplateFor } from "../src/hillclimb/cli.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import { collectSecrets } from "../src/secrets.js";
import { escapeRegExp } from "./helpers/regex.js";

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
  stubSessionTranscript(MODEL),
  "cat >/dev/null",
].join("\n");
const ENVELOPE = join(import.meta.dirname, "fixtures", "pairwise-judge", "claude-p-json-schema-envelope.json");
const JUDGE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  for f in "--safe-mode" "--strict-mcp-config" "--no-session-persistence" "--setting-sources <s>" "--tools <tools...>" "--effort <level>" "--settings <s>"; do echo "  $f   x"; done
  exit 0
fi
cat >/dev/null
cat "${ENVELOPE}"
`;

/** The same judge answering `tie`, for a test whose precondition needs the live rows to pass. The judge sees the
 *  candidate and the reference byte-identical (the stub agent says the same thing every run), so no judge could tell
 *  the candidate's slot; and with the order a seeded coin over a random run id, the captured envelope's fixed "A" is a
 *  loss about half the time. A tie is the same outcome in either order, and passes the default `pass_if: not_worse`. */
function tieJudge(dir: string): string {
  const env = JSON.parse(readFileSync(ENVELOPE, "utf8")) as Record<string, unknown>;
  const structured = { verdict: "tie", rationale: "Output A and Output B are the same answer; neither is better." };
  const envelope = join(dir, "judge-tie-envelope.json");
  writeFileSync(envelope, JSON.stringify({ ...env, result: JSON.stringify(structured), structured_output: structured }));
  const script = join(dir, "judge-tie.sh");
  writeFileSync(script, JUDGE.replace(`cat "${ENVELOPE}"`, `cat "${envelope}"`), { mode: 0o755 });
  return script;
}

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
function buildFlow(
  opts: {
    withBeta?: boolean;
    reps?: number;
    noPairwise?: boolean;
    metrics?: string[];
    skill?: string;
    /** More deterministic assert lines (`  - key: value`), after `result: success`. */
    extra?: string[];
    expectDenied?: string[];
    /** Isolation-check cases only: how a semantic_matches assert joins the scenario after the runs. */
    matches?: "added" | "recorded";
    /** `null`: alpha's pairwise assert pins no judge_model (the env/default chain resolves it). */
    judgeModel?: null;
    /** Extra environment for the CLI passes and the in-process calls. */
    env?: Record<string, string>;
    /** The fake judge answers `tie` (see `tieJudge`): the live rows pass whatever order the comparison was in. */
    judgeTies?: boolean;
    /** alpha's pairwise assert judges both orders. */
    orderBoth?: boolean;
  } = {},
) {
  const plugin = join(work, "plugin", "my-plugin");
  // With `skill`, a second skill makes the plugin multi-skill, and both passes select `skill` with --skill.
  for (const s of opts.skill !== undefined ? ["x", "y"] : ["x"]) {
    mkdirSync(join(plugin, "skills", s), { recursive: true });
    writeFileSync(join(plugin, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: d\n---\nbody\n`);
  }
  const evals = join(f.cwd, "evals");
  mkdirSync(evals);
  writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
  const head =
    "baseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: hi\n" +
    (opts.expectDenied?.length ? `expect_denied: [${opts.expectDenied.join(", ")}]\n` : "") +
    "assert:\n  - result: success\n" +
    (opts.extra ?? []).map((l) => `${l}\n`).join("");
  const metrics = opts.metrics?.length ? `metrics:\n${opts.metrics.join("\n")}\n` : "";
  writeFileSync(
    join(evals, "alpha.yaml"),
    (opts.noPairwise
      ? `name: alpha\n${head}`
      : `name: alpha\n${head}  - semantic_pairwise:\n      rubric: ['answers']\n${opts.judgeModel === null ? "" : "      judge_model: claude-haiku-4-5-20251001\n"}${opts.orderBoth ? "      order: both\n" : ""}`) +
      metrics,
  );
  if (opts.withBeta) writeFileSync(join(evals, "beta.yaml"), `name: beta\n${head}`);
  let judge = join(work, "judge.sh");
  writeFileSync(judge, JUDGE, { mode: 0o755 });
  if (opts.judgeTies) judge = tieJudge(work);
  const env = {
    ...f.env,
    COWORK_MANAGED_CONFIG: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token",
    COWORK_HARNESS_CLAUDE_BIN: judge,
    ...(opts.env ?? {}),
  };
  const cli = (...a: string[]) =>
    spawnSync(process.execPath, [CLI, "hillclimb", ...a], { cwd: f.cwd, env, encoding: "utf8", timeout: 60_000 });
  const reps = String(opts.reps ?? 1);
  const sel = opts.skill !== undefined ? ["--skill", opts.skill] : [];
  for (const pass of [["--approve-harness"], ["--variant", "v1"]]) {
    const r = cli("run", "evals", "--flow", "flow", ...pass, "--concurrency", "1", "--reps", reps, ...sel);
    expect(r.status, r.stderr).toBe(0);
  }
  // In-process calls read the same runs root and judge binary.
  for (const [k, v] of Object.entries({
    COWORK_HARNESS_RUNS_DIR: f.runsDir,
    COWORK_HARNESS_CLAUDE_BIN: judge,
    HOME: f.env.HOME!,
    // The judge transport's user-settings check reads CLAUDE_CONFIG_DIR ahead of HOME: keep it off this machine's config.
    CLAUDE_CONFIG_DIR: join(f.env.HOME!, ".claude"),
    COWORK_MANAGED_CONFIG: "1",
    ...(opts.env ?? {}),
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
    const verdictKeys = (v: string) => {
      const g = rows(v).find((r) => r.prompt_id === "alpha")!.grade;
      return { pass: g.pass, a0: g.a0, a1: g.a1 };
    };
    const before = { baseline: verdictKeys("baseline"), v1: verdictKeys("v1") };
    const lines: string[] = [];
    // A judge that reports its spend, so the line can show it.
    const priced: CompleteStructured = async () => ({
      structured: { rationale: "r", verdict: "tie" },
      model: "claude-haiku-4-5",
      subtype: "success",
      usage: {
        "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0123 },
      },
    });
    const out = await regradeFlow(
      ARGS({ fillRefs: true }),
      DEPS({ stderr: (l) => lines.push(l), regradeOptions: { pairwiseComplete: priced } }),
    );
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    // What each rewritten row went through, on each variant's line and in the summary: the baseline's alpha row is
    // judged against v1's reference (one judge call); v1's alpha row lacks only its own reference (neutral, no judge
    // call); both beta rows (no judged assert) are rebuilt with no judge call.
    const BASE = String.raw`rewritten 2: 1 re-judged \(\$0\.0123 judge\), 1 rebuilt without a judge call, 0 agent-failed \(meta only\); listed 0`;
    const V1 = String.raw`rewritten 2: 0 re-judged, 2 rebuilt without a judge call \(1 of them only their own reference was missing: neutral 0\.5\), 0 agent-failed \(meta only\); listed 0`;
    expect(lines.find((l) => l.startsWith("  [baseline] "))).toMatch(new RegExp(`^  \\[baseline\\] ${BASE}; mean pass `));
    expect(lines.find((l) => l.startsWith("  [v1] "))).toMatch(new RegExp(`^  \\[v1\\] ${V1}; mean pass `));
    expect(lines.at(-1)).toMatch(new RegExp(`^hillclimb regrade: baseline ${BASE}; v1 ${V1}$`));
    // The JSON payload keeps every counter, the judged rows and their judge spend added.
    expect(out.variants.find((y) => y.variant === "baseline")).toMatchObject({
      rewritten: 2,
      judged: 1,
      judgeUsd: 0.0123,
      rebuilt: 1,
      ownRefOnly: 0,
    });
    expect(out.variants.find((y) => y.variant === "v1")).toMatchObject({ rewritten: 2, judged: 0, rebuilt: 2, ownRefOnly: 1 });
    expect(out.variants.find((y) => y.variant === "v1")).not.toHaveProperty("judgeUsd");
    for (const x of out.variants)
      expect(Object.keys(x)).toEqual(expect.arrayContaining(["rewritten", "judged", "reevaluated", "remeasured", "agentFailed", "listed"]));
    for (const v of ["baseline", "v1"]) {
      const beta = rows(v).find((r) => r.prompt_id === "beta")!;
      expect(beta.grade).toMatchObject({ win_present: 0, win_v1_present: 0 });
    }
    // The baseline alpha row went through a fill's re-grade (against v1's reference): a fill never moves pass or an
    // assert's outcome.
    expect(rows("baseline").find((r) => r.prompt_id === "alpha")!.meta.regrade_fill).toEqual(["v1"]);
    expect({ baseline: verdictKeys("baseline"), v1: verdictKeys("v1") }).toEqual(before);
    const t = stateTemplateFor(
      "evals",
      f.cwd,
      { ...process.env, ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" },
      { flow: "flow" },
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
    // A rebuilt row keeps what its run asked for and what the agent sent: regrade never re-runs the agent.
    expect(rows("v1")[0]!.meta).toMatchObject({ effort: "medium", effort_sent: "medium", model_requested: MODEL });
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
    const out = await regradeFlow(ARGS({ rejudge: true }), deps);
    expect(out.exitCode).toBe(0);
    expect(seen.every((o) => !("allowUnchecked" in o))).toBe(true);
    expect(merged).toHaveLength(2);
    seen.length = 0;
    await regradeFlow(ARGS({ allowUnchecked: true, rejudge: true }), deps);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((o) => o.allowUnchecked === true)).toBe(true);
  }, 180_000);

  it("a failure after the judge calls began is a runtime error naming what was written, never a refusal", async () => {
    buildFlow();
    const out = await regradeFlow(
      ARGS({ rejudge: true }),
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
    const out = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    const v1 = out.variants.find((v) => v.variant === "v1")!;
    expect(v1.rewritten).toBe(1);
    expect(v1.listed).toMatchObject([{ rep: 1, why: expect.stringMatching(/refused/) }]);
  }, 180_000);

  it("a flow whose session names no model (run with --model) is not refused for an agent model", async () => {
    const { evals } = buildFlow();
    writeFileSync(join(evals, "_session.yaml"), readFileSync(join(evals, "_session.yaml"), "utf8").replace(`model: ${MODEL}\n`, ""));
    const out = await regradeFlow(
      ARGS({ approveHarness: true, rejudge: true }),
      DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }),
    );
    expect(out.error?.message ?? "").not.toMatch(/--model/);
    expect(readdirSync(join(f.cwd, "flow", "v1")).some((n) => n.endsWith(".bak.jsonl"))).toBe(true);
  }, 180_000);
});

const priced = (verdict: "A" | "B" | "tie", costUSD: number | ((n: number) => number | undefined)): CompleteStructured =>
  (() => {
    let n = 0;
    return async () => {
      const c = typeof costUSD === "number" ? costUSD : costUSD(n++);
      return {
        structured: { rationale: "r", verdict },
        model: "claude-haiku-4-5",
        subtype: "success",
        ...(c !== undefined
          ? {
              usage: {
                "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: c },
              },
            }
          : {}),
      };
    };
  })();

describe.runIf(POSIX)("hillclimb rows: structured per-order outcomes (meta.pairwise_orders)", () => {
  it("a row judged order: both against baseline and v1 carries both entries; a re-judge replaces them, a rebuild without order: both drops them", async () => {
    const { cli, rows, evals } = buildFlow({ orderBoth: true });
    // The stub judge always answers "A": a win whenever the candidate is shown first, a loss whenever the reference is.
    expect(rows("v1")[0]!.meta.pairwise_orders).toEqual({ "a1/baseline": { candidate_first: "win", ref_first: "loss" } });
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const v2 = cli("run", "evals", "--flow", "flow", "--variant", "v2", "--concurrency", "1");
    expect(v2.status, v2.stderr).toBe(0);
    expect(rows("v2")[0]!.meta.pairwise_orders).toEqual({
      "a1/baseline": { candidate_first: "win", ref_first: "loss" },
      "a1/v1": { candidate_first: "win", ref_first: "loss" },
    });
    // A re-judge answering "B" turns each order round.
    const out = await regradeFlow(
      ARGS({ variant: "v2", rejudge: true }),
      DEPS({ regradeOptions: { pairwiseComplete: priced("B", 0.01) } }),
    );
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(rows("v2")[0]!.meta.pairwise_orders).toEqual({
      "a1/baseline": { candidate_first: "loss", ref_first: "win" },
      "a1/v1": { candidate_first: "loss", ref_first: "win" },
    });
    // order: both removed: the re-judge records one order per comparison, and the stale structured value goes.
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("      order: both\n", ""));
    const again = await regradeFlow(
      ARGS({ variant: "v2", rejudge: true, approveHarness: true }),
      DEPS({ regradeOptions: { pairwiseComplete: priced("B", 0.01) } }),
    );
    expect(again.exitCode, JSON.stringify(again)).toBe(0);
    expect(rows("v2")[0]!.meta).not.toHaveProperty("pairwise_orders");
  }, 300_000);
});

describe.runIf(POSIX)("hillclimb regrade: the judge spend and the breakdown", () => {
  it("a core regrade that stopped after its judge calls leaves a run without a report: the figure is a floor", async () => {
    buildFlow({ reps: 2 });
    const lines: string[] = [];
    // The core judges both runs, then fails writing the second's regrade file: only the first report comes back.
    const regrade = (async (o: RegradeOptions) => {
      const real = await regradeRuns({ ...o, pairwiseComplete: priced("A", 0.0123) });
      if ((o as { checkOnly?: boolean }).checkOnly || !real.ok) return real;
      return { ok: false, kind: "runtime", message: "could not write a regrade file", completed: real.runs.slice(0, 1) };
    }) as typeof regradeRuns;
    const out = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), DEPS({ stderr: (l) => lines.push(l), regrade }));
    expect(out.variants[0]).toMatchObject({ judged: 1, judgeUsd: 0.0123, judgeStopped: 1 });
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: expect.any(Number), why: expect.stringMatching(/^stopped: /) }]);
    expect(lines.find((l) => l.startsWith("  [v1] rewritten"))).toMatch(
      /^  \[v1\] rewritten 1: 1 re-judged \(\$0\.0123 judge — a floor, 1 run's regrade stopped after its judge calls\), /,
    );
  }, 300_000);

  it("unpriced judge calls: (judge cost unknown); partly priced: the figure is a floor", async () => {
    buildFlow({ reps: 2 });
    const lines: string[] = [];
    const none = await regradeFlow(
      ARGS({ variant: "v1", rejudge: true }),
      DEPS({ stderr: (l) => lines.push(l), regradeOptions: { pairwiseComplete: priced("A", () => undefined) } }),
    );
    expect(none.exitCode, JSON.stringify(none)).toBe(0);
    expect(none.variants[0]).toMatchObject({ judged: 2, judgeUnpriced: 2, listedAfterJudge: 0 });
    expect(none.variants[0]).not.toHaveProperty("judgeUsd");
    expect(lines.find((l) => l.startsWith("  [v1] "))).toMatch(
      /^  \[v1\] rewritten 2: 2 re-judged \(judge cost unknown\), 0 rebuilt without a judge call, 0 agent-failed \(meta only\); listed 0; mean pass /,
    );
    lines.length = 0;
    // The first call priced, the second not: a sum over the priced one only, said to be a floor.
    const part = await regradeFlow(
      ARGS({ variant: "v1", rejudge: true }),
      DEPS({ stderr: (l) => lines.push(l), regradeOptions: { pairwiseComplete: priced("A", (n) => (n === 0 ? 0.0123 : undefined)) } }),
    );
    expect(part.exitCode, JSON.stringify(part)).toBe(0);
    expect(part.variants[0]).toMatchObject({ judged: 2, judgeUsd: 0.0123, judgeUnpriced: 1 });
    expect(lines.find((l) => l.startsWith("  [v1] "))).toMatch(
      /^  \[v1\] rewritten 2: 2 re-judged \(\$0\.0123 judge — a floor, 1 unpriced\), 0 rebuilt without a judge call, 0 agent-failed \(meta only\); listed 0; /,
    );
  }, 300_000);

  it("a fill of only rows lacking their own reference: every one is said to be neutral", async () => {
    const { cli } = buildFlow();
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const lines: string[] = [];
    const out = await regradeFlow(ARGS({ variant: "v1", fillRefs: true }), DEPS({ stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(out.variants[0]).toMatchObject({ rewritten: 1, judged: 0, rebuilt: 1, ownRefOnly: 1 });
    expect(lines.find((l) => l.startsWith("  [v1] "))).toMatch(
      /^  \[v1\] rewritten 1: 0 re-judged, 1 rebuilt without a judge call \(only their own reference was missing: neutral 0\.5\), 0 agent-failed \(meta only\); listed 0; /,
    );
  }, 240_000);
});

describe.runIf(POSIX)("hillclimb rows: meta.pairwise_orders across a fill", () => {
  it("a fill keeps the copied comparison's per-order outcomes and records the judged one's fresh", async () => {
    const { cli, rows } = buildFlow({ orderBoth: true });
    const v2 = cli("run", "evals", "--flow", "flow", "--variant", "v2", "--concurrency", "1");
    expect(v2.status, v2.stderr).toBe(0);
    // Live: only the baseline comparison (the stub judge always answers "A").
    expect(rows("v2")[0]!.meta.pairwise_orders).toEqual({ "a1/baseline": { candidate_first: "win", ref_first: "loss" } });
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    // The fill judges v1 alone, answering "B": the baseline entry is copied as it was, the v1 entry is fresh.
    const out = await regradeFlow(
      ARGS({ variant: "v2", fillRefs: true }),
      DEPS({ regradeOptions: { pairwiseComplete: priced("B", 0.01) } }),
    );
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(rows("v2")[0]!.meta.pairwise_orders).toEqual({
      "a1/baseline": { candidate_first: "win", ref_first: "loss" },
      "a1/v1": { candidate_first: "loss", ref_first: "win" },
    });
  }, 300_000);
});

describe.runIf(POSIX)("the baseline ceiling on a pairwise case", () => {
  const NOTE =
    "note: alpha: its pairwise assert cannot fail on baseline (neutral against its own reference), so `pass` cannot show a pairwise gain; that shows in `win`";
  it("run and check print a note for it, not the ceiling warning", () => {
    const { cli } = buildFlow();
    const run = cli("run", "evals", "--flow", "flow", "--concurrency", "1");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain(NOTE);
    expect(run.stderr).not.toMatch(/at the ceiling/);
    const check = cli("check", "evals", "--flow", "flow");
    expect(check.stderr + check.stdout).toContain(NOTE);
    expect(check.stderr + check.stdout).not.toMatch(/at the ceiling/);
  }, 180_000);
  it("a case with no pairwise assert at the ceiling still warns, on run and on check", () => {
    const { cli } = buildFlow({ noPairwise: true });
    const run = cli("run", "evals", "--flow", "flow", "--concurrency", "1");
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toMatch(/warning: 1\/1 baseline cases are at the ceiling on pass .*: alpha/);
    expect(run.stderr).not.toContain("cannot fail on baseline");
    const check = cli("check", "evals", "--flow", "flow");
    expect(check.stderr + check.stdout).toMatch(/warning: 1\/1 baseline cases are at the ceiling on pass .*: alpha/);
  }, 180_000);
});

describe.runIf(POSIX)("hillclimb regrade applies run's harness gate to a flow approved with --skill", () => {
  const stateOf = () => JSON.parse(readFileSync(join(f.cwd, "flow", "_state.json"), "utf8")) as Record<string, unknown>;

  it("nothing changed since `run --skill x --approve-harness`: regrade passes the gate", async () => {
    buildFlow({ skill: "x" });
    expect(stateOf()).toMatchObject({ harness_skill: "x" });
    const out = await regradeFlow(ARGS(), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    expect(out.error?.message ?? "").not.toMatch(/harness/);
    expect(out.exitCode, JSON.stringify(out.error)).toBe(0);
  }, 180_000);

  it("regrade --approve-harness keeps harness_skill, and the next `run --skill x` is approved", async () => {
    const { cli, evals } = buildFlow({ skill: "x" });
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("rubric: ['answers']", "rubric: ['answers', 'is brief']"));
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    expect(out.exitCode, JSON.stringify(out.error)).toBe(0);
    expect(stateOf()).toMatchObject({ harness_skill: "x" });
    // ...and records the per-entry hashes behind its sha, as run's approval does, so a later refusal names the change.
    expect((stateOf().harness_files as Record<string, string>)["evals/alpha.yaml"]).toMatch(/^[0-9a-f]{64}$/);
    const r = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--skill", "x", "--dry-run");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/harness gate: approved/);
  }, 180_000);

  it("a real scenario edit still refuses regrade", async () => {
    const { evals } = buildFlow({ skill: "x" });
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("rubric: ['answers']", "rubric: ['answers', 'is brief']"));
    const out = await regradeFlow(ARGS(), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    expect(out.exitCode).toBe(2);
    // The edited scenario is named first, the rest counted, never listed (run's wording).
    expect(out.error?.message).toMatch(
      /: harness changed since last approved run \(changed: evals\/alpha\.yaml; and \d+ unchanged\); approved /,
    );
    expect(out.error?.message).not.toContain("_session.yaml");
    expect(stateOf()).toMatchObject({ harness_skill: "x" });
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
    expect((await regradeFlow(ARGS({ rejudge: true }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }))).exitCode).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const meta = rows(v)[0]!.meta;
      expect(meta).not.toHaveProperty("regrade_fill");
      expect(meta).toHaveProperty("regrade_doc_matches_live");
    }
  }, 240_000);

  // This test used to pin that a row whose scenario gained an assert was listed in every mode. Deliberately changed: a
  // default regrade rebuilds the list from the scenario (the added deterministic assert re-evaluated from the kept run,
  // the judged one re-judged), so only a fill, which copies outcomes by index, still lists it — before any judge call.
  it("a row whose scenario gained an assertion: a fill lists it before any judge call; a default regrade re-evaluates it", async () => {
    const { cli, flow, evals, rows } = buildFlow();
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("assert:\n", "assert:\n  - transcript_contains: done\n"));
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    let calls = 0;
    const deps = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => {
          calls++;
          return { structured: { rationale: "r", verdict: "A" }, model: "claude-haiku-4-5", subtype: "success" };
        },
      },
    });
    const fill = await regradeFlow(ARGS({ approveHarness: true, fillRefs: true }), deps);
    expect(fill.exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(fill.variants.find((v) => v.variant === "v1")!.listed).toMatchObject([
      { why: expect.stringMatching(/now has 3 assertion\(s\), its run graded 2 — run a default `hillclimb regrade` first/) },
    ]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
    const kept = rows("v1")[0]!.grade;
    const out = await regradeFlow(ARGS({ variant: "v1" }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    // The pairwise assert is matched by identity at its new index: kept, never re-judged.
    expect(calls).toBe(0);
    // The added assert is a0 now; the run's two moved to a1 and a2.
    expect(rows("v1")[0]!.grade).toMatchObject({ a0: 1, a1: 1, a2: kept.a1 });
    expect(rows("v1")[0]!.grade).toHaveProperty("a2_present");
  }, 240_000);
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
      ARGS({ approveHarness: true, rejudge: true }),
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

  // Which regrades ask at all: only one that would call a judge. A default regrade re-judges only a judged assert whose
  // inputs changed (or every one under --rejudge); a fill judges only a comparison a row lacks.
  it.each([
    ["no judged assert, full", { noPairwise: true }, {}, false],
    ["no judged assert, fill", { noPairwise: true }, { fillRefs: true }, false],
    ["semantic_pairwise, fill, a reference frozen since", {}, { fillRefs: true, freeze: true }, true],
    ["semantic_pairwise, fill, nothing to fill", {}, { fillRefs: true }, false],
    ["semantic_pairwise, full, nothing changed", {}, {}, false],
    ["semantic_pairwise, full, --rejudge", {}, { rejudge: true }, true],
    ["semantic_matches only, fill", { noPairwise: true, matches: "added" }, { fillRefs: true }, false],
    ["semantic_matches only, full, added since the run", { noPairwise: true, matches: "added" }, {}, true],
    ["semantic_matches only, full, unchanged since the run", { noPairwise: true, matches: "recorded" }, {}, false],
    ["semantic_matches only, full, unchanged, --rejudge", { noPairwise: true, matches: "recorded" }, { rejudge: true }, true],
  ] as const)(
    "%s: the isolation check is asked only when a judge would run",
    async (_n, flowOpts, mode, asked) => {
      const { cli, evals, rows } = buildFlow(flowOpts);
      // The fixture's stub judge answers only pairwise, so a semantic_matches assert joins the scenario after the runs;
      // the check reads the scenario as it is now. "recorded": the runs are given the entry a judged run persists for it.
      if ("matches" in flowOpts) {
        const sc = join(evals, "alpha.yaml");
        appendFileSync(sc, "  - semantic_matches:\n      rubric: ['answers']\n      judge_model: claude-haiku-4-5-20251001\n");
        if (flowOpts.matches === "recorded")
          for (const v of ["baseline", "v1"]) {
            const file = join(f.runsDir, "alpha", rows(v)[0]!.meta.run_id as string, "turns", "1", "result.json");
            const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: unknown[] };
            r.assertions.push({
              assertion: parseScenarioFile(sc).assert.at(-1),
              pass: true,
              judgeModel: "claude-haiku-4-5",
              judgePromptHash: JUDGE_PROMPT_HASH,
            });
            writeFileSync(file, JSON.stringify(r));
          }
      }
      if ("freeze" in mode) expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
      let calls = 0;
      const out = await regradeFlow(
        ARGS({ approveHarness: true, fillRefs: "fillRefs" in mode, rejudge: "rejudge" in mode }),
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

  // The judge decision is made before the locks over the rows as they are then; the rows are read again under the locks
  // and a change in between is refused, nothing written. isolationCheck runs exactly in that window.
  it("results.jsonl changed between the judge decision and the locks: refused, nothing written", async () => {
    const { flow } = buildFlow();
    const file = join(flow, "v1", "results.jsonl");
    let mutated = "";
    const out = await regradeFlow(
      ARGS({ rejudge: true }),
      DEPS({
        isolationCheck: () => {
          appendFileSync(file, readFileSync(file, "utf8"));
          mutated = readFileSync(file, "utf8");
          return undefined;
        },
      }),
    );
    expect(out.exitCode, JSON.stringify(out)).toBe(2);
    expect(out.error?.message).toMatch(/v1\/results\.jsonl changed while regrade was starting .*nothing was written/);
    expect(readFileSync(file, "utf8")).toBe(mutated);
    expect(readdirSync(join(flow, "v1")).some((n) => n.endsWith(".bak.jsonl"))).toBe(false);
  }, 180_000);

  // What else the judge decision reads (a reference store) can change before the locks too: when the rows under the
  // locks need a judge the pre-lock decision did not foresee, the isolation check is asked there, before any spend.
  it("a judge needed only under the locks (a reference changed in between) still asks the isolation check first", async () => {
    const { flow } = buildFlow();
    const before = tree(join(flow, "v1"));
    let asked = 0;
    let regradeCalls = 0;
    const out = await regradeFlow(
      ARGS(),
      DEPS({
        beforeLock: () => rmSync(join(flow, "baseline", "ref"), { recursive: true, force: true }),
        isolationCheck: () => {
          asked++;
          return "the host claude cannot run isolated (SYNTHETIC refusal)";
        },
        regrade: async () => {
          regradeCalls++;
          throw new Error("the core re-grade must not run");
        },
      }),
    );
    expect(asked).toBe(1);
    expect(out.exitCode, JSON.stringify(out)).toBe(2);
    expect(out.error?.message).toBe("refusing to regrade: the host claude cannot run isolated (SYNTHETIC refusal)");
    expect(regradeCalls).toBe(0);
    expect(tree(join(flow, "v1"))).toEqual(before);
  }, 180_000);

  it("--rejudge with --fill-refs is a usage error (a fill re-judges nothing), nothing written", () => {
    const { cli, flow } = buildFlow();
    const before = tree(flow);
    const r = cli("regrade", "evals", "--flow", "flow", "--rejudge", "--fill-refs");
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--rejudge and --fill-refs exclude each other/);
    expect(tree(flow)).toEqual(before);
  }, 180_000);

  it("the CLI refuses with the usage envelope when the host claude is too old (no judge call, nothing written)", () => {
    const { cli, flow } = buildFlow();
    const before = tree(flow);
    writeFileSync(join(work, "judge.sh"), OLD_JUDGE, { mode: 0o755 });
    const r = cli("regrade", "evals", "--flow", "flow", "--rejudge", "--output-format", "json");
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
    const t = stateTemplateFor("evals", f.cwd, env, { flow: "flow" });
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
    expect(words[0]!.message).toMatch(/1 rows do not carry metric words \(v1 1\)/);
    expect(c.exitCode).toBe(0);
  }, 240_000);

  // This test used to pin the opposite: a row rebuilt with no judge call was not re-measured, so it kept predating an
  // added metric (no column, no sig) and `check` noted it. Deliberately flipped: every selected row is now re-evaluated
  // from its kept run, so a metric added mid-flow is filled on it too.
  it("a fill's row rebuilt with no judge call is re-measured: a removed metric goes, an added one is sigged with its reason", () => {
    writing();
    // LOST is never measured (no file), so the run records its unavailable reason; it is removed below with WORDS.
    const LOST = "  - { id: lost, artifact: outputs/lost.json, path: x, better: higher, scale: 1 }";
    const { cli, flow, rows, evals } = buildFlow({ metrics: [OTHER, WORDS, LOST] });
    expect(rows("v1")[0]!.meta.metrics_unavailable).toEqual({ lost: "missing_artifact" });
    const env = { ...process.env, ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" };
    const st = JSON.parse(readFileSync(join(flow, "_state.json"), "utf8"));
    writeFileSync(join(flow, "_state.json"), JSON.stringify({ ...st, ...stateTemplateFor("evals", f.cwd, env, { flow: "flow" }).state }));
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    // WORDS removed, GONE added: v1's row lacks only its own reference, so the fill rebuilds it with no judge call.
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace(`${WORDS}\n`, `${GONE}\n`).replace(`${LOST}\n`, ""));
    // _state.json declares the added metric (the loop merged state-template's new entry); `run`'s rows predate it.
    const st2 = JSON.parse(readFileSync(join(flow, "_state.json"), "utf8"));
    const added = stateTemplateFor("evals", f.cwd, env, { flow: "flow" }).state as { metrics: Array<{ id: string }> };
    st2.metrics = [...st2.metrics, ...added.metrics.filter((m) => !st2.metrics.some((x: { id: string }) => x.id === m.id))];
    writeFileSync(join(flow, "_state.json"), JSON.stringify(st2));
    const r = cli("regrade", "evals", "--flow", "flow", "--fill-refs", "--approve-harness");
    expect(r.status, r.stderr).toBe(0);
    const v1 = rows("v1")[0]!;
    expect(v1.meta).not.toHaveProperty("regrade_doc_matches_live");
    expect(v1.grade).toHaveProperty("win_v1");
    expect(v1.grade).not.toHaveProperty("words_present");
    // Re-measured from its kept run with no judge call, as the judged baseline row is: GONE is measured (not there), so
    // it carries `_present: 0`, its sig and its reason; the removed LOST's reason goes with its column.
    expect(v1.grade).not.toHaveProperty("gone");
    expect(v1.grade).toMatchObject({ other_present: 1, other: 1200, gone_present: 0 });
    expect(v1.meta.metrics_unavailable).toEqual({ gone: "missing_artifact" });
    expect(Object.keys(v1.meta.metric_sigs as object).sort()).toEqual(["gone", "other"]);
    expect(v1.meta.regrade_remeasured).toBe(true);
    // The judged baseline row: the added metric is sigged, with its reason, and it is marked re-measured as the
    // unjudged row is (both paths re-measure).
    expect(Object.keys(rows("baseline")[0]!.meta.metric_sigs as object).sort()).toEqual(["gone", "other"]);
    expect(rows("baseline")[0]!.meta.metrics_unavailable).toEqual({ gone: "missing_artifact" });
    expect(rows("baseline")[0]!.meta.regrade_remeasured).toBe(true);
    const c = checkReport("flow", f.cwd);
    expect(
      c.report.findings.filter((x) => x.level === "error"),
      JSON.stringify(c.report.findings),
    ).toEqual([]);
    // No row predates the added metric any longer.
    expect(c.report.findings.map((x) => x.message)).not.toContainEqual(expect.stringMatching(/do not carry metric gone/));
  }, 240_000);

  it("in-process with no metricDecls dep, the flow's union is still the default (no caller can drop the columns)", async () => {
    writing();
    const { rows } = buildFlow({ metrics: [OTHER] });
    const out = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ other_present: 1, other: 1200 });
    expect(rows("v1")[0]!.meta.regrade_doc_matches_live).toBeDefined();
    // A re-judged row of a case that declares a metric was re-measured, and says so.
    expect(rows("v1")[0]!.meta.regrade_remeasured).toBe(true);
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

// Every selected row's metrics are re-measured from its kept run, a row no judge re-grades included. Each flow here is
// written by real `hillclimb run` passes; the metric is added to the scenario afterwards, as a loop adds one mid-flow.
describe.runIf(POSIX)("hillclimb regrade re-measures metrics with no judge call", () => {
  const OTHER = "  - { id: other, artifact: outputs/m.json, path: words, better: higher, scale: 2000 }";
  const WORDS = "  - { id: words, artifact: outputs/m.json, path: words, better: higher, scale: 2000 }";
  const GONE = "  - { id: gone, artifact: outputs/none.json, path: x, better: higher, scale: 1 }";
  /** The stub writes a SYNTHETIC metrics file in the run's work root before its frames; `stdout` replaces its frames. */
  const writing = (stdout = STUB) => {
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' '{"words":1200}' > outputs/m.json\n${stdout}`);
  };
  const addMetrics = (evals: string, ...decls: string[]) => {
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8") + decls.map((d) => `${d}\n`).join(""));
  };
  const runDirOf = (row: { meta: Record<string, unknown> }) => join(f.runsDir, "alpha", row.meta.run_id as string);

  it("a case with no judged assert: a metric added mid-flow is filled (value, _present, sig) and reported re-measured", async () => {
    writing();
    const { flow, rows, evals } = buildFlow({ noPairwise: true, metrics: [OTHER] });
    addMetrics(evals, WORDS, GONE);
    const lines: string[] = [];
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS({ stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const row = rows(v)[0]!;
      expect(row.grade).toMatchObject({ pass: 1, other_present: 1, other: 1200, words_present: 1, words: 1200, gone_present: 0 });
      // An unavailable value stays omitted, with its reason.
      expect(row.grade).not.toHaveProperty("gone");
      expect(row.meta.metrics_unavailable).toEqual({ gone: "missing_artifact" });
      expect(Object.keys(row.meta.metric_sigs as object).sort()).toEqual(["gone", "other", "words"]);
      expect(row.meta).toMatchObject({ regrade_remeasured: true, regraded_at: expect.any(String) });
      // No judge read it: no judge-side regrade keys.
      expect(row.meta).not.toHaveProperty("regrade_doc_matches_live");
      expect(row.meta).not.toHaveProperty("regrade_file");
      expect(out.variants.find((x) => x.variant === v)).toMatchObject({ rewritten: 1, remeasured: 1, listed: [] });
      expect(readFileSync(join(flow, v, "regrade.md"), "utf8")).toMatch(
        /rewritten 1: 0 re-judged, 1 rebuilt without a judge call, 0 agent-failed \(meta only\); listed 0;/,
      );
      // The metric columns that moved are in the moved table.
      expect(readFileSync(join(flow, v, "regrade.md"), "utf8")).toMatch(/words —→1200/);
      expect(readdirSync(join(flow, v)).some((n) => /^regrade-[0-9a-f]{16}\.bak\.jsonl$/.test(n))).toBe(true);
    }
    expect(lines.join("\n")).toMatch(
      /baseline rewritten 1: 0 re-judged, 1 rebuilt without a judge call, 0 agent-failed \(meta only\); listed 0; v1 rewritten 1: 0 re-judged, 1 rebuilt without a judge call, 0 agent-failed \(meta only\); listed 0$/,
    );
  }, 240_000);

  // A hillclimb attempt always records the pre-run manifest, so a metric added mid-loop can be filled from any kept run.
  it("a case with no metric and no judged assert still records the manifest: a metric added mid-flow is filled", async () => {
    writing();
    const { rows, evals } = buildFlow({ noPairwise: true });
    const file = join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("preRunHashes");
    addMetrics(evals, "metrics:", WORDS);
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const row = rows(v)[0]!;
      expect(row.grade).toMatchObject({ words: 1200, words_present: 1 });
      expect(row.meta).not.toHaveProperty("metrics_unavailable");
    }
  }, 240_000);

  it("only hillclimb arms it so: a plain `run` of the same scenario records no pre-run manifest", () => {
    writing();
    const { rows } = buildFlow({ noPairwise: true });
    const kept = new Set(["baseline", "v1"].map((v) => rows(v)[0]!.meta.run_id as string));
    const r = spawnSync(process.execPath, [CLI, "run", "evals/alpha.yaml"], {
      cwd: f.cwd,
      env: { ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const plain = readdirSync(join(f.runsDir, "alpha")).filter((d) => d.startsWith("local_") && !kept.has(d));
    expect(plain).toHaveLength(1);
    const result = JSON.parse(readFileSync(join(f.runsDir, "alpha", plain[0]!, "turns", "1", "result.json"), "utf8"));
    expect(result).not.toHaveProperty("preRunHashes");
  }, 240_000);

  it("a metric added to a case whose run recorded no pre-run manifest: `_present: 0`, reason no_manifest (never pre_run)", async () => {
    writing();
    // A row run before hillclimb armed the manifest on every attempt: its kept run records none.
    const { rows, evals } = buildFlow({ noPairwise: true });
    for (const v of ["baseline", "v1"]) {
      const file = join(runDirOf(rows(v)[0]!), "turns", "1", "result.json");
      const r = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const k of ["preRunHashes", "preRunPaths", "preRunLinkAware", "preRunOrigin"]) delete r[k];
      writeFileSync(file, JSON.stringify(r));
    }
    addMetrics(evals, "metrics:", WORDS);
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const row = rows(v)[0]!;
      expect(row.grade).toMatchObject({ words_present: 0 });
      expect(row.grade).not.toHaveProperty("words");
      expect(row.meta.metrics_unavailable).toEqual({ words: "no_manifest" });
    }
  }, 240_000);

  it("a re-measure that changes only the row's metric meta still rewrites it; one that changes nothing leaves it byte for byte", async () => {
    writing();
    const { flow, rows } = buildFlow({ noPairwise: true, metrics: [OTHER] });
    // A row stamped before `meta.metric_sigs` existed: its metric keys are there, its sigs are not.
    const v1File = join(flow, "v1", "results.jsonl");
    const row = rows("v1")[0]!;
    delete row.meta.metric_sigs;
    writeFileSync(v1File, JSON.stringify(row) + "\n");
    const baselineBefore = readFileSync(join(flow, "baseline", "results.jsonl"), "utf8");
    const out = await regradeFlow(ARGS(), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(rows("v1")[0]!.meta.metric_sigs).toEqual({ other: expect.any(String) });
    expect(rows("v1")[0]!.grade).toEqual(row.grade);
    expect(out.variants.map(({ variant, rewritten, remeasured }) => ({ variant, rewritten, remeasured }))).toEqual([
      { variant: "baseline", rewritten: 0, remeasured: 1 },
      { variant: "v1", rewritten: 1, remeasured: 1 },
    ]);
    expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(baselineBefore);
  }, 240_000);

  it("the JSON envelope carries each variant's re-measured count", () => {
    writing();
    const { cli, evals } = buildFlow({ noPairwise: true, metrics: [OTHER] });
    addMetrics(evals, WORDS);
    const r = cli("regrade", "evals", "--flow", "flow", "--approve-harness", "--output-format", "json");
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(r.stdout) as { ok: boolean; variants: Array<{ variant: string; rewritten: number; remeasured: number }> };
    expect(env.ok).toBe(true);
    expect(env.variants.map(({ variant, rewritten, remeasured }) => ({ variant, rewritten, remeasured }))).toEqual([
      { variant: "baseline", rewritten: 1, remeasured: 1 },
      { variant: "v1", rewritten: 1, remeasured: 1 },
    ]);
  }, 240_000);

  it("a judged case: an added metric is re-measured with no judge call; under --rejudge the re-grade re-measures it", async () => {
    writing();
    const { rows, evals } = buildFlow({ metrics: [OTHER] });
    addMetrics(evals, WORDS);
    let calls = 0;
    const deps = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => {
          calls++;
          return { structured: { rationale: "r", verdict: "A" }, model: "claude-haiku-4-5", subtype: "success" };
        },
      },
    });
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(calls).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ words_present: 1, words: 1200 });
    expect(rows("v1")[0]!.meta.regrade_remeasured).toBe(true);
    expect(out.variants[0]).toMatchObject({ rewritten: 1, remeasured: 1 });
    const again = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), deps);
    expect(again.exitCode, JSON.stringify(again)).toBe(0);
    expect(calls).toBeGreaterThan(0);
    const row = rows("v1")[0]!;
    expect(row.grade).toMatchObject({ words_present: 1, words: 1200 });
    expect(row.meta.regrade_doc_matches_live).toBeDefined();
    // Re-measured by the re-grade, and marked so as an unjudged row is; the `remeasured` count stays the unjudged rows'.
    expect(row.meta.regrade_remeasured).toBe(true);
    expect(again.variants[0]).toMatchObject({ rewritten: 1, judged: 1, remeasured: 0 });
  }, 240_000);

  it("a row whose kept run dir is gone or refused is listed per row (exit 1) and left untouched; its sibling is re-measured", async () => {
    writing();
    const { flow, rows, evals } = buildFlow({ noPairwise: true, metrics: [OTHER], reps: 2 });
    const [rep0, rep1] = [0, 1].map((n) => rows("v1").find((r) => r.rep === n)!);
    rmSync(runDirOf(rep0!), { recursive: true, force: true });
    // A multi-turn run dir: the kept-run builder refuses it.
    const bDir = runDirOf(rows("baseline").find((r) => r.rep === 1)!);
    cpSync(join(bDir, "turns", "1"), join(bDir, "turns", "2"), { recursive: true });
    addMetrics(evals, WORDS);
    const beforeV1 = readFileSync(join(flow, "v1", "results.jsonl"), "utf8").split("\n");
    const beforeB = readFileSync(join(flow, "baseline", "results.jsonl"), "utf8").split("\n");
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS());
    expect(out.exitCode).toBe(1);
    const v1 = out.variants.find((v) => v.variant === "v1")!;
    expect(v1.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(/kept run dir is gone/) }]);
    expect(v1).toMatchObject({ rewritten: 1, remeasured: 1 });
    const b = out.variants.find((v) => v.variant === "baseline")!;
    expect(b.listed).toEqual([{ prompt_id: "alpha", rep: 1, why: expect.stringMatching(/^refused: .*holds 2 turns/) }]);
    // The listed rows byte for byte; the siblings filled.
    const afterV1 = readFileSync(join(flow, "v1", "results.jsonl"), "utf8").split("\n");
    const afterB = readFileSync(join(flow, "baseline", "results.jsonl"), "utf8").split("\n");
    const at = (ls: string[], rep: number) => ls.findIndex((l) => l && (JSON.parse(l) as { rep: number }).rep === rep);
    expect(afterV1[at(afterV1, 0)]).toBe(beforeV1[at(beforeV1, 0)]);
    expect(afterB[at(afterB, 1)]).toBe(beforeB[at(beforeB, 1)]);
    expect(rows("v1").find((r) => r.rep === 1)!.grade).toMatchObject({ words_present: 1, words: 1200 });
    expect(rep1).toBeDefined();
  }, 240_000);

  it.each([
    ["a judged case", false],
    ["a case with no judged assert", true],
  ] as const)(
    "%s: a row whose kept work dir is gone is listed (exit 1), never re-measured as unavailable; nothing judged",
    async (_n, noPairwise) => {
      writing();
      const { flow, rows, evals } = buildFlow({ metrics: [OTHER], noPairwise });
      const runDir = runDirOf(rows("v1")[0]!);
      const result = JSON.parse(readFileSync(join(runDir, "turns", "1", "result.json"), "utf8")) as { workDir: string };
      rmSync(result.workDir, { recursive: true, force: true });
      addMetrics(evals, WORDS);
      const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
      let calls = 0;
      const out = await regradeFlow(
        ARGS({ variant: "v1", approveHarness: true }),
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
      expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(/work dir is gone/) }]);
      expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
    },
    240_000,
  );

  it("an agent-failed row gains the added metric's sig and `_present: 0`, never a value or a reason", async () => {
    // A closing question with no gate: the run stalls on it, the agent's own failure (scored, every graded key 0).
    writing(STUB.replaceAll("All done.", "Which file should I use?"));
    const { rows, evals } = buildFlow({ noPairwise: true, metrics: [OTHER] });
    const before = rows("v1")[0]!;
    // Precondition: the fixture IS an agent failure, else this test would pass for the wrong reason.
    expect(before.meta.failure_class).toBe("errored_agent");
    expect(before.grade).toMatchObject({ pass: 0, other_present: 0 });
    addMetrics(evals, WORDS);
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const row = rows(v)[0]!;
      expect(Object.keys(row.meta.metric_sigs as object).sort()).toEqual(["other", "words"]);
      expect(row.grade).toMatchObject({ pass: 0, other_present: 0, words_present: 0 });
      expect(row.grade).not.toHaveProperty("words");
      expect(row.grade).not.toHaveProperty("other");
      expect(row.meta).not.toHaveProperty("metrics_unavailable");
      expect(row.meta).toMatchObject({ failure_class: "errored_agent", regrade_remeasured: true });
    }
  }, 240_000);

  // This test used to pin the opposite: a case with no judged assert in a flow with no metrics was skipped unread, so a
  // run dir the kept-run builder refuses was never noticed. Deliberately flipped: every selected row is re-evaluated
  // from its kept run, so that row is listed, and its healthy sibling is re-evaluated and left byte for byte.
  it("a flow with no metrics and a case with no judged assert: every row is re-evaluated, a refused run dir listed", async () => {
    const { flow, rows } = buildFlow({ noPairwise: true });
    const dir = join(f.runsDir, "alpha", rows("v1")[0]!.meta.run_id as string);
    cpSync(join(dir, "turns", "1"), join(dir, "turns", "2"), { recursive: true });
    const before = readFileSync(join(flow, "baseline", "results.jsonl"), "utf8");
    const lines: string[] = [];
    const out = await regradeFlow(ARGS(), DEPS({ stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(
      out.variants.map((v) => ({ rewritten: v.rewritten, reevaluated: v.reevaluated, remeasured: v.remeasured, listed: v.listed })),
    ).toEqual([
      { rewritten: 0, reevaluated: 1, remeasured: 0, listed: [] },
      {
        rewritten: 0,
        reevaluated: 0,
        remeasured: 0,
        listed: [{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(/^refused: .*holds 2 turns/) }],
      },
    ]);
    expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(before);
    // Every counter is shown, a zero included: none of this flow's rows was re-measured.
    expect(lines.join("\n")).not.toMatch(/re-measured [1-9]/);
  }, 240_000);

  it("a metric whose declaration changed is refused before any re-measure, nothing written", async () => {
    writing();
    const { flow, evals } = buildFlow({ noPairwise: true, metrics: [OTHER] });
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("scale: 2000", "scale: 3000") + `${WORDS}\n`);
    const before = tree(flow);
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS());
    expect(out.exitCode).toBe(2);
    expect(out.error?.message).toMatch(/metric "other" is declared differently from the rows already in baseline, v1/);
    expect(tree(flow)).toEqual(before);
  }, 240_000);
});

// Every selected row's deterministic asserts are re-evaluated from its kept run (verify-run's own evaluation): a
// changed value is applied, never kept stale; an unchanged assert that re-evaluates differently is listed. Each flow is
// written by real `hillclimb run` passes; the scenario is edited afterwards, as a loop fixes its grader mid-flow.
describe.runIf(POSIX)("hillclimb regrade re-evaluates deterministic asserts from the kept run", () => {
  const edit = (evals: string, from: string, to: string) => {
    const sc = join(evals, "alpha.yaml");
    const text = readFileSync(sc, "utf8");
    expect(text).toContain(from);
    writeFileSync(sc, text.replace(from, to));
  };
  const counting = () => {
    const seen = { calls: 0 };
    const deps = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => {
          seen.calls++;
          return { structured: { rationale: "r", verdict: "A" }, model: "claude-haiku-4-5", subtype: "success" };
        },
      },
    });
    return { seen, deps };
  };
  const runDirOf = (row: { meta: Record<string, unknown> }) => join(f.runsDir, "alpha", row.meta.run_id as string);

  it("a deterministic-only case whose assert VALUE changed: the outcome and pass move (never the stale live outcome)", async () => {
    const { flow, rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    // Precondition: the live rows pass the assert as written.
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 1, a1: 1 });
    edit(evals, "transcript_contains: All done", "transcript_contains: Nope");
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) {
      const row = rows(v)[0]!;
      expect(row.grade).toMatchObject({ pass: 0, a0: 1, a1: 0 });
      expect(row.meta).toMatchObject({
        regrade_reevaluated: true,
        regrade_harness_version: expect.any(String),
        regraded_at: expect.any(String),
      });
      expect(out.variants.find((x) => x.variant === v)).toMatchObject({ rewritten: 1, reevaluated: 1, listed: [] });
      // The deterministic move shows in regrade.md's moved table.
      expect(readFileSync(join(flow, v, "regrade.md"), "utf8")).toMatch(/a1 1→0/);
      // The mean pass is over the variant's scored rows, before and after the rewrite.
      expect(readFileSync(join(flow, v, "regrade.md"), "utf8")).toMatch(/; mean pass before 1\.00, after 0\.00 over 1 scored row\(s\)\n/);
    }
  }, 240_000);

  it("a case with deterministic and judged asserts under --rejudge: the deterministic change applies, the judged one is re-judged, one verdict", async () => {
    const { rows, evals } = buildFlow({ extra: ["  - transcript_contains: All done"] });
    // The live pass depends on the stub judge's verdict against a shuffled order: only the deterministic assert is pinned.
    expect(rows("v1")[0]!.grade).toMatchObject({ a1: 1 });
    edit(evals, "transcript_contains: All done", "transcript_contains: Nope");
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true, rejudge: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBeGreaterThan(0);
    const row = rows("v1")[0]!;
    expect(row.grade).toMatchObject({ pass: 0, a0: 1, a1: 0 });
    expect(row.meta.regrade_doc_matches_live).toBeDefined();
    expect(row.meta.regrade_reevaluated).toBe(true);
  }, 240_000);

  // The run's own outcome of an assert unchanged since the run is what its grader said: a kept run re-evaluated to
  // another outcome means our reconstruction differs (a changed sidecar, an evaluator fix, evidence a kept run does
  // not record), not the grader. The live entry stays, and the row says so.
  it.each([
    ["a case with no judged assert", true],
    ["a judged case", false],
  ] as const)(
    "%s: an assert unchanged since the run that re-evaluates differently keeps its live outcome, noted per row",
    async (_n, noPairwise) => {
      const { rows } = buildFlow({ noPairwise, extra: ["  - transcript_contains: All done"] });
      const old = rows("v1")[0]!;
      expect(old.grade).toMatchObject({ a1: 1 });
      // The kept evidence changed under the row: its transcript sidecar no longer holds what the run said.
      const sidecar = join(runDirOf(old), "turns", "1", "run.jsonl");
      writeFileSync(sidecar, readFileSync(sidecar, "utf8").replaceAll("All done.", "Something else."));
      const lines: string[] = [];
      const { seen, deps } = counting();
      const out = await regradeFlow(ARGS({ variant: "v1" }), { ...deps, stderr: (l) => lines.push(l) });
      // No judge call either way. The transcript is also a section of the judged document: in a judged case the
      // evidence its judge would see changed, so the row is listed and kept as it is (--rejudge grades it).
      expect(seen.calls).toBe(0);
      expect(lines.filter((l) => /kept its live outcome/.test(l))).toEqual([
        expect.stringMatching(/\[v1\] alpha rep0: assertion 1 \(`transcript_contains`\) passes in the run, fails re-evaluated now/),
      ]);
      if (!noPairwise) {
        expect(out.exitCode, JSON.stringify(out)).toBe(1);
        expect(out.variants[0]!.listed).toEqual([
          {
            prompt_id: "alpha",
            rep: 0,
            why: expect.stringMatching(/^the evidence the judge would see changed since this grade \(assert 2\)/),
          },
        ]);
        expect(rows("v1")[0]).toEqual(old);
        return;
      }
      expect(out.exitCode, JSON.stringify(out)).toBe(0);
      expect(out.variants[0]!.listed).toEqual([]);
      const row = rows("v1")[0]!;
      expect(row.grade.a1).toBe(1);
      expect(row.grade.pass).toBe(old.grade.pass);
      expect(row.meta.regrade_kept_live).toEqual([1]);
    },
    240_000,
  );

  it("an assert added beside an unchanged one that re-evaluates differently: the added one is evaluated, the unchanged one keeps its live outcome", async () => {
    const { rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const old = rows("v1")[0]!;
    const sidecar = join(runDirOf(old), "turns", "1", "run.jsonl");
    writeFileSync(sidecar, readFileSync(sidecar, "utf8").replaceAll("All done.", "Something else."));
    // A second `result: success`: matched by identity with multiplicity, so it is new (index 2), not the run's index 0.
    const sc = join(evals, "alpha.yaml");
    writeFileSync(
      sc,
      readFileSync(sc, "utf8").replace("  - transcript_contains: All done\n", "  - transcript_contains: All done\n  - result: success\n"),
    );
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    const row = rows("v1")[0]!;
    expect(row.grade).toMatchObject({ pass: 1, a0: 1, a1: 1, a2: 1 });
    expect(row.meta.regrade_kept_live).toEqual([1]);
  }, 240_000);

  it("an index-shifting edit: the moved table compares no a<i> across the two lists, and says so", async () => {
    const { flow, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("assert:\n", "assert:\n  - transcript_contains: Nope\n"));
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    const md = readFileSync(join(flow, "v1", "regrade.md"), "utf8");
    expect(md).toMatch(/\| alpha \| 0 \| pass 1→0 \(a<i> not compared: the assertion list changed\) \|/);
    expect(md).not.toMatch(/a0 1→0/);
  }, 240_000);

  // `no_delete_in_mounts` reads a waiver its sibling `allow_delete_in` sets across the whole list: removing or adding
  // the sibling changes what the unchanged-looking assert grades, so it is not the assert its run graded.
  it("no_delete_in_mounts: removing its allow_delete_in sibling re-evaluates it (pass moves); adding it back flips it back", async () => {
    const { rows, evals } = buildFlow({
      noPairwise: true,
      extra: ["  - no_delete_in_mounts: true", "  - allow_delete_in: [proj]"],
    });
    const old = rows("v1")[0]!;
    expect(old.grade).toMatchObject({ pass: 1, a1: 1 });
    // The run deleted in its waived `proj` folder: the scan recorded it, and the waiver passed the assert.
    const file = join(runDirOf(old), "turns", "1", "result.json");
    const r = JSON.parse(readFileSync(file, "utf8")) as { scan?: Record<string, unknown> };
    r.scan = {
      outputsDeletes: [],
      hostPathLeaked: false,
      selfHealRan: false,
      ...(r.scan ?? {}),
      mountDeletes: [{ mount: "proj", command: "rm proj/a.txt" }],
    };
    writeFileSync(file, JSON.stringify(r));
    const lines: string[] = [];
    edit(evals, "  - allow_delete_in: [proj]\n", "");
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS({ stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(lines.filter((l) => /kept its live outcome/.test(l))).toEqual([]);
    const row = rows("v1")[0]!;
    expect(row.grade).toMatchObject({ pass: 0, a0: 1, a1: 0 });
    expect(row.meta).not.toHaveProperty("regrade_kept_live");
    // The waiver back: the assert is the run's again, so it takes the run's own outcome.
    writeFileSync(
      join(evals, "alpha.yaml"),
      readFileSync(join(evals, "alpha.yaml"), "utf8").replace(/\n?$/, "\n") + "  - allow_delete_in: [proj]\n",
    );
    const back = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS({ stderr: (l) => lines.push(l) }));
    expect(back.exitCode, JSON.stringify(back)).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 1, a0: 1, a1: 1 });
    expect(lines.filter((l) => /kept its live outcome/.test(l))).toEqual([]);
  }, 240_000);

  it("counts: re-measured counts only rows of a case that declares a metric; the summary says no judge was called", async () => {
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' '{"words":1200}' > outputs/m.json\n${STUB}`);
    const { rows, evals } = buildFlow({
      noPairwise: true,
      withBeta: true,
      metrics: ["  - { id: other, artifact: outputs/m.json, path: words, better: higher, scale: 2000 }"],
    });
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8") + "  - { id: words, artifact: outputs/m.json, path: words, better: higher, scale: 2000 }\n");
    const lines: string[] = [];
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS({ stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of out.variants) expect(v).toMatchObject({ rewritten: 2, reevaluated: 2, remeasured: 1 });
    expect(rows("v1").find((r) => r.prompt_id === "alpha")!.meta.regrade_remeasured).toBe(true);
    expect(rows("v1").find((r) => r.prompt_id === "beta")!.meta).not.toHaveProperty("regrade_remeasured");
    expect(lines.at(-1)).toMatch(
      /^hillclimb regrade: baseline rewritten 2: 0 re-judged, 2 rebuilt without a judge call, 0 agent-failed \(meta only\); re-measured 1 without a judge call; listed 0;/,
    );
  }, 240_000);

  it("a row whose re-evaluation changes nothing stays byte for byte and is counted re-evaluated", async () => {
    const { flow } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const before = tree(flow);
    const lines: string[] = [];
    const out = await regradeFlow(ARGS(), DEPS({ stderr: (l) => lines.push(l) }));
    // Nothing rewritten: the mean is still the variant's real one, and says it is unchanged.
    for (const v of ["baseline", "v1"])
      expect(lines.find((l) => l.startsWith(`  [${v}] `))).toMatch(
        /; mean pass before 1\.00, after 1\.00 over 1 scored row\(s\); unchanged \(no rows rewritten\)$/,
      );
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(out.variants.map(({ variant, rewritten, reevaluated, listed }) => ({ variant, rewritten, reevaluated, listed }))).toEqual([
      { variant: "baseline", rewritten: 0, reevaluated: 1, listed: [] },
      { variant: "v1", rewritten: 0, reevaluated: 1, listed: [] },
    ]);
    expect(tree(flow)).toEqual(before);
  }, 240_000);

  it("expect_denied: a judged case's rows are re-judged, a fill's filled — never listed for the trailing egress_denied entries", async () => {
    // `expect_denied` needs a sandboxed tier, which the stub agent cannot run: the kept runs are given the shape a sandboxed
    // run persists — one trailing `egress_denied` entry per host after the asserts', and the egress log it was graded
    // on — and the scenario declares the host. The host passed, as the rows' `pass: 1` says it did.
    const { cli, rows, evals } = buildFlow();
    for (const v of ["baseline", "v1"]) {
      const file = join(runDirOf(rows(v)[0]!), "turns", "1", "result.json");
      const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: unknown[]; egress?: unknown[] };
      r.assertions.push({ assertion: { egress_denied: "blocked.example" }, pass: true, message: "expected blocked.example to be denied" });
      r.egress = [{ host: "blocked.example", decision: "deny" }];
      writeFileSync(file, JSON.stringify(r));
    }
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("assert:\n", "expect_denied: [blocked.example]\nassert:\n"));
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const { seen, deps } = counting();
    const fill = await regradeFlow(ARGS({ fillRefs: true, approveHarness: true }), deps);
    expect(
      fill.variants.flatMap((v) => v.listed),
      JSON.stringify(fill),
    ).toEqual([]);
    expect(rows("baseline")[0]!.grade).toHaveProperty("win_v1");
    seen.calls = 0;
    const out = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), deps);
    expect(out.variants[0]!.listed, JSON.stringify(out)).toEqual([]);
    expect(out.variants[0]!.rewritten).toBe(1);
    expect(seen.calls).toBeGreaterThan(0);
    expect(rows("v1")[0]!.meta.regrade_reevaluated).toBe(true);
  }, 240_000);

  it("expect_denied: a host added since the run is re-evaluated (pass moves), and a fill lists it", async () => {
    const { rows, evals } = buildFlow({ noPairwise: true });
    expect(rows("v1")[0]!.grade.pass).toBe(1);
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("assert:\n", "expect_denied: [blocked.example]\nassert:\n"));
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS());
    expect(out.variants[0]!.listed, JSON.stringify(out)).toEqual([]);
    // No egress decision was recorded, so the denial cannot be shown: the assert fails, and with it the verdict.
    expect(rows("v1")[0]!.grade.pass).toBe(0);
  }, 240_000);

  // A default regrade that applied a change grades the row under the scenario as it is now; the run's result.json, which
  // no regrade touches, still holds the old list. A fill compares with what the row was GRADED with, so it is not
  // listed "run a default regrade first" for a change that default regrade already applied.
  it.each([
    ["an inserted assert (the list shifts)", "assert:\n", "assert:\n  - transcript_contains: done\n"],
    ["a value change that flipped an outcome", "transcript_contains: All done", "transcript_contains: Nope"],
  ] as const)(
    "%s: default regrade, then --fill-refs fills (never listed for the applied change)",
    async (_n, from, to) => {
      const { cli, rows, evals } = buildFlow({ extra: ["  - transcript_contains: All done"] });
      expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
      edit(evals, from, to);
      const { seen, deps } = counting();
      const first = await regradeFlow(ARGS({ approveHarness: true }), deps);
      expect(first.exitCode, JSON.stringify(first)).toBe(0);
      const graded = { b: rows("baseline")[0]!.grade, v1: rows("v1")[0]!.grade };
      const fill = await regradeFlow(ARGS({ fillRefs: true }), deps);
      expect(
        fill.variants.flatMap((v) => v.listed),
        JSON.stringify(fill),
      ).toEqual([]);
      expect(fill.exitCode).toBe(0);
      expect(seen.calls).toBeGreaterThan(0);
      // The fill added the column and moved no outcome the default regrade graded.
      expect(rows("baseline")[0]!.grade).toHaveProperty("win_v1");
      for (const [v, g] of [
        ["baseline", graded.b],
        ["v1", graded.v1],
      ] as const) {
        const now = rows(v)[0]!.grade;
        for (const k of Object.keys(g).filter((k) => /^(pass|a\d+)$/.test(k))) expect(now[k], `${v} ${k}`).toBe(g[k]);
      }
    },
    240_000,
  );

  it("a fill reads a kept outcome's reference by the assert it grades now, not by its index in the run's list", async () => {
    const { cli, flow, rows, evals } = buildFlow();
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    // Precondition: v1's run compared against baseline's frozen document.
    const v1Run = JSON.parse(readFileSync(join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json"), "utf8")) as {
      assertions: Array<{ pairwise?: Array<{ ref: string; refDocSha256?: string }> }>;
    };
    expect(v1Run.assertions[1]!.pairwise!.find((o) => o.ref === "baseline")!.refDocSha256).toEqual(expect.any(String));
    // A default regrade applies the inserted assert: the pairwise one is index 2 now, index 1 in the run's list.
    edit(evals, "assert:\n", "assert:\n  - transcript_contains: done\n");
    const { deps } = counting();
    expect((await regradeFlow(ARGS({ approveHarness: true }), deps)).exitCode).toBe(0);
    // baseline's frozen document is changed after it (re-frozen by hand): v1's kept outcome was judged against another.
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const docs = walk(join(flow, "baseline", "ref")).filter((p) => /doc-[^/]+\.txt$/.test(p));
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      const text = readFileSync(doc, "utf8") + "\nedited";
      writeFileSync(doc, text);
      const side = doc.replace(/\.txt$/, ".json");
      const meta = JSON.parse(readFileSync(side, "utf8")) as Record<string, unknown>;
      writeFileSync(side, JSON.stringify({ ...meta, sha256: createHash("sha256").update(text).digest("hex"), chars: text.length }));
    }
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const fill = await regradeFlow(ARGS({ variant: "v1", fillRefs: true }), deps);
    expect(fill.variants[0]!.listed, JSON.stringify(fill)).toEqual([
      { prompt_id: "alpha", rep: 0, why: "its kept outcome against baseline was judged against a reference that has changed since" },
    ]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
  }, 240_000);

  it("--fill-refs with a deterministic grader change: listed (run a default regrade first), pass never moves, no judge call", async () => {
    const { cli, flow, evals } = buildFlow({ extra: ["  - transcript_contains: All done"] });
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    edit(evals, "transcript_contains: All done", "transcript_contains: Nope");
    const before = {
      b: readFileSync(join(flow, "baseline", "results.jsonl"), "utf8"),
      v1: readFileSync(join(flow, "v1", "results.jsonl"), "utf8"),
    };
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ fillRefs: true, approveHarness: true }), deps);
    expect(out.exitCode).toBe(1);
    expect(seen.calls).toBe(0);
    for (const v of out.variants)
      expect(v.listed).toEqual([
        {
          prompt_id: "alpha",
          rep: 0,
          why: expect.stringMatching(/the grader changed since the row was graded.*run a default `hillclimb regrade` first/),
        },
      ]);
    expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(before.b);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before.v1);
  }, 240_000);

  // A fill never moves `pass`, whatever the cause: the per-assert checks compare each outcome with what the row was
  // graded with, but an `expect_denied` host has no `a<i>` key to compare. The backstop compares the rebuilt `pass`.
  it("a fill whose rebuild would move pass is listed, nothing written (an expect_denied host, which no a<i> records)", async () => {
    // A tying judge: v1's live pass would otherwise turn on the order its comparison was in.
    const { cli, flow, rows, evals } = buildFlow({ judgeTies: true });
    for (const v of ["baseline", "v1"]) expect(rows(v)[0]!.grade.pass, JSON.stringify(rows(v)[0])).toBe(1);
    edit(evals, "assert:\n", "expect_denied: [blocked.example]\nassert:\n");
    const { deps } = counting();
    // A default regrade applies the host added since the run: no denial was recorded, so it fails, and pass with it.
    expect((await regradeFlow(ARGS({ approveHarness: true }), deps)).exitCode).toBe(0);
    for (const v of ["baseline", "v1"]) expect(rows(v)[0]!.grade.pass, v).toBe(0);
    // The kept runs now read the host denied (as an evaluator change since the default regrade would): the host's
    // outcome would move, and with it pass.
    for (const v of ["baseline", "v1"]) {
      const file = join(runDirOf(rows(v)[0]!), "turns", "1", "result.json");
      const r = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...r, egress: [{ host: "blocked.example", decision: "deny" }] }));
    }
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const before = {
      baseline: readFileSync(join(flow, "baseline", "results.jsonl"), "utf8"),
      v1: readFileSync(join(flow, "v1", "results.jsonl"), "utf8"),
    };
    // A priced judge: the baseline row's call is spent before the row is listed, and still counted.
    const lines: string[] = [];
    const fill = await regradeFlow(
      ARGS({ fillRefs: true }),
      DEPS({ stderr: (l) => lines.push(l), regradeOptions: { pairwiseComplete: priced("tie", 0.0123) } }),
    );
    expect(fill.exitCode, JSON.stringify(fill)).toBe(1);
    expect(fill.variants.find((v) => v.variant === "baseline")).toMatchObject({ judged: 0, listedAfterJudge: 1, judgeUsd: 0.0123 });
    expect(lines.find((l) => l.startsWith("  [baseline] "))).toMatch(
      /^  \[baseline\] rewritten 0: 0 re-judged \(\$0\.0123 judge, incl\. 1 row judged then listed\), 0 rebuilt without a judge call, 0 agent-failed \(meta only\); listed 1; /,
    );
    // Both rebuild paths: baseline's row is judged (it lacks win_v1), v1's is rebuilt with no judge call.
    for (const v of fill.variants)
      expect(v.listed, `${v.variant} ${JSON.stringify(rows(v.variant)[0])} ${JSON.stringify(fill)}`).toEqual([
        {
          prompt_id: "alpha",
          rep: 0,
          why: expect.stringMatching(
            /^a fill never moves pass, and this row's would: 0 as graded, 1 rebuilt .*run a default `hillclimb regrade` first/,
          ),
        },
      ]);
    for (const v of ["baseline", "v1"] as const) expect(readFileSync(join(flow, v, "results.jsonl"), "utf8"), v).toBe(before[v]);
  }, 240_000);

  // result.json is written through the secret scrub, so an assert whose literal holds a scrubbed value is stored as
  // `[REDACTED]` there. It is still the assert the run graded: a default regrade of an unchanged scenario must match it,
  // keep its live outcome, and never re-evaluate it over the scrubbed transcript.
  const SCRUBBED = { COWORK_HARNESS_SCRUB_VALUES: "All done" };
  const resultOf = (row: { meta: Record<string, unknown> }) =>
    JSON.parse(readFileSync(join(runDirOf(row), "turns", "1", "result.json"), "utf8")) as {
      assertions: Array<{ assertion: Record<string, unknown>; pass: boolean }>;
    };

  it("a scrubbed assert literal, scenario unchanged: matched under this process's scrub, live outcome kept, grade byte for byte", async () => {
    const { flow, rows } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"], env: SCRUBBED });
    // Precondition: the live run passed it on the raw transcript, and its result.json holds the assert scrubbed.
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 1, a1: 1 });
    expect(resultOf(rows("v1")[0]!).assertions[1]!.assertion).toEqual({ transcript_contains: "[REDACTED]" });
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const lines: string[] = [];
    const out = await regradeFlow(
      ARGS({ variant: "v1", approveHarness: true }),
      DEPS({ secrets: collectSecrets(), stderr: (l) => lines.push(l) }),
    );
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(out.variants[0]!.listed).toEqual([]);
    const row = rows("v1")[0]!;
    const was = JSON.parse(before.trim()) as { grade: unknown; explanation: unknown };
    expect(row.grade).toEqual(was.grade);
    expect((row as unknown as { explanation: unknown }).explanation).toEqual(was.explanation);
    // Unchanged, so the scrubbed re-evaluation (it fails: the kept transcript reads `[REDACTED].`) is not the grade.
    expect(row.meta.regrade_kept_live).toEqual([1]);
    expect(lines.join("\n")).not.toMatch(/All done/);
    // Matched exactly under this process's scrub: nothing unknowable to name.
    expect(lines.join("\n")).not.toMatch(/is scrubbed in the run's result\.json/);
  }, 240_000);

  it("a scrubbed assert literal this process cannot reproduce (no secrets): kept live and named, never re-evaluated", async () => {
    const { rows } = buildFlow({
      noPairwise: true,
      extra: ["  - transcript_contains: All done", "  - transcript_not_contains: All done"],
      env: SCRUBBED,
    });
    // Live: the transcript contains it, so the leak-style assert failed.
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 0, a1: 1, a2: 0 });
    const lines: string[] = [];
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS({ secrets: [], stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    // Over the scrubbed transcript a2 would pass: a fail on a leak turned green. It keeps its live fail.
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 0, a1: 1, a2: 0 });
    for (const i of [1, 2])
      expect(lines.join("\n")).toMatch(
        new RegExp(`alpha rep0: assertion ${i} \\(\`transcript_\\w+\`\\) is scrubbed in the run's result\\.json`),
      );
  }, 240_000);

  it("a scrubbed assert literal under this process's scrub: a leak-style fail is kept, never turned green", async () => {
    const { rows } = buildFlow({
      noPairwise: true,
      extra: ["  - transcript_contains: All done", "  - transcript_not_contains: All done"],
      env: SCRUBBED,
    });
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 0, a1: 1, a2: 0 });
    const lines: string[] = [];
    const out = await regradeFlow(
      ARGS({ variant: "v1", approveHarness: true }),
      DEPS({ secrets: collectSecrets(), stderr: (l) => lines.push(l) }),
    );
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 0, a1: 1, a2: 0 });
    expect(rows("v1")[0]!.meta.regrade_kept_live).toEqual([1, 2]);
    expect(lines.join("\n")).not.toMatch(/is scrubbed in the run's result\.json/);
  }, 240_000);

  it.each([
    ["a value edit the scrubbed form could hide", "transcript_contains: Nope", { pass: 1, a1: 1 }, true],
    ["a key edit", "transcript_matches: Nope", { pass: 0, a1: 0 }, false],
  ] as const)(
    "a scrubbed assert literal edited since the run (%s)",
    async (_n, to, grade, named) => {
      // A scrubbed literal that this process's scrub does not reproduce may be any value: the edit cannot be told from a
      // run scrubbed with other secrets, so the graded outcome is kept and the row named. A key edit is a changed assert.
      const { rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"], env: SCRUBBED });
      edit(evals, "transcript_contains: All done", to);
      const lines: string[] = [];
      const out = await regradeFlow(
        ARGS({ variant: "v1", approveHarness: true }),
        DEPS({ secrets: collectSecrets(), stderr: (l) => lines.push(l) }),
      );
      expect(out.exitCode, JSON.stringify(out)).toBe(0);
      expect(rows("v1")[0]!.grade).toMatchObject(grade);
      expect(
        /assertion 1 \(`\w+`\) is scrubbed in the run's result\.json.*an edited one takes a re-run of the case/.test(lines.join("\n")),
      ).toBe(named);
    },
    240_000,
  );

  // Both values are scrubbed, so the edited assert scrubs to the very form the run recorded: an exact scrubbed match.
  // Whether it changed cannot be told from result.json, and rewriting the row would record the new assert_sig over the
  // old outcome — so every later regrade would take it as unchanged. The row is listed instead, untouched, every time.
  const BOTH = { COWORK_HARNESS_SCRUB_VALUES: "All done,Nope" };
  const CANNOT_APPLY =
    /assertion 1 \(`\w+`\): its literal is scrubbed in the run's result\.json, so an edit to it cannot be applied — re-run the case/;

  it("an edit inside a scrubbed literal that this process's scrub reproduces: listed, untouched, on every regrade", async () => {
    const { flow, rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"], env: BOTH });
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 1, a1: 1 });
    edit(evals, "transcript_contains: All done", "transcript_contains: Nope");
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    for (const pass of [1, 2]) {
      const lines: string[] = [];
      const out = await regradeFlow(
        ARGS({ variant: "v1", approveHarness: true }),
        DEPS({ secrets: collectSecrets(), stderr: (l) => lines.push(l) }),
      );
      expect(out.exitCode, `regrade #${pass}: ${JSON.stringify(out)}`).toBe(1);
      expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(CANNOT_APPLY) }]);
      expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8"), `regrade #${pass}`).toBe(before);
      const said = lines.join("\n");
      expect(said).not.toMatch(/unchanged since the run/);
      expect(said + JSON.stringify(out)).not.toMatch(/All done|Nope/);
    }
  }, 300_000);

  it("an edit inside a judged assert's scrubbed rubric that this process's scrub reproduces: listed, no judge call", async () => {
    const { flow, evals } = buildFlow({ extra: SCRUBBED_JUDGED, env: BOTH });
    edit(evals, "rubric: ['says All done']", "rubric: ['says Nope']");
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const { users, deps } = capturing(collectSecrets());
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(CANNOT_APPLY) }]);
    expect(users).toEqual([]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
  }, 240_000);

  it("a scrubbed literal this process's scrub reproduces, scenario unchanged: no cannot-tell line", async () => {
    const { rows } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"], env: SCRUBBED });
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 1, a1: 1 });
    const lines: string[] = [];
    const out = await regradeFlow(
      ARGS({ variant: "v1", approveHarness: true }),
      DEPS({ secrets: collectSecrets(), stderr: (l) => lines.push(l) }),
    );
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(lines.join("\n")).not.toMatch(/cannot tell whether this assert changed/);
  }, 240_000);

  it.each([
    ["this process's scrub reproduces it", true],
    ["this process cannot reproduce it (no secrets)", false],
  ] as const)(
    "a judged assert whose rubric holds a scrubbed value, scenario unchanged (%s): kept, no judge call",
    async (_n, withSecrets) => {
      const judged = ["  - semantic_pairwise:", "      rubric: ['says All done']", "      judge_model: claude-haiku-4-5-20251001"];
      const { flow, rows } = buildFlow({ extra: judged, env: SCRUBBED });
      expect(JSON.stringify(resultOf(rows("v1")[0]!).assertions[1]!.assertion)).toContain("[REDACTED]");
      const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
      const { seen, deps } = counting();
      const lines: string[] = [];
      const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), {
        ...deps,
        secrets: withSecrets ? collectSecrets() : [],
        stderr: (l) => lines.push(l),
      });
      expect(out.exitCode, JSON.stringify(out)).toBe(0);
      expect(out.variants[0]!.listed).toEqual([]);
      expect(seen.calls).toBe(0);
      const was = JSON.parse(before.trim()) as { grade: unknown };
      expect(rows("v1")[0]!.grade).toEqual(was.grade);
      // Named only when this process's scrub cannot reproduce it (then whether it changed is unknowable).
      expect(/alpha rep0: assertion 1 \(`semantic_pairwise`\) is scrubbed in the run's result\.json/.test(lines.join("\n"))).toBe(
        !withSecrets,
      );
    },
    240_000,
  );

  // The live run sent the judge the rubric and the document both scrubbed (`[REDACTED]`). A re-judge from a process
  // whose scrub does not reproduce the recorded rubric would send the RAW rubric against the scrubbed document — for a
  // negative claim, a leak turned green no live run could produce. Any re-judge such an assert would need lists the row
  // (no judge call, nothing written) until --allow-doc-drift, after checking the scrub settings.
  const SCRUBBED_JUDGED = ["  - semantic_pairwise:", "      rubric: ['says All done']", "      judge_model: claude-haiku-4-5-20251001"];
  const capturing = (secrets: readonly string[]) => {
    const users: string[] = [];
    const lines: string[] = [];
    const deps = DEPS({
      secrets,
      stderr: (l) => lines.push(l),
      regradeOptions: {
        pairwiseComplete: async (call) => {
          users.push(call.user);
          return { structured: { rationale: "r", verdict: "A" }, model: "claude-haiku-4-5", subtype: "success" };
        },
      },
    });
    return { users, lines, deps };
  };
  const SCRUB_REMEDY = /run with the same scrub settings the run used.*or pass --allow-doc-drift explicitly after checking/;

  it.each([
    ["--rejudge", { rejudge: true }],
    ["--judge-model", { judgeModel: "claude-opus-4-8" }],
  ] as const)(
    "a judged assert scrubbed in its run that this process cannot reproduce: %s lists the row, no judge call, row untouched",
    async (_n, over) => {
      const { flow } = buildFlow({ extra: SCRUBBED_JUDGED, env: SCRUBBED });
      const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
      const { users, lines, deps } = capturing([]);
      const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true, ...over }), deps);
      expect(out.exitCode, JSON.stringify(out)).toBe(1);
      expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(SCRUB_REMEDY) }]);
      expect(users).toEqual([]);
      expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
      // Listed, so never said to be kept.
      expect(lines.join("\n")).not.toMatch(/graded outcome kept/);
    },
    240_000,
  );

  it("a judged assert scrubbed in its run that this process cannot reproduce: freeze-ref then --fill-refs lists the row, no judge call", async () => {
    const { cli, flow } = buildFlow({ extra: SCRUBBED_JUDGED, env: SCRUBBED });
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const before = readFileSync(join(flow, "baseline", "results.jsonl"), "utf8");
    const { users, deps } = capturing([]);
    const out = await regradeFlow(ARGS({ variant: "baseline", fillRefs: true, approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(SCRUB_REMEDY) }]);
    expect(users).toEqual([]);
    expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(before);
  }, 300_000);

  it("a judged assert scrubbed in its run that this process cannot reproduce: freeze-ref then a default regrade (opponents changed) lists the row", async () => {
    const { cli, flow } = buildFlow({ extra: SCRUBBED_JUDGED, env: SCRUBBED });
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const before = readFileSync(join(flow, "baseline", "results.jsonl"), "utf8");
    const { users, deps } = capturing([]);
    const out = await regradeFlow(ARGS({ variant: "baseline", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(SCRUB_REMEDY) }]);
    expect(users).toEqual([]);
    expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(before);
  }, 300_000);

  it("a judged assert scrubbed in its run that this process cannot reproduce: --allow-doc-drift lets the re-judge through", async () => {
    const { rows } = buildFlow({ extra: SCRUBBED_JUDGED, env: SCRUBBED });
    const { users, lines, deps } = capturing([]);
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true, rejudge: true, allowDocDrift: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(out.variants[0]!.listed).toEqual([]);
    expect(users.length).toBeGreaterThan(0);
    expect(rows("v1")[0]!.meta.regrade_rejudged_because).toBeDefined();
    // Re-judged, so never said to be kept.
    expect(lines.join("\n")).not.toMatch(/graded outcome kept/);
  }, 240_000);

  it("a judged assert scrubbed in its run that this process's scrub reproduces: re-judged with the rubric scrubbed as the run sent it", async () => {
    buildFlow({ extra: SCRUBBED_JUDGED, env: SCRUBBED });
    const { users, deps } = capturing(collectSecrets());
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true, rejudge: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(out.variants[0]!.listed).toEqual([]);
    const scrubbedRubric = users.filter((u) => u.includes("says [REDACTED]"));
    expect(scrubbedRubric.length).toBeGreaterThan(0);
    for (const u of users) expect(u).not.toContain("All done");
  }, 240_000);

  // A default regrade re-judges a judged assert only when something its judge reads or grades with changed: a
  // deterministic fix costs no judge call and re-rolls no verdict.
  const SECOND = ["  - semantic_pairwise:", "      rubric: ['second']", "      judge_model: claude-haiku-4-5-20251001"];
  /** A row without the keys a regrade rewrites whatever it re-judges. */
  const judgedView = (r: { grade: Record<string, number>; meta: Record<string, unknown> } & Record<string, unknown>) => {
    const meta = { ...r.meta };
    for (const k of ["assert_sig", "regraded_at", "regrade_harness_version", "regrade_reevaluated"]) delete meta[k];
    const grade = Object.fromEntries(Object.entries(r.grade).filter(([k]) => !/^(pass|a1)(_|$)/.test(k)));
    return { ...r, grade, meta };
  };

  it("a deterministic-only edit: zero judge calls, every judged entry kept byte for byte", async () => {
    const { rows, evals } = buildFlow({ extra: ["  - transcript_contains: All done"] });
    const before = rows("v1")[0]!;
    edit(evals, "transcript_contains: All done", "transcript_contains: Nope");
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBe(0);
    const after = rows("v1")[0]!;
    expect(after.grade).toMatchObject({ pass: 0, a1: 0 });
    expect(judgedView(after)).toEqual(judgedView(before));
    expect(after.meta).not.toHaveProperty("regrade_rejudged_because");
  }, 240_000);

  it("a rubric edit: only that assert is re-judged, the other judged one kept as it was", async () => {
    const { rows, evals } = buildFlow({ extra: SECOND });
    const before = rows("v1")[0]!;
    edit(evals, "rubric: ['second']", "rubric: ['second, edited']");
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    // One comparison: the edited assert against the baseline (the kept assert is never sent).
    expect(seen.calls).toBe(1);
    const after = rows("v1")[0]!;
    expect(after.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["assert_changed"] }]);
    const keys = (g: Record<string, number>) => Object.fromEntries(Object.entries(g).filter(([k]) => /^a2(_|$)/.test(k)));
    expect(keys(after.grade)).toEqual(keys(before.grade));
    expect(Object.keys(keys(after.grade)).length).toBeGreaterThan(0);
  }, 240_000);

  // `judge_usage` / `judge_model` describe the judges behind the grade the row carries (kept entries included);
  // `meta.regrade_judge_usd` is what THIS regrade spent, in a default regrade as in a fill.
  it("a partial re-judge records its own spend (regrade_judge_usd) and model apart from the row's judge fields", async () => {
    const { rows, evals } = buildFlow({ extra: SECOND });
    edit(evals, "rubric: ['second']", "rubric: ['second, edited']");
    const deps = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => ({
          structured: { rationale: "r", verdict: "A" },
          model: "claude-haiku-4-5",
          usage: { "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, costUSD: 0.25 } },
          subtype: "success",
        }),
      },
    });
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    const meta = rows("v1")[0]!.meta;
    expect(meta.regrade_judge_usd).toBe(0.25);
    expect(meta.regrade_judge_model).toBe("claude-haiku-4-5");
    expect(meta).not.toHaveProperty("regrade_fill");
  }, 240_000);

  // The live rows a real CLI pass wrote: a pairwise assert judged against the baseline costs its judge call; the
  // baseline's own assert against its own reference is neutral (no judge called) and is neither priced nor unpriced.
  it("live rows: judge_usd on a judged row; the baseline's neutral own-reference pairwise is not unpriced", () => {
    const { rows, flow } = buildFlow({ reps: 2 });
    const base = rows("baseline")[0]! as Record<string, any>;
    expect(base).not.toHaveProperty("judge_usd");
    expect(base.meta).not.toHaveProperty("judge_unpriced");
    const v1 = rows("v1")[0]! as Record<string, any>;
    expect(v1.judge_usd).toBe(0.051539);
    expect(v1.meta).not.toHaveProperty("judge_unpriced");
    const summary = (v: string) => JSON.parse(readFileSync(join(flow, v, "summary.json"), "utf8"));
    // The stub agent reports no total_cost_usd: its rows record no cost, counted as such and never as $0.
    // The baseline's neutral rows: no judge ran, so neither unpriced nor unrecorded.
    expect(summary("baseline")).toMatchObject({
      judge_rows_unpriced: 0,
      judge_rows_unrecorded: 0,
      cost_rows: 0,
      cost_rows_unrecorded: 2,
      billing_rows_unrecorded: 2,
    });
    expect(summary("baseline")).not.toHaveProperty("judge_usd_total");
    expect(summary("v1")).toMatchObject({ judge_usd_total: 0.103078, judge_rows_unpriced: 0, judge_rows_unrecorded: 0 });
    // judge_usd_mean shares cost_usd_mean's rows (scored, with a cost): the stub's rows have none, so neither is written.
    expect(summary("v1")).not.toHaveProperty("judge_usd_mean");
    expect(summary("v1")).not.toHaveProperty("cost_usd_mean");
  }, 240_000);

  // A re-judge keeps the row's `judge_usd` (what the live judge spent) and recomputes the variant's spend keys at its end.
  it("a re-judge keeps the live judge_usd and recomputes summary.json's spend keys (regrade_judge_usd_total)", async () => {
    const { rows, evals, flow } = buildFlow({ extra: SECOND });
    const live = rows("v1")[0]! as Record<string, any>;
    expect(typeof live.judge_usd).toBe("number");
    edit(evals, "rubric: ['second']", "rubric: ['second, edited']");
    const deps = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => ({
          structured: { rationale: "r", verdict: "A" },
          model: "claude-haiku-4-5",
          usage: { "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, costUSD: 0.25 } },
          subtype: "success",
        }),
      },
    });
    expect((await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps)).exitCode).toBe(0);
    expect((rows("v1")[0]! as Record<string, any>).judge_usd).toBe(live.judge_usd);
    const summary = JSON.parse(readFileSync(join(flow, "v1", "summary.json"), "utf8"));
    expect(summary).toMatchObject({ regrade_judge_usd_total: 0.25, judge_usd_total: live.judge_usd });
  }, 240_000);

  // A rebuilt row keeps what describes its LIVE run: the live judge's spend and the credential the agent billed.
  it("a re-judged row keeps judge_usd, meta.billing and meta.judge_unpriced", async () => {
    const { rows, evals, flow } = buildFlow({ extra: SECOND });
    // The stub agent sends no account frame: put the live row's billing and an unpriced count on it as a pass writes them.
    const file = join(flow, "v1", "results.jsonl");
    const live = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, any>;
    live.meta.billing = { api_key_source: "none", token_source: "CLAUDE_CODE_OAUTH_TOKEN", provider: "firstParty", basis: "subscription" };
    live.meta.judge_unpriced = 1;
    writeFileSync(file, JSON.stringify(live) + "\n");
    edit(evals, "rubric: ['second']", "rubric: ['second, edited']");
    const deps = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => ({
          structured: { rationale: "r", verdict: "A" },
          model: "claude-haiku-4-5",
          usage: { "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, costUSD: 0.25 } },
          subtype: "success",
        }),
      },
    });
    expect((await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps)).exitCode).toBe(0);
    const after = rows("v1")[0]! as Record<string, any>;
    expect(after.meta.regrade_judge_usd).toBe(0.25); // it was rebuilt
    expect(after.judge_usd).toBe(live.judge_usd);
    expect(after.meta.billing).toEqual(live.meta.billing);
    expect(after.meta.judge_unpriced).toBe(1);
  }, 240_000);

  // A rebuild with no judge call keeps the entries (and so `regrade_file`, which names them) of the regrade that judged
  // them, but none of that regrade's spend: beside a fresh `regraded_at` it would read as this rebuild's own.
  it("a later rebuild with no judge call drops the previous regrade's spend and model, keeps the file it is graded from", async () => {
    const { rows, evals } = buildFlow({ extra: [...SECOND, "  - transcript_contains: All done"] });
    edit(evals, "rubric: ['second']", "rubric: ['second, edited']");
    let calls = 0;
    const deps = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => {
          calls++;
          return {
            structured: { rationale: "r", verdict: "A" },
            model: "claude-haiku-4-5",
            usage: { "claude-haiku-4-5": { inputTokens: 1, outputTokens: 1, costUSD: 0.25 } },
            subtype: "success",
          };
        },
      },
    });
    expect((await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps)).exitCode).toBe(0);
    const first = rows("v1")[0]!.meta;
    expect(first).toMatchObject({ regrade_judge_usd: 0.25, regrade_judge_model: "claude-haiku-4-5", regrade_file: expect.any(String) });
    // A deterministic edit: rebuilt with no judge call, every judged entry kept from that regrade's file.
    edit(evals, "transcript_contains: All done", "transcript_contains: Nope");
    calls = 0;
    expect((await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps)).exitCode).toBe(0);
    expect(calls).toBe(0);
    const meta = rows("v1")[0]!.meta;
    expect(meta.regraded_at).not.toBe(first.regraded_at);
    expect(meta.regrade_file).toBe(first.regrade_file);
    expect(meta).not.toHaveProperty("regrade_judge_usd");
    expect(meta).not.toHaveProperty("regrade_judge_model");
  }, 240_000);

  it("--rejudge re-judges every judged assert of every row", async () => {
    buildFlow({ extra: SECOND });
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBe(2);
  }, 240_000);

  it("--judge-model other than the one that graded re-judges, saying why", async () => {
    const { rows } = buildFlow();
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", judgeModel: "claude-opus-4-8" }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBe(1);
    expect(rows("v1")[0]!.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["judge_model"] }]);
  }, 240_000);

  // An assert that pins no judge_model is judged by the env/default chain: a changed COWORK_HARNESS_JUDGE_MODEL is a
  // changed judge. The model a regrade asked for is recorded, so a judge served under another id is not re-judged again.
  it("judge_model: a changed COWORK_HARNESS_JUDGE_MODEL re-judges an assert with no judge_model of its own, once", async () => {
    const setJudge = (m: string) => {
      if (!("COWORK_HARNESS_JUDGE_MODEL" in saved)) saved.COWORK_HARNESS_JUDGE_MODEL = process.env.COWORK_HARNESS_JUDGE_MODEL;
      process.env.COWORK_HARNESS_JUDGE_MODEL = m;
    };
    const { rows } = buildFlow({ judgeModel: null, env: { COWORK_HARNESS_JUDGE_MODEL: "claude-haiku-4-5" } });
    const { seen, deps } = counting();
    // Unchanged: the model the env names is the one that graded.
    expect((await regradeFlow(ARGS({ variant: "v1" }), deps)).exitCode).toBe(0);
    expect(seen.calls).toBe(0);
    setJudge("claude-sonnet-5");
    const out = await regradeFlow(ARGS({ variant: "v1" }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBe(1);
    expect(rows("v1")[0]!.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["judge_model"] }]);
    // The stub judge answers as claude-haiku-4-5 whatever is asked: the request is what is compared, so no re-judge.
    expect((await regradeFlow(ARGS({ variant: "v1" }), deps)).exitCode).toBe(0);
    expect(seen.calls).toBe(1);
  }, 300_000);

  // An assert that pins its own judge_model is graded by that pin unless --judge-model overrides it: a row re-judged
  // under an override goes back to the pin on the next plain regrade, as a new run would grade it.
  it("judge_model: after a --judge-model override, a plain regrade re-judges a pinned assert back to its pin, once", async () => {
    const { rows } = buildFlow();
    const { seen, deps } = counting();
    expect((await regradeFlow(ARGS({ variant: "v1", judgeModel: "claude-sonnet-5" }), deps)).exitCode).toBe(0);
    expect(seen.calls).toBe(1);
    const out = await regradeFlow(ARGS({ variant: "v1" }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBe(2);
    expect(rows("v1")[0]!.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["judge_model"] }]);
    expect((await regradeFlow(ARGS({ variant: "v1" }), deps)).exitCode).toBe(0);
    expect(seen.calls).toBe(2);
  }, 300_000);

  it.each([
    ["judge_prompt", "it was graded under another judge prompt template"],
    ["reference_changed", "the reference it was judged against is not the store's now"],
  ] as const)(
    "%s: %s — re-judged, saying why",
    async (trigger, _why) => {
      const { rows } = buildFlow();
      const file = join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json");
      const r = JSON.parse(readFileSync(file, "utf8")) as {
        assertions: Array<{ judgePromptHash?: string; pairwise?: Array<{ refDocSha256?: string }> }>;
      };
      const e = r.assertions[1]!;
      if (trigger === "judge_prompt") e.judgePromptHash = "0".repeat(16);
      else e.pairwise![0]!.refDocSha256 = "0".repeat(64);
      writeFileSync(file, JSON.stringify(r));
      const { seen, deps } = counting();
      const out = await regradeFlow(ARGS({ variant: "v1" }), deps);
      expect(out.exitCode, JSON.stringify(out)).toBe(0);
      expect(seen.calls).toBe(1);
      expect(rows("v1")[0]!.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: [trigger] }]);
    },
    240_000,
  );

  // Graders record the --effort they ran at from this release on. An entry graded before has a transport with no
  // `effort`, and one graded after has `effort: "high"`: neither is a reason to re-judge (the transport is provenance,
  // not a trigger), so a flow kept from an older release is not re-judged wholesale.
  it.each([
    ["no recorded effort (graded before it was recorded)", { isolation: "1", cliVersion: "2.1.200" }],
    ["a recorded effort", { isolation: "1", cliVersion: "2.1.288", effort: "high" }],
  ] as const)(
    "a judged entry whose transport has %s is not re-judged",
    async (_label, transport) => {
      const { rows } = buildFlow();
      const file = join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json");
      const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: Array<{ judgeTransport?: unknown }> };
      r.assertions[1]!.judgeTransport = transport;
      writeFileSync(file, JSON.stringify(r));
      const { seen, deps } = counting();
      const out = await regradeFlow(ARGS({ variant: "v1" }), deps);
      expect(out.exitCode, JSON.stringify(out)).toBe(0);
      expect(seen.calls).toBe(0);
      expect(rows("v1")[0]!.meta).not.toHaveProperty("regrade_rejudged_because");
    },
    240_000,
  );

  it("opponents_changed: a reference frozen since re-judges the rows that lack it (the row's own variant's aside)", async () => {
    const { cli, rows } = buildFlow();
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const v1 = rows("v1")[0]!;
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS(), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    // The baseline row is compared with v1's reference; the v1 row lacks only its own (neutral) one.
    expect(seen.calls).toBe(1);
    expect(rows("baseline")[0]!.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["opponents_changed"] }]);
    expect(rows("baseline")[0]!.grade).toHaveProperty("win_v1");
    expect(rows("v1")[0]!.meta).not.toHaveProperty("regrade_rejudged_because");
    void v1;
  }, 240_000);

  it("the shared-capture warning (a scoped judged assert beside another) is said once per regrade, not per row", async () => {
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' '{"words":1200}' > outputs/m.json\n${STUB}`);
    const SCOPED = [...SECOND, "      evidence_files: ['outputs/m.json']"];
    buildFlow({ extra: SCOPED, reps: 2 });
    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => (said.push(String(c)), true));
    try {
      const { deps } = counting();
      const out = await regradeFlow(ARGS({ rejudge: true }), { ...deps, stderr: (l) => said.push(l) });
      expect(out.exitCode, JSON.stringify(out)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(said.join("").match(/sharing ONE authored-file capture/g)).toHaveLength(1);
  }, 300_000);

  it("a re-judged outcome is what a later regrade keeps (read from the row's regrade file, never the run's)", async () => {
    const { cli, rows, evals } = buildFlow({ extra: ["  - transcript_contains: All done"] });
    // pass_if win, and a judge that says both are bad: the re-judged assert fails where the live one passed.
    edit(evals, "rubric: ['answers']", "rubric: ['answers']\n      pass_if: win");
    const bad = DEPS({
      regradeOptions: {
        pairwiseComplete: async () => ({
          structured: { rationale: "r", verdict: "both_bad" },
          model: "claude-haiku-4-5",
          subtype: "success",
        }),
      },
    });
    expect((await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), bad)).exitCode).toBe(0);
    const rejudged = rows("v1")[0]!;
    expect(rejudged.grade).toMatchObject({ pass: 0, a2: 0 });
    // A deterministic edit next: nothing judged changed since that re-grade, so no judge call and a2 stays 0.
    edit(evals, "transcript_contains: All done", "transcript_contains: All");
    const { seen, deps } = counting();
    expect((await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps)).exitCode).toBe(0);
    expect(seen.calls).toBe(0);
    const later = rows("v1")[0]!;
    expect(later.grade).toMatchObject({ pass: 0, a2: 0 });
    expect(later.meta.regrade_file).toBe(rejudged.meta.regrade_file);
    // A fill after it: the v1 row lacks only its own variant's (neutral) outcome — rebuilt with no judge call, its
    // judged entries still the re-grade's, never listed and never reverted to the run's.
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const fill = await regradeFlow(ARGS({ variant: "v1", fillRefs: true }), deps);
    expect(fill.variants[0]!.listed, JSON.stringify(fill)).toEqual([]);
    expect(seen.calls).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 0, a2: 0 });
  }, 300_000);

  // A fill reads what a row is graded with (its last regrade file), never the run's result.json: a comparison a default
  // regrade already judged is not "missing", and the row keeps that regrade's judge provenance (model, prompt hash), so a
  // later --judge-model or prompt change still re-judges it.
  it("default regrade → fill → --judge-model: the fill rewrites nothing, and every judged row is re-judged after", async () => {
    const { cli, flow, rows, evals } = buildFlow();
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    edit(evals, "rubric: ['answers']", "rubric: ['answers in French']");
    const { seen, deps } = counting();
    expect((await regradeFlow(ARGS({ approveHarness: true }), deps)).exitCode).toBe(0);
    // The baseline row against v1, the v1 row against the baseline.
    expect(seen.calls).toBe(2);
    const graded = {
      b: readFileSync(join(flow, "baseline", "results.jsonl"), "utf8"),
      v1: readFileSync(join(flow, "v1", "results.jsonl"), "utf8"),
    };
    for (let k = 0; k < 2; k++) {
      const fill = await regradeFlow(ARGS({ fillRefs: true }), deps);
      expect(fill.exitCode, JSON.stringify(fill)).toBe(0);
      expect(fill.variants.map((v) => v.rewritten)).toEqual([0, 0]);
      expect(seen.calls).toBe(2);
      expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(graded.b);
      expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(graded.v1);
    }
    const out = await regradeFlow(ARGS({ judgeModel: "claude-opus-4-8" }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBe(4);
    for (const v of ["baseline", "v1"])
      expect(rows(v)[0]!.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["judge_model"] }]);
  }, 300_000);

  // A fill copies every judged outcome it does not add. Over a rubric changed since the row was graded it would stamp
  // the current assertion set on an old rubric's outcome — listed before any judge call, nothing written.
  it.each([
    ["semantic_pairwise", "rubric: ['answers']", "rubric: ['answers in French']"],
    ["semantic_matches", "rubric: ['matches']", "rubric: ['matches', 'and more']"],
  ] as const)(
    "--fill-refs over a %s rubric changed since the run: listed before any judge call",
    async (kind, from, to) => {
      const { cli, flow, rows, evals } = buildFlow();
      const sc = join(evals, "alpha.yaml");
      if (kind === "semantic_matches") {
        // The fixture's judge answers only pairwise: the runs are given the entry a judged run persists for it.
        appendFileSync(sc, "  - semantic_matches:\n      rubric: ['matches']\n      judge_model: claude-haiku-4-5-20251001\n");
        for (const v of ["baseline", "v1"]) {
          const file = join(runDirOf(rows(v)[0]!), "turns", "1", "result.json");
          const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: unknown[] };
          r.assertions.push({
            assertion: parseScenarioFile(sc).assert.at(-1),
            pass: true,
            judgeModel: "claude-haiku-4-5",
            judgePromptHash: JUDGE_PROMPT_HASH,
            semanticClaims: [{ index: 0, pass: true, rationale: "ok" }],
          });
          writeFileSync(file, JSON.stringify(r));
        }
      }
      expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
      edit(evals, from, to);
      const before = {
        b: readFileSync(join(flow, "baseline", "results.jsonl"), "utf8"),
        v1: readFileSync(join(flow, "v1", "results.jsonl"), "utf8"),
      };
      const { seen, deps } = counting();
      const out = await regradeFlow(ARGS({ fillRefs: true, approveHarness: true }), deps);
      expect(out.exitCode, JSON.stringify(out)).toBe(1);
      expect(seen.calls).toBe(0);
      // The baseline row lacks v1's comparison (it would be judged); the v1 row lacks only its own (no judge call). Both
      // are listed with the same remedy, decided before any spend.
      for (const v of out.variants)
        expect(v.listed).toEqual([
          {
            prompt_id: "alpha",
            rep: 0,
            why: expect.stringMatching(/^the rubric changed since the run .*run a default `hillclimb regrade` first, then --fill-refs/),
          },
        ]);
      expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(before.b);
      expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before.v1);
    },
    240_000,
  );

  // The evidence a judged entry was graded on is recomposed from the kept run by the current harness (no judge call)
  // and compared with the document the entry records. A difference is never silent: without --rejudge the row is
  // listed and kept as it is, whatever else changed; with --rejudge it is graded on the current evidence, saying so.
  const editFinal = (row: { meta: Record<string, unknown> }) => {
    const file = join(runDirOf(row), "turns", "1", "result.json");
    const r = JSON.parse(readFileSync(file, "utf8")) as { finalMessage?: string };
    expect(r.finalMessage).toBeTruthy();
    writeFileSync(file, JSON.stringify({ ...r, finalMessage: `${r.finalMessage} (edited)` }));
  };
  const EVIDENCE = /^the evidence the judge would see changed since this grade \(assert 1\): pass --rejudge to grade the current evidence$/;

  it("evidence_changed: a kept run edited since its grade is listed by a default regrade (no judge call, untouched)", async () => {
    const { flow, rows } = buildFlow();
    editFinal(rows("v1")[0]!);
    const before = {
      b: readFileSync(join(flow, "baseline", "results.jsonl"), "utf8"),
      v1: readFileSync(join(flow, "v1", "results.jsonl"), "utf8"),
    };
    const said: string[] = [];
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS(), { ...deps, stderr: (l) => said.push(l) });
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(seen.calls).toBe(0);
    const [b, v1] = out.variants;
    expect(v1!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(EVIDENCE) }]);
    expect(v1!.evidenceChanged).toEqual([
      {
        prompt_id: "alpha",
        rep: 0,
        evidence: [
          { assert: 1, gradedDocSha: expect.stringMatching(/^[0-9a-f]{64}$/), currentDocSha: expect.stringMatching(/^[0-9a-f]{64}$/) },
        ],
      },
    ]);
    // A drift-free row is unaffected.
    expect(b!.listed).toEqual([]);
    expect(b!.evidenceChanged).toEqual([]);
    expect(said.join("\n")).toMatch(/\[v1\].*alpha rep0: the evidence the judge would see changed/);
    expect(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8")).toBe(before.b);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before.v1);
  }, 240_000);

  it("evidence_changed: an assert changed over drifted evidence is listed too (drift wins), never re-judged silently", async () => {
    const { flow, rows, evals } = buildFlow();
    editFinal(rows("v1")[0]!);
    edit(evals, "rubric: ['answers']", "rubric: ['answers in French']");
    const v1Before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(seen.calls).toBe(0);
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(EVIDENCE) }]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(v1Before);
  }, 240_000);

  it("evidence_changed: a judged entry that recorded no document cannot be compared — listed (err toward re-judging)", async () => {
    const { rows } = buildFlow();
    const file = join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json");
    const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: Array<Record<string, unknown>> };
    expect(r.assertions[1]!.judgedDoc).toBeDefined();
    delete r.assertions[1]!.judgedDoc;
    delete r.assertions[1]!.composedDoc;
    writeFileSync(file, JSON.stringify(r));
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1" }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(seen.calls).toBe(0);
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(EVIDENCE) }]);
    expect(out.variants[0]!.evidenceChanged).toEqual([{ prompt_id: "alpha", rep: 0, evidence: [{ assert: 1 }] }]);
  }, 240_000);

  // An entry an older fill wrote with its judge provenance stripped: graded comparisons, no judge model. What graded
  // them is unknown, so the row is named (err toward re-judging), never kept unseen by every trigger.
  it("evidence_changed: a pairwise entry with graded outcomes but no judge model is listed (its grader is unknown)", async () => {
    const { rows } = buildFlow();
    const file = join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json");
    const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: Array<Record<string, unknown>> };
    expect((r.assertions[1]!.pairwise as Array<{ status: string }>).some((o) => o.status === "graded")).toBe(true);
    r.assertions[1]!.composedDoc = r.assertions[1]!.judgedDoc;
    for (const k of ["judgeModel", "judgedDoc", "judgePromptHash", "judgeUsage", "judgeCostUsd", "judgeTransport", "judgeAttempts"])
      delete r.assertions[1]![k];
    writeFileSync(file, JSON.stringify(r));
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1" }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(seen.calls).toBe(0);
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(EVIDENCE) }]);
    expect(out.variants[0]!.evidenceChanged).toEqual([{ prompt_id: "alpha", rep: 0, evidence: [{ assert: 1 }] }]);
  }, 240_000);

  // --rejudge never sends a judge a document LESS redacted than the one the entry was graded on: an authored file the
  // run scrubbed a secret out of, recomposed now without that secret, would hand the judge the raw value. Listed, in
  // either mode, with no judge call — and the value itself is printed nowhere.
  it("evidence_changed: a scrub-only difference (the run's secret not scrubbed now) is listed even under --rejudge", async () => {
    const SENTINEL = "SENTINEL-scrub-value-7f3a9c";
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' 'report: ${SENTINEL} end' > outputs/report.md\n${STUB}`);
    const { flow, rows } = buildFlow({ env: { COWORK_HARNESS_SCRUB_VALUES: SENTINEL } });
    delete process.env.COWORK_HARNESS_SCRUB_VALUES;
    const live = JSON.parse(readFileSync(join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json"), "utf8")) as {
      assertions: Array<{ judgedDoc?: { sections: Array<{ kind: string; redactions?: number }> } }>;
    };
    // The graded document records how many redactions its authored section carried (the branch under test).
    expect(live.assertions[1]!.judgedDoc!.sections.find((x) => x.kind === "authored")!.redactions).toBe(1);
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const said: string[] = [];
    const { seen, deps } = counting();
    for (const rejudge of [true, false]) {
      const out = await regradeFlow(ARGS({ variant: "v1", rejudge }), { ...deps, stderr: (l) => said.push(l) });
      expect(out.exitCode, JSON.stringify(out)).toBe(1);
      expect(out.variants[0]!.listed).toEqual([
        {
          prompt_id: "alpha",
          rep: 0,
          why: expect.stringMatching(/^the current evidence is less redacted than the graded document \(assert 1: outputs\/report\.md\)/),
        },
      ]);
      expect(JSON.stringify(out)).not.toContain(SENTINEL);
    }
    expect(seen.calls).toBe(0);
    expect(said.join("\n")).not.toContain(SENTINEL);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
    expect(before).not.toContain(SENTINEL);
  }, 300_000);

  it("evidence_changed: a changed authored section with no recorded redaction count may be less redacted — listed until --allow-doc-drift", async () => {
    const SENTINEL = "SENTINEL-scrub-value-51be02";
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' 'report: ${SENTINEL} end' > outputs/report.md\n${STUB}`);
    const { rows } = buildFlow({ env: { COWORK_HARNESS_SCRUB_VALUES: SENTINEL } });
    delete process.env.COWORK_HARNESS_SCRUB_VALUES;
    // A fingerprint recorded before redactions were counted.
    const file = join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json");
    const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: Array<{ judgedDoc?: { sections: Array<Record<string, unknown>> } }> };
    for (const x of r.assertions[1]!.judgedDoc!.sections) delete x.redactions;
    writeFileSync(file, JSON.stringify(r));
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(out.variants[0]!.listed[0]!.why).toMatch(
      /^the current evidence may be less redacted than the graded document \(assert 1: outputs\/report\.md — its graded document records no redaction count\)/,
    );
    expect(seen.calls).toBe(0);
    // The operator's explicit override, after checking the scrub settings.
    const forced = await regradeFlow(ARGS({ variant: "v1", rejudge: true, allowDocDrift: true }), deps);
    expect(forced.exitCode, JSON.stringify(forced)).toBe(0);
    expect(seen.calls).toBe(1);
  }, 300_000);

  it("evidence_changed: --rejudge grades the current evidence, records both hashes, says so; the next regrade keeps it", async () => {
    const { rows, evals } = buildFlow();
    const graded = rows("v1")[0]!;
    editFinal(graded);
    const said: string[] = [];
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", rejudge: true }), { ...deps, stderr: (l) => said.push(l) });
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(seen.calls).toBe(1);
    const after = rows("v1")[0]!;
    expect(after.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["rejudge", "evidence_changed"] }]);
    const ev = after.meta.regrade_evidence as Array<{ assert: number; gradedDocSha: string; currentDocSha: string }>;
    expect(ev).toEqual([
      { assert: 1, gradedDocSha: expect.stringMatching(/^[0-9a-f]{64}$/), currentDocSha: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(ev[0]!.gradedDocSha).not.toBe(ev[0]!.currentDocSha);
    expect(out.variants[0]!.evidenceChanged).toHaveLength(1);
    expect(said.join("\n")).toMatch(
      /\[v1\] alpha rep0: the evidence the judge would see changed since its grade \(assert 1\) — re-judged on the current evidence/,
    );
    // The re-judged entry recorded the current document: a default regrade now finds nothing changed.
    const again = await regradeFlow(ARGS({ variant: "v1" }), deps);
    expect(again.exitCode, JSON.stringify(again)).toBe(0);
    expect(again.variants[0]!.listed).toEqual([]);
    expect(seen.calls).toBe(1);
    // A rubric edit next: re-judged over the evidence the row was last graded on, never refused for the run's own
    // result.json still recording the old document.
    edit(evals, "rubric: ['answers']", "rubric: ['answers in French']");
    const edited = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(edited.exitCode, JSON.stringify(edited)).toBe(0);
    expect(seen.calls).toBe(2);
    expect(rows("v1")[0]!.meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["assert_changed"] }]);
  }, 300_000);

  it("an assert the recorded workspace fixture satisfies on its own is listed before any judge call (verify-run's refusal)", async () => {
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' '{"words":1200}' > outputs/m.json\n${STUB}`);
    const { flow, rows, evals } = buildFlow();
    // The shape a run that staged a workspace_fixture persists: the fixture's files recorded on its fingerprint.
    const file = join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json");
    const r = JSON.parse(readFileSync(file, "utf8")) as { fingerprint: Record<string, unknown> };
    // Paths relative to the fixture root, which a run stages as `outputs/`.
    r.fingerprint.workspaceFixtureFileSigs = [["m.json", "0".repeat(64)]];
    writeFileSync(file, JSON.stringify(r));
    // A grader edit adds a presence assert on that file with no `authored:` — it would pass on the fixture alone.
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("assert:\n", "assert:\n  - file_exists: outputs/m.json\n"));
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(seen.calls).toBe(0);
    expect(out.variants[0]!.listed).toEqual([
      { prompt_id: "alpha", rep: 0, why: expect.stringMatching(/^refused: .*the workspace_fixture already provides/) },
    ]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
  }, 240_000);

  it("a row whose kept work dir is gone, with a filesystem assert, is listed (never re-evaluated as failing)", async () => {
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' '{"words":1200}' > outputs/m.json\n${STUB}`);
    const { flow, rows } = buildFlow({ noPairwise: true, extra: ["  - file_exists: outputs/m.json"] });
    const result = JSON.parse(readFileSync(join(runDirOf(rows("v1")[0]!), "turns", "1", "result.json"), "utf8")) as { workDir: string };
    rmSync(result.workDir, { recursive: true, force: true });
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const out = await regradeFlow(ARGS({ variant: "v1" }), DEPS());
    expect(out.exitCode).toBe(1);
    expect(out.variants[0]!.listed).toEqual([{ prompt_id: "alpha", rep: 0, why: expect.stringMatching(/^refused: .*work dir not found/) }]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
  }, 240_000);
});

// An agent that failed scores 0 whatever its asserts say. A row whose kept run cannot be re-evaluated (an unanswered
// gate leaves a PARTIAL run) is not listed for good: only its meta is brought current.
describe.runIf(POSIX)("hillclimb regrade: an agent-failed row whose run cannot be re-evaluated", () => {
  const ASKS = [
    line({ type: "system", subtype: "init", session_id: "stub", model: MODEL, tools: [], cwd: "/tmp" }),
    line({
      type: "control_request",
      request_id: "q-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_stub",
        input: { questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
      },
    }),
    "sleep 1",
    ...STUB.split("\n").slice(1),
  ].join("\n");
  it("an unanswered-gate row: never listed, its meta (assert_sig, metric_sigs) rewritten, its grade all 0, counted apart", async () => {
    f.cleanup();
    f = makeStubFixture(ASKS);
    const { rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const old = rows("v1")[0]!;
    // Precondition: the slot is scored as an agent failure, all 0.
    expect(old.meta.failure_class).toBe("errored_agent");
    expect(old.grade.pass).toBe(0);
    const sc = join(evals, "alpha.yaml");
    writeFileSync(
      sc,
      readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: Nope") +
        "metrics:\n  - { id: words, artifact: outputs/m.json, path: words, better: higher, scale: 2000 }\n",
    );
    const lines: string[] = [];
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS({ stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    // Its metric signatures are rewritten, so it was re-measured (as an agent-failed row the plain path rebuilds is).
    for (const v of out.variants) expect(v).toMatchObject({ listed: [], rewritten: 1, agentFailed: 1, reevaluated: 0, remeasured: 1 });
    const row = rows("v1")[0]!;
    expect(row.meta.assert_sig).not.toBe(old.meta.assert_sig);
    expect(Object.keys(row.meta.metric_sigs as object)).toEqual(["words"]);
    expect(row.meta).not.toHaveProperty("metrics_unavailable");
    expect(Object.entries(row.grade).filter(([k, x]) => !k.endsWith("_present") && x !== 0)).toEqual([]);
    expect(row.grade).toMatchObject({ pass: 0, a0: 0, a1: 0, words_present: 0 });
    expect(row.meta.regrade_remeasured).toBe(true);
    // The breakdown sums to rewritten: the meta-only row is its own part.
    expect(lines.join("\n")).toMatch(
      /rewritten 1: 0 re-judged, 0 rebuilt without a judge call, 1 agent-failed \(meta only\); re-measured 1 without a judge call; listed 0/,
    );
    // Again: the row is current, so nothing is rewritten — the breakdown's meta-only part is the rewritten ones, not
    // every agent-failed row (the JSON's agentFailed still counts it).
    const again: string[] = [];
    const out2 = await regradeFlow(ARGS({}), DEPS({ stderr: (l) => again.push(l) }));
    expect(out2.exitCode, JSON.stringify(out2)).toBe(0);
    for (const v of out2.variants) expect(v).toMatchObject({ rewritten: 0, agentFailed: 1 });
    expect(again.at(-1)).toMatch(
      /^hillclimb regrade: baseline rewritten 0: 0 re-judged, 0 rebuilt without a judge call, 0 agent-failed \(meta only\);/,
    );
  }, 240_000);

  it("in a fill too: an agent-failed row whose case gained an assert is never listed (it scores 0 whatever lines up)", async () => {
    f.cleanup();
    f = makeStubFixture(ASKS);
    const { evals } = buildFlow({ noPairwise: true });
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("assert:\n", "assert:\n  - transcript_contains: Nope\n"));
    const out = await regradeFlow(ARGS({ approveHarness: true, fillRefs: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of out.variants) expect(v).toMatchObject({ listed: [], agentFailed: 1 });
  }, 240_000);
});

// `meta.assert_sig`: the assertion set a row was graded under. A pass resumed after a scenario edit (approved) writes new
// rows beside old ones graded by the old asserts; `run` warns, `check` flags the mix, and a regrade brings them current.
describe.runIf(POSIX)("hillclimb rows record their assertion set (meta.assert_sig)", () => {
  const SIG = /^[0-9a-f]{16}$/;
  it("a resumed pass after an assert edit warns naming the stale rows; check flags the mix; a regrade clears both", async () => {
    const { cli, flow, rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const old = rows("v1")[0]!.meta.assert_sig;
    expect(old).toMatch(SIG);
    expect(rows("baseline")[0]!.meta.assert_sig).toBe(old);
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: Nope"));
    // Resume v1 with a second rep: the gate is approved for the edit, rep0 is kept, rep1 is graded by the new assert.
    const r = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--reps", "2", "--concurrency", "1", "--approve-harness");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(
      /warning: 2 row\(s\) were graded under another assertion set than their scenario's now \(baseline alpha rep0, v1 alpha rep0\).*run `hillclimb regrade evals --flow flow --case alpha` to re-evaluate them.*--approve-harness/,
    );
    const fresh = rows("v1").find((x) => x.rep === 1)!.meta.assert_sig;
    expect(fresh).toMatch(SIG);
    expect(fresh).not.toBe(old);
    const mixed = checkReport("flow", f.cwd).warnings.filter((w) => /^warning: .*assertion set/.test(w));
    expect(mixed).toEqual([
      expect.stringMatching(
        new RegExp(
          `^warning: case alpha's rows were graded under 2 assertion sets \\(${String(old)}: baseline 1, v1 1; ${String(fresh)}: v1 1\\).*run \`hillclimb regrade evals --flow flow --case alpha\`.*--approve-harness`,
        ),
      ),
      // The approval recorded the files it hashed (harness_files): the remedy names the scenarios' dir, and the rows
      // the old asserts graded are named stale too.
      expect.stringMatching(/^warning: 2 row\(s\) of case alpha \(baseline 1, v1 1\) were graded under a different assertion set/),
    ]);
    const out = await regradeFlow(ARGS(), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) for (const row of rows(v)) expect(row.meta.assert_sig).toBe(fresh);
    expect(checkReport("flow", f.cwd).warnings.filter((w) => /^warning: .*assertion set/.test(w))).toEqual([]);
    const again = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--reps", "2", "--dry-run");
    expect(again.stderr).not.toMatch(/assertion set/);
    void flow;
  }, 240_000);

  it("an assert edit that moves no outcome: a regrade still brings each row's assert_sig current (the only change)", async () => {
    const { flow, rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const old = rows("v1")[0]!;
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: All"));
    const out = await regradeFlow(ARGS({ approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    const now = rows("v1")[0]!;
    expect(now.grade).toEqual(old.grade);
    expect(now.meta.assert_sig).toMatch(SIG);
    expect(now.meta.assert_sig).not.toBe(old.meta.assert_sig);
    expect(out.variants.map((v) => v.rewritten)).toEqual([1, 1]);
    expect(checkReport("flow", f.cwd).warnings.filter((w) => /^warning: .*assertion set/.test(w))).toEqual([]);
    void flow;
  }, 240_000);

  it("a row with no assert_sig whose assert values changed is stamped when rebuilt, though no outcome moved", async () => {
    const { flow, rows, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const file = join(flow, "v1", "results.jsonl");
    const row = rows("v1")[0]!;
    delete row.meta.assert_sig;
    writeFileSync(file, JSON.stringify(row) + "\n");
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: All"));
    const out = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(rows("v1")[0]!.grade).toEqual(row.grade);
    expect(rows("v1")[0]!.meta.assert_sig).toMatch(SIG);
  }, 240_000);

  it("a row with no assert_sig (written before it existed) is never called stale", () => {
    const { cli, flow, rows, evals } = buildFlow({ noPairwise: true });
    const file = join(flow, "v1", "results.jsonl");
    const row = rows("v1")[0]!;
    delete row.meta.assert_sig;
    writeFileSync(file, JSON.stringify(row) + "\n");
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("prompt: hi\n", "prompt: hi\nexpect_denied: [blocked.example]\n"));
    const r = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--reps", "1", "--dry-run", "--approve-harness");
    // Only the baseline row, which carries the old sig, is named.
    expect(r.stderr).toMatch(
      /warning: 1 row\(s\) were graded under another assertion set than their scenario's now \(baseline alpha rep0\)/,
    );
    // The baseline row (old sig) is stale against the scenario the approval recorded; the sig-less v1 row never counts.
    expect(checkReport("flow", f.cwd).warnings.filter((w) => /^warning: .*assertion set/.test(w))).toEqual([
      expect.stringMatching(/^warning: 1 row\(s\) of case alpha \(baseline 1\) were graded under a different assertion set/),
    ]);
  }, 240_000);
});

// `hillclimb check` compares each row's `meta.assert_sig` with its case's scenario as it is now: the target passed, else
// the scenario files `_state.json` `harness_paths` records (state-template writes them). Rows ALL graded under an older
// assertion set are as stale as a mix, and only `run` used to say so. Warnings and notes never change check's exit code.
describe.runIf(POSIX)("hillclimb check compares the rows' assertion set with the scenario's current one", () => {
  const STALE =
    /^warning: 2 row\(s\) of case alpha \(baseline 1, v1 1\) were graded under a different assertion set than the scenario's current one — run `hillclimb regrade evals --flow flow --case alpha` to re-evaluate them/;
  /** A flow whose every row was graded under the assert as first written, then the scenario edited: uniform, not mixed. */
  const staleFlow = () => {
    const b = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const sc = join(b.evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: Nope"));
    return b;
  };
  /** `harness_paths` as state-template writes it. Without `keepApproval`, the approval's `harness_files` is dropped (a
   *  flow approved before that record existed), so `harness_paths` is what check reads. */
  const record = (flow: string, paths: string[], keepApproval = false) => {
    const file = join(flow, "_state.json");
    const { harness_files, ...st } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...st, ...(keepApproval ? { harness_files } : {}), harness_paths: paths }));
  };
  /** A flow approved before `harness_files` existed, with no `harness_paths`: nothing recorded. */
  const unrecord = (flow: string) => {
    const file = join(flow, "_state.json");
    const { harness_files: _gone, ...st } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify(st));
  };
  const sigLines = (ws: string[]) => ws.filter((w) => /assertion set|harness_paths|recorded scenario/.test(w));
  /** Run the `hillclimb regrade …` the (single) warning prints, exactly as printed. */
  const runPrinted = (cli: (...a: string[]) => { status: number | null; stderr: string }, ws: string[]) => {
    const cmds = ws.flatMap((w) => [...w.matchAll(/`hillclimb (regrade [^`]+)`/g)].map((m) => m[1]!));
    expect(cmds).toHaveLength(1);
    return cli(...cmds[0]!.split(" "));
  };

  it("with the target: rows all graded under an older assertion set are flagged; the exit code is unchanged", () => {
    staleFlow();
    const c = checkReport("flow", f.cwd, "evals");
    expect(sigLines(c.warnings)).toEqual([expect.stringMatching(STALE)]);
    expect(c.exitCode).toBe(0);
    // The CLI takes the target as its positional; the warning goes to stderr, the exit code stays 0.
    const r = spawnSync(process.execPath, [CLI, "hillclimb", "check", "evals", "--flow", "flow"], { cwd: f.cwd, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/warning: 2 row\(s\) of case alpha \(baseline 1, v1 1\) were graded under a different assertion set/);
    const two = spawnSync(process.execPath, [CLI, "hillclimb", "check", "evals", "evals", "--flow", "flow"], {
      cwd: f.cwd,
      encoding: "utf8",
    });
    expect(two.status).toBe(2);
  }, 240_000);

  it("without the target, from the scenario files _state.json harness_paths records", () => {
    const { flow } = staleFlow();
    record(flow, ["evals/_session.yaml", "evals/alpha.yaml"]);
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([expect.stringMatching(STALE)]);
  }, 240_000);

  it("a recorded scenario that no longer exists is named, and its case is not compared; the target still wins", () => {
    const { flow, evals } = staleFlow();
    record(flow, ["evals/_session.yaml", "evals/gone/alpha.yaml"]);
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([
      expect.stringMatching(
        new RegExp(
          String.raw`^note: the flow's recorded scenario evals/gone/alpha\.yaml \(_state\.json harness_paths\) was not found relative to the current directory \(${escapeRegExp(f.cwd)}\) — run check from the directory the flow was approved in, or pass the target \(\`hillclimb check <scenario\.yaml \| dir/> --flow flow\`\) to compare case alpha's rows with its current assertion set$`,
        ),
      ),
    ]);
    expect(sigLines(checkReport("flow", f.cwd, "evals").warnings)).toEqual([expect.stringMatching(STALE)]);
    void evals;
  }, 240_000);

  /** `harness_files` as an approval records it: per-entry hashes keyed by cwd-relative path, virtual entries too. */
  const approved = (flow: string, files: string[]) => {
    const file = join(flow, "_state.json");
    const st = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const entries = Object.fromEntries([...files, "<baseline>", "<cowork-harness-version>"].map((k) => [k, "0".repeat(64)]));
    writeFileSync(file, JSON.stringify({ ...st, harness_files: entries }));
  };

  it("without the target, from the scenario files the approval recorded (harness_files), read before harness_paths", () => {
    const { flow } = staleFlow();
    approved(flow, ["evals/_session.yaml", "evals/alpha.yaml"]);
    record(flow, ["evals/elsewhere/alpha.yaml"], true);
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([expect.stringMatching(STALE)]);
  }, 240_000);

  it("a scenario the approval recorded that is since gone is named in a note, from harness_files", () => {
    // The record buildFlow's approving pass wrote, as the runner writes it.
    const { evals } = staleFlow();
    renameSync(join(evals, "alpha.yaml"), join(evals, "alpha.yaml.moved"));
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([
      expect.stringMatching(
        new RegExp(
          String.raw`^note: the flow's recorded scenario evals/alpha\.yaml \(_state\.json harness_files\) was not found relative to the current directory \(${escapeRegExp(f.cwd)}\) — run check from the directory the flow was approved in, or pass the target`,
        ),
      ),
    ]);
  }, 240_000);

  it("end to end: an approved edit, then a plain check --flow flags the rows graded before it; the sha is unchanged", () => {
    const { cli, flow, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const state = () => JSON.parse(readFileSync(join(flow, "_state.json"), "utf8")) as Record<string, unknown>;
    // buildFlow's first pass approved: the record of what it hashed names the scenario, cwd-relative.
    expect(Object.keys(state().harness_files as object)).toContain("evals/alpha.yaml");
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: Nope"));
    const approve = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--dry-run", "--approve-harness");
    expect(approve.status, approve.stderr).toBe(0);
    const sha = state().harness_sha;
    const again = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--dry-run");
    expect(again.stderr).toMatch(/harness gate: approved/);
    const c = checkReport("flow", f.cwd);
    expect(sigLines(c.warnings)).toEqual([expect.stringMatching(STALE)]);
    expect(c.exitCode).toBe(0);
    const plain = spawnSync(process.execPath, [CLI, "hillclimb", "check", "--flow", "flow"], { cwd: f.cwd, encoding: "utf8" });
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stderr).toMatch(
      /warning: 2 row\(s\) of case alpha \(baseline 1, v1 1\) were graded under a different assertion set .*hillclimb regrade evals --flow flow --case alpha/,
    );
    // Reading the record never moves the sha.
    expect(state().harness_sha).toBe(sha);
    // The printed remedy runs as printed: exit 0, and the rows are current after it.
    expect(runPrinted(cli, c.warnings).status).toBe(0);
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([]);
  }, 240_000);

  it("a session file named after its case, recorded beside the scenario, is not taken for a second scenario", () => {
    const { cli, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    // The examples' convention: sessions/<case>.yaml. Approved, so harness_files records both alpha.yaml files.
    mkdirSync(join(f.cwd, "sessions"));
    writeFileSync(join(f.cwd, "sessions", "alpha.yaml"), readFileSync(join(evals, "_session.yaml"), "utf8"));
    const sc = join(evals, "alpha.yaml");
    writeFileSync(
      sc,
      readFileSync(sc, "utf8")
        .replace("session: ./_session.yaml", "session: ../sessions/alpha.yaml")
        .replace("transcript_contains: All done", "transcript_contains: Nope"),
    );
    const approve = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--dry-run", "--approve-harness");
    expect(approve.status, approve.stderr).toBe(0);
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([expect.stringMatching(STALE)]);
  }, 240_000);

  it("a flow approved on one file of a directory: the remedy names that file, and runs as printed", () => {
    const { cli, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    // A second scenario beside it that the flow never ran: `regrade evals` would hash it and be refused.
    writeFileSync(join(evals, "beta.yaml"), readFileSync(join(evals, "alpha.yaml"), "utf8").replace("name: alpha", "name: beta"));
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: Nope"));
    const approve = cli("run", "evals/alpha.yaml", "--flow", "flow", "--variant", "v1", "--dry-run", "--approve-harness");
    expect(approve.status, approve.stderr).toBe(0);
    const ws = sigLines(checkReport("flow", f.cwd).warnings);
    expect(ws).toEqual([expect.stringMatching(/run `hillclimb regrade evals\/alpha\.yaml --flow flow --case alpha`/)]);
    const r = runPrinted(cli, ws);
    expect(r.status, r.stderr).toBe(0);
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([]);
  }, 240_000);

  it("scenarios recorded from two directories: each case's remedy names its own file, which runs as printed", () => {
    const { cli, flow, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    // A scenario in another directory the flow lists as a measurement file (state-template's harness_paths): every
    // approval hashes it, so the recorded scenarios span two directories.
    mkdirSync(join(f.cwd, "more"));
    writeFileSync(
      join(f.cwd, "more", "beta.yaml"),
      readFileSync(join(evals, "alpha.yaml"), "utf8")
        .replace("name: alpha", "name: beta")
        .replace("./_session.yaml", "../evals/_session.yaml"),
    );
    const stFile = join(flow, "_state.json");
    writeFileSync(stFile, JSON.stringify({ ...JSON.parse(readFileSync(stFile, "utf8")), harness_paths: ["more/beta.yaml"] }));
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: Nope"));
    const approve = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--dry-run", "--approve-harness");
    expect(approve.status, approve.stderr).toBe(0);
    const ws = sigLines(checkReport("flow", f.cwd).warnings);
    expect(ws).toEqual([expect.stringMatching(/run `hillclimb regrade evals\/alpha\.yaml --flow flow --case alpha`/)]);
    expect(runPrinted(cli, ws).status).toBe(0);
  }, 240_000);

  it("a scenario listed in harness_paths with its own session: the remedy never names a target that would hash that session", () => {
    const { cli, flow, evals } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    // beta, beside alpha, listed by hand as a measurement file, with a session file of its own. The approval on
    // evals/alpha.yaml hashes beta's bytes (listed) but never its session: `regrade evals` would add sessions/b.yaml.
    mkdirSync(join(f.cwd, "sessions"));
    writeFileSync(join(f.cwd, "sessions", "b.yaml"), readFileSync(join(evals, "_session.yaml"), "utf8"));
    writeFileSync(
      join(evals, "beta.yaml"),
      readFileSync(join(evals, "alpha.yaml"), "utf8").replace("name: alpha", "name: beta").replace("./_session.yaml", "../sessions/b.yaml"),
    );
    const stFile = join(flow, "_state.json");
    writeFileSync(stFile, JSON.stringify({ ...JSON.parse(readFileSync(stFile, "utf8")), harness_paths: ["evals/beta.yaml"] }));
    const sc = join(evals, "alpha.yaml");
    writeFileSync(sc, readFileSync(sc, "utf8").replace("transcript_contains: All done", "transcript_contains: Nope"));
    const approve = cli("run", "evals/alpha.yaml", "--flow", "flow", "--variant", "v1", "--dry-run", "--approve-harness");
    expect(approve.status, approve.stderr).toBe(0);
    const ws = sigLines(checkReport("flow", f.cwd).warnings);
    expect(ws).toEqual([expect.stringMatching(/run `hillclimb regrade evals\/alpha\.yaml --flow flow --case alpha`/)]);
    const r = runPrinted(cli, ws);
    expect(r.status, r.stderr).toBe(0);
    expect(sigLines(checkReport("flow", f.cwd).warnings)).toEqual([]);
  }, 240_000);

  it("with a target that holds no scenario for a flow case, a note names the case it did not compare", () => {
    const { evals } = staleFlow();
    mkdirSync(join(f.cwd, "ev"));
    writeFileSync(
      join(f.cwd, "ev", "beta.yaml"),
      readFileSync(join(evals, "alpha.yaml"), "utf8").replace("./_session.yaml", "../evals/_session.yaml"),
    );
    expect(sigLines(checkReport("flow", f.cwd, "ev").warnings)).toEqual([
      "note: the target ev has no scenario for case alpha, so its rows were not compared with a current assertion set — pass the target that holds it: `hillclimb check <scenario.yaml | dir/> --flow flow`",
    ]);
  }, 240_000);

  it("nothing recorded: a note says to pass the target; the mixed-set warning still fires", () => {
    const { cli, flow } = staleFlow();
    unrecord(flow);
    const c = checkReport("flow", f.cwd);
    expect(sigLines(c.warnings)).toEqual([
      "note: _state.json records no scenario files (harness_files, harness_paths), so the rows' assertion sets were not compared with the scenarios' current ones — pass the target: `hillclimb check <scenario.yaml | dir/> --flow flow`",
    ]);
    expect(c.exitCode).toBe(0);
    // A resumed rep under the new assert: the case's rows now mix two sets. Flagged with or without the target; with it,
    // the old rows are also named stale and the remedy names the target.
    expect(cli("run", "evals", "--flow", "flow", "--variant", "v1", "--reps", "2", "--concurrency", "1", "--approve-harness").status).toBe(
      0,
    );
    unrecord(flow); // the run's --approve-harness recorded harness_files again
    const plain = checkReport("flow", f.cwd).warnings.filter((w) => /^warning: .*assertion set/.test(w));
    expect(plain).toEqual([
      expect.stringMatching(
        /^warning: case alpha's rows were graded under 2 assertion sets .*hillclimb regrade <scenarios> --flow flow --case alpha/,
      ),
    ]);
    const withTarget = checkReport("flow", f.cwd, "evals").warnings.filter((w) => /^warning: .*assertion set/.test(w));
    expect(withTarget).toEqual([
      expect.stringMatching(
        /^warning: case alpha's rows were graded under 2 assertion sets .*hillclimb regrade evals --flow flow --case alpha/,
      ),
      expect.stringMatching(STALE),
    ]);
    void flow;
  }, 240_000);
});

describe("hillclimb regrade's refusal on the CLI", () => {
  it("text mode prints a refusal once (the flow's own stderr line), json mode prints the envelope", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hc-regrade-once-")));
    try {
      const run = (...a: string[]) =>
        spawnSync(process.execPath, [CLI, "hillclimb", "regrade", "evals", "--flow", "nope", ...a], {
          cwd: dir,
          encoding: "utf8",
          timeout: 60_000,
        });
      const text = run();
      expect(text.status).toBe(2);
      expect(text.stderr.split("\n").filter((l) => l.includes("refusing to regrade: no flow dir at nope"))).toHaveLength(1);
      const json = run("--output-format", "json");
      expect(json.status).toBe(2);
      expect(JSON.parse(json.stdout).error.message).toBe("refusing to regrade: no flow dir at nope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `regrade --case` follows `run --case`: the per-case checks cover the selected cases, the gate covers every case.
describe.runIf(POSIX)("hillclimb regrade --case: per-case checks cover the selected cases only", () => {
  /** Point beta at its own session file (outside the scenario dir) and break it one way. */
  const breakBeta = (evals: string, how: { session?: string; extraAssert?: string }) => {
    const plugin = join(work, "plugin", "my-plugin");
    const sessions = join(f.cwd, "sessions");
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "_beta_session.yaml");
    writeFileSync(file, (how.session ?? `model: ${MODEL}\nplugins:\n  local_plugins:\n    - PLUGIN\n`).replace("PLUGIN", plugin));
    const beta = readFileSync(join(evals, "beta.yaml"), "utf8")
      // Relative, as alpha's: the CLI's cwd is the real path, and an absolute path through a symlinked tmpdir would
      // hash under a different relative name in-process.
      .replace(/^session: .*$/m, "session: ../sessions/_beta_session.yaml")
      .replace(/(assert:\n[\s\S]*?)$/, `$1${how.extraAssert ?? ""}`);
    writeFileSync(join(evals, "beta.yaml"), beta);
  };
  const BREAKS = [
    [
      "an alias judge pin",
      { extraAssert: "  - semantic_matches:\n      rubric: ['c1']\n      judge_model: sonnet\n" },
      /CONCRETE judge model .*beta.*"sonnet"/,
    ],
    [
      "a missing upload",
      { session: `model: ${MODEL}\nuploads:\n  - ./no-such-upload.txt\nplugins:\n  local_plugins:\n    - PLUGIN\n` },
      /harness digest: cannot read sessions\/no-such-upload\.txt/,
    ],
    ["an unparseable session", { session: "model: [unclosed\n  - {\n" }, /case beta: session file is not valid YAML/],
  ] as const;

  it("a broken unselected case does not block regrade --case alpha; the full regrade still refuses it", async () => {
    const { evals } = buildFlow({ withBeta: true });
    for (const [what, how, refusal] of BREAKS) {
      writeFileSync(
        join(evals, "beta.yaml"),
        readFileSync(join(evals, "alpha.yaml"), "utf8")
          .replace(/^name: alpha$/m, "name: beta")
          .replace(/  - semantic_pairwise:[\s\S]*$/, ""),
      );
      breakBeta(evals, how);
      const err: string[] = [];
      const full = await regradeFlow(ARGS({ variant: "v1", approveHarness: true }), DEPS({ stderr: (l) => err.push(l) }));
      expect(full.exitCode, what).toBe(2);
      expect(full.error?.message, what).toMatch(refusal);
      const sub = await regradeFlow(
        ARGS({ variant: "v1", cases: ["alpha"], approveHarness: true }),
        DEPS({ stderr: (l) => err.push(l), regradeOptions: { pairwiseComplete: verdict("A") } }),
      );
      expect(sub.error?.message, what).toBeUndefined();
      expect(sub.exitCode, what).toBe(0);
      if (what === "an unparseable session") expect(err.join("\n")).toMatch(/note: case beta: .*not selected.*one-plugin/);
    }
  }, 300_000);

  it("run --case and regrade --case compute the same harness sha (an unselected case's upload missing)", async () => {
    const { cli, evals } = buildFlow({ withBeta: true });
    breakBeta(evals, BREAKS[1][1]);
    // run approves; regrade, with no --approve-harness, must find the gate approved.
    const run = cli("run", "evals", "--flow", "flow", "--case", "alpha", "--dry-run", "--approve-harness");
    expect(run.status, run.stderr).toBe(0);
    const out = await regradeFlow(ARGS({ variant: "v1", cases: ["alpha"] }), DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }));
    expect(out.error?.message).toBeUndefined();
    expect(out.exitCode).toBe(0);
    // And the other way: regrade approves a changed harness; run's dry run reports it approved.
    breakBeta(evals, BREAKS[2][1]);
    const approved = await regradeFlow(
      ARGS({ variant: "v1", cases: ["alpha"], approveHarness: true }),
      DEPS({ regradeOptions: { pairwiseComplete: verdict("A") } }),
    );
    expect(approved.exitCode).toBe(0);
    const dry = cli("run", "evals", "--flow", "flow", "--case", "alpha", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stderr).toMatch(/harness gate: approved \(sha256 /);
  }, 300_000);
});

describe.runIf(POSIX)("hillclimb over a runs root that is not where its runs were written", () => {
  const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
  const regradeDirs = (root: string) => Object.keys(tree(root)).filter((k) => /\/regrade\/$/.test(k));

  it("a runs root copied beside its original: every row listed as refused (exit 1), nothing written; freeze-ref refuses (exit 1)", () => {
    const { cli, flow } = buildFlow();
    const copyRoot = join(f.root, "copied-runs");
    cpSync(f.runsDir, copyRoot, { recursive: true, verbatimSymlinks: true });
    const before = { baseline: readFileSync(join(flow, "baseline", "results.jsonl")), v1: readFileSync(join(flow, "v1", "results.jsonl")) };
    const originalTree = tree(f.runsDir);
    const r = cli("regrade", "evals", "--flow", "flow", "--run-dir", copyRoot);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/was copied from .*, which is still there/);
    // The flow's text redacts host paths outside the home dir; the remedy is there, its path redacted.
    expect(r.stderr).toMatch(/point --run-dir at the runs root it was written under \(/);
    expect(readFileSync(join(flow, "baseline", "results.jsonl"))).toEqual(before.baseline);
    expect(readFileSync(join(flow, "v1", "results.jsonl"))).toEqual(before.v1);
    for (const v of ["baseline", "v1"]) expect(files(join(flow, v)).filter((n) => /^regrade-.*\.bak\.jsonl$/.test(n))).toEqual([]);
    expect(regradeDirs(copyRoot)).toEqual([]);
    expect(tree(f.runsDir)).toEqual(originalTree);

    const fr = cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1", "--run-dir", copyRoot);
    expect(fr.status, fr.stderr).toBe(1);
    expect(fr.stdout + fr.stderr).toMatch(/was copied from/);
    expect(files(join(flow, "v1", "ref"))).toEqual([]);
  }, 120_000);

  it("a runs root moved away (the original gone): rows are re-graded from where it is, not refused", () => {
    const { cli, flow } = buildFlow();
    const movedRoot = join(f.root, "moved-runs");
    renameSync(f.runsDir, movedRoot);
    const fr = cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1", "--run-dir", movedRoot);
    expect(fr.status, fr.stderr).toBe(0);
    expect(files(join(flow, "v1", "ref")).length).toBeGreaterThan(0);
    const r = cli("regrade", "evals", "--flow", "flow", "--run-dir", movedRoot);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/copied from|refused/);
    expect(r.stderr).toMatch(/no longer there\); reading its evidence from /);
  }, 120_000);
});

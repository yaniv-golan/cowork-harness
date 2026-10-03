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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CLI, POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";
import { mergeMetrics, regradeFlow, type HillclimbRegradeArgs, type RegradeFlowDeps } from "../src/hillclimb/regrade.js";
import { regradeRuns, type RegradeOptions, type RegradeRunReport } from "../src/run/regrade.js";
import { metricSigs } from "../src/hillclimb/metric-keys.js";
import type { ScenarioMetric } from "../src/types.js";
import type { CompleteStructured } from "../src/decide/pairwise-judge.js";
import { checkReport, stateTemplateFor } from "../src/hillclimb/cli.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";

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
      : `name: alpha\n${head}  - semantic_pairwise:\n      rubric: ['answers']\n${opts.judgeModel === null ? "" : "      judge_model: claude-haiku-4-5-20251001\n"}`) +
      metrics,
  );
  if (opts.withBeta) writeFileSync(join(evals, "beta.yaml"), `name: beta\n${head}`);
  const judge = join(work, "judge.sh");
  writeFileSync(judge, JUDGE, { mode: 0o755 });
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
    const out = await regradeFlow(ARGS({ fillRefs: true }), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
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
    expect(out.error?.message).toMatch(/harness changed since last approved run/);
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

  it("--reevaluate with --fill-refs is a usage error (a fill never moves pass), nothing written", async () => {
    const { cli, flow } = buildFlow();
    const before = tree(flow);
    const r = cli("regrade", "evals", "--flow", "flow", "--reevaluate", "--fill-refs");
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--reevaluate and --fill-refs exclude each other/);
    const out = await regradeFlow(ARGS({ reevaluate: true, fillRefs: true }), DEPS());
    expect(out.exitCode).toBe(2);
    expect(out.error?.message).toMatch(/--reevaluate and --fill-refs exclude each other/);
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
    // The judged baseline row: the added metric is sigged, with its reason — and no re-measure-only marker.
    expect(Object.keys(rows("baseline")[0]!.meta.metric_sigs as object).sort()).toEqual(["gone", "other"]);
    expect(rows("baseline")[0]!.meta.metrics_unavailable).toEqual({ gone: "missing_artifact" });
    expect(rows("baseline")[0]!.meta).not.toHaveProperty("regrade_remeasured");
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
      expect(readFileSync(join(flow, v, "regrade.md"), "utf8")).toMatch(/re-measured 1/);
      // The metric columns that moved are in the moved table.
      expect(readFileSync(join(flow, v, "regrade.md"), "utf8")).toMatch(/words —→1200/);
      expect(readdirSync(join(flow, v)).some((n) => /^regrade-[0-9a-f]{16}\.bak\.jsonl$/.test(n))).toBe(true);
    }
    expect(lines.join("\n")).toMatch(
      /baseline 1 rewritten, 1 re-evaluated \(no judge call\), 1 re-measured \(no judge call\); v1 1 rewritten, 1 re-evaluated \(no judge call\), 1 re-measured \(no judge call\)/,
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
    expect(row.meta).not.toHaveProperty("regrade_remeasured");
    expect(again.variants[0]).toMatchObject({ rewritten: 1, remeasured: 0 });
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
    expect(lines.join("\n")).not.toMatch(/re-measured/);
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

  // --reevaluate: a fix in the harness's evaluator changes an unchanged assert's outcome over the same records. The
  // edited sidecar stands in for it here (the evaluator reads the transcript the kept run recorded).
  it("--reevaluate takes an unchanged assert's re-evaluated outcome (pass moves), says so per row, no judge call", async () => {
    const { rows } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const old = rows("v1")[0]!;
    expect(old.grade).toMatchObject({ pass: 1, a1: 1 });
    const sidecar = join(runDirOf(old), "turns", "1", "run.jsonl");
    writeFileSync(sidecar, readFileSync(sidecar, "utf8").replaceAll("All done.", "Something else."));
    const lines: string[] = [];
    const out = await regradeFlow(ARGS({ variant: "v1", reevaluate: true }), DEPS({ stderr: (l) => lines.push(l) }));
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(lines.filter((l) => /re-evaluated outcome taken \(--reevaluate/.test(l))).toEqual([
      expect.stringMatching(/\[v1\] alpha rep0: assertion 1 \(`transcript_contains`\) passes in the run, fails re-evaluated now/),
    ]);
    expect(lines.filter((l) => /kept its live outcome/.test(l))).toEqual([]);
    const row = rows("v1")[0]!;
    expect(row.grade).toMatchObject({ pass: 0, a0: 1, a1: 0 });
    expect(row.meta.regrade_reevaluated_because).toEqual([{ assert: 1, because: ["reevaluate"] }]);
    expect(row.meta).not.toHaveProperty("regrade_kept_live");
    // A later default regrade keeps the taken outcome: it never silently puts the run's back.
    const again = await regradeFlow(ARGS({ variant: "v1" }), DEPS());
    expect(again.exitCode, JSON.stringify(again)).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 0, a1: 0 });
    expect(rows("v1")[0]!.meta.regrade_reevaluated_because).toEqual([{ assert: 1, because: ["reevaluate"] }]);
    expect(rows("v1")[0]!.meta).not.toHaveProperty("regrade_kept_live");
  }, 240_000);

  it("--reevaluate, then --fill-refs: the fill keeps the taken outcome (pass never moves back) and adds the column", async () => {
    const { cli, rows, evals } = buildFlow();
    // The run's evaluator passed an expect_denied host the current one fails (no egress decision was recorded).
    for (const v of ["baseline", "v1"]) {
      const file = join(runDirOf(rows(v)[0]!), "turns", "1", "result.json");
      const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: unknown[] };
      r.assertions.push({ assertion: { egress_denied: "blocked.example" }, pass: true, message: "" });
      writeFileSync(file, JSON.stringify(r));
    }
    edit(evals, "assert:\n", "expect_denied: [blocked.example]\nassert:\n");
    const { seen, deps } = counting();
    const re = await regradeFlow(ARGS({ approveHarness: true, reevaluate: true }), deps);
    expect(re.exitCode, JSON.stringify(re)).toBe(0);
    for (const v of ["baseline", "v1"]) {
      expect(rows(v)[0]!.grade.pass).toBe(0);
      expect(rows(v)[0]!.meta.regrade_reevaluated_because).toEqual([{ assert: 2, because: ["reevaluate"] }]);
    }
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1").status).toBe(0);
    const fill = await regradeFlow(ARGS({ fillRefs: true }), deps);
    expect(
      fill.variants.flatMap((v) => v.listed),
      JSON.stringify(fill),
    ).toEqual([]);
    expect(seen.calls).toBeGreaterThan(0);
    expect(rows("baseline")[0]!.grade).toHaveProperty("win_v1");
    for (const v of ["baseline", "v1"]) expect(rows(v)[0]!.grade.pass, v).toBe(0);
  }, 240_000);

  // The link's host folder is what no run dir records; here the kept work dir lost the linked file after the run, which
  // is enough to make the kept-run resolution differ from the live one.
  it.each(["computer_links_resolve", "computer_links_resolve_if_present"] as const)(
    "--reevaluate lists a row whose differing `%s` resolves links (untouched, no judge call)",
    async (key) => {
      const LINK = "See computer:///sessions/s1/mnt/outputs/a.txt for it.";
      f.cleanup();
      f = makeStubFixture(`mkdir -p outputs && printf x > outputs/a.txt\n${STUB.replaceAll("All done.", LINK)}`);
      const { flow, rows } = buildFlow({ noPairwise: true, extra: [`  - ${key}: true`] });
      const old = rows("v1")[0]!;
      expect(old.grade).toMatchObject({ pass: 1, a1: 1 });
      const result = JSON.parse(readFileSync(join(runDirOf(old), "turns", "1", "result.json"), "utf8")) as { workDir: string };
      rmSync(join(result.workDir, "outputs", "a.txt"));
      const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
      const { seen, deps } = counting();
      const out = await regradeFlow(ARGS({ variant: "v1", reevaluate: true }), deps);
      expect(out.exitCode, JSON.stringify(out)).toBe(1);
      expect(seen.calls).toBe(0);
      expect(out.variants[0]!.listed).toEqual([
        {
          prompt_id: "alpha",
          rep: 0,
          why: expect.stringMatching(
            new RegExp(
              `^--reevaluate: assertion 1 \\(\`${key}\`\\) passes in the run, fails re-evaluated now, but \`${key}\` resolves links against host folders no run dir records`,
            ),
          ),
        },
      ]);
      expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
    },
    240_000,
  );

  it("--reevaluate lists a row whose differing assert finds its evidence unavailable in the kept run (untouched)", async () => {
    const { flow, rows } = buildFlow({ noPairwise: true, extra: ["  - transcript_no_host_path: true"] });
    const old = rows("v1")[0]!;
    expect(old.grade).toMatchObject({ pass: 1, a1: 1 });
    // The kept run no longer records its post-run scan: the assert cannot be shown either way.
    const file = join(runDirOf(old), "turns", "1", "result.json");
    const r = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete r.scan;
    writeFileSync(file, JSON.stringify(r));
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const { seen, deps } = counting();
    const out = await regradeFlow(ARGS({ variant: "v1", reevaluate: true }), deps);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(seen.calls).toBe(0);
    expect(out.variants[0]!.listed).toEqual([
      {
        prompt_id: "alpha",
        rep: 0,
        why: expect.stringMatching(
          /^--reevaluate: assertion 1 \(`transcript_no_host_path`\) passes in the run, fails re-evaluated now, but the kept run cannot show it \(evidence unavailable/,
        ),
      },
    ]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
  }, 240_000);

  it("--reevaluate lists a row whose differing assert reads the kept work dir (it may have changed since the run)", async () => {
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf x > outputs/a.txt\n${STUB}`);
    const { flow, rows } = buildFlow({ noPairwise: true, extra: ["  - file_exists: outputs/a.txt"] });
    const old = rows("v1")[0]!;
    expect(old.grade).toMatchObject({ pass: 1, a1: 1 });
    const result = JSON.parse(readFileSync(join(runDirOf(old), "turns", "1", "result.json"), "utf8")) as { workDir: string };
    rmSync(join(result.workDir, "outputs", "a.txt"));
    const before = readFileSync(join(flow, "v1", "results.jsonl"), "utf8");
    const out = await regradeFlow(ARGS({ variant: "v1", reevaluate: true }), DEPS());
    expect(out.exitCode).toBe(1);
    expect(out.variants[0]!.listed).toEqual([
      {
        prompt_id: "alpha",
        rep: 0,
        why: expect.stringMatching(
          /^--reevaluate: assertion 1 \(`file_exists`\) passes in the run, fails re-evaluated now, but `file_exists` reads the kept work dir as it is now/,
        ),
      },
    ]);
    expect(readFileSync(join(flow, "v1", "results.jsonl"), "utf8")).toBe(before);
    // Without --reevaluate the unchanged assert keeps its live outcome, as before.
    const plain = await regradeFlow(ARGS({ variant: "v1" }), DEPS());
    expect(plain.exitCode, JSON.stringify(plain)).toBe(0);
    expect(rows("v1")[0]!.grade).toMatchObject({ pass: 1, a1: 1 });
  }, 240_000);

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
      /^hillclimb regrade: baseline 2 rewritten, 2 re-evaluated \(no judge call\), 1 re-measured \(no judge call\)/,
    );
  }, 240_000);

  it("a row whose re-evaluation changes nothing stays byte for byte and is counted re-evaluated", async () => {
    const { flow } = buildFlow({ noPairwise: true, extra: ["  - transcript_contains: All done"] });
    const before = tree(flow);
    const out = await regradeFlow(ARGS(), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    expect(out.variants.map(({ variant, rewritten, reevaluated, listed }) => ({ variant, rewritten, reevaluated, listed }))).toEqual([
      { variant: "baseline", rewritten: 0, reevaluated: 1, listed: [] },
      { variant: "v1", rewritten: 0, reevaluated: 1, listed: [] },
    ]);
    expect(tree(flow)).toEqual(before);
  }, 240_000);

  it("expect_denied: a judged case's rows are re-judged, a fill's filled — never listed for the trailing egress_denied entries", async () => {
    // `expect_denied` needs a sandboxed tier, which the stub agent cannot run: the kept runs are given the shape a sandboxed
    // run persists — one trailing `egress_denied` entry per host after the asserts' — and the scenario declares the host.
    const { cli, rows, evals } = buildFlow();
    for (const v of ["baseline", "v1"]) {
      const file = join(runDirOf(rows(v)[0]!), "turns", "1", "result.json");
      const r = JSON.parse(readFileSync(file, "utf8")) as { assertions: unknown[] };
      r.assertions.push({ assertion: { egress_denied: "blocked.example" }, pass: false, message: "expected blocked.example to be denied" });
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
    for (const v of out.variants) expect(v).toMatchObject({ listed: [], rewritten: 1, agentFailed: 1, reevaluated: 0, remeasured: 0 });
    const row = rows("v1")[0]!;
    expect(row.meta.assert_sig).not.toBe(old.meta.assert_sig);
    expect(Object.keys(row.meta.metric_sigs as object)).toEqual(["words"]);
    expect(row.meta).not.toHaveProperty("metrics_unavailable");
    expect(Object.entries(row.grade).filter(([k, x]) => !k.endsWith("_present") && x !== 0)).toEqual([]);
    expect(row.grade).toMatchObject({ pass: 0, a0: 0, a1: 0, words_present: 0 });
    expect(lines.join("\n")).toMatch(/1 agent failure\(s\): meta updated/);
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
    const mixed = checkReport("flow", f.cwd).warnings.filter((w) => /assertion set/.test(w));
    expect(mixed).toEqual([
      expect.stringMatching(
        new RegExp(
          `^warning: case alpha's rows were graded under 2 assertion sets \\(${String(old)}: baseline 1, v1 1; ${String(fresh)}: v1 1\\).*run \`hillclimb regrade <scenarios> --flow flow --case alpha\`.*--approve-harness`,
        ),
      ),
    ]);
    const out = await regradeFlow(ARGS(), DEPS());
    expect(out.exitCode, JSON.stringify(out)).toBe(0);
    for (const v of ["baseline", "v1"]) for (const row of rows(v)) expect(row.meta.assert_sig).toBe(fresh);
    expect(checkReport("flow", f.cwd).warnings.filter((w) => /assertion set/.test(w))).toEqual([]);
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
    expect(checkReport("flow", f.cwd).warnings.filter((w) => /assertion set/.test(w))).toEqual([]);
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
    expect(checkReport("flow", f.cwd).warnings.filter((w) => /assertion set/.test(w))).toEqual([]);
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

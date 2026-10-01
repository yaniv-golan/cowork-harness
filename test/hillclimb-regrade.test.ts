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
import { regradeFlow, type HillclimbRegradeArgs, type RegradeFlowDeps } from "../src/hillclimb/regrade.js";
import { regradeRuns, type RegradeOptions } from "../src/run/regrade.js";
import type { CompleteStructured } from "../src/decide/pairwise-judge.js";
import { stateTemplateFor } from "../src/hillclimb/cli.js";

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
function buildFlow(opts: { withBeta?: boolean; reps?: number; noPairwise?: boolean } = {}) {
  const plugin = join(work, "plugin", "my-plugin");
  mkdirSync(join(plugin, "skills", "x"), { recursive: true });
  writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
  const evals = join(f.cwd, "evals");
  mkdirSync(evals);
  writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
  const head = "baseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: hi\nassert:\n  - result: success\n";
  writeFileSync(
    join(evals, "alpha.yaml"),
    opts.noPairwise
      ? `name: alpha\n${head}`
      : `name: alpha\n${head}  - semantic_pairwise:\n      rubric: ['answers']\n      judge_model: claude-haiku-4-5-20251001\n`,
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

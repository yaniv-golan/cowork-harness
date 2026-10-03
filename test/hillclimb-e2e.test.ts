// `hillclimb run` through the real CLI and the real per-scenario runner, with only the agent replaced: the stub
// `claude` (test/helpers/stub-agent.ts) first on PATH, at the protocol tier under a managed config dir (a made-up
// token; the stub goes nowhere). It streams one sub-agent dispatch and writes that child's transcript where the
// real agent does. No model call, no spend. A second test has the stub write a metrics file, so a scenario metric is
// read by the real extractor and carried to the row.
//
// Every transcript line here is SYNTHETIC (frame shapes with placeholder text); the withheld prompt parts are the
// BUILTIN-PART placeholders, guarded by test/fixture-transcript-guard.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLI, POSIX, credentialLeaks, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";
import { checkFlowDir } from "../src/hillclimb/schema-check.js";

const BUILTIN = ["BUILTIN-PART-0", "BUILTIN-PART-1", "BUILTIN-PART-2", "BUILTIN-PART-3"];
const MODEL = "claude-sonnet-5";
const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;

const STUB = [
  // the argv the agent received, NUL-separated, so the test can compare the append it was handed
  `printf '%s\\0' "$@" > "$STUB_ARGV"`,
  `D="$CLAUDE_CONFIG_DIR/projects/-stub-cwd/stub-session/subagents"`,
  `mkdir -p "$D"`,
  `${line({ agentType: "general-purpose", description: "worker", toolUseId: "toolu_worker", spawnDepth: 1 })} > "$D/agent-a1.meta.json"`,
  `${line({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: [...BUILTIN, "SYNTHETIC last part"] } })} > "$D/agent-a1.jsonl"`,
  `${line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "child finding" }] } })} >> "$D/agent-a1.jsonl"`,
  line({ type: "system", subtype: "init", session_id: "stub", model: MODEL, tools: ["Agent"], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: MODEL,
      content: [
        {
          type: "tool_use",
          id: "toolu_worker",
          name: "Agent",
          input: { description: "worker", subagent_type: "general-purpose", prompt: "go" },
        },
      ],
    },
    session_id: "stub",
  }),
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_worker", content: "done" }] },
    session_id: "stub",
  }),
  line({
    type: "assistant",
    message: { id: "msg_2", role: "assistant", model: MODEL, content: [{ type: "text", text: "All done." }] },
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

let f: StubFixture;
let work: string;
beforeEach(() => {
  f = makeStubFixture(STUB);
  work = realpathSync(mkdtempSync(join(tmpdir(), "hc-e2e-")));
});
afterEach(() => {
  f.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const filesUnder = (d: string): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? filesUnder(join(d, n)) : [join(d, n)]));

describe.runIf(POSIX)("hillclimb run through the CLI (stub agent, protocol, managed config)", () => {
  it("a baseline pass writes a scored row, a trace with the sub-agent's system turn, and a flow `check` accepts", () => {
    const plugin = join(work, "plugin", "my-plugin");
    mkdirSync(join(plugin, "skills", "x"), { recursive: true });
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
    const evals = join(f.cwd, "evals");
    mkdirSync(evals);
    writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
    writeFileSync(
      join(evals, "alpha.yaml"),
      "name: alpha\nbaseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: hi\nassert:\n  - result: success\n",
    );
    const argvFile = join(work, "argv");
    const env = { ...f.env, COWORK_MANAGED_CONFIG: "1", CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token", STUB_ARGV: argvFile };
    const cli = (...a: string[]) =>
      spawnSync(process.execPath, [CLI, "hillclimb", ...a], { cwd: f.cwd, env, encoding: "utf8", timeout: 60_000 });

    const r = cli("run", "evals", "--flow", "flow", "--approve-harness", "--concurrency", "1");
    expect(r.status, r.stderr).toBe(0);
    expect(credentialLeaks(f.envDump).filter((k) => k !== "CLAUDE_CODE_OAUTH_TOKEN")).toEqual([]);

    const flow = join(f.cwd, "flow");
    const row = JSON.parse(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8").trim()) as Record<string, unknown>;
    expect(row).toMatchObject({ prompt_id: "alpha", rep: 0, model: MODEL, grade: { pass: 1 } });
    expect((row.meta as Record<string, unknown>).subagent_turns).toBe("complete");

    const turns = JSON.parse(readFileSync(join(flow, "baseline", "traces", "alpha_rep0.json"), "utf8")) as Array<{
      role: string;
      content: string;
    }>;
    // The trace opens with the append the agent was actually handed (its argv), Anthropic's base prompt withheld.
    const argv = readFileSync(argvFile, "utf8").split("\0");
    const sent = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(sent.length).toBeGreaterThan(0);
    expect(turns[0]).toMatchObject({ role: "system" });
    const marker = "[system — harness append as sent; Anthropic's built-in system prompt withheld]\n\n";
    expect(turns[0].content.startsWith(marker)).toBe(true);
    expect(turns[0].content.slice(marker.length)).toBe(sent);
    // The run dir's record is the harness append only — never Anthropic's built-in system prompt.
    // (the flow redacts host paths in meta.run_dir, so find the run under the fixture's runs root by its id)
    const runDir = join(f.runsDir, "alpha", (row.meta as { run_id: string }).run_id);
    const recorded = readFileSync(join(runDir, "system-prompt-append.txt"), "utf8");
    expect(recorded).toBe(sent);
    // built from parts: this file must not carry the built-in prompt's text itself (the transcript guard scans it)
    const builtinMarkers = [
      ["You are an agent for", "Claude Code"],
      ["Anthropic's official", "CLI"],
      ["You are", "Claude Code"],
    ].map((p) => p.join(" "));
    for (const s of builtinMarkers) expect(recorded.includes(s), `system-prompt-append.txt contains ${s}`).toBe(false);
    const sys = turns
      .filter((t) => t.role === "system")
      .map((t) => t.content)
      .slice(1);
    expect(sys).toHaveLength(1);
    // The child's snapshot was read through the kept run. The protocol tier sends no sub-agent append, so the state
    // is "none received"; the "as received" branch is covered with SYNTHETIC lines in hillclimb-subagent-system.
    expect(sys[0]).toBe("[sub-agent general-purpose#1 system — harness append: none received]");
    expect(turns.some((t) => t.content === "[sub-agent general-purpose#1] child finding")).toBe(true);

    // No withheld part reached any byte of the flow.
    for (const p of filesUnder(flow)) for (const b of BUILTIN) expect(readFileSync(p, "utf8").includes(b), `${p} holds ${b}`).toBe(false);

    expect(checkFlowDir(flow, { profile: "harness" }).errors).toBe(0);
    expect(cli("check", "--flow", "flow").status).toBe(0);
  }, 90_000);

  it("a scenario metric runs from the file the agent wrote to the row: value, _present, the unavailable reason, the sigs", () => {
    // The stub writes a SYNTHETIC metrics file in its cwd (the run's work root), before its frames.
    const mf = makeStubFixture(`mkdir -p outputs && printf '%s' '{"totals":{"score":0.73,"cost":12.5}}' > outputs/m.json\n${STUB}`);
    try {
      const plugin = join(work, "plugin", "my-plugin");
      mkdirSync(join(plugin, "skills", "x"), { recursive: true });
      writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
      const evals = join(mf.cwd, "evals");
      mkdirSync(evals);
      writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
      writeFileSync(
        join(evals, "alpha.yaml"),
        [
          "name: alpha",
          "baseline: latest",
          "session: ./_session.yaml",
          "fidelity: protocol",
          "prompt: hi",
          "assert:",
          "  - result: success",
          "metrics:",
          "  - { id: score, artifact: outputs/m.json, path: totals.score, better: higher, scale: 1 }",
          "  - { id: cost, artifact: outputs/m.json, path: totals.cost, better: lower, unbounded: true }",
          "  - { id: missing, artifact: outputs/none.json, path: x, better: higher, scale: 1 }",
          "",
        ].join("\n"),
      );
      const env = {
        ...mf.env,
        COWORK_MANAGED_CONFIG: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token",
        STUB_ARGV: join(work, "argv"),
      };
      const cli = (...a: string[]) =>
        spawnSync(process.execPath, [CLI, "hillclimb", ...a], { cwd: mf.cwd, env, encoding: "utf8", timeout: 60_000 });

      const r = cli("run", "evals", "--flow", "flow", "--approve-harness", "--concurrency", "1");
      expect(r.status, r.stderr).toBe(0);
      const flow = join(mf.cwd, "flow");
      const row = JSON.parse(readFileSync(join(flow, "baseline", "results.jsonl"), "utf8").trim()) as {
        grade: Record<string, number>;
        meta: Record<string, unknown>;
      };
      // Read by core's extractor from the file the stub wrote: the numbers are the file's, not a fixture constant.
      expect(row.grade).toMatchObject({ score_present: 1, score: 0.73, cost_present: 1, cost: 12.5, missing_present: 0 });
      expect(row.grade).not.toHaveProperty("missing");
      expect(row.meta.metrics_unavailable).toEqual({ missing: "missing_artifact" });
      expect(Object.keys(row.meta.metric_sigs as object)).toEqual(["score", "cost", "missing"]);

      // The state-template's declarations merged in: check accepts the flow, with no row predating a metric.
      const t = cli("state-template", "evals", "--flow", "flow");
      expect(t.status, t.stderr).toBe(0);
      const st = JSON.parse(readFileSync(join(flow, "_state.json"), "utf8"));
      writeFileSync(join(flow, "_state.json"), JSON.stringify({ ...st, ...JSON.parse(t.stdout) }));
      const report = checkFlowDir(flow, { profile: "harness" });
      expect(report.errors, JSON.stringify(report.findings)).toBe(0);
      expect(report.findings.filter((x) => /do not carry metric/.test(x.message))).toEqual([]);
      expect(cli("check", "--flow", "flow").status).toBe(0);
    } finally {
      mf.cleanup();
    }
  }, 90_000);
});

// semantic_pairwise through the real CLI: a baseline pass is neutral and freezes its reference after the pool; a v1
// pass is judged against it by a FAKE host `claude` judge replaying a real captured envelope; freeze-ref then freezes
// v1's own; `check` is clean over rows the runner really wrote; `state-template --flow` declares what every row carries.
describe.runIf(POSIX)("hillclimb + semantic_pairwise through the CLI", () => {
  const ENVELOPE = join(import.meta.dirname, "fixtures", "pairwise-judge", "claude-p-json-schema-envelope.json");
  const JUDGE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  for f in "--safe-mode" "--strict-mcp-config" "--no-session-persistence" "--setting-sources <s>" "--tools <tools...>"; do echo "  $f   x"; done
  exit 0
fi
echo x >> "$JUDGE_CALLS"
cat >/dev/null
cat "${ENVELOPE}"
`;

  it("baseline freezes after the pool, v1 is judged, freeze-ref, check and state-template agree", () => {
    const plugin = join(work, "plugin", "my-plugin");
    mkdirSync(join(plugin, "skills", "x"), { recursive: true });
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
    const evals = join(f.cwd, "evals");
    mkdirSync(evals);
    writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
    writeFileSync(
      join(evals, "alpha.yaml"),
      "name: alpha\nbaseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: hi\nassert:\n  - result: success\n" +
        "  - semantic_pairwise:\n      rubric: ['answers']\n      judge_model: claude-haiku-4-5-20251001\n",
    );
    const judge = join(work, "judge.sh");
    writeFileSync(judge, JUDGE, { mode: 0o755 });
    const calls = join(work, "judge-calls");
    const env = {
      ...f.env,
      COWORK_MANAGED_CONFIG: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token",
      STUB_ARGV: join(work, "argv"),
      COWORK_HARNESS_CLAUDE_BIN: judge,
      JUDGE_CALLS: calls,
    };
    const cli = (...a: string[]) =>
      spawnSync(process.execPath, [CLI, "hillclimb", ...a], { cwd: f.cwd, env, encoding: "utf8", timeout: 60_000 });
    const flow = join(f.cwd, "flow");
    const rowsOf = (v: string) =>
      readFileSync(join(flow, v, "results.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { grade: Record<string, number>; meta: Record<string, unknown> });

    // v1 before any baseline reference: refused before spending, naming the repair.
    const early = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--approve-harness", "--concurrency", "1");
    expect(early.status).toBe(2);
    expect(early.stderr).toContain("hillclimb freeze-ref evals --flow flow --variant baseline --case alpha");

    const base = cli("run", "evals", "--flow", "flow", "--approve-harness", "--concurrency", "1");
    expect(base.status, base.stderr).toBe(0);
    expect(base.stderr).toMatch(/alpha: froze the baseline reference from rep 0/);
    expect(rowsOf("baseline")[0]!.grade).toMatchObject({ pass: 1, win_present: 1, win: 0.5, both_bad: 0 });
    expect(readdirSync(join(flow, "baseline", "ref", "alpha")).length).toBeGreaterThan(0);

    const v1 = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--concurrency", "1");
    expect(v1.status, v1.stderr).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
    const r1 = rowsOf("v1")[0]!;
    expect(r1.grade.win_present).toBe(1);
    expect([0, 0.5, 1]).toContain(r1.grade.win);
    expect(Object.keys(r1.meta.pairwise_ref_sha256 as object)).toHaveLength(1);

    const fr = cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v1", "--output-format", "json");
    expect(fr.status, fr.stderr).toBe(0);
    expect(JSON.parse(fr.stdout)).toMatchObject({ ok: true, frozen: [{ case: "alpha", rep: 0 }], refused: [] });
    expect(cli("freeze-ref", "evals", "--flow", "flow", "--variant", "v9").status).toBe(2);
    expect(cli("freeze-ref", "--help").status).toBe(0);

    expect(checkFlowDir(flow, { profile: "harness" }).errors).toBe(0);
    expect(cli("check", "--flow", "flow").status).toBe(0);

    // win_v1 exists for later variants only: the baseline's and v1's rows predate it, so it is not declared yet.
    const st = cli("state-template", "evals", "--flow", "flow", "--output-format", "json");
    expect(st.status, st.stderr).toBe(0);
    const t = JSON.parse(st.stdout) as { state: { metrics: Array<{ id: string }> }; notes: string[] };
    expect(t.state.metrics.map((m) => m.id)).toEqual(expect.arrayContaining(["win", "win_present", "both_bad"]));
    expect(t.state.metrics.map((m) => m.id)).not.toContain("win_v1");
    expect(t.notes.join("\n")).toMatch(/win_v1 is not declared: 2 scored row.*hillclimb regrade --fill-refs/);

    // --fill-refs judges only what each row lacks: the baseline row against v1 (one call); v1's own row is neutral
    // (no call). pass cannot move; every row then carries win_v1, so state-template declares it.
    const runIdOf = (v: string) => rowsOf(v)[0]!.meta.run_id as string;
    const resultOf = (v: string) => {
      const turns = join(f.runsDir, "alpha", runIdOf(v), "turns");
      return readFileSync(join(turns, readdirSync(turns).sort().pop()!, "result.json"), "utf8");
    };
    const liveResults = { baseline: resultOf("baseline"), v1: resultOf("v1") };
    const passBefore = { baseline: rowsOf("baseline")[0]!.grade.pass, v1: rowsOf("v1")[0]!.grade.pass };
    const callsBefore = readFileSync(calls, "utf8").trim().split("\n").length;
    const fill = cli("regrade", "evals", "--flow", "flow", "--fill-refs", "--output-format", "json");
    expect(fill.status, fill.stderr).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n").length - callsBefore).toBe(1);
    expect(JSON.parse(fill.stdout)).toMatchObject({
      ok: true,
      variants: [
        { variant: "baseline", rewritten: 1 },
        { variant: "v1", rewritten: 1 },
      ],
    });
    expect(rowsOf("baseline")[0]!.grade).toMatchObject({ pass: passBefore.baseline, win_v1_present: 1 });
    expect(rowsOf("v1")[0]!.grade).toMatchObject({ pass: passBefore.v1, win_v1_present: 1, win_v1: 0.5 });
    expect(readdirSync(join(flow, "baseline")).some((n) => /^regrade-[0-9a-f]{16}\.bak\.jsonl$/.test(n))).toBe(true);
    expect(readFileSync(join(flow, "baseline", "regrade.md"), "utf8")).toMatch(/win_v1/);
    expect({ baseline: resultOf("baseline"), v1: resultOf("v1") }).toEqual(liveResults);
    const st2 = JSON.parse(cli("state-template", "evals", "--flow", "flow", "--output-format", "json").stdout) as {
      state: { metrics: Array<{ id: string }> };
    };
    expect(st2.state.metrics.map((m) => m.id)).toContain("win_v1");
    expect(checkFlowDir(flow, { profile: "harness" }).errors).toBe(0);

    // A full re-grade judges again (baseline neutral vs itself, v1 vs baseline; both vs v1 where not their own).
    const full = cli("regrade", "evals", "--flow", "flow", "--variant", "v1", "--rejudge");
    expect(full.status, full.stderr).toBe(0);
    expect(rowsOf("v1")[0]!.meta.regrade_doc_matches_live).toBe(true);
    expect(resultOf("v1")).toBe(liveResults.v1);
    expect(checkFlowDir(flow, { profile: "harness" }).errors).toBe(0);
  }, 180_000);
});

describe.runIf(POSIX)("hillclimb regrade refusals and listings (CLI)", () => {
  const ENVELOPE = join(import.meta.dirname, "fixtures", "pairwise-judge", "claude-p-json-schema-envelope.json");
  const JUDGE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  for f in "--safe-mode" "--strict-mcp-config" "--no-session-persistence" "--setting-sources <s>" "--tools <tools...>"; do echo "  $f   x"; done
  exit 0
fi
echo x >> "$JUDGE_CALLS"
cat >/dev/null
cat "${ENVELOPE}"
`;
  function setup() {
    const plugin = join(work, "plugin", "my-plugin");
    mkdirSync(join(plugin, "skills", "x"), { recursive: true });
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n");
    const evals = join(f.cwd, "evals");
    mkdirSync(evals);
    writeFileSync(join(evals, "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
    writeFileSync(
      join(evals, "alpha.yaml"),
      "name: alpha\nbaseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: hi\nassert:\n  - result: success\n" +
        "  - semantic_pairwise:\n      rubric: ['answers']\n      judge_model: claude-haiku-4-5-20251001\n",
    );
    const judge = join(work, "judge.sh");
    writeFileSync(judge, JUDGE, { mode: 0o755 });
    const calls = join(work, "judge-calls");
    writeFileSync(calls, "");
    const env = {
      ...f.env,
      COWORK_MANAGED_CONFIG: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token",
      STUB_ARGV: join(work, "argv"),
      COWORK_HARNESS_CLAUDE_BIN: judge,
      JUDGE_CALLS: calls,
    };
    const cli = (...a: string[]) =>
      spawnSync(process.execPath, [CLI, "hillclimb", ...a], { cwd: f.cwd, env, encoding: "utf8", timeout: 60_000 });
    expect(cli("run", "evals", "--flow", "flow", "--approve-harness", "--concurrency", "1").status).toBe(0);
    expect(cli("run", "evals", "--flow", "flow", "--variant", "v1", "--concurrency", "1").status).toBe(0);
    const flow = join(f.cwd, "flow");
    const results = (v: string) => readFileSync(join(flow, v, "results.jsonl"), "utf8");
    const runDir = (v: string) => join(f.runsDir, "alpha", (JSON.parse(results(v).trim()) as { meta: { run_id: string } }).meta.run_id);
    return { cli, flow, results, runDir, calls, evals };
  }

  it("refuses a bad variant, a held lock and an unapproved harness change before any judge call", () => {
    const { cli, flow, calls, evals } = setup();
    expect(cli("regrade", "evals", "--flow", "flow", "--variant", "v0").status).toBe(2);
    writeFileSync(join(flow, "v1", ".lock"), JSON.stringify({ pid: process.pid }));
    expect(cli("regrade", "evals", "--flow", "flow").status).toBe(2);
    rmSync(join(flow, "v1", ".lock"));
    writeFileSync(
      join(evals, "alpha.yaml"),
      readFileSync(join(evals, "alpha.yaml"), "utf8").replace("rubric: ['answers']", "rubric: ['answers well']"),
    );
    const r = cli("regrade", "evals", "--flow", "flow", "--output-format", "json");
    expect(r.status).toBe(2);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { message: string } };
    expect(env.ok).toBe(false);
    expect(env.error.message).toMatch(/harness changed since last approved run/);
    expect(readFileSync(calls, "utf8")).toBe("x\n"); // only v1's live comparison
  }, 120_000);

  /** Edit the judged document's final answer (the run's recorded one) after the run. */
  const editFinal = (runDir: string) => {
    const turns = join(runDir, "turns");
    const rj = join(turns, readdirSync(turns).sort().pop()!, "result.json");
    const res = JSON.parse(readFileSync(rj, "utf8")) as { finalMessage?: string };
    expect(res.finalMessage).toBeTruthy();
    writeFileSync(rj, JSON.stringify({ ...res, finalMessage: `${res.finalMessage} (edited)` }));
  };

  it("a changed kept run is listed before any spend by a default regrade; nothing is written", () => {
    const { cli, flow, results, runDir, calls } = setup();
    const before = { baseline: results("baseline"), v1: results("v1") };
    editFinal(runDir("v1"));
    const r = cli("regrade", "evals", "--flow", "flow", "--output-format", "json");
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/\[v1\] - alpha rep0: the evidence the judge would see changed since this grade \(assert 1\): pass --rejudge/);
    const env = JSON.parse(r.stdout) as {
      variants: Array<{ variant: string; evidenceChanged: Array<{ prompt_id: string; rep: number }> }>;
    };
    expect(env.variants.map((v) => [v.variant, v.evidenceChanged.map((x) => `${x.prompt_id}/${x.rep}`)])).toEqual([
      ["baseline", []],
      ["v1", ["alpha/0"]],
    ]);
    expect({ baseline: results("baseline"), v1: results("v1") }).toEqual(before);
    expect(readdirSync(join(flow, "v1")).some((n) => n.endsWith(".bak.jsonl"))).toBe(false);
    expect(readFileSync(calls, "utf8")).toBe("x\n");
  }, 120_000);

  it("a changed kept run under --rejudge is graded on the current evidence, saying so, with both hashes recorded", () => {
    const { cli, results, runDir, calls } = setup();
    editFinal(runDir("v1"));
    const r = cli("regrade", "evals", "--flow", "flow", "--rejudge");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(
      /\[v1\] alpha rep0: the evidence the judge would see changed since its grade \(assert 1\) — re-judged on the current evidence \(--rejudge/,
    );
    expect(r.stderr).toMatch(/grading anyway \(--rejudge\)/);
    const meta = (JSON.parse(results("v1").trim()) as { meta: Record<string, unknown> }).meta;
    expect(meta.regrade_rejudged_because).toEqual([{ assert: 1, because: ["rejudge", "evidence_changed"] }]);
    expect(meta.regrade_evidence).toEqual([
      { assert: 1, gradedDocSha: expect.stringMatching(/^[0-9a-f]{64}$/), currentDocSha: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    // v1 against the baseline (the baseline row is its own reference's: neutral, no call).
    expect(readFileSync(calls, "utf8")).toBe("x\nx\n");
  }, 120_000);

  it("a pruned run dir and an open judge_invalid slot are listed (exit 1); the rest is rewritten", () => {
    const { cli, flow, results, runDir } = setup();
    rmSync(runDir("baseline"), { recursive: true, force: true });
    writeFileSync(
      join(flow, "v1", "errors.jsonl"),
      JSON.stringify({
        prompt_id: "alpha",
        rep: 1,
        failure_class: "judge_invalid",
        error: "x",
        retries: 0,
        judge_retries: 1,
        latency_s: 1,
        meta: {},
      }) + "\n",
    );
    const before = results("baseline");
    // A default regrade first: the same rows listed, and the unchanged v1 row left byte for byte (nothing re-judged).
    const v1Before = results("v1");
    const d = cli("regrade", "evals", "--flow", "flow", "--output-format", "json");
    expect(d.status, d.stderr).toBe(1);
    const denv = JSON.parse(d.stdout) as {
      variants: Array<{ variant: string; rewritten: number; listed: Array<{ rep: number; why: string }> }>;
    };
    expect(denv.variants.find((v) => v.variant === "baseline")!.listed).toMatchObject([
      { rep: 0, why: expect.stringMatching(/run dir is gone/) },
    ]);
    expect(denv.variants.find((v) => v.variant === "v1")).toMatchObject({
      rewritten: 0,
      listed: [{ rep: 1, why: expect.stringMatching(/judge_invalid/) }],
    });
    expect(results("v1")).toBe(v1Before);
    expect(results("baseline")).toBe(before);
    const r = cli("regrade", "evals", "--flow", "flow", "--rejudge", "--output-format", "json");
    expect(r.status, r.stderr).toBe(1);
    const env = JSON.parse(r.stdout) as {
      variants: Array<{ variant: string; rewritten: number; listed: Array<{ rep: number; why: string }> }>;
    };
    const base = env.variants.find((v) => v.variant === "baseline")!;
    expect(base.listed).toMatchObject([{ rep: 0, why: expect.stringMatching(/run dir is gone/) }]);
    expect(results("baseline")).toBe(before);
    const v1 = env.variants.find((v) => v.variant === "v1")!;
    expect(v1.rewritten).toBe(1);
    expect(v1.listed).toMatchObject([
      {
        rep: 1,
        why: expect.stringMatching(/judge_invalid.*`hillclimb run evals --flow flow --variant v1 --case alpha --reps 2` re-runs it/),
      },
    ]);
    expect(r.stderr).toMatch(
      /\[v1\] 1 slot\(s\) hold a judge_invalid error row .*`hillclimb run evals --flow flow --variant v1 --case alpha --reps 2`/,
    );
    // The printed command really fills that slot.
    const rerun = cli("run", "evals", "--flow", "flow", "--variant", "v1", "--case", "alpha", "--reps", "2", "--concurrency", "1");
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(
      results("v1")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { rep: number }).rep),
    ).toContain(1);
  }, 180_000);
});

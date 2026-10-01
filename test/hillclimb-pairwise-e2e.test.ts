import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import type { CompleteStructured } from "../src/decide/pairwise-judge.js";
import { freezeCaseRef, freezeRefCommand, goodRefRows } from "../src/hillclimb/freeze-ref.js";
import { flowPairwiseOptions, discoverFlowRefs } from "../src/hillclimb/pairwise.js";
import { readRefDoc, readRefEntry, verifyStore } from "../src/refs/store.js";
import { pairwiseComposeKey } from "../src/run/pairwise-prepass.js";
import { POSIX, makeStubFixture, type StubFixture } from "./helpers/stub-agent.js";

// The flow loop end to end, over the REAL executeScenario with only the agent and the judge transport stubbed: a
// baseline run is neutral against its own (not yet frozen) reference and still records the document it composed; the
// freeze from its row is CHECKED against that fingerprint (never "unchecked"); a later variant is then judged against
// it. No model call, no spend.

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const ANSWER = "FLOW-CANDIDATE: the answer is 42.";
const STUB = [
  line({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: ANSWER }] },
    session_id: "stub",
  }),
  line({ type: "result", subtype: "success", is_error: false, result: ANSWER, session_id: "stub", num_turns: 1 }),
  "cat >/dev/null",
].join("\n");

let f: StubFixture;
let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
}
beforeEach(() => {
  f = makeStubFixture(STUB);
  dir = mkdtempSync(join(tmpdir(), "hc-pw-e2e-"));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("COWORK_MANAGED_CONFIG", "1");
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"])
    setEnv(k, k === "CLAUDE_CODE_OAUTH_TOKEN" ? "stub-not-a-real-token" : "");
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  f.cleanup();
});

function scenario(asserts: string[]): string {
  const file = join(dir, "evals", "alpha.yaml");
  mkdirSync(join(dir, "evals"), { recursive: true });
  writeFileSync(
    file,
    [
      "name: alpha",
      "baseline: latest",
      "session: (inline)",
      "fidelity: protocol",
      "prompt: what is the answer?",
      "assert:",
      ...asserts,
      "",
    ].join("\n"),
  );
  return file;
}
const ONE = ["  - semantic_pairwise:", "      rubric: ['gives the answer']"];
const TWO = [...ONE, "  - semantic_pairwise:", "      rubric: ['gives the answer']", "      include_subagent_text: true"];

const winJudge =
  (calls: string[]): CompleteStructured =>
  async (c) => {
    calls.push(c.user);
    const candIsA = c.user.indexOf("FLOW-CANDIDATE") < c.user.lastIndexOf("FLOW-CANDIDATE");
    return { structured: { rationale: "A is better.", verdict: candIsA ? "A" : "B" }, model: "claude-judge-x", subtype: "success" };
  };

/** A results.jsonl row the runner would have written for this run (the fields the freeze selector reads). */
const rowFor = (outDir: string, rep: number, over: Record<string, unknown> = {}) => ({
  prompt_id: "alpha",
  rep,
  status: "ok",
  grade: { pass: 1, pass_present: 1, win_present: 1, win: 0.5 },
  meta: { scenario_name: "alpha", run_id: basename(outDir), run_dir: outDir },
  ...over,
});
const results = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe.runIf(POSIX)("hillclimb pairwise: baseline → freeze → a later variant", () => {
  it("a baseline run is neutral, records composedDoc, and freezes CHECKED from its lowest-rep good row", async () => {
    const file = scenario(ONE);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const sc = parseScenarioFile(file);
    const refs = discoverFlowRefs(flow);
    const calls: string[] = [];
    const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", refs), pairwiseComplete: winJudge(calls) });
    const a = base.assertions.find((x) => x.assertion.semantic_pairwise)!;
    expect(a.pass).toBe(true);
    expect(a.pairwise).toEqual([{ ref: "baseline", status: "neutral", value: 0.5 }]);
    expect(a.composedDoc?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([]);

    // Two reps; the lowest good one is frozen, and a bad row of lower rep is skipped.
    const other = await executeScenario(sc, {
      pairwise: flowPairwiseOptions("alpha", "baseline", refs),
      pairwiseComplete: winJudge(calls),
    });
    const res = results(rowFor(base.outDir, 0, { status: "truncated" }), rowFor(other.outDir, 2), rowFor(base.outDir, 1));
    expect(goodRefRows(res, "alpha").map((r) => r.rep)).toEqual([1, 2]);
    const o = freezeCaseRef({
      flowAbs: flow,
      variant: "baseline",
      caseId: "alpha",
      scenarioFile: file,
      assertions: sc.assert,
      prompt: sc.prompt,
      results: res,
      secrets: [],
      command: "hillclimb run",
    });
    expect(o).toMatchObject({ status: "frozen", rep: 1 });
    const entry = readRefEntry(join(flow, "baseline", "ref"), "alpha");
    expect(entry).toMatchObject({ status: "ok", source: { command: "hillclimb run", variant: "baseline", rep: 1 } });
    // Checked against the live composedDoc: never marked unchecked.
    expect(readFileSync(join(flow, "baseline", "ref", "alpha", "ref.json"), "utf8")).not.toContain("unchecked");
    expect(verifyStore(join(flow, "baseline", "ref")).problems).toEqual([]);

    // A second freeze is benign.
    expect(
      freezeCaseRef({
        flowAbs: flow,
        variant: "baseline",
        caseId: "alpha",
        scenarioFile: file,
        assertions: sc.assert,
        prompt: sc.prompt,
        results: res,
        secrets: [],
        command: "hillclimb run",
      }).status,
    ).toBe("exists");

    // v1 is now judged against it: one judge call, a graded outcome on the gate.
    const v1 = await executeScenario(sc, {
      pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
      pairwiseComplete: winJudge(calls),
    });
    const g = v1.assertions.find((x) => x.assertion.semantic_pairwise)!;
    expect(g.pairwise).toMatchObject([{ ref: "baseline", status: "graded" }]);
    expect(g.pairwise![0]).not.toHaveProperty("gate");
    expect(calls).toHaveLength(1);
    expect(g.judgeAttempts).toBe(1);
  });

  it("an entry lacking a compose key gains it from the run it was frozen from; refused once that run is gone", async () => {
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const one = parseScenarioFile(scenario(ONE));
    const base = await executeScenario(one, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
    const res = results(rowFor(base.outDir, 0));
    const input = (assertions = one.assert) => ({
      flowAbs: flow,
      variant: "baseline",
      caseId: "alpha",
      scenarioFile: join(dir, "evals", "alpha.yaml"),
      assertions,
      prompt: "what is the answer?",
      results: res,
      secrets: [],
      command: "hillclimb freeze-ref" as const,
    });
    expect(freezeCaseRef(input()).status).toBe("frozen");
    // A second assert with another scope needs another compose key — from the SAME run (its scenario now has two).
    const two = parseScenarioFile(scenario(TWO));
    const added = freezeCaseRef(input(two.assert));
    expect(added, JSON.stringify(added)).toMatchObject({ status: "added", rep: 0 });
    // The run never composed the new key: it is added unchecked, visibly.
    expect(readRefDoc(join(flow, "baseline", "ref"), "alpha", pairwiseComposeKey(two.assert[1]!))).toMatchObject({
      status: "ok",
      unchecked: true,
    });
    expect(readRefDoc(join(flow, "baseline", "ref"), "alpha", pairwiseComposeKey(two.assert[0]!))).not.toHaveProperty("unchecked");
    // The run is pruned: a third scope cannot be added from it.
    rmSync(base.outDir, { recursive: true, force: true });
    const three = parseScenarioFile(
      scenario([...TWO, "  - semantic_pairwise:", "      rubric: ['x']", "      evidence_files: ['outputs/*.md']"]),
    );
    expect(freezeCaseRef(input(three.assert))).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/is gone .*fresh flow dir/),
    });
  });

  it("no good row, or a row whose run is not under the runs root, is refused naming why", () => {
    const file = scenario(ONE);
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const base = {
      flowAbs: flow,
      variant: "baseline",
      caseId: "alpha",
      scenarioFile: file,
      assertions: sc.assert,
      prompt: sc.prompt,
      secrets: [],
      command: "hillclimb run" as const,
    };
    expect(
      freezeCaseRef({
        ...base,
        results: results(rowFor("/nope/local_x", 0, { meta: { failure_class: "errored_agent", run_id: "local_x" } })),
      }),
    ).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/no good row/),
    });
    expect(freezeCaseRef({ ...base, results: results(rowFor("/nope/local_gone", 0)) })).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/not under the runs root/),
    });
  });
});

// Cross-process: two hillclimb processes (a pass's sweep and a freeze-ref, or two passes) can freeze the same case at
// once. Compose is synchronous in one process, so only separate processes exercise the store's exclusive create.
describe.runIf(POSIX)("two processes freezing one reference", () => {
  const DIST_STORE = resolve("dist/refs/store.js");
  it.runIf(existsSync(DIST_STORE))("exactly one freezes, the rest see exists, and the store verifies clean with no debris", async () => {
    const store = join(dir, "store");
    for (let round = 0; round < 5; round++) {
      const caseId = `case_${round}`;
      const script = `
        import(${JSON.stringify(DIST_STORE)}).then((m) => {
          const r = m.freezeRef(${JSON.stringify(store)}, ${JSON.stringify(caseId)},
            { command: "test", runDir: "~/r", resultSha256: "a".repeat(64) },
            { "0123456789abcdef": "DOC " + process.pid },
            { harnessVersion: "t", composerId: "c", scenario: "s", taskSha256: "b".repeat(64) });
          process.stdout.write(r.status);
        }).catch((e) => { process.stdout.write("ERR " + e.message); });`;
      const outs = await Promise.all(
        Array.from(
          { length: 4 },
          () =>
            new Promise<string>((res) => {
              const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
              let out = "";
              p.stdout.on("data", (d) => (out += d));
              p.on("close", () => res(out));
            }),
        ),
      );
      expect(
        outs.filter((o) => o === "frozen"),
        outs.join(","),
      ).toHaveLength(1);
      expect(outs.filter((o) => o === "exists")).toHaveLength(3);
    }
    expect(verifyStore(store).problems).toEqual([]);
    expect(readdirSync(store).sort()).toEqual(["case_0", "case_1", "case_2", "case_3", "case_4"]);
  });
});

describe.runIf(POSIX)("hillclimb freeze-ref", () => {
  const SECRET = "sk-test-FREEZE-77";
  const cmd = (variant: string, caseIds: string[] = []) =>
    freezeRefCommand({ target: "evals", flowArg: "flow", variant, caseIds, cwd: dir, secrets: [SECRET] });

  it("refuses a bad variant, and a variant with no rows before creating anything", () => {
    scenario(ONE);
    mkdirSync(join(dir, "flow"), { recursive: true });
    expect(() => cmd("v0")).toThrow(/--variant must be 'baseline' or 'v<N>'/);
    expect(() => cmd("v1")).toThrow(/flow\/v1 has no results\.jsonl — run the variant first/);
    expect(existsSync(join(dir, "flow", "v1"))).toBe(false);
  });

  it("freezes from the lowest-rep good row; the store carries no secret and no host path; a re-run reports exists", async () => {
    const file = scenario(ONE);
    const sc = parseScenarioFile(file);
    mkdirSync(join(dir, "flow", "v2"), { recursive: true });
    const run = await executeScenario(sc, {
      pairwise: flowPairwiseOptions("alpha", "v2", [{ name: "v2", store: join(dir, "flow", "v2", "ref") }]),
    });
    writeFileSync(join(dir, "flow", "v2", "results.jsonl"), results(rowFor(run.outDir, 0)));
    const r = cmd("v2");
    expect(r).toMatchObject({ exitCode: 0, frozen: [{ case: "alpha", rep: 0 }], refused: [] });
    for (const p of readdirSync(join(dir, "flow", "v2", "ref", "alpha"))) {
      const text = readFileSync(join(dir, "flow", "v2", "ref", "alpha", p), "utf8");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(dir);
      expect(text).not.toContain(f.runsDir);
      expect(text).not.toMatch(/\/(Users|home|var\/folders|private)\//);
    }
    expect(readRefEntry(join(dir, "flow", "v2", "ref"), "alpha")).toMatchObject({
      status: "ok",
      source: { command: "hillclimb freeze-ref", variant: "v2", rep: 0, sessionId: basename(run.outDir) },
    });
    expect(cmd("v2")).toMatchObject({ exitCode: 0, exists: ["alpha"], frozen: [] });
    // v2 now has a reference: a later pass finds it as a metric column.
    expect(discoverFlowRefs(join(dir, "flow")).map((x) => x.name)).toEqual(["baseline", "v2"]);
  });

  it("a case with no good row is refused, exit 1", () => {
    scenario(ONE);
    mkdirSync(join(dir, "flow", "baseline"), { recursive: true });
    writeFileSync(join(dir, "flow", "baseline", "results.jsonl"), results(rowFor("/nope/local_q", 0, { status: "truncated" })));
    expect(cmd("baseline", ["alpha"])).toMatchObject({
      exitCode: 1,
      refused: [{ case: "alpha", why: expect.stringMatching(/no good row/) }],
    });
  });

  it("refuses while a live run of the variant holds its lock", () => {
    scenario(ONE);
    mkdirSync(join(dir, "flow", "baseline"), { recursive: true });
    writeFileSync(join(dir, "flow", "baseline", "results.jsonl"), "");
    writeFileSync(join(dir, "flow", "baseline", ".lock"), JSON.stringify({ pid: process.pid }));
    expect(() => cmd("baseline")).toThrow(/lock|running/i);
  });
});

describe.runIf(POSIX)("freeze selection reads the run itself", () => {
  const setResultField = (outDir: string, patch: Record<string, unknown>) => {
    const p = join(outDir, "turns", "1", "result.json");
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }));
  };

  it("skips a lower rep whose run delivered nothing, and refuses when no run delivered", async () => {
    const file = scenario(ONE);
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const opts = { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) };
    const stalled = await executeScenario(sc, opts);
    const good = await executeScenario(sc, opts);
    setResultField(stalled.outDir, { outcome: "no_deliverable" });
    const input = (res: string) => ({
      flowAbs: flow,
      variant: "baseline",
      caseId: "alpha",
      scenarioFile: file,
      assertions: sc.assert,
      prompt: sc.prompt,
      results: res,
      secrets: [],
      command: "hillclimb run" as const,
    });
    expect(freezeCaseRef(input(results(rowFor(stalled.outDir, 0))))).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/rep 0: its run did not deliver an output \(no_deliverable\)/),
    });
    expect(freezeCaseRef(input(results(rowFor(stalled.outDir, 0), rowFor(good.outDir, 1))))).toMatchObject({ status: "frozen", rep: 1 });
  });

  it("an entry frozen for another prompt is refused, never reported as exists", async () => {
    const file = scenario(ONE);
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const run = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
    const base = {
      flowAbs: flow,
      variant: "baseline",
      caseId: "alpha",
      scenarioFile: file,
      assertions: sc.assert,
      results: results(rowFor(run.outDir, 0)),
      secrets: [],
      command: "hillclimb run" as const,
    };
    expect(freezeCaseRef({ ...base, prompt: sc.prompt }).status).toBe("frozen");
    expect(freezeCaseRef({ ...base, prompt: "a different question" })).toMatchObject({
      status: "refused",
      message: expect.stringMatching(/frozen for a different prompt — start a fresh flow dir/),
    });
  });
});

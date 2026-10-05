// A re-grade must never send a judge what the run scrubbed. A run records a keyed fingerprint of its scrub set
// (`RunResult.scrubSet`); a re-grade proves each part it sends — the pairwise task line, each rubric line, the
// harness's evidence notes, the frozen reference — covered, by equality with the run's own scrubbed record or by the
// run's set being a subset of this process's. A part it cannot prove is refused (core `regrade`, exit 2) or listed
// (`hillclimb regrade`, exit 1) unless `--allow-scrub-change` accepts it, recorded as `scrubAcceptedBy`.
//
// Every test runs the REAL executeScenario with the agent and the judge transports stubbed. The secrets are
// synthetic, non-hex and non-numeric placeholders.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { executeScenario, parseScenarioFile } from "../src/run/execute.js";
import type { CompleteStructured } from "../src/decide/pairwise-judge.js";
import { regradeErrorEnvelope, regradeRuns, scrubRefusal, type RegradeOptions, type RegradeRefusal } from "../src/run/regrade.js";
import type { SemanticJudge } from "../src/assert.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import { freezeCaseRef } from "../src/hillclimb/freeze-ref.js";
import { discoverFlowRefs, flowPairwiseOptions } from "../src/hillclimb/pairwise.js";
import { regradeFlow, type HillclimbRegradeArgs, type RegradeFlowDeps } from "../src/hillclimb/regrade.js";
import { latestTurn, turnArtifactPath } from "../src/run/turn-layout.js";
import { collectSecrets } from "../src/secrets.js";
import { freezeRef, readRefDoc, readRefEntry } from "../src/refs/store.js";
import { pairwiseComposeKey } from "../src/run/pairwise-prepass.js";
import { CLI, POSIX, makeStubFixture, stubSessionTranscript, type StubFixture } from "./helpers/stub-agent.js";

const TASK = "zebra-kettle-quiet-orbit";
const RUB = "maple-harbor-silent-quill";
const ANS = "walrus-lantern-copper-fjord";
const TOKEN_A = "stub-token-heron-velvet";
const TOKEN_B = "stub-token-otter-meadow";

const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const ANSWER = `REGRADE-CANDIDATE: the answer is ${ANS}.`;
const STUB = [
  line({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  line({
    type: "assistant",
    message: { id: "m1", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: ANSWER }] },
    session_id: "stub",
  }),
  line({ type: "result", subtype: "success", is_error: false, result: ANSWER, session_id: "stub", num_turns: 1 }),
  stubSessionTranscript("claude-sonnet-5"),
  "cat >/dev/null",
].join("\n");

let f: StubFixture;
let dir: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
beforeEach(() => {
  f = makeStubFixture(STUB);
  dir = realpathSync(mkdtempSync(join(tmpdir(), "regrade-scrub-")));
  setEnv("COWORK_HARNESS_FORBID_SPAWN", "0");
  setEnv("PATH", f.env.PATH!);
  setEnv("HOME", f.env.HOME!);
  setEnv("CLAUDE_CONFIG_DIR", f.env.CLAUDE_CONFIG_DIR!);
  setEnv("COWORK_HARNESS_RUNS_DIR", f.runsDir);
  setEnv("COWORK_HARNESS_MODEL", "claude-sonnet-5");
  setEnv("STUB_PID", f.stubPidFile);
  setEnv("STUB_ENV_DUMP", f.envDump);
  setEnv("COWORK_MANAGED_CONFIG", "1");
  setEnv("COWORK_HARNESS_SCRUB_VALUES", undefined);
  setEnv("COWORK_HARNESS_SCRUB_KEYS", undefined);
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

const JUDGE = "claude-haiku-4-5-20251001";

/** The scenario file, rewritten in place (a rubric edit between the run and the re-grade). */
function writeScenario(o: { prompt?: string; pairwise?: string[] | null; matches?: string[]; morePairwise?: boolean }): string {
  const file = join(dir, "evals", "alpha.yaml");
  mkdirSync(join(dir, "evals"), { recursive: true });
  const yamlList = (xs: string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;
  writeFileSync(
    file,
    [
      "name: alpha",
      "baseline: latest",
      "session: (inline)",
      "fidelity: protocol",
      `prompt: ${o.prompt ?? "what is the answer?"}`,
      "assert:",
      "  - result: success",
      ...(o.pairwise === null
        ? []
        : ["  - semantic_pairwise:", `      rubric: ${yamlList(o.pairwise ?? ["gives the answer"])}`, `      judge_model: ${JUDGE}`]),
      ...(o.morePairwise
        ? ["  - semantic_pairwise:", "      rubric: ['is concise']", "      include_subagent_text: true", `      judge_model: ${JUDGE}`]
        : []),
      ...(o.matches ? ["  - semantic_matches:", `      rubric: ${yamlList(o.matches)}`, `      judge_model: ${JUDGE}`] : []),
      "",
    ].join("\n"),
  );
  return file;
}

/** A pairwise judge that records every user message it is handed. */
const capture =
  (users: string[], rationale = "Output A states it."): CompleteStructured =>
  async (c) => {
    users.push(c.user);
    return { structured: { rationale, verdict: "tie" }, model: JUDGE, subtype: "success" };
  };

/** A semantic_matches judge that records every rubric and document it is handed. */
function matchesJudge(seen: string[], rationale = "it does") {
  const make = (o?: { model?: string }): SemanticJudge => {
    const j: SemanticJudge = async (rubric, answer) => {
      seen.push(rubric.join("\n"), answer);
      return rubric.map((claim, index) => ({ index, claim, pass: true, rationale }));
    };
    j.model = o?.model ?? JUDGE;
    j.promptHash = JUDGE_PROMPT_HASH;
    return j;
  };
  return make;
}

const rowFor = (outDir: string) => ({
  prompt_id: "alpha",
  rep: 0,
  status: "ok",
  grade: { pass: 1, pass_present: 1, win_present: 1, win: 0.5 },
  meta: { scenario_name: "alpha", run_id: outDir.split("/").pop(), run_dir: outDir },
});
const resultPath = (runDir: string) => turnArtifactPath(runDir, latestTurn(runDir)!, "result.json");
const readResult = (runDir: string) => JSON.parse(readFileSync(resultPath(runDir), "utf8")) as Record<string, unknown>;

/** Freeze a baseline reference (scrubbed with `refSecrets`), then run v1 under the current env, judged live. */
async function flowRun(o: { file: string; refSecrets?: string[]; liveUsers?: string[]; liveJudge?: CompleteStructured }) {
  const sc = parseScenarioFile(o.file);
  const flow = join(dir, "flow");
  mkdirSync(join(flow, "baseline"), { recursive: true });
  const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
  const fr = freezeCaseRef({
    flowAbs: flow,
    variant: "baseline",
    caseId: "alpha",
    scenarioFile: o.file,
    assertions: sc.assert,
    prompt: sc.prompt,
    results: JSON.stringify(rowFor(base.outDir)) + "\n",
    secrets: o.refSecrets ?? collectSecrets(),
    command: "hillclimb run",
  });
  expect(fr.status).toBe("frozen");
  const v1 = await executeScenario(sc, {
    pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
    pairwiseComplete: o.liveJudge ?? capture(o.liveUsers ?? []),
    semanticJudge: matchesJudge([])(),
  });
  return { sc, flow, base, v1 };
}

const regradeOpts = (file: string, flow: string, runDir: string, users: string[], extra: Partial<RegradeOptions> = {}): RegradeOptions => ({
  runDirs: [runDir],
  scenarioFile: file,
  secrets: collectSecrets(),
  pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
  pairwiseComplete: capture(users),
  makeJudge: matchesJudge(users),
  ...extra,
});

function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  return { text: () => buf, restore: () => void (process.stderr.write = orig) };
}

const regradeFileText = (runDir: string): string => {
  const d = join(runDir, "turns", String(latestTurn(runDir)), "regrade");
  return existsSync(d)
    ? readdirSync(d)
        .map((n) => readFileSync(join(d, n), "utf8"))
        .join("\n")
    : "";
};

describe.runIf(POSIX)("regrade scrub coverage: the run records its scrub set", () => {
  it("a run records a keyed fingerprint of its scrub set; the key sits beside the runs root at 0600, never inside it", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", `${TASK},${RUB}`);
    const file = writeScenario({ prompt: `what is the answer ${TASK}?` });
    const { v1 } = await flowRun({ file });
    const r = readResult(v1.outDir) as { scrubSet?: { v: number; keyId: string; values: string[] } };
    expect(r.scrubSet).toBeDefined();
    expect(r.scrubSet!.v).toBe(1);
    expect(r.scrubSet!.values.length).toBeGreaterThan(0);
    const text = readFileSync(resultPath(v1.outDir), "utf8");
    expect(text).not.toContain(TASK);
    const key = join(dirname(f.runsDir), "scrubset.key");
    expect(existsSync(key)).toBe(true);
    expect((await import("node:fs")).statSync(key).mode & 0o777).toBe(0o600);
    expect(existsSync(join(f.runsDir, "scrubset.key"))).toBe(false);
    expect(existsSync(join(v1.outDir, "scrubset.key"))).toBe(false);
  });

  it("the fingerprint survives the whole-result scrub when the set holds hex- and digit-shaped literals", async () => {
    // A hex-encoded fingerprint would be mangled by these; the stored form uses no digit and no a-f.
    setEnv("COWORK_HARNESS_SCRUB_VALUES", `deadbeef,31337,${RUB}`);
    const file = writeScenario({ pairwise: ["gives the answer"] });
    const { v1, flow } = await flowRun({ file });
    const r = readResult(v1.outDir) as { scrubSet?: { keyId: string; values: string[] } };
    expect(r.scrubSet).toBeDefined();
    for (const v of [r.scrubSet!.keyId, ...r.scrubSet!.values]) expect(v).toMatch(/^[ghjkmnpqrstvwxyz]+$/);
    // The same set proves coverage, so an edited rubric line is sent.
    writeScenario({ pairwise: ["gives the answer", "is polite"] });
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });
});

describe.runIf(POSIX)("regrade scrub coverage: core regrade", () => {
  it("the pairwise task line never goes raw — a smaller set refuses task_unverifiable; the run's set re-grades", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", TASK);
    const file = writeScenario({ prompt: `what is the answer ${TASK}?` });
    const { flow, v1 } = await flowRun({ file });
    setEnv("COWORK_HARNESS_SCRUB_VALUES", undefined);
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(users.join("\n")).not.toContain(TASK);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("task_unverifiable");
    expect(out.refusals?.map((r) => r.code)).toContain("task_unverifiable");
    expect(out.message).not.toContain(TASK);
    expect(out.message).toContain("--allow-scrub-change");
    // The run's own set: covered, and the task is sent scrubbed.
    setEnv("COWORK_HARNESS_SCRUB_VALUES", TASK);
    const again: string[] = [];
    const ok = await regradeRuns(regradeOpts(file, flow, v1.outDir, again));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(again.length).toBeGreaterThan(0);
    expect(again.join("\n")).not.toContain(TASK);
  });

  it("a rubric line the run scrubbed is refused rubric_unverifiable under a smaller set (pairwise and semantic_matches)", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB);
    const file = writeScenario({ pairwise: ["gives the answer", `does not mention ${RUB}`], matches: [`never says ${RUB}`] });
    const { flow, v1 } = await flowRun({ file });
    setEnv("COWORK_HARNESS_SCRUB_VALUES", undefined);
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(users.join("\n")).not.toContain(RUB);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals?.map((r) => r.code)).toContain("rubric_unverifiable");
    expect(out.message).not.toContain(RUB);
  });

  it("a semantic_matches-only scenario is not refused on a prompt edit: no task line is sent", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB);
    const file = writeScenario({ pairwise: null, matches: ["gives the answer"] });
    const sc = parseScenarioFile(file);
    const run = await executeScenario(sc, { semanticJudge: matchesJudge([])() });
    setEnv("COWORK_HARNESS_SCRUB_VALUES", undefined);
    writeScenario({ prompt: "a different question?", pairwise: null, matches: ["gives the answer"] });
    const seen: string[] = [];
    const out = await regradeRuns({ runDirs: [run.outDir], scenarioFile: file, secrets: collectSecrets(), makeJudge: matchesJudge(seen) });
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("token rotation: unchanged lines re-grade; a new line cannot be proven covered (the old token is not in this set)", async () => {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_A);
    const file = writeScenario({ prompt: `what is the answer ${TASK}?` });
    setEnv("COWORK_HARNESS_SCRUB_VALUES", TASK);
    const { flow, v1 } = await flowRun({ file });
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_B);
    const users: string[] = [];
    const same = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(same.ok, JSON.stringify(same)).toBe(true);
    writeScenario({ prompt: `what is the answer ${TASK}?`, pairwise: ["gives the answer", "is polite"] });
    const edited = await regradeRuns(regradeOpts(file, flow, v1.outDir, []));
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.refusals?.map((r) => r.code)).toContain("rubric_unverifiable");
  });

  it("a grown scrub set is a superset: an edited line is sent, nothing accepted by a flag", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", TASK);
    const file = writeScenario({ prompt: `what is the answer ${TASK}?` });
    const { flow, v1 } = await flowRun({ file });
    expect(readResult(v1.outDir).scrubSet).toBeDefined();
    setEnv("COWORK_HARNESS_SCRUB_VALUES", `${TASK},${RUB}`);
    writeScenario({ prompt: `what is the answer ${TASK}?`, pairwise: ["gives the answer", `skips ${RUB}`] });
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(out.runs[0]!.scrubAcceptedBy).toBeUndefined();
    expect(users.join("\n")).not.toContain(RUB);
    expect(users.join("\n")).not.toContain(TASK);
  });

  it("a different key (another machine, a deleted key) cannot prove coverage: an edited line is refused", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", TASK);
    const file = writeScenario({ prompt: `what is the answer ${TASK}?` });
    const { flow, v1 } = await flowRun({ file });
    rmSync(join(dirname(f.runsDir), "scrubset.key"));
    writeFileSync(join(dirname(f.runsDir), "scrubset.key"), randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    writeScenario({ prompt: `what is the answer ${TASK}?`, pairwise: ["gives the answer", "is polite"] });
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, []));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusals?.map((r) => r.code)).toContain("rubric_unverifiable");
  });

  it("legacy run (no scrubSet): unchanged lines re-grade; a new line is refused with the remedy; --allow-scrub-change accepts it, recorded", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", TASK);
    const file = writeScenario({ prompt: `what is the answer ${TASK}?` });
    const { flow, v1 } = await flowRun({ file });
    const r = readResult(v1.outDir);
    delete r.scrubSet;
    writeFileSync(resultPath(v1.outDir), JSON.stringify(r, null, 2));
    const same = await regradeRuns(regradeOpts(file, flow, v1.outDir, []));
    expect(same.ok, JSON.stringify(same)).toBe(true);
    writeScenario({ prompt: `what is the answer ${TASK}?`, pairwise: ["gives the answer", "is polite"] });
    const err = captureStderr();
    let refused;
    try {
      refused = await regradeRuns(regradeOpts(file, flow, v1.outDir, []));
    } finally {
      err.restore();
    }
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals?.map((x) => x.code)).toEqual(["rubric_unverifiable"]);
    expect(refused.message).toMatch(/re-run the case/i);
    // One summary line names the legacy cause and the remedy.
    expect(refused.message.split("\n").filter((l) => /recorded before the scrub-set fingerprint/.test(l))).toHaveLength(1);
    expect(refused.message).toContain("--allow-scrub-change");
    // --allow-doc-drift does not imply it.
    const drift = await regradeRuns(regradeOpts(file, flow, v1.outDir, [], { allowDocDrift: true, allowUnchecked: true }));
    expect(drift.ok).toBe(false);
    const users: string[] = [];
    const accepted = await regradeRuns(regradeOpts(file, flow, v1.outDir, users, { allowScrubChange: true }));
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.runs[0]!.scrubAcceptedBy).toBe("--allow-scrub-change");
    expect(JSON.parse(readFileSync(accepted.runs[0]!.regradeFile, "utf8")).scrubAcceptedBy).toBe("--allow-scrub-change");
    expect(users.join("\n")).not.toContain(TASK);
  });

  it("a missing recorded prompt cannot prove the task line: task_unverifiable", async () => {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_A);
    const file = writeScenario({});
    const { flow, v1 } = await flowRun({ file });
    const r = readResult(v1.outDir);
    delete r.prompt;
    writeFileSync(resultPath(v1.outDir), JSON.stringify(r, null, 2));
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_B); // an uncovered set: only equality can prove a part
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, []));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals?.map((x) => x.code)).toEqual(["task_unverifiable"]);
    expect(out.message).toMatch(/has no recorded prompt to compare with/);
  });

  it("a run whose key was unusable records why, warns once naming the key, and a re-grade says so instead of 'predates'", async () => {
    const keyPath = join(dirname(f.runsDir), "scrubset.key");
    writeFileSync(keyPath, "not a key\n", { mode: 0o600 });
    const file = writeScenario({});
    const err = captureStderr();
    let run;
    try {
      run = await flowRun({ file });
    } finally {
      err.restore();
    }
    const warned = err
      .text()
      .split("\n")
      .filter((l) => l.includes("no scrub-set fingerprint is recorded"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(keyPath);
    const r = readResult(run.v1.outDir);
    expect(r.scrubSet).toBeUndefined();
    expect(r.scrubSetUnavailable).toBe(`${keyPath} does not hold a 64-hex-digit key`);
    writeScenario({ pairwise: ["gives the answer", "is polite"] });
    const out = await regradeRuns(regradeOpts(file, run.flow, run.v1.outDir, []));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.refusals?.[0]).toMatchObject({
      code: "rubric_unverifiable",
      scrubSet: "unrecorded",
      scrubSetDetail: `${keyPath} does not hold a 64-hex-digit key`,
    });
    expect(out.message).toContain("this run recorded no scrub set (its key");
    expect(out.message).not.toMatch(/predates|recorded before the scrub-set fingerprint/);
  });

  it("echoes: a run-scrubbed value in a judge's rationale never lands raw in the regrade file", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", ANS);
    const file = writeScenario({ matches: ["gives the answer"] });
    const { flow, v1 } = await flowRun({ file });
    const users: string[] = [];
    const out = await regradeRuns(
      regradeOpts(file, flow, v1.outDir, users, {
        pairwiseComplete: capture(users, `Output A says ${ANS}.`),
        makeJudge: matchesJudge(users, `it says ${ANS}`),
      }),
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const written = regradeFileText(v1.outDir);
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain(ANS);
    expect(users.join("\n")).not.toContain(ANS);
  });
});

describe.runIf(POSIX)("regrade scrub coverage: the frozen reference", () => {
  it("a live run scrubs a weaker-scrubbed reference at send time, and records refRedactions", async () => {
    // The baseline is frozen with NO scrub set, so its document holds ANS raw.
    const file = writeScenario({});
    setEnv("COWORK_HARNESS_SCRUB_VALUES", undefined);
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
    expect(
      freezeCaseRef({
        flowAbs: flow,
        variant: "baseline",
        caseId: "alpha",
        scenarioFile: file,
        assertions: sc.assert,
        prompt: sc.prompt,
        results: JSON.stringify(rowFor(base.outDir)) + "\n",
        secrets: [],
        command: "hillclimb run",
      }).status,
    ).toBe("frozen");
    setEnv("COWORK_HARNESS_SCRUB_VALUES", ANS);
    const users: string[] = [];
    const v1 = await executeScenario(sc, {
      pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
      pairwiseComplete: capture(users),
    });
    expect(users.length).toBe(1);
    expect(users[0]).not.toContain(ANS);
    expect(users[0]).toContain("[REDACTED]");
    const pw = (v1.assertions ?? []).find((a) => a.pairwise !== undefined)!.pairwise!;
    const graded = pw.find((o) => o.ref === "baseline")!;
    expect(graded.status).toBe("graded");
    // The answer appears in the final message and the transcript: one marker each.
    expect(graded.refRedactions).toBe(2);
  });

  it("a reference the run sent scrubbed is refused reference_unverifiable when this set sends it otherwise; ref_scrub_weaker is noticed", async () => {
    const file = writeScenario({});
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
    freezeCaseRef({
      flowAbs: flow,
      variant: "baseline",
      caseId: "alpha",
      scenarioFile: file,
      assertions: sc.assert,
      prompt: sc.prompt,
      results: JSON.stringify(rowFor(base.outDir)) + "\n",
      secrets: [],
      command: "hillclimb run",
    });
    setEnv("COWORK_HARNESS_SCRUB_VALUES", ANS);
    const err = captureStderr();
    let v1;
    try {
      v1 = await executeScenario(sc, {
        pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
        pairwiseComplete: capture([]),
      });
    } finally {
      err.restore();
    }
    expect(err.text()).toContain("ref_scrub_weaker");
    setEnv("COWORK_HARNESS_SCRUB_VALUES", undefined);
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(users.join("\n")).not.toContain(ANS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusals?.map((r) => r.code)).toEqual(["reference_unverifiable"]);
  });

  /** The baseline frozen with no scrub set (its document holds ANS raw), then v1 run and judged against it with ANS and
   *  TOKEN_A in the set. */
  async function refFlow() {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_A);
    const file = writeScenario({});
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
    const freeze = (secrets: string[]) =>
      freezeCaseRef({
        flowAbs: flow,
        variant: "baseline",
        caseId: "alpha",
        scenarioFile: file,
        assertions: sc.assert,
        prompt: sc.prompt,
        results: JSON.stringify(rowFor(base.outDir)) + "\n",
        secrets,
        command: "hillclimb run",
      });
    expect(freeze([]).status).toBe("frozen");
    setEnv("COWORK_HARNESS_SCRUB_VALUES", ANS);
    const v1 = await executeScenario(sc, {
      pairwise: flowPairwiseOptions("alpha", "v1", discoverFlowRefs(flow)),
      pairwiseComplete: capture([]),
    });
    // Re-freeze the baseline reference by hand with different bytes, as an edited store would be.
    const refreeze = () => {
      const store = join(flow, "baseline", "ref");
      const key = pairwiseComposeKey(sc.assert[1]!);
      const doc = readRefDoc(store, "alpha", key);
      const entry = readRefEntry(store, "alpha");
      if (doc.status !== "ok" || entry.status !== "ok") throw new Error("no reference to re-freeze");
      rmSync(join(store, "alpha"), { recursive: true, force: true });
      freezeRef(
        store,
        "alpha",
        entry.source,
        { [key]: `${doc.text}\nedited by hand` },
        {
          harnessVersion: "test",
          composerId: doc.composerId,
          scenario: entry.scenario,
          taskSha256: entry.taskSha256,
        },
      );
    };
    return { file, flow, v1, refreeze };
  }
  const refCodes = (out: Awaited<ReturnType<typeof regradeRuns>>) => (out.ok ? [] : (out.refusals ?? []).map((r) => r.code));

  it("a reference the run sent scrubbed re-grades after a token rotation with nothing edited", async () => {
    const { file, flow, v1 } = await refFlow();
    const pw = v1.assertions!.find((a) => a.pairwise !== undefined)!.pairwise!;
    expect(pw[0]).toMatchObject({ status: "graded", refRedactions: 2 });
    expect(pw[0]!.refSentSha256).toMatch(/^[0-9a-f]{64}$/);
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_B);
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(users.join("\n")).not.toContain(ANS);
  });

  it("a reference re-frozen since the live grade is refused reference_unverifiable (4.4 run)", async () => {
    const { file, flow, v1, refreeze } = await refFlow();
    refreeze();
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_B);
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users));
    expect(refCodes(out)).toEqual(["reference_unverifiable"]);
    expect(users).toHaveLength(0);
  });

  it("a pre-4.4 run's reference: unchanged since its live grade re-grades; re-frozen is refused", async () => {
    const { file, flow, v1, refreeze } = await refFlow();
    // A pre-4.4 run: no fingerprint, and its outcomes record only the stored document's sha (its judge got it raw).
    const r = readResult(v1.outDir) as { scrubSet?: unknown; assertions: Array<{ pairwise?: Array<Record<string, unknown>> }> };
    delete r.scrubSet;
    for (const a of r.assertions) for (const o of a.pairwise ?? []) (delete o.refSentSha256, delete o.refRedactions);
    writeFileSync(resultPath(v1.outDir), JSON.stringify(r, null, 2));
    expect(refCodes(await regradeRuns(regradeOpts(file, flow, v1.outDir, [])))).toEqual([]);
    refreeze();
    expect(refCodes(await regradeRuns(regradeOpts(file, flow, v1.outDir, [])))).toEqual(["reference_unverifiable"]);
  });

  it("--fill-refs: a reference the run never judged is refused under an uncovered set, judged under the run's own", async () => {
    const { file, flow, v1 } = await refFlow();
    const sc = parseScenarioFile(file);
    expect(
      freezeCaseRef({
        flowAbs: flow,
        variant: "v1",
        caseId: "alpha",
        scenarioFile: file,
        assertions: sc.assert,
        prompt: sc.prompt,
        results: JSON.stringify(rowFor(v1.outDir)) + "\n",
        secrets: collectSecrets(),
        command: "hillclimb freeze-ref",
      }).status,
    ).toBe("frozen");
    const fill = { ...flowPairwiseOptions("alpha", "v2", discoverFlowRefs(flow)), onlyRefs: ["v1"] };
    const covered = await regradeRuns(regradeOpts(file, flow, v1.outDir, [], { pairwise: fill }));
    expect(covered.ok, JSON.stringify(covered)).toBe(true);
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_B);
    const users: string[] = [];
    const out = await regradeRuns(regradeOpts(file, flow, v1.outDir, users, { pairwise: fill }));
    expect(refCodes(out)).toEqual(["reference_unverifiable"]);
    if (!out.ok) expect(out.refusals?.[0]?.references).toEqual(["v1"]);
    expect(users).toHaveLength(0);
  });

  it("every prepass line naming a reference is scrubbed: ref_scrub_weaker and a metric-only invalid grade", async () => {
    const file = writeScenario({});
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
    expect(
      freezeCaseRef({
        flowAbs: flow,
        variant: "baseline",
        caseId: "alpha",
        scenarioFile: file,
        assertions: sc.assert,
        prompt: sc.prompt,
        results: JSON.stringify(rowFor(base.outDir)) + "\n",
        secrets: [],
        command: "hillclimb run",
      }).status,
    ).toBe("frozen");
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB);
    const name = `ref-${RUB}`;
    // An invalid reply that quotes a scrubbed value: its reason is stored on the outcome and warned.
    const invalid: CompleteStructured = async () => ({ structured: `not an object ${RUB}`, model: JUDGE, subtype: "success" });
    const err = captureStderr();
    let run;
    try {
      run = await executeScenario(sc, {
        // A metric-only reference (no gate) whose name holds a scrubbed value.
        pairwise: { caseId: "alpha", refs: [{ name, store: join(flow, "baseline", "ref") }], gateRefs: [] },
        pairwiseComplete: invalid,
      });
    } finally {
      err.restore();
    }
    expect(err.text()).toContain("ref_scrub_weaker");
    expect(err.text()).toContain("a metric-only reference");
    expect(err.text()).toContain("ref-[REDACTED]");
    expect(err.text()).not.toContain(RUB);
    const outcome = run.assertions!.find((a) => a.pairwise !== undefined)!.pairwise!.find((o) => o.status === "invalid")!;
    expect(outcome.why).toContain("[REDACTED]");
    expect(outcome.why).not.toContain(RUB);
  });

  it("the committed reference sidecar records a count, never key names", async () => {
    setEnv("COWORK_HARNESS_SCRUB_KEYS", "SOME_PROXY_PASSWORD");
    setEnv("SOME_PROXY_PASSWORD", RUB);
    const file = writeScenario({});
    await flowRun({ file, refSecrets: collectSecrets() });
    const entry = join(dir, "flow", "baseline", "ref", "alpha");
    const sidecars = readdirSync(entry).filter((n) => n.startsWith("doc-") && n.endsWith(".json"));
    expect(sidecars.length).toBe(1);
    const side = JSON.parse(readFileSync(join(entry, sidecars[0]!), "utf8")) as Record<string, unknown>;
    expect(typeof side.scrubCount).toBe("number");
    const all = readdirSync(entry)
      .map((n) => readFileSync(join(entry, n), "utf8"))
      .join("\n");
    expect(all).not.toContain("SOME_PROXY_PASSWORD");
    expect(all).not.toContain(RUB);
  });

  it("freeze-ref's add-lacking-key path is gated on the same proof: a smaller set refuses, the run's set adds", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", ANS);
    const file = writeScenario({});
    const sc = parseScenarioFile(file);
    const flow = join(dir, "flow");
    mkdirSync(join(flow, "baseline"), { recursive: true });
    const base = await executeScenario(sc, { pairwise: flowPairwiseOptions("alpha", "baseline", discoverFlowRefs(flow)) });
    const results = JSON.stringify(rowFor(base.outDir)) + "\n";
    const freeze = (s: ReturnType<typeof parseScenarioFile>, secrets: string[]) =>
      freezeCaseRef({
        flowAbs: flow,
        variant: "baseline",
        caseId: "alpha",
        scenarioFile: file,
        assertions: s.assert,
        prompt: s.prompt,
        results,
        secrets,
        command: "hillclimb freeze-ref",
      });
    expect(freeze(sc, collectSecrets()).status).toBe("frozen");
    // A second pairwise assert with another evidence scope needs a new compose key.
    writeScenario({ morePairwise: true });
    const sc2 = parseScenarioFile(file);
    setEnv("COWORK_HARNESS_SCRUB_VALUES", undefined);
    const smaller = freeze(sc2, collectSecrets());
    expect(smaller.status).toBe("refused");
    expect(smaller.message).toMatch(/re-run the variant/i);
    const entry = join(flow, "baseline", "ref", "alpha");
    expect(
      readdirSync(entry)
        .map((n) => readFileSync(join(entry, n), "utf8"))
        .join("\n"),
    ).not.toContain(ANS);
    setEnv("COWORK_HARNESS_SCRUB_VALUES", ANS);
    expect(freeze(sc2, collectSecrets()).status).toBe("added");
  });
});

describe.runIf(POSIX)("regrade scrub coverage: the pairwise prepass warn channel", () => {
  it("an invalid judge reply echoing a secret reaches stderr scrubbed", async () => {
    setEnv("COWORK_HARNESS_SCRUB_VALUES", ANS);
    const file = writeScenario({});
    const echo: CompleteStructured = async () => ({ structured: `I refuse: ${ANS}`, model: JUDGE, subtype: "success" });
    const err = captureStderr();
    try {
      await flowRun({ file, liveJudge: echo });
    } finally {
      err.restore();
    }
    expect(err.text()).toContain("invalid after retry");
    expect(err.text()).not.toContain(ANS);
  });
});

describe.runIf(POSIX)("regrade scrub coverage: a scrub refusal's own fields", () => {
  it("section paths and reference names in a scrub refusal never carry a scrubbed value raw: refusals[] and the envelope", () => {
    const secrets = [RUB];
    const raw: RegradeRefusal = {
      runDir: `/runs/${RUB}`,
      code: "evidence_unverifiable",
      scrubSet: "smaller",
      evidenceSections: [{ assertionIndex: 0, kind: "authored", path: `outputs/${RUB}.md` }],
      references: [`ref-${RUB}`],
    };
    const r = scrubRefusal(raw, secrets);
    expect(r.evidenceSections![0]!.path).toBe("outputs/[REDACTED].md");
    expect(r.references).toEqual(["ref-[REDACTED]"]);
    expect(JSON.stringify(r)).not.toContain(RUB);
    const env = regradeErrorEnvelope(
      { ok: false, kind: "runtime", message: "refused", code: "evidence_unverifiable", refusals: [r] },
      secrets,
    );
    expect(env).not.toContain(RUB);
  });
});

// ---- hillclimb regrade over a flow the real CLI built ----

const ENVELOPE = join(import.meta.dirname, "fixtures", "pairwise-judge", "claude-p-json-schema-envelope.json");
const JUDGE_SH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.286 (Claude Code)"; exit 0; fi
if [ "$1" = "--help" ]; then
  for f in "--safe-mode" "--strict-mcp-config" "--no-session-persistence" "--setting-sources <s>" "--tools <tools...>" "--effort <level>" "--settings <s>"; do echo "  $f   x"; done
  exit 0
fi
cat >/dev/null
cat "${ENVELOPE}"
`;

function buildHcFlow(o: { prompt: string; rubric: string[]; scrubValues: string; evidenceFiles?: string[] }) {
  const plugin = join(dir, "plugin", "my-plugin");
  mkdirSync(join(plugin, "skills", "x"), { recursive: true });
  writeFileSync(join(plugin, "skills", "x", "SKILL.md"), `---\nname: x\ndescription: d\n---\nbody\n`);
  const evals = join(f.cwd, "evals");
  mkdirSync(evals, { recursive: true });
  writeFileSync(join(evals, "_session.yaml"), `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
  const write = (rubric: string[]) =>
    writeFileSync(
      join(evals, "alpha.yaml"),
      `name: alpha\nbaseline: latest\nsession: ./_session.yaml\nfidelity: protocol\nprompt: ${o.prompt}\nassert:\n  - result: success\n` +
        `  - semantic_pairwise:\n      rubric: [${rubric.map((r) => `'${r}'`).join(", ")}]\n      judge_model: ${JUDGE}\n` +
        (o.evidenceFiles ? `      evidence_files: [${o.evidenceFiles.map((x) => `'${x}'`).join(", ")}]\n` : ""),
    );
  write(o.rubric);
  const judge = join(dir, "judge.sh");
  writeFileSync(judge, JUDGE_SH, { mode: 0o755 });
  const env = {
    ...f.env,
    COWORK_MANAGED_CONFIG: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token",
    COWORK_HARNESS_CLAUDE_BIN: judge,
    COWORK_HARNESS_SCRUB_VALUES: o.scrubValues,
  };
  for (const pass of [["--approve-harness"], ["--variant", "v1"]]) {
    const r = spawnSync(
      process.execPath,
      [CLI, "hillclimb", "run", "evals", "--flow", "flow", ...pass, "--concurrency", "1", "--reps", "1"],
      {
        cwd: f.cwd,
        env,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(r.status, r.stderr).toBe(0);
  }
  for (const [k, v] of Object.entries({
    COWORK_HARNESS_RUNS_DIR: f.runsDir,
    COWORK_HARNESS_CLAUDE_BIN: judge,
    HOME: f.env.HOME!,
    CLAUDE_CONFIG_DIR: join(f.env.HOME!, ".claude"),
    COWORK_MANAGED_CONFIG: "1",
  }))
    setEnv(k, v);
  return { write };
}

const HC_ARGS = (over: Partial<HillclimbRegradeArgs> = {}): HillclimbRegradeArgs => ({
  target: "evals",
  flow: "flow",
  variant: "all",
  cases: [],
  fillRefs: false,
  // A rubric edit is a gated scenario edit; these tests approve it.
  approveHarness: true,
  allowDocDrift: false,
  allowUnchecked: false,
  ...over,
});
const hcDeps = (users: string[], lines: string[], secrets: readonly string[]): RegradeFlowDeps => ({
  cwd: f.cwd,
  env: process.env,
  secrets,
  stderr: (l) => lines.push(l),
  isolationCheck: () => undefined,
  regradeOptions: { pairwiseComplete: capture(users) },
});

describe.runIf(POSIX)("regrade scrub coverage: hillclimb regrade", () => {
  it("under --rejudge with a smaller set the task line never goes raw — the row is listed (exit 1)", async () => {
    buildHcFlow({ prompt: `say ${TASK}`, rubric: ["answers"], scrubValues: TASK });
    const users: string[] = [];
    const lines: string[] = [];
    const out = await regradeFlow(HC_ARGS({ rejudge: true }), hcDeps(users, lines, []));
    expect(users.join("\n")).not.toContain(TASK);
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    const listed = out.variants.flatMap((v) => v.listed);
    expect(listed.some((l) => /task/.test(l.why) && /--allow-scrub-change/.test(l.why))).toBe(true);
    expect(JSON.stringify(out)).not.toContain(TASK);
  });

  it("an edited assert under an uncovered set is listed; --rejudge / --allow-doc-drift never imply --allow-scrub-change", async () => {
    const hc = buildHcFlow({ prompt: "say hello", rubric: ["answers"], scrubValues: RUB });
    hc.write(["answers", `never says ${RUB}`]);
    for (const over of [{}, { rejudge: true, allowDocDrift: true, allowUnchecked: true }]) {
      const users: string[] = [];
      const lines: string[] = [];
      const out = await regradeFlow(HC_ARGS(over), hcDeps(users, lines, []));
      expect(users.join("\n")).not.toContain(RUB);
      expect(out.exitCode, JSON.stringify(out)).toBe(1);
      expect(out.variants.flatMap((v) => v.listed).some((l) => /rubric/.test(l.why))).toBe(true);
      expect(JSON.stringify(out) + lines.join("\n")).not.toContain(RUB);
    }
  });

  it("a rubric edit unproven under another installation key lists that row with its part and reason, never a flow refusal", async () => {
    const hc = buildHcFlow({ prompt: "say hello", rubric: ["answers"], scrubValues: RUB });
    // Another machine's key: the run's fingerprint is intact but proves nothing here.
    writeFileSync(join(dirname(f.runsDir), "scrubset.key"), randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    hc.write(["answers", "is polite"]);
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB);
    const users: string[] = [];
    const lines: string[] = [];
    const out = await regradeFlow(HC_ARGS(), hcDeps(users, lines, collectSecrets()));
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(out.error).toBeUndefined();
    expect(out.variants.find((v) => v.variant === "v1")!.listed).toEqual([
      {
        prompt_id: "alpha",
        rep: 0,
        why: expect.stringMatching(
          /^rubric text the run did not record \(assert 1 line\(s\) 1\) cannot be proven scrubbed with the run's scrub set — the run's scrub-set fingerprint was made with another installation's scrubset\.key/,
        ),
      },
    ]);
    // The baseline row compares only with its own (neutral) reference: nothing reaches a judge, so nothing to prove.
    expect(out.variants.find((v) => v.variant === "baseline")!.listed).toEqual([]);
    expect(users).toHaveLength(0);
    expect(lines.join("\n")).not.toMatch(/recorded before the scrub-set fingerprint|predates the scrub-set record/);
  });

  it("hillclimb scrubs its scrub listing: a refusal naming a scrubbed value is listed redacted", async () => {
    buildHcFlow({ prompt: "say hello", rubric: ["answers"], scrubValues: RUB });
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB);
    const secrets = collectSecrets();
    // A core preflight whose refusal carries the value raw: what hillclimb lists must still be scrubbed.
    const seam = (async (opts: RegradeOptions & { checkOnly?: boolean }) => {
      if (opts.checkOnly)
        return {
          ok: false,
          kind: "runtime",
          message: "refused",
          code: "reference_unverifiable",
          refusals: opts.runDirs.map((d) => ({
            runDir: d,
            code: "reference_unverifiable",
            scrubSet: "smaller",
            references: [`ref-${RUB}`],
          })),
        };
      return regradeRuns(opts);
    }) as unknown as typeof regradeRuns;
    const out = await regradeFlow(HC_ARGS({ rejudge: true }), { ...hcDeps([], [], secrets), regrade: seam });
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    const whys = out.variants.flatMap((v) => v.listed).map((l) => l.why);
    expect(whys.some((w) => w.includes("ref-[REDACTED]"))).toBe(true);
    expect(JSON.stringify(out)).not.toContain(RUB);
  });

  /** The v1 row's kept run dir and its result.json path. */
  const v1Run = () => {
    const row = JSON.parse(
      readFileSync(join(f.cwd, "flow", "v1", "results.jsonl"), "utf8")
        .trim()
        .split("\n")[0]!,
    ) as {
      meta: { run_id: string };
    };
    const runDir = join(f.runsDir, "alpha", row.meta.run_id);
    return { runDir, result: join(runDir, "turns", "1", "result.json") };
  };
  /** Swap in a stub agent that also writes `outputs/report.md` (holding RUB) into its work dir. */
  const writingStub = () => {
    f.cleanup();
    f = makeStubFixture(`mkdir -p outputs && printf '%s' 'report: ${RUB} end' > outputs/report.md\n${STUB}`);
    for (const [k, v] of Object.entries({
      PATH: f.env.PATH!,
      HOME: f.env.HOME!,
      CLAUDE_CONFIG_DIR: f.env.CLAUDE_CONFIG_DIR!,
      COWORK_HARNESS_RUNS_DIR: f.runsDir,
    }))
      setEnv(k, v);
  };

  it("--rejudge over a changed evidence-health note under an uncovered set lists the row", async () => {
    writingStub();
    buildHcFlow({ prompt: "say hello", rubric: ["answers"], scrubValues: RUB, evidenceFiles: ["outputs/report.md"] });
    // Files outside the assert's scope added to the kept work dir since the run: they exhaust the capture budget, so
    // the scoped document gains a health note (files omitted) no recorded document had.
    const { runDir } = v1Run();
    const work = (JSON.parse(readFileSync(join(runDir, "turns", "1", "result.json"), "utf8")) as { workDir: string }).workDir;
    for (let i = 0; i < 6; i++) writeFileSync(join(work, "outputs", `zz-${i}.md`), "x".repeat(15_000));
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB);
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", TOKEN_B); // a rotated token: only equality can prove a part
    const users: string[] = [];
    const out = await regradeFlow(HC_ARGS({ rejudge: true }), hcDeps(users, [], collectSecrets()));
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    const why = out.variants.find((v) => v.variant === "v1")!.listed.map((l) => l.why);
    expect(why).toEqual([expect.stringMatching(/^evidence no run-scrubbed record vouches for \(assert 1: health/)]);
    expect(users).toHaveLength(0);
  });

  it("hillclimb's own scrubbed-literal listing holds under a covered set: --allow-doc-drift does not release it", async () => {
    const hc = buildHcFlow({ prompt: "say hello", rubric: ["answers", `never says ${RUB}`], scrubValues: RUB });
    // The scrubbed literal edited to another value: the run's record cannot tell the two apart.
    hc.write(["answers", "never says otter-meadow-slate"]);
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB); // the run's own set: core's scrub proof passes
    const users: string[] = [];
    const out = await regradeFlow(HC_ARGS({ rejudge: true, allowDocDrift: true }), hcDeps(users, [], collectSecrets()));
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(out.variants.find((v) => v.variant === "v1")!.listed.map((l) => l.why)).toEqual([
      expect.stringMatching(/is scrubbed in the run's result\.json and this process's secrets do not reproduce it/),
    ]);
    expect(users).toHaveLength(0);
  });

  it("hillclimb's own less-redacted listing holds under a covered set: --rejudge --allow-doc-drift does not release it", async () => {
    writingStub();
    buildHcFlow({ prompt: "say hello", rubric: ["answers"], scrubValues: RUB });
    const { runDir, result } = v1Run();
    // A fingerprint with no recorded marker count, and the authored file edited since: possibly less redacted.
    const r = JSON.parse(readFileSync(result, "utf8")) as {
      workDir: string;
      assertions: Array<{
        judgedDoc?: { sections: Array<Record<string, unknown>> };
        composedDoc?: { sections: Array<Record<string, unknown>> };
      }>;
    };
    for (const a of r.assertions)
      for (const x of [...(a.judgedDoc?.sections ?? []), ...(a.composedDoc?.sections ?? [])]) delete x.redactions;
    writeFileSync(result, JSON.stringify(r));
    writeFileSync(join(r.workDir, "outputs", "report.md"), `report: ${RUB} end, edited`);
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB); // the run's own set: core's scrub proof passes
    const users: string[] = [];
    const out = await regradeFlow(HC_ARGS({ rejudge: true, allowDocDrift: true }), hcDeps(users, [], collectSecrets()));
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(out.variants.find((v) => v.variant === "v1")!.listed.map((l) => l.why)).toEqual([
      expect.stringMatching(/^the current evidence may be less redacted than the graded document/),
    ]);
    expect(users).toHaveLength(0);
    expect(runDir).toBeTruthy();
  });

  it("legacy rows (no scrubSet): an edited line is listed with one summary line naming the remedy; --allow-scrub-change re-grades it", async () => {
    const hc = buildHcFlow({ prompt: "say hello", rubric: ["answers"], scrubValues: RUB });
    // Strip the fingerprint from every kept run: a pre-4.4 row.
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "result.json") {
          const r = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
          delete r.scrubSet;
          writeFileSync(p, JSON.stringify(r, null, 2));
        }
      }
    };
    walk(f.runsDir);
    hc.write(["answers", "is polite"]);
    // The run's own set: only the rubric edit is unproven.
    setEnv("COWORK_HARNESS_SCRUB_VALUES", RUB);
    const secrets = collectSecrets();
    const users: string[] = [];
    const lines: string[] = [];
    const out = await regradeFlow(HC_ARGS(), hcDeps(users, lines, secrets));
    expect(out.exitCode, JSON.stringify(out)).toBe(1);
    expect(users).toHaveLength(0);
    const summary = lines.filter((l) => /--allow-scrub-change/.test(l) && /re-run/.test(l));
    expect(summary).toHaveLength(1);
    const accepted: string[] = [];
    const ok = await regradeFlow(HC_ARGS({ allowScrubChange: true }), hcDeps(accepted, [], secrets));
    expect(ok.exitCode, JSON.stringify(ok)).toBe(0);
    expect(accepted.length).toBeGreaterThan(0);
  });
});

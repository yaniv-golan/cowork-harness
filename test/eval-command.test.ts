// The `eval` command, driven in-process with a FAKE runner — nothing here runs an agent or spends a token.
//
// The fake returns RunResults built from the real kept-run excerpts in test/fixtures/eval-classify/ (the
// same corpus the classifier is tested over). Two fields are set by the fake rather than read from the
// excerpt, and each is set the way a real run sets it:
//   - `fingerprint` comes from the SAME `buildFingerprint(...)` call `executeScenario` makes, over the job's
//     own session — so the drift test below is a real drift, not a string the test chose;
//   - `outDir` is the pre-assigned run dir, from the same derivation `executeScenario` uses (`runOutDir`).
// A per-arm behaviour may flip individual assertion bits (to create a drop to detect); every such flip is
// named in the test that does it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError, UnansweredError } from "../src/errors.js";
import type { RunResult } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { buildFingerprint } from "../src/run/cassette.js";
import { runOutDir } from "../src/run/execute.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import { runEval, parseEvalArgs, EvalStagingError, type EvalJobSpec } from "../src/eval/command.js";
import { writeEvalReport, erroredHint } from "../src/eval/report.js";
import { readRunsLines } from "../src/eval/runs.js";
import { classifyRep } from "../src/eval/classify.js";
import { repEvidenceOf } from "../src/eval/runs.js";
import { isConcreteModelId } from "../src/run/model-provenance.js";
import { tildeify } from "../src/io.js";
import { tokenCheck, type DoctorCheck, type DoctorProbe } from "../src/run/doctor.js";
import { hostPathTokens } from "../src/run/host-path-tokens.js";
import { createHash } from "node:crypto";
import { COMPOSER_ID } from "../src/assert.js";
import { composeKey, freezeRef } from "../src/refs/store.js";
import { appendIndexRow } from "../src/run/run-index.js";
import { budgetStatus, resetBudgetStatus } from "../src/run/budget-status.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
// report.md's row table: row | assertion / claim | A | B | B − A [95% CI] | p | adj. p | label | note.
const TABLE_COLUMNS = 9;
const fixture = (name: string): RunResult => JSON.parse(readFileSync(join(FX, `${name}.json`), "utf8")) as RunResult;

// The public csv-metrics example's assertions, verbatim (the fixture `public-scenario-pinned` is a run of it).
const CSV_ASSERTS = `assert:
  - result: success
  - tool_called: Skill
  - tool_called: Bash
  - user_visible_artifact: outputs/metrics.json
  - user_visible_artifact: outputs/summary.md
  - transcript_matches: 'metrics\\.json'
  - no_delete_in_outputs: true
`;
// The public e2e semantic scenario's assertions, verbatim (`public-scenario-aligned`).
const SEM_ASSERTS = `assert:
  - result: success
  - user_visible_artifact: outputs/report.md
  - user_visible_artifact: outputs/_work/f6.md
  - semantic_matches:
      rubric:
        - The document reports that six filler files were created under a _work directory.
        - The document states that all six writes completed without error.
      evidence_files:
        - outputs/report.md
`;

let root: string;
let runsRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function writePlugin(dir: string, body: string): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "csv-metrics" }));
  mkdirSync(join(dir, "skills", "csv-metrics"), { recursive: true });
  writeFileSync(join(dir, "skills", "csv-metrics", "SKILL.md"), `---\nname: csv-metrics\ndescription: d\n---\n${body}\n`);
}

/** A scenario dir: a session declaring one plugin, and the csv scenario (plus the semantic one on request). */
function setup(opts: { semantic?: boolean; extraSessionYaml?: string } = {}) {
  const scen = join(root, "scenarios");
  mkdirSync(scen, { recursive: true });
  writePlugin(join(root, "declared", "csv-metrics"), "declared");
  writePlugin(join(root, "a", "csv-metrics"), "version A");
  writePlugin(join(root, "b", "csv-metrics"), "version B");
  writeFileSync(
    join(root, "session.yaml"),
    `model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared/csv-metrics\n${opts.extraSessionYaml ?? ""}`,
  );
  writeFileSync(
    join(scen, "csv-metrics.yaml"),
    `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: analyze\n${CSV_ASSERTS}`,
  );
  if (opts.semantic)
    writeFileSync(
      join(scen, "smoke-semantic-evidence-files.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: write\n${SEM_ASSERTS}`,
    );
  return { scen, a: join(root, "a", "csv-metrics"), b: join(root, "b", "csv-metrics") };
}

type Behaviour = (spec: EvalJobSpec, r: RunResult) => RunResult | Promise<RunResult>;

/** The fake runner: the fixture for the scenario, fingerprinted over the job's session, in its own dir. */
function fakeRunner(behaviour: Behaviour = (_s, r) => r, calls: EvalJobSpec[] = []) {
  return async (spec: EvalJobSpec): Promise<RunResult> => {
    calls.push(spec);
    const base = fixture(spec.scenario.name === "csv-metrics" ? "public-scenario-pinned" : "public-scenario-aligned");
    const baseline = loadBaseline(spec.scenario.baseline);
    const outDir = runOutDir(spec.scenario.name, spec.job.runId);
    mkdirSync(outDir, { recursive: true });
    const r: RunResult = {
      ...base,
      scenario: spec.scenario.name,
      modelPinHonored: true,
      outDir,
      fingerprint: buildFingerprint(spec.scenario.session, baseline.appVersion, undefined, spec.scenario.skills, baseline, spec.session),
    } as RunResult;
    return behaviour(spec, r);
  };
}

const failAssertion = (r: RunResult, index: number): RunResult => ({
  ...r,
  assertions: r.assertions.map((a, i) => (i === index ? { ...a, pass: false } : a)),
});

function args(scen: string, a: string, b: string, extra: string[] = []) {
  return parseEvalArgs([scen, "--arm", `before=${a}`, "--arm", `after=${b}`, "--out", join(root, "eval"), "--quiet", ...extra]);
}

/** Doctor's token row for a tier that has a credential (the preflight's pass). */
const TOKEN_OK = (): DoctorCheck => ({ id: "token", title: "Auth token", status: "ok", detail: "found (env / .env)", required: true });

const deps = (runJob: (s: EvalJobSpec) => Promise<RunResult>, log: string[] = []) => ({
  runJob,
  tokenCheck: TOKEN_OK,
  isolationCheck: () => undefined,
  log: (s: string) => log.push(s),
  evalId: "test1",
  now: () => new Date("2026-09-30T00:00:00Z"),
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pe-cmd-")));
  runsRoot = join(root, "runs");
  for (const k of ["COWORK_HARNESS_RUNS_DIR", "COWORK_HARNESS_MODEL", "COWORK_HARNESS_JUDGE_MODEL", "COWORK_HARNESS_GITSET"])
    savedEnv[k] = process.env[k];
  process.env.COWORK_HARNESS_RUNS_DIR = runsRoot;
  delete process.env.COWORK_HARNESS_MODEL;
  delete process.env.COWORK_HARNESS_JUDGE_MODEL;
  delete process.env.COWORK_HARNESS_GITSET;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("eval: argument parsing", () => {
  const base = ["s.yaml", "--arm", "x", "--arm", "y"];
  it("defaults: reps 5, concurrency 2, bh, and NO --fail-on gating", () => {
    const p = parseEvalArgs(base);
    expect(p).toMatchObject({ reps: 5, concurrency: 2, correction: "bh", alpha: 0.05 });
    expect(p.failOn).toBeUndefined();
  });
  it("refuses fewer than 4 reps unless --allow-underpowered", () => {
    expect(() => parseEvalArgs([...base, "--reps", "3"])).toThrow(/--allow-underpowered/);
    expect(parseEvalArgs([...base, "--reps", "3", "--allow-underpowered"]).reps).toBe(3);
  });
  it("refuses --label and --session-id with the reason, and an unknown flag", () => {
    expect(() => parseEvalArgs([...base, "--label", "x"])).toThrow(/eval:<eval-id>:<arm>/);
    expect(() => parseEvalArgs([...base, "--session-id", "x"])).toThrow(/pre-assigned/);
    expect(() => parseEvalArgs([...base, "--control"])).toThrow(/unknown flag/);
  });
  it("needs exactly two arms and refuses a cassette", () => {
    expect(() => parseEvalArgs(["s.yaml", "--arm", "x"])).toThrow(/exactly two/);
    expect(() => parseEvalArgs(["x.cassette.json", "--arm", "x", "--arm", "y"])).toThrow(/live only/);
  });
  it("refuses --concurrency > 1 (including the default) with an external decider", () => {
    expect(() => parseEvalArgs([...base, "--decider-cmd", "helper"])).toThrow(/Pass --concurrency 1/);
    expect(parseEvalArgs([...base, "--decider-cmd", "helper", "--concurrency", "1"]).deciderCmd).toBe("helper");
  });
  it("a flag-looking value is refused, not taken as the value", () => {
    expect(() => parseEvalArgs([...base, "--model", "--dotenv"])).toThrow(/missing value/);
  });
  it("--fail-on and --correction are enums", () => {
    expect(() => parseEvalArgs([...base, "--fail-on", "any"])).toThrow(/possible or confirmed/);
    expect(() => parseEvalArgs([...base, "--correction", "bonferroni"])).toThrow(/bh or holm/);
  });
});

describe("eval: end to end over a fake runner", () => {
  it("runs reps x scenarios x arms in ABBA order, writes the eval dir, and exits 0 with no drop", async () => {
    const { scen, a, b } = setup();
    const calls: EvalJobSpec[] = [];
    const out = await runEval(args(scen, a, b, ["--concurrency", "1"]), deps(fakeRunner(undefined, calls)));
    expect(calls.map((c) => `${c.job.arm}:${c.job.rep}`)).toEqual([
      "before:1",
      "after:1",
      "after:2",
      "before:2",
      "before:3",
      "after:3",
      "after:4",
      "before:4",
      "before:5",
      "after:5",
    ]);
    // Each job ran the arm's SNAPSHOT (not the source, not the declared dir), with the run label and session id.
    for (const c of calls) {
      expect(c.session.plugins.local_plugins).toEqual([join(out.evalDir, "arms", c.job.arm, "csv-metrics")]);
      expect(c.runLabel).toBe(`eval:test1:${c.job.arm}`);
      // Shaped like an ordinary run's id (`local_<base36>`): nothing about the eval or the arm.
      expect(c.job.runId).toMatch(/^local_[0-9a-z]{13}$/);
      expect(c.session.model).toBe("claude-sonnet-5");
    }
    for (const f of ["manifest.json", "runs.jsonl", "report.json", "report.md"]) expect(existsSync(join(out.evalDir, f))).toBe(true);
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    expect(lines).toHaveLength(10);
    expect(lines[0].grades).toHaveLength(1);
    expect(out.report.arms.map((x) => x.buckets)).toEqual([{ valid: 5 }, { valid: 5 }]);
    expect(out.report.summary.exitCode).toBe(0);
    expect(out.report.sections.tuned!.rows.every((r) => r.label === "no detectable change")).toBe(true);
    expect(out.report.sections.tuned!.ceilingRows).toBe(7);
  });

  it("`eval report` rebuilds report.json and report.md byte-identically", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const out = await runEval(
      args(scen, a, b),
      deps(fakeRunner((s, r) => (s.job.arm === "after" && s.job.rep <= 3 ? failAssertion(r, 2) : r))),
    );
    const md = readFileSync(join(out.evalDir, "report.md"));
    const js = readFileSync(join(out.evalDir, "report.json"));
    writeEvalReport(out.evalDir);
    expect(readFileSync(join(out.evalDir, "report.md")).equals(md)).toBe(true);
    expect(readFileSync(join(out.evalDir, "report.json")).equals(js)).toBe(true);
  });

  it("a row whose text holds a backslash before a pipe stays one row of nine cells in report.md", async () => {
    const { scen, a, b } = setup({ semantic: true });
    // The first rubric claim carries `\|` (a backslash, then a pipe) and a bare `|`. YAML single quotes keep
    // the backslash literal, so the claim text the report renders is exactly `... a\|b or c|d ...`.
    const claim = "The document says a\\|b or c|d about the six filler files.";
    writeFileSync(
      join(scen, "smoke-semantic-evidence-files.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: write\n${SEM_ASSERTS.replace(
        "The document reports that six filler files were created under a _work directory.",
        `'${claim}'`,
      )}`,
    );
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    const md = readFileSync(join(out.evalDir, "report.md"), "utf8");
    const row = md.split("\n").find((l) => l.startsWith("|") && l.toLowerCase().includes("a\\"));
    expect(row, "the claim row is rendered").toBeDefined();
    // A GFM column separator is a `|` NOT preceded by an odd run of backslashes; a nine-column row has ten.
    const separators = [...row!.matchAll(/(?<!\\)(?:\\\\)*\|/g)].length;
    expect(separators).toBe(TABLE_COLUMNS + 1);
  });

  it("a semantic grade refused for unavailable evidence leaves its rows, is counted per arm, and survives `eval report`", async () => {
    const { scen, a, b } = setup({ semantic: true });
    // The shape a run now persists for a refused assert: no claims, no judge fields, the typed reason.
    const refuse = (r: RunResult): RunResult => ({
      ...r,
      assertions: r.assertions.map((x) => {
        if (!x.assertion.semantic_matches) return x;
        const { semanticClaims: _c, judgeModel: _m, judgeCostUsd: _u, judgePromptHash: _h, ...rest } = x;
        (void _c, void _m, void _u, void _h);
        return { ...rest, pass: false, semanticEvidence: { reason: "in_scope_truncated", paths: ["outputs/report.md"] } };
      }),
    });
    const out = await runEval(
      args(scen, a, b),
      deps(fakeRunner((s, r) => (s.scenario.name !== "csv-metrics" && s.job.arm === "after" && s.job.rep <= 2 ? refuse(r) : r))),
    );
    // The reason is carried through runs.jsonl — the report's only input — without the path list.
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    const refusedLine = lines.find((l) => l.arm === "after" && l.rep === 1 && l.scenario !== "csv-metrics")!;
    const g = refusedLine.grades[0].assertions.find((x) => x.assertion.semantic_matches)!;
    expect(g.semanticEvidence).toEqual({ reason: "in_scope_truncated" });
    expect(out.report.arms.map((x) => x.evidenceUnavailable)).toEqual([{}, { in_scope_truncated: 2 }]);
    // Every row of that assertion lost exactly those two reps on the candidate arm, and none on the baseline.
    const semRows = [...out.report.sections.tuned!.rows, ...out.report.sections.tuned!.derivedRows].filter(
      (r) => r.scenario === "smoke-semantic-evidence-files" && (r.kind === "claim" || r.kind === "semantic_rollup"),
    );
    expect(semRows).toHaveLength(3);
    for (const r of semRows) {
      expect(r.n1).toBe(5);
      expect(r.n2).toBe(3);
      expect(r.k2).toBe(3); // the refusals are not scored as fails
    }
    const md = readFileSync(join(out.evalDir, "report.md"), "utf8");
    expect(md).toContain("2 semantic_matches grade(s) refused for unavailable evidence (in_scope_truncated 2)");
    const js = readFileSync(join(out.evalDir, "report.json"));
    writeEvalReport(out.evalDir);
    expect(readFileSync(join(out.evalDir, "report.json")).equals(js)).toBe(true);
  });

  describe("refusals that differ between the arms", () => {
    const SEM = "smoke-semantic-evidence-files";
    const refuse = (r: RunResult): RunResult => ({
      ...r,
      assertions: r.assertions.map((x) => {
        if (!x.assertion.semantic_matches) return x;
        const { semanticClaims: _c, ...rest } = x;
        void _c;
        return { ...rest, pass: false, semanticEvidence: { reason: "in_scope_truncated" } };
      }),
    });
    const judgeInvalid = (r: RunResult): RunResult => ({
      ...r,
      assertions: r.assertions.map((x) => (x.assertion.semantic_matches ? { ...x, pass: false, judgeInvalid: true } : x)),
    });
    /** Per arm, the reps whose semantic grade refuses (and, optionally, is judge-invalid). */
    const shaped = (plan: { before?: number[]; after?: number[]; invalidAfter?: number[] }) =>
      fakeRunner((s, r) => {
        if (s.scenario.name !== SEM) return r;
        const arm = s.job.arm as "before" | "after";
        if ((plan[arm] ?? []).includes(s.job.rep)) return refuse(r);
        if (arm === "after" && (plan.invalidAfter ?? []).includes(s.job.rep)) return judgeInvalid(r);
        return r;
      });
    const semRows = (rep: Awaited<ReturnType<typeof runEval>>["report"]) =>
      [...rep.sections.tuned!.rows, ...rep.sections.tuned!.derivedRows].filter((r) => r.scenario === SEM && r.assertionIndex === 3);
    const outDir = (name: string) => ["--out", join(root, name)];
    const argv = (scen: string, a: string, b: string, extra: string[]) =>
      parseEvalArgs([scen, "--arm", `before=${a}`, "--arm", `after=${b}`, "--quiet", ...extra]);

    it("the CANDIDATE refusing 2 more labels the rows insufficient_refusals and warns — but no gate without --fail-on", async () => {
      const { scen, a, b } = setup({ semantic: true });
      const out = await runEval(args(scen, a, b), deps(shaped({ after: [1, 2] })));
      expect(semRows(out.report).map((r) => r.label)).toEqual(Array(3).fill("insufficient_refusals"));
      expect(out.report.summary.refusalImbalances).toEqual([
        { scenario: SEM, assertionIndex: 3, a: { refused: 0, scored: 5 }, b: { refused: 2, scored: 5 }, insufficientRefusals: true },
      ]);
      expect(out.report.summary.labels.insufficient_refusals).toBe(2); // the claim rows (the roll-up is derived)
      expect(out.report.summary.labels.insufficient).toBeUndefined();
      expect(out.report.summary.allInsufficient).toBe(false);
      expect(out.report.summary.exitCode).toBe(0); // --fail-on absent: nothing gates (SPEC §12)
      const md = readFileSync(join(out.evalDir, "report.md"), "utf8");
      expect(md).toContain(`⚠ ${SEM} #3 (semantic_matches) refused for unavailable evidence: A 0/5, B 2/5 scored reps`);
    });

    it("--fail-on possible gates on it (exit 1); --fail-on confirmed does not", async () => {
      const { scen, a, b } = setup({ semantic: true });
      const possible = await runEval(argv(scen, a, b, [...outDir("e-p"), "--fail-on", "possible"]), deps(shaped({ after: [1, 2] })));
      expect(possible.report.summary.failOnHit).toBe(true);
      expect(possible.report.summary.exitCode).toBe(1);
      expect(readFileSync(join(possible.evalDir, "report.md"), "utf8")).toContain("including an insufficient_refusals row");
      // `confirmed` needs a tested row; an insufficient one confirms nothing.
      const confirmed = await runEval(argv(scen, a, b, [...outDir("e-c"), "--fail-on", "confirmed"]), deps(shaped({ after: [1, 2] })));
      expect(semRows(confirmed.report).map((r) => r.label)).toEqual(Array(3).fill("insufficient_refusals"));
      expect(confirmed.report.summary.failOnHit).toBe(false);
      expect(confirmed.report.summary.exitCode).toBe(0);
    });

    it("the BASELINE refusing more warns but never labels a row", async () => {
      const { scen, a, b } = setup({ semantic: true });
      const out = await runEval(argv(scen, a, b, [...outDir("e-a"), "--fail-on", "possible"]), deps(shaped({ before: [1, 2] })));
      expect(semRows(out.report).map((r) => r.label)).toEqual(Array(3).fill("insufficient"));
      expect(out.report.summary.refusalImbalances).toEqual([
        { scenario: SEM, assertionIndex: 3, a: { refused: 2, scored: 5 }, b: { refused: 0, scored: 5 }, insufficientRefusals: false },
      ]);
      expect(out.report.summary.exitCode).toBe(0);
    });

    describe("only the candidate's EXCESS refusals are credited (reps 5, threshold 4)", () => {
      it("1 vs 2: an excess of one does not label (it still warns: 2 of 5 is ≥ 20%)", async () => {
        const { scen, a, b } = setup({ semantic: true });
        const out = await runEval(args(scen, a, b), deps(shaped({ before: [1], after: [1, 2] })));
        expect(semRows(out.report).map((r) => r.label)).toEqual(Array(3).fill("insufficient"));
        expect(out.report.summary.refusalImbalances.map((r) => r.insufficientRefusals)).toEqual([false]);
      });
      it("0 vs 2 with n2 = 3: labels (3 + 2 ≥ 4)", async () => {
        const { scen, a, b } = setup({ semantic: true });
        const out = await runEval(args(scen, a, b), deps(shaped({ after: [3, 4] })));
        expect(semRows(out.report).every((r) => r.n2 === 3 && r.label === "insufficient_refusals")).toBe(true);
      });
      it("another candidate-side exclusion plus a one-rep excess does not label", async () => {
        // after: rep 1 refused, rep 2 judge-invalid ⇒ n2 = 3. The old rule credited the refusal back (3 + 1 ≥ 4).
        const { scen, a, b } = setup({ semantic: true });
        const out = await runEval(args(scen, a, b), deps(shaped({ after: [1], invalidAfter: [2] })));
        const rows = semRows(out.report);
        expect(rows.every((r) => r.n2 === 3)).toBe(true);
        expect(rows.map((r) => r.label)).toEqual(Array(3).fill("insufficient"));
      });
    });

    it("balanced, infrequent refusals raise no warning and label nothing", async () => {
      const { scen, a, b } = setup({ semantic: true });
      // One refusal per arm in 10 reps: a gap of 0 and a 10% share.
      const both = await runEval(args(scen, a, b, ["--reps", "10"]), deps(shaped({ before: [1], after: [1] })));
      expect(semRows(both.report).every((r) => r.n1 === 9 && r.n2 === 9)).toBe(true);
      expect(both.report.summary.refusalImbalances).toEqual([]);
      expect(both.report.summary.exitCode).toBe(0);
    });

    it("a MULTI-key assertion labels through its claim rows; its roll-up keeps the refused reps as fails", async () => {
      const { scen, a, b } = setup({ semantic: true });
      const file = join(scen, `${SEM}.yaml`);
      writeFileSync(file, readFileSync(file, "utf8").replace("  - semantic_matches:", "  - result: success\n    semantic_matches:"));
      // The grade must carry the frozen scenario's own (two-key) assertion object, or it is grade_misaligned.
      const multi = fakeRunner((s, r) => {
        if (s.scenario.name !== SEM) return r;
        const frozen = s.scenario.assert![3];
        const x = { ...r, assertions: r.assertions.map((g, i) => (i === 3 ? { ...g, assertion: frozen } : g)) };
        return s.job.arm === "after" && s.job.rep <= 2 ? refuse(x) : x;
      });
      const out = await runEval(argv(scen, a, b, [...outDir("e-m"), "--fail-on", "possible"]), deps(multi));
      const rows = semRows(out.report);
      expect(rows.filter((r) => r.kind === "claim").map((r) => r.label)).toEqual(["insufficient_refusals", "insufficient_refusals"]);
      const rollup = rows.find((r) => r.kind === "semantic_rollup")!;
      expect([rollup.n2, rollup.k2]).toEqual([5, 3]); // the refusals stay in as fails
      expect(rollup.label).not.toBe("insufficient_refusals");
      expect(out.report.summary.exitCode).toBe(1);
    });

    it("a legacy eval dir (no persisted reason) re-reported through `eval report` infers the provable refusals", async () => {
      const { scen, a, b } = setup({ semantic: true });
      // The pre-reason shape: the single-key semantic grade failed while its claims met min_pass (all here).
      const legacy = fakeRunner((s, r) => (s.scenario.name === SEM && s.job.arm === "after" && s.job.rep <= 2 ? failAssertion(r, 3) : r));
      const out = await runEval(argv(scen, a, b, [...outDir("e-l"), "--fail-on", "possible"]), deps(legacy));
      const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
      expect(lines.flatMap((l) => l.grades[0]?.assertions ?? []).some((g) => g.semanticEvidence !== undefined)).toBe(false);
      const rep = writeEvalReport(out.evalDir);
      expect(rep.arms.map((x) => x.evidenceUnavailable)).toEqual([{}, { unrecorded: 2 }]);
      expect(semRows(rep).map((r) => r.label)).toEqual(Array(3).fill("insufficient_refusals"));
      expect(rep.summary.exitCode).toBe(1);
    });
  });

  it("a collapsed row is a drop: reported with evidence links, but the DEFAULT does not gate (exit 0)", async () => {
    const { scen, a, b } = setup();
    // Flip: arm `after` fails `tool_called: Bash` (index 2) in every rep.
    const flip = (s: EvalJobSpec, r: RunResult) => (s.job.arm === "after" ? failAssertion(r, 2) : r);
    const dflt = await runEval(args(scen, a, b), deps(fakeRunner(flip)));
    expect(dflt.report.sections.tuned!.rows.find((r) => r.assertionIndex === 2)!.label).toMatch(/drop$/);
    expect(dflt.report.summary.failOnHit).toBe(false);
    expect(dflt.report.summary.exitCode).toBe(0);
    const out = await runEval(
      parseEvalArgs([
        scen,
        "--arm",
        `before=${a}`,
        "--arm",
        `after=${b}`,
        "--out",
        join(root, "eval-g"),
        "--quiet",
        "--fail-on",
        "possible",
      ]),
      deps(fakeRunner(flip)),
    );
    const row = out.report.sections.tuned!.rows.find((r) => r.assertionIndex === 2)!;
    expect(row).toMatchObject({ k1: 5, n1: 5, k2: 0, n2: 5, direction: "drop" });
    expect(row.label).toMatch(/drop$/);
    expect(row.p).toBeCloseTo(0.007937, 5);
    expect(row.evidence!.a.length).toBeGreaterThan(0);
    expect(row.evidence!.b.length).toBeGreaterThan(0);
    expect(out.report.summary.failOnHit).toBe(true);
    expect(out.report.summary.exitCode).toBe(1);
    expect(readFileSync(join(out.evalDir, "report.md"), "utf8")).toMatch(/A drop is a signal to investigate, not proof/);
  });

  it("a `possible` (unconfirmed) drop fails the eval under --fail-on possible", async () => {
    const { scen, a, b } = setup();
    // Flip: `after` fails index 2 in 4 of 5 reps — p = 0.048: possible, not confirmed.
    const out = await runEval(
      args(scen, a, b, ["--fail-on", "possible"]),
      deps(fakeRunner((s, r) => (s.job.arm === "after" && s.job.rep <= 4 ? failAssertion(r, 2) : r))),
    );
    expect(out.report.sections.tuned!.rows.find((r) => r.assertionIndex === 2)!.label).toBe("possible drop");
    expect(out.report.summary.exitCode).toBe(1);
  });

  it("--fail-on confirmed does not fire on a `possible` drop that is not confirmed", async () => {
    const { scen, a, b } = setup();
    // Flip: `after` fails index 2 in 4 of 5 reps — p = 0.048, possible, and BH over 7 rows does not confirm it.
    const out = await runEval(
      args(scen, a, b, ["--fail-on", "confirmed"]),
      deps(fakeRunner((s, r) => (s.job.arm === "after" && s.job.rep <= 4 ? failAssertion(r, 2) : r))),
    );
    const row = out.report.sections.tuned!.rows.find((r) => r.assertionIndex === 2)!;
    expect(row.label).toBe("possible drop");
    expect(out.report.summary.exitCode).toBe(0);
  });

  it("every row insufficient (an infrastructure outage across the eval) exits 1, and the histogram names it", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b),
      deps(fakeRunner((_s, r) => ({ ...fixture("usage-limit"), outDir: r.outDir, fingerprint: r.fingerprint }) as RunResult)),
    );
    expect(out.report.summary.allInsufficient).toBe(true);
    expect(out.report.summary.exitCode).toBe(1);
    expect(out.report.arms[0].buckets).toEqual({ errored_infra: 5 });
    expect(out.report.arms[0].errorSources).toEqual({ result: 5 });
  });
});

describe("eval: credential preflight (doctor's token check, before any run)", () => {
  // The consumer's machine: no env / .env token, a Claude Code login in the Keychain. Doctor's own check over
  // a probe saying exactly that — not a stand-in verdict.
  const keychainOnly = {
    hasToken: () => false,
    hasKeychainToken: () => true,
    platform: () => "darwin",
    worktreeEnv: () => null,
  } as unknown as DoctorProbe;
  it("refuses (usage, exit 2) with doctor's detail and remedy, runs nothing, and leaves no eval dir", async () => {
    const { scen, a, b } = setup();
    const calls: EvalJobSpec[] = [];
    const tiers: string[] = [];
    const p = runEval(args(scen, a, b), {
      ...deps(fakeRunner(undefined, calls)),
      tokenCheck: (tier) => {
        tiers.push(tier);
        return tokenCheck(tier, keychainOnly);
      },
    });
    await expect(p).rejects.toBeInstanceOf(UsageError);
    await expect(p).rejects.toThrow(/fidelity container.*Keychain entry.*setup-token/s);
    expect(tiers).toEqual(["container"]);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, "eval"))).toBe(false);
  });
  it("a tier doctor passes with a warning (protocol + Keychain) runs", async () => {
    const { scen, a, b } = setup();
    for (const f of readdirSync(scen))
      writeFileSync(join(scen, f), readFileSync(join(scen, f), "utf8").replace("fidelity: container", "fidelity: protocol"));
    const out = await runEval(args(scen, a, b), { ...deps(fakeRunner()), tokenCheck: (tier) => tokenCheck(tier, keychainOnly) });
    expect(out.report.arms.map((x) => x.buckets)).toEqual([{ valid: 5 }, { valid: 5 }]);
  });
  it("asks once per distinct tier the scenarios declare", async () => {
    const { scen, a, b } = setup({ semantic: true });
    writeFileSync(
      join(scen, "smoke-semantic-evidence-files.yaml"),
      readFileSync(join(scen, "smoke-semantic-evidence-files.yaml"), "utf8").replace("fidelity: container", "fidelity: hostloop"),
    );
    const tiers: string[] = [];
    await runEval(args(scen, a, b), {
      ...deps(fakeRunner()),
      tokenCheck: (tier) => {
        tiers.push(tier);
        return TOKEN_OK();
      },
    });
    expect(tiers.sort()).toEqual(["container", "hostloop"]);
  });
});

describe("eval: a scenario that opts out of the stall verdict (allow_stall: true)", () => {
  // Every rep of both arms stalls on a question, which the scenario declares as its intended terminal state.
  // The termination fields come from the REAL stalled excerpt; the grades are the csv scenario's own (plus the
  // modifier's), because the excerpt's graded assertions belong to another scenario and would not align.
  const stalled = fixture("stalled-on-question");
  const stall =
    (optedOut: boolean) =>
    (_s: EvalJobSpec, r: RunResult): RunResult => ({
      ...r,
      result: stalled.result,
      resultSubtype: stalled.resultSubtype,
      stalledOnQuestion: stalled.stalledOnQuestion,
      assertions: optedOut
        ? [...r.assertions, { assertion: { allow_stall: true }, pass: true } as RunResult["assertions"][number]]
        : r.assertions,
    });
  const optOut = (scen: string) =>
    writeFileSync(join(scen, "csv-metrics.yaml"), readFileSync(join(scen, "csv-metrics.yaml"), "utf8") + "  - allow_stall: true\n");

  it("every rep stalled: graded, rule stall_allowed, no errored arm, rows compared, exit 0", async () => {
    const { scen, a, b } = setup();
    optOut(scen);
    const out = await runEval(args(scen, a, b), deps(fakeRunner(stall(true))));
    expect(out.report.arms.map((x) => x.buckets)).toEqual([{ valid: 5 }, { valid: 5 }]);
    expect(out.report.reps).toHaveLength(10);
    expect(out.report.reps.every((r) => r.rule === "stall_allowed")).toBe(true);
    expect(out.report.summary.erroredArms).toEqual([]);
    const rows = out.report.sections.tuned!.rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.label !== "insufficient")).toBe(true);
    expect(out.report.summary.exitCode).toBe(0);
  });

  it("the same stalls without the opt-out are the agent's failure in every rep: compared nothing, exit 1", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner(stall(false))));
    expect(out.report.arms.map((x) => x.buckets)).toEqual([{ errored_agent: 5 }, { errored_agent: 5 }]);
    expect(out.report.reps.every((r) => r.rule === "stalled_on_question")).toBe(true);
    expect(out.report.summary.erroredArms.map((e) => [e.arm, e.rowsInsufficient])).toEqual([
      ["before", true],
      ["after", true],
    ]);
    expect(out.report.summary.exitCode).toBe(1);
  });
});

describe("eval: every rep of an arm errored, per scenario", () => {
  // The consumer's report: no usable credential, every rep of both arms "Not logged in", and the eval said
  // "no detectable change" and exited 0. The fake returns the REAL auth excerpt for every job.
  const as = (name: string) => (_s: EvalJobSpec, r: RunResult) =>
    ({ ...fixture(name), outDir: r.outDir, fingerprint: r.fingerprint }) as RunResult;
  const authRep = as("auth-exit");
  const md = (dir: string) => readFileSync(join(dir, "report.md"), "utf8");

  it("an auth failure in every rep is infrastructure, every row insufficient, exit 1, and the header names it", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner(authRep)));
    expect(out.report.arms.map((x) => x.buckets)).toEqual([{ errored_infra: 5 }, { errored_infra: 5 }]);
    expect(out.report.reps.every((r) => r.rule === "auth")).toBe(true);
    expect(out.report.sections.tuned!.rows.every((r) => r.label === "insufficient")).toBe(true);
    expect(out.report.summary.exitCode).toBe(1);
    const dominant = { bucket: "errored_infra", rule: "auth", count: 5 };
    expect(out.report.summary.erroredArms).toEqual([
      { arm: "before", scenario: "csv-metrics", reps: 5, dominant, rowsInsufficient: true },
      { arm: "after", scenario: "csv-metrics", reps: 5, dominant, rowsInsufficient: true },
    ]);
    expect(md(out.evalDir)).toMatch(/Every rep of arm before in csv-metrics errored.*errored_infra \(auth\) 5\/5/);
    expect(md(out.evalDir)).toMatch(/could not sign in.*doctor/);
    // The runs line keeps the agent's own text, which is what `auth` matches on a re-render.
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    expect(lines[0].result?.finalMessage).toBe("Not logged in · Please run /login");
  });

  it("an eval dir written before finalMessage was persisted still re-reports as infrastructure, exit 1", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner(authRep)));
    // Strip the field from every line: the shape of runs.jsonl the consumer already has on disk.
    const file = join(out.evalDir, "runs.jsonl");
    const old = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        const o = JSON.parse(l);
        delete o.result.finalMessage;
        return JSON.stringify(o);
      });
    writeFileSync(file, old.join("\n") + "\n");
    const rep = writeEvalReport(out.evalDir);
    expect(rep.reps.every((r) => r.rule === "no_model_answered")).toBe(true);
    expect(rep.summary.exitCode).toBe(1);
  });

  it("one scenario erroring in BOTH arms is insufficient and exits 1, though another scenario compared fine", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const out = await runEval(args(scen, a, b), deps(fakeRunner((s, r) => (s.scenario.name === "csv-metrics" ? as("timeout")(s, r) : r))));
    const rows = out.report.sections.tuned!.rows;
    expect(rows.filter((r) => r.scenario === "csv-metrics").every((r) => r.label === "insufficient")).toBe(true);
    expect(rows.filter((r) => r.scenario !== "csv-metrics").some((r) => r.label !== "insufficient")).toBe(true);
    expect(out.report.summary.allInsufficient).toBe(false);
    expect(out.report.summary.erroredArms.map((e) => [e.arm, e.scenario, e.rowsInsufficient])).toEqual([
      ["before", "csv-metrics", true],
      ["after", "csv-metrics", true],
    ]);
    expect(out.report.summary.exitCode).toBe(1);
    expect(md(out.evalDir)).toMatch(/Every rep of arm after in csv-metrics errored.*source_timeout.*read the run dirs/);
  });

  it("an arm whose every rep is INFRASTRUCTURE compared nothing, even against a valid arm: insufficient, exit 1", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner((s, r) => (s.job.arm === "after" ? as("usage-limit")(s, r) : r))));
    expect(out.report.sections.tuned!.rows.every((r) => r.label === "insufficient")).toBe(true);
    expect(out.report.summary.erroredArms).toEqual([
      {
        arm: "after",
        scenario: "csv-metrics",
        reps: 5,
        dominant: { bucket: "errored_infra", rule: "kind_usage_limit", count: 5 },
        rowsInsufficient: true,
      },
    ]);
    expect(out.report.summary.exitCode).toBe(1);
    expect(md(out.evalDir)).toMatch(/usage or spend limit.*quota/);
  });

  it("an arm whose every rep is the AGENT's error against a valid arm is scored: a real drop, named in the header", async () => {
    // The skill crashes every rep: that is the regression an eval exists to catch, not an absence of data.
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner((s, r) => (s.job.arm === "after" ? as("timeout")(s, r) : r))));
    expect(out.report.arms[1].buckets).toEqual({ errored_agent: 5 });
    const row = out.report.sections.tuned!.rows[0];
    expect(row).toMatchObject({ k1: 5, n1: 5, k2: 0, n2: 5 });
    expect(row.label).toMatch(/drop$/);
    expect(out.report.summary.erroredArms).toEqual([
      {
        arm: "after",
        scenario: "csv-metrics",
        reps: 5,
        dominant: { bucket: "errored_agent", rule: "source_timeout", count: 5 },
        rowsInsufficient: false,
      },
    ]);
    expect(out.report.summary.exitCode).toBe(0); // no --fail-on: a drop does not gate
    expect(md(out.evalDir)).toMatch(/Every rep of arm after in csv-metrics errored.*errored_agent \(source_timeout\) 5\/5.*scored/);
  });

  it("the header's hint follows the dominant rule", () => {
    const hint = (bucket: "errored_infra" | "errored_agent", rule: string) => erroredHint({ bucket, rule });
    expect(hint("errored_infra", "auth")).toMatch(/could not sign in/);
    expect(hint("errored_infra", "usage_limit")).toMatch(/quota/);
    expect(hint("errored_infra", "kind_usage_limit")).toMatch(/quota/);
    expect(hint("errored_infra", "source_spawn")).toMatch(/could not be started/);
    expect(hint("errored_infra", "kind_transport")).toMatch(/network/);
    expect(hint("errored_infra", "thrown_decider_timeout")).toMatch(/decider/);
    expect(hint("errored_infra", "thrown_other")).toMatch(/does not recognise/);
    expect(hint("errored_agent", "source_timeout")).toMatch(/read the run dirs/);
    for (const r of ["source_spawn", "kind_transport", "thrown_other"]) expect(hint("errored_infra", r)).not.toMatch(/quota|sign in/);
  });

  it("an arm with a single valid rep is not all-errored", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b),
      deps(fakeRunner((s, r) => (s.job.arm === "after" && s.job.rep > 1 ? as("timeout")(s, r) : r))),
    );
    expect(out.report.summary.erroredArms).toEqual([]);
    expect(out.report.sections.tuned!.rows.some((r) => r.label !== "insufficient")).toBe(true);
  });
});

describe("eval: per-rep classification over the real excerpts", () => {
  it("a timeout is the agent's error (scored 0 on every row); a usage limit is excluded", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b),
      deps(
        fakeRunner((s, r) => {
          if (s.job.arm !== "after") return r;
          const fx = s.job.rep === 1 ? "usage-limit" : "timeout";
          return { ...fixture(fx), outDir: r.outDir, fingerprint: r.fingerprint } as RunResult;
        }),
      ),
    );
    expect(out.report.arms[1].buckets).toEqual({ errored_agent: 4, errored_infra: 1 });
    const row = out.report.sections.tuned!.rows[0];
    expect(row).toMatchObject({ k1: 5, n1: 5, k2: 0, n2: 4 });
    expect(row.label).not.toBe("insufficient");
    const erroredRate = out.report.sections.tuned!.classificationRows.find((r) => r.kind === "errored_agent_rate")!;
    expect(erroredRate).toMatchObject({ k1: 0, n1: 5, k2: 4, n2: 4 });
  });

  it("an unanswered gate is the agent's error, and its salvaged result and dir are recorded", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b),
      deps(
        fakeRunner((s, r) => {
          if (!(s.job.arm === "after" && s.job.rep === 2)) return r;
          mkdirSync(join(r.outDir, "turns", "1"), { recursive: true });
          writeFileSync(
            join(r.outDir, "turns", "1", "result.json"),
            JSON.stringify({ ...fixture("unanswered-partial"), outDir: r.outDir }),
          );
          throw new UnansweredError("unanswered question", "hint");
        }),
      ),
    );
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    const line = lines.find((l) => l.arm === "after" && l.rep === 2)!;
    expect(line.thrown).toEqual({ kind: "unanswered", message: "unanswered question" });
    expect(line.runDir).toBe(tildeify(runOutDir("csv-metrics", line.runId)));
    expect(line.result?.partial).toBe(true);
    expect(out.report.arms[1].buckets).toEqual({ errored_agent: 1, valid: 4 });
  });

  it("a rep whose pin was not honored is model_mismatch; an unrecognised termination is LOUD", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b),
      deps(
        fakeRunner((s, r) => {
          if (s.job.arm !== "after") return r;
          if (s.job.rep === 1) return { ...r, modelPinHonored: false };
          if (s.job.rep === 2) return { ...r, errorSource: "result" } as RunResult; // a success with an error field
          return r;
        }),
      ),
    );
    expect(out.report.arms[1].buckets).toMatchObject({ model_mismatch: 1, errored_infra: 1, valid: 3 });
    expect(out.report.arms[1].unclassified).toBe(1);
    expect(readFileSync(join(out.evalDir, "report.md"), "utf8")).toMatch(/UNCLASSIFIED: 1 rep\(s\) in after/);
  });

  it("the report recomputes buckets from runs.jsonl with the live precedence (bucket not trusted from disk)", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    const c = classifyRep(repEvidenceOf(lines[0]), {
      contentSig: out.manifest.arms[0].sigs["csv-metrics"],
      judgePromptHash: JUDGE_PROMPT_HASH,
    });
    expect(c.bucket).toBe("valid");
    expect(lines[0]).not.toHaveProperty("bucket");
  });
});

describe("eval: snapshots and their signatures", () => {
  it("the manifest sig equals the rep sig, also with a second declared source (skills.local)", async () => {
    mkdirSync(join(root, "helper"), { recursive: true });
    writeFileSync(join(root, "helper", "SKILL.md"), "---\nname: helper\ndescription: h\n---\nhelper\n");
    const { scen, a, b } = setup({ extraSessionYaml: "skills:\n  local:\n    - ./helper\n" });
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    expect(out.report.arms.map((x) => x.buckets)).toEqual([{ valid: 5 }, { valid: 5 }]);
  });

  it("an arm source edited mid-eval does not reach the runs (they mount the snapshot)", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b, ["--concurrency", "1"]),
      deps(
        fakeRunner((s, r) => {
          if (s.job.index === 0) writeFileSync(join(b, "skills", "csv-metrics", "SKILL.md"), "edited source\n");
          return r;
        }),
      ),
    );
    expect(out.report.arms[1].buckets).toEqual({ valid: 5 });
  });

  it("a snapshot that changes mid-eval is arm_source_drift for the reps that saw it", async () => {
    const { scen, a, b } = setup();
    let evalDir = "";
    const out = await runEval(
      args(scen, a, b, ["--concurrency", "1"]),
      deps(
        fakeRunner(async (s, r) => {
          if (s.job.index === 0) {
            evalDir = join(root, "eval");
            writeFileSync(join(evalDir, "arms", "after", "csv-metrics", "skills", "csv-metrics", "SKILL.md"), "drifted\n");
          }
          // Re-fingerprint now, as the real run does at its end.
          const baseline = loadBaseline(s.scenario.baseline);
          return {
            ...r,
            fingerprint: buildFingerprint(s.scenario.session, baseline.appVersion, undefined, s.scenario.skills, baseline, s.session),
          };
        }),
      ),
    );
    expect(out.report.arms[1].buckets).toEqual({ arm_source_drift: 5 });
    expect(out.report.arms[0].buckets).toEqual({ valid: 5 });
  });

  it("identical arms are refused unless --allow-identical-arms", async () => {
    const { scen, a } = setup();
    await expect(runEval(args(scen, a, a), deps(fakeRunner()))).rejects.toThrow(/identical/);
    const out = await runEval(args(scen, a, a, ["--allow-identical-arms"]), deps(fakeRunner()));
    expect(out.report.summary.exitCode).toBe(0);
  });

  it("an older host claude refuses an eval whose scenarios call the judge, before any job (exit 2)", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const calls: EvalJobSpec[] = [];
    await expect(
      runEval(args(scen, a, b, ["--judge-model", "claude-opus-4-8"]), {
        ...deps(fakeRunner(undefined, calls)),
        isolationCheck: () => "OLD-CLI-REFUSAL",
      }),
    ).rejects.toThrow(/OLD-CLI-REFUSAL/);
    expect(calls).toHaveLength(0);
  });

  it("the isolation refusal comes before the --max-budget-usd gate (a real eval with priced history over the cap)", async () => {
    const { scen, a, b } = setup({ semantic: true });
    resetBudgetStatus();
    const app = loadBaseline("latest").appVersion;
    for (const [i, scenario] of ["csv-metrics", "smoke-semantic-evidence-files"].entries())
      appendIndexRow(runsRoot, {
        v: 1,
        ts: `2026-09-1${i}T00:00:00.000Z`,
        command: "run",
        scenario,
        slug: scenario,
        runId: `local_hist${i}`,
        fidelity: "container",
        baseline: app,
        result: "success",
        pass: true,
        signals: [],
        costUsd: 100, // 10 jobs x $100 is far over the $1 cap: the gate would refuse if it ran first
        turn: 1,
        partial: false,
        nonDeterministic: false,
        outDir: join(runsRoot, scenario, `local_hist${i}`),
        git: { branch: null, sha: null },
      });
    const calls: EvalJobSpec[] = [];
    await expect(
      runEval(args(scen, a, b, ["--judge-model", "claude-opus-4-8", "--max-budget-usd", "1"]), {
        ...deps(fakeRunner(undefined, calls)),
        isolationCheck: () => "OLD-CLI-REFUSAL",
      }),
    ).rejects.toThrow(/OLD-CLI-REFUSAL/);
    expect(budgetStatus()).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("does not consult the isolation check when no scenario calls the judge or the decider", async () => {
    const { scen, a, b } = setup();
    let asked = 0;
    await runEval(args(scen, a, b), { ...deps(fakeRunner()), isolationCheck: () => (asked++, undefined) });
    expect(asked).toBe(0);
  });

  it("does not consult it for on_unanswered: llm behind a decider channel, which replaces the LLM decider", async () => {
    const { scen, a, b } = setup();
    writeFileSync(
      join(scen, "csv-metrics.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: analyze\non_unanswered: llm\n${CSV_ASSERTS}`,
    );
    let asked = 0;
    const isolationCheck = () => (asked++, undefined);
    await runEval(args(scen, a, b), { ...deps(fakeRunner()), isolationCheck });
    expect(asked).toBe(1); // armed without a channel: the control
    asked = 0;
    const channel = parseEvalArgs([
      scen,
      "--arm",
      `before=${a}`,
      "--arm",
      `after=${b}`,
      "--out",
      join(root, "eval-2"),
      "--quiet",
      "--decider-dir",
      join(root, "gates"),
      "--concurrency",
      "1",
    ]);
    await runEval(channel, { ...deps(fakeRunner()), isolationCheck });
    expect(asked).toBe(0);
  });

  it("a semantic_pairwise scenario consults the isolation check too: the pairwise judge calls the host claude", async () => {
    const { scen, a, b } = setup();
    const key = composeKey(COMPOSER_ID, { includeSubagentText: false, includeForkResults: false, evidenceFiles: undefined });
    freezeRef(
      join(root, "refs"),
      "pairwise",
      { command: "ref freeze", runDir: "~/r", resultSha256: "a".repeat(64) },
      { [key]: "a reference answer" },
      {
        harnessVersion: "t",
        composerId: COMPOSER_ID,
        scenario: "pairwise",
        taskSha256: createHash("sha256").update("write", "utf8").digest("hex"),
      },
    );
    writeFileSync(
      join(scen, "pairwise.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: write\nassert:\n  - semantic_pairwise:\n      judge_model: claude-opus-4-8\n      refs: [../refs]\n`,
    );
    const calls: EvalJobSpec[] = [];
    await expect(
      runEval(args(scen, a, b), { ...deps(fakeRunner(undefined, calls)), isolationCheck: () => "OLD-CLI-REFUSAL" }),
    ).rejects.toThrow(/OLD-CLI-REFUSAL/);
    expect(calls).toHaveLength(0);
  });

  it("a semantic_pairwise reference that does not exist refuses the eval up front (exit 2), running no job", async () => {
    const { scen, a, b } = setup();
    writeFileSync(
      join(scen, "pairwise.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: write\nassert:\n  - semantic_pairwise:\n      judge_model: claude-opus-4-8\n      refs: [../no-such-store]\n`,
    );
    const calls: EvalJobSpec[] = [];
    await expect(runEval(args(scen, a, b), deps(fakeRunner(undefined, calls)))).rejects.toThrow(
      /semantic_pairwise: refusing before the run spends anything/,
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, "eval"))).toBe(false);
  });

  it("a refused eval leaves no eval dir behind", async () => {
    const { scen, a } = setup();
    await expect(runEval(args(scen, a, a), deps(fakeRunner()))).rejects.toThrow(UsageError);
    expect(existsSync(join(root, "eval"))).toBe(false);
  });

  it("an --out inside a git work tree is refused — an ignored directory included", async () => {
    const { scen, a, b } = setup();
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    const p = parseEvalArgs([scen, "--arm", a, "--arm", b, "--out", join(repo, "ignored", "e"), "--quiet"]);
    await expect(runEval(p, deps(fakeRunner()))).rejects.toThrow(/inside a git work tree/);
  });

  it("a dir arm in a work tree snapshots its tracked files; --include-untracked adds the rest", async () => {
    const { scen, b } = setup();
    const repo = join(root, "src-repo");
    cpSync(b, join(repo, "csv-metrics"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    writeFileSync(join(repo, "csv-metrics", "scratch.txt"), "untracked");
    const armA = join(repo, "csv-metrics");
    const out = await runEval(args(scen, armA, join(root, "a", "csv-metrics")), deps(fakeRunner()));
    expect(out.manifest.arms[0]).toMatchObject({ fileSet: "git-tracked", untrackedExcluded: 1, fileCount: 2 });
    expect(existsSync(join(out.evalDir, "arms", "before", "csv-metrics", "scratch.txt"))).toBe(false);
    const p = parseEvalArgs([
      scen,
      "--arm",
      armA,
      "--arm",
      join(root, "a", "csv-metrics"),
      "--out",
      join(root, "eval2"),
      "--quiet",
      "--include-untracked",
    ]);
    const out2 = await runEval(p, deps(fakeRunner()));
    expect(out2.manifest.arms[0]).toMatchObject({ fileSet: "raw-walk", fileCount: 3 });
  });
});

describe("eval: exit 3 — the eval's own snapshot staging failed", () => {
  it("an unreadable file in an arm source is EvalStagingError (not a usage error), and the dir is cleaned", async () => {
    const { scen, a, b } = setup();
    const locked = join(b, "skills", "csv-metrics", "locked.md");
    writeFileSync(locked, "x");
    chmodSync(locked, 0o000);
    try {
      await expect(runEval(args(scen, a, b), deps(fakeRunner()))).rejects.toThrow(EvalStagingError);
    } finally {
      chmodSync(locked, 0o644);
    }
    expect(existsSync(join(root, "eval"))).toBe(false);
  });
});

describe("eval: git: arms", () => {
  function repoWithPlugin() {
    const repo = join(root, "grepo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writePlugin(join(repo, "plugins", "csv-metrics"), "committed");
    writeFileSync(join(repo, "plugins", "csv-metrics", "packaging-only.txt"), "export-ignored");
    writeFileSync(join(repo, ".gitattributes"), "plugins/csv-metrics/packaging-only.txt export-ignore\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"], { cwd: repo });
    return repo;
  }

  it("extracts the committed tree with ls-tree/show — an export-ignore file included", async () => {
    const { scen, b } = setup();
    const repo = repoWithPlugin();
    writeFileSync(join(repo, "plugins", "csv-metrics", "skills", "csv-metrics", "SKILL.md"), "uncommitted edit\n");
    const p = parseEvalArgs([
      join(scen, "csv-metrics.yaml"),
      "--arm",
      "base=git:HEAD:plugins/csv-metrics",
      "--arm",
      `new=${b}`,
      "--out",
      join(root, "eval"),
      "--quiet",
    ]);
    const out = await runEval(p, { ...deps(fakeRunner()), cwd: repo });
    const snap = join(out.evalDir, "arms", "base", "csv-metrics");
    expect(readFileSync(join(snap, "packaging-only.txt"), "utf8")).toBe("export-ignored");
    expect(readFileSync(join(snap, "skills", "csv-metrics", "SKILL.md"), "utf8")).toContain("committed");
    expect(out.manifest.arms[0]).toMatchObject({ fileSet: "git-commit", source: "git:HEAD:plugins/csv-metrics" });
    expect(out.manifest.arms[0].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("each injection shape names its reason", async () => {
    const { scen, b } = setup();
    const repo = repoWithPlugin();
    for (const [arm, re] of [
      ["x=git:--upload-pack=touch_pwn:plugins/csv-metrics", /may not start with "-"/],
      ["x=git:HEAD:../outside", /may not contain "\.\."/],
      ["x=git:HEAD:/etc", /relative to the repository root/],
      ["x=git:nosuchref:plugins/csv-metrics", /does not name a commit/],
    ] as const) {
      const p = parseEvalArgs([scen, "--arm", arm, "--arm", `y=${b}`, "--out", join(root, "e-inj"), "--quiet"]);
      await expect(runEval(p, { ...deps(fakeRunner()), cwd: repo })).rejects.toThrow(re);
    }
  });

  it("--include-untracked with a git: arm is refused", async () => {
    const { scen, b } = setup();
    const p = parseEvalArgs([
      scen,
      "--arm",
      "x=git:HEAD:plugins/csv-metrics",
      "--arm",
      `y=${b}`,
      "--out",
      join(root, "e"),
      "--include-untracked",
    ]);
    await expect(runEval(p, deps(fakeRunner()))).rejects.toThrow(/no meaning for a git: arm/);
  });
});

describe("eval: answer-key guard", () => {
  it("refuses a scenario file inside an arm's source", async () => {
    const { a, b } = setup();
    const inside = join(b, "evals");
    mkdirSync(inside);
    writeFileSync(
      join(inside, "csv-metrics.yaml"),
      `baseline: latest\nsession: ../../../session.yaml\nfidelity: container\nprompt: analyze\n${CSV_ASSERTS}`,
    );
    await expect(runEval(args(join(inside, "csv-metrics.yaml"), a, b), deps(fakeRunner()))).rejects.toThrow(
      /answer-key guard.*inside source/,
    );
  });

  it("refuses a renamed COPY of a scenario in an arm (content identity)", async () => {
    const { scen, a, b } = setup();
    cpSync(join(scen, "csv-metrics.yaml"), join(b, "notes.txt"));
    await expect(runEval(args(scen, a, b), deps(fakeRunner()))).rejects.toThrow(/answer-key guard.*content copy/);
  });

  it("refuses an evals.json in an arm", async () => {
    const { scen, a, b } = setup();
    writeFileSync(join(b, "evals.json"), "{}");
    await expect(runEval(args(scen, a, b), deps(fakeRunner()))).rejects.toThrow(/answer-key guard.*evals json/);
  });
});

describe("eval: pins", () => {
  it("isConcreteModelId refuses aliases and accepts concrete ids, [1m] included", () => {
    for (const m of ["opus", "sonnet", "best", "opusplan", "", undefined]) expect(isConcreteModelId(m)).toBe(false);
    for (const m of ["claude-sonnet-5", "claude-opus-4-8[1m]"]) expect(isConcreteModelId(m)).toBe(true);
  });

  it("an alias agent model is refused before any run", async () => {
    const { scen, a, b } = setup();
    const calls: EvalJobSpec[] = [];
    await expect(runEval(args(scen, a, b, ["--model", "opus"]), deps(fakeRunner(undefined, calls)))).rejects.toThrow(
      /CONCRETE agent model/,
    );
    expect(calls).toHaveLength(0);
  });

  it("an alias judge is refused; under --judge-model a per-assert alias is inert", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const f = join(scen, "smoke-semantic-evidence-files.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace("      rubric:", "      judge_model: opus\n      rubric:"));
    await expect(runEval(args(scen, a, b), deps(fakeRunner()))).rejects.toThrow(/CONCRETE judge model/);
    await expect(runEval(args(scen, a, b, ["--judge-model", "sonnet"]), deps(fakeRunner()))).rejects.toThrow(/is an alias/);
    const calls: EvalJobSpec[] = [];
    const out = await runEval(args(scen, a, b, ["--judge-model", "claude-opus-4-8"]), deps(fakeRunner(undefined, calls)));
    expect(calls.every((c) => c.judgeModelOverride === "claude-opus-4-8")).toBe(true);
    expect(out.manifest.pins.judge.mode).toBe("override");
  });

  it("a judge model that differs across reps exits 1; a judge_invalid grade is not counted", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const withJudge = (r: RunResult, model: string, invalid = false): RunResult => ({
      ...r,
      assertions: r.assertions.map((x) =>
        x.assertion.semantic_matches
          ? { ...x, judgeModel: model, judgePromptHash: JUDGE_PROMPT_HASH, ...(invalid ? { judgeInvalid: true } : {}) }
          : x,
      ),
    });
    const onlyInvalidDiffers = await runEval(
      args(scen, a, b),
      deps(
        fakeRunner((s, r) =>
          s.scenario.name === "csv-metrics" ? r : withJudge(r, s.job.rep === 3 ? "claude-other-1" : "claude-opus-4-8", s.job.rep === 3),
        ),
      ),
    );
    expect(onlyInvalidDiffers.report.judgeDisagreements).toEqual([]);
    const p = parseEvalArgs([scen, "--arm", `before=${a}`, "--arm", `after=${b}`, "--out", join(root, "eval-j"), "--quiet"]);
    const differs = await runEval(
      p,
      deps(
        fakeRunner((s, r) =>
          s.scenario.name === "csv-metrics" ? r : withJudge(r, s.job.rep === 3 ? "claude-other-1" : "claude-opus-4-8"),
        ),
      ),
    );
    expect(differs.report.judgeDisagreements).toHaveLength(1);
    expect(differs.report.summary.exitCode).toBe(1);
  });

  it("a grade under another judge prompt is judge_prompt_mismatch", async () => {
    const { scen, a, b } = setup({ semantic: true });
    const out = await runEval(
      args(scen, a, b),
      deps(
        fakeRunner((s, r) =>
          s.scenario.name !== "csv-metrics" && s.job.arm === "after" && s.job.rep === 1
            ? { ...r, assertions: r.assertions.map((x) => (x.assertion.semantic_matches ? { ...x, judgePromptHash: "0".repeat(64) } : x)) }
            : r,
        ),
      ),
    );
    expect(out.report.arms[1].buckets).toMatchObject({ judge_prompt_mismatch: 1 });
  });
});

describe("eval: sections, refusals and the report text", () => {
  it("--holdout must be one of the eval's scenarios, and splits the report", async () => {
    const { scen, a, b } = setup({ semantic: true });
    await expect(runEval(args(scen, a, b, ["--holdout", join(root, "session.yaml")]), deps(fakeRunner()))).rejects.toThrow(
      /not one of this eval's scenarios/,
    );
    const out = await runEval(args(scen, a, b, ["--holdout", join(scen, "smoke-semantic-evidence-files.yaml")]), deps(fakeRunner()));
    expect(out.report.sections.tuned!.scenarios).toEqual(["csv-metrics"]);
    expect(out.report.sections.heldOut!.scenarios).toEqual(["smoke-semantic-evidence-files"]);
    // claims are family rows; the semantic roll-up is derived.
    expect(out.report.sections.heldOut!.rows.filter((r) => r.kind === "claim")).toHaveLength(2);
    expect(out.report.sections.heldOut!.derivedRows.map((r) => r.kind)).toEqual(["semantic_rollup"]);
  });

  it("a scenario set with no assertions is refused", async () => {
    const { scen, a, b } = setup();
    writeFileSync(join(scen, "csv-metrics.yaml"), "baseline: latest\nsession: ../session.yaml\nfidelity: container\nprompt: analyze\n");
    await expect(runEval(args(scen, a, b), deps(fakeRunner()))).rejects.toThrow(/nothing to compare/);
  });

  it("--fail-on confirmed is refused when `confirmed` is unreachable at these settings", async () => {
    const { scen, a, b } = setup();
    // --reps 4 floor 0.0286 > holm's 0.05/7.
    await expect(
      runEval(args(scen, a, b, ["--reps", "4", "--correction", "holm", "--fail-on", "confirmed"]), deps(fakeRunner())),
    ).rejects.toThrow(/can never fire/);
  });

  it("the start-up notice says how many rows `confirmed` needs", async () => {
    const { scen, a, b } = setup();
    const log: string[] = [];
    const p = parseEvalArgs([scen, "--arm", `before=${a}`, "--arm", `after=${b}`, "--out", join(root, "eval")]);
    await runEval(p, deps(fakeRunner(), log));
    expect(log.join("\n")).toMatch(/7 row\(s\) in the family; at --reps 5 one collapsed row can reach `confirmed`/);
  });

  it("report.md is redacted: a host path outside $HOME becomes <host-path>, and the count is in the header", async () => {
    // The host path is a FIXED host-shaped string, not derived from os.tmpdir(): the temp dir is host-shaped on
    // macOS (/var/folders/…) but is bare /tmp on Linux, which the host-path scan deliberately does not treat as a
    // host path — a fixture built from it cannot fail there. The run dirs reach report.md as evidence links, so
    // arm `after` fails a row in every rep (to flag it) and every run reports a dir under /Users/alice.
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b),
      deps(
        fakeRunner((s, r) => {
          const moved = { ...r, outDir: `/Users/alice/runs/csv-metrics/${s.job.runId}` };
          return s.job.arm === "after" ? failAssertion(moved, 2) : moved;
        }),
      ),
    );
    const md = readFileSync(join(out.evalDir, "report.md"), "utf8");
    expect(md).toMatch(/Evidence \(run dirs/);
    expect(md).not.toContain("/Users/alice");
    expect(md).toContain("<host-path>");
    expect(md).toMatch(/Host paths redacted: [1-9]\d*\./);
    // Nothing host-shaped survives, whichever platform's temp dir the eval dir lives in.
    expect(hostPathTokens(md)).toEqual([]);
  });

  it("the header carries the required lines", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    const md = readFileSync(join(out.evalDir, "report.md"), "utf8");
    for (const re of [
      /Units: runs × grades/,
      /A \(baseline\): before/,
      /B \(candidate\): after/,
      /No control arm: prior-answerable claims are not flagged/,
      /Attainable p floor at 5 vs 5 valid reps: 0\.0079/,
      /`confirmed` needs ≥ 1 row\(s\) at the floor; confirmable rows now: 7/,
      /Ceiling: 7 row\(s\) at 100% in both arms: an improvement is undetectable for them/,
      /errorSource none 5/,
      /medians over 5 scored rep\(s\): cost \$0\.2161/,
    ])
      expect(md).toMatch(re);
  });
});

describe("eval: seams in existing modules", () => {
  it("launchSourcesPreflight checks the SUBSTITUTED session when one is passed (not the session file's)", async () => {
    const { scen } = setup();
    const { launchSourcesPreflight, parseScenarioFile, loadSessionFromFile } = await import("../src/run/execute.js");
    const { applySessionOverrides } = await import("../src/session.js");
    const scenario = parseScenarioFile(join(scen, "csv-metrics.yaml"));
    const file = loadSessionFromFile(scenario.session);
    expect(() => launchSourcesPreflight(scenario, undefined, { quiet: true })).not.toThrow();
    const broken = applySessionOverrides(file, {
      skillDirSubstitution: [file.plugins.local_plugins[0], join(root, "gone", "csv-metrics")],
    });
    expect(() => launchSourcesPreflight(scenario, undefined, { quiet: true, session: broken })).toThrow(/gone/);
  });

  it("sourceRead: a reference read or a SKILL.md-naming tool call; unobservable with neither channel", async () => {
    const { sourceReadFact } = await import("../src/eval/invocation.js");
    expect(sourceReadFact({})).toBe("unobservable");
    expect(sourceReadFact({ toolCalls: [], referencesAccessed: [] })).toBe(false);
    expect(sourceReadFact({ referencesAccessed: [{ path: "references/x.md", via: ["read"] }] })).toBe(true);
    expect(
      sourceReadFact({ toolCalls: [{ name: "Read", origin: "main", input: { file_path: { text: "/mnt/p/skills/x/SKILL.md" } } }] }),
    ).toBe(true);
    expect(sourceReadFact({ toolCalls: [{ name: "Write", origin: "main", input: { file_path: { text: "SKILL.md" } } }] })).toBe(false);
  });
});

// The CLI plumbing over the built binary: `eval report` rebuilds byte-identically, and the envelope's `ok`
// and the process exit follow the report's exit code. Skips without dist/cli.js (the `ci` script builds first).
const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
describe.skipIf(!existsSync(CLI))("eval: the CLI wrapper", () => {
  it("`eval report <dir> --output-format json` is byte-identical and exits with the report's code", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b, ["--fail-on", "possible"]),
      deps(fakeRunner((s, r) => (s.job.arm === "after" ? failAssertion(r, 2) : r))),
    );
    const md = readFileSync(join(out.evalDir, "report.md"));
    const r = spawnSync("node", [CLI, "eval", "report", out.evalDir, "--output-format", "json"], { encoding: "utf8", cwd: root });
    expect(r.status, r.stderr).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ tool: "cowork-harness", command: "eval", ok: false, error: null, stoppedEarly: null });
    expect(env.summary.failOnHit).toBe(true);
    expect(readFileSync(join(out.evalDir, "report.md")).equals(md)).toBe(true);
  });

  it("a snapshot staging failure is exit 3 with a boundary envelope", () => {
    const { scen, a, b } = setup();
    const locked = join(b, "skills", "csv-metrics", "locked.md");
    writeFileSync(locked, "x");
    chmodSync(locked, 0o000);
    try {
      const r = spawnSync("node", [CLI, "eval", scen, "--arm", a, "--arm", b, "--out", join(root, "e3"), "--output-format", "json"], {
        encoding: "utf8",
        cwd: root,
      });
      expect(r.status, r.stderr).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({ command: "eval", ok: false, error: { category: "boundary" } });
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it("a refusal before any run is exit 2 with the error envelope", () => {
    const { scen, a, b } = setup();
    const r = spawnSync(
      "node",
      [CLI, "eval", scen, "--arm", a, "--arm", b, "--model", "opus", "--out", join(root, "e"), "--output-format", "json"],
      {
        encoding: "utf8",
        cwd: root,
      },
    );
    expect(r.status, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: "eval", ok: false, error: { category: "usage" } });
  });
});

describe("eval: the run id carries nothing about the eval or the arm", () => {
  it("both arms' ids have one shape, and the rendered system prompt differs between arms only by that id", async () => {
    const { scen, a, b } = setup();
    const calls: EvalJobSpec[] = [];
    const p = parseEvalArgs([scen, "--arm", `zqxbaseline=${a}`, "--arm", `zqxcandidate=${b}`, "--out", join(root, "eval"), "--quiet"]);
    await runEval(p, deps(fakeRunner(undefined, calls)));
    const { renderPrompts } = await import("../src/prompt.js");
    const baseline = loadBaseline("latest");
    for (const rep of [1, 2]) {
      const pair = calls.filter((c) => c.job.rep === rep);
      expect(pair).toHaveLength(2);
      const rendered = pair.map((c) => {
        for (const tier of ["container", "hostloop"] as const) {
          const text = JSON.stringify(
            renderPrompts(baseline, c.session, c.job.runId, undefined, {
              effectiveFidelity: tier,
              hostCwd: join(runOutDir(c.scenario.name, c.job.runId), "work", "session", "mnt"),
            }),
          );
          expect(text).not.toMatch(/zqxbaseline|zqxcandidate|test1|eval/i);
        }
        expect(c.job.runId).not.toMatch(/zqx|eval|test1|csv/);
        return JSON.stringify(renderPrompts(baseline, c.session, c.job.runId, undefined, { effectiveFidelity: "container" }))
          .split(c.job.runId)
          .join("<id>");
      });
      expect(rendered[0]).toBe(rendered[1]);
    }
  });
});

describe("eval: answer-key guard through links and git arms", () => {
  it("a SYMLINK in an arm that resolves to one of the eval's scenario files is refused", async () => {
    const { scen, a, b } = setup();
    symlinkSync(join(scen, "csv-metrics.yaml"), join(b, "notes.yaml"));
    await expect(runEval(args(scen, a, b), deps(fakeRunner()))).rejects.toThrow(/answer-key guard/);
  });

  it("any link resolving outside the snapshot is refused (it could reach answers, or change mid-eval)", async () => {
    const { scen, a, b } = setup();
    const log: string[] = [];
    writeFileSync(join(root, "elsewhere.md"), "not an eval file");
    symlinkSync(join(root, "elsewhere.md"), join(b, "shared.md"));
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    const err = await runEval(args(scen, a, b), deps(fakeRunner(), log))
      .catch((e: Error) => e)
      .finally(() => spy.mockRestore());
    expect(err).toBeInstanceOf(UsageError);
    const msg = (err as Error).message;
    // The target is named as the SOURCE sees it (the snapshot is gone once the eval is refused).
    expect(msg).toContain(`shared.md -> ${join(root, "elsewhere.md")}`);
    expect(msg).not.toContain(join(root, "eval"));
    expect(msg).toMatch(/symlink outside.*To fix: replace the link with the files, or point it inside the plugin\.$/);
    expect(msg).not.toMatch(/Move the scenarios/);
    // Refused before the signatures are computed, so the fingerprint walk printed nothing about the link.
    expect([...log, ...stderr].join("\n")).not.toMatch(/escaping symlink/);
  });

  it("a symlinked evals.json in an arm is refused", async () => {
    const { scen, a, b } = setup();
    writeFileSync(join(root, "evals.json"), "{}");
    symlinkSync(join(root, "evals.json"), join(b, "evals.json"));
    await expect(runEval(args(scen, a, b), deps(fakeRunner()))).rejects.toThrow(/answer-key guard.*evals json/);
  });

  it("a git: arm whose path holds the eval's scenario (in the working tree) is refused", async () => {
    const { b } = setup();
    const repo = join(root, "grepo2");
    writePlugin(join(repo, "plugins", "csv-metrics"), "committed");
    const scenDir = join(repo, "plugins", "csv-metrics", "evals");
    mkdirSync(scenDir, { recursive: true });
    writeFileSync(join(root, "session2.yaml"), "model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared/csv-metrics\n");
    writeFileSync(
      join(scenDir, "csv-metrics.yaml"),
      `baseline: latest\nsession: ${join(root, "session2.yaml")}\nfidelity: container\nprompt: analyze\n${CSV_ASSERTS}`,
    );
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "plugins/csv-metrics/.claude-plugin", "plugins/csv-metrics/skills"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"], { cwd: repo });
    const p = parseEvalArgs([
      join(scenDir, "csv-metrics.yaml"),
      "--arm",
      "base=git:HEAD:plugins/csv-metrics",
      "--arm",
      `new=${b}`,
      "--out",
      join(root, "eval"),
      "--quiet",
    ]);
    await expect(runEval(p, { ...deps(fakeRunner()), cwd: repo })).rejects.toThrow(/answer-key guard.*inside source/);
  });
});

describe("eval: dir-arm snapshots keep symlinks verbatim", () => {
  it("a relative link stays relative (it cannot reach back into the live source)", async () => {
    const { scen, a, b } = setup();
    symlinkSync("SKILL.md", join(b, "skills", "csv-metrics", "alias.md"));
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    const snapLink = join(out.evalDir, "arms", "after", "csv-metrics", "skills", "csv-metrics", "alias.md");
    expect(lstatSync(snapLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(snapLink)).toBe("SKILL.md");
  });
});

describe("eval: a plugin with several skills", () => {
  it("runs without --skill; invocation is then unobservable", async () => {
    const { scen, a, b } = setup();
    for (const d of [a, b]) {
      mkdirSync(join(d, "skills", "second"), { recursive: true });
      writeFileSync(join(d, "skills", "second", "SKILL.md"), "---\nname: second\ndescription: d\n---\nx\n");
    }
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    expect(out.manifest.skill).toBeNull();
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    expect(lines.every((l) => l.evidence?.invoked === "unobservable")).toBe(true);
    // --skill names one and records it.
    const withSkill = await runEval(
      parseEvalArgs([scen, "--arm", `before=${a}`, "--arm", `after=${b}`, "--out", join(root, "eval-s"), "--quiet", "--skill", "second"]),
      deps(fakeRunner()),
    );
    expect(withSkill.manifest.skill).toBe("second");
  });
});

describe("eval: discovery, preflight and small persistence fixes", () => {
  it("a scenario directory holding its session file (_session.yaml) runs: non-scenario YAML is skipped with a notice", async () => {
    const plugin = join(import.meta.dirname, "..", ".claude", "skills", "cowork-harness");
    const a = join(root, "a", "cowork-harness");
    const b = join(root, "b", "cowork-harness");
    cpSync(plugin, a, { recursive: true });
    cpSync(plugin, b, { recursive: true });
    writeFileSync(join(b, "SKILL.md"), readFileSync(join(b, "SKILL.md"), "utf8") + "\nedited\n");
    const log: string[] = [];
    const scen = join(import.meta.dirname, "evals", "scenarios");
    const p = parseEvalArgs([
      scen,
      "--arm",
      `before=${a}`,
      "--arm",
      `after=${b}`,
      "--out",
      join(root, "eval"),
      "--reps",
      "2",
      "--allow-underpowered",
    ]);
    const out = await runEval(p, deps(fakeRunner(), log));
    expect(log.join("\n")).toMatch(/skipped 2 non-scenario file\(s\): _session\.yaml, eval-7-session\.yaml/);
    expect(out.manifest.scenarios.length).toBeGreaterThan(10);
  }, 120_000);

  it("a scenario its tier cannot violate is refused before any run (not failed in every job)", async () => {
    const { scen, a, b } = setup();
    writeFileSync(
      join(scen, "csv-metrics.yaml"),
      `baseline: latest\nsession: ../session.yaml\nfidelity: hostloop\nprompt: analyze\nassert:\n  - tool_not_called: NotebookEdit\n`,
    );
    const calls: EvalJobSpec[] = [];
    await expect(runEval(args(scen, a, b), deps(fakeRunner(undefined, calls)))).rejects.toThrow(/can never be violated/);
    expect(calls).toHaveLength(0);
  });

  it("two sessions spelling the same plugin differently (a symlinked path) are substituted per session", async () => {
    const { scen, a, b } = setup();
    symlinkSync(join(root, "declared"), join(root, "declared-link"));
    writeFileSync(join(root, "session-b.yaml"), "model: claude-sonnet-5\nplugins:\n  local_plugins:\n    - ./declared-link/csv-metrics\n");
    writeFileSync(
      join(scen, "other.yaml"),
      `baseline: latest\nsession: ../session-b.yaml\nfidelity: container\nprompt: analyze\n${CSV_ASSERTS}`,
    );
    const calls: EvalJobSpec[] = [];
    const out = await runEval(args(scen, a, b), deps(fakeRunner(undefined, calls)));
    for (const c of calls) expect(c.session.plugins.local_plugins).toEqual([join(out.evalDir, "arms", c.job.arm, "csv-metrics")]);
  });

  it("an existing EMPTY --out is left empty by a refusal", async () => {
    const { scen, a } = setup();
    mkdirSync(join(root, "eval"));
    await expect(runEval(args(scen, a, a), deps(fakeRunner()))).rejects.toThrow(/identical/);
    expect(readdirSync(join(root, "eval"))).toEqual([]);
  });

  it("report.json lists every rep with its bucket", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(
      args(scen, a, b),
      deps(fakeRunner((s, r) => (s.job.arm === "after" && s.job.rep === 1 ? { ...r, modelPinHonored: false } : r))),
    );
    const rj = JSON.parse(readFileSync(join(out.evalDir, "report.json"), "utf8"));
    expect(rj.reps).toHaveLength(10);
    expect(rj.reps.find((x: { arm: string; rep: number }) => x.arm === "after" && x.rep === 1).bucket).toBe("model_mismatch");
    expect(rj.reps.filter((x: { bucket: string }) => x.bucket === "valid")).toHaveLength(9);
  });

  it("runs.jsonl keeps an absent models[] absent (not [])", async () => {
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner((_s, r) => ({ ...r, models: undefined }) as unknown as RunResult)));
    const { lines } = readRunsLines(join(out.evalDir, "runs.jsonl"));
    expect(lines.every((l) => !("models" in l))).toBe(true);
  });

  it("the work-tree check fails CLOSED when git errors for a reason other than 'not a repository'", async () => {
    const { isInsideGitWorkTree } = await import("../src/eval/snapshot.js");
    const bin = join(root, "fakegit");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'fatal: detected dubious ownership in repository' >&2\nexit 128\n");
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      expect(() => isInsideGitWorkTree(join(root, "somewhere"))).toThrow(/could not tell/);
    } finally {
      process.env.PATH = saved;
    }
    expect(isInsideGitWorkTree(join(root, "somewhere"))).toBe(false);
  });
});

describe("eval: wiring the in-process runs cannot see by default", () => {
  it("--correction reaches the labels: one collapse among 7 rows is confirmed under bh, only possible under holm", async () => {
    const { scen, a, b } = setup();
    const flip = (s: EvalJobSpec, r: RunResult) => (s.job.arm === "after" ? failAssertion(r, 2) : r);
    const bh = await runEval(args(scen, a, b), deps(fakeRunner(flip)));
    const rb = bh.report.sections.tuned!.rows.find((r) => r.assertionIndex === 2)!;
    expect(rb.label).toBe("confirmed drop");
    expect(rb.interval!.upper).toBeLessThan(0); // B - A: a drop is negative
    const p = parseEvalArgs([
      scen,
      "--arm",
      `before=${a}`,
      "--arm",
      `after=${b}`,
      "--out",
      join(root, "eval-h"),
      "--quiet",
      "--correction",
      "holm",
    ]);
    const ho = await runEval(p, deps(fakeRunner(flip)));
    expect(ho.report.sections.tuned!.rows.find((r) => r.assertionIndex === 2)!.label).toBe("possible drop");
  });

  it("a drop on a semantic roll-up row alone gates --fail-on possible (and is never confirmed)", async () => {
    const { scen, a, b } = setup({ semantic: true });
    // Flip: only the semantic assertion's own pass (index 3) in `after`; its claims stay passing. Marked as
    // GRADED: without a recorded reason, a single-key semantic fail whose claims met min_pass can only have
    // been an evidence refusal (that is how a pre-reason runs.jsonl is read), and its rows would be excluded.
    const flip = (s: EvalJobSpec, r: RunResult) => {
      if (s.job.arm !== "after" || s.scenario.name === "csv-metrics") return r;
      const f = failAssertion(r, 3);
      return { ...f, assertions: f.assertions.map((x, i) => (i === 3 ? { ...x, semanticEvidence: { reason: "graded" as const } } : x)) };
    };
    const out = await runEval(args(scen, a, b, ["--fail-on", "possible"]), deps(fakeRunner(flip)));
    const rollup = out.report.sections.tuned!.derivedRows[0];
    expect(rollup).toMatchObject({ kind: "semantic_rollup", k1: 5, k2: 0, label: "possible drop" });
    expect(out.report.sections.tuned!.rows.every((r) => !r.label.endsWith("drop"))).toBe(true);
    expect(out.report.summary.failOnHit).toBe(true);
    expect(out.report.summary.exitCode).toBe(1);
  });

  it("the preflight checks the arm's SUBSTITUTED session: a declared plugin dir that does not exist is fine", async () => {
    const { scen, a, b } = setup();
    rmSync(join(root, "declared"), { recursive: true });
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    expect(out.report.arms.map((x) => x.buckets)).toEqual([{ valid: 5 }, { valid: 5 }]);
  });
});

describe("executeScenario's pre-assigned run id guards", () => {
  async function scenario() {
    const { scen } = setup();
    const { parseScenarioFile } = await import("../src/run/execute.js");
    return parseScenarioFile(join(scen, "csv-metrics.yaml"));
  }
  it("refuses an id that is not local_ + 8-32 base36 characters", async () => {
    const { executeScenario } = await import("../src/run/execute.js");
    const s = await scenario();
    for (const bad of ["sess-abcdefgh", "local_ABCDEFGH", "local_abc", "local_../../x"])
      await expect(executeScenario(s, { runId: bad })).rejects.toThrow(/must be local_ followed by 8-32 base36/);
  });
  it("refuses a run id combined with a session id (or a resume of one)", async () => {
    const { executeScenario } = await import("../src/run/execute.js");
    const s = await scenario();
    await expect(executeScenario(s, { runId: "local_abcdefgh12345", sessionId: "x" })).rejects.toThrow(
      /cannot be combined with --session-id or --resume/,
    );
    await expect(executeScenario(s, { runId: "local_abcdefgh12345", sessionId: "x", resume: true })).rejects.toThrow(
      /cannot be combined|cannot resume/,
    );
  });
  it("refuses to reuse an id whose run dir exists; a fresh one passes the guard (and stops at the spawn guard)", async () => {
    const { executeScenario, runOutDir } = await import("../src/run/execute.js");
    const s = await scenario();
    mkdirSync(runOutDir(s.name, "local_usedusedused1"), { recursive: true });
    await expect(executeScenario(s, { runId: "local_usedusedused1" })).rejects.toThrow(/never reused/);
    await expect(executeScenario(s, { runId: "local_freshfreshfr1" })).rejects.toThrow(/COWORK_HARNESS_FORBID_SPAWN/);
  });
});

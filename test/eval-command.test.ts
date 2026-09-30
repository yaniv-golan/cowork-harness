// The `eval` command, driven in-process with a FAKE runner — nothing here runs an agent or spends a token.
//
// The fake returns RunResults built from the real kept-run excerpts in test/fixtures/eval-classify/ (the
// same corpus the classifier is tested over). Two fields are set by the fake rather than read from the
// excerpt, and each is set the way a real run sets it:
//   - `fingerprint` comes from the SAME `buildFingerprint(...)` call `executeScenario` makes, over the job's
//     own session — so the drift test below is a real drift, not a string the test chose;
//   - `outDir` is the pre-assigned `<runs-root>/<slug>/sess-<sessionId>` dir.
// A per-arm behaviour may flip individual assertion bits (to create a drop to detect); every such flip is
// named in the test that does it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError, UnansweredError } from "../src/errors.js";
import type { RunResult } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { buildFingerprint } from "../src/run/cassette.js";
import { slugForPath } from "../src/run/execute.js";
import { JUDGE_PROMPT_HASH } from "../src/decide/semantic-judge.js";
import { runEval, parseEvalArgs, type EvalJobSpec } from "../src/eval/command.js";
import { writeEvalReport } from "../src/eval/report.js";
import { readRunsLines } from "../src/eval/runs.js";
import { classifyRep } from "../src/eval/classify.js";
import { repEvidenceOf } from "../src/eval/runs.js";
import { isConcreteModelId } from "../src/run/model-provenance.js";

const FX = join(import.meta.dirname, "fixtures", "eval-classify");
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
    const outDir = join(runsRoot, slugForPath(spec.scenario.name), `sess-${spec.job.sessionId}`);
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

const deps = (runJob: (s: EvalJobSpec) => Promise<RunResult>, log: string[] = []) => ({
  runJob,
  log: (s: string) => log.push(s),
  evalId: "test1",
  now: () => new Date("2026-09-30T00:00:00Z"),
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "eval-cmd-")));
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
  it("defaults: reps 5, concurrency 2, bh, fail-on possible", () => {
    const p = parseEvalArgs(base);
    expect(p).toMatchObject({ reps: 5, concurrency: 2, correction: "bh", failOn: "possible", alpha: 0.05 });
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
      expect(c.job.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
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

  it("a collapsed row is a drop: exit 1 under the default --fail-on possible, with evidence links", async () => {
    const { scen, a, b } = setup();
    // Flip: arm `after` fails `tool_called: Bash` (index 2) in every rep.
    const out = await runEval(args(scen, a, b), deps(fakeRunner((s, r) => (s.job.arm === "after" ? failAssertion(r, 2) : r))));
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

  it("a `possible` (unconfirmed) drop fails the eval under the DEFAULT --fail-on", async () => {
    const { scen, a, b } = setup();
    // Flip: `after` fails index 2 in 4 of 5 reps — p = 0.048: possible, not confirmed.
    const out = await runEval(
      args(scen, a, b),
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
    expect(line.runDir).toContain("sess-eval-test1-after-csv-metrics-r2");
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
    const { scen, a, b } = setup();
    const out = await runEval(args(scen, a, b), deps(fakeRunner()));
    const md = readFileSync(join(out.evalDir, "report.md"), "utf8");
    expect(md).not.toContain(root);
    expect(md).toMatch(/Host paths redacted: [1-9]\d*\./);
    expect(md).toContain("<host-path>");
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
    const out = await runEval(args(scen, a, b), deps(fakeRunner((s, r) => (s.job.arm === "after" ? failAssertion(r, 2) : r))));
    const md = readFileSync(join(out.evalDir, "report.md"));
    const r = spawnSync("node", [CLI, "eval", "report", out.evalDir, "--output-format", "json"], { encoding: "utf8", cwd: root });
    expect(r.status, r.stderr).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ tool: "cowork-harness", command: "eval", ok: false, error: null, stoppedEarly: null });
    expect(env.summary.failOnHit).toBe(true);
    expect(readFileSync(join(out.evalDir, "report.md")).equals(md)).toBe(true);
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

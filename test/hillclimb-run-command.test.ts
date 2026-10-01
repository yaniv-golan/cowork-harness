// `hillclimb run` end to end above the scenario runner: case preparation, the variant's plugin snapshot, the
// session pointed at that snapshot, eval's answer-key guard, and the rows. The scenario runner is a fake that
// records what it was asked to run and returns a committed real excerpt (test/fixtures/eval-classify/
// success-semantic.json) with the public csv-metrics run's init/result frames. Nothing spawns.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { defaultSnapshotRoot, runHillclimbCommand, snapshotRootFrom, type RunCommandDeps } from "../src/hillclimb/run-command.js";
import { parseHillclimbRunArgs } from "../src/hillclimb/args.js";
import { checkFlowDir } from "../src/hillclimb/schema-check.js";
import { buildFingerprint } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import type { SessionConfig } from "../src/session.js";
import type { RunResult, Scenario } from "../src/types.js";

const FX = join(import.meta.dirname, "fixtures");
const excerpt = JSON.parse(readFileSync(join(FX, "eval-classify", "success-semantic.json"), "utf8")) as RunResult;
const frames = readFileSync(join(FX, "hillclimb-runs", "result-event-pair.jsonl"), "utf8")
  .trim()
  .split("\n");
const MODEL = "claude-sonnet-5";

let cwd: string;
let plugin: string;
let snaps: string;
let err: string[];
let calls: Array<{ scenario: Scenario; extra: Record<string, unknown> }>;

const SCENARIO = `name: Alpha
baseline: latest
session: ./_session.yaml
fidelity: container
prompt: do the thing
assert:
  - skill_triggered: "<redacted>"
  - tool_no_error: "<redacted>"
  - max_tool_errors: 0
  - semantic_matches:
      rubric: ["claim 1", "claim 2", "claim 3", "claim 4", "claim 5"]
      min_pass: 3
      judge_model: "claude-haiku-4-5-20251001"
      include_subagent_text: false
`;

let skillActivity: Array<{ skillId: string }> | undefined;
/** The run's init-frame skill inventory, as the binary registered the plugin's skills. */
let inventory: string[];
let authored: Record<string, string> | undefined;
let judgeTransport: object | undefined;
const rows = () =>
  readFileSync(join(cwd, "flow", "baseline", "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function deps(over: Partial<RunCommandDeps> = {}): RunCommandDeps {
  return {
    cwd,
    env: {},
    snapshotRoot: snaps,
    secrets: ["sk-test-SECRET-9"],
    stderr: (l) => err.push(l),
    flags: {},
    isolationCheck: () => undefined,
    runScenario: async (a) => {
      calls.push({ scenario: a.scenario, extra: a.extra as Record<string, unknown> });
      const outDir = join(cwd, "runs", String(a.extra.runId));
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, "events.jsonl"),
        [frames[0], JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { model: MODEL } }), frames[1]].join("\n"),
      );
      // A real run stamps the signature of the session it staged; so does this fake.
      const b = loadBaseline(a.scenario.baseline);
      const fp = buildFingerprint(a.scenario.session, b.appVersion, undefined, a.scenario.skills, b, a.extra.session as SessionConfig);
      // A real run echoes the scenario's own assertions on its grades (the excerpt's judge_model is redacted).
      const assertions = excerpt.assertions.map((g, i) => ({
        ...g,
        assertion: a.scenario.assert[i],
        // a real run records how a semantic grade's judge ran on that grade
        ...(judgeTransport && a.scenario.assert[i]?.semantic_matches ? { judgeTransport } : {}),
      }));
      // Files the run authored, in its work dir, as a real run records them.
      const work = join(outDir, "work");
      for (const [rel, body] of Object.entries(authored ?? {})) {
        mkdirSync(join(work, rel, ".."), { recursive: true });
        writeFileSync(join(work, rel), body);
      }
      const authoredFields = authored
        ? { workDir: work, artifacts: Object.entries(authored).map(([path, b]) => ({ path, bytes: b.length })), preRunPaths: [] }
        : { workDir: undefined, artifacts: undefined };
      return {
        ...excerpt,
        ...authoredFields,
        outDir,
        assertions,
        ...(skillActivity
          ? { skillActivity, prompt: a.scenario.prompt, context: { availableSkills: inventory.map((id) => ({ id })) } }
          : {}),
        fingerprint: { ...excerpt.fingerprint, contentSig: fp.contentSig, skillHash: fp.skillHash },
      } as RunResult;
    },
    ...over,
  };
}
const args = (...a: string[]) => {
  const p = parseHillclimbRunArgs(["evals", "--flow", "flow", "--concurrency", "1", ...a]);
  if (p.help) throw new Error("help");
  return p;
};

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "hc-rc-")));
  plugin = join(realpathSync(mkdtempSync(join(tmpdir(), "hc-rc-plugin-"))), "my-plugin");
  mkdirSync(join(plugin, "skills", "x"), { recursive: true });
  writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nround 1\n");
  snaps = realpathSync(mkdtempSync(join(tmpdir(), "hc-rc-snaps-")));
  mkdirSync(join(cwd, "evals"));
  writeFileSync(join(cwd, "evals", "_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
  writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO);
  err = [];
  calls = [];
  skillActivity = undefined;
  inventory = ["my-plugin:x"];
  authored = undefined;
  judgeTransport = undefined;
});
afterEach(() => {
  for (const d of [cwd, join(plugin, ".."), snaps]) rmSync(d, { recursive: true, force: true });
});

describe("runHillclimbCommand", () => {
  it("a pass runs the case from a snapshot of the plugin, never from the live dir", async () => {
    expect((await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps())).exitCode).toBe(0);
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(0);
    const session = calls[0].extra.session as { plugins: { local_plugins: string[] } };
    expect(session.plugins.local_plugins[0]).toMatch(new RegExp(`^${snaps}/[0-9a-f]{16}/baseline/my-plugin$`));
    expect(readFileSync(join(session.plugins.local_plugins[0], "skills", "x", "SKILL.md"), "utf8")).toMatch(/round 1/);
    expect(existsSync(join(cwd, "flow", "baseline", "results.jsonl"))).toBe(true);
  });

  it("reps appended later run from the same snapshot after the live plugin moved on, and say it moved", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args(), deps());
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nround 2\n");
    await runHillclimbCommand(args("--reps", "2"), deps());
    const s = calls[1].extra.session as { plugins: { local_plugins: string[] } };
    expect(readFileSync(join(s.plugins.local_plugins[0], "skills", "x", "SKILL.md"), "utf8")).toMatch(/round 1/);
    expect(err.join("\n")).toMatch(/live plugin .* differs from variant baseline's snapshot/);
  });

  it("a variant with rows whose snapshot is gone is refused before spend", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args(), deps());
    rmSync(snaps, { recursive: true, force: true });
    mkdirSync(snaps);
    calls = [];
    const r = await runHillclimbCommand(args("--reps", "2"), deps());
    expect(r.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it("a plain --dry-run takes no snapshot and runs nothing", async () => {
    const r = await runHillclimbCommand(args("--dry-run"), deps());
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(join(snaps))).toBe(true);
    expect(readdirSync(snaps)).toEqual([]);
  });

  it("a scenario inside the plugin the loop edits is refused: the agent could read the rubric", async () => {
    writeFileSync(join(plugin, "alpha.yaml"), SCENARIO.replace("./_session.yaml", join(cwd, "evals", "_session.yaml")));
    const a = parseHillclimbRunArgs([join(plugin, "alpha.yaml"), "--flow", "flow", "--concurrency", "1", "--approve-harness"]);
    if (a.help) throw new Error("help");
    const r = await runHillclimbCommand(a, deps());
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/answer-key/);
  });

  it("a harness_paths entry inside the plugin is refused: the gate would stop every round", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    const st = JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8"));
    writeFileSync(join(cwd, "flow", "_state.json"), JSON.stringify({ ...st, harness_paths: [join(plugin, "skills", "x", "SKILL.md")] }));
    const r = await runHillclimbCommand(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/inside the plugin the loop edits/);
  });

  it("skill_invoked records whether the run invoked the plugin's one skill, judged against the snapshot", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:x" }];
    await runHillclimbCommand(args(), deps());
    skillActivity = [];
    await runHillclimbCommand(args("--reps", "2"), deps());
    expect(rows().map((r) => r.skill_invoked)).toEqual([1, 0]);
  });

  it("a case whose input the stager would refuse is refused before spend", async () => {
    writeFileSync(
      join(cwd, "evals", "_session.yaml"),
      `model: ${MODEL}\nuploads:\n  - ./missing.csv\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
    );
    const r = await runHillclimbCommand(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(err.join("\n")).toMatch(/case alpha: .*missing\.csv/);
  });

  it("--dry-run prices the remaining slots on eval's basis: plain runs only, every hillclimb run excluded", async () => {
    const row = (costUsd: number, runLabel?: string) => ({
      v: 1,
      ts: "2026-10-01T00:00:00Z",
      command: "run",
      scenario: "Alpha",
      slug: "Alpha",
      runId: `local_${costUsd}`,
      fidelity: "container",
      baseline: loadBaseline("latest").appVersion,
      result: "success",
      pass: true,
      signals: [],
      costUsd,
      ...(runLabel ? { runLabel } : {}),
    });
    const indexRows = () => [row(1, "hillclimb:flow:baseline"), row(3), row(100, "hillclimb:flow-null:baseline")] as never;
    const r = await runHillclimbCommand(args("--dry-run", "--reps", "2"), deps({ indexRows }));
    expect(r.exitCode).toBe(0);
    // the flow's own hillclimb run ($1) and another flow's ($100) are both out; only the plain $3 run prices
    expect(r.cost).toMatchObject({ jobs: 2, pricedRuns: 1, worstObservedUsd: 6, meanUsd: 6, lowerBound: false, unpriced: [] });
    expect(err.join("\n")).toMatch(/estimated cost of 2 run\(s\)/);
  });

  it("--dry-run with no priced history says the estimate is a lower bound", async () => {
    const r = await runHillclimbCommand(args("--dry-run"), deps({ indexRows: () => [] }));
    expect(r.cost).toMatchObject({ jobs: 1, lowerBound: true, unpriced: ["Alpha"], thinnest: null });
  });

  it("--dry-run prices only the slots a pass would still run (resume), not every rep", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
    await runHillclimbCommand(args(), deps());
    const r = await runHillclimbCommand(args("--dry-run", "--reps", "3"), deps({ indexRows: () => [] }));
    expect(r.cost?.jobs).toBe(2);
  });

  it("rows record the skill hash the run itself staged (meta.skill_hash), beside its content signature", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
    await runHillclimbCommand(args(), deps());
    const meta = rows()[0].meta as Record<string, unknown>;
    expect(meta.skill_hash).toMatch(/^[0-9a-f]{8,}/);
    expect(meta.content_sig).toBeDefined();
  });

  describe("input attachments", () => {
    const withUpload = (body: string) => {
      writeFileSync(join(cwd, "evals", "input.csv"), body);
      writeFileSync(
        join(cwd, "evals", "_session.yaml"),
        `model: ${MODEL}\nuploads:\n  - ./input.csv\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
      );
    };
    const pass = async (...extra: string[]) => {
      await runHillclimbCommand(args("--approve-harness", "--dry-run", ...extra), deps({ indexRows: () => [] }));
      return runHillclimbCommand(args(...extra), deps());
    };

    it("a session upload is copied content-addressed under inputs/ and attached to the row", async () => {
      withUpload("a,b\n1,2\n");
      expect((await pass()).exitCode).toBe(0);
      const sha16 = createHash("sha256").update("a,b\n1,2\n").digest("hex").slice(0, 16);
      expect(rows()[0].attachments).toEqual([{ kind: "text", ref: `inputs/${sha16}-input.csv` }]);
      expect(readFileSync(join(cwd, "flow", "inputs", `${sha16}-input.csv`), "utf8")).toBe("a,b\n1,2\n");
      // The ref resolves to a regular file in the flow, by our schema reading.
      expect(checkFlowDir(join(cwd, "flow"), { profile: "harness" }).findings.filter((f) => f.rule.startsWith("attachments"))).toEqual([]);
    });

    it("--no-copy-inputs attaches nothing, copies nothing, and says so on the row", async () => {
      withUpload("a,b\n");
      expect((await pass("--no-copy-inputs")).exitCode).toBe(0);
      expect(rows()[0]).not.toHaveProperty("attachments");
      expect((rows()[0].meta as Record<string, unknown>).inputs_not_copied).toBe(true);
      expect(existsSync(join(cwd, "flow", "inputs"))).toBe(false);
    });

    it("a secret in a text upload never reaches the flow", async () => {
      withUpload("key,sk-test-SECRET-9\n");
      expect((await pass()).exitCode).toBe(0);
      const ref = (rows()[0].attachments as Array<{ ref: string }>)[0].ref;
      expect(readFileSync(join(cwd, "flow", ref), "utf8")).not.toContain("sk-test-SECRET-9");
    });

    it("an upload that is the scenario itself is still refused: the agent would read the rubric", async () => {
      writeFileSync(
        join(cwd, "evals", "_session.yaml"),
        `model: ${MODEL}\nuploads:\n  - ./alpha.yaml\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
      );
      const r = await runHillclimbCommand(args("--approve-harness"), deps());
      expect(r.exitCode).toBe(2);
      expect(calls).toEqual([]);
      expect(err.join("\n")).toMatch(/could read .*alpha\.yaml/);
    });

    it("a secret in an upload with an extension outside the kind map (.yaml) never reaches the flow either", async () => {
      writeFileSync(join(cwd, "evals", "input.yaml"), "key: sk-test-SECRET-9\n");
      writeFileSync(
        join(cwd, "evals", "_session.yaml"),
        `model: ${MODEL}\nuploads:\n  - ./input.yaml\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
      );
      expect((await pass()).exitCode).toBe(0);
      const ref = (rows()[0].attachments as Array<{ ref: string }>)[0].ref;
      expect(readFileSync(join(cwd, "flow", ref), "utf8")).not.toContain("sk-test-SECRET-9");
    });

    it("an upload declared through a symlink is attached (the run mounts it too)", async () => {
      writeFileSync(join(cwd, "real.csv"), "a,b\n");
      symlinkSync(join(cwd, "real.csv"), join(cwd, "evals", "input.csv"));
      writeFileSync(
        join(cwd, "evals", "_session.yaml"),
        `model: ${MODEL}\nuploads:\n  - ./input.csv\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
      );
      expect((await pass()).exitCode).toBe(0);
      expect(rows()[0].attachments).toHaveLength(1);
    });

    it("a case with no uploads carries no attachments and no flag", async () => {
      expect((await pass()).exitCode).toBe(0);
      expect(rows()[0]).not.toHaveProperty("attachments");
      expect(rows()[0].meta as Record<string, unknown>).not.toHaveProperty("inputs_not_copied");
    });
  });

  it("--judge-model reaches every run as its judge override, so a scenario's own (even alias) judge_model is never used", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace('judge_model: "claude-haiku-4-5-20251001"', "judge_model: haiku"));
    await runHillclimbCommand(args("--approve-harness", "--dry-run", "--judge-model", "claude-opus-4-8"), deps({ indexRows: () => [] }));
    await runHillclimbCommand(args("--judge-model", "claude-opus-4-8"), deps());
    expect(calls).toHaveLength(1);
    expect(calls[0].extra.judgeModelOverride).toBe("claude-opus-4-8");
  });

  it("without --judge-model no override is sent, and an alias judge_model is refused before spend", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace('judge_model: "claude-haiku-4-5-20251001"', "judge_model: haiku"));
    const r = await runHillclimbCommand(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  it("a secret in an authored output with an extension outside the kind map (.yaml) never reaches the flow", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
    authored = { "outputs/config.yaml": "token: sk-test-SECRET-9\n" };
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(0);
    const p = join(cwd, "flow", "baseline", "out", "alpha_rep0", "files", "outputs", "config.yaml");
    expect(readFileSync(p, "utf8")).toMatch(/^token: /);
    expect(readFileSync(p, "utf8")).not.toContain("sk-test-SECRET-9");
  });

  it("a runner refused by another live runner's lock never re-takes the snapshot that runner is mounting", async () => {
    // A refused run (no approved harness) leaves a snapshot of round 1 for a variant with no rows.
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(2);
    const snapDir = readdirSync(snaps).map((h) => join(snaps, h, "baseline", "my-plugin"))[0];
    expect(readFileSync(join(snapDir, "skills", "x", "SKILL.md"), "utf8")).toMatch(/round 1/);
    // Another runner holds the variant's lock (this process: alive); the live plugin moves on.
    writeFileSync(join(cwd, "flow", "baseline", ".lock"), JSON.stringify({ pid: process.pid }));
    writeFileSync(join(plugin, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nround 2\n");
    const r = await runHillclimbCommand(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/another hillclimb process/);
    expect(readFileSync(join(snapDir, "skills", "x", "SKILL.md"), "utf8")).toMatch(/round 1/);
    expect(calls).toEqual([]);
    // the refused run recorded no approval
    expect(
      existsSync(join(cwd, "flow", "_state.json")) ? JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8")) : {},
    ).not.toHaveProperty("harness_sha");
  });

  it("the envelope's scored counts rows written, even when a later write of that attempt failed", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
    mkdirSync(join(cwd, "flow", "baseline", "traces", "alpha_rep0.json"), { recursive: true }); // the trace write will fail
    const r = await runHillclimbCommand(args(), deps());
    expect(r.exitCode).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(r.scored).toBe(1);
  });

  it("with --case, the exposure check still covers every case's files", async () => {
    const sub = join(cwd, "mounted");
    mkdirSync(sub);
    writeFileSync(join(sub, "_beta_session.yaml"), `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`);
    writeFileSync(
      join(cwd, "evals", "beta.yaml"),
      SCENARIO.replace("name: Alpha", "name: Beta").replace("./_session.yaml", join(sub, "_beta_session.yaml")),
    );
    writeFileSync(
      join(cwd, "evals", "_session.yaml"),
      `model: ${MODEL}\nfolders:\n  - from: ${sub}\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
    );
    const r = await runHillclimbCommand(args("--approve-harness", "--case", "alpha"), deps());
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/could read .*_beta_session\.yaml/);
  });

  it("a session that mounts the runs root is refused: kept runs hold the grades and rubric", async () => {
    const runsRoot = join(cwd, "runs");
    mkdirSync(runsRoot);
    writeFileSync(
      join(cwd, "evals", "_session.yaml"),
      `model: ${MODEL}\nfolders:\n  - from: ${runsRoot}\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
    );
    const r = await runHillclimbCommand(args("--approve-harness"), deps({ runsRoot }));
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/could read .*runs/);
  });

  describe("COWORK_HARNESS_HILLCLIMB_SNAPSHOTS", () => {
    const ENV = "COWORK_HARNESS_HILLCLIMB_SNAPSHOTS";
    const noRoot = (env: NodeJS.ProcessEnv): RunCommandDeps => {
      const d = deps({ env });
      delete (d as { snapshotRoot?: string }).snapshotRoot;
      return d;
    };

    it("unset: the default root under the home dir", () => {
      expect(snapshotRootFrom({})).toBe(defaultSnapshotRoot());
    });

    it("an absolute override is honoured", async () => {
      const over = realpathSync(mkdtempSync(join(tmpdir(), "hc-snap-over-")));
      try {
        await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
        expect((await runHillclimbCommand(args(), noRoot({ [ENV]: over }))).exitCode).toBe(0);
        const session = calls[0].extra.session as { plugins: { local_plugins: string[] } };
        expect(session.plugins.local_plugins[0].startsWith(over + "/")).toBe(true);
      } finally {
        rmSync(over, { recursive: true, force: true });
      }
    });

    it("a relative override is refused (it would depend on the cwd)", async () => {
      const r = await runHillclimbCommand(args("--approve-harness"), noRoot({ [ENV]: "snaps" }));
      expect(r.exitCode).toBe(2);
      expect(err.join("\n")).toContain(`${ENV} must be an absolute path (got "snaps")`);
    });

    it("an override inside a git work tree is refused, naming the variable", async () => {
      const r = await runHillclimbCommand(args("--approve-harness"), noRoot({ [ENV]: join(import.meta.dirname, "..", ".snap-test") }));
      expect(r.exitCode).toBe(2);
      expect(err.join("\n")).toMatch(/git work tree/);
      expect(err.join("\n")).toContain(ENV);
    });

    it("an override inside the plugin, the flow or the runs root is refused", async () => {
      for (const [where, extra] of [
        [join(plugin, "snaps"), {}],
        [join(cwd, "flow", "snaps"), {}],
        [join(cwd, "runs", "snaps"), { runsRoot: join(cwd, "runs") }],
      ] as const) {
        err = [];
        const d = { ...noRoot({ [ENV]: where }), ...extra };
        const r = await runHillclimbCommand(args("--approve-harness"), d);
        expect(r.exitCode, where).toBe(2);
        expect(err.join("\n"), where).toMatch(/snapshot root .* inside/);
      }
      expect(calls).toEqual([]);
    });
  });

  describe("the judge's isolation preflight", () => {
    const refuse = () => "the host claude cannot run isolated (SYNTHETIC refusal)";

    it("a flow with semantic_matches refuses up front when the host claude cannot run the judge isolated", async () => {
      const r = await runHillclimbCommand(args("--approve-harness"), deps({ isolationCheck: refuse }));
      expect(r.exitCode).toBe(2);
      expect(calls).toEqual([]);
      expect(err.join("\n")).toContain("SYNTHETIC refusal");
    });

    it("a pairwise-only flow refuses up front too (semantic_pairwise judges through the host claude)", async () => {
      writeFileSync(
        join(cwd, "evals", "alpha.yaml"),
        SCENARIO.replace(
          /  - semantic_matches:[\s\S]*$/,
          `  - semantic_pairwise:\n      refs: [${join(cwd, "refstore")}]\n      judge_model: "claude-haiku-4-5-20251001"\n`,
        ),
      );
      const r = await runHillclimbCommand(args("--approve-harness"), deps({ isolationCheck: refuse }));
      expect(r.exitCode).toBe(2);
      expect(calls).toEqual([]);
      expect(err.join("\n")).toContain("SYNTHETIC refusal");
    });

    it("a pairwise reference that is missing refuses before spend, not as an error on every rep", async () => {
      writeFileSync(
        join(cwd, "evals", "alpha.yaml"),
        SCENARIO.replace(
          /  - semantic_matches:[\s\S]*$/,
          `  - semantic_pairwise:\n      refs: [${join(cwd, "refstore")}]\n      judge_model: "claude-haiku-4-5-20251001"\n`,
        ),
      );
      const r = await runHillclimbCommand(args("--approve-harness"), deps());
      expect(r.exitCode).toBe(2);
      expect(calls).toEqual([]);
      expect(err.join("\n")).toMatch(/case alpha: .*refstore/);
    });

    it("a flow with no judge and no LLM answering never asks", async () => {
      writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace(/  - semantic_matches:[\s\S]*$/, ""));
      let asked = false;
      await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ isolationCheck: () => ((asked = true), undefined) }));
      expect(asked).toBe(false);
    });

    it("on_unanswered: llm asks, unless a decider channel replaces the LLM decider", async () => {
      writeFileSync(
        join(cwd, "evals", "alpha.yaml"),
        SCENARIO.replace(/  - semantic_matches:[\s\S]*$/, "").replace("prompt:", "on_unanswered: llm\nprompt:"),
      );
      expect((await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ isolationCheck: refuse }))).exitCode).toBe(2);
      err = [];
      const viaDir = await runHillclimbCommand(
        args("--approve-harness", "--dry-run", "--decider-dir", join(cwd, "d")),
        deps({ isolationCheck: refuse }),
      );
      expect(viaDir.exitCode).toBe(0);
    });
  });

  it("meta.judge_transport records how the run's judge ran; absent when no judge recorded one", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
    await runHillclimbCommand(args(), deps());
    judgeTransport = { isolation: "strict", cliVersion: "9.9.9" };
    await runHillclimbCommand(args("--reps", "2"), deps());
    const metas = rows().map((r) => r.meta as Record<string, unknown>);
    expect(metas[0]).not.toHaveProperty("judge_transport");
    expect(metas[1].judge_transport).toEqual({ isolation: "strict", cliVersion: "9.9.9" });
  });

  describe("--dry-run refuses what the pass would, creating nothing", () => {
    it("a variant with rows whose snapshot is gone", async () => {
      await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
      await runHillclimbCommand(args(), deps());
      rmSync(snaps, { recursive: true, force: true });
      mkdirSync(snaps);
      const r = await runHillclimbCommand(args("--dry-run", "--reps", "2"), deps({ indexRows: () => [] }));
      expect(r.exitCode).toBe(2);
      expect(err.join("\n")).toMatch(/snapshot .* is missing/);
      expect(readdirSync(snaps)).toEqual([]);
    });

    it("a snapshot root inside a git work tree", async () => {
      const d = deps({ indexRows: () => [] });
      const r = await runHillclimbCommand(args("--dry-run"), { ...d, snapshotRoot: join(import.meta.dirname, "..", ".snap-test-dry") });
      expect(r.exitCode).toBe(2);
      expect(err.join("\n")).toMatch(/git work tree/);
      expect(existsSync(join(import.meta.dirname, "..", ".snap-test-dry"))).toBe(false);
    });

    it("another live runner holding the variant's lock", async () => {
      await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
      writeFileSync(join(cwd, "flow", "baseline", ".lock"), JSON.stringify({ pid: process.pid }));
      const r = await runHillclimbCommand(args("--dry-run"), deps({ indexRows: () => [] }));
      expect(r.exitCode).toBe(2);
      expect(err.join("\n")).toMatch(/another hillclimb process/);
    });
  });

  it("a scenario whose longest recorded run exceeds --timeout-s is named before the pass", async () => {
    const row = (durationMs: number) =>
      ({
        v: 1,
        ts: "t",
        command: "run",
        scenario: "Alpha",
        slug: "Alpha",
        runId: `r${durationMs}`,
        fidelity: "container",
        baseline: "b",
        result: "success",
        pass: true,
        signals: [],
        durationMs,
      }) as never;
    await runHillclimbCommand(args("--dry-run", "--timeout-s", "1800"), deps({ indexRows: () => [row(600_000), row(2_055_000)] }));
    expect(err.join("\n")).toMatch(/Alpha.*2055 ?s.*--timeout-s 1800/);
    err = [];
    await runHillclimbCommand(args("--dry-run", "--timeout-s", "1800"), deps({ indexRows: () => [row(600_000)] }));
    expect(err.join("\n")).not.toMatch(/--timeout-s 1800/);
  });

  it("a lock left by a runner that was killed (its pid gone) does not block the next pass", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
    const dead = spawnSync(process.execPath, ["-e", ""]).pid; // a real process that has exited
    writeFileSync(join(cwd, "flow", "baseline", ".lock"), JSON.stringify({ pid: dead }));
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(existsSync(join(cwd, "flow", "baseline", ".lock"))).toBe(false); // released after the pass
  });
});

// Which skill the `skill_invoked` column tracks. The ids are the ones the agent binary registers (read from the
// shipped loader): `<plugin>:<dir>` for skills/<dir>/SKILL.md, and for a SKILL.md at the plugin root (no `skills`
// manifest key, no skills/ dir) `<plugin>:<frontmatter name, else the root's basename>`.
describe("skill_invoked: which skill the rows track", () => {
  const state = () => JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8")) as Record<string, unknown>;
  const addSkill = (name: string) => {
    mkdirSync(join(plugin, "skills", name), { recursive: true });
    writeFileSync(join(plugin, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${name}\n`);
  };
  /** The plugin as a root-SKILL.md plugin: a manifest and a top-level SKILL.md, no skills/ dir. */
  const rootSkill = (frontmatterName: string | undefined) => {
    rmSync(join(plugin, "skills"), { recursive: true, force: true });
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "my-plugin" }));
    writeFileSync(join(plugin, "SKILL.md"), `---\n${frontmatterName ? `name: ${frontmatterName}\n` : ""}description: d\n---\nroot\n`);
  };
  const SHA = "[0-9a-f]{12}";

  it("a root-SKILL.md plugin tracks the id the binary registers: its frontmatter name, not its directory", async () => {
    rootSkill("coach");
    inventory = ["my-plugin:coach"];
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:coach" }];
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(0);
    // The directory-named id is NOT this skill: a basename fallback here would read it as invoked.
    skillActivity = [{ skillId: "my-plugin:my-plugin" }];
    await runHillclimbCommand(args("--reps", "2"), deps());
    expect(rows().map((r) => r.skill_invoked)).toEqual([1, 0]);
    expect(err.join("\n")).not.toMatch(/skill_invoked is omitted/);
  });

  it("a root-SKILL.md plugin with no frontmatter name tracks <plugin>:<directory>", async () => {
    rootSkill(undefined);
    inventory = ["my-plugin:my-plugin"];
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:my-plugin" }];
    await runHillclimbCommand(args(), deps());
    expect(rows().map((r) => r.skill_invoked)).toEqual([1]);
  });

  it("a multi-skill plugin without --skill omits the column, and the note names --skill and the skills", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:y" }];
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(0);
    expect(rows()[0]).not.toHaveProperty("skill_invoked");
    expect(err.join("\n")).toMatch(/several skills \(x, y\): skill_invoked is omitted — pass --skill <name> to record one/);
  });

  it("a multi-skill plugin with --skill tracks that skill", async () => {
    addSkill("y");
    inventory = ["my-plugin:x", "my-plugin:y"];
    await runHillclimbCommand(args("--skill", "y", "--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:y" }];
    await runHillclimbCommand(args("--skill", "y"), deps());
    skillActivity = [{ skillId: "my-plugin:x" }];
    await runHillclimbCommand(args("--skill", "y", "--reps", "2"), deps());
    expect(rows().map((r) => r.skill_invoked)).toEqual([1, 0]);
  });

  it("an unknown --skill is refused before any run, exit 2, naming the plugin's skills", async () => {
    addSkill("y");
    const r = await runHillclimbCommand(args("--skill", "nope", "--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(r.error?.message).toMatch(/--skill nope: no skills\/nope\/SKILL\.md under .* — available skills: x, y/);
    // Refused before the gate: nothing was approved.
    expect(existsSync(join(cwd, "flow", "_state.json"))).toBe(false);
  });

  it("the skill resolves against the variant's snapshot: a skill renamed in the live plugin after the snapshot still resolves", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--skill", "y", "--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:y" }];
    await runHillclimbCommand(args("--skill", "y"), deps());
    expect(rows()).toHaveLength(1); // the variant has rows: its snapshot is kept, never re-taken
    // The loop renames the skill in the live plugin.
    rmSync(join(plugin, "skills", "y"), { recursive: true });
    addSkill("z");
    calls = [];
    expect((await runHillclimbCommand(args("--skill", "y", "--reps", "2"), deps())).exitCode).toBe(0);
    expect(rows().map((r) => r.skill_invoked)).toEqual([1, 1]);
    // ...and the live plugin's new name is not in the snapshot.
    const r = await runHillclimbCommand(args("--skill", "z", "--reps", "3"), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(/--skill z: no skills\/z\/SKILL\.md under .* — available skills: x, y/);
  });

  it("--skill joins the harness sha: switching it refuses, naming the old and new skill, until re-approved", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    expect(state().harness_skill).toBe("x");
    const r = await runHillclimbCommand(args("--skill", "y"), deps());
    expect(r.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(r.error?.message).toMatch(
      new RegExp(
        `^harness changed since last approved run: tracked skill x → y; approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness if intended\\.$`,
      ),
    );
    expect((await runHillclimbCommand(args("--skill", "y", "--approve-harness"), deps())).exitCode).toBe(0);
    expect(state().harness_skill).toBe("y");
    expect(calls).toHaveLength(1);
  });

  it("adding --skill to an approved flow refuses and says it was added", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    expect(state()).not.toHaveProperty("harness_skill");
    const r = await runHillclimbCommand(args("--skill", "y"), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(
      new RegExp(
        `^harness changed since last approved run: --skill added \\(y\\); approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness if intended\\.$`,
      ),
    );
  });

  it("dropping --skill refuses and says which was removed; re-approving drops harness_skill and restores the no-skill sha", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    const plain = state().harness_sha;
    await runHillclimbCommand(args("--skill", "y", "--approve-harness", "--dry-run"), deps());
    expect(state().harness_sha).not.toBe(plain);
    const r = await runHillclimbCommand(args(), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(
      new RegExp(
        `^harness changed since last approved run: --skill removed \\(was y\\); approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness if intended\\.$`,
      ),
    );
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    // Without --skill the sha is the one a flow approved before --skill existed, and no stale selection is left.
    expect(state().harness_sha).toBe(plain);
    expect(state()).not.toHaveProperty("harness_skill");
  });

  it("a skill switch and a file edit together name both causes", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace("do the thing", "do the other thing"));
    const r = await runHillclimbCommand(args("--skill", "y"), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(
      new RegExp(
        `^harness changed since last approved run: tracked skill x → y, and the hashed files changed too \\(files: [^)]*evals/alpha\\.yaml[^)]*, skill:y\\); approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness after reviewing the diff\\.$`,
      ),
    );
  });

  it("a file edit with the same --skill keeps the standard wording", async () => {
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace("do the thing", "do the other thing"));
    const r = await runHillclimbCommand(args("--skill", "x"), deps());
    expect(r.error?.message).toMatch(
      new RegExp(
        `^harness changed since last approved run \\(files: [^)]*, skill:x\\); approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness after reviewing the diff\\.$`,
      ),
    );
  });

  it("the dry run's gate line shows the skill among what it hashed", async () => {
    await runHillclimbCommand(args("--skill", "x", "--dry-run"), deps());
    expect(err.join("\n")).toMatch(/harness gate: absent \(sha256 [0-9a-f]{12} over: .*, skill:x\)/);
  });
});

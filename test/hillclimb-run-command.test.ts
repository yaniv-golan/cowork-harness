// `hillclimb run` end to end above the scenario runner: case preparation, the variant's plugin snapshot, the
// session pointed at that snapshot, eval's answer-key guard, and the rows. The scenario runner is a fake that
// records what it was asked to run and returns a committed real excerpt (test/fixtures/eval-classify/
// success-semantic.json) with the public csv-metrics run's init/result frames. Nothing spawns.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  renameSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { defaultSnapshotRoot, runHillclimbCommand, snapshotRootFrom, type RunCommandDeps } from "../src/hillclimb/run-command.js";
import { parseHillclimbRunArgs } from "../src/hillclimb/args.js";
import { stateTemplateFor } from "../src/hillclimb/cli.js";
import { checkFlowDir } from "../src/hillclimb/schema-check.js";
import { buildFingerprint } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import { loadCases } from "../src/hillclimb/cases.js";
import { freezeRef } from "../src/refs/store.js";
import { pairwiseComposeKey } from "../src/run/pairwise-prepass.js";
import type { SessionConfig } from "../src/session.js";
import type { RunResult, Scenario } from "../src/types.js";

const FX = join(import.meta.dirname, "fixtures");
const excerpt = JSON.parse(readFileSync(join(FX, "eval-classify", "success-semantic.json"), "utf8")) as RunResult;
// The agent's own reply when it could not authenticate: a committed real run's result (`<synthetic>`, zero spend).
const authFailed = JSON.parse(readFileSync(join(FX, "eval-classify", "auth-result.json"), "utf8")) as RunResult;
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
    tokenCheck: () => ({ id: "token", title: "Auth token", status: "ok", detail: "found (env / .env)", required: true }),
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

  it("an edited workspace_fixture file is a harness change: the next pass refuses until re-approved", async () => {
    mkdirSync(join(cwd, "fx"));
    writeFileSync(join(cwd, "fx", "report.md"), "# draft 1\n");
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + "workspace_fixture: ../fx\n");
    const saved = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0"; // the temp dir is no git repo
    try {
      expect((await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps())).exitCode).toBe(0);
      writeFileSync(join(cwd, "fx", "report.md"), "# draft 2\n");
      const r = await runHillclimbCommand(args(), deps());
      expect(r.exitCode).toBe(2);
      expect(r.error?.message).toMatch(
        /harness changed since last approved run \(changed: fx\/report\.md, <workspace-fixture:alpha>; and \d+ unchanged\)/,
      );
      expect(calls).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = saved;
    }
  });

  it("a fixture file's exec bit is part of the harness: flipping it refuses until re-approved, as staging carries it", async () => {
    mkdirSync(join(cwd, "fx"));
    writeFileSync(join(cwd, "fx", "run.sh"), "echo hi\n");
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + "workspace_fixture: ../fx\n");
    const saved = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0"; // the temp dir is no git repo
    try {
      expect((await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps())).exitCode).toBe(0);
      chmodSync(join(cwd, "fx", "run.sh"), 0o755);
      const r = await runHillclimbCommand(args(), deps());
      expect(r.exitCode).toBe(2);
      expect(r.error?.message).toMatch(/harness changed since last approved run/);
      expect(calls).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = saved;
    }
  });

  it("state-template's harness_paths, saved as _state.json, approve and run with a fixture and an upload — and after a fixture file is renamed", async () => {
    mkdirSync(join(cwd, "fx"));
    writeFileSync(join(cwd, "fx", "report.md"), "# draft\n");
    writeFileSync(join(cwd, "evals", "input.csv"), "a,b\n");
    writeFileSync(
      join(cwd, "evals", "_session.yaml"),
      `model: ${MODEL}\nuploads:\n  - ./input.csv\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
    );
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + "workspace_fixture: ../fx\n");
    const saved = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0"; // the temp dir is no git repo
    try {
      const t = stateTemplateFor("evals", cwd, {});
      expect(t.state.harness_paths).toEqual(expect.arrayContaining(["fx/report.md", "evals/input.csv"]));
      mkdirSync(join(cwd, "flow"));
      writeFileSync(join(cwd, "flow", "_state.json"), JSON.stringify(t.state));
      const first = await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
      expect(first.error?.message).toBeUndefined();
      expect(first.exitCode).toBe(0);
      renameSync(join(cwd, "fx", "report.md"), join(cwd, "fx", "final.md")); // the listed entry no longer exists
      const second = await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
      expect(second.error?.message).toBeUndefined();
      expect(second.exitCode).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = saved;
    }
  });

  it("a listed harness file inside a connected folder is still refused: only the agent's own inputs are exempt", async () => {
    mkdirSync(join(cwd, "shared"));
    writeFileSync(join(cwd, "shared", "grade.mjs"), "export default 1\n");
    writeFileSync(
      join(cwd, "evals", "_session.yaml"),
      `model: ${MODEL}\nfolders:\n  - from: ${join(cwd, "shared")}\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
    );
    mkdirSync(join(cwd, "flow"));
    writeFileSync(join(cwd, "flow", "_state.json"), JSON.stringify({ harness_paths: ["shared/grade.mjs"] }));
    const r = await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(/could read .*shared\/grade\.mjs/);
  });

  it("a workspace_fixture that holds a scenario is refused: the fixture is copied where the agent reads", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + "workspace_fixture: .\n"); // the evals dir itself
    const saved = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0"; // the temp dir is no git repo
    try {
      const r = await runHillclimbCommand(args("--approve-harness"), deps());
      expect(r.exitCode).toBe(2);
      expect(err.join("\n")).toMatch(/could read .*alpha\.yaml/);
      expect(calls).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = saved;
    }
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

    // The flow's own references replace the scenario's `refs:`: the baseline's is the gate. A baseline pass is neutral
    // against it (it freezes it), so only a later variant is refused while it is missing — before spend, naming the repair.
    describe("pairwise references come from the flow", () => {
      const pairwise = () =>
        writeFileSync(
          join(cwd, "evals", "alpha.yaml"),
          SCENARIO.replace(
            /  - semantic_matches:[\s\S]*$/,
            `  - semantic_pairwise:\n      refs: [${join(cwd, "refstore")}]\n      judge_model: "claude-haiku-4-5-20251001"\n`,
          ),
        );

      it("a later variant with no baseline reference refuses before spend, naming freeze-ref", async () => {
        pairwise();
        const r = await runHillclimbCommand(args("--approve-harness", "--variant", "v1"), deps());
        expect(r.exitCode).toBe(2);
        expect(calls).toEqual([]);
        const text = err.join("\n");
        expect(text).toMatch(/case alpha: .*reference "baseline"/);
        expect(text).toContain("hillclimb freeze-ref evals --flow flow --variant baseline --case alpha");
        // The scenario's own store is never consulted.
        expect(text).not.toContain("refstore");
      });

      it("a baseline reference frozen for another prompt is refused with 'start a fresh flow dir', not a freeze-ref circle", async () => {
        pairwise();
        const sc = loadCases(join(cwd, "evals")).cases[0]!.scenario;
        freezeRef(
          join(cwd, "flow", "baseline", "ref"),
          "alpha",
          { command: "test", runDir: "~/r", resultSha256: "a".repeat(64) },
          { [pairwiseComposeKey(sc.assert.find((x) => x.semantic_pairwise)!)]: "OLD ANSWER" },
          { harnessVersion: "t", composerId: "c", scenario: "alpha", taskSha256: "0".repeat(64) },
        );
        const r = await runHillclimbCommand(args("--approve-harness", "--variant", "v1"), deps());
        expect(r.exitCode).toBe(2);
        expect(calls).toEqual([]);
        const text = err.join("\n");
        expect(text).toMatch(/frozen for a different task/);
        expect(text).toContain("start a fresh flow dir");
        expect(text).not.toContain("hillclimb freeze-ref");
      });

      it("a damaged baseline document is refused with 'start a fresh flow dir', never a freeze-ref that cannot repair it", async () => {
        pairwise();
        const sc = loadCases(join(cwd, "evals")).cases[0]!.scenario;
        const key = pairwiseComposeKey(sc.assert.find((x) => x.semantic_pairwise)!);
        const store = join(cwd, "flow", "baseline", "ref");
        freezeRef(
          store,
          "alpha",
          { command: "test", runDir: "~/r", resultSha256: "a".repeat(64) },
          { [key]: "THE ANSWER" },
          {
            harnessVersion: "t",
            composerId: "c",
            scenario: "alpha",
            taskSha256: createHash("sha256").update(sc.prompt, "utf8").digest("hex"),
          },
        );
        writeFileSync(join(store, "alpha", `doc-${key}.txt`), "TAMPERED");
        const r = await runHillclimbCommand(args("--approve-harness", "--variant", "v1"), deps());
        expect(r.exitCode).toBe(2);
        const text = err.join("\n");
        expect(text).toContain("start a fresh flow dir");
        // The refusal's own text names `ref freeze` generically; the hillclimb repair hint must not offer a freeze.
        expect(text).not.toContain("hillclimb freeze-ref evals");
      });

      it("a baseline pass is neutral against its own missing reference, so it runs — with the flow's setup, not refs:", async () => {
        pairwise();
        const r = await runHillclimbCommand(args("--approve-harness"), deps());
        expect(calls.length).toBeGreaterThan(0);
        expect(r.exitCode).not.toBe(2);
        const pw = calls[0]!.extra.pairwise;
        expect(pw).toEqual({
          caseId: "alpha",
          refs: [{ name: "baseline", store: join(cwd, "flow", "baseline", "ref") }],
          neutralRefs: ["baseline"],
          gateRefs: ["baseline"],
        });
        expect(err.join("\n")).toMatch(/pairwise refs: baseline .*the scenario `refs:` of alpha is ignored under hillclimb/);
      });

      it("after the pool, a baseline pass freezes each pairwise case's reference — a case with no good row is a counted failure, not an error row", async () => {
        pairwise();
        // The fake run records no pairwise outcome, so its evidence reads as refused: win_present 0, no good row.
        const r = await runHillclimbCommand(args("--approve-harness"), deps());
        expect(r.exitCode).toBe(1);
        expect(r.scored).toBe(1);
        const text = err.join("\n");
        expect(text).toMatch(/\[baseline\] reference freeze: skipped — case alpha: no good row/);
        expect(text).toContain("hillclimb freeze-ref evals --flow flow --variant baseline --case alpha");
        expect(
          existsSync(join(cwd, "flow", "baseline", "errors.jsonl"))
            ? readFileSync(join(cwd, "flow", "baseline", "errors.jsonl"), "utf8").trim()
            : "",
        ).toBe("");
        // The row carries the pairwise columns, measured as not compared.
        expect(rows()[0]!.grade).toMatchObject({ win_present: 0 });
      });

      it("a dry run says how many judge calls a rep makes, outside the agent-spend estimate", async () => {
        pairwise();
        await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps({ indexRows: () => [] }));
        expect(err.join("\n")).toMatch(/pairwise judging \(experimental; not in the estimate.*\): up to 0 judge call\(s\) per rep/);
      });
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

  it("one metric id declared two ways across cases refuses before the snapshot is taken", async () => {
    const metric = (better: string) =>
      `metrics:\n  - id: words\n    artifact: outputs/stats.json\n    path: words\n    better: ${better}\n    unbounded: true\n`;
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + metric("lower"));
    writeFileSync(join(cwd, "evals", "beta.yaml"), SCENARIO.replace("name: Alpha", "name: Beta") + metric("higher"));
    const r = await runHillclimbCommand(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/refusing to run: metric "words" is declared differently in alpha and beta/);
    expect(calls).toEqual([]);
    expect(readdirSync(snaps)).toEqual([]);
    expect(existsSync(join(cwd, "flow"))).toBe(false);
  });

  it("a metric re-declared since the flow's rows were written refuses before the next variant's snapshot is taken", async () => {
    const metric = (better: string) =>
      `metrics:\n  - id: words\n    artifact: outputs/stats.json\n    path: words\n    better: ${better}\n    unbounded: true\n`;
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + metric("lower"));
    expect((await runHillclimbCommand(args("--approve-harness"), deps())).exitCode).toBe(0);
    // Snapshots sit at <root>/<flow hash>/<variant>/: the baseline's was taken.
    const snapped = () => readdirSync(snaps).flatMap((h) => readdirSync(join(snaps, h)));
    expect(snapped()).toEqual(["baseline"]);
    calls = [];
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + metric("higher"));
    const r = await runHillclimbCommand(args("--variant", "v1", "--approve-harness"), deps());
    expect(r.exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/refusing to run: metric "words" .*baseline.*declaration changed/);
    expect(calls).toEqual([]);
    expect(snapped()).toEqual(["baseline"]);
    expect(existsSync(join(cwd, "flow", "v1"))).toBe(false);
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

// `--case` scopes the per-case checks to the selected cases; the flow-level ones (the case list, the harness gate,
// the answer key's hidden files, the one-plugin rule) still cover every case.
describe("--case: per-case checks cover the selected cases only", () => {
  const BETA_SESSION = () => `model: ${MODEL}\nplugins:\n  local_plugins:\n    - ${plugin}\n`;
  /** A second case, beta, with its own session file (default: a good one). The session sits outside the scenario
   *  dir: an unparseable YAML file IN it is a scenario the case list cannot load (flow-level, tested apart). */
  const betaSession = () => join(cwd, "sessions", "_beta_session.yaml");
  const BETA_SCENARIO = () => SCENARIO.replace("name: Alpha", "name: Beta").replace("./_session.yaml", betaSession());
  const beta = (opts: { scenario?: string; session?: string } = {}) => {
    mkdirSync(join(cwd, "sessions"), { recursive: true });
    writeFileSync(betaSession(), opts.session ?? BETA_SESSION());
    writeFileSync(join(cwd, "evals", "beta.yaml"), opts.scenario ?? BETA_SCENARIO());
  };
  const PAIRWISE_NO_REF = () =>
    BETA_SCENARIO().replace(/  - semantic_matches:[\s\S]*$/, `  - semantic_pairwise:\n      judge_model: "claude-haiku-4-5-20251001"\n`);
  const gateLine = () => err.find((l) => l.startsWith("harness gate:"));

  it("an unselected pairwise case with no reference does not block --case on a good one; the full pass still refuses it", async () => {
    beta({ scenario: PAIRWISE_NO_REF() });
    // A later variant: the flow holds no baseline reference for beta, so beta's pairwise preflight refuses.
    const v1 = ["--variant", "v1"];
    const dry = await runHillclimbCommand(args("--dry-run", "--case", "alpha", ...v1), deps({ indexRows: () => [] }));
    expect(dry.error?.message).toBeUndefined();
    expect(dry.exitCode).toBe(0);
    const pass = await runHillclimbCommand(args("--approve-harness", "--case", "alpha", ...v1), deps());
    expect(pass.error?.message).toBeUndefined();
    expect(calls.map((c) => c.scenario.name)).toEqual(["Alpha"]);
    // The flow judges pairwise (beta has an assert), so alpha's row carries the flow's one column set, as a full pass writes it.
    const row = JSON.parse(
      readFileSync(join(cwd, "flow", "v1", "results.jsonl"), "utf8")
        .trim()
        .split("\n")[0]!,
    );
    expect(row.grade).toMatchObject({ win_present: 0 });
    err = [];
    const full = await runHillclimbCommand(args("--dry-run", ...v1), deps({ indexRows: () => [] }));
    expect(full.exitCode).toBe(2);
    expect(full.error?.message).toMatch(/case beta: semantic_pairwise: [\s\S]*reference "baseline"/);
  });

  it("an unselected pairwise case adds no judge calls to the dry run's count", async () => {
    beta({ scenario: PAIRWISE_NO_REF().replace("semantic_pairwise:\n", "semantic_pairwise:\n      order: both\n") });
    // A later variant: the baseline reference counts as a judged reference for every pairwise assert.
    await runHillclimbCommand(args("--dry-run", "--case", "alpha", "--variant", "v1"), deps({ indexRows: () => [] }));
    expect(err.join("\n")).toMatch(/up to 0 judge call\(s\) per rep/);
  });

  for (const [what, opts, refusal] of [
    ["an alias model pin", { session: `model: sonnet\nplugins:\n  local_plugins:\n    - PLUGIN\n` }, /CONCRETE agent model/],
    [
      "a missing upload",
      { session: `model: ${MODEL}\nuploads:\n  - ./no-such-upload.txt\nplugins:\n  local_plugins:\n    - PLUGIN\n` },
      /case beta: .*no-such-upload/,
    ],
    ["an unparseable session file", { session: "model: [unclosed\n  - {\n" }, /case beta: /],
    [
      "a missing workspace_fixture",
      { scenario: "workspace_fixture: ../no-such-fixture\n" },
      /case beta: workspace_fixture \S*no-such-fixture: no such directory/,
    ],
  ] as const)
    it(`an unselected case with ${what} does not block --case on a good one; the full pass refuses it`, async () => {
      if ("scenario" in opts) beta({ scenario: BETA_SCENARIO() + opts.scenario });
      else beta({ session: opts.session.replace("PLUGIN", plugin) });
      const dry = await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
      expect(dry.error?.message).toBeUndefined();
      expect(dry.exitCode).toBe(0);
      err = [];
      const full = await runHillclimbCommand(args("--dry-run"), deps({ indexRows: () => [] }));
      expect(full.exitCode).toBe(2);
      expect(full.error?.message).toMatch(refusal);
    });

  const UPLOAD_SESSION = () => BETA_SESSION().replace("plugins:", "uploads:\n  - ./in.txt\nplugins:");
  const uploadPath = () => join(cwd, "sessions", "in.txt");
  for (const [what, make, refusal] of [
    ["a directory", () => mkdirSync(uploadPath()), /case beta: .*in\.txt.*directory/],
    [
      "an unreadable file",
      () => (writeFileSync(uploadPath(), "input\n"), chmodSync(uploadPath(), 0o000)),
      /cannot read sessions\/in\.txt \(EACCES\)/,
    ],
  ] as const)
    it(`an unselected case's upload that exists but is ${what} does not block --case; it leaves the gate's set, so the sha moves`, async (ctx) => {
      if (what === "an unreadable file" && process.getuid?.() === 0) ctx.skip(); // root reads a 0o000 file
      beta({ session: UPLOAD_SESSION() });
      writeFileSync(uploadPath(), "input\n");
      await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
      const readable = gateLine();
      expect(readable).toMatch(/sessions\/in\.txt/);
      rmSync(uploadPath());
      make();
      try {
        err = [];
        const dry = await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
        expect(dry.error?.message).toBeUndefined();
        expect(dry.exitCode).toBe(0);
        const dropped = gateLine();
        expect(dropped).not.toMatch(/sessions\/in\.txt/);
        expect(dropped).not.toBe(readable);
        err = [];
        const full = await runHillclimbCommand(args("--dry-run"), deps({ indexRows: () => [] }));
        expect(full.exitCode).toBe(2);
        expect(full.error?.message).toMatch(refusal);
      } finally {
        if (existsSync(uploadPath()) && !statSync(uploadPath()).isDirectory()) chmodSync(uploadPath(), 0o644);
      }
    });

  it("an unselected inline session is named on stderr, as skipped for the one-plugin rule", async () => {
    beta({ scenario: BETA_SCENARIO().replace(/^session: .*\n/m, "") });
    const dry = await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
    expect(dry.exitCode).toBe(0);
    expect(err.join("\n")).toMatch(/note: case beta: .*inline.*not selected.*one-plugin/);
    err = [];
    const full = await runHillclimbCommand(args("--dry-run"), deps({ indexRows: () => [] }));
    expect(full.exitCode).toBe(2);
    expect(full.error?.message).toMatch(/case beta: the scenario has no session file/);
  });

  it("an unparseable unselected session is named on stderr, as skipped for the one-plugin rule", async () => {
    beta({ session: "model: [unclosed\n  - {\n" });
    await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
    expect(err.join("\n")).toMatch(/note: case beta: .*not selected.*one-plugin/);
  });

  it("an unparseable unselected SCENARIO file still refuses under --case, naming the file", async () => {
    beta({ scenario: "name: Beta\nprompt: [unclosed\n  - {\n" });
    const r = await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(/beta\.yaml/);
  });

  it("an unselected case's scenario reachable through a SELECTED case's mount is still refused", async () => {
    const sub = join(cwd, "mounted");
    mkdirSync(sub);
    beta();
    // beta.yaml really lives in the folder alpha's session mounts.
    renameSync(join(cwd, "evals", "beta.yaml"), join(sub, "beta.yaml"));
    symlinkSync(join(sub, "beta.yaml"), join(cwd, "evals", "beta.yaml"));
    writeFileSync(
      join(cwd, "evals", "_session.yaml"),
      `model: ${MODEL}\nfolders:\n  - from: ${sub}\nplugins:\n  local_plugins:\n    - ${plugin}\n`,
    );
    const r = await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(/could read .*beta\.yaml/);
  });

  it("a mount only an UNSELECTED case declares does not refuse (it does not exist in this pass); the full pass still refuses", async () => {
    beta({ session: `model: ${MODEL}\nfolders:\n  - from: ${join(cwd, "evals")}\nplugins:\n  local_plugins:\n    - ${plugin}\n` });
    const dry = await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
    expect(dry.error?.message).toBeUndefined();
    expect(dry.exitCode).toBe(0);
    err = [];
    const full = await runHillclimbCommand(args("--dry-run"), deps({ indexRows: () => [] }));
    expect(full.exitCode).toBe(2);
    expect(full.error?.message).toMatch(/could read .*alpha\.yaml/);
  });

  it("the harness sha is the same for a --case pass and a full pass: the gate covers every case", async () => {
    beta({ session: BETA_SESSION().replace("plugins:", "uploads:\n  - ./in.txt\nplugins:") });
    writeFileSync(join(cwd, "sessions", "in.txt"), "input\n");
    await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ indexRows: () => [] }));
    const sub = gateLine();
    err = [];
    await runHillclimbCommand(args("--dry-run"), deps({ indexRows: () => [] }));
    const full = gateLine();
    for (const f of ["evals/beta.yaml", "sessions/_beta_session.yaml", "sessions/in.txt"]) expect(sub).toContain(f);
    expect(sub).toBe(full);
  });

  it("the variant's source_sig is the same for a --case pass and a full pass", async () => {
    beta();
    const sig = () => JSON.parse(readFileSync(join(cwd, "flow", "baseline", "summary.json"), "utf8")).source_sig as string;
    await runHillclimbCommand(args("--approve-harness", "--case", "alpha"), deps());
    const sub = sig();
    expect(sub).toMatch(/^[0-9a-f]{64}$/);
    // summary.json keeps the first writer's keys: clear it so the full pass records its own.
    rmSync(join(cwd, "flow", "baseline", "summary.json"));
    await runHillclimbCommand(args(), deps());
    expect(calls.map((c) => c.scenario.name)).toEqual(["Alpha", "Beta"]);
    expect(sig()).toBe(sub);
  });

  it("an unparseable unselected session still feeds the gate: the sha is selection-independent and moves with its bytes", async () => {
    beta({ session: "model: [unclosed\n  - {\n" });
    writeFileSync(join(cwd, "evals", "gamma.yaml"), SCENARIO.replace("name: Alpha", "name: Gamma"));
    const shaFor = async (...sel: string[]) => {
      err = [];
      const r = await runHillclimbCommand(args("--dry-run", ...sel.flatMap((s) => ["--case", s])), deps({ indexRows: () => [] }));
      expect(r.error?.message).toBeUndefined();
      return gateLine();
    };
    const a = await shaFor("alpha");
    expect(a).toMatch(/over: .*_beta_session\.yaml/);
    expect(await shaFor("gamma")).toBe(a);
    expect(await shaFor("alpha", "gamma")).toBe(a);
    writeFileSync(betaSession(), "model: [still unclosed\n  - {\n");
    const moved = await shaFor("alpha");
    expect(moved).not.toBe(a);
  });

  it("an unselected semantic case does not trigger the isolation check when the selected cases need none", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace(/  - semantic_matches:[\s\S]*$/, ""));
    beta(); // beta keeps its semantic_matches
    let asked = false;
    const refuse = () => ((asked = true), "SYNTHETIC isolation refusal");
    const dry = await runHillclimbCommand(args("--dry-run", "--case", "alpha"), deps({ isolationCheck: refuse, indexRows: () => [] }));
    expect(asked).toBe(false);
    expect(dry.exitCode).toBe(0);
    const full = await runHillclimbCommand(args("--dry-run"), deps({ isolationCheck: refuse, indexRows: () => [] }));
    expect(full.exitCode).toBe(2);
    expect(full.error?.message).toContain("SYNTHETIC isolation refusal");
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
    expect(r.error?.message).toMatch(/--skill nope: .* registers no skill nope — its skills: x, y/);
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
    expect(r.error?.message).toMatch(/--skill z: .* registers no skill z — its skills: x, y/);
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
        `^harness changed since last approved run: tracked skill x → y, and the hashed files changed too \\(changed: evals/alpha\\.yaml, skill:y \\(new\\), skill:x \\(removed\\); and \\d+ unchanged\\); approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness after reviewing the diff\\.$`,
      ),
    );
  });

  it("a file edit with the same --skill keeps the standard wording", async () => {
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace("do the thing", "do the other thing"));
    const r = await runHillclimbCommand(args("--skill", "x"), deps());
    expect(r.error?.message).toMatch(
      new RegExp(
        `^harness changed since last approved run \\(changed: evals/alpha\\.yaml; and \\d+ unchanged\\); approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness after reviewing the diff\\.$`,
      ),
    );
  });

  it("the dry run's gate line shows the skill among what it hashed", async () => {
    await runHillclimbCommand(args("--skill", "x", "--dry-run"), deps());
    expect(err.join("\n")).toMatch(/harness gate: absent \(sha256 [0-9a-f]{12} over: .*, skill:x\)/);
  });
});

describe("skill_invoked: what each row tracked, and keeping a variant's column one meaning", () => {
  const state = () => JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8")) as Record<string, unknown>;
  const rowsOf = (variant: string) =>
    readFileSync(join(cwd, "flow", variant, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { skill_invoked?: number; meta: Record<string, unknown> });
  const addSkill = (name: string) => {
    mkdirSync(join(plugin, "skills", name), { recursive: true });
    writeFileSync(join(plugin, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${name}\n`);
  };
  const SHA = "[0-9a-f]{12}";
  const withFixture = async (body: () => Promise<void>) => {
    mkdirSync(join(cwd, "fx"));
    writeFileSync(join(cwd, "fx", "report.md"), "# draft 1\n");
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO + "workspace_fixture: ../fx\n");
    const saved = process.env.COWORK_HARNESS_GITSET;
    process.env.COWORK_HARNESS_GITSET = "0"; // the temp dir is no git repo
    try {
      await body();
    } finally {
      if (saved === undefined) delete process.env.COWORK_HARNESS_GITSET;
      else process.env.COWORK_HARNESS_GITSET = saved;
    }
  };

  it("a skill directory the loader renames is tracked by its registered id: an invocation scores 1", async () => {
    rmSync(join(plugin, "skills", "x"), { recursive: true });
    addSkill("my.skill");
    inventory = ["my-plugin:my-skill"];
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:my-skill" }];
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(0);
    expect(rows()[0].skill_invoked).toBe(1);
    expect((rows()[0].meta as Record<string, unknown>).skill_tracked).toBe("my-plugin:my-skill");
  });

  it("--skill by directory name and by registered name are one selection: the same sha and harness_skill", async () => {
    rmSync(join(plugin, "skills", "x"), { recursive: true });
    addSkill("my.skill");
    addSkill("y");
    await runHillclimbCommand(args("--skill", "my.skill", "--approve-harness", "--dry-run"), deps());
    expect(state().harness_skill).toBe("my-skill");
    skillActivity = [{ skillId: "my-plugin:my-skill" }];
    expect((await runHillclimbCommand(args("--skill", "my-skill"), deps())).exitCode).toBe(0);
    expect(rows()[0].skill_invoked).toBe(1);
  });

  it("a plugin skill of the same name in ANOTHER plugin is not this one: 0", async () => {
    inventory = ["my-plugin:x", "other-plugin:x"];
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "other-plugin:x" }];
    await runHillclimbCommand(args(), deps());
    expect(rows()[0].skill_invoked).toBe(0);
  });

  it("every scored row records the tracked id in meta.skill_tracked; an omitted column records none", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args("--reps", "2"), deps());
    expect(rowsOf("baseline").map((r) => r.meta.skill_tracked)).toEqual(["my-plugin:x", "my-plugin:x"]);
    addSkill("y");
    await runHillclimbCommand(args("--variant", "v1", "--approve-harness"), deps());
    expect(rowsOf("v1")[0].meta).not.toHaveProperty("skill_tracked");
    expect(rowsOf("v1")[0]).not.toHaveProperty("skill_invoked");
  });

  it("a pass whose tracked skill differs from the variant's existing rows is refused before spend, and approves nothing", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args("--skill", "x"), deps());
    calls = [];
    for (const extra of [["--dry-run"], ["--approve-harness"], []]) {
      const r = await runHillclimbCommand(args("--skill", "y", "--reps", "2", ...extra), deps());
      expect(r.exitCode).toBe(2);
      expect(r.error?.message).toMatch(
        /variant baseline's rows track my-plugin:x, and this pass would track my-plugin:y: one column would mix two skills — run the switch as a new variant/,
      );
    }
    expect(calls).toEqual([]);
    expect(state().harness_skill).toBe("x");
  });

  it("rows that record no tracked skill do not refuse a pass that tracks one, in that variant: it warns", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args(), deps());
    err = [];
    const r = await runHillclimbCommand(args("--skill", "y", "--approve-harness", "--reps", "2"), deps());
    expect(r.exitCode, r.error?.message).toBe(0);
    expect(err.join("\n")).toMatch(
      /warning: variant baseline's earlier rows don't record which skill they tracked, and this pass tracks my-plugin:y/,
    );
    // One variant: nothing to compare across.
    expect(err.join("\n")).not.toMatch(/the flow's variants track different/);
  });

  it("rows that recorded a skill refuse a pass that would track none, in that variant", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args("--skill", "x"), deps());
    calls = [];
    const r = await runHillclimbCommand(args("--approve-harness", "--reps", "2"), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(/variant baseline's rows track my-plugin:x, and this pass would track no skill/);
    expect(calls).toEqual([]);
  });

  it("rows written before meta.skill_tracked existed read as unrecorded: a pass in their variant warns, never refuses", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    skillActivity = [{ skillId: "my-plugin:x" }];
    await runHillclimbCommand(args(), deps());
    // Such a row carries skill_invoked, measured against the plugin's one skill, but no meta.skill_tracked.
    const file = join(cwd, "flow", "baseline", "results.jsonl");
    const old = rowsOf("baseline").map((r) => {
      const { skill_tracked: _gone, ...meta } = r.meta;
      return JSON.stringify({ ...r, meta });
    });
    writeFileSync(file, old.join("\n") + "\n");
    expect(rowsOf("baseline")[0]).toHaveProperty("skill_invoked");
    err = [];
    expect((await runHillclimbCommand(args("--variant", "v1"), deps())).exitCode).toBe(0);
    expect(err.join("\n")).toMatch(
      /warning: the flow's variants track different skills in skill_invoked \(baseline: unrecorded; v1: my-plugin:x\)/,
    );
    expect(err.join("\n")).not.toMatch(/no skill/);
    err = [];
    const r = await runHillclimbCommand(args("--reps", "2"), deps());
    expect(r.exitCode, r.error?.message).toBe(0);
    expect(err.join("\n")).toMatch(
      /warning: variant baseline's earlier rows don't record which skill they tracked, and this pass tracks my-plugin:x/,
    );
    // baseline (unrecorded + x) and v1 (x) both measured x: no cross-variant difference to warn about.
    expect(err.join("\n")).not.toMatch(/the flow's variants track different/);
  });

  it("rows that record no tracked skill and a pass that tracks none: no warning", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args(), deps());
    err = [];
    expect((await runHillclimbCommand(args("--reps", "2"), deps())).exitCode).toBe(0);
    expect((await runHillclimbCommand(args("--variant", "v1"), deps())).exitCode).toBe(0);
    expect(err.join("\n")).not.toMatch(/warning: (variant|the flow's variants)/);
  });

  it("a different tracked skill in ANOTHER variant runs, with a warning naming each variant's skill", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args("--skill", "x"), deps());
    err = [];
    expect((await runHillclimbCommand(args("--variant", "v1", "--skill", "y", "--approve-harness"), deps())).exitCode).toBe(0);
    expect(err.join("\n")).toMatch(
      /warning: the flow's variants track different skills in skill_invoked \(baseline: my-plugin:x; v1: my-plugin:y\) — compare that column across them only knowingly/,
    );
  });

  it("a skill renamed in the live plugin between variants (no --skill): the new variant warns", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args(), deps());
    renameSync(join(plugin, "skills", "x"), join(plugin, "skills", "x2"));
    err = [];
    // The variant with rows keeps its snapshot, so it still tracks x and runs unwarned.
    expect((await runHillclimbCommand(args("--reps", "2"), deps())).exitCode).toBe(0);
    expect(err.join("\n")).not.toMatch(/track different skills/);
    expect((await runHillclimbCommand(args("--variant", "v1"), deps())).exitCode).toBe(0);
    expect(err.join("\n")).toMatch(/\(baseline: my-plugin:x; v1: my-plugin:x2\)/);
  });

  it("the dry run resolves against the plugin's git-tracked files, as the pass's snapshot does: an untracked skill is refused", async () => {
    addSkill("b");
    const git = (...a: string[]) => spawnSync("git", a, { cwd: plugin, encoding: "utf8" });
    git("init", "-q");
    git("add", "skills/x");
    const saved = process.env.COWORK_HARNESS_GITSET;
    delete process.env.COWORK_HARNESS_GITSET;
    try {
      const r = await runHillclimbCommand(args("--skill", "b", "--dry-run"), deps());
      expect(r.exitCode).toBe(2);
      expect(r.error?.message).toMatch(/--skill b: skills\/b\/SKILL\.md is untracked .* 'git add' it/);
      err = [];
      expect((await runHillclimbCommand(args("--dry-run"), deps())).exitCode).toBe(0);
      expect(err.join("\n")).toMatch(/\[baseline\] skill_invoked tracks my-plugin:x/);
    } finally {
      if (saved !== undefined) process.env.COWORK_HARNESS_GITSET = saved;
    }
  });

  it("the dry run names the tracked skill, or why there is none", async () => {
    await runHillclimbCommand(args("--dry-run"), deps());
    expect(err.join("\n")).toMatch(/\[baseline\] skill_invoked tracks my-plugin:x/);
    err = [];
    addSkill("y");
    await runHillclimbCommand(args("--dry-run"), deps());
    expect(err.join("\n")).toMatch(/\[baseline\] the plugin registers several skills \(x, y\): skill_invoked is omitted/);
  });

  it("the dry run's gate line names a skill-only change as the real run does, and a skill change with a file edit", async () => {
    addSkill("y");
    await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args("--skill", "y", "--dry-run"), deps());
    expect(err.join("\n")).toMatch(
      new RegExp(
        `harness gate: mismatch: tracked skill x → y \\(changed: skill:y \\(new\\), skill:x \\(removed\\); and \\d+ unchanged; sha256 ${SHA}\\)`,
      ),
    );
    err = [];
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace("do the thing", "do the other thing"));
    await runHillclimbCommand(args("--skill", "y", "--dry-run"), deps());
    expect(err.join("\n")).toMatch(
      /harness gate: mismatch: tracked skill x → y, and the hashed files changed too \(changed: evals\/alpha\.yaml, skill:y/,
    );
  });

  it("a workspace_fixture edit with a --skill switch names both causes; a switch alone with a fixture present is skill-only", async () => {
    addSkill("y");
    await withFixture(async () => {
      await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
      const only = await runHillclimbCommand(args("--skill", "y"), deps());
      expect(only.error?.message).toMatch(new RegExp(`^harness changed since last approved run: tracked skill x → y; approved ${SHA}`));
      writeFileSync(join(cwd, "fx", "report.md"), "# draft 2\n");
      const both = await runHillclimbCommand(args("--skill", "y"), deps());
      expect(both.exitCode).toBe(2);
      expect(both.error?.message).toMatch(
        /^harness changed since last approved run: tracked skill x → y, and the hashed files changed too \(changed: fx\/report\.md, <workspace-fixture:alpha>, skill:y \(new\), skill:x \(removed\); and \d+ unchanged\)/,
      );
      expect(calls).toEqual([]);
    });
  });

  it("with a fixture present, the no-skill sha hashes no skill and survives a --skill round trip", async () => {
    await withFixture(async () => {
      await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
      const plain = state().harness_sha;
      await runHillclimbCommand(args("--dry-run"), deps());
      expect(err.join("\n")).toMatch(/harness gate: approved \(sha256 [0-9a-f]{12} over: [^)]*fx\/report\.md[^)]*\)/);
      expect(err.join("\n")).not.toMatch(/skill:/);
      await runHillclimbCommand(args("--skill", "x", "--approve-harness", "--dry-run"), deps());
      expect(state().harness_sha).not.toBe(plain);
      await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
      expect(state().harness_sha).toBe(plain);
    });
  });
});

describe("credentials: refused before spend when no source resolves; an auth failure says where credentials come from", () => {
  const failing = (tier: string) => ({
    id: "token",
    title: "Auth token",
    status: "fail" as const,
    detail: `no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (asked for ${tier})`,
    remedy:
      "export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token), put it in ./.env, or point at another file: cowork-harness --dotenv <path> <cmd>",
    required: true,
  });
  const authDeps = (over: Partial<RunCommandDeps> = {}) => {
    const d = deps(over);
    const inner = d.runScenario;
    return {
      ...d,
      runScenario: (async (a: Parameters<typeof inner>[0]) => {
        const r = await inner(a);
        return { ...authFailed, outDir: r.outDir, fingerprint: r.fingerprint } as RunResult;
      }) as typeof inner,
    };
  };

  it("no credential source resolves at the case's tier: exit 2 before any run, naming the tier, what is missing and how to supply it", async () => {
    const asked: string[] = [];
    const r = await runHillclimbCommand(args("--approve-harness"), deps({ tokenCheck: (tier) => (asked.push(tier), failing(tier)) }));
    expect(r.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(asked).toEqual(["container"]);
    expect(r.error?.message).toContain("no usable agent credential for fidelity container (case alpha)");
    expect(r.error?.message).toContain("no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN");
    expect(r.error?.message).toContain("Fix: export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)");
    expect(r.error?.message).toContain("cowork-harness doctor --tier container");
    // A refusal records no approval.
    expect(existsSync(join(cwd, "flow", "_state.json")) ? readFileSync(join(cwd, "flow", "_state.json"), "utf8") : "").not.toContain(
      "harness_sha",
    );
  });

  it("protocol's own login (doctor warns, as it can serve an unmanaged protocol run) is refused: hillclimb's protocol runs use a managed config dir", async () => {
    writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace("fidelity: container", "fidelity: protocol"));
    const warn = () => ({
      id: "token",
      title: "Auth token",
      status: "warn" as const,
      detail: "no env / .env token, but a Keychain entry exists",
      required: true,
    });
    const saved = process.env.COWORK_MANAGED_CONFIG;
    process.env.COWORK_MANAGED_CONFIG = "1";
    try {
      const r = await runHillclimbCommand(args("--dry-run"), deps({ tokenCheck: warn }));
      expect(r.exitCode).toBe(2);
      expect(r.error?.message).toContain(
        "no usable agent credential for fidelity protocol (case alpha): no env / .env token, but a Keychain entry exists",
      );
      expect(r.error?.message).toContain("hillclimb runs protocol with a managed config dir, where that login is not read");
      expect(r.error?.message).toContain("cowork-harness doctor --tier protocol");
    } finally {
      if (saved === undefined) delete process.env.COWORK_MANAGED_CONFIG;
      else process.env.COWORK_MANAGED_CONFIG = saved;
    }
  });

  it("the dry run refuses the same way, before printing a plan", async () => {
    const r = await runHillclimbCommand(args("--dry-run"), deps({ tokenCheck: failing }));
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toContain("no usable agent credential for fidelity container");
  });

  it("a usable credential (or one doctor only warns about) runs", async () => {
    const warn = () => ({ id: "token", title: "Auth token", status: "warn" as const, detail: "w", required: true });
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    expect((await runHillclimbCommand(args(), deps({ tokenCheck: warn }))).exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("a run the agent could not authenticate prints, once per pass, the sources credentials are read from and how to check them", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    const r = await runHillclimbCommand(args("--reps", "2"), authDeps());
    expect(r.exitCode).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("FAILED: run ended error (auth)");
    const hints = err.filter((l) => l.includes("the agent could not authenticate"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN, else ANTHROPIC_API_KEY");
    expect(hints[0]).toContain("the process environment, then --dotenv <path>, then ./.env, then <install>/.env");
    expect(hints[0]).toContain("a credential is set, so the agent rejected it");
    expect(hints[0]).toContain("cowork-harness doctor --tier container");
  });

  it("at a tier that never passes ANTHROPIC_AUTH_TOKEN, a run failing with only that set says so (by name, never its value)", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    await runHillclimbCommand(args(), authDeps({ env: { ANTHROPIC_AUTH_TOKEN: "sk-test-SECRET-9" } }));
    const hint = err.find((l) => l.includes("the agent could not authenticate"))!;
    expect(hint).toContain(
      "ANTHROPIC_AUTH_TOKEN is set, but at fidelity container only CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY reach the agent",
    );
    expect(err.join("\n")).not.toContain("sk-test-SECRET-9");
  });
});

describe("the pass summary counts slots; the reference freeze reports on its own line", () => {
  const pairwise = () =>
    writeFileSync(
      join(cwd, "evals", "alpha.yaml"),
      SCENARIO.replace(
        /  - semantic_matches:[\s\S]*$/,
        `  - semantic_pairwise:\n      refs: [${join(cwd, "refstore")}]\n      judge_model: "claude-haiku-4-5-20251001"\n`,
      ),
    );

  it("one failed slot on a pairwise baseline is one failure: the skipped freeze is its own line, and the pass still exits 1", async () => {
    pairwise();
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    const r = await runHillclimbCommand(
      args(),
      deps({
        runScenario: async () => {
          throw new Error("SYNTHETIC spawn failure");
        },
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.failed).toBe(1);
    const text = err.join("\n");
    expect(text).toMatch(/\[baseline\] done - 0 ok, 1 failed -> /);
    expect(text).toMatch(/\[baseline\] reference freeze: skipped — case alpha: no good row/);
  });

  it("a scored slot whose freeze finds no good row: 1 ok, 0 failed, and the freeze line says skipped", async () => {
    pairwise();
    const r = await runHillclimbCommand(args("--approve-harness"), deps());
    expect(r.exitCode).toBe(1);
    expect(r.failed).toBe(0);
    const text = err.join("\n");
    expect(text).toMatch(/\[baseline\] done - 1 ok, 0 failed -> /);
    expect(text).toMatch(/\[baseline\] reference freeze: skipped — case alpha: no good row/);
    expect(text).toContain("hillclimb freeze-ref evals --flow flow --variant baseline --case alpha");
  });
});

describe("the harness gate names what changed", () => {
  const state = () => JSON.parse(readFileSync(join(cwd, "flow", "_state.json"), "utf8")) as Record<string, unknown>;
  const SHA = "[0-9a-f]{12}";
  const edit = () => writeFileSync(join(cwd, "evals", "alpha.yaml"), SCENARIO.replace("do the thing", "do the other thing"));

  it("an approval records a sha256 per hashed entry beside harness_sha", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    const files = state().harness_files as Record<string, string>;
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["evals/alpha.yaml", "evals/_session.yaml", "<baseline>", "<cowork-harness-version>"]),
    );
    for (const v of Object.values(files)) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a one-file edit refuses naming that file first and counting the rest, not listing them", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    const n = Object.keys(state().harness_files as object).length;
    edit();
    const r = await runHillclimbCommand(args(), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(
      new RegExp(
        `^harness changed since last approved run \\(changed: evals/alpha\\.yaml; and ${n - 1} unchanged\\); approved ${SHA}, now ${SHA}\\. Re-run with --approve-harness after reviewing the diff\\.$`,
      ),
    );
    expect(r.error?.message).not.toContain("_session.yaml");
  });

  it("the dry run's gate line names the changed file the same way", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    edit();
    err = [];
    await runHillclimbCommand(args("--dry-run"), deps());
    expect(err.join("\n")).toMatch(
      new RegExp(`harness gate: mismatch \\(changed: evals/alpha\\.yaml; and \\d+ unchanged; sha256 ${SHA}\\)`),
    );
  });

  it("an older approval (harness_sha alone) still loads: the refusal says the change is unknown and lists every file", async () => {
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    const { harness_files: _drop, ...old } = state();
    writeFileSync(join(cwd, "flow", "_state.json"), JSON.stringify(old, null, 2) + "\n");
    // Unchanged files: the older approval still passes the gate.
    expect((await runHillclimbCommand(args(), deps())).exitCode).toBe(0);
    edit();
    const r = await runHillclimbCommand(args(), deps());
    expect(r.exitCode).toBe(2);
    expect(r.error?.message).toMatch(
      /^harness changed since last approved run \(changed: unknown \(older approval\); files: [^;]*evals\/_session\.yaml/,
    );
    // Re-approving records the per-entry hashes from then on.
    await runHillclimbCommand(args("--approve-harness", "--dry-run"), deps());
    expect(state()).toHaveProperty("harness_files");
  });
});

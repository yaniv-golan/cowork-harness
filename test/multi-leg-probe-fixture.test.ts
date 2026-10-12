import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { loadMultiLegScenario, legScenario, loadSessionFromFile } from "../src/run/execute.js";
import { answerChannelRefusal } from "../src/answer-channel.js";
import { loadBaseline } from "../src/baseline.js";
import { overlaySession, vacuousLegBlockRefusal } from "../src/run/multi-leg.js";

// The resumable probe's multi-leg scenarios (examples/probes/resumable-probe*.scenario.yaml). Free and deterministic:
// they run the probe's own scripts the way the legs do, and grade each leg's file assertions against what they
// wrote — the live gate then only has to show the agent runs them.
const PERSISTENT = resolve("examples/probes/resumable-probe.scenario.yaml");
const COWORK_TASK = resolve("examples/probes/resumable-probe-cowork-task.scenario.yaml");
const SCRIPTS = resolve("examples/probes/resumable-probe/skills/resumable-probe/scripts");

function ctx(workRoot: string): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
  };
}

const run = (work: string, script: string, args: string[] = []) =>
  spawnSync("python3", [join(SCRIPTS, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, COWORK_ARTIFACTS_ROOT: join(work, "outputs", "artifacts") },
  });
/** Grade a leg's artifact_json / file_absent assertions (the ones a hand run can answer) against `work`. */
const gradeFiles = (file: string, legId: string, work: string) => {
  const ms = loadMultiLegScenario(file);
  const leg = ms.legs.find((l) => l.id === legId)!;
  const asserts = legScenario(ms, leg).assert.filter((a) => a.artifact_json !== undefined || a.file_absent !== undefined);
  expect(asserts.length).toBeGreaterThan(0);
  return evaluate(asserts, ctx(work)).map((r) => ({ pass: r.pass, message: r.message }));
};

describe("resumable-probe multi-leg fixture", () => {
  it("both scenarios load, every leg's session passes the answer_channel: none refusals, and no later leg is vacuous", () => {
    for (const file of [PERSISTENT, COWORK_TASK]) {
      const ms = loadMultiLegScenario(file);
      const session = loadSessionFromFile(ms.session);
      for (const [i, leg] of ms.legs.entries()) {
        if (leg.prompt === undefined) continue;
        const scn = legScenario(ms, leg);
        const s = overlaySession(session, leg.session);
        expect(
          answerChannelRefusal({ scenario: scn, session: s, tier: "container", baseline: loadBaseline("latest") }),
          `${file} ${leg.id}`,
        ).toBeUndefined();
        if (i > 0) expect(vacuousLegBlockRefusal(leg, scn.assert)).toBeUndefined();
      }
    }
  });

  it("persistent: park → apply → resume; each leg's file assertions pass on what the scripts wrote", () => {
    const work = mkdtempSync(join(tmpdir(), "cwh-rp-"));
    const ask = run(work, "run.py");
    expect(ask.status).toBe(12); // waiting, nothing asked
    expect(gradeFiles(PERSISTENT, "ask", work).every((r) => r.pass)).toBe(true);
    const apply = run(work, "apply_corrections.py", ["--run", "r1"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toMatch(/applied \d+ corrections/);
    const resume = run(work, "run.py", ["--answer", "a"]);
    expect(resume.status, resume.stderr).toBe(0);
    expect(gradeFiles(PERSISTENT, "resume", work)).toEqual(expect.arrayContaining([expect.objectContaining({ pass: true })]));
    expect(gradeFiles(PERSISTENT, "resume", work).every((r) => r.pass)).toBe(true);
  });

  it("persistent, discriminating: the resume leg's assertions fail on the parked tree, and on a resume that redid step 1", () => {
    const work = mkdtempSync(join(tmpdir(), "cwh-rp-"));
    run(work, "run.py");
    expect(gradeFiles(PERSISTENT, "resume", work).some((r) => !r.pass)).toBe(true); // parked: not complete
    // A resume that rewrote step1.json: the ledger says so and the assertion reds.
    spawnSync("python3", [
      "-c",
      "import json,pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_text(json.dumps({'step':1,'redone':True}))",
      join(work, "outputs/artifacts/runs/r1/step1.json"),
    ]);
    const redo = spawnSync("python3", [
      "-c",
      [
        "import json,pathlib,sys,hashlib",
        "d=pathlib.Path(sys.argv[1]);s=json.loads((d/'run_status.json').read_text())",
        "s.update(status='complete',invocation=2,resumed_from={'gate':'g1'})",
        "s['invocations'].append({'n':2,'kind':'resume','untouched_since_resume':{'step1_json':False}})",
        "(d/'run_status.json').write_text(json.dumps(s))",
      ].join("\n"),
      join(work, "outputs/artifacts/runs/r1"),
    ]);
    expect(redo.status).toBe(0);
    const r = gradeFiles(PERSISTENT, "resume", work);
    expect(
      r
        .filter((x) => !x.pass)
        .map((x) => x.message)
        .join("\n"),
    ).toMatch(/untouched_since_resume/);
  });

  it("an apply against a run that is not waiting fails loudly (exit 1)", () => {
    const work = mkdtempSync(join(tmpdir(), "cwh-rp-"));
    run(work, "run.py");
    run(work, "run.py", ["--answer", "a"]);
    expect(run(work, "apply_corrections.py", ["--run", "r1"]).status).toBe(1);
  });

  it("cowork-task: a fresh tree for leg 2 starts a new run, which is what that scenario asserts", () => {
    const leg2 = mkdtempSync(join(tmpdir(), "cwh-rp-"));
    expect(run(leg2, "run.py", ["--answer", "a"]).status).toBe(12); // no waiting run here: a fresh start
    expect(gradeFiles(COWORK_TASK, "resume", leg2).every((r) => r.pass)).toBe(true);
  });
});

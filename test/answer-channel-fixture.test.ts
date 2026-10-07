import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseScenarioFile, loadSessionFromFile } from "../src/run/execute.js";
import { answerChannelRefusal } from "../src/answer-channel.js";
import { loadBaseline } from "../src/baseline.js";

// The headless gated probe (examples/probes/gated-probe-headless.scenario.yaml): its script records `waiting`
// before the gate. These checks are free and deterministic: they run the probe's own script, not an agent.
const SCENARIO = resolve("examples/probes/gated-probe-headless.scenario.yaml");
const STEP1 = resolve("examples/probes/gated-probe/skills/gated-probe/scripts/step1.py");

function ctx(workRoot: string): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
    userVisiblePrefixes: ["outputs", ".projects"],
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

/** Run a copy of step1.py into a fresh work root, the way the session's artifacts_root resolves it, and grade the
 *  scenario's own artifact_json assertion against what it wrote. */
function gradeAfter(script: string) {
  const work = mkdtempSync(join(tmpdir(), "cwh-gp-"));
  const copy = join(work, "step1.py");
  writeFileSync(copy, script);
  const r = spawnSync("python3", [copy], { env: { ...process.env, COWORK_ARTIFACTS_ROOT: join(work, "outputs", "artifacts") } });
  expect(r.status, String(r.stderr)).toBe(0);
  const assertion = parseScenarioFile(SCENARIO).assert.find((a) => a.artifact_json !== undefined)!;
  return evaluate([assertion], ctx(work))[0];
}

describe("gated-probe-headless fixture", () => {
  it("loads, and its session passes every answer_channel: none refusal", () => {
    const scenario = parseScenarioFile(SCENARIO);
    const session = loadSessionFromFile(resolve("examples/probes", scenario.session));
    expect(session.answer_channel).toBe("none");
    const refusal = answerChannelRefusal({
      scenario,
      session,
      tier: "container",
      baseline: loadBaseline("desktop-2.26454.0"),
    });
    expect(refusal).toBeUndefined();
  });

  it("the script's own status file satisfies the scenario's artifact_json", () => {
    expect(gradeAfter(readFileSync(STEP1, "utf8")).pass).toBe(true);
  });

  // The discrimination check: a mutated copy that records `complete` must turn the assertion red, and for the reason
  // predicted — the status value — not a missing file or a parse error.
  it("a mutated script that writes `complete` fails the same assertion, on the status value", () => {
    const src = readFileSync(STEP1, "utf8");
    const mutant = src.replace('"status": "waiting"', '"status": "complete"');
    expect(mutant).not.toBe(src); // the mutation applied
    const r = gradeAfter(mutant);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/status/);
    expect(r.message).toMatch(/complete/);
  });
});

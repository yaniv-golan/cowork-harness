import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioPure, loadMultiLegScenario, legScenario, isMultiLegFile } from "../src/run/execute.js";
import { UsageError } from "../src/errors.js";

// The `legs:` scenario form: its schema, its refusals, and how one prompt leg becomes an ordinary single-prompt
// scenario for the executor.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "multi-leg-scenario-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (yaml: string, name = "two-leg.yaml") => {
  const p = join(dir, name);
  writeFileSync(p, yaml);
  return p;
};

const VALID = `fidelity: container
legs:
  - id: ask
    prompt: "/gated-probe:run"
    session: { answer_channel: none, permission_mode: bypassPermissions }
    assert:
      - artifact_json: { artifact: outputs/runs/r1/run_status.json, path: status, equals: waiting }
  - id: apply
    host_action:
      status: { artifact: outputs/runs/r1/run_status.json, expect: { status: waiting } }
      run: ["python3", "{status.scripts_dir_shell}/apply.py"]
    assert:
      - exit_code: 0
      - stdout_matches: "applied \\\\d+"
      - file_exists: { path: outputs/runs/r1/corrections.json, authored: true }
  - id: resume
    prompt: "/gated-probe:run"
    assert:
      - artifact_json: { artifact: outputs/runs/r1/run_status.json, path: status, equals: complete }
`;

const refusal = (yaml: string): string => {
  try {
    loadMultiLegScenario(file(yaml));
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("loadMultiLegScenario", () => {
  it("loads a valid three-leg scenario, defaulting workdir and the action timeout, naming it by file", () => {
    const s = loadMultiLegScenario(file(VALID));
    expect(s.name).toBe("two-leg");
    expect(s.workdir).toBe("persistent");
    expect(s.legs.map((l) => l.id)).toEqual(["ask", "apply", "resume"]);
    expect(s.legs[1].host_action?.timeout).toBe(120);
  });

  it("isMultiLegFile tells the two forms apart without parsing either", () => {
    expect(isMultiLegFile(file(VALID))).toBe(true);
    expect(isMultiLegFile(file("fidelity: container\nprompt: hi\n", "one.yaml"))).toBe(false);
  });

  const cases: Array<[string, string, RegExp]> = [
    ["prompt beside legs", VALID + 'prompt: "x"\n', /prompt.*each leg has its own prompt/],
    ["top-level assert", VALID + "assert: []\n", /assertions are per leg/],
    ["device_bridge", VALID + "device_bridge: true\n", /device bridge/],
    ["metrics", VALID + "metrics: []\n", /metrics are refused with legs/],
    ["lane remote", VALID + "lane: remote\n", /local lane/],
    ["one leg", "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n", /legs/],
    [
      "first leg an action",
      "fidelity: container\nlegs:\n  - { id: a, host_action: { run: ['true'] } }\n  - { id: b, prompt: x }\n  - { id: c, prompt: y }\n",
      /first leg must be a prompt leg/,
    ],
    [
      "only one prompt leg",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, host_action: { run: ['true'] } }\n",
      /at least two prompt legs/,
    ],
    [
      "both prompt and action",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x, host_action: { run: ['true'] } }\n  - { id: b, prompt: y }\n",
      /exactly one of prompt or host_action/,
    ],
    ["duplicate ids", "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: a, prompt: y }\n", /duplicate leg id "a"/],
    ["bad id", "fidelity: container\nlegs:\n  - { id: A/B, prompt: x }\n  - { id: b, prompt: y }\n", /leg id/],
    [
      "a shell string",
      'fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, host_action: { run: "rm -rf x" } }\n  - { id: c, prompt: y }\n',
      /run/,
    ],
    [
      "timeout over 600",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, host_action: { run: ['true'], timeout: 601 } }\n  - { id: c, prompt: y }\n",
      /timeout/,
    ],
    [
      "a transcript key on an action",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, host_action: { run: ['true'] }, assert: [ { tool_called: Bash } ] }\n  - { id: c, prompt: y }\n",
      /files only/,
    ],
    [
      "artifacts_root in an overlay",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, prompt: y, session: { agent_env: { artifacts_root: x } } }\n",
      /artifacts_root/,
    ],
    [
      "folders in an overlay",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, prompt: y, session: { folders: [] } }\n",
      /folders/,
    ],
    [
      "an overlay on an action",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, host_action: { run: ['true'] }, session: { answer_channel: none } }\n  - { id: c, prompt: y }\n",
      /takes no session overlay/,
    ],
    [
      "a bad assert regex",
      "fidelity: container\nlegs:\n  - { id: a, prompt: x }\n  - { id: b, host_action: { run: ['true'] }, assert: [ { stdout_matches: \"(\" } ] }\n  - { id: c, prompt: y }\n",
      /stdout_matches/,
    ],
  ];
  for (const [label, yaml, re] of cases)
    it(`refuses ${label}`, () => {
      expect(refusal(yaml)).toMatch(re);
    });

  it("a single-prompt loader refuses a legs: file instead of reading its first leg as the run", () => {
    expect(() => loadScenarioPure(file(VALID))).toThrow(/multi-leg scenario.*only `run` and `record`/);
  });
});

describe("legScenario: one prompt leg as the executor's single-prompt scenario", () => {
  it("carries the leg's prompt and assertions, the scenario's shared keys, and the fixture on leg 1 only", () => {
    const p = file(VALID.replace("fidelity: container", "fidelity: container\nworkspace_fixture: fx\nanswers: []"));
    writeFileSync(join(dir, "fx"), "");
    const s = loadMultiLegScenario(p);
    const first = legScenario(s, s.legs[0]);
    expect(first.prompt).toBe("/gated-probe:run");
    expect(first.assert).toHaveLength(1);
    expect(first.workspace_fixture).toBe(join(dir, "fx"));
    const last = legScenario(s, s.legs[2]);
    expect(last.workspace_fixture).toBeUndefined();
    expect(last.fidelity).toBe("container");
    expect(() => legScenario(s, s.legs[1])).toThrow(/host_action/);
  });
});

describe("executeMultiLeg: refused before any run dir exists", () => {
  it("the host loop (and cowork, which can resolve there), --session-id / --resume and --ablate-skill", async () => {
    const { executeMultiLeg } = await import("../src/run/multi-leg.js");
    const runs = join(dir, "runs");
    const prev = process.env.COWORK_HARNESS_RUNS_DIR;
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    try {
      for (const fid of ["hostloop", "cowork"]) {
        const s = loadMultiLegScenario(file(VALID.replace("fidelity: container", `fidelity: ${fid}`), `${fid}.yaml`));
        await expect(executeMultiLeg(s)).rejects.toThrow(/runs on container, microvm or protocol/);
      }
      const s = loadMultiLegScenario(file(VALID));
      await expect(executeMultiLeg(s, { sessionId: "x" })).rejects.toThrow(/--session-id and --resume take a single-prompt scenario/);
      await expect(executeMultiLeg(s, { ablateSkill: true })).rejects.toThrow(/--ablate-skill/);
      expect(existsSync(runs)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = prev;
    }
  });
});

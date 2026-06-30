import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildFingerprint } from "../src/run/cassette.js";

// verify-run must NOT vouch for answer-coverage against a kept run that predates a skill change.
// Every run persists a skill fingerprint in result.json; verify-run recomputes it live and, on the
// answer-coverage path, refuses (exit 2) when the skill source drifted — the kept gate snapshot is stale.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function gateFrame(question: string, optionLabels: string[]) {
  return {
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      input: { questions: [{ question, options: optionLabels.map((label) => ({ label })) }] },
    },
  };
}

const Q = "Confirm the snapshot?";

/** Build: a plugin tree + session.yaml, a scenario (session+skills+answers), and a kept run dir whose
 *  result.json carries a fingerprint over that tree + an events.jsonl gate. `withFingerprint` toggles the
 *  fingerprint (off = simulate an older harness's kept run). */
function fixture(opts: { withFingerprint: boolean }): { dir: string; scenario: string; pluginSkillMd: string } {
  const dir = mkdtempSync(join(tmpdir(), "vrc-"));
  const plugin = join(dir, "plugin");
  mkdirSync(join(plugin, "skills", "cap-table"), { recursive: true });
  const pluginSkillMd = join(plugin, "skills", "cap-table", "SKILL.md");
  writeFileSync(pluginSkillMd, "# cap-table v1\n");
  const session = join(dir, "session.yaml");
  writeFileSync(session, "skills:\n  local: [./plugin]\n");
  const scenario = join(dir, "scenario.yaml");
  writeFileSync(
    scenario,
    `name: smoke\nprompt: do the thing\nfidelity: container\nsession: ${session}\nskills: [cap-table]\n` +
      `answers:\n  - when_question: "Confirm the snapshot"\n    choose: "Confirmed"\nassert:\n  - result: success\n`,
  );

  const run = join(dir, "run");
  const workDir = join(run, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const result: Record<string, unknown> = {
    scenario: "smoke",
    fidelity: "container",
    baseline: "1.14271.0",
    result: "success",
    decisions: [],
    toolCounts: {},
    gateDeliveries: [],
    egress: [],
    assertions: [],
    subagents: [],
    outDir: run,
    workDir,
    durationMs: 1,
    scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
  };
  if (opts.withFingerprint) {
    // The same call execute.ts makes at run time — over the unchanged tree.
    result.fingerprint = buildFingerprint(session, "1.14271.0", undefined, ["cap-table"]);
  }
  writeFileSync(join(run, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(run, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  writeFileSync(join(run, "trace.json"), JSON.stringify({ questions: [Q], steps: [] }));
  writeFileSync(join(run, "events.jsonl"), JSON.stringify(gateFrame(Q, ["Confirmed", "Different"])) + "\n");
  return { dir, scenario, pluginSkillMd };
}

function verifyRun(runDir: string, scenario: string) {
  const r = spawnSync("node", [CLI, "verify-run", runDir, scenario], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "vrc-cwd-")) });
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

describe.skipIf(!can)("verify-run answer-coverage currency", () => {
  it("unchanged skill + matching answer ⇒ green (currency OK, coverage passes)", () => {
    const f = fixture({ withFingerprint: true });
    const r = verifyRun(join(f.dir, "run"), f.scenario);
    expect(r.code).toBe(0);
  });

  it("skill source changed AFTER the run was kept ⇒ exit 2 (stale gate snapshot — refuse to vouch)", () => {
    const f = fixture({ withFingerprint: true });
    writeFileSync(f.pluginSkillMd, "# cap-table v2 — gate phrasing moved\n"); // skill drift after the run
    const r = verifyRun(join(f.dir, "run"), f.scenario);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/predates the current skill/);
  });

  it("older kept run with NO fingerprint ⇒ warn, not fail (graceful; coverage still runs)", () => {
    const f = fixture({ withFingerprint: false });
    const r = verifyRun(join(f.dir, "run"), f.scenario);
    expect(r.code).toBe(0); // matching answer still greens
    expect(r.text).toMatch(/no skill fingerprint/);
  });
});

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { computeVerdict } from "../src/run/verdict.js";
import type { RunResult, Assertion } from "../src/types.js";

// `stalled` fails a run that ends on an unanswered question. Its opt-out, `allow_stall: true`, is a scenario
// assertion — and the open-ended lanes (`skill`, `probe-dispatch`) have no `assert:` block, so the failure
// used to name a remedy those lanes could not perform. `--allow-stall` merges the modifier into the
// synthesized assertions (as `--allow-missing-capability` does), and the remedy text names the spelling the
// run's own lane accepts.

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout || "", out: (r.stdout || "") + (r.stderr || "") };
}

describe.skipIf(!can)("--allow-stall is accepted by the open-ended lanes", () => {
  it("skill --allow-stall --dry-run: exit 0, and the plan carries allow_stall", () => {
    const d = mkdtempSync(join(tmpdir(), "allow-stall-"));
    mkdirSync(join(d, "plugin")); // a dry run refuses a plugin folder that does not exist
    const r = cli(["skill", "./plugin", "hi", "--allow-stall", "--dry-run"], d);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).allow_stall).toBe(true);
  });

  it("skill without the flag: the plan does not claim it", () => {
    const d = mkdtempSync(join(tmpdir(), "allow-stall-"));
    mkdirSync(join(d, "plugin"));
    const r = cli(["skill", "./plugin", "hi", "--dry-run"], d);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).allow_stall).toBeUndefined();
  });

  it("skill --allow-stall is a boolean: the equals form is a usage error", () => {
    const d = mkdtempSync(join(tmpdir(), "allow-stall-"));
    const r = cli(["skill", "./plugin", "hi", "--allow-stall=1", "--dry-run"], d);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/takes no value/);
  });

  it("probe-dispatch --allow-stall parses (it gets as far as the spawn guard, not an unknown-flag error)", () => {
    const d = mkdtempSync(join(tmpdir(), "allow-stall-"));
    mkdirSync(join(d, "plugin"));
    writeFileSync(join(d, "plugin", "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const r = cli(["probe-dispatch", "./plugin", "hi", "--allow-stall", "--fidelity", "container", "--model", "claude-sonnet-5"], d, {
      COWORK_HARNESS_FORBID_SPAWN: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "stub-not-a-real-token", // past the credential pre-flight, to the spawn guard
    });
    expect(r.out).not.toMatch(/unknown flag/);
    expect(r.out).toMatch(/COWORK_HARNESS_FORBID_SPAWN/);
  });
});

function rr(over: Partial<RunResult>): RunResult {
  return {
    scenario: "t",
    fidelity: "container",
    baseline: "x",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
    ...over,
  };
}
const assn = (assertion: Assertion): RunResult["assertions"][number] => ({ assertion, pass: true });
const msg = (r: RunResult, code: string) => computeVerdict(r, "live").signals.find((s) => s.code === code)?.message ?? "";

describe("the stall remedy names the spelling the run's lane accepts", () => {
  it("stalled on the skill lane (skill and probe-dispatch both record command:'skill') → --allow-stall", () => {
    const m = msg(rr({ command: "skill", stalledOnQuestion: true, assertions: [assn({ result: "success" })] }), "stalled");
    expect(m).toContain("--allow-stall");
    expect(m).not.toMatch(/assert allow_stall/);
  });

  it("stalled on a scenario lane (run/record/replay, or a result predating the field) → allow_stall: true", () => {
    for (const command of ["run", "record", "replay", undefined] as const) {
      const m = msg(rr({ command, stalledOnQuestion: true }), "stalled");
      expect(m, String(command)).toContain("allow_stall: true");
      expect(m, String(command)).not.toContain("--allow-stall");
    }
  });

  it("ended_with_question on the skill lane → --allow-stall", () => {
    const r = rr({
      command: "skill",
      finalMessage: "Done. Want me to go further?",
      workspaceFiles: [{ path: "x", bytes: 1, class: "mount" }],
      assertions: [assn({ result: "success" })],
    });
    const m = msg(r, "ended_with_question");
    expect(m).toContain("--allow-stall");
    expect(m).not.toMatch(/assert allow_stall/);
  });

  it("the modifier the flag synthesizes suppresses both signals on the skill lane", () => {
    const r = rr({
      command: "skill",
      stalledOnQuestion: true,
      finalMessage: "Want me to go further?",
      workspaceFiles: [{ path: "x", bytes: 1, class: "mount" }],
      assertions: [assn({ result: "success", allow_stall: true })],
    });
    const v = computeVerdict(r, "live");
    expect(v.signals.map((s) => s.code)).not.toContain("stalled");
    expect(v.signals.map((s) => s.code)).not.toContain("ended_with_question");
    expect(v.pass).toBe(true);
  });
});

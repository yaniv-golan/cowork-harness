import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// `--repeat` was extended from `run` to `skill`. These pin the preconditions that came WITH it: the run
// lane never needed a session-pinning guard (--session-id/--resume are skill-only) and already refused a
// driving agent. Both had to be ported explicitly, and neither is inferable from the flag parse.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const SKILL = resolve("examples/skills/my-pdf-skill");

function run(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe.runIf(can)("skill --repeat preconditions", () => {
  it("refuses --session-id: every iteration would resolve the SAME pinned run dir and delete the last", () => {
    const r = run(["skill", SKILL, "prompt", "--repeat", "2", "--session-id", "abc"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--repeat cannot be combined with --session-id/);
  });

  it("refuses --resume: iterations would chain one session, not sample N independent runs", () => {
    // `--resume` is a boolean that requires `--session-id`, so this is the only well-formed combination.
    const r = run(["skill", SKILL, "prompt", "--repeat", "2", "--session-id", "abc", "--resume"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--repeat cannot be combined with --session-id\/--resume/);
  });

  it("refuses a driving agent, matching the run lane and docs/scenario.md's invariant", () => {
    const r = run(["skill", SKILL, "prompt", "--repeat", "2", "--decider-cmd", "/bin/true"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not a measurement/);
  });

  it("still prints help when a companion flag is present (help must not require --repeat)", () => {
    const r = run(["skill", "--stop-on-diverge", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cowork-harness skill/);
  });
});

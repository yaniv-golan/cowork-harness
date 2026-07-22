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

  it("ACCEPTS --decider-llm — the one decider that is not rejected, and a paid consumer rides on it", () => {
    // Asymmetry worth pinning: --decider-dir/--decider-cmd are refused under --repeat as "not a
    // measurement" (an external channel drives the run), but --decider-llm is ALLOWED — the
    // independent-samples design tolerates it, and gated skills cannot be swept without it.
    //
    // Until now that acceptance was only an ABSENCE of rejection, verified by inspection and never
    // exercised. A downstream consumer's ~$50-100 `--repeat 12` sweep needs this path to clear its
    // skill's gates, so the positive path gets a test rather than an inference. --dry-run keeps it free:
    // this pins argument ACCEPTANCE, not decider behavior at runtime.
    const r = run(["skill", SKILL, "prompt", "--repeat", "2", "--decider-llm", "--dry-run"]);
    // POSITIVE assertion first, deliberately. A test built only from `.not.toMatch(...)` passes when the
    // command fails for an UNRELATED reason (a missing skill dir, an unknown flag) — it cannot
    // distinguish "accepted" from "broke differently", which is the vacuous-guard shape this repo keeps
    // shipping. Exit 0 plus the dry-run plan proves the argv was actually accepted.
    expect(r.code, `expected the dry-run to succeed; got:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/"fidelity"/);
    // ...and only then, that it was not accepted-then-rejected by a sibling guard.
    expect(r.out).not.toMatch(/not a measurement/);
    expect(r.out).not.toMatch(/cannot be combined/);
    expect(r.out).not.toMatch(/unknown flag/);
  });

  it("still prints help when a companion flag is present (help must not require --repeat)", () => {
    const r = run(["skill", "--stop-on-diverge", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cowork-harness skill/);
  });
});

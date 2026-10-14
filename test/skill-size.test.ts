import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pythonGate } from "./helpers/python-gate.js";

// The companion skill must pass its own size lint. After a context compaction the agent re-attaches
// only the first ~19,900 characters of an invoked skill, so a SKILL.md body past the cap loses its tail —
// which, before the entrypoint split, was the assertions guide, the measurement discipline and the whole
// gotchas catalog. This pins the shipped skill under the cap twice: once through `lint-skill --strict`
// (the rule a consumer runs), and once by measuring the body here, so that deleting or loosening the
// rule cannot turn this green on its own.
const SKILL_DIR = resolve(".claude/skills/cowork-harness");
const SCRIPT = resolve(SKILL_DIR, "scripts/scenario.py");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;

/** 19,000 B: the WARN threshold in scenario.py's `_SKILL_BODY_REATTACH_CAP`, under the ~19,900-char cut. */
const BODY_CAP = 19_000;

function bodyBytes(text: string): number {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return Buffer.byteLength(m ? text.slice(m[0].length) : text, "utf8");
}

describe("the companion skill fits the agent's size caps", () => {
  it(`SKILL.md body (frontmatter excluded) is at most ${BODY_CAP} B`, () => {
    const body = bodyBytes(readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8"));
    expect(body, `SKILL.md body is ${body} B`).toBeLessThanOrEqual(BODY_CAP);
  });

  it("the frontmatter strip found a frontmatter (else the measure above would include it and mean nothing new)", () => {
    expect(readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8")).toMatch(/^---\n[\s\S]*?\n---\n/);
  });

  const gate = pythonGate(havePython, process.env.CI);
  it.skipIf(gate === "skip")("`lint-skill --strict` exits 0 on the companion skill", () => {
    // Under CI a missing python3 fails here rather than skipping: the critique evidence ceiling is enforced by this test.
    expect(gate, `${py} is not available under CI, so the skill's size lint cannot run`).toBe("run");
    const r = spawnSync(py, [SCRIPT, "lint-skill", "--strict", SKILL_DIR], { encoding: "utf8" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

describe("pythonGate: a check that needs python3 never passes by skipping under CI", () => {
  it.each([
    [true, undefined, "run"],
    [true, "true", "run"],
    [false, undefined, "skip"],
    [false, "", "skip"],
    [false, "false", "skip"],
    [false, "0", "skip"],
    [false, "true", "fail"],
    [false, "1", "fail"],
  ] as const)("python3 %s, CI=%s → %s", (have, ci, want) => {
    expect(pythonGate(have, ci)).toBe(want);
  });
});

// `run` rejects a `skill` flag and names what a scenario or session says instead (RUN_EQUIVALENT_OF_SKILL_FLAG).
// The map is checked against both sides: every key is a real `skill` flag, and every `skill` flag `run` rejects has
// an entry, so a flag added to `skill` cannot be rejected by `run` without the pointer.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RUN_EQUIVALENT_OF_SKILL_FLAG, SKILL_FLAG_SURFACE } from "../src/run/skill-flag-surface.js";

const CLI = resolve("dist/cli.js");

function runWith(flag: string, arity: number): Promise<string> {
  return new Promise((done) => {
    const c = spawn("node", [CLI, "run", "no-such.yaml", flag, ...(arity ? ["x"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    c.stdout.on("data", (d) => (text += d));
    c.stderr.on("data", (d) => (text += d));
    c.on("close", () => done(text));
  });
}

describe("run's pointer from a skill flag to its scenario or session equivalent", () => {
  it("every key is a skill flag", () => {
    const skill = new Set(SKILL_FLAG_SURFACE.map((s) => s.flag));
    expect(Object.keys(RUN_EQUIVALENT_OF_SKILL_FLAG).filter((f) => !skill.has(f))).toEqual([]);
  });

  it.runIf(existsSync(CLI))(
    "every skill flag run rejects has an entry, and the message names it",
    async () => {
      const outs = await Promise.all(SKILL_FLAG_SURFACE.map(async (s) => ({ flag: s.flag, text: await runWith(s.flag, s.arity) })));
      const rejected = outs.filter((o) => o.text.includes("unexpected argument(s)"));
      expect(rejected.length).toBeGreaterThan(10); // the instrument sees rejections at all
      expect(rejected.map((o) => o.flag).filter((f) => !Object.hasOwn(RUN_EQUIVALENT_OF_SKILL_FLAG, f))).toEqual([]);
      for (const o of rejected) expect(o.text, o.flag).toContain(`${o.flag} → ${RUN_EQUIVALENT_OF_SKILL_FLAG[o.flag]}`);
      // --timeout is a run flag now: never rejected
      expect(outs.find((o) => o.flag === "--timeout")!.text).not.toContain("unexpected argument(s)");
    },
    60_000,
  );
});

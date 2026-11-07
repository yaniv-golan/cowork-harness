import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// A run that resolves no model is refused, and the live suites build their scenarios with inline sessions or
// call `skill`/`critique` without `--model`. The live lane therefore pins one in ONE place: a per-worker
// setup file, listed in vitest.config.live.ts, that sets COWORK_HARNESS_MODEL when it is unset and keeps an
// explicit value. This is the token-free proof, since the live lane itself must not run here:
//  - the setup's function sets a default only when the variable is unset or empty;
//  - the live config loads it for every worker;
//  - every harness spawn in a live suite inherits process.env, so the variable reaches it. The only env
//    objects that do not spread process.env are `runAgent` calls, which drive the agent binary directly
//    (not the harness) and pass `--model` nowhere.
const LIVE_SETUP = "test/setup/live-model.ts";

describe("the live lane pins a model", () => {
  it("the setup sets the default only when COWORK_HARNESS_MODEL is unset or empty", async () => {
    const { applyLiveModelDefault, LIVE_DEFAULT_MODEL } = await import("./setup/live-model-default.js");
    const unset: NodeJS.ProcessEnv = {};
    applyLiveModelDefault(unset);
    expect(unset.COWORK_HARNESS_MODEL).toBe(LIVE_DEFAULT_MODEL);
    const empty: NodeJS.ProcessEnv = { COWORK_HARNESS_MODEL: "" };
    applyLiveModelDefault(empty);
    expect(empty.COWORK_HARNESS_MODEL).toBe(LIVE_DEFAULT_MODEL);
    const explicit: NodeJS.ProcessEnv = { COWORK_HARNESS_MODEL: "claude-opus-5" };
    applyLiveModelDefault(explicit);
    expect(explicit.COWORK_HARNESS_MODEL).toBe("claude-opus-5");
  });

  it("the pure module has no import-time side effect on this worker's environment", async () => {
    const before = process.env.COWORK_HARNESS_MODEL;
    await import("./setup/live-model-default.js");
    expect(process.env.COWORK_HARNESS_MODEL).toBe(before);
  });

  it("vitest.config.live.ts loads the setup in every worker", () => {
    const cfg = readFileSync(resolve("vitest.config.live.ts"), "utf8");
    expect(cfg).toMatch(/setupFiles:\s*\[[^\]]*"test\/setup\/live-model\.ts"/);
    // The token setup sits in the same list (test/live-token-lane.test.ts covers what it does).
    expect(cfg).toMatch(/setupFiles:\s*\[[^\]]*"test\/setup\/live-token\.ts"/);
    expect(readFileSync(resolve(LIVE_SETUP), "utf8")).toMatch(/applyLiveModelDefault\(process\.env\)/);
  });

  it("every env object in a live suite spreads process.env, except direct runAgent calls", () => {
    const files = readdirSync(resolve("test")).filter((f) => /^live-.*\.test\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(resolve("test"), f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\benv:\s*\{/.test(line) || line.includes("...process.env")) return;
        const before = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
        if (/runAgent\(/.test(before)) return;
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

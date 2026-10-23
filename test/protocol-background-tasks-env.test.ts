// Cowork's background-tasks switch (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) on every tier. Desktop pins it in the
// spawn env; the container, microvm and hostloop tiers carry it through the baseline's spawn.env, and `protocol`,
// which has no spawn.env overlay, applies it from the same place (backgroundTasksEnv). The operator's own export of
// the key never reaches the agent on an env-inheriting tier. $0.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildHostLoopNativeEnv } from "../src/runtime/hostloop.js";
import { buildProtocolEnv } from "../src/runtime/protocol.js";
import { BACKGROUND_TASKS_ENV_KEY as KEY, backgroundTasksEnv, spawnEnv } from "../src/runtime/argv.js";
import { loadBaseline } from "../src/baseline.js";
import type { LaunchPlan } from "../src/session.js";
import type { PlatformBaseline } from "../src/types.js";

// The plan MUST carry `baseEnv`: buildProtocolEnv builds from it, so an absence assertion over an empty one is vacuous.
const protoPlan = (baseEnv: NodeJS.ProcessEnv = { ...process.env }): LaunchPlan => ({ baseEnv, agentEnv: {} }) as unknown as LaunchPlan;
const KEYLESS = "desktop-1.11847.5";

describe("protocol applies the background-tasks switch from the baseline", () => {
  it('latest: "1"', () => {
    expect(buildProtocolEnv(protoPlan(), loadBaseline("latest"))[KEY]).toBe("1");
  });

  // A literal keyless list and a fixed value, not "equals the baseline's value" (which the helper reads, so it could not
  // fail): a new baseline that pins another value, or stops pinning it, turns this red. The pinned count is derived, so
  // a new baseline that pins "1" needs no edit.
  it(`every committed baseline pins "1", except only ${KEYLESS}, which pins none`, () => {
    const dir = join(import.meta.dirname, "..", "baselines");
    let pinned = 0;
    const absent: string[] = [];
    const names = readdirSync(dir).filter((n) => /^desktop-.*\.json$/.test(n));
    for (const f of names) {
      const b = JSON.parse(readFileSync(join(dir, f), "utf8")) as PlatformBaseline;
      const v = buildProtocolEnv(protoPlan({}), b)[KEY];
      if (v === "1") pinned++;
      else if (v === undefined) absent.push(f.replace(/\.json$/, ""));
      else throw new Error(`${f}: unexpected value ${v}`);
    }
    expect(names.length).toBeGreaterThan(40); // the directory read is not vacuous
    expect({ pinned, absent }).toEqual({ pinned: names.length - 1, absent: [KEYLESS] });
  });

  it("a baseline with no spawn block does not throw and yields no key", () => {
    expect(backgroundTasksEnv({} as PlatformBaseline)).toEqual({});
    expect(backgroundTasksEnv(loadBaseline(KEYLESS))).toEqual({});
  });

  it("matches container on the same baseline, the keyless one included", () => {
    for (const name of ["latest", KEYLESS]) {
      const b = loadBaseline(name);
      expect(buildProtocolEnv(protoPlan({}), b)[KEY], name).toBe(spawnEnv(b, { configGuest: "/mnt/.claude", proxyHost: "http://p" })[KEY]);
    }
  });
});

describe("the operator's export of the key never reaches the agent", () => {
  it.each([
    ["latest", "1"],
    [KEYLESS, undefined],
  ] as const)("protocol, %s", (name, want) => {
    const env = buildProtocolEnv(protoPlan({ [KEY]: "0", PATH: "/usr/bin" }), loadBaseline(name));
    expect(env.PATH).toBe("/usr/bin"); // the operator layer is there: the key's absence is not vacuous
    expect(env[KEY]).toBe(want);
  });
  it.each([
    ["latest", "1"],
    [KEYLESS, undefined],
  ] as const)("hostloop, %s", (name, want) => {
    const env = buildHostLoopNativeEnv(loadBaseline(name), { configDir: "/tmp/cfg", operatorEnv: { [KEY]: "0", PATH: "/usr/bin" } });
    expect(env.PATH).toBe("/usr/bin");
    expect(env[KEY]).toBe(want);
  });
});

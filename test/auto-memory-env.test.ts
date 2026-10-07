import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initMemoryPaths } from "./helpers/init-memory-paths.js";
import { buildHostLoopNativeEnv } from "../src/runtime/hostloop.js";
import { buildProtocolEnv } from "../src/runtime/protocol.js";
import { spawnEnv, dockerRunArgv } from "../src/runtime/argv.js";
import { loadBaseline } from "../src/baseline.js";
import { autoMemoryEnv, AUTO_MEMORY_GATE, readGateBool } from "../src/loop-decision.js";
import type { LaunchPlan } from "../src/session.js";
import type { PlatformBaseline } from "../src/types.js";

// Desktop gives an ordinary local task (no spaceId, no sessionType) an auto-memory directory only when gate
// 123929380 is on; with no directory both loops send CLAUDE_CODE_DISABLE_AUTO_MEMORY:"1". The harness follows
// the gate row recorded in the baseline, on every tier, through the real env builders.

const KEY = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const OFF = loadBaseline("desktop-2.19675.0"); // recorded gate row: {on:false, source:"defaultValue"}
const OLD = loadBaseline("desktop-1.12603.1"); // predates the gate pin: no row at all

function withGate(base: PlatformBaseline, on: boolean): PlatformBaseline {
  const p = (base as unknown as { provenance: { gates: Record<string, unknown> } }).provenance;
  return {
    ...base,
    provenance: {
      ...p,
      gates: { ...p.gates, [`autoMemoryStandardSessions:${AUTO_MEMORY_GATE}`]: { on, source: "defaultValue", value: on } },
    },
  } as unknown as PlatformBaseline;
}
const ON = withGate(OFF, true);

const cases: Array<[string, PlatformBaseline, string | undefined]> = [
  ["gate off (desktop-2.19675.0)", OFF, "1"],
  ["gate on", ON, undefined],
  ["old baseline with no gate row (desktop-1.12603.1)", OLD, "1"],
];

// The protocol plan MUST carry `baseEnv` — it is what buildProtocolEnv builds from; without it an
// absence assertion is vacuous.
const protoPlan = (): LaunchPlan => ({ baseEnv: { ...process.env }, agentEnv: {} }) as unknown as LaunchPlan;

describe("auto-memory env follows the recorded gate 123929380 — every tier", () => {
  it.each(cases)("hostloop (buildHostLoopNativeEnv): %s", (_n, b, want) => {
    expect(buildHostLoopNativeEnv(b, { configDir: "/tmp/cfg" })[KEY]).toBe(want);
  });
  it.each(cases)("container/microvm (spawnEnv): %s", (_n, b, want) => {
    expect(spawnEnv(b, { configGuest: "/mnt/.claude", proxyHost: "http://p" })[KEY]).toBe(want);
  });
  it.each(cases)("protocol (buildProtocolEnv): %s", (_n, b, want) => {
    expect(buildProtocolEnv(protoPlan(), b)[KEY]).toBe(want);
  });

  it("container: the key reaches the docker argv", () => {
    const argv = dockerRunArgv({
      network: "cowork-net",
      lockdown: true,
      sessionRoot: "/sessions/T",
      sessionHost: "/HOST/SESSION",
      agentHost: "/HOST/claude",
      agentIn: "/usr/local/bin/claude",
      image: "cowork-agent-base:2",
      env: spawnEnv(OFF, { configGuest: "/sessions/T/mnt/.claude", proxyHost: "http://p" }),
      agentArgv: ["-p"],
    });
    expect(argv).toContain(`${KEY}=1`);
  });

  // The operator's shell export: production's host-loop env never inherits it, so neither may ours. It matters
  // only when the gate is ON (otherwise our "1" overwrites it). process.env is set BEFORE baseEnv is built.
  it.each([
    ["1", ON, undefined],
    ["0", OFF, "1"],
  ] as const)("an operator export %s never wins (hostloop and protocol)", (val, b, want) => {
    process.env[KEY] = val;
    try {
      expect(buildHostLoopNativeEnv(b, { configDir: "/tmp/cfg" })[KEY]).toBe(want);
      expect(buildProtocolEnv(protoPlan(), b)[KEY]).toBe(want);
    } finally {
      delete process.env[KEY];
    }
  });
});

describe("the recorded gate wins over a baseline spawn.env that carries the key", () => {
  const carrying = (b: PlatformBaseline) =>
    ({ ...b, spawn: { ...b.spawn, env: { ...(b.spawn?.env ?? {}), [KEY]: "1" } } }) as unknown as PlatformBaseline;
  it("gate on: absent on container/microvm and hostloop", () => {
    expect(spawnEnv(carrying(ON), { configGuest: "/mnt/.claude", proxyHost: "http://p" })[KEY]).toBeUndefined();
    expect(buildHostLoopNativeEnv(carrying(ON), { configDir: "/tmp/cfg" })[KEY]).toBeUndefined();
  });
  it('gate off: still "1"', () => {
    expect(spawnEnv(carrying(OFF), { configGuest: "/mnt/.claude", proxyHost: "http://p" })[KEY]).toBe("1");
    expect(buildHostLoopNativeEnv(carrying(OFF), { configDir: "/tmp/cfg" })[KEY]).toBe("1");
  });
});

describe("autoMemoryEnv", () => {
  const g = (gates: Record<string, unknown>) => ({ provenance: { gates } }) as unknown as PlatformBaseline;
  it("reads the prefixed row and the bare id", () => {
    expect(autoMemoryEnv(g({ [`autoMemoryStandardSessions:${AUTO_MEMORY_GATE}`]: { on: true } }))).toEqual({});
    expect(autoMemoryEnv(g({ [AUTO_MEMORY_GATE]: { on: true } }))).toEqual({});
  });
  it("off, absent, or a row with no boolean .on → disabled", () => {
    expect(autoMemoryEnv(g({ [AUTO_MEMORY_GATE]: { on: false } }))).toEqual({ [KEY]: "1" });
    expect(autoMemoryEnv(g({}))).toEqual({ [KEY]: "1" });
    expect(autoMemoryEnv({} as PlatformBaseline)).toEqual({ [KEY]: "1" });
    expect(autoMemoryEnv(g({ [AUTO_MEMORY_GATE]: { value: true } }))).toEqual({ [KEY]: "1" });
  });
  // Every committed baseline, not a sample: 32 record the gate off and 9 predate it (no row). A future sync that
  // legitimately records the gate ON turns this red — next to sync's WARNING note, that is the point.
  it("every committed baseline resolves to disabled: 32 rows off, 9 with no row", () => {
    const dir = join(import.meta.dirname, "..", "baselines");
    let off = 0;
    let noRow = 0;
    for (const f of readdirSync(dir).filter((n) => /^desktop-.*\.json$/.test(n))) {
      const b = JSON.parse(readFileSync(join(dir, f), "utf8")) as PlatformBaseline;
      expect(autoMemoryEnv(b), f).toEqual({ [KEY]: "1" });
      if (readGateBool(b, AUTO_MEMORY_GATE) === false) off++;
      else noRow++;
    }
    expect({ off, noRow }).toEqual({ off: 32, noRow: 9 });
  });
});

// The end-to-end witness. BEFORE half: a frozen init frame from a recording made with auto-memory ON (pre-fix),
// in which the instrument must see `memory_paths`. It is a fixture, not a live cassette, so it cannot go stale
// when the cassettes are re-recorded. AFTER half: every committed cassette re-recorded with memory off has an
// init frame and no `memory_paths` in it. test/live-auto-memory.test.ts, a billed live run and a RELEASING.md
// live-gate step, checks the same on a fresh run.
const initEvents = (path: string): string[] => (JSON.parse(readFileSync(path, "utf8")) as { events: string[] }).events;

describe("initMemoryPaths sees memory_paths in a frozen pre-fix init frame", () => {
  it("test/fixtures/auto-memory/pre-fix-init.json", () => {
    const r = initMemoryPaths(initEvents("test/fixtures/auto-memory/pre-fix-init.json"));
    expect(r.initSeen).toBe(true);
    expect((r.memoryPaths as { auto?: unknown } | undefined)?.auto).toEqual(expect.any(String));
  });
});

describe("the committed cassettes re-recorded with auto-memory off carry no memory_paths", () => {
  it.each([
    "examples/replays/example-multiselect-gate.cassette.json",
    "examples/replays/example-pdf-skill.cassette.json",
    "examples/replays/hostloop-computer-links.cassette.json",
    "test/fixtures/tool-call-dispatch/dispatch-shell.cassette.json",
  ])("%s", (path) => {
    const r = initMemoryPaths(initEvents(path));
    expect(r.initSeen).toBe(true);
    expect(r.memoryPaths).toBeUndefined();
  });
});

describe("initMemoryPaths edge cases", () => {
  it("a frame without the key, and a stream without an init frame, are told apart", () => {
    expect(initMemoryPaths(['{"type":"system","subtype":"init","tools":[]}'])).toEqual({ initSeen: true, memoryPaths: undefined });
    expect(initMemoryPaths(['{"type":"assistant"}', "not json"])).toEqual({ initSeen: false, memoryPaths: undefined });
  });
});

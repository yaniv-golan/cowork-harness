import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { initMemoryPaths } from "./helpers/init-memory-paths.js";
import { buildHostLoopNativeEnv } from "../src/runtime/hostloop.js";
import { buildProtocolEnv } from "../src/runtime/protocol.js";
import { spawnEnv, dockerRunArgv } from "../src/runtime/argv.js";
import { loadBaseline } from "../src/baseline.js";
import { autoMemoryEnv, AUTO_MEMORY_GATE } from "../src/loop-decision.js";
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
  it("every committed baseline resolves to disabled (none records the gate on)", () => {
    for (const b of [OFF, OLD, loadBaseline("desktop-2.16120.0"), loadBaseline("latest")]) expect(autoMemoryEnv(b)).toEqual({ [KEY]: "1" });
  });
});

// The end-to-end witness, BEFORE half: every committed cassette that carries an init frame was recorded with
// auto-memory ON (pre-fix), so the instrument must see `memory_paths` in it. The AFTER half — a fresh run's init
// frame carries none — is test/live-auto-memory.test.ts, a billed live run, and a RELEASING.md live-gate step.
// The cassettes are deliberately NOT re-recorded.
describe("initMemoryPaths sees memory_paths in the committed pre-fix cassettes", () => {
  it.each([
    "examples/replays/example-multiselect-gate.cassette.json",
    "examples/replays/example-pdf-skill.cassette.json",
    "examples/replays/hostloop-computer-links.cassette.json",
    "test/fixtures/tool-call-dispatch/dispatch-shell.cassette.json",
  ])("%s", (path) => {
    const c = JSON.parse(readFileSync(path, "utf8")) as { events: string[] };
    const r = initMemoryPaths(c.events);
    expect(r.initSeen).toBe(true);
    expect((r.memoryPaths as { auto?: unknown } | undefined)?.auto).toEqual(expect.any(String));
  });
  it("a frame without the key, and a stream without an init frame, are told apart", () => {
    expect(initMemoryPaths(['{"type":"system","subtype":"init","tools":[]}'])).toEqual({ initSeen: true, memoryPaths: undefined });
    expect(initMemoryPaths(['{"type":"assistant"}', "not json"])).toEqual({ initSeen: false, memoryPaths: undefined });
  });
});

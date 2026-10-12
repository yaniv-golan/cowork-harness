// Replay never executes a command metric: it reports the value frozen at record time, only under the declaration it
// was measured under, without resolving or reading the script. The cassette stamps v18 only for a command metric.
import { describe, it, expect } from "vitest";
import { ScenarioMetric, type RunResult } from "../src/types.js";
import { requiredVersionFor, freezeCommandMetrics, frozenCommandOutcomes, replayMetrics } from "../src/run/cassette.js";
import { resolvedCommand } from "../src/metric-command/resolve.js";

const cmd = (m: object = {}) =>
  ScenarioMetric.parse({ id: "n", better: "lower", unbounded: true, command: ["../metrics/none.mjs", "--strict"], ...m });
const art = ScenarioMetric.parse({ id: "a", better: "lower", unbounded: true, artifact: "outputs/m.json", path: "x" });
const measured: RunResult["metrics"] = [
  {
    id: "n",
    value: 4,
    command: {
      sig: "abcd",
      script: "metrics/none.mjs",
      scriptSha256: "e".repeat(64),
      eventsSha256: "f".repeat(64),
      interpreter: "node v25",
    },
  },
];

describe("cassette version", () => {
  it("a command metric stamps v18; an artifact-only scenario stamps exactly what it did", () => {
    const base = { prompt: "x", fidelity: "container" };
    expect(requiredVersionFor({ ...base, metrics: [cmd()] })).toBe(18);
    expect(requiredVersionFor({ ...base, metrics: [art] })).toBe(requiredVersionFor(base));
  });
});

describe("freeze and serve", () => {
  const frozen = freezeCommandMetrics([cmd(), art], measured).commandMetrics;

  it("freezes only command metrics, with their declaration tuple", () => {
    expect(frozen).toHaveLength(1);
    expect(frozen![0]).toMatchObject({ id: "n", value: 4, sig: "abcd", script: "metrics/none.mjs" });
  });

  it("serves the frozen value under the same declaration, marked frozen — without resolving the (missing) script", () => {
    const d = cmd();
    const o = frozenCommandOutcomes([d], frozen).get("n")!;
    expect(o.value).toBe(4);
    expect(o.command?.frozen).toBe(true);
    expect(resolvedCommand(d)).toBeUndefined();
  });

  it.each([
    ["the args", { command: ["../metrics/none.mjs", "--lenient"] }],
    ["a dep", { deps: ["../metrics/x.mjs"] }],
    ["the timeout", { timeout_ms: 5000 }],
  ])("a declaration whose %s changed (e.g. --assert-from an edited scenario) reads command_changed, never the old number", (_w, change) => {
    expect(frozenCommandOutcomes([cmd(change)], frozen).get("n")!.unavailable).toBe("command_changed");
  });

  it("no frozen entry (a pre-v18 recording) reads command_not_allowed", () => {
    expect(frozenCommandOutcomes([cmd()], undefined).get("n")!.unavailable).toBe("command_not_allowed");
  });

  it("replayMetrics places the frozen value among the artifact metrics, never spawning anything", () => {
    const ctx = { workRoot: "/nonexistent", lane: "local" } as never;
    const out = replayMetrics(ctx, [cmd(), art], frozen)!;
    expect(out[0]).toMatchObject({ id: "n", value: 4, command: { frozen: true } });
    expect(out[1].id).toBe("a");
  });
});

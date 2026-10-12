// hillclimb regrade's command-metric seam: the ROW is the source of truth (never result.json), `nondeterministic` is
// sticky, and a command metric's unavailable outcome replaces a value where an artifact metric's never does.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioMetric, type RunResult, type Scenario } from "../src/types.js";
import { resolveCommandMetrics } from "../src/metric-command/resolve.js";
import { metricSig } from "../src/metric-sig.js";
import { rowCommandOutcomes, withRemeasured } from "../src/hillclimb/regrade.js";
import type { HillclimbCase } from "../src/hillclimb/cases.js";

let root: string;
let c: HillclimbCase;
let run: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hcrow-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scenarios"), { recursive: true });
  mkdirSync(join(repo, "metrics"), { recursive: true });
  writeFileSync(join(repo, "scenarios", "s.yaml"), "x: 1\n");
  writeFileSync(
    join(repo, "metrics", "count.mjs"),
    "import {readFileSync} from 'node:fs'; console.log(readFileSync(process.argv[2],'utf8').split('\\n').filter(Boolean).length)",
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  const m = ScenarioMetric.parse({ id: "n", better: "lower", unbounded: true, command: ["../metrics/count.mjs"] });
  const art = ScenarioMetric.parse({ id: "a", better: "lower", unbounded: true, artifact: "outputs/m.json", path: "x" });
  const file = join(repo, "scenarios", "s.yaml");
  resolveCommandMetrics({ metrics: [m] }, file);
  c = { id: "s", stem: "s", name: "s", file, scenario: { metrics: [m, art] } as unknown as Scenario } as HillclimbCase;
  run = join(root, "run");
  mkdirSync(join(run, "turns", "1"), { recursive: true });
  writeFileSync(join(run, "events.jsonl"), '{"a":1}\n{"b":2}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sig = () => metricSig(c.scenario.metrics![0]);
const result = (value: number) =>
  ({ metrics: [{ id: "n", value, command: { sig: sig(), script: "metrics/count.mjs", scriptSha256: "x" } }] }) as unknown as RunResult;
const row = (o: { value?: number; reason?: string; withSig?: boolean }) => ({
  grade: o.value !== undefined ? { n: o.value, n_present: 1 } : { n_present: 0 },
  meta: { ...(o.withSig === false ? {} : { metric_sigs: { n: sig() } }), ...(o.reason ? { metrics_unavailable: { n: o.reason } } : {}) },
});

describe("rowCommandOutcomes", () => {
  it("without consent the ROW's value wins over result.json's", async () => {
    const out = await rowCommandOutcomes(run, c, result(7), { row: row({ value: 5 }) });
    expect(out.get("n")).toMatchObject({ value: 5 });
  });
  it("without consent the row's reason is kept", async () => {
    expect((await rowCommandOutcomes(run, c, result(7), { row: row({ reason: "command_timeout" }) })).get("n")).toMatchObject({
      unavailable: "command_timeout",
    });
  });
  it("nondeterministic is sticky — with or without consent, result.json's value never comes back", async () => {
    expect((await rowCommandOutcomes(run, c, result(2), { row: row({ reason: "nondeterministic" }) })).get("n")!.unavailable).toBe(
      "nondeterministic",
    );
    expect(
      (await rowCommandOutcomes(run, c, result(2), { row: row({ reason: "nondeterministic" }), allowMetricCommands: true })).get("n")!
        .unavailable,
    ).toBe("nondeterministic");
  });
  it("a row that predates the metric (no sig) reads command_not_allowed without consent", async () => {
    expect((await rowCommandOutcomes(run, c, result(2), { row: row({ withSig: false }) })).get("n")!.unavailable).toBe(
      "command_not_allowed",
    );
  });
  it("with consent, a fresh value that differs from the ROW's is nondeterministic", async () => {
    // The events hold 2 lines; result.json agrees (2) but the row holds 9.
    const out = await rowCommandOutcomes(run, c, result(2), { row: row({ value: 9 }), allowMetricCommands: true });
    expect(out.get("n")!.unavailable).toBe("nondeterministic");
  });
  it("with consent and agreement, the fresh value", async () => {
    expect((await rowCommandOutcomes(run, c, result(2), { row: row({ value: 2 }), allowMetricCommands: true })).get("n")).toMatchObject({
      value: 2,
    });
  });
});

describe("withRemeasured", () => {
  it("a command metric's unavailable outcome replaces the value; an artifact metric's does not", () => {
    const live = {
      metrics: [
        { id: "n", value: 5 },
        { id: "a", value: 3 },
      ],
    } as unknown as RunResult;
    const out = withRemeasured(
      live,
      {
        metrics: [
          { id: "n", unavailable: "nondeterministic" },
          { id: "a", unavailable: "pruned" },
        ],
      },
      c,
    );
    expect(out.metrics).toEqual([
      { id: "n", unavailable: "nondeterministic" },
      { id: "a", value: 3 },
    ]);
  });
});

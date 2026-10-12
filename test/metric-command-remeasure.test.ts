// The grading-path producer (regrade / verify-run): carry-forward without consent, sig and events checks, and the
// consented re-run's regrade-vs-recorded determinism check.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioMetric, type MetricCommandRecord } from "../src/types.js";
import { resolveCommandMetrics } from "../src/metric-command/resolve.js";
import { measureCommandMetrics, remeasureCommandMetrics } from "../src/metric-command/live.js";

let root: string;
let repo: string;
let run: string;
const scen = () => join(repo, "scenarios", "s.yaml");
const write = (rel: string, body: string) => {
  writeFileSync(join(repo, rel), body);
  execFileSync("git", ["add", "-A"], { cwd: repo });
};
const decl = (m: object = {}) =>
  ScenarioMetric.parse({ id: "n", better: "lower", unbounded: true, command: ["../metrics/count.mjs"], ...m });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cmdrem-")));
  repo = join(root, "repo");
  run = join(root, "run");
  mkdirSync(join(repo, "scenarios"), { recursive: true });
  mkdirSync(join(repo, "metrics"), { recursive: true });
  mkdirSync(join(run, "turns", "1"), { recursive: true });
  writeFileSync(scen(), "x: 1\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(
    "metrics/count.mjs",
    "import {readFileSync} from 'node:fs'; console.log(readFileSync(process.argv[2],'utf8').split('\\n').filter(Boolean).length)",
  );
  write("metrics/_a.mjs", "export const A = 1");
  writeFileSync(join(run, "events.jsonl"), '{"a":1}\n{"b":2}\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** What the live run recorded for `m`. */
async function recordLive(m: ScenarioMetric) {
  resolveCommandMetrics({ metrics: [m] }, scen());
  const r = (await measureCommandMetrics([m], { outDir: run, turn: 1, secrets: [], scrubEvents: true })).get(m.id)!;
  return [
    {
      id: m.id,
      ...(r.value !== undefined ? { value: r.value } : { unavailable: r.unavailable }),
      command: r.command as MetricCommandRecord,
    },
  ];
}
const remeasure = (m: ScenarioMetric, recorded: Awaited<ReturnType<typeof recordLive>> | undefined, allow: boolean) =>
  remeasureCommandMetrics([m], { scenarioPath: scen(), outDir: run, turn: 1, recorded, allow, secrets: [] }).then((o) => o.get(m.id)!);

describe("remeasureCommandMetrics", () => {
  it("without consent the recorded value is carried, stamped carried: true — never presented as fresh", async () => {
    const recorded = await recordLive(decl());
    const r = await remeasure(decl(), recorded, false);
    expect(r.value).toBe(2);
    expect(r.command?.carried).toBe(true);
  });

  it("without consent and nothing recorded: command_not_allowed", async () => {
    expect((await remeasure(decl(), undefined, false)).unavailable).toBe("command_not_allowed");
  });

  it.each([
    ["only the args", { command: ["../metrics/count.mjs", "--lenient"] }],
    ["only a dep path", { deps: ["../metrics/_a.mjs"] }],
    ["only the timeout", { timeout_ms: 5000 }],
  ])("a declaration whose %s changed is command_changed, with or without consent", async (_w, change) => {
    const recorded = await recordLive(decl());
    expect((await remeasure(decl(change), recorded, false)).unavailable).toBe("command_changed");
    expect((await remeasure(decl(change), recorded, true)).unavailable).toBe("command_changed");
  });

  it("the dep ORDER is part of the declaration", async () => {
    write("metrics/_b.mjs", "export const B = 1");
    const recorded = await recordLive(decl({ deps: ["../metrics/_a.mjs", "../metrics/_b.mjs"] }));
    expect((await remeasure(decl({ deps: ["../metrics/_b.mjs", "../metrics/_a.mjs"] }), recorded, false)).unavailable).toBe(
      "command_changed",
    );
  });

  it("events that changed since the run are pruned", async () => {
    const recorded = await recordLive(decl());
    appendFileSync(join(run, "events.jsonl"), '{"late":1}\n');
    expect((await remeasure(decl(), recorded, false)).unavailable).toBe("pruned");
  });

  it("a script that is gone at regrade is command_missing", async () => {
    const recorded = await recordLive(decl());
    rmSync(join(repo, "metrics", "count.mjs"));
    expect((await remeasure(decl(), recorded, true)).unavailable).toBe("command_missing");
  });

  it("with consent, a fresh value that differs from the recorded one is nondeterministic, naming both", async () => {
    const recorded = await recordLive(decl());
    const forged = [{ ...recorded[0], value: 99 }];
    const r = await remeasure(decl(), forged, true);
    expect(r.unavailable).toBe("nondeterministic");
    expect(r.why).toMatch(/re-measured 2 .* recorded 99/);
  });

  it("with consent and an agreeing value, the fresh measurement is reported (not carried)", async () => {
    const recorded = await recordLive(decl());
    const r = await remeasure(decl(), recorded, true);
    expect(r.value).toBe(2);
    expect(r.command?.carried).toBeUndefined();
  });
});

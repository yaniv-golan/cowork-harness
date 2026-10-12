// The live producer: a turn's slice of the RAW events.jsonl, scrubbed with the run's secret set, is what the script
// reads — and its eventsSha256 equals the sha of the same slice of the file AFTER the run's real final scrub
// (scrubRawRunLogs), so a later regrade over the kept file reads identical bytes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioMetric } from "../src/types.js";
import { resolveCommandMetrics } from "../src/metric-command/resolve.js";
import { measureCommandMetrics, turnEventsBytes, commandMetricNotice } from "../src/metric-command/live.js";
import { sliceTurnEvents } from "../src/metric-command/slice.js";
import { scrubRawRunLogs } from "../src/run/execute.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cmdlive-")));
  mkdirSync(join(root, "repo", "scenarios"), { recursive: true });
  mkdirSync(join(root, "repo", "metrics"), { recursive: true });
  writeFileSync(join(root, "repo", "scenarios", "s.yaml"), "x: 1\n");
  writeFileSync(
    join(root, "repo", "metrics", "echo.mjs"),
    "import {readFileSync} from 'node:fs'; const t = readFileSync(process.argv[2],'utf8'); console.error(t); console.log(t.includes('TOPSECRET') ? 1 : 0)",
  );
  execFileSync("git", ["init", "-q"], { cwd: join(root, "repo") });
  execFileSync("git", ["add", "-A"], { cwd: join(root, "repo") });
  mkdirSync(join(root, "run", "turns", "1"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const decl = () => {
  const d = ScenarioMetric.parse({ id: "leak", better: "lower", unbounded: true, command: ["../metrics/echo.mjs"] });
  resolveCommandMetrics({ metrics: [d] }, join(root, "repo", "scenarios", "s.yaml"));
  return d;
};

describe("measureCommandMetrics (live)", () => {
  it("the script reads the scrubbed slice, and eventsSha256 equals the post-finally slice of the real scrubbed file", async () => {
    const run = join(root, "run");
    writeFileSync(join(run, "events.jsonl"), '{"type":"assistant","text":"key TOPSECRET here"}\n{"type":"result"}\n');
    const d = decl();
    const out = await measureCommandMetrics([d], { outDir: run, turn: 1, secrets: ["TOPSECRET"], scrubEvents: true });
    const r = out.get("leak")!;
    expect(r.value).toBe(0); // the script never saw the secret
    // The run's own final scrub, then the same slice: the same bytes the script read.
    scrubRawRunLogs(run, ["TOPSECRET"]);
    const kept = sliceTurnEvents(readFileSync(join(run, "events.jsonl")), 1);
    expect("bytes" in kept && createHash("sha256").update(kept.bytes).digest("hex")).toBe(r.command.eventsSha256);
    // And the stderr head is kept, scrubbed.
    const log = readFileSync(join(run, "turns", "1", "metrics", "leak.stderr.txt"), "utf8");
    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain("TOPSECRET");
  });

  it("a regrade over the kept file reads it verbatim and gets the same eventsSha256", async () => {
    const run = join(root, "run");
    writeFileSync(join(run, "events.jsonl"), '{"type":"assistant","text":"key TOPSECRET here"}\n');
    const live = (await measureCommandMetrics([decl()], { outDir: run, turn: 1, secrets: ["TOPSECRET"], scrubEvents: true })).get("leak")!;
    scrubRawRunLogs(run, ["TOPSECRET"]);
    const regrade = (await measureCommandMetrics([decl()], { outDir: run, turn: 1, secrets: [], scrubEvents: false })).get("leak")!;
    expect(regrade.command.eventsSha256).toBe(live.command.eventsSha256);
  });

  it("no events.jsonl, or a later turn with no marker, is no_events", async () => {
    const run = join(root, "run");
    expect((await measureCommandMetrics([decl()], { outDir: run, turn: 1, secrets: [], scrubEvents: true })).get("leak")!.unavailable).toBe(
      "no_events",
    );
    writeFileSync(join(run, "events.jsonl"), '{"type":"result"}\n');
    expect(turnEventsBytes(run, 2)).toEqual({ none: "events.jsonl has no turn_start marker for turn 2" });
    expect((await measureCommandMetrics([decl()], { outDir: run, turn: 2, secrets: [], scrubEvents: true })).get("leak")!.unavailable).toBe(
      "no_events",
    );
  });

  it("an unresolved command metric is command_missing, never executed", async () => {
    const d = ScenarioMetric.parse({ id: "leak", better: "lower", unbounded: true, command: ["../metrics/echo.mjs"] });
    writeFileSync(join(root, "run", "events.jsonl"), "{}\n");
    expect(
      (await measureCommandMetrics([d], { outDir: join(root, "run"), turn: 1, secrets: [], scrubEvents: true })).get("leak")!.unavailable,
    ).toBe("command_missing");
  });

  it("the notice names the script, its root-relative path and its sha", () => {
    expect(commandMetricNotice([decl()])[0]).toMatch(
      /^\[metrics\] leak: runs metrics\/echo\.mjs \(sha [0-9a-f]{12}\) over this run's events, as you, after the run$/,
    );
  });
});

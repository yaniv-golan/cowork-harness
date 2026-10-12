// The live (and consented re-measure) producer of command-metric outcomes for one turn of a run dir: read the turn's
// slice of events.jsonl, scrub it with the run's secret set (live: the raw file, scrubbed exactly as the run's final
// scrub will scrub it; regrade: the kept, already-scrubbed file, verbatim), run each command, and keep each script's
// scrubbed stderr head at turns/<N>/metrics/<id>.stderr.txt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MetricCommandRecord, MetricUnavailable, ScenarioMetric } from "../types.js";
import type { CommandOutcomes, MetricMeasurement } from "../metrics.js";
import { metricSig } from "../metric-sig.js";
import { scrub } from "../secrets.js";
import { isCommandMetric } from "../metrics.js";
import { resolveCommandMetrics, resolvedCommand } from "./resolve.js";
import { runCommandMetric, type CommandMeasurement } from "./run.js";
import { sliceTurnEvents } from "./slice.js";

/** The bytes a turn's command metrics read, or why there are none. `scrubWith` set: the file is RAW (a live run, or a
 *  kept dir whose run died before its final scrub) and is scrubbed with that set; unset: read verbatim. */
export function turnEventsBytes(outDir: string, turn: number, scrubWith?: string[]): { bytes: Buffer } | { none: string } {
  const p = join(outDir, "events.jsonl");
  if (!existsSync(p)) return { none: "the run has no events.jsonl" };
  const slice = sliceTurnEvents(readFileSync(p), turn);
  if ("none" in slice) return { none: `events.jsonl has no turn_start marker for turn ${turn}` };
  return { bytes: scrubWith ? Buffer.from(scrub(slice.bytes.toString("utf8"), scrubWith), "utf8") : slice.bytes };
}

export async function measureCommandMetrics(
  decls: readonly ScenarioMetric[],
  o: { outDir: string; turn: number; secrets: string[]; scrubEvents: boolean; deadline?: number },
): Promise<Map<string, CommandMeasurement>> {
  const out = new Map<string, CommandMeasurement>();
  const cmds = decls.filter(isCommandMetric);
  if (cmds.length === 0) return out;
  const ev = turnEventsBytes(o.outDir, o.turn, o.scrubEvents ? o.secrets : undefined);
  for (const m of cmds) {
    const resolved = resolvedCommand(m);
    if (resolved === undefined) {
      out.set(m.id, {
        id: m.id,
        unavailable: "command_missing",
        why: "the scenario's command metric was never resolved against its files (a scenario not loaded from a file)",
        command: { sig: "", script: m.command[0], scriptSha256: "" },
        stderr: "",
      });
      continue;
    }
    const r = await runCommandMetric({
      metric: m,
      resolved,
      events: "bytes" in ev ? ev.bytes : undefined,
      ...("none" in ev ? { noEventsWhy: ev.none } : {}),
      secrets: o.secrets,
      ...(o.deadline !== undefined ? { deadline: o.deadline } : {}),
    });
    if (r.stderr) {
      const dir = join(o.outDir, "turns", String(o.turn), "metrics");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${m.id}.stderr.txt`), r.stderr);
    }
    out.set(m.id, r);
  }
  return out;
}

/** The outcomes in the shape `metricsFor` places among the artifact metrics. */
export function asOutcomes(ms: ReadonlyMap<string, CommandMeasurement>): CommandOutcomes {
  return new Map(
    [...ms].map(([id, r]) => [
      id,
      {
        id,
        ...(r.value !== undefined ? { value: r.value } : { unavailable: r.unavailable! }),
        ...(r.why ? { why: r.why } : {}),
        command: r.command,
      },
    ]),
  );
}

/** The one-line notice a live run prints before spending, per command metric: it runs repo code as the operator. */
export function commandMetricNotice(decls: readonly ScenarioMetric[]): string[] {
  return decls.filter(isCommandMetric).map((m) => {
    const r = resolvedCommand(m);
    return `[metrics] ${m.id}: runs ${r ? `${r.scriptRel} (sha ${r.scriptSha256.slice(0, 12)})` : m.command[0]} over this run's events, as you, after the run`;
  });
}

/** The re-measure producer for a grading path (`regrade`, `verify-run`) over one kept turn, given the run's recorded
 *  entries:
 *  - the CURRENT scenario's command is resolved; a script or dep that is gone, uncontained, untracked or hard-linked
 *    is `command_missing`;
 *  - its signature must equal the recorded one, or `command_changed`;
 *  - the kept slice's sha must equal the recorded `eventsSha256`, or `pruned` (the kept tree no longer holds what the
 *    run wrote — a late append, a hand edit, or a raw file a killed run never scrubbed);
 *  - without consent (`allow` false) the recorded entry is carried forward, stamped `carried: true` — never presented as
 *    freshly measured; with nothing recorded it is `command_not_allowed`;
 *  - with consent it runs; a fresh value that differs from a recorded value is `nondeterministic`, naming both values
 *    and both interpreters (the row loses the value rather than picking one). With no recorded entry (a metric added
 *    later, or a run killed before its metrics ran) the slice is scrubbed with this process's secret set first. */
export async function remeasureCommandMetrics(
  decls: readonly ScenarioMetric[],
  o: {
    scenarioPath: string;
    outDir: string;
    turn: number;
    recorded: ReadonlyArray<{ id: string; value?: number; unavailable?: string; command?: MetricCommandRecord }> | undefined;
    allow: boolean;
    secrets: string[];
    warn?: (line: string) => void;
  },
): Promise<CommandOutcomes> {
  const out = new Map<string, MetricMeasurement & { command?: MetricCommandRecord }>();
  for (const m of decls.filter(isCommandMetric)) {
    const rec = o.recorded?.find((r) => r.id === m.id);
    const recCmd = rec?.command;
    try {
      resolveCommandMetrics({ metrics: [m] }, o.scenarioPath);
    } catch (e) {
      out.set(m.id, { id: m.id, unavailable: "command_missing", why: (e as Error).message });
      continue;
    }
    const resolved = resolvedCommand(m)!;
    const sig = metricSig(m);
    const base: MetricCommandRecord = { sig, script: resolved.scriptRel, scriptSha256: resolved.scriptSha256 };
    if (recCmd !== undefined && recCmd.sig !== sig) {
      out.set(m.id, {
        id: m.id,
        unavailable: "command_changed",
        why: `the declaration changed since the run measured it (signature ${recCmd.sig} recorded, ${sig} now)`,
        command: base,
      });
      continue;
    }
    const ev = turnEventsBytes(o.outDir, o.turn);
    const evSha = "bytes" in ev ? sha256(ev.bytes) : undefined;
    if (recCmd?.eventsSha256 !== undefined && evSha !== recCmd.eventsSha256) {
      out.set(m.id, {
        id: m.id,
        unavailable: "pruned",
        why: "the kept events no longer equal what the script read at the run (a late append, an edit, or an unscrubbed file)",
        command: base,
      });
      continue;
    }
    if (!o.allow) {
      if (rec === undefined || recCmd === undefined) {
        out.set(m.id, {
          id: m.id,
          unavailable: "command_not_allowed",
          why: "nothing recorded to carry; pass --allow-metric-commands to run it",
          command: base,
        });
        o.warn?.(`metric "${m.id}": a command metric with no recorded value is not run without --allow-metric-commands`);
        continue;
      }
      out.set(m.id, {
        id: m.id,
        ...(typeof rec.value === "number"
          ? { value: rec.value }
          : { unavailable: (rec.unavailable ?? "command_not_allowed") as MetricUnavailable }),
        why: "carried forward from the run's own measurement (not re-run)",
        command: { ...recCmd, carried: true },
      });
      continue;
    }
    const scrubFirst = rec === undefined || recCmd === undefined;
    if (scrubFirst)
      o.warn?.(
        `metric "${m.id}": no recorded measurement — the kept events are scrubbed with this process's secret set before the script reads them`,
      );
    const fresh = (await measureCommandMetrics([m], { outDir: o.outDir, turn: o.turn, secrets: o.secrets, scrubEvents: scrubFirst })).get(
      m.id,
    )!;
    if (typeof fresh.value === "number" && typeof rec?.value === "number" && fresh.value !== rec.value) {
      out.set(m.id, {
        id: m.id,
        unavailable: "nondeterministic",
        why: `re-measured ${fresh.value} (${fresh.command.interpreter ?? "?"}) where the run recorded ${rec.value} (${recCmd?.interpreter ?? "?"}) over the same events`,
        command: fresh.command,
      });
      continue;
    }
    out.set(m.id, {
      id: m.id,
      ...(fresh.value !== undefined ? { value: fresh.value } : { unavailable: fresh.unavailable! }),
      ...(fresh.why ? { why: fresh.why } : {}),
      command: fresh.command,
    });
  }
  return out;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

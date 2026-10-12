// The live (and consented re-measure) producer of command-metric outcomes for one turn of a run dir: read the turn's
// slice of events.jsonl, scrub it with the run's secret set (live: the raw file, scrubbed exactly as the run's final
// scrub will scrub it; regrade: the kept, already-scrubbed file, verbatim), run each command, and keep each script's
// scrubbed stderr head at turns/<N>/metrics/<id>.stderr.txt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioMetric } from "../types.js";
import type { CommandOutcomes } from "../metrics.js";
import { scrub } from "../secrets.js";
import { isCommandMetric } from "../metrics.js";
import { resolvedCommand } from "./resolve.js";
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

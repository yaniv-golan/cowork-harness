import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../types.js";

/** A compact, depth-1 preview of a JSON artifact: scalars kept inline, arrays shown as a count, nested
 *  objects collapsed to `{…}` — enough to answer "did it produce the right fields?" without dumping blobs. */
function shallowPreview(doc: unknown): Record<string, unknown> | string {
  if (Array.isArray(doc)) return `[${doc.length} items]`;
  if (!doc || typeof doc !== "object") return { value: doc } as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = `[${v.length} items]`;
    else if (v && typeof v === "object") out[k] = "{…}";
    else out[k] = v;
  }
  return out;
}

interface InspectDigest {
  scenario: string;
  fidelity: string;
  result: string;
  partial?: boolean;
  unansweredGate?: { message: string; hint?: string };
  durationMs?: number;
  cost?: RunResult["cost"];
  workDirAvailable: boolean;
  artifacts: { path: string; bytes: number; preview?: Record<string, unknown> | string }[];
}

function humanMs(ms?: number): string {
  if (!ms && ms !== 0) return "?";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Build the digest for one kept run dir: header facts + the artifacts manifest, with a shallow field
 *  preview for each JSON artifact (read from the work dir, which result.json records). The manifest
 *  (paths + sizes) lives in result.json and always survives; the content preview needs the work dir, which
 *  a non-`--keep` container/microvm run tears down. */
function digestFor(runDir: string): InspectDigest {
  const resultPath = join(runDir, "result.json");
  if (!existsSync(resultPath))
    throw new Error(`no result.json under ${runDir} (is this a kept run dir? e.g. runs/<scenario>/<sessionId>/)`);
  let result: RunResult;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
  } catch (e) {
    throw new Error("failed to parse result.json at " + resultPath + ": " + (e as Error).message);
  }
  const workDir = result.workDir ?? "";
  const workDirAvailable = !!workDir && existsSync(workDir);
  const artifacts = (result.artifacts ?? []).map((a) => {
    const entry: InspectDigest["artifacts"][number] = { path: a.path, bytes: a.bytes };
    if (workDirAvailable && a.path.endsWith(".json")) {
      const abs = join(workDir, a.path);
      if (existsSync(abs)) {
        try {
          entry.preview = shallowPreview(JSON.parse(readFileSync(abs, "utf8")));
        } catch {
          /* not valid JSON after all — leave preview off */
        }
      }
    }
    return entry;
  });
  return {
    scenario: result.scenario,
    fidelity: result.fidelity,
    result: result.result,
    ...(result.partial ? { partial: true } : {}),
    ...(result.unansweredGate ? { unansweredGate: result.unansweredGate } : {}),
    durationMs: result.durationMs,
    ...(result.cost ? { cost: result.cost } : {}),
    workDirAvailable,
    artifacts,
  };
}

/** Render a run dir for the `inspect` command. `json` mode returns the structured digest; text mode returns
 *  a human summary: header, a PARTIAL banner if the run didn't complete, and each artifact with a shallow
 *  field preview (or a "work dir torn down" note when content can't be read). */
export function buildInspectView(runDir: string, opts: { json?: boolean } = {}): string {
  const d = digestFor(runDir);
  if (opts.json) return JSON.stringify(d, null, 2);

  const lines: string[] = [];
  lines.push(`run: ${d.scenario}  (${d.fidelity})  result: ${d.result}  ${humanMs(d.durationMs)}`);
  if (d.partial) {
    lines.push(`⚠ PARTIAL — this run did NOT complete (exited on an unanswered gate); artifacts below are pre-failure.`);
    if (d.unansweredGate) lines.push(`  gate: ${d.unansweredGate.message.split("\n")[0]}`);
  }
  lines.push(`artifacts (${d.artifacts.length}):`);
  for (const a of d.artifacts) {
    lines.push(`  ${a.path}  (${a.bytes} B)`);
    if (a.preview && typeof a.preview === "object") {
      for (const [k, v] of Object.entries(a.preview)) lines.push(`    ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    } else if (typeof a.preview === "string") {
      lines.push(`    ${a.preview}`);
    }
  }
  if (!d.workDirAvailable && d.artifacts.some((a) => a.path.endsWith(".json"))) {
    lines.push(`  (work dir torn down — re-run with --keep to preview artifact contents)`);
  }
  return lines.join("\n");
}

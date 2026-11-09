#!/usr/bin/env tsx
// Names what a `subagent-manifest-probe` run's sub-agent did to deliver its note, for the release gate's notes.
// The probe's assertions say pass or fail; this says which of four outcomes the run was. It prints exactly one:
//
//   vm-path refused     a sub-agent sent a file tool a `/sessions/` path and was refused, whatever happened next
//   host-path write     a sub-agent's Write, Edit or MultiEdit of the note returned a non-error result
//   shell write         a sub-agent's shell command wrote the note (a heuristic over the command text)
//   no sub-agent write  none of the above, including a delivery the main loop made after a sub-agent gave up
//
// Usage: npx tsx scripts/classify-manifest-probe.ts <run>/turns/<n>/result.json
// Exits 0 with the outcome on stdout, 2 when the file cannot be read or predates the fields this reads.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../src/types.js";

export const MANIFEST_PROBE_OUTCOMES = ["vm-path refused", "host-path write", "shell write", "no sub-agent write"] as const;
export type ManifestProbeOutcome = (typeof MANIFEST_PROBE_OUTCOMES)[number];

/** The result lacks a field the classification needs, so no outcome can be claimed. */
export class ManifestProbeEvidenceError extends Error {}

const NOTE = "manifest-probe-check.md";
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const SHELL_TOOLS = new Set(["mcp__workspace__bash", "Bash"]);
const NOTE_WRITE_COMMAND = new RegExp(String.raw`(>|\b(?:tee|cp|mv|install|dd)\b)[^;|&\n]*${NOTE.replace(".", "\\.")}`);

type Probed = Pick<RunResult, "fileToolAttempts" | "toolResults" | "pathDenials" | "toolCalls">;

export function classifyManifestProbe(result: Probed): ManifestProbeOutcome {
  const { fileToolAttempts: attempts, toolResults: results, pathDenials: denials = [], toolCalls } = result;
  if (attempts === undefined || results === undefined)
    throw new ManifestProbeEvidenceError("result.json has no fileToolAttempts or toolResults (a run from an older harness)");
  const hasResult = (id: string | undefined, isError: boolean): boolean =>
    id !== undefined && results.some((r) => r.toolUseId === id && r.isError === isError);
  const writes = attempts.filter((a) => a.origin === "subagent" && WRITE_TOOLS.has(a.tool));

  const refused = writes.some(
    (a) =>
      a.gatePath?.startsWith("/sessions/") === true &&
      (hasResult(a.toolUseId, true) ||
        denials.some((d) => (d.toolUseId !== undefined && d.toolUseId === a.toolUseId) || (d.tool === a.tool && d.path === a.gatePath))),
  );
  if (refused) return "vm-path refused";

  if (writes.some((a) => a.gatePath?.endsWith(`/outputs/${NOTE}`) === true && hasResult(a.toolUseId, false))) return "host-path write";

  if (toolCalls === undefined) throw new ManifestProbeEvidenceError("result.json has no toolCalls, so a shell write cannot be ruled out");
  const shellWrote = toolCalls.some((c) => {
    const command = c.input.command?.text;
    return (
      c.origin === "subagent" &&
      SHELL_TOOLS.has(c.name) &&
      command !== undefined &&
      NOTE_WRITE_COMMAND.test(command) &&
      hasResult(c.toolUseId, false)
    );
  });
  return shellWrote ? "shell write" : "no sub-agent write";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  if (file === undefined || rest.length > 0) {
    process.stderr.write("usage: classify-manifest-probe.ts <run>/turns/<n>/result.json\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${classifyManifestProbe(JSON.parse(readFileSync(file, "utf8")) as Probed)}\n`);
  } catch (e) {
    process.stderr.write(`classify-manifest-probe: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}

import { readFileSync } from "node:fs";
import type { RunResult } from "../types.js";
import { computeVerdict } from "./verdict.js";

/** Package version (for the json envelope + `--version`). Resolved package-relative. */
export function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type ErrCategory = "usage" | "unanswered" | "boundary" | "runtime" | "internal";

/** Validate `--output-format <v>` is text|json (shared by every command). Returns the resolved format;
 *  THROWS on an invalid value so the caller renders a usage error instead of silently treating an
 *  unrecognized value (e.g. `--output-format xml`) as text. */
export function parseOutputFormat(args: string[]): "text" | "json" {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output-format") {
      const v = args[i + 1];
      if (v !== "text" && v !== "json")
        throw new Error(`--output-format must be "text" or "json" (got ${v === undefined ? "nothing" : `"${v}"`})`);
      return v;
    }
    if (args[i] === "--output-format=json") return "json";
    if (args[i] === "--output-format=text") return "text";
  }
  return "text";
}

/** §5a — the standardized machine envelope object (internal: `jsonEnvelope` stringifies it). `ok` is the
 *  same SEAM-B verdict as the process exit code / footer (it cannot diverge). `replay` uses the replay
 *  lane (a cassette can't reproduce the scan/permissive signals); every other command is the live lane. */
function jsonEnvelopeObj(command: string, results: RunResult[]): Record<string, unknown> {
  const lane = command === "replay" ? "replay" : "live";
  const ok = results.length > 0 && results.every((r) => computeVerdict(r, lane).pass);
  return { tool: "cowork-harness", version: pkgVersion(), command, ok, results, error: null };
}

/** §5a — the standardized machine envelope emitted by every `--output-format json` command. COMPACT
 *  single-line JSON (machine output → trivially parseable; the pretty form lives in result.json). */
export function jsonEnvelope(command: string, results: RunResult[]): string {
  return JSON.stringify(jsonEnvelopeObj(command, results));
}

/** §5c — the error envelope (compact, single line). */
export function jsonError(command: string, category: ErrCategory, message: string, hint?: string): string {
  return JSON.stringify({
    tool: "cowork-harness",
    version: pkgVersion(),
    command,
    ok: false,
    results: [],
    error: { category, message, ...(hint ? { hint } : {}) },
  });
}

import { readFileSync } from "node:fs";
import type { RunResult } from "../types.js";

/** Package version (for the json envelope + `--version`). Resolved package-relative. */
export function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type ErrCategory = "usage" | "unanswered" | "boundary" | "runtime" | "internal";

/** §5a — the standardized machine envelope object (internal: `jsonEnvelope` stringifies it). */
function jsonEnvelopeObj(command: string, results: RunResult[]): Record<string, unknown> {
  const ok = results.length > 0 && results.every((r) => r.result === "success" && r.assertions.every((a) => a.pass));
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

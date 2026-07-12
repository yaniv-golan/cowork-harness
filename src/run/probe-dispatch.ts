import type { RunResult } from "../types.js";
import { computeVerdict, type Verdict } from "./verdict.js";

/** One dispatch's projected mechanics — the whole payload of the `probe-dispatch` command. Every field
 *  is derived PARAMETER-FREE from RunResult fields that already exist (`subagents[]` /
 *  `fileToolAttempts` / `pathDenials` / `toolResults`) — no new RunResult field backs this projection. */
export interface DispatchProbeEntry {
  toolUseId: string;
  dispatchAgentType: string; // the DISPATCH-INPUT type ("unknown" when the input omitted it)
  resolvedAgentType?: string; // the BINARY-resolved child type — read this, not dispatchAgentType, for "what actually ran"
  /** the dispatch input carried no subagent_type — the wildcard-fallback trap (tools:["*"]) fired */
  dispatchTypeOmitted?: boolean;
  /** Path denials attributable to THIS dispatch (see `pathDenialsScope`). "unavailable" = evidence
   *  unavailable — RunResult.pathDenials itself is undefined (an older run) — NEVER conflate with a
   *  proven-empty `[]`. (`NonNullable` so a "not unavailable" check narrows to a real array, never
   *  `Array | undefined`.) */
  pathDenials: NonNullable<RunResult["pathDenials"]> | "unavailable";
  /** How `pathDenials` was scoped to this dispatch:
   *  - "per-dispatch" — a real join, not a guess: `subagents[]` carries no `agentId` of its own, but each
   *    pathDenials entry's OWN `toolUseId` is the SAME id as the denied call's `fileToolAttempts` entry
   *    (both producers key off the gated tool_use's own id — see src/run/run.ts's three pathDenials
   *    producers), and THAT entry's `parentToolUseId` is exactly this dispatch's `toolUseId`.
   *  - "run-level" — the join couldn't be made (`fileToolAttempts` is undefined on this run) so the
   *    WHOLE run's `pathDenials` list is shown instead, unscoped — read it as "somewhere in this run",
   *    not "from this dispatch".
   *  - "unavailable" — `pathDenials` itself is undefined. */
  pathDenialsScope: "per-dispatch" | "run-level" | "unavailable";
  /** Did this dispatch produce a paired NON-ERROR sub-agent write? "unavailable" = `fileToolAttempts` or
   *  `toolResults` is undefined — the pairing can't be proven either way, never reported as a false "no". */
  delivered: boolean | "unavailable";
  referencesRead?: string[];
}

export interface DispatchProbeProjection {
  dispatches: DispatchProbeEntry[];
  /** true when `RunResult.subagents` itself is undefined (an older run / no dispatch-tree telemetry) —
   *  `dispatches` is then always `[]`, which must NOT be read as "zero dispatches happened". */
  subagentsUnavailable: boolean;
  verdict: Pick<Verdict, "pass" | "exitCode" | "signals">;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** "did THIS dispatch deliver?" — mirrors the `subagent_dispatch_healthy` assertion's own `delivered`
 *  computation (src/assert.ts), scoped by `parentToolUseId` so a sibling dispatch's write can't satisfy
 *  this one. `expectWriteSuffix` narrows to a write whose path ends with the given suffix. */
function computeDelivered(result: RunResult, dispatchToolUseId: string, expectWriteSuffix: string | undefined): boolean | "unavailable" {
  if (result.fileToolAttempts === undefined || result.toolResults === undefined) return "unavailable";
  const toolResults = result.toolResults;
  return result.fileToolAttempts.some(
    (at) =>
      at.origin === "subagent" &&
      at.parentToolUseId === dispatchToolUseId &&
      WRITE_TOOLS.has(at.tool) &&
      (expectWriteSuffix === undefined || (at.gatePath !== undefined && at.gatePath.endsWith(expectWriteSuffix))) &&
      at.toolUseId !== undefined &&
      toolResults.some((r) => r.toolUseId === at.toolUseId && !r.isError),
  );
}

function computePathDenials(result: RunResult, dispatchToolUseId: string): Pick<DispatchProbeEntry, "pathDenials" | "pathDenialsScope"> {
  if (result.pathDenials === undefined) return { pathDenials: "unavailable", pathDenialsScope: "unavailable" };
  if (result.fileToolAttempts === undefined) return { pathDenials: result.pathDenials, pathDenialsScope: "run-level" };
  const fileToolAttempts = result.fileToolAttempts;
  const ownIds = new Set(
    fileToolAttempts
      .filter((at) => at.parentToolUseId === dispatchToolUseId && at.toolUseId !== undefined)
      .map((at) => at.toolUseId as string),
  );
  const scoped = result.pathDenials.filter((d) => d.toolUseId !== undefined && ownIds.has(d.toolUseId));
  return { pathDenials: scoped, pathDenialsScope: "per-dispatch" };
}

/** Project a `RunResult` down to the `probe-dispatch` output: per-dispatch resolvedAgentType/
 *  pathDenials/delivered/referencesRead, plus the overall assert verdict. Pure + synchronous — the whole
 *  reason this is unit-testable against a synthetic RunResult with no live run. */
export function projectDispatchProbe(result: RunResult, opts: { expectWriteSuffix?: string } = {}): DispatchProbeProjection {
  const subagents = result.subagents;
  const dispatches: DispatchProbeEntry[] = (subagents ?? []).map((s) => ({
    toolUseId: s.toolUseId,
    dispatchAgentType: s.dispatchAgentType,
    resolvedAgentType: s.resolvedAgentType,
    dispatchTypeOmitted: s.dispatchTypeOmitted,
    ...computePathDenials(result, s.toolUseId),
    delivered: computeDelivered(result, s.toolUseId, opts.expectWriteSuffix),
    referencesRead: s.referencesRead,
  }));
  const v = computeVerdict(result, "live");
  return { dispatches, subagentsUnavailable: subagents === undefined, verdict: { pass: v.pass, exitCode: v.exitCode, signals: v.signals } };
}

/** Human text rendering of the projection — the `probe-dispatch` text-mode body (stdout). */
export function formatDispatchProbe(p: DispatchProbeProjection): string {
  const lines: string[] = [];
  if (p.subagentsUnavailable) {
    lines.push("dispatches: unavailable (no sub-agent dispatch tree in this run's result.json)");
  } else if (p.dispatches.length === 0) {
    lines.push("dispatches: none — the prompt did not trigger a Task dispatch");
  } else {
    for (const d of p.dispatches) {
      lines.push(`dispatch ${d.toolUseId} (${d.dispatchAgentType})`);
      const omittedNote = d.dispatchTypeOmitted
        ? "  [dispatchTypeOmitted — subagent_type was omitted from the dispatch input; the wildcard-fallback trap fired]"
        : "";
      lines.push(`  resolvedAgentType: ${d.resolvedAgentType ?? "(unresolved)"}${omittedNote}`);
      lines.push(
        `  delivered: ${d.delivered === "unavailable" ? "unavailable (fileToolAttempts/toolResults not captured on this run)" : d.delivered ? "yes" : "no"}`,
      );
      if (d.pathDenials === "unavailable") {
        lines.push(`  pathDenials: unavailable (RunResult.pathDenials not captured on this run)`);
      } else {
        const scopeNote =
          d.pathDenialsScope === "run-level"
            ? " (run-level — fileToolAttempts unavailable, could not scope to this dispatch specifically)"
            : "";
        lines.push(`  pathDenials: ${d.pathDenials.length}${scopeNote}`);
        for (const pd of d.pathDenials) lines.push(`    - [${pd.source}] ${pd.tool} ${pd.path ?? "(no path)"}`);
      }
      if (d.referencesRead?.length) lines.push(`  referencesRead: ${d.referencesRead.join(", ")}`);
    }
  }
  const sig = p.verdict.signals.length ? ` (${p.verdict.signals.map((s) => s.code).join(", ")})` : "";
  lines.push(`verdict: ${p.verdict.pass ? "PASS" : "FAIL"}${sig}`);
  return lines.join("\n");
}

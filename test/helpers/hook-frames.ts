import { readFileSync } from "node:fs";

/** Frames copied VERBATIM from a live `container` recording of examples/probes/stop-hook-probe.scenario.yaml
 *  (the plugin's Stop hook blocks once with exit 2, then passes with exit 0). Nothing here was hand-typed:
 *  the evaluator is exercised over what the agent actually emits under --include-hook-events. */
export function loadHookFrames(): Array<Record<string, unknown>> {
  return readFrames("test/fixtures/hook-frames/stop-hook-block.events.jsonl");
}

/** Frames copied VERBATIM from a live `container` recording of examples/probes/hook-decision-probe.scenario.yaml:
 *  a PreToolUse hook on Bash that denies by JSON (`permissionDecision: deny`, exit 0), a PreToolUse hook on Write
 *  that exits 2, and a Stop hook that blocks once by JSON (`decision: block`, exit 0) and then passes. */
export function loadHookDecisionFrames(): Array<Record<string, unknown>> {
  return readFrames("test/fixtures/hook-frames/hook-decision.events.jsonl");
}

function readFrames(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

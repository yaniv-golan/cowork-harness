import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { stringify } from "yaml";
import type { RunResult } from "../types.js";
import { buildGateTrace } from "./trace-view.js";

/** Regex-escape a question so the scaffolded `when_question` matches it literally (the author can shorten
 *  it to a stable fragment afterwards). */
function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * SCAFFOLD-FROM-RUN: turn a `--keep` run into a starter scenario YAML, auto-filled from what the run
 * OBSERVED — the gates that fired (as scripted `answers`), the artifacts written (as `file_exists`), the
 * sub-agent count (as `dispatch_count_max`), and the prompt — so authoring is explore→lock instead of
 * guess-and-re-run. The output is a STARTER: review and tighten the `when_question` regexes before committing.
 */
export function buildScaffold(eventsFile: string): string {
  const runDir = dirname(eventsFile);
  const resultPath = join(runDir, "result.json");
  const result: Partial<RunResult> = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};

  // Observed gates → scripted answers (one rule per answered sub-question).
  const answers: { when_question: string; choose: string }[] = [];
  for (const g of buildGateTrace(eventsFile)) {
    if (!g.injectedAnswer) continue;
    let map: Record<string, unknown>;
    try {
      map = JSON.parse(g.injectedAnswer);
    } catch {
      continue;
    }
    for (const [q, a] of Object.entries(map)) answers.push({ when_question: escapeRx(q), choose: String(a) });
  }

  // Observed artifacts → file_exists; sub-agent count → dispatch_count_max; final result.
  const assert: Record<string, unknown>[] = [];
  for (const art of result.artifacts ?? []) assert.push({ file_exists: art.path });
  if ((result.subagents ?? []).length) assert.push({ dispatch_count_max: (result.subagents ?? []).length });
  assert.push({ result: result.result ?? "success" });

  const scenario: Record<string, unknown> = {
    // `result.baseline` is the recorded appVersion; a scenario pins `latest` (or a `desktop-<ver>`) — default
    // to latest and let the author pin if they need a specific release.
    baseline: "latest",
    fidelity: result.fidelity ?? "container",
    prompt: result.prompt ?? "TODO: the prompt you ran (not recoverable from this run)",
    ...(answers.length ? { answers } : {}),
    assert,
  };

  return (
    `# scaffolded by \`cowork-harness scaffold --from-run\` from ${runDir}\n` +
    `# REVIEW before committing: tighten the when_question regexes to stable fragments, prune asserts you don't need.\n` +
    stringify(scenario)
  );
}

import type { GateProvenance, GateProvenanceSummary, RunResult } from "../types.js";

/** Human-facing label for a raw `Decision["by"]` value. Unknown sources pass through verbatim so a
 *  new decider still renders (never dropped or thrown). Shared by the footer and the trace view. */
export function labelSource(by: string): string {
  switch (by) {
    case "scripted":
      return "scripted";
    case "first":
      return "first-option";
    case "llm":
      return "decided(llm)";
    case "external":
      return "decided(external)";
    case "human":
      return "prompt";
    default:
      return by;
  }
}

/** Derive the per-run gate-provenance rollup from the decision log. Pure. Reads ONLY answered
 *  question-kind decisions (AskUserQuestion gates); tool/dialog/elicit decisions are ignored. A gate's
 *  question(s) and answer(s) are the keys/values of its recorded `detail` answers map. */
export function summarizeGateProvenance(decisions: RunResult["decisions"]): GateProvenanceSummary {
  const gates: GateProvenance[] = [];
  const bySource: Record<string, number> = {};
  for (const d of decisions) {
    // Only real ANSWERED gates. A question-kind decision with decision !== "answered" is a
    // mismatch→deny / abstain→deny (run.ts:385 / run.ts:376) that carries no answers `detail` — skip it
    // so it doesn't surface as an empty-string gate entry or inflate the bySource histogram.
    if (d.kind !== "question" || d.decision !== "answered") continue;
    const by = d.by ?? "unknown";
    bySource[by] = (bySource[by] ?? 0) + 1;
    const answers = d.detail && typeof d.detail === "object" ? (d.detail as Record<string, unknown>) : {};
    const entries = Object.entries(answers);
    gates.push({
      question: entries.map(([q]) => q).join(" / "),
      answeredBy: by,
      answer: entries.map(([q, c]) => `${q}=${String(c)}`).join("; "),
      model: d.model,
    });
  }
  return { total: gates.length, bySource, gates };
}

/** One-line footer summary, e.g. `gates: 3 · 2 decided(llm), 1 scripted`. Counts only — never answer
 *  text (secret-safe; the details live in the scrubbed result.json). Returns null when there were no
 *  gates, so the caller prints nothing. Sources are ordered most-frequent first, then alphabetically. */
export function formatGateProvenanceLine(summary: GateProvenanceSummary): string | null {
  if (summary.total === 0) return null;
  const parts = Object.entries(summary.bySource)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([by, n]) => `${n} ${labelSource(by)}`);
  return `gates: ${summary.total} · ${parts.join(", ")}`;
}

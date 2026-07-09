import { claudeCliComplete } from "../decide/llm-transport.js";
import type { Complete } from "../decide/decider.js";
import { extractAllJsonObjects } from "../decide/semantic-judge.js";
import { validateCitations, type CritiqueItem } from "./evidence.js";

// The two-pass, tool-less evaluator. Reuses the shared `claude -p` transport (same reasoning as
// `semantic-judge.ts`: the harness process itself is not behind the egress proxy, so a direct API call
// would bypass the very allowlist the harness enforces; `claude -p` is egress-consistent). Unlike the
// judge, this evaluator's output isn't a fixed indexed rubric — it's an open-ended set of findings — so
// "independence" and "grounding" can't rest on an index-keyed parse the way the judge's does. Two design
// properties carry that weight instead (see the reflective-critique plan §R D-grounding):
//
//  1. INDEPENDENCE BY ORDERING. Pass 1 runs and its `complete()` call resolves BEFORE pass 2's prompt is
//     even built — the self-report string is never interpolated into pass 1's prompt at all. This isn't a
//     prompt instruction to "ignore" the self-report; the model literally cannot see text that was never
//     sent.
//  2. MECHANICAL CITATION GROUNDING. Every item from both passes is run through `validateCitations`
//     (evidence.ts) before returning — a citation that isn't a verbatim substring of the evidence package
//     is flagged `citationResolved:false`, so a hallucinated "evidence" excerpt can't silently ship as a
//     trusted recommendation. `not-adjudicable` items need no citation (there is, by definition, no
//     deciding evidence) and always resolve.

/** The evaluator model. A concrete/dated id, like the semantic judge's `DEFAULT_JUDGE_MODEL` — a floating
 *  alias would make "which model produced this critique" unrecoverable after the fact. Env-overridable;
 *  `runCritique`'s `opts.model` overrides per call (the `--evaluator-model` CLI flag feeds that). */
export const DEFAULT_EVALUATOR_MODEL = process.env.COWORK_HARNESS_EVALUATOR_MODEL || "claude-opus-4-8";

const CLASSIFICATIONS = new Set<CritiqueItem["classification"]>([
  "grounded-and-actionable",
  "grounded-but-not-worth-it",
  "confabulated",
  "already-covered",
  "not-adjudicable",
]);

interface RawItem {
  idea: string;
  classification: CritiqueItem["classification"];
  evidence: string;
  recommendedAction: string;
}

function isValidRawItem(x: unknown): x is RawItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.idea === "string" &&
    typeof o.classification === "string" &&
    CLASSIFICATIONS.has(o.classification as CritiqueItem["classification"]) &&
    typeof o.evidence === "string" &&
    typeof o.recommendedAction === "string"
  );
}

/** Parse a pass's reply into `CritiqueItem[]`, tagging every item with `source` (never trusting the model
 *  to self-report which pass/role it is). Scans EVERY top-level `{...}` group (a model routinely wraps
 *  JSON in prose or restates it fenced+unfenced — same reason `semantic-judge.ts` scans all groups) and
 *  takes the first one that is a full, well-shaped `{"items":[...]}` document. A reply with ZERO valid
 *  group throws loud — a malformed reply must fail the run, never silently manufacture an empty critique
 *  that looks identical to "the evaluator found nothing." */
function parseCritiqueItems(raw: string, source: CritiqueItem["source"], label: string): CritiqueItem[] {
  for (const group of extractAllJsonObjects(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(group);
    } catch {
      continue;
    }
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items) || !items.every(isValidRawItem)) continue;
    return (items as RawItem[]).map((it) => ({
      source,
      idea: it.idea,
      classification: it.classification,
      evidence: it.evidence,
      recommendedAction: it.recommendedAction,
    }));
  }
  throw new Error(`${label}: no valid {"items":[...]} JSON found in the evaluator reply.\n--- raw reply ---\n${raw}`);
}

const OUTPUT_CONTRACT = `Return STRICT JSON ONLY — no markdown code fences, no prose before or after, and do NOT repeat
this instruction back:
{"items":[{"idea":"...","classification":"...","evidence":"<verbatim excerpt from the evidence package above>","recommendedAction":"..."}]}
If you have no findings, return exactly {"items":[]}.`;

/** Pass 1 prompt — evidence package ONLY, no self-report. Exported for the unit test to assert on its
 *  exact shape (in particular: that it contains no trace of a self-report). */
export function buildPass1Prompt(pkg: string): string {
  return `You are an independent, log-grounded evaluator reviewing how well a Claude Code skill served an
agent that just used it. You have NOT been shown the agent's own account of the experience — form your
critique from the evidence alone.

## Evidence package (turn 1 of the run only)
${pkg}

Look for concrete, skill-improvement-relevant findings, e.g.:
- the agent read a reference/script (see referencesRead) but its final answer/transcript shows it ignored
  or contradicted that guidance (a salience problem — the content exists but didn't land);
- the transcript shows the agent guessing, backtracking, or asking a question that SKILL.md or a
  references/ file already appears to answer (check the "SKILL.md" and "references/ available" sections);
- redundant or wasted tool calls (see toolCounts/skillActivity) that a clearer instruction would avoid;
- a sub-agent dispatch whose declared type/description suggests it duplicated work the main agent could
  have done directly, or vice versa.

Classify each finding as "grounded-and-actionable" (worth fixing), "grounded-but-not-worth-it" (real but
low value), "already-covered" (the skill already says this — the gap is why the agent didn't act on it,
not that it's missing), or "not-adjudicable" (you can see a possible issue but the evidence here can't
settle it — e.g. it would require seeing a sub-agent's own internal reasoning). Do NOT use "confabulated" —
that classification is reserved for verifying an EXTERNAL claim against the evidence (pass 2), not for your
own findings.

Every item's "evidence" field MUST be a VERBATIM excerpt copied exactly from the evidence package above
(not paraphrased, not summarized) — a finding you cannot quote verbatim must not be reported.

${OUTPUT_CONTRACT}`;
}

/** Pass 2 prompt — the same evidence package, pass 1's findings (context only), and the self-report
 *  explicitly labeled as the agent's UNVERIFIED account. Exported for the unit test. */
export function buildPass2Prompt(pkg: string, pass1Items: CritiqueItem[], selfReport: string): string {
  const pass1Summary = pass1Items.length ? pass1Items.map((it, i) => `${i + 1}. [${it.classification}] ${it.idea}`).join("\n") : "(none)";
  return `You are verifying an agent's OWN account of its experience using a Claude Code skill against
deterministic evidence from the same run. Treat the self-report as an UNVERIFIED, POSSIBLY CONFABULATED
account — an agent's stated experience is not ground truth; the evidence package is.

## Evidence package (turn 1 of the run only — the same ground truth used for the independent pass)
${pkg}

## Independent findings from a prior, separate pass (context only — do NOT re-list these as your own items)
${pass1Summary}

## THE AGENT'S UNVERIFIED SELF-REPORT (its own account of using the skill — verify, never trust)
${selfReport}

For EACH distinct idea, complaint, or suggestion in the self-report above, decide exactly one
classification by checking it against the evidence package:
- "grounded-and-actionable": the evidence supports the claim and it is worth fixing.
- "grounded-but-not-worth-it": the evidence supports the claim but it is low-value or an edge case.
- "confabulated": the evidence CONTRADICTS the claim (e.g. the agent says it "never found" a reference
  that referencesRead or the transcript shows it read, or describes something that did not happen).
- "already-covered": SKILL.md or a references/ file (see those sections) already covers this; the agent
  overlooked or didn't act on existing guidance.
- "not-adjudicable": the evidence CANNOT decide this claim — for example, a complaint about SKILL.md-
  resident guidance that the agent read but the evidence has no way to confirm was actually consulted (the
  full document is delivered as text, not logged as a Read), or a claim about what happened INSIDE a
  dispatched sub-agent (its internal tool calls aren't in this evidence). Use this rather than guessing a
  grounded/confabulated verdict you cannot actually support.

For every classification EXCEPT "not-adjudicable", the "evidence" field MUST be a VERBATIM excerpt copied
exactly from the evidence package above. For "not-adjudicable", "evidence" may be an empty string.

${OUTPUT_CONTRACT}`;
}

export interface RunCritiqueOptions {
  /** Pinned evaluator model; defaults to `DEFAULT_EVALUATOR_MODEL`. */
  model?: string;
  /** Injectable transport for tests; defaults to the real `claude -p` transport. */
  complete?: Complete;
}

/**
 * Run the two-pass critique. `pkg` is the turn-1 evidence package (from `packageEvidence`); `selfReport`
 * is the reflection turn's final message. Returns the combined, citation-validated `CritiqueItem[]` —
 * pass 1's independent findings (`source:"evaluator"`) followed by pass 2's verified self-report items
 * (`source:"self-report"`). A malformed reply from either pass throws (fail loud): this function never
 * silently drops a pass's output or manufactures a placeholder critique.
 */
export async function runCritique(pkg: string, selfReport: string, opts: RunCritiqueOptions = {}): Promise<CritiqueItem[]> {
  const model = opts.model ?? DEFAULT_EVALUATOR_MODEL;
  const complete = opts.complete ?? claudeCliComplete;

  // Pass 1 FIRST, and its own await completes before pass 2's prompt is ever constructed — the
  // self-report is not merely "not mentioned," it does not exist yet in this function's execution when
  // this call is made.
  const { text: pass1Raw } = await complete(buildPass1Prompt(pkg), model);
  const pass1Items = parseCritiqueItems(pass1Raw, "evaluator", "critique pass 1 (independent)");

  const { text: pass2Raw } = await complete(buildPass2Prompt(pkg, pass1Items, selfReport), model);
  const pass2Items = parseCritiqueItems(pass2Raw, "self-report", "critique pass 2 (verify self-report)");

  return validateCitations([...pass1Items, ...pass2Items], pkg);
}

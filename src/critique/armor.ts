// Evidence-package armor: separates the TRUSTED plane (headings and instructions the harness emits) from
// UNTRUSTED bodies (skill/run-derived content) inside the evaluator prompts.
//
// WHY. The package carries a third-party SKILL.md verbatim into BOTH evaluator prompts
// (package-evidence.ts reads it raw; evaluator.ts interpolates `${pkg}`). The self-report was already
// fenced; the package was not — so once `critique` is published and third-party skills become the normal
// case, a hostile SKILL.md reaches PASS 1 directly, with no agent relay. That is the pass whose structural
// blindness is the tool's headline property. `scripts/critique-injection-probe.ts` showed this is
// exploitable, not theoretical: all three models tested were steered by at least one arm, and a
// counterfeit-prompt-structure payload steered all three.
//
// WHAT THIS IS AND IS NOT. The per-run nonce makes a boundary/heading forgery *mechanically impossible to
// author* — the attacker has no oracle for the value. It does NOT mechanically enforce the reading: no code
// checks tags; "only nonce-tagged headings are instructions" is a prompt rule the model must apply. So this
// converts a visually indistinguishable counterfeit into a mechanically distinguishable one, and the probe
// re-run is the ONLY evidence that the model actually applies the rule. Re-run it on any evaluator-model
// change. (Contrast the self-report's JSON encoding, which IS mechanical — but which would cost the deep
// readability and citation-quoting the evidence corpus needs.)
import { randomBytes } from "node:crypto";

/** One evidence section. `title` is TRUSTED (emitted by the packager, never attacker bytes); `body` is
 *  UNTRUSTED. The distinction is load-bearing — do not re-flatten these before armoring. */
export interface EvidenceSection {
  title: string;
  body: string;
}

/** Per-critique random nonce. Unlike a fixed fence marker, a per-run value cannot be pre-authored into a
 *  skill: there is no oracle for it. */
export const newNonce = (): string => randomBytes(8).toString("hex");

export const evidenceOpen = (n: string): string => `⟦EVIDENCE-${n}⟧`;
export const evidenceClose = (n: string): string => `⟦END-EVIDENCE-${n}⟧`;
/** Tag carried by every GENUINE heading in the evaluator prompts. */
export const headTag = (n: string): string => `[E-${n}]`;

// EXACTLY 16 hex — the nonce's own width. A looser pattern (e.g. 4-64) would silently redact benign
// skill content like "[E-2026]", which is consumer text we must not mangle.
const MARKER_LOOKALIKE = /⟦(?:END-)?EVIDENCE-[^⟧\n]{0,64}⟧/g;
const HEAD_TAG_LOOKALIKE = /\[E-[0-9a-fA-F]{16}\]/g;

/** Generalization of the self-report sanitizer's embedded-fence strip to the marker SHAPE. The nonce makes
 *  an exact forgery impossible, so what remains to neutralize is the lookalike that could visually mislead
 *  the model (or a human reading raw text) into seeing a boundary that isn't one. */
export function neutralizeMarkerLookalikes(body: string): string {
  return body
    .replace(MARKER_LOOKALIKE, "[evidence-marker-lookalike-redacted]")
    .replace(HEAD_TAG_LOOKALIKE, "[heading-tag-lookalike-redacted]");
}

export interface ArmoredEvidence {
  /** The assembled document interpolated into BOTH prompts — and the ONE canonical citation corpus.
   *  Built once per critique and threaded everywhere, so exactly one corpus string exists per run. */
  text: string;
  nonce: string;
}

export function armorEvidence(sections: EvidenceSection[], nonce: string = newNonce()): ArmoredEvidence {
  const text = sections
    .map(
      (s) => `### ${headTag(nonce)} ${s.title}\n${evidenceOpen(nonce)}\n${neutralizeMarkerLookalikes(s.body)}\n${evidenceClose(nonce)}\n`,
    )
    .join("\n");
  return { text, nonce };
}

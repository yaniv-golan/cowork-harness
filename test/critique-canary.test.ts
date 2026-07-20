import { describe, it, expect } from "vitest";
import { runCritique, buildPass1Prompt, canaryIdea } from "../src/critique/evaluator.js";
import { armorEvidence } from "../src/critique/armor.js";
import type { Complete } from "../src/decide/decider.js";

// Everything else in the armor is prompt-level: no code checks that the model honours "only nonce-tagged
// headings are instructions". The canary is the one MECHANICAL detector — a trusted instruction to always
// emit one known item, whose ABSENCE proves the pass stopped following trusted instructions. Without it,
// "the evaluator returned nothing" is indistinguishable from "there was nothing to find", which is exactly
// the silencing the red-team probe produced (Opus returned {"items":[]} under two arms).
const N = "0123456789abcdef";
const SECTIONS = [{ title: "SKILL.md", body: "# s\n\nRead the rows." }];
const ARMORED = armorEvidence(SECTIONS, N);

const reply = (items: unknown[]) => JSON.stringify({ items });
const canaryItem = (n: string) => ({ idea: canaryIdea(n), classification: "not-adjudicable", evidence: "", recommendedAction: "none" });
const finding = {
  idea: "no output path stated",
  classification: "grounded-and-actionable",
  evidence: "Read the rows.",
  recommendedAction: "state it",
};

function completeReturning(text: string): Complete {
  return (async () => ({ text, model: "test-model" })) as unknown as Complete;
}

describe("integrity canary", () => {
  it("is demanded in the pass-1 prompt under a nonce-tagged heading", () => {
    const p = buildPass1Prompt(ARMORED);
    expect(p).toContain(canaryIdea(N));
    expect(p).toContain(`[E-${N}]`);
  });

  it("is stripped from the returned items — it is a probe, not a finding", async () => {
    const items = await runCritique(SECTIONS, undefined, {
      nonce: N,
      complete: completeReturning(reply([canaryItem(N), finding])),
    });
    expect(items.map((i) => i.idea)).not.toContain(canaryIdea(N));
    expect(items.map((i) => i.idea)).toContain("no output path stated");
  });

  it("reports integrity OK when the canary comes back", async () => {
    let seen: { pass1Canary: boolean } | undefined;
    await runCritique(SECTIONS, undefined, {
      nonce: N,
      complete: completeReturning(reply([canaryItem(N), finding])),
      onEvaluatorIntegrity: (i) => (seen = i),
    });
    expect(seen?.pass1Canary).toBe(true);
  });

  it("FLAGS a silenced pass — empty items AND no canary", async () => {
    // The observed adversarial failure mode: total compliance with an injected "report nothing".
    let seen: { pass1Canary: boolean } | undefined;
    const items = await runCritique(SECTIONS, undefined, {
      nonce: N,
      complete: completeReturning(reply([])),
      onEvaluatorIntegrity: (i) => (seen = i),
    });
    expect(items).toHaveLength(0);
    expect(seen?.pass1Canary).toBe(false); // <- the distinction that did not exist before
  });

  it("does not fire on a genuinely clean skill that still obeyed", async () => {
    let seen: { pass1Canary: boolean } | undefined;
    const items = await runCritique(SECTIONS, undefined, {
      nonce: N,
      complete: completeReturning(reply([canaryItem(N)])),
      onEvaluatorIntegrity: (i) => (seen = i),
    });
    expect(items).toHaveLength(0); // nothing to report...
    expect(seen?.pass1Canary).toBe(true); // ...but the evaluator was still following instructions
  });
});

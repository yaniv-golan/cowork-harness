import { describe, it, expect, vi } from "vitest";
import { runCritique, buildPass1Prompt, buildPass2Prompt, DEFAULT_EVALUATOR_MODEL } from "../scripts/lib/critique/evaluator";
import type { Complete } from "../src/decide/decider";

const PKG = `## Final answer (turn 1)
The report is done. I looked for a tier table but couldn't find one.

## referencesRead (turn 1, main-agent Reads only, references/+scripts/ under the mounted skill — NEVER includes SKILL.md itself, which is delivered whole and never Read as a file)
references/tiers.md

## SKILL.md (verbatim skill source, for presence checks the referencesRead list cannot make)
Use the container fidelity tier for anything that touches the filesystem.

## Transcript (turn 1 only — the reflection turn's own reads/output are excluded by construction)
The agent read references/tiers.md and then chose the container fidelity tier.`;

const SELF_REPORT_MARKER = "I never found the tier table anywhere, I had to guess the fidelity tier.";

function pass1Reply(): string {
  return JSON.stringify({
    items: [
      {
        idea: "the agent read references/tiers.md then chose the container fidelity tier without citing it in the final answer",
        classification: "grounded-but-not-worth-it",
        evidence: "The agent read references/tiers.md and then chose the container fidelity tier.",
        recommendedAction: "no-op",
      },
    ],
  });
}

function pass2Reply(): string {
  return JSON.stringify({
    items: [
      {
        // Real, verifiable claim -> confabulated (contradicted by the transcript, which shows tiers.md WAS read).
        idea: SELF_REPORT_MARKER,
        classification: "confabulated",
        evidence: "The agent read references/tiers.md and then chose the container fidelity tier.",
        recommendedAction: "none",
      },
      {
        // Hallucinated citation -> must be flagged by validateCitations.
        idea: "the intro paragraph was confusing",
        classification: "grounded-and-actionable",
        evidence: "the intro paragraph rambles for three pages before saying anything useful",
        recommendedAction: "trim the intro",
      },
      {
        // not-adjudicable -> empty evidence is fine.
        idea: "unclear whether SKILL.md's fidelity guidance was actually consulted",
        classification: "not-adjudicable",
        evidence: "",
        recommendedAction: "human review",
      },
    ],
  });
}

/** A stub transport that returns pass1Reply() on the first call and pass2Reply() on the second, while
 *  recording every (prompt, model) call it received so the test can assert on ordering/content. */
function makeStubComplete(): { complete: Complete; calls: { prompt: string; model: string }[] } {
  const calls: { prompt: string; model: string }[] = [];
  const complete: Complete = vi.fn(async (prompt: string, model: string) => {
    calls.push({ prompt, model });
    const text = calls.length === 1 ? pass1Reply() : pass2Reply();
    return { text, model };
  });
  return { complete, calls };
}

describe("runCritique (two-pass evaluator, stubbed transport)", () => {
  it("runs pass 1 BEFORE pass 2, and pass 1 never sees the self-report", async () => {
    const { complete, calls } = makeStubComplete();
    await runCritique(PKG, SELF_REPORT_MARKER, { complete });

    expect(calls).toHaveLength(2);
    // Pass 1's prompt is built from the evidence package alone — the self-report string must not appear
    // anywhere in it (this is the mechanical proof of independence-by-ordering, not a prompt hope).
    expect(calls[0].prompt).not.toContain(SELF_REPORT_MARKER);
    expect(calls[0].prompt).toContain("Evidence package");
    expect(calls[0].prompt).not.toContain("UNVERIFIED SELF-REPORT");
    // Pass 2's prompt DOES carry the self-report, explicitly labeled unverified.
    expect(calls[1].prompt).toContain(SELF_REPORT_MARKER);
    expect(calls[1].prompt).toContain("UNVERIFIED");
  });

  it("combines both passes' items, tagging source by pass regardless of what the model claims", async () => {
    const { complete } = makeStubComplete();
    const items = await runCritique(PKG, SELF_REPORT_MARKER, { complete });

    expect(items).toHaveLength(4); // 1 from pass 1 + 3 from pass 2
    expect(items[0].source).toBe("evaluator");
    expect(items.slice(1).every((it) => it.source === "self-report")).toBe(true);
  });

  it("validates citations: a real excerpt resolves, a hallucinated one is flagged citationResolved:false", async () => {
    const { complete } = makeStubComplete();
    const items = await runCritique(PKG, SELF_REPORT_MARKER, { complete });

    const confabulated = items.find((it) => it.classification === "confabulated");
    expect(confabulated?.citationResolved).toBe(true); // its cited excerpt IS verbatim in the package

    const hallucinated = items.find((it) => it.idea === "the intro paragraph was confusing");
    expect(hallucinated?.citationResolved).toBe(false); // "rambles for three pages" is nowhere in PKG

    const notAdjudicable = items.find((it) => it.classification === "not-adjudicable");
    expect(notAdjudicable?.citationResolved).toBe(true); // needs no citation by definition
  });

  it("defaults to the pinned evaluator model when opts.model is omitted", async () => {
    const { complete, calls } = makeStubComplete();
    await runCritique(PKG, SELF_REPORT_MARKER, { complete });
    expect(calls[0].model).toBe(DEFAULT_EVALUATOR_MODEL);
    expect(calls[1].model).toBe(DEFAULT_EVALUATOR_MODEL);
  });

  it("honors an explicit model override for both passes", async () => {
    const { complete, calls } = makeStubComplete();
    await runCritique(PKG, SELF_REPORT_MARKER, { complete, model: "claude-sonnet-4-8" });
    expect(calls[0].model).toBe("claude-sonnet-4-8");
    expect(calls[1].model).toBe("claude-sonnet-4-8");
  });

  it("fails loud (throws) on a malformed pass-1 reply instead of silently dropping it", async () => {
    const complete: Complete = vi.fn(async () => ({ text: "not json at all, sorry", model: "x" }));
    await expect(runCritique(PKG, SELF_REPORT_MARKER, { complete })).rejects.toThrow(/pass 1/i);
  });

  it("fails loud on a malformed pass-2 reply even when pass 1 was fine", async () => {
    let call = 0;
    const complete: Complete = vi.fn(async () => {
      call++;
      return { text: call === 1 ? pass1Reply() : "prose with no JSON object at all", model: "x" };
    });
    await expect(runCritique(PKG, SELF_REPORT_MARKER, { complete })).rejects.toThrow(/pass 2/i);
  });

  it('accepts an empty {"items":[]} reply as a legitimate zero-findings result, not a parse failure', async () => {
    const complete: Complete = vi.fn(async () => ({ text: JSON.stringify({ items: [] }), model: "x" }));
    const items = await runCritique(PKG, SELF_REPORT_MARKER, { complete });
    expect(items).toEqual([]);
  });
});

describe("prompt builders", () => {
  it("buildPass1Prompt embeds the evidence package and forbids source:self-report content", () => {
    const p = buildPass1Prompt(PKG);
    expect(p).toContain(PKG);
    expect(p).not.toContain(SELF_REPORT_MARKER);
  });

  it("buildPass2Prompt embeds the evidence package, pass-1 context, and the labeled self-report", () => {
    const p = buildPass2Prompt(PKG, [], SELF_REPORT_MARKER);
    expect(p).toContain(PKG);
    expect(p).toContain(SELF_REPORT_MARKER);
    expect(p).toMatch(/UNVERIFIED/);
  });

  it("injects the truncation caveat into BOTH prompts only when the package was truncated", () => {
    // Not truncated (default): no caveat, so absence-based classifications proceed normally.
    expect(buildPass1Prompt(PKG)).not.toContain("TRUNCATED");
    expect(buildPass2Prompt(PKG, [], SELF_REPORT_MARKER)).not.toContain("TRUNCATED");
    // Truncated: both passes are warned that absence is uninformative → prefer not-adjudicable.
    expect(buildPass1Prompt(PKG, true)).toContain("this evidence package was TRUNCATED");
    const p2 = buildPass2Prompt(PKG, [], SELF_REPORT_MARKER, true);
    expect(p2).toContain("this evidence package was TRUNCATED");
    expect(p2).toMatch(/do NOT classify it "confabulated"/);
  });
});

describe("runCritique — truncation awareness", () => {
  it("threads packageTruncated into both passes so a truncated package can't yield a false confabulation", async () => {
    const { complete, calls } = makeStubComplete();
    await runCritique(PKG, SELF_REPORT_MARKER, { complete, packageTruncated: true });
    expect(calls[0].prompt).toContain("this evidence package was TRUNCATED");
    expect(calls[1].prompt).toContain("this evidence package was TRUNCATED");
  });
});

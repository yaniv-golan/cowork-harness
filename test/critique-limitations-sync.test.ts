import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CRITIQUE_LIMITATIONS, renderKnownLimitations, provenanceDetail } from "../src/critique/limitations.js";

// `provenance` exists to answer "should I architect around this forever, or is it pending work?" — a
// consumer read "container tier only" as permanent, concluded critique could never see their
// hostloop-specific findings, and committed to a two-lane test architecture on that misreading.
//
// These guards are what keep the tag load-bearing rather than decorative (this repo's recurring bug
// shape): --help is DERIVED from the list, and docs/critique.md must document the same set.

const DOCS = readFileSync(resolve("docs/critique.md"), "utf8");

/** docs/critique.md's "Known limitations" section, whitespace-normalized.
 *
 *  Normalizing is not tidiness: markdown prose WRAPS, and a line-oriented match against a wrapped
 *  sentence comes back clean while the text is plainly present. That false clean happened for real in
 *  this repo — a grep for a comment reported zero hits because the sentence spanned two lines. */
function docsLimitationsSection(): string {
  const start = DOCS.indexOf("## Known limitations");
  expect(start, "docs/critique.md has no '## Known limitations' section — the guard is blind, fix the marker").toBeGreaterThan(-1);
  const rest = DOCS.slice(start + 1);
  const end = rest.indexOf("\n## ");
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");
}

const SECTION = docsLimitationsSection();
const norm = (s: string) => s.replace(/\s+/g, " ");

describe("critique limitations ↔ docs parity", () => {
  it("finds a non-trivial limitations section (never go green over nothing)", () => {
    expect(SECTION.length).toBeGreaterThan(200);
    expect(CRITIQUE_LIMITATIONS.length).toBeGreaterThan(4);
  });

  for (const l of CRITIQUE_LIMITATIONS) {
    it(`\`${l.id}\` is documented in docs/critique.md`, () => {
      expect(
        SECTION.includes(norm(l.docsAnchor)),
        `docs/critique.md's Known limitations does not mention "${l.docsAnchor}" (limitation \`${l.id}\`). Declaring a limitation here without documenting it there is the half-shipped state this guard exists to catch.`,
      ).toBe(true);
    });
  }

  it("every limitation carries a provenance with a non-empty, actionable detail", () => {
    for (const l of CRITIQUE_LIMITATIONS) {
      expect(l.provenance.kind, `${l.id}`).toMatch(/^(structural|unverified|deliberate|not-built)$/);
      // A tag with an empty rationale is decoration wearing a type.
      expect(provenanceDetail(l.provenance).length, `${l.id}'s provenance detail is too thin to act on`).toBeGreaterThan(20);
    }
  });

  it("an `unverified` limitation names the specific proof that would lift it", () => {
    // Without this, "unverified" degrades into a shrug. The container-tier pin is the motivating case:
    // the proof it needs is a hostloop run against the NATIVE agent binary, not the container ELF.
    for (const l of CRITIQUE_LIMITATIONS) {
      if (l.provenance.kind !== "unverified") continue;
      expect(l.provenance.liftedBy.length, `${l.id} is 'unverified' but does not say what would lift it`).toBeGreaterThan(20);
    }
  });

  it("--help is DERIVED from the list, so the tags cannot drift from the text", () => {
    // The whole anti-decoration mechanism: if a limitation is added to the list, it appears in --help
    // automatically; if the renderer stopped consuming the list, this fails.
    const help = renderKnownLimitations();
    for (const l of CRITIQUE_LIMITATIONS) {
      expect(help, `${l.id} missing from rendered --help`).toContain(l.summary);
      expect(help, `${l.id}'s provenance class missing from rendered --help`).toContain(`[${l.provenance.kind}]`);
    }
  });

  it("the container-tier pin is tagged `unverified`, not `structural`", () => {
    // Pinned deliberately: this is the exact misreading that cost a consumer an architecture decision.
    // If someone ever retags it `structural`, that should be a conscious act with a test to update — not
    // a quiet edit. (If the hostloop proof lands and the pin lifts, delete this test with the limitation.)
    const pin = CRITIQUE_LIMITATIONS.find((l) => l.id === "container-tier-only");
    expect(pin, "the container-tier limitation was removed — if the pin genuinely lifted, delete this test too").toBeDefined();
    expect(pin!.provenance.kind).toBe("unverified");
  });
});

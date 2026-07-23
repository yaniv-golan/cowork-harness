import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { CRITIQUE_LIMITATIONS, provenanceDetail } from "../src/critique/limitations.js";

// `provenance` exists to answer "should I architect around this forever, or is it pending work?" — a
// consumer read "container tier only" as permanent, concluded critique could never see their
// hostloop-specific findings, and committed to a two-lane test architecture on that misreading.
//
// These guards are what keep the tag load-bearing rather than decorative (this repo's recurring bug
// shape): --help is DERIVED from the list, and docs/critique.md must document the same set.

const DOCS = readFileSync(resolve("docs/critique.md"), "utf8");

/** docs/critique.md's "Known limitations" section, whitespace-normalized.
 *
 *  Normalizing is needed because markdown prose WRAPS and one anchor genuinely spans a line break. Be
 *  precise about which way it cuts, though: in a PRESENCE-asserting guard a line-oriented match on
 *  wrapped text produces a false RED, not a false clean — normalization prevents a nuisance failure, it
 *  does not add rigor. (An earlier version of this comment claimed the opposite, dressing a
 *  looseness-INCREASING choice as care.)
 *
 *  The real residual risk runs the other way: `docsAnchor` is a substring, so a bullet rewritten to
 *  assert the OPPOSITE ("attached content is now always excluded") can still contain the anchor and pass.
 *  The tag-agreement and bidirectional guards below bound that; the anchors themselves do not. */
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

  it("the docs bullet's [tag] MATCHES the list's provenance — not merely present", () => {
    // Presence-only checking let the two disagree: retagging `english-only` in the list while docs still
    // read [not-built] passed 12/12. docs/critique.md claims "generated from one source ... so the two
    // cannot disagree"; that claim now has something behind it.
    for (const l of CRITIQUE_LIMITATIONS) {
      const idx = SECTION.indexOf(norm(l.docsAnchor));
      // Look backwards from the anchor to the bullet it belongs to, and read that bullet's tag.
      const before = SECTION.slice(0, idx);
      const tag = [...before.matchAll(/\[(structural|unverified|deliberate|not-built)\]/g)].pop()?.[1];
      expect(tag, `no [tag] precedes "${l.docsAnchor}" in docs/critique.md`).toBeDefined();
      expect(tag, `docs tags \`${l.id}\` as [${tag}] but the list says [${l.provenance.kind}]`).toBe(l.provenance.kind);
    }
  });

  it("the docs section declares NO limitation the list does not know about (bidirectional)", () => {
    // limitations.ts claimed a limitation "cannot be added here and forgotten there (or vice versa)" —
    // the vice versa was unimplemented, so docs could accumulate invented limitations with fabricated
    // tags. Count tagged bullets instead of trusting the prose.
    const tagged = [...SECTION.matchAll(/\[(structural|unverified|deliberate|not-built)\]/g)].length;
    expect(
      tagged,
      `docs/critique.md's Known limitations has ${tagged} tagged bullets but the list declares ${CRITIQUE_LIMITATIONS.length} — a docs-only limitation is undocumented drift in the other direction`,
    ).toBe(CRITIQUE_LIMITATIONS.length);
  });

  it("pins the exact limitation id set, so a silent DELETION reds", () => {
    // A `length > 4` floor absorbed two deletions from the current seven: removing a limitation dropped
    // it from --help and orphaned its docs bullet, all green. Deleting one should be a deliberate act.
    expect([...CRITIQUE_LIMITATIONS.map((l) => l.id)].sort()).toEqual(
      [
        "attached-content-may-enter-evidence",
        "citation-seams",
        "container-tier-only",
        "english-only",
        "evidence-not-persisted",
        "report-stdout-only",
        "skill-md-16kb-cap",
      ].sort(),
    );
  });

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

  it("the SHIPPED `critique --help` renders every limitation from the list", () => {
    // Tests the ASSEMBLY, not the renderer. The first version of this test called
    // renderKnownLimitations() and asserted its output contained the list — i.e. that the renderer
    // renders its own input, which is near-tautological and passes even when `usage()` ignores the
    // renderer entirely. An adversarial review proved it: replacing the `${renderKnownLimitations()}`
    // interpolation in usage() with hard-coded text left all 12 tests GREEN.
    //
    // This repo has shipped that exact bug before (the integrity canary: field, renderer, local and
    // callback all present, never assembled into the state literal, unit tests green because they handed
    // the builder a state directly). Assert against the real binary's real output.
    const help = execFileSync(process.execPath, [resolve("dist/cli.js"), "critique", "--help"], { encoding: "utf8" });
    for (const l of CRITIQUE_LIMITATIONS) {
      expect(help, `${l.id} is in the list but absent from the SHIPPED --help`).toContain(l.summary);
      expect(help, `${l.id}'s provenance class is absent from the SHIPPED --help`).toContain(`[${l.provenance.kind}]`);
      expect(help, `${l.id}'s provenance DETAIL is absent from the SHIPPED --help`).toContain(provenanceDetail(l.provenance));
    }
  });

  it("the container-tier pin is tagged `not-built`, never `structural`", () => {
    // `structural` (permanent) is the exact misreading that cost a consumer an architecture decision, so a
    // retag toward it must be a conscious act caught here, not a quiet edit. Was `unverified` until the
    // hostloop resume-continuity proof PASSED (2026-07-23, test/live-contract.test.ts) — evidence cleared, so it
    // is now `not-built`: only the unpin + tier-stamp + host-write-consent WORK remains. It must never be
    // `structural` — the tier is proven reachable. (When the pin is actually lifted — critique runs at a
    // non-container tier — delete this test with the limitation.)
    const pin = CRITIQUE_LIMITATIONS.find((l) => l.id === "container-tier-only");
    expect(pin, "the container-tier limitation was removed — if the pin genuinely lifted, delete this test too").toBeDefined();
    expect(pin!.provenance.kind).toBe("not-built");
    expect(pin!.provenance.kind).not.toBe("structural");
  });
});

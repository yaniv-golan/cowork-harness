// THE source of truth for `critique`'s known limitations — and, for each, WHICH KIND of limitation it is.
//
// WHY THIS EXISTS. We documented every limitation's *what* and never its *class*. A downstream consumer
// read "container tier only" as a permanent structural property, concluded native `critique` could never
// see their hostloop-specific findings, and committed to a permanent two-lane test architecture. It is
// not structural: it is UNVERIFIED — the resume-continuity proof exists for the container tier's Linux ELF
// and simply has never been run against hostloop's native binary. A one-word tag would have prevented an
// architecture decision.
//
// The distinction a reader actually needs is not "what can't it do" but "should I architect around this
// forever, or is it pending work?" That is what `provenance` answers.
//
// NOT DECORATION. A tag nothing reads would be this repo's recurring bug shape (see
// run/skill-flag-surface.ts for the same lesson about flags). So:
//   1. `renderKnownLimitations()` GENERATES critique's `--help` block from this list — the help text
//      cannot drift from the tags because it is derived from them.
//   2. `test/critique-limitations-sync.test.ts` asserts, against the SHIPPED binary and the real docs:
//      every limitation reaches `critique --help`; every one is documented; the docs bullet's [tag]
//      MATCHES this list's class; the docs declare no limitation this list lacks; and the id set is
//      pinned so a deletion is deliberate.
//      An earlier version claimed the "or vice versa" direction while implementing only one of these —
//      a completeness claim nothing enforced, which is the exact shape this module exists to prevent.
//      Each guard above was mutation-tested: break it and the suite reds.

/** Why a limitation exists — and therefore whether a consumer should design around it permanently. */
export type LimitationProvenance =
  /** Physics of the design. It will not lift; architect around it. */
  | { kind: "structural"; why: string }
  /** It may well work — nobody has PROVEN it. Not a statement about difficulty, only about evidence.
   *  `liftedBy` names the specific proof that would remove the limitation, so the path is never folklore.
   *
   *  `thenRequires` exists because the first version of this type could not express its OWN flagship case.
   *  The container pin needs a proof AND work afterwards (unpin three hard-coded sites, stamp the tier on
   *  the session manifest, plumb host-write consent); saying only "lifts with: a proof" told the reader
   *  evidence alone was enough — a half-truth aimed at the very consumer this feature exists to inform.
   *  Omit it when the proof genuinely is sufficient. */
  | { kind: "unverified"; liftedBy: string; thenRequires?: string }
  /** A deliberate choice with a rationale. Could be revisited, but not by accident. */
  | { kind: "deliberate"; rationale: string }
  /** Simply not built yet. No obstacle beyond the work. */
  | { kind: "not-built"; note: string };

export interface Limitation {
  /** Stable id — what the docs sync guard matches on. */
  id: string;
  /** One line, as shown in `--help`. No trailing period. */
  summary: string;
  /** REQUIRED — the whole point of the module; totality by construction. */
  provenance: LimitationProvenance;
  /** A distinctive substring that MUST appear in docs/critique.md's "Known limitations" section. Keeps the
   *  prose and this list from drifting apart in either direction.
   *
   *  Write it as a SINGLE LINE with single spaces: the guard normalizes whitespace on both sides before
   *  matching, because markdown prose wraps and a line-oriented match would silently come back clean
   *  against text that is actually present. (That false clean happened for real in this repo.) */
  docsAnchor: string;
}

export const CRITIQUE_LIMITATIONS: Limitation[] = [
  // The container pin was LIFTED on 2026-07-23: hostloop resume-continuity was proven live (native binary,
  // test/live-contract.test.ts) and critique now accepts `--fidelity container|hostloop`. What remains is
  // the three tiers still refused — each for its OWN, distinctly-classed reason, which is exactly the
  // per-limitation provenance this module exists to record. A cross-tier resume is blocked separately by
  // the session-manifest fidelity stamp (src/run/execute.ts).
  {
    id: "microvm-tier-refused",
    summary: "the microvm tier is refused — resume-continuity is unproven for the microVM guest",
    provenance: {
      kind: "unverified",
      liftedBy:
        "a live resume-continuity proof at the microvm tier (its Apple-VZ guest and in-guest session store, which the container/hostloop proofs do not cover)",
    },
    docsAnchor: "microvm tier is refused",
  },
  {
    id: "protocol-tier-refused",
    summary: "the protocol tier is refused — it never plumbs a session id or --resume",
    provenance: {
      kind: "not-built",
      note: "protocol's spawn hand-builds its argv and never emits --session-id/--resume, so critique's two-turn resume protocol has nothing to resume; adding session plumbing to the protocol tier (which also runs with no sandbox) is the work",
    },
    docsAnchor: "protocol tier is refused",
  },
  {
    id: "cowork-tier-refused",
    summary: "the cowork tier is refused — pass the resolved tier (container|hostloop) explicitly",
    provenance: {
      kind: "deliberate",
      rationale:
        "cowork resolves dynamically to hostloop|container via the synced loop gate; accepting it would make the graded tier baseline-dependent, adding noise to skillHash-paired generation comparisons",
    },
    docsAnchor: "cowork tier is refused",
  },
  {
    id: "skill-md-size-cap",
    summary:
      'SKILL.md is capped at 64KB in the evidence — an oversized one is truncated but still graded; only a missing/unreadable one forces "not adjudicable"',
    provenance: {
      kind: "deliberate",
      rationale: "the evidence package is bounded so the evaluator sees a whole record rather than a truncated tail",
    },
    docsAnchor: "capped at 64KB",
  },
  {
    id: "english-only",
    summary: "prompts are English-only",
    provenance: { kind: "not-built", note: "no localization work has been attempted; nothing blocks it" },
    docsAnchor: "English-only",
  },
  // Two former `not-built` limitations were BUILT (deliberately deleted here; the pinned id set in
  // test/critique-limitations-sync.test.ts was updated in the same change):
  //  - "evidence-not-persisted": the armored corpus is now written to critique-evidence-package.txt;
  //  - "report-stdout-only": critique-report.json is always written, and --out copies the report.
  {
    id: "attached-content-may-enter-evidence",
    summary: "attached-file CONTENT usually stays out of the evidence, but that is the common case, not a guarantee",
    provenance: {
      kind: "deliberate",
      rationale:
        "packaging falls back to a raw events.jsonl slice when the archived transcript is missing, and that stream carries full tool results — losing the record entirely would be worse than a bounded, armor-fenced inclusion",
    },
    docsAnchor: "not a guarantee",
  },
  {
    id: "citation-seams",
    summary: "a quote spanning an armor seam without its marker does not resolve and is DROPPED (measured 0/9 on a benign package)",
    provenance: {
      kind: "structural",
      why: "armor must interpose a marker between heading and body for the fence to hold; a quote crossing that boundary cannot match verbatim",
    },
    docsAnchor: "Citation seams",
  },
  {
    id: "advisory-self-run-verdict",
    summary: "the verdict is an advisory self-run — a discovery lead, NOT an independent attestation",
    provenance: {
      kind: "deliberate",
      rationale:
        "the skill under review controls text that enters the evaluator's prompt, so a crafted skill can steer the grade; treat the verdict as a lead to investigate, never as trustworthy proof of a skill's quality or safety",
    },
    docsAnchor: "not an independent attestation",
  },
];

const CLASS_GLOSS: Record<LimitationProvenance["kind"], string> = {
  structural: "permanent — architect around it",
  unverified: "unproven, NOT known-impossible — may lift",
  deliberate: "a design choice",
  "not-built": "simply absent; no obstacle but the work",
};

/** The detail a reader needs to act on the tag: what would lift it, or why it won't. */
export function provenanceDetail(p: LimitationProvenance): string {
  switch (p.kind) {
    case "structural":
      return p.why;
    case "unverified":
      return p.thenRequires ? `needs BOTH — proof: ${p.liftedBy}; then work: ${p.thenRequires}` : `lifts with: ${p.liftedBy}`;
    case "deliberate":
      return p.rationale;
    case "not-built":
      return p.note;
  }
}

/** Renders critique's `--help` KNOWN LIMITATIONS block. The help text is DERIVED from the tags, so the two
 *  cannot disagree — which is what keeps `provenance` load-bearing rather than decorative. */
export function renderKnownLimitations(): string {
  const gloss = (Object.keys(CLASS_GLOSS) as LimitationProvenance["kind"][]).map((k) => `    ${k.padEnd(11)} ${CLASS_GLOSS[k]}`);
  const items = CRITIQUE_LIMITATIONS.map((l) => `  [${l.provenance.kind}] ${l.summary}\n      ${provenanceDetail(l.provenance)}`);
  return `KNOWN LIMITATIONS — each tagged with WHY it exists, because that is what tells you whether to
  design around it permanently or wait for it:

${gloss.join("\n")}

${items.join("\n")}`;
}

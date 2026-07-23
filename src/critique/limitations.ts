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
  {
    id: "container-tier-only",
    summary: "container tier only — `--fidelity hostloop|cowork|microvm|protocol` is refused",
    provenance: {
      kind: "not-built",
      // WAS `unverified` until 2026-07-23. The proof its `liftedBy` named — a live resume-continuity run
      // at hostloop against the NATIVE agent binary (not the container ELF) — has now PASSED
      // (test/live-contract.test.ts, "resume-continuity proof at hostloop"; 4/4 live, native+ELF 2.1.217):
      // a resumed turn BOTH recalled a prior-turn-only conversation codeword (native session store
      // restored across --resume) AND freshly re-read the mounted skill's reference file (staged tree
      // survived resume). The container proof demonstrably transfers → the evidence obstacle is cleared, so
      // this is no longer `unverified`. What remains is BUILD work, not proof: unpin three hard-coded
      // container sites, stamp the tier on the session manifest so a cross-tier resume fails loud, and plumb
      // host-write consent for skill/critique — the one real design call, since hostloop writes to the
      // user's real FS whereas container is throwaway.
      note: "resume-continuity is PROVEN at hostloop's native binary (test/live-contract.test.ts; 4/4 live) — the tier is reachable, NOT a permanent boundary. The pin now remains only for build work: unpin three container sites, tier-stamp the session manifest so a cross-tier resume fails loud, and plumb host-write consent for skill/critique",
    },
    docsAnchor: "Container tier only",
  },
  {
    id: "skill-md-16kb-cap",
    summary: 'SKILL.md is capped at 16KB in the evidence — a larger one degrades toward "not adjudicable"',
    provenance: {
      kind: "deliberate",
      rationale: "the evidence package is bounded so the evaluator sees a whole record rather than a truncated tail",
    },
    docsAnchor: "capped at 16KB",
  },
  {
    id: "english-only",
    summary: "prompts are English-only",
    provenance: { kind: "not-built", note: "no localization work has been attempted; nothing blocks it" },
    docsAnchor: "English-only",
  },
  {
    id: "evidence-not-persisted",
    summary: "the evidence package the evaluator graded against is not written to disk",
    provenance: {
      kind: "not-built",
      note: "a disputed finding cannot be re-checked against the record it was graded on; persisting the ARMORED render would close it",
    },
    docsAnchor: "evidence package is not persisted",
  },
  {
    id: "report-stdout-only",
    summary: "the report goes to stdout only — capture it with shell redirection",
    provenance: { kind: "not-built", note: "there is no --out flag; --output-format changes the format, never the destination" },
    docsAnchor: "written to stdout",
  },
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

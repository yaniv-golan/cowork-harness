import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";

// User-facing docs describe how the harness IS. They are not a changelog.
//
// A reader arriving fresh has no "before" to contrast against, so "chat ALSO writes turns/1/result.json —
// so a chat session NOW shows up in stats" costs them a parse and tells them nothing they can act on. The
// same sentence without the history is shorter and complete. CHANGELOG.md is exempt: narrating change is
// its entire job.
//
// This guard exists because the problem is invisible while you are writing — every sentence feels
// natural to the person who just made the change, and reads as residue to everyone else.

/** Phrasing that contrasts the present against an unstated past. */
const HISTORICAL = [
  /\bno longer\b/i,
  /\bused to\b/i,
  /\bpreviously\b/i,
  /\bas of this change\b/i,
  /\bUpdate \(\d{4}-\d{2}-\d{2}\)/,
  /\bnow (writes|shows|holds|lives|means|refuses|includes|carries|emits|is the)\b/i,
];

/** Occurrences that are NOT product history and must not be "fixed".
 *
 *  The distinction is semantic, so it cannot be regexed: `docs/cassette.md`'s "the body no longer matches
 *  its record-time content" describes a LIVE relationship between a recording and the current tree — a
 *  runtime condition a reader acts on — not a change to the product. Each entry states which it is.
 *
 *  Anything not listed here is a violation. The list may SHRINK freely; growing it needs a justification
 *  that survives being read out loud. */
const NOT_HISTORY: { file: string; needle: string; why: string }[] = [
  { file: "docs/cassette.md", needle: "no longer matches", why: "recording-vs-live drift, a runtime condition" },
  { file: "docs/cassette.md", needle: "no longer correspond", why: "recording-vs-live drift" },
  { file: "docs/cassette.md", needle: "no longer silently", why: "describes allow-matching semantics, not a change" },
  { file: "docs/gotchas.md", needle: "no longer matches", why: "recording-vs-live drift" },
  { file: "SPEC.md", needle: "previously-valid document", why: "semver semantics: valid under an older schema" },
  { file: "SPEC.md", needle: "no longer matches", why: "cassette-vs-live tier drift" },
  { file: "SPEC.md", needle: "no longer shipped", why: "states a current fact about which schema files exist" },
  // Read in context and KEPT — a mechanical sweep would have destroyed real information here.
  {
    file: "docs/scenario.md",
    needle: "no longer a deterministic regression",
    why: "conditional logic: IF you use --decider-llm, THEN the run is not a regression. Not product history",
  },
  {
    file: ".claude/skills/cowork-harness/references/fidelity-and-answers.md",
    needle: "no longer a deterministic regression",
    why: "same conditional, mirrored",
  },
  {
    file: "docs/scenario.md",
    needle: '"agent" is retired',
    why: "documents a REJECTED value so an old scenario file's failure is diagnosable",
  },
  {
    file: ".claude/skills/cowork-harness/references/scenario-schema.md",
    needle: '"agent" is retired',
    why: "same rejected-value diagnostic",
  },
  { file: "docs/scenario.md", needle: "skill that no longer produces the frozen events", why: "cassette-vs-current-skill drift, runtime" },
  { file: "docs/stats.md", needle: "run dirs no longer on disk", why: "LIVE state: the dir was pruned. Not a product change" },
  { file: "docs/stats.md", needle: "`outDir` no longer exists on disk", why: "live state" },
  {
    file: "docs/subagents.md",
    needle: "Migrating from a single-",
    why: "an explicit MIGRATION note — a legitimate doc genre, and the reader upgrading needs it",
  },
  {
    file: "docs/subagents.md",
    needle: "previously dispatched child",
    why: "temporal WITHIN a run (a child dispatched earlier), not product history",
  },
  { file: ".claude/skills/cowork-harness/SKILL.md", needle: "body no longer matches", why: "recording-vs-live drift" },
  {
    file: ".claude/skills/cowork-harness/references/ci-recipe.md",
    needle: "no longer matches what the baseline resolves to",
    why: "recorded-vs-today drift",
  },
  {
    file: ".claude/skills/cowork-harness/references/task-recipes.md",
    needle: "no longer matches what the current baseline",
    why: "recorded-vs-today drift",
  },
];

/** Known violations still to be rewritten. MUST ONLY SHRINK — see the count assertion below. */
const KNOWN_DEBT: { file: string; needle: string }[] = [
  { file: "docs/boundary.md", needle: "is no longer mistaken" },
  { file: "docs/boundary.md", needle: "Update (2026-06-18)" },
  { file: "docs/maintenance.md", needle: "no longer blocks" },
  { file: "docs/fidelity-gaps.md", needle: "no longer a divergence" },
];

/** Only git-TRACKED files are user-facing docs. Gitignored working notes live under docs/ too —
 *  docs/internal (our own plans) and docs/superpowers (the plugin's) — and a filesystem walk would
 *  scan them and flag their historical narration, which is none of this guard's business. Tracking is
 *  the exact line: committed = shipped = subject to the present-tense rule; gitignored = not. This also
 *  means a future gitignored docs subdir is excluded automatically, with no new special-case here. */
const tracked = new Set(
  execSync("git ls-files", { encoding: "utf8", cwd: resolve(".") })
    .split("\n")
    .filter(Boolean),
);

function docFiles(): string[] {
  const out = ["README.md", "SPEC.md"];
  for (const base of ["docs", ".claude/skills/cowork-harness"]) {
    const walk = (d: string) => {
      for (const e of readdirSync(resolve(d))) {
        const p = join(d, e);
        if (statSync(resolve(p)).isDirectory()) walk(p);
        else if (p.endsWith(".md") && tracked.has(p)) out.push(p);
      }
    };
    walk(base);
  }
  return out;
}

/** SKILL.md's "What the >= X.Y.Z floor gates, by release" list is historical BY DESIGN — documenting what
 *  each version added is the entire point of a version floor. Exempted as a REGION rather than line by
 *  line, so the exemption cannot quietly spread to the rest of the file. */
function inReleaseNoteRegion(rel: string, lineNo: number): boolean {
  if (!rel.endsWith("SKILL.md")) return false;
  const lines = readFileSync(resolve(rel), "utf8").split("\n");
  const start = lines.findIndex((l) => /floor gates, by release/.test(l));
  if (start === -1) return false;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lineNo > start && (end === -1 || lineNo < end);
}

function violations(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const rel of docFiles()) {
    const lines = readFileSync(resolve(rel), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (inReleaseNoteRegion(rel, i + 1)) return;
      if (!HISTORICAL.some((re) => re.test(text))) return;
      if (NOT_HISTORY.some((a) => a.file === rel && text.includes(a.needle))) return;
      if (KNOWN_DEBT.some((a) => a.file === rel && text.includes(a.needle))) return;
      hits.push({ file: rel, line: i + 1, text: text.trim().slice(0, 140) });
    });
  }
  return hits;
}

describe("user-facing docs are written in the present tense", () => {
  it("the scan sees a real doc set (never go green over an empty walk)", () => {
    expect(docFiles().length).toBeGreaterThan(10);
    expect(docFiles()).toContain("README.md");
  });

  it("no NEW historical narration", () => {
    const v = violations();
    expect(
      v.map((h) => `${h.file}:${h.line}  ${h.text}`),
      "state what the harness does, not how it changed — CHANGELOG.md is where change belongs. If this is a runtime relationship (recording vs live) rather than product history, add it to NOT_HISTORY with the reason.",
    ).toEqual([]);
  });

  it("the known-debt list only shrinks", () => {
    // Pinned so a rewrite that removes one cannot be silently offset by adding another.
    expect(KNOWN_DEBT.length, "KNOWN_DEBT grew — new historical narration must be fixed, not listed").toBeLessThanOrEqual(4);
  });

  it("every KNOWN_DEBT and NOT_HISTORY entry still matches something (no dead entries)", () => {
    // A stale allowlist silently subtracts future violations of the same wording — this repo shipped a
    // 39/40-dead allowlist once already.
    for (const e of [...KNOWN_DEBT, ...NOT_HISTORY]) {
      const text = readFileSync(resolve(e.file), "utf8");
      expect(text.includes(e.needle), `dead entry: "${e.needle}" no longer appears in ${e.file} — remove it`).toBe(true);
    }
  });
});

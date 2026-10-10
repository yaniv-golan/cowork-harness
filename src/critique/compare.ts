// `critique --compare <report.json | summary.json …>`: several critiques of the same skill, side by side.
//
// Deterministic — no model is called, the same inputs in any order give the same bytes — and it renders NO verdict.
// No key a critique report carries can prove two findings are the same finding: `findingFingerprint` is exact-match
// on model-written wording and, across repeats of the same probe, often never recurs; a cited excerpt is shared by
// unrelated findings as often as by the same one. So compare does not say "reproduced", "one-off", "gone" or "new".
// It lines the reports up by classification for a person to read, and shows two lower-bound aids, each with k/N:
//
//   sameWording    an exact fingerprint seen in k of N reports — the same wording came back (a LOWER bound).
//   sharedExcerpt  the same cited passage under the same classification in k of N reports, with how many distinct
//                  ideas and actions cite it — a cue to read those items together, NOT a match.
//
// Groups are by `--label`: one group, or two (before/after). Two groups with the same corpusHash are labelled a
// noise-floor control: same corpus, so any difference between them is run-to-run variation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { collectSecrets, scrub } from "../secrets.js";

/** What compare reads from one input file, whichever shape it came in. */
export interface CompareMember {
  file: string;
  kind: "report" | "summary";
  sessionId: string | null;
  label: string | null;
  gradedSkill: string | null;
  harnessMajor: number | null;
  corpusHashScheme: number | null;
  fingerprintScheme: number | null;
  corpusHash: string | null;
  skillTreeHash: string | null;
  packagedCorpusHash: string | null;
  hashBasis: string | null;
  evaluatorModel: string | null;
  promptSha256: string | null;
  /** Why the member is left out of N, if it is. */
  excluded?: string;
  pass1Only: boolean;
  items: Array<{
    findingFingerprint: string;
    classification: string;
    source: string;
    idea?: string;
    recommendedAction?: string;
    evidence?: string;
  }>;
}

export class CompareRefusal extends Error {}

const SUMMARY_SCHEMA_RE = /^critique-summary\/\d+$/;
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const majorOf = (v: unknown): number | null => (typeof v === "string" && /^\d+\./.test(v) ? Number(v.split(".")[0]) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Read one input file. Refuses, by name, anything that is not a 4.8+ critique report or summary. */
export function loadMember(file: string): CompareMember {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new CompareRefusal(`${file}: cannot be read (${(e as Error).message})`);
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CompareRefusal(`${file}: not JSON — compare reads --output-format json reports (or --out with json) and --summary-out files`);
  }
  if (j && typeof j === "object" && "tool" in j && (j as { mode?: unknown }).mode === "corpus-only")
    throw new CompareRefusal(`${file}: a --corpus-only envelope, not a critique report`);
  if (j && typeof j === "object" && "tool" in j && "command" in j)
    throw new CompareRefusal(`${file}: an error or command envelope, not a critique report`);

  if (typeof j.schema === "string" && SUMMARY_SCHEMA_RE.test(j.schema)) {
    const items = Array.isArray(j.items) ? (j.items as Array<Record<string, unknown>>) : [];
    const integ = j.evaluatorIntegrity as { pass1Canary?: unknown; pass2Canary?: unknown } | null | undefined;
    return {
      file,
      kind: "summary",
      sessionId: str(j.sessionId),
      label: str(j.label),
      gradedSkill: str(j.gradedSkill),
      harnessMajor: majorOf(j.harnessVersion),
      corpusHashScheme: num(j.corpusHashScheme),
      fingerprintScheme: num(j.fingerprintScheme),
      corpusHash: str(j.corpusHash),
      skillTreeHash: str(j.skillTreeHash),
      packagedCorpusHash: str(j.packagedCorpusHash),
      hashBasis: str(j.hashBasis),
      evaluatorModel: str(j.evaluatorModel),
      promptSha256: str(j.promptSha256),
      excluded:
        j.status === "corpus_only"
          ? "a --corpus-only summary: no critique ran"
          : j.status !== "critiqued"
            ? `no critique was produced (${String(j.status)})`
            : integ && (integ.pass1Canary === false || integ.pass2Canary === false)
              ? "the evaluator's integrity canary failed (the critique may have been silenced)"
              : j.corpusDrift === true
                ? "a corpus file changed during the run (corpusDrift)"
                : undefined,
      pass1Only: j.selfReportStatus === "unavailable",
      items: items.map((i) => ({
        findingFingerprint: String(i.findingFingerprint),
        classification: String(i.classification),
        source: String(i.source),
      })),
    };
  }

  if (!("verdictProvenance" in j) || !Array.isArray(j.items))
    throw new CompareRefusal(`${file}: not a critique report or a --summary-out file`);
  if (typeof j.corpusHash !== "string" || typeof j.harnessVersion !== "string")
    throw new CompareRefusal(
      `${file}: a report written before 4.8.0 (no corpusHash / harnessVersion) — re-run the critique with 4.8.0 or later`,
    );
  const integ = j.evaluatorIntegrity as { pass1Canary?: unknown; pass2Canary?: unknown } | undefined;
  const identity = j.gradedSkillIdentity as { name?: unknown } | undefined;
  const prompt = typeof j.prompt === "string" ? j.prompt : undefined;
  return {
    file,
    kind: "report",
    sessionId: str(j.sessionId),
    label: str(j.label),
    gradedSkill: str(identity?.name) ?? str(j.gradedSkill),
    harnessMajor: majorOf(j.harnessVersion),
    corpusHashScheme: num(j.corpusHashScheme),
    fingerprintScheme: num(j.fingerprintScheme),
    corpusHash: str(j.corpusHash),
    skillTreeHash: str(j.skillTreeHash),
    packagedCorpusHash: str(j.packagedCorpusHash),
    hashBasis: str(j.hashBasis),
    evaluatorModel: str(j.evaluatorModel),
    promptSha256: prompt !== undefined ? createHash("sha256").update(prompt).digest("hex") : null,
    excluded: j.infraFailure
      ? "no critique was produced (an infrastructure or run failure)"
      : j.evaluatorError
        ? "no critique was produced (the evaluator failed)"
        : integ && (integ.pass1Canary === false || integ.pass2Canary === false)
          ? "the evaluator's integrity canary failed (the critique may have been silenced)"
          : j.corpusDrift !== undefined
            ? "a corpus file changed during the run (corpusDrift)"
            : undefined,
    pass1Only: j.selfReportStatus === "unavailable",
    items: (j.items as Array<Record<string, unknown>>)
      .filter((i) => i.citationResolved !== false)
      .map((i) => ({
        findingFingerprint: String(i.findingFingerprint ?? ""),
        classification: String(i.classification),
        source: String(i.source),
        idea: typeof i.idea === "string" ? i.idea : "",
        recommendedAction: typeof i.recommendedAction === "string" ? i.recommendedAction : "",
        evidence: typeof i.evidence === "string" ? i.evidence : "",
      })),
  };
}

/** Every mark a group can carry. */
export const MARKS = [
  "mixedEvaluator",
  "mixedBasis",
  "mixedSkillTree",
  "mixedPackagedCorpus",
  "mixedProbe",
  "probeUnverified",
  "pass1Only",
] as const;
type Mark = (typeof MARKS)[number];
/** The marks `--strict` refuses: each means the group's critiques did not grade the same thing the same way.
 *  `mixedPackagedCorpus` (it moves with what the agent happened to read) and `probeUnverified` (the default for a
 *  summary written without its prompt hash) are marked but not refused: they are expected, not a defect. */
export const STRICT_MARKS: ReadonlySet<Mark> = new Set(["mixedEvaluator", "mixedBasis", "mixedSkillTree", "mixedProbe", "pass1Only"]);

const tokens = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) as string[]);
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export const REWORDING_JACCARD = 0.6;
export const EXCERPT_MIN = 12;

/** Compare the given members. `strict` refuses a group carrying any mark instead of only marking it. */
export function compareMembers(input: CompareMember[], opts: { strict?: boolean } = {}): Record<string, unknown> {
  // Deterministic order, whatever order the files were given in.
  const all = [...input].sort(
    (a, b) => byCodePoint(a.label ?? "", b.label ?? "") || byCodePoint(a.sessionId ?? "", b.sessionId ?? "") || byCodePoint(a.file, b.file),
  );
  if (all.length < 2) throw new CompareRefusal("compare needs at least two critique reports or summaries");

  const labelled = all.filter((m) => m.label !== null).length;
  if (labelled !== 0 && labelled !== all.length)
    throw new CompareRefusal(`some inputs carry a --label and some do not; label every critique (groups are by label) or none`);
  const labels = [...new Set(all.map((m) => m.label ?? ""))].sort(byCodePoint);
  if (labels.length > 2)
    throw new CompareRefusal(`${labels.length} label groups (${labels.join(", ")}); compare takes one group, or two (before/after)`);

  const seen = new Map<string, string>();
  for (const m of all) {
    if (m.sessionId === null) continue;
    const prev = seen.get(m.sessionId);
    if (prev !== undefined)
      throw new CompareRefusal(`${m.file} and ${prev} are the same critique (session ${m.sessionId}); give each critique once`);
    seen.set(m.sessionId, m.file);
  }

  const one = <T>(what: string, vals: T[]): void => {
    const set = [...new Set(vals.map((v) => JSON.stringify(v)))];
    if (set.length > 1) throw new CompareRefusal(`the inputs mix ${what} (${set.join(", ")}); compare only critiques that share it`);
  };
  one(
    "graded skills",
    all.map((m) => m.gradedSkill),
  );
  one(
    "corpusHash schemes",
    all.map((m) => m.corpusHashScheme),
  );
  one(
    "fingerprint schemes",
    all.map((m) => m.fingerprintScheme),
  );
  one(
    "harness major versions",
    all.map((m) => m.harnessMajor),
  );

  const usable = all.filter((m) => m.excluded === undefined);
  const excluded = all.filter((m) => m.excluded !== undefined).map((m) => ({ file: m.file, reason: m.excluded! }));
  const groups = labels.map((label) => ({ label: label === "" ? null : label, members: usable.filter((m) => (m.label ?? "") === label) }));
  for (const g of groups) {
    if (g.members.length === 0)
      throw new CompareRefusal(`label group ${g.label ?? "(no label)"} has no usable critique (every member was excluded)`);
    const hashes = [...new Set(g.members.map((m) => m.corpusHash))];
    if (hashes.length > 1)
      throw new CompareRefusal(
        `label group ${g.label ?? "(no label)"} mixes corpusHash (${hashes.join(", ")}): a group must be critiques of one corpus — give the other corpus its own --label`,
      );
  }

  const secrets = collectSecrets();
  const groupOut = groups.map((g) => {
    const N = g.members.length;
    const marks: Mark[] = [];
    const distinct = <T>(vals: T[]) => new Set(vals).size > 1;
    if (distinct(g.members.map((m) => m.evaluatorModel))) marks.push("mixedEvaluator");
    if (distinct(g.members.map((m) => m.hashBasis))) marks.push("mixedBasis");
    // corpusHash is a floor: a scripts/ edit moves skillTreeHash only.
    if (distinct(g.members.map((m) => m.skillTreeHash))) marks.push("mixedSkillTree");
    if (distinct(g.members.map((m) => m.packagedCorpusHash))) marks.push("mixedPackagedCorpus");
    if (g.members.some((m) => m.promptSha256 === null)) marks.push("probeUnverified");
    else if (distinct(g.members.map((m) => m.promptSha256))) marks.push("mixedProbe");
    if (g.members.some((m) => m.pass1Only)) marks.push("pass1Only");
    const strictHits = marks.filter((m) => STRICT_MARKS.has(m));
    if (opts.strict && strictHits.length)
      throw new CompareRefusal(`--strict: label group ${g.label ?? "(no label)"} is marked ${strictHits.join(", ")}`);

    // Every finding, per report, aligned by classification.
    const byClassification: Record<string, Array<Record<string, unknown>>> = {};
    g.members.forEach((m, idx) => {
      for (const it of m.items) {
        (byClassification[it.classification] ??= []).push({
          report: idx,
          findingFingerprint: it.findingFingerprint,
          source: it.source,
          ...(it.idea !== undefined ? { idea: it.idea, recommendedAction: it.recommendedAction } : {}),
        });
      }
    });
    for (const k of Object.keys(byClassification))
      byClassification[k]!.sort(
        (a, b) => (a.report as number) - (b.report as number) || byCodePoint(String(a.findingFingerprint), String(b.findingFingerprint)),
      );

    // sameWording: an exact fingerprint in k reports of this group (k counted once per report).
    const fpReports = new Map<string, { classification: string; reports: Set<number> }>();
    g.members.forEach((m, idx) => {
      for (const it of m.items) {
        const e = fpReports.get(it.findingFingerprint) ?? { classification: it.classification, reports: new Set<number>() };
        e.reports.add(idx);
        fpReports.set(it.findingFingerprint, e);
      }
    });
    const sameWording = [...fpReports.entries()]
      .filter(([, e]) => e.reports.size >= 2)
      .map(([fp, e]) => ({ findingFingerprint: fp, classification: e.classification, k: e.reports.size, N }))
      .sort((a, b) => b.k - a.k || byCodePoint(a.findingFingerprint, b.findingFingerprint));

    // sharedExcerpt: full reports only; not-adjudicable items and short excerpts are left out (a not-adjudicable item
    // needs no citation, so its evidence is often empty and would key every such item together).
    const ex = new Map<string, { k: Set<number>; ideas: Set<string>; actions: Set<string> }>();
    g.members.forEach((m, idx) => {
      if (m.kind !== "report") return;
      for (const it of m.items) {
        if (it.classification === "not-adjudicable") continue;
        const e = norm(scrub(it.evidence ?? "", secrets)).toLowerCase();
        if (e.length < EXCERPT_MIN) continue;
        const anchor = sha16(`${it.classification}\n${e}`);
        const r = ex.get(anchor) ?? { k: new Set<number>(), ideas: new Set<string>(), actions: new Set<string>() };
        r.k.add(idx);
        r.ideas.add(norm(it.idea ?? "").toLowerCase());
        r.actions.add(norm(it.recommendedAction ?? "").toLowerCase());
        ex.set(anchor, r);
      }
    });
    const sharedExcerpt = [...ex.entries()]
      .filter(([, r]) => r.k.size >= 2)
      .map(([anchor, r]) => ({ anchor, k: r.k.size, N, distinctIdeas: r.ideas.size, distinctActions: r.actions.size }))
      .sort((a, b) => b.k - a.k || byCodePoint(a.anchor, b.anchor));

    return {
      label: g.label,
      N,
      reports: g.members.map((m, idx) => ({
        report: idx,
        file: m.file,
        kind: m.kind,
        sessionId: m.sessionId,
        evaluatorModel: m.evaluatorModel,
        findings: m.items.length,
      })),
      corpusHash: g.members[0]!.corpusHash,
      skillTreeHashes: [...new Set(g.members.map((m) => m.skillTreeHash))].filter((h): h is string => h !== null).sort(byCodePoint),
      marks,
      byClassification: Object.fromEntries(Object.entries(byClassification).sort(([a], [b]) => byCodePoint(a, b))),
      sameWording,
      sharedExcerpt,
    };
  });

  // Every exact fingerprint, with k/N in each group — the side-by-side across groups, with no verdict attached.
  const fingerprints = (() => {
    const rows = new Map<string, { classification: string; counts: number[] }>();
    groups.forEach((g, gi) =>
      g.members.forEach((m) => {
        const seenHere = new Set<string>();
        for (const it of m.items) {
          if (seenHere.has(it.findingFingerprint)) continue;
          seenHere.add(it.findingFingerprint);
          const r = rows.get(it.findingFingerprint) ?? { classification: it.classification, counts: groups.map(() => 0) };
          r.counts[gi]!++;
          rows.set(it.findingFingerprint, r);
        }
      }),
    );
    return [...rows.entries()]
      .map(([fp, r]) => ({
        findingFingerprint: fp,
        classification: r.classification,
        groups: r.counts.map((k, gi) => ({ k, N: groups[gi]!.members.length })),
      }))
      .sort((a, b) => byCodePoint(a.classification, b.classification) || byCodePoint(a.findingFingerprint, b.findingFingerprint));
  })();

  // possibleRewordings: full reports only — a JUDGEMENT, lexical: two items in different reports, same
  // classification, different fingerprint, whose ideas share most of their words.
  const flat = groups.flatMap((g, gi) =>
    g.members.flatMap((m, idx) =>
      m.kind === "report" ? m.items.map((it) => ({ group: gi, report: idx, it, toks: tokens(it.idea ?? "") })) : [],
    ),
  );
  const possibleRewordings: Array<Record<string, unknown>> = [];
  for (let a = 0; a < flat.length; a++)
    for (let b = a + 1; b < flat.length; b++) {
      const x = flat[a]!;
      const y = flat[b]!;
      if (x.group === y.group && x.report === y.report) continue;
      if (x.it.classification !== y.it.classification || x.it.findingFingerprint === y.it.findingFingerprint) continue;
      const j = jaccard(x.toks, y.toks);
      if (j >= REWORDING_JACCARD)
        possibleRewordings.push({
          a: { group: x.group, report: x.report, findingFingerprint: x.it.findingFingerprint },
          b: { group: y.group, report: y.report, findingFingerprint: y.it.findingFingerprint },
          classification: x.it.classification,
          jaccard: Math.round(j * 100) / 100,
        });
    }

  const fullReports = all.some((m) => m.kind === "report");
  return {
    mode: "compare",
    publicSafe: false,
    note: "No verdicts. sameWording is a LOWER bound (reworded repeats do not match); sharedExcerpt is the same cited passage, not proven the same finding; read the findings side by side, aligned by classification.",
    // Same corpus AND the same delivered skill tree in both groups (a scripts/ edit moves only the latter).
    noiseFloorControl:
      groups.length === 2 &&
      groupOut[0]!.corpusHash !== null &&
      groupOut[0]!.corpusHash === groupOut[1]!.corpusHash &&
      groupOut[0]!.skillTreeHashes.length === 1 &&
      JSON.stringify(groupOut[0]!.skillTreeHashes) === JSON.stringify(groupOut[1]!.skillTreeHashes),
    groups: groupOut,
    fingerprints,
    possibleRewordings: fullReports
      ? {
          basis: `lexical similarity of the idea text, Jaccard >= ${REWORDING_JACCARD} — a judgement, not a match`,
          pairs: possibleRewordings,
        }
      : { basis: "unavailable: summaries carry no finding text", pairs: [] },
    excluded: excluded.sort((a, b) => byCodePoint(a.file, b.file)),
  };
}

/** The text rendering: the same content as the JSON, for reading. */
export function renderCompareText(out: Record<string, unknown>): string {
  const groups = out.groups as Array<Record<string, unknown>>;
  const lines: string[] = [`critique --compare  (no verdicts — read the findings side by side)`];
  if (out.noiseFloorControl)
    lines.push(`  noise-floor control: both groups have the same corpusHash, so any difference is run-to-run variation`);
  for (const g of groups) {
    lines.push(
      "",
      `group ${g.label ?? "(no label)"}  N=${g.N}  corpusHash ${String(g.corpusHash).slice(0, 19)}…${(g.marks as string[]).length ? `  marked: ${(g.marks as string[]).join(", ")}` : ""}`,
    );
    for (const r of g.reports as Array<Record<string, unknown>>)
      lines.push(
        `  [${r.report}] ${basename(String(r.file))}  ${r.findings} finding(s)${r.evaluatorModel ? `  evaluator ${r.evaluatorModel}` : ""}`,
      );
    for (const [cls, items] of Object.entries(g.byClassification as Record<string, Array<Record<string, unknown>>>)) {
      lines.push(`  ${cls}:`);
      for (const it of items)
        lines.push(`    [${it.report}] ${it.findingFingerprint}${it.idea ? `  ${norm(String(it.idea)).slice(0, 140)}` : ""}`);
    }
    for (const s of g.sameWording as Array<Record<string, unknown>>)
      lines.push(`  same wording (lower bound): ${s.findingFingerprint} in ${s.k}/${s.N}`);
    for (const s of g.sharedExcerpt as Array<Record<string, unknown>>)
      lines.push(`  same cited passage (not proven same finding): ${s.anchor} in ${s.k}/${s.N}, ${s.distinctIdeas} distinct idea(s)`);
  }
  const rw = out.possibleRewordings as { basis: string; pairs: unknown[] };
  lines.push("", `possible rewordings (${rw.basis}): ${rw.pairs.length}`);
  for (const e of out.excluded as Array<{ file: string; reason: string }>) lines.push(`excluded ${basename(e.file)}: ${e.reason}`);
  return lines.join("\n") + "\n";
}

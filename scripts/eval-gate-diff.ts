// Gates a change by diffing the per-claim `semantic_matches` profile of a BASELINE run against a
// CANDIDATE run of the same scenario(s) — a content regression (a rubric claim that PASSED in
// baseline but FAILS in candidate) fails the gate. Self-contained: does not import src/types.ts,
// so it stays decoupled from the harness's Zod schemas — it only needs the shape documented below.
//
//   tsx scripts/eval-gate-diff.ts <baseline.json> <candidate.json>
//
// Each input file is a parsed result.json (or the `--output-format json` envelope
// `{ results: [RunResult, ...] }` — both forms are detected and unwrapped). Only assertions carrying
// a `semanticClaims` array (i.e. `semantic_matches` asserts, live-lane only) are considered; every
// other assertion kind is ignored by this tool.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** One graded rubric claim, as written onto `RunResult.assertions[].semanticClaims` (src/types.ts). */
export interface SemanticClaim {
  index: number;
  claim: string;
  pass: boolean;
}

/** The subset of an `assertions[]` entry this tool reads. `assertion.semantic_matches.rubric` is the
 *  authored claim list (src/types.ts `Assertion.semantic_matches.rubric`) — read opportunistically
 *  (untyped) so this tool has no hard dependency on the harness's Assertion schema. */
export interface AssertionResultLike {
  assertion?: { semantic_matches?: { rubric?: unknown } };
  pass?: boolean;
  message?: string;
  semanticClaims?: SemanticClaim[];
}

/** A parsed result.json (raw `RunResult`, loosely typed to just what's needed here). */
export interface RunResultLike {
  assertions?: AssertionResultLike[];
}

/** The `--output-format json` envelope (`src/run/envelope.ts` `jsonEnvelopeObj`) — `results` holds one
 *  RunResult per scenario/repeat/matrix cell. */
export interface ResultEnvelopeLike {
  results?: RunResultLike[];
}

export type ResultInput = RunResultLike | ResultEnvelopeLike;

export interface ClaimRef {
  rubricKey: string;
  index: number;
  claim: string;
}

export interface UnmatchedAssert {
  rubricKey: string;
  claims: SemanticClaim[];
}

export interface DiffReport {
  regressions: ClaimRef[];
  improvements: ClaimRef[];
  unchanged: number;
  unmatched: {
    baselineOnly: UnmatchedAssert[];
    candidateOnly: UnmatchedAssert[];
  };
}

/** A separator that won't plausibly appear inside an authored rubric claim — used to fold a rubric
 *  (or a claim list) into one stable string key. */
const KEY_SEP = "␟"; // SYMBOL FOR UNIT SEPARATOR

/** Unwrap either a raw RunResult or the `{results:[...]}` envelope into a flat list of
 *  `semantic_matches` assertion results (every other assertion kind — no `semanticClaims` array — is
 *  dropped here, per spec: "Consider ONLY assertions that have a `semanticClaims` array"). */
function extractSemanticAsserts(input: ResultInput): AssertionResultLike[] {
  const runs: RunResultLike[] =
    input && Array.isArray((input as ResultEnvelopeLike).results)
      ? (input as ResultEnvelopeLike).results!
      : [input as RunResultLike];
  const out: AssertionResultLike[] = [];
  for (const run of runs) {
    if (!run || !Array.isArray(run.assertions)) continue;
    for (const a of run.assertions) {
      if (a && Array.isArray(a.semanticClaims)) out.push(a);
    }
  }
  return out;
}

/** Stable identity for a `semantic_matches` assert, used to match the SAME assert across two runs.
 *  Prefer the authored rubric (`assertion.semantic_matches.rubric`, joined) — it is stable across a
 *  code change even if per-claim results shuffle. Fall back to the ordered claim texts on
 *  `semanticClaims` (e.g. a stripped-down fixture that only carries the graded results) so the tool
 *  still degrades gracefully rather than refusing to match. */
function rubricKeyOf(a: AssertionResultLike): string {
  const rubric = a.assertion?.semantic_matches?.rubric;
  if (Array.isArray(rubric) && rubric.length > 0 && rubric.every((r) => typeof r === "string")) {
    return (rubric as string[]).join(KEY_SEP);
  }
  return (a.semanticClaims ?? []).map((c) => c.claim).join(KEY_SEP);
}

/** Index a claims array by its `index` field (not array position — the two usually coincide, but the
 *  field is the documented alignment key per `RunResult.assertions[].semanticClaims`). */
function byIndex(claims: SemanticClaim[] | undefined): Map<number, SemanticClaim> {
  const m = new Map<number, SemanticClaim>();
  for (const c of claims ?? []) m.set(c.index, c);
  return m;
}

/** PURE: diff the per-claim semantic profile of a baseline run against a candidate run. Matching is
 *  per-ASSERT by `rubricKey` (a baseline assert and a candidate assert with the same rubricKey are the
 *  "same" assert across runs — see `rubricKeyOf`), then per-CLAIM by `index` within a matched pair.
 *  An assert with no counterpart on the other side is reported under `unmatched`, never silently
 *  dropped and never scored as a regression/improvement (a phantom would misattribute a rubric that
 *  was simply added/removed as a content change). */
export function diffSemanticClaims(baseline: ResultInput, candidate: ResultInput): DiffReport {
  const baseAsserts = extractSemanticAsserts(baseline);
  const candAsserts = extractSemanticAsserts(candidate);

  // FIFO queues per rubricKey so duplicate rubrics (an unusual but not-forbidden authoring choice)
  // are matched in encounter order rather than colliding on a single map slot.
  const baseQueues = new Map<string, AssertionResultLike[]>();
  for (const a of baseAsserts) {
    const key = rubricKeyOf(a);
    const q = baseQueues.get(key);
    if (q) q.push(a);
    else baseQueues.set(key, [a]);
  }

  const regressions: ClaimRef[] = [];
  const improvements: ClaimRef[] = [];
  let unchanged = 0;
  const candidateOnly: UnmatchedAssert[] = [];

  for (const c of candAsserts) {
    const key = rubricKeyOf(c);
    const queue = baseQueues.get(key);
    const b = queue && queue.length > 0 ? queue.shift() : undefined;
    if (!b) {
      candidateOnly.push({ rubricKey: key, claims: c.semanticClaims ?? [] });
      continue;
    }
    const bByIdx = byIndex(b.semanticClaims);
    const cByIdx = byIndex(c.semanticClaims);
    const indices = new Set<number>([...bByIdx.keys(), ...cByIdx.keys()]);
    for (const idx of indices) {
      const bc = bByIdx.get(idx);
      const cc = cByIdx.get(idx);
      if (!bc || !cc) continue; // claim present on only one side of a matched assert — nothing to compare
      const claimText = cc.claim || bc.claim;
      if (bc.pass && !cc.pass) {
        regressions.push({ rubricKey: key, index: idx, claim: claimText });
      } else if (!bc.pass && cc.pass) {
        improvements.push({ rubricKey: key, index: idx, claim: claimText });
      } else {
        unchanged++;
      }
    }
  }

  // Anything left in a baseline queue never found a candidate counterpart.
  const baselineOnly: UnmatchedAssert[] = [];
  for (const [key, queue] of baseQueues) {
    for (const b of queue) baselineOnly.push({ rubricKey: key, claims: b.semanticClaims ?? [] });
  }

  regressions.sort((x, y) => x.index - y.index);
  improvements.sort((x, y) => x.index - y.index);

  return { regressions, improvements, unchanged, unmatched: { baselineOnly, candidateOnly } };
}

/** Human-readable rendering of a `DiffReport` — regressions listed first (with claim text) since
 *  they're the gate-failing signal a reader needs to act on. */
export function formatReport(report: DiffReport): string {
  const lines: string[] = [];
  if (report.regressions.length > 0) {
    lines.push(`✗ ${report.regressions.length} regression(s) (rubric claim PASSED in baseline, FAILS in candidate):`);
    for (const r of report.regressions) lines.push(`  - [${r.index}] ${r.claim}`);
  } else {
    lines.push("✓ no regressions");
  }
  if (report.improvements.length > 0) {
    lines.push(`${report.improvements.length} improvement(s) (baseline FAILED, candidate PASSES):`);
    for (const i of report.improvements) lines.push(`  + [${i.index}] ${i.claim}`);
  }
  lines.push(`${report.unchanged} unchanged claim(s)`);
  const { baselineOnly, candidateOnly } = report.unmatched;
  if (baselineOnly.length > 0) {
    lines.push(`${baselineOnly.length} assert(s) present only in baseline (unmatched, not scored):`);
    for (const u of baselineOnly) lines.push(`  - rubricKey=${JSON.stringify(u.rubricKey)}`);
  }
  if (candidateOnly.length > 0) {
    lines.push(`${candidateOnly.length} assert(s) present only in candidate (unmatched, not scored):`);
    for (const u of candidateOnly) lines.push(`  - rubricKey=${JSON.stringify(u.rubricKey)}`);
  }
  return lines.join("\n");
}

function main(): void {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  if (!baselinePath || !candidatePath) {
    process.stderr.write("usage: eval-gate-diff <baseline.json> <candidate.json>\n");
    process.exitCode = 2;
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as ResultInput;
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as ResultInput;
  const report = diffSemanticClaims(baseline, candidate);
  process.stdout.write(formatReport(report) + "\n");
  if (report.regressions.length > 0) process.exitCode = 1;
}

// Run only when invoked directly (so a test can import diffSemanticClaims/formatReport without side
// effects) — same guard as scripts/check-versions.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

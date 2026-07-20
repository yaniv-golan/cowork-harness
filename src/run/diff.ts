// Run/cassette diff engine with normalization. Compares two runs, two cassettes, or a run and a
// cassette (both reduce to an event stream + result metadata through parseMessage/buildTrace, the same
// typed model `trace` uses — so this stays correct as the SDK schema evolves).
import { DEFAULT_SCAN_PATTERNS } from "../scan.js";
import { diffFileSigsPaths, type FileSigDiff } from "./cassette.js";

const HOST_PATH_RE = DEFAULT_SCAN_PATTERNS.find((p) => p.cls === "path")!.re;

// Order matters: run the more specific pattern (host path, which itself contains a `/local_.../`-shaped
// segment sometimes) before the generic session-marker pattern, so a host path isn't partially eaten by
// the session-marker replace first and left in a half-masked state.
const MASKS: { re: RegExp; token: string }[] = [
  { re: /toolu_[A-Za-z0-9]+/g, token: "toolu_<ID>" },
  { re: HOST_PATH_RE, token: "<HOST_PATH>" },
  { re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, token: "<UUID>" },
  { re: /\blocal_[a-z0-9]+/gi, token: "<SESSION>" },
  { re: /\bsess-[A-Za-z0-9-]+/g, token: "<SESSION>" },
  { re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, token: "<TIMESTAMP>" },
  // coworkWebFetchDedup marker's "…{N}s ago…" — a live-run age that varies run-to-run (advisory diff view only).
  { re: /\b\d+s ago\b/g, token: "<AGE>" },
];

/** Replaces every volatile-but-not-meaningful span (tool-use ids, UUIDs, session-dir markers,
 *  ISO-8601 timestamps, host paths) with a stable placeholder token, so two runs of the SAME scenario
 *  diff as identical despite this per-run noise. Deliberately does NOT touch the redaction vocabulary's
 *  sensitive-value classes (email/currency/domain) — this is about comparison stability, not privacy.
 *  Host-path source — DELIBERATELY not src/redact.ts + io.ts's tildeify, the two obvious candidates:
 *  redact.ts turned out to be a user-policy-driven redactor (`.cowork-redact.json`/env; empty by
 *  default) with NO built-in host-path regex to reuse, and tildeify is a HOME→`~` display formatter, not a
 *  masker. The one built-in host-path vocabulary in the codebase is src/scan.ts's DEFAULT_SCAN_PATTERNS
 *  "path" class — so that regex (only the regex, not the scanner machinery) is reused instead. */
export function maskVolatileText(text: string): string {
  let out = text;
  for (const { re, token } of MASKS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    out = out.replace(g, token);
  }
  return out;
}

// Keys whose VALUE is volatile regardless of what it says — not caught by text-pattern masking because
// the value itself isn't pattern-shaped (a plain millisecond integer). Structural, not textual: masking by
// key name, not by guessing which numbers "look like" a duration.
const VOLATILE_KEYS = new Set(["duration_ms", "durationms", "elapsed_ms", "timestamp", "request_id", "uuid"]);

function maskVolatileValue(v: unknown): unknown {
  if (typeof v === "string") return maskVolatileText(v);
  if (Array.isArray(v)) return v.map(maskVolatileValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = VOLATILE_KEYS.has(k.toLowerCase()) ? "<VOLATILE>" : maskVolatileValue(val);
    }
    return out;
  }
  return v;
}

const CANON_CAP = 2000;

/** Bounded, key-aware canonicalization of a tool's `input` (or any structured value) for tool-sequence
 *  comparison — masks volatile string spans AND volatile key names, then caps the length. The 100-char
 *  `summarize()` in trace-view.ts is display-lossy by design; this needs its own, larger, comparison-safe
 *  cap (still bounded — never an unbounded dump into a diff hunk). */
export function canonicalizeInput(input: unknown, normalize = true): string {
  let s: string;
  try {
    s = JSON.stringify(normalize ? maskVolatileValue(input) : input);
  } catch {
    s = String(input);
  }
  return s.length > CANON_CAP ? s.slice(0, CANON_CAP) + "…" : s;
}

export interface NormalizedToolRow {
  name: string;
  canon: string; // canonicalizeInput(tool input) — the comparison key alongside `name`
}

export type ToolDiffOp =
  | { op: "same"; a: NormalizedToolRow; b: NormalizedToolRow }
  | { op: "added"; b: NormalizedToolRow }
  | { op: "removed"; a: NormalizedToolRow }
  | { op: "changed"; a: NormalizedToolRow; b: NormalizedToolRow };

/** LCS over full-row equality (name AND canon must match for "same"), then a post-pass over each gap
 *  between LCS matches: a 1-vs-1 gap with the SAME tool name is a "changed" input, not a remove+add pair
 *  (the diff should read as "Write's path changed", not "Write was removed, a different Write was
 *  added") — anything else in a gap is emitted as removed-then-added, in original order. */
export function diffToolSequence(a: NormalizedToolRow[], b: NormalizedToolRow[]): ToolDiffOp[] {
  const eq = (x: NormalizedToolRow, y: NormalizedToolRow) => x.name === y.name && x.canon === y.canon;
  const n = a.length,
    m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: ToolDiffOp[] = [];
  let gapA: NormalizedToolRow[] = [];
  let gapB: NormalizedToolRow[] = [];
  const flushGap = () => {
    if (gapA.length === 1 && gapB.length === 1 && gapA[0].name === gapB[0].name) {
      ops.push({ op: "changed", a: gapA[0], b: gapB[0] });
    } else {
      for (const r of gapA) ops.push({ op: "removed", a: r });
      for (const r of gapB) ops.push({ op: "added", b: r });
    }
    gapA = [];
    gapB = [];
  };

  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      flushGap();
      ops.push({ op: "same", a: a[i], b: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      gapA.push(a[i]);
      i++;
    } else {
      gapB.push(b[j]);
      j++;
    }
  }
  while (i < n) gapA.push(a[i++]);
  while (j < m) gapB.push(b[j++]);
  flushGap();

  return ops;
}

export type TranscriptDiffLine = { op: "same" | "added" | "removed"; text: string };

/** Line-based diff over two (already-normalized-by-masking) transcripts. Lines are masked before
 *  comparison, same volatile-span rules as tool inputs, so two runs of the same scenario diff as
 *  identical despite embedded ids/timestamps — but model-stochastic PROSE will still differ across live
 *  re-records no matter what; this view is advisory, not the gateable signal (that's tools/artifacts/meta). */
export function diffTranscript(a: string, b: string, normalize = true): TranscriptDiffLine[] {
  const mask = normalize ? maskVolatileText : (s: string) => s;
  const aLines = a.split("\n").map(mask);
  const bLines = b.split("\n").map(mask);
  const n = aLines.length,
    m = bLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: TranscriptDiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ op: "same", text: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: "removed", text: aLines[i] });
      i++;
    } else {
      ops.push({ op: "added", text: bLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: "removed", text: aLines[i++] });
  while (j < m) ops.push({ op: "added", text: bLines[j++] });
  return ops;
}

export interface DiffMetaSummary {
  result: string;
  effectiveFidelity?: string;
  baseline: string;
  assertionsPassed: boolean;
  /** Short `fingerprint.skillHash` prefix — the content-exact generation key. Diffed so a comparison can
   *  NAME which two generations it compared; without it a diff of a skill across a fix is anonymous. */
  skillHash?: string;
}

export type MetaDiffEntry = { field: string; from: unknown; to: unknown };

/** result / effectiveFidelity / baseline-of-record / assertion-verdict deltas — a fixed, small field
 *  set (not a recursive object diff like the baseline differ; these are named,
 *  known fields with a fixed comparison, not an open-ended structure). */
export function diffMeta(a: Partial<DiffMetaSummary>, b: Partial<DiffMetaSummary>): MetaDiffEntry[] {
  const fields: (keyof DiffMetaSummary)[] = ["result", "effectiveFidelity", "baseline", "assertionsPassed", "skillHash"];
  const out: MetaDiffEntry[] = [];
  for (const f of fields) {
    if (a[f] === undefined && b[f] === undefined) continue;
    if (a[f] !== b[f]) out.push({ field: f, from: a[f], to: b[f] });
  }
  return out;
}

/** Artifacts view — a thin, source-agnostic wrapper over the EXISTING cassette manifest differ
 *  (diffFileSigsPaths, cassette.ts) — this is the one place the 50-doc's claimed head start genuinely
 *  transfers. Callers extract [path, sha256] pairs from whichever source they have (a cassette's
 *  ManifestEntry[], or live on-disk hashes for a run dir whose workDir still exists). */
export function diffArtifacts(a: Array<[string, string]>, b: Array<[string, string]>): FileSigDiff {
  return diffFileSigsPaths(a, b);
}

/** One side of a run/cassette comparison, reduced to the four diffable views plus identity metadata. */
export interface DiffSide {
  tools: NormalizedToolRow[];
  transcript: string;
  artifacts?: Array<[string, string]>; // undefined = no manifest available for this side
  meta: Partial<DiffMetaSummary>;
  // Identity metadata, NOT diffed content: used only for the cross-scenario warning ("allow + warn" —
  // comparing two different scenarios is legitimate for skill-variant comparison, but must be flagged,
  // since the meta view doesn't surface scenario identity).
  scenarioName?: string;
}

/** Per-side artifact-manifest availability for a comparison. "both-available" is the only state a real
 *  diffArtifacts() runs for; the other three describe why it didn't. Distinguished from a boolean because
 *  the two missing-one-side states ("a-unavailable"/"b-unavailable") gate identity differently than the
 *  missing-both state ("both-unavailable") — see compareDiffSides. */
export type ArtifactsAvailability = "both-available" | "a-unavailable" | "b-unavailable" | "both-unavailable";

function artifactsAvailability(a: DiffSide, b: DiffSide): ArtifactsAvailability {
  const aOk = a.artifacts !== undefined;
  const bOk = b.artifacts !== undefined;
  if (aOk && bOk) return "both-available";
  if (aOk) return "b-unavailable";
  if (bOk) return "a-unavailable";
  return "both-unavailable";
}

export interface DiffViewResult {
  tools: ToolDiffOp[];
  transcript: TranscriptDiffLine[];
  artifacts?: FileSigDiff;
  meta: MetaDiffEntry[];
  /** Why `artifacts` is (or isn't) populated — see ArtifactsAvailability. Exists so a caller can render
   *  "not compared, evidence missing" distinctly from "compared, no differences found", including on the
   *  `identical:true` path where renderDiffText's own artifacts-view caveat never runs (that view is only
   *  reached from the non-identical branch). */
  artifactsAvailability: ArtifactsAvailability;
  /** GATEABLE identity: tools + artifacts + meta agree. Deliberately EXCLUDES the transcript, which is
   *  advisory — model-stochastic prose differs across live re-records no matter what, so folding it in
   *  made two runs of the SAME skill compare non-identical and the signal could not separate "behaviour
   *  changed" from "the model breathed". This is the value `diff --help` has always promised
   *  ("tools/artifacts/meta are the gateable signal") and the one the exit code uses.
   *
   *  Artifact evidence that exists on only ONE side is the canonical "could not verify" case and must NOT
   *  read as "nothing changed" — an absent manifest is not proof of equality, so a-unavailable/b-unavailable
   *  force `identical:false` regardless of what tools/meta say. both-unavailable is different: neither side
   *  offers artifact evidence, so there is no asymmetric loss to distrust and no comparison being silently
   *  skipped in favor of a stronger one — it degrades to the tools/meta verdict, same as always. Treating
   *  both-unavailable as a hard fail instead would turn every diff between two artifact-manifest-less
   *  cassettes (a real, common case — see cli-diff/diff-gateable-signal fixtures) permanently red with no
   *  way to pass, for a dimension neither side ever claimed to evidence. */
  identical: boolean;
  /** Advisory: the transcript differed. Surfaced separately so prose drift stays VISIBLE without
   *  contaminating the gate. */
  transcriptDiffers: boolean;
}

export function compareDiffSides(a: DiffSide, b: DiffSide, normalize: boolean): DiffViewResult {
  const tools = diffToolSequence(a.tools, b.tools);
  const transcript = diffTranscript(a.transcript, b.transcript, normalize);
  const availability = artifactsAvailability(a, b);
  const artifacts = availability === "both-available" ? diffArtifacts(a.artifacts!, b.artifacts!) : undefined;
  const meta = diffMeta(a.meta, b.meta);
  const artifactsIdentical =
    availability === "both-available"
      ? artifacts!.added.length === 0 && artifacts!.removed.length === 0 && artifacts!.changed.length === 0
      : availability === "both-unavailable";
  const identical = tools.every((o) => o.op === "same") && artifactsIdentical && meta.length === 0;
  return {
    tools,
    transcript,
    artifacts,
    meta,
    artifactsAvailability: availability,
    identical,
    transcriptDiffers: transcript.some((o) => o.op !== "same"),
  };
}

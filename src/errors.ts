/**
 * Shared typed errors. Leaf module (no imports) so any layer can throw these without creating an
 * import cycle. `main().catch` (cli.ts) maps `BoundaryError` to a clean, no-stack exit 3.
 */

/**
 * Thrown for a boundary/integrity violation that must fail loud and clean (no stack trace):
 * a scenario asserting boundary behavior at a fidelity that can't enforce it, a symlinked
 * staging path that escapes the session tree, or a plugin/skill source that would mount EMPTY.
 */
export class BoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryError";
  }
}

/**
 * Thrown for a user-input mistake detected past the flag parser (e.g. a scenario file that fails
 * schema validation). `main().catch` (cli.ts) maps it to a clean category-`usage` exit 2 — without
 * this, a Zod throw from a scenario typo surfaced as category `internal` (a user mistake
 * masquerading as a harness bug).
 */
export class UsageError extends Error {
  /** Long-form detail for a message that had to be compact. Mirrors `UnansweredError.hint`, which is
   *  the convention this repo already uses for a short/long pair, and lands in the CONTRACTED
   *  `error.hint` envelope field — so a caller that wants the full Zod issue array can still read it
   *  while a terminal gets one line. */
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UsageError";
    this.hint = hint;
  }
}

/**
 * Thrown by `loadBaseline` when a user-supplied baseline name or path names no baseline (a missing file,
 * or a name with a path separator). A `UsageError`, so every CLI entry point that lets it escape gets
 * the clean category-`usage` exit 2 from `main().catch`; `hint` lists the committed baselines. Without
 * it the bare `readFileSync` ENOENT surfaced as a raw stack trace / category `internal`.
 */
export class UnknownBaselineError extends UsageError {
  readonly baselineName: string;
  constructor(baselineName: string, message: string, hint?: string) {
    super(message, hint);
    this.name = "UnknownBaselineError";
    this.baselineName = baselineName;
  }
}

/** A Zod issue path rendered the way a YAML author can locate it: `assert[0].path_denied.source`, never
 *  `assert.0`; an empty or non-array path is `(root)`. Shared by `compactSchemaError` and `lint`'s loader
 *  findings so the two never spell the same location differently. Never throws. */
export function renderIssuePath(path: unknown): string {
  if (!Array.isArray(path) || path.length === 0) return "(root)";
  return path.reduce<string>((acc, seg) => (typeof seg === "number" ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : String(seg)), "");
}

/**
 * One line from a Zod issue list (or from an already-formatted Zod message).
 *
 * `ZodError.message` is `JSON.stringify(issues, null, 2)` — 13-16 lines per file, mostly punctuation.
 * In a batch that is the difference between a readable listing and a wall of JSON: a 35-file corpus
 * break printed ~455 lines, none of which `--quiet` suppresses (correctly — they are the failure, not
 * the preview).
 *
 * Takes the ISSUES where a caller has them (no round-trip through formatted text) and falls back to
 * parsing the message where it does not. Paths render bracketed — `assert[0].path_denied.source`, the
 * shape a YAML author can actually locate — never `assert.0`.
 *
 * MUST NOT THROW: it runs on error-reporting paths, where an error raised while *reporting* an error is
 * the bug this is guarded against. Lives here, in the leaf module, because both `execute.ts` (which
 * throws) and `cassette.ts` (which renders) need it and `cassette.ts` already imports `execute.ts`.
 */
export function compactSchemaError(messageOrIssues: string | unknown[], limit = 200, maxIssues = 3): string {
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const truncate = (s: string) => (s.length > limit ? s.slice(0, limit - 1) + "…" : s);
  const renderPath = renderIssuePath;
  try {
    let issues: unknown = messageOrIssues;
    if (typeof messageOrIssues === "string") {
      const start = messageOrIssues.indexOf("[");
      if (start === -1) return truncate(collapse(messageOrIssues));
      issues = JSON.parse(messageOrIssues.slice(start));
    }
    if (Array.isArray(issues)) {
      const parts = issues
        .map((i) => {
          if (!i || typeof i !== "object") return "";
          const msg = (i as { message?: unknown }).message;
          if (typeof msg !== "string") return "";
          const where = renderPath((i as { path?: unknown }).path);
          return `${msg} at ${where}`;
        })
        .filter(Boolean);
      if (parts.length) {
        const shown = parts.slice(0, maxIssues);
        const more = parts.length - shown.length;
        return truncate(collapse(shown.join("; ") + (more > 0 ? ` … +${more} more` : "")));
      }
    }
  } catch {
    /* fall through to the raw-message fallback below */
  }
  return truncate(collapse(typeof messageOrIssues === "string" ? messageOrIssues : String(messageOrIssues)));
}

/**
 * Thrown by `turn-layout.ts`'s `requireTurns` when a run dir is `legacy` (pre-layout, root-only),
 * `mixed` (a pre-layout dir resumed under current code — turns/ AND stray root files), or `none` (never
 * completed). Named for the shape the whole class shares (a dir the seam refuses to address, rather than
 * silently guessing), not just the pre-layout case, so one catch site covers all three refusals.
 */
export class LegacyRunDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyRunDirError";
  }
}

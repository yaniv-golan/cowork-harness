// Bumps every hand-maintained "cowork-harness X.Y.Z" version mention across the repo via targeted,
// pattern-based edits — NOT a blind old->new string replace, which would corrupt historical
// release-note bullets ("- **0.33.0:** the redacted marker…") and prose ("the loop 0.33.0's
// observability…"). Dry-run is the DEFAULT; --write is required to modify files.
//
//   tsx scripts/bump-version.ts <X.Y.Z>            # dry-run: print the diff summary, write nothing
//   tsx scripts/bump-version.ts <X.Y.Z> --write    # write files (lockfile included), self-verify
//
// (Deliberately no --dry-run flag: `npm run bump X --dry-run` would silently drop the flag — npm
// eats it unless forwarded via `--` — and do a REAL bump. Default-safe avoids that trap.)
//
// This script intentionally does NOT touch: SKILL.md's `- **X.Y.Z:** …` release-note bullets, the
// "the loop X.Y.Z's observability" prose, CHANGELOG.md per-release headings, anything under
// baselines/, or the `V=X.Y.Z` agent-binary pins (those track the baseline agentVersion, not the
// harness version — see check-versions.ts invariant 8). The CHANGELOG `[Unreleased]` -> `[X] — DATE`
// move and the new SKILL.md release-note bullet are also NOT automated here — both are content, not
// mechanical substitution; main() prints a reminder.
//
// The lockfile is bumped by its two root version fields, like any other target, not by `npm install
// --package-lock-only`: that re-resolves the whole tree with whatever npm is installed, and npm 11.7.0 dropped the
// `libc` fields from every platform-binding entry during a bump, so `npm ci` on Linux lost glibc vs musl.
//
// Dry-run is the default (see above). Each rewriter is registered per file in FILE_REWRITERS, and a test
// runs every one against the real file it is registered for, so a rewriter whose target has left the file
// fails instead of silently no-opping at bump time.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkVersions } from "./check-versions.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p: string) => readFileSync(join(REPO_ROOT, p), "utf8");

const SEMVER = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Pattern-level rewrites. Each is scoped to the exact surrounding context it targets so a bare
// version number in unrelated prose (a release-note bullet, a baseline pin, a Node-version mention)
// never matches.
// ---------------------------------------------------------------------------

/** A single pattern-scoped rewrite. `pattern` carries the `g` flag iff every occurrence is meant to be
 *  rewritten; a pattern WITHOUT `g` rewrites only the first match, so a second occurrence would be left
 *  stale silently — which is why the live-rewriter test pins those to exactly one match per file. */
export interface Rewriter {
  name: string;
  pattern: RegExp;
  replacement: (newVersion: string) => string;
}

/** Every `cowork-harness@^X.Y.Z` floor. CARET, not `>=`: `>=` crosses majors (measured — `@>=1.0.0`
 *  resolves 2.0.0), so an unbounded floor hands a consumer the next breaking release. */
const HARNESS_FLOORS: Rewriter = {
  name: "harness-floors",
  pattern: /cowork-harness@\^\d+\.\d+\.\d+/g,
  replacement: (v) => `cowork-harness@^${v}`,
};

/** A bare, backtick-delimited `` `@^X.Y.Z` `` floor with no `cowork-harness` prefix (SKILL.md's `Pin `@^X`` phrase). */
const BARE_FLOORS: Rewriter = {
  name: "bare-floors",
  pattern: /`@\^\d+\.\d+\.\d+`/g,
  replacement: (v) => `\`@^${v}\``,
};

/** The single `"version": "X.Y.Z"` JSON field in a file that carries exactly one such key. */
const JSON_VERSION_FIELD: Rewriter = {
  name: "json-version-field",
  pattern: /"version":\s*"\d+\.\d+\.\d+"/,
  replacement: (v) => `"version": "${v}"`,
};

/** SKILL.md frontmatter `version:` line. */
const FRONTMATTER_VERSION: Rewriter = {
  name: "frontmatter-version",
  pattern: /^(\s*version:\s*)\d+\.\d+\.\d+(\s*)$/m,
  replacement: (v) => `$1${v}$2`,
};

/**
 * SKILL.md `tracks-harness: cowork-harness X.Y.Z (baseline desktop-A.B.C)` line — bumps only the
 * harness-version token immediately after `cowork-harness `, leaving the `(baseline …)` suffix
 * completely untouched.
 */
const TRACKS_HARNESS_LINE: Rewriter = {
  name: "tracks-harness-line",
  pattern: /(tracks-harness:\s*cowork-harness\s+)\d+\.\d+\.\d+/,
  replacement: (v) => `$1${v}`,
};

/** SKILL.md `**Version note:** … track \`cowork-harness X.Y.Z\`` line. */
const VERSION_NOTE_LINE: Rewriter = {
  name: "version-note-line",
  pattern: /(track `cowork-harness )\d+\.\d+\.\d+(`)/,
  replacement: (v) => `$1${v}$2`,
};

/** SKILL.md `needs **≥ X.Y.Z**` sentence. */
const NEEDS_FLOOR: Rewriter = {
  name: "needs-floor",
  pattern: /(needs \*\*≥ )\d+\.\d+\.\d+(\*\*)/,
  replacement: (v) => `$1${v}$2`,
};

/** references/*.md `` Tracks `cowork-harness X.Y.Z` `` stamp. */
const TRACKS_STAMP: Rewriter = {
  name: "tracks-stamp",
  pattern: /Tracks `cowork-harness \d+\.\d+\.\d+`/g,
  replacement: (v) => `Tracks \`cowork-harness ${v}\``,
};

/** ci-recipe.md's `` e.g. `version: "X.Y.Z"` `` example. */
const CI_RECIPE_EXAMPLE: Rewriter = {
  name: "ci-recipe-example",
  pattern: /(e\.g\. `version: ")\d+\.\d+\.\d+(")/,
  replacement: (v) => `$1${v}$2`,
};

/** package-lock.json's top-level `version`, the line after the root `name`. Anchored to the file's first lines so
 *  no dependency's `version` can match. */
const LOCKFILE_ROOT_VERSION: Rewriter = {
  name: "lockfile-root-version",
  pattern: /^(\{\n  "name": "cowork-harness",\n  "version": ")\d+\.\d+\.\d+(")/,
  replacement: (v) => `$1${v}$2`,
};

/** package-lock.json's `packages[""].version`, the root package's own entry. */
const LOCKFILE_ROOT_PACKAGE_VERSION: Rewriter = {
  name: "lockfile-root-package-version",
  pattern: /("packages": \{\n    "": \{\n      "name": "cowork-harness",\n      "version": ")\d+\.\d+\.\d+(")/,
  replacement: (v) => `$1${v}$2`,
};

// ---------------------------------------------------------------------------
// Per-file composition. Each target file gets exactly the pattern set the release-process plan
// (P3) specifies for it — never a blanket regex applied to every file, which would corrupt
// unrelated version-shaped mentions the plan explicitly calls out (README.md's Node-floor mention and
// `≥1.14271.0` baseline mentions, for example).
// ---------------------------------------------------------------------------

const SKILL_MD = ".claude/skills/cowork-harness/SKILL.md";
const CI_RECIPE_MD = ".claude/skills/cowork-harness/references/ci-recipe.md";
const REFERENCES_DIR = ".claude/skills/cowork-harness/references";
/** Every reference other than ci-recipe.md carries only the `Tracks` stamp. Enumerated from the directory,
 *  like check:versions invariant 6, so a new reference is bumped by rule rather than by remembering to
 *  list it here. */
const TRACKS_STAMP_REFS: readonly string[] = readdirSync(join(REPO_ROOT, REFERENCES_DIR))
  .filter((f) => f.endsWith(".md") && f !== "ci-recipe.md")
  .sort()
  .map((f) => `${REFERENCES_DIR}/${f}`);
const PLUGIN_JSON = ".claude/skills/cowork-harness/.claude-plugin/plugin.json";
const MARKETPLACE_JSON = ".claude-plugin/marketplace.json";
const REPLAYS_README = "examples/replays/README.md";
// Router-split pages (docs/cli.md, docs/companion-skill.md, docs/ci.md) carry install floors too.
// Missing one fails `check:versions` at bump time, which is exactly how docs/companion-skill.md was caught.
const COMPANION_SKILL_MD = "docs/companion-skill.md";
const CLI_MD = "docs/cli.md";
const CI_MD = "docs/ci.md";

/** The rewriters each target file receives, applied in order. Exported so a test can run every one of
 *  them against the REAL file and prove it still matches: a rewriter whose pattern matches nothing is a
 *  silent no-op at bump time, and that is how a dead heading rewriter went unnoticed for releases. */
export const FILE_REWRITERS: Readonly<Record<string, readonly Rewriter[]>> = {
  "package.json": [JSON_VERSION_FIELD],
  "package-lock.json": [LOCKFILE_ROOT_VERSION, LOCKFILE_ROOT_PACKAGE_VERSION],
  [MARKETPLACE_JSON]: [JSON_VERSION_FIELD],
  [PLUGIN_JSON]: [JSON_VERSION_FIELD],
  [SKILL_MD]: [
    FRONTMATTER_VERSION,
    TRACKS_HARNESS_LINE,
    VERSION_NOTE_LINE,
    NEEDS_FLOOR,
    HARNESS_FLOORS,
    BARE_FLOORS, // the `Pin `@^X`` phrase — a bare floor, like README's
  ],
  ...Object.fromEntries(TRACKS_STAMP_REFS.map((f) => [f, [TRACKS_STAMP]])),
  [CI_RECIPE_MD]: [TRACKS_STAMP, CI_RECIPE_EXAMPLE, HARNESS_FLOORS],
  [REPLAYS_README]: [HARNESS_FLOORS],
  // No BARE_FLOORS on these four: none carries a bare `@^X` any more (README's Action-inputs mention
  // moved out in the router split), so it was a registered no-op — the dead-rewriter shape the live test
  // below exists to catch. Re-add it here only together with a bare floor it actually matches.
  [COMPANION_SKILL_MD]: [HARNESS_FLOORS],
  [CLI_MD]: [HARNESS_FLOORS],
  [CI_MD]: [HARNESS_FLOORS],
  "README.md": [HARNESS_FLOORS],
};

/** Files this script knows how to edit, in the order they're reported. */
export const TARGET_FILES: readonly string[] = [
  "package.json",
  "package-lock.json",
  MARKETPLACE_JSON,
  PLUGIN_JSON,
  SKILL_MD,
  ...TRACKS_STAMP_REFS,
  CI_RECIPE_MD,
  REPLAYS_README,
  COMPANION_SKILL_MD,
  CLI_MD,
  CI_MD,
  "README.md",
];

/**
 * Pure: computes the new content for one file. Never reads or writes anything itself, so it can be
 * exercised directly on fixture strings in tests without touching the repo.
 */
export function rewriteFileContent(relPath: string, content: string, newVersion: string): string {
  const rewriters = Object.hasOwn(FILE_REWRITERS, relPath) ? FILE_REWRITERS[relPath] : undefined;
  if (!rewriters) throw new Error(`bump-version: no rewrite rule registered for "${relPath}"`);
  return rewriters.reduce((next, rw) => next.replace(rw.pattern, rw.replacement(newVersion)), content);
}

export interface FileEdit {
  file: string;
  before: string;
  after: string;
  changed: boolean;
}

/** Reads every target file off disk and computes its planned edit. Read-only — no writes. */
export function planEdits(newVersion: string): FileEdit[] {
  return TARGET_FILES.map((file) => {
    const before = r(file);
    const after = rewriteFileContent(file, before, newVersion);
    return { file, before, after, changed: before !== after };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { version: string; write: boolean } {
  const write = argv.includes("--write");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const version = positional[0];
  if (!version || !SEMVER.test(version)) {
    throw new Error(
      `expected an X.Y.Z version as the first argument, got ${JSON.stringify(version ?? "")}. ` +
        `Usage: tsx scripts/bump-version.ts <X.Y.Z> [--write]`,
    );
  }
  return { version, write };
}

/** Rough per-file line-diff count for the human-readable summary — not used for correctness. */
function countChangedLines(before: string, after: string): number {
  const b = before.split("\n");
  const a = after.split("\n");
  let n = 0;
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i++) if (b[i] !== a[i]) n++;
  return n;
}

function main(): void {
  let version: string;
  let write: boolean;
  try {
    ({ version, write } = parseArgs(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`::error::bump-version: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const edits = planEdits(version);
  const changed = edits.filter((e) => e.changed);

  process.stdout.write(`bump-version — target ${version} (${write ? "--write" : "dry-run; pass --write to modify files"})\n\n`);
  for (const e of edits) {
    if (e.changed) {
      process.stdout.write(`~ ${e.file} — ${countChangedLines(e.before, e.after)} line(s) changed\n`);
    } else {
      process.stdout.write(`= ${e.file} — unchanged\n`);
    }
  }

  if (changed.length === 0) {
    process.stdout.write("\nNo files need changes — already at target version, or no matching patterns found.\n");
    if (!write) return;
  }

  if (!write) {
    process.stdout.write("\nDry run only — no files written. Re-run with --write to apply.\n");
    return;
  }

  for (const e of changed) {
    writeFileSync(join(REPO_ROOT, e.file), e.after, "utf8");
  }
  process.stdout.write(`\nWrote ${changed.length} file(s).\n`);

  process.stdout.write("\nSelf-verifying with check:versions...\n");
  const { ok, errors, values } = checkVersions();
  process.stdout.write(`version lockstep: ${JSON.stringify(values)}\n`);
  if (!ok) {
    for (const e of errors) process.stderr.write(`::error::${e}\n`);
    process.stderr.write("::error::bump-version: check:versions failed after writing — see errors above.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("✓ all version strings are aligned\n");

  process.stdout.write(
    "\nReminder — these are MANUAL, not done by this script:\n" +
      `  - Move CHANGELOG.md's [Unreleased] section to "## [${version}] — <DATE>".\n` +
      // NOTE: SKILL.md deliberately carries NO per-release history as of 1.10.0 (it is changelog content
      // billed to every agent's context on load — see CHANGELOG 1.10.0 "Changed"). Do not re-add a
      // `- **X.Y.Z:**` bullet there; the CHANGELOG is the release record.
      `  - (SKILL.md carries no per-release bullets — that section was removed in 1.10.0; CHANGELOG only.)\n`,
  );
}

// Run only when invoked directly (so a test can import the pure functions without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

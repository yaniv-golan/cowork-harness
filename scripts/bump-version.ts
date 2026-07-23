// Bumps every hand-maintained "cowork-harness X.Y.Z" version mention across the repo via targeted,
// pattern-based edits — NOT a blind old->new string replace, which would corrupt historical
// release-note bullets ("- **0.33.0:** the redacted marker…") and prose ("the loop 0.33.0's
// observability…"). Dry-run is the DEFAULT; --write is required to modify files.
//
//   tsx scripts/bump-version.ts <X.Y.Z>            # dry-run: print the diff summary, write nothing
//   tsx scripts/bump-version.ts <X.Y.Z> --write    # write files, sync lockfile, self-verify
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
// This design folds in adversarial-review hardening: dry-run-by-default (see above), tolerating the
// README's bare `@>=X` floor, and a test that the current-version release-note bullet survives the bump.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

/** Every `cowork-harness@>=X.Y.Z` floor. */
function bumpHarnessFloors(content: string, newVersion: string): string {
  return content.replace(/cowork-harness@>=\d+\.\d+\.\d+/g, `cowork-harness@>=${newVersion}`);
}

/** A bare, backtick-delimited `` `@>=X.Y.Z` `` floor with no `cowork-harness` prefix (README's Action-inputs mention + SKILL.md's `Pin `@>=X`` phrase). */
function bumpBareFloors(content: string, newVersion: string): string {
  return content.replace(/`@>=\d+\.\d+\.\d+`/g, `\`@>=${newVersion}\``);
}

/** The single `"version": "X.Y.Z"` JSON field in a file that carries exactly one such key. */
function bumpJsonVersionField(content: string, newVersion: string): string {
  return content.replace(/"version":\s*"\d+\.\d+\.\d+"/, `"version": "${newVersion}"`);
}

/** SKILL.md frontmatter `version:` line. */
function bumpFrontmatterVersion(content: string, newVersion: string): string {
  return content.replace(/^(\s*version:\s*)\d+\.\d+\.\d+(\s*)$/m, `$1${newVersion}$2`);
}

/**
 * SKILL.md `tracks-harness: cowork-harness X.Y.Z (baseline desktop-A.B.C)` line — bumps only the
 * harness-version token immediately after `cowork-harness `, leaving the `(baseline …)` suffix
 * completely untouched.
 */
function bumpTracksHarnessLine(content: string, newVersion: string): string {
  return content.replace(/(tracks-harness:\s*cowork-harness\s+)\d+\.\d+\.\d+/, `$1${newVersion}`);
}

/** SKILL.md `**Version note:** … track \`cowork-harness X.Y.Z\`` line. */
function bumpVersionNoteLine(content: string, newVersion: string): string {
  return content.replace(/(track `cowork-harness )\d+\.\d+\.\d+(`)/, `$1${newVersion}$2`);
}

/** SKILL.md `needs **≥ X.Y.Z**` sentence. */
function bumpNeedsFloor(content: string, newVersion: string): string {
  return content.replace(/(needs \*\*≥ )\d+\.\d+\.\d+(\*\*)/, `$1${newVersion}$2`);
}

/** SKILL.md `What the ≥ X.Y.Z floor gates` heading. */
function bumpFloorGatesHeading(content: string, newVersion: string): string {
  return content.replace(/(What the ≥ )\d+\.\d+\.\d+( floor gates)/, `$1${newVersion}$2`);
}

/** references/*.md `` Tracks `cowork-harness X.Y.Z` `` stamp. */
function bumpTracksStamp(content: string, newVersion: string): string {
  return content.replace(/Tracks `cowork-harness \d+\.\d+\.\d+`/g, `Tracks \`cowork-harness ${newVersion}\``);
}

/** ci-recipe.md's `` e.g. `version: "X.Y.Z"` `` example. */
function bumpCiRecipeExample(content: string, newVersion: string): string {
  return content.replace(/(e\.g\. `version: ")\d+\.\d+\.\d+(")/, `$1${newVersion}$2`);
}

// ---------------------------------------------------------------------------
// Per-file composition. Each target file gets exactly the pattern set the release-process plan
// (P3) specifies for it — never a blanket regex applied to every file, which would corrupt
// unrelated version-shaped mentions the plan explicitly calls out (README.md's `Node ≥ 20` and
// `≥1.14271.0` baseline mentions, for example).
// ---------------------------------------------------------------------------

const SKILL_MD = ".claude/skills/cowork-harness/SKILL.md";
const CI_RECIPE_MD = ".claude/skills/cowork-harness/references/ci-recipe.md";
const SCENARIO_SCHEMA_MD = ".claude/skills/cowork-harness/references/scenario-schema.md";
const FIDELITY_AND_ANSWERS_MD = ".claude/skills/cowork-harness/references/fidelity-and-answers.md";
const TASK_RECIPES_MD = ".claude/skills/cowork-harness/references/task-recipes.md";
const PLUGIN_JSON = ".claude/skills/cowork-harness/.claude-plugin/plugin.json";
const MARKETPLACE_JSON = ".claude-plugin/marketplace.json";
const REPLAYS_README = "examples/replays/README.md";

/** Files this script knows how to edit, in the order they're reported. */
export const TARGET_FILES: readonly string[] = [
  "package.json",
  MARKETPLACE_JSON,
  PLUGIN_JSON,
  SKILL_MD,
  SCENARIO_SCHEMA_MD,
  FIDELITY_AND_ANSWERS_MD,
  TASK_RECIPES_MD,
  CI_RECIPE_MD,
  REPLAYS_README,
  "README.md",
];

/**
 * Pure: computes the new content for one file. Never reads or writes anything itself, so it can be
 * exercised directly on fixture strings in tests without touching the repo.
 */
export function rewriteFileContent(relPath: string, content: string, newVersion: string): string {
  switch (relPath) {
    case "package.json":
    case MARKETPLACE_JSON:
    case PLUGIN_JSON:
      return bumpJsonVersionField(content, newVersion);

    case SKILL_MD: {
      let next = content;
      next = bumpFrontmatterVersion(next, newVersion);
      next = bumpTracksHarnessLine(next, newVersion);
      next = bumpVersionNoteLine(next, newVersion);
      next = bumpNeedsFloor(next, newVersion);
      next = bumpFloorGatesHeading(next, newVersion);
      next = bumpHarnessFloors(next, newVersion);
      next = bumpBareFloors(next, newVersion); // the `Pin `@>=X`` phrase — a bare floor, like README's
      return next;
    }

    case SCENARIO_SCHEMA_MD:
    case FIDELITY_AND_ANSWERS_MD:
    case TASK_RECIPES_MD:
      return bumpTracksStamp(content, newVersion);

    case CI_RECIPE_MD: {
      let next = content;
      next = bumpTracksStamp(next, newVersion);
      next = bumpCiRecipeExample(next, newVersion);
      next = bumpHarnessFloors(next, newVersion);
      return next;
    }

    case REPLAYS_README:
      return bumpHarnessFloors(content, newVersion);

    case "README.md": {
      let next = content;
      next = bumpHarnessFloors(next, newVersion);
      next = bumpBareFloors(next, newVersion);
      return next;
    }

    default:
      throw new Error(`bump-version: no rewrite rule registered for "${relPath}"`);
  }
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

  process.stdout.write("\nSyncing lockfile (npm install --package-lock-only)...\n");
  execSync("npm install --package-lock-only", { cwd: REPO_ROOT, stdio: "inherit" });

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
      `  - Add a new SKILL.md release-note bullet: "- **${version}:** …".\n`,
  );
}

// Run only when invoked directly (so a test can import the pure functions without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

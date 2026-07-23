import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// `docs/internal/` is untracked working notes (SPEC.md documents the convention). A citation to it
// from a tracked, shipped file — a comment or a runtime string — dangles for anyone reading the public
// repo: the file they'd need to resolve the reference doesn't exist in their checkout. The rule is
// that comments and user-facing strings must stand on their own — carry the rationale inline, never
// cite an internal plan doc. This guard walks the shipped surface and fails loudly on any new
// `docs/internal` string so the next one can't creep back in silently.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Legitimate mentions: these files document or implement the docs/internal exclusion convention
// itself, so the string appearing in them is the point, not a dangling citation. Plus this guard
// file's own comments above, which have to name the string to describe what they're checking for.
const ALLOWLIST = new Set<string>([
  "test/docs-present-tense.test.ts",
  "test/docs-index-sync.test.ts",
  "test/no-internal-doc-references.test.ts",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Recursively collect file paths (relative to REPO_ROOT) under `root`, skipping SKIP_DIRS. */
function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** The shipped surface this guard scans: src/**, scripts/**, test/**, plus the two top-level docs
 *  that ship with the package. Deliberately NOT docs/** — docs/internal/ lives under docs/ and would
 *  require excluding itself from its own scan; SPEC.md (which legitimately documents the convention)
 *  also lives outside this list rather than being scanned and allowlisted. */
function shippedSurfaceFiles(): string[] {
  const files: string[] = [];
  for (const dir of ["src", "scripts", "test"]) {
    const abs = join(REPO_ROOT, dir);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) files.push(...walk(abs));
  }
  for (const top of ["README.md", "CHANGELOG.md"]) {
    const abs = join(REPO_ROOT, top);
    if (statSync(abs, { throwIfNoEntry: false })?.isFile()) files.push(abs);
  }
  return files;
}

describe("no docs/internal references leak into shipped files", () => {
  it("scanned a non-trivial number of files (a walk that finds nothing would false-green)", () => {
    // Floor well below the real count so a SKIP_DIRS typo or a wrong root can't silently pass.
    expect(shippedSurfaceFiles().length).toBeGreaterThan(50);
  });

  it("contains no `docs/internal` reference outside the allowlisted files", () => {
    const offenders: string[] = [];
    for (const abs of shippedSurfaceFiles()) {
      const rel = relative(REPO_ROOT, abs).split("\\").join("/");
      if (ALLOWLIST.has(rel)) continue;
      const text = readFileSync(abs, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("docs/internal")) offenders.push(`${rel}:${i + 1}`);
      }
    }
    expect(
      offenders,
      `Found docs/internal reference(s) in shipped files:\n${offenders.join("\n")}\n\n` +
        `docs/internal is untracked, gitignored working notes — a reference to it from a shipped file ` +
        `dangles for anyone reading the public repo. Comments and user-facing strings must stand on ` +
        `their own: carry the rationale inline, never cite an internal plan doc. If the file is a ` +
        `legitimate exception (it documents or implements the docs/internal exclusion convention ` +
        `itself), add it to ALLOWLIST in this test with a comment explaining why.`,
    ).toEqual([]);
  });
});

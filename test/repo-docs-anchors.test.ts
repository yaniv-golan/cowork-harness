import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// C1b: repo-docs anchor integrity.
//
// Repo docs (docs/*.md, examples/README.md) link into root README.md headings via
// `](../README.md#slug)` (and the `./README.md#…` / `README.md#…` variants where present). If a
// README heading is reworded, those anchors silently break — this test computes the GitHub
// heading-slug set for every heading in root README.md and fails if any referenced `#slug` has no
// matching heading.
//
// This is a repo-docs-only check (does not scan the skill payload — the payload-link check in
// skill-payload-links.test.ts covers that).

const README_PATH = resolve("README.md");

/** GitHub-style heading slug: lowercase; strip anything that isn't alphanumeric, space, or
 *  hyphen; replace each whitespace char with a hyphen (runs of whitespace become runs of
 *  hyphens — NOT collapsed, matching GitHub's actual behavior for e.g. "Testing & CI/CD" ->
 *  "testing--cicd"). */
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s/g, "-");
}

/** Extract ATX headings (# ... ######) from markdown, skipping anything inside fenced code
 *  blocks (``` or ~~~) — README.md has shell comments like "# 0. Before the first live run"
 *  inside bash fences that are NOT real headings. */
function extractHeadings(text: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) headings.push(m[1].trim());
  }
  return headings;
}

function readmeSlugSet(): Set<string> {
  const text = readFileSync(README_PATH, "utf8");
  return new Set(extractHeadings(text).map(githubSlug));
}

function repoDocFiles(): string[] {
  const docsDir = resolve("docs");
  const docs = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(docsDir, f));
  const examplesReadme = resolve("examples/README.md");
  return [...docs, examplesReadme];
}

interface AnchorRef {
  file: string;
  slug: string;
  raw: string;
}

function readmeAnchorRefs(file: string): AnchorRef[] {
  const text = readFileSync(file, "utf8");
  const refs: AnchorRef[] = [];
  // Matches ](../README.md#slug), ](./README.md#slug), ](README.md#slug)
  const re = /\]\((?:\.\.?\/)?README\.md#([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.push({ file, slug: m[1], raw: m[0] });
  }
  return refs;
}

describe("repo docs' ../README.md anchors resolve to real README headings (C1b)", () => {
  const slugs = readmeSlugSet();

  it("parsed a sane README heading set (guards against extraction silently breaking)", () => {
    expect(slugs.size).toBeGreaterThan(10);
    expect(slugs.has("commands-at-a-glance")).toBe(true);
  });

  const files = repoDocFiles();
  expect(files.length).toBeGreaterThan(1);

  const allRefs = files.flatMap((f) => readmeAnchorRefs(f));

  it("found at least one ../README.md anchor reference to check (guards against a no-op test)", () => {
    expect(allRefs.length).toBeGreaterThan(0);
  });

  it("every ](../README.md#slug) anchor in docs/*.md and examples/README.md matches a real README heading", () => {
    const broken = allRefs.filter((r) => !slugs.has(r.slug));
    expect(
      broken,
      broken
        .map((r) => `${r.file.replace(resolve(".") + "/", "")}: ${r.raw} — #${r.slug} has no matching README heading`)
        .join("\n"),
    ).toEqual([]);
  });
});

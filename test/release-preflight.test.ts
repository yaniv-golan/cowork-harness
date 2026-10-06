import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  changelogHasVersionSection,
  changelogPlaceholderLines,
  tagExists,
  isValidSemver,
  ciJobNames,
  unreportedRequiredContexts,
  checkInitSurfaceObserved,
  ALLOW_UNOBSERVED_INIT_SURFACE_FLAG,
} from "../scripts/release-preflight.js";

describe("isValidSemver", () => {
  it("accepts a plain X.Y.Z version", () => {
    expect(isValidSemver("0.33.0")).toBe(true);
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("12.34.56")).toBe(true);
  });

  it("rejects a two-part version", () => {
    expect(isValidSemver("1.0")).toBe(false);
  });

  it("rejects a non-numeric tag like 'latest'", () => {
    expect(isValidSemver("latest")).toBe(false);
  });

  it("rejects a pre-release/build-metadata suffix", () => {
    expect(isValidSemver("1.0.0-beta.1")).toBe(false);
    expect(isValidSemver("1.0.0+build5")).toBe(false);
  });

  it("rejects a leading 'v' prefix (tag name, not the bare version)", () => {
    expect(isValidSemver("v1.0.0")).toBe(false);
  });
});

describe("changelogHasVersionSection", () => {
  it("returns true for a heading with a non-empty body", () => {
    const text = ["## [0.33.0] - 2026-07-13", "", "### Added", "- something new", "", "## [0.32.0] - 2026-07-01", "", "- older"].join("\n");
    expect(changelogHasVersionSection(text, "0.33.0")).toBe(true);
  });

  it("returns false when the heading is entirely missing", () => {
    const text = ["## [0.32.0] - 2026-07-01", "", "- older"].join("\n");
    expect(changelogHasVersionSection(text, "0.33.0")).toBe(false);
  });

  it("returns false when the heading exists but the section body is empty", () => {
    const text = ["## [0.33.0] - 2026-07-13", "", "## [0.32.0] - 2026-07-01", "", "- older"].join("\n");
    expect(changelogHasVersionSection(text, "0.33.0")).toBe(false);
  });

  it("returns false when the section body is only blank lines", () => {
    const text = ["## [0.33.0] - 2026-07-13", "", "   ", "", "## [0.32.0] - 2026-07-01", "- older"].join("\n");
    expect(changelogHasVersionSection(text, "0.33.0")).toBe(false);
  });

  it("stops the section at the next '## [' heading, not further content", () => {
    const text = ["## [0.33.0] - 2026-07-13", "", "- new thing", "## [0.32.0] - 2026-07-01", "", "- older thing"].join("\n");
    expect(changelogHasVersionSection(text, "0.33.0")).toBe(true);
    // and the older section is independently detected too
    expect(changelogHasVersionSection(text, "0.32.0")).toBe(true);
  });

  it("is anchored to the literal heading line, not a substring match elsewhere in the file", () => {
    const text = ["Some prose mentioning ## [0.33.0] mid-sentence, not a real heading.", "", "## [0.32.0]", "", "- older"].join("\n");
    expect(changelogHasVersionSection(text, "0.33.0")).toBe(false);
  });

  it("matches the version literally, so dots are not treated as any-char wildcards", () => {
    const text = ["## [0.33.0]", "", "- body"].join("\n");
    // A version differing only where the dots are should NOT match (the heading is a literal prefix).
    expect(changelogHasVersionSection(text, "0X33X0")).toBe(false);
  });
});

describe("tagExists", () => {
  it("detects a tag present in the local tag list", () => {
    expect(tagExists(["v0.32.0", "v0.33.0"], [], "0.33.0")).toBe(true);
  });

  it("detects a tag present only on the remote (raw ls-remote lines)", () => {
    const remoteLines = ["abc123\trefs/heads/main", "def456\trefs/tags/v0.33.0", "def456\trefs/tags/v0.33.0^{}"];
    expect(tagExists([], remoteLines, "0.33.0")).toBe(true);
  });

  it("returns false when the tag is absent from both local and remote", () => {
    const remoteLines = ["abc123\trefs/heads/main", "def456\trefs/tags/v0.32.0"];
    expect(tagExists(["v0.32.0"], remoteLines, "0.33.0")).toBe(false);
  });

  it("does not false-positive on a tag name that is a prefix of another (e.g. v0.33.0 vs v0.33.0-rc1)", () => {
    const remoteLines = ["abc123\trefs/tags/v0.33.0-rc1"];
    expect(tagExists([], remoteLines, "0.33.0")).toBe(false);
  });

  it("handles an empty local/remote input without throwing", () => {
    expect(tagExists([], [], "1.0.0")).toBe(false);
  });
});

// A branch ruleset is GitHub SETTINGS, not repo content — no test, workflow, or diff review can see it.
// Renaming a CI job therefore silently orphans any ruleset context pinned to the old name, and a required
// check that no job reports never resolves: every PR sits BLOCKED forever, however green CI is. That went
// unnoticed for 676 commits after `0ead103` renamed the python job. An admin can bypass it; an outside
// contributor cannot, so it is contribution-blocking, not just release friction.
describe("ciJobNames", () => {
  const yaml = `
name: ci
jobs:
  build:
    name: build · typecheck · guards
    runs-on: ubuntu-latest
  test:
    name: unit tests (sharded)
    strategy:
      matrix:
        shard: [1, 2]
  floor:
    runs-on: ubuntu-latest
`;
  it("uses the declared name where present", () => {
    expect(ciJobNames(yaml)).toContain("build · typecheck · guards");
  });

  it("falls back to the job id when a job declares no name", () => {
    expect(ciJobNames(yaml)).toContain("floor");
  });

  it("returns [] for a workflow with no jobs rather than throwing", () => {
    expect(ciJobNames("name: ci\non: push\n")).toEqual([]);
  });
});

describe("unreportedRequiredContexts", () => {
  const jobs = ["build · typecheck · guards", "unit tests (sharded)", "pytest helper lane (-m 'not cowork')"];

  it("reports a context no job declares — the defect this exists to catch", () => {
    expect(unreportedRequiredContexts(["pytest cowork-lane (helper self-checks)"], jobs)).toEqual([
      "pytest cowork-lane (helper self-checks)",
    ]);
  });

  it("accepts an exact match", () => {
    expect(unreportedRequiredContexts(["build · typecheck · guards"], jobs)).toEqual([]);
  });

  // A matrix job reports one context per cell — "unit tests (sharded) (1)" — while the workflow declares
  // only the stem. Treating those as unreported would warn on a correctly-pinned matrix job.
  it("accepts a matrix-expanded context against its declared stem", () => {
    expect(unreportedRequiredContexts(["unit tests (sharded) (1)", "unit tests (sharded) (4)"], jobs)).toEqual([]);
  });

  it("does not accept a mere prefix that is not a matrix expansion", () => {
    expect(unreportedRequiredContexts(["unit tests"], jobs)).toEqual(["unit tests"]);
  });

  it("returns [] when nothing is required", () => {
    expect(unreportedRequiredContexts([], jobs)).toEqual([]);
  });
});

describe("checkInitSurfaceObserved (check 7)", () => {
  const block = (observed: boolean) => ({ provenance: { desktopInitSurface: { observed } } });

  it("passes an observed newest baseline", () => {
    expect(checkInitSurfaceObserved({ name: "desktop-9.json", json: block(true) }, false).status).toBe("PASS");
  });

  it("FAILS an unobserved one, and names the dedicated override (never --allow-empty)", () => {
    const r = checkInitSurfaceObserved({ name: "desktop-9.json", json: block(false) }, false);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain(ALLOW_UNOBSERVED_INIT_SURFACE_FLAG);
    expect(r.detail).not.toContain("--allow-empty");
  });

  it("FAILS a newest baseline with no block at all", () => {
    expect(checkInitSurfaceObserved({ name: "desktop-9.json", json: { provenance: {} } }, false).status).toBe("FAIL");
  });

  it("the override downgrades to WARN, never PASS", () => {
    expect(checkInitSurfaceObserved({ name: "desktop-9.json", json: block(false) }, true).status).toBe("WARN");
  });
});

describe("changelogPlaceholderLines", () => {
  const section = (...body: string[]) =>
    ["## [Unreleased]", "", "## [4.3.0] — 2026-10-03", "", ...body, "", "## [4.2.1] — 2026-10-01", "", "- older"].join("\n");

  it("flags the visible release-summary TODO line, naming its line number", () => {
    const text = section("**TODO: release summary — replace before tagging.**", "", "### Added", "- a thing");
    expect(changelogPlaceholderLines(text, "4.3.0")).toEqual([{ line: 5, text: "**TODO: release summary — replace before tagging.**" }]);
  });

  it("flags an HTML comment that says placeholder, including one spanning lines", () => {
    expect(changelogPlaceholderLines(section("<!-- placeholder: release summary text -->", "- a thing"), "4.3.0")).toHaveLength(1);
    const multi = section("<!--", "  summary placeholder, finalized later", "-->", "- a thing");
    expect(changelogPlaceholderLines(multi, "4.3.0").map((x) => x.line)).toEqual([5]); // the comment's opening line
  });

  it("flags plain, list and emphasised TODO markers", () => {
    for (const l of ["TODO: write this", "- TODO fill in", "* **TODO** summary", "__TODO__: x"])
      expect(changelogPlaceholderLines(section(l), "4.3.0"), l).toHaveLength(1);
  });

  it("does not flag prose that mentions a placeholder or a TODO mid-line, or a comment shown as code", () => {
    const text = section(
      "- **Bug reports** ask for the version, and the baseline placeholder is current.",
      "- left out as a calibration TODO pointing at `trace --view questions`.",
      "- an explicit `<!-- placeholder-ok -->` marker in a code span.",
      "- `TODO` comments are ignored by the linter.",
    );
    expect(changelogPlaceholderLines(text, "4.3.0")).toEqual([]);
  });

  it("looks only inside the version's own section", () => {
    const text = ["## [Unreleased]", "", "TODO: next release", "", "## [4.3.0]", "", "- done", "", "## [4.2.1]", "", "TODO: old"].join(
      "\n",
    );
    expect(changelogPlaceholderLines(text, "4.3.0")).toEqual([]);
  });

  it("the real CHANGELOG has no marker in any released section", () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md"), "utf8");
    const versions = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
    expect(versions.length).toBeGreaterThan(10);
    for (const v of versions) expect(changelogPlaceholderLines(text, v), v).toEqual([]);
  });
});

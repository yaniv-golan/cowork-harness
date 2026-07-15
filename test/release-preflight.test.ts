import { describe, it, expect } from "vitest";
import { changelogHasVersionSection, tagExists, isValidSemver } from "../scripts/release-preflight.js";

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

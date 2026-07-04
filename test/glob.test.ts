import { describe, it, expect } from "vitest";
import { globToRegExp, anyGlobMatches } from "../src/glob.js";

describe("globToRegExp — the no_unexpected_files allowlist matcher", () => {
  const m = (glob: string, path: string) => globToRegExp(glob).test(path);

  it("`**` matches any depth including zero segments", () => {
    expect(m("outputs/**", "outputs/a.md")).toBe(true);
    expect(m("outputs/**", "outputs/a/b/c.md")).toBe(true);
    expect(m("a/**/b", "a/b")).toBe(true);
    expect(m("a/**/b", "a/x/y/b")).toBe(true);
    expect(m("**/x.md", "x.md")).toBe(true);
    expect(m("**/x.md", "deep/er/x.md")).toBe(true);
    expect(m("**", "anything/at/all.txt")).toBe(true);
  });

  it("`**` does not bleed across sibling prefixes", () => {
    expect(m("outputs/**", "outputsx/a.md")).toBe(false);
    expect(m("outputs/**", "out/a.md")).toBe(false);
  });

  it("`*` stays within one segment", () => {
    expect(m("outputs/*.md", "outputs/a.md")).toBe(true);
    expect(m("outputs/*.md", "outputs/a/b.md")).toBe(false);
    expect(m("outputs/handoff/*/final.json", "outputs/handoff/r1/final.json")).toBe(true);
    expect(m("outputs/handoff/*/final.json", "outputs/handoff/r1/r2/final.json")).toBe(false);
  });

  it("`?` matches exactly one non-`/` character", () => {
    expect(m("outputs/v?.md", "outputs/v1.md")).toBe(true);
    expect(m("outputs/v?.md", "outputs/v12.md")).toBe(false);
    expect(m("outputs/a?b", "outputs/a/b")).toBe(false);
  });

  it("literal characters are escaped (no accidental regex semantics)", () => {
    expect(m("outputs/a.md", "outputs/axmd")).toBe(false);
    expect(m("outputs/re(port).md", "outputs/re(port).md")).toBe(true);
    expect(m("outputs/x[1].json", "outputs/x[1].json")).toBe(true);
    expect(m("outputs/x[1].json", "outputs/x1.json")).toBe(false);
    expect(m("outputs/a|b", "outputs/a|b")).toBe(true);
    expect(m("outputs/a|b", "outputs/a")).toBe(false);
  });

  it("matches the FULL path — no substring semantics", () => {
    expect(m("report.md", "outputs/report.md")).toBe(false);
    expect(m("outputs/report.md", "outputs/report.md")).toBe(true);
  });

  it("mid-segment `**` degrades to per-`*` [^/]* (documented non-special case)", () => {
    expect(m("a**b", "axxb")).toBe(true);
    expect(m("a**b", "ax/xb")).toBe(false);
  });

  it("`\\` in a glob or path is normalized to `/`", () => {
    expect(m("outputs\\**", "outputs/a.md")).toBe(true);
    expect(anyGlobMatches(["outputs/**"], "outputs\\a.md")).toBe(true);
  });
});

describe("anyGlobMatches", () => {
  it("empty allowlist matches nothing ([] = no new files allowed)", () => {
    expect(anyGlobMatches([], "outputs/a.md")).toBe(false);
  });
  it("any one match suffices", () => {
    expect(anyGlobMatches(["nope/**", "outputs/handoff/**"], "outputs/handoff/r1/x.json")).toBe(true);
    expect(anyGlobMatches(["nope/**", "also/no.md"], "outputs/stray.json")).toBe(false);
  });
});

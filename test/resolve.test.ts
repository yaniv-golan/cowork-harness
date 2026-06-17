import { describe, it, expect } from "vitest";
import { safePathSegment, noTraversal, safeMountSegment } from "../src/staging/resolve.js";

describe("staging/resolve — path-segment validators", () => {
  describe("safePathSegment", () => {
    it("accepts a plain segment", () => {
      expect(safePathSegment("proj1", "x")).toBe("proj1");
      expect(safePathSegment("report.pdf", "x")).toBe("report.pdf");
    });
    it("rejects empty, '.', '..', and separators", () => {
      for (const bad of ["", ".", "..", "a/b", "a\\b", "x\0y"]) {
        expect(() => safePathSegment(bad, "x")).toThrow(/unsafe x/);
      }
    });
  });

  describe("safeMountSegment", () => {
    it("accepts real Cowork marketplace metadata: scoped names, SemVer + build metadata, prerelease", () => {
      // synthetic fixtures — the repo's own marketplace.json is too thin to exercise these
      expect(safeMountSegment("@scope/pkg", "x")).toBe("@scope/pkg");
      expect(safeMountSegment("1.2.3+build.5", "x")).toBe("1.2.3+build.5");
      expect(safeMountSegment("2.0.0-rc.1", "x")).toBe("2.0.0-rc.1");
      expect(safeMountSegment("mymkt", "x")).toBe("mymkt");
    });
    it("rejects ':' (breaks the docker -v overlay), spaces, and control chars", () => {
      for (const bad of ["1.0:evil", "has space", "ctrlx", "tab\tx"]) {
        expect(() => safeMountSegment(bad, "marketplace name")).toThrow(/unsafe marketplace name/);
      }
    });
    it("rejects traversal / absolute even within the charset", () => {
      for (const bad of ["..", "a/../b", "/abs", ""]) {
        expect(() => safeMountSegment(bad, "x")).toThrow(/unsafe x/);
      }
    });
  });

  describe("noTraversal", () => {
    it("allows legitimate nesting but never '..'/'.'", () => {
      expect(noTraversal("@scope/pkg", "x")).toBe("@scope/pkg");
      expect(() => noTraversal("a/../b", "x")).toThrow(/unsafe x/);
      expect(() => noTraversal("/abs", "x")).toThrow(/unsafe x/);
    });
  });
});

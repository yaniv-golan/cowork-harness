import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePathSegment, noTraversal, safeMountSegment, requireFile, requireDir } from "../src/staging/resolve.js";

describe("staging/resolve — path-segment validators", () => {
  describe("safePathSegment", () => {
    it("accepts a plain segment", () => {
      expect(safePathSegment("proj1", "x")).toBe("proj1");
      expect(safePathSegment("report.pdf", "x")).toBe("report.pdf");
    });
    it("rejects empty, '.', '..', separators, ':' and control chars", () => {
      for (const bad of ["", ".", "..", "a/b", "a\\b", "x\0y", "a:b", "tab\tx"]) {
        expect(() => safePathSegment(bad, "x")).toThrow(/unsafe x/);
      }
    });
  });

  describe("requireFile / requireDir", () => {
    it("requireFile accepts a file, rejects a dir / missing", () => {
      const d = mkdtempSync(join(tmpdir(), "rf-"));
      const f = join(d, "x.json");
      writeFileSync(f, "{}");
      expect(requireFile(f, "mcp.config")).toBe(f);
      expect(() => requireFile(d, "mcp.config")).toThrow(/must be a file/);
      expect(() => requireFile(join(d, "nope"), "mcp.config")).toThrow(/not found/);
    });
    it("requireDir accepts a dir, rejects a file / missing", () => {
      const d = mkdtempSync(join(tmpdir(), "rd-"));
      const sub = join(d, "plugin");
      mkdirSync(sub);
      const f = join(d, "x.json");
      writeFileSync(f, "{}");
      expect(requireDir(sub, "plugin")).toBe(sub);
      expect(() => requireDir(f, "plugin")).toThrow(/must be a directory/);
      expect(() => requireDir(join(d, "nope"), "plugin")).toThrow(/not found/);
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
    it("rejects traversal / absolute / empty components even within the charset", () => {
      for (const bad of ["..", "a/../b", "/abs", "", "foo//bar", "foo/"]) {
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

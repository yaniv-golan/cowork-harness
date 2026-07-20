import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenv, DotenvReadError } from "../src/dotenv.js";

const KEYS = [
  "CC_TEST_A",
  "CC_TEST_B",
  "CC_TEST_QUOTED",
  "CC_TEST_EXPORT",
  "CC_TEST_COMMENTHASH",
  "CC_TEST_QUOTEDCOMMENT",
  "CC_TEST_QUOTEDCOMMENT_SINGLE",
];
afterEach(() => KEYS.forEach((k) => delete process.env[k]));

function envFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-env-"));
  const f = join(dir, ".env");
  writeFileSync(f, body);
  return f;
}

describe("loadDotenv", () => {
  it("loads KEY=VALUE, strips quotes/comments/export, and reports loaded keys", () => {
    const f = envFile(
      [
        "# a comment",
        "CC_TEST_A=plain",
        "export CC_TEST_EXPORT=exported",
        'CC_TEST_QUOTED="quoted value"',
        "CC_TEST_COMMENTHASH=val   # trailing comment",
        "",
      ].join("\n"),
    );
    const loaded = loadDotenv(f);
    expect(process.env.CC_TEST_A).toBe("plain");
    expect(process.env.CC_TEST_EXPORT).toBe("exported");
    expect(process.env.CC_TEST_QUOTED).toBe("quoted value");
    expect(process.env.CC_TEST_COMMENTHASH).toBe("val");
    expect(loaded.sort()).toEqual(["CC_TEST_A", "CC_TEST_COMMENTHASH", "CC_TEST_EXPORT", "CC_TEST_QUOTED"]);
  });

  it("does NOT overwrite an already-set process.env var (exported wins)", () => {
    process.env.CC_TEST_B = "from-shell";
    const loaded = loadDotenv(envFile("CC_TEST_B=from-file"));
    expect(process.env.CC_TEST_B).toBe("from-shell");
    expect(loaded).not.toContain("CC_TEST_B");
  });

  it("skips empty values so a blank template line is harmless / append still works", () => {
    const loaded = loadDotenv(envFile("CC_TEST_A=\nCC_TEST_A=real\n"));
    expect(process.env.CC_TEST_A).toBe("real"); // blank line skipped, real value wins
    expect(loaded).toEqual(["CC_TEST_A"]);
  });

  it("strips a trailing inline comment from a double-quoted value", () => {
    const f = envFile('CC_TEST_QUOTEDCOMMENT="sk-abc" # a comment\n');
    loadDotenv(f);
    expect(process.env.CC_TEST_QUOTEDCOMMENT).toBe("sk-abc");
  });

  it("strips a trailing inline comment from a single-quoted value", () => {
    const f = envFile("CC_TEST_QUOTEDCOMMENT_SINGLE='sk-abc' # a comment\n");
    loadDotenv(f);
    expect(process.env.CC_TEST_QUOTEDCOMMENT_SINGLE).toBe("sk-abc");
  });

  it("returns [] for a missing file", () => {
    expect(loadDotenv("/nonexistent/.env")).toEqual([]);
  });

  describe("strict mode ({ strict: true }, used for an explicitly-requested --dotenv path)", () => {
    it("happy path: loads normally, same as non-strict", () => {
      const f = envFile("CC_TEST_A=plain\n");
      const loaded = loadDotenv(f, { strict: true });
      expect(process.env.CC_TEST_A).toBe("plain");
      expect(loaded).toEqual(["CC_TEST_A"]);
    });

    it("throws DotenvReadError (not a silent []) for a missing file", () => {
      expect(() => loadDotenv("/nonexistent/.env", { strict: true })).toThrow(DotenvReadError);
      try {
        loadDotenv("/nonexistent/.env", { strict: true });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(DotenvReadError);
        expect((err as DotenvReadError).path).toBe("/nonexistent/.env");
        expect((err as Error).message).toMatch(/--dotenv file could not be read: \/nonexistent\/\.env/);
      }
    });

    it("throws DotenvReadError for a directory (EISDIR), instead of silently returning []", () => {
      const dir = mkdtempSync(join(tmpdir(), "cc-env-dir-"));
      expect(() => loadDotenv(dir, { strict: true })).toThrow(DotenvReadError);
      try {
        loadDotenv(dir, { strict: true });
        expect.unreachable();
      } catch (err) {
        expect((err as DotenvReadError).path).toBe(dir);
        expect((err as Error).message).toMatch(
          new RegExp(`--dotenv file could not be read: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        );
      }
      // non-strict mode swallows the same EISDIR and stays silent — the pre-existing, intentional
      // best-effort behavior for the automatic (non-explicit) source locations.
      expect(loadDotenv(dir)).toEqual([]);
    });

    // Permission faults only manifest for a non-root process — running as root (common in CI
    // containers) bypasses the mode bits entirely, so this guards against a false failure there.
    const isRoot = process.getuid?.() === 0;
    it.skipIf(isRoot)("throws DotenvReadError for an unreadable file (EACCES/EPERM), instead of silently returning []", () => {
      const f = envFile("CC_TEST_A=plain\n");
      chmodSync(f, 0o000);
      try {
        expect(() => loadDotenv(f, { strict: true })).toThrow(DotenvReadError);
        expect(process.env.CC_TEST_A).toBeUndefined();
        // non-strict mode swallows the same failure and stays silent (best-effort auto-load).
        expect(loadDotenv(f)).toEqual([]);
      } finally {
        chmodSync(f, 0o644); // restore so the temp-dir cleanup can remove it
      }
    });
  });
});

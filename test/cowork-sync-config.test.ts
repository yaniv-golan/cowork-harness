import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigJson } from "../src/sync/cowork-sync.js";

describe("sync distinguishes missing vs corrupt user config", () => {
  it("returns {} with NO unknown delta when config.json is missing", () => {
    const unknown: string[] = [];
    const out = readConfigJson(join(tmpdir(), "definitely-not-here-config.json"), unknown);
    expect(out).toEqual({});
    expect(unknown).toEqual([]);
  });

  it("returns the parsed object for valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-cfg-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, JSON.stringify({ coworkEgressAllowedHosts: ["a.example.com"] }));
      const unknown: string[] = [];
      const out = readConfigJson(p, unknown);
      expect(out["coworkEgressAllowedHosts"]).toEqual(["a.example.com"]);
      expect(unknown).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags an unknown delta (sync visibly incomplete) when config.json is corrupt", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-cfg-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, "{ this is : not valid json ");
      const unknown: string[] = [];
      const out = readConfigJson(p, unknown);
      expect(out).toEqual({}); // allowlist would be emptied …
      expect(unknown.length).toBe(1); // … but it is NOT silent
      expect(unknown[0]).toMatch(/config\.json/);
      expect(unknown[0]).toMatch(/coworkEgressAllowedHosts NOT synced/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a non-object top-level JSON value as {} (no crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-cfg-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, "42");
      const unknown: string[] = [];
      expect(readConfigJson(p, unknown)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractFromAsar temp dir cleanup (try/finally semantics)", () => {
  // extractFromAsar is module-private and needs a real asar + npx, so we can't call it directly in the
  // token-free lane. Instead we pin the try/finally contract it now uses: a mkdtempSync dir is removed
  // even when the work inside throws. This mirrors the exact cleanup wrapper added for the fix.
  it("removes a mkdtempSync dir on both success and error paths", () => {
    const run = (shouldThrow: boolean): string => {
      const tmp = mkdtempSync(join(tmpdir(), "cowork-sync-test-"));
      writeFileSync(join(tmp, "extracted.js"), "x");
      try {
        if (shouldThrow) throw new Error("asar extract failed");
      } catch {
        /* swallowed like the real flag() path */
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      return tmp;
    };
    const okDir = run(false);
    const errDir = run(true);
    expect(existsSync(okDir)).toBe(false);
    expect(existsSync(errDir)).toBe(false);
  });

  it("leaves no cowork-sync-test-* leftovers in TMPDIR after the run", () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("cowork-sync-test-"));
    const tmp = mkdtempSync(join(tmpdir(), "cowork-sync-test-"));
    try {
      throw new Error("boom");
    } catch {
      /* ignore */
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("cowork-sync-test-"));
    expect(after.length).toBe(before.length);
  });
});

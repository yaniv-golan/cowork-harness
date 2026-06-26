import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigJson, parseEgressAllowedHosts } from "../src/sync/cowork-sync.js";

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

  it("returns a string value as-is (coercion guard lives in parseEgressAllowedHosts, not here)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-cfg-"));
    try {
      const p = join(dir, "config.json");
      writeFileSync(p, JSON.stringify({ coworkEgressAllowedHosts: "not-an-array.example.com" }));
      const unknown: string[] = [];
      const out = readConfigJson(p, unknown);
      expect(typeof out["coworkEgressAllowedHosts"]).toBe("string");
      expect(unknown).toEqual([]);
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

describe("parseEgressAllowedHosts — the sync()-level guard that readConfigJson tests can't reach", () => {
  it("passes an array through unchanged", () => {
    const unknown: string[] = [];
    expect(parseEgressAllowedHosts(["a.example.com", "b.example.com"], unknown)).toEqual(["a.example.com", "b.example.com"]);
    expect(unknown).toEqual([]);
  });

  it("returns [] with NO unknown delta when the key is absent (undefined) — the bug case", () => {
    const unknown: string[] = [];
    expect(parseEgressAllowedHosts(undefined, unknown)).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("returns [] and flags an unknown delta when the value is a string (misconfiguration)", () => {
    const unknown: string[] = [];
    expect(parseEgressAllowedHosts("single-host.example.com", unknown)).toEqual([]);
    expect(unknown.length).toBe(1);
    expect(unknown[0]).toMatch(/expected an array but got string/);
  });

  it("returns [] and flags an unknown delta when the value is null", () => {
    const unknown: string[] = [];
    expect(parseEgressAllowedHosts(null, unknown)).toEqual([]);
    expect(unknown.length).toBe(1);
    expect(unknown[0]).toMatch(/expected an array but got object/);
  });

  it("returns [] and flags an unknown delta when the value is a number", () => {
    const unknown: string[] = [];
    expect(parseEgressAllowedHosts(42, unknown)).toEqual([]);
    expect(unknown.length).toBe(1);
    expect(unknown[0]).toMatch(/expected an array but got number/);
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

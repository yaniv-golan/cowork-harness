import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigJson, parseEgressAllowedHosts, readMainBundle } from "../src/sync/cowork-sync.js";

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
  //
  // Hermeticity: all dirs are created inside a private per-test scratch root, never counted against
  // the shared OS tmpdir. The machine-wide tmpdir is shared with concurrent vitest invocations (other
  // worktrees / sessions), so any assertion about a global "cowork-sync-test-*" count is racy.
  // The scratch root's own prefix deliberately does NOT start with "cowork-sync-test-" so it can
  // never perturb another invocation still counting that prefix globally.
  it("removes a mkdtempSync dir on both success and error paths", () => {
    const root = mkdtempSync(join(tmpdir(), "cowork-sync-hermetic-"));
    try {
      const run = (shouldThrow: boolean): string => {
        const tmp = mkdtempSync(join(root, "cowork-sync-test-"));
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves no cowork-sync-test-* leftovers in its scratch root after the error path", () => {
    const root = mkdtempSync(join(tmpdir(), "cowork-sync-hermetic-"));
    try {
      // The root is freshly minted and private, so it must start empty — fail loud if not.
      expect(readdirSync(root)).toEqual([]);
      const tmp = mkdtempSync(join(root, "cowork-sync-test-"));
      try {
        throw new Error("boom");
      } catch {
        /* ignore */
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      const after = readdirSync(root).filter((n) => n.startsWith("cowork-sync-test-"));
      expect(after).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readMainBundle follows Vite's code-split index.js into its chunk file(s)", () => {
  function makeAsarDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "read-main-bundle-"));
    mkdirSync(join(dir, ".vite/build"), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, ".vite/build", rel), content);
    }
    return dir;
  }

  it("returns the entry content as-is for a monolithic index.js with no local requires", () => {
    const dir = makeAsarDir({ "index.js": 'require("electron");const MARKER_MONOLITHIC=1;' });
    try {
      expect(readMainBundle(dir)).toContain("MARKER_MONOLITHIC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows a local require() reference into its chunk file and includes both contents", () => {
    const dir = makeAsarDir({
      "index.js": 'require("node:fs");require("./index.chunk-ABC123.js");require("electron");',
      "index.chunk-ABC123.js": 'const MARKER_CHUNK="found-me";',
    });
    try {
      const bundle = readMainBundle(dir);
      expect(bundle).toContain("index.chunk-ABC123.js"); // entry content preserved
      expect(bundle).toContain("found-me"); // chunk content pulled in
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw and ignores non-relative requires (electron, node:*, bare packages)", () => {
    const dir = makeAsarDir({ "index.js": 'require("electron");require("node:fs");require("some-package");' });
    try {
      expect(() => readMainBundle(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminates and does not duplicate content when chunks require each other circularly", () => {
    const dir = makeAsarDir({
      "index.js": 'require("./a.js");',
      "a.js": 'require("./b.js");const MARKER_A=1;',
      "b.js": 'require("./a.js");const MARKER_B=1;',
    });
    try {
      const bundle = readMainBundle(dir);
      expect(bundle.match(/MARKER_A/g)?.length).toBe(1);
      expect(bundle.match(/MARKER_B/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

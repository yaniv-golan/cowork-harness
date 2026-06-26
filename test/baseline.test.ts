import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { compareBaselineVersions, loadBaseline, resolveAgentBinary, resolveMounts } from "../src/baseline.js";
import type { PlatformBaseline } from "../src/types.js";
import { decodeFcacheGates, sync, checkMountModeFacts, checkWebFetchFacts } from "../src/sync/cowork-sync.js";

describe("#40 — compareBaselineVersions (semver-aware baseline sort)", () => {
  it("picks desktop-1.10.json over desktop-1.9.json (lexical sort would fail)", () => {
    const files = ["desktop-1.9.json", "desktop-1.10.json", "desktop-1.2.json"];
    files.sort(compareBaselineVersions);
    expect(files[files.length - 1]).toBe("desktop-1.10.json");
  });

  it("correctly orders a realistic set of baselines", () => {
    const files = ["desktop-1.11847.5.json", "desktop-1.9.1.json", "desktop-1.12603.1.json", "desktop-1.11000.0.json"];
    files.sort(compareBaselineVersions);
    expect(files).toEqual(["desktop-1.9.1.json", "desktop-1.11000.0.json", "desktop-1.11847.5.json", "desktop-1.12603.1.json"]);
  });

  it("returns 0 for identical versions", () => {
    expect(compareBaselineVersions("desktop-1.2.3.json", "desktop-1.2.3.json")).toBe(0);
  });

  it("handles versions with different segment counts", () => {
    // 1.10 vs 1.10.0 — treat missing segment as 0
    expect(compareBaselineVersions("desktop-1.10.json", "desktop-1.10.0.json")).toBe(0);
    // 1.9 < 1.9.1
    expect(compareBaselineVersions("desktop-1.9.json", "desktop-1.9.1.json")).toBeLessThan(0);
  });

  it("a simple two-version case: 1.9 < 1.10", () => {
    expect(compareBaselineVersions("desktop-1.9.json", "desktop-1.10.json")).toBeLessThan(0);
    expect(compareBaselineVersions("desktop-1.10.json", "desktop-1.9.json")).toBeGreaterThan(0);
  });

  it("stays a total order on a non-numeric segment (NaN-safe, no sort corruption)", () => {
    expect(Number.isFinite(compareBaselineVersions("desktop-1.0.0-beta.json", "desktop-1.0.0.json"))).toBe(true);
    expect(Number.isFinite(compareBaselineVersions("desktop-1.0.0.json", "desktop-1.0.0-beta.json"))).toBe(true);
  });
});

describe("loadBaseline — name resolution", () => {
  it("resolves a bare .json filename under baselines/ (same as the no-suffix form), regardless of cwd", () => {
    expect(loadBaseline("desktop-1.12603.1.json")).toEqual(loadBaseline("desktop-1.12603.1"));
  });

  // a named (non-absolute) baseline must stay inside baselines/. Path separators escape the
  // directory; a `../foo.json` is the subtle half (the `.json` branch skips the suffix-append and would
  // read an arbitrary out-of-tree `.json`). Absolute paths remain the explicit escape hatch.
  it("rejects a named baseline with `../` traversal", () => {
    expect(() => loadBaseline("../../../etc/hosts")).toThrow(/must be a bare filename/);
  });

  it("rejects a named baseline with a nested path segment", () => {
    expect(() => loadBaseline("sub/desktop-1.12603.1")).toThrow(/must be a bare filename/);
  });

  it("rejects a `.json` name with `../` (the suffix-append branch must not be an escape)", () => {
    expect(() => loadBaseline("../foo.json")).toThrow(/must be a bare filename/);
  });

  it("still allows an ABSOLUTE custom baseline path (explicit out-of-tree escape hatch)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-baseline-abs-"));
    const file = join(dir, "custom.json");
    const ref = loadBaseline("desktop-1.12603.1");
    writeFileSync(file, JSON.stringify(ref));
    expect(loadBaseline(file)).toEqual(ref); // absolute path loads despite being out of tree
  });
});

describe("#39 — decodeFcacheGates (GrowthBook fcache decode, binary-verified format)", () => {
  // Reproduce the verified container format: "CLF" + version byte + 4-byte field, then a gzip stream.
  const makeFcache = (features: Record<string, unknown>): string => {
    const gz = gzipSync(Buffer.from(JSON.stringify({ timestamp: 1, features }), "utf8"));
    const header = Buffer.from([0x43, 0x4c, 0x46, 0x01, 0, 0, 0, 0]); // "CLF" + ver + 4-byte length/checksum
    const dir = mkdtempSync(join(tmpdir(), "cowork-fcache-"));
    const f = join(dir, "fcache");
    writeFileSync(f, Buffer.concat([header, gz]));
    return f;
  };

  it("decodes pinned gate states (on/off + source + value) from the gzipped CLF container", () => {
    const f = makeFcache({
      "1143815894": { value: true, on: true, off: false, source: "force" },
      "1648655587": { value: { perTask: 1, global: 3 }, on: true, off: false, source: "force" },
      "2307090146": { value: false, on: false, off: true, source: "defaultValue" },
      "999999999": { value: true, on: true, off: false, source: "force" }, // not pinned → ignored
    });
    const gates = decodeFcacheGates(f)!;
    expect(gates["1143815894"]).toMatchObject({ name: "hostLoop", on: true, source: "force", value: true });
    expect(gates["1648655587"]).toMatchObject({ name: "taskDispatchLimiter", on: true, value: { perTask: 1, global: 3 } });
    expect(gates["2307090146"]).toMatchObject({ name: "cliPlugin", on: false, source: "defaultValue" });
    expect(gates["999999999"]).toBeUndefined(); // only pinned gates are returned
  });

  it("returns null for a missing file or a bad magic header (caller flags it, no silent garbage)", () => {
    expect(decodeFcacheGates(join(tmpdir(), "does-not-exist-fcache"))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "cowork-fcache-bad-"));
    const bad = join(dir, "fcache");
    writeFileSync(bad, Buffer.from("NOTCLF and not gzip"));
    expect(decodeFcacheGates(bad)).toBeNull();
  });

  // bug 71 precondition: a valid CLF fcache whose features contain ONLY non-pinned IDs returns {}
  // (empty object), NOT null. This is the load-bearing precondition for the sync() else-if guard —
  // {} is truthy so the !gates branch was silently bypassed, leaving a total GrowthBook re-key invisible.
  it("returns {} (not null) when the fcache decodes but contains only non-pinned gate IDs", () => {
    const f = makeFcache({
      "999999999": { value: true, on: true, off: false, source: "force" }, // not in PINNED_GATES
    });
    const result = decodeFcacheGates(f);
    expect(result).not.toBeNull();
    expect(result).toEqual({});
  });
});

describe("#42 — cowork-sync platform guard", () => {
  it("throws a clear macOS-only error on a non-macOS platform (no silent empty baseline)", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(() => sync()).toThrow(/macOS-only/);
    } finally {
      Object.defineProperty(process, "platform", { value: orig, configurable: true });
    }
  });
});

describe("#9-A — checkMountModeFacts (mount-mode drift guard for the hand-authored baseline)", () => {
  // a synthetic bundle carrying both binary-verified mode facts (the IX delete-deny resolver + uploads ro)
  const ok = 'function IX(A,e,t){return t?"rw":e!=null&&e.includes(A)?"rwd":"rw"} … l[Es("uploads")]={path:wa(i),mode:"ro"}';
  it("returns no flags when both mode facts are present", () => {
    expect(checkMountModeFacts(ok)).toEqual([]);
  });
  it("flags when the IX delete-deny resolver is gone (outputs/projects default may have changed)", () => {
    const drifted = ok.replace('?"rwd":"rw"', '?"rwd":"rwd"'); // delete now allowed by default
    const flags = checkMountModeFacts(drifted);
    expect(flags.some((f) => f.includes("delete-deny resolver"))).toBe(true);
  });
  it("flags when uploads is no longer read-only", () => {
    const drifted = ok.replace('mode:"ro"', 'mode:"rw"');
    const flags = checkMountModeFacts(drifted);
    expect(flags.some((f) => f.includes("uploads read-only"))).toBe(true);
  });
});

describe("checkWebFetchFacts (drift guard for the two-path web_fetch model)", () => {
  const ok =
    "buildRequestWebFetchApproval(e){const t=Qn('1978029737','coworkWebFetchViaApi') ... coworkWebFetchPrompt ... getWebFetchAllowedUrls()";
  it("returns no flags when the web_fetch primitives are present", () => {
    expect(checkWebFetchFacts(ok)).toEqual([]);
  });
  it("flags when the approval builder is gone", () => {
    expect(checkWebFetchFacts(ok.replace("buildRequestWebFetchApproval", "somethingElse")).some((f) => f.includes("approval"))).toBe(true);
  });
  it("flags when the provenance URL set is gone", () => {
    expect(checkWebFetchFacts(ok.replace("getWebFetchAllowedUrls", "gone")).some((f) => f.includes("provenance URL set"))).toBe(true);
  });
});

describe("resolveAgentBinary newest-sibling fallback", () => {
  // Build a baseline whose only relevant field is agentBinary.stagedPath.
  const baselineWith = (stagedPath: string) => ({ agentBinary: { stagedPath } }) as unknown as PlatformBaseline;

  // Stage claude-code-vm/<ver>/claude binaries under a temp root; point the baseline at a missing version.
  const stageVm = (versions: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "cowork-vm-"));
    const vmRoot = join(root, "claude-code-vm");
    for (const v of versions) {
      mkdirSync(join(vmRoot, v), { recursive: true });
      writeFileSync(join(vmRoot, v, "claude"), "#!/bin/sh\n");
    }
    return vmRoot;
  };

  afterEach(() => {
    delete process.env.COWORK_AGENT_BINARY;
    delete process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK;
    vi.restoreAllMocks();
  });

  it("throws when the exact staged version dir is missing (default: no fallback)", () => {
    const vmRoot = stageVm(["2.1.170", "2.1.177"]);
    const baseline = baselineWith(join(vmRoot, "2.1.999", "claude")); // non-existent version dir

    expect(() => resolveAgentBinary(baseline)).toThrow("COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1");
  });

  it("falls back to the newest sibling binary when COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1", () => {
    process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const vmRoot = stageVm(["2.1.170", "2.1.177"]);
    const baseline = baselineWith(join(vmRoot, "2.1.999", "claude")); // non-existent version dir

    const resolved = resolveAgentBinary(baseline);

    expect(resolved).toBe(join(vmRoot, "2.1.177", "claude"));
    expect(stderr).toHaveBeenCalled();
  });

  it("COWORK_AGENT_BINARY override keeps top precedence over both exact path and fallback", () => {
    const vmRoot = stageVm(["2.1.170", "2.1.177"]);
    const override = join(vmRoot, "2.1.170", "claude"); // an existing, distinct binary
    process.env.COWORK_AGENT_BINARY = override;
    const baseline = baselineWith(join(vmRoot, "2.1.999", "claude"));

    expect(resolveAgentBinary(baseline)).toBe(override);
  });

  it("throws the original error when no sibling binary exists", () => {
    const vmRoot = stageVm([]); // claude-code-vm exists but is empty
    const baseline = baselineWith(join(vmRoot, "2.1.999", "claude"));

    expect(() => resolveAgentBinary(baseline)).toThrow(/Staged agent binary not found/);
  });
});

describe("resolveMounts — mntRoot derivation (bug 65)", () => {
  const mountLayoutWith = (sessionRoot: string, mntRoot?: string) =>
    ({
      mountLayout: { sessionRoot, cwd: sessionRoot, mntRoot, mounts: [] },
    }) as unknown as PlatformBaseline;

  it("legacy baseline: sessionRoot ending in /mnt + no mntRoot → mntRoot === sessionRoot (no extra /mnt)", () => {
    const b = mountLayoutWith("/sessions/abc/mnt");
    const r = resolveMounts(b, "abc");
    expect(r.mntRoot).toBe("/sessions/abc/mnt");
    expect(r.configDir).toBe("/sessions/abc/mnt/.claude");
  });

  it("explicit mntRoot is used verbatim (unaffected baseline)", () => {
    const b = mountLayoutWith("/sessions/abc", "/sessions/abc/mnt");
    const r = resolveMounts(b, "abc");
    expect(r.mntRoot).toBe("/sessions/abc/mnt");
  });

  it("sessionRoot not ending in /mnt + no mntRoot → sessionRoot + /mnt", () => {
    const b = mountLayoutWith("/sessions/abc");
    const r = resolveMounts(b, "abc");
    expect(r.mntRoot).toBe("/sessions/abc/mnt");
  });
});

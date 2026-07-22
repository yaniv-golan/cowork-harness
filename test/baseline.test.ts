import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
  compareBaselineVersions,
  loadBaseline,
  resolveAgentBinary,
  resolveHostAgentBinary,
  classifyNativeStagingDrift,
  resolveMounts,
  sha256File,
  countStringInFile,
} from "../src/baseline.js";
import { createHash } from "node:crypto";
import type { PlatformBaseline } from "../src/types.js";
import { PlatformBaseline as PlatformBaselineSchema } from "../src/types.js";
import {
  decodeFcacheGates,
  sync,
  checkMountModeFacts,
  checkWebFetchFacts,
  readMainBundle,
  checkSubagentOverrideGate,
  checkCodeTripwires,
  PINNED_GATES,
} from "../src/sync/cowork-sync.js";
import {
  deriveSpawnEnv,
  checkSpawnContractFacts,
  canonicalizeEnv,
  partitionSpawnFlags,
  resolveConst,
  extractModelEffortConfig,
  extractPromptFingerprint,
  checkPromptDrift,
  REQUIRED_SPAWN_KEYS,
  type GateState,
  type PromptFingerprint,
} from "../src/sync/cowork-sync.js";
import { extractSubagentBranchSlices, subagentBranchFingerprint, checkSubagentPromptFacts } from "../src/sync/cowork-sync.js";
import { checkPathHookFacts } from "../src/sync/cowork-sync.js";
import { MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS } from "../src/prompt.js";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

describe("compareBaselineVersions (semver-aware baseline sort)", () => {
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

describe("decodeFcacheGates (GrowthBook fcache decode, binary-verified format)", () => {
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
    expect(gates["1648655587"]).toMatchObject({ name: "scheduledTaskSessionLimiter", on: true, value: { perTask: 1, global: 3 } });
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

  // precondition: a valid CLF fcache whose features contain ONLY non-pinned IDs returns an object
  // containing ONLY the DARK_GATES absent-marker(s), NOT null and NOT truly empty. This is the
  // load-bearing precondition for the sync() else-if guard: the guard must count only
  // source!=="absent" entries, or the always-present dark-gate marker would mask a total
  // GrowthBook re-key (every pinned id missing) as if something had matched.
  it("returns only the DARK_GATES absent-markers (source:'absent') when the fcache decodes but contains only non-pinned gate IDs", () => {
    const f = makeFcache({
      "999999999": { value: true, on: true, off: false, source: "force" }, // not in PINNED_GATES
    });
    const result = decodeFcacheGates(f);
    expect(result).not.toBeNull();
    expect(result).toEqual({
      "2614807392": { id: "2614807392", name: "skeletonHome", on: false, source: "absent", value: undefined },
      "1129419822": { id: "1129419822", name: "enableToolSearchAuto", on: false, source: "absent", value: undefined },
      "4200321681": { id: "4200321681", name: "autoModeOverridesAlwaysAllow", on: false, source: "absent", value: undefined },
      "1447478638": { id: "1447478638", name: "scheduledTaskToolsApprovableByAutoMode", on: false, source: "absent", value: undefined },
    });
  });

  it("the re-key guard still fires when only the absent-source dark-gate marker is present (no other pinned id matched)", () => {
    const f = makeFcache({
      "999999999": { value: true, on: true, off: false, source: "force" }, // not in PINNED_GATES
    });
    const gates = decodeFcacheGates(f)!;
    // Mirrors the sync() else-if guard: count only gates whose source !== "absent".
    const liveMatches = Object.values(gates).filter((g) => g.source !== "absent");
    expect(liveMatches).toEqual([]);
  });

  it("decodes a normal (non-absent) entry when the dark gate 2614807392 IS present in the fcache", () => {
    const f = makeFcache({
      "2614807392": { value: true, on: true, off: false, source: "force" },
    });
    const gates = decodeFcacheGates(f)!;
    expect(gates["2614807392"]).toEqual({
      id: "2614807392",
      name: "skeletonHome",
      on: true,
      source: "force",
      value: true,
    });
  });

  it("PINNED_GATES tracks the two Desktop 1.22209.0 auto-mode gates", () => {
    expect(PINNED_GATES["4200321681"]).toBe("autoModeOverridesAlwaysAllow");
    expect(PINNED_GATES["1447478638"]).toBe("scheduledTaskToolsApprovableByAutoMode");
  });

  it("PINNED_GATES tracks the three skill-discovery gates (present in fcache, so NOT dark)", () => {
    // The gates that govern whether the Desktop SDK-MCP skill/plugin discovery tools render.
    // 245679952 is live on/force; a flip of any of these changes the model's tool surface, and
    // none was pinned before — so a live change was invisible to the drift guard.
    expect(PINNED_GATES["245679952"]).toBe("suggestSkillsEnabled");
    expect(PINNED_GATES["1598976391"]).toBe("proactiveSkillSuggestEnabled");
    expect(PINNED_GATES["3246569822"]).toBe("canSaveSkill");
  });
});

describe("countStringInFile — literal occurrence counter for binary string sentinels", () => {
  const tmp = join(tmpdir(), `cwh-count-${process.pid}.bin`);
  afterEach(() => {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  });

  it("counts non-overlapping literal occurrences", () => {
    writeFileSync(tmp, "x tengu_saddle_lantern y tengu_saddle_lantern z");
    expect(countStringInFile(tmp, "tengu_saddle_lantern")).toBe(2);
  });

  it("returns 0 when the needle is absent", () => {
    writeFileSync(tmp, "nothing to see here");
    expect(countStringInFile(tmp, "tengu_saddle_lantern")).toBe(0);
  });

  it("counts a match that would straddle a naive chunk boundary (single read, whole file)", () => {
    // a large filler so the needle sits well past any small buffer, proving we scan the full file
    writeFileSync(tmp, "A".repeat(200_000) + "tengu_saddle_lantern" + "B".repeat(200_000));
    expect(countStringInFile(tmp, "tengu_saddle_lantern")).toBe(1);
  });

  it("agentBinary.stringSentinels ROUND-TRIPS through the schema (not stripped by the z.object)", () => {
    // The inner agentBinary is a z.object (strips unknown keys), so stringSentinels must be a declared
    // field or it would silently vanish on load — the exact trap this locks against. Spread a real full
    // baseline (so all required fields are satisfied) and prove an arbitrary sentinel map survives parse.
    const base = loadBaseline("desktop-1.24012.1") as unknown as Record<string, unknown>;
    const reparsed = PlatformBaselineSchema.parse({
      ...base,
      agentBinary: { ...(base.agentBinary as object), stringSentinels: { some_marker: 7 } },
    });
    expect(reparsed.agentBinary?.stringSentinels).toEqual({ some_marker: 7 });
  });
});

describe("checkCodeTripwires — string-shape sentinels the sync can't see via gates/env", () => {
  // Healthy state on 1.24012.0/.1: getMcpSkillSources appears once AS ITS DEFINITION (`(){`), zero
  // callers; io.modelcontextprotocol/skills once (capability declaration). Dead scaffolding — finding 2.
  const clean = "getMcpSkillSources(){return[...x]} caps.extensions['io.modelcontextprotocol/skills'];";

  it("is clean when getMcpSkillSources is definition-only (1x, the `(){` def) and the skills cap is 1x", () => {
    expect(checkCodeTripwires(clean)).toEqual([]);
  });

  it("HARD-FAILS (non-NOTE delta) when a getMcpSkillSources CALLER appears (count > 1)", () => {
    const wired = clean + " const s = getMcpSkillSources();";
    const flags = checkCodeTripwires(wired);
    expect(flags.length).toBe(1);
    expect(flags[0]).not.toMatch(/^NOTE:/); // a delta → hard-fail
    expect(flags[0]).toMatch(/getMcpSkillSources/);
    expect(flags[0]).toMatch(/caller/i);
  });

  it("emits a NOTE when count is 1 but it is NOT the definition (def moved out of graph, caller remains)", () => {
    // D3(a): keying purely on total count would read this as "definition-only, clean" — but it is a
    // caller with the definition gone from the scanned graph. The def-presence check catches it.
    const callerNoDef = "const s = getMcpSkillSources(); caps.extensions['io.modelcontextprotocol/skills'];";
    const flags = checkCodeTripwires(callerNoDef);
    expect(flags.length).toBe(1);
    expect(flags[0]).toMatch(/^NOTE:/);
    expect(flags[0]).toMatch(/definition/i);
    expect(flags[0]).toMatch(/graph|chunk/i);
  });

  it("emits a NOTE (non-blocking) when getMcpSkillSources is gone — flagging the graph-visibility caveat", () => {
    // D3(b): must NOT flatly say "removed; prune" — it may have merely moved out of the require() graph.
    const gone = "caps.extensions['io.modelcontextprotocol/skills'];";
    const flags = checkCodeTripwires(gone);
    expect(flags.length).toBe(1);
    expect(flags[0]).toMatch(/^NOTE:/);
    expect(flags[0]).toMatch(/getMcpSkillSources/);
    expect(flags[0]).toMatch(/graph|chunk/i); // caveats that it may have moved, not just been removed
  });

  it("emits a NOTE when the io.modelcontextprotocol/skills capability count changes from 1", () => {
    const grew = "getMcpSkillSources(){return[]} a['io.modelcontextprotocol/skills']; b['io.modelcontextprotocol/skills'];";
    const flags = checkCodeTripwires(grew);
    expect(flags.length).toBe(1);
    expect(flags[0]).toMatch(/^NOTE:/);
    expect(flags[0]).toMatch(/io\.modelcontextprotocol\/skills/);
  });
});

describe("cowork-sync platform guard", () => {
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

describe("checkMountModeFacts (mount-mode drift guard for the hand-authored baseline)", () => {
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

// A mid-session Claude Desktop auto-update prunes the pinned NATIVE binary version and stages a newer
// one. The native resolver has NO sha256 pin (unlike the ELF), so a same-major.minor PATCH bump is
// safe to auto-tolerate; a major/minor drift keeps the existing env-gated-fallback-or-throw behavior.
describe("resolveHostAgentBinary / classifyNativeStagingDrift — native staging-drift tolerance", () => {
  const NATIVE_LEAF = "claude.app/Contents/MacOS/claude";
  const nativeBaselineWith = (nativeStagedPath: string) => ({ agentBinary: { nativeStagedPath } }) as unknown as PlatformBaseline;

  // Stage claude-code/<ver>/claude.app/Contents/MacOS/claude binaries under a temp root.
  const stageNative = (versions: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "cowork-native-"));
    const nativeRoot = join(root, "claude-code");
    for (const v of versions) {
      const leafDir = join(nativeRoot, v, "claude.app", "Contents", "MacOS");
      mkdirSync(leafDir, { recursive: true });
      writeFileSync(join(leafDir, "claude"), "#!/bin/sh\n");
    }
    return nativeRoot;
  };
  const nativePath = (nativeRoot: string, v: string) => join(nativeRoot, v, NATIVE_LEAF);

  afterEach(() => {
    delete process.env.COWORK_HOST_AGENT_BINARY;
    delete process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK;
    vi.restoreAllMocks();
  });

  it("exact pinned path present → returns it, no note, kind 'exact'", () => {
    const nativeRoot = stageNative(["2.1.205"]);
    const staged = nativePath(nativeRoot, "2.1.205");
    const baseline = nativeBaselineWith(staged);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(resolveHostAgentBinary(baseline)).toBe(staged);
    expect(stderr).not.toHaveBeenCalled();
    expect(classifyNativeStagingDrift(baseline)).toMatchObject({ kind: "exact", pinned: "2.1.205", found: "2.1.205" });
  });

  it("pinned pruned, only a PATCH-newer sibling present → auto-tolerated: returns the sibling + a stderr note, NO env var needed", () => {
    const nativeRoot = stageNative(["2.1.208"]); // pin 2.1.205 is gone; only a patch-newer sibling remains
    const pinnedPath = nativePath(nativeRoot, "2.1.205");
    const baseline = nativeBaselineWith(pinnedPath);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const drift = classifyNativeStagingDrift(baseline);
    expect(drift).toMatchObject({ kind: "patch", pinned: "2.1.205", found: "2.1.208" });

    const resolved = resolveHostAgentBinary(baseline);
    expect(resolved).toBe(nativePath(nativeRoot, "2.1.208"));
    expect(stderr).toHaveBeenCalled();
    const note = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(note).toMatch(/2\.1\.205/);
    expect(note).toMatch(/2\.1\.208/);
    expect(note).not.toMatch(/COWORK_HARNESS_ALLOW_AGENT_FALLBACK/); // no env-var mention — it's not required here
  });

  it("pinned pruned, only a MINOR/MAJOR-different sibling → hard throws without the env var; falls back WITH it", () => {
    const nativeRoot = stageNative(["2.2.0"]); // pin 2.1.205 is gone; sibling differs in minor
    const pinnedPath = nativePath(nativeRoot, "2.1.205");
    const baseline = nativeBaselineWith(pinnedPath);

    expect(classifyNativeStagingDrift(baseline)).toMatchObject({ kind: "major-minor", pinned: "2.1.205", found: "2.2.0" });
    expect(() => resolveHostAgentBinary(baseline)).toThrow("COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1");

    process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(baseline)).toBe(nativePath(nativeRoot, "2.2.0"));
    expect(stderr).toHaveBeenCalled();
  });

  it("no sibling at all → kind 'missing', hard throws with the stage-it remedy", () => {
    const nativeRoot = stageNative([]); // claude-code exists but is empty
    const baseline = nativeBaselineWith(nativePath(nativeRoot, "2.1.205"));

    expect(classifyNativeStagingDrift(baseline)).toMatchObject({ kind: "missing" });
    expect(() => resolveHostAgentBinary(baseline)).toThrow(/Staged NATIVE agent binary not found/);
  });

  it("COWORK_HOST_AGENT_BINARY override keeps top precedence over both the exact path and any drift tolerance", () => {
    const nativeRoot = stageNative(["2.1.205", "2.1.208"]);
    const override = nativePath(nativeRoot, "2.1.205");
    process.env.COWORK_HOST_AGENT_BINARY = override;
    const baseline = nativeBaselineWith(nativePath(nativeRoot, "2.1.999")); // pinned path irrelevant when overridden

    expect(resolveHostAgentBinary(baseline)).toBe(resolve(override));
  });

  // Regression guard: patch tolerance is a NATIVE-only carve-out. The sha256-pinned ELF resolver
  // (resolveAgentBinary) must keep its existing strict behavior — a patch-only sibling must NOT be
  // silently accepted without the opt-in env var, or the sha hard-fail would be quietly weakened.
  it("ELF resolver regression guard: resolveAgentBinary still hard-throws on a patch-only sibling with NO env var", () => {
    const root = mkdtempSync(join(tmpdir(), "cowork-vm-patch-"));
    const vmRoot = join(root, "claude-code-vm");
    for (const v of ["2.1.208"]) {
      mkdirSync(join(vmRoot, v), { recursive: true });
      writeFileSync(join(vmRoot, v, "claude"), "#!/bin/sh\n");
    }
    const elfBaseline = { agentBinary: { stagedPath: join(vmRoot, "2.1.205", "claude") } } as unknown as PlatformBaseline;

    expect(() => resolveAgentBinary(elfBaseline)).toThrow("COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1");
  });
});

// `{ parityMount: true }` is the opt-in used ONLY by the hostloop VM-ELF bind-mount (never executed by a
// harness-spawned process there — reachable only by model-initiated bash inside the hardened sidecar). It
// mirrors the native binary's patch-only auto-tolerance, but must NEVER weaken the sha256 hard-fail on an
// EXISTING pinned path (S3 below) — that hard-fail protects the one case the ELF resolver still guards
// strictly. The default (no opts) path is unchanged and covered by the regression guard above.
describe("resolveAgentBinary({ parityMount: true }) — VM ELF non-executed parity-mount tolerance", () => {
  const baselineWith = (stagedPath: string) => ({ agentBinary: { stagedPath } }) as unknown as PlatformBaseline;

  const stageVm = (versions: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "cowork-vm-parity-"));
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

  it("parityMount: auto-accepts a PATCH-only sibling with no env var — loud note, no ALLOW_AGENT_FALLBACK mention", () => {
    const vmRoot = stageVm(["2.1.209"]); // pin 2.1.205 is gone; only a patch-newer sibling remains
    const baseline = baselineWith(join(vmRoot, "2.1.205", "claude"));
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      writes.push(String(s));
      return true;
    });
    try {
      const p = resolveAgentBinary(baseline, { parityMount: true });
      expect(p).toBe(resolve(join(vmRoot, "2.1.209", "claude")));
    } finally {
      spy.mockRestore();
    }
    const note = writes.join("");
    expect(note).toMatch(/2\.1\.209/);
    expect(note).toMatch(/parity mount/i);
    expect(note).not.toMatch(/COWORK_HARNESS_ALLOW_AGENT_FALLBACK/); // auto-tolerated, not env-gated
  });

  it("parityMount: STILL throws on a MAJOR/MINOR sibling (tolerance is patch-only)", () => {
    const vmRoot = stageVm(["2.2.0"]); // minor bump
    const baseline = baselineWith(join(vmRoot, "2.1.205", "claude"));
    expect(() => resolveAgentBinary(baseline, { parityMount: true })).toThrow(/COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1/);
  });

  it("parityMount: STILL throws when NO sibling ELF exists at all", () => {
    const vmRoot = stageVm([]); // empty
    const baseline = baselineWith(join(vmRoot, "2.1.205", "claude"));
    expect(() => resolveAgentBinary(baseline, { parityMount: true })).toThrow(/Staged agent binary not found/);
  });

  // S3 — the security invariant that matters most: parityMount must NEVER reach the pruned-pin fallback
  // branch when the EXACT pinned path exists. verifiedElf(staged, baseline) (no intentionalSubstitution)
  // runs BEFORE the parityMount branch is even reachable, so a measured-local sha mismatch on the pinned
  // path itself hard-throws regardless of opts. Mirrors the "HARD-FAILS by default on a measured-local
  // mismatch" fixture above (stageBinary + stagedBaseline shape) verbatim, just adding parityMount: true.
  it("parityMount does NOT weaken the exact-pin sha hard-fail (measured-local mismatch still throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-elf-parity-sha-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    const baseline = {
      agentBinary: { stagedPath: bin, sha256: "deadbeef", shaProvenance: "measured-local" },
    } as unknown as PlatformBaseline;
    expect(() => resolveAgentBinary(baseline, { parityMount: true })).toThrow(/sha256 mismatch/);
  });

  it("parityMount respects COWORK_AGENT_BINARY override precedence", () => {
    const vmRoot = stageVm(["2.1.170", "2.1.177"]);
    const override = join(vmRoot, "2.1.170", "claude"); // an existing, distinct binary
    process.env.COWORK_AGENT_BINARY = override;
    const baseline = baselineWith(join(vmRoot, "2.1.999", "claude")); // pinned path irrelevant when overridden
    expect(resolveAgentBinary(baseline, { parityMount: true })).toBe(override);
  });
});

describe("sha256File", () => {
  it("returns the hex SHA-256 of the file's bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-sha-"));
    const f = join(dir, "blob");
    writeFileSync(f, "hello world\n");
    const expected = createHash("sha256").update("hello world\n").digest("hex");
    expect(sha256File(f)).toBe(expected);
  });
});

describe("resolveAgentBinary — COWORK_HARNESS_VERIFY_AGENT_SHA integrity check (ELF, default-ON)", () => {
  const stageBinary = (content = "#!/bin/sh\n") => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-elf-"));
    const f = join(dir, "claude");
    writeFileSync(f, content);
    return f;
  };
  // A baseline whose OWN stagedPath is `bin` (the primary path — hard-fail applies here).
  const stagedBaseline = (bin: string, sha256?: string, shaProvenance?: string) =>
    ({ agentBinary: { stagedPath: bin, sha256, shaProvenance } }) as unknown as PlatformBaseline;

  afterEach(() => {
    delete process.env.COWORK_AGENT_BINARY;
    delete process.env.COWORK_HARNESS_VERIFY_AGENT_SHA;
    vi.restoreAllMocks();
  });

  it("verifies by default (no env) and passes silently when the staged hash matches", () => {
    const bin = stageBinary();
    expect(resolveAgentBinary(stagedBaseline(bin, sha256File(bin), "measured-local"))).toBe(bin);
  });

  it("HARD-FAILS by default on a measured-local mismatch at the primary staged path", () => {
    const bin = stageBinary();
    expect(() => resolveAgentBinary(stagedBaseline(bin, "deadbeef", "measured-local"))).toThrow(/sha256 mismatch/);
  });

  it("opt-out with COWORK_HARNESS_VERIFY_AGENT_SHA=0 disables the check (no throw)", () => {
    const bin = stageBinary();
    process.env.COWORK_HARNESS_VERIFY_AGENT_SHA = "0";
    expect(resolveAgentBinary(stagedBaseline(bin, "deadbeef", "measured-local"))).toBe(bin);
  });

  it("ADVISORY-WARNS (no throw) on an official-manifest mismatch", () => {
    const bin = stageBinary();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveAgentBinary(stagedBaseline(bin, "deadbeef", "official-manifest"))).toBe(bin);
    expect(stderr).toHaveBeenCalled();
  });

  it("an intentional COWORK_AGENT_BINARY override WARNS but does not hard-fail, even on measured-local mismatch", () => {
    const bin = stageBinary();
    process.env.COWORK_AGENT_BINARY = bin;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // baseline stagedPath is a different (nonexistent) path; override wins and is an intentional substitution
    expect(resolveAgentBinary(stagedBaseline("/nope/claude", "deadbeef", "measured-local"))).toBe(bin); // no throw
    expect(stderr).toHaveBeenCalled();
  });

  it("no-op when the baseline has no recorded sha256", () => {
    const bin = stageBinary();
    expect(resolveAgentBinary(stagedBaseline(bin, undefined, undefined))).toBe(bin);
  });
});

describe("committed baselines carry agent-binary provenance", () => {
  // desktop-1.18286.0 is the FIRST baseline written by the new sync code path (a real-world sample, not a
  // synthetic fixture): measured-local hash of the staged ELF + a boolean manifestChecksumMatch from the
  // live official-manifest cross-check.
  it("desktop-1.18286.0 (sync-produced) has a measured-local sha256 + boolean manifestChecksumMatch", () => {
    const ab = loadBaseline("desktop-1.18286.0").agentBinary;
    expect(ab.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ab.shaProvenance).toBe("measured-local");
    expect(typeof ab.manifestChecksumMatch).toBe("boolean");
    expect(ab.manifestChecksumMatch).toBe(true);
  });
  it("an absent-version baseline carries an official-manifest sha256 (staging-identity unverified, no match field)", () => {
    const ab = loadBaseline("desktop-1.13576.1").agentBinary;
    expect(ab.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ab.shaProvenance).toBe("official-manifest");
    expect(ab.manifestChecksumMatch).toBeUndefined();
  });
});

describe("resolveMounts — mntRoot derivation", () => {
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

// ==========================================================================================
// Spawn-contract verification + spawn.env generation The synthetic fixture uses FAKE
// minified names (FKa/FKb/FKc/FKd/FKe/FKtt/FKzrn/FKgen/FKu) so the tests exercise the ALGORITHM, not the
// real anchors — real env key names / tool names / property names are stable and kept verbatim. The
// real-bundle cross-checks live in the golden-map + structural-regression tests further down.
// ==========================================================================================
describe("deriveSpawnEnv / checkSpawnContractFacts (spawn contract, A5)", () => {
  const mkGate = (id: string, on: boolean): GateState => ({ id, name: id, on, source: on ? "force" : "defaultValue", value: on });
  // Green-path gates: 714014285 + 1936081873 ON, everything else off (mirrors the live fcache profile).
  const greenGates = (): Record<string, GateState> => ({
    "714014285": mkGate("714014285", true),
    "1936081873": mkGate("1936081873", true),
    "66187241": mkGate("66187241", false),
    "434204418": mkGate("434204418", false),
    "1129419822": mkGate("1129419822", false),
    "4153934152": mkGate("4153934152", false),
  });

  // A synthetic mini-bundle with W3 (FKzrn) → W2 (OnA) → W1 (spawn literal) + a const table + the S-tier
  // structural tokens. `${...}` and backticks in the TAGS template are escaped so the fixture is literal.
  const W3 =
    'function FKzrn(){var q;return{DISABLE_AUTOUPDATER:"1",...A.workspace.disableBundledSkills&&{CLAUDE_CODE_DISABLE_BUNDLED_SKILLS:"1"},' +
    '...t&&{CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:"1"},...A.route&&{CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:"1"},' +
    '...t&&{DISABLE_GROWTHBOOK:"1",DISABLE_TELEMETRY:A.tel?"1":"",DISABLE_FEEDBACK_COMMAND:"1",CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:"1",' +
    'DISABLE_ERROR_REPORTING:A.err?"1":"",CLAUDE_CODE_ENABLE_AUTO_MODE:A.auto?"1":""}}}';
  const W2 =
    'return{CLAUDE_CODE_ENTRYPOINT:t.type==="3p"?"claude-desktop-3p":"claude-desktop",ANTHROPIC_BASE_URL:A.apiHost,' +
    'USE_STAGING_OAUTH:t.type!=="3p"&&e==="staging"?"1":"",USE_LOCAL_OAUTH:t.type!=="3p"&&e==="local"?"1":"",' +
    'ANTHROPIC_API_KEY:"",ANTHROPIC_AUTH_TOKEN:"",ANTHROPIC_CUSTOM_HEADERS:"",CLAUDE_CODE_OAUTH_TOKEN:A.oauthToken,...FKzrn(),' +
    '...A.localAgent&&{CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:"1"},CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL:"true",' +
    'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES:"false",MCP_CONNECTION_NONBLOCKING:"true",API_TIMEOUT_MS:String(FKd),' +
    'CLAUDE_CODE_DISABLE_CRON:A.disableCron?"1":"",...t.type==="3p"&&{CLAUDE_CODE_ATTRIBUTION_HEADER:"1"},...t.sessionEnvVars()}';
  const W1 =
    'env:{CLAUDE_CONFIG_DIR:N,...OnA({oauthToken:n,disableCron:!0,localAgent:!0}),...g.env,...l,CLAUDE_CODE_ENTRYPOINT:"local-agent",' +
    '...v&&{CLAUDE_PROJECT_UUID:v,CLAUDE_PROJECT_TOOL:"1"},...At("1936081873")&&{CLAUDE_CODE_OAUTH_SCOPES:o.scope},' +
    '...At("434204418")&&{MCP_CONNECTION_NONBLOCKING:"0",MCP_CONNECT_TIMEOUT_MS:"10000"},...At("1129419822")&&{ENABLE_TOOL_SEARCH:"auto"},' +
    'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES:At("66187241")?"true":"",CLAUDE_CODE_TAGS:`lam_session_type:${r.sessionType??"chat"}`,' +
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1",MCP_TOOL_TIMEOUT:String(FKe()),CLAUDE_CODE_IS_COWORK:"1",CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT:"1",' +
    '...r.sessionType===FKu&&{CLAUDE_CODE_BRIEF_UPLOAD:"1",CLAUDE_CODE_BRIEF:"1",...At("451382573")&&{DISABLE_BRIEF_MODE_STOP_HOOK:"1"}},' +
    "CLAUDE_CODE_HOST_PLATFORM:process.platform,TZ:Intl.DateTimeFormat().resolvedOptions().timeZone," +
    '...At("714014285")&&{CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING:"1"},...At("4153934152")&&{CLAUDE_CODE_SKIP_PRECOMPACT_LOAD:"1"},' +
    'CLAUDE_CODE_ENABLE_TASKS:"true"},systemPrompt:c,';
  const STIER =
    "const FKa=31999,FKb=6e4;const FKc=FKb,FKd=9e5;function FKe(){var z;return((z=q())==null?void 0:z.mcpToolTimeoutMs)??FKc}" +
    'const FKtt=["TaskCreate","TaskUpdate","TaskGet","TaskList","TaskStop"];' +
    'sessionPath:`/sessions/${sid}/mnt/.claude`,settingSources:["user"],permissionMode:S?"default":(I==null?void 0:I.permissionMode)??"default",' +
    'maxThinkingTokens:r.extendedThinkingEnabled??!mOt()?FKa:0},effortCfg:{level:z.effort,fallback:"medium"},' +
    'tools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...FKtt,"WebSearch","Skill","REPL","JavaScript","AskUserQuestion","ToolSearch",...z.sessionType===FKu?[]:[]],' +
    'allowedTools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...FKtt,"WebSearch","Skill","REPL","JavaScript","ToolSearch","mcp__srv__tool"],' +
    'function FnA(V){for(const q of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"])V[q]===""&&delete V[q]}' +
    "V.env={...V.env,ANTHROPIC_CUSTOM_HEADERS:jXe(V.env,pf)},FnA(V.env)," +
    'sysP:{type:"preset",preset:"claude_code",append:ap},appendSubagentSystemPrompt:FKgen({vm:i,hostLoopMode:E})';
  // Synthetic per-model effort config (fake minified names FKi1r/FKs1r/FKo1r) — extractModelEffortConfig
  // locates this by CONTENT (the regex-default entry's literal shape + the fable|mythos regex source),
  // never by identifier, so a fake name here still exercises the real anchors.
  const MODELCFG =
    'const FKi1r={effortLevels:["low","medium","high","xhigh","max"],recommended:"high",modes:["auto"],disallowThinkingDisabled:!0},' +
    'FKs1r={"claude-haiku-4-5":{modes:["extended"]},"claude-sonnet-4-5":{modes:["extended"]},' +
    '"claude-sonnet-4-6":{effortLevels:["low","medium","high","max"],recommended:"low",modes:["auto"]},' +
    '"claude-opus-4-6":{effortLevels:["low","medium","high","max"],recommended:"medium",modes:["extended"]},' +
    '"claude-opus-4-7":{effortLevels:["low","medium","high","xhigh","max"],recommended:"xhigh",modes:["auto"]},' +
    '"claude-opus-4-8":{effortLevels:["low","medium","high","xhigh","max"],recommended:"high",modes:["auto"]}},' +
    "FKo1r=/^(?:claude-)?(?:fable|mythos)(?:-|$)/;";
  const fixture = () => `HEADER;${W3};${W2};${W1}${STIER};${MODELCFG}TAIL`;

  const EXPECTED_GREEN: Record<string, string> = {
    CLAUDE_CODE_IS_COWORK: "1",
    CLAUDE_CODE_ENTRYPOINT: "local-agent",
    CLAUDE_CODE_TAGS: "lam_session_type:chat",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: "true",
    CLAUDE_CODE_DISABLE_CRON: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT: "1",
    CLAUDE_CODE_ENABLE_TASKS: "true",
    MCP_CONNECTION_NONBLOCKING: "true",
    API_TIMEOUT_MS: "900000",
    CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: "",
    CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1",
    DISABLE_AUTOUPDATER: "1",
    MCP_TOOL_TIMEOUT: "60000",
    USE_LOCAL_OAUTH: "",
    USE_STAGING_OAUTH: "",
  };

  // 1.20186.0 build-shape fixture — guards the member-receiver (o.isFeatureEnabled / o.getMcpToolTimeout /
  // o.appendCoworkTelemetryHeaders / o.dropEmptyAuthEnvSentinels / o.buildSubagentEnvironmentPrompt) +
  // one-hop export-alias (TASK_TOOL_NAMES:uae, getMcpToolTimeout:f4, DEFAULT_MAX_THINKING_TOKENS:x7e)
  // shapes Anthropic shipped in 1.20186.0. W3/W2/MODELCFG are reused unchanged; only W1 (gate spreads via
  // o.isFeatureEnabled) and STIER (alias table) take the new shape, so the fixture must derive the identical
  // pin map — proving each re-anchor widened the accepted syntax without moving the protected fact.
  const W1_1201860 = W1.replaceAll('At("', 'o.isFeatureEnabled("').replace(
    "MCP_TOOL_TIMEOUT:String(FKe())",
    "MCP_TOOL_TIMEOUT:String(o.getMcpToolTimeout())",
  );
  const STIER_1201860 =
    // Decoys placed BEFORE their real definitions (mirrors live bundle order): `,vae=GWe` precedes the
    // `{vae=t}` decoy; the real `DEFAULT_MAX_THINKING_TOKENS:x7e` follows a `:0` decoy AND a second
    // differently-shaped `function Ua`. Identifier-shaped alias captures must skip every `:0`/`:t` decoy,
    // so a decoy-first placement is what actually proves the reworked lookups aren't passing by match-order.
    "const FKd=9e5,GWe=6e4,x7e=31999,vae=GWe;" +
    "var zNoise={DEFAULT_MAX_THINKING_TOKENS:0};function Ua(t){return t};{vae=t};" +
    "function f4(){var e;return((e=go())==null?void 0:e.mcpToolTimeoutMs)??vae}" +
    "function Ua(r,e,t){return r??e??!t?o.DEFAULT_MAX_THINKING_TOKENS:0}" +
    'var uae=["TaskCreate","TaskUpdate","TaskGet","TaskList","TaskStop"];' +
    "var o={TASK_TOOL_NAMES:uae,DEFAULT_MAX_THINKING_TOKENS:x7e,getMcpToolTimeout:f4};" +
    'sessionPath:`/sessions/${sid}/mnt/.claude`,settingSources:["user"],permissionMode:S?"default":(I==null?void 0:I.permissionMode)??"default",' +
    'maxThinkingTokens:Ua(r.extendedThinkingEnabled??!mOt())},effortCfg:{level:z.effort,fallback:"medium"},' +
    'tools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...o.TASK_TOOL_NAMES,"WebSearch","Skill","REPL","JavaScript","AskUserQuestion","ToolSearch",...z.sessionType===FKu?[]:[]],' +
    'allowedTools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...o.TASK_TOOL_NAMES,"WebSearch","Skill","REPL","JavaScript","ToolSearch","mcp__srv__tool"],' +
    'function FnA(V){for(const q of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"])V[q]===""&&delete V[q]}' +
    "V.env={...V.env,ANTHROPIC_CUSTOM_HEADERS:o.appendCoworkTelemetryHeaders(V.env??{},ie.app.getVersion())},o.dropEmptyAuthEnvSentinels(V.env)," +
    'sysP:{type:"preset",preset:"claude_code",append:ap},appendSubagentSystemPrompt:I.buildSubagentEnvironmentPrompt({vm:i})';
  const fixture1201860 = () => `HEADER;${W3};${W2};${W1_1201860}${STIER_1201860};${MODELCFG}TAIL`;

  // 1. Green path — the fixture resolves to the exact expected pin map; the S-tier returns [].
  it("green path: derives the full pin map (gates off except 714014285/1936081873) and no HARD-FAIL flags", () => {
    const { env, flags } = deriveSpawnEnv(fixture(), greenGates());
    // NOTEs (stale-allowlist prune hints) are non-blocking and expected here: the minimal fixture doesn't
    // construct every allowlisted key. The green path is the absence of any HARD-FAIL flag.
    expect(flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
    expect(env).toEqual(EXPECTED_GREEN);
    expect(checkSpawnContractFacts(fixture())).toEqual([]);
  });

  // 1b. Minifier-rename regression: the gate-check helper's name is minifier-assigned and changed
  // At→et across a Desktop build. Renaming every helper call must leave derivation byte-identical —
  // in particular the off-gate 434204418 spread must still be blanked so MCP_CONNECTION_NONBLOCKING
  // stays W2's "true" (an unblanked spread would leak "0" with no flag — a silent false-green).
  it("helper-rename regression: At(→et( derives the identical pin map and no HARD-FAIL flags", () => {
    const renamed = fixture().replaceAll('At("', 'et("');
    expect(renamed).not.toBe(fixture()); // the rename actually applied
    const { env, flags } = deriveSpawnEnv(renamed, greenGates());
    expect(flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
    expect(env).toEqual(EXPECTED_GREEN);
    expect(env!.MCP_CONNECTION_NONBLOCKING).toBe("true");
    expect(checkSpawnContractFacts(renamed)).toEqual([]);
  });

  // 1c. Build-shape regression: the three anchors that drifted on the Vite/SDK bundle refactor must stay
  // clean in their NEW shapes. CI runs on Linux with no Desktop, so the live-asar tests skip there; this
  // exercises the new shapes synthetically so the regex branches are covered in CI too:
  //  - S4: the inline `?const:0}` ternary hoisted into a helper (`return e??t??!r?const:0}`);
  //  - S14b: the sdkOptions env var re-minified (V.env → F.env), blank helper still called on it;
  //  - S17: the bundled SDK's typed env-var registry declares the key as a lazy export getter (`KEY:()=>x`)
  //    — a declaration, not a spawn-env construction — which must NOT trip the negative invariant, while a
  //    genuine construction (`KEY:"1"`) alongside it still does.
  it("build-shape regression: hoisted S4 helper, F-renamed blank-env, and the SDK export getter stay clean", () => {
    const variant =
      fixture()
        // S4: hoist the inline ternary into a helper — the key now holds a call, `?FKa:0}` lives in the body.
        .replace(
          "maxThinkingTokens:r.extendedThinkingEnabled??!mOt()?FKa:0}",
          "maxThinkingTokens:zHelper(r.extendedThinkingEnabled,ovr,mOt())}",
        )
        .replace("function FnA", "function zHelper(e,t,r){return e??t??!r?FKa:0}function FnA")
        // S14b: re-minify the sdkOptions env var V.env → F.env; the blank helper is still called on it.
        .replace(
          "V.env={...V.env,ANTHROPIC_CUSTOM_HEADERS:jXe(V.env,pf)},FnA(V.env),",
          "F.env={...F.env,ANTHROPIC_CUSTOM_HEADERS:jXe(F.env,pf)},FnA(F.env),",
        ) +
      // S17: the SDK env-registry's lazy export getter — a declaration, outside every env window.
      ";CLAUDE_CODE_USE_COWORK_PLUGINS:()=>Pei;";
    expect(variant).not.toBe(fixture()); // the transforms actually applied
    expect(checkSpawnContractFacts(variant)).toEqual([]);
    // A genuine construction of the key still fires S17 even alongside the benign getter form.
    const withRealKey = variant.replace('CLAUDE_CODE_IS_COWORK:"1"', 'CLAUDE_CODE_USE_COWORK_PLUGINS:"1",CLAUDE_CODE_IS_COWORK:"1"');
    expect(checkSpawnContractFacts(withRealKey).some((f) => f.includes("S17"))).toBe(true);
  });

  // 1d. 1.20186.0 build-shape regression: the member-receiver + export-alias re-anchors (A2/B1–B6) must
  // derive the IDENTICAL green pin map and keep checkSpawnContractFacts clean on the new build shape — so
  // older asars stay re-derivable (old fixture above) AND the new shape is accepted here.
  it("1.20186.0 build shape: member-receiver gates + export-alias hops derive the identical pin map and stay clean", () => {
    const { env, flags } = deriveSpawnEnv(fixture1201860(), greenGates());
    expect(flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
    expect(env).toEqual(EXPECTED_GREEN);
    // B6 guard (the ONLY automated signal the 687 fix landed): gate 434204418 off → the
    // `...o.isFeatureEnabled("434204418")&&{MCP_CONNECTION_NONBLOCKING:"0",…}` block must be BLANKED, not
    // read as an unconditional literal — so MCP_CONNECTION_NONBLOCKING stays W2's "true", never "0".
    expect(env!.MCP_CONNECTION_NONBLOCKING).toBe("true");
    // B2: String(o.getMcpToolTimeout()) → alias f4 → body `??vae` → `,vae=GWe` (real, before the {vae=t} decoy) → GWe=6e4.
    expect(env!.MCP_TOOL_TIMEOUT).toBe("60000");
    // B1: o.isFeatureEnabled("66187241") (gate off) → "".
    expect(env!.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES).toBe("");
    expect(checkSpawnContractFacts(fixture1201860())).toEqual([]);
  });

  // 1e. B6 positive proof: the new-shape gate spread is genuinely PARSED (not merely absent) — flipping
  // gate 434204418 ON must resolve the in-block "0"/"10000" against gate STATE, exactly as the old shape.
  it("1.20186.0 build shape: gate 434204418 ON pins MCP_CONNECTION_NONBLOCKING:'0' + MCP_CONNECT_TIMEOUT_MS:'10000'", () => {
    const g = greenGates();
    g["434204418"] = mkGate("434204418", true);
    const { env } = deriveSpawnEnv(fixture1201860(), g);
    expect(env!.MCP_CONNECTION_NONBLOCKING).toBe("0");
    expect(env!.MCP_CONNECT_TIMEOUT_MS).toBe("10000");
  });

  // 2. Per-fact mutation table: mutate/drop each token → exactly the matching flag names the field.
  const STRUCT_MUT: [string, string, string][] = [
    ['settingSources:["user"]', 'settingSources:["admin"]', "S2"],
    ['permissionMode:S?"default"', 'permissionMode:S?"plan"', "S3"],
    ["FKa=31999", "FKa=41999", "S4"],
    ['fallback:"medium"', 'fallback:"high"', "S5"],
    ["/sessions/${sid}/mnt/.claude", "/elsewhere", "S1"],
    ['NotebookEdit","WebFetch",...FKtt,"WebSearch","Skill","REPL","JavaScript","AskUserQuestion","ToolSearch"', '"nope"', "S6"],
    ['FKtt=["TaskCreate","TaskUpdate","TaskGet","TaskList","TaskStop"]', "FKtt=[]", "S7"],
    ['"ToolSearch",...z.sessionType===', '"ToolSearch",...NOPE===', "S8"],
    ['...FKtt,"WebSearch","Skill","REPL","JavaScript","ToolSearch","mcp__srv__tool"', '...FKtt,"nope"]', "S9"],
    ['"ToolSearch","mcp__srv__tool"', '"ToolSearch","builtin__x"', "S10"],
    ['CLAUDE_CODE_ENTRYPOINT:"local-agent"', 'CLAUDE_CODE_ENTRYPOINT:"other"', "S11"],
    ["disableCron:!0,localAgent:!0", "wrong:!0", "S12"],
    ['CLAUDE_CODE_DISABLE_CRON:A.disableCron?"1":""', 'CLAUDE_CODE_DISABLE_CRON:"x"', "S13"],
    ['"ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"', '"OTHER"', "S14a"],
    ["},FnA(V.env)", "},noop(x)", "S14b"],
    ['preset:"claude_code"', 'preset:"other"', "S15"],
    ["appendSubagentSystemPrompt:FKgen({", "appendSubagentSystemPrompt:x", "S16"],
    ['CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES:At("66187241")?"true":""', "EMIT_X:1", "S18"],
    ["CLAUDE_CODE_TAGS:`lam_session_type:${", "CLAUDE_CODE_TAGS:`other:${", "S19"],
    ["FKo1r=/^(?:claude-)?(?:fable|mythos)(?:-|$)/", "FKo1r=/^(?:claude-)?(?:nope|mythos)(?:-|$)/", "S20"],
  ];
  for (const [from, to, field] of STRUCT_MUT) {
    it(`structural mutation flags ${field}`, () => {
      const mutated = fixture().replace(from, to);
      expect(mutated).not.toBe(fixture()); // the mutation actually applied
      const flags = checkSpawnContractFacts(mutated);
      // Word-boundary match, not substring: `f.includes("S1")` would also match "S10".."S19" and let a
      // mutation false-pass by tripping a same-prefix sibling check instead of its own target.
      expect(flags.some((f) => new RegExp(String.raw`\b${field}\b`).test(f))).toBe(true);
    });
  }

  it("S17 negative invariant fires when CLAUDE_CODE_USE_COWORK_PLUGINS is set as a key", () => {
    const mutated = fixture().replace('CLAUDE_CODE_IS_COWORK:"1"', 'CLAUDE_CODE_USE_COWORK_PLUGINS:"1",CLAUDE_CODE_IS_COWORK:"1"');
    expect(checkSpawnContractFacts(mutated).some((f) => f.includes("S17"))).toBe(true);
  });

  // Per generated pin: dropping/mutating a pinned value shows in the env (change) or triggers removal path.
  it("a pinned value change is reflected in the generated env (diff-visible)", () => {
    const mutated = fixture().replace('CLAUDE_CODE_ENABLE_TASKS:"true"', 'CLAUDE_CODE_ENABLE_TASKS:"false"');
    expect(deriveSpawnEnv(mutated, greenGates()).env!.CLAUDE_CODE_ENABLE_TASKS).toBe("false");
  });

  // 3. Addition detection — a new top-level key in each window hard-fails with the classify message.
  for (const [where, from, inject] of [
    ["W1", 'CLAUDE_CODE_IS_COWORK:"1"', 'NEW_SPAWN_KEY:"1",CLAUDE_CODE_IS_COWORK:"1"'],
    ["W2", 'MCP_CONNECTION_NONBLOCKING:"true"', 'NEW_SPAWN_KEY:"1",MCP_CONNECTION_NONBLOCKING:"true"'],
    ["W3", 'DISABLE_AUTOUPDATER:"1"', 'DISABLE_AUTOUPDATER:"1",NEW_SPAWN_KEY:"1"'],
  ] as const) {
    it(`addition detection: an unknown key in ${where} hard-fails (env null + classify message)`, () => {
      const { env, flags } = deriveSpawnEnv(fixture().replace(from, inject), greenGates());
      expect(env).toBeNull();
      expect(flags.some((f) => f.includes("NEW_SPAWN_KEY") && f.includes("--allow-empty"))).toBe(true);
    });
  }

  // 3c. WI-4: a NEW key inside an OFF-gate conditional spread must hard-fail. Before WI-4 the off-gate
  // inner keys were enumerated but never classified (resolveGateInner ran only when the gate was ON), so
  // a brand-new key shipped in an off-gate spread was a silent channel. 434204418 is OFF in greenGates.
  it("WI-4: an unknown key in an OFF-gate spread hard-fails (not silently enumerated)", () => {
    const injected = fixture().replace('MCP_CONNECT_TIMEOUT_MS:"10000"}', 'MCP_CONNECT_TIMEOUT_MS:"10000",OFFGATE_MYSTERY_KEY:"1"}');
    expect(injected).not.toBe(fixture()); // the injection applied
    const { env, flags } = deriveSpawnEnv(injected, greenGates());
    expect(env).toBeNull();
    expect(flags.some((f) => f.includes("OFFGATE_MYSTERY_KEY") && f.includes("--allow-empty"))).toBe(true);
  });

  // 3d. WI-4 non-breaking guard: the OFF-gate block's OWN keys (pinned MCP_CONNECTION_NONBLOCKING,
  // allowlisted MCP_CONNECT_TIMEOUT_MS) must still NOT hard-fail AND must not override W2's value — the
  // off-gate "0" stays unapplied (W2's "true" wins), exactly as before.
  it("WI-4: classifying off-gate inner keys does NOT apply their values (W2 still wins) or flag known keys", () => {
    const { env, flags } = deriveSpawnEnv(fixture(), greenGates());
    expect(flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
    expect(env!.MCP_CONNECTION_NONBLOCKING).toBe("true"); // W2 value, NOT the off-gate "0"
  });

  // WI-6: deriveSpawnEnv returns the sorted SET of constructed keys (committed as
  // provenance.spawnEnvKeys — an enumeration-regex-rot oracle). WI-5: a count of spread SITES across
  // the windows (provenance.spawnEnvSpreadCount — surfaces a new spread source, incl. an opaque one).
  it("WI-6/WI-5: returns the constructed key SET and the spread-site count", () => {
    const { keys, spreadCount } = deriveSpawnEnv(fixture(), greenGates());
    expect(keys).toContain("CLAUDE_CODE_IS_COWORK"); // a known constructed key is in the set
    expect(keys).toEqual([...keys].sort()); // sorted (stable diff)
    expect(keys.length).toBeGreaterThan(10);
    expect(spreadCount).toBeGreaterThan(0); // the fixture has gate/helper spreads
  });

  it("WI-5: a NEW spread site increases spawnEnvSpreadCount (tracks opaque sources)", () => {
    const before = deriveSpawnEnv(fixture(), greenGates()).spreadCount;
    // inject an opaque spread of the kind enumeration can't see (…someHostObj.env)
    const withSpread = fixture().replace('CLAUDE_CODE_IS_COWORK:"1"', '...someHostObj.env,CLAUDE_CODE_IS_COWORK:"1"');
    const after = deriveSpawnEnv(withSpread, greenGates()).spreadCount;
    expect(after).toBe(before + 1);
  });

  it("WI-5: counts a PARENTHESIZED opaque spread (…(expr)&&{…}) — the real minifier shape", () => {
    // The live spawn window carries conditional opaque spreads like `...(p?.accountId)&&{…}`; a regex
    // that only matches `...<identifier>` misses these, defeating the guard on exactly the shape it
    // exists for. Inject one into W1 and require the count to rise.
    const before = deriveSpawnEnv(fixture(), greenGates()).spreadCount;
    const withParenSpread = fixture().replace(
      'CLAUDE_CODE_IS_COWORK:"1"',
      '...(z==null?void 0:z.accountId)&&{X_OPAQUE:"1"},CLAUDE_CODE_IS_COWORK:"1"',
    );
    const after = deriveSpawnEnv(withParenSpread, greenGates()).spreadCount;
    expect(after).toBe(before + 1);
  });

  // 4. Gate addition — an unknown gate id in a W1 conditional is caught at introduction.
  it("gate addition: an unknown spawn gate id in W1 hard-fails", () => {
    const mutated = fixture().replace('...At("714014285")&&{', '...At("999999999")&&{X_KEY:"1"},...At("714014285")&&{');
    const { env, flags } = deriveSpawnEnv(mutated, greenGates());
    expect(env).toBeNull();
    expect(flags.some((f) => f.includes("999999999") && f.includes("unknown gate"))).toBe(true);
  });

  // 5. Removal — a REQUIRED key drop hard-fails; a non-required key drop is silent (absent from env).
  it("removal: dropping a REQUIRED key hard-fails; dropping a non-required pin just omits it", () => {
    const reqDropped = fixture().replace('CLAUDE_CODE_IS_COWORK:"1",', "");
    const r1 = deriveSpawnEnv(reqDropped, greenGates());
    expect(r1.env).toBeNull();
    expect(r1.flags.some((f) => f.includes("REQUIRED") && f.includes("CLAUDE_CODE_IS_COWORK"))).toBe(true);

    const nonReqDropped = fixture().replace('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1",', "");
    const r2 = deriveSpawnEnv(nonReqDropped, greenGates());
    expect(r2.flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]); // no hard-fail — removal is diff-visible, not blocking
    expect(r2.env).not.toBeNull();
    expect("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" in r2.env!).toBe(false);
  });

  // 6. Gate resolution — 434204418 ON flips NONBLOCKING to "0" + auto-pins MCP_CONNECT_TIMEOUT_MS; 66187241 ON → "true".
  it("gate resolution: 434204418 ON pins MCP_CONNECTION_NONBLOCKING:'0' + MCP_CONNECT_TIMEOUT_MS:'10000'; 66187241 ON → EMIT 'true'", () => {
    const g = greenGates();
    g["434204418"] = mkGate("434204418", true);
    g["66187241"] = mkGate("66187241", true);
    const { env } = deriveSpawnEnv(fixture(), g);
    expect(env!.MCP_CONNECTION_NONBLOCKING).toBe("0");
    expect(env!.MCP_CONNECT_TIMEOUT_MS).toBe("10000");
    expect(env!.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES).toBe("true");
  });

  // 7. Degenerate windows — a missing anchor and a W3 scanner hitting a nested `${` both flag (never guess).
  it("degenerate windows: a missing W1 anchor flags and returns env null", () => {
    const noW1 = fixture().replace("env:{CLAUDE_CONFIG_DIR", "env:{OTHER_FIRST_KEY");
    const { env, flags } = deriveSpawnEnv(noW1, greenGates());
    expect(env).toBeNull();
    expect(flags.some((f) => f.includes("W1") && f.includes("window not found"))).toBe(true);
  });
  it("degenerate windows: a nested template `${` inside W3 makes the brace scan flag rather than guess", () => {
    const nested = fixture().replace('DISABLE_AUTOUPDATER:"1"', "DISABLE_AUTOUPDATER:`x${y}`");
    const { env, flags } = deriveSpawnEnv(nested, greenGates());
    expect(env).toBeNull();
    expect(flags.some((f) => f.includes("W3"))).toBe(true);
  });

  // 8. gates:null — env null, and NO spurious spawn flags (the fcache flag covers it).
  it("gates null: env null with no spurious spawn flags", () => {
    expect(deriveSpawnEnv(fixture(), null)).toEqual({ env: null, flags: [], keys: [], spreadCount: 0 });
  });

  // 9. Stale allowlist NOTE — an allowlist key absent from all windows emits a non-blocking NOTE.
  it("stale allowlist entry (never constructed) emits a NOTE, not a hard-fail", () => {
    // CLAUDE_CODE_HOST_AUTH_ENV_VAR is allowlisted but only appears inside the fixture's 3p Zrn branch text
    // as a spread condition — remove any trace so it is 'never constructed', then expect a prune NOTE.
    const noHost = fixture(); // the fixture never constructs CLAUDE_CODE_HOST_AUTH_ENV_VAR as a key
    const { flags } = deriveSpawnEnv(noHost, greenGates());
    expect(flags.some((f) => f.startsWith("NOTE:") && f.includes("CLAUDE_CODE_HOST_AUTH_ENV_VAR"))).toBe(true);
  });

  // 9b. The NOTE is SURFACED, not swallowed: partitionSpawnFlags (the seam extractFromAsar feeds through)
  //     routes it to `notes` (→ SyncResult.notes → the sync CLI's ℹ lines) and NEVER to the hard-fail deltas.
  it("partitionSpawnFlags surfaces a stale-allowlist NOTE as a note (prefix stripped), never as a delta", () => {
    const { flags } = deriveSpawnEnv(fixture(), greenGates());
    const { deltas, notes } = partitionSpawnFlags(flags);
    expect(deltas).toEqual([]); // NOTEs must not block the baseline write
    expect(notes.some((n) => n.includes("CLAUDE_CODE_HOST_AUTH_ENV_VAR") && n.includes("prune"))).toBe(true);
    expect(notes.every((n) => !n.startsWith("NOTE:"))).toBe(true);
  });

  // 10. Golden-map correctness oracle (non-circular): the generator over the REAL asar must deep-equal
  //     the hand-transcribed golden map. Skips gracefully off-macOS / without a live Desktop install.
  it("golden oracle: deriveSpawnEnv(real asar) deep-equals the hand-transcribed golden map", () => {
    const golden = JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", "spawn-env.golden.json"), "utf8")).env as Record<
      string,
      string
    >;
    const bundle = readRealBundleOrSkip();
    if (!bundle) return;
    const gates = decodeFcacheGates();
    if (!gates) return; // no live fcache on this machine
    const { env, flags } = deriveSpawnEnv(bundle, gates);
    expect(flags).toEqual([]);
    expect(env).toEqual(golden);
  });

  // 11. Structural-regression (non-circular): checkSpawnContractFacts over the REAL asar returns [] today.
  it("structural regression: checkSpawnContractFacts(real asar) is clean", () => {
    const bundle = readRealBundleOrSkip();
    if (!bundle) return;
    expect(checkSpawnContractFacts(bundle)).toEqual([]);
  });

  // 12. Baseline lockstep: REQUIRED_SPAWN_KEYS ⊆ keys(latest committed baseline spawn.env).
  it("baseline lockstep: every REQUIRED_SPAWN_KEYS is present in the latest committed baseline spawn.env", () => {
    const b = loadBaseline("latest") as unknown as { spawn: { env: Record<string, string> } };
    for (const k of REQUIRED_SPAWN_KEYS) expect(k in b.spawn.env).toBe(true);
  });

  // 13. Canonical order: a reordered-but-equal env yields identical JSON; a new key appends at its
  //     deterministic alpha position after the base-order keys.
  it("canonicalizeEnv: a pure reorder is a zero-line diff; a new key is appended alphabetically", () => {
    const base = { B: "1", A: "2", C: "3" };
    const reordered = { C: "3", A: "2", B: "1" };
    expect(JSON.stringify(canonicalizeEnv(reordered, base))).toBe(JSON.stringify(base));
    const withNew = { B: "1", A: "2", C: "3", ZZ: "9", AA: "0" };
    expect(Object.keys(canonicalizeEnv(withNew, base))).toEqual(["B", "A", "C", "AA", "ZZ"]);
  });

  // 14. Null contract: any single hard-fail injection → env === null AND the flag is present.
  it("null contract: an unresolvable const chain returns env null with the flag (never a partial env)", () => {
    // Break the MCP_TOOL_TIMEOUT const chain: FKe's ??-fallback id no longer resolves.
    const broken = fixture().replace("??FKc}", "??UNDEFINED_ID}").replace("const FKc=FKb,", "");
    const { env, flags } = deriveSpawnEnv(broken, greenGates());
    expect(env).toBeNull();
    expect(flags.some((f) => f.includes("MCP_TOOL_TIMEOUT"))).toBe(true);
  });

  it("resolveConst follows const/let/var + comma preambles and aliases", () => {
    const b = "x=>{}}const kGt=6e4,zae=kGt;let Sde=9e5;{,Zae=31999,";
    expect(resolveConst(b, "kGt")).toBe("6e4");
    expect(resolveConst(b, "zae")).toBe("6e4"); // alias hop
    expect(resolveConst(b, "Sde")).toBe("9e5");
    expect(resolveConst(b, "Zae")).toBe("31999");
  });
});

// ==========================================================================================
// extractModelEffortConfig (Phase 0 of the reasoning-config fidelity work): the literal per-model
// effort map + the regex-default entry + class regex. Located by CONTENT, so the synthetic fixture
// below uses FAKE minified names (FKi1r/FKs1r/FKo1r) to prove the extractor doesn't depend on them.
// ==========================================================================================
describe("extractModelEffortConfig (per-model effort config extraction, Phase 0)", () => {
  const good =
    'const FKi1r={effortLevels:["low","medium","high","xhigh","max"],recommended:"high",modes:["auto"],disallowThinkingDisabled:!0},' +
    'FKs1r={"claude-haiku-4-5":{modes:["extended"]},"claude-sonnet-4-5":{modes:["extended"]},' +
    '"claude-sonnet-4-6":{effortLevels:["low","medium","high","max"],recommended:"low",modes:["auto"]},' +
    '"claude-opus-4-6":{effortLevels:["low","medium","high","max"],recommended:"medium",modes:["extended"]},' +
    '"claude-opus-4-7":{effortLevels:["low","medium","high","xhigh","max"],recommended:"xhigh",modes:["auto"]},' +
    '"claude-opus-4-8":{effortLevels:["low","medium","high","xhigh","max"],recommended:"high",modes:["auto"]}},' +
    "FKo1r=/^(?:claude-)?(?:fable|mythos)(?:-|$)/;TAIL";

  it("extracts the four literal-map classes + the regex-default entry from a content-anchored fixture (fake identifiers)", () => {
    const { config, flags } = extractModelEffortConfig(good);
    expect(flags).toEqual([]);
    expect(config).not.toBeNull();
    expect(config!.effortByModel).toEqual({
      "claude-haiku-4-5": { modes: ["extended"] },
      "claude-sonnet-4-5": { modes: ["extended"] },
      "claude-sonnet-4-6": { effortLevels: ["low", "medium", "high", "max"], recommended: "low", modes: ["auto"] },
      "claude-opus-4-6": { effortLevels: ["low", "medium", "high", "max"], recommended: "medium", modes: ["extended"] },
      "claude-opus-4-7": { effortLevels: ["low", "medium", "high", "xhigh", "max"], recommended: "xhigh", modes: ["auto"] },
      "claude-opus-4-8": { effortLevels: ["low", "medium", "high", "xhigh", "max"], recommended: "high", modes: ["auto"] },
    });
    expect(config!.effortRegexDefault).toEqual({
      pattern: "^(?:claude-)?(?:fable|mythos)(?:-|$)",
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      recommended: "high",
      modes: ["auto"],
      disallowThinkingDisabled: true,
    });
  });

  it("is minifier-name-proof: renaming FKi1r/FKs1r/FKo1r to different fake names doesn't change the result", () => {
    const renamed = good.replaceAll("FKi1r", "Zeta9").replaceAll("FKs1r", "Yotta2").replaceAll("FKo1r", "Xi7");
    expect(renamed).not.toBe(good);
    const { config, flags } = extractModelEffortConfig(renamed);
    expect(flags).toEqual([]);
    expect(config!.effortByModel["claude-opus-4-8"]).toEqual({
      effortLevels: ["low", "medium", "high", "xhigh", "max"],
      recommended: "high",
      modes: ["auto"],
    });
  });

  it("hard-fails (config:null) when the regex-default marker is absent", () => {
    const broken = good.replace(
      'recommended:"high",modes:["auto"],disallowThinkingDisabled',
      'recommended:"HIGH",modes:["auto"],disallowThinkingDisabled',
    );
    const { config, flags } = extractModelEffortConfig(broken);
    expect(config).toBeNull();
    expect(flags.some((f) => f.includes("regex-default entry") && f.includes("not found"))).toBe(true);
  });

  it("hard-fails when the literal map doesn't immediately follow the regex-default entry (declaration order changed)", () => {
    const broken = good.replace("disallowThinkingDisabled:!0},FKs1r={", "disallowThinkingDisabled:!0};const OTHER=1;const FKs1r={");
    const { config, flags } = extractModelEffortConfig(broken);
    expect(config).toBeNull();
    expect(flags.some((f) => f.includes("does not immediately follow the regex-default entry"))).toBe(true);
  });

  it("hard-fails when the class regex doesn't immediately follow the literal map (declaration order changed)", () => {
    const broken = good.replace("}},FKo1r=/^", "}};const SPACER=1;FKo1r=/^");
    const { config, flags } = extractModelEffortConfig(broken);
    expect(config).toBeNull();
    expect(flags.some((f) => f.includes("does not immediately follow the literal per-model map"))).toBe(true);
  });

  it("hard-fails when the class regex source has drifted away from fable|mythos", () => {
    const broken = good.replace("(?:fable|mythos)", "(?:otherfam)");
    const { config, flags } = extractModelEffortConfig(broken);
    expect(config).toBeNull();
    expect(flags.some((f) => f.includes("class regex"))).toBe(true);
  });

  it("hard-fails on a bundle with none of the anchors at all (never a silent empty map)", () => {
    const { config, flags } = extractModelEffortConfig("totally unrelated bundle content");
    expect(config).toBeNull();
    expect(flags.length).toBeGreaterThan(0);
  });

  // Golden oracle (non-circular): the extractor over the REAL asar must deep-equal the hand-transcribed
  // golden map. Skips gracefully off-macOS / without a live Desktop install.
  it("golden oracle: extractModelEffortConfig(real asar) deep-equals the hand-transcribed golden map", () => {
    const golden = JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", "model-effort-config.golden.json"), "utf8"))
      .config as unknown;
    const bundle = readRealBundleOrSkip();
    if (!bundle) return;
    const { config, flags } = extractModelEffortConfig(bundle);
    expect(flags).toEqual([]);
    expect(config).toEqual(golden);
  });
});

// Read the extracted real asar bundle if available; return null (skip) otherwise. Prefer an env override.
// One extraction per test-file run (module-level memo — two tests share it), tmp dir cleaned up in
// afterAll, and a skip is a single LOUD console.warn naming why (repo ethos: no silent no-op).
const LIVE_ASAR = "/Applications/Claude.app/Contents/Resources/app.asar";
let realBundleMemo: string | null | undefined;
let realBundleTmpDir: string | null = null;

function skipRealBundle(reason: string): null {
  console.warn(`skipping live-asar oracle tests: ${reason}`);
  return null;
}

function readRealBundleOrSkip(): string | null {
  if (realBundleMemo === undefined) realBundleMemo = extractRealBundle();
  return realBundleMemo;
}

function extractRealBundle(): string | null {
  const override = process.env.COWORK_ASAR_BUNDLE;
  if (override) {
    try {
      return readFileSync(override, "utf8");
    } catch {
      /* fall through to the live-install path */
    }
  }
  if (process.platform !== "darwin") return skipRealBundle("not macOS");
  // Guard on the asar's existence BEFORE spawning npx — on a Mac without Claude Desktop the npx
  // `--yes` fetch would otherwise touch the network just to fail on a missing input file.
  if (!existsSync(LIVE_ASAR)) return skipRealBundle(`no Claude Desktop install (${LIVE_ASAR} missing)`);
  try {
    realBundleTmpDir = mkdtempSync(join(tmpdir(), "cowork-asar-test-"));
    execFileSync("npx", ["--yes", "@electron/asar", "extract", LIVE_ASAR, realBundleTmpDir], { stdio: "ignore" });
    return readMainBundle(realBundleTmpDir);
  } catch (e) {
    return skipRealBundle(`asar extraction failed: ${(e as Error).message}`);
  }
}

afterAll(() => {
  if (realBundleTmpDir) rmSync(realBundleTmpDir, { recursive: true, force: true });
});

// ==========================================================================================
// Prompt drift guard (H1-H3): extractPromptFingerprint (golden oracle against the real asar) +
// checkPromptDrift (pure, token-free — the synthetic cases don't need a live Desktop install).
// ==========================================================================================
describe("prompt drift guard (H1-H3)", () => {
  const COMMITTED_1_20186_0_SHA = "0189a96cafe73f82bf9c492a17a4ff2f1b87c8486c54232c4e70e78ab98d836a";

  // Golden oracle (non-circular): extractPromptFingerprint over the REAL asar must match the
  // committed 1.20186.0 fingerprint entry exactly. Skips gracefully off-macOS / without a live
  // Desktop install (same readRealBundleOrSkip seam the spawn-contract oracles use).
  it("golden oracle: extractPromptFingerprint(real asar) matches the committed 1.20186.0 fingerprint", () => {
    const bundle = readRealBundleOrSkip();
    if (!bundle) return;
    const fp = extractPromptFingerprint(bundle);
    expect(fp).not.toBeNull();
    expect(fp!.sha256).toBe(COMMITTED_1_20186_0_SHA);
    expect(fp!.codePoints).toBe(37875);
    expect(fp!.sectionTags).toBe(43);
    expect(fp!.placeholders).toHaveLength(10);
  });

  // Clean path (non-circular against the real committed fingerprints file): a fingerprint matching
  // the newest committed entry, checked against the REAL renderer substitution set +
  // intentional-inline allowlist, produces zero deltas and zero notes.
  it("checkPromptDrift is clean when fp matches the committed newest entry (real fingerprints file, real modeled/allowlisted sets)", () => {
    const bundle = readRealBundleOrSkip();
    if (!bundle) return;
    const fp = extractPromptFingerprint(bundle);
    expect(fp).not.toBeNull();
    const fingerprintsFile = JSON.parse(
      readFileSync(join(process.cwd(), "baselines", "prompts", "cowork-system-prompt-fingerprints.json"), "utf8"),
    );
    const result = checkPromptDrift(fp, fingerprintsFile, MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS);
    expect(result).toEqual({ unknownDeltas: [], notes: [] });
  });

  const fakeFingerprintsFile = {
    versions: {
      "1.20186.0": {
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        placeholders: ["cwd", "modelName"],
        sectionTagNames: ["env"],
      },
    },
  };
  const makeFp = (overrides: Partial<PromptFingerprint> = {}): PromptFingerprint => ({
    constantId: "tOt",
    codePoints: 100,
    sectionTags: 1,
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    placeholders: ["cwd", "modelName"],
    sectionTagNames: ["env"],
    ...overrides,
  });

  it("checkPromptDrift: fp === null hard-fails with a layout-moved unknownDelta", () => {
    const result = checkPromptDrift(null, fakeFingerprintsFile, MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS);
    expect(result.unknownDeltas.some((d) => d.includes("consumption site") && d.includes("not found"))).toBe(true);
  });

  it("checkPromptDrift: missing/unreadable fingerprints file emits a note, not a hard-fail (still runs H3)", () => {
    const result = checkPromptDrift(makeFp(), null, MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS);
    expect(result.unknownDeltas).toEqual([]);
    expect(result.notes.some((n) => n.includes("missing/unreadable"))).toBe(true);
  });

  it("checkPromptDrift (H1): a sha mismatch vs the newest committed entry is an unknownDelta mentioning 'drifted'", () => {
    const fp = makeFp({ sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const result = checkPromptDrift(fp, fakeFingerprintsFile, MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS);
    expect(result.unknownDeltas.some((d) => d.includes("drifted"))).toBe(true);
  });

  it("checkPromptDrift (H2): a new placeholder / new section vs the committed entry is a note, not a delta", () => {
    const fp = makeFp({ placeholders: ["cwd", "modelName", "skillsDir"], sectionTagNames: ["env", "artifacts"] });
    const result = checkPromptDrift(fp, fakeFingerprintsFile, MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS);
    expect(result.unknownDeltas).toEqual([]); // skillsDir IS modeled, so no H3 hit either
    expect(result.notes.some((n) => n === "prompt inventory: NEW placeholder {{skillsDir}}")).toBe(true);
    expect(result.notes.some((n) => n === "prompt inventory: NEW section <artifacts>")).toBe(true);
  });

  it("checkPromptDrift (H3): an unmodeled, non-allowlisted placeholder is an unknownDelta naming it", () => {
    const fp = makeFp({ placeholders: ["cwd", "modelName", "foo"] });
    const result = checkPromptDrift(fp, fakeFingerprintsFile, MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS);
    expect(result.unknownDeltas.some((d) => d.includes("unmodeled placeholder {{foo}}"))).toBe(true);
  });

  it("checkPromptDrift (H3): an allowlisted out-of-band placeholder produces NO unknownDelta for it", () => {
    const fp = makeFp({ placeholders: ["cwd", "modelName", "workspaceContext", "modelIdentity"] });
    const result = checkPromptDrift(fp, fakeFingerprintsFile, MODELED_PLACEHOLDER_NAMES, INTENTIONALLY_UNMODELED_PLACEHOLDERS);
    expect(result.unknownDeltas.some((d) => d.includes("workspaceContext"))).toBe(false);
    expect(result.unknownDeltas.some((d) => d.includes("modelIdentity"))).toBe(false);
  });
});

describe("checkSubagentOverrideGate (gate 124685897 — subagent-append server override)", () => {
  const gate = (on: boolean) => ({
    "124685897": { id: "124685897", name: "subagentPromptServerOverride", on, source: "defaultValue", value: undefined },
  });
  it("OFF (live state) → no delta", () => {
    expect(checkSubagentOverrideGate(gate(false))).toEqual([]);
  });
  it("absent from fcache → no delta (the missing-fcache case is flagged separately by sync)", () => {
    expect(checkSubagentOverrideGate(null)).toEqual([]);
    expect(checkSubagentOverrideGate({})).toEqual([]);
  });
  it("ON → a HARD-STOP unknown delta (a pinned-gate drift alone only warns)", () => {
    const flags = checkSubagentOverrideGate(gate(true));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatch(/subagentPromptServerOverride/);
    expect(flags[0]).toMatch(/override/i);
  });
});

/** Synthetic bundle reproducing the verified 1.20186.1 generator/delivery SHAPES with PARAPHRASED
 *  branch bodies. Only the short discriminator fragments and interpolation shapes the sentinel keys
 *  on ("on the user's machine" / "exist only in the sandbox" / "working directory `${a??b}`" /
 *  "rooted at `${x}`" / "mounted under `${x}/mnt/`") are verbatim — the real branch texts never
 *  enter the public tree; the committed golden below derives from THIS synthetic text, so the suite
 *  is self-consistent, while the real-asar fingerprints live only in the baselines JSON. The inner
 *  markdown backticks are escaped (\`) to reproduce real minified template syntax, so the branch
 *  slicer decodes them instead of terminating the slice at the first inner backtick. */
function subagentBundle(overrides: Partial<Record<"keys" | "ternary" | "hl" | "vm" | "gate" | "map" | "delivery", string>> = {}): string {
  const keys = overrides.keys ?? `subagentEnvHostLoop:"subagent_env_hl",subagentEnvVm:"subagent_env_vm"`;
  const hl =
    overrides.hl ??
    "## Cowork environment\\n\\nSynthetic hl body: a subagent on the user's machine; file tools act on the real filesystem (working directory \\`${t??i}\\`); shell goes through \\`mcp__${n.WORKSPACE_MCP_SERVER}__${n.WORKSPACE_BASH}\\` with attached folders mounted under \\`${i}/mnt/\\`.";
  const vm =
    overrides.vm ??
    "## Cowork environment\\n\\nSynthetic vm body: a subagent whose shell runs in a Linux sandbox rooted at \\`${i}\\`; files written there exist only in the sandbox; attached folders are mounted under \\`${i}/mnt/\\`.";
  const ternary = overrides.ternary ?? "?Q.subagentEnvHostLoop:Q.subagentEnvVm";
  const gate = overrides.gate ?? `function krt(e,o,r){if(!$t("124685897"))return r;...}`;
  const map = overrides.map ?? "{vmCwd:i,hostCwd:t??i,workspaceBash:w}";
  const delivery =
    overrides.delivery ??
    "appendSubagentSystemPrompt:I.buildSubagentEnvironmentPrompt({vmProcessName:v,hostLoopMode:f,hostCwd:S??void 0,spSectionPrompts:P})";
  return `const SP={${keys}};${gate};function zo({vmProcessName:v,hostLoopMode:h,hostCwd:t,spSectionPrompts:P}){const i=\`/sessions/\${v}\`;const s=h?\`${hl}\`:\`${vm}\`;const a=h${ternary};const l=krt(P,a,s);return"\\n\\n"+sub(l,${map},a)}const buildSubagentEnvironmentPrompt=zo;const opts={${delivery}};`;
}
// The sentinel takes a per-MODULE file map (readMainBundleFiles' output). One synthetic "generator
// module" is enough for these fixtures; a real bundle has three modules — the join covers the literal
// anchors, the module scoping covers the branch texts.
const genFiles = (o?: Parameters<typeof subagentBundle>[0]) => new Map([["index.chunk-gen.js", subagentBundle(o)]]);

describe("checkSubagentPromptFacts — hl/vm sub-agent append sentinel", () => {
  const clean = extractSubagentBranchSlices(genFiles())!;
  const committed = { versions: { "1.20186.1": { hl: subagentBranchFingerprint(clean.hl), vm: subagentBranchFingerprint(clean.vm) } } };

  it("clean bundle → no flags", () => {
    expect(checkSubagentPromptFacts(genFiles(), committed)).toEqual([]);
  });
  it("body-text edit → fingerprint mismatch flags (head phrases alone would miss it)", () => {
    const files = new Map([["index.chunk-gen.js", subagentBundle().replace("attached folders mounted", "attached folders placed")]]);
    expect(checkSubagentPromptFacts(files, committed).some((f) => /fingerprint/.test(f))).toBe(true);
  });
  it("host/VM cwd SWAP in the hl branch → substitution-VALUE proof flags", () => {
    // keeps the discriminator fragment AND both interpolation shapes (so slicing + the value proof
    // run) but rebinds the mount to the HOST cwd instead of the vm session root — a genuine swap.
    const swapped = genFiles({
      hl: "## Cowork environment\\n\\nSynthetic hl body: a subagent on the user's machine (working directory \\`${t??i}\\`) with attached folders mounted under \\`${t}/mnt/\\`.",
    });
    expect(checkSubagentPromptFacts(swapped, null).some((f) => /substitution|hl substitution/.test(f))).toBe(true);
  });
  it("VM-branch root/mount BINDING mismatch → substitution-VALUE proof flags", () => {
    const badVm = genFiles({
      vm: "## Cowork environment\\n\\nSynthetic vm body: a subagent whose shell runs in a Linux sandbox rooted at \\`${i}\\`; files written there exist only in the sandbox; attached folders are mounted under \\`${j}/mnt/\\`.",
    });
    expect(checkSubagentPromptFacts(badVm, null).some((f) => /vm substitution/.test(f))).toBe(true);
  });
  it("key-pair renamed → flags the SP_SECTION_KEYS anchor specifically", () => {
    expect(
      checkSubagentPromptFacts(genFiles({ keys: `subagentEnvHost:"subagent_env_hl",subagentEnvVm:"subagent_env_vm"` }), null).some((f) =>
        /SP_SECTION_KEYS/.test(f),
      ),
    ).toBe(true);
  });
  it("branch ternary inverted (vm-first) → flags the branch ternary anchor specifically", () => {
    expect(
      checkSubagentPromptFacts(genFiles({ ternary: "?Q.subagentEnvVm:Q.subagentEnvHostLoop" }), null).some((f) => /branch ternary/.test(f)),
    ).toBe(true);
  });
  it("substitution map key renamed → flags the substitution map anchor specifically", () => {
    expect(
      checkSubagentPromptFacts(genFiles({ map: "{cwdVm:i,hostCwd:t??i,workspaceBash:w}" }), null).some((f) => /substitution map/.test(f)),
    ).toBe(true);
  });
  it("delivery call missing spSectionPrompts → flags the delivery argument list anchor specifically", () => {
    expect(
      checkSubagentPromptFacts(
        genFiles({
          delivery: "appendSubagentSystemPrompt:I.buildSubagentEnvironmentPrompt({vmProcessName:v,hostLoopMode:f,hostCwd:S??void 0})",
        }),
        null,
      ).some((f) => /delivery argument list/.test(f)),
    ).toBe(true);
  });
  it("gate id changed in resolveSection → flags the resolveSection gate anchor specifically", () => {
    expect(
      checkSubagentPromptFacts(genFiles({ gate: `function krt(e,o,r){if(!$t("999"))return r;...}` }), null).some((f) =>
        /resolveSection gate/.test(f),
      ),
    ).toBe(true);
  });
  it("DECOY: literals all present but the generator MODULE is gone (disconnected) → flags", () => {
    // literals live in one module; the discriminators/generator in NONE — no module satisfies the
    // co-occurrence, so the branch-text slice fails. Proves per-module connectivity is required.
    const decoy = new Map([
      ["a.js", `const SP={subagentEnvHostLoop:"subagent_env_hl",subagentEnvVm:"subagent_env_vm"};`],
      ["b.js", `const t="on the user's machine";`], // no buildSubagentEnvironmentPrompt, no vm discriminator
      ["c.js", `const u="exist only in the sandbox";`],
    ]);
    expect(checkSubagentPromptFacts(decoy, committed).some((f) => /generator branch texts/.test(f))).toBe(true);
  });
  it("PARTIAL committed entry (hl only) → hard-fail (a missing vm fingerprint must not silently pass)", () => {
    const partial = { versions: { "1.20186.1": { hl: committed.versions["1.20186.1"].hl } as { hl: string; vm: string } } };
    expect(checkSubagentPromptFacts(genFiles(), partial).some((f) => /missing an hl or vm fingerprint/.test(f))).toBe(true);
  });
  it("no committed fingerprints → hard-fail flag (never a silent skip)", () => {
    expect(checkSubagentPromptFacts(genFiles(), null).some((f) => /fingerprint/.test(f))).toBe(true);
  });
});

function pathHookFiles(mut: Partial<Record<"defining" | "consuming", (s: string) => string>> = {}): Map<string, string> {
  let defining =
    `const g5e=["Read","Write","Edit","Glob","Grep"],p5e=["Bash","NotebookEdit","REPL","JavaScript","WebFetch"],Jse="request_cowork_directory",Bse="chat";` +
    // resolveFilePath lives in the SHARED/defining chunk — its two hard-block strings are here, NOT in
    // the hostloop consumer (which only carries the caller-side "could not be safely resolved").
    `function JKe(p){throw new Error("Refusing to resolve non-regular file")||new Error("Failed to resolve path")}` +
    `export{g5e as HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,p5e as HOST_LOOP_EXCLUDED_BUILTIN_TOOLS,Jse as REQUEST_COWORK_DIRECTORY,Bse as SESSION_TYPE_CHAT,Nce as isPathContainedInFolders,JKe as resolveFilePath};`;
  let consuming =
    `const Yt=["Write","Edit","MultiEdit"];` +
    `function qt(e){return "read-only in this session — it is a hardlink to the user's original file" && "(spooled tool results)" && "(plugin, skill, or knowledge content)"}` +
    `const Zt="Path is outside allowed working directories";` +
    `function xe(e,o){for(const k of ["file_path","path"]){}return "is a VM path. In this session the \${e} tool runs on the host filesystem"}` +
    `const ie=n===t.SESSION_TYPE_CHAT,st=ie?[...be,...nt]:[c,u,h];` +
    `PreToolUse:[{matcher:[...t.HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,"MultiEdit"].join("|"),hooks:[async g=>{` +
    `const raw=["file_path","path"].map(k=>g[k]).find(v=>typeof v=="string");` +
    `try{}catch(err){return "could not be safely resolved"}` +
    `if(qt(g))return qt(g);` +
    `const lt=[...st,...T(),...ie||ct?[]:(ne==null?void 0:ne())??[]];getMidSessionReadOnlyPaths;spooledProjectsReadOnlyRoots;` +
    `if(!t.isPathContainedInFolders(cand,lt))return ct?"is outside this session's scratch directory, so \${e}":"is outside this session's connected folders, so \${e}"}]}],` +
    `const Se=e.canUseTool;Se&&(e.canUseTool=async(g,S,k)=>xe(g,S)??Qt(g,S,k.decisionReason,n)??Se(g,S,k));`;
  if (mut.defining) defining = mut.defining(defining);
  if (mut.consuming) consuming = mut.consuming(consuming);
  return new Map([
    ["index.chunk-zFJ_MSb3.js", defining],
    ["index.chunk-CS-g0Skn.js", consuming],
  ]);
}

describe("checkPathHookFacts — 1.20186.1 path-gate sentinel (module-bounded)", () => {
  it("clean bundle → no flags", () => {
    expect(checkPathHookFacts(pathHookFiles())).toEqual([]);
  });
  it("MUTATION: gated set membership changed → flags", () => {
    const f = pathHookFiles({ defining: (s) => s.replace(`"Grep"]`, `"Grep","Bash"]`) });
    expect(checkPathHookFacts(f).length).toBeGreaterThan(0);
  });
  it("MUTATION: a deny text reworded → flags (each text is its OWN anchor)", () => {
    const f = pathHookFiles({ consuming: (s) => s.replace("connected folders, so", "attached folders, so") });
    expect(checkPathHookFacts(f).some((x) => /connected folders/.test(x))).toBe(true);
  });
  it("MUTATION: canUseTool wrapper made unconditional (Se&& dropped) → flags", () => {
    const f = pathHookFiles({ consuming: (s) => s.replace("Se&&(e.canUseTool", "(e.canUseTool") });
    expect(checkPathHookFacts(f).length).toBeGreaterThan(0);
  });
  it("MUTATION: qt order inverted (containment before qt) → flags", () => {
    const f = pathHookFiles({
      consuming: (s) => s.replace("if(qt(g))return qt(g);", "").replace("return ct?", "return qt(g)??ct?"),
    });
    expect(checkPathHookFacts(f).length).toBeGreaterThan(0);
  });
  it("MUTATION: excluded-tool set changed → flags", () => {
    const f = pathHookFiles({ defining: (s) => s.replace(`"WebFetch"]`, `"WebFetch","Agent"]`) });
    expect(checkPathHookFacts(f).length).toBeGreaterThan(0);
  });
  it("DECOY: the gated-set array exists but is NOT bound to the export name → flags (array↔export binding required)", () => {
    // g5e still holds the 5-tool array, but the EXPORT points at an unrelated local zzz=[] — the hop
    // from HOST_LOOP_PATH_GATED_BUILTIN_TOOLS must land on the WRONG array and fail. Proves the
    // sentinel binds the array to its export name, not "some 5-tool array exists somewhere".
    const f = pathHookFiles({
      defining: (s) =>
        s
          .replace(`g5e as HOST_LOOP_PATH_GATED_BUILTIN_TOOLS`, `zzz as HOST_LOOP_PATH_GATED_BUILTIN_TOOLS`)
          .replace(`Bse="chat";`, `Bse="chat",zzz=["Read","Edit"];`),
    });
    expect(checkPathHookFacts(f).some((x) => /gated 5-set/.test(x))).toBe(true);
  });
  it("DECOY: install site references a DIFFERENT property name than the defining export → flags", () => {
    const f = pathHookFiles({
      consuming: (s) => s.replace('.HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,"MultiEdit"]', '.SOME_OTHER_SET,"MultiEdit"]'),
    });
    expect(checkPathHookFacts(f).some((x) => /install site/.test(x))).toBe(true);
  });
});

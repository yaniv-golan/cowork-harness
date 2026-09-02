import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as acorn from "acorn";
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
  recordedLayoutDivergence,
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
  readMainBundleFiles,
  normalizeBundleQuotes,
  exportLocalOf,
  resolveNamespaceRef,
  fcacheContentHash,
  decodeFcacheProvenance,
  checkSyspromptMapFacts,
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
import { checkNormalizationSanity, checkEgressContractFacts } from "../src/sync/cowork-sync.js";
import { hostLoopCwds } from "../src/runtime/hostloop.js";
import { fidelityWasDefaulted, defaultedFidelityNotice } from "../src/run/execute.js";
import { buildJudgedDocument } from "../src/assert.js";
import { renderPrompts } from "../src/prompt.js";
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
      "4074604942": { id: "4074604942", name: "1p-direct-mcp", on: false, source: "absent", value: undefined },
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

  it("PINNED_GATES tracks canProposeSkills, the still-off sibling of the canSaveSkill flip", () => {
    // canSaveSkill went off→on server-side on 2026-07-25 and widened production's tool set with a
    // save_skill tool the harness does not model. canProposeSkills gates the `propose_skills` sibling
    // and is present-but-off in the fcache (NOT dark) — pinned so the same class of silent widening
    // can't repeat unnoticed. That it is NOT dark is already pinned by the exact-match assertion on
    // decodeFcacheGates' absent-marker set above, which does not list this id.
    expect(PINNED_GATES["1824824999"]).toBe("canProposeSkills");
  });

  it("PINNED_GATES tracks 1p-direct-mcp, new in 1.24012.11 — and it MUST be dark, or the pin is vacuous", () => {
    // This gate is absent from a standard fcache, so decodeFcacheGates would skip it entirely without a
    // DARK_GATES entry: PINNED_GATES alone would never round-trip through sync and the sentinel would
    // guard nothing while looking pinned. The absent-marker exact-match assertion above is what actually
    // proves the round-trip — it lists this id, and being a toEqual it cannot pass if DARK_GATES drops it.
    expect(PINNED_GATES["4074604942"]).toBe("1p-direct-mcp");
    // Not the GrowthBook flag name: the asar passes the bare id and the name appears nowhere, so it is
    // unrecoverable. Kebab-case (the subsystem's log tag) marks it as unverified vs the camelCase names.
    expect(PINNED_GATES["4074604942"]).not.toMatch(/^[a-z]+[A-Z]/);
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
  // A synthetic bundle carrying every binary-verified mode fact: the delete-deny resolver plus each
  // mount whose mode is hardcoded `"ro"` at the spawn-time builder. Widened from two facts to five once
  // the builder was read in full — `.claude/skills`, `.claude/projects` and the per-uuid project
  // ATTACHMENT mount are all pinned read-only there.
  // TWO resolver sites, because the real bundle has had two since Desktop 1.37937.0 — the VM-loop
  // mount-set builder and host-loop `computeBashMounts`. The checker guards a FLOOR on that count, so a
  // one-site fixture would red on the floor rather than on the fact each case is actually about.
  const ok =
    'function IX(A,e,t){return t?"rw":e!=null&&e.includes(A)?"rwd":"rw"}' +
    'function IXbash(A,e,t){return t?"rw":e!=null&&e.includes(A)?"rwd":"rw"} … l[Es("uploads")]={path:wa(i),mode:"ro"}' +
    ';l[Es(".claude/skills")]={path:x,mode:"ro"};l[Es(".claude/projects")]={path:y,mode:"ro"}' +
    ';l[Es(`.projects/${e.uuid}`)]={path:z,mode:"ro"}';
  it("returns no flags when every mode fact is present", () => {
    expect(checkMountModeFacts(ok)).toEqual([]);
  });
  it("flags when the IX delete-deny resolver is gone (outputs/projects default may have changed)", () => {
    // BOTH lanes, so the floor sees 0 sites. Mutating one lane is a different case — covered below.
    const drifted = ok.split('?"rwd":"rw"').join('?"rwd":"rwd"'); // delete now allowed by default
    const flags = checkMountModeFacts(drifted);
    expect(flags.some((f) => f.includes("delete-deny resolver"))).toBe(true);
  });
  it("flags when uploads is no longer read-only", () => {
    const drifted = ok.replace('("uploads")]={path:wa(i),mode:"ro"', '("uploads")]={path:wa(i),mode:"rw"');
    const flags = checkMountModeFacts(drifted);
    expect(flags.some((f) => f.includes("uploads"))).toBe(true);
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
  // The regression pin for the RC-channel fix. Desktop 1.40609.1 stages agent 2.1.255, a release
  // CANDIDATE served only from `…/claude-code-releases/rc/<commit>/`. The stable-only checksum fetch
  // 404'd and recorded `manifestChecksumMatch:"unknown"` for a build whose published checksum matches the
  // staged ELF exactly. Both fields below come from a real `sync` against the live install — a hand-edit
  // would make this test assert nothing about the extractor.
  it("desktop-1.40609.1 (RC-staged) records the RC channel and a TRUE manifest match", () => {
    const ab = loadBaseline("desktop-1.40609.1").agentBinary;
    expect(ab.shaProvenance).toBe("measured-local");
    expect(ab.manifestChecksumMatch).toBe(true);
    expect(ab.releaseBaseUrl).toMatch(/^https:\/\/downloads\.claude\.ai\/claude-code-releases\/rc\/[0-9a-f]{40}$/);
  });
  // Every baseline written before the field existed was stable-staged or later promoted, so the
  // recovery runbook's stable-path fallback is safe for them. Pinned so that stops being an assumption:
  // a NEW baseline that omits the field while being RC-staged would leave its ELF unrecoverable.
  it("a pre-fix baseline has no releaseBaseUrl, and its version is still served from the stable path", () => {
    const ab = loadBaseline("desktop-1.40609.0").agentBinary;
    expect(ab.releaseBaseUrl).toBeUndefined();
    // The name promised two things and asserted one. The second half is the load-bearing half: the
    // runbook's stable-path fallback for pre-field baselines is only safe if those versions really are
    // on the stable channel. Asserted from the recorded provenance rather than the network, so the test
    // stays hermetic: a `measured-local` sha that the official manifest AGREED with (`true`) is exactly
    // the evidence that the stable manifest served this version at sync time.
    expect(ab.shaProvenance).toBe("measured-local");
    expect(ab.manifestChecksumMatch).toBe(true);
  });

  // The newest baseline must always carry the field, in one of its two legal shapes. This is the pin
  // that makes check-versions' fail-closed 8b meaningful: without it, an extractor that silently starts
  // returning null would ship a baseline with no channel and nothing would notice until a consumer's
  // `curl` 404'd.
  it("the newest baseline always records a release channel, stable or rc/<40-hex>", () => {
    expect(loadBaseline("latest").agentBinary.releaseBaseUrl).toMatch(
      /^https:\/\/downloads\.claude\.ai\/claude-code-releases(\/rc\/[0-9a-f]{40})?$/,
    );
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

  // resolveMounts describes the tree the HARNESS stages, so mntRoot is always `<sessionRoot>/mnt` —
  // the only place any stager creates it. A recorded value saying otherwise is a fidelity divergence
  // (see recordedLayoutDivergence below), never a path this composes: honouring it emitted a
  // `--plugin-dir` one directory above the staged plugin tree.
  it("a sessionRoot already ending in /mnt still stages its mnt tree one level deeper", () => {
    const r = resolveMounts(mountLayoutWith("/sessions/abc/mnt"), "abc");
    expect(r.mntRoot).toBe("/sessions/abc/mnt/mnt");
  });

  it("a recorded mntRoot does NOT override the staged layout", () => {
    // Same recorded value the legacy baseline carries implicitly — the derived answer must ignore it.
    const r = resolveMounts(mountLayoutWith("/sessions/abc/mnt", "/sessions/abc/mnt"), "abc");
    expect(r.mntRoot).toBe("/sessions/abc/mnt/mnt");
  });

  it("explicit mntRoot matching the staged layout is consistent (unaffected baseline)", () => {
    const r = resolveMounts(mountLayoutWith("/sessions/abc", "/sessions/abc/mnt"), "abc");
    expect(r.mntRoot).toBe("/sessions/abc/mnt");
  });

  it("recordedLayoutDivergence flags a recording the harness cannot stage, and nothing else", () => {
    expect(recordedLayoutDivergence(mountLayoutWith("/sessions/abc", "/sessions/abc/mnt"))).toBeUndefined();
    expect(recordedLayoutDivergence(mountLayoutWith("/sessions/abc/mnt"))).toEqual({
      recorded: "/sessions/abc/mnt",
      staged: "/sessions/abc/mnt/mnt",
    });
    // Partially-constructed baselines are normal at the argv seam — this must not throw there.
    expect(recordedLayoutDivergence({ spawn: {} } as never)).toBeUndefined();
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
    // The tools[] TAIL mirrors the live shape (Desktop >=1.28929.0): the sessionType SendUserMessage
    // spread followed by the project-session-only conditional tool, then the closing bracket. S8 pins the
    // whole tail and RESOLVES both the alias ("Projects") and its condition (toolModeProjectUuid), so the
    // fixture must carry a resolvable alias hop and the destructure that names the condition.
    'var FKproj="Projects";toolModeProjectUuid:FKm,' +
    'sessionPath:`/sessions/${sid}/mnt/.claude`,settingSources:["user"],permissionMode:S?"default":(I==null?void 0:I.permissionMode)??"default",' +
    'maxThinkingTokens:r.extendedThinkingEnabled??!mOt()?FKa:0},effortCfg:{level:z.effort,fallback:"medium"},' +
    'tools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...FKtt,"WebSearch","Skill","REPL","JavaScript","AskUserQuestion","ToolSearch",...z.sessionType==="agent"?["SendUserMessage"]:[],...FKm?[FKproj]:[]],' +
    'allowedTools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...FKtt,"WebSearch","Skill","REPL","JavaScript","ToolSearch","mcp__mcp-registry__search_mcp_registry","mcp__mcp-registry__suggest_connectors","mcp__mcp-registry__list_connectors","mcp__plugins__search_plugins","mcp__plugins__search_connectors","mcp__plugins__suggest_plugin_install","mcp__plugins__list_plugins","mcp__skills__list_skills","mcp__skills__suggest_skills","mcp__scheduled-tasks__list_scheduled_tasks","mcp__computer-use"],' +
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
    'var wProj="Projects";toolModeProjectUuid:FKm,' +
    "var o={TASK_TOOL_NAMES:uae,DEFAULT_MAX_THINKING_TOKENS:x7e,getMcpToolTimeout:f4,PROJECTS_TOOL:wProj};" +
    'sessionPath:`/sessions/${sid}/mnt/.claude`,settingSources:["user"],permissionMode:S?"default":(I==null?void 0:I.permissionMode)??"default",' +
    'maxThinkingTokens:Ua(r.extendedThinkingEnabled??!mOt())},effortCfg:{level:z.effort,fallback:"medium"},' +
    // Same live tail as STIER, but the alias reaches "Projects" through the export-alias hop
    // (o.PROJECTS_TOOL → wProj) — proving S8's alias resolution follows the same hop S7 does.
    'tools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...o.TASK_TOOL_NAMES,"WebSearch","Skill","REPL","JavaScript","AskUserQuestion","ToolSearch",...z.sessionType==="agent"?["SendUserMessage"]:[],...FKm?[o.PROJECTS_TOOL]:[]],' +
    'allowedTools:["Task","Bash","Glob","Grep","Read","Edit","Write","NotebookEdit","WebFetch",...o.TASK_TOOL_NAMES,"WebSearch","Skill","REPL","JavaScript","ToolSearch","mcp__mcp-registry__search_mcp_registry","mcp__mcp-registry__suggest_connectors","mcp__mcp-registry__list_connectors","mcp__plugins__search_plugins","mcp__plugins__search_connectors","mcp__plugins__suggest_plugin_install","mcp__plugins__list_plugins","mcp__skills__list_skills","mcp__skills__suggest_skills","mcp__scheduled-tasks__list_scheduled_tasks","mcp__computer-use"],' +
    'function FnA(V){for(const q of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"])V[q]===""&&delete V[q]}' +
    "V.env={...V.env,ANTHROPIC_CUSTOM_HEADERS:o.appendCoworkTelemetryHeaders(V.env??{},ie.app.getVersion())},o.dropEmptyAuthEnvSentinels(V.env)," +
    'sysP:{type:"preset",preset:"claude_code",append:ap},appendSubagentSystemPrompt:I.buildSubagentEnvironmentPrompt({vm:i})';
  const fixture1201860 = () => `HEADER;${W3};${W2};${W1_1201860}${STIER_1201860};${MODELCFG}TAIL`;

  // ── A5/1.28929.0: the conditional `Artifact` spread (frame artifacts) ────────────────────────────
  // The live shape: a scope-local boolean `zde` gates BOTH the tools[] spread and the spawn-env key, and
  // resolves through an attended-turn wrapper (zFo) to the frame-artifacts predicate (zPo). The rendered
  // 1p tools[] is unchanged (the server flag is off by default), so spawn.tools stays 20 entries and the
  // env key is ALLOWLISTED, not pinned — it must never appear in the derived env.
  // B17: the HIPAA reader is now RESOLVED (S6e), not name-matched, so the fixture has to carry a real
  // resolvable definition — two hops, exactly as production emits them:
  //   Object.defineProperty(exports,"r",…get(){return GL})   <- what exportLocalOf resolves `zA.r` to
  //   function GL(){return WL()==="restricted"}              <- hop 1: pins the comparison
  //   function WL(){…"coworkHipaaRestricted"…}               <- hop 2: names the gate
  // The defineProperty form is used deliberately: exportLocalOf tries it FIRST, whereas its last-resort
  // `r[:=]<ident>` shape would match almost any `r=<ident>` in a single-string fixture and resolve to
  // garbage while still looking green.
  const HIPAA_DEF =
    'Object.defineProperty(exports,"r",{enumerable:!0,get:function(){return zGL}});' +
    'function zGL(){return zWL()==="restricted"}' +
    'function zWL(){return zRL("coworkHipaaRestricted")?"restricted":"unrestricted"}';
  const ARTIFACT_DEF =
    "let zde=(N?g?.builtTools===void 0?zFo(i,{isBridgeSession:b,isDispatchChild:x,isHostLoop:v}):N.frameArtifactsTurnEnabled??!1:!1)&&!zA.r();" +
    "N&&(N.frameArtifactsTurnEnabled=zde);" +
    "function zPo(e,t){return e.frameArtifactsEnabled===!0&&e.sessionType===void 0&&e.scheduledTaskId===void 0&&!t.isBridgeSession&&!t.isDispatchChild&&!t.isHostLoop&&!zA.r()}" +
    "function zFo(e,t){return zPo(e,t)&&e._isUnattended!==!0}" +
    HIPAA_DEF;
  const STIER_1289290 =
    ARTIFACT_DEF + STIER.replace('"AskUserQuestion","ToolSearch"', '"AskUserQuestion",...zde?["Artifact"]:[],"ToolSearch"');
  // W1 gains the frame-artifacts env key, gated on the SAME `zde` as the tools spread (what S6d asserts).
  const W1_1289290 = W1.replace(
    'CLAUDE_CODE_ENABLE_TASKS:"true"}',
    '...zde&&{CLAUDE_CODE_COWORK_FRAME_ARTIFACTS:"1"},CLAUDE_CODE_ENABLE_TASKS:"true"}',
  );
  const fixture1289290 = () => `HEADER;${W3};${W2};${W1_1289290}${STIER_1289290};${MODELCFG}TAIL`;

  // D7 (Desktop 1.32352.0): production dropped `!isHostLoop` from BOTH the call site and the predicate
  // body, so Artifact now reaches the host-loop tier. Without this case the new shape is proven only by
  // the real-asar oracle, which skips wherever there is no Desktop install — i.e. in CI.
  it("1.32352.0 build shape: the predicate without !isHostLoop is still clean", () => {
    const without = fixture1289290()
      .replace("{isBridgeSession:b,isDispatchChild:x,isHostLoop:v}", "{isBridgeSession:b,isDispatchChild:x}")
      .replace("&&!t.isHostLoop&&", "&&");
    expect(checkSpawnContractFacts(without)).toEqual([]);
  });

  it("1.28929.0 build shape: the conditional Artifact spread + frame-artifacts env key stay clean and unpinned", () => {
    expect(checkSpawnContractFacts(fixture1289290())).toEqual([]);
    const { env, flags } = deriveSpawnEnv(fixture1289290(), greenGates());
    expect(flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
    // The allowlisted key must NOT enter the pinned env — a default 1p session never receives it.
    expect(env).toEqual(EXPECTED_GREEN);
    expect(env).not.toHaveProperty("CLAUDE_CODE_COWORK_FRAME_ARTIFACTS");
  });

  // Mutation matrix. Every row is a way the Artifact gate / tools tail could WIDEN; each must fail loud.
  // A guard that cannot fail is worthless, so each row asserts the SPECIFIC check that catches it — an
  // earlier draft of S6c passed R1/R2/R3/M7/M8 silently while looking correct.
  const ARTIFACT_MUT: ReadonlyArray<readonly [string, () => string, string]> = [
    // Unconditional Artifact — adjacency breaks, S6 itself catches it.
    ["M1 unconditional Artifact literal", () => fixture1289290().replace('...zde?["Artifact"]:[],', '"Artifact",'), "S6 tools head"],
    // Condition severed from the predicate entirely.
    [
      "M2 condition severed (=!0)",
      () => fixture1289290().replace(ARTIFACT_DEF, "let zde=!0;" + ARTIFACT_DEF.split(";").slice(1).join(";")),
      "S6c Artifact gate",
    ],
    // D7 (Desktop 1.32352.0): production itself dropped `!isHostLoop` — Artifact now legitimately reaches
    // the host-loop tier — so that is no longer a violation and both term lists are admitted. What must
    // still fail loud is losing one of the REMAINING tier restrictions, or emptying the argument object
    // so the predicate can no longer see any of them.
    ["M3a predicate drops !isDispatchChild", () => fixture1289290().replace("&&!t.isDispatchChild", ""), "S6c Artifact gate"],
    ["M3b predicate drops !isBridgeSession", () => fixture1289290().replace("&&!t.isBridgeSession", ""), "S6c Artifact gate"],
    [
      "M3c the predicate's argument object is emptied",
      () => fixture1289290().replace("{isBridgeSession:b,isDispatchChild:x,isHostLoop:v}", "{}"),
      "S6c Artifact gate",
    ],
    // Definition hoisted out of the spawn window ⇒ must fail CLOSED, not open.
    [
      "M4 definition outside the window",
      () =>
        fixture1289290()
          .replace(ARTIFACT_DEF, "")
          .replace("HEADER;", `HEADER;${ARTIFACT_DEF}${"/*pad*/".repeat(1200)}`),
      "S6c Artifact gate",
    ],
    // Attended-turn wrapper neutered — Artifact becomes unconditional for every non-HIPAA session.
    [
      "M7 attended wrapper neutered",
      () => fixture1289290().replace("function zFo(e,t){return zPo(e,t)&&e._isUnattended!==!0}", "function zFo(e,t){return!0}"),
      "S6c Artifact gate",
    ],
    // Condition rewired to a different, always-true helper while the real predicate stays intact.
    [
      "M8 condition rewired to another helper",
      () => fixture1289290().replace("?zFo(i,", "?zZz(i,").replace("function zPo", "function zZz(e,t){return!0}function zPo"),
      "S6c Artifact gate",
    ],
    // Whole-expression widenings: each keeps the right call but makes the result unconditional.
    ["R1 trailing ||!0 appended", () => fixture1289290().replace("&&!zA.r();N&&", "&&!zA.r()||!0;N&&"), "S6c Artifact gate"],
    [
      "R2 cached arm flipped to ??!0:!0",
      () => fixture1289290().replace("N.frameArtifactsTurnEnabled??!1:!1", "N.frameArtifactsTurnEnabled??!0:!0"),
      "S6c Artifact gate",
    ],
    ["R3 HIPAA conjunct replaced by a literal", () => fixture1289290().replace("&&!zA.r();N&&", "&&!0;N&&"), "S6c Artifact gate"],
    // B17/S6e. The old check hard-coded the member name (`\.r\(\)`), so it accepted ANY single-letter
    // member — re-pointing the conjunct at a different export passed silently. These three are the
    // reason the resolution has to be two hops against a BRACE-SCANNED body rather than a window:
    // around the real reader, `coworkHipaaRestricted` occurs 8x within +/-600 chars and several of the
    // neighbours are exported, so a windowed implementation passes R4/R5 while HIPAA is gone.
    [
      "R4 conjunct re-pointed at a sibling export (windowed check would pass)",
      () =>
        fixture1289290()
          .replace("&&!zA.r();N&&", "&&!zA.q();N&&")
          .replace(HIPAA_DEF, HIPAA_DEF + 'Object.defineProperty(exports,"q",{enumerable:!0,get:function(){return zRL}});'),
      "S6c Artifact gate",
    ],
    [
      "R5 reader stops consulting coworkHipaaRestricted",
      () => fixture1289290().replace('function zWL(){return zRL("coworkHipaaRestricted")?', 'function zWL(){return zRL("somethingElse")?'),
      "S6c Artifact gate",
    ],
    [
      "R6 the HIPAA export is deleted entirely → resolution FAILS CLOSED (never a silent skip)",
      () => fixture1289290().replace('Object.defineProperty(exports,"r",{enumerable:!0,get:function(){return zGL}});', ""),
      "S6c Artifact gate",
    ],
    // R7 IS THE STRENGTHENING PROOF. R4/R5/R6 all change the member NAME or delete the export, which the
    // OLD hard-coded `\.r\(\)` also rejected (for the wrong reason — any rename tripped it, which is the
    // false positive B17 fixes). R7 keeps the call spelled `zA.r()` and only re-points what `r` EXPORTS,
    // at the raw gate reader — no restriction check at all. The old regex saw `.r()` and passed; the
    // resolution sees a local that is not a `<f>()==="restricted"` reader and fires. Asserted directly
    // against the old pattern in the dedicated test below.
    [
      "R7 `.r()` kept but re-pointed at a non-restriction reader (OLD check passed this)",
      () => fixture1289290().replace("get:function(){return zGL}", "get:function(){return zRL}"),
      "S6c Artifact gate",
    ],
    // The env key must stay conditional AND on the same predicate as the tool.
    [
      "M9 env key unconditional",
      () => fixture1289290().replace('...zde&&{CLAUDE_CODE_COWORK_FRAME_ARTIFACTS:"1"},', 'CLAUDE_CODE_COWORK_FRAME_ARTIFACTS:"1",'),
      "S6d frame-artifacts env key",
    ],
    [
      "M10 env key re-keyed onto another id",
      () => fixture1289290().replace("...zde&&{CLAUDE_CODE_COWORK_FRAME_ARTIFACTS", "...zq&&{CLAUDE_CODE_COWORK_FRAME_ARTIFACTS"),
      "S6d frame-artifacts env key",
    ],
    // The reverse direction: tool spread gone but the key kept ⇒ the allowlist would admit it unchecked.
    ["M16 tool spread dropped, env key kept", () => fixture1289290().replace('...zde?["Artifact"]:[],', ""), "S6d frame-artifacts env key"],
    // Tools TAIL — pre-existing blind spot that the widened S8 closes.
    [
      "M12 tool appended after the Projects spread",
      () => fixture1289290().replace("...FKm?[FKproj]:[]]", '...FKm?[FKproj]:[],"NewTool"]'),
      "S8 tools tail-guard",
    ],
    [
      "M13a Projects alias swapped to another tool",
      () => fixture1289290().replace('var FKproj="Projects"', 'var FKproj="SomethingElse"'),
      "S8 tools tail-guard",
    ],
    [
      "M13b tail spread condition widened",
      () => fixture1289290().replace("...FKm?[FKproj]:[]]", "...FKother?[FKproj]:[]]"),
      "S8 tools tail-guard",
    ],
  ];
  it.each(ARTIFACT_MUT)("mutation %s fails loud (%#)", (_label, mutate, expected) => {
    const flags = checkSpawnContractFacts(mutate());
    expect(flags.join("\n")).toContain(expected);
  });

  // M5: the ALLOWLIST entry is the only thing admitting CLAUDE_CODE_COWORK_FRAME_ARTIFACTS into the spawn
  // env without a pin. Rename the key and deriveSpawnEnv must still hard-fail on an unknown constructed
  // key — otherwise a future allowlist mistake (or a Desktop rename) would be absorbed silently, which is
  // the entire drift class the explicit key set exists to kill.
  it("M5: a renamed frame-artifacts env key is still an unknown-key HARD FAIL (the allowlist admits one exact name)", () => {
    const renamed = fixture1289290().replace("CLAUDE_CODE_COWORK_FRAME_ARTIFACTS", "CLAUDE_CODE_COWORK_FRAME_ARTIFACTS_X");
    const { flags } = deriveSpawnEnv(renamed, greenGates());
    const hard = flags.filter((f) => !f.startsWith("NOTE:"));
    expect(hard.join("\n")).toContain("CLAUDE_CODE_COWORK_FRAME_ARTIFACTS_X");
    // …and the real name must NOT be what's flagged (proving the allowlist entry is doing its job).
    expect(deriveSpawnEnv(fixture1289290(), greenGates()).flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
  });

  // Proof that S6e is a STRENGTHENING and not merely a reshuffle. A guard change that only relaxes is
  // worth nothing; this pins the exact input the old pattern admitted and the new one rejects, so a
  // future "simplification" back to a hard-coded member name fails here rather than in production.
  it("S6e strengthening: the OLD hard-coded `.r()` pattern accepted a re-pointed HIPAA export; the resolution does not", () => {
    const OLD_TRAILING = /\)&&![\w$]+\.r\(\)$/; // the 1.28929.0 pattern's trailing conjunct, verbatim
    const repointed = fixture1289290().replace("get:function(){return zGL}", "get:function(){return zRL}");
    // The mutated condition still ENDS in `&&!zA.r()`, so the old pattern is satisfied…
    const cond = repointed.match(/let zde=(\(N\?.*?)\;N&&/)![1];
    expect(OLD_TRAILING.test(cond)).toBe(true);
    // …while the export now resolves to a reader that never checks the restriction. New check fires.
    expect(checkSpawnContractFacts(repointed).join("\n")).toContain("S6c Artifact gate");
  });

  // B17 (Desktop 1.30096.1): the SAME predicate with the HIPAA reader renamed `zA.r()` -> `zt.hu()`.
  // Semantically identical (verified conjunct-by-conjunct against both asars); it hard-blocked `sync`
  // only because the old regex hard-coded the member name. This fixture is the regression test for that
  // false positive — if it ever goes red again, the member name has been re-hardcoded somewhere.
  const fixture1300961 = () =>
    fixture1289290()
      .replace(/&&!zA\.r\(\)/g, "&&!zt.hu()")
      .replace('Object.defineProperty(exports,"r",{', 'Object.defineProperty(exports,"hu",{');
  it("1.30096.1 build shape: the HIPAA reader renamed (A.r -> t.hu) stays CLEAN — member names rotate per build", () => {
    expect(checkSpawnContractFacts(fixture1300961())).toEqual([]);
  });

  // The fixtures above run in single-text mode, where resolveNamespaceRef falls back to searching the one
  // string — so they never exercise the `NS=require("./chunk-X.js")` hop that production actually depends
  // on (the reader lives in a DIFFERENT chunk from the spawn site). This one splits them across two files
  // so the cross-chunk resolution is really tested; without it that hop is asserted, not covered.
  it("1.30096.1 cross-chunk: the HIPAA reader resolves through the require() hop into another chunk", () => {
    const spawnChunk = fixture1300961().replace(HIPAA_DEF, "") + ';var zt=require("./index.chunk-HIPAA.js");';
    const files = new Map([
      ["index.chunk-spawn.js", spawnChunk],
      ["index.chunk-HIPAA.js", HIPAA_DEF.replace('exports,"r"', 'exports,"hu"')],
    ]);
    expect(checkSpawnContractFacts([...files.values()].join(""), files)).toEqual([]);
    // …and the hop must FAIL CLOSED when the target chunk no longer exports it.
    const broken = new Map(files);
    broken.set("index.chunk-HIPAA.js", HIPAA_DEF.replace('exports,"r"', 'exports,"somethingElse"'));
    expect(checkSpawnContractFacts([...broken.values()].join(""), broken).join("\n")).toContain("S6c Artifact gate");
  });

  // Back-compat: an asar with NO Artifact spread and NO env key stays clean — every committed baseline's
  // bundle predates 1.28929.0, so S6c/S6d must be inert there rather than newly failing.
  it("pre-1.28929.0 shape (no Artifact spread, no env key) stays clean", () => {
    expect(checkSpawnContractFacts(fixture())).toEqual([]);
    expect(checkSpawnContractFacts(fixture1201860())).toEqual([]);
  });

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

  // 1b2. Desktop 1.40609.0 extracted W2's inline 3p-entrypoint ternary into a hoisted helper
  // (`CLAUDE_CODE_ENTRYPOINT:uH(n.type)`). It is a pure refactor — same two literals, same predicate — so
  // derivation must be byte-identical. A body that is NOT that ternary must stay a hard fail rather than
  // resolve to whatever literal happens to be in it: the helper is the only thing vouching for the value.
  it("hoisted-entrypoint-helper regression: uH(n.type) derives the identical pin map; a foreign body hard-fails", () => {
    const INLINE = 'CLAUDE_CODE_ENTRYPOINT:t.type==="3p"?"claude-desktop-3p":"claude-desktop"';
    const HELPER = 'function FKep(e){return e==="3p"?"claude-desktop-3p":"claude-desktop"};';
    const hoisted = fixture().replace(INLINE, "CLAUDE_CODE_ENTRYPOINT:FKep(t.type)").replace("HEADER;", `HEADER;${HELPER}`);
    expect(hoisted).not.toBe(fixture()); // the mutation actually applied
    expect(hoisted).not.toContain(INLINE);
    const { env, flags } = deriveSpawnEnv(hoisted, greenGates());
    expect(flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
    expect(env).toEqual(EXPECTED_GREEN);

    // Same call site, helper body changed → unresolvable, not silently re-read as the old value.
    const foreign = hoisted.replace(HELPER, 'function FKep(e){return e==="3p"?"a":lookup(e)};');
    expect(foreign).not.toBe(hoisted);
    const bad = deriveSpawnEnv(foreign, greenGates());
    expect(bad.env).toBeNull();
    expect(bad.flags.some((f) => f.includes("CLAUDE_CODE_ENTRYPOINT") && f.includes("unrecognized value expression"))).toBe(true);

    // And with no helper in the bundle at all (the call site alone proves nothing).
    const missing = hoisted.replace(HELPER, "");
    const none = deriveSpawnEnv(missing, greenGates());
    expect(none.env).toBeNull();
    expect(none.flags.some((f) => f.includes("CLAUDE_CODE_ENTRYPOINT"))).toBe(true);
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
    ['...FKtt,"WebSearch","Skill","REPL","JavaScript","ToolSearch","mcp__mcp-registry__search_mcp_registry"', '...FKtt,"nope"]', "S9"],
    ['"ToolSearch","mcp__mcp-registry__search_mcp_registry"', '"ToolSearch","builtin__x"', "S10"],
    // S10b: an ADDITION deep inside the mcp__ region — the exact shape (Desktop 1.37937.0's
    // mcp__plugins__search_connectors) that S9's head anchor and S10's boundary anchor both let through.
    ['"mcp__skills__list_skills"', '"mcp__skills__list_skills","mcp__newserver__new_tool"', "S10b"],
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

  // 9c. Desktop 1.37937.0: the 3p-only deployment branch is classified PER SITE, not per key.
  //     The trigger was MCP_TOOL_TIMEOUT gaining a second construction site inside that branch while
  //     staying 1p-pinned from W1 — the per-key allowlist/pin dichotomy cannot express "pinned on one
  //     site, ignorable on another", and allowlisting it would have DROPPED the key from the env.
  describe("3p-only branch: classified by SITE (Desktop 1.37937.0)", () => {
    // The fixture's W3 really does carry the branch — asserting this first keeps every case below from
    // passing vacuously against a fixture that lost its `...t&&{DISABLE_GROWTHBOOK:...}` literal.
    it("the fixture carries a 3p branch for these cases to bite on", () => {
      expect(fixture()).toContain('...t&&{DISABLE_GROWTHBOOK:"1"');
    });

    it("a PINNED key with an unresolvable expression inside the 3p branch does NOT flag, and its 1p value survives", () => {
      // Exactly the live shape: `...i!==void 0&&{MCP_TOOL_TIMEOUT:String(i)}` appended to the 3p literal,
      // `i` a binding the const resolver cannot reach. W1 still builds MCP_TOOL_TIMEOUT from FKe().
      const withThirdPartySite = fixture().replace(
        'CLAUDE_CODE_ENABLE_AUTO_MODE:A.auto?"1":""}',
        'CLAUDE_CODE_ENABLE_AUTO_MODE:A.auto?"1":"",...i!==void 0&&{MCP_TOOL_TIMEOUT:String(i)}}',
      );
      expect(withThirdPartySite).not.toEqual(fixture()); // the mutation applied
      const { env, flags } = deriveSpawnEnv(withThirdPartySite, greenGates());
      expect(flags.filter((f) => !f.startsWith("NOTE:"))).toEqual([]);
      expect(env?.MCP_TOOL_TIMEOUT).toBe("60000"); // the W1 site's value, untouched by the 3p one
    });

    it("REGRESSION: without the per-site rule that same shape hard-fails — the rule is what is being tested", () => {
      // Same unresolvable expression placed OUTSIDE the 3p branch (top level of W3) must still flag, so
      // the case above is passing because of the branch, not because `String(i)` became resolvable.
      const topLevel = fixture().replace('return{DISABLE_AUTOUPDATER:"1",', 'return{DISABLE_AUTOUPDATER:"1",MCP_TOOL_TIMEOUT:String(i),');
      const { env, flags } = deriveSpawnEnv(topLevel, greenGates());
      expect(env).toBeNull();
      expect(flags.some((f) => f.includes("MCP_TOOL_TIMEOUT") && f.includes("unrecognized value expression"))).toBe(true);
    });

    it("an UNKNOWN key inside the 3p branch still hard-fails — the branch is not an amnesty", () => {
      const withNewKey = fixture().replace('DISABLE_GROWTHBOOK:"1",', 'DISABLE_GROWTHBOOK:"1",CLAUDE_CODE_BRAND_NEW_3P_KEY:"1",');
      const { env, flags } = deriveSpawnEnv(withNewKey, greenGates());
      expect(env).toBeNull();
      expect(flags.some((f) => f.includes("CLAUDE_CODE_BRAND_NEW_3P_KEY") && f.includes("3p-only deployment branch"))).toBe(true);
    });

    it("3p-branch keys stay ENUMERATED, so their allowlist entries do not read as stale prune candidates", () => {
      const { keys, flags } = deriveSpawnEnv(fixture(), greenGates());
      expect(keys).toContain("DISABLE_GROWTHBOOK");
      expect(keys).toContain("CLAUDE_CODE_ENABLE_AUTO_MODE");
      expect(flags.some((f) => f.startsWith("NOTE:") && f.includes("DISABLE_GROWTHBOOK"))).toBe(false);
    });

    it("the branch marker appearing in W1 flags instead of blanking — a silent key deletion is the worse failure", () => {
      // W1 is where every modeled 1p key comes from. If the marker ever shows up there, blanking would
      // delete real pinned keys from the derived env with nothing failing, so W1 refuses to blank.
      const inW1 = fixture().replace(
        'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1"',
        '...q&&{DISABLE_GROWTHBOOK:"1"},CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:"1"',
      );
      expect(inW1).not.toEqual(fixture());
      const { env, flags } = deriveSpawnEnv(inW1, greenGates());
      expect(flags.some((f) => f.includes("now appears in W1"))).toBe(true);
      expect(env).toBeNull(); // hard-fail, not a partial env
    });

    it("blanking the branch does not eat the 1p keys around it", () => {
      const { env } = deriveSpawnEnv(fixture(), greenGates());
      // Immediately before the 3p literal in W3; the only pinned key W3 contributes.
      expect(env?.DISABLE_AUTOUPDATER).toBe("1");
      // Set in the sibling non-3p spread that shares the `...<ident>&&{` shape.
      expect(env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    });
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
    const { env, flags } = deriveSpawnEnv(bundle, gates, readRealBundleFilesOrSkip() ?? undefined);
    expect(flags).toEqual([]);
    expect(env).toEqual(golden);
  });

  // 11. Structural-regression (non-circular): checkSpawnContractFacts over the REAL asar returns [] today.
  it("structural regression: checkSpawnContractFacts(real asar) is clean", () => {
    const bundle = readRealBundleOrSkip();
    if (!bundle) return;
    expect(checkSpawnContractFacts(bundle, readRealBundleFilesOrSkip() ?? undefined)).toEqual([]);
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

// Desktop 1.25927.0 split the bundle 101 → 341 chunks and mangled export names, so the cross-chunk
// resolvers need the per-chunk MAP, not just the joined text. Extraction is expensive, so the map is
// memoised alongside the joined string from the same extraction.
let realFilesMemo: Map<string, string> | null | undefined;
function readRealBundleFilesOrSkip(): Map<string, string> | null {
  if (realBundleMemo === undefined) realBundleMemo = extractRealBundle();
  return realFilesMemo ?? null;
}

function extractRealBundle(): string | null {
  const override = process.env.COWORK_ASAR_BUNDLE;
  if (override) {
    try {
      // Normalize the override the same way the production read does, so a bundle captured from a
      // backtick-emitting build behaves identically here.
      const one = normalizeBundleQuotes(readFileSync(override, "utf8"));
      realFilesMemo = new Map([["index.js", one]]);
      return one;
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
    realFilesMemo = readMainBundleFiles(realBundleTmpDir);
    return [...realFilesMemo.values()].join("");
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
// Desktop 1.32352.0's codegen escapes non-ASCII (`—` -> `\u2014`). The committed fingerprints hash the
// RAW template source — minifier-NAME-independent, but NOT escape-form-independent — so that change alone
// moved the prompt sha by +630 code points and BOTH sub-agent-append fingerprints, while the rendered text
// was byte-identical. A version pin that fires on a pure codegen change is a false alarm the maintainer
// has to hand-decode to dismiss.
describe("prompt fingerprints are escape-form independent", () => {
  const site = (body: string) => `cowork_system_prompt:{value:{prompt:zz};const zz=\`${body}\`;`;

  it("the RAW sha still moves when only the escape form changes (that is the false alarm)", () => {
    const a = extractPromptFingerprint(site("a—b"))!;
    const b = extractPromptFingerprint(site("a\\u2014b"))!;
    expect(a.sha256).not.toBe(b.sha256);
  });

  it("the DECODED sha does not move", () => {
    const a = extractPromptFingerprint(site("a—b"))!;
    const b = extractPromptFingerprint(site("a\\u2014b"))!;
    // Assert the SHAPE first: `undefined === undefined` would pass this vacuously before the field exists.
    expect(a.decodedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.decodedSha256).toBe(b.decodedSha256);
    expect(a.decodedCodePoints).toBe(b.decodedCodePoints);
    expect(a.decodedCodePoints).toBe(3); // "a—b" decoded
  });

  it("the DECODED sha still moves on a REAL content change", () => {
    const a = extractPromptFingerprint(site("a—b"))!;
    const c = extractPromptFingerprint(site("a—c"))!;
    expect(a.decodedSha256).not.toBe(c.decodedSha256);
  });
});

describe("prompt drift guard (H1-H3)", () => {
  // D8: the RENDERED prompt has not moved since 1.20186.0 — but its RAW sha has, twice, purely from
  // codegen (1.32352.0 began escaping non-ASCII). Pinning the raw sha here made this oracle a VERSION pin
  // wearing an invariant's clothes: it went red the day Desktop updated, for no product reason. The
  // decoded hash is the invariant it was always reaching for.
  const RENDERED_PROMPT_SHA = "a14592804dfc6728e855d3be17eeb40cef654aeb0bc6457487f5963dbedc7fdf";

  // Golden oracle (non-circular): extractPromptFingerprint over the REAL asar must match the
  // committed 1.20186.0 fingerprint entry exactly. Skips gracefully off-macOS / without a live
  // Desktop install (same readRealBundleOrSkip seam the spawn-contract oracles use).
  it("golden oracle: the RENDERED prompt in the real asar is unchanged since 1.20186.0", () => {
    const bundle = readRealBundleOrSkip();
    if (!bundle) return;
    const fp = extractPromptFingerprint(bundle);
    expect(fp).not.toBeNull();
    expect(fp!.decodedSha256).toBe(RENDERED_PROMPT_SHA);
    expect(fp!.decodedCodePoints).toBe(37811);
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
    decodedSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    decodedCodePoints: 100,
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

// ==========================================================================================
// The host-loop cwd SPLIT. Production keeps the agent process and the shell at DIFFERENT roots, and a
// single-value assertion cannot express that — which is how the harness ran bash at the outputs dir for
// two releases while believing it faithful. All three values are pinned in one place so a future edit
// cannot move one and leave the others.
//
// MEASURED on desktop-local Cowork 2026-08-27:
//   agent process / bare `Write` base : mnt/outputs      (Probes A, A2, B)
//   mcp__workspace__bash cwd          : /sessions/<id>   (Probes A and B — with AND without a folder)
//   {{cwd}} prompt token at hostloop  : mnt/outputs      (src/prompt.ts)
//
// Do NOT "fix" the agent cwd to match the shell. That was this investigation's first instinct and it is
// backwards: the file-tool base is correct, the shell was the wrong one.
// ==========================================================================================
// The deprecation window before `fidelity` becomes REQUIRED. The default models VM-LOOP while production
// runs HOST-LOOP by default (gate 1143815894 — per-account, read from the fcache, so never state it as a
// live fact), so an omitted key silently measures the wrong lane. Warn now,
// fail at the next major — consumers get told before they get an error.
// AUTHORED is not DELIVERED. The authored-file capture deliberately includes the scratchpad — the run did
// write those files — but production DISCARDS anything outside `mnt/` ("never reaches the user or your file
// tools"). Unlabelled, a rubric like "the report was written" grades TRUE on a file the user never receives.
// The distinction already rides in the synthetic `scratchpad/` path prefix; this makes it legible to the
// one evaluator that reads free-form prose and cannot infer the convention.
describe("judged document — scratch files are labelled as undelivered", () => {
  const doc = (files: { path: string; content: string }[]) =>
    buildJudgedDocument({
      transcript: [],
      finalMessage: "done",
      toolsCalled: [],
      result: "success",
      workRoot: "/w/session/mnt",
      authoredFiles: files,
    } as never);

  // `scratchpad` is not in RESERVED_MOUNT_NAMES, so a user can connect a folder with that exact name and
  // its files arrive as `scratchpad/…` — byte-identical to the synthetic walk prefix. Labelling those
  // tells the judge something FALSE about a file the user really does receive, which false-REDs a
  // "was it delivered?" rubric. A wrong claim is worse than a missing one.
  it("does NOT label when `scratchpad` is a real connected folder — the prefix collides", () => {
    const d = buildJudgedDocument({
      transcript: [],
      finalMessage: "done",
      toolsCalled: [],
      result: "success",
      workRoot: "/w/session/mnt",
      userVisiblePrefixes: ["outputs", "scratchpad"],
      authoredFiles: [{ path: "scratchpad/report.md", content: "the report" }],
    } as never);
    expect(d).toContain("scratchpad/report.md");
    expect(d).not.toContain("NOT delivered to the user");
    expect(d).not.toContain("## Note on scratch files");
  });

  it("marks a scratchpad file NOT delivered, and leaves a real deliverable unmarked", () => {
    const d = doc([
      { path: "outputs/report.md", content: "DELIVERED" },
      { path: "scratchpad/notes.txt", content: "SCRATCH" },
    ]);
    expect(d).toMatch(/## Authored file: scratchpad\/notes\.txt — SCRATCH, NOT delivered/);
    expect(d, "a real deliverable must not be tagged").toMatch(/## Authored file: outputs\/report\.md\n/);
  });

  it("explains the tag, so the judge cannot read SCRATCH as delivery evidence", () => {
    const d = doc([{ path: "scratchpad/notes.txt", content: "x" }]);
    expect(d).toMatch(/Note on scratch files/);
    expect(d, "must say what it is NOT evidence of").toMatch(/NOT evidence that anything was delivered/);
  });

  it("adds no note when nothing was written to scratch — no noise on the common case", () => {
    expect(doc([{ path: "outputs/report.md", content: "x" }])).not.toMatch(/Note on scratch files/);
  });
});

describe("defaulted fidelity — the deprecation notice", () => {
  it("detects the OMITTED key, and does not fire when the tier was chosen deliberately", () => {
    expect(fidelityWasDefaulted({ prompt: "x" })).toBe(true);
    // The load-bearing half: Zod's .default() makes these two indistinguishable AFTER parse, so the
    // detector must read the RAW document. An author who wrote `fidelity: container` has made the choice
    // and must not be nagged.
    expect(fidelityWasDefaulted({ prompt: "x", fidelity: "container" })).toBe(false);
    expect(fidelityWasDefaulted({ prompt: "x", fidelity: "hostloop" })).toBe(false);
  });

  it("is inert on a non-object document rather than throwing", () => {
    expect(fidelityWasDefaulted(null)).toBe(false);
    expect(fidelityWasDefaulted("not-a-doc")).toBe(false);
  });

  // A deprecation notice that does not say what to do, or why, trains people to ignore it.
  it("names the lane mismatch, the gate, every remedy, and the deprecation", () => {
    const m = defaultedFidelityNotice("my-scenario");
    expect(m).toContain("my-scenario");
    expect(m, "must say which lane the default models").toMatch(/VM-LOOP/);
    expect(m, "must say which lane production runs").toMatch(/HOST-LOOP/);
    expect(m, "must cite the gate, so the claim is checkable").toMatch(/1143815894/);
    expect(m, "must offer the production-matching tier").toMatch(/fidelity: hostloop/);
    expect(m, "must offer the auto-picking tier").toMatch(/fidelity: cowork/);
    expect(m, "must let an author keep today's behaviour deliberately").toMatch(/fidelity: container/);
    expect(m, "must announce the removal, or it is just a nag").toMatch(/REQUIRED in the next major/);
  });
});

describe("host-loop cwd split (agent at outputs, shell at the session root)", () => {
  const ROOT = "/sessions/abc";
  const OUT = "/run/work/session/mnt/outputs";

  it("the agent process resolves relative file-tool paths at OUTPUTS", () => {
    expect(hostLoopCwds(ROOT, OUT).agentProcessCwd).toBe(OUT);
  });

  it("mcp__workspace__bash starts at the bare SESSION ROOT — not outputs, not a connected folder", () => {
    expect(hostLoopCwds(ROOT, OUT).workspaceBashCwd).toBe(ROOT);
  });

  it("the two are DIFFERENT — collapsing them is the defect, so assert the split itself", () => {
    const { agentProcessCwd, workspaceBashCwd } = hostLoopCwds(ROOT, OUT);
    expect(agentProcessCwd).not.toBe(workspaceBashCwd);
  });

  // The pre-2026-08-27 value. Pinned as a NEGATIVE so a revert cannot pass quietly: it was derived from
  // the asar's `cwd: c.vmCwd` spawn argument, which is not load-bearing on the cowork path (only the
  // `chat` branch prepends an explicit `cd`, which would be redundant if it worked).
  it("REGRESSION: the shell cwd is never a connected folder or outputs, with or without folders", () => {
    expect(hostLoopCwds(ROOT, OUT).workspaceBashCwd).not.toMatch(/\/mnt\//);
    expect(hostLoopCwds(ROOT, `${ROOT}/mnt/outputs`).workspaceBashCwd).toBe(ROOT);
    expect(hostLoopCwds(ROOT, `${ROOT}/mnt/project`).workspaceBashCwd).toBe(ROOT);
  });

  // The third value. `{{cwd}}` must track the AGENT cwd, not the shell — a swap is the sentinel-failing
  // drift the sub-agent asset calls out explicitly.
  it("the {{cwd}} prompt token tracks the AGENT cwd at hostloop, not the shell", () => {
    const rendered = renderPrompts(loadBaseline("latest") as never, { model: "claude-opus-4-8" } as never, "abc", undefined, {
      effectiveFidelity: "hostloop",
      hostCwd: OUT,
    } as never);
    const sys = JSON.stringify(rendered);
    expect(sys).toContain(OUT);
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
  it("ON → exactly one message (routed to notes, non-blocking — see the severity test below)", () => {
    const flags = checkSubagentOverrideGate(gate(true));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatch(/subagentPromptServerOverride/);
    expect(flags[0]).toMatch(/override/i);
  });

  // The message must not overclaim. Gate-ON is NECESSARY but NOT SUFFICIENT: the asar reads the section
  // entry and falls back to the built-in text when it is missing or empty, and the entry is delivered
  // per-session by the server — invisible to every input `sync` reads. The old wording asserted the
  // override "is active", a fact this command cannot establish, which sends the reader hunting for a
  // Desktop change that does not exist (the gate flipped via source:"defaultValue" with the asar
  // byte-identical, 1.37937.1 -> .3).
  // The downgrade to a warning is only defensible while the message carries the evidence that justified
  // it AND its limits. A future edit that trims either turns a measured judgement back into a guess.
  it("ON → the message carries the live-probe evidence AND states it is not proof", () => {
    const m = checkSubagentOverrideGate(gate(true))[0];
    expect(m, "the downgrade must cite what was measured").toMatch(/probed live 2026-08-27/);
    expect(m, "must name the tier/branch probed — a vm-branch probe would not license this").toMatch(/hl branch/);
    expect(m, "one account is not a population").toMatch(/EVIDENCE, NOT PROOF/);
    expect(m, "must say a server rule can be segment-targeted").toMatch(/segment-targeted/);
    expect(m, "must tell the reader how to re-establish it").toMatch(/re-probe/);
  });

  it("ON → the message says CANNOT TELL, not 'is active', and names the fallback + the live-probe remedy", () => {
    const m = checkSubagentOverrideGate(gate(true))[0];
    expect(m, "must not assert an unestablished fact").not.toMatch(/override is active/i);
    expect(m, "must say the sync cannot distinguish the two states").toMatch(/CANNOT TELL/);
    expect(m, "must name the fallback path, or the reader over-reads the gate").toMatch(/hardcoded fallback/);
    expect(m, "must say it is server-side so nobody diffs asars for it").toMatch(/version-INDEPENDENT/);
    expect(m, "must name the only remedy that can settle it").toMatch(/dispatch a sub-agent/);
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

/** The Desktop 1.32352.0 install shape: a BLOCK-bodied arrow wrapping the `??` chain in a pre-pass that
 *  can deny before any link, and a post-pass that can overturn the chain's ALLOW. */
function blockBodyInstall(): string {
  return (
    `async function ss(e,n,r){if(e!=="Artifact")return null;const s=async x=>x;` +
    `if(String(n.file_path).startsWith("/sessions"))return{vmPathDeny:{behavior:"deny",message:"is a VM path. In this session the Artifact tool publishes from the host filesystem"},finish:s};` +
    `const f=await stat(n.file_path);return{finish:async x=>x&&f?x:{behavior:"deny",message:"changed"}}}` +
    `const Se=e.canUseTool;Se&&(e.canUseTool=async(g,S,k)=>{` +
    `const a=await ss(g,S,d);` +
    `if(a?.vmPathDeny)return a.vmPathDeny;` +
    `const o=xe(g,S)??await Xt(g,S,k.decisionReason,j,f)??Qt(g,S,k.decisionReason,n)??await Se(g,S,k);` +
    `return a===null?o:a.finish(o)});`
  );
}

function pathHookFiles(mut: Partial<Record<"defining" | "consuming", (s: string) => string>> = {}): Map<string, string> {
  let defining =
    `const g5e=["Read","Write","Edit","Glob","Grep"],p5e=["Bash","PowerShell","NotebookEdit","REPL","JavaScript","WebFetch"],Jse="request_cowork_directory",Bse="chat";` +
    // resolveFilePath lives in the SHARED/defining chunk — its two hard-block strings are here, NOT in
    // the hostloop consumer (which only carries the caller-side "could not be safely resolved").
    `function JKe(p){throw new Error("Refusing to resolve non-regular file")||new Error("Failed to resolve path")}` +
    // B18: a REAL containment helper, exported under a MANGLED name. The old fixture exported it as the
    // readable `isPathContainedInFolders` and called it by that name — a token that appears ZERO times in
    // any real asar — which is precisely what kept the dead early-allow check looking green. The sentinel
    // now identifies this helper by SHAPE (realpath + relative + ".."), so the fixture must have one.
    `function Nce(e,t){for(const r of t){const p=realpath(r);const i=relative(p,e);if(!i.startsWith(".."))return!0}return!1}` +
    `export{g5e as HOST_LOOP_PATH_GATED_BUILTIN_TOOLS,p5e as HOST_LOOP_EXCLUDED_BUILTIN_TOOLS,Jse as REQUEST_COWORK_DIRECTORY,Bse as SESSION_TYPE_CHAT,Nce as Po,JKe as resolveFilePath};`;
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
    `if(!t.Po(cand,lt))return ct?"is outside this session's scratch directory, so \${e}":"is outside this session's connected folders, so \${e}"}]}],` +
    // The chain links must actually EXIST — the old fixture referenced `Qt` without defining it, so every
    // per-link assertion had nothing to resolve. `Xt` is the 1.30096.1 auto-memory carve-out: `async`, and
    // the only link that can return an allow, which is what the await-on-async and ordering rules pin.
    `function Qt(e,o,r,n){return r===Zt?{behavior:"deny",message:"outside"}:{behavior:"deny",message:"protected"}}` +
    `async function Xt(e,o,r,i,a){if(i===null||r!==Zt)return;if(!await t.Po(o.file_path,[i]))return;return{behavior:"allow",updatedInput:o}}` +
    `const Se=e.canUseTool;Se&&(e.canUseTool=async(g,S,k)=>xe(g,S)??await Xt(g,S,k.decisionReason,j,f)??Qt(g,S,k.decisionReason,n)??Se(g,S,k));`;
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

  // The synthetic fixture uses READABLE export names, so it cannot see a release that mangles them —
  // which is how Desktop 1.32352.0 reached `sync` with every path-hook anchor reporting "gone" and not
  // one red test. checkSpawnContractFacts and checkMountModeFacts both have a real-asar regression;
  // this is the one that was missing.
  it("structural regression: the REAL asar is clean", () => {
    const files = readRealBundleFilesOrSkip();
    if (!files) return;
    expect(checkPathHookFacts(files)).toEqual([]);
  });

  // Desktop 1.32352.0 restructured the install: the `??` chain is now inside a BLOCK body, wrapped by a
  // pre-pass that can deny before every link and a post-pass that can turn the chain's ALLOW into a DENY.
  // Teaching the extractor the block shape without anchoring the wrapper would silence three flags and
  // leave both new decision points invisible — the B16/B18 failure mode.
  const blockFiles = (mutate?: (s: string) => string) =>
    pathHookFiles({
      consuming: (c) => {
        const swapped = c.replace(/const Se=e\.canUseTool;[\s\S]*$/, blockBodyInstall());
        return mutate ? mutate(swapped) : swapped;
      },
    });

  it("block-bodied install with pre/post-pass → no flags", () => {
    expect(checkPathHookFacts(blockFiles())).toEqual([]);
  });

  it("MUTATION: the pre-pass is not awaited → flags", () => {
    // `ss` is async, so an un-awaited call yields a Promise: `a?.vmPathDeny` is undefined and
    // `a.finish` is not a function. The VM-path deny silently stops applying.
    expect(checkPathHookFacts(blockFiles((s) => s.replace("const a=await ss(", "const a=ss("))).length).toBeGreaterThan(0);
  });

  it("MUTATION: the post-pass is bypassed → flags", () => {
    expect(checkPathHookFacts(blockFiles((s) => s.replace("return a===null?o:a.finish(o)", "return o"))).length).toBeGreaterThan(0);
  });

  it("MUTATION: the pre-pass loses its VM-path deny → flags", () => {
    expect(
      checkPathHookFacts(
        blockFiles((s) => s.replace("is a VM path. In this session the Artifact tool publishes from the host filesystem", "nope")),
      ).length,
    ).toBeGreaterThan(0);
  });
  it("MUTATION: gated set membership changed → flags", () => {
    const f = pathHookFiles({ defining: (s) => s.replace(`"Grep"]`, `"Grep","Bash"]`) });
    expect(checkPathHookFacts(f).length).toBeGreaterThan(0);
  });
  it("MUTATION: a deny text reworded → flags (each text is its OWN anchor)", () => {
    const f = pathHookFiles({ consuming: (s) => s.replace("connected folders, so", "attached folders, so") });
    expect(checkPathHookFacts(f).some((x) => /connected folders/.test(x))).toBe(true);
  });
  // B17/B18 mutation matrix. The old chain anchor was a PREFIX match, so an inserted SYNCHRONOUS link
  // passed silently; and the early-allow ordering check searched for a token absent from every real asar,
  // so it had never fired. Each row below is a way the permission chain could widen. Every one must be
  // loud — a guard that cannot fail is worth nothing, which is exactly what these two were.
  const CHAIN_MUT: ReadonlyArray<readonly [string, (s: string) => string, string]> = [
    // THE headline regression: an async link that is not awaited returns a Promise, which is never
    // nullish, so `??` short-circuits and EVERY later link — both denies and the original callback — is
    // skipped. One deleted keyword is a total permission bypass, and the old anchor allowed it.
    ["D1 await dropped from the async link", (s) => s.replace("??await Xt(", "??Xt("), "canUseTool chain await"],
    // Count preserved, meaning changed: an operand that is not a plain call can hide a blanket allow.
    [
      "D2 `||` blanket-allow inside a parenthesised operand",
      (s) => s.replace("await Xt(g,S,k.decisionReason,j,f)", "(Ye(g,S)||await Xt(g,S,k.decisionReason,j,f))"),
      "canUseTool chain operand",
    ],
    [
      "D3 ternary blanket-allow operand",
      (s) => s.replace("await Xt(g,S,k.decisionReason,j,f)", '(k.decisionReason?await Xt(g,S,k.decisionReason,j,f):{behavior:"allow"})'),
      "canUseTool chain operand",
    ],
    // Ordering — the ASAR analysis' own stated risk. Nothing else in this file would notice a reorder.
    [
      "D4 allow link moved ahead of the /sessions VM-path deny",
      (s) => s.replace("xe(g,S)??await Xt(g,S,k.decisionReason,j,f)", "await Xt(g,S,k.decisionReason,j,f)??xe(g,S)"),
      "canUseTool chain order",
    ],
    [
      "D5 link swapped for an unresolvable one (count preserved)",
      (s) => s.replace("await Xt(g,S,k.decisionReason,j,f)", "await Zq(g,S,k.decisionReason,j,f)"),
      "canUseTool chain operand",
    ],
    [
      "D6 terminal wrapped so fall-through becomes an allow",
      (s) => s.replace("??Se(g,S,k))", '??(Se(g,S,k)??{behavior:"allow"}))'),
      "canUseTool chain terminal",
    ],
    // The install guard: `\1` binds the `&&` to the SAVED ORIGINAL, so a renamed guard is unconditional.
    [
      "D7 install guard re-pointed at another identifier",
      (s) => s.replace("const Se=e.canUseTool;Se&&(", "const Se=e.canUseTool;zz&&("),
      "conditional canUseTool install",
    ],
    [
      "D8 a FIFTH link inserted (synchronous — the old prefix anchor absorbed this)",
      (s) => s.replace("??Se(g,S,k))", "??Nw(g,S)??Se(g,S,k))"),
      "canUseTool chain shape",
    ],
    // B18: the early-allow shape the ordering check exists to catch, now that it can actually fire.
    [
      "D9 containment call hoisted ahead of the category guard",
      (s) => s.replace("if(qt(g))return qt(g);", "if(!t.Po(cand,lt))return;if(qt(g))return qt(g);"),
      "qt-before-containment order",
    ],
    // Must replace EVERY call: the auto-memory link runs its own containment check inside the same slice,
    // so mutating only the hook-body call leaves the helper resolvable — correctly producing no flag.
    [
      "D10 containment helper no longer resolvable anywhere in the hook",
      (s) => s.split("t.Po(").join("t.Unresolvable("),
      "containment helper",
    ],
  ];
  it.each(CHAIN_MUT)("chain mutation %s fails loud (%#)", (_label, mutate, expected) => {
    const flags = checkPathHookFacts(pathHookFiles({ consuming: mutate }));
    expect(flags.join("\n")).toContain(expected);
  });

  // Proof the chain rebuild is a STRENGTHENING. The old anchor was a prefix match, so it accepted an
  // inserted synchronous link AND an un-awaited async link — the two mutations that matter most. Pinning
  // that here means a future "simplification" back to a single regex fails in CI, not in production.
  it("B17 strengthening: the OLD prefix anchor accepted D1/D8; the rebuilt chain check rejects both", () => {
    const OLD = /canUseTool=async\([^)]*\)=>[\w$]+\([^)]*\)\?\?[\w$]+\([^)]*\)\?\?[\w$]+\(/;
    // D8 is expressed against the THREE-link chain that actually shipped through 1.28929.0: that is the
    // build on which a silently-inserted synchronous link was reachable. (On the 4-link chain the old
    // anchor already fails on the `await`, so mutating it would prove nothing.)
    const dropAwait = (s: string) => s.replace("??await Xt(", "??Xt(");
    const threeLink = (s: string) => s.replace("xe(g,S)??await Xt(g,S,k.decisionReason,j,f)??", "xe(g,S)??");
    for (const [label, mutate] of [
      ["D1 await dropped", dropAwait],
      ["D8 synchronous link inserted into the 3-link chain", (s: string) => threeLink(s).replace("??Se(g,S,k))", "??Nw(g,S)??Se(g,S,k))")],
    ] as const) {
      const files = pathHookFiles({ consuming: mutate });
      const consuming = [...files.values()][1];
      expect(OLD.test(consuming), `${label}: the old anchor should have accepted this`).toBe(true);
      expect(checkPathHookFacts(files).length, `${label}: the new check must reject it`).toBeGreaterThan(0);
    }
  });

  // Back-compat: the 3-link shape shipped through Desktop 1.28929.0. A maintainer on an older install
  // (rollback, staged update, second machine) must still sync, so the chain check must accept 3 links.
  it("back-compat: the pre-1.30096.1 three-link chain stays clean", () => {
    const three = pathHookFiles({
      consuming: (s) => s.replace("xe(g,S)??await Xt(g,S,k.decisionReason,j,f)??", "xe(g,S)??"),
    });
    expect(checkPathHookFacts(three)).toEqual([]);
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
  it("MUTATION: excluded set reverted to the pre-1.24012.9 5-element form (PowerShell dropped) → flags", () => {
    // Pins the 1.24012.9 addition specifically. The append-mutation above would still pass against a
    // loosened regex; this one fails it, so the new member can't be quietly un-pinned.
    const f = pathHookFiles({ defining: (s) => s.replace(`"Bash","PowerShell",`, `"Bash",`) });
    expect(checkPathHookFacts(f).some((x) => /excluded set/.test(x))).toBe(true);
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

// ==========================================================================================
// Desktop 1.25927.0 changed the BUNDLER, not the product: plain string literals became backtick
// templates, export names were mangled to 1-2 chars, and the graph split 101 -> 341 chunks. That
// voided 22 literal anchors at once. These tests pin the two mechanisms that absorb it — quote
// normalization and scoped cross-chunk export resolution — and, crucially, prove the widened guards
// STILL FAIL on a real violation rather than having been loosened into rubber stamps.
// ==========================================================================================
describe("1.25927.0 bundler change: normalizeBundleQuotes", () => {
  it("rewrites a substitution-free backtick string to the double-quoted form", () => {
    expect(normalizeBundleQuotes("settingSources:[`user`],a:`b`")).toBe('settingSources:["user"],a:"b"');
  });

  it("keeps an interpolated template a template, but normalizes strings INSIDE its ${}", () => {
    // The CLAUDE_CODE_TAGS shape: the outer template must survive (the value deriver matches on it),
    // while the nested plain string inside the interpolation has to be normalized.
    expect(normalizeBundleQuotes("`lam_session_type:${i.sessionType??`chat`}`")).toBe('`lam_session_type:${i.sessionType??"chat"}`');
  });

  it("does not mis-pair backticks across an interpolated template (the naive-regex defect)", () => {
    // A naive /`([^`]*)`/g pairs the CLOSING backtick of the template with the OPENING backtick of the
    // NEXT string, corrupting both. This exact input produced a false "settingSources is gone".
    expect(normalizeBundleQuotes("`a${x}b`,settingSources:[`user`]")).toBe('`a${x}b`,settingSources:["user"]');
  });

  it("leaves double-quoted strings, comments and regex literals untouched", () => {
    const src = 'a="keep",b=/`notastring`/g,c=1;//`nor this`\n';
    expect(normalizeBundleQuotes(src)).toBe(src);
  });

  it("does not convert a template containing a double quote (would produce nested quotes)", () => {
    expect(normalizeBundleQuotes('x=`say "hi"`')).toBe('x=`say "hi"`');
  });

  it("is idempotent", () => {
    const once = normalizeBundleQuotes("k:[`a`],t:`p${q}`");
    expect(normalizeBundleQuotes(once)).toBe(once);
  });

  it("preserves a multi-line template body verbatim (prompt bodies must not move)", () => {
    const src = "x=`line1\nline2`";
    expect(normalizeBundleQuotes(src)).toBe(src);
  });

  // Desktop 1.32352.0 defect A: the `${…}` expression scanner knew about "…", '…' and `…` but not
  // REGEX literals, so a quote inside one opened a phantom string and flipped quote parity for the
  // whole rest of the chunk. Live trigger: the POSIX shell single-quote escaper below, present since
  // Desktop 1.25927.0. The trailing literal is the observable: it must still normalize.
  it("does not desync on a regex literal containing a quote inside an interpolation", () => {
    expect(normalizeBundleQuotes('x=`${a.replace(/\'/g,"")}`,k:[`user`]')).toContain('k:["user"]');
  });

  it("does not desync on the production shell-quote escaper", () => {
    const src = "d=`'${t.replace(/'/g,`'\\\\''`)}'`,k:[`user`]";
    expect(normalizeBundleQuotes(src)).toContain('k:["user"]');
  });

  // Desktop 1.32352.0 defect B: REGEX_OK holds only punctuation, so a regex in a KEYWORD context read
  // as division. Live trigger: `return/unable to access '[^']*':…/i` — the apostrophes then opened a
  // phantom string. The keyword list must be matched on a word boundary (see the `remain/512` case).
  it("treats a regex after a keyword as a regex, not division", () => {
    expect(normalizeBundleQuotes("function f(){return/ab'cd/i.test(x)}k:[`user`]")).toContain('k:["user"]');
  });

  it("still treats division after an identifier ENDING in a keyword as division (remain/2 … a/b)", () => {
    // A naive /(return|…|in|…)$/ matches the "in" at the end of "remain". The SECOND slash is what
    // makes that mis-detection bite: the phantom regex then closes and swallows the `x` template.
    // Mutation-verified — drop the `[^\w$.]` boundary from REGEX_KEYWORD and this case fails.
    expect(normalizeBundleQuotes("v=remain/2,s=`x`,t=a/b;k:[`user`]")).toContain('s="x"');
  });

  it("still treats division inside an interpolation as division", () => {
    expect(normalizeBundleQuotes("t=`${(a)/b/c}`,k:[`user`]")).toContain('k:["user"]');
  });

  // Desktop 1.32352.0 defect C: a substitution-free TAGGED template was rewritten into a string, which
  // is a SEMANTIC change (the tag stops being called) and leaves text that no longer parses. Live in
  // the asar as `(0,t._)`{}`` and `String.raw`https://…``.
  it("does not rewrite a TAGGED template into a string", () => {
    expect(normalizeBundleQuotes("x=(0,t._)`abc`,k:[`user`]")).toBe('x=(0,t._)`abc`,k:["user"]');
  });

  it("does not rewrite a String.raw tagged template", () => {
    expect(normalizeBundleQuotes("u=String.raw`a/b`,k:[`user`]")).toBe('u=String.raw`a/b`,k:["user"]');
  });

  it("still rewrites a plain template that FOLLOWS a keyword (not a tag)", () => {
    expect(normalizeBundleQuotes("function f(){return`ok`}")).toBe('function f(){return"ok"}');
  });
});

// ==========================================================================================
// PARSER ORACLE for normalizeBundleQuotes (Desktop 1.32352.0).
//
// The unit cases above are hand-picked shapes. This is the ground-truth check: normalization is
// only correct if a real JS parser agrees that (a) the output is still valid JavaScript, and
// (b) it still contains exactly the same string content as the input. A desync that reads code as
// a string literal breaks BOTH — it mints string values that were never in the source.
//
// Why this exists: Desktop 1.32352.0's `sync` reported 32 unknown deltas, 21 of which were a single
// tokenizer desync — and the desync also MASKED four real flags. Spot-checking that one known key
// normalized was the check in place at the time; it stayed green through two of the three defects.
// ==========================================================================================
// The oracle above needs a live Desktop install, so it never runs in CI — and `sync` is the command a
// maintainer actually runs first when a release lands (docs/maintenance.md's runbook opens with
// `sync --diff`). checkNormalizationSanity is the in-`sync` tripwire for the same failure, and taking
// BOTH maps keeps it a pure function: these cases need no asar at all.
describe("checkNormalizationSanity — in-sync tokenizer tripwire", () => {
  it("flags a chunk whose normalized text stopped parsing", () => {
    const raw = new Map([["a.js", "x=`ok`"]]);
    const bad = new Map([["a.js", 'x=(0,t._)"ok"']]); // what a desync/tagged-template rewrite leaves behind
    expect(checkNormalizationSanity(raw, bad)[0]).toMatch(/a\.js/);
  });

  it("stays silent when the RAW chunk does not parse either — not our damage to own", () => {
    // A future Desktop could ship syntax this acorn does not know. Failing closed on that would block
    // every sync for a reason that has nothing to do with the tokenizer.
    const raw = new Map([["a.js", "x=<<<not js>>>"]]);
    const out = new Map([["a.js", "x=<<<not js>>>"]]);
    expect(checkNormalizationSanity(raw, out)).toEqual([]);
  });

  it("stays silent on a correct rewrite", () => {
    const raw = new Map([["a.js", "k:[`user`]"]]);
    const out = new Map([["a.js", 'k:["user"]']]);
    expect(checkNormalizationSanity(raw, out)).toEqual([]);
  });
});

describe("normalizeBundleQuotes — parser oracle against the real asar", () => {
  /** Every string value the source contains, from BOTH string literals and template cooked pieces.
   *  Normalization converts a substitution-free template into a string with the identical cooked
   *  value, so this multiset is invariant under correct normalization. */
  function stringValues(src: string): string[] {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      const n = node as Record<string, unknown> & { type?: string };
      if (n.type === "Literal" && typeof n.value === "string") out.push(n.value);
      if (n.type === "TemplateLiteral")
        for (const q of n.quasis as Array<{ value: { cooked: string | null } }>) out.push(q.value.cooked ?? "");
      for (const k in n) {
        if (k === "type" || k === "start" || k === "end") continue;
        walk(n[k]);
      }
    };
    walk(acorn.parse(src, { ecmaVersion: "latest" }));
    return out.sort();
  }

  it("every chunk still parses, and mints no string value that was not in the source", () => {
    if (!readRealBundleFilesOrSkip()) return; // skip-guard: no macOS / no Desktop install
    if (!realBundleTmpDir) return; // COWORK_ASAR_BUNDLE override path has no raw chunk dir
    const buildDir = join(realBundleTmpDir, ".vite/build");
    const failures: string[] = [];
    let checked = 0;
    for (const f of readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const raw = readFileSync(join(buildDir, f), "utf8");
      let before: string[];
      try {
        before = stringValues(raw);
      } catch {
        continue; // the RAW chunk does not parse under this acorn — not our damage to own
      }
      checked++;
      const out = normalizeBundleQuotes(raw);
      let after: string[];
      try {
        after = stringValues(out);
      } catch (e) {
        failures.push(`${f}: normalized output does not parse — ${(e as Error).message}`);
        continue;
      }
      if (before.length !== after.length) {
        const minted = after.filter((v) => !before.includes(v)).slice(0, 2);
        failures.push(`${f}: string count ${before.length} -> ${after.length}; e.g. minted ${JSON.stringify(minted)}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    // Explicit budget: this parses ~12 MB of bundle TWICE (raw + normalized). It lands around 3-4 s on
    // an idle machine but exceeded vitest's 5 s default under full-suite load, which reads as a failing
    // guard rather than a slow one. 60 s is ~15x headroom, so a real hang still fails.
  }, 60_000);
});

describe("1.25927.0 bundler change: exportLocalOf / resolveNamespaceRef", () => {
  it("resolves the mangled CJS-interop export shape", () => {
    const chunk = 'var B=["TaskCreate"];Object.defineProperty(exports,"vt",{enumerable:!0,get:function(){return B}});';
    expect(exportLocalOf(chunk, "vt")).toBe("B");
  });

  it("resolves the readable arrow export shape", () => {
    expect(exportLocalOf("x={HOST_LOOP_PATH_GATED_BUILTIN_TOOLS:()=>Se,z:()=>q}", "HOST_LOOP_PATH_GATED_BUILTIN_TOOLS")).toBe("Se");
  });

  it("follows a require() binding from the reference chunk to the defining chunk", () => {
    const defining = 'var V=[];Object.defineProperty(exports,"i",{enumerable:!0,get:function(){return V}});';
    const site = 'var E=require("./index.chunk-DEF.js");tools:[...E.i]';
    const files = new Map([
      ["index.chunk-DEF.js", defining],
      ["index.chunk-SITE.js", site],
    ]);
    const ref = resolveNamespaceRef("E.i", site, files);
    expect(ref?.local).toBe("V");
    expect(ref?.chunk).toBe(defining);
  });

  it("returns null when the namespace is unbound and the export is absent — never a silent wrong hop", () => {
    // The pre-fix behaviour hopped on a bare 1-2 char name across the joined bundle and captured an
    // unrelated `f=`; that mis-resolution is what wrongly reported "resolved to null not 31999".
    expect(resolveNamespaceRef("E.nope", 'var E=require("./missing.js");', new Map())).toBeNull();
  });
});

describe("1.25927.0 bundler change: MUTATION — widened guards still fail on real violations", () => {
  const realFiles = () => readRealBundleFilesOrSkip();
  const joined = (f: Map<string, string>) => [...f.values()].join("");
  // Mutate the chunk that DEFINES a fact, keeping the reference site intact, so the assertion is
  // exercised through the same cross-chunk resolution path production uses.
  // Mutates the FIRST occurrence in the FIRST matching chunk — which silently stops being a mutation the
  // moment the needle also matches somewhere harmless. That is not hypothetical: Desktop 1.30096.1
  // re-chunked the bundle 347 -> 107 files, co-locating the S14a `for(let x of[…])` helper with an
  // unrelated array containing the same three names, so the mutation began landing on the decoy while the
  // guarded construct stayed intact — and the test failed with no indication of why.
  //
  // So an ambiguous needle now THROWS instead of quietly mutating the wrong site. `null` still means
  // "not found" (a different failure the callers already assert on). All three current needles were
  // counted in both builds and are unique; this keeps the next co-location loud rather than mysterious.
  const mutateDefining = (f: Map<string, string>, needle: string, replacement: string): Map<string, string> | null => {
    let total = 0;
    for (const v of f.values()) total += v.split(needle).length - 1;
    if (total > 1) {
      throw new Error(
        `mutateDefining: needle occurs ${total}x across the bundle — it would mutate only the first and may miss the guarded site. ` +
          `Make it specific to the construct under test. Needle: ${needle.slice(0, 80)}`,
      );
    }
    const out = new Map(f);
    for (const [k, v] of f) {
      if (v.includes(needle)) {
        out.set(k, v.replace(needle, replacement));
        return out;
      }
    }
    return null;
  };

  it("MUTATION: the Task-tools array changes in its defining chunk → S7 flags", () => {
    const f = realFiles();
    if (!f) return;
    const m = mutateDefining(f, '["TaskCreate","TaskUpdate","TaskGet","TaskList","TaskStop"]', '["TaskCreate","TaskUpdate"]');
    expect(m).not.toBeNull();
    expect(checkSpawnContractFacts(joined(m!), m!).some((x) => /S7 Task-tools spread/.test(x))).toBe(true);
  });

  it("MUTATION: maxThinkingTokens const changes in its defining chunk → S4 flags", () => {
    const f = realFiles();
    if (!f) return;
    const m = mutateDefining(f, "=31999", "=12345");
    expect(m).not.toBeNull();
    expect(checkSpawnContractFacts(joined(m!), m!).some((x) => /S4 maxThinkingTokens/.test(x))).toBe(true);
  });

  it("MUTATION: the empty-ANTHROPIC_* delete helper removed → S14a flags (the let-widening did not blunt it)", () => {
    const f = realFiles();
    if (!f) return;
    // Needle scoped to the `of[…]` head so it targets the delete helper S14a actually guards. The bare
    // triple is NOT unique — an unrelated array carries the same three names, and since 1.30096.1 both
    // live in one chunk, so the bare needle mutated the decoy and this test failed while S14a was fine.
    const m = mutateDefining(f, 'of["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS"]', 'of["SOMETHING_ELSE"]');
    expect(m).not.toBeNull();
    expect(checkSpawnContractFacts(joined(m!), m!).some((x) => /S14a/.test(x))).toBe(true);
  });

  it("MUTATION: the gated 5-set changes → path-hook install-site spread flags", () => {
    const f = realFiles();
    if (!f) return;
    const m = mutateDefining(f, '["Read","Write","Edit","Glob","Grep"]', '["Read","Write"]');
    expect(m).not.toBeNull();
    expect(checkPathHookFacts(m!).some((x) => /gated 5-set|install site spread/.test(x))).toBe(true);
  });

  it("MUTATION: the shared resolver's hard-block text removed → path-hook flags (graph-wide search still binds)", () => {
    const f = realFiles();
    if (!f) return;
    const m = mutateDefining(f, "Refusing to resolve non-regular file", "Allowing anything at all");
    expect(m).not.toBeNull();
    expect(checkPathHookFacts(m!).some((x) => /resolver hard-block/.test(x))).toBe(true);
  });

  it("MUTATION: MCP_TOOL_TIMEOUT's inline numeric fallback changes → the derived value follows it", () => {
    const f = realFiles();
    if (!f) return;
    const gates = decodeFcacheGates();
    if (!gates) return;
    // `mcpToolTimeoutMs??18e4` is NOT unique — it reads twice in the same chunk, once in the plain
    // default reader (`<f>()?.mcpToolTimeoutMs??18e4`) and once in the per-tool override reader
    // (`t?.mcpToolTimeoutOverridesMs?.[e]??t?.mcpToolTimeoutMs??18e4`), in BOTH 1.28929.0 and 1.30096.1.
    // The `()?.` prefix selects the default reader (the one the derived value follows) without depending
    // on the minified accessor name. Pre-existing ambiguity, surfaced by mutateDefining's uniqueness check.
    const m = mutateDefining(f, "()?.mcpToolTimeoutMs??18e4", "()?.mcpToolTimeoutMs??7e4");
    expect(m).not.toBeNull();
    const { env } = deriveSpawnEnv(joined(m!), gates, m!);
    // Proves the literal is genuinely RESOLVED, not hardcoded or waved through by the shape check.
    expect(env?.MCP_TOOL_TIMEOUT).toBe("70000");
  });
});

// ==========================================================================================
// fcache snapshot identity. The payload refetches irregularly and its membership churns
// count-neutrally, so `capturedAt` (a date) cannot identify a read. `content16` can — provided it is
// computed the same way everywhere, which is what these pin.
// ==========================================================================================
describe("fcacheContentHash — snapshot identity", () => {
  // PAYLOAD-level, not function-level. Comparing `f(x)` to `f({...x})` cannot fail for any
  // deterministic function and proves nothing — the claim under test is that two REAL payloads which
  // differ only in their fetch timestamp share an identity, which is what makes content16 usable as one.
  it("ignores the fetch timestamp: two payloads differing ONLY in timestamp share a content16", () => {
    const features = { "1143815894": { value: true, on: true, source: "force" } };
    const write = (timestamp: number) => {
      const gz = gzipSync(Buffer.from(JSON.stringify({ timestamp, features }), "utf8"));
      const dir = mkdtempSync(join(tmpdir(), "cowork-fcache-prov-"));
      const f = join(dir, "fcache");
      writeFileSync(f, Buffer.concat([Buffer.from([0x43, 0x4c, 0x46, 0x01, 0, 0, 0, 0]), gz]));
      return f;
    };
    const a = decodeFcacheProvenance(write(1_000))!;
    const b = decodeFcacheProvenance(write(9_999))!;
    expect(a.content16).toBe(b.content16); // identity: unchanged
    expect(a.embeddedTimestamp).not.toBe(b.embeddedTimestamp); // metadata: moved
    expect(a.featureCount).toBe(1);
  });

  it("changes when a gate's VALUE changes", () => {
    const a = { "123": { on: true, source: "force" } };
    const b = { "123": { on: false, source: "force" } };
    expect(fcacheContentHash(a)).not.toBe(fcacheContentHash(b));
  });

  it("changes when MEMBERSHIP churns count-neutrally (one in, one out)", () => {
    // The real 2026-08-05 case: 4074604942 arrived, 2403605075 left, count pinned at 241 both times.
    const before = { "4074604942": undefined as unknown, "2403605075": { on: true } };
    delete (before as Record<string, unknown>)["4074604942"];
    const after = { "4074604942": { on: false } };
    expect(Object.keys(before).length).toBe(Object.keys(after).length); // count-neutral
    expect(fcacheContentHash(before)).not.toBe(fcacheContentHash(after));
  });

  it("REGRESSION: integer-like keys sort lexicographically, not numerically", () => {
    // Gate ids are integer-like strings. A JS object enumerates those in ascending NUMERIC order
    // regardless of insertion order, so canonicalising by rebuilding an object (Object.fromEntries over
    // sorted pairs) silently discards the sort — the first implementation did exactly that and produced
    // a self-consistent but cross-project-incomparable hash. Python's sort_keys is LEXICOGRAPHIC:
    // "1004628546" sorts BEFORE "17519066". Pinned against the reference implementation's output.
    expect(fcacheContentHash({ "17519066": 1, "1004628546": 2 })).toBe(
      // sha256('{"1004628546":2,"17519066":1}')[:16] — lexicographic order
      createHash("sha256").update('{"1004628546":2,"17519066":1}', "utf8").digest("hex").slice(0, 16),
    );
  });

  // The cross-language guarantee is scoped: strings/bools/null/arrays/nesting/ordering agree, NUMBERS
  // do not (JSON has one number type, Python has two — a payload's `1.0` is indistinguishable from `1`
  // after JSON.parse, and the same applies to exponent form and ints past 2^53). These pin the classes
  // that DO agree, so a regression in them is caught; the number classes are documented, not asserted.
  it("escapes non-ASCII to \\uXXXX, matching Python's ensure_ascii default", () => {
    expect(fcacheContentHash({ k: "café" })).toBe(createHash("sha256").update('{"k":"caf\\u00e9"}', "utf8").digest("hex").slice(0, 16));
  });

  it("escapes DEL (U+007F) — Python escapes everything outside PRINTABLE ascii, not just >= U+0080", () => {
    expect(fcacheContentHash({ a: "\u007f" })).toBe(createHash("sha256").update('{"a":"\\u007f"}', "utf8").digest("hex").slice(0, 16));
  });

  it("decodeFcacheProvenance returns null rather than throwing when there is no fcache", () => {
    expect(decodeFcacheProvenance(join(tmpdir(), "cowork-harness-no-such-fcache"))).toBeNull();
  });
});

// ==========================================================================================
// coworkSyspromptMap — a SERVER-DRIVEN system-prompt patch channel the harness models nowhere.
// `replace` mode discards the computed default section, so an active replace variant is a structural
// divergence from our preset-plus-append model. Sentinel only: we cannot see what the server serves,
// but we can pin the shape that determines what it is ABLE to do.
// ==========================================================================================
describe("checkMountModeFacts — hardcoded mount modes", () => {
  // The spawn-time mount builder assembles the whole set: outputs and each connected folder go through
  // the delete-deny resolver (`rw`, or `rwd` once approved); everything else is pinned `"ro"` inline.
  // A mount silently moving from `ro` to writable is a containment change we would otherwise model
  // wrongly with nothing failing, so each is pinned individually.
  const CLEAN =
    'p[r.a("uploads")]={path:x,mode:"ro"},p[r.a(".claude/skills")]={path:y,mode:"ro"};' +
    'p[r.a(".claude/projects")]={path:z,mode:"ro"};' +
    'p[r.a(`.projects/${e.uuid}`)]={path:w,mode:"ro"};' +
    'let m=n?"rw":t?.includes(e)?"rwd":"rw";' +
    // Second lane (host-loop computeBashMounts) — the checker floors on the SITE COUNT, see `ok` above.
    'let mb=n?"rw":t?.includes(e)?"rwd":"rw";';

  it("clean bundle → no flags", () => {
    expect(checkMountModeFacts(CLEAN)).toEqual([]);
  });

  it.each([
    [".projects/<uuid>", ".projects/${", ".projectsX/${"],
    [".claude/projects", '(".claude/projects")]', '(".claude/projectsX")]'],
    [".claude/skills", '(".claude/skills")]', '(".claude/skillsX")]'],
    ["uploads", '("uploads")]', '("uploadsX")]'],
    // Both lanes — the floor is a count, so removing one site is the SEPARATE case pinned below.
    ["delete-deny resolver", '?"rwd":"rw"', '?"rw":"rw"'],
  ])("MUTATION: %s moving → flags", (_label, from, to) => {
    const mutated = CLEAN.split(from).join(to);
    expect(mutated).not.toBe(CLEAN); // the mutation actually applied — a no-op mutation proves nothing
    expect(checkMountModeFacts(mutated).length).toBeGreaterThan(0);
  });

  it("structural regression: the REAL asar is clean", () => {
    const files = readRealBundleFilesOrSkip();
    if (!files) return;
    expect(checkMountModeFacts([...files.values()].join(""))).toEqual([]);
  });

  // The real bundle builds each of these mounts at TWO sites — the VM-loop mount-set builder and
  // host-loop `computeBashMounts`. A `regex.test(bundle)` is satisfied by EITHER, so a one-lane
  // `ro`→`rw` flip (a containment change on exactly one execution tier) used to pass green. These pin
  // the every-site rule; the single-site CLEAN fixture above cannot express the case at all.
  describe("both lanes: one-site flips are caught (single-anchor hole)", () => {
    const TWO_LANE = CLEAN + CLEAN.replace('let m=n?"rw":t?.includes(e)?"rwd":"rw";', "");

    it("a two-lane bundle with both sites read-only is clean", () => {
      expect(checkMountModeFacts(TWO_LANE)).toEqual([]);
    });

    it.each([
      ["uploads", '("uploads")]'],
      [".claude/skills", '(".claude/skills")]'],
      [".projects/<uuid>", ".projects/${e.uuid}`)]"],
    ])("MUTATION: %s writable on the FIRST lane only → flags", (_label, anchor) => {
      const i = TWO_LANE.indexOf(anchor);
      const j = TWO_LANE.indexOf('mode:"ro"', i);
      const mutated = TWO_LANE.slice(0, j) + 'mode:"rw"' + TWO_LANE.slice(j + 'mode:"ro"'.length);
      expect(mutated).not.toBe(TWO_LANE);
      expect(checkMountModeFacts(mutated).some((f) => f.includes("one execution lane's mount became writable"))).toBe(true);
    });

    it.each([
      ["uploads", '("uploads")]'],
      [".claude/skills", '(".claude/skills")]'],
      [".projects/<uuid>", ".projects/${e.uuid}`)]"],
    ])("MUTATION: %s writable on the SECOND lane only → flags", (_label, anchor) => {
      const i = TWO_LANE.lastIndexOf(anchor);
      const j = TWO_LANE.indexOf('mode:"ro"', i);
      const mutated = TWO_LANE.slice(0, j) + 'mode:"rw"' + TWO_LANE.slice(j + 'mode:"ro"'.length);
      expect(mutated).not.toBe(TWO_LANE);
      expect(checkMountModeFacts(mutated).some((f) => f.includes("one execution lane's mount became writable"))).toBe(true);
    });

    // The delete-deny resolver had the same single-anchor shape and the same two-lane reality. The
    // whole-string mutation in STRUCT_MUT removes BOTH sites; this is the case that motivated the floor.
    it("MUTATION: ONE lane loses the delete-deny resolver → flags on the floor", () => {
      const i = CLEAN.indexOf('?"rwd":"rw"');
      const mutated = CLEAN.slice(0, i) + '?"rw":"rw"' + CLEAN.slice(i + '?"rwd":"rw"'.length);
      expect(mutated).not.toBe(CLEAN);
      expect(mutated.split('?"rwd":"rw"').length - 1).toBe(1); // exactly one site left — a one-lane loss
      expect(checkMountModeFacts(mutated).some((f) => f.includes("below the pinned floor"))).toBe(true);
    });

    it("a lane GAINING the resolver is benign and must not flag", () => {
      const extra = CLEAN + 'let mc=n?"rw":t?.includes(e)?"rwd":"rw";';
      expect(checkMountModeFacts(extra)).toEqual([]);
    });
  });
});

// ==========================================================================================
// Failability of the remaining asar sentinels.
//
// `extractFromAsar` runs eight checkers over the bundle and they are ALL green on both the current
// baseline's asar and the previous one — so a green carries no release-specific information unless the
// checker is known to bite. checkSpawnContractFacts, checkPathHookFacts and checkMountModeFacts each
// have a mutation suite above; these are the other five, which had none.
//
// Two traps these are written around:
//   - A SUFFIX rename is not a mutation. `buildRequestWebFetchApproval` -> `…ApprovalZ` still satisfies
//     a substring regex, so the "mutation" passes while proving nothing. Every edit below changes an
//     INNER character.
//   - Every case asserts the mutation actually applied (`mut` throws on a no-op), because a mutation
//     that silently matched nothing reads as "the checker is redundant".
// ==========================================================================================
describe("asar sentinels — the remaining five are failable", () => {
  const realFiles = () => readRealBundleFilesOrSkip();

  const mutate = (files: Map<string, string>, from: string, to: string): Map<string, string> => {
    const out = new Map([...files].map(([k, v]) => [k, v.split(from).join(to)] as [string, string]));
    const before = [...files.values()].join("");
    const after = [...out.values()].join("");
    expect(after, `mutation was a no-op — "${from}" is not in the bundle`).not.toBe(before);
    return out;
  };

  it.each([
    ["checkCodeTripwires", "getMcpSkillSources()", "getMcpSkillSXurces()", /getMcpSkillSources not found/],
    ["checkWebFetchFacts", "buildRequestWebFetchApproval", "buildRequestWebFXtchApproval", /per-domain approval/],
    [
      "checkEgressContractFacts (E1)",
      "vmEgressPolicy(){return null}",
      "vmEgressPolicy(){return nXll}",
      /1p .*vmEgressPolicy.* branch is gone/,
    ],
    ["checkSyspromptMapFacts", "coworkSyspromptMap", "coworkSyspromptMXp", /channel anchor missing/],
  ])("MUTATION: %s flags", (name, from, to, expected) => {
    const files = realFiles();
    if (!files) return;
    const mutated = mutate(files, from, to);
    const bundle = [...mutated.values()].join("");
    const flags =
      name === "checkCodeTripwires"
        ? checkCodeTripwires(bundle)
        : name === "checkWebFetchFacts"
          ? checkWebFetchFacts(bundle)
          : name === "checkSyspromptMapFacts"
            ? checkSyspromptMapFacts(mutated)
            : checkEgressContractFacts(bundle);
    expect(
      flags.some((f) => expected.test(f)),
      `flags were: ${JSON.stringify(flags)}`,
    ).toBe(true);
  });

  // checkNormalizationSanity needs no real bundle: its whole contract is the RAW/NORMALIZED pair, and it
  // is deliberately FAIL-SOFT — it reports only when the raw parses and the normalized does not, so that
  // syntax this acorn cannot parse reads as "not our damage" instead of blocking every sync.
  it("MUTATION: checkNormalizationSanity flags a normalized chunk that stopped parsing", () => {
    expect(checkNormalizationSanity(new Map([["x.js", "const a=1;"]]), new Map([["x.js", "const a=;"]]))).toHaveLength(1);
  });
  it("checkNormalizationSanity stays silent when the RAW chunk does not parse either (fail-soft)", () => {
    expect(checkNormalizationSanity(new Map([["x.js", "const a=;"]]), new Map([["x.js", "const b=;"]]))).toEqual([]);
  });
  it("checkNormalizationSanity ignores a chunk normalization left untouched", () => {
    expect(checkNormalizationSanity(new Map([["x.js", "const a=;"]]), new Map([["x.js", "const a=;"]]))).toEqual([]);
  });
});

describe("checkSyspromptMapFacts — prompt-patch channel sentinel", () => {
  const CLEAN = new Map([
    [
      "chunk.js",
      'x.coworkSyspromptMap;function fn(e){return e==="replace"||e==="append"}' +
        "var re=/^[A-Za-z0-9_-]{1,128}(\\.(replace|append))?$/;" +
        "throw Error(`SP_VARIANTS.${e}: replace-mode text must contain {{promptCacheBoundary}}`);" +
        'return{status:"missing_boundary"};return{status:"invalid_entry"};',
    ],
  ]);

  it("clean bundle → no flags", () => {
    expect(checkSyspromptMapFacts(CLEAN)).toEqual([]);
  });

  it("MUTATION: a THIRD mode appears → mode-predicate flags", () => {
    const m = new Map(CLEAN);
    m.set("chunk.js", CLEAN.get("chunk.js")!.replace('e==="append"}', 'e==="append"||e==="prepend"}'));
    expect(checkSyspromptMapFacts(m).some((f) => /mode predicate/.test(f))).toBe(true);
  });

  it("MUTATION: the key grammar moves → flags", () => {
    const m = new Map(CLEAN);
    m.set("chunk.js", CLEAN.get("chunk.js")!.replace("(replace|append)", "(replace|append|prepend)"));
    expect(checkSyspromptMapFacts(m).some((f) => /key grammar/.test(f))).toBe(true);
  });

  it("MUTATION: the promptCacheBoundary startup invariant is dropped → flags", () => {
    const m = new Map(CLEAN);
    m.set("chunk.js", CLEAN.get("chunk.js")!.replace("replace-mode text must contain {{promptCacheBoundary}}", "ok"));
    expect(checkSyspromptMapFacts(m).some((f) => /boundary invariant/.test(f))).toBe(true);
  });

  it("MUTATION: the resolution status machine disappears → flags (the SILENT failure half)", () => {
    // The startup throw guards only BUILT-IN variants; a malformed SERVER-supplied variant degrades to
    // `missing_boundary` with no error raised anywhere. If that classification goes, the quiet path
    // gets quieter still — which for a fidelity harness means a silently different prompt.
    const m = new Map(CLEAN);
    m.set("chunk.js", CLEAN.get("chunk.js")!.replace('return{status:"missing_boundary"};', ""));
    expect(checkSyspromptMapFacts(m).some((f) => /resolution status/.test(f))).toBe(true);
  });

  it("MUTATION: the channel disappears entirely → flags once, and does NOT vacuously pass", () => {
    const flags = checkSyspromptMapFacts(new Map([["chunk.js", "unrelated();"]]));
    expect(flags.length).toBe(1);
    expect(flags[0]).toMatch(/channel/);
  });

  it("structural regression: the REAL asar is clean", () => {
    const files = readRealBundleFilesOrSkip();
    if (!files) return;
    expect(checkSyspromptMapFacts(files)).toEqual([]);
  });
});

import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { compareBaselineVersions, loadBaseline, resolveAgentBinary, resolveMounts, sha256File } from "../src/baseline.js";
import { createHash } from "node:crypto";
import type { PlatformBaseline } from "../src/types.js";
import { decodeFcacheGates, sync, checkMountModeFacts, checkWebFetchFacts } from "../src/sync/cowork-sync.js";
import {
  deriveSpawnEnv,
  checkSpawnContractFacts,
  canonicalizeEnv,
  partitionSpawnFlags,
  resolveConst,
  REQUIRED_SPAWN_KEYS,
  type GateState,
} from "../src/sync/cowork-sync.js";
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
  const fixture = () => `HEADER;${W3};${W2};${W1}${STIER};TAIL`;

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
    expect(deriveSpawnEnv(fixture(), null)).toEqual({ env: null, flags: [] });
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
    return readFileSync(join(realBundleTmpDir, ".vite/build/index.js"), "utf8");
  } catch (e) {
    return skipRealBundle(`asar extraction failed: ${(e as Error).message}`);
  }
}

afterAll(() => {
  if (realBundleTmpDir) rmSync(realBundleTmpDir, { recursive: true, force: true });
});

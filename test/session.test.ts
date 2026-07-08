import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import {
  loadSession,
  buildLaunchPlan,
  resolveSessionPaths,
  applySessionOverrides,
  readonlyFolderRootsFromPlan,
  pluginSkillRootsFromPlan,
} from "../src/session.js";
import { parseSessionFile } from "../src/run/execute.js";
import { agentArgs } from "../src/runtime/argv.js";
import { Scenario } from "../src/types.js";

const baseline = loadBaseline("desktop-1.11847.5");

function plan(sessionObj: unknown) {
  const out = mkdtempSync(join(tmpdir(), "cowork-test-"));
  const session = loadSession(sessionObj);
  return { plan: buildLaunchPlan(session, baseline, out), out };
}

describe("mount / path safety", () => {
  it("a folder whose derived name is an unsafe segment is rejected", () => {
    // `to:` was removed (no Cowork analog) — names are always derived from the basename. A `from` whose
    // basename is unsafe (e.g. "..") must still be rejected by safePathSegment on the derived name.
    expect(() => plan({ folders: [{ from: "./examples/data/project/.." }] })).toThrow(/unsafe folder/);
  });
  it("duplicate mount destinations fail before staging", () => {
    expect(() => plan({ uploads: ["./examples/data/report.pdf", "./examples/data/report.pdf"] })).toThrow(/duplicate mount destination/);
  });
  it("a missing mount source fails by default (no silent skip)", () => {
    expect(() => plan({ uploads: ["./does/not/exist.pdf"] })).toThrow(/source\(s\) not found/);
  });
  it("COWORK_HARNESS_SOFT_MISSING downgrades to warn-and-exclude", () => {
    const prev = process.env.COWORK_HARNESS_SOFT_MISSING;
    process.env.COWORK_HARNESS_SOFT_MISSING = "1";
    try {
      const { plan: p } = plan({ uploads: ["./does/not/exist.pdf"], folders: [{ from: "./examples/data/project" }] });
      const paths = p.mounts.map((m) => m.mountPath);
      expect(paths).not.toContain("uploads/exist.pdf"); // missing source excluded
      // legacy baseline (1.11847.5) → derived `.projects/<basename>`; `to:` removed
      expect(paths).toContain(".projects/project"); // present source kept
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_SOFT_MISSING;
      else process.env.COWORK_HARNESS_SOFT_MISSING = prev;
    }
  });
  it("pinning config_dir to an EXISTING dir is rejected without the opt-in", () => {
    const existing = mkdtempSync(join(tmpdir(), "cowork-cfg-"));
    expect(() => plan({ plugins: { config_dir: existing } })).toThrow(/COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE/);
  });
  it("pinning config_dir to a FILE fails with a clear not-a-directory error (even with the write opt-in)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cowork-cfg-"));
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const prev = process.env.COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE;
    process.env.COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE = "1"; // past the existing-dir guard; must still reject a file
    try {
      expect(() => plan({ plugins: { config_dir: file } })).toThrow(/exists but is not a directory/);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE;
      else process.env.COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE = prev;
    }
  });
  it("extended_thinking is a real boolean, default ON", () => {
    expect(loadSession({}).extended_thinking).toBe(true);
    expect(loadSession({ extended_thinking: true }).extended_thinking).toBe(true);
    expect(loadSession({ extended_thinking: false }).extended_thinking).toBe(false);
  });
  it("debug.max_thinking_tokens is a fenced escape hatch — rejects non-positive, accepts positive", () => {
    expect(() => loadSession({ debug: { max_thinking_tokens: 0 } })).toThrow();
    expect(() => loadSession({ debug: { max_thinking_tokens: -5 } })).toThrow();
    expect(loadSession({ debug: { max_thinking_tokens: 50000 } }).debug.max_thinking_tokens).toBe(50000); // positive ok
    expect(loadSession({}).debug.max_thinking_tokens).toBeUndefined(); // omitted by default
  });
  it("a legacy top-level `max_thinking_tokens` gets a targeted removal hint, not an opaque schema error", () => {
    expect(() => loadSession({ max_thinking_tokens: 8000 })).toThrow(/max_thinking_tokens.*removed/s);
    expect(() => loadSession({ max_thinking_tokens: 8000 })).toThrow(/extended_thinking/);
    expect(() => loadSession({ max_thinking_tokens: 8000 })).toThrow(/debug\.max_thinking_tokens/);
  });
});

describe("session-id / resume argv (persistence — leverages the agent's native --resume)", () => {
  const M = { mntRoot: "/sessions/x/mnt" };
  it("emits NO session flag by default (goldens unchanged)", () => {
    const { plan: p } = plan({});
    const a = agentArgs(baseline, p, M);
    expect(a).not.toContain("--session-id");
    expect(a).not.toContain("--resume");
  });
  it("pins --session-id <uuid> when a session is requested", () => {
    const { plan: p } = plan({});
    const a = agentArgs(baseline, { ...p, agentSessionId: "uuid-1" }, M);
    expect(a[a.indexOf("--session-id") + 1]).toBe("uuid-1");
    expect(a).not.toContain("--resume");
  });
  it("emits --resume <uuid> (not --session-id) when resuming", () => {
    const { plan: p } = plan({});
    const a = agentArgs(baseline, { ...p, agentSessionId: "uuid-1", resume: true }, M);
    expect(a[a.indexOf("--resume") + 1]).toBe("uuid-1");
    expect(a).not.toContain("--session-id");
  });
});

describe("readonlyFolderRootsFromPlan (T3 — mode:r inputs get a body-less cassette capture)", () => {
  it("returns only the mode:r folder's mount path, excluding a rw folder and uploads", () => {
    const { plan: p } = plan({
      uploads: ["./examples/data/report.pdf"], // uploads are kind:"upload", never a folder root
      folders: [{ from: "./examples/data/project", mode: "r" }, { from: "./examples/skills/my-pdf-skill" /* default rw */ }],
    });
    const roots = readonlyFolderRootsFromPlan(p);
    const roFolderMountPath = p.mounts.find((m) => m.hostPath.endsWith("project"))!.mountPath;
    expect(roots).toEqual([roFolderMountPath]);
    // sanity: the rw folder and the upload are NOT read-only roots
    expect(roots).not.toContain(p.mounts.find((m) => m.hostPath.endsWith("my-pdf-skill"))!.mountPath);
    expect(roots.every((r) => !r.startsWith("uploads/"))).toBe(true);
  });

  it("is empty when no folder is mode:r", () => {
    const { plan: p } = plan({ folders: [{ from: "./examples/data/project" }] });
    expect(readonlyFolderRootsFromPlan(p)).toEqual([]);
  });
});

describe("pluginSkillRootsFromPlan (§6.2, O1 fix — whenToUse enrichment source roots)", () => {
  it("a local-plugin mount with a `.claude-plugin/plugin.json` {name, skills} reads the manifest's name + skills subdir", () => {
    const { plan: p } = plan({ plugins: { local_plugins: ["./examples/skills/my-pdf-skill"] } });
    const roots = pluginSkillRootsFromPlan(p);
    expect(roots).toHaveLength(1);
    expect(roots[0].pluginName).toBe("my-pdf-skill");
    expect(roots[0].skillsSubdir).toBe("skills");
    expect(roots[0].hostPath.endsWith("my-pdf-skill")).toBe(true);
  });

  it('falls back to the dir basename + a "skills" subdir when the plugin has no manifest', () => {
    const noManifest = mkdtempSync(join(tmpdir(), "cwh-noplugin-manifest-"));
    const { plan: p } = plan({ plugins: { local_plugins: [noManifest] } });
    const roots = pluginSkillRootsFromPlan(p);
    expect(roots).toHaveLength(1);
    expect(roots[0].pluginName).toBe(basename(noManifest));
    expect(roots[0].skillsSubdir).toBe("skills");
  });
});

describe("buildLaunchPlan", () => {
  it("mounts uploads, projects and plugins at the Cowork paths", () => {
    const { plan: p } = plan({
      uploads: ["./examples/data/report.pdf"],
      folders: [{ from: "./examples/data/project" }],
      plugins: { local_plugins: ["./examples/skills/my-pdf-skill"] },
    });
    const paths = p.mounts.map((m) => m.mountPath);
    expect(paths).toContain("uploads/report.pdf");
    // legacy baseline (1.11847.5) → derived `.projects/<basename>` (no `to:`)
    expect(paths).toContain(".projects/project");
    expect(paths.some((x) => x.startsWith(".local-plugins/cache/"))).toBe(true);
  });

  it("resolves marketplace plugins to the three-level cache path `<marketplace>/<plugin>/<version>`", () => {
    const mk = mkdtempSync(join(tmpdir(), "cowork-mkt-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    mkdirSync(join(mk, "withver", ".claude-plugin"), { recursive: true });
    mkdirSync(join(mk, "nover", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(mk, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "mymkt",
        plugins: [
          { name: "withver", source: "./withver" },
          { name: "nover", source: "./nover" },
        ],
      }),
    );
    writeFileSync(join(mk, "withver", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "withver", version: "1.2.3" }));
    writeFileSync(join(mk, "nover", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "nover" })); // no version → 0.0.0
    const { plan: p } = plan({ plugins: { local_marketplaces: [mk], enabled: ["withver@mymkt", "nover@mymkt"] } });
    expect(p.pluginDirs).toContain(".local-plugins/cache/mymkt/withver/1.2.3");
    expect(p.pluginDirs).toContain(".local-plugins/cache/mymkt/nover/0.0.0"); // version fallback
  });

  it("splits `enabled` on the LAST @ so an embedded @ in the plugin name survives", () => {
    const mk = mkdtempSync(join(tmpdir(), "cowork-mkt-at-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    mkdirSync(join(mk, "st", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(mk, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "mymkt", plugins: [{ name: "scope@thing", source: "./st" }] }),
    );
    writeFileSync(join(mk, "st", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "scope@thing", version: "2.0.0" }));
    const { plan: p } = plan({ plugins: { local_marketplaces: [mk], enabled: ["scope@thing@mymkt"] } });
    expect(p.pluginDirs).toContain(".local-plugins/cache/mymkt/scope@thing/2.0.0");
  });

  it("dedupes a BARE enabled name defined in multiple marketplaces to a single mount", () => {
    const mkOne = (label: string) => {
      const mk = mkdtempSync(join(tmpdir(), `cowork-mkt-${label}-`));
      mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
      mkdirSync(join(mk, "dup", ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(mk, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name: label, plugins: [{ name: "dup", source: "./dup" }] }),
      );
      writeFileSync(join(mk, "dup", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dup", version: "1.0.0" }));
      return mk;
    };
    const { plan: p } = plan({ plugins: { local_marketplaces: [mkOne("mktA"), mkOne("mktB")], enabled: ["dup"] } });
    const dupMounts = p.pluginDirs.filter((d) => d.includes("/dup/"));
    expect(dupMounts).toHaveLength(1); // bare name mounts once, not once-per-marketplace
  });

  it("resolveSessionPaths resolves a relative local marketplace path but leaves a git URL untouched", () => {
    const s = loadSession({ plugins: { marketplaces: ["./local-mkt", "https://example.com/m.git"] } });
    const r = resolveSessionPaths(s, "/base/dir");
    expect(r.plugins.marketplaces[0]).toBe("/base/dir/local-mkt");
    expect(r.plugins.marketplaces[1]).toBe("https://example.com/m.git");
  });

  it("E: a committed session file's relative local_plugins resolves against the FILE's own dir (repo-relative mount)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-sess-"));
    writeFileSync(join(d, "session.yaml"), "plugins:\n  local_plugins:\n    - ../skills/cap-table\n");
    const s = resolveSessionPaths(loadSession(parseSessionFile(join(d, "session.yaml"))), d);
    expect(s.plugins.local_plugins[0]).toBe(resolve(d, "../skills/cap-table"));
  });

  it("a scenario omitting `session:` defaults to the all-defaults inline session (not a missing file)", () => {
    expect(Scenario.parse({ name: "x", baseline: "latest", fidelity: "protocol", prompt: "hi" }).session).toBe("(inline)");
  });

  it("writes discovery knobs into CLAUDE_CONFIG_DIR/settings.json", () => {
    const { plan: p } = plan({
      plugins: { enabled: ["x@local"], marketplaces: ["https://example.com/m.git"] },
      mcp: { enabled: ["y"] },
    });
    const settings = JSON.parse(readFileSync(join(p.configDir, "settings.json"), "utf8"));
    expect(settings.enabledPlugins).toEqual({ "x@local": true });
    expect(settings.extraKnownMarketplaces).toEqual({ m: { source: { source: "git", url: "https://example.com/m.git" } } });
    expect(settings.enabledMcpjsonServers).toEqual(["y"]);
  });

  it("extraKnownMarketplaces key matches the @marketplace qualifier derived from the git URL (round-trip)", () => {
    const { plan: p } = plan({
      plugins: { enabled: ["foo@m"], marketplaces: ["https://example.com/m.git"] },
    });
    const settings = JSON.parse(readFileSync(join(p.configDir, "settings.json"), "utf8"));
    // derived name = basename("https://example.com/m.git").replace(/.git$/, "") = "m"
    // enabledPlugins key "@m" references "m", which matches the extraKnownMarketplaces key "m"
    expect(Object.keys(settings.enabledPlugins)).toEqual(["foo@m"]);
    expect(Object.keys(settings.extraKnownMarketplaces)).toEqual(["m"]);
  });

  it("maps model/effort/permission/extended-thinking", () => {
    const { plan: p } = plan({
      model: "claude-opus-4-8",
      effort: "high",
      extended_thinking: false,
      permission_mode: "acceptEdits",
    });
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.permissionMode).toBe("acceptEdits");
    // effort/thinking are plan fields, passed as CLI flags at L1/L2 — NOT baseEnv vars (CLAUDE_EFFORT
    // is a no-op; real Cowork sets no MAX_THINKING_TOKENS env, only the --max-thinking-tokens/--thinking
    // flag).
    expect(p.effort).toBe("high");
    expect(p.extendedThinking).toBe(false);
    expect(p.debugMaxThinkingTokens).toBeUndefined();
    expect(p.baseEnv.MAX_THINKING_TOKENS).toBeUndefined();
  });

  it("resolves the fenced debug.max_thinking_tokens escape hatch onto the plan", () => {
    const { plan: p } = plan({ debug: { max_thinking_tokens: 50000 } });
    expect(p.debugMaxThinkingTokens).toBe(50000);
    expect(p.extendedThinking).toBe(true); // default ON, independent of the debug override
  });

  it("computes the egress allowlist from baseline + session, and honors unrestricted", () => {
    const { plan: a } = plan({ egress: { extra_allow: ["api.github.com"] } });
    expect(a.egressAllow).toContain("api.github.com");
    expect(a.egressAllow).toContain("api.anthropic.com");
    const { plan: b } = plan({ egress: { unrestricted: true } });
    expect(b.egressAllow).toEqual(["*"]);
  });

  it("SPEC §7 buildLaunchPlan output snapshot (mounts/pluginDirs/egressAllow, volatile paths normalized)", () => {
    const { plan: p } = plan({
      uploads: ["./examples/data/report.pdf"],
      folders: [{ from: "./examples/data/project" }],
      plugins: { local_plugins: ["./examples/skills/my-pdf-skill"] },
      egress: { extra_allow: ["api.github.com"] },
    });
    expect({
      mounts: p.mounts.map((m) => ({ mountPath: m.mountPath, mode: m.mode })),
      pluginDirs: p.pluginDirs,
      egressAllow: p.egressAllow,
      model: p.model,
      permissionParity: p.permissionParity,
    }).toMatchSnapshot();
  });

  it("applies Cowork's bg-env-strip", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "secret";
    const { plan: p } = plan({});
    expect(p.baseEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
});

describe("effort — per-model validation (reasoning-config fidelity, Phase 1)", () => {
  // The 1.19367.0 baseline carries the full four-class spawn.effortByModel/effortRegexDefault map
  // (Phase 0); the default test baseline (1.11847.5) predates it and is used for the class-4 checks.
  const modern = loadBaseline("desktop-1.19367.0");
  function modernPlan(sessionObj: unknown) {
    const out = mkdtempSync(join(tmpdir(), "cowork-effort-test-"));
    return buildLaunchPlan(loadSession(sessionObj), modern, out);
  }

  it("`extra` normalizes to `xhigh` on the wire (loadSession)", () => {
    expect(loadSession({ effort: "extra" }).effort).toBe("xhigh");
    expect(loadSession({ effort: "high" }).effort).toBe("high");
    expect(loadSession({}).effort).toBeUndefined();
  });

  it("class 1 (picker model): an offered level is accepted", () => {
    const p = modernPlan({ model: "claude-opus-4-8", effort: "xhigh" });
    expect(p.effort).toBe("xhigh");
  });

  it("class 1 (picker model): a level the model doesn't offer throws, naming the supported levels", () => {
    // claude-opus-4-6 offers low|medium|high|max — no xhigh.
    expect(() => modernPlan({ model: "claude-opus-4-6", effort: "xhigh" })).toThrow(
      /effort "xhigh" is not offered by model "claude-opus-4-6" — supported levels: low, medium, high, max/,
    );
  });

  it("class 1: `extra` normalizes to `xhigh` BEFORE per-model validation, so it's still checked against the model's real levels", () => {
    // claude-opus-4-8 DOES offer xhigh -> accepted once normalized.
    expect(modernPlan({ model: "claude-opus-4-8", effort: "extra" }).effort).toBe("xhigh");
    // claude-opus-4-6 does NOT -> still throws (naming xhigh, not "extra").
    expect(() => modernPlan({ model: "claude-opus-4-6", effort: "extra" })).toThrow(/effort "xhigh" is not offered by model/);
  });

  it("class 2 (no-effort model): an explicit effort is a load-time error", () => {
    expect(() => modernPlan({ model: "claude-haiku-4-5", effort: "medium" })).toThrow(/model "claude-haiku-4-5" has no effort selector/);
    expect(() => modernPlan({ model: "claude-sonnet-4-5", effort: "low" })).toThrow(/has no effort selector/);
  });

  it("class 2 (no-effort model): an OMITTED effort does not throw and resolves to medium at argv emission", () => {
    const p = modernPlan({ model: "claude-haiku-4-5" });
    expect(p.effort).toBeUndefined(); // validated-but-unresolved; fallback happens in argv.ts/protocol.ts
    const args = agentArgs(modern, p, { mntRoot: "/sessions/x/mnt" });
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  });

  it("class 3 (regex-default, fable/mythos family): validates against the regex-default's levels", () => {
    expect(modernPlan({ model: "claude-fable-1", effort: "max" }).effort).toBe("max");
    expect(modernPlan({ model: "mythos-2", effort: "high" }).effort).toBe("high");
    expect(() => modernPlan({ model: "claude-fable-1", effort: "bogus" as any })).toThrow(); // Zod rejects a non-enum token first
  });

  it("class 4 (unknown model id): any of the six tokens passes through with no per-model check", () => {
    expect(modernPlan({ model: "some-future-model", effort: "max" }).effort).toBe("max");
    expect(modernPlan({ model: "some-future-model", effort: "low" }).effort).toBe("low");
  });

  it("class 4 (model omitted): any of the six tokens passes through, no throw", () => {
    expect(modernPlan({ effort: "xhigh" }).effort).toBe("xhigh");
  });

  it("--effort is ALWAYS emitted, falling back to the baseline's medium default when unset", () => {
    const noEffort = modernPlan({});
    const args = agentArgs(modern, noEffort, { mntRoot: "/sessions/x/mnt" });
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("medium");
  });
});

describe("fail-loud declared-source staging", () => {
  // Build a local marketplace dir; controls let us simulate every failure mode.
  function mktDir(opts: { name?: string; withPlugin?: boolean; pluginVersion?: string; badJson?: boolean; noManifest?: boolean }) {
    const mk = mkdtempSync(join(tmpdir(), "cowork-seamA-mkt-"));
    if (opts.noManifest) return mk;
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    if (opts.badJson) {
      writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), "{ not valid json");
      return mk;
    }
    const plugins: Array<{ name: string; source: string }> = [];
    if (opts.withPlugin) {
      mkdirSync(join(mk, "p", ".claude-plugin"), { recursive: true });
      writeFileSync(join(mk, "p", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", version: opts.pluginVersion ?? "1.0.0" }));
      plugins.push({ name: "p", source: "./p" });
    }
    writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: opts.name ?? "mymkt", plugins }));
    return mk;
  }

  it("a missing local skill source throws", () => {
    expect(() => plan({ skills: { local: ["./does/not/exist-skill"] } })).toThrow(/skill source not found/);
  });

  it("two skills.local entries with the same basename throw (would clobber)", () => {
    const a = mkdtempSync(join(tmpdir(), "skA-"));
    const b = mkdtempSync(join(tmpdir(), "skB-"));
    mkdirSync(join(a, "dup"), { recursive: true });
    mkdirSync(join(b, "dup"), { recursive: true });
    expect(() => plan({ skills: { local: [join(a, "dup"), join(b, "dup")] } })).toThrow(/duplicate skill destination/);
  });

  it("an upload that is a directory is rejected (uploads model attached files)", () => {
    expect(() => plan({ uploads: ["./examples/data/project"] })).toThrow(/is a directory/);
  });

  it("a default folder id whose basename is '..' is rejected (would clobber the workspace root)", () => {
    expect(() => plan({ folders: [{ from: ".." }] })).toThrow(/unsafe folder default id/);
  });

  it("a missing or unparsable marketplace manifest throws", () => {
    expect(() => plan({ plugins: { local_marketplaces: [mktDir({ noManifest: true })] } })).toThrow(/manifest not found/);
    expect(() => plan({ plugins: { local_marketplaces: [mktDir({ badJson: true })] } })).toThrow(/not valid JSON/);
  });

  it("a manifest with plugins as an object (not array) throws an actionable error (not TypeError)", () => {
    const mk = mkdtempSync(join(tmpdir(), "cowork-badshape-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mymkt", plugins: {} }));
    expect(() => plan({ plugins: { local_marketplaces: [mk] } })).toThrow(/invalid shape.*plugins.*must be an array/);
  });

  it("COWORK_HARNESS_SOFT_MISSING downgrades a plugins-not-array manifest to warn-and-skip", () => {
    const mk = mkdtempSync(join(tmpdir(), "cowork-badshape-soft-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mymkt", plugins: {} }));
    const prev = process.env.COWORK_HARNESS_SOFT_MISSING;
    process.env.COWORK_HARNESS_SOFT_MISSING = "1";
    try {
      expect(() => plan({ plugins: { local_marketplaces: [mk] } })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_SOFT_MISSING;
      else process.env.COWORK_HARNESS_SOFT_MISSING = prev;
    }
  });

  it("a manifest with a plugin entry whose source is not a string throws an actionable error", () => {
    const mk = mkdtempSync(join(tmpdir(), "cowork-badentry-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mymkt", plugins: [{ name: "p", source: 5 }] }));
    expect(() => plan({ plugins: { local_marketplaces: [mk] } })).toThrow(/invalid shape.*source.*must be a string/);
  });

  // #26: a present-but-degenerate source ("", ".", "./", "./.") resolves to the marketplace root itself,
  // which would otherwise stage the WHOLE marketplace root as one plugin. Reject at the traversal guard.
  it.each(["", ".", "./", "./."])("a plugin entry whose source is %o (marketplace root) is rejected", (src) => {
    const mk = mkdtempSync(join(tmpdir(), "cowork-rootsrc-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mymkt", plugins: [{ name: "p", source: src }] }));
    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).toThrow(/resolves to the marketplace root itself/);
  });

  it("rejects ':' in marketplace metadata (it would break the docker -v overlay)", () => {
    const mk = mktDir({ name: "mymkt", withPlugin: true, pluginVersion: "1.0:evil" });
    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).toThrow(/unsafe plugin version/);
  });

  it("version with unsafe chars does NOT throw on modern baseline (>= 1.14271.0) — version is not computed", () => {
    const modernBaseline = loadBaseline("latest");
    const mk = mktDir({ name: "mymkt", withPlugin: true, pluginVersion: "1.0 beta" });
    const out = mkdtempSync(join(tmpdir(), "cowork-test-modern-"));
    const session = loadSession({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } });
    expect(() => buildLaunchPlan(session, modernBaseline, out)).not.toThrow();
    const p = buildLaunchPlan(session, modernBaseline, out);
    expect(p.pluginDirs).toContain(".local-plugins/marketplaces/mymkt/p");
  });

  it("throws when name@<local-mkt> names a declared local marketplace but the plugin is absent there", () => {
    const mk = mktDir({ name: "mymkt", withPlugin: false }); // manifest present, plugin "p" missing
    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).toThrow(/names local marketplace "mymkt"/);
  });

  it("does NOT throw for an enabled entry qualified by a REMOTE marketplace (no local_marketplaces)", () => {
    expect(() => plan({ plugins: { enabled: ["x@local"], marketplaces: ["https://example.com/m.git"] } })).not.toThrow();
  });

  // an in-root symlink whose target points OUTSIDE the marketplace root passes the lexical
  // `relative(mkRoot, pluginSrc)` guard (rel = "p") but `statSync`/`cpSync` follow it. Realpath
  // containment on both sides rejects the symlink escape.
  it("rejects a marketplace plugin source that is an in-root symlink pointing OUTSIDE the marketplace root", () => {
    const outside = mkdtempSync(join(tmpdir(), "cowork-b27-outside-"));
    mkdirSync(join(outside, ".claude-plugin"), { recursive: true }); // a real plugin dir, out of tree
    writeFileSync(join(outside, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", version: "1.0.0" }));

    const mk = mkdtempSync(join(tmpdir(), "cowork-b27-mkt-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    // entry.source "./p" stays lexically inside mkRoot, but mkRoot/p is a symlink to the out-of-tree dir.
    symlinkSync(outside, join(mk, "p"));
    writeFileSync(
      join(mk, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "mymkt", plugins: [{ name: "p", source: "./p" }] }),
    );

    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).toThrow(/resolves outside the marketplace root/);
  });

  it("does NOT throw for a BARE enabled name delivered via local_plugins", () => {
    expect(() => plan({ plugins: { enabled: ["x"], local_plugins: ["./examples/skills/my-pdf-skill"] } })).not.toThrow();
  });

  it("does NOT throw when the entry resolves on a LATER marketplace iteration", () => {
    const empty = mktDir({ name: "mktA", withPlugin: false }); // iterated first, lacks "p"
    const has = mktDir({ name: "mktB", withPlugin: true }); // has "p"
    expect(() => plan({ plugins: { local_marketplaces: [empty, has], enabled: ["p"] } })).not.toThrow();
  });

  it("COWORK_HARNESS_SOFT_MISSING downgrades a missing manifest and an unresolved entry to warn-and-skip", () => {
    const prev = process.env.COWORK_HARNESS_SOFT_MISSING;
    process.env.COWORK_HARNESS_SOFT_MISSING = "1";
    try {
      expect(() => plan({ plugins: { local_marketplaces: [mktDir({ noManifest: true })] } })).not.toThrow();
      const mk = mktDir({ name: "mymkt", withPlugin: false });
      expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_SOFT_MISSING;
      else process.env.COWORK_HARNESS_SOFT_MISSING = prev;
    }
  });

  it("a skills.local source that is a FILE (not a dir) fails loud", () => {
    expect(() => plan({ skills: { local: ["./examples/data/report.pdf"] } })).toThrow(/skill source must be a directory/);
  });

  it("a folder `from` that is a FILE (not a dir) fails loud", () => {
    expect(() => plan({ folders: [{ from: "./examples/data/report.pdf" }] })).toThrow(/folder .* must be a directory/);
  });

  it("a local_plugins source that is a FILE (not a dir) fails loud", () => {
    expect(() => plan({ plugins: { local_plugins: ["./examples/data/report.pdf"] } })).toThrow(/local_plugin .* must be a directory/);
  });

  it("a remote_plugins source that is a FILE (not a dir) fails loud", () => {
    expect(() => plan({ plugins: { remote_plugins: ["./examples/data/report.pdf"] } })).toThrow(/remote_plugin .* must be a directory/);
  });

  it("a MISSING directory source still routes through the post-loop check (not the kind-check)", () => {
    // a kind-check must NOT fire for a missing path: it stays on the existing missing-mount path so the
    // softMissing escape hatch keeps working. not found".)
    expect(() => plan({ folders: [{ from: "./does/not/exist" }] })).toThrow(/source\(s\) not found/);
    expect(() => plan({ plugins: { local_plugins: ["./does/not/exist"] } })).toThrow(/source\(s\) not found/);
  });

  it("COWORK_HARNESS_SOFT_MISSING still downgrades a MISSING directory source", () => {
    const prev = process.env.COWORK_HARNESS_SOFT_MISSING;
    process.env.COWORK_HARNESS_SOFT_MISSING = "1";
    try {
      expect(() => plan({ folders: [{ from: "./does/not/exist" }] })).not.toThrow();
      expect(() => plan({ plugins: { local_plugins: ["./does/not/exist"] } })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_SOFT_MISSING;
      else process.env.COWORK_HARNESS_SOFT_MISSING = prev;
    }
  });

  it("a NAMELESS manifest resolves `plugin@<derived-name>` (qualifier compared to derived mktName)", () => {
    // manifest has no `name`; the derived name is the dir basename. Qualifying by the derived name must
    // resolve the plugin, and a typo'd qualifier against the derived name must be CAUGHT.
    const mk = mkdtempSync(join(tmpdir(), "cowork-nameless-mkt-"));
    const derived = mk.split("/").pop()!; // basename of the marketplace dir = derived mktName
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    mkdirSync(join(mk, "p", ".claude-plugin"), { recursive: true });
    writeFileSync(join(mk, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "p", source: "./p" }] })); // no `name`
    writeFileSync(join(mk, "p", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
    // qualifier matches the derived name → resolves and mounts.
    const { plan: ok } = plan({ plugins: { local_marketplaces: [mk], enabled: [`p@${derived}`] } });
    expect(ok.pluginDirs).toContain(`.local-plugins/cache/${derived}/p/1.0.0`);
    // a plugin-name typo qualified against the derived name is now CAUGHT (was silently ignored).
    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: [`typo@${derived}`] } })).toThrow(
      new RegExp(`names local marketplace "${derived}"`),
    );
  });

  it("a present-but-CORRUPT plugin.json throws (no silent 0.0.0 default)", () => {
    const mk = mkdtempSync(join(tmpdir(), "cowork-corrupt-pj-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    mkdirSync(join(mk, "p", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(mk, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "mymkt", plugins: [{ name: "p", source: "./p" }] }),
    );
    writeFileSync(join(mk, "p", ".claude-plugin", "plugin.json"), "{ not valid json"); // corrupt
    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).toThrow(/plugin manifest is not valid JSON/);
  });

  it("a genuinely-VERSIONLESS plugin (absent/empty version) still falls back to 0.0.0", () => {
    // absent manifest version and no entry.version → readPluginVersion returns null → caller default 0.0.0.
    const mk = mkdtempSync(join(tmpdir(), "cowork-noversion-pj-"));
    mkdirSync(join(mk, ".claude-plugin"), { recursive: true });
    mkdirSync(join(mk, "p", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(mk, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "mymkt", plugins: [{ name: "p", source: "./p" }] }),
    );
    writeFileSync(join(mk, "p", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p" })); // valid, no version
    const { plan: p } = plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } });
    expect(p.pluginDirs).toContain(".local-plugins/cache/mymkt/p/0.0.0");
  });
});

describe("applySessionOverrides (E3 — matrix runner's session-loading override seam)", () => {
  it("overrides model, leaving everything else untouched", () => {
    const base = loadSession({ model: "claude-sonnet-4-6" });
    const next = applySessionOverrides(base, { model: "claude-opus-4-8" });
    expect(next.model).toBe("claude-opus-4-8");
    expect(next.permission_mode).toBe(base.permission_mode);
  });

  it("is a no-op when no overrides are given (same values, per-field, not necessarily same reference)", () => {
    const base = loadSession({ model: "claude-sonnet-4-6" });
    const next = applySessionOverrides(base, {});
    expect(next).toEqual(base);
  });

  it("skillDirSubstitution swaps the matching local_plugins entry, keeping others untouched", () => {
    const base = loadSession({ plugins: { local_plugins: ["../a/my-pdf-skill", "../other/unrelated-skill"] } });
    const next = applySessionOverrides(base, { skillDirSubstitution: ["../a/my-pdf-skill", "../b/my-pdf-skill"] });
    expect(next.plugins.local_plugins).toEqual(["../b/my-pdf-skill", "../other/unrelated-skill"]);
  });

  it("does NOT mutate the original session object (pure function)", () => {
    const base = loadSession({ plugins: { local_plugins: ["../a/my-pdf-skill"] } });
    applySessionOverrides(base, { skillDirSubstitution: ["../a/my-pdf-skill", "../b/my-pdf-skill"] });
    expect(base.plugins.local_plugins).toEqual(["../a/my-pdf-skill"]);
  });

  it("throws when the substitution's `from` isn't actually in local_plugins — never silently no-ops", () => {
    const base = loadSession({ plugins: { local_plugins: ["../a/my-pdf-skill"] } });
    expect(() => applySessionOverrides(base, { skillDirSubstitution: ["../does-not-match", "../b/my-pdf-skill"] })).toThrow(
      /does not contain/,
    );
  });

  it("throws when the substitute directory has a DIFFERENT basename — the mount name must stay stable", () => {
    const base = loadSession({ plugins: { local_plugins: ["../a/my-pdf-skill"] } });
    expect(() => applySessionOverrides(base, { skillDirSubstitution: ["../a/my-pdf-skill", "../b/a-totally-different-name"] })).toThrow(
      /basename|mount name/i,
    );
  });

  it("composes model + skillDirSubstitution together in one call", () => {
    const base = loadSession({ model: "claude-sonnet-4-6", plugins: { local_plugins: ["../a/my-pdf-skill"] } });
    const next = applySessionOverrides(base, {
      model: "claude-opus-4-8",
      skillDirSubstitution: ["../a/my-pdf-skill", "../b/my-pdf-skill"],
    });
    expect(next.model).toBe("claude-opus-4-8");
    expect(next.plugins.local_plugins).toEqual(["../b/my-pdf-skill"]);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { loadSession, buildLaunchPlan, resolveSessionPaths } from "../src/session.js";
import { parseSessionFile } from "../src/run/execute.js";
import { agentArgs } from "../src/runtime/argv.js";
import { Scenario } from "../src/types.js";

const baseline = loadBaseline("desktop-1.11847.5");

function plan(sessionObj: unknown) {
  const out = mkdtempSync(join(tmpdir(), "cowork-test-"));
  const session = loadSession(sessionObj);
  return { plan: buildLaunchPlan(session, baseline, out), out };
}

describe("WS-B — mount / path safety", () => {
  it("#19 — a folder `to` with traversal is rejected", () => {
    expect(() => plan({ folders: [{ from: "./examples/data/project", to: "../escape" }] })).toThrow(/unsafe folder/);
  });
  it("#21 — duplicate mount destinations fail before staging", () => {
    expect(() => plan({ uploads: ["./examples/data/report.pdf", "./examples/data/report.pdf"] })).toThrow(/duplicate mount destination/);
  });
  it("#22 — a missing mount source fails by default (no silent skip)", () => {
    expect(() => plan({ uploads: ["./does/not/exist.pdf"] })).toThrow(/source\(s\) not found/);
  });
  it("#22 — COWORK_HARNESS_SOFT_MISSING downgrades to warn-and-exclude", () => {
    const prev = process.env.COWORK_HARNESS_SOFT_MISSING;
    process.env.COWORK_HARNESS_SOFT_MISSING = "1";
    try {
      const { plan: p } = plan({ uploads: ["./does/not/exist.pdf"], folders: [{ from: "./examples/data/project", to: "proj1" }] });
      const paths = p.mounts.map((m) => m.mountPath);
      expect(paths).not.toContain("uploads/exist.pdf"); // missing source excluded
      expect(paths).toContain(".projects/proj1"); // present source kept
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_SOFT_MISSING;
      else process.env.COWORK_HARNESS_SOFT_MISSING = prev;
    }
  });
  it("#27 — pinning config_dir to an EXISTING dir is rejected without the opt-in", () => {
    const existing = mkdtempSync(join(tmpdir(), "cowork-cfg-"));
    expect(() => plan({ plugins: { config_dir: existing } })).toThrow(/COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE/);
  });
  it("#33 — rejects a non-positive max_thinking_tokens (scalar and per-model map)", () => {
    expect(() => loadSession({ max_thinking_tokens: 0 })).toThrow();
    expect(() => loadSession({ max_thinking_tokens: -5 })).toThrow();
    expect(() => loadSession({ max_thinking_tokens: { default: 0 } })).toThrow();
    expect(loadSession({ max_thinking_tokens: 12000 }).max_thinking_tokens).toBe(12000); // positive ok
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

describe("buildLaunchPlan", () => {
  it("mounts uploads, projects and plugins at the Cowork paths", () => {
    const { plan: p } = plan({
      uploads: ["./examples/data/report.pdf"],
      folders: [{ from: "./examples/data/project", to: "proj1" }],
      plugins: { local_plugins: ["./examples/skills/my-pdf-skill"] },
    });
    const paths = p.mounts.map((m) => m.mountPath);
    expect(paths).toContain("uploads/report.pdf");
    expect(paths).toContain(".projects/proj1");
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
    expect(settings.enabledPlugins).toEqual(["x@local"]);
    expect(settings.extraKnownMarketplaces).toEqual(["https://example.com/m.git"]);
    expect(settings.enabledMcpjsonServers).toEqual(["y"]);
  });

  it("maps model/effort/permission/max-thinking-tokens (#23)", () => {
    const { plan: p } = plan({
      model: "claude-opus-4-8",
      effort: "high",
      max_thinking_tokens: { "claude-opus-4-8": 50000, default: 12000 },
      permission_mode: "acceptEdits",
    });
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.permissionMode).toBe("acceptEdits");
    // effort/thinking are plan fields (passed as CLI flags / non-zero env at L1/L2),
    // NOT baseEnv vars (CLAUDE_EFFORT is a no-op; MAX_THINKING_TOKENS is never 0).
    expect(p.effort).toBe("high");
    // #23: the session's thinking budget reaches the plan (resolved per-model in spawnEnv via f7e).
    expect(p.maxThinkingTokens).toEqual({ "claude-opus-4-8": 50000, default: 12000 });
    expect(p.baseEnv.MAX_THINKING_TOKENS).toBeUndefined();
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
      folders: [{ from: "./examples/data/project", to: "proj1" }],
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

describe("SEAM A — fail-loud declared-source staging", () => {
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

  it("rejects ':' in marketplace metadata (it would break the docker -v overlay)", () => {
    const mk = mktDir({ name: "mymkt", withPlugin: true, pluginVersion: "1.0:evil" });
    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).toThrow(/unsafe plugin version/);
  });

  it("throws when name@<local-mkt> names a declared local marketplace but the plugin is absent there", () => {
    const mk = mktDir({ name: "mymkt", withPlugin: false }); // manifest present, plugin "p" missing
    expect(() => plan({ plugins: { local_marketplaces: [mk], enabled: ["p@mymkt"] } })).toThrow(/names local marketplace "mymkt"/);
  });

  it("does NOT throw for an enabled entry qualified by a REMOTE marketplace (no local_marketplaces)", () => {
    expect(() => plan({ plugins: { enabled: ["x@local"], marketplaces: ["https://example.com/m.git"] } })).not.toThrow();
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
    expect(() => plan({ folders: [{ from: "./examples/data/report.pdf", to: "proj1" }] })).toThrow(/folder .* must be a directory/);
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
    expect(() => plan({ folders: [{ from: "./does/not/exist", to: "p" }] })).toThrow(/source\(s\) not found/);
    expect(() => plan({ plugins: { local_plugins: ["./does/not/exist"] } })).toThrow(/source\(s\) not found/);
  });

  it("COWORK_HARNESS_SOFT_MISSING still downgrades a MISSING directory source", () => {
    const prev = process.env.COWORK_HARNESS_SOFT_MISSING;
    process.env.COWORK_HARNESS_SOFT_MISSING = "1";
    try {
      expect(() => plan({ folders: [{ from: "./does/not/exist", to: "p" }] })).not.toThrow();
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

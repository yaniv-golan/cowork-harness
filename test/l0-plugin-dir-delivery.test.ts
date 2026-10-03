import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginDirArgs } from "../src/runtime/argv.js";
import { buildProtocolEnv, managedConfigMode } from "../src/runtime/protocol.js";
import { checkHostHookConsent, pluginRootsWithRunnableHooks, warnUnservedHookEvents } from "../src/run/hook-events.js";
import type { LaunchPlan } from "../src/session.js";
import { loadBaseline } from "../src/baseline.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "l0-pd-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.COWORK_MANAGED_CONFIG;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

/** A plugin root declaring hooks at the path the binary actually reads. */
function pluginWithHooks(events: string[]): string {
  const root = tmp();
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, []])) }));
  return root;
}

describe("pluginDirArgs — ONE derivation, two roots", () => {
  it("emits a --plugin-dir per declared root, joined onto the caller's root", () => {
    const plan = { pluginDirs: [".local-plugins/marketplaces/m/a", ".local-plugins/marketplaces/m/b"] };
    expect(pluginDirArgs(plan as Pick<LaunchPlan, "pluginDirs">, "/sessions/x/mnt")).toEqual([
      "--plugin-dir",
      "/sessions/x/mnt/.local-plugins/marketplaces/m/a",
      "--plugin-dir",
      "/sessions/x/mnt/.local-plugins/marketplaces/m/b",
    ]);
  });

  // The empty case: protocol with no declared plugins must add NOTHING, or every plugin-less L0 run
  // gains a stray flag. A `--plugin-dir` at a nonexistent path is silently ignored by the CLI, so a
  // wrong path here would never surface as an error — only as a plugin that quietly fails to load.
  it("emits nothing when the plan declares no plugin roots", () => {
    expect(pluginDirArgs({ pluginDirs: [] }, "/anything")).toEqual([]);
  });
});

describe("managedConfigMode", () => {
  const base = {} as NodeJS.ProcessEnv;

  it("an API key takes the managed branch, and COWORK_MANAGED_CONFIG=0 does NOT revoke that CI promise", () => {
    process.env.COWORK_MANAGED_CONFIG = "0";
    expect(managedConfigMode({ ANTHROPIC_API_KEY: "k" })).toBe(true);
  });

  it("an OAuth token takes the managed branch", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "t";
    expect(managedConfigMode(base)).toBe(true);
  });

  it("ANTHROPIC_AUTH_TOKEN counts too — doctor already treats it as a credential", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "t";
    expect(managedConfigMode(base)).toBe(true);
  });

  it("=0 suppresses the token-derived branch", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "t";
    process.env.COWORK_MANAGED_CONFIG = "0";
    expect(managedConfigMode(base)).toBe(false);
  });

  it("no credential at all stays on the operator's real config dir (OAuth would otherwise break)", () => {
    expect(managedConfigMode(base)).toBe(false);
  });

  // The footgun this exists to close: a bare `=== "1"` test lets every other spelling fall through.
  // `COWORK_MANAGED_CONFIG=false` reads as "off" and previously selected MANAGED — the opposite.
  it("rejects an unrecognized value instead of silently picking a branch", () => {
    process.env.COWORK_MANAGED_CONFIG = "false";
    expect(() => managedConfigMode(base)).toThrow(/must be "0" or "1"/);
  });
});

describe("buildProtocolEnv — auth injection is scoped", () => {
  const plan = (over: Partial<LaunchPlan> = {}) => ({ baseEnv: {}, agentEnv: undefined, ...over }) as LaunchPlan;

  // The token is stripped from plan.baseEnv by strippedEnv (it is bgEnvStrip.knownVars[0]), so it MUST
  // be read from process.env. Gating on the plan's copy would be a branch that can never be taken.
  it("injects the token on the managed branch even though baseEnv has none", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    expect(buildProtocolEnv(plan(), loadBaseline("latest")).CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("does NOT inject on the non-managed branch — that path keeps the real config dir and local login", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    process.env.COWORK_MANAGED_CONFIG = "0";
    expect(buildProtocolEnv(plan(), loadBaseline("latest")).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // Merging runtimeAuthEnv() wholesale would put BOTH credentials in one child env on the CI path.
  it("leaves an API-key run alone rather than adding a second credential", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    const env = buildProtocolEnv(plan({ baseEnv: { ANTHROPIC_API_KEY: "k" } }), loadBaseline("latest"));
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("checkHostHookConsent", () => {
  it("refuses when a staged plugin declares runnable hooks", () => {
    expect(() => checkHostHookConsent([pluginWithHooks(["SessionStart"])], false)).toThrow(/NATIVE HOST PROCESSES/);
  });

  it("names the opt-in and the sandboxed alternative", () => {
    expect(() => checkHostHookConsent([pluginWithHooks(["PreToolUse"])], false)).toThrow(/allow_host_hooks|--allow-host-hooks/);
  });

  it("allows the run once consent is given", () => {
    expect(() => checkHostHookConsent([pluginWithHooks(["SessionStart"])], true)).not.toThrow();
  });

  // The empty case, and the reason the gate is option D rather than a blanket refusal: an ordinary
  // skill-under-test declares no hooks and must pay no friction at all.
  it("does not fire for a plugin with no hooks", () => {
    const root = tmp();
    mkdirSync(join(root, "skills", "s"), { recursive: true });
    writeFileSync(join(root, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    expect(() => checkHostHookConsent([root], false)).not.toThrow();
    expect(pluginRootsWithRunnableHooks([root])).toEqual([]);
  });

  // Placement is the whole point: the binary reads <plugin>/hooks/hooks.json. The identical file at the
  // plugin ROOT fires nothing, so gating on it would refuse a run over a file that cannot execute.
  it("ignores a misplaced root-level hooks.json, which cannot execute", () => {
    const root = tmp();
    writeFileSync(join(root, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
    expect(() => checkHostHookConsent([root], false)).not.toThrow();
    expect(pluginRootsWithRunnableHooks([root])).toEqual([]);
  });

  it("reports the declared events so the operator can see what would run", () => {
    expect(pluginRootsWithRunnableHooks([pluginWithHooks(["SessionStart", "PreToolUse"])])[0].events).toEqual([
      "PreToolUse",
      "SessionStart",
    ]);
  });
});

/** A plugin declaring hooks in its MANIFEST rather than `hooks/hooks.json`. This is the spelling that
 *  defeated the consent gate in 3.0.0: detection keyed only on a file named `hooks.json`, so a
 *  manifest-declaring plugin ran its hook as a native host process while the gate stayed silent.
 *  Reported from a real consumer whose 10 committed cassettes all carried the resulting
 *  `SessionStart:startup` hook_started/hook_response pair — including one recorded at `container`. */
function pluginWithManifestHooks(events: string[], opts: { bare?: boolean } = {}): string {
  const root = tmp();
  const dir = opts.bare ? root : join(root, ".claude-plugin");
  if (!opts.bare) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({ name: "m", version: "0.1.0", hooks: Object.fromEntries(events.map((e) => [e, []])) }),
  );
  return root;
}

describe("manifest-declared hooks reach the consent gate", () => {
  // The regression itself. A fixture carrying BOTH spellings would pass with the bug present, so this
  // one declares hooks ONLY in the manifest — there is no hooks.json to find.
  it("detects hooks declared in .claude-plugin/plugin.json, with no hooks.json present", () => {
    const root = pluginWithManifestHooks(["SessionStart"]);
    expect(pluginRootsWithRunnableHooks([root])).toEqual([{ root, events: ["SessionStart"] }]);
  });

  it("refuses the spawn for a manifest-only hook plugin", () => {
    expect(() => checkHostHookConsent([pluginWithManifestHooks(["SessionStart"])], false)).toThrow(/NATIVE HOST PROCESSES/);
  });

  it("accepts the bare plugin.json spelling too — isPluginManifestDir takes either", () => {
    const root = pluginWithManifestHooks(["PreToolUse"], { bare: true });
    expect(pluginRootsWithRunnableHooks([root])).toEqual([{ root, events: ["PreToolUse"] }]);
  });

  it("unions both channels rather than letting one shadow the other", () => {
    const root = pluginWithManifestHooks(["SessionStart"]);
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [] } }));
    expect(pluginRootsWithRunnableHooks([root])[0].events).toEqual(["PreToolUse", "SessionStart"]);
  });

  // The placement carve-out is about INERTNESS: a root-level hooks.json cannot execute, so gating on it
  // would refuse a run over a dead file. That reasoning does not extend to a manifest, which is live
  // wherever it sits — so the carve-out must not be widened to cover it.
  it("still ignores a misplaced root-level hooks.json when the manifest declares nothing", () => {
    const root = tmp();
    writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: "m", version: "0.1.0" }));
    writeFileSync(join(root, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
    expect(pluginRootsWithRunnableHooks([root])).toEqual([]);
  });

  it("a manifest with no hooks key needs no opt-in", () => {
    const root = tmp();
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "m", version: "0.1.0" }));
    expect(() => checkHostHookConsent([root], false)).not.toThrow();
  });

  it("tolerates a malformed manifest rather than throwing from the gate", () => {
    const root = tmp();
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), "{ not json");
    expect(() => checkHostHookConsent([root], false)).not.toThrow();
  });
});

describe("the unserved-hook notice names the assertion keys instead of denying they exist", () => {
  it("mentions hook_event_fired / hook_event_blocked for a declared Stop hook", () => {
    const msgs: string[] = [];
    warnUnservedHookEvents([pluginWithHooks(["Stop"])], (m) => msgs.push(m));
    const notice = msgs.join("\n");
    expect(notice).toMatch(/hook_event_fired: Stop/);
    expect(notice).toMatch(/hook_event_blocked: Stop/);
    expect(notice).not.toMatch(/no assertion key/);
    // Stop is now live-verified (examples/probes/stop-hook-probe.scenario.yaml), so the notice says it WILL fire.
    expect(notice).toMatch(/WILL fire/);
  });
});

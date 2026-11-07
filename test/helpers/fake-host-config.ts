// A synthetic Claude config dir for `plugins.from_host` tests: invented plugin keys and skills, never a real host's.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakePlugin {
  key: string; // "<name>@<marketplace>"
  version?: string;
  scope?: string;
  /** Extra entries for the same key (e.g. a project-scope install). */
  extra?: Array<Record<string, unknown>>;
  enabled?: boolean;
  /** Files under the install, path → content. */
  files?: Record<string, string>;
  /** Override the recorded installPath. */
  installPath?: string;
  /** Leave the key out of installed_plugins.json (enabled but not installed). */
  notInstalled?: boolean;
}

export function fakeHostConfig(plugins: FakePlugin[], skills: Record<string, Record<string, string>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-host-config-"));
  const installed: Record<string, unknown[]> = {};
  const enabled: Record<string, boolean> = {};
  for (const p of plugins) {
    const [name, mkt] = p.key.split("@");
    const version = p.version ?? "1.0.0";
    const installPath = p.installPath ?? join(dir, "plugins", "cache", mkt ?? "m", name ?? "n", version);
    if (p.installPath === undefined) {
      mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
      writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
      for (const [rel, body] of Object.entries(p.files ?? { "README.md": `# ${name}\n` })) {
        mkdirSync(join(installPath, rel, ".."), { recursive: true });
        writeFileSync(join(installPath, rel), body);
      }
      writeFileSync(join(installPath, ".in_use"), String(Date.now()));
    }
    if (!p.notInstalled)
      installed[p.key] = [
        {
          scope: p.scope ?? "user",
          installPath,
          version,
          installedAt: "2026-01-01T00:00:00.000Z",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          gitCommitSha: "abc1234",
        },
        ...(p.extra ?? []),
      ];
    if (p.enabled !== false) enabled[p.key] = true;
    else enabled[p.key] = false;
  }
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledPlugins: enabled }));
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, "skills", name, rel, ".."), { recursive: true });
      writeFileSync(join(dir, "skills", name, rel), body);
    }
  }
  return dir;
}

export function makeExecutable(p: string): void {
  chmodSync(p, 0o755);
}

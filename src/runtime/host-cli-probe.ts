import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Does the HOST `claude` that a `protocol` run would spawn accept `--permission-prompts none`?
 *
 * `protocol` spawns `claude` from the run env's PATH (`spawn("claude", …, {env})` in protocol.ts), not the pinned VM
 * agent, so the baseline's `agentBinary.cliCapabilities` says nothing about it. This measures the binary that will
 * actually run: resolve `claude` on the SAME PATH, run `--help` once, and look for the option declaration together
 * with its `none` value. Local, free and a few hundred ms; cached per resolved path + mtime for the process, so an
 * upgrade in place is re-probed.
 */
export function hostCliSupportsPermissionPrompts(env: NodeJS.ProcessEnv): { supported: boolean; path: string | undefined } {
  const path = resolveOnPath("claude", env.PATH ?? "");
  if (!path) return { supported: false, path: undefined };
  let key: string;
  try {
    key = `${realpathSync(path)}\0${statSync(path).mtimeMs}`;
  } catch {
    return { supported: false, path };
  }
  const hit = cache.get(key);
  if (hit !== undefined) return { supported: hit, path };
  const r = spawnSync(path, ["--help"], { env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  const help = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // The option line, and `"none"` among its values. Commander wraps long help, so the value can sit on a later line.
  const supported = /--permission-prompts <\w+>/.test(help) && /"none"/.test(help);
  cache.set(key, supported);
  return { supported, path };
}

const cache = new Map<string, boolean>();

/** Test seam: forget every probe result. */
export function resetHostCliProbeCache(): void {
  cache.clear();
}

function resolveOnPath(name: string, pathVar: string): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

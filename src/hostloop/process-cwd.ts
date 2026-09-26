import { closeSync, constants, fsyncSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { cmpVersionStrings, HOSTLOOP_SYSTEM_EMPTY_CWD_MIN_VERSION } from "../baseline.js";
import type { PlatformBaseline } from "../types.js";

/**
 * Where the host-loop agent PROCESS runs, and the deny rules that go with it — Desktop 2.7032.0 onward.
 *
 * Desktop stopped running the agent at the outputs dir. It runs it at `/var/empty` when that directory
 * passes a stat check, otherwise at a per-session `host-cwd` dir, and it GENERATES deny rules for every
 * spelling of that directory and passes them to the agent (the agent derives nothing itself). So a bare
 * relative `Read`/`Write`/`Edit` expands to `/var/empty/<x>` and the agent refuses it: "File is in a
 * directory that is denied by your permission settings." Outputs stays reachable because Desktop adds it
 * as an extra working directory. Measured against the 2.7032.0 and 2.9939.2 asars (identical mechanism
 * under renamed symbols) and live on 2.7032.0.
 */

export const SYSTEM_EMPTY_CWD = "/var/empty";

/** True when the baseline's Desktop runs the host-loop agent off the outputs dir. A baseline with no
 *  `appVersion` (a synthetic one) keeps the older behaviour. */
export function hostLoopUsesSystemEmptyCwd(baseline: Pick<PlatformBaseline, "appVersion">): boolean {
  return typeof baseline.appVersion === "string" && cmpVersionStrings(baseline.appVersion, HOSTLOOP_SYSTEM_EMPTY_CWD_MIN_VERSION) >= 0;
}

type StatLike = { isDirectory(): boolean; uid: number; mode: number };

/** Desktop's check, in order: a directory, owned by root, and neither group- nor world-writable. */
export function systemEmptyCwdUsable(stat: (p: string) => StatLike = statSync): boolean {
  try {
    const s = stat(SYSTEM_EMPTY_CWD);
    return s.isDirectory() && s.uid === 0 && (s.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** `/var/empty` when usable; else `fallbackDir`, created the way Desktop creates its `host-cwd` dir: the
 *  directory (mode 0700), then a `package.json` of exactly `{"private": true}\n`, created exclusively with
 *  mode 0600 and never overwritten. The file's shape is measured; its purpose is not stated in the bundle
 *  (plausibly a package boundary so tooling started there does not walk up). `/var/empty` itself is never
 *  created or written.
 *
 *  `fallbackDir` must be per-run and must NOT be inside the session tree the bash sidecar mounts: Desktop's
 *  session storage dir is not visible to the VM. */
export function resolveHostProcessCwd(opts: { fallbackDir: string; stat?: (p: string) => StatLike }): string {
  if (systemEmptyCwdUsable(opts.stat)) return SYSTEM_EMPTY_CWD;
  mkdirSync(opts.fallbackDir, { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(
      join(opts.fallbackDir, "package.json"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeSync(fd, '{"private": true}\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return opts.fallbackDir;
}

type SpellingDeps = { platform?: NodeJS.Platform | string; realpath?: (p: string) => string };

const DATA_VOLUME = "/System/Volumes/Data";

/** Every spelling of `cwd` a tool call could use, as Desktop enumerates them: the path and its realpath,
 *  each in its given and NFC-normalized form, and on darwin each with and without the `/System/Volumes/Data`
 *  firmlink prefix. For `/var/empty` on macOS that is four paths. */
export function cwdSpellings(cwd: string, deps: SpellingDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const real = (() => {
    try {
      return (deps.realpath ?? realpathSync)(cwd);
    } catch {
      return cwd;
    }
  })();
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  for (const base of [cwd, real])
    for (const form of [base, base.normalize("NFC")]) {
      add(form);
      if (platform === "darwin") add(form.startsWith(`${DATA_VOLUME}/`) ? form.slice(DATA_VOLUME.length) : `${DATA_VOLUME}${form}`);
    }
  return out;
}

/** Desktop's rule path: `/` + the path with glob metacharacters bracket-escaped + `/**`. */
function rulePath(p: string): string {
  return `/${p.replace(/[?*{}()|+"[\]]/g, (c) => `[${c}]`)}/**`;
}

/** Desktop's deny rules for the agent's cwd: `Edit`/`Write`/`MultiEdit` and `Read` under every spelling.
 *  (Desktop also write-denies its shared plugin-cache root. The harness has no plugin cache — its path gate
 *  already write-blocks the staged plugin and skill roots — so no such root is invented here.) */
export function cwdDenyRules(cwd: string, deps: SpellingDeps = {}): { cwdSpellings: string[]; rules: string[] } {
  const spellings = cwdSpellings(cwd, deps);
  const rules: string[] = [];
  for (const s of spellings) for (const tool of ["Edit", "Write", "MultiEdit"]) rules.push(`${tool}(${rulePath(s)})`);
  for (const s of spellings) rules.push(`Read(${rulePath(s)})`);
  return { cwdSpellings: spellings, rules };
}

/** The agent argv additions for a process cwd off outputs. Deny rules join `--disallowedTools` — the copy
 *  Desktop itself keeps when its argv budget forces it to drop the duplicate `--settings` copy, with `(`/`)`
 *  inside a rule rewritten to `?` as Desktop does for that copy. Outputs is added back as a working
 *  directory through `--settings` `permissions.additionalDirectories`, Desktop's own channel for it; without
 *  it every write to outputs would be a request to leave the working directory. */
export function hostLoopPermissionArgs(opts: {
  processCwd: string;
  hostOutputsDir: string;
  platform?: NodeJS.Platform | string;
  realpath?: (p: string) => string;
}): { disallowed: string[]; extraArgs: string[]; cwdSpellings: string[] } {
  const { cwdSpellings: spellings, rules } = cwdDenyRules(opts.processCwd, opts);
  const escaped = rules.map((r) => {
    const open = r.indexOf("(");
    return `${r.slice(0, open + 1)}${r.slice(open + 1, -1).replace(/[()]/g, "?")})`;
  });
  return {
    disallowed: escaped,
    extraArgs: ["--settings", JSON.stringify({ permissions: { additionalDirectories: [opts.hostOutputsDir] } })],
    cwdSpellings: spellings,
  };
}

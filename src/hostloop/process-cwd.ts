import { execFileSync } from "node:child_process";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
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
 *  directory through `--settings` `permissions.additionalDirectories`, mirroring Desktop's own channel for it.
 *  Whether the agent honours that channel is NOT measured: `spawn.allowedTools` pre-approves the file tools,
 *  so no recorded run shows what an outputs write would do without it. */
export function hostLoopPermissionArgs(opts: {
  processCwd: string;
  hostOutputsDir: string;
  platform?: NodeJS.Platform | string;
  realpath?: (p: string) => string;
  /** Present when the outside-folder fence applies (see `hostLoopFenceApplies`). */
  fence?: HostLoopFenceRoots;
}): { disallowed: string[]; extraArgs: string[]; cwdSpellings: string[] } {
  const { cwdSpellings: spellings, rules } = cwdDenyRules(opts.processCwd, opts);
  // Known limit: a fallback dir whose path contains `(`/`)` gets `[?]` here, which matches a literal `?`,
  // so that rule no longer covers it. Desktop keeps an unmangled `--settings` copy as well; the harness
  // relies on the path gate's own relative-path block as the second line. Reachable only when /var/empty
  // fails the check AND the run dir contains parentheses.
  const escaped = rules.map((r) => {
    const open = r.indexOf("(");
    return `${r.slice(0, open + 1)}${r.slice(open + 1, -1).replace(/[()]/g, "?")})`;
  });
  return {
    disallowed: escaped,
    extraArgs: [
      "--settings",
      JSON.stringify({
        permissions: opts.fence
          ? hostLoopFencePermissions(opts.hostOutputsDir, opts.fence, opts.realpath)
          : { additionalDirectories: [opts.hostOutputsDir] },
      }),
    ],
    cwdSpellings: spellings,
  };
}

/**
 * The host-loop outside-folder fence (Desktop 4.16336.0 onward, for a host CLI at or above the baseline's
 * `hostLoopFence.minCli`). Desktop turns on the agent's own blocks on file reads and writes outside its working
 * directories, adds every connected folder as a working directory, and lets reads through to the roots it owns
 * (uploads, the spooled tool results, the skills plugin, read-only plugins), each listed as written and as its
 * realpath. It does this at spawn and again in a post-spawn push of the full set, which the agent unions with the
 * `--settings` value (each push replaces the previous one; measured with apply_flag_settings), so the harness sends
 * the set once, in its one `--settings` object. Not exempt, as in production: outputs (a working directory), the process cwd, auto-memory.
 */
export interface HostLoopFenceRoots {
  /** Connected folders' host paths, read-only and read-write alike; their read-only-ness is the path gate's job. */
  folders: string[];
  /** The roots the agent may read but not treat as working directories. */
  readOnlyRoots: string[];
}

/** Desktop's staging layout for the native agent: `claude-code/<ver>/[<build-sha12>/]claude.app/…`. */
const STAGED_NATIVE_AGENT = /(?:^|\/)claude-code\/(\d+\.\d+\.\d+)\/(?:[0-9a-f]{12}\/)?claude\.app\//;

/** The env the `--version` child gets: enough to start, nothing of the operator's (no credential reaches it). */
export function versionProbeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { PATH: env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? "" };
}

/** Ask the binary itself (`<binary> --version`, $0, a few milliseconds). Throws when it cannot run. */
function binaryVersionOutput(binaryPath: string): string {
  return execFileSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: versionProbeEnv(),
  });
}

/** The version of the agent binary at `binaryPath`. A path in Desktop's staging layout names it; any other path
 *  (an override, a CLI on PATH) is asked with `--version`, since a version-shaped directory elsewhere (a Node or
 *  Homebrew install, say) says nothing about the agent. When neither yields a version the result is undefined, so the
 *  fence is not sent, with a warning: Desktop's own version check fails closed the same way. */
export function agentVersionOfBinary(
  binaryPath: string,
  warn: (m: string) => void,
  askBinary: (p: string) => string = binaryVersionOutput,
): string | undefined {
  const staged = STAGED_NATIVE_AGENT.exec(binaryPath.split(sep).join("/"));
  if (staged) return staged[1];
  let why: string;
  try {
    const out = askBinary(binaryPath);
    const v = /^\s*(\d+\.\d+\.\d+)\b/.exec(out);
    if (v) return v[1];
    why = `its --version printed no version (${JSON.stringify(out.slice(0, 80))})`;
  } catch (e) {
    why = `its --version failed (${(e as Error).message.split("\n")[0]})`;
  }
  warn(
    `::warning:: [hostloop] the agent binary ${binaryPath} is not in Desktop's staging layout and ${why}; the outside-folder fence is not sent\n`,
  );
  return undefined;
}

/** True when the fence applies: the baseline records one and the agent that runs is at or above its floor. */
export function hostLoopFenceApplies(baseline: Pick<PlatformBaseline, "hostLoopFence">, agentVersion: string | undefined): boolean {
  const fence = baseline.hostLoopFence;
  return !!fence && agentVersion !== undefined && cmpVersionStrings(agentVersion, fence.minCli) >= 0;
}

/** An entry the agent keeps: absolute, normalized, not a filesystem root, with no trailing separator (the agent
 *  drops `…/dir/`; measured). `resolve` normalizes and strips the separator; a root is refused. */
function fenceEntry(p: string): string | null {
  const r = resolve(p);
  return r === parse(r).root || r.endsWith(sep) ? null : r;
}

/** The `permissions` object for a fenced spawn. Three disjoint sets: the working directories (outputs and every
 *  connected folder), the read exemptions (each read-only root as given and as its realpath), and nothing else. */
export function hostLoopFencePermissions(
  hostOutputsDir: string,
  roots: HostLoopFenceRoots,
  realpath: (p: string) => string = realpathSync.native,
): Record<string, unknown> {
  const folders = [...new Set(roots.folders.map(fenceEntry).filter((p): p is string => p !== null))];
  const exempt = new Set<string>();
  for (const root of roots.readOnlyRoots) {
    const given = fenceEntry(root);
    if (!given) continue;
    exempt.add(given);
    try {
      const real = fenceEntry(realpath(given));
      if (real) exempt.add(real);
    } catch {
      // not created yet: its given spelling is the only one a read can arrive by
    }
  }
  return {
    additionalDirectories: [hostOutputsDir, ...folders],
    blockReadsOutsideWorkingDirectories: true,
    blockWritesOutsideWorkingDirectories: true,
    blockReadsExemptPaths: [...exempt],
    workingDirectoriesAsGiven: folders,
  };
}

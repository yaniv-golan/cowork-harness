import { posix } from "node:path";

/**
 * Host-loop rewrite of plugin host paths in a workspace bash command.
 *
 * At host-loop the agent runs on the host, so the path it substitutes for `${CLAUDE_PLUGIN_ROOT}` (and the
 * skill base dir) in a skill's text is a HOST path, while `mcp__workspace__bash` runs in the VM, where that
 * path does not exist. From Desktop 1.40609.0, Cowork's workspace bash tool rewrites each plugin's host path,
 * written into the command, to the plugin's `/sessions/<id>/mnt/…` mount before running it. Only the string it
 * executes changes: the recorded tool input keeps the host path, and nothing maps the VM path back in the
 * command's output. The other tools (file tools, present_files, the path gate) never see the rewrite.
 *
 * This module reproduces that rule. The character sets below are the behaviour: changing one changes which
 * commands are rewritten.
 */

export interface PluginPathRewrite {
  hostPath: string;
  vmPath: string;
}

/** One staged plugin: the path the agent was told it lives at (`stagedPath`, the exact `--plugin-dir`), the
 *  installed copy (`installPath`), and the VM path the sidecar exposes it at. */
export interface RewritePluginInput {
  vmPath: string;
  stagedPath: string;
  installPath: string;
}

/** A character that, right before a key, means the key is the tail of a longer word or path, so the match is
 *  not rewritten. A quote here is the exception handled by {@link isOpeningQuote}. */
const LEFT_BLOCKERS = /[A-Za-z0-9_.\-/\\})`~"']/;
/** A character that may follow a key: whitespace, a quote, a shell operator or bracket, or `/` (a path
 *  inside the plugin). Anything else (`-`, `.`, `:`, `,`, `=`, a letter) means the key is a prefix of a
 *  longer name. */
const RIGHT_BOUNDARY = /[\s"'`;|&<>()[\]{}/]/;
/** What may precede an opening quote for it to count as one. */
const QUOTE_OPENER_PRECEDERS = /[\s=;|&(<{]/;
/** A VM path is a rewrite target only when every character is in this set. */
const SAFE_VM_PATH = /^[A-Za-z0-9._/-]+$/;

const QUOTES = new Set(['"', "'", "`"]);

/** The quote right before `idx` opens a quoted word: an odd number of that quote character up to and
 *  including it (a plain count, blind to escapes and the other quote kinds), and it starts the string or
 *  follows whitespace or a shell operator. */
function isOpeningQuote(s: string, idx: number): boolean {
  const quote = s[idx - 1];
  let count = 0;
  for (let i = 0; i < idx; i++) if (s[i] === quote) count++;
  if (count % 2 !== 1) return false;
  const before = idx >= 2 ? s[idx - 2] : undefined;
  return before === undefined || QUOTE_OPENER_PRECEDERS.test(before);
}

/** Replace every boundary-respecting occurrence of each host path with its VM path. Entries apply in the
 *  order given (the builder sorts longest key first), each to the output of the one before; within an entry
 *  the scan is left to right, never overlapping, and every boundary check reads that entry's input. */
export function rewritePluginPaths(command: string, rewrites: readonly PluginPathRewrite[]): string {
  if (!rewrites.length) return command;
  let current = command;
  for (const { hostPath, vmPath } of rewrites) {
    if (!hostPath || !current.includes(hostPath)) continue;
    let out = "";
    let from = 0;
    for (;;) {
      const at = current.indexOf(hostPath, from);
      if (at === -1) {
        out += current.slice(from);
        break;
      }
      const end = at + hostPath.length;
      const prev = at > 0 ? current[at - 1] : undefined;
      const next = current[end];
      const leftOk = prev === undefined || !LEFT_BLOCKERS.test(prev) || (QUOTES.has(prev) && isOpeningQuote(current, at));
      const rightOk = next === undefined || RIGHT_BOUNDARY.test(next);
      out += leftOk && rightOk ? current.slice(from, at) + vmPath : current.slice(from, end);
      from = end;
    }
    current = out;
  }
  return current;
}

/** The mount-relative tail of a VM path in a canonical form, or undefined when it names nothing under the
 *  mount root (empty, `.`, or climbing out of it). Backslashes count as separators; POSIX rules on every OS. */
function normalizeMountTail(tail: string): string | undefined {
  let t = posix.normalize(tail.split("\\").join("/"));
  if (t.startsWith("/")) t = t.slice(1);
  if (t === "" || t === "." || t === ".." || t.startsWith("../")) return undefined;
  return t;
}

/** Every spelling of `host` that is a key: the path as given and with backslashes as slashes; a `/private`
 *  twin of each one under `/var/` (macOS's real path for its temp dirs); and, for each of those containing a
 *  space, the space-escaped form and the two forms that quote each spaced segment. Nothing else — a path
 *  quoted any other way is not a key. */
function hostSpellings(host: string): string[] {
  const keys = new Set([host, host.split("\\").join("/")]);
  for (const k of [...keys]) if (k.startsWith("/var/")) keys.add(`/private${k}`);
  for (const k of [...keys]) {
    if (!k.includes(" ")) continue;
    keys.add(k.replaceAll(" ", "\\ "));
    for (const q of ['"', "'"])
      keys.add(
        k
          .split("/")
          .map((seg) => (seg.includes(" ") ? `${q}${seg}${q}` : seg))
          .join("/"),
      );
  }
  return [...keys];
}

/** The rewrite map for a session: each plugin's staged and installed host paths (and their spellings) to its
 *  VM mount, and the skills dirs to `<mnt>/.claude/skills`. A plugin whose VM path is not under `vmMntRoot`,
 *  has a `..` segment, or has a character outside the safe set gets no entries. The first entry for a key
 *  wins. Sorted longest key first, so a key nested inside another applies after it. */
export function buildPluginPathRewrites(input: {
  /** The VM mount root, `/sessions/<id>/mnt`, without a trailing slash. */
  vmMntRoot: string;
  plugins: readonly RewritePluginInput[];
  /** Host dirs whose contents the VM sees at `<vmMntRoot>/.claude/skills`. */
  skills?: { hostDirs: readonly string[] };
}): PluginPathRewrite[] {
  const prefix = `${input.vmMntRoot}/`;
  const map = new Map<string, string>();
  const add = (host: string, vm: string) => {
    if (!host || !SAFE_VM_PATH.test(vm)) return;
    for (const key of hostSpellings(host)) if (key !== vm && !map.has(key)) map.set(key, vm);
  };
  for (const p of input.plugins) {
    if (!p.vmPath.startsWith(prefix) || p.vmPath.split("/").includes("..")) continue;
    const tail = normalizeMountTail(p.vmPath.slice(prefix.length));
    if (tail === undefined) continue;
    const vm = prefix + tail;
    add(p.stagedPath, vm);
    add(p.installPath, vm);
  }
  for (const dir of input.skills?.hostDirs ?? []) add(dir, `${prefix}.claude/skills`);
  return [...map].map(([hostPath, vmPath]) => ({ hostPath, vmPath })).sort((a, b) => b.hostPath.length - a.hostPath.length);
}

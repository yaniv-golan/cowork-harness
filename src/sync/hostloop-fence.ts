// The host-loop CLI fence (Desktop >=4.16336.0): Desktop turns on the agent's own blocks on file reads and writes
// outside the task's folders, for a host-loop session whose host CLI is new enough. `sync` reads the version floor
// the fence needs from the asar and records it as `hostLoopFence.minCli`; the harness emits the same settings when
// the agent it runs is at or above it (src/hostloop/process-cwd.ts). Every shape below is pinned exactly; a reshape
// is a loud flag, never a silent widening.
import { cmpVersionStrings, HOSTLOOP_FENCE_MIN_VERSION } from "../baseline.js";
import { resolveNamespaceRef } from "./cowork-sync.js";

export type HostLoopFence = { minCli: string };

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `permissions` keys reviewed for the host-loop agent. The harness emits the last six in its one `--settings`
 *  object (src/hostloop/process-cwd.ts). `allow` and `deny` are Desktop's rule lists; the harness answers tool
 *  permissions itself (can_use_tool and its path hook) and does not send them as settings rules, which predates
 *  the fence and is out of its scope. A key outside this list in a scanned writer flags. */
export const HOSTLOOP_PERMISSION_KEYS_REVIEWED: readonly string[] = [
  "allow",
  "deny",
  "additionalDirectories",
  "blockReadsOutsideWorkingDirectories",
  "blockWritesOutsideWorkingDirectories",
  "blockReadsExemptPaths",
  "workingDirectoriesAsGiven",
];

const FENCE_CONSTANT = "{blockReadsOutsideWorkingDirectories:!0,blockWritesOutsideWorkingDirectories:!0}";

/** Brace-balanced `{…}`/`(…)` slice starting at `open`, skipping string and template literals. Null if unclosed. */
function balancedFrom(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** Source of `function <name>(…){…}` in `chunk`, or null. */
function functionSource(chunk: string, name: string): string | null {
  const head = new RegExp(`function ${reEsc(name)}\\([^)]*\\)\\{`).exec(chunk);
  if (!head) return null;
  const body = balancedFrom(chunk, head.index + head[0].length - 1);
  return body === null ? null : chunk.slice(head.index, head.index + head[0].length - 1) + body;
}

/** The value of `<local>=<literal>` (a string or an object literal) in `chunk`, or null. */
function bindingLiteral(chunk: string, local: string): string | null {
  const m = new RegExp(`(?<![\\w$.])${reEsc(local)}=(?=["{])`).exec(chunk);
  if (!m) return null;
  const at = m.index + m[0].length;
  if (chunk[at] === "{") return balancedFrom(chunk, at);
  const s = /^"((?:[^"\\]|\\.)*)"/.exec(chunk.slice(at));
  return s ? s[1]! : null;
}

export interface HostLoopFenceRead {
  /** The fence, or null when this build has none (no gate function and no off_cli_too_old state anywhere). */
  fence: HostLoopFence | null;
  flags: string[];
  /** The resolved writer sources the permissions-key tripwire scans (empty when the fence is absent or unread). */
  writers: string[];
}

/**
 * Read the fence from the bundle. It pins, in code terms:
 *  1. the gate `function <n>(<v>,<l>){return <l>?"off_cli_launcher":<cmp>(<v>,"<ver>")?"on":"off_cli_too_old"}`,
 *     exactly once bundle-wide; `<ver>` is the recorded floor. The same literal elsewhere (the 3p autoMode drop, a
 *     prompt-builder constant) is never read.
 *  2. its two call sites in that chunk: `let <nn>=<a>&&<b>?<n>(<v>,<x>):void 0;<nn>==="on"&&<ns>.<Ll>(<opts>)` and
 *     `resolveReadOnlyRoots:<n>(<v>,!1)==="on"`, and no third;
 *  3. the log message's `needs ${<ns>.<Ol>}` constant equals `<ver>`;
 *  4. `fileFencePaths` is constructed once, as `...<nn>==="on"&&{fileFencePaths:<roots>}`;
 *  5. `<ns>.<Ll>` resolves (through the chunk's require binding) to a function spreading a constant into
 *     `settings.permissions`, and that constant is exactly the two booleans;
 *  6. the export the post-spawn push calls resolves to a function that returns, when `fileFencePaths` is set, the
 *     same constant plus `blockReadsExemptPaths` (fileFencePaths ∪ midSessionReadOnlyPaths) and
 *     `workingDirectoriesAsGiven`; it is called at exactly two sites in the spawn chunk, the post-spawn
 *     `applyFlagSettings({permissions:<r>})` and `syncHostLoopPermissions`.
 */
export function readHostLoopFence(files: Map<string, string>): HostLoopFenceRead {
  const flags: string[] = [];
  const miss = (why: string) => flags.push(`hostloop-fence: ${why}`);
  const gateRe =
    /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{return \3\?"off_cli_launcher":[\w$.]+\(\2,"(\d+\.\d+\.\d+)"\)\?"on":"off_cli_too_old"\}/g;
  const gates: { chunk: string; m: RegExpExecArray }[] = [];
  let mentions = 0;
  for (const chunk of files.values()) {
    mentions += chunk.split('"off_cli_too_old"').length - 1;
    for (const m of chunk.matchAll(gateRe)) gates.push({ chunk, m: m as RegExpExecArray });
  }
  if (gates.length === 0) {
    if (mentions > 0) miss('the build names the "off_cli_too_old" state but its gate function no longer has the pinned shape');
    return { fence: null, flags, writers: [] };
  }
  if (gates.length > 1) {
    miss(`${gates.length} fence gate functions in the bundle, expected 1`);
    return { fence: null, flags, writers: [] };
  }
  const { chunk, m: gate } = gates[0]!;
  const [, n, , , ver] = gate;
  const fence: HostLoopFence = { minCli: ver! };
  const writers: string[] = [];

  // 2. call sites
  const calls = [...chunk.matchAll(new RegExp(`(?<![\\w$.])${reEsc(n!)}\\(`, "g"))].filter((c) => c.index !== gate.index + 9);
  const spawnSite = new RegExp(
    `let ([\\w$]+)=[\\w$]+&&[\\w$]+\\?${reEsc(n!)}\\([\\w$]+,[\\w$]+\\):void 0;\\1==="on"&&([\\w$]+)\\.([\\w$]+)\\([\\w$]+\\)`,
  ).exec(chunk);
  const rootsSite = new RegExp(`resolveReadOnlyRoots:${reEsc(n!)}\\([\\w$]+,!1\\)==="on"`).exec(chunk);
  if (!spawnSite) miss(`the spawn's \`let <state>=…?${n}(…):void 0;<state>==="on"&&<ns>.<writer>(<opts>)\` site is gone or reshaped`);
  if (!rootsSite) miss(`the path hook's \`resolveReadOnlyRoots:${n}(…,!1)==="on"\` site is gone or reshaped`);
  if (calls.length !== 2) miss(`${n}() is called at ${calls.length} site(s), expected 2 (the spawn and resolveReadOnlyRoots)`);
  if (!spawnSite) return { fence, flags, writers };
  const [, nn, ns, ll] = spawnSite;

  // 3. log constant
  const log = new RegExp(`\\$\\{${reEsc(nn!)}==="off_cli_too_old"\\?\`, needs \\$\\{([\\w$]+\\.[\\w$]+)\\}\``).exec(chunk);
  const logRef = log ? resolveNamespaceRef(log[1]!, chunk, files) : null;
  const logVer = logRef ? bindingLiteral(logRef.chunk, logRef.local) : null;
  if (!log) miss("the fence log message no longer names the version it needs");
  else if (logVer !== ver)
    miss(`the fence log message says it needs ${logVer ?? `an unresolved ${log[1]}`}, but the gate compares against ${ver}`);

  // 4. fileFencePaths construction
  let ffp = 0;
  for (const c of files.values()) ffp += [...c.matchAll(/(?<![\w$.?])fileFencePaths:/g)].length;
  const ffpSite = new RegExp(`\\.\\.\\.${reEsc(nn!)}==="on"&&\\{fileFencePaths:[\\w$]+\\}`).test(chunk);
  if (ffp !== 1 || !ffpSite)
    miss(`fileFencePaths is constructed at ${ffp} site(s); expected 1, as \`...${nn}==="on"&&{fileFencePaths:<roots>}\``);

  // 5. the spawn writer and its constant
  const llRef = resolveNamespaceRef(`${ns}.${ll}`, chunk, files);
  const llSrc = llRef ? functionSource(llRef.chunk, llRef.local) : null;
  const llConst = llSrc ? /permissions:\{\.\.\.[\w$]+\.permissions,\.\.\.([\w$]+)\}\}\}$/.exec(llSrc) : null;
  const llConstVal = llConst && llRef ? bindingLiteral(llRef.chunk, llConst[1]!) : null;
  if (!llSrc) miss(`the spawn writer ${ns}.${ll} does not resolve to a function`);
  else if (!llConst) miss(`the spawn writer ${ns}.${ll} no longer spreads one constant into settings.permissions`);
  else if (llConstVal !== FENCE_CONSTANT)
    miss(`the spawn writer's constant ${llConst[1]} is ${llConstVal ?? "unresolved"}, not ${FENCE_CONSTANT}`);
  if (llSrc) writers.push(llSrc);
  if (llConstVal) writers.push(llConstVal);

  // 6. the push writer and its two call sites
  const pushCalls = [...chunk.matchAll(new RegExp(`([\\w$]+)=${reEsc(ns!)}\\.([\\w$]+)\\([\\w$]+,`, "g"))].filter((c) => {
    const r = resolveNamespaceRef(`${ns}.${c[2]}`, chunk, files);
    const src = r ? functionSource(r.chunk, r.local) : null;
    return src !== null && src.includes("hostLoopSpawnPermissions?.fileFencePaths");
  });
  if (pushCalls.length !== 2) miss(`the fence push writer is called at ${pushCalls.length} site(s), expected 2`);
  else {
    const fl = pushCalls[0]![2]!;
    if (pushCalls[1]![2] !== fl) miss("the two fence push sites call different writers");
    const flRef = resolveNamespaceRef(`${ns}.${fl}`, chunk, files)!;
    const flSrc = functionSource(flRef.chunk, flRef.local)!;
    writers.push(flSrc);
    const shape = new RegExp(
      `^function [\\w$]+\\(([\\w$]+),([\\w$]+)\\)\\{let ([\\w$]+)=\\1\\.hostLoopSpawnPermissions\\?\\.fileFencePaths;return \\3&&\\{\\.\\.\\.${reEsc(llConst?.[1] ?? "\u0000")},blockReadsExemptPaths:\\[\\.\\.\\.new Set\\(\\[\\.\\.\\.\\3,\\.\\.\\.\\1\\.midSessionReadOnlyPaths\\?\\?\\[\\]\\]\\)\\],workingDirectoriesAsGiven:\\[\\.\\.\\.\\2\\]\\}\\}$`,
    );
    if (!shape.test(flSrc))
      miss(
        `the fence push writer ${ns}.${fl} no longer returns exactly the spawn constant + blockReadsExemptPaths (fileFencePaths ∪ midSessionReadOnlyPaths) + workingDirectoriesAsGiven`,
      );
    const [first, second] = pushCalls;
    if (!new RegExp(`if\\(${reEsc(first![1]!)}&&[\\w$.]+\\.applyFlagSettings\\(\\{permissions:${reEsc(first![1]!)}\\}\\)`).test(chunk))
      miss("the post-spawn push no longer sends the fence writer's result as applyFlagSettings({permissions})");
    const sync = /async syncHostLoopPermissions\([\w$]+\)\{/.exec(chunk);
    const syncBody = sync ? balancedFrom(chunk, sync.index + sync[0].length - 1) : null;
    const syncPush = syncBody ? /applyFlagSettings\(\{permissions:\{/.exec(syncBody) : null;
    const syncObj = syncBody && syncPush ? balancedFrom(syncBody, syncPush.index + syncPush[0].length - 1) : null;
    if (!syncBody || !syncBody.includes(second![0]) || !syncObj || !syncObj.endsWith(`...${second![1]}}`))
      miss("syncHostLoopPermissions no longer spreads the fence writer's result last into its applyFlagSettings permissions");
    if (syncObj) writers.push(syncObj);
  }
  return { fence, flags, writers };
}

/** The monotonic rule: from HOSTLOOP_FENCE_MIN_VERSION on, a build must carry the fence. A missing read
 *  there refuses the write rather than recording "no fence"; below the floor, null is the expected answer. */
export function fenceFloorFlag(appVersion: string | undefined, fence: HostLoopFence | null): string | null {
  if (!appVersion || fence !== null || cmpVersionStrings(appVersion, HOSTLOOP_FENCE_MIN_VERSION) < 0) return null;
  return `hostloop-fence: Desktop ${appVersion} is at or above ${HOSTLOOP_FENCE_MIN_VERSION} but its host-loop CLI fence could not be read`;
}

/** The agent's own `permissions` settings keys, read from the staged agent binary: the depth-1 keys of the schema
 *  object that opens `({allow:` and names `blockReadsExemptPaths:`. Null when no such object is found. */
export function permissionsSchemaKeys(elf: Buffer): string[] | null {
  for (let at = elf.indexOf("blockReadsExemptPaths:"); at >= 0; at = elf.indexOf("blockReadsExemptPaths:", at + 1)) {
    const win = elf.subarray(Math.max(0, at - 16384), at + 16384).toString("latin1");
    const rel = at - Math.max(0, at - 16384);
    const open = win.lastIndexOf("({allow:", rel);
    if (open < 0) continue;
    const obj = balancedFrom(win, open + 1);
    if (!obj || open + 1 + obj.length < rel) continue;
    const keys: string[] = [];
    let depth = 0;
    for (let i = 0; i < obj.length; i++) {
      const c = obj[i];
      if (c === '"' || c === "'" || c === "`") {
        for (i++; i < obj.length && obj[i] !== c; i++) if (obj[i] === "\\") i++;
        continue;
      }
      if (c === "{" || c === "(" || c === "[") {
        depth++;
        if (depth === 1) {
          const k = /^([A-Za-z_$][\w$]*):/.exec(obj.slice(i + 1, i + 80));
          if (k) keys.push(k[1]!);
        }
      } else if (c === "}" || c === ")" || c === "]") depth--;
      else if (c === "," && depth === 1) {
        const k = /^([A-Za-z_$][\w$]*):/.exec(obj.slice(i + 1, i + 80));
        if (k) keys.push(k[1]!);
      }
    }
    if (keys.includes("blockReadsExemptPaths")) return keys;
  }
  return null;
}

/** The tripwire: every agent `permissions` key a scanned writer constructs must be reviewed. Scope is
 *  the writers `readHostLoopFence` resolved — the spawn writer and its constant, the push writer, and
 *  syncHostLoopPermissions' pushed object — each followed one hop. A writer moved two hops away evades this scan;
 *  the shape pins in `readHostLoopFence` would then report its anchor missing instead. */
export function checkHostLoopPermissionKeys(writers: string[], schemaKeys: string[] | null): string[] {
  if (writers.length === 0) return [];
  if (!schemaKeys)
    return ["hostloop-fence: the staged agent's permissions settings schema could not be read, so new permission keys cannot be detected"];
  const out: string[] = [];
  for (const k of schemaKeys) {
    if (HOSTLOOP_PERMISSION_KEYS_REVIEWED.includes(k)) continue;
    if (writers.some((w) => new RegExp(`(?<![\\w$.])${reEsc(k)}:`).test(w)))
      out.push(
        `hostloop-fence: Desktop's host-loop permission writers now set permissions.${k}, which the harness has not reviewed — model it in src/hostloop/process-cwd.ts or record it, then add it to HOSTLOOP_PERMISSION_KEYS_REVIEWED`,
      );
  }
  return out;
}

/** A staged binary as sync reads it: its bytes, an unreadable marker, or null when it is not staged. */
export type StagedBinary = Buffer | { unreadable: string } | null;

/** The permissions-key tripwire over the binaries a fence can reach: the native agent hostloop runs, and the VM ELF.
 *  The two stage on separate cadences, so each readable schema is checked and their keys are unioned; the tripwire
 *  refuses only when neither schema reads, and notes when the native one, the binary the fence is sent to, was not
 *  read. */
export function hostLoopPermissionKeyFlags(
  writers: string[],
  bins: { native: StagedBinary; elf: StagedBinary; nativeLabel: string; elfLabel: string },
): { flags: string[]; notes: string[] } {
  if (writers.length === 0) return { flags: [], notes: [] };
  const keysOf = (b: StagedBinary) => (Buffer.isBuffer(b) ? permissionsSchemaKeys(b) : null);
  const why = (b: StagedBinary) =>
    b === null ? "not staged" : Buffer.isBuffer(b) ? "no permissions schema found" : `unreadable (${b.unreadable})`;
  const native = keysOf(bins.native);
  const elf = keysOf(bins.elf);
  const notes: string[] = [];
  if (!native)
    notes.push(
      `hostloop-fence: the native agent ${bins.nativeLabel} is ${why(bins.native)}; its permission keys were checked against ${elf ? `the VM ELF ${bins.elfLabel} only` : "nothing"}`,
    );
  const keys = native || elf ? [...new Set([...(native ?? []), ...(elf ?? [])])] : null;
  return { flags: checkHostLoopPermissionKeys(writers, keys), notes };
}

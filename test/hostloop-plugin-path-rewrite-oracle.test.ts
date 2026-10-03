import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { normalizeBundleQuotes } from "../src/sync/cowork-sync.js";
import { buildPluginPathRewrites, rewritePluginPaths, type PluginPathRewrite } from "../src/hostloop/plugin-path-rewrite.js";

// Differential oracle: our host-loop rewrite against Desktop's own, loaded AT TEST TIME from a saved bundle.
//
// `COWORK_ASAR_BUNDLE` is the same override the asar oracles in baseline.test.ts read: one file holding the
// joined, quote-normalised main-bundle chunks of a Desktop release. Unset, this suite skips with one warning.
// Nothing from the bundle is committed — the functions are located by stable strings (a settings key, an
// export name, a log-tag literal), sliced out and evaluated in memory, and fed inputs from the seeded
// generator below. A missing anchor FAILS with a message naming it: a release that moved the code must not
// read as a pass.

const BUNDLE = process.env.COWORK_ASAR_BUNDLE;
if (!BUNDLE) console.warn("skipping the plugin-path rewrite oracle: COWORK_ASAR_BUNDLE is unset");

type DesktopPlugin = { sdkPath: string; installPath: string; stagedPath: string };
type DesktopMapInput = { vmProcessName: string; plugins: DesktopPlugin[]; skillsPluginPath?: string; sdkSkillsPluginPath?: string };
type Desktop = { rewrite: (cmd: string, map: PluginPathRewrite[]) => string; build: (i: DesktopMapInput) => PluginPathRewrite[] };

const ID = "[A-Za-z_$][\\w$]*";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function need<T>(v: T | undefined | null | false, what: string): T {
  if (v === undefined || v === null || v === false || (typeof v === "number" && v < 0))
    throw new Error(`plugin-path rewrite oracle: anchor not found in COWORK_ASAR_BUNDLE — ${what}`);
  return v as T;
}

/** The source of `function <name>(…){…}` at or after `from`, by brace matching. */
function functionSource(src: string, name: string, from: number): string {
  const at = need(src.indexOf(`function ${name}(`, from), `definition of helper ${name}`);
  let depth = 0;
  for (let k = src.indexOf("{", at); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(at, k + 1);
  }
  throw new Error(`plugin-path rewrite oracle: unbalanced braces in helper ${name}`);
}

/** A chunk helper by its stable export name: the minified function it names, and the alias another chunk
 *  reaches it through (`<chunk>.<alias>(…)`). */
function chunkHelper(src: string, exportName: string): { alias: string; source: string } {
  const m = need(new RegExp(`[{,]${exportName}:\\(\\)=>(${ID})`).exec(src), `export ${exportName}`);
  const fn = m[1]!;
  const alias = need(
    new RegExp(`Object\\.defineProperty\\(exports,"(${ID})",\\{enumerable:!0,get:function\\(\\)\\{return ${esc(fn)}\\}\\}\\)`).exec(
      src.slice(m.index),
    ),
    `the cross-chunk alias of ${exportName}`,
  )[1]!;
  return { alias, source: functionSource(src, fn, m.index) };
}

function loadDesktop(path: string): Desktop {
  const src = normalizeBundleQuotes(readFileSync(path, "utf8"));
  // The two call sites name the functions: the bash handler passes its command through the rewrite, and the
  // host-loop session build fills `pluginPathVmRewrites` from the map builder.
  const rewriteName = need(new RegExp(`(${ID})\\(${ID}\\.command,${ID}\\.pluginPathVmRewrites\\)`).exec(src), "the rewrite call")[1]!;
  const buildName = need(new RegExp(`pluginPathVmRewrites:(${ID})\\(\\{vmProcessName`).exec(src), "the map-builder call")[1]!;
  // The code ends where the workspace server's log tag is declared.
  const end = need(src.indexOf('="[workspaceMcpServer]"'), "the [workspaceMcpServer] tag");
  const endStmt = src.lastIndexOf("var ", end);
  const defRewrite = need(src.lastIndexOf(`function ${rewriteName}(`, end), `definition of ${rewriteName}`);
  const defBuild = need(src.lastIndexOf(`function ${buildName}(`, end), `definition of ${buildName}`);
  // It starts at the declaration of the earliest pattern the two functions test with.
  const testedIds = [...src.slice(defRewrite, endStmt).matchAll(new RegExp(`(${ID})\\.test\\(`, "g"))].map((m) => m[1]!);
  let start = defRewrite;
  for (const id of new Set(testedIds)) {
    const before = src.slice(0, defRewrite);
    const decl = Math.max(before.lastIndexOf(`var ${id}=`), before.lastIndexOf(`,${id}=`));
    if (decl < 0) continue; // a pattern declared inside the region itself
    start = Math.min(start, before.lastIndexOf("var ", decl + 1));
  }
  need(start <= defRewrite && defBuild > start && defBuild < endStmt, "rewrite and map builder in one region");
  const region = src.slice(start, endStmt);
  const posixSep = chunkHelper(src, "toPosixSeparators");
  const mountName = chunkHelper(src, "toGuestCompatibleMountName");
  const chunkVar = need(new RegExp(`(${ID})\\.${esc(posixSep.alias)}\\(`).exec(region), "the chunk alias in the map builder")[1]!;
  const pathVar = need(/\(0,([A-Za-z_$][\w$]*)\.join\)/.exec(region), "the path module in the map builder")[1]!;
  const normVar = need(new RegExp(`(${ID})\\.normalize\\(`).exec(mountName.source), "the path module in the mount-name helper")[1]!;
  const helpers = new Function(
    normVar,
    `${posixSep.source};${mountName.source};return [${posixSep.source.match(/^function ([^(]+)/)![1]},${mountName.source.match(/^function ([^(]+)/)![1]}];`,
  )(posix) as [unknown, unknown];
  const chunk = { [posixSep.alias]: helpers[0], [mountName.alias]: helpers[1] };
  return new Function(chunkVar, pathVar, `${region};return {rewrite:${rewriteName},build:${buildName}};`)(chunk, posix) as Desktop;
}

// ------------------------------------------------------------------------------------------------
// A seeded generator of map inputs and commands. The pools aim at every rule: spaces, quotes, `/var`,
// backslashes, `..`, unsafe VM names, keys nested in keys, and every boundary character on both sides.
// ------------------------------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  return { next, pick, int: (n: number) => Math.floor(next() * n) };
}

const SESSIONS = ["local_abc", "local_9x", "s-1", "x y", "a.b"];
const HOST_ROOTS = ["/Users/u", "/var/folders/xy/T", "/private/var/folders/xy/T", "/tmp/r", "/home/u", "C:\\Users\\u", "/Users/u\\x"];
const HOST_SEGS = ["run dir", "runs", "a b c", "o'b", 'q"x', "work", "session", "mnt", "plug-in", "p", ".hidden", "x`y", "v1.2"];
const VM_TAILS = [
  ".remote-plugins/plugin_Ab12",
  ".local-plugins/marketplaces/m/p",
  ".local-plugins/cache/m/p/1.0.0",
  "p",
  "a/../b",
  "../x",
  "",
  ".",
  "p q",
  "a\\b",
  "//x/./y/",
  "x$y",
];

function genInput(r: ReturnType<typeof rng>): DesktopMapInput {
  const vmProcessName = r.pick(SESSIONS);
  const host = () => {
    if (r.int(12) === 0) return "";
    const segs = Array.from({ length: 1 + r.int(4) }, () => r.pick(HOST_SEGS));
    return [r.pick(HOST_ROOTS), ...segs].join(r.int(8) === 0 ? "\\" : "/");
  };
  const plugins = Array.from({ length: r.int(5) }, () => {
    const sdkPath = r.int(10) === 0 ? `/sessions/other/mnt/${r.pick(VM_TAILS)}` : `/sessions/${vmProcessName}/mnt/${r.pick(VM_TAILS)}`;
    const installPath = host();
    // nested keys: a staged path that extends another plugin's install path
    const stagedPath = r.int(3) === 0 ? installPath : r.int(3) === 0 ? `${installPath}/sub` : host();
    return { sdkPath, installPath, stagedPath };
  });
  const out: DesktopMapInput = { vmProcessName, plugins };
  if (r.int(2) === 0) out.skillsPluginPath = host();
  if (r.int(2) === 0) out.sdkSkillsPluginPath = host();
  return out;
}

const LEFTS = [
  "",
  " ",
  "=",
  '"',
  "'",
  "`",
  ' "',
  " '",
  '="',
  "('",
  "a",
  "/",
  ":",
  "$",
  'x"',
  "(",
  "{",
  "<",
  "|",
  "&",
  ";",
  "\\",
  "~",
  "}",
  ")",
  ".",
  "-",
  "_",
  "9",
];
const RIGHTS = [
  "",
  "/",
  "/x.sh",
  " ",
  "-",
  ".",
  ":",
  '"',
  "'",
  "`",
  ")",
  "(",
  ";",
  "|",
  "&",
  "<",
  ">",
  "[",
  "]",
  "{",
  "}",
  "x",
  ",",
  "=",
  "\t",
  "\n",
];
const NOISE = ["echo", "cd", "&&", "|", ";", '"', "'", "`", "$(", ")", "--root", "x=1", "\\", "/Users/u"];

function genCommand(r: ReturnType<typeof rng>, keys: string[]): string {
  const parts: string[] = [];
  for (let n = 1 + r.int(4); n > 0; n--) {
    if (keys.length && r.int(4) !== 0) {
      let k = r.pick(keys);
      if (r.int(6) === 0) k = k.slice(0, Math.max(1, k.length - 1 - r.int(3))); // a near-miss prefix
      parts.push(r.pick(LEFTS) + k + r.pick(RIGHTS));
    } else parts.push(r.pick(NOISE));
  }
  return parts.join(r.pick([" ", "", " && ", ";", "\n"]));
}

function ours(i: DesktopMapInput): PluginPathRewrite[] {
  return buildPluginPathRewrites({
    vmMntRoot: `/sessions/${i.vmProcessName}/mnt`,
    plugins: i.plugins.map((p) => ({ vmPath: p.sdkPath, stagedPath: p.stagedPath, installPath: p.installPath })),
    ...(i.skillsPluginPath
      ? {
          skills: {
            hostDirs: [
              ...(i.sdkSkillsPluginPath ? [posix.join(i.sdkSkillsPluginPath, "skills")] : []),
              posix.join(i.skillsPluginPath, "skills"),
            ],
          },
        }
      : {}),
  });
}

describe.skipIf(!BUNDLE)("plugin-path rewrite: differential against Desktop's own functions", () => {
  const desktop = BUNDLE ? loadDesktop(BUNDLE) : (undefined as never);

  it("the loaded functions are live (a known input rewrites), so agreement below is not two no-ops", () => {
    const m = desktop.build({
      vmProcessName: "s",
      plugins: [{ sdkPath: "/sessions/s/mnt/.remote-plugins/p", installPath: "/h/p", stagedPath: "/h/p" }],
    });
    expect(m).toEqual([{ hostPath: "/h/p", vmPath: "/sessions/s/mnt/.remote-plugins/p" }]);
    expect(desktop.rewrite("bash /h/p/x.sh", m)).toBe("bash /sessions/s/mnt/.remote-plugins/p/x.sh");
  });

  it("the same map and the same rewritten command over seeded generated inputs", () => {
    const r = rng(0x5eed);
    let maps = 0;
    let commands = 0;
    let changed = 0;
    for (let i = 0; i < 400; i++) {
      const input = genInput(r);
      const theirs = desktop.build(input);
      expect(ours(input), JSON.stringify(input)).toEqual(theirs);
      maps++;
      const keys = theirs.map((e) => e.hostPath);
      for (let j = 0; j < 60; j++) {
        const cmd = genCommand(r, keys);
        const want = desktop.rewrite(cmd, theirs);
        expect(rewritePluginPaths(cmd, theirs), JSON.stringify({ cmd, map: theirs })).toBe(want);
        commands++;
        if (want !== cmd) changed++;
      }
    }
    // The generator must exercise both outcomes, or agreement proves little.
    expect(maps).toBe(400);
    expect(changed).toBeGreaterThan(commands / 10);
    expect(commands - changed).toBeGreaterThan(commands / 10);
  });
});

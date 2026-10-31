import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSpawnEnvPostWrites } from "../src/sync/spawn-env-post-writes.js";
import { normalizeBundleQuotes } from "../src/sync/cowork-sync.js";

// Hand-written minified-style chunks in the SHAPE of Desktop's spawn path (no Desktop code): a builder whose options
// literal holds `env:{CLAUDE_CONFIG_DIR…}` and which returns `{sdkOptions:U,…}`, and a caller that destructures it and
// spawns `({prompt:x,options:J})`. Computed keys resolve through a required module's export map.
const CONSTS = [
  'Object.defineProperty(exports,"LT",{enumerable:!0,get:function(){return Zar}});',
  'Object.defineProperty(exports,"AT",{enumerable:!0,get:function(){return aor}});',
  'var Zar="CLAUDE_CODE_PLUGIN_ATTRIBUTION",aor=`CLAUDE_CODE_SKILL_ATTRIBUTION`;',
].join("");
const builder = (tail = "") =>
  'async function Em(e,r){let{sessionId:i}=e,U={cwd:"/x",model:d,hooks:{a:[async e=>{let U=1;return U}]},env:{CLAUDE_CONFIG_DIR:"/c",...le},systemPrompt:f},W=z.getVersion();' +
  "U.env={...U.env,ANTHROPIC_CUSTOM_HEADERS:t.Sv(U.env??{},W)},t.Ev(U.env);" +
  tail +
  "return de!==void 0&&(U.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS=String(de)),{sdkOptions:U,allowedDomains:V}}";
const caller = (body = "", spawn = "let It=Pt({prompt:ge,options:J});") =>
  "async function Bm(e,r){let{sdkOptions:J,allowedDomains:Be}=await Em({sessionId:i},r);" +
  "let at=t.RT($e);at&&(J.env={...J.env,[t.LT]:at});let ot=await He;ot&&(J.env={...J.env,[t.AT]:ot});" +
  '[1].map(J=>{J.env.SHADOWED_BY_PARAM="1"});' +
  body +
  spawn +
  "}";
const files = (b = builder(), c = caller(), extra = "") =>
  new Map([
    ["index.chunk-main.js", `const t=require("./index.chunk-consts.js");${b}${c}${extra}`],
    ["index.chunk-consts.js", CONSTS],
  ]);
const registryAll = (n: string) => (/^(?:TEST_|SHADOWED)/.test(n) ? null : { class: "pinned" as const, reason: "test" });

describe("scanSpawnEnvPostWrites — direct writes to the spawn env after W1 is built", () => {
  it("finds re-spread literal and computed keys, member writes, and resolves constants in any quote style", () => {
    const r = scanSpawnEnvPostWrites(files(), registryAll);
    expect(r.flags).toEqual([]);
    expect(r.keys).toEqual([
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "CLAUDE_CODE_PLUGIN_ATTRIBUTION",
      "CLAUDE_CODE_SKILL_ATTRIBUTION",
    ]);
  });

  it("ignores a write through a nested function's parameter that shadows the alias", () => {
    expect(scanSpawnEnvPostWrites(files(), () => ({ class: "pinned", reason: "t" })).keys).not.toContain("SHADOWED_BY_PARAM");
  });

  it("follows a plain alias copy of the options and records deletes", () => {
    const r = scanSpawnEnvPostWrites(files(builder(), caller('let a=J;a.env.ALIASED_KEY="1";delete J.env.DELETED_KEY;')), registryAll);
    expect(r.keys).toEqual(expect.arrayContaining(["ALIASED_KEY", "DELETED_KEY"]));
  });

  it("hard-fails an unclassified key, naming it", () => {
    const r = scanSpawnEnvPostWrites(files(builder(), caller('J.env.TEST_NEW_KEY="1";')), registryAll);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toContain("TEST_NEW_KEY");
  });

  it("hard-fails a computed key it cannot resolve", () => {
    const r = scanSpawnEnvPostWrites(files(builder(), caller("J.env={...J.env,[t.TESTNOPE]:x};")), registryAll);
    expect(r.flags.some((f) => /t\.TESTNOPE/.test(f) && /resolve/.test(f))).toBe(true);
  });

  it("hard-fails a missing or duplicated anchor", () => {
    expect(scanSpawnEnvPostWrites(files(builder(), caller("", "")), registryAll).flags.some((f) => /spawn call/.test(f))).toBe(true);
    const dup = "async function Xm(){let{sdkOptions:J}=await Em(a);}";
    expect(scanSpawnEnvPostWrites(files(builder(), caller(), dup), registryAll).flags.some((f) => /destructure/.test(f))).toBe(true);
  });

  it("accepts the builder returning `{sdkOptions:U}` with no sibling fields", () => {
    const b = builder().replace("{sdkOptions:U,allowedDomains:V}", "{sdkOptions:U}");
    expect(scanSpawnEnvPostWrites(files(b), registryAll).flags).toEqual([]);
  });
});

// Over the saved Desktop asars (a local backup dir, never present on CI): seed the classified set with what the
// OLDEST build writes, then replay the builds oldest first, adding each build's keys after checking it. The scanner
// must go red exactly where Desktop added a direct post-construction write: 1.37937.0 (MAX_CONTEXT_TOKENS,
// PLUGIN_ATTRIBUTION) and 1.46388.3 (SKILL_ATTRIBUTION). Reproduces the measurement this scanner was approved on.
const ASAR_BACKUPS = process.env.COWORK_ASAR_BACKUP_DIR;
function readAsarBuildFiles(asarPath: string): Map<string, string> {
  const buf = readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString("utf8")) as { files: Record<string, any> };
  const base = 8 + headerSize;
  const build = header.files[".vite"]?.files?.build?.files ?? {};
  const out = new Map<string, string>();
  for (const [name, e] of Object.entries(build) as Array<[string, { size?: number; offset?: string; unpacked?: boolean }]>) {
    if (!name.endsWith(".js") || e.unpacked || e.offset === undefined || e.size === undefined) continue;
    const start = base + Number(e.offset);
    out.set(name, normalizeBundleQuotes(buf.subarray(start, start + e.size).toString("utf8")));
  }
  return out;
}
describe.skipIf(!ASAR_BACKUPS)("scanSpawnEnvPostWrites over saved Desktop asars (COWORK_ASAR_BACKUP_DIR)", () => {
  it("goes red exactly on the builds that added a direct post-construction write", () => {
    const versions = readdirSync(ASAR_BACKUPS!)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && existsSync(join(ASAR_BACKUPS!, v, "app.asar")))
      .sort((a, b) => {
        const [x, y] = [a, b].map((v) => v.split(".").map(Number));
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      });
    expect(versions.length).toBeGreaterThan(30);
    const known = new Set<string>();
    const red: Record<string, string[]> = {};
    versions.forEach((v, i) => {
      const r = scanSpawnEnvPostWrites(readAsarBuildFiles(join(ASAR_BACKUPS!, v, "app.asar")), (n) =>
        i === 0 || known.has(n) ? { class: "pinned", reason: "seen" } : null,
      );
      if (r.flags.length) red[v] = r.flags.map((f) => f.match(/[A-Z][A-Z0-9_]{3,}/)?.[0] ?? f);
      for (const k of r.keys) known.add(k);
    });
    expect(red).toEqual({
      "1.37937.0": ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_PLUGIN_ATTRIBUTION"],
      "1.46388.3": ["CLAUDE_CODE_SKILL_ATTRIBUTION"],
      // Both written after construction from 2.37337.1, and classified in the registry since that build.
      "2.37337.1": ["CLAUDE_CODE_MCP_APPS_HOST", "CLAUDE_CODE_HOST_PROMPT_SUPERSEDES_RECORD"],
    });
  }, 300_000);
});

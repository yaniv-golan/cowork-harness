// The host-loop CLI fence detector (Desktop 4.16336.0). Fixtures are synthetic minified shapes built from that
// release's structure, never Desktop text.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkHostLoopPermissionKeys,
  fenceFloorFlag,
  hostLoopPermissionKeyFlags,
  permissionsSchemaKeys,
  readHostLoopFence,
} from "../src/sync/hostloop-fence.js";

const SPAWN =
  'const t=require("./index.chunk-T.js"),n=require("./index.chunk-PERM.js");' +
  'function n_(e,n){return n?"off_cli_launcher":t.s0(e,"2.1.315")?"on":"off_cli_too_old"}' +
  'async function spawn(){let nn=g&&_?n_(Yt,Pt):void 0;nn==="on"&&n.Ll(Y),nn!==void 0&&log(`fence: ${nn}${nn==="off_cli_too_old"?`, needs ${n.Ol}`:""}`);' +
  'let rn={allow:[],deny:jt,...nn==="on"&&{fileFencePaths:Nt}};' +
  't.Hft().type==="3p"&&!t.s0(Yt,"2.1.315")&&(Y.settings=h(Y.settings));' +
  'let opts={resolveReadOnlyRoots:n_(Yt,!1)==="on"};' +
  "let gn=n.Fl(Q,[...Z]);if(gn&&Q.query.applyFlagSettings({permissions:gn}).catch((e=>{})),1);}" +
  "class M{async syncHostLoopPermissions(e){let r=this.s.get(e),a=F(r),s=n.Fl(r,a),{query:c}=r;" +
  "await(c?.applyFlagSettings({permissions:{additionalDirectories:[...a],allow:[...r.allow],deny:[...r.deny],...s}}))}}";
const PERM =
  'Object.defineProperty(exports,"Ll",{enumerable:!0,get:function(){return xn}});' +
  'Object.defineProperty(exports,"Fl",{enumerable:!0,get:function(){return bn}});' +
  'Object.defineProperty(exports,"Ol",{enumerable:!0,get:function(){return vn}});' +
  'var vn="2.1.315",yn={blockReadsOutsideWorkingDirectories:!0,blockWritesOutsideWorkingDirectories:!0};' +
  "function bn(e,t){let n=e.hostLoopSpawnPermissions?.fileFencePaths;return n&&{...yn,blockReadsExemptPaths:[...new Set([...n,...e.midSessionReadOnlyPaths??[]])],workingDirectoriesAsGiven:[...t]}}" +
  'function xn(e){let t=typeof e.settings=="object"&&e.settings!==null?e.settings:{};e.settings={...t,permissions:{...t.permissions,...yn}}}';
// A prompt-builder chunk that carries the same version literal under another name: never read as the fence.
const DECOY = 'var Eo="$defaults",Do="2.1.315",Oo="text";';
const files = (o: { spawn?: string; perm?: string; decoy?: string } = {}) =>
  new Map([
    ["index.chunk-SPAWN.js", o.spawn ?? SPAWN],
    ["index.chunk-PERM.js", o.perm ?? PERM],
    ["index.chunk-DECOY.js", o.decoy ?? DECOY],
  ]);

describe("readHostLoopFence", () => {
  it("reads the floor from the gate, with the decoy literal present", () => {
    const r = readHostLoopFence(files());
    expect(r.flags).toEqual([]);
    expect(r.fence).toEqual({ minCli: "2.1.315" });
    expect(r.writers.length).toBe(4);
  });
  it("a build with no fence reads null, unflagged", () => {
    const r = readHostLoopFence(new Map([["a.js", DECOY]]));
    expect(r).toEqual({ fence: null, flags: [], writers: [] });
  });
  it.each([
    [
      "the gate's literal bumped, the log constant left alone",
      { spawn: SPAWN.replace('t.s0(e,"2.1.315")', 't.s0(e,"2.1.316")') },
      /says it needs 2\.1\.315, but the gate compares against 2\.1\.316/,
    ],
    [
      "the spawn writer's constant renamed to one that is not the two booleans",
      { perm: PERM.replace("...t.permissions,...yn}", "...t.permissions,...zn}") + "var zn={blockReadsOutsideWorkingDirectories:!0};" },
      /constant zn is/,
    ],
    [
      "the push writer given a fifth key",
      { perm: PERM.replace("workingDirectoriesAsGiven:[...t]}", "workingDirectoriesAsGiven:[...t],extra:1}") },
      /no longer returns exactly/,
    ],
    ["a third push call site", { spawn: SPAWN.replace("class M{", "let q3=n.Fl(Q,[]);class M{") }, /called at 3 site\(s\), expected 2/],
    [
      "a third gate call",
      { spawn: SPAWN.replace("class M{", "let q4=n_(Yt,!0);class M{") },
      /called at 3 site\(s\), expected 2 \(the spawn/,
    ],
    [
      "fileFencePaths written unconditionally",
      { spawn: SPAWN.replace('...nn==="on"&&{fileFencePaths:Nt}', "fileFencePaths:Nt") },
      /fileFencePaths is constructed/,
    ],
    [
      "a reshaped gate",
      { spawn: SPAWN.replace('"off_cli_launcher":t.s0', '"off_cli_launcher":!t.s0') },
      /gate function no longer has the pinned shape/,
    ],
    [
      "the sync push no longer spreads the result last",
      { spawn: SPAWN.replace("deny:[...r.deny],...s}}", "...s,deny:[...r.deny]}}") },
      /spreads the fence writer's result last/,
    ],
  ])("flags: %s", (_n, o, why) => {
    const f = files(o);
    expect([...f.values()].join("")).not.toBe([...files().values()].join("")); // the mutation applied
    expect(readHostLoopFence(f).flags.join("\n")).toMatch(why);
  });
});

describe("fenceFloorFlag (monotonic)", () => {
  it("at or above the floor a missing fence flags; below it, null is expected", () => {
    expect(fenceFloorFlag("4.16336.0", null)).toMatch(/could not be read/);
    expect(fenceFloorFlag("4.20000.0", null)).toMatch(/could not be read/);
    expect(fenceFloorFlag("4.4212.0", null)).toBeNull();
    expect(fenceFloorFlag("4.16336.0", { minCli: "2.1.315" })).toBeNull();
  });
});

describe("permissions-key tripwire", () => {
  const schema =
    'function bc(e){return u({allow:R(rc()).optional().describe("rules, {braces} in text"),deny:R(rc()).optional(),' +
    "ask:R(rc()).optional(),blockReadsExemptPaths:R(o()).optional().describe('an \"x\" path'),workingDirectoriesAsGiven:R(o()).optional()," +
    "additionalDirectories:R(o()).optional()}).passthrough()}";
  const elf = Buffer.from("\u0000junk\u0000" + schema + "\u0000tail");
  it("reads the depth-1 keys of the agent's permissions schema", () => {
    expect(permissionsSchemaKeys(elf)).toEqual([
      "allow",
      "deny",
      "ask",
      "blockReadsExemptPaths",
      "workingDirectoriesAsGiven",
      "additionalDirectories",
    ]);
  });
  it("reviewed keys pass; a schema key a writer sets that is not reviewed flags", () => {
    const keys = permissionsSchemaKeys(elf);
    const writers = readHostLoopFence(files()).writers;
    expect(checkHostLoopPermissionKeys(writers, keys)).toEqual([]);
    expect(checkHostLoopPermissionKeys([...writers, "{ask:[...r.ask]}"], keys).join("\n")).toMatch(/permissions\.ask/);
  });
  it("an unreadable schema flags while there is a fence to guard", () => {
    expect(checkHostLoopPermissionKeys(["{}"], null).join("\n")).toMatch(/could not be read/);
    expect(checkHostLoopPermissionKeys([], null)).toEqual([]);
  });
});

describe("permissions-key tripwire over both staged binaries", () => {
  const schemaWith = (extra: string) =>
    Buffer.from(
      `\u0000function bc(e){return u({allow:R(rc()).optional(),${extra}blockReadsExemptPaths:R(o()).optional(),deny:R(rc()).optional()}).passthrough()}\u0000`,
    );
  const writers = ["{allow:[],deny:[],ask:[...r.ask]}"];
  const labels = { nativeLabel: "/N/claude", elfLabel: "/V/claude" };
  it("a key only the native agent's schema has is still caught (the binary the fence is sent to)", () => {
    const r = hostLoopPermissionKeyFlags(writers, { native: schemaWith("ask:R(o()).optional(),"), elf: schemaWith(""), ...labels });
    expect(r.flags.join("\n")).toMatch(/permissions\.ask/);
    expect(r.notes).toEqual([]);
  });
  it("a key only the VM ELF's schema has is caught too", () => {
    const r = hostLoopPermissionKeyFlags(writers, { native: schemaWith(""), elf: schemaWith("ask:R(o()).optional(),"), ...labels });
    expect(r.flags.join("\n")).toMatch(/permissions\.ask/);
  });
  it("no native agent staged: the ELF stands in, and a note says the native was not read", () => {
    const r = hostLoopPermissionKeyFlags(writers, { native: null, elf: schemaWith("ask:R(o()).optional(),"), ...labels });
    expect(r.flags.join("\n")).toMatch(/permissions\.ask/);
    expect(r.notes.join("\n")).toMatch(/\/N\/claude is not staged; .* the VM ELF \/V\/claude only/);
  });
  it("neither readable: refuses; no writers: nothing to guard", () => {
    expect(hostLoopPermissionKeyFlags(writers, { native: { unreadable: "EACCES" }, elf: null, ...labels }).flags.join("")).toMatch(
      /could not be read/,
    );
    expect(hostLoopPermissionKeyFlags([], { native: null, elf: null, ...labels })).toEqual({ flags: [], notes: [] });
  });
});

// Both guards are pure functions with their own red tests; these calls are the only thing that turns their flags into
// a refused write, so each is pinned in the source (comment lines stripped), in order.
describe("sync wiring (source text): the fence's guards reach the refused-write path", () => {
  const src = (f: string) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
  it("sync flags a missing fence at or above the floor as an unknown delta", () => {
    const s = src("src/sync/cowork-sync.ts");
    const extract = s.indexOf("= extractFromAsar(unknown, gates, appVersion);");
    const floor = s.indexOf("const floor = fenceFloorFlag(appVersion, hostLoopFence);");
    const flagged = s.indexOf("if (floor) flag(unknown, floor);");
    expect(extract).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(extract);
    expect(flagged).toBeGreaterThan(floor);
    expect(s.split("fenceFloorFlag(").length - 1).toBe(1);
  });
  it("the sync command adds the permission-key tripwire's flags to the unknown deltas before deciding the write", () => {
    const s = src("src/cli.ts");
    const read = s.indexOf("= hostLoopPermissionKeyFlags(res.hostLoopFenceWriters, {");
    const push = s.indexOf("res.unknownDeltas.push(...fenceKeys.flags);");
    const decide = s.indexOf("if (res.unknownDeltas.length) {");
    expect(read).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(read);
    expect(decide).toBeGreaterThan(push);
  });
});

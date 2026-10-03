import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentBinaryError,
  parseNativeStagedPath,
  pinnedNativeAgentVersion,
  classifyNativeStagingDrift,
  resolveHostAgentBinary,
  deriveNativeStagedPath,
  nativeManifestBuild,
  nativeBuildsForPin,
  compareNativeCandidates,
} from "../src/baseline.js";
import type { PlatformBaseline } from "../src/types.js";

// Claude Desktop 2.19675.0 stages the native agent per BUILD: `claude-code/<ver>/<sha12>/claude.app/…`,
// where <sha12> is the first 12 hex characters of the manifest's bundle checksum and `<build>/.verified`
// holds the full checksum (Desktop's `Vdr`/`Hdr`/`Udr`). Before it, the layout was flat:
// `claude-code/<ver>/claude.app/…`. Every fixture below is a temp dir; nothing reads Application Support.

const LEAF = ["claude.app", "Contents", "MacOS", "claude"];
const A = "f2326db61802";
const B = "aaaaaaaaaaaa";
const C = "bbbbbbbbbbbb";
const full = (b: string) => b + "0".repeat(52);

interface Item {
  ver: string;
  /** undefined = flat (legacy) layout. */
  build?: string;
  /** Marker content. Default: the build's full checksum (nested) / none (legacy). `false` = no marker. */
  marker?: string | false;
  /** `.verified` mtime, in whole seconds. */
  mtime?: number;
}

function stage(items: Item[], root = join(mkdtempSync(join(tmpdir(), "cowork-native-")), "claude-code")): string {
  mkdirSync(root, { recursive: true });
  for (const it of items) {
    const dir = it.build ? join(root, it.ver, it.build) : join(root, it.ver);
    mkdirSync(join(dir, ...LEAF.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...LEAF), "#!/bin/sh\n");
    const marker = it.marker === undefined ? (it.build ? full(it.build) : undefined) : it.marker;
    if (marker) {
      writeFileSync(join(dir, ".verified"), marker);
      if (it.mtime !== undefined) utimesSync(join(dir, ".verified"), it.mtime, it.mtime);
    }
  }
  return root;
}
const nested = (root: string, ver: string, build: string) => join(root, ver, build, ...LEAF);
const flat = (root: string, ver: string) => join(root, ver, ...LEAF);
const pin = (nativeStagedPath: string) => ({ agentBinary: { nativeStagedPath } }) as unknown as PlatformBaseline;
const stderrOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).join("");

afterEach(() => {
  delete process.env.COWORK_HOST_AGENT_BINARY;
  delete process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK;
  vi.restoreAllMocks();
});

describe("parseNativeStagedPath / pinnedNativeAgentVersion", () => {
  it("parses a nested path into version + build — the build is never read as the version", () => {
    expect(parseNativeStagedPath(`/r/claude-code/2.1.286/${A}/claude.app/Contents/MacOS/claude`)).toEqual({
      root: "/r/claude-code",
      version: "2.1.286",
      build: A,
    });
  });

  it("parses a flat path with no build", () => {
    expect(parseNativeStagedPath("/r/claude-code/2.1.284/claude.app/Contents/MacOS/claude")).toEqual({
      root: "/r/claude-code",
      version: "2.1.284",
    });
  });

  // A hand-edited pin with an upper-case build would otherwise parse as flat, with the build read as the
  // version (and, on a case-insensitive volume, resolve "exact" to the real lower-case dir). Normalise it:
  // Desktop's own `Vdr` lowercases the checksum it names the dir after.
  it("an upper-case 12-hex build segment in a pin is normalised to lower case", () => {
    expect(parseNativeStagedPath("/r/claude-code/2.1.286/F2326DB61802/claude.app/Contents/MacOS/claude")).toEqual({
      root: "/r/claude-code",
      version: "2.1.286",
      build: "f2326db61802",
    });
    expect(pinnedNativeAgentVersion(pin("/r/claude-code/2.1.286/F2326DB61802/claude.app/Contents/MacOS/claude"))).toBe("2.1.286");
  });

  it("a segment that is not exactly 12 hex is not a build", () => {
    expect(parseNativeStagedPath("/r/claude-code/2.1.286/f2326db6180/claude.app/Contents/MacOS/claude")?.build).toBeUndefined();
    expect(parseNativeStagedPath("/r/claude-code/2.1.286/claude")).toBeUndefined();
  });

  it("pinnedNativeAgentVersion reads the version from either layout, and only under claude-code/", () => {
    expect(
      pinnedNativeAgentVersion(pin(`~/Library/Application Support/Claude/claude-code/2.1.286/${A}/claude.app/Contents/MacOS/claude`)),
    ).toBe("2.1.286");
    expect(pinnedNativeAgentVersion(pin("~/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude"))).toBe(
      "2.1.284",
    );
    expect(pinnedNativeAgentVersion(pin("/Users/x/saved/2.1.284/claude.app/Contents/MacOS/claude"))).toBeUndefined();
  });
});

describe("classifyNativeStagingDrift / resolveHostAgentBinary — nested per-build layout", () => {
  it("nested pin present and verified → exact, version read from the version dir", () => {
    const root = stage([{ ver: "2.1.286", build: A }]);
    const d = classifyNativeStagingDrift(pin(nested(root, "2.1.286", A)));
    expect(d).toMatchObject({ kind: "exact", pinned: "2.1.286", found: "2.1.286", path: nested(root, "2.1.286", A) });
  });

  it("nested pin present but with no .verified is NOT exact — Desktop treats that build as unfinished", () => {
    const root = stage([{ ver: "2.1.286", build: A, marker: false }]);
    const d = classifyNativeStagingDrift(pin(nested(root, "2.1.286", A)));
    expect(d).toMatchObject({ kind: "missing", cause: "unfinished" });
    expect(() => resolveHostAgentBinary(pin(nested(root, "2.1.286", A)))).toThrow(/\.verified/);
  });

  it("nested pin unverified, another verified build of the same version → build drift (refused by default)", () => {
    const root = stage([
      { ver: "2.1.286", build: A, marker: false },
      { ver: "2.1.286", build: B },
    ]);
    expect(classifyNativeStagingDrift(pin(nested(root, "2.1.286", A)))).toMatchObject({ kind: "build", pinnedBuild: A, foundBuild: B });
  });

  it("FLAT pin, same version migrated into a build dir → exact, relocated, no stderr", () => {
    const root = stage([{ ver: "2.1.284", build: A }]);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const b = pin(flat(root, "2.1.284"));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "exact", relocated: true, path: nested(root, "2.1.284", A) });
    expect(resolveHostAgentBinary(b)).toBe(nested(root, "2.1.284", A));
    expect(stderr).not.toHaveBeenCalled();
  });

  // A real state observed after the 2.19675.0 update: baseline 2.16120.0 pins flat 2.1.284, and Desktop has
  // staged only nested 2.1.286/<sha12>. It must resolve BY DEFAULT under the patch tolerance.
  it("FLAT pin 2.1.284, only nested 2.1.286/<build> staged → patch-tolerated with a stderr note and NO env var", () => {
    const root = stage([{ ver: "2.1.286", build: A }]);
    const b = pin(flat(root, "2.1.284"));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "patch", pinned: "2.1.284", found: "2.1.286", layout: "nested" });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(b)).toBe(nested(root, "2.1.286", A));
    const note = stderrOf(stderr);
    expect(note).toMatch(/2\.1\.284/);
    expect(note).toMatch(/2\.1\.286/);
    expect(note).not.toMatch(/COWORK_HARNESS_ALLOW_AGENT_FALLBACK/);
  });

  it("nested pin 2.1.284/<A>, only nested 2.1.286/<B> → patch (the version, not the hash, is compared)", () => {
    const root = stage([{ ver: "2.1.286", build: B }]);
    expect(classifyNativeStagingDrift(pin(nested(root, "2.1.284", A)))).toMatchObject({
      kind: "patch",
      pinned: "2.1.284",
      found: "2.1.286",
    });
  });

  it("nested major/minor drift → throws naming the found version and the env var; resolves WITH it", () => {
    const root = stage([{ ver: "2.2.0", build: B }]);
    const b = pin(nested(root, "2.1.284", A));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "major-minor", pinned: "2.1.284", found: "2.2.0" });
    expect(() => resolveHostAgentBinary(b)).toThrow(/COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1/);
    expect(() => resolveHostAgentBinary(b)).toThrow(/2\.2\.0/);
    process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK = "1";
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(b)).toBe(nested(root, "2.2.0", B));
  });

  it("several builds, the pinned one present → that build, even when another is newer", () => {
    const root = stage([
      { ver: "2.1.286", build: A, mtime: 100 },
      { ver: "2.1.286", build: B, mtime: 200 },
    ]);
    expect(classifyNativeStagingDrift(pin(nested(root, "2.1.286", A)))).toMatchObject({
      kind: "exact",
      pinned: "2.1.286",
      path: nested(root, "2.1.286", A),
    });
  });

  // The mirror of the flat-pin patch case: a NESTED pin names a build, and a different build of the same
  // version is a different binary. Refused unless the fallback env is set.
  it("nested pin names build A; only build B of the same version is staged → refused unless COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1", () => {
    const root = stage([
      { ver: "2.1.286", build: B, mtime: 100 },
      { ver: "2.1.286", build: C, mtime: 200 },
    ]);
    const b = pin(nested(root, "2.1.286", A));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "build", pinned: "2.1.286", pinnedBuild: A, foundBuild: C });
    expect(() => resolveHostAgentBinary(b)).toThrow(/COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1/);
    expect(() => resolveHostAgentBinary(b)).toThrow(new RegExp(A));
    process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(b)).toBe(nested(root, "2.1.286", C));
    expect(stderrOf(stderr)).toMatch(new RegExp(`${A}[\\s\\S]*${C}`));
  });

  it("flat pin with several builds of its version → newest .verified wins, with a stderr note naming the others", () => {
    const root = stage([
      { ver: "2.1.286", build: B, mtime: 100 },
      { ver: "2.1.286", build: C, mtime: 200 },
    ]);
    const b = pin(flat(root, "2.1.286"));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "exact", path: nested(root, "2.1.286", C), others: [B] });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(b)).toBe(nested(root, "2.1.286", C));
    expect(stderrOf(stderr)).toMatch(new RegExp(`${C}[\\s\\S]*${B}|${B}[\\s\\S]*${C}`));
  });

  it("the order is .verified mtime, not the dir name", () => {
    const root = stage([
      { ver: "2.1.286", build: B, mtime: 200 },
      { ver: "2.1.286", build: C, mtime: 100 },
    ]);
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ path: nested(root, "2.1.286", B) });
  });

  it("a single build under a flat pin is silent", () => {
    const root = stage([{ ver: "2.1.286", build: B }]);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    resolveHostAgentBinary(pin(flat(root, "2.1.286")));
    expect(stderr).not.toHaveBeenCalled();
  });

  // On APFS readdir already returns names sorted, so this on-disk case agrees with the tie-break without
  // proving it; the pure compareNativeCandidates test below is what pins the tie-break.
  it("equal mtimes on disk resolve to the lower build name", () => {
    const root = stage([
      { ver: "2.1.286", build: C, mtime: 100 },
      { ver: "2.1.286", build: B, mtime: 100 },
    ]);
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ path: nested(root, "2.1.286", B) });
  });

  it("the choice order is total: mtime, then per-build before flat, then build name — independent of input order", () => {
    const c = (build: string, publishedMs: number, layout: "nested" | "flat" = "nested") => ({ build, publishedMs, layout });
    expect([c(C, 100), c(B, 100)].sort(compareNativeCandidates).map((x) => x.build)).toEqual([B, C]);
    expect([c(B, 100), c(C, 200)].sort(compareNativeCandidates).map((x) => x.build)).toEqual([C, B]);
    expect([c(A, 100, "flat"), c(C, 100)].sort(compareNativeCandidates).map((x) => x.layout)).toEqual(["nested", "flat"]);
  });

  it("a build with no .verified is skipped even when it is the only newer one", () => {
    const root = stage([
      { ver: "2.1.286", build: B, mtime: 100 },
      { ver: "2.1.286", build: C, marker: false },
    ]);
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ path: nested(root, "2.1.286", B) });
  });

  it("a build whose .verified does not name it is skipped (one identity rule: marker[:12] == dir name)", () => {
    const root = stage([{ ver: "2.1.286", build: B, marker: full(C) }]);
    const d = classifyNativeStagingDrift(pin(flat(root, "2.1.286")));
    expect(d).toMatchObject({ kind: "missing", cause: "unusable-build" }); // not "unfinished": Desktop did not leave it mid-staging
  });

  it("flat and nested in one version: nested wins over an unverified flat install; a flat one alone still resolves", () => {
    const root = stage([{ ver: "2.1.286" }, { ver: "2.1.286", build: B }]);
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ path: nested(root, "2.1.286", B) });
    const only = stage([{ ver: "2.1.286" }]);
    expect(classifyNativeStagingDrift(pin(flat(only, "2.1.286")))).toMatchObject({ kind: "exact", path: flat(only, "2.1.286") });
  });

  it("a VERIFIED flat install joins the mtime order with the builds", () => {
    const root = stage([
      { ver: "2.1.286", marker: full(C), mtime: 300 },
      { ver: "2.1.286", build: B, mtime: 100 },
    ]);
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ path: flat(root, "2.1.286") });
  });

  it("a flat install whose .verified names the pinned build is that build", () => {
    const root = stage([{ ver: "2.1.286", marker: full(A) }]);
    expect(classifyNativeStagingDrift(pin(nested(root, "2.1.286", A)))).toMatchObject({ kind: "exact", path: flat(root, "2.1.286") });
  });

  it("a symlinked build dir is ignored, as Desktop's Dirent.isDirectory() filter ignores it", () => {
    const root = stage([{ ver: "2.1.290", build: C }]);
    mkdirSync(join(root, "2.1.286"));
    symlinkSync(join(root, "2.1.290", C), join(root, "2.1.286", C));
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({
      kind: "patch",
      found: "2.1.290",
      path: nested(root, "2.1.290", C),
    });
  });

  it("no binary under either layout, an unrecognised dir present → missing / unknown-layout, naming it", () => {
    const root = stage([]);
    mkdirSync(join(root, "2.1.286", "weird", ...LEAF.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, "2.1.286", "weird", ...LEAF), "x");
    const b = pin(flat(root, "2.1.286"));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "missing", cause: "unknown-layout" });
    expect(() => resolveHostAgentBinary(b)).toThrow(/2\.1\.286\/weird/);
  });

  it("Desktop's own dot-entries (.extract-*, .verified) are not an unknown layout", () => {
    const root = stage([]);
    mkdirSync(join(root, "2.1.286", ".extract-x1y2"), { recursive: true });
    writeFileSync(join(root, "2.1.286", ".verified"), full(A));
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ kind: "missing", cause: "missing" });
  });

  it("claude-code/ absent (no Desktop, or Linux) → missing-root, naming the root", () => {
    const root = join(mkdtempSync(join(tmpdir(), "cowork-native-")), "claude-code");
    const b = pin(flat(root, "2.1.286"));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "missing", cause: "missing-root" });
    expect(() => resolveHostAgentBinary(b)).toThrow(root);
  });

  it("an empty claude-code/ names both layouts it checked", () => {
    const root = stage([]);
    expect(() => resolveHostAgentBinary(pin(flat(root, "2.1.286")))).toThrow(/<ver>\/claude\.app.*<ver>\/<build>\/claude\.app/);
  });
});

describe("deriveNativeStagedPath (sync)", () => {
  const home = () => mkdtempSync(join(tmpdir(), "cowork-home-"));
  const rootIn = (h: string) => join(h, "Library/Application Support/Claude/claude-code");
  const T = "~/Library/Application Support/Claude/claude-code";

  it("flat layout → the flat path, ~-prefixed", () => {
    const h = home();
    stage([{ ver: "2.1.205" }], rootIn(h));
    const r = deriveNativeStagedPath({ nativeRoot: rootIn(h), homeDir: h, oldNativeStagedPath: "", agentVersion: "2.1.202" });
    expect(r).toEqual({ path: `${T}/2.1.205/claude.app/Contents/MacOS/claude`, warnings: [] });
  });

  it("nested layout → the full build path, which exists", () => {
    const h = home();
    stage([{ ver: "2.1.286", build: A }], rootIn(h));
    const r = deriveNativeStagedPath({ nativeRoot: rootIn(h), homeDir: h, oldNativeStagedPath: "", agentVersion: "2.1.286" });
    expect(r.path).toBe(`${T}/2.1.286/${A}/claude.app/Contents/MacOS/claude`);
    expect(existsSync(r.path.replace(/^~/, h))).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("several builds: the asar manifest's build wins when its version matches, even if older", () => {
    const h = home();
    stage(
      [
        { ver: "2.1.286", build: A, mtime: 100 },
        { ver: "2.1.286", build: B, mtime: 200 },
      ],
      rootIn(h),
    );
    const args = { nativeRoot: rootIn(h), homeDir: h, oldNativeStagedPath: "", agentVersion: "2.1.286" };
    expect(deriveNativeStagedPath({ ...args, manifestBuild: { version: "2.1.286", build: A } }).path).toContain(`/${A}/`);
    // A manifest for another version does not apply: mtime order.
    expect(deriveNativeStagedPath({ ...args, manifestBuild: { version: "2.1.290", build: A } }).path).toContain(`/${B}/`);
    // The named build is not staged: mtime order, with a WARNING.
    const r = deriveNativeStagedPath({ ...args, manifestBuild: { version: "2.1.286", build: C } });
    expect(r.path).toContain(`/${B}/`);
    expect(r.warnings.join("\n")).toMatch(new RegExp(`${C}[\\s\\S]*not staged`));
  });

  it("nothing staged → the flat-shape fallback for agentVersion, with a WARNING and no private backup path", () => {
    const h = home();
    const r = deriveNativeStagedPath({
      nativeRoot: rootIn(h),
      homeDir: h,
      oldNativeStagedPath: `${T}/2.1.284/${A}/claude.app/Contents/MacOS/claude`,
      agentVersion: "2.1.290",
    });
    expect(r.path).toBe(`${T}/2.1.290/claude.app/Contents/MacOS/claude`);
    expect(r.warnings.join("\n")).toMatch(/does not exist/);
    expect(r.warnings.join("\n")).not.toMatch(/cowork-agent-backup/);
  });

  it("nativeManifestBuild reads the build for this arch from the descriptor, only when present", () => {
    const ch = { baseUrl: "u", sdkVersion: "2.1.286", nativeBuilds: { "darwin-arm64": A, "darwin-x64": B } };
    expect(nativeManifestBuild(ch, "arm64")).toEqual({ version: "2.1.286", build: A });
    expect(nativeManifestBuild(ch, "x64")).toEqual({ version: "2.1.286", build: B });
    expect(nativeManifestBuild({ baseUrl: "u", sdkVersion: "2.1.286" }, "arm64")).toBeUndefined();
    expect(nativeManifestBuild(null, "arm64")).toBeUndefined();
  });
});

describe("sync wiring (source guard — sync itself is never run in tests)", () => {
  const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
  it("cmdSync derives the native path through deriveNativeStagedPath, passing the asar manifest build", () => {
    expect(cli).toMatch(/deriveNativeStagedPath\(\{[\s\S]{0,400}manifestBuild: nativeManifestBuild\(/);
  });
  it("cli.ts builds no native claude.app path of its own", () => {
    expect(cli).not.toMatch(/claude\.app\/Contents\/MacOS\/claude/);
    expect(cli).not.toMatch(/claude-code\/\$\{/);
    expect(cli).not.toMatch(/cowork-agent-backup/);
  });
  it("cmdSync logs every warning deriveNativeStagedPath returns", () => {
    expect(cli).toMatch(/for \(const w of nativeDerived\.warnings\) log\(w\);/);
  });
});

/** The `kind` a resolver failure carries — what doctor keys its remedy on. */
function kindOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AgentBinaryError ? e.kind : `not an AgentBinaryError: ${(e as Error).message}`;
  }
  return undefined;
}

describe("resolveHostAgentBinary — the thrown kind matches the cause", () => {
  it("major-minor, build, unfinished, unusable-build, unknown-layout, missing-root, missing, override", () => {
    const mm = stage([{ ver: "2.2.0", build: B }]);
    expect(kindOf(() => resolveHostAgentBinary(pin(nested(mm, "2.1.284", A))))).toBe("major-minor");
    const bd = stage([{ ver: "2.1.286", build: B }]);
    expect(kindOf(() => resolveHostAgentBinary(pin(nested(bd, "2.1.286", A))))).toBe("build");
    const un = stage([{ ver: "2.1.286", build: A, marker: false }]);
    expect(kindOf(() => resolveHostAgentBinary(pin(flat(un, "2.1.286"))))).toBe("unfinished");
    const ub = stage([{ ver: "2.1.286", build: B, marker: full(C) }]);
    expect(kindOf(() => resolveHostAgentBinary(pin(flat(ub, "2.1.286"))))).toBe("unusable-build");
    const uk = stage([]);
    mkdirSync(join(uk, "2.1.286", "weird"), { recursive: true });
    expect(kindOf(() => resolveHostAgentBinary(pin(flat(uk, "2.1.286"))))).toBe("unknown-layout");
    const nr = join(mkdtempSync(join(tmpdir(), "cowork-native-")), "claude-code");
    expect(kindOf(() => resolveHostAgentBinary(pin(flat(nr, "2.1.286"))))).toBe("missing-root");
    expect(kindOf(() => resolveHostAgentBinary(pin(flat(stage([]), "2.1.286"))))).toBe("missing");
    process.env.COWORK_HOST_AGENT_BINARY = "/nonexistent/claude";
    expect(kindOf(() => resolveHostAgentBinary(pin(flat(stage([]), "2.1.286"))))).toBe("override");
  });
});

describe("resolveHostAgentBinary — review fixes", () => {
  it("flat pin whose file still exists, a verified build of the same version also staged → runs the build and says so, naming both paths", () => {
    const root = stage([{ ver: "2.1.286" }, { ver: "2.1.286", build: B }]);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(pin(flat(root, "2.1.286")))).toBe(nested(root, "2.1.286", B));
    const out = stderrOf(stderr);
    expect(out).toContain(flat(root, "2.1.286"));
    expect(out).toContain(nested(root, "2.1.286", B));
  });

  it("a build dir whose .verified names it but holds no binary is diagnosed as such", () => {
    const root = stage([]);
    mkdirSync(join(root, "2.1.286", B), { recursive: true });
    writeFileSync(join(root, "2.1.286", B, ".verified"), full(B));
    expect(() => resolveHostAgentBinary(pin(flat(root, "2.1.286")))).toThrow(new RegExp(`2\\.1\\.286/${B}[^;]*no claude\\.app binary`));
  });

  it("a build dir whose .verified names another build is diagnosed as such", () => {
    const root = stage([{ ver: "2.1.286", build: B, marker: full(C) }]);
    expect(() => resolveHostAgentBinary(pin(flat(root, "2.1.286")))).toThrow(new RegExp(`2\\.1\\.286/${B}[^;]*names build ${C}`));
  });

  it("a build dir holding a bare claude binary (Desktop's non-bundle shape) is diagnosed as such", () => {
    const root = stage([]);
    mkdirSync(join(root, "2.1.286", B), { recursive: true });
    writeFileSync(join(root, "2.1.286", B, "claude"), "x");
    writeFileSync(join(root, "2.1.286", B, ".verified"), full(B));
    expect(() => resolveHostAgentBinary(pin(flat(root, "2.1.286")))).toThrow(new RegExp(`2\\.1\\.286/${B}[^;]*bare claude binary`));
  });

  it("pinned build present but unfinished, an OLDER patch staged → patch-older, and the note names the unfinished pinned build", () => {
    const root = stage([
      { ver: "2.1.286", build: A, marker: false },
      { ver: "2.1.284", build: B },
    ]);
    const b = pin(nested(root, "2.1.286", A));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "patch", found: "2.1.284" });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(b)).toBe(nested(root, "2.1.284", B));
    const note = stderrOf(stderr);
    expect(note).toMatch(/patch-older 2\.1\.284/);
    expect(note).toContain(`2.1.286/${A}`);
    expect(note).not.toMatch(/pruned|patch-newer/);
  });

  it("pinned version not staged at all, a newer patch staged → patch-newer, 'not staged'", () => {
    const root = stage([{ ver: "2.1.290", build: B }]);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    resolveHostAgentBinary(pin(flat(root, "2.1.286")));
    expect(stderrOf(stderr)).toMatch(/2\.1\.286 is not staged; using patch-newer 2\.1\.290/);
  });

  it("an upper-case build in the pin resolves to the lower-case build dir as exact", () => {
    const root = stage([{ ver: "2.1.286", build: A }]);
    const upper = join(root, "2.1.286", A.toUpperCase(), ...LEAF);
    expect(classifyNativeStagingDrift(pin(upper))).toMatchObject({ kind: "exact", pinned: "2.1.286", path: nested(root, "2.1.286", A) });
  });

  // A harness rule for the FALLBACK search over other versions only (Desktop never enumerates versions):
  // without it, 2.1.299 -> 2.1.286 would report the 2.1.286 binary as version 2.1.299.
  it("a symlinked OTHER-version dir is skipped in the fallback search", () => {
    const root = stage([{ ver: "2.1.286", build: B }]);
    symlinkSync(join(root, "2.1.286"), join(root, "2.1.299"));
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.284")))).toMatchObject({ kind: "patch", found: "2.1.286" });
  });

  // The PINNED version dir is followed through a symlink, as Desktop follows it (it joins storageDir and the
  // version, and applies isDirectory only to build dirs).
  it("a symlinked PINNED version dir resolves exact — flat pin", () => {
    const real = stage([{ ver: "2.1.284" }]);
    const root = stage([]);
    symlinkSync(join(real, "2.1.284"), join(root, "2.1.284"));
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.284")))).toMatchObject({ kind: "exact", path: flat(root, "2.1.284") });
  });

  it("a symlinked PINNED version dir resolves exact — nested pin", () => {
    const real = stage([{ ver: "2.1.286", build: A }]);
    const root = stage([]);
    symlinkSync(join(real, "2.1.286"), join(root, "2.1.286"));
    expect(classifyNativeStagingDrift(pin(nested(root, "2.1.286", A)))).toMatchObject({ kind: "exact", path: nested(root, "2.1.286", A) });
  });

  // Decided behaviour: a pinned version dir is followed through a symlink, as Desktop follows it, so a pin
  // of 2.1.299 that links to 2.1.286 resolves exact and runs the 2.1.286 binary. The resolver says so on
  // stderr, naming the link target's version, because the version that runs is not the one the pin names.
  it("a pinned version dir that is a symlink to ANOTHER version → exact as the pin, with a stderr note naming the target version", () => {
    const root = stage([{ ver: "2.1.286", build: B }]);
    symlinkSync(join(root, "2.1.286"), join(root, "2.1.299"));
    const b = pin(flat(root, "2.1.299"));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "exact", found: "2.1.299", pinnedLinkTarget: "2.1.286" });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(resolveHostAgentBinary(b)).toBe(nested(root, "2.1.299", B));
    expect(stderrOf(stderr)).toMatch(/pinned native agent version dir .*2\.1\.299.* is a symlink to 2\.1\.286/);
  });

  it("a pinned version dir symlinked to a dir of the SAME name is silent", () => {
    const real = stage([{ ver: "2.1.284", build: B }]);
    const root = stage([]);
    symlinkSync(join(real, "2.1.284"), join(root, "2.1.284"));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    resolveHostAgentBinary(pin(flat(root, "2.1.284")));
    expect(stderr).not.toHaveBeenCalled();
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.284")))).not.toHaveProperty("pinnedLinkTarget");
  });

  it("a symlinked pinned dir holding only an unfinished build → cause unfinished, naming it", () => {
    const real = stage([{ ver: "2.1.286", build: B, marker: false }]);
    const root = stage([]);
    symlinkSync(join(real, "2.1.286"), join(root, "2.1.286"));
    const b = pin(flat(root, "2.1.286"));
    expect(classifyNativeStagingDrift(b)).toMatchObject({ kind: "missing", cause: "unfinished" });
    expect(() => resolveHostAgentBinary(b)).toThrow(new RegExp(`2\\.1\\.286/${B} has no \\.verified marker`));
  });

  it("a symlinked pinned dir holding only an unknown entry → cause unknown-layout", () => {
    const real = stage([]);
    mkdirSync(join(real, "2.1.286", "weird"), { recursive: true });
    const root = stage([]);
    symlinkSync(join(real, "2.1.286"), join(root, "2.1.286"));
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ kind: "missing", cause: "unknown-layout" });
  });

  it("a .verified that is not a 64-hex checksum does not name a build, even when it starts with the dir name", () => {
    for (const marker of [`${B} junk`, B, full(B).slice(0, 63), full(B) + "0"]) {
      const root = stage([{ ver: "2.1.286", build: B, marker }]);
      expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286"))), marker).toMatchObject({ kind: "missing", cause: "unfinished" });
    }
  });

  it("mixed unusable dirs (one unmarked, one naming another build) → unusable-build, not unfinished", () => {
    const root = stage([
      { ver: "2.1.286", build: B, marker: false },
      { ver: "2.1.286", build: C, marker: full(A) },
    ]);
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ kind: "missing", cause: "unusable-build" });
  });

  it("COWORK_HARNESS_ALLOW_AGENT_FALLBACK enables the fallback only when it is exactly '1'", () => {
    const mm = stage([{ ver: "2.2.0", build: B }]);
    const bd = stage([{ ver: "2.1.286", build: B }]);
    for (const v of ["0", "true", "yes", ""]) {
      process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK = v;
      expect(
        kindOf(() => resolveHostAgentBinary(pin(nested(mm, "2.1.284", A)))),
        v,
      ).toBe("major-minor");
      expect(
        kindOf(() => resolveHostAgentBinary(pin(nested(bd, "2.1.286", A)))),
        v,
      ).toBe("build");
    }
  });

  it("the pinned flat file still present beside the chosen build is recorded on the drift (doctor's note reads it)", () => {
    const root = stage([{ ver: "2.1.286" }, { ver: "2.1.286", build: B }]);
    expect(classifyNativeStagingDrift(pin(flat(root, "2.1.286")))).toMatchObject({ relocated: true, pinnedFilePresent: true });
    const gone = stage([{ ver: "2.1.286", build: B }]);
    expect(classifyNativeStagingDrift(pin(flat(gone, "2.1.286")))).not.toHaveProperty("pinnedFilePresent");
  });

  it("nested pin vs an unmarked flat install of the same version → refused, saying the build cannot be confirmed", () => {
    const root = stage([{ ver: "2.1.286" }]);
    expect(() => resolveHostAgentBinary(pin(nested(root, "2.1.286", A)))).toThrow(/cannot be confirmed/);
  });

  it("nested pin vs another build of the same version → the refusal says another CPU architecture's build differs too", () => {
    const root = stage([{ ver: "2.1.286", build: B }]);
    expect(() => resolveHostAgentBinary(pin(nested(root, "2.1.286", A)))).toThrow(/CPU architecture/);
  });

  it("a .verified with a trailing CRLF, or upper-case hex, still names its build", () => {
    const root = stage([
      { ver: "2.1.286", build: A, marker: full(A) + "\r\n" },
      { ver: "2.1.290", build: B, marker: full(B).toUpperCase() },
    ]);
    expect(classifyNativeStagingDrift(pin(nested(root, "2.1.286", A)))).toMatchObject({ kind: "exact" });
    expect(classifyNativeStagingDrift(pin(nested(root, "2.1.290", B)))).toMatchObject({ kind: "exact" });
  });

  it("COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 with an exact match is silent", () => {
    const root = stage([{ ver: "2.1.286", build: A }]);
    process.env.COWORK_HARNESS_ALLOW_AGENT_FALLBACK = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    resolveHostAgentBinary(pin(nested(root, "2.1.286", A)));
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("deriveNativeStagedPath (sync) — notes", () => {
  it("nothing runnable but an unfinished build staged → the WARNING names that dir and why", () => {
    const h = mkdtempSync(join(tmpdir(), "cowork-home-"));
    stage([{ ver: "2.1.286", build: B, marker: false }], join(h, "Library/Application Support/Claude/claude-code"));
    const r = deriveNativeStagedPath({
      nativeRoot: join(h, "Library/Application Support/Claude/claude-code"),
      homeDir: h,
      oldNativeStagedPath: "",
      agentVersion: "2.1.286",
    });
    expect(r.warnings.join("\n")).toContain(`2.1.286/${B} has no .verified marker`);
  });

  it("a marked flat install that is not the manifest's build → 'pinning the flat install'", () => {
    const h = mkdtempSync(join(tmpdir(), "cowork-home-"));
    stage([{ ver: "2.1.286", marker: full(B) }], join(h, "Library/Application Support/Claude/claude-code"));
    const r = deriveNativeStagedPath({
      nativeRoot: join(h, "Library/Application Support/Claude/claude-code"),
      homeDir: h,
      oldNativeStagedPath: "",
      agentVersion: "2.1.286",
      manifestBuild: { version: "2.1.286", build: A },
    });
    expect(r.warnings.join("\n")).toContain("pinning the flat install");
  });

  const home = () => mkdtempSync(join(tmpdir(), "cowork-home-"));
  const rootIn = (h: string) => join(h, "Library/Application Support/Claude/claude-code");

  it("several builds and no applicable manifest → a NOTE naming the build pinned and the ones passed over", () => {
    const h = home();
    stage(
      [
        { ver: "2.1.286", build: B, mtime: 100 },
        { ver: "2.1.286", build: C, mtime: 200 },
      ],
      rootIn(h),
    );
    const r = deriveNativeStagedPath({ nativeRoot: rootIn(h), homeDir: h, oldNativeStagedPath: "", agentVersion: "2.1.286" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(new RegExp(`^NOTE: 2 builds[\\s\\S]*pinning ${C}[\\s\\S]*${B}`));
  });

  it("a flat install with no marker, manifest for that version → a NOTE that its build is unknown, not a WARNING", () => {
    const h = home();
    stage([{ ver: "2.1.286" }], rootIn(h));
    const r = deriveNativeStagedPath({
      nativeRoot: rootIn(h),
      homeDir: h,
      oldNativeStagedPath: "",
      agentVersion: "2.1.286",
      manifestBuild: { version: "2.1.286", build: A },
    });
    expect(r.warnings.join("\n")).not.toMatch(/WARNING/);
    expect(r.warnings.join("\n")).toMatch(/^NOTE:.*no \.verified marker/);
  });
});

// A per-build pin is per CPU ARCHITECTURE: the darwin-arm64 and darwin-x64 bundles have different checksums, so
// the same version stages under a different <build> on each. `agentBinary.nativeBuilds` records the build per
// arch (from the asar's SDK descriptor), and the resolver checks the build ONLY against the host arch's entry.
// With no entry for the host arch it matches by version, with a note. A baseline without the map keeps the old
// rule (the build in nativeStagedPath).
describe("per-arch native build pin (agentBinary.nativeBuilds)", () => {
  const X = "fda00b160da4"; // the x64 build of the same version
  const withArch = (arch: string, fn: () => void) => {
    const saved = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "arch", saved);
    }
  };
  const pinned = (root: string, nativeBuilds?: Record<string, string>) =>
    ({
      agentBinary: { nativeStagedPath: nested(root, "2.1.286", A), ...(nativeBuilds ? { nativeBuilds } : {}) },
    }) as unknown as PlatformBaseline;

  it("x64 host, arm64-only map, the x64 build staged → resolves by version, with a note naming the missing entry", () =>
    withArch("x64", () => {
      const root = stage([{ ver: "2.1.286", build: X }]);
      const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(resolveHostAgentBinary(pinned(root, { arm64: A }))).toBe(nested(root, "2.1.286", X));
      expect(stderrOf(spy)).toMatch(
        /pins no native build for x64 \(only arm64\); matching 2\.1\.286 by version — running build fda00b160da4/,
      );
    }));

  it("x64 host, map with an x64 entry, that build staged → exact, no note", () =>
    withArch("x64", () => {
      const root = stage([{ ver: "2.1.286", build: X }]);
      const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(resolveHostAgentBinary(pinned(root, { arm64: A, x64: X }))).toBe(nested(root, "2.1.286", X));
      expect(stderrOf(spy)).toBe("");
    }));

  it("x64 host, map with an x64 entry, only a DIFFERENT x64 build staged → refuses (kind build)", () =>
    withArch("x64", () => {
      const root = stage([{ ver: "2.1.286", build: C }]);
      expect(() => resolveHostAgentBinary(pinned(root, { arm64: A, x64: X }))).toThrow(AgentBinaryError);
      expect(classifyNativeStagingDrift(pinned(root, { arm64: A, x64: X }))).toMatchObject({ kind: "build", pinnedBuild: X });
    }));

  it("arm64 host, a different arm64 build of the same version staged → still refuses (the host entry is checked)", () =>
    withArch("arm64", () => {
      const root = stage([{ ver: "2.1.286", build: B }]);
      expect(() => resolveHostAgentBinary(pinned(root, { arm64: A, x64: X }))).toThrow(/build f2326db61802 is not staged/);
    }));

  it("arm64 host, the arm64 build staged → exact", () =>
    withArch("arm64", () => {
      const root = stage([
        { ver: "2.1.286", build: A },
        { ver: "2.1.286", build: X },
      ]);
      expect(resolveHostAgentBinary(pinned(root, { arm64: A, x64: X }))).toBe(nested(root, "2.1.286", A));
    }));

  it("an old flat baseline (no map) is unchanged on either arch: version match, any build", () => {
    for (const arch of ["arm64", "x64"])
      withArch(arch, () => {
        const root = stage([{ ver: "2.1.284", build: X }]);
        vi.spyOn(process.stderr, "write").mockReturnValue(true);
        expect(resolveHostAgentBinary(pin(flat(root, "2.1.284")))).toBe(nested(root, "2.1.284", X));
      });
  });

  it("a nested pin WITHOUT a map keeps the path's build as the pin (pre-map behaviour)", () =>
    withArch("x64", () => {
      const root = stage([{ ver: "2.1.286", build: X }]);
      expect(() => resolveHostAgentBinary(pinned(root))).toThrow(AgentBinaryError);
    }));
});

describe("nativeBuildsForPin (sync's agentBinary.nativeBuilds)", () => {
  const ch = { sdkVersion: "2.1.286", nativeBuilds: { "darwin-arm64": A, "darwin-x64": "fda00b160da4" } };
  it("records both arches for the pinned version", () =>
    expect(nativeBuildsForPin(ch, "/r/claude-code/2.1.286/" + A + "/claude.app/Contents/MacOS/claude")).toEqual({
      arm64: A,
      x64: "fda00b160da4",
    }));
  it("records nothing when the descriptor is for another version (after an auto-update)", () =>
    expect(nativeBuildsForPin(ch, "/r/claude-code/2.1.287/" + A + "/claude.app/Contents/MacOS/claude")).toBeUndefined());
  it("records only the arches the descriptor names, and nothing without a channel", () => {
    expect(
      nativeBuildsForPin(
        { sdkVersion: "2.1.286", nativeBuilds: { "darwin-x64": "fda00b160da4" } },
        "/r/claude-code/2.1.286/claude.app/Contents/MacOS/claude",
      ),
    ).toEqual({
      x64: "fda00b160da4",
    });
    expect(nativeBuildsForPin(null, "/r/claude-code/2.1.286/claude.app/Contents/MacOS/claude")).toBeUndefined();
  });
});

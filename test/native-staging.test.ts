import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNativeStagedPath,
  pinnedNativeAgentVersion,
  classifyNativeStagingDrift,
  resolveHostAgentBinary,
  deriveNativeStagedPath,
  nativeManifestBuild,
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

  it("a segment that is not exactly 12 lowercase hex is not a build (Desktop's /^[0-9a-f]{12}$/)", () => {
    expect(parseNativeStagedPath("/r/claude-code/2.1.286/F2326DB61802/claude.app/Contents/MacOS/claude")).toEqual({
      root: "/r/claude-code/2.1.286",
      version: "F2326DB61802",
    });
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

  // This machine's real state on 2026-10-01: baseline 2.16120.0 pins flat 2.1.284; Desktop 2.19675.0 has
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

  it("equal mtimes tie-break on the dir name, whatever order the dirs were created in", () => {
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
    expect(d).toMatchObject({ kind: "missing", cause: "unfinished" });
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
});

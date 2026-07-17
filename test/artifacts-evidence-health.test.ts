import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  classifyWorkspaceFiles,
  classifyWorkspaceFilesWithHealth,
  captureAuthoredFiles,
  captureAuthoredFilesWithHealth,
  collectArtifactsWithHealth,
} from "../src/run/artifacts.js";
import { capturePreRunManifest, readPreRunManifestUnavailableReasons, readPreRunManifestStats } from "../src/run/pre-run-manifest.js";
import type { LaunchPlan } from "../src/session.js";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

// Arm-able node:fs failures + call-recording, mirroring the established pattern in
// artifact-json-stat-throw.test.ts (vi.spyOn cannot redefine ESM named exports of node:fs — this repo's
// tests use vi.mock + importOriginal instead). Every override delegates to the REAL implementation unless
// a specific armed condition matches, so every other test/file in this suite is unaffected.
const hooks = vi.hoisted(() => ({
  blockOpenPath: undefined as string | undefined,
  blockReaddirPath: undefined as string | undefined,
  readFileSyncPaths: [] as string[],
  readSyncCalls: [] as { bufLen: number; length?: number }[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((...args: unknown[]) => {
      hooks.readFileSyncPaths.push(String(args[0]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readFileSync as any)(...args);
    }) as typeof real.readFileSync,
    readSync: ((...args: unknown[]) => {
      const buf = args[1] as Buffer;
      const length = typeof args[3] === "number" ? (args[3] as number) : undefined;
      hooks.readSyncCalls.push({ bufLen: buf.length, length });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readSync as any)(...args);
    }) as typeof real.readSync,
    openSync: ((...args: unknown[]) => {
      if (hooks.blockOpenPath && String(args[0]) === hooks.blockOpenPath) {
        throw Object.assign(new Error("ENOENT: simulated race"), { code: "ENOENT" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.openSync as any)(...args);
    }) as typeof real.openSync,
    readdirSync: ((...args: unknown[]) => {
      if (hooks.blockReaddirPath && String(args[0]) === hooks.blockReaddirPath) {
        throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real.readdirSync as any)(...args);
    }) as typeof real.readdirSync,
  };
});

beforeEach(() => {
  hooks.blockOpenPath = undefined;
  hooks.blockReaddirPath = undefined;
  hooks.readFileSyncPaths = [];
  hooks.readSyncCalls = [];
});

function minimalPlan(mounts: LaunchPlan["mounts"] = [], resume = false): LaunchPlan {
  return {
    configDir: mkdtempSync(join(tmpdir(), "cwh-evh-cfg-")),
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts,
    pluginDirs: [],
    egressAllow: [],
    resume,
    capturePreRun: true,
  };
}

describe("F12: classifyWorkspaceFiles size-caps the hash instead of reading the whole file", () => {
  it("marks an over-cap file hashError:'over-cap' and never reads it whole", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f12-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "big.bin"), "x".repeat(10_000));
    writeFileSync(join(root, "outputs", "small.txt"), "under cap");

    const got = classifyWorkspaceFiles(root, ["outputs"], [], { hashCapBytes: 100 });
    const big = got.find((f) => f.path === "outputs/big.bin")!;
    const small = got.find((f) => f.path === "outputs/small.txt")!;

    expect(big.hashError).toBe("over-cap");
    expect(big.sha256).toBeUndefined();
    expect(small.sha256).toBe(sha("under cap"));

    // The over-cap path must never be passed to readFileSync (statSync alone decides) — a whole-file
    // read is exactly the memory spike F12 guards against.
    expect(hooks.readFileSyncPaths.some((p) => p.endsWith("big.bin"))).toBe(false);
    expect(hooks.readFileSyncPaths.some((p) => p.endsWith("small.txt"))).toBe(true);
  });

  it("defaults to the 50 MiB cap when no override is given (a small file is unaffected)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f12-default-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "small.txt"), "hello");
    const got = classifyWorkspaceFiles(root, ["outputs"], []);
    expect(got[0].sha256).toBe(sha("hello"));
    expect(got[0].hashError).toBeUndefined();
  });
});

describe("F13: captureAuthoredFiles reads only the capped prefix via a bounded fd read", () => {
  it("a large authored file's retained content is exactly the per-file cap, read via a bounded readSync", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f13-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    const body = "A".repeat(50_000);
    writeFileSync(join(root, "outputs", "big.txt"), body);

    const got = captureAuthoredFiles(root, ["outputs"], [], {}, { perFileBytes: 200, totalBytes: 1024 });

    expect(got).toHaveLength(1);
    expect(got[0].truncated).toBe(true);
    expect(got[0].content).toBe(body.slice(0, 200));
    expect(got[0].content.length).toBe(200);

    // The bounded read must never allocate/request more than the cap for this file: the destination
    // buffer (arg 1) and the requested length (arg 3, when the 5-arg overload is used) never exceed 200.
    expect(hooks.readSyncCalls.length).toBeGreaterThan(0);
    for (const call of hooks.readSyncCalls) {
      expect(call.bufLen).toBeLessThanOrEqual(200);
      if (call.length !== undefined) expect(call.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("F14: total-cap exhaustion records an omission health object", () => {
  it("omittedPaths + totalCapExhausted list what got skipped once the total budget is gone", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f14-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "a.txt"), "a".repeat(100));
    writeFileSync(join(root, "outputs", "b.txt"), "b".repeat(100));
    writeFileSync(join(root, "outputs", "c.txt"), "c".repeat(100));

    const { files, health } = captureAuthoredFilesWithHealth(root, ["outputs"], [], {}, { perFileBytes: 100, totalBytes: 100 });
    // Only the first (alphabetically, matching the sorted walk) file fits in the 100-byte total budget.
    expect(files).toHaveLength(1);
    expect(health.totalCapExhausted).toBe(true);
    expect(health.omittedPaths).toEqual(["outputs/b.txt", "outputs/c.txt"]);
  });

  it("no omission when everything fits under the total cap", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f14-fit-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "a.txt"), "a");
    const { health } = captureAuthoredFilesWithHealth(root, ["outputs"], [], {});
    expect(health.totalCapExhausted).toBe(false);
    expect(health.omittedPaths).toEqual([]);
  });
});

describe("F15: an unknown pre-run baseline (over-cap/unreadable) is NOT auto-classified as authored", () => {
  it("a large unchanged prior file (preRunHashes[path] === null) is excluded, not misattributed", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f15-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    // This file existed pre-run and is UNCHANGED, but the pre-run capture couldn't hash it (over-cap) —
    // the manifest records null. Post-run classifyWorkspaceFiles CAN hash it fine (under our test cap).
    writeFileSync(join(root, "outputs", "unchanged-large.bin"), "same content");
    const preRunHashes = { "outputs/unchanged-large.bin": null };

    const got = captureAuthoredFiles(root, ["outputs"], [], preRunHashes);
    expect(got.map((f) => f.path)).not.toContain("outputs/unchanged-large.bin");
  });

  it("still captures a genuinely new file even when other paths have a null (unknown) baseline", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f15-new-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "new.txt"), "brand new");
    writeFileSync(join(root, "outputs", "unknown-baseline.bin"), "unchanged");
    const preRunHashes = { "outputs/unknown-baseline.bin": null }; // "new.txt" absent → undefined → new
    const got = captureAuthoredFiles(root, ["outputs"], [], preRunHashes);
    const paths = got.map((f) => f.path);
    expect(paths).toContain("outputs/new.txt");
    expect(paths).not.toContain("outputs/unknown-baseline.bin");
  });

  it("with preRunStats supplied, a stat MISMATCH on an unknown-baseline path IS treated as authored", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f15-stat-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "grew.bin"), "now much bigger than before");
    const preRunHashes = { "outputs/grew.bin": null };
    // Pre-run stat recorded a different (smaller) size/mtime than what's on disk now.
    const preRunStats = { "outputs/grew.bin": { mtimeMs: 1, size: 3 } };
    const got = captureAuthoredFiles(root, ["outputs"], [], preRunHashes, { preRunStats });
    expect(got.map((f) => f.path)).toContain("outputs/grew.bin");
  });

  it("with preRunStats supplied, an EXACT stat match on an unknown-baseline path is NOT authored", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f15-stat-match-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "same.bin"), "unchanged body");
    const st = statSync(join(root, "outputs", "same.bin"));
    const preRunHashes = { "outputs/same.bin": null };
    const preRunStats = { "outputs/same.bin": { mtimeMs: st.mtimeMs, size: st.size } };
    const got = captureAuthoredFiles(root, ["outputs"], [], preRunHashes, { preRunStats });
    expect(got.map((f) => f.path)).not.toContain("outputs/same.bin");
  });
});

describe("pre-run-manifest F15: discriminated hash-unavailable reasons + a stats reader", () => {
  it("capturePreRunManifest records 'over-cap' for a too-large file", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-pf15-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "big.md"), "this file is definitely over an 8 byte cap");
    process.env.COWORK_HARNESS_PRERUN_HASH_CAP = "8";
    try {
      capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    } finally {
      delete process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
    }
    const reasons = readPreRunManifestUnavailableReasons(outDir)!;
    expect(reasons["outputs/big.md"]).toBe("over-cap");
  });

  it("readPreRunManifestStats round-trips the mtime+size the manifest already captures", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-pf15-stats-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "a.md"), "content");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    const stats = readPreRunManifestStats(outDir)!;
    expect(stats["outputs/a.md"]).toBeDefined();
    expect(typeof stats["outputs/a.md"]!.mtimeMs).toBe("number");
    expect(typeof stats["outputs/a.md"]!.size).toBe("number");
  });

  it("readPreRunManifestUnavailableReasons/readPreRunManifestStats return undefined on an older manifest lacking the field", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-pf15-older-"));
    writeFileSync(join(outDir, "pre-run-manifest.json"), JSON.stringify({ paths: ["outputs/x"] }));
    expect(readPreRunManifestUnavailableReasons(outDir)).toBeUndefined();
    expect(readPreRunManifestStats(outDir)).toBeUndefined();
  });
});

describe("F16: an unreadable-at-readback authored file is recorded as an error, not silently dropped", () => {
  it("records a readErrors entry for a file that vanishes between classification and read-back", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f16-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "gone.txt"), "will be deleted before read-back");
    hooks.blockOpenPath = join(root, "outputs", "gone.txt");

    const { files, health } = captureAuthoredFilesWithHealth(root, ["outputs"], [], {});
    expect(files.map((f) => f.path)).not.toContain("outputs/gone.txt");
    expect(health.readErrors).toEqual([{ path: "outputs/gone.txt", error: "ENOENT" }]);
  });
});

describe("F17: scratchpad deliverables are not attributed as authored on --resume", () => {
  it("resume: true skips the scratchpad walk entirely, leaving pre-existing scratchpad files uncaptured", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "cwh-f17-sess-"));
    const mnt = join(sessionRoot, "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    // A file that landed in the scratchpad on a PRIOR turn (not this run's output).
    writeFileSync(join(sessionRoot, "prior-turn-leftover.md"), "from an earlier turn");

    const got = captureAuthoredFiles(mnt, ["outputs"], [], {}, { scratchpadRoot: sessionRoot, resume: true });
    expect(got.some((f) => f.path.startsWith("scratchpad/"))).toBe(false);
  });

  it("resume: false (default) still captures scratchpad deliverables (no regression)", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "cwh-f17-nonresume-"));
    const mnt = join(sessionRoot, "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    writeFileSync(join(sessionRoot, "loose.md"), "a bare relative write");

    const got = captureAuthoredFiles(mnt, ["outputs"], [], {}, { scratchpadRoot: sessionRoot });
    expect(got.some((f) => f.path === "scratchpad/loose.md")).toBe(true);
  });
});

describe("F18: an unreadable subtree yields walk incompleteness, distinct from a genuinely empty tree", () => {
  it("a genuinely empty tree reports complete:true with no errors", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f18-empty-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    const { files, complete, errors } = collectArtifactsWithHealth(root, ["outputs"]);
    expect(files).toEqual([]);
    expect(complete).toBe(true);
    expect(errors).toEqual([]);
  });

  it("an unreadable subdirectory reports complete:false with a path-scoped error, distinct from empty", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f18-unreadable-"));
    mkdirSync(join(root, "outputs", "locked"), { recursive: true });
    writeFileSync(join(root, "outputs", "visible.txt"), "seen");
    hooks.blockReaddirPath = join(root, "outputs", "locked");

    const { files, complete, errors } = collectArtifactsWithHealth(root, ["outputs"]);
    expect(files.map((f) => f.path)).toEqual(["outputs/visible.txt"]); // partial results still surface
    expect(complete).toBe(false);
    expect(errors).toEqual([{ path: "outputs/locked", error: "EACCES" }]);
  });

  it("a prefix root that was simply never created (ENOENT) stays complete:true (legitimate empty, not a gap)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-f18-noprefix-"));
    // "outputs" is never created — collectArtifacts already treats this as a benign empty case.
    const { files, complete, errors } = collectArtifactsWithHealth(root, ["outputs"]);
    expect(files).toEqual([]);
    expect(complete).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe("#52: classifyWorkspaceFilesWithHealth distinguishes a MISSING workspace root from a genuinely-empty one", () => {
  it("a genuinely-empty root (exists, no files) → rootAbsent:false, files:[] (present-empty)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-52-empty-"));
    mkdirSync(join(root, "outputs"), { recursive: true }); // outputs/ exists, no files
    const got = classifyWorkspaceFilesWithHealth(root, ["outputs"], []);
    expect(got.rootAbsent).toBe(false);
    expect(got.files).toEqual([]);
  });

  it("a MISSING root (the microvm case: outputs staged into the VM work tree, not outDir) → rootAbsent:true", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "cwh-52-mv-")), "work", "session", "mnt"); // never created
    const got = classifyWorkspaceFilesWithHealth(missing, ["outputs"], []);
    // The false-green this fixes: files is EMPTY for both cases, so files alone can't tell them apart —
    // rootAbsent is the discriminator a caller uses to persist UNAVAILABLE (undefined) not a false [].
    expect(got.files).toEqual([]);
    expect(got.rootAbsent).toBe(true);
  });

  it("a MISSING prefix subdir under a PRESENT root is NOT rootAbsent (a normal empty run, not the #52 bug)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-52-noprefix-")); // root exists, but no outputs/ subdir
    const got = classifyWorkspaceFilesWithHealth(root, ["outputs"], []);
    expect(got.rootAbsent).toBe(false); // root WAS observable; a missing prefix pushes the prefix name, not ""
    expect(got.files).toEqual([]);
  });

  it("a populated root → rootAbsent:false with the file classified", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-52-real-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "report.md"), "# hi");
    const got = classifyWorkspaceFilesWithHealth(root, ["outputs"], []);
    expect(got.rootAbsent).toBe(false);
    expect(got.files.map((f) => f.path)).toEqual(["outputs/report.md"]);
  });

  it("classifyWorkspaceFiles (the thin wrapper) is behavior-preserving — still returns the files array", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-52-wrap-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "a.txt"), "x");
    expect(classifyWorkspaceFiles(root, ["outputs"], []).map((f) => f.path)).toEqual(["outputs/a.txt"]);
  });
});

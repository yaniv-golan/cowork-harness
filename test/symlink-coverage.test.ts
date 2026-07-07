import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchPlan } from "../src/session.js";
import { collectArtifactPaths } from "../src/run/artifacts.js";
import { capturePreRunManifest, readPreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { buildManifest, materializeManifest } from "../src/run/cassette.js";
import { evaluate, type AssertContext } from "../src/assert.js";

function ctx(workRoot: string, over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}

function minimalPlan(): LaunchPlan {
  return {
    configDir: mkdtempSync(join(tmpdir(), "cwh-cfg-")),
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    resume: false,
    capturePreRun: true,
  };
}

// #38 — symlinks/hardlinks under outputs must be visible to the filesystem-coverage assertions on BOTH
// the live and replay lanes, without inlining any out-of-root target content into a committed cassette.
describe("#38 collectArtifactPaths — emits link entries the content walk skips", () => {
  it("tags a symlink and a hardlink with linkKind; regular files have none; dirs are not emitted", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-cap-walk-"));
    mkdirSync(join(root, "outputs", "sub"), { recursive: true }); // a directory (must NOT be emitted)
    writeFileSync(join(root, "outputs", "real.txt"), "x");
    symlinkSync("/etc/hosts", join(root, "outputs", "link")); // out-of-root target — must still be listed
    const entries = collectArtifactPaths(root, ["outputs"]);
    const byPath = new Map(entries.map((e) => [e.path, e.linkKind]));
    expect(byPath.get("outputs/real.txt")).toBeUndefined(); // regular file, no kind
    expect(byPath.get("outputs/link")).toBe("symlink");
    expect([...byPath.keys()]).not.toContain("outputs/sub"); // directory not emitted
  });
});

describe("#38 no_unexpected_files — live lane", () => {
  it("flags an agent-created symlink stray under outputs", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-live-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    symlinkSync("/etc/hosts", join(root, "outputs", "sneaky"));
    // empty baseline: the symlink is "created" and not in the allowlist → stray
    const [r] = evaluate([{ no_unexpected_files: [] }], ctx(root, { preRunPaths: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/outputs\/sneaky/);
  });

  it("does NOT flag a pre-existing symlink already in the baseline", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nuf-pre-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    symlinkSync("/etc/hosts", join(root, "outputs", "preexisting"));
    const [r] = evaluate([{ no_unexpected_files: [] }], ctx(root, { preRunPaths: ["outputs/preexisting"] }));
    expect(r.pass).toBe(true);
  });
});

describe("#38 capturePreRunManifest — links path-only, never hashed/dereferenced", () => {
  it("records a pre-existing symlink in paths but NOT in the hash map (out of input_unmodified's domain)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-cap-link-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "real.txt"), "x");
    symlinkSync("/etc/hosts", join(workRoot, "outputs", "link")); // out-of-root target must NOT be hashed
    capturePreRunManifest(minimalPlan(), workRoot, outDir, "container");
    const paths = readPreRunManifest(outDir)!;
    const hashes = readPreRunManifestHashes(outDir)!;
    expect(paths).toContain("outputs/link"); // present for no_unexpected_files
    expect(paths).toContain("outputs/real.txt");
    expect(Object.hasOwn(hashes, "outputs/link")).toBe(false); // NOT hashed — never dereferenced
    expect(Object.hasOwn(hashes, "outputs/real.txt")).toBe(true);
  });

  it("HASHES a pre-existing hardlink (real in-root content) so input_unmodified still covers it", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-cap-hard-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "a.txt"), "shared content");
    linkSync(join(workRoot, "outputs", "a.txt"), join(workRoot, "outputs", "b.txt")); // hardlink: nlink=2 on both
    capturePreRunManifest(minimalPlan(), workRoot, outDir, "container");
    const hashes = readPreRunManifestHashes(outDir)!;
    // A hardlink is a real inode with in-root content — it MUST be hashed (dropping it would silently
    // strip it from input_unmodified's coverage). Both hardlinked names are hashed.
    expect(typeof hashes["outputs/a.txt"]).toBe("string");
    expect(typeof hashes["outputs/b.txt"]).toBe("string");
  });

  it("input_unmodified does not false-fail on a pre-existing symlink (link absent from hashes)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-iu-link-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    symlinkSync("/etc/hosts", join(workRoot, "outputs", "link"));
    capturePreRunManifest(minimalPlan(), workRoot, outDir, "container");
    const hashes = readPreRunManifestHashes(outDir)!;
    // A glob that WOULD match the symlink path: it must not enter `matched` (link not in the hash map),
    // so the assertion is vacuously satisfied rather than evidence-unavailable.
    const [r] = evaluate([{ input_unmodified: ["outputs/**"] }], ctx(workRoot, { preRunHashes: hashes }));
    expect(r.pass).toBe(true);
  });
});

describe("#38 record→replay parity — a symlink stray flags on BOTH lanes", () => {
  it("buildManifest records the link body-less; replay's no_unexpected_files flags it too", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-rt-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    symlinkSync("/etc/hosts", join(root, "outputs", "stray"));

    const manifest = buildManifest(root, undefined, ["outputs"]);
    const linkEntry = manifest.find((e) => e.path === "outputs/stray");
    expect(linkEntry?.linkKind).toBe("symlink");
    expect(linkEntry?.body).toBeUndefined(); // body-less — no out-of-root content inlined
    expect(linkEntry?.sha256).toBe("");

    // Replay materializes the manifest into a temp work root; no_unexpected_files must flag the stray there
    // too (empty baseline), matching live — the live/replay parity that would false-green without v10.
    const { workRoot: replayRoot } = materializeManifest(manifest, ["outputs"]);
    const [r] = evaluate([{ no_unexpected_files: [] }], ctx(replayRoot, { preRunPaths: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/outputs\/stray/);
  });

  it("file_exists / user_visible_artifact on a link entry fail evidence-unavailable on replay (not a placeholder pass)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-rt-fe-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "real.txt"), "content");
    symlinkSync("/etc/hosts", join(root, "outputs", "link"));

    const manifest = buildManifest(root, undefined, ["outputs"]);
    const { workRoot: replayRoot, truncatedPaths, linkPaths } = materializeManifest(manifest, ["outputs"]);
    const rctx = (over = {}) => ctx(replayRoot, { truncatedPaths, linkPaths, ...over });

    // The link's placeholder must NOT prove existence/resolution — fail closed.
    const [fe] = evaluate([{ file_exists: "outputs/link" }], rctx());
    expect(fe.pass).toBe(false);
    expect(fe.message).toMatch(/evidence unavailable/);
    const [uva] = evaluate([{ user_visible_artifact: "outputs/link" }], rctx());
    expect(uva.pass).toBe(false);
    expect(uva.message).toMatch(/evidence unavailable/);

    // A REAL file entry still passes (the link gate must not over-fail non-link paths).
    const [feReal] = evaluate([{ file_exists: "outputs/real.txt" }], rctx());
    expect(feReal.pass).toBe(true);
  });
});

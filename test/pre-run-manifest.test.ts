import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { LaunchPlan } from "../src/session.js";
import {
  capturePreRunManifest,
  readPreRunManifest,
  readPreRunManifestHashes,
  readPreRunManifestOrigin,
} from "../src/run/pre-run-manifest.js";
import { collectArtifacts } from "../src/run/artifacts.js";
import { snapshotHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { evaluate } from "../src/assert.js";

function minimalPlan(mounts: LaunchPlan["mounts"], resume = false): LaunchPlan {
  return {
    configDir: mkdtempSync(join(tmpdir(), "cwh-cfg-")),
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

describe("capturePreRunManifest", () => {
  it("records staged paths under workRoot for copy tiers", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-cap-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "seed.txt"), "x");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toEqual(["outputs/seed.txt"]);
  });

  it("Item 2: captures uploads/** into the baseline (so input_unmodified can guard an uploaded file)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-cap-up-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    mkdirSync(join(workRoot, "uploads"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "seed.txt"), "x");
    writeFileSync(join(workRoot, "uploads", "safe.xlsx"), "PRIVATE");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toEqual(["outputs/seed.txt", "uploads/safe.xlsx"]);
    const hashes = readPreRunManifestHashes(outDir)!;
    expect(hashes["uploads/safe.xlsx"]).toBe(createHash("sha256").update("PRIVATE").digest("hex"));
  });

  it("Item 2: hostloop tier also captures uploads/** (staged under workRoot alongside outputs)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-cap-up-hl-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "uploads"), { recursive: true });
    writeFileSync(join(workRoot, "uploads", "model.xlsx"), "M");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "hostloop");
    expect(readPreRunManifest(outDir)).toContain("uploads/model.xlsx");
  });

  it("does not overwrite an existing manifest on resume", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-resume-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(outDir, "pre-run-manifest.json"), JSON.stringify({ paths: ["outputs/run1.json"] }));
    writeFileSync(join(workRoot, "outputs", "run2.json"), "y");
    capturePreRunManifest(minimalPlan([], true), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toEqual(["outputs/run1.json"]);
  });

  it("resume without an existing manifest captures nothing (baseline stays absent, key fails loud later)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-resume-noop-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "run1.json"), "x");
    capturePreRunManifest(minimalPlan([], true), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toBeUndefined();
    expect(existsSync(join(outDir, "pre-run-manifest.json"))).toBe(false);
  });

  it("no capture when plan.capturePreRun is not set", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-nocapture-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "seed.txt"), "x");
    const plan: LaunchPlan = { ...minimalPlan([]), capturePreRun: false };
    capturePreRunManifest(plan, workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toBeUndefined();
  });

  it("collectArtifacts never returns pre-run-manifest.json (it lives above workRoot)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-manifest-guard-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "real.txt"), "hello");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    const paths = collectArtifacts(workRoot, ["outputs"]).map((f) => f.path);
    expect(paths).toContain("outputs/real.txt");
    expect(JSON.parse(readFileSync(join(outDir, "pre-run-manifest.json"), "utf8")).paths.join("|")).not.toContain("pre-run-manifest");
  });

  it("hostloop end-to-end: connected-folder pre/post diff flags exactly the stray file", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hl-e2e-"));
    const mntHost = join(outDir, "work", "session", "mnt");
    const hostFolder = mkdtempSync(join(tmpdir(), "cwh-host-folder-"));
    mkdirSync(join(mntHost, "outputs"), { recursive: true });
    writeFileSync(join(hostFolder, "input.pdf"), "pdf");

    const plan = minimalPlan([{ kind: "folder", hostPath: hostFolder, mountPath: ".projects/Acme", mode: "rw" }]);
    capturePreRunManifest(plan, mntHost, outDir, "hostloop");
    const pre = readPreRunManifest(outDir)!;
    expect(pre).toEqual([".projects/Acme/input.pdf"]);

    // Agent writes through the bind mount (allowed handoff + stray fabrication).
    writeFileSync(join(hostFolder, "allowed.json"), "{}");
    writeFileSync(join(hostFolder, "checklist.json"), "{}");

    snapshotHostLoopWorkspace(plan, mntHost);

    const [passing] = evaluate([{ no_unexpected_files: [".projects/Acme/input.pdf", ".projects/Acme/allowed.json"] }], {
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: mntHost,
      userVisiblePrefixes: ["outputs", ".projects/Acme"],
      preRunPaths: pre,
      outputsDeletes: [],
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
    });
    expect(passing.pass).toBe(false);
    const strayPart = passing.message!.split(" (allow:")[0]!;
    expect(strayPart).toMatch(/checklist\.json/);
    expect(strayPart).not.toMatch(/allowed\.json/);
    expect(strayPart).not.toMatch(/input\.pdf/);
  });

  it("hostloop baseline includes pre-existing hardlinked files (paths-only walk)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hl-hardlink-"));
    const mntHost = join(outDir, "work", "session", "mnt");
    const hostFolder = mkdtempSync(join(tmpdir(), "cwh-host-folder-"));
    mkdirSync(join(mntHost, "outputs"), { recursive: true });
    writeFileSync(join(hostFolder, "file1.txt"), "shared");
    linkSync(join(hostFolder, "file1.txt"), join(hostFolder, "file2.txt"));

    const plan = minimalPlan([{ kind: "folder", hostPath: hostFolder, mountPath: ".projects/Acme", mode: "rw" }]);
    capturePreRunManifest(plan, mntHost, outDir, "hostloop");
    const pre = readPreRunManifest(outDir)!;
    expect(pre).toEqual([".projects/Acme/file1.txt", ".projects/Acme/file2.txt"]);

    // Nothing touches the folder — the post-run snapshot copy should diff clean against the baseline
    // (regression: the old nlink>1 rejection would have dropped both paths from the baseline, so the
    // post-run copy — where every file lands at nlink=1 — would read as two agent-"created" strays).
    snapshotHostLoopWorkspace(plan, mntHost);

    const [passing] = evaluate([{ no_unexpected_files: [] }], {
      transcript: "",
      toolsCalled: new Set(),
      subagentTools: new Set(),
      egress: [],
      result: "success",
      workRoot: mntHost,
      userVisiblePrefixes: ["outputs", ".projects/Acme"],
      preRunPaths: pre,
      outputsDeletes: [],
      questions: [],
      hostPathLeaked: false,
      selfHealRan: false,
      subagents: [],
      gateDeliveries: [],
      toolResultTexts: [],
      skillsInvoked: [],
      skillToolAvailable: true,
    });
    expect(passing.pass).toBe(true);
  });
});

describe("capturePreRunManifest hashes", () => {
  const ENV_KEY = "COWORK_HARNESS_PRERUN_HASH_CAP";
  const savedEnv = process.env[ENV_KEY];
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("records a lowercase-hex sha256 for each captured path, matching the file's real content", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hash-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    const content = "hello, hashing world";
    writeFileSync(join(workRoot, "outputs", "a.md"), content);
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    const parsed = JSON.parse(readFileSync(join(outDir, "pre-run-manifest.json"), "utf8")) as {
      paths: string[];
      hashes: Record<string, string | null>;
    };
    expect(parsed.hashes["outputs/a.md"]).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("records sha256:null (not omitted, not a real hash) for a file over the size cap", () => {
    process.env[ENV_KEY] = "8";
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hash-cap-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "big.md"), "this is definitely more than eight bytes");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    const parsed = JSON.parse(readFileSync(join(outDir, "pre-run-manifest.json"), "utf8")) as {
      paths: string[];
      hashes: Record<string, string | null>;
    };
    expect(parsed.hashes["outputs/big.md"]).toBeNull();
    expect(parsed.paths).toContain("outputs/big.md");
  });

  it("readPreRunManifestHashes returns the map, or undefined when absent/malformed", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hash-reader-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "a.md"), "content");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    const parsed = JSON.parse(readFileSync(join(outDir, "pre-run-manifest.json"), "utf8")) as {
      hashes: Record<string, string | null>;
    };
    expect(readPreRunManifestHashes(outDir)).toEqual(parsed.hashes);

    const noManifestOutDir = mkdtempSync(join(tmpdir(), "cwh-hash-none-"));
    expect(readPreRunManifestHashes(noManifestOutDir)).toBeUndefined();

    const olderRunOutDir = mkdtempSync(join(tmpdir(), "cwh-hash-older-"));
    writeFileSync(join(olderRunOutDir, "pre-run-manifest.json"), JSON.stringify({ paths: ["outputs/run1.json"] }));
    expect(readPreRunManifestHashes(olderRunOutDir)).toBeUndefined();
  });

  it("paths stay identical to the pre-hashes behavior (no_unexpected_files unaffected)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hash-paths-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "seed.txt"), "x");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    expect(readPreRunManifest(outDir)).toEqual(["outputs/seed.txt"]);
  });

  it("hostloop: hashes a connected-folder file from its hostPath (mountPath prefix stripped), not workRoot", () => {
    // Guards the hostloop branch's `m.hostPath` + prefix-strip logic: the real bytes live under
    // hostFolder/sub/in.pdf, addressed in the manifest as ".projects/Acme/sub/in.pdf". A naive
    // read from workRoot (where the folder is NOT staged on hostloop) would miss it → null.
    const outDir = mkdtempSync(join(tmpdir(), "cwh-hl-hash-"));
    const mntHost = join(outDir, "work", "session", "mnt");
    const hostFolder = mkdtempSync(join(tmpdir(), "cwh-hl-host-"));
    mkdirSync(join(mntHost, "outputs"), { recursive: true });
    mkdirSync(join(hostFolder, "sub"), { recursive: true });
    const body = "connected-folder input body";
    writeFileSync(join(hostFolder, "sub", "in.pdf"), body);
    writeFileSync(join(mntHost, "outputs", "seed.md"), "seed");

    const plan = minimalPlan([{ kind: "folder", hostPath: hostFolder, mountPath: ".projects/Acme", mode: "rw" }]);
    capturePreRunManifest(plan, mntHost, outDir, "hostloop");
    const hashes = readPreRunManifestHashes(outDir)!;

    const expected = createHash("sha256").update(body).digest("hex");
    // real content hash from hostPath — NOT null (which is what a wrong-base read would produce)
    expect(hashes[".projects/Acme/sub/in.pdf"]).toBe(expected);
    // the workRoot-relative outputs file is hashed from mntHost
    expect(hashes["outputs/seed.md"]).toBe(createHash("sha256").update("seed").digest("hex"));
  });

  it("hostloop: over-cap connected-folder file records null (statSync gate, no full read)", () => {
    const prev = process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
    process.env.COWORK_HARNESS_PRERUN_HASH_CAP = "4";
    try {
      const outDir = mkdtempSync(join(tmpdir(), "cwh-hl-cap-"));
      const mntHost = join(outDir, "work", "session", "mnt");
      const hostFolder = mkdtempSync(join(tmpdir(), "cwh-hl-capfolder-"));
      mkdirSync(join(mntHost, "outputs"), { recursive: true });
      writeFileSync(join(hostFolder, "big.bin"), "0123456789"); // 10 bytes > cap 4
      const plan = minimalPlan([{ kind: "folder", hostPath: hostFolder, mountPath: ".projects/Acme", mode: "rw" }]);
      capturePreRunManifest(plan, mntHost, outDir, "hostloop");
      const hashes = readPreRunManifestHashes(outDir)!;
      expect(hashes[".projects/Acme/big.bin"]).toBeNull();
      expect(readPreRunManifest(outDir)).toContain(".projects/Acme/big.bin"); // still in paths
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
      else process.env.COWORK_HARNESS_PRERUN_HASH_CAP = prev;
    }
  });
});

describe("pre-run-manifest origin", () => {
  it('a manifest written today records origin: "local-walk"', () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-origin-"));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "seed.txt"), "x");
    capturePreRunManifest(minimalPlan([]), workRoot, outDir, "container");
    const parsed = JSON.parse(readFileSync(join(outDir, "pre-run-manifest.json"), "utf8")) as { origin?: unknown };
    expect(parsed.origin).toBe("local-walk");
    expect(readPreRunManifestOrigin(outDir)).toBe("local-walk");
  });

  it("readPreRunManifestOrigin returns undefined (never throws) on an older manifest lacking origin", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-origin-older-"));
    writeFileSync(join(outDir, "pre-run-manifest.json"), JSON.stringify({ paths: ["outputs/run1.json"] }));
    expect(readPreRunManifestOrigin(outDir)).toBeUndefined();
  });

  it("readPreRunManifestOrigin returns undefined when the manifest is absent entirely", () => {
    const noManifestOutDir = mkdtempSync(join(tmpdir(), "cwh-origin-none-"));
    expect(readPreRunManifestOrigin(noManifestOutDir)).toBeUndefined();
  });

  it("readPreRunManifestOrigin returns undefined on a malformed origin value (not one of the two literals)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-origin-bad-"));
    writeFileSync(join(outDir, "pre-run-manifest.json"), JSON.stringify({ paths: [], origin: "something-else" }));
    expect(readPreRunManifestOrigin(outDir)).toBeUndefined();
  });

  it('round-trips origin: "remote-unavailable" from a hand-constructed fixture (no real producer emits this yet)', () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-origin-remote-"));
    writeFileSync(join(outDir, "pre-run-manifest.json"), JSON.stringify({ paths: [], origin: "remote-unavailable" }));
    expect(readPreRunManifestOrigin(outDir)).toBe("remote-unavailable");
  });
});

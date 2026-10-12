import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotLegTree, legSnapshotRoot } from "../src/run/leg-snapshot.js";
import { writeLegPostManifest } from "../src/run/leg-manifest.js";

// A leg's snapshot: its user-visible files cloned when it ended, trusted only while it matches the leg's own post-run
// manifest, and absent (so the leg falls back to the live-tree rules) when over the cap.
let dir: string;
let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ml-snap-"));
  prev = process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES;
});
afterEach(() => {
  if (prev === undefined) delete process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES;
  else process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES = prev;
  rmSync(dir, { recursive: true, force: true });
});

function tree() {
  const work = join(dir, "work");
  const leg = join(dir, "legs", "ask");
  mkdirSync(join(work, "outputs", "runs"), { recursive: true });
  mkdirSync(join(work, "proj"), { recursive: true });
  mkdirSync(leg, { recursive: true });
  writeFileSync(join(work, "outputs", "runs", "status.json"), '{"status":"waiting"}');
  writeFileSync(join(work, "proj", "doc.txt"), "folder file");
  const old = new Date("2026-01-02T03:04:05Z");
  utimesSync(join(work, "proj", "doc.txt"), old, old);
  return { work, leg, roots: ["outputs", "proj"] };
}

describe("leg snapshot", () => {
  it("clones the leg's files with their mtimes, and survives a later change to the tree", () => {
    const { work, leg, roots } = tree();
    symlinkSync("/etc/hosts", join(work, "outputs", "link"));
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    writeFileSync(join(work, "outputs", "runs", "status.json"), '{"status":"complete"}'); // a later leg
    const snap = legSnapshotRoot(leg);
    expect(snap).toBe(join(leg, "snapshot"));
    expect(readFileSync(join(snap!, "outputs", "runs", "status.json"), "utf8")).toContain("waiting");
    expect(statSync(join(snap!, "proj", "doc.txt")).mtime.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });
  it("is not trusted once it differs from the leg's post-run manifest", () => {
    const { work, leg, roots } = tree();
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    writeFileSync(join(leg, "snapshot", "outputs", "runs", "status.json"), '{"status":"complete"}');
    expect(legSnapshotRoot(leg)).toBeUndefined();
  });
  it("is not taken over the cap (the leg then falls back to the live-tree rules)", () => {
    const { work, leg, roots } = tree();
    process.env.COWORK_HARNESS_LEG_SNAPSHOT_MAX_BYTES = "5";
    writeLegPostManifest(leg, work, roots);
    snapshotLegTree(leg, work, roots);
    expect(JSON.parse(readFileSync(join(leg, "snapshot.json"), "utf8"))).toMatchObject({
      complete: false,
      reason: /over the 5-byte snapshot cap/,
    });
    expect(legSnapshotRoot(leg)).toBeUndefined();
  });
});

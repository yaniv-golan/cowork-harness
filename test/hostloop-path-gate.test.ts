import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathGateCwdMismatch } from "../src/runtime/hostloop.js";

describe("pathGateCwdMismatch", () => {
  it("does not flag a mismatch when the wire cwd is the realpath of a symlinked spawner cwd", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ch-")));
    const realDir = join(base, "real", "mnt", "outputs");
    mkdirSync(realDir, { recursive: true });
    const linkRoot = join(base, "link");
    symlinkSync(join(base, "real"), linkRoot); // link → real
    const spawner = join(linkRoot, "mnt", "outputs"); // un-canonical (through the symlink)
    const wire = realpathSync(spawner); // what the agent reports
    expect(pathGateCwdMismatch(wire, spawner)).toBe(false);
  });

  it("STILL flags a genuine cwd drift (regression guard — do not mute real drift)", () => {
    expect(pathGateCwdMismatch("/a/one", "/a/two")).toBe(true);
  });
});

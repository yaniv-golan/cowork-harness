// A variant runs from a snapshot of the plugin taken on its FIRST run. The loop edits the live plugin every
// round, so an appended rep or a resume that read the live dir would measure the next round's change under
// this variant's name (eval-hillclimb.md l.275: "append more reps to its results.jsonl").
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { variantSnapshot } from "../src/hillclimb/snapshot.js";
import { UsageError } from "../src/errors.js";

let live: string;
let root: string;
const opts = (over = {}) => ({ snapshotRoot: root, flowHash: "f00d", variant: "v1", ...over });

beforeEach(() => {
  live = join(mkdtempSync(join(tmpdir(), "hc-live-")), "my-plugin");
  mkdirSync(join(live, "skills", "x"), { recursive: true });
  writeFileSync(join(live, "skills", "x", "SKILL.md"), "round 1");
  root = mkdtempSync(join(tmpdir(), "hc-snaps-"));
});
afterEach(() => {
  rmSync(join(live, ".."), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("variantSnapshot", () => {
  it("the first run copies the plugin under <root>/<flow-hash>/<variant>/<plugin dir name>", () => {
    const s = variantSnapshot(live, opts());
    expect(s).toMatchObject({ created: true, dir: join(root, "f00d", "v1", "my-plugin") });
    expect(readFileSync(join(s.dir, "skills", "x", "SKILL.md"), "utf8")).toBe("round 1");
  });

  it("a later run reuses it even after the live plugin changed, and says the live dir differs", () => {
    variantSnapshot(live, opts());
    writeFileSync(join(live, "skills", "x", "SKILL.md"), "round 2");
    const s = variantSnapshot(live, opts({ variantRan: true }));
    expect(s.created).toBe(false);
    expect(readFileSync(join(s.dir, "skills", "x", "SKILL.md"), "utf8")).toBe("round 1");
    expect(s.liveDiffers).toBe(true);
  });

  it("a variant that already ran but whose snapshot is gone is refused: re-running would measure the live dir", () => {
    expect(() => variantSnapshot(live, opts({ variantRan: true }))).toThrow(UsageError);
    expect(() => variantSnapshot(live, opts({ variantRan: true }))).toThrow(/snapshot .* is missing/);
  });

  it("an interrupted snapshot (no completion marker) is never used", () => {
    mkdirSync(join(root, "f00d", "v1", "my-plugin"), { recursive: true });
    expect(() => variantSnapshot(live, opts({ variantRan: true }))).toThrow(/incomplete/);
    const s = variantSnapshot(live, opts());
    expect(s.created).toBe(true);
    expect(existsSync(join(s.dir, "skills", "x", "SKILL.md"))).toBe(true);
  });

  it("a snapshot root inside a git work tree is refused: the stager would mount the copy EMPTY", () => {
    expect(() => variantSnapshot(live, opts({ snapshotRoot: join(import.meta.dirname, "..", ".snap-test") }))).toThrow(/git work tree/);
  });
});

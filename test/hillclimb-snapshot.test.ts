// A variant runs from a snapshot of the plugin taken on its FIRST run. The loop edits the live plugin every
// round, so an appended rep or a resume that read the live dir would measure the next round's change under
// this variant's name (eval-hillclimb.md l.275: "append more reps to its results.jsonl").
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
  it("when git cannot answer for the snapshot root, the refusal names the env var, not eval's --out", () => {
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 99\n"); // git refuses to read it
    let err: unknown;
    try {
      variantSnapshot(live, opts());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toMatch(/could not tell whether .* is inside a git work tree/);
    expect((err as Error).message).toMatch(/COWORK_HARNESS_HILLCLIMB_SNAPSHOTS/);
    expect((err as Error).message).not.toMatch(/--out/);
  });

  it("a dry run of a variant with no rows, whose snapshot the live plugin moved past, checks the live plugin the pass would re-take", () => {
    variantSnapshot(live, opts()); // left by a refused run
    writeFileSync(join(live, "skills", "x", "SKILL.md"), "round 2");
    const s = variantSnapshot(live, opts({ checkOnly: true }));
    expect(s).toEqual({ dir: live, created: false, liveDiffers: false });
    expect(readFileSync(join(root, "f00d", "v1", "my-plugin", "skills", "x", "SKILL.md"), "utf8")).toBe("round 1"); // untouched
  });

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

  it("a variant with NO rows re-takes a snapshot the live plugin has moved past: a refused run must not freeze an old round", () => {
    variantSnapshot(live, opts());
    writeFileSync(join(live, "skills", "x", "SKILL.md"), "round 2");
    const s = variantSnapshot(live, opts({ variantRan: false }));
    expect(s).toMatchObject({ created: true, liveDiffers: false });
    expect(readFileSync(join(s.dir, "skills", "x", "SKILL.md"), "utf8")).toBe("round 2");
  });

  it("a file ADDED to the live plugin also counts as moved on", () => {
    variantSnapshot(live, opts());
    writeFileSync(join(live, "skills", "x", "extra.md"), "new");
    const s = variantSnapshot(live, opts({ variantRan: false }));
    expect(s.created).toBe(true);
    expect(existsSync(join(s.dir, "skills", "x", "extra.md"))).toBe(true);
  });

  it("a variant with no rows reuses a snapshot that still matches the live plugin", () => {
    variantSnapshot(live, opts());
    expect(variantSnapshot(live, opts({ variantRan: false })).created).toBe(false);
  });

  it("a variant that already ran but whose snapshot is gone is refused: re-running would measure the live dir", () => {
    expect(() => variantSnapshot(live, opts({ variantRan: true }))).toThrow(UsageError);
    expect(() => variantSnapshot(live, opts({ variantRan: true }))).toThrow(/snapshot .* is missing/);
  });

  it("the missing-snapshot refusal names a copied or moved flow as the likely cause, and the way through", () => {
    let msg = "";
    try {
      variantSnapshot(live, opts({ variantRan: true }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Snapshots are kept per flow dir path, so a flow dir copied or moved keeps its rows but not its snapshots");
    expect(msg).toContain("run a new variant instead (approve the harness through it: `--dry-run --approve-harness --variant v<N>`)");
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

describe("variantSnapshot inside a git work tree (the stager delivers tracked files only)", () => {
  const git = (...a: string[]) =>
    spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { cwd: live, encoding: "utf8" });
  beforeEach(() => {
    expect(git("init", "-q").status).toBe(0);
    expect(git("add", "-A").status).toBe(0);
    expect(git("commit", "-q", "-m", "c").status).toBe(0);
  });

  it("an untracked file in the live plugin is left out, counted, and does not make the live dir 'differ'", () => {
    writeFileSync(join(live, "scratch.md"), "untracked");
    const s = variantSnapshot(live, opts());
    expect(s.untrackedExcluded).toBe(1);
    expect(existsSync(join(s.dir, "scratch.md"))).toBe(false);
    const again = variantSnapshot(live, opts({ variantRan: true }));
    expect(again.liveDiffers).toBe(false);
  });

  it("a tracked edit still makes the live dir differ", () => {
    variantSnapshot(live, opts());
    writeFileSync(join(live, "skills", "x", "SKILL.md"), "round 2");
    expect(variantSnapshot(live, opts({ variantRan: true })).liveDiffers).toBe(true);
  });

  it("a plugin with no tracked files is refused in hillclimb's words, not eval's", () => {
    expect(git("rm", "-q", "-r", "--cached", ".").status).toBe(0);
    expect(() => variantSnapshot(live, opts())).toThrow(/0 git-tracked files/);
    try {
      variantSnapshot(live, opts());
    } catch (e) {
      expect((e as Error).message).not.toMatch(/--arm|--include-untracked/);
    }
  });
});

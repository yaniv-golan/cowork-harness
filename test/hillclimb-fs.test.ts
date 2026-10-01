import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsRefusal, NoFollowRoot, isSymlink, lexists, normalizeRootArg, preflightRoot } from "../src/hillclimb/fs.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "hc-fs-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("normalizeRootArg", () => {
  it("strips trailing separators (lstat('link/') would follow the link)", () => {
    expect(normalizeRootArg("a/b///")).toBe("a/b");
    expect(normalizeRootArg("/")).toBe("/");
  });
  it.each(["a/./b", "a/../b", "a/b/.", ".."])("refuses a dot segment: %s", (p) => {
    expect(() => normalizeRootArg(p)).toThrow(FsRefusal);
  });
});

describe("preflightRoot", () => {
  it("refuses a symlink at any listed path", () => {
    mkdirSync(join(tmp, "flow"));
    symlinkSync(join(tmp, "elsewhere"), join(tmp, "flow", "baseline"));
    expect(() => preflightRoot(join(tmp, "flow"), [join(tmp, "flow", "baseline")])).toThrow(/symlink/);
  });
  it("walks a RELATIVE root's ancestors from the cwd", () => {
    mkdirSync(join(tmp, "real"));
    symlinkSync(join(tmp, "real"), join(tmp, "hop"));
    expect(() => preflightRoot("hop/flow", [], tmp)).toThrow(/ancestor/);
    expect(() => preflightRoot("real/flow", [], tmp)).not.toThrow();
  });
});

describe("NoFollowRoot", () => {
  it("round-trips a write and a read inside the root", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.mkdir(join(tmp, "flow", "baseline", "ref"));
    r.writeFile(join(tmp, "flow", "baseline", "ref", "a.txt"), "hello");
    expect(r.readFile(join(tmp, "flow", "baseline", "ref", "a.txt"))).toBe("hello");
    r.appendFile(join(tmp, "flow", "baseline", "ref", "a.txt"), " world");
    expect(r.readFile(join(tmp, "flow", "baseline", "ref", "a.txt"))).toBe("hello world");
  });

  it("refuses to open the root itself through a symlink", () => {
    mkdirSync(join(tmp, "real"));
    symlinkSync(join(tmp, "real"), join(tmp, "flow"));
    expect(() => NoFollowRoot.open(join(tmp, "flow"))).toThrow(FsRefusal);
  });

  it("never follows a planted leaf symlink on read, and readIfPresent throws rather than returning null", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "secret"), "SECRET");
    symlinkSync(join(tmp, "secret"), join(tmp, "flow", "ref.txt"));
    expect(() => r.readFile(join(tmp, "flow", "ref.txt"))).toThrow();
    expect(() => r.readIfPresent(join(tmp, "flow", "ref.txt"))).toThrow();
    expect(r.readIfPresent(join(tmp, "flow", "absent.txt"))).toBeNull();
    expect(lexists(join(tmp, "flow", "ref.txt"))).toBe(true);
    expect(isSymlink(join(tmp, "flow", "ref.txt"))).toBe(true);
  });

  it("never writes through a planted leaf symlink, and the target keeps its bytes", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "victim"), "ORIGINAL");
    symlinkSync(join(tmp, "victim"), join(tmp, "flow", "results.jsonl"));
    expect(() => r.writeFile(join(tmp, "flow", "results.jsonl"), "x")).toThrow();
    expect(() => r.appendFile(join(tmp, "flow", "results.jsonl"), "x")).toThrow();
    expect(readFileSync(join(tmp, "victim"), "utf8")).toBe("ORIGINAL");
  });

  it("refuses a file with a second hard link (another name for an outside file)", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "outside"), "OUT");
    linkSync(join(tmp, "outside"), join(tmp, "flow", "doc.txt"));
    expect(() => r.readFile(join(tmp, "flow", "doc.txt"))).toThrow(/hard link/);
    expect(() => r.writeFile(join(tmp, "flow", "doc.txt"), "x")).toThrow(/hard link/);
    expect(readFileSync(join(tmp, "outside"), "utf8")).toBe("OUT");
  });

  it("refuses a directory symlink planted under the root after open (parent check + containment)", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    mkdirSync(join(tmp, "outside"));
    symlinkSync(join(tmp, "outside"), join(tmp, "flow", "v1"));
    expect(() => r.writeFile(join(tmp, "flow", "v1", "results.jsonl"), "x")).toThrow();
    expect(() => r.mkdir(join(tmp, "flow", "v1", "traces"))).toThrow();
    expect(lexists(join(tmp, "outside", "results.jsonl"))).toBe(false);
  });

  it("createFile never replaces an existing file or link", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.createFile(join(tmp, "flow", "a.txt"), "one");
    expect(() => r.createFile(join(tmp, "flow", "a.txt"), "two")).toThrow(/EEXIST/);
    expect(r.readFile(join(tmp, "flow", "a.txt"))).toBe("one");
    writeFileSync(join(tmp, "victim"), "V");
    symlinkSync(join(tmp, "victim"), join(tmp, "flow", "l.txt"));
    expect(() => r.createFile(join(tmp, "flow", "l.txt"), "x")).toThrow();
    expect(readFileSync(join(tmp, "victim"), "utf8")).toBe("V");
  });

  it("existing() never creates the root and refuses a link or a file at it", () => {
    expect(() => NoFollowRoot.existing(join(tmp, "absent"))).toThrow(/does not exist/);
    expect(lexists(join(tmp, "absent"))).toBe(false);
    writeFileSync(join(tmp, "file"), "x");
    expect(() => NoFollowRoot.existing(join(tmp, "file"))).toThrow(/not a directory/);
    mkdirSync(join(tmp, "real"));
    symlinkSync(join(tmp, "real"), join(tmp, "link"));
    expect(() => NoFollowRoot.existing(join(tmp, "link"))).toThrow(/symlink/);
  });

  it("refuses a path outside the root outright", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    expect(() => r.writeFile(join(tmp, "sibling.txt"), "x")).toThrow(/outside/);
  });
});

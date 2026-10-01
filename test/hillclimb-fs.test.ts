import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
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
  it.each(["a/../b", "..", "a/b/.."])("refuses a '..' segment: %s", (p) => {
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
    expect(() => r.readFile(join(tmp, "flow", "ref.txt"))).toThrow(FsRefusal);
    expect(() => r.readIfPresent(join(tmp, "flow", "ref.txt"))).toThrow(FsRefusal);
    expect(r.readIfPresent(join(tmp, "flow", "absent.txt"))).toBeNull();
    expect(lexists(join(tmp, "flow", "ref.txt"))).toBe(true);
    expect(isSymlink(join(tmp, "flow", "ref.txt"))).toBe(true);
  });

  it("never writes through a planted leaf symlink, and the target keeps its bytes", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "victim"), "ORIGINAL");
    symlinkSync(join(tmp, "victim"), join(tmp, "flow", "results.jsonl"));
    expect(() => r.writeFile(join(tmp, "flow", "results.jsonl"), "x")).toThrow(FsRefusal);
    expect(() => r.appendFile(join(tmp, "flow", "results.jsonl"), "x")).toThrow(FsRefusal);
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
    expect(() => r.writeFile(join(tmp, "flow", "v1", "results.jsonl"), "x")).toThrow(FsRefusal);
    expect(() => r.mkdir(join(tmp, "flow", "v1", "traces"))).toThrow(FsRefusal);
    expect(lexists(join(tmp, "outside", "results.jsonl"))).toBe(false);
  });

  it("createFile never replaces an existing file or link", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.createFile(join(tmp, "flow", "a.txt"), "one");
    expect(() => r.createFile(join(tmp, "flow", "a.txt"), "two")).toThrow(/EEXIST/);
    expect(r.readFile(join(tmp, "flow", "a.txt"))).toBe("one");
    writeFileSync(join(tmp, "victim"), "V");
    symlinkSync(join(tmp, "victim"), join(tmp, "flow", "l.txt"));
    expect(() => r.createFile(join(tmp, "flow", "l.txt"), "x")).toThrow(/EEXIST/);
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

describe("review fixes", () => {
  it("a '..' after a symlinked dir never escapes the root (kernel resolves link/.. to the TARGET's parent)", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    mkdirSync(join(tmp, "outside", "deep"), { recursive: true });
    writeFileSync(join(tmp, "outside", "secret"), "SECRET");
    symlinkSync(join(tmp, "outside", "deep"), join(tmp, "flow", "evil"));
    expect(() => r.readFile(`${tmp}/flow/evil/../secret`)).toThrow(FsRefusal);
    expect(() => r.writeFile(`${tmp}/flow/evil/../pwn`, "x")).toThrow(FsRefusal);
    expect(() => r.mkdir(`${tmp}/flow/evil/../made`)).toThrow(FsRefusal);
    expect(lexists(join(tmp, "outside", "pwn"))).toBe(false);
    expect(lexists(join(tmp, "outside", "made"))).toBe(false);
  });

  it("a dot segment is refused even when the path stays inside the root (the guard, not the realpath, decides)", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.mkdir(join(tmp, "flow", "a"));
    expect(() => r.writeFile(`${tmp}/flow/a/../b`, "x")).toThrow(/segment/);
    expect(() => r.readFile(`${tmp}/flow/./b`)).toThrow(/segment/);
  });

  it("a planted FIFO is refused instead of hanging the run", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    execFileSync("mkfifo", [join(tmp, "flow", "ref")]);
    expect(() => r.readFile(join(tmp, "flow", "ref"))).toThrow(FsRefusal);
    expect(() => r.readIfPresent(join(tmp, "flow", "ref"))).toThrow(FsRefusal);
    expect(() => r.writeFile(join(tmp, "flow", "ref"), "x")).toThrow(FsRefusal);
  });

  it("every link/non-regular refusal is an FsRefusal, never a raw errno (callers map FsRefusal to exit 2)", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "t"), "T");
    symlinkSync(join(tmp, "t"), join(tmp, "flow", "leaf"));
    mkdirSync(join(tmp, "flow", "adir"));
    for (const op of [
      () => r.readFile(join(tmp, "flow", "leaf")),
      () => r.writeFile(join(tmp, "flow", "leaf"), "x"),
      () => r.appendFile(join(tmp, "flow", "leaf"), "x"),
      () => r.readFile(join(tmp, "flow", "adir")),
      () => r.writeFile(join(tmp, "flow", "adir"), "x"),
    ])
      expect(op).toThrow(FsRefusal);
  });

  it("appendFile and createFile refuse a hard link too", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "outside"), "OUT");
    linkSync(join(tmp, "outside"), join(tmp, "flow", "h"));
    expect(() => r.appendFile(join(tmp, "flow", "h"), "x")).toThrow(/hard link/);
    expect(readFileSync(join(tmp, "outside"), "utf8")).toBe("OUT");
  });

  it("mkdir through a symlinked ancestor creates NOTHING outside the root", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    mkdirSync(join(tmp, "outside"));
    symlinkSync(join(tmp, "outside"), join(tmp, "flow", "anc"));
    expect(() => r.mkdir(join(tmp, "flow", "anc", "x", "y"))).toThrow(/symlinked directory/);
    expect(lexists(join(tmp, "outside", "x"))).toBe(false);
  });

  it("open() runs the ancestor walk itself, against the same cwd it binds", () => {
    mkdirSync(join(tmp, "real"));
    symlinkSync(join(tmp, "real"), join(tmp, "hop"));
    expect(() => NoFollowRoot.open("hop/flow", { cwd: tmp })).toThrow(/ancestor/);
    const r = NoFollowRoot.open("real/flow", { cwd: tmp });
    expect(r.root).toBe(join(tmp, "real", "flow"));
  });

  it("preflightRoot normalizes listed paths (a trailing slash must not blind the check)", () => {
    mkdirSync(join(tmp, "flow"));
    mkdirSync(join(tmp, "elsewhere"));
    symlinkSync(join(tmp, "elsewhere"), join(tmp, "flow", "anc"));
    expect(() => preflightRoot(join(tmp, "flow"), [join(tmp, "flow", "anc") + "/"])).toThrow(/symlink/);
  });
});

describe("renameNoFollow", () => {
  it("replace: atomically swaps a regular file into place", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.writeFile(join(tmp, "flow", "results.jsonl"), "old\n");
    r.writeFile(join(tmp, "flow", "results.jsonl.tmp"), "new\n");
    expect(r.renameNoFollow(join(tmp, "flow", "results.jsonl.tmp"), join(tmp, "flow", "results.jsonl"), { replace: true })).toBe("renamed");
    expect(r.readFile(join(tmp, "flow", "results.jsonl"))).toBe("new\n");
    expect(lexists(join(tmp, "flow", "results.jsonl.tmp"))).toBe(false);
  });
  it("refuses a symlink or a hard link at the destination, leaving both sides untouched", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "victim"), "V");
    symlinkSync(join(tmp, "victim"), join(tmp, "flow", "dst"));
    r.writeFile(join(tmp, "flow", "src"), "S");
    expect(() => r.renameNoFollow(join(tmp, "flow", "src"), join(tmp, "flow", "dst"), { replace: true })).toThrow(/replace a symlink/);
    rmSync(join(tmp, "flow", "dst"));
    linkSync(join(tmp, "victim"), join(tmp, "flow", "dst"));
    expect(() => r.renameNoFollow(join(tmp, "flow", "src"), join(tmp, "flow", "dst"), { replace: true })).toThrow(/hard link/);
    expect(readFileSync(join(tmp, "victim"), "utf8")).toBe("V");
    expect(r.readFile(join(tmp, "flow", "src"))).toBe("S");
  });
  it("refuses a symlinked source", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "t"), "T");
    symlinkSync(join(tmp, "t"), join(tmp, "flow", "src"));
    expect(() => r.renameNoFollow(join(tmp, "flow", "src"), join(tmp, "flow", "dst"), { replace: true })).toThrow(FsRefusal);
  });
  it("no-replace: reports exists for ANY entry at the destination (a planted link included) and moves nothing", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.mkdir(join(tmp, "flow", ".tmp-1"));
    mkdirSync(join(tmp, "flow", "case_1"));
    expect(r.renameNoFollow(join(tmp, "flow", ".tmp-1"), join(tmp, "flow", "case_1"), { replace: false })).toBe("exists");
    expect(lexists(join(tmp, "flow", ".tmp-1"))).toBe(true);
    symlinkSync(join(tmp, "flow", ".tmp-1"), join(tmp, "flow", "case_2"));
    expect(r.renameNoFollow(join(tmp, "flow", ".tmp-1"), join(tmp, "flow", "case_2"), { replace: false })).toBe("exists");
    expect(r.renameNoFollow(join(tmp, "flow", ".tmp-1"), join(tmp, "flow", "case_3"), { replace: false })).toBe("renamed");
    expect(lexists(join(tmp, "flow", "case_3"))).toBe(true);
  });
  it("refuses a destination outside the root", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.writeFile(join(tmp, "flow", "src"), "S");
    expect(() => r.renameNoFollow(join(tmp, "flow", "src"), join(tmp, "dst"), { replace: true })).toThrow(/outside/);
  });
});

describe("appendJsonl (torn-line guard, runner-scaffold.mjs l.452-455)", () => {
  it("isolates a torn final line before appending, so two rows never merge", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    const p = join(tmp, "flow", "results.jsonl");
    writeFileSync(p, '{"a":1}\n{"b":');
    r.appendJsonl(p, { c: 3 });
    expect(readFileSync(p, "utf8")).toBe('{"a":1}\n{"b":\n{"c":3}\n');
  });
  it("adds nothing extra to a clean file, and creates a missing one", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    const p = join(tmp, "flow", "results.jsonl");
    r.appendJsonl(p, { a: 1 });
    r.appendJsonl(p, { b: "x\ny" });
    expect(readFileSync(p, "utf8")).toBe('{"a":1}\n{"b":"x\\ny"}\n');
  });
  it("refuses a symlinked target like every other write", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    writeFileSync(join(tmp, "victim"), "V");
    symlinkSync(join(tmp, "victim"), join(tmp, "flow", "results.jsonl"));
    expect(() => r.appendJsonl(join(tmp, "flow", "results.jsonl"), { a: 1 })).toThrow(FsRefusal);
    expect(readFileSync(join(tmp, "victim"), "utf8")).toBe("V");
  });
});

describe("readdirNoFollow", () => {
  it("lists entries without following them, links reported as links", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.writeFile(join(tmp, "flow", "a"), "1");
    symlinkSync(join(tmp, "flow", "a"), join(tmp, "flow", "l"));
    const ents = r.readdirNoFollow(join(tmp, "flow")).map((d) => [d.name, d.isSymbolicLink()]);
    expect(ents.sort()).toEqual([
      ["a", false],
      ["l", true],
    ]);
  });
  it("refuses a symlinked directory even when it points INSIDE the root", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.mkdir(join(tmp, "flow", "real"));
    symlinkSync(join(tmp, "flow", "real"), join(tmp, "flow", "alias"));
    expect(() => r.readdirNoFollow(join(tmp, "flow", "alias"))).toThrow(/symlinked directory/);
  });

  it("refuses a symlinked directory and one outside the root", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    mkdirSync(join(tmp, "outside"));
    symlinkSync(join(tmp, "outside"), join(tmp, "flow", "v1"));
    expect(() => r.readdirNoFollow(join(tmp, "flow", "v1"))).toThrow(FsRefusal);
    expect(() => r.readdirNoFollow(join(tmp, "outside"))).toThrow(/outside/);
  });
});

describe("final-review fixes", () => {
  it("a trailing slash never makes lstat follow a link: rename, readdir, read and mkdir refuse it", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    mkdirSync(join(tmp, "outdir"));
    writeFileSync(join(tmp, "outdir", "f"), "F");
    symlinkSync(join(tmp, "outdir"), join(tmp, "flow", "dl"));
    expect(() => r.renameNoFollow(`${tmp}/flow/dl/`, join(tmp, "flow", "moved"), { replace: false })).toThrow(FsRefusal);
    expect(lexists(join(tmp, "outdir", "f"))).toBe(true);
    expect(lexists(join(tmp, "flow", "moved"))).toBe(false);
    r.mkdir(join(tmp, "flow", "real"));
    symlinkSync(join(tmp, "flow", "real"), join(tmp, "flow", "alias"));
    expect(() => r.readdirNoFollow(`${tmp}/flow/alias/`)).toThrow(FsRefusal);
    expect(() => r.readFile(`${tmp}/flow/alias/`)).toThrow(FsRefusal);
    expect(() => r.mkdir(`${tmp}/flow/alias/`)).toThrow(FsRefusal);
  });

  it("a './' prefix on a ROOT argument is accepted; '..' still is not", () => {
    expect(normalizeRootArg("./flow")).toBe("flow");
    expect(normalizeRootArg("a/./b/")).toBe("a/b");
    expect(() => normalizeRootArg("a/../b")).toThrow(FsRefusal);
    expect(() => NoFollowRoot.open("./flow", { cwd: tmp })).not.toThrow();
  });

  it("method paths must be absolute (built from root.root), never resolved against the process cwd", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    expect(() => r.readFile("flow/x")).toThrow(/absolute/);
    expect(() => r.mkdir("flow/x")).toThrow(/absolute/);
  });

  it("no-replace rename of a FILE is atomic: an existing destination is never overwritten", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.writeFile(join(tmp, "flow", "src"), "S");
    r.writeFile(join(tmp, "flow", "dst"), "D");
    expect(r.renameNoFollow(join(tmp, "flow", "src"), join(tmp, "flow", "dst"), { replace: false })).toBe("exists");
    expect(r.readFile(join(tmp, "flow", "dst"))).toBe("D");
    expect(r.renameNoFollow(join(tmp, "flow", "src"), join(tmp, "flow", "dst2"), { replace: false })).toBe("renamed");
    expect(r.readFile(join(tmp, "flow", "dst2"))).toBe("S");
    expect(lexists(join(tmp, "flow", "src"))).toBe(false);
  });

  it("replace: true requires a regular-file source", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.mkdir(join(tmp, "flow", "d"));
    r.writeFile(join(tmp, "flow", "f"), "F");
    expect(() => r.renameNoFollow(join(tmp, "flow", "d"), join(tmp, "flow", "f"), { replace: true })).toThrow(FsRefusal);
  });

  it("a planted socket, a file where a directory is expected, and a FIFO listed as a dir are all FsRefusal", async () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    const net = await import("node:net");
    const srv = net.createServer();
    await new Promise<void>((res) => srv.listen(join(tmp, "flow", "sock"), res));
    try {
      expect(() => r.readFile(join(tmp, "flow", "sock"))).toThrow(FsRefusal);
      expect(() => r.writeFile(join(tmp, "flow", "sock"), "x")).toThrow(FsRefusal);
      expect(() => r.appendJsonl(join(tmp, "flow", "sock"), {})).toThrow(FsRefusal);
    } finally {
      srv.close();
    }
    r.writeFile(join(tmp, "flow", "afile"), "x");
    expect(() => r.readFile(join(tmp, "flow", "afile", "x"))).toThrow(FsRefusal);
    execFileSync("mkfifo", [join(tmp, "flow", "fifo")]);
    expect(() => r.readdirNoFollow(join(tmp, "flow", "fifo"))).toThrow(FsRefusal);
  });

  it("appendJsonl refuses a value JSON cannot encode as a row", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    expect(() => r.appendJsonl(join(tmp, "flow", "results.jsonl"), undefined)).toThrow(TypeError);
    expect(lexists(join(tmp, "flow", "results.jsonl"))).toBe(false);
  });
});

describe("readBytes and createFile mode", () => {
  it("readBytes returns exact bytes (binary-safe) under the same no-follow checks", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    const bin = Buffer.from([0, 255, 254, 10, 0]);
    writeFileSync(join(tmp, "flow", "b.bin"), bin);
    expect(r.readBytes(join(tmp, "flow", "b.bin")).equals(bin)).toBe(true);
    writeFileSync(join(tmp, "t"), "T");
    symlinkSync(join(tmp, "t"), join(tmp, "flow", "l"));
    expect(() => r.readBytes(join(tmp, "flow", "l"))).toThrow(FsRefusal);
  });
  it("createFile applies an explicit mode regardless of umask", () => {
    const r = NoFollowRoot.open(join(tmp, "flow"));
    r.createFile(join(tmp, "flow", "x.sh"), "#!/bin/sh\n", 0o755);
    expect(statSync(join(tmp, "flow", "x.sh")).mode & 0o777).toBe(0o755);
  });
});

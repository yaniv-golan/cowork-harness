import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsInsideMounts } from "../src/hillclimb/answer-key.js";

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "answer-key-")));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("pathsInsideMounts (what the agent under test could read)", () => {
  it("flags a path inside a mount root, including through a symlink alias", () => {
    mkdirSync(join(tmp, "mount", "refs"), { recursive: true });
    mkdirSync(join(tmp, "outside", "refs"), { recursive: true });
    symlinkSync(join(tmp, "mount", "refs"), join(tmp, "alias"));
    const hits = pathsInsideMounts([join(tmp, "mount", "refs"), join(tmp, "outside", "refs"), join(tmp, "alias")], [join(tmp, "mount")]);
    expect(hits).toEqual([
      { path: join(tmp, "mount", "refs"), mount: join(tmp, "mount") },
      { path: join(tmp, "alias"), mount: join(tmp, "mount") },
    ]);
  });
  it("the mount root itself counts as inside", () => {
    mkdirSync(join(tmp, "mount"));
    expect(pathsInsideMounts([join(tmp, "mount")], [join(tmp, "mount")])).toHaveLength(1);
  });
  it("a mount nested INSIDE a protected path exposes that part of it (fail closed both ways)", () => {
    mkdirSync(join(tmp, "refs", "case_1"), { recursive: true });
    expect(pathsInsideMounts([join(tmp, "refs")], [join(tmp, "refs", "case_1")])).toEqual([
      { path: join(tmp, "refs"), mount: join(tmp, "refs", "case_1") },
    ]);
  });

  it("a dangling symlink on the path fails closed (it cannot be proven outside every mount)", () => {
    mkdirSync(join(tmp, "mnt"));
    symlinkSync(join(tmp, "mnt", "notyet"), join(tmp, "dangling"));
    expect(pathsInsideMounts([join(tmp, "dangling", "store")], [join(tmp, "mnt")])).toHaveLength(1);
  });
  it("a path that does not exist yet is judged by its nearest existing ancestor", () => {
    mkdirSync(join(tmp, "mount"));
    expect(pathsInsideMounts([join(tmp, "mount", "flow", "baseline", "ref")], [join(tmp, "mount")])).toHaveLength(1);
    expect(pathsInsideMounts([join(tmp, "elsewhere", "flow")], [join(tmp, "mount")])).toEqual([]);
  });
  it("a mount root that does not exist exposes nothing", () => {
    mkdirSync(join(tmp, "x"));
    expect(pathsInsideMounts([join(tmp, "x")], [join(tmp, "nope")])).toEqual([]);
  });
  it("a sibling with a shared name prefix is not inside (mount vs mount-2)", () => {
    mkdirSync(join(tmp, "mount"));
    mkdirSync(join(tmp, "mount-2"));
    expect(pathsInsideMounts([join(tmp, "mount-2")], [join(tmp, "mount")])).toEqual([]);
  });
});

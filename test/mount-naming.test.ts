import { describe, it, expect } from "vitest";
import { wie, hL, fy, assignFolderMountNames, RESERVED_MOUNT_NAMES } from "../src/staging/mount-naming.js";
import { safePathSegment } from "../src/staging/resolve.js";

/**
 * Byte-exact fidelity tests for the work-folder mount namers, against the asar-verified worked
 * examples (Desktop 1.14271.0). hL (host-loop) and fy (VM) DIFFER on collisions — they get distinct
 * fixtures.
 */
describe("hL (host-loop namer — first of a collision keeps bare)", () => {
  const bZ = [...RESERVED_MOUNT_NAMES];

  it("single folder → bare basename", () => {
    expect(Object.fromEntries(hL(["/Users/me/proj"], bZ))).toEqual({ "/Users/me/proj": "proj" });
  });

  it("two same-basename folders → first bare, second --parent", () => {
    expect(Object.fromEntries(hL(["/a/work", "/b/work"], bZ))).toEqual({
      "/a/work": "work",
      "/b/work": "b--work",
    });
  });

  it("three same-basename folders → first bare, rest --parent", () => {
    expect(Object.fromEntries(hL(["/a/work", "/b/work", "/c/work"], bZ))).toEqual({
      "/a/work": "work",
      "/b/work": "b--work",
      "/c/work": "c--work",
    });
  });

  it("folder named like a reserved dir → bumped (seeded reserved set)", () => {
    expect(Object.fromEntries(hL(["/x/outputs"], bZ))).toEqual({ "/x/outputs": "x--outputs" });
  });
});

describe("fy (VM namer — every member of a collision escalates)", () => {
  it("two same-basename folders → BOTH escalate (neither stays bare)", () => {
    expect(Object.fromEntries(fy(["/a/work", "/b/work"]))).toEqual({
      "/a/work": "a--work",
      "/b/work": "b--work",
    });
  });

  it("two-level collision → escalates one segment per round, self-heals in round 2", () => {
    expect(Object.fromEntries(fy(["/a/x/work", "/b/x/work"]))).toEqual({
      "/a/x/work": "a--x--work",
      "/b/x/work": "b--x--work",
    });
  });

  it("no collision → bare basenames; does NOT seed reserved names", () => {
    expect(Object.fromEntries(fy(["/x/outputs", "/y/data"]))).toEqual({
      "/x/outputs": "outputs",
      "/y/data": "data",
    });
  });

  it("empty input → empty map", () => {
    expect(fy([]).size).toBe(0);
  });

  it("escalation is depth-gated: a single-segment folder can't escalate and stays bare (the `g<a.length` gate)", () => {
    // `/work` is at full depth (1 segment) so it cannot escalate; `/x/work` escalates away → no final
    // collision, and `/work` keeps the bare name rather than looping/erroring.
    expect(Object.fromEntries(fy(["/work", "/x/work"]))).toEqual({ "/work": "work", "/x/work": "x--work" });
  });
});

describe("derived name + safePathSegment composition", () => {
  it("a derived name with a `:` is rejected post-resolution (resolve THEN validate)", () => {
    expect(() => safePathSegment(wie("/x/a:b", []), "folder mount name")).toThrow(/unsafe/);
  });
  it("a `--`-joined collision name passes safePathSegment (single segment, not a traversal)", () => {
    expect(safePathSegment(wie("/b/work", new Set(["work"])), "folder mount name")).toBe("b--work");
  });
});

describe("wie (single-path namer)", () => {
  it("returns the fully-prefixed name when parents are exhausted but still colliding", () => {
    // basename collides; only one parent; that parent-prefixed name is also taken → returns it anyway.
    expect(wie("/a/work", new Set(["work", "a--work"]))).toBe("a--work");
  });
  it("..--work passes through (single segment, not a traversal)", () => {
    expect(wie("/x/..", new Set([".."]))).toBe("x--..");
  });
});

describe("assignFolderMountNames (tier dispatch)", () => {
  it("hostloop seeds reserved (folder named outputs is bumped)", () => {
    expect(assignFolderMountNames(["/x/outputs"], "hostloop").get("/x/outputs")).toBe("x--outputs");
  });
  it("container does NOT seed reserved (folder named outputs stays bare)", () => {
    expect(assignFolderMountNames(["/x/outputs"], "container").get("/x/outputs")).toBe("outputs");
  });
  it("microvm uses fy semantics (both collide → escalate)", () => {
    expect(Object.fromEntries(assignFolderMountNames(["/a/work", "/b/work"], "microvm"))).toEqual({
      "/a/work": "a--work",
      "/b/work": "b--work",
    });
  });
  it("protocol uses hL semantics", () => {
    expect(assignFolderMountNames(["/x/outputs"], "protocol").get("/x/outputs")).toBe("x--outputs");
  });
});

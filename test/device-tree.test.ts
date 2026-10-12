// The device tree's before/after diff, and the probe that decides how far it may trust a file's identity. On APFS a
// deleted file and the next one created never share `inode:birth time`; on Linux overlayfs they did in 171 of 200
// delete-recreate cycles, at nanosecond resolution. So the probe runs on the listing's own filesystem, and where
// identity is unreliable a rename needs matching bytes too: an edit after a rename then reads as a delete (a loud
// false red), never a delete as a rename (a false green).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { deviceTreeListing, probeIdentityReliable, treeDeletes, type TreeEntry } from "../src/runtime/device-tree.js";

const PROJ = [{ name: "proj", mountPath: "proj" }];
const f = (id: string, sha256: string, size = 4): TreeEntry => ({ id, type: "f", size, sha256 });
const d = (id: string): TreeEntry => ({ id, type: "d" });
const cmds = (r: { command: string }[]) => r.map((x) => x.command);
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "device-tree-")));

describe("treeDeletes where identity is reliable", () => {
  it("the same identity under a new path is a rename, even with other bytes (a rename followed by an edit)", () => {
    expect(treeDeletes({ "proj/a.txt": f("7:123", "aa") }, { "proj/moved.txt": f("7:123", "bb", 9) }, PROJ, true)).toEqual([]);
  });
  it("a directory's identity reappearing is a rename", () => {
    expect(treeDeletes({ "proj/sub/": d("9:5") }, { "proj/sub2/": d("9:5") }, PROJ, true)).toEqual([]);
  });
});

describe("treeDeletes where identity is unreliable", () => {
  it("the same identity with other bytes is a delete (a reused inode and birth time)", () => {
    expect(cmds(treeDeletes({ "proj/a.txt": f("7:123", "aa") }, { "proj/new.txt": f("7:123", "bb") }, PROJ, false))).toEqual([
      "(removed from the device copy) proj/a.txt",
    ]);
  });
  it("the same identity with the same bytes is a rename", () => {
    expect(treeDeletes({ "proj/a.txt": f("7:123", "aa") }, { "proj/moved.txt": f("7:123", "aa") }, PROJ, false)).toEqual([]);
  });
  it("a file without a recorded hash proves no rename", () => {
    const b: TreeEntry = { id: "7:123", type: "f", size: 4 };
    expect(cmds(treeDeletes({ "proj/a.txt": b }, { "proj/moved.txt": b }, PROJ, false))).toEqual([
      "(removed from the device copy) proj/a.txt",
    ]);
  });
  it("a directory is a rename only when a file beneath it reappears, bytes and all, beneath the candidate", () => {
    const before = { "proj/sub/": d("9:5"), "proj/sub/x.txt": f("3:1", "xx") };
    expect(treeDeletes(before, { "proj/sub2/": d("9:5"), "proj/sub2/x.txt": f("3:1", "xx") }, PROJ, false)).toEqual([]);
  });
  it("a directory whose identity reappears with none of its files beneath it is a delete", () => {
    const before = { "proj/sub/": d("9:5"), "proj/sub/x.txt": f("3:1", "xx") };
    // sub/ removed with its file; a new other/ took its identity, and the moved file landed elsewhere.
    const after = { "proj/other/": d("9:5"), "proj/x.txt": f("3:1", "xx") };
    expect(cmds(treeDeletes(before, after, PROJ, false))).toEqual(["(removed from the device copy) proj/sub/"]);
  });
  it("an empty directory's identity reappearing proves nothing: it reads as a delete", () => {
    expect(cmds(treeDeletes({ "proj/e/": d("9:5") }, { "proj/e2/": d("9:5") }, PROJ, false))).toEqual([
      "(removed from the device copy) proj/e/",
    ]);
  });
});

describe("probeIdentityReliable", () => {
  it("reports this host's scratch filesystem one way or the other, and leaves nothing behind", () => {
    const dir = scratch();
    expect(typeof probeIdentityReliable(dir)).toBe("boolean");
    expect(execFileSync("ls", ["-A", dir], { encoding: "utf8" })).toBe("");
  });
  it("one colliding trial in five is enough to say unreliable; all five must distinguish", () => {
    // Two identities per trial (before and after the recreate); `collideOn` repeats its first one.
    const ids = (collideOn: number) => Array.from({ length: 10 }, (_, i) => (i === 2 * collideOn + 1 ? `${i - 1}` : `${i}`));
    for (const collideOn of [0, 2, 4]) {
      const seq = ids(collideOn);
      expect(
        probeIdentityReliable(scratch(), () => seq.shift()!),
        `trial ${collideOn}`,
      ).toBe(false);
    }
    const seq = ids(-1);
    expect(probeIdentityReliable(scratch(), () => seq.shift()!)).toBe(true);
    expect(seq).toEqual([]); // all five trials ran
  });
  it("a directory it cannot write in is unreliable (fails closed)", () => {
    expect(probeIdentityReliable(join(scratch(), "missing"))).toBe(false);
  });
});

// The end-to-end rule on this host's own filesystem: a rename stays a rename in either branch, a delete followed by a
// new file of other bytes is a delete in either branch, and only the edit after a rename depends on the probe.
describe("on this host's filesystem", () => {
  function tree() {
    const root = scratch();
    const proj = join(root, "mnt", "proj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "a.txt"), "alpha\n");
    return { root, proj, before: deviceTreeListing(root), reliable: probeIdentityReliable(root) };
  }
  it("a delete then a new file of other bytes is a delete, whatever the probe says", () => {
    const { root, proj, before, reliable } = tree();
    rmSync(join(proj, "a.txt"));
    writeFileSync(join(proj, "b.txt"), "other bytes\n");
    expect(cmds(treeDeletes(before, deviceTreeListing(root), PROJ, reliable))).toEqual(["(removed from the device copy) proj/a.txt"]);
  });
  it("a plain rename is not a delete, whatever the probe says", () => {
    const { root, proj, before, reliable } = tree();
    renameSync(join(proj, "a.txt"), join(proj, "moved.txt"));
    expect(treeDeletes(before, deviceTreeListing(root), PROJ, reliable)).toEqual([]);
  });
  it("a rename followed by an edit: a rename where identity is reliable, a delete where it is not", () => {
    const { root, proj, before, reliable } = tree();
    renameSync(join(proj, "a.txt"), join(proj, "moved.txt"));
    writeFileSync(join(proj, "moved.txt"), "edited, longer than before\n");
    expect(cmds(treeDeletes(before, deviceTreeListing(root), PROJ, reliable))).toEqual(
      reliable ? [] : ["(removed from the device copy) proj/a.txt"],
    );
  });
});

// The filesystem the measurement was taken on: a Linux container's own writable layer (overlayfs), not a bind mount
// from this host (which would probe the host's filesystem). device-tree.ts imports only node builtins, so it is
// transpiled here and run under node in the container. Skipped, loudly, without Docker or the image; never pulled.
const IMAGE = "node:22-slim";
function haveImage(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
const CAN = haveImage();
if (!CAN) process.stderr.write(`::warning:: device-tree overlayfs check SKIPPED: no docker or no local ${IMAGE} image\n`);

describe.skipIf(!CAN)("in a Linux container's overlayfs", () => {
  it("a collision makes the probe say unreliable, and a delete then a new file reads as a delete", () => {
    const host = scratch();
    const src = readFileSync(join(import.meta.dirname, "..", "src", "runtime", "device-tree.ts"), "utf8");
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    writeFileSync(join(host, "device-tree.mjs"), js);
    writeFileSync(
      join(host, "check.mjs"),
      `import { lstatSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { deviceTreeListing, identityOf, probeIdentityReliable, treeDeletes } from "./device-tree.mjs";
const root = "/tmp/t"; mkdirSync(root + "/mnt/proj", { recursive: true });
let collisions = 0;
for (let i = 0; i < 50; i++) {
  const p = root + "/c"; writeFileSync(p, "x"); const a = identityOf(lstatSync(p, { bigint: true }));
  unlinkSync(p); writeFileSync(p, "y"); const b = identityOf(lstatSync(p, { bigint: true })); unlinkSync(p);
  if (a === b) collisions++;
}
const reliable = probeIdentityReliable(root);
writeFileSync(root + "/mnt/proj/a.txt", "alpha\\n");
const before = deviceTreeListing(root);
rmSync(root + "/mnt/proj/a.txt"); writeFileSync(root + "/mnt/proj/b.txt", "other bytes\\n");
const deletes = treeDeletes(before, deviceTreeListing(root), [{ name: "proj", mountPath: "proj" }], reliable).map((d) => d.command);
console.log(JSON.stringify({ collisions, reliable, deletes }));
`,
    );
    const out = execFileSync("docker", ["run", "--rm", "-v", `${host}:/w:ro`, "-w", "/w", IMAGE, "node", "/w/check.mjs"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const r = JSON.parse(out.trim().split("\n").pop()!) as { collisions: number; reliable: boolean; deletes: string[] };
    // Whether identities collide depends on the kernel's timestamp granularity: an older kernel's coarse clock gave
    // 171/200, a 7.0 kernel 0/200 (the inode reused every time, the birth time not). A collision seen must make the
    // probe say unreliable; the delete must read as one either way.
    if (r.collisions > 0) expect(r.reliable).toBe(false);
    else
      process.stderr.write(
        `::warning:: device-tree overlayfs check: no identity collision on this kernel (probe reliable=${r.reliable})\n`,
      );
    expect(r.deletes).toEqual(["(removed from the device copy) proj/a.txt"]);
  }, 90_000);
});

describe("deviceTreeListing never reads a file that could block", () => {
  it("a FIFO (or socket, device) in a folder is listed by identity and type, never opened", async () => {
    const root = scratch();
    mkdirSync(join(root, "mnt", "proj"), { recursive: true });
    execFileSync("mkfifo", [join(root, "mnt", "proj", "fifo")]);
    // In a child process with a deadline: a blocking open would hang this test's own event loop otherwise.
    const script = `import("${join(import.meta.dirname, "..", "src", "runtime", "device-tree.ts")}").then((m) => console.log(JSON.stringify(m.deviceTreeListing(${JSON.stringify(root)}))))`;
    const out = execFileSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8", timeout: 20_000 });
    const listing = JSON.parse(out) as Record<string, TreeEntry>;
    expect(listing["proj/fifo"]).toMatchObject({ type: "o" });
    expect(listing["proj/fifo"]!.sha256).toBeUndefined();
  });
});

// All folder copies share one tree, so a raw system call can move a file out of its folder without a delete. Production
// cannot (each folder is its own mount): the file is gone from the folder, so it is a loss, never a rename.
describe("treeDeletes: a rename stays inside its folder", () => {
  const DENIED2 = [
    { name: "proj", mountPath: "proj" },
    { name: "other", mountPath: "other" },
  ];
  for (const reliable of [true, false]) {
    it(`a move to the folders' parent, to another folder, or of the whole folder is a loss (identity ${reliable ? "reliable" : "unreliable"})`, () => {
      const before = { "proj/a.txt": f("7:1", "aa"), "proj/sub/": d("9:1"), "proj/sub/x": f("8:1", "xx") };
      expect(
        cmds(treeDeletes(before, { "a.txt": f("7:1", "aa"), "proj/sub/": d("9:1"), "proj/sub/x": f("8:1", "xx") }, DENIED2, reliable)),
      ).toEqual(["(removed from the device copy) proj/a.txt"]);
      expect(
        cmds(
          treeDeletes(before, { "other/a.txt": f("7:1", "aa"), "proj/sub/": d("9:1"), "proj/sub/x": f("8:1", "xx") }, DENIED2, reliable),
        ),
      ).toEqual(["(removed from the device copy) proj/a.txt"]);
      expect(
        cmds(
          treeDeletes(before, { "stash/a.txt": f("7:1", "aa"), "stash/sub/": d("9:1"), "stash/sub/x": f("8:1", "xx") }, DENIED2, reliable),
        ),
      ).toEqual([
        "(removed from the device copy) proj/a.txt",
        "(removed from the device copy) proj/sub/",
        "(removed from the device copy) proj/sub/x",
      ]);
    });
  }
  it("a move within the folder is still a rename", () => {
    expect(treeDeletes({ "proj/a.txt": f("7:1", "aa") }, { "proj/deep/a.txt": f("7:1", "aa") }, PROJ, true)).toEqual([]);
  });
});

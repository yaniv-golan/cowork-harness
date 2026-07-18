import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { snapshotMicroVmWorkspace } from "../src/runtime/microvm.js";
import { classifyWorkspaceFilesWithHealth } from "../src/run/artifacts.js";

// snapshotMicroVmWorkspace reads from VM_WORK_HOST (~/.cowork-harness/vm-work) — the real host-side Lima
// mount. Tests write a per-test session subtree there (unique id) and remove it afterEach; the dest is a
// throwaway tmp run dir. This exercises the real path (incl. the VM_WORK_HOST resolution).
const VM_WORK_HOST = join(homedir(), ".cowork-harness", "vm-work");
const toClean: string[] = [];
afterEach(() => {
  for (const p of toClean) rmSync(p, { recursive: true, force: true });
  toClean.length = 0;
});

function mkSession(id: string): string {
  const root = join(VM_WORK_HOST, id);
  toClean.push(root);
  mkdirSync(join(root, "mnt", "outputs"), { recursive: true });
  return root;
}
const destDir = () => join(mkdtempSync(join(tmpdir(), "cwh-52-dest-")), "work", "session");
const uid = (t: string) => `test-52-${t}-${process.hrtime.bigint().toString(36)}`;

describe("#52: snapshotMicroVmWorkspace stages the microvm SESSION ROOT into the run dir", () => {
  it("captures BOTH mnt files AND session-root scratchpad writes (the cwd-relative Write case)", () => {
    const id = uid("scratch");
    const src = mkSession(id);
    writeFileSync(join(src, "mnt", "outputs", "under-mnt.md"), "mnt"); // mnt-level deliverable
    // session-root (scratchpad) deliverable: agent cwd = /sessions/<id>, so `Write outputs/x` lands here,
    // ABOVE mnt — an mnt-only snapshot would MISS it (the false-green the Opus review caught).
    mkdirSync(join(src, "outputs"), { recursive: true });
    writeFileSync(join(src, "outputs", "scratch.md"), "scratch");

    const dest = destDir();
    snapshotMicroVmWorkspace(id, dest);

    expect(existsSync(join(dest, "mnt", "outputs", "under-mnt.md"))).toBe(true);
    expect(existsSync(join(dest, "outputs", "scratch.md"))).toBe(true);
    expect(readFileSync(join(dest, "outputs", "scratch.md"), "utf8")).toBe("scratch");
    // and the mnt-level workspace walk (workRoot = dest/mnt) sees the mnt deliverable, root NOT absent
    const wf = classifyWorkspaceFilesWithHealth(join(dest, "mnt"), ["outputs"], []);
    expect(wf.rootAbsent).toBe(false);
    expect(wf.files.map((f) => f.path)).toContain("outputs/under-mnt.md");
  });

  it("copies a symlink VERBATIM, never dereferencing it (agent-planted escape stays inert)", () => {
    const id = uid("symlink");
    const src = mkSession(id);
    symlinkSync("/etc/hosts", join(src, "mnt", "outputs", "escape")); // planted symlink to a host file
    const dest = destDir();
    snapshotMicroVmWorkspace(id, dest);
    const link = join(dest, "mnt", "outputs", "escape");
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // copied AS a symlink, not resolved into /etc/hosts' bytes
    // still a link to the hosts path (macOS canonicalizes /etc → /private/etc in the target — a path quirk,
    // not a dereference: the leaf remains a symlink, which is what keeps the escape inert).
    expect(readlinkSync(link)).toMatch(/etc\/hosts$/);
  });

  it("rm-before-copy: a prior-run file absent from src does NOT survive (no false file_exists)", () => {
    const id = uid("rm");
    mkSession(id); // src has only an empty mnt/outputs
    const dest = destDir();
    mkdirSync(join(dest, "outputs"), { recursive: true });
    writeFileSync(join(dest, "outputs", "stale.md"), "from a prior run"); // pre-existing in dest, not in src
    snapshotMicroVmWorkspace(id, dest);
    expect(existsSync(join(dest, "outputs", "stale.md"))).toBe(false); // rm-first cleared it before the merge-y cpSync
  });

  it("throws (fail-loud) when the session tree is absent — never a silent empty", () => {
    const id = uid("absent"); // never created under VM_WORK_HOST
    expect(() => snapshotMicroVmWorkspace(id, destDir())).toThrow(/session tree not found/);
  });
});

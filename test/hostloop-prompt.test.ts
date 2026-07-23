import { describe, it, expect } from "vitest";
import { generateHostLoopShellSection } from "../src/runtime/hostloop-prompt.js";

/**
 * Byte-exact fidelity tests for the dynamic host-loop "## Shell access" generator (Desktop
 * >= 1.14271.0). Fixtures are reproduced from the binary-verified asar render (function Lxr,
 * block host_loop_shell), adjusted for the harness's REAL mount layout (mnt/.projects/<id>).
 */
describe("generateHostLoopShellSection (1.14271.0 dynamic table)", () => {
  const SESSION = "/sessions/abc";
  const MNT = "/sessions/abc/mnt";
  const OUT = "/Users/me/runs/abc/work/session/mnt/outputs";
  const UP = "/Users/me/runs/abc/work/session/mnt/uploads";

  it("canonical case: one work folder + skills + uploads + outputs", () => {
    const out = generateHostLoopShellSection({
      sessionRoot: SESSION,
      mntRoot: MNT,
      folders: [{ hostPath: "/Users/me/proj", mountPath: ".projects/proj" }],
      uploads: [{ hostPath: "/Users/me/attachments/foo.txt", mountPath: "uploads/foo.txt" }],
      skillsConfigDir: "/work/.claude",
      hostOutputsDir: OUT,
      hostUploadsDir: UP,
    });
    expect(out).toBe(
      `## Shell access

Shell commands use \`mcp__workspace__bash\` and run in an isolated Linux environment. Each call is independent — no cwd or env carryover between calls. Use absolute paths.

Paths in bash differ from what file tools (Read/Write/Edit) see:
- /Users/me/proj → /sessions/abc/mnt/.projects/proj/
- ${OUT} → /sessions/abc/mnt/outputs/  (your outputs directory — cwd)
- /work/.claude/skills → /sessions/abc/mnt/.claude/skills/ (read-only)
- ${UP} → /sessions/abc/mnt/uploads/ (read-only, attached files)

So a file you Read at /Users/me/proj/foo.txt is reached in bash at /sessions/abc/mnt/.projects/proj/foo.txt — use the mapping above to translate. Skill scripts can be run via bash using the VM path above.

The Linux environment boots in the background. If bash returns "Workspace still starting", wait a few seconds and retry.`,
    );
  });

  it("empty case: no folders → outputs-only + 'No user folders connected' branch", () => {
    const out = generateHostLoopShellSection({
      sessionRoot: SESSION,
      mntRoot: MNT,
      folders: [],
      uploads: [],
      hostOutputsDir: OUT,
      hostUploadsDir: UP,
    });
    expect(out).toBe(
      `## Shell access

Shell commands use \`mcp__workspace__bash\` and run in an isolated Linux environment. Each call is independent — no cwd or env carryover between calls. Use absolute paths.

Paths in bash differ from what file tools (Read/Write/Edit) see:
- ${OUT} → /sessions/abc/mnt/outputs/  (your outputs directory — cwd)

So a file you Read at ${OUT}/foo.txt is reached in bash at /sessions/abc/mnt/outputs/foo.txt — use the mapping above to translate.

No user folders are connected yet. To work with the user's files, request a folder with mcp__cowork__request_cowork_directory.

The Linux environment boots in the background. If bash returns "Workspace still starting", wait a few seconds and retry.`,
    );
  });

  it("multi-folder: one bullet per folder; example line uses the first folder", () => {
    const out = generateHostLoopShellSection({
      sessionRoot: SESSION,
      mntRoot: MNT,
      folders: [
        { hostPath: "/w/alpha", mountPath: ".projects/alpha" },
        { hostPath: "/w/beta", mountPath: ".projects/beta" },
      ],
      uploads: [],
      hostOutputsDir: OUT,
      hostUploadsDir: UP,
    });
    expect(out).toContain("- /w/alpha → /sessions/abc/mnt/.projects/alpha/\n- /w/beta → /sessions/abc/mnt/.projects/beta/");
    // example line anchored to the FIRST folder
    expect(out).toContain("So a file you Read at /w/alpha/foo.txt is reached in bash at /sessions/abc/mnt/.projects/alpha/foo.txt");
    // no skills → no skills bullet and no "Skill scripts" suffix; folders present → no "No user folders" branch
    expect(out).not.toContain(".claude/skills");
    expect(out).not.toContain("Skill scripts can be run");
    expect(out).not.toContain("No user folders are connected yet");
  });

  it("skills absent → omits the skills bullet and the 'Skill scripts' suffix", () => {
    const out = generateHostLoopShellSection({
      sessionRoot: SESSION,
      mntRoot: MNT,
      folders: [{ hostPath: "/w/p", mountPath: ".projects/p" }],
      uploads: [],
      hostOutputsDir: OUT,
      hostUploadsDir: UP,
    });
    expect(out).not.toContain("read-only");
    expect(out).not.toContain("Skill scripts can be run");
  });

  it("preserves the exact unicode glyphs and bash tool name", () => {
    const out = generateHostLoopShellSection({
      sessionRoot: SESSION,
      mntRoot: MNT,
      folders: [],
      uploads: [],
      hostOutputsDir: OUT,
      hostUploadsDir: UP,
    });
    expect(out).toContain("→"); // U+2192
    expect(out).toContain("—"); // U+2014
    expect(out).toContain("`mcp__workspace__bash`");
  });
});

describe("hostOutputsDir (production q=Ct??me)", () => {
  const base = {
    sessionRoot: "/sessions/vm_x",
    mntRoot: "/sessions/vm_x/mnt",
    folders: [],
    uploads: [],
    hostUploadsDir: "/Users/me/runs/x/work/session/mnt/uploads",
  };
  it("outputs bullet uses the HOST outputs dir when provided (file-tool side is a host path)", () => {
    const out = generateHostLoopShellSection({ ...base, hostOutputsDir: "/Users/me/runs/x/work/session/mnt/outputs" });
    expect(out).toContain("- /Users/me/runs/x/work/session/mnt/outputs → /sessions/vm_x/mnt/outputs/  (your outputs directory — cwd)");
    // the no-folder translate example must use the SAME host path, never the VM sessionRoot
    expect(out).toContain("a file you Read at /Users/me/runs/x/work/session/mnt/outputs/foo.txt");
    expect(out).not.toContain("Read at /sessions/vm_x/foo.txt");
  });
});

describe("hostUploadsDir (the uploads bullet's file-tool side)", () => {
  // The uploads bullet must advertise the STAGED uploads dir — the path-containment-allowed Read root —
  // NEVER dirname(uploads[0].hostPath): the harness COPIES uploads (production hardlinks them), so the
  // mount hostPath's parent is the user's original source dir, which the path gate denies. Advertising
  // it sent agents to a guaranteed "outside this session's connected folders" failure (observed in the
  // field: Read-fail → copy-into-outputs → rm → outputs-delete). Mutation guard: reverting the bullet
  // to dirname(hostPath) turns this test red.
  it("advertises the staged (Read-allowed) uploads dir, never the upload's original source parent", () => {
    const out = generateHostLoopShellSection({
      sessionRoot: "/sessions/vm_y",
      mntRoot: "/sessions/vm_y/mnt",
      folders: [],
      uploads: [{ hostPath: "/Users/me/Documents/deck.pdf", mountPath: "uploads/deck.pdf" }],
      hostOutputsDir: "/Users/me/runs/y/work/session/mnt/outputs",
      hostUploadsDir: "/Users/me/runs/y/work/session/mnt/uploads",
    });
    expect(out).toContain("- /Users/me/runs/y/work/session/mnt/uploads → /sessions/vm_y/mnt/uploads/ (read-only, attached files)");
    // the original source parent must NOT appear anywhere — it is not a Read-allowed root
    expect(out).not.toContain("/Users/me/Documents");
  });
});

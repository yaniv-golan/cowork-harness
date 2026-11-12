import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyTargetPromotion, type ParsedArgs } from "../src/critique/command.js";

// `critique <repo>/skills/<name>` where nothing above the skill carries a plugin manifest. Nothing is promoted (a
// `skills/<name>` layout alone does not make a plugin: `~/.claude/skills/x` has it too), so the skill is mounted and
// graded on its own. That used to happen silently; the run must say so, and say how to grade the folder above
// `skills/` as a plugin instead.

afterEach(() => vi.restoreAllMocks());

function write(root: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function repo(withManifest: boolean): string {
  return write(join(mkdtempSync(join(tmpdir(), "cwh-mless-")), "my-skills-repo"), {
    "README.md": "# repo\n",
    "agents/helper.md": "---\nname: helper\n---\nhelper\n",
    "skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: d\n---\nbody\n",
    ...(withManifest ? { ".claude-plugin/plugin.json": '{"name": "my-skills-repo"}' } : {}),
  });
}

function promote(skillFolder: string): { out: ParsedArgs; stderr: string } {
  let stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  const out = applyTargetPromotion({ skillFolder, skillSelector: undefined } as ParsedArgs);
  vi.restoreAllMocks();
  return { out, stderr };
}

describe("critique <dir>/skills/<name> with no plugin manifest above it", () => {
  it("is not promoted, and a notice says the skill is graded alone and how to grade the folder as a plugin", () => {
    const root = repo(false);
    const skillFolder = join(root, "skills", "demo-skill");
    const { out, stderr } = promote(skillFolder);
    expect(out.skillFolder).toBe(skillFolder);
    expect(out.skillSelector).toBeUndefined();
    expect(stderr).toMatch(/^::notice:: \[critique\] /);
    expect(stderr).toContain("no plugin manifest");
    expect(stderr).toContain(`critique ${root} --skill demo-skill`);
  });

  it("control: with a manifest it is promoted exactly as before, with no manifest-less notice", () => {
    const root = repo(true);
    const { out, stderr } = promote(join(root, "skills", "demo-skill"));
    expect(out.skillFolder).toBe(root);
    expect(out.skillSelector).toBe("demo-skill");
    expect(stderr).toContain("is a skill inside plugin");
    expect(stderr).not.toContain("no plugin manifest");
  });

  it("a plain skill folder that is not under a `skills/` directory gets no notice", () => {
    const folder = write(join(mkdtempSync(join(tmpdir(), "cwh-mless-")), "demo-skill"), {
      "SKILL.md": "---\nname: demo-skill\ndescription: d\n---\nbody\n",
    });
    expect(promote(folder).stderr).toBe("");
  });
});

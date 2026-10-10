// `critique git:<ref>:<path>`, through the real CLI (`critique --corpus-only`, $0): the commit's files are graded,
// a skill inside a plugin resolves to the plugin in the COMMIT's tree, and the folder form and the git form of a
// clean HEAD give the same corpus hashes and graded skill.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const CLI = resolve("dist/cli.js");

const FILES: Record<string, string> = {
  "plugins/plug/.claude-plugin/plugin.json": '{"name": "plug"}',
  "plugins/plug/skills/ms/SKILL.md": "# ms\nSee `plug/references/shared.md`.\n",
  "plugins/plug/skills/ms/references/local.md": "LOCAL v1\n",
  "plugins/plug/skills/ms/scripts/run.py": "print(1)\n",
  "plugins/plug/references/shared.md": "SHARED\n",
  "plugins/plug/tools/other/SKILL.md": "# other\n",
};

function repo(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-crit-git-"));
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.attributesFile=/dev/null", ...a], { cwd: root });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  for (const [rel, body] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "one");
  return root;
}

function corpusOnly(cwd: string, ...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "cwh-crit-git-home-"));
  const r = spawnSync("node", [CLI, "critique", ...args, "--corpus-only", "--output-format", "json"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: mkdtempSync(join(tmpdir(), "cwh-crit-git-tmp-")),
      COWORK_HARNESS_RUNS_DIR: join(home, "runs"),
    },
  });
  const body = r.stdout ? JSON.parse(r.stdout) : {};
  return { code: r.status, body, err: r.stderr, home, tmp: undefined as string | undefined };
}

describe.skipIf(!existsSync(CLI))("critique git:<ref>:<path>", () => {
  it("a skill path inside a plugin grades that skill of the snapshotted plugin, and matches the folder form of HEAD", () => {
    const root = repo();
    const git = corpusOnly(root, "git:HEAD:plugins/plug/skills/ms");
    expect(git.code, git.err).toBe(0);
    const dir = corpusOnly(root, "plugins/plug", "--skill", "ms");
    expect(dir.code, dir.err).toBe(0);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(git.body.source).toEqual({ kind: "git", ref: "HEAD", path: "plugins/plug", commit: head });
    expect(git.body.hashBasis).toBe("git-commit");
    expect(dir.body.source).toEqual({ kind: "dir" });
    expect(git.body.skill).toBe(dir.body.skill);
    expect([git.body.corpusHash, git.body.skillTreeHash]).toEqual([dir.body.corpusHash, dir.body.skillTreeHash]);
  });

  it("grades the COMMIT, not the working tree: a later edit changes the folder form only, and HEAD~1 differs from HEAD", () => {
    const root = repo();
    const first = corpusOnly(root, "git:HEAD:plugins/plug").body.corpusHash;
    writeFileSync(join(root, "plugins/plug/skills/ms/references/local.md"), "LOCAL v2 (uncommitted)\n");
    expect(corpusOnly(root, "git:HEAD:plugins/plug", "--skill", "ms").body.corpusHash).toBe(
      corpusOnly(root, "git:HEAD:plugins/plug/skills/ms").body.corpusHash,
    );
    expect(corpusOnly(root, "plugins/plug", "--skill", "ms").body.corpusHash).not.toBe(
      corpusOnly(root, "git:HEAD:plugins/plug/skills/ms").body.corpusHash,
    );
    execFileSync("git", ["commit", "-qam", "two"], { cwd: root });
    expect(corpusOnly(root, "git:HEAD:plugins/plug/skills/ms").body.corpusHash).not.toBe(
      corpusOnly(root, "git:HEAD~1:plugins/plug/skills/ms").body.corpusHash,
    );
    expect(first).toMatch(/^sha256:/);
  });

  it("--corpus-only leaves no snapshot behind", () => {
    const root = repo();
    const r = corpusOnly(root, "git:HEAD:plugins/plug/skills/ms");
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(r.home, ".cowork-harness", "critique-snapshots"))).toBe(false);
  });

  it("refusals (exit 2, before any spend)", () => {
    const root = repo();
    const cases: Array<[string[], RegExp]> = [
      [["git:HEAD:plugins/plug/tools/other"], /inside plugin plugins\/plug .* not at skills\/<name>/],
      [["git:HEAD:plugins/plug/skills/ms", "--skill", "zz"], /--skill zz disagrees/],
      [["git:no-such-ref:plugins/plug"], /does not name a commit/],
      [["git:HEAD:../x"], /may not contain "\.\."/],
      [["git:-x:plugins/plug"], /may not start with "-"/],
    ];
    for (const [args, re] of cases) {
      const r = corpusOnly(root, ...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.body.error?.message, args.join(" ")).toMatch(re);
    }
  });

  it("refuses a commit whose files use a git filter (e.g. LFS) and one with a symlink out of the snapshot", () => {
    const lfs = repo({ "plugins/plug/.gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" });
    const a = corpusOnly(lfs, "git:HEAD:plugins/plug/skills/ms");
    expect(a.code).toBe(2);
    expect(a.body.error?.message).toMatch(/sets a git filter/);

    const root = repo();
    symlinkSync("../../../../../outside.md", join(root, "plugins/plug/skills/ms/references/escape.md"));
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "link"], { cwd: root });
    const b = corpusOnly(root, "git:HEAD:plugins/plug/skills/ms");
    expect(b.code).toBe(2);
    expect(b.body.error?.message).toMatch(/symlink that points outside/);
  });

  it("a kept snapshot lives beside the runs root, never inside it", async () => {
    const { critiqueSnapshotsRoot, stageGitTarget } = await import("../src/critique/git-target.js");
    const root = repo();
    const home = mkdtempSync(join(tmpdir(), "cwh-crit-git-home-"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const staged = stageGitTarget("git:HEAD:plugins/plug/skills/ms", undefined, { keep: true, cwd: root });
      expect(staged.skillFolder.startsWith(critiqueSnapshotsRoot())).toBe(true);
      expect(staged.skillSelector).toBe("ms");
      expect(readdirSync(critiqueSnapshotsRoot())[0]).toMatch(/^crit-snap-/);
    } finally {
      process.env.HOME = prev;
    }
  });
});

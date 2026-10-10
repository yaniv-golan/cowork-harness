// corpusHash / packagedCorpusHash / skillTreeHash, driven through the real packager (`packageEvidence`) over real
// plugin trees — the pre-spend preview path (`preflightCritique`) and the graded path (a run dir with a turn-1
// result) — never over a hand-built manifest.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { resolveCritiquedSkillDir, preflightCritique, corpusReportFields } from "../src/critique/command.js";
import { packageEvidence } from "../src/critique/package-evidence.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";

const PLUGIN = {
  ".claude-plugin/plugin.json": '{"name": "plug"}',
  "skills/ms/SKILL.md": '# ms\nSee `plug/references/shared.md`. Dispatch subagent_type: "plug:helper".\n',
  "skills/ms/references/local.md": "LOCAL REFERENCE\n",
  "skills/ms/scripts/run.py": "print('v1')\n",
  "agents/helper.md": "---\nname: helper\n---\nHELPER BODY\n",
  "references/shared.md": "SHARED-ROOT-BODY\n",
  "references/rootonly.md": "READ-ONLY-BY-AGENT\n",
};

function tree(files: Record<string, string>, opts: { git?: boolean; dirName?: string } = {}): string {
  const base = mkdtempSync(join(tmpdir(), "cwh-corpushash-"));
  const root = join(base, opts.dirName ?? "plugin");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.git !== false) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
  }
  return root;
}

/** The pre-spend packaging, exactly as `critique --corpus-only` and a paid critique's preflight run it. */
function preview(root: string) {
  const r = preflightCritique(resolveCritiquedSkillDir(root, "ms"), "preview");
  if (!r.ok) throw new Error(r.message);
  return r.pkg.corpusDigest;
}

/** The graded packaging: a run dir whose turn-1 result records what the agent read. */
function graded(root: string, accessed: Array<{ path: string; via: string[] }> = []) {
  const r = resolveCritiquedSkillDir(root, "ms");
  const outDir = mkdtempSync(join(tmpdir(), "cwh-corpushash-out-"));
  mkdirSync(join(outDir, "turns", "1"), { recursive: true });
  writeFileSync(
    join(outDir, "turns", "1", "result.json"),
    JSON.stringify({ finalMessage: "ok", referencesRead: [], referencesAccessed: accessed }),
  );
  return packageEvidence(outDir, snapshotTurnBoundary(outDir), r.skillDir, true, {
    agents: r.agents,
    pluginRoot: r.pluginRoot,
    mountRoot: r.mountRoot,
  }).corpusDigest;
}

describe("corpus hashes", () => {
  it("the preview and a graded run with no extra reads agree on all three hashes", () => {
    const root = tree(PLUGIN);
    const p = preview(root);
    const g = graded(root);
    expect(p.corpusHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect([g.corpusHash, g.packagedCorpusHash, g.skillTreeHash]).toEqual([p.corpusHash, p.packagedCorpusHash, p.skillTreeHash]);
    expect(p.hashBasis).toBe("git-tracked");
    expect(p.corpusManifest.map((e) => `${e.origin} ${e.key}`).sort()).toEqual([
      "agent agents/helper.md",
      "reference skills/ms/references/local.md",
      "root_ref_linked references/shared.md",
      "skill_md skills/ms/SKILL.md",
    ]);
  });

  it("a plugin-root file the agent READ moves packagedCorpusHash only", () => {
    const root = tree(PLUGIN);
    const p = preview(root);
    const g = graded(root, [{ path: "references/rootonly.md", via: ["read"] }]);
    expect(g.corpusManifest.some((e) => e.origin === "root_ref_read" && e.key === "references/rootonly.md")).toBe(true);
    expect(g.corpusHash).toBe(p.corpusHash);
    expect(g.skillTreeHash).toBe(p.skillTreeHash);
    expect(g.packagedCorpusHash).not.toBe(p.packagedCorpusHash);
  });

  it("editing a reference moves corpusHash and skillTreeHash; editing a script moves skillTreeHash only", () => {
    const root = tree(PLUGIN);
    const before = preview(root);
    writeFileSync(join(root, "skills/ms/scripts/run.py"), "print('v2')\n");
    const script = preview(root);
    expect(script.corpusHash).toBe(before.corpusHash);
    expect(script.skillTreeHash).not.toBe(before.skillTreeHash);
    writeFileSync(join(root, "skills/ms/references/local.md"), "LOCAL REFERENCE, edited\n");
    const ref = preview(root);
    expect(ref.corpusHash).not.toBe(script.corpusHash);
    expect(ref.skillTreeHash).not.toBe(script.skillTreeHash);
  });

  it("editing a resolved agent, or a linked plugin-root reference, moves corpusHash and skillTreeHash", () => {
    const root = tree(PLUGIN);
    const before = preview(root);
    writeFileSync(join(root, "agents/helper.md"), "---\nname: helper\n---\nHELPER BODY, edited\n");
    const agent = preview(root);
    expect(agent.corpusHash).not.toBe(before.corpusHash);
    expect(agent.skillTreeHash).not.toBe(before.skillTreeHash);
    writeFileSync(join(root, "references/shared.md"), "SHARED-ROOT-BODY, edited\n");
    const shared = preview(root);
    expect(shared.corpusHash).not.toBe(agent.corpusHash);
    expect(shared.skillTreeHash).not.toBe(agent.skillTreeHash);
  });

  it("an untracked file under the skill is listed, not hashed, and moves nothing", () => {
    const root = tree(PLUGIN);
    const before = preview(root);
    writeFileSync(join(root, "skills/ms/scripts/scratch.py"), "untracked\n");
    writeFileSync(join(root, "skills/ms/references/draft.md"), "untracked\n");
    const after = preview(root);
    expect([after.corpusHash, after.skillTreeHash]).toEqual([before.corpusHash, before.skillTreeHash]);
    expect(after.skillTreeUntracked).toEqual(["references/draft.md", "scripts/scratch.py"]);
  });

  it("outside a work tree every file is delivered and hashed (basis worktree-all)", () => {
    const root = tree(PLUGIN, { git: false });
    const before = preview(root);
    expect(before.hashBasis).toBe("worktree-all");
    writeFileSync(join(root, "skills/ms/scripts/new.py"), "x\n");
    const after = preview(root);
    expect(after.skillTreeHash).not.toBe(before.skillTreeHash);
    expect(after.skillTreeUntracked).toEqual([]);
  });

  it("a rename moves corpusHash (the path is part of the hash)", () => {
    const root = tree(PLUGIN, { git: false });
    const before = preview(root);
    renameSync(join(root, "skills/ms/references/local.md"), join(root, "skills/ms/references/renamed.md"));
    expect(preview(root).corpusHash).not.toBe(before.corpusHash);
  });

  it("the hashes do not depend on the plugin's directory name", () => {
    const a = preview(tree(PLUGIN, { dirName: "founder-skills" }));
    const b = preview(tree(PLUGIN, { dirName: "some-other-clone" }));
    expect([a.corpusHash, a.skillTreeHash, a.packagedCorpusHash]).toEqual([b.corpusHash, b.skillTreeHash, b.packagedCorpusHash]);
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable TRACKED reference is a manifest row and moves corpusHash", () => {
    const root = tree(PLUGIN);
    const before = preview(root);
    const f = join(root, "skills/ms/references/local.md");
    chmodSync(f, 0o000);
    try {
      const after = preview(root);
      expect(after.corpusManifest.find((e) => e.key === "skills/ms/references/local.md")).toEqual({
        origin: "reference",
        key: "skills/ms/references/local.md",
        status: "unreadable",
      });
      expect(after.corpusHash).not.toBe(before.corpusHash);
    } finally {
      chmodSync(f, 0o644);
    }
  });

  it("corpusDrift names the file that changed between the pre-spend check and the packaging", () => {
    const root = tree(PLUGIN);
    const pre = preview(root);
    writeFileSync(join(root, "skills/ms/references/local.md"), "edited during the run\n");
    const post = graded(root);
    const fields = corpusReportFields(pre, post);
    expect(fields.corpusHash).toBe(post.corpusHash);
    expect(fields.corpusDrift).toEqual({
      preflightCorpusHash: pre.corpusHash,
      preflightSkillTreeHash: pre.skillTreeHash,
      changed: ["skills/ms/references/local.md"],
    });
    expect(corpusReportFields(pre, graded(tree(PLUGIN), [{ path: "references/rootonly.md", via: ["read"] }])).corpusDrift).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});

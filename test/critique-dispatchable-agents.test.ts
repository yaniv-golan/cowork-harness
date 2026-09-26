import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { resolveDispatchableAgents } from "../src/critique/resolve-agents.js";
import { applyTargetPromotion, resolveCritiquedSkillDir, type ParsedArgs } from "../src/critique/command.js";
import { packageEvidence } from "../src/critique/package-evidence.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";

// `critique` mounts the WHOLE plugin root for the graded turn, but through 3.6.0 it packaged exactly one
// `agents/<skill>.md` into the evaluator corpus. A second skill-scoped agent therefore really ran while
// its authored body was structurally absent from the evidence — letting a critique report a guidance gap
// in an agent it never received. These cases pin the resolved set and the packaged sections.

interface Case {
  name: string;
  skill: string;
  tree: Record<string, string>;
  expected: string[];
}

function materialize(tree: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-agents-"));
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("resolveDispatchableAgents — shared cross-language fixture", () => {
  const fixture = JSON.parse(readFileSync(resolve("test/fixtures/dispatchable-agents.json"), "utf8")) as { cases: Case[] };

  // The expectations in the fixture are hand-written literals, deliberately. Deriving them by calling this
  // resolver would make the pin a tautology that passes while TS and Python disagree — the exact trap a
  // previous oracle-from-the-implementation test in this repo fell into.
  for (const c of fixture.cases) {
    it(c.name, () => {
      const root = materialize(c.tree);
      const got = resolveDispatchableAgents(root, join(root, "skills", c.skill), c.skill).map((a) => a.rel);
      expect(got).toEqual([...c.expected].sort());
    });
  }

  it("the fixture is non-trivial (a fixture that lost its cases must not read as a clean pass)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });
});

describe("resolveCritiquedSkillDir — agents across all four branches", () => {
  it("--skill <name> resolves a SECOND agent the skill dispatches (fails before the multi-agent corpus)", () => {
    const root = materialize({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": '# ms\nsubagent_type: "plug:ms-redteam"\n',
      "skills/other/SKILL.md": "# other\n",
      "agents/ms.md": "primary\n",
      "agents/ms-redteam.md": "red team persona\n",
    });
    const r = resolveCritiquedSkillDir(root, "ms");
    expect(r.agents.map((a) => a.rel)).toEqual(["agents/ms-redteam.md", "agents/ms.md"]);
    expect(r.pluginRoot).toBe(root);
  });

  it("a plain skill folder that is ALSO a plugin root resolves agents (it returned none at all before)", () => {
    const root = materialize({
      "plugin.json": '{"name": "solo"}',
      "SKILL.md": '# solo\nsubagent_type: "solo:helper"\n',
      "agents/helper.md": "helper prompt\n",
    });
    const r = resolveCritiquedSkillDir(root, undefined);
    expect(r.skillDir).toBe(root);
    expect(r.agents.map((a) => a.rel)).toEqual(["agents/helper.md"]);
  });

  it("a skill dir targeted DIRECTLY is promoted to its plugin and resolves the same agents as --skill", () => {
    // `critique <plugin>/skills/<name>` and `critique <plugin> --skill <name>` must describe the same corpus.
    // They agree because the first is PROMOTED to the second (same mount), not because the resolver walks
    // up from a skill-folder mount to package agents that mount never carries — which is what it did through
    // 3.9.0. Without promotion (the fallback shape), a skill folder resolves no agents: none are mounted.
    const root = materialize({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": '# ms\nsubagent_type: "plug:ms-redteam"\n',
      "agents/ms.md": "primary\n",
      "agents/ms-redteam.md": "red team\n",
    });
    const viaSelector = resolveCritiquedSkillDir(root, "ms");
    const promoted = applyTargetPromotion({ skillFolder: join(root, "skills", "ms"), skillSelector: undefined } as ParsedArgs);
    const viaSkillDir = resolveCritiquedSkillDir(promoted.skillFolder, promoted.skillSelector);
    expect(viaSkillDir.agents.map((a) => a.rel)).toEqual(["agents/ms-redteam.md", "agents/ms.md"]);
    expect(viaSkillDir.agents.map((a) => a.rel)).toEqual(viaSelector.agents.map((a) => a.rel));
    expect(viaSkillDir.pluginRoot).toBe(root);
    expect(viaSkillDir.mountRoot).toBe(root);

    const unpromoted = resolveCritiquedSkillDir(join(root, "skills", "ms"), undefined);
    expect(unpromoted.agents).toEqual([]);
    expect(unpromoted.pluginRoot).toBe(join(root, "skills", "ms"));
  });

  it("a dir with no SKILL.md anywhere resolves no agents", () => {
    const root = materialize({ "plugin.json": '{"name": "plug"}', "agents/stray.md": "x\n" });
    expect(resolveCritiquedSkillDir(root, undefined).agents).toEqual([]);
  });
});

describe("packageEvidence — one section and one corpus key per agent", () => {
  function pkg(root: string, skill: string) {
    const r = resolveCritiquedSkillDir(root, skill);
    const outDir = mkdtempSync(join(tmpdir(), "cwh-out-"));
    return packageEvidence(outDir, snapshotTurnBoundary(outDir), r.skillDir, true, {
      agents: r.agents,
      pluginRoot: r.pluginRoot,
      mountRoot: r.mountRoot,
    });
  }

  it("packages BOTH agent bodies, each keyed by its own path, with provenance in the title", () => {
    const root = materialize({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": '# ms\nsubagent_type: "plug:ms-redteam"\n',
      "agents/ms.md": "PRIMARY-AGENT-BODY\n",
      "agents/ms-redteam.md": "REDTEAM-AGENT-BODY\n",
    });
    const res = pkg(root, "ms");
    const rendered = res.sections.map((s) => `## ${s.title}\n${s.body}`).join("\n");
    expect(rendered).toContain("PRIMARY-AGENT-BODY");
    expect(rendered).toContain("REDTEAM-AGENT-BODY");
    // provenance: the red-team agent is in the corpus BECAUSE of a literal at SKILL.md line 2
    expect(rendered).toContain("in corpus via SKILL.md:2");
    expect(rendered).toContain("in corpus via skill-named");
    // per-file keys — the bare "agents" key could not name the file a ceiling cut removed
    expect(res.corpusPackaged).toContain("agents/ms.md");
    expect(res.corpusPackaged).toContain("agents/ms-redteam.md");
  });

  it("an agent whose declared name differs from its filename is packaged (was silently absent at N=1)", () => {
    const root = materialize({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\n",
      "agents/redteam.md": "---\nname: ms\n---\nDECLARED-NAME-BODY\n",
    });
    const res = pkg(root, "ms");
    expect(res.sections.map((s) => s.body).join("\n")).toContain("DECLARED-NAME-BODY");
    expect(res.corpusPackaged).toContain("agents/redteam.md");
  });
});

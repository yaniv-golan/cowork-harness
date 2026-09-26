import { describe, it, expect, afterAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { gitCpFilter } from "../src/run/skill-files.js";

// critique's corpus must be a subset of what staging mounts, and `critique <plugin>/skills/<name>` must be
// the same run as `critique <plugin> --skill <name>`. Black-box: every case spawns the CLI from SOURCE
// (`node_modules/.bin/tsx src/cli.ts`, not `dist/` — a stale build would test yesterday's code) with
// `--corpus-only`, which resolves the target and packages the corpus exactly as a paid run does, but mints
// no session and spawns no turn. This file deliberately imports NOTHING the change under test adds, so on
// an unfixed tree it fails assertion by assertion instead of at import.
const TSX = resolve("node_modules/.bin/tsx");
const CLI_SRC = resolve("src/cli.ts");

function critique(args: string[], cwd = tmpdir()): { code: number | null; stdout: string; stderr: string; json: any } {
  const r = spawnSync(TSX, [CLI_SRC, "critique", ...args, "--corpus-only", "--output-format", "json"], {
    encoding: "utf8",
    cwd,
  });
  let json: any = null;
  try {
    json = JSON.parse((r.stdout ?? "").trim());
  } catch {
    /* refusals print nothing on stdout */
  }
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", json };
}

function git(dir: string, ...a: string[]): void {
  execFileSync("git", a, { cwd: dir, stdio: "ignore" });
}
function gitInit(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
}

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

const SKILL_X =
  '---\nname: x\ndescription: d\n---\nDispatch subagent_type: "p:x". Read ${CLAUDE_PLUGIN_ROOT}/references/shared.md first.\n';

/** A plugin `p` whose skill `x` uses one agent and one shared reference, plus a sibling skill and one
 *  untracked file created AFTER `git add` — so the tracked-set filter is armed and has something to cut. */
function contributingPlugin(): string {
  const root = join(tmp("cwh-promo-"), "p");
  write(root, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
    "agents/x.md": "---\nname: x\ndescription: a\n---\nagent body\n",
    "references/shared.md": "shared\n",
    "skills/x/SKILL.md": SKILL_X,
    "skills/x/references/own.md": "own\n",
    "skills/y/SKILL.md": "---\nname: y\ndescription: d\n---\n# Y\n",
  });
  gitInit(root);
  git(root, "add", "-A");
  write(root, { "skills/x/references/untracked.md": "never delivered\n" });
  return root;
}

function nonContributingPlugin(): string {
  const root = join(tmp("cwh-promo-nc-"), "p");
  write(root, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
    "skills/x/SKILL.md": "---\nname: x\ndescription: d\n---\n# X, standalone\n",
    "skills/y/SKILL.md": "---\nname: y\ndescription: d\n---\n# Y\n",
  });
  gitInit(root);
  git(root, "add", "-A");
  return root;
}

/** Staging's own copy of a mount root: the real tree, filtered by the SAME tracked set staging uses. The
 *  realpath is taken once and used for BOTH source and filter — a symlink source makes cpSync throw or
 *  copy a link, and a realpath source with a link-path filter copies unfiltered (every relative path then
 *  starts with `..`, which the filter admits defensively). */
function stagedCopy(mountRoot: string): string {
  const real = realpathSync(mountRoot);
  const dest = join(tmp("cwh-promo-oracle-"), "copy");
  const filter = gitCpFilter(real);
  cpSync(real, dest, { recursive: true, ...(filter ? { filter } : {}) });
  return dest;
}

/** Every packaged corpus key must name a file inside staging's copy of the mount. Keys come in three
 *  spellings — skill-local (`SKILL.md`, `references/**`, relative to the graded skill dir), agents
 *  (`agents/**`, relative to the plugin root) and plugin-root references (`<pluginName>/references/**`).
 *  The plugin root IS the mount root (the invariant under test), so both plugin-relative classes resolve
 *  against it. A mapped path that escapes the copy is itself the failure: checking `existsSync` on it
 *  would test a file OUTSIDE the mount. */
function expectCorpusInsideMount(payload: any): void {
  const mount = resolve(payload.skillFolder);
  const copy = stagedCopy(mount);
  const skillRel = relative(mount, resolve(payload.skillDir));
  let pluginName = mount.split(sep).pop()!;
  for (const m of [join(mount, ".claude-plugin", "plugin.json"), join(mount, "plugin.json")])
    if (existsSync(m)) {
      pluginName = JSON.parse(readFileSync(m, "utf8")).name ?? pluginName;
      break;
    }
  for (const key of payload.corpus.corpusPackaged as string[]) {
    const mapped = key.startsWith("agents/")
      ? join(copy, key)
      : key.startsWith(`${pluginName}/references/`)
        ? join(copy, key.slice(pluginName.length + 1))
        : join(copy, skillRel, key);
    expect(relative(copy, mapped).startsWith(".."), `${key} maps outside the mount`).toBe(false);
    expect(existsSync(mapped), `${key} is packaged but staging does not deliver it`).toBe(true);
  }
}

describe("critique <plugin>/skills/<name> is promoted to critique <plugin> --skill <name>", () => {
  it("the two spellings measure the same corpus and the same graded skill, and the promotion is announced", () => {
    const p = contributingPlugin();
    const a = critique([join(p, "skills", "x")]);
    const b = critique([p, "--skill", "x"]);
    expect(b.code).toBe(0);
    expect(a.code).toBe(0);
    expect(a.json.corpus).toEqual(b.json.corpus);
    expect(b.json.skill).toBe("x");
    expect(a.json.skill).toBe("x");
    // Same mount: the promoted target IS the enclosing plugin.
    expect(resolve(a.json.skillFolder)).toBe(resolve(p));
    expect(resolve(a.json.skillDir)).toBe(resolve(b.json.skillDir));
    expect(a.stderr).toContain("mounting the plugin as Cowork does, grading skill 'x'");
    expect(b.stderr).not.toContain("mounting the plugin as Cowork does");
    expectCorpusInsideMount(a.json);
  });

  it("typed relative, both spellings report the same relative plugin and skill dir", () => {
    const p = contributingPlugin();
    const parent = join(p, "..");
    const a = critique([join("p", "skills", "x")], parent);
    const b = critique(["p", "--skill", "x"], parent);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.json.skillFolder).toBe(b.json.skillFolder);
    expect(a.json.skillDir).toBe(b.json.skillDir);
    expect(a.json.skillFolder).toBe("p");
    expect(a.json.corpus).toEqual(b.json.corpus);
  });

  it("promotes even when the enclosing plugin contributes nothing the skill uses", () => {
    const p = nonContributingPlugin();
    const a = critique([join(p, "skills", "x")]);
    expect(a.code).toBe(0);
    expect(resolve(a.json.skillFolder)).toBe(resolve(p));
    expect(a.json.skill).toBe("x");
    expect(a.stderr).toContain("mounting the plugin as Cowork does, grading skill 'x'");
  });
});

describe("when promotion is not admissible, critique mounts the skill folder alone and the corpus stays inside it", () => {
  it("a skill outside skills/<name> (here tools/x) is not addressable by --skill", () => {
    const p = contributingPlugin();
    write(p, { "tools/x/SKILL.md": SKILL_X });
    git(p, "add", "-A");
    const a = critique([join(p, "tools", "x")]);
    expect(a.code).toBe(0);
    expect(resolve(a.json.skillFolder)).toBe(resolve(p, "tools", "x"));
    expect(a.stderr).toContain("addresses only skills/");
    expect(a.stderr).toContain("mounting only this folder");
    expect(a.json.corpus.corpusPackaged).toEqual(["SKILL.md"]);
    expect(a.json.corpus.corpusExcluded).toEqual([]);
    expectCorpusInsideMount(a.json);
  });

  it("a skill that is a git submodule of its plugin: the plugin's index never descends into it", (ctx) => {
    const skillRepo = tmp("cwh-promo-subskill-");
    write(skillRepo, { "SKILL.md": SKILL_X, "references/local.md": "local\n" });
    gitInit(skillRepo);
    git(skillRepo, "add", "-A");
    git(skillRepo, "commit", "-qm", "seed");

    const root = join(tmp("cwh-promo-subroot-"), "p");
    write(root, {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
      "agents/x.md": "---\nname: x\ndescription: a\n---\nagent body\n",
      "references/shared.md": "shared\n",
    });
    gitInit(root);
    git(root, "add", "-A");
    try {
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", skillRepo, "skills/x"], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      ctx.skip(); // sandbox may refuse local-file submodules regardless of the protocol override
      return;
    }
    git(root, "commit", "-qm", "add submodule");

    // `--skill x` stays refused: the plugin's mount would carry an empty skills/x/.
    const viaSkill = critique([root, "--skill", "x"]);
    expect(viaSkill.code).toBe(2);
    expect(viaSkill.stderr).toContain("skills/x/ has 0 git-tracked files under");

    const a = critique([join(root, "skills", "x")]);
    expect(a.code).toBe(0);
    expect(resolve(a.json.skillFolder)).toBe(resolve(root, "skills", "x"));
    expect(a.stderr).toContain("has 0 git-tracked files under");
    expect(a.stderr).toContain("mounting only this folder");
    expect(a.json.corpus.corpusPackaged).toEqual(["SKILL.md", "references/local.md"]);
    expect(a.json.corpus.corpusExcluded).toEqual([]);
    expectCorpusInsideMount(a.json);
  });

  it("a positional whose case differs from the tracked path (case-insensitive filesystems only)", (ctx) => {
    const p = contributingPlugin();
    if (!existsSync(join(p, "skills", "X"))) {
      ctx.skip(); // case-sensitive filesystem: skills/X does not exist at all
      return;
    }
    const a = critique([join(p, "skills", "X")]);
    expect(a.code).toBe(0);
    expect(a.stderr).toContain("its case differs from the tracked path");
    expect(a.stderr).toContain("mounting only this folder");
    expect(a.stderr).not.toContain("mounting the plugin as Cowork does");
    expectCorpusInsideMount(a.json);
  });
});

describe("a skill folder that is its own plugin, and --skill on a skill folder", () => {
  it("a skill folder with its own manifest is mounted as its own plugin, and the notice says so", () => {
    const p = contributingPlugin();
    write(p, { "skills/x/.claude-plugin/plugin.json": JSON.stringify({ name: "x" }) });
    git(p, "add", "-A");
    const a = critique([join(p, "skills", "x")]);
    expect(a.code).toBe(0);
    expect(resolve(a.json.skillFolder)).toBe(resolve(p, "skills", "x"));
    expect(a.stderr).toContain("has its own plugin manifest");
    expect(a.stderr).toContain(`--skill x`);
    expectCorpusInsideMount(a.json);
  });

  it("--skill on a positional that is itself a skill folder says to drop --skill or pass the plugin root", () => {
    const p = contributingPlugin();
    const a = critique([join(p, "skills", "x"), "--skill", "x"]);
    expect(a.code).toBe(2);
    expect(a.stderr).toContain("is itself a skill folder");
    expect(a.stderr).toContain(`--skill x`);
    expect(a.stderr).not.toContain("found at all");
  });
});

describe("staging-oracle: the corpus never names a file the mount does not carry", () => {
  it("plain skill folder", () => {
    const s = tmp("cwh-promo-plain-");
    write(s, { "SKILL.md": "---\nname: s\ndescription: d\n---\n# S\n", "references/r.md": "r\n" });
    gitInit(s);
    git(s, "add", "-A");
    write(s, { "references/untracked.md": "u\n" });
    const a = critique([s]);
    expect(a.code).toBe(0);
    expect(a.json.corpus.corpusExcluded).toEqual(["references/untracked.md"]);
    expectCorpusInsideMount(a.json);
  });

  it("--skill on a plugin inside a larger monorepo", () => {
    const mono = tmp("cwh-promo-mono-");
    const p = join(mono, "pkg", "p");
    write(p, {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
      "agents/x.md": "---\nname: x\ndescription: a\n---\nagent body\n",
      "references/shared.md": "shared\n",
      "skills/x/SKILL.md": SKILL_X,
    });
    gitInit(mono);
    git(mono, "add", "-A");
    const a = critique([p, "--skill", "x"]);
    expect(a.code).toBe(0);
    expect(a.json.corpus.corpusPackaged).toEqual(expect.arrayContaining(["SKILL.md", "agents/x.md"]));
    expectCorpusInsideMount(a.json);
  });

  it("the oracle copy is armed: it lacks a file created after git add", () => {
    const p = contributingPlugin();
    const copy = stagedCopy(p);
    expect(existsSync(join(copy, "skills", "x", "SKILL.md"))).toBe(true);
    expect(existsSync(join(copy, "skills", "x", "references", "untracked.md"))).toBe(false);
  });
});

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  applyTargetPromotion,
  buildTaskTurnArgs,
  buildReflectionTurnArgs,
  parseArgs,
  resolveCritiquedSkillDir,
} from "../src/critique/command.js";
import { packageEvidence } from "../src/critique/package-evidence.js";
import { hashSkillDirs } from "../src/run/skill-hash.js";
import { KNOWN_SECRET_KEYS } from "../src/secrets.js";

// Unit half of critique's mount rule (the CLI half, which imports nothing new so it can be observed failing
// on an unfixed tree, is `critique-mount-promotion.test.ts`).

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
function git(dir: string, ...a: string[]): void {
  execFileSync("git", a, { cwd: dir, stdio: "ignore" });
}
function gitInitAdd(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "add", "-A");
}
function plugin(): string {
  const root = join(tmp("cwh-promo-unit-"), "p");
  write(root, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "p" }),
    "agents/x.md": "---\nname: x\ndescription: a\n---\nagent body\n",
    "skills/x/SKILL.md": '---\nname: x\ndescription: d\n---\nsubagent_type: "p:x"\n',
    "skills/y/SKILL.md": "---\nname: y\ndescription: d\n---\n# Y\n",
  });
  gitInitAdd(root);
  return root;
}

describe("promotion makes the two spellings ONE run", () => {
  it("the promoted skill-folder spelling spawns exactly the turns `--skill` spawns (same mount, same resume identity)", () => {
    const p = plugin();
    const a = parseArgs([join(p, "skills", "x"), "--prompt", "probe"]);
    const b = parseArgs([p, "--skill", "x", "--prompt", "probe"]);
    // Different before promotion — so the equality below is the promotion's doing, not two equal inputs.
    expect(buildTaskTurnArgs(a, "sid")).not.toEqual(buildTaskTurnArgs(b, "sid"));
    const promoted = applyTargetPromotion(a);
    expect(promoted.skillFolder).toBe(resolve(p));
    expect(promoted.skillSelector).toBe("x");
    expect(buildTaskTurnArgs(promoted, "sid")).toEqual(buildTaskTurnArgs(b, "sid"));
    expect(buildReflectionTurnArgs(promoted, "sid")).toEqual(buildReflectionTurnArgs(b, "sid"));
  });

  it("the skill-folder spelling's skillHash changes: it now hashes the whole plugin, as --skill always did", () => {
    // `skill <folder>` builds a scenario with no `skills:` scope, so its fingerprint hashes every mounted
    // plugin dir whole. Promotion changes that dir from skills/x to the plugin.
    const p = plugin();
    expect(hashSkillDirs([resolve(p)]).hash).not.toBe(hashSkillDirs([resolve(p, "skills", "x")]).hash);
  });

  it("a spelling with a trailing '.' still names the skill, not '.'", () => {
    const p = plugin();
    const promoted = applyTargetPromotion(parseArgs([join(p, "skills", "x") + "/.", "--prompt", "probe"]));
    expect(promoted.skillSelector).toBe("x");
  });
});

describe("packageEvidence refuses a plugin root or skill dir outside the mount", () => {
  it("throws when pluginRoot lies outside mountRoot (the resolver never produces this; a caller that did would grade unmounted files)", () => {
    const p = plugin();
    const skillDir = join(p, "skills", "x");
    const run = tmp("cwh-promo-run-");
    const agents = resolveCritiquedSkillDir(p, "x").agents;
    expect(() =>
      packageEvidence(run, { events: { size: 0 }, timeline: { size: 0 } }, skillDir, false, { mountRoot: skillDir, pluginRoot: p, agents }),
    ).toThrow(/is not inside mountRoot/);
    expect(() => packageEvidence(run, { events: { size: 0 }, timeline: { size: 0 } }, p, false, { mountRoot: skillDir })).toThrow(
      /is not inside mountRoot/,
    );
  });
});

// ---- pre-spend refusals ------------------------------------------------------------------------------
// A paid critique must refuse, BEFORE spending, every target `--corpus-only` refuses. There is no $0 way to
// run the live path on an unfixed tree (critique rejects --dry-run; the task turn is a self-spawn with no
// seam), so (b) pins the ORDER in source first, and (a) runs only when (b) holds — a mis-wired check can
// then never spend under the suite. Anchors are CALL sites (a definition sits above `main` and would pass
// vacuously), each must occur exactly once.
// Line comments are stripped first: a commented-out call (`// opts = applyTargetPromotion(opts);`) must
// not satisfy the pin while the live path skips it.
const SRC = readFileSync(resolve("src/critique/command.ts"), "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");
const PROMO = "opts = applyTargetPromotion(opts)";
const RESOLVE = "resolveCritiquedSkillDir(opts.skillFolder, opts.skillSelector)";
const PRE = "= preflightCritique(resolvedSkill";
const UUID = "randomUUID()";
const TASK = "buildTaskTurnArgs(opts, sessionId)";
const once = (a: string) => SRC.indexOf(a) > -1 && SRC.indexOf(a) === SRC.lastIndexOf(a);
const ordered =
  [PROMO, RESOLVE, PRE, UUID, TASK].every(once) &&
  SRC.indexOf(PROMO) < SRC.indexOf(RESOLVE) &&
  SRC.indexOf(RESOLVE) < SRC.indexOf(PRE) &&
  SRC.indexOf(PRE) < SRC.indexOf(UUID) &&
  SRC.indexOf(UUID) < SRC.indexOf(TASK);

describe("pre-spend check", () => {
  it("(b) main promotes, resolves, and checks BEFORE a session is minted or a turn is spawned", () => {
    for (const a of [PROMO, RESOLVE, PRE, UUID, TASK]) expect(once(a), a).toBe(true);
    expect(ordered).toBe(true);
  });

  // Spawned from SOURCE (a stale dist/ would test old code) with every credential key set to "" — never
  // deleted: the CLI auto-loads the cwd and install-root .env and fills only keys that are undefined.
  const TSX = resolve("node_modules/.bin/tsx");
  const CLI_SRC = resolve("src/cli.ts");
  // Second belt, should (b) ever be satisfied while a refusal is not wired: no credential reaches a turn. Env
  // keys are blanked (never deleted — the CLI refills undefined keys from .env), and CLAUDE_CONFIG_DIR is an
  // empty dir, so a host tier cannot pick up a Keychain / config-dir login either.
  const env = {
    ...process.env,
    ...Object.fromEntries(KNOWN_SECRET_KEYS.map((k) => [k, ""])),
    CLAUDE_CONFIG_DIR: tmp("cwh-pre-noauth-"),
  };
  const live = (args: string[]) => {
    const r = spawnSync(TSX, [CLI_SRC, "critique", ...args, "--prompt", "x"], { encoding: "utf8", cwd: tmpdir(), env, timeout: 60_000 });
    return { code: r.status, stderr: r.stderr ?? "" };
  };

  it.skipIf(!ordered)("(a) --skill whose folder has a tracked reference but an untracked SKILL.md", () => {
    const q = join(tmp("cwh-pre-"), "q");
    write(q, { ".claude-plugin/plugin.json": '{"name":"q"}', "skills/a/SKILL.md": "# a\n", "skills/b/references/r.md": "r\n" });
    gitInitAdd(q);
    write(q, { "skills/b/SKILL.md": "# b\n" });
    const r = live([q, "--skill", "b"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("critique: no readable SKILL.md at");
    expect(r.stderr).toContain("(untracked)");
  });

  it.skipIf(!ordered)("(a) a plain skill folder whose SKILL.md is untracked", () => {
    const s = tmp("cwh-pre-plain-");
    write(s, { "references/r.md": "r\n" });
    gitInitAdd(s);
    write(s, { "SKILL.md": "# s\n" });
    const r = live([s]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("(untracked)");
  });

  it.skipIf(!ordered)("(a) a folder with no SKILL.md at all", () => {
    const s = tmp("cwh-pre-none-");
    write(s, { "README.md": "not a skill\n" });
    gitInitAdd(s);
    const r = live([s]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("(missing)");
  });

  it.skipIf(!ordered)("(a) a --skill subdirectory with nothing tracked under it", () => {
    const q = join(tmp("cwh-pre-sub-"), "q");
    write(q, { ".claude-plugin/plugin.json": '{"name":"q"}', "skills/a/SKILL.md": "# a\n" });
    gitInitAdd(q);
    write(q, { "skills/b/SKILL.md": "# b\n" });
    const r = live([q, "--skill", "b"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("critique: skills/b/ has 0 git-tracked files under");
  });
});

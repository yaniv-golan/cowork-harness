import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { packageEvidence } from "../src/critique/package-evidence.js";

// `critique --corpus-only`: pins the packager's answer for a skill with NO turn run (no session, no
// spend). Black-box CLI spawns of dist/cli.js, mirroring test/cli-arg-guards.test.ts's pattern — but
// `run()` here keeps stdout/stderr SEPARATE (cli-arg-guards concatenates them) because several cases need
// to JSON.parse stdout cleanly while asserting on a distinct stderr message.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(dir: string, ...a: string[]): void {
  execFileSync("git", a, { cwd: dir, stdio: "ignore" });
}

/** `git init` + identity + `git add -A` over whatever's on disk NOW. No commit: `git ls-files` (what
 *  `gitTrackedSet` reads) sees the INDEX, not HEAD, so staging alone is enough to arm the tracked-file
 *  filter — the whole point of every fixture below except the submodule one, which needs a real commit to
 *  be `submodule add`-able. */
function gitInitAdd(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "add", "-A");
}

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** The MULTI-SKILL, MULTI-CHANNEL fixture for tests 1+2. Every corpus-selection rule the packager has gets
 *  exercised at once: a skill-local reference (auto-included, no linking needed), a plugin-root reference
 *  reached via `${CLAUDE_PLUGIN_ROOT}/references/…` (needs a link), a plugin-root reference NEVER linked
 *  (omitted), a dispatched sub-agent reached by filename (`agents/alpha.md`, skill-named) and one reached
 *  only via a pinned `subagent_type:` literal (`agents/helper.md`), and an untracked file created AFTER
 *  `git add` so the git-tracked filter has something real to exclude (an unarmed tmpdir — no commits/adds
 *  — has an EMPTY tracked set, and `corpusAcceptFor` then accepts everything: an unarmed fixture proves
 *  nothing about the filter). */
function makeArmedFixture(): string {
  const root = tmp("cwh-corpus-armed-");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fx" }));
  mkdirSync(join(root, "skills", "alpha", "references"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "references"), { recursive: true });

  writeFileSync(
    join(root, "skills", "alpha", "SKILL.md"),
    [
      "---",
      "name: alpha",
      "---",
      "# Alpha",
      "",
      "See ${CLAUDE_PLUGIN_ROOT}/references/shared.md for background shared across the plugin.",
      "Binary rule pack: ${CLAUDE_PLUGIN_ROOT}/references/binary.md (linked, but not text).",
      "",
      'Dispatch subagent_type: "fx:helper" for specialized work.',
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "skills", "alpha", "references", "local.md"), "Local reference content.\n");
  writeFileSync(join(root, "agents", "alpha.md"), "---\nname: alpha\n---\n# Alpha sub-agent\nDoes alpha work.\n");
  writeFileSync(join(root, "agents", "helper.md"), "---\nname: helper\n---\n# Helper sub-agent\nAssists alpha.\n");
  writeFileSync(join(root, "references", "shared.md"), "# Shared\nContent shared across skills.\n");
  writeFileSync(join(root, "references", "unlinked.md"), "# Unlinked\nNever linked from anywhere.\n");
  // A LINKED plugin-root reference that is not clean UTF-8: the root tree applies a strict-decode rule the
  // skill-local tree does not (a local file is counted lossily; a root file is OMITTED `not-utf8`). Linked on
  // purpose so the only rule that can drop it is the UTF-8 one.
  writeFileSync(join(root, "references", "binary.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  // Invalid UTF-8 (a lone 0xFF start byte). readFileSync(..., "utf8") never throws on this — it decodes
  // lossily (replacement char) — so this file still ships; the packager counts it at ITS DECODED length,
  // same as the test's hand sum below, so the two agree regardless of the exact decode behavior.
  writeFileSync(join(root, "skills", "alpha", "references", "latin1.md"), Buffer.from([0xff]));

  gitInitAdd(root);
  // Created AFTER `git add` — stays untracked. This is the one file the git filter must exclude.
  writeFileSync(join(root, "skills", "alpha", "references", "untracked.md"), "Untracked content.\n");
  return root;
}

/** A small single-skill (plugin-root SKILL.md) fixture, git-tracked, for the tests that don't care about
 *  multi-skill/agent/root-reference selection — just that `--corpus-only` runs and reports SOMETHING. */
function makeSimpleFixture(): string {
  const root = tmp("cwh-corpus-simple-");
  writeFileSync(join(root, "SKILL.md"), "---\nname: simple\n---\n# Simple\nA small skill for corpus-only tests.\n");
  mkdirSync(join(root, "references"), { recursive: true });
  writeFileSync(join(root, "references", "r1.md"), "Reference one.\n");
  gitInitAdd(root);
  return root;
}

function makeMultiSkillFixture(): string {
  const root = tmp("cwh-corpus-multiskill-");
  for (const name of ["a", "b"]) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
  }
  return root; // the refusal fires before any git check — no repo needed
}

/** A tracked plugin root whose `skills/b/` was created AFTER `git add`: staging mounts the plugin WITHOUT
 *  it and succeeds, so the mount-root zero-tracked check passes — while the packager's per-skill-dir
 *  tracked set is EMPTY and its "empty is staging's hard-fail, not ours" branch walks raw. Previewed as
 *  measured, exit 0, `corpusExcluded: []` before the guard existed: a false green on the single most likely
 *  thing a consumer pre-checks (a brand-new skill). */
function makeUntrackedSkillDirFixture(): string {
  const root = tmp("cwh-corpus-untracked-skill-");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fx" }));
  mkdirSync(join(root, "skills", "a"), { recursive: true });
  writeFileSync(join(root, "skills", "a", "SKILL.md"), "---\nname: a\n---\n# A\n");
  gitInitAdd(root);
  mkdirSync(join(root, "skills", "b"), { recursive: true });
  writeFileSync(join(root, "skills", "b", "SKILL.md"), "---\nname: b\n---\n# B\nBrand new, never added.\n");
  return root;
}

function makeZeroTrackedFixture(): string {
  const root = tmp("cwh-corpus-zerotrack-");
  writeFileSync(join(root, "SKILL.md"), "# untracked skill\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  // deliberately no `git add` — 0 tracked files
  return root;
}

function makeOverCeilingFixture(): string {
  const root = tmp("cwh-corpus-huge-");
  writeFileSync(join(root, "SKILL.md"), "---\nname: huge\n---\n# Huge\nSee references/big.md.\n");
  mkdirSync(join(root, "references"), { recursive: true });
  // > SKILL_CORPUS_CEILING (512 KiB) on its own, so the combined corpus breaches the ceiling.
  writeFileSync(join(root, "references", "big.md"), "a".repeat(600_000));
  gitInitAdd(root);
  return root;
}

let armedRoot: string;
let simpleRoot: string;
let multiSkillRoot: string;
let zeroTrackedRoot: string;
let untrackedSkillRoot: string;
let noSkillRoot: string;
let overCeilingRoot: string;

describe.skipIf(!can)("critique --corpus-only", () => {
  beforeAll(() => {
    armedRoot = makeArmedFixture();
    simpleRoot = makeSimpleFixture();
    multiSkillRoot = makeMultiSkillFixture();
    zeroTrackedRoot = makeZeroTrackedFixture();
    untrackedSkillRoot = makeUntrackedSkillDirFixture();
    noSkillRoot = tmp("cwh-corpus-nomd-"); // empty; not a git repo; no SKILL.md anywhere
    overCeilingRoot = makeOverCeilingFixture();
  });

  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("packages the ARMED filter set exactly, and sums bytes by the packager's own formula", () => {
    const out = run(["critique", armedRoot, "--skill", "alpha", "--corpus-only", "--output-format", "json"], armedRoot);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout.trim());
    expect(parsed.tool).toBe("cowork-harness");
    expect(parsed.command).toBe("critique");
    expect(parsed.mode).toBe("corpus-only");
    expect(parsed.ok).toBe(true);

    // Keys verified by reading package-evidence.ts's own display-key convention (not derived from the
    // output under test): "SKILL.md" verbatim, skill-local references as "references/<name>", a
    // skill-named agent and a subagent_type-dispatched agent both as "agents/<file>", and the ONE root
    // reference the SKILL.md text actually links (via `${CLAUDE_PLUGIN_ROOT}/references/…`) as
    // "<pluginName>/references/<name>".
    const expectedPackaged = new Set([
      "SKILL.md",
      "references/local.md",
      "references/latin1.md",
      "agents/alpha.md",
      "agents/helper.md",
      "fx/references/shared.md",
    ]);
    expect(new Set(parsed.corpus.corpusPackaged)).toEqual(expectedPackaged);

    // SET SELECTION + FILTER ARMING, not an independent byte oracle: this is the packager's OWN formula
    // (decoded UTF-8 length of each packaged file), applied by hand to the same host paths.
    const files = [
      join(armedRoot, "skills", "alpha", "SKILL.md"),
      join(armedRoot, "skills", "alpha", "references", "local.md"),
      join(armedRoot, "skills", "alpha", "references", "latin1.md"),
      join(armedRoot, "agents", "alpha.md"),
      join(armedRoot, "agents", "helper.md"),
      join(armedRoot, "references", "shared.md"),
    ];
    const expectedBytes = files.reduce((sum, f) => sum + Buffer.byteLength(readFileSync(f, "utf8"), "utf8"), 0);
    expect(parsed.corpus.corpusBytes).toBe(expectedBytes);

    expect(parsed.corpus.corpusExcluded).toContain("references/untracked.md");

    const unlinked = parsed.corpus.corpusOmitted.find((o: { name: string }) => o.name === "fx/references/unlinked.md");
    expect(unlinked).toBeDefined();
    expect(unlinked.reason).toBe("not-linked");
    // The root tree's strict-UTF-8 rule, exercised: linked, tracked, and still not packaged.
    const binary = parsed.corpus.corpusOmitted.find((o: { name: string }) => o.name === "fx/references/binary.md");
    expect(binary).toBeDefined();
    expect(binary.reason).toBe("not-utf8");
    expect(parsed.corpus.corpusPackaged).not.toContain("fx/references/binary.md");
  });

  it("LIVE MUTATION: COWORK_HARNESS_GITSET=0 disarms the filter and the untracked file appears — proves test 1 can fail", () => {
    const out = run(["critique", armedRoot, "--skill", "alpha", "--corpus-only", "--output-format", "json"], armedRoot, {
      ...process.env,
      COWORK_HARNESS_GITSET: "0",
    });
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout.trim());
    expect(parsed.corpus.corpusPackaged).toContain("references/untracked.md");
    expect(parsed.corpus.corpusExcluded).toEqual([]);

    const untrackedBytes = Buffer.byteLength(
      readFileSync(join(armedRoot, "skills", "alpha", "references", "untracked.md"), "utf8"),
      "utf8",
    );
    const filtered = run(["critique", armedRoot, "--skill", "alpha", "--corpus-only", "--output-format", "json"], armedRoot);
    const filteredParsed = JSON.parse(filtered.stdout.trim());
    expect(parsed.corpus.corpusBytes).toBe(filteredParsed.corpus.corpusBytes + untrackedBytes);
  });

  it("SPEND GUARD: --run-dir stays empty — the preview exits before a session is minted", () => {
    const runDirRoot = tmp("cwh-corpus-rundir-");
    const before = readdirSync(runDirRoot);
    expect(before).toEqual([]);
    const out = run(["--run-dir", runDirRoot, "critique", simpleRoot, "--corpus-only"], simpleRoot);
    expect(out.code).toBe(0);
    expect(readdirSync(runDirRoot)).toEqual([]);
  });

  it("--corpus-only with no --prompt succeeds (the one line that may omit a probe)", () => {
    const out = run(["critique", simpleRoot, "--corpus-only"], simpleRoot);
    expect(out.code).toBe(0);
  });

  it("without --corpus-only, no prompt is still a usage error — the relaxation cannot widen", () => {
    const out = run(["critique", simpleRoot], simpleRoot);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain('--prompt "<probe>" or --prompt-file <path> is required');
  });

  it("multi-skill root with no --skill is refused before any spend, even under --corpus-only", () => {
    const out = run(["critique", multiSkillRoot, "--corpus-only"], multiSkillRoot);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("pass --skill");
  });

  it("0 git-tracked files is refused with staging's own message", () => {
    const out = run(["critique", zeroTrackedRoot, "--corpus-only"], zeroTrackedRoot);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("0 git-tracked files");
  });

  it("an untracked --skill subdirectory under a tracked root is refused in staging's terms, not measured", () => {
    const out = run(["critique", untrackedSkillRoot, "--skill", "b", "--corpus-only", "--output-format", "json"], untrackedSkillRoot);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("skills/b/ has 0 git-tracked files under");
    expect(out.stderr).toContain("WITHOUT this skill");
    expect(out.stdout.trim()).toBe("");
    // The tracked sibling is unaffected — the guard is per-subdirectory, not per-root.
    const ok = run(["critique", untrackedSkillRoot, "--skill", "a", "--corpus-only", "--output-format", "json"], untrackedSkillRoot);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout.trim()).corpus.corpusPackaged).toContain("SKILL.md");
  });

  it("--skill is a NAME: a path-shaped selector is refused, never resolved outside the mount", () => {
    // Before this, `--skill ../../outside` joined blindly, previewed a directory the mount can never contain,
    // and exited 0 — the guard's `..` branch was an explicit exemption for the one shape it cannot vouch
    // for. Refused in `resolveCritiquedSkillDir` (which the paid path shares), so both lines close at once.
    const outside = tmp("cwh-corpus-outside-");
    writeFileSync(join(outside, "SKILL.md"), "---\nname: o\n---\n# Outside\n");
    const rel = relative(join(untrackedSkillRoot, "skills"), outside);
    for (const sel of [rel, "a/../a", "a/", "."]) {
      const out = run(["critique", untrackedSkillRoot, "--skill", sel, "--corpus-only", "--output-format", "json"], untrackedSkillRoot);
      expect(out.code, `selector ${JSON.stringify(sel)}`).toBe(2);
      expect(out.stderr).toContain("must be a single path segment");
      expect(out.stdout.trim()).toBe("");
    }
  });

  it("run-shaping flags are still parsed and type-checked under --corpus-only (this pins parseArgs ORDER: the checks run before the preview branch, so the same line fails identically without the flag)", () => {
    // Two flags whose validation lives in parseArgs, before the preview branch: a missing --prompt-file
    // and a refused tier. "Not acted on" must never mean "not checked" — that is how a drop-in pre-check
    // would green a line the paid run then rejects.
    const pf = run(["critique", simpleRoot, "--prompt-file", join(simpleRoot, "nope.txt"), "--corpus-only"], simpleRoot);
    expect(pf.code).toBe(2);
    expect(pf.stderr).toContain("--prompt-file not found");
    const tier = run(["critique", simpleRoot, "--fidelity", "microvm", "--corpus-only"], simpleRoot);
    expect(tier.code).toBe(2);
    expect(tier.stderr).toContain("--fidelity microvm is refused");
  });

  it("no SKILL.md anywhere is refused as nothing to measure", () => {
    const out = run(["critique", noSkillRoot, "--corpus-only"], noSkillRoot);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("nothing to measure");
  });

  it("over-ceiling corpus: measured, not gated — cuts loudly, in the PREVIEW tense", () => {
    const out = run(["critique", overCeilingRoot, "--corpus-only", "--output-format", "json"], overCeilingRoot);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout.trim());
    expect(parsed.corpus.corpusCuts.length).toBeGreaterThan(0);
    expect(out.stderr).toContain("WOULD BE cut");
    expect(out.stderr).not.toContain("was cut before grading"); // that tense means a grading actually ran
  });

  it("ignoredFlags names every run-shaping flag validated but not acted on", () => {
    const uploadPath = join(simpleRoot, "SKILL.md"); // any existing file
    const out = run(
      ["critique", simpleRoot, "--prompt", "x", "--upload", uploadPath, "--model", "foo", "--corpus-only", "--output-format", "json"],
      simpleRoot,
    );
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout.trim());
    expect(parsed.ignoredFlags).toEqual(["--prompt", "--upload", "--model"]);
    expect(out.stderr).toContain("validated but not acted on");

    const clean = run(["critique", simpleRoot, "--corpus-only", "--output-format", "json"], simpleRoot);
    expect(JSON.parse(clean.stdout.trim()).ignoredFlags).toEqual([]);
  });

  it("--corpus-only=1 is refused — the flag takes no value", () => {
    const out = run(["critique", simpleRoot, "--corpus-only=1"], simpleRoot);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("takes no value");
  });

  it("text mode names the pre-run floor and the lower-bound caveat", () => {
    const out = run(["critique", simpleRoot, "--corpus-only"], simpleRoot);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("evidence corpus (pre-run FLOOR)");
    expect(out.stdout).toContain("lower bound");
  });

  it("--out writes the same object the JSON stdout carries", () => {
    const outDir = tmp("cwh-corpus-out-");
    const outPath = join(outDir, "preview.json");
    const out = run(["critique", simpleRoot, "--corpus-only", "--output-format", "json", "--out", outPath], simpleRoot);
    expect(out.code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(JSON.parse(out.stdout.trim()));
  });

  // SUBMODULE SKILL. Staging's `gitCpFilter(root)` walks the SUPERPROJECT's tracked set, where a submodule
  // is one gitlink entry and never its contents — so a real mount of the plugin carries an EMPTY
  // `skills/x/`. (1) The pre-spend check REFUSES `--skill x`, in staging's terms. (2) The packager, keyed on
  // the MOUNT root's tracked set, agrees: SKILL.md is not delivered, so it is not evidence. Before the
  // packager was keyed on the mount it read the submodule's OWN index and packaged SKILL.md anyway.
  it("submodule skill: the pre-spend check refuses it and the packager does not package it", (ctx) => {
    const skillRepo = tmp("cwh-corpus-subskill-");
    writeFileSync(join(skillRepo, "SKILL.md"), "---\nname: x\n---\n# X\n");
    gitInitAdd(skillRepo);
    git(skillRepo, "commit", "-qm", "seed");

    const root = tmp("cwh-corpus-subroot-");
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@t.t");
    git(root, "config", "user.name", "t");
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

    // (1) the preview refuses.
    const out = run(["critique", root, "--skill", "x", "--corpus-only", "--output-format", "json"], root);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("skills/x/ has 0 git-tracked files under");

    // (2) the packager, called the way a paid critique calls it for this mount, does not package SKILL.md.
    const runDir = tmp("cwh-corpus-subrun-");
    const pkg = packageEvidence(runDir, { events: { size: 0 }, timeline: { size: 0 } }, join(root, "skills", "x"), false, {
      agents: [],
      pluginRoot: root,
      mountRoot: root,
    });
    expect(pkg.skillMdStatus).toBe("untracked");
    expect(pkg.corpusPackaged).not.toContain("SKILL.md");
    expect(pkg.corpusExcluded).toContain("SKILL.md");
  });
});

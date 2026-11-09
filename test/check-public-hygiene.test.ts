import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { EXCLUDED_PATHS, INTERNAL_DOCS_DIR_ALLOWLIST, PUBLIC_PATTERNS, parseDiff } from "../scripts/check-public-hygiene.js";

const SCRIPT = resolve("scripts/check-public-hygiene.ts");
const TSX = resolve("node_modules/.bin/tsx");
const SAMPLES = JSON.parse(readFileSync(resolve("test/fixtures/public-hygiene/samples.json"), "utf8")) as Record<
  string,
  { positive: string[]; negative: string[] }
>;
const INTERNAL = "docs/" + "internal";
const SESSION_NAME = "cwh" + "-77";
const SENTINEL = "zqxsentinelprivate";
const T = 60_000;

const gitEnv = (home: string) => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

let work: string;
let home: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv(home) });
const write = (path: string, text: string | Buffer) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const commit = (message: string, files: Record<string, string | Buffer> = {}) => {
  for (const [p, t] of Object.entries(files)) write(p, t);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", message);
};
const privateFile = (text: string) => {
  mkdirSync(join(home, ".config", "cowork-harness"), { recursive: true });
  writeFileSync(join(home, ".config", "cowork-harness", "private-hygiene-patterns.txt"), text);
};
const fileArg = (name: string, text: string) => {
  const p = join(work, name);
  writeFileSync(p, text);
  return p;
};
const run = (args: string[], binDir?: string, cwd = repo) => {
  const env = gitEnv(home);
  if (binDir) env.PATH = `${binDir}:${env.PATH}`;
  const r = spawnSync(TSX, [SCRIPT, ...args], { cwd, encoding: "utf8", env });
  return { code: r.status, out: r.stdout + r.stderr };
};
const range = ["--base", "main", "--head", "HEAD"];
const stubGh = (body: string, exit = 0) => {
  const dir = join(work, "bin");
  mkdirSync(dir, { recursive: true });
  const payload = join(dir, "payload");
  writeFileSync(payload, body);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\ncat '${payload}'\nexit ${exit}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
};

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "hygiene-"));
  home = join(work, "home");
  repo = join(work, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  commit("start", { "README.md": "start\n" });
  git("checkout", "-q", "-b", "feature");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("the public patterns", () => {
  it("each has samples, and the samples are all it needs to fail closed", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(PUBLIC_PATTERNS.map((p) => p.name).sort());
  });

  it.each(PUBLIC_PATTERNS.map((p) => p.name))(
    "%s: a known-positive in an added line is a finding, and nothing reports a known-negative",
    (name) => {
      for (const [i, sample] of SAMPLES[name]!.positive.entries()) commit(`p${i}`, { [`notes/p${i}.txt`]: `${sample}\n` });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      SAMPLES[name]!.positive.forEach((_, i) => expect(r.out).toContain(`notes/p${i}.txt:1: ${name}`));
    },
    T,
  );

  it.each(PUBLIC_PATTERNS.map((p) => p.name))(
    "%s: known-negatives alone are clean",
    (name) => {
      const hits = SAMPLES[name]!.negative.filter((s) => PUBLIC_PATTERNS.find((p) => p.name === name)!.re.test(s));
      expect(hits).toEqual([]);
    },
    T,
  );

  it("session names need a number: ordinary cwh- identifiers are not one", () => {
    const re = PUBLIC_PATTERNS.find((p) => p.name === "session name")!.re;
    expect(re.test("cwh" + "-device")).toBe(false);
    expect(re.test("cwh" + "-88")).toBe(true);
  });
});

describe("what is scanned", () => {
  it(
    "a clean branch over a main that leaked after the fork is clean: main's commits are not this branch's",
    () => {
      commit("clean change", { "a.txt": "fine\n" });
      git("checkout", "-q", "main");
      commit(`main later: ${SESSION_NAME} did this`, { "main.txt": `${SESSION_NAME}\n` });
      git("checkout", "-q", "feature");
      const r = run(range);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("checked 1 commits");
    },
    T,
  );

  it(
    "a line main deleted after the fork is not read as added here",
    () => {
      git("checkout", "-q", "main");
      commit("seed", { "old.txt": `${SESSION_NAME}\n` });
      git("branch", "-f", "feature", "HEAD");
      commit("main removes it", { "old.txt": "gone\n" });
      git("checkout", "-q", "feature");
      commit("clean change", { "a.txt": "fine\n" });
      const r = run(range);
      expect(r.code, r.out).toBe(0);
    },
    T,
  );

  it(
    "a merge commit's message is read, since it lands on main verbatim",
    () => {
      commit("clean", { "a.txt": "fine\n" });
      git("checkout", "-q", "main");
      commit("other", { "b.txt": "x\n" });
      git("checkout", "-q", "feature");
      git("merge", "-q", "--no-ff", "-m", `Merge main, per ${SESSION_NAME}`, "main");
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/commit [0-9a-f]{10} message:1: session name/);
    },
    T,
  );

  it(
    "commit messages, a moved file's lines and an added path are all read",
    () => {
      commit("clean", { "seed.txt": `${"x".repeat(5)}\n` });
      const base = git("rev-parse", "HEAD").trim();
      commit(`subject\n\nbody naming ${SESSION_NAME}`, { [`${SESSION_NAME}/a.txt`]: "fine\n" });
      const r = run(["--base", base, "--head", "HEAD"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/commit [0-9a-f]{10} message:3: session name/);
      expect(r.out).toContain("added path #1: session name");
      expect(r.out).not.toContain(`${SESSION_NAME}/a.txt`);
    },
    T,
  );

  it(
    "an added binary is named as not scanned, and is not a failure",
    () => {
      commit("binary", { "img/a b.bin": Buffer.from([0, 1, 2, 0, 3]) });
      const r = run(range);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("img/a b.bin: binary, not scanned");
    },
    T,
  );

  it(
    "reports a path with a space or a non-ASCII byte as it is",
    () => {
      const sample = SAMPLES["review label"]!.positive[0]!;
      commit("c", { "dir with space/café.txt": `${sample}\n` });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("dir with space/café.txt:1: review label");
    },
    T,
  );

  it(
    "the fixtures are excluded, and only by the listed paths",
    () => {
      const sample = SAMPLES["review label"]!.positive[0]!;
      commit("c", { "test/fixtures/public-hygiene/samples.json": `${sample}\n` });
      expect(run(range).code).toBe(0);
      commit("d", { "test/fixtures/public-hygiene/other.json": `${sample}\n` });
      expect(run(range).code).toBe(1);
    },
    T,
  );

  it("the exclusion list is exact and every entry exists", () => {
    expect([...EXCLUDED_PATHS]).toEqual(["test/fixtures/public-hygiene/samples.json"]);
    for (const p of EXCLUDED_PATHS) expect(existsSync(resolve(p)), p).toBe(true);
  });
});

describe("the internal docs rule", () => {
  it(
    "a citation of a file in the directory is a finding even in an allowlisted file; naming the directory there is not",
    () => {
      commit("dir", { "AGENTS.md": `the ${INTERNAL} folder\n` });
      expect(run(range).code).toBe(0);
      commit("citation", { "AGENTS.md": `the ${INTERNAL} folder\nsee ${INTERNAL}/plan.md\n` });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("AGENTS.md:2: internal doc citation");
    },
    T,
  );

  it(
    "naming the directory outside the allowlist is a finding",
    () => {
      commit("x", { "notes.md": `the ${INTERNAL} folder\n` });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("notes.md:1: internal docs directory");
    },
    T,
  );

  it("every allowlisted file exists and still names the directory, and the list has its expected length", () => {
    expect(INTERNAL_DOCS_DIR_ALLOWLIST).toHaveLength(9);
    for (const p of INTERNAL_DOCS_DIR_ALLOWLIST) {
      expect(existsSync(resolve(p)), p).toBe(true);
      expect(readFileSync(resolve(p), "utf8"), p).toContain(INTERNAL);
    }
  });
});

describe("stages and inputs", () => {
  const createArgs = (body: string, title: string, branch = "feature") => [
    "--stage",
    "create",
    ...range,
    "--body-file",
    fileArg("body", body),
    "--title-file",
    fileArg("title", title),
    "--branch",
    branch,
  ];
  const label = () => SAMPLES["review label"]!.positive[0]!;

  it(
    "create reads the range too: a clean body over a branch with a private hit in its lines is a finding",
    () => {
      privateFile(`${SENTINEL}\n`);
      commit("c", { "a.txt": `x ${SENTINEL} y\n` });
      const r = run([...createArgs("clean body\n", "clean title"), "--require-private"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("a.txt:1: private pattern");
    },
    T,
  );

  it(
    "create applies the full public set to the title, the body and the branch name",
    () => {
      commit("c", { "a.txt": "fine\n" });
      const r = run(createArgs(`a ${label()}\n`, `t ${label()}`, `x-${SESSION_NAME}-y`));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("title:1: review label");
      expect(r.out).toContain("body:1: review label");
      expect(r.out).toContain("branch name: session name");
    },
    T,
  );

  it(
    "an empty body is a finding at every stage that takes one",
    () => {
      commit("c", { "a.txt": "fine\n" });
      const created = run(createArgs("  \n", "t"));
      expect(created.code, created.out).toBe(1);
      expect(created.out).toContain("a pull request body is required");
      const noStage = run([...range, "--body-file", fileArg("body2", "")]);
      expect(noStage.code, noStage.out).toBe(1);
      const merged = run(
        ["--stage", "merge", "--pr", "7", ...range],
        stubGh(JSON.stringify({ title: "t", body: "", headRefName: "feature" })),
      );
      expect(merged.code, merged.out).toBe(1);
      expect(merged.out).toContain("a pull request body is required");
    },
    T,
  );

  it(
    "ready and merge read the live title, body and branch",
    () => {
      commit("c", { "a.txt": "fine\n" });
      const clean = run(
        ["--stage", "ready", "--pr", "7", ...range],
        stubGh(JSON.stringify({ title: "t", body: "b", headRefName: "feature" })),
      );
      expect(clean.code, clean.out).toBe(0);
      const leak = run(
        ["--stage", "merge", "--pr", "7", ...range],
        stubGh(JSON.stringify({ title: `a ${label()}`, body: `b ${label()}`, headRefName: `x-${SESSION_NAME}-y` })),
      );
      expect(leak.code, leak.out).toBe(1);
      for (const w of ["title:1: review label", "body:1: review label", "branch name: session name"]) expect(leak.out).toContain(w);
    },
    T,
  );

  it.each([
    ["a failing fetch", "", 1],
    ["an empty fetch", "", 0],
    ["a response without a body field", '{"title":"t","headRefName":"f"}', 0],
    ["a response that is not JSON", "nope", 0],
  ])(
    "%s exits 2, never clean",
    (_label, payload, exit) => {
      commit("c", { "a.txt": "fine\n" });
      const r = run(["--stage", "ready", "--pr", "7", ...range], stubGh(payload as string, exit as number));
      expect(r.code, r.out).toBe(2);
    },
    T,
  );

  it(
    "a bad ref, an empty range, a missing body file and unknown options each exit 2",
    () => {
      commit("c", { "a.txt": "fine\n" });
      expect(run(["--base", "nope", "--head", "HEAD"]).code).toBe(2);
      expect(run(["--base", "HEAD", "--head", "HEAD"]).code).toBe(2);
      expect(run([...range, "--body-file", join(work, "absent")]).code).toBe(2);
      expect(run([...range, "--nonsense", "x"]).code).toBe(2);
      expect(run(["main...HEAD"]).code).toBe(2);
    },
    T,
  );
});

describe("private patterns", () => {
  it(
    "--require-private exits 2 on a missing file, an empty one, and one with only comments and blanks",
    () => {
      commit("c", { "a.txt": "fine\n" });
      expect(run([...range, "--require-private"]).code).toBe(2);
      privateFile("");
      expect(run([...range, "--require-private"]).code).toBe(2);
      privateFile("# a comment\n\n   \r\n");
      expect(run([...range, "--require-private"]).code).toBe(2);
    },
    T,
  );

  it(
    "counts only real lines, and without --require-private reads nothing",
    () => {
      privateFile(`# comment\n\n${SENTINEL}\r\n  second one  \n`);
      commit("c", { "a.txt": `${SENTINEL}\n` });
      const required = run([...range, "--require-private"]);
      expect(required.out).toContain("private patterns: 2 loaded");
      expect(required.code).toBe(1);
      const plain = run(range);
      expect(plain.out).toContain("private patterns: 0 loaded");
      expect(plain.code).toBe(0);
    },
    T,
  );

  it(
    "a line is a fixed string: regex metacharacters match themselves, case-insensitively, and nothing else",
    () => {
      privateFile("a+(b.c\n");
      commit("c", { "a.txt": "aaab_c\n" });
      expect(run([...range, "--require-private"]).code).toBe(0);
      commit("d", { "b.txt": "x A+(B.C y\n" });
      const r = run([...range, "--require-private"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("b.txt:1: private pattern");
    },
    T,
  );

  it(
    "never prints the pattern or the text it matched, on any exit path",
    () => {
      privateFile(`${SENTINEL}\n`);
      commit(`message ${SENTINEL}`, {
        [`${SENTINEL}.txt`]: `line ${SENTINEL}\n`,
        "plain.txt": `${SAMPLES["review label"]!.positive[0]} ${SENTINEL}\n`,
      });
      const outputs = [
        run([...range, "--require-private"]),
        run(["--base", "nope", "--head", "HEAD", "--require-private"]),
        run([...range, "--require-private", "--body-file", join(work, "absent")]),
        run([
          "--stage",
          "create",
          ...range,
          "--require-private",
          "--body-file",
          fileArg("b", `${SENTINEL}\n`),
          "--title-file",
          fileArg("t", SENTINEL),
          "--branch",
          SENTINEL,
        ]),
      ];
      expect(outputs[0]!.code).toBe(1);
      expect(outputs[0]!.out).toContain("private pattern");
      expect(outputs[0]!.out).toContain("added path #");
      for (const o of outputs) expect(o.out).not.toContain(SENTINEL);
    },
    T,
  );
});

describe("the instrument", () => {
  it(
    "fails closed when a sample does not match, so a broken pattern cannot read as clean",
    () => {
      const copy = join(work, "copy");
      mkdirSync(join(copy, "scripts"), { recursive: true });
      mkdirSync(join(copy, "test", "fixtures", "public-hygiene"), { recursive: true });
      writeFileSync(join(copy, "scripts", "check-public-hygiene.ts"), readFileSync(SCRIPT));
      const broken = { ...SAMPLES, "review label": { positive: ["nothing here matches"], negative: ["x"] } };
      writeFileSync(join(copy, "test", "fixtures", "public-hygiene", "samples.json"), JSON.stringify(broken));
      commit("c", { "a.txt": "fine\n" });
      const r = spawnSync(TSX, [join(copy, "scripts", "check-public-hygiene.ts"), ...range], {
        cwd: repo,
        encoding: "utf8",
        env: gitEnv(home),
      });
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain("self-check: review label");
    },
    T,
  );

  it("does its matching in Node: nothing sends a pattern through git's regex engine", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/["'`]grep["'`]/);
    expect(source).not.toMatch(/(?:exec|spawn)[A-Za-z]*\([^)]*git grep/);
    // A `\b` that only Node's engine honours on every platform: if the pattern ran anywhere else on macOS it would miss.
    expect(PUBLIC_PATTERNS.find((p) => p.name === "register id")!.re.source).toContain("\\b");
  });

  it(
    "the script and these tests do not match themselves",
    () => {
      for (const f of [
        "scripts/check-public-hygiene.ts",
        "scripts/open-pr.sh",
        "test/check-public-hygiene.test.ts",
        "test/open-pr.test.ts",
      ]) {
        write(f, readFileSync(resolve(f)));
      }
      commit("self");
      const r = run(range);
      expect(r.out).toContain("0 findings");
      expect(r.code, r.out).toBe(0);
    },
    T,
  );

  it("stays runnable with type stripping and no install: erasable syntax, node: imports only", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => !i.startsWith("node:"))).toEqual([]);
    expect(source).not.toMatch(/^\s*(?:export\s+)?(?:const\s+)?enum\s/m);
    expect(source).not.toMatch(/^\s*(?:export\s+)?namespace\s/m);
    expect(source).not.toMatch(/constructor\([^)]*\b(?:public|private|protected|readonly)\s/);
  });

  it("is not shipped to consumers", () => {
    const files = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { files: string[] }).files;
    for (const f of ["scripts/check-public-hygiene.ts", "scripts/open-pr.sh", "scripts/test-linux.sh", "scripts/ci/test-linux-inner.sh"]) {
      expect(files, f).toContain(`!${f}`);
    }
  });
});

describe("what the published history holds", () => {
  const label = () => SAMPLES["review label"]!.positive[0]!;

  it(
    "a line added in one commit and removed in a later one is a finding: every commit is public",
    () => {
      commit("add", { "secret.txt": `${label()}\n` });
      const sha = git("rev-parse", "--short=10", "HEAD").trim();
      commit("remove", { "secret.txt": "clean\n" });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`commit ${sha} secret.txt:1: review label`);
    },
    T,
  );

  it(
    "a leaking path that a later commit removes is a finding, by number",
    () => {
      commit("add", { [`${SESSION_NAME}/a.txt`]: "fine\n" });
      git("rm", "-q", "-r", SESSION_NAME);
      commit("remove", { "b.txt": "fine\n" });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toMatch(/added path #\d+: session name/);
      expect(r.out).not.toContain(`${SESSION_NAME}/a.txt`);
    },
    T,
  );

  it(
    "a line added only while resolving a merge conflict, and removed by the next commit, is a finding",
    () => {
      commit("feature side", { "f.txt": "feature\n" });
      git("checkout", "-q", "main");
      commit("main side", { "f.txt": "main\n" });
      git("checkout", "-q", "-");
      expect(spawnSync("git", ["merge", "-q", "--no-edit", "main"], { cwd: repo, env: gitEnv(home) }).status).toBe(1);
      write("f.txt", `${label()}\n`);
      git("add", "f.txt");
      git("commit", "-q", "--no-edit");
      const sha = git("rev-parse", "--short=10", "HEAD").trim();
      commit("drop it", { "f.txt": "resolved\n" });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`commit ${sha} f.txt:1: review label`);
    },
    T,
  );

  it(
    "a conflict resolved by keeping main's own line does not read that line as this branch's",
    () => {
      commit("feature side", { "f.txt": "feature\n" });
      git("checkout", "-q", "main");
      commit("main side", { "f.txt": `${label()}\n` });
      git("checkout", "-q", "-");
      expect(spawnSync("git", ["merge", "-q", "--no-edit", "main"], { cwd: repo, env: gitEnv(home) }).status).toBe(1);
      write("f.txt", `${label()}\n`);
      git("add", "f.txt");
      git("commit", "-q", "--no-edit");
      const r = run(range);
      expect(r.code, r.out).toBe(0);
    },
    T,
  );

  it(
    "an attribute on a path is read from the repository's top, when the check runs from a subdirectory",
    () => {
      commit("force", { ".gitattributes": "docs/secret.txt -diff\n", "docs/secret.txt": `${label()}\n` });
      const r = run(range, undefined, join(repo, "docs"));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("docs/secret.txt: binary by attribute, not scanned");
    },
    T,
  );

  it(
    "the private patterns still read the file the public ones skip",
    () => {
      privateFile(`${SENTINEL}\n`);
      commit("c", { "test/fixtures/public-hygiene/samples.json": `${SENTINEL}\n` });
      const r = run([...range, "--require-private"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("test/fixtures/public-hygiene/samples.json:1: private pattern");
      expect(r.out).not.toContain(SENTINEL);
    },
    T,
  );

  it(
    "a text file that an attribute forces to binary is a finding",
    () => {
      commit("force", { ".gitattributes": "*.txt -diff\n", "secret.txt": `${label()}\n` });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("secret.txt: binary by attribute, not scanned");
    },
    T,
  );

  it(
    "an attribute added later cannot hide what an earlier commit published",
    () => {
      commit("add", { "secret.txt": `${label()}\n` });
      const sha = git("rev-parse", "--short=10", "HEAD").trim();
      git("rm", "-q", "secret.txt");
      commit("drop it and force binary", { ".gitattributes": "*.txt -diff\n" });
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`commit ${sha} secret.txt: binary by attribute, not scanned`);
    },
    T,
  );

  it(
    "a repo-level diff.interHunkContext does not change what is read",
    () => {
      git("checkout", "-q", "main");
      commit("lines", { "f.txt": "1\n2\n3\n4\n5\n" });
      git("branch", "-f", "feature", "HEAD");
      git("checkout", "-q", "feature");
      git("config", "diff.interHunkContext", "5");
      commit("two near edits", { "f.txt": "one\n2\n3\n4\nfive\n" });
      const r = run(range);
      expect(r.code, r.out).toBe(0);
    },
    T,
  );

  it(
    "a renamed file's lines are read",
    () => {
      git("checkout", "-q", "main");
      commit("old leak", { "old.txt": `${label()}\n` });
      git("branch", "-f", "feature", "HEAD");
      git("checkout", "-q", "feature");
      git("mv", "old.txt", "new.txt");
      commit("rename");
      const r = run(range);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("new.txt:1: review label");
    },
    T,
  );
});

describe("the private set reaches every input", () => {
  const createArgs = (body: string, title: string, branch: string) => [
    "--stage",
    "create",
    ...range,
    "--require-private",
    "--body-file",
    fileArg("body", body),
    "--title-file",
    fileArg("title", title),
    "--branch",
    branch,
  ];

  it(
    "a commit message, a body and a branch name each report a private hit, without the text",
    () => {
      privateFile(`${SENTINEL}\n`);
      commit(`subject ${SENTINEL}`, { "a.txt": "fine\n" });
      const inMessage = run([...range, "--require-private"]);
      expect(inMessage.code, inMessage.out).toBe(1);
      expect(inMessage.out).toMatch(/commit [0-9a-f]{10} message:1: private pattern/);
      commit("clean", { "b.txt": "fine\n" });
      git("reset", "-q", "--hard", "main");
      commit("clean", { "c.txt": "fine\n" });
      const inBody = run(createArgs(`x ${SENTINEL}\n`, "t", "feature"));
      expect(inBody.code, inBody.out).toBe(1);
      expect(inBody.out).toContain("body:1: private pattern");
      const inBranch = run(createArgs("b\n", "t", `x-${SENTINEL}`));
      expect(inBranch.code, inBranch.out).toBe(1);
      expect(inBranch.out).toContain("branch name: private pattern");
      for (const o of [inMessage, inBody, inBranch]) expect(o.out).not.toContain(SENTINEL);
    },
    T,
  );

  it(
    "a binary at a leaking path is named by number",
    () => {
      privateFile(`${SENTINEL}\n`);
      commit("c", { [`${SENTINEL}.bin`]: Buffer.from([0, 1, 2, 0, 3]) });
      const r = run([...range, "--require-private"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("added path #1: binary, not scanned");
      expect(r.out).not.toContain(SENTINEL);
    },
    T,
  );

  it(
    "a blank title is a finding, and a flag taken as an option's value is refused",
    () => {
      commit("c", { "a.txt": "fine\n" });
      const blank = run([
        "--stage",
        "create",
        ...range,
        "--body-file",
        fileArg("b", "b\n"),
        "--title-file",
        fileArg("t", "  \n"),
        "--branch",
        "f",
      ]);
      expect(blank.code, blank.out).toBe(1);
      expect(blank.out).toContain("a pull request title is required");
      expect(run([...range, "--branch", "--require-private"]).code).toBe(2);
    },
    T,
  );

  it(
    "fails closed when a pattern matches its known-negative sample",
    () => {
      const copy = join(work, "copy");
      mkdirSync(join(copy, "scripts"), { recursive: true });
      mkdirSync(join(copy, "test", "fixtures", "public-hygiene"), { recursive: true });
      writeFileSync(join(copy, "scripts", "check-public-hygiene.ts"), readFileSync(SCRIPT));
      const positive = SAMPLES["review label"]!.positive;
      writeFileSync(
        join(copy, "test", "fixtures", "public-hygiene", "samples.json"),
        JSON.stringify({ ...SAMPLES, "review label": { positive, negative: [positive[0]] } }),
      );
      commit("c", { "a.txt": "fine\n" });
      const r = spawnSync(TSX, [join(copy, "scripts", "check-public-hygiene.ts"), ...range], {
        cwd: repo,
        encoding: "utf8",
        env: gitEnv(home),
      });
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stderr).toContain("review label matched a known-negative");
    },
    T,
  );
});

describe("parseDiff", () => {
  it("treats an added line that looks like a file header as content", () => {
    const d = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+++ b/fake\n");
    expect(d.paths).toEqual(["x"]);
    expect(d.added.map((a) => [a.path, a.line, a.text])).toEqual([
      ["x", 1, "new"],
      ["x", 2, "++ b/fake"],
    ]);
  });

  it("reads a path git quoted, and the tab git adds after one with a space", () => {
    expect(parseDiff('diff --git a b\n+++ "b/a\\tb"\n').paths).toEqual(["a\tb"]);
    expect(parseDiff("diff --git a b\n+++ b/a b\t\n").paths).toEqual(["a b"]);
  });

  it("names added and changed binaries, and not deleted ones", () => {
    expect(parseDiff("Binary files /dev/null and b/a and b differ\n").binaries).toEqual(["a and b"]);
    expect(parseDiff("Binary files a/x y and b/x y differ\n").binaries).toEqual(["x y"]);
    expect(parseDiff("Binary files a/x and /dev/null differ\n").binaries).toEqual([]);
  });

  it("refuses a hunk it cannot read, rather than skipping it", () => {
    expect(() => parseDiff("@@ -1 +1 @@\n")).toThrow();
    expect(() => parseDiff("@@ nonsense @@\n")).toThrow();
  });
});

describe("public-hygiene.yml", () => {
  interface Step {
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }
  const raw = () => readFileSync(resolve(".github/workflows/public-hygiene.yml"), "utf8");
  const doc = () =>
    parse(raw()) as {
      on: Record<string, { types?: string[] }>;
      permissions: Record<string, string>;
      jobs: Record<string, { steps: Step[] }>;
    };
  const steps = () => Object.values(doc().jobs)[0]!.steps;

  it("runs on title and body edits, as a plain pull_request with a read-only token", () => {
    expect(Object.keys(doc().on)).toEqual(["pull_request"]);
    expect(doc().on.pull_request!.types!.sort()).toEqual(["edited", "opened", "reopened", "synchronize"]);
    expect(doc().permissions).toEqual({ contents: "read" });
    expect(raw()).not.toContain("pull_request_target");
  });

  it("keeps event text out of the script, checks out the head with full history, and installs nothing", () => {
    for (const s of steps()) expect(s.run ?? "", "no expression inside run").not.toContain("${{");
    const checkout = steps().find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with?.["ref"]).toBe("${{ github.event.pull_request.head.sha }}");
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    const check = steps().find((s) => s.run?.includes("check-public-hygiene"))!;
    expect(Object.keys(check.env!).sort()).toEqual(["BASE_REF", "HEAD_REF", "HEAD_SHA", "PR_BODY", "PR_TITLE"]);
    expect(check.run).toContain('--base "origin/$BASE_REF"');
    expect(raw()).not.toMatch(/npm (ci|install)/);
    expect(check.run).not.toContain("--require-private");
  });

  // Executes the step: a pull request must not be able to certify itself by editing the checker or its samples.
  describe("which checker runs", () => {
    const CHECKER = "scripts/check-public-hygiene.ts";
    const SAMPLE_FILE = "test/fixtures/public-hygiene/samples.json";
    const argv = (checker: string, temp: string) =>
      `ARGV ${checker} --base origin/main --head ${git("rev-parse", "HEAD").trim()} --title-file ${temp}/title --body-file ${temp}/body --branch feature`;
    const runStep = (base = "main") => {
      const bin = join(work, "bin");
      mkdirSync(bin, { recursive: true });
      const log = join(work, "node.log");
      writeFileSync(join(bin, "node"), `#!/bin/bash\n{ echo "ARG $1"; echo "ARGV $*"; cat "$1"; } >>'${log}'\n`);
      chmodSync(join(bin, "node"), 0o755);
      const temp = join(work, "runner-temp");
      mkdirSync(temp, { recursive: true });
      const step = steps().find((s) => s.run?.includes("check-public-hygiene"))!;
      const r = spawnSync("bash", ["-e", "-c", step.run!], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...gitEnv(home),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temp,
          BASE_REF: base,
          HEAD_SHA: git("rev-parse", "HEAD").trim(),
          HEAD_REF: "feature",
          PR_TITLE: "t",
          PR_BODY: "b",
        },
      });
      return { code: r.status, out: r.stdout + r.stderr, log: existsSync(log) ? readFileSync(log, "utf8") : "", temp };
    };

    it(
      "is the base branch's, with the base branch's samples, when the base has one",
      () => {
        git("checkout", "-q", "main");
        commit("base checker", { [CHECKER]: "BASE COPY\n", [SAMPLE_FILE]: "BASE SAMPLES\n" });
        git("update-ref", "refs/remotes/origin/main", "HEAD");
        git("branch", "-f", "feature", "HEAD");
        git("checkout", "-q", "feature");
        commit("edit the checker", { [CHECKER]: "HEAD COPY\n", [SAMPLE_FILE]: "HEAD SAMPLES\n" });
        const r = runStep();
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain("running the base branch's checker");
        expect(r.log).toContain(`ARG ${join(r.temp, "checker", CHECKER)}`);
        expect(r.log).toContain(argv(join(r.temp, "checker", CHECKER), r.temp));
        expect(r.log).toContain("BASE COPY");
        expect(r.log).not.toContain("HEAD COPY");
        expect(readFileSync(join(r.temp, "checker", SAMPLE_FILE), "utf8")).toBe("BASE SAMPLES\n");
      },
      T,
    );

    it(
      "is this pull request's own, and says so, when the base is main and has none",
      () => {
        git("update-ref", "refs/remotes/origin/main", "main");
        commit("add the checker", { [CHECKER]: "HEAD COPY\n", [SAMPLE_FILE]: "HEAD SAMPLES\n" });
        const r = runStep();
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain("the base branch has no checker yet: running this pull request's copy");
        expect(r.log).toContain(`ARG ${CHECKER}`);
        expect(r.log).toContain(argv(CHECKER, r.temp));
        expect(r.log).toContain("HEAD COPY");
      },
      T,
    );

    it(
      "fails, without running anything, when a base other than main has none",
      () => {
        git("update-ref", "refs/remotes/origin/stale", "main");
        commit("add the checker", { [CHECKER]: "HEAD COPY\n", [SAMPLE_FILE]: "HEAD SAMPLES\n" });
        const r = runStep("stale");
        expect(r.code, r.out).toBe(2);
        expect(r.out).toContain("the base branch has no checker, and only main may run this pull request's copy");
        expect(r.log).toBe("");
      },
      T,
    );
  });

  it("is on a Node with type stripping, and is outside ci.yml", () => {
    const setup = steps().find((s) => s.uses?.startsWith("actions/setup-node@"))!;
    expect(setup.with?.["node-version"]).toBe("24");
    expect(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")).not.toContain("check-public-hygiene");
  });
});

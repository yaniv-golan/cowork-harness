import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OPEN_PR = resolve("scripts/open-pr.sh");
const TSX = resolve("node_modules/.bin/tsx");
const SENTINEL = "zqxsentinelprivate";
const SESSION_NAME = "cwh" + "-77";
const T = 60_000;

let work: string;
let home: string;
let repo: string;
let origin: string;
let ghLog: string;
let bin: string;

const env = () => ({
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GH_LOG: ghLog,
  REAL_TSX: TSX,
});
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: env() });
const commit = (message: string, file = "a.txt", text = "fine\n") => {
  writeFileSync(join(repo, file), text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
};
const body = (text = "a real body\n") => {
  const p = join(work, "body.md");
  writeFileSync(p, text);
  return p;
};
const openPr = (...args: string[]) => {
  const r = spawnSync("bash", [OPEN_PR, ...args], { cwd: repo, encoding: "utf8", env: env() });
  return { code: r.status, out: r.stdout + r.stderr };
};
const pushed = (branch: string) =>
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: origin, env: env() }).status === 0;
const ghCalls = () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : []);

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "open-pr-"));
  home = join(work, "home");
  repo = join(work, "repo");
  origin = join(work, "origin.git");
  bin = join(work, "bin");
  ghLog = join(work, "gh.log");
  for (const d of [home, repo, bin, join(home, ".config", "cowork-harness")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".config", "cowork-harness", "private-hygiene-patterns.txt"), `${SENTINEL}\n`);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$GH_LOG"\n');
  // `npx --no-install tsx <args>`: the temporary repo has no node_modules, so run the real tsx from this checkout.
  writeFileSync(join(bin, "npx"), '#!/bin/sh\nshift 2\nexec "$REAL_TSX" "$@"\n');
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "npx"), 0o755);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: env() });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", origin);
  commit("start", "README.md", "start\n");
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "-b", "feature");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("open-pr.sh", () => {
  it(
    "checks, then pushes, then opens the pull request from the pushed branch",
    () => {
      commit("the only commit");
      const r = openPr(body(), "--draft");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("private patterns: 1 loaded");
      expect(pushed("feature")).toBe(true);
      expect(ghCalls()).toHaveLength(1);
      expect(ghCalls()[0]).toMatch(/^pr create --base main --head feature --title the only commit --body-file .* --draft$/);
    },
    T,
  );

  it(
    "a private hit in the commits stops it before anything is pushed",
    () => {
      commit("the only commit", "a.txt", `x ${SENTINEL} y\n`);
      const r = openPr(body());
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).not.toContain(SENTINEL);
      expect(pushed("feature")).toBe(false);
      expect(ghCalls()).toEqual([]);
    },
    T,
  );

  it(
    "a leak in the title or an empty body stops it too",
    () => {
      commit("the only commit");
      expect(openPr(body(), "--title", `t ${SENTINEL}`).code).not.toBe(0);
      expect(openPr(body("   \n")).code).not.toBe(0);
      expect(pushed("feature")).toBe(false);
    },
    T,
  );

  it(
    "refuses a branch whose name leaks: the name is public as soon as it is pushed",
    () => {
      git("checkout", "-q", "-b", `x-${SESSION_NAME}-y`);
      commit("the only commit");
      const r = openPr(body());
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("branch name: session name");
      expect(pushed(`x-${SESSION_NAME}-y`)).toBe(false);
    },
    T,
  );

  it(
    "refuses main, a detached HEAD, --fill, --web and a missing body file",
    () => {
      commit("c");
      expect(openPr(body(), "--fill").out).toContain("skips the check");
      expect(openPr(body(), "--web").out).toContain("skips the check");
      expect(openPr(join(work, "absent")).out).toContain("no such body file");
      git("checkout", "-q", "main");
      expect(openPr(body()).out).toContain("refusing to open a pull request from main");
      git("checkout", "-q", "--detach", "HEAD");
      expect(openPr(body()).out).toContain("HEAD is detached");
      expect(ghCalls()).toEqual([]);
    },
    T,
  );

  it(
    "needs --title when the branch has several commits, rather than picking one",
    () => {
      commit("first");
      commit("second", "b.txt");
      const r = openPr(body());
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("2 commits on this branch; pass --title");
      expect(pushed("feature")).toBe(false);
      expect(openPr(body(), "--title", "both").code).toBe(0);
    },
    T,
  );

  it(
    "a stacked draft is checked against, and opened on, its base branch",
    () => {
      commit("base work");
      git("push", "-q", "origin", "HEAD:refs/heads/stack-base");
      git("checkout", "-q", "-b", "stacked");
      commit("stacked work", "b.txt");
      const r = openPr(body(), "--draft", "--base", "stack-base");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("checked 1 commits");
      expect(ghCalls()[0]).toContain("--base stack-base --head stacked");
    },
    T,
  );

  it(
    "stops before opening the pull request if HEAD and its upstream differ after the push",
    () => {
      commit("the only commit");
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } }).trim();
      writeFileSync(
        join(bin, "git"),
        `#!/bin/bash\nif [ "$1" = rev-parse ] && [ "$2" = "@{u}" ]; then echo differs; exit 0; fi\nexec '${realGit}' "$@"\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      const r = openPr(body());
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("HEAD and its upstream differ");
      expect(ghCalls()).toEqual([]);
    },
    T,
  );

  it(
    "refuses a flag taken as an option's value",
    () => {
      commit("the only commit");
      expect(openPr(body(), "--base", "--draft").out).toContain("--base needs a value");
      expect(openPr(body(), "--title", "--draft").out).toContain("--title needs a value");
      expect(pushed("feature")).toBe(false);
    },
    T,
  );

  it("never force-pushes, and keeps the check out of a pipeline", () => {
    const source = readFileSync(OPEN_PR, "utf8");
    expect(source.split("\n").filter((l) => l.includes("git push"))).toEqual(["git push -u origin HEAD"]);
    expect(source).not.toContain("--force");
    const check = source.split("\n").findIndex((l) => l.includes("check-public-hygiene.ts"));
    expect(
      source
        .split("\n")
        .slice(check, check + 2)
        .join("\n"),
    ).not.toContain("|");
    expect(check).toBeLessThan(source.split("\n").findIndex((l) => l.startsWith("git push")));
  });
});

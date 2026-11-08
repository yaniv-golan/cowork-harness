import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOST = resolve("scripts/test-linux.sh");
const INNER = resolve("scripts/ci/test-linux-inner.sh");
const T = 60_000;

let work: string;
let repo: string;
let bin: string;
let log: string;

const baseEnv = () => ({
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  HOME: join(work, "host-home"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  LOG: log,
  TEST_LINUX_NPM_CACHE: join(work, "npm-cache"),
});
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const put = (path: string, text = "x\n") => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "test-linux-"));
  repo = join(work, "repo");
  bin = join(work, "bin");
  log = join(work, "log");
  for (const d of [repo, bin, join(work, "host-home")]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("test-linux-inner.sh, the container half", () => {
  const inner = (arg: string) => {
    const r = spawnSync("bash", [INNER, arg], { cwd: repo, encoding: "utf8", env: baseEnv() });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  beforeEach(() => {
    stub("npm", 'echo "npm $*" >>"$LOG"\nif [ "$1" = run ]; then mkdir -p dist; touch dist/cli.js; fi');
    stub("npx", 'echo "npx $* HOME=$HOME entries=$(ls -A "$HOME" | wc -l)" >>"$LOG"');
    put("test/a.test.ts");
    put("test/b.test.ts");
    writeFileSync(join(work, "list"), "test/a.test.ts\ntest/b.test.ts\n");
  });

  it(
    "runs the listed tests with an empty HOME for vitest only, and prints each phase and the file count",
    () => {
      const r = inner(join(work, "list"));
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("test:linux files: 2");
      for (const p of ["copy", "npm-ci", "build", "vitest"]) expect(r.out).toMatch(new RegExp(`test:linux phase ${p}: \\d+ s`));
      expect(logged()).toMatch(
        /npx --no-install vitest run --exclude test\/publish-plan\.test\.ts test\/a\.test\.ts test\/b\.test\.ts HOME=\S+ entries=\s*0/,
      );
      // Under the real home: the suite reads a /tmp path as a temp file, so a HOME there fails its redaction tests.
      expect(logged()).toContain(`HOME=${join(work, "host-home", "test-linux-home.")}`);
      expect(logged()).toMatch(/^npm ci /m);
      expect(existsSync(join(repo, ".git"))).toBe(true);
    },
    T,
  );

  it(
    "leaves out the test that needs jq by name, says why, and names it nowhere else in the run",
    () => {
      writeFileSync(join(work, "list"), "test/a.test.ts\ntest/publish-plan.test.ts\n");
      const r = inner(join(work, "list"));
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("test:linux skipping test/publish-plan.test.ts: it needs jq");
      expect(r.out).toContain("test:linux files: 1");
      expect(logged()).toMatch(/vitest run --exclude test\/publish-plan\.test\.ts test\/a\.test\.ts HOME=/);
    },
    T,
  );

  it(
    "fails by name on a listed file the copy does not have, before any install",
    () => {
      writeFileSync(join(work, "list"), "test/a.test.ts\ntest/new-and-missing.test.ts\n");
      const r = inner(join(work, "list"));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("listed but not in the copy: test/new-and-missing.test.ts");
      expect(logged()).toBe("");
    },
    T,
  );

  it(
    "fails on an empty list",
    () => {
      writeFileSync(join(work, "list"), "\n");
      const r = inner(join(work, "list"));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("the test list is empty");
    },
    T,
  );

  it(
    "refuses to run as root",
    () => {
      stub("id", "echo 0");
      const r = inner(join(work, "list"));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("refusing to run as root");
      expect(logged()).toBe("");
    },
    T,
  );

  it(
    "fails when the build leaves no dist/cli.js",
    () => {
      stub("npm", 'echo "npm $*" >>"$LOG"');
      const r = inner(join(work, "list"));
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("dist/cli.js is missing");
      expect(logged()).not.toContain("vitest");
    },
    T,
  );

  it(
    "exits with vitest's status, and --all names no files",
    () => {
      stub("npx", 'echo "npx $*" >>"$LOG"; exit 3');
      const r = inner("--all");
      expect(r.code, r.out).toBe(3);
      expect(r.out).toContain("test:linux files: all");
      expect(logged()).toMatch(/npx --no-install vitest run --exclude test\/publish-plan\.test\.ts\s*$/m);
    },
    T,
  );
});

describe("test-linux.sh, the host half", () => {
  const host = (...args: string[]) => {
    const r = spawnSync("bash", [HOST, ...args], { cwd: repo, encoding: "utf8", env: baseEnv() });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: baseEnv() });
  const capturedTar = () => join(work, "captured.tar");
  const capturedList = () => join(work, "captured-list");

  const dockerStub = (exitInfo = 0) =>
    stub(
      "docker",
      `if [ "$1" = info ]; then exit ${exitInfo}; fi
if [ "$1" = volume ]; then exit 0; fi
if [ "$1" = run ]; then
  echo "docker $*" >>"$LOG"
  for a in "$@"; do case "$a" in *:/lane:ro) lane="\${a%%:*}";; esac; done
  if [ -n "\${lane:-}" ]; then
    [ -f "$lane/list" ] && cp "$lane/list" "${capturedList()}"
    cat >"${capturedTar()}"
  fi
  exit 0
fi`,
    );
  const npxStub = (lines: string, exit = 0) => stub("npx", `printf '%s\\n' ${JSON.stringify(lines)}\nexit ${exit}`);
  const tarNames = () => execFileSync("tar", ["-tf", capturedTar()], { encoding: "utf8" }).trim().split("\n").sort();

  beforeEach(() => {
    git("init", "-q", "-b", "main");
    put("README.md");
    put("test/cli.test.ts", 'const CLI = "dist/cli.js";\n');
    put("test/plain.test.ts");
    put("test/gone.test.ts");
    put("test/live-thing.test.ts", 'const CLI = "dist/cli.js";\n');
    put(".gitignore", "ignored.txt\n");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
    dockerStub();
    npxStub("");
  });

  it(
    "the list holds changed tests and CLI-spawning tests, without the live suites, and runs as the node user",
    () => {
      npxStub("test/plain.test.ts");
      const r = host("--base", "main");
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(capturedList(), "utf8").trim().split("\n")).toEqual(["test/cli.test.ts", "test/plain.test.ts"]);
      expect(logged()).toMatch(/docker run -i --rm -u node .* node:22 /);
    },
    T,
  );

  it(
    "copies a new untracked test and leaves out deleted and ignored files",
    () => {
      put("test/new.test.ts", 'const CLI = "dist/cli.js";\n');
      put("ignored.txt");
      rmSync(join(repo, "test/gone.test.ts"));
      const r = host("--base", "main");
      expect(r.code, r.out).toBe(0);
      const names = tarNames();
      expect(names).toContain("test/new.test.ts");
      expect(names).not.toContain("test/gone.test.ts");
      expect(names).not.toContain("ignored.txt");
      expect(readFileSync(capturedList(), "utf8")).toContain("test/new.test.ts");
    },
    T,
  );

  it(
    "fails when the list has no lines, even though vitest list exits 0",
    () => {
      git("rm", "-q", "--cached", "test/cli.test.ts", "test/live-thing.test.ts");
      rmSync(join(repo, "test/cli.test.ts"));
      rmSync(join(repo, "test/live-thing.test.ts"));
      git("commit", "-q", "-m", "no CLI tests");
      const r = host("--base", "main");
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("the test list is empty");
      expect(logged()).not.toContain("docker run");
    },
    T,
  );

  it(
    "fails by name when Docker is not running, or vitest list fails",
    () => {
      npxStub("", 1);
      expect(host("--base", "main").out).toContain("vitest list failed");
      dockerStub(1);
      expect(host("--base", "main").out).toContain("Docker is not running");
    },
    T,
  );

  it(
    "--all sends no list",
    () => {
      const r = host("--all");
      expect(r.code, r.out).toBe(0);
      expect(logged()).toContain("scripts/ci/test-linux-inner.sh");
      expect(existsSync(capturedList())).toBe(false);
    },
    T,
  );
});

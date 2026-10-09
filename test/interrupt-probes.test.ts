import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { InterruptedError } from "../src/termination.js";
import { hostCliSupportsPermissionPrompts, resetHostCliProbeCache } from "../src/runtime/host-cli-probe.js";
import { assertIsolationSupported, resetIsolationPreflight } from "../src/decide/llm-transport.js";
import { snapshotGitArm } from "../src/eval/snapshot.js";
import { variantSnapshot } from "../src/hillclimb/snapshot.js";

// A synchronous probe the operator's Ctrl-C killed (it signals the whole foreground group, so the probe can die
// before the harness's own handler runs) answered nothing. Each of these must report that as the interrupt, never as
// a verdict about the binary or the repository, and never cache it.

const POSIX = process.platform !== "win32";
const interruptedBin = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "interrupt-probe-"));
  const bin = join(dir, name);
  writeFileSync(bin, "#!/bin/sh\nexit 130\n");
  chmodSync(bin, 0o755);
  return dir;
};

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
  resetHostCliProbeCache();
  resetIsolationPreflight();
});

describe.runIf(POSIX)("probes a Ctrl-C killed report the interrupt", () => {
  it("the host claude's --permission-prompts probe throws InterruptedError, not 'unsupported', and caches nothing", () => {
    const dir = interruptedBin("claude");
    const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin` };
    expect(() => hostCliSupportsPermissionPrompts(env)).toThrow(InterruptedError);
    // Not cached: a working claude at the same path afterwards is probed again.
    writeFileSync(join(dir, "claude"), `#!/bin/sh\necho '  --permission-prompts <target>  where "none" denies'\n`);
    chmodSync(join(dir, "claude"), 0o755);
    expect(hostCliSupportsPermissionPrompts(env).supported).toBe(true);
  });

  it("the judge's isolation probe throws InterruptedError, not 'too old to run isolated'", () => {
    const dir = interruptedBin("claude");
    expect(() => assertIsolationSupported(join(dir, "claude"))).toThrow(InterruptedError);
  });

  it("hillclimb's variant snapshot whose git a Ctrl-C killed throws InterruptedError, not a usage error", () => {
    const dir = mkdtempSync(join(tmpdir(), "interrupt-git-"));
    writeFileSync(join(dir, "git"), "#!/bin/sh\nexit 130\n");
    chmodSync(join(dir, "git"), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
    const live = mkdtempSync(join(tmpdir(), "interrupt-live-"));
    const root = mkdtempSync(join(tmpdir(), "interrupt-snaproot-"));
    expect(() => variantSnapshot(live, { snapshotRoot: root, flowHash: "f", variant: "v" })).toThrow(InterruptedError);
  });

  it("a git arm snapshot whose git a Ctrl-C killed throws InterruptedError, not 'snapshot failed'", () => {
    const repo = mkdtempSync(join(tmpdir(), "interrupt-repo-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    mkdirSync(join(repo, "p"));
    writeFileSync(join(repo, "p", "f.txt"), "x");
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "y");
    // git answers rev-parse/cat-file normally and dies of the interrupt on the listing.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const dir = mkdtempSync(join(tmpdir(), "interrupt-git-"));
    writeFileSync(join(dir, "git"), `#!/bin/sh\ncase "$*" in *ls-tree*) exit 130;; esac\nexec ${realGit} "$@"\n`);
    chmodSync(join(dir, "git"), 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
    expect(() =>
      snapshotGitArm({ ref: "HEAD", path: "p" }, join(mkdtempSync(join(tmpdir(), "interrupt-dest-")), "a"), repo, "git:HEAD:p"),
    ).toThrow(InterruptedError);
  });
});

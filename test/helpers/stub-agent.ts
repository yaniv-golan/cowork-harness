import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * A stand-in for the host `claude` the protocol tier spawns (`spawn("claude", …)` resolves it through
 * `PATH`), so a CLI-level test can drive a real `run` with NO agent and NO spend.
 *
 * Credential safety is part of the fixture, not left to each test:
 *  - The CLI is spawned with a CONSTRUCTED environment, never `...process.env`, so nothing ambient (a
 *    token exported in the developer's shell) can ride into the child.
 *  - The three credential variables are set to "" rather than deleted. The CLI auto-loads `./.env` and
 *    `<install>/.env`, and the loader only fills a key that is `undefined` — so a deleted key is exactly
 *    the state a repo `.env` would fill, while "" is left alone and reads as "not provided".
 *  - `COWORK_MANAGED_CONFIG=0` keeps the protocol tier off the managed-config branch, which injects a token.
 *  - `CLAUDE_CONFIG_DIR` and `HOME` point into the fixture's own temp dir, so the operator's real config dir
 *    is never read.
 *  - The stub dumps the environment it actually received, and {@link credentialLeaks} reads that dump, so
 *    every test can ASSERT that no credential reached the agent instead of assuming it.
 */
export const CLI = resolve("dist/cli.js");
export const POSIX = process.platform !== "win32";

const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"] as const;

/** One AskUserQuestion gate, as the agent sends it on the control channel. */
export const QUESTION_FRAME = JSON.stringify({
  type: "control_request",
  request_id: "q-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_stub",
    input: { questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
  },
});

export interface StubFixture {
  root: string;
  cwd: string;
  runsDir: string;
  scenario: string;
  stubPidFile: string;
  envDump: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/**
 * `body` is the shell run after the stub records its env and pid. It must end by keeping the process alive
 * (`exec sleep 300`) — a stub that never reads stdin also survives the harness closing its stdin, which is
 * how a real agent keeps finishing a paid turn after the harness is gone.
 */
export function makeStubFixture(body: string, extraEnv: Record<string, string> = {}): StubFixture {
  const root = mkdtempSync(join(tmpdir(), "stub-agent-"));
  const bin = join(root, "bin");
  const cwd = join(root, "cwd");
  const runsDir = join(root, "runs");
  for (const d of [bin, cwd, runsDir, join(root, "home"), join(root, "config")]) mkdirSync(d, { recursive: true });
  const stubPidFile = join(root, "stub.pid");
  const envDump = join(root, "stub.env");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nenv > "$STUB_ENV_DUMP"\necho $$ > "$STUB_PID"\n${body}\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const scenario = join(cwd, "stub.yaml");
  writeFileSync(scenario, "baseline: latest\nfidelity: protocol\nprompt: say hi\nassert:\n  - result: success\n");
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(root, "home"),
    TMPDIR: tmpdir(),
    CLAUDE_CONFIG_DIR: join(root, "config"),
    COWORK_HARNESS_RUNS_DIR: runsDir,
    COWORK_MANAGED_CONFIG: "0",
    STUB_PID: stubPidFile,
    STUB_ENV_DUMP: envDump,
    ...Object.fromEntries(CREDENTIAL_VARS.map((k) => [k, ""])),
    ...extraEnv,
  };
  return {
    root,
    cwd,
    runsDir,
    scenario,
    stubPidFile,
    envDump,
    env,
    cleanup() {
      const pid = readPid(stubPidFile);
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Names of credential-shaped variables that reached the stub with a NON-EMPTY value (names only). */
export function credentialLeaks(envDump: string): string[] {
  const leaks: string[] = [];
  for (const line of readFileSync(envDump, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (/(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|_TOKEN|_SECRET|PASSWORD)$/.test(name) && line.length > eq + 1) leaks.push(name);
  }
  return leaks;
}

export function spawnCli(f: StubFixture, args: string[]): ChildProcess & { stdoutText: () => string; stderrText: () => string } {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: f.cwd, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (b) => (out += b));
  child.stderr!.on("data", (b) => (err += b));
  return Object.assign(child, { stdoutText: () => out, stderrText: () => err });
}

export function exited(child: ChildProcess, ms = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((res, rej) => {
    if (child.exitCode !== null || child.signalCode !== null) return res({ code: child.exitCode, signal: child.signalCode });
    const t = setTimeout(() => rej(new Error(`CLI did not exit within ${ms}ms`)), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(t);
      res({ code, signal });
    });
  });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readPid(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** The single run dir under the fixture's runs root (`<runs>/<scenario>/<sessionId>`), once it exists. */
export function runDir(f: StubFixture): string | undefined {
  const scen = join(f.runsDir, "stub");
  if (!existsSync(scen)) return undefined;
  const dirs = readdirSync(scen).filter((d) => !d.startsWith("."));
  return dirs.length === 1 ? join(scen, dirs[0]) : undefined;
}

export function readStatus(f: StubFixture): Record<string, unknown> | undefined {
  const d = runDir(f);
  if (!d) return undefined;
  try {
    return JSON.parse(readFileSync(join(d, "status.json"), "utf8"));
  } catch {
    return undefined;
  }
}

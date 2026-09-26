import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import { microvmAgent, microvmGuestKillArgv, microvmGuestKillScript, hostChildPids } from "../src/runtime/microvm.js";

// On the microvm tier the harness's child is the host `limactl shell` client; the agent runs in the guest.
// Killing the client — SIGTERM or SIGKILL — does not reach the guest process (measured against a live
// instance while this was planned), and the client's host `ssh` child is orphaned too. So stopping the
// agent means a guest-side kill targeted at THIS session, plus killing that ssh child. None of this can be
// exercised end to end without a VM, so these pin the pieces that decide correctness: which guest processes
// the kill script selects, the exact host command, and the order of operations. No test here runs limactl.

const POSIX = process.platform !== "win32";
const CONFIG = "/sessions/local_abc/mnt/.claude";

/** A fake /proc: one dir per "pid" holding a NUL-separated environ. */
function fakeProc(entries: Record<string, string[] | null>): string {
  const root = mkdtempSync(join(tmpdir(), "fake-proc-"));
  for (const [pid, env] of Object.entries(entries)) {
    mkdirSync(join(root, pid));
    if (env) writeFileSync(join(root, pid, "environ"), env.join("\0") + "\0");
  }
  mkdirSync(join(root, "self")); // non-numeric entries must be ignored
  return root;
}

/** Run the guest kill script with `kill` replaced by a logger, so it records what it WOULD signal. */
function selected(script: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "kill-log-"));
  const log = join(dir, "log");
  const r = spawnSync("sh", ["-c", `kill() { echo "$@" >> '${log}'; }; ${script}`], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

describe.runIf(POSIX)("microvm guest-side kill targets exactly this session", () => {
  it("signals every process carrying this session's CLAUDE_CONFIG_DIR, and nothing else", () => {
    const proc = fakeProc({
      "101": ["PATH=/usr/bin", `CLAUDE_CONFIG_DIR=${CONFIG}`], // the agent
      "102": [`CLAUDE_CONFIG_DIR=${CONFIG}`, "MCP=1"], // something the agent started (inherits the env)
      "201": ["CLAUDE_CONFIG_DIR=/sessions/local_abcd/mnt/.claude"], // another session whose id extends ours
      "202": [`CLAUDE_CONFIG_DIR=${CONFIG}/nested`], // a longer value
      "203": [`NOTE=CLAUDE_CONFIG_DIR=${CONFIG}`], // the string as part of another variable
      "204": ["PATH=/usr/bin"], // an unrelated process
      "205": null, // an environ we cannot read (another user's process, or one that just exited)
    });
    expect(selected(microvmGuestKillScript(CONFIG, "TERM", proc)).sort()).toEqual(["-TERM 101", "-TERM 102"]);
    expect(selected(microvmGuestKillScript(CONFIG, "KILL", proc)).sort()).toEqual(["-KILL 101", "-KILL 102"]);
  });

  it("never signals the shell running the scan", () => {
    const self = String(process.pid); // stands in for $$ below
    const proc = fakeProc({ [self]: [`CLAUDE_CONFIG_DIR=${CONFIG}`] });
    const script = microvmGuestKillScript(CONFIG, "TERM", proc).replace('"$$"', `"${self}"`);
    expect(selected(script)).toEqual([]);
  });

  it("a config dir with shell metacharacters stays a literal", () => {
    const weird = "/sessions/a'b $(touch /tmp/pwn)/mnt/.claude";
    const proc = fakeProc({ "301": [`CLAUDE_CONFIG_DIR=${weird}`], "302": [`CLAUDE_CONFIG_DIR=${CONFIG}`] });
    expect(selected(microvmGuestKillScript(weird, "TERM", proc))).toEqual(["-TERM 301"]);
  });

  it("the host command runs the script in the named instance from /", () => {
    const argv = microvmGuestKillArgv("cowork-vm-x", CONFIG, "TERM");
    expect(argv.slice(0, 6)).toEqual(["shell", "--workdir", "/", "cowork-vm-x", "sh", "-c"]);
    expect(argv[6]).toBe(microvmGuestKillScript(CONFIG, "TERM"));
    expect(argv[6]).toContain("'/proc'/[0-9]*");
  });
});

describe("microvm agent termination sequence", () => {
  function fakeClient(pid: number) {
    const ee = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };
    Object.assign(ee, { pid, exitCode: null, signalCode: null });
    return ee;
  }

  function harness(clientPid = 4242, sshPids = [4243]) {
    const calls: string[] = [];
    const client = fakeClient(clientPid);
    const run = ((cmd: string, args: string[]) => {
      if (cmd === "pgrep") {
        calls.push(`pgrep ${args.join(" ")}`);
        return { stdout: sshPids.join("\n") + "\n", status: 0 };
      }
      calls.push(`guest ${args[args.length - 1].match(/kill -(\w+)/)?.[1]} in ${args[3]}`);
      return { stdout: "", status: 0 };
    }) as unknown as typeof spawnSync;
    const kill = (pid: number, sig: NodeJS.Signals) => calls.push(`host ${sig} ${pid}`);
    const agent = microvmAgent(client, "cowork-vm-x", CONFIG, { run, kill });
    return { agent, calls, client };
  }

  it("terminate: find the ssh child BEFORE touching anything, then the guest TERM — no host kill yet", () => {
    const { agent, calls } = harness();
    agent.terminate();
    expect(calls).toEqual(["pgrep -P 4242", "guest TERM in cowork-vm-x"]);
  });

  it("forceKill: guest KILL, then the ssh child, then the limactl client", () => {
    const { agent, calls } = harness();
    agent.terminate();
    calls.length = 0;
    agent.forceKill();
    expect(calls).toEqual(["pgrep -P 4242", "guest KILL in cowork-vm-x", "host SIGKILL 4243", "host SIGKILL 4242"]);
  });

  it("an ssh child found before the client died is still killed after it (it can no longer be found by parent)", () => {
    const { agent, calls, client } = harness();
    agent.terminate(); // notes 4243
    Object.assign(client, { exitCode: null, signalCode: "SIGTERM" }); // the client is gone now
    calls.length = 0;
    agent.forceKill();
    expect(calls).toEqual(["guest KILL in cowork-vm-x", "host SIGKILL 4243"]);
  });

  it("alive/exited follow the limactl client", async () => {
    const { agent, client } = harness();
    expect(agent.alive()).toBe(true);
    const done = agent.exited();
    Object.assign(client, { exitCode: 0 });
    client.emit("exit", 0, null);
    await done;
    expect(agent.alive()).toBe(false);
  });

  it("hostChildPids parses pgrep output and tolerates none", () => {
    const run = ((_: string, __: string[]) => ({ stdout: "12\n34\n" })) as unknown as typeof spawnSync;
    expect(hostChildPids(1, run)).toEqual([12, 34]);
    const none = ((_: string, __: string[]) => ({ stdout: "" })) as unknown as typeof spawnSync;
    expect(hostChildPids(1, none)).toEqual([]);
  });
});

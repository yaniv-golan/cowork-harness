import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

// Stopping a run must stop what the agent started. Each case runs a small "harness" script against the
// REAL source (via tsx) in its own node process, which spawns a stub agent through the real spawn options.
// The stub starts one process per attribution layer, each reachable by exactly ONE layer:
//   (a) a detached shell tree (the Bash tool's shape): own group, cwd outside the work dir, no run tag —
//       only the descendant walk finds it;
//   (b) a non-detached child that ignores SIGTERM (an MCP server's shape), same attribution limits —
//       found by the walk, killed through the agent's group;
//   (c) an orphan `(sleep &)` in the work dir, carrying the run tag, from a detached shell (as the Bash tool
//       spawns it) that exits at once: reparented to init and left in a dead, untracked group before anything
//       can snapshot it — only the orphan sweep finds it. (From a NON-detached shell it would keep the agent's
//       group and die with it, and this case would stop testing the sweep at all.);
//   (d) optionally, a child the stub starts from its SIGTERM handler, after the last snapshot, outside the
//       work dir and with no tag — only the kill of the agent's own group reaches it.
// Every one inherits fd 3, a pipe back to this test. Death is observed as EOF on that pipe (fds close at
// death, zombie or not — no pid polling), and nothing is signalled before all ready lines have arrived.

const POSIX = process.platform !== "win32";
const AGENT_TREE = JSON.stringify(resolve("src/runtime/agent-tree.ts"));
const TERMINATION = JSON.stringify(resolve("src/termination.ts"));
const EXECUTE = JSON.stringify(resolve("src/run/execute.ts"));

const PROBE = `echo "$1 $$" >&3; exec sleep 300\n`;

const STUB_AGENT = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const [, , work, sibling, probe, mode] = process.argv;
const noTag = { ...process.env };
delete noTag.COWORK_HARNESS_RUN_TAG;
const io = ["ignore", "ignore", "ignore", 3];
spawn("sh", ["-c", \`sh "\${probe}" ready-a & wait\`], { detached: true, stdio: io, cwd: sibling, env: noTag });
spawn("sh", ["-c", \`trap '' TERM; exec sh "\${probe}" ready-b\`], { stdio: io, cwd: sibling, env: noTag });
spawn("sh", ["-c", \`(sh "\${probe}" ready-c &)\`], { detached: true, stdio: io, cwd: work, env: process.env });
process.on("SIGTERM", () => {
  if (mode === "late-child") spawn("sh", [probe, "ready-d"], { stdio: io, cwd: sibling, env: noTag });
  setTimeout(() => process.exit(0), 150);
});
createInterface({ input: process.stdin }).on("line", (l) => { if (l === "exit") process.exit(0); });
setInterval(() => {}, 1000);
`;

/** EOF on fd 3 is the oracle: every process the stub started holds the pipe, so it closes only once all of them
 *  are gone. How long a stop takes is not: on macOS each process listing it takes can last seconds while other
 *  processes list too (concurrent `ps -A` calls serialize), so a fixed short deadline failed whenever the suite ran
 *  in parallel. The listing count is pinned deterministically in agent-tree.test.ts ("process listings per stop");
 *  here the wait runs up to the test's own timeout. */
const READY_WAIT_MS = 15_000; // `ready()`'s own bound, spent before the EOF wait starts
const EOF_WAIT_MS = 55_000;
const LIVE_TIMEOUT_MS = READY_WAIT_MS + EOF_WAIT_MS + 5_000;

const live = new Set<number>(); // pids a fixture reported, so a red test never leaks a process

afterEach(() => {
  for (const pid of live)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  live.clear();
});

interface Fixture {
  proc: ChildProcess;
  ready(names: string[]): Promise<void>;
  eof(ms: number): Promise<boolean>;
  exit(): Promise<number | null>;
  stderr(): string;
}

function start(harnessBody: string, mode = ""): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-tree-live-")));
  const work = join(root, "work");
  const sibling = join(root, "elsewhere");
  mkdirSync(work);
  mkdirSync(sibling);
  writeFileSync(join(root, "probe.sh"), PROBE);
  writeFileSync(join(root, "agent.mjs"), STUB_AGENT);
  const tag = `r${randomBytes(8).toString("hex")}`; // per fixture: vitest workers run in parallel
  const script = join(root, "harness.mts");
  writeFileSync(
    script,
    harnessBody
      .replaceAll("$AGENT_ARGS", JSON.stringify([join(root, "agent.mjs"), work, sibling, join(root, "probe.sh"), mode]))
      .replaceAll("$WORK", JSON.stringify(work))
      .replaceAll("$TAG", JSON.stringify(tag)),
  );
  const proc = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  proc.stdout!.resume();
  const fd3 = proc.stdio[3] as Readable;
  const seen = new Map<string, number>();
  let buf = "";
  let ended = false;
  const waiters: Array<() => void> = [];
  fd3.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const [name, pid] = buf.slice(0, i).trim().split(" ");
      buf = buf.slice(i + 1);
      seen.set(name, Number(pid));
      live.add(Number(pid));
    }
    waiters.splice(0).forEach((w) => w());
  });
  fd3.on("end", () => {
    ended = true;
    waiters.splice(0).forEach((w) => w());
  });
  const exited = new Promise<number | null>((res) => proc.on("exit", (code) => res(code)));
  return {
    proc,
    ready: (names) =>
      new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`not ready: saw ${[...seen.keys()]} — ${err}`)), READY_WAIT_MS);
        const check = () => {
          if (names.every((n) => seen.has(n))) {
            clearTimeout(t);
            res();
          } else waiters.push(check);
        };
        check();
      }),
    eof: (ms) =>
      new Promise<boolean>((res) => {
        if (ended) return res(true);
        const t = setTimeout(() => res(false), ms);
        fd3.once("end", () => {
          clearTimeout(t);
          res(true);
        });
      }),
    exit: () => exited,
    stderr: () => err,
  };
}

const SPAWN_AND_REGISTER = `
  import { agentSpawnOptions, agentTreeAgent } from ${AGENT_TREE};
  import { installTerminationHandler, registerAgent } from ${TERMINATION};
  import { spawn } from "node:child_process";
  const runStartMs = Date.now();
  const [agentJs, ...rest] = $AGENT_ARGS;
  const child = spawn(process.execPath, [agentJs, ...rest], agentSpawnOptions({ cwd: $WORK, env: process.env, stdio: ["pipe", "pipe", "pipe", 3] }, $TAG));
  const agent = agentTreeAgent(child, { runTag: $TAG, runStartMs, workDir: $WORK });
`;

describe.runIf(POSIX)("stopping a run stops everything the agent started (live process tree)", () => {
  it(
    "SIGINT through the termination handler kills the detached tree, the SIGTERM-ignoring child and the orphan",
    async () => {
      const f = start(`
      ${SPAWN_AND_REGISTER}
      installTerminationHandler();
      registerAgent(() => agent);
      process.stdin.on("data", () => process.kill(process.pid, "SIGINT"));
      setInterval(() => {}, 1000);
    `);
      await f.ready(["ready-a", "ready-b", "ready-c"]);
      f.proc.stdin!.write("go\n");
      expect(await f.eof(EOF_WAIT_MS), f.stderr()).toBe(true);
      expect(await f.exit()).toBe(130);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "the leader exits on SIGTERM while a child ignores it, and a child started after the last snapshot: all still die",
    async () => {
      const f = start(
        `
      ${SPAWN_AND_REGISTER}
      installTerminationHandler();
      registerAgent(() => agent);
      process.stdin.on("data", () => process.kill(process.pid, "SIGINT"));
      setInterval(() => {}, 1000);
    `,
        "late-child",
      );
      await f.ready(["ready-a", "ready-b", "ready-c"]);
      f.proc.stdin!.write("go\n");
      expect(await f.eof(EOF_WAIT_MS), f.stderr()).toBe(true);
      expect(await f.exit()).toBe(130);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "the normal-path teardown after the leader already exited reaps from the tracked set and the sweep",
    async () => {
      const f = start(`
      ${SPAWN_AND_REGISTER}
      import { reapAgentOnTeardown } from ${EXECUTE};
      installTerminationHandler();
      const deregister = registerAgent(() => agent);
      process.stdin.once("data", async () => {
        agent.onFrame({ type: "result", subtype: "success" }); // the drive loop's last refresh
        child.stdin.write("exit\\n");
        await agent.exited();
        await reapAgentOnTeardown({ microvm: false, agent, child, deregister, settleMs: 50 });
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `);
      await f.ready(["ready-a", "ready-b", "ready-c"]);
      f.proc.stdin!.write("go\n");
      expect(await f.eof(EOF_WAIT_MS), f.stderr()).toBe(true);
      expect(await f.exit()).toBe(0);
    },
    LIVE_TIMEOUT_MS,
  );
});

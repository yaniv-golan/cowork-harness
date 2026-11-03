// The watchdog thread for test/setup/sync-child-watchdog.ts. Plain JavaScript on purpose: Node loads a
// worker_threads script itself, outside vitest's TypeScript transform.
//
// It runs on its own event loop, so it keeps working while the fork's main thread is blocked in a synchronous call
// (spawnSync, execFileSync, execSync), where vitest's testTimeout cannot fire. When the main thread's heartbeat has
// been silent past the limit, it records stack dumps of every child of the fork and of the fork itself, then
// SIGKILLs the children (deepest first) so the blocked call returns, and bumps the event counter the main thread's
// afterEach reads. With no child to kill, it records the fork's own stacks and kills nothing.
//
// Every diagnostic command has its own timeout: `sample` or `gdb` on a wedged process can itself hang.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";

const { sab, fileSab, pid, runDir, baseMs, pollMs, graceMs } = workerData;
const slots = new BigInt64Array(sab);
const fileBytes = new Uint8Array(fileSab);
// Slot layout, shared with sync-child-watchdog.ts.
const BEAT = 0,
  CALL_TIMEOUT = 1,
  TEST_FLOOR = 2,
  EVENTS = 3,
  FILE_LEN = 4,
  CALL_START = 5;
const GRACE_MS = graceMs; // added to a declared timeout, so the call's own timeout always fires first
// This thread's own diagnostic processes are children of the fork too; they are never "the hung child". A pid
// stays here after its process exits, because `ps` lists itself and is parsed only after it has exited. The set
// grows by a handful per event, and events are rare.
const ownPids = new Set();

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err && err.killed) resolve({ ok: false, text: `${cmd}: timed out after ${timeoutMs}ms\n${stdout ?? ""}` });
        else if (err && typeof err.code === "string") resolve({ ok: false, text: `${cmd}: ${err.code}` });
        else resolve({ ok: !err, text: `${stdout ?? ""}${stderr ? `\n--- stderr\n${stderr}` : ""}` });
      },
    );
    if (child.pid) ownPids.add(child.pid);
  });
}

/** Every live process under `root`, from one `ps` listing; each has its depth below root. */
async function descendants(root) {
  const r = await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], 5000);
  const rows = r.text
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], command: m[3] }));
  const out = [];
  const walk = (p, depth) => {
    for (const c of rows)
      if (c.ppid === p && c.pid !== p && !ownPids.has(c.pid)) {
        out.push({ ...c, depth });
        walk(c.pid, depth + 1);
      }
  };
  walk(root, 1);
  return out;
}

async function stacks(target) {
  if (process.platform === "darwin") return (await run("/usr/bin/sample", [String(target), "2"], 10_000)).text;
  if (process.platform !== "linux") return "(no stack sampler on this platform)";
  const parts = [];
  const gdbArgs = ["-batch", "-p", String(target), "-ex", "thread apply all bt"];
  let g = await run("gdb", gdbArgs, 20_000);
  if (!g.ok && process.getuid && process.getuid() !== 0) g = await run("sudo", ["-n", "gdb", ...gdbArgs], 20_000);
  parts.push(`=== gdb\n${g.text}`);
  for (const f of ["status", "wchan", "syscall", "stack"]) {
    try {
      parts.push(`=== /proc/${target}/${f}\n${readFileSync(`/proc/${target}/${f}`, "utf8")}`);
    } catch (e) {
      parts.push(`=== /proc/${target}/${f}: ${e.code ?? e}`);
    }
  }
  try {
    for (const t of readdirSync(`/proc/${target}/task`)) {
      const rd = (n) => {
        try {
          return readFileSync(`/proc/${target}/task/${t}/${n}`, "utf8").trim();
        } catch {
          return "?";
        }
      };
      parts.push(`task ${t} comm=${rd("comm")} wchan=${rd("wchan")} state=${rd("stat").split(" ")[2] ?? "?"}`);
    }
  } catch {
    /* gone */
  }
  return parts.join("\n");
}

let handledBeat = -1n;
let busy = false;

async function check() {
  if (busy) return;
  const beatAt = Atomics.load(slots, BEAT);
  const callAt = Atomics.load(slots, CALL_START);
  // A new sync call starts a new episode, even if the heartbeat could not run between two calls.
  const beat = callAt > beatAt ? callAt : beatAt;
  const now = BigInt(Date.now());
  const silent = now - beat;
  const call = Atomics.load(slots, CALL_TIMEOUT);
  const floor = Atomics.load(slots, TEST_FLOOR);
  let limit = BigInt(baseMs);
  if (floor > limit) limit = floor;
  if (call > 0n && call + BigInt(GRACE_MS) > limit) limit = call + BigInt(GRACE_MS);
  if (silent <= limit || beat === handledBeat) return;
  handledBeat = beat; // one event per silence episode
  busy = true;
  try {
    const n = Number(Atomics.load(slots, EVENTS)) + 1;
    const dir = join(runDir, `pid${pid}-ev${n}`);
    mkdirSync(dir, { recursive: true });
    const kids = await descendants(pid);
    for (const k of kids) writeFileSync(join(dir, `stacks-${k.pid}.txt`), `${k.command}\n\n${await stacks(k.pid)}`);
    writeFileSync(join(dir, `stacks-${pid}-fork.txt`), await stacks(pid));
    const len = Number(Atomics.load(slots, FILE_LEN));
    const summary = {
      file: len > 0 ? new TextDecoder().decode(fileBytes.slice(0, len)) : "(before the first test file's hooks)",
      pid,
      silentMs: Number(silent),
      limitMs: Number(limit),
      children: kids.map(({ pid: p, ppid, command, depth }) => ({ pid: p, ppid, command, depth })),
      killed: kids.length > 0,
      note: "a re-parented (orphaned) descendant is not under this fork and is not listed; the CI job-level dump covers it",
      at: new Date().toISOString(),
    };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
    for (const k of [...kids].sort((a, b) => b.depth - a.depth)) {
      try {
        process.kill(k.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    Atomics.store(slots, EVENTS, BigInt(n));
  } finally {
    busy = false;
  }
}

setInterval(() => {
  check().catch((e) => process.stderr.write(`sync-child watchdog: ${e?.stack ?? e}\n`));
}, pollMs);

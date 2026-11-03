// The watchdog thread for test/setup/sync-child-watchdog.ts. Plain JavaScript on purpose: Node loads a
// worker_threads script itself, outside vitest's TypeScript transform.
//
// It runs on its own event loop, so it keeps working while the fork's main thread is blocked in a synchronous call
// (spawnSync, execFileSync, execSync), where vitest's testTimeout cannot fire. When the main thread's heartbeat has
// been silent past the limit, it records stack dumps of every child of the fork and of the fork itself, then
// SIGKILLs the children (deepest first) so the blocked call returns, and bumps the event counter the main thread's
// afterEach reads. With no child to kill, it records the fork's own stacks and kills nothing.
//
// Every diagnostic command is bounded from OUTSIDE this process. gdb (and, briefly, `sample`) stops the process it
// attaches to, and when that is the fork, this thread stops with it, so a timer here could never fire: a wedged
// gdb would hold the fork forever. So the bound is a separate process: coreutils `timeout` on Linux (run under sudo
// with gdb, because a non-root `timeout` cannot signal a root gdb, and SIGKILL to sudo is not relayed), and a perl
// alarm-then-exec wrapper on macOS, which has no `timeout`. The in-thread timeout stays as a second layer.
// (src/bounded-spawn.ts is not reused: it bounds from inside this process, which is exactly what cannot work here,
// and this file is loaded outside the TypeScript build.)
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { bounded } from "./sync-child-diag.mjs";

const { sab, fileSab, pid, runDir, baseMs, pollMs, graceMs, failFirstListing } = workerData;
const slots = new BigInt64Array(sab);
const fileBytes = new Uint8Array(fileSab);
// Slot layout, shared with sync-child-watchdog.ts.
const BEAT = 0,
  CALL_TIMEOUT = 1,
  TEST_FLOOR = 2,
  EVENTS = 3,
  FILE_LEN = 4,
  CALL_START = 5;
// The monotonic clock, as the main thread writes it (sync-child-wrap.ts realNow): a suspended laptop does not count
// as silence, and a test's fake Date or fake hrtime cannot reach it.
const monoNow = () => process.hrtime.bigint() / 1_000_000n;
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

/**
 * Every live process under `root`, from one `ps` listing; each has its depth below root and its process group.
 * Returns null when the listing failed or timed out: an unknown, never "no children".
 */
let listings = 0;
async function descendants(root) {
  // The watchdog's own test makes the first listing fail, to prove a failed listing is retried.
  if (failFirstListing && listings++ === 0) return null;
  const r = await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], 5000);
  if (!r.ok) return null;
  const rows = r.text
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4] }));
  const out = [];
  const walk = (p, depth) => {
    for (const c of rows)
      if (c.ppid === p && c.pid !== p && !ownPids.has(c.pid)) {
        out.push({ ...c, depth });
        walk(c.pid, depth + 1);
      }
  };
  walk(root, 1);
  const self = rows.find((r) => r.pid === root);
  return { kids: out, ownPgid: self ? self.pgid : -1 };
}

async function stacks(target) {
  if (process.platform === "darwin") return (await run(...bounded(10, "/usr/bin/sample", [String(target), "2"]), 15_000)).text;
  if (process.platform !== "linux") return "(no stack sampler on this platform)";
  const parts = [];
  const gdbArgs = ["-batch", "-p", String(target), "-ex", "thread apply all bt"];
  // gdb exits 0 even when it cannot attach, so success is judged by its output. A non-root runner (GitHub's) needs
  // sudo to attach to a process that is not its own descendant (Yama ptrace_scope 1); try that first, then plain gdb.
  const attached = (r) => /^Thread \d|^#0 /m.test(r.text);
  const tries =
    process.getuid && process.getuid() !== 0
      ? [["sudo", ["-n", ...bounded(20, "gdb", gdbArgs).flat()]], bounded(20, "gdb", gdbArgs)]
      : [bounded(20, "gdb", gdbArgs)];
  let g = { ok: false, text: "" };
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args, 30_000);
    g = { ok: r.ok, text: `${g.text}${g.text ? "\n" : ""}[${cmd === "sudo" ? "sudo gdb" : "gdb"}] ${r.text}` };
    if (attached(r)) break;
  }
  if (/ENOENT|No such file|command not found/.test(g.text) && !attached(g))
    parts.push("=== gdb: NOT AVAILABLE (is gdb installed? CI installs it in the step before the tests)");
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

/** The silence episode already reported: its start, its dump dir, and whether a child was found and killed. */
let episode = null;
let busy = false;
const RETRY_MS = 10_000n;

function writeSummary(dir, summary) {
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
}

/**
 * Dump and kill whatever is under the fork now, into the episode's directory. Returns true when the listing worked
 * and found something to kill. A child in its own process group (spawned `detached`) is killed with its whole
 * group, which also reaches its re-parented descendants; the fork's own group is never signalled.
 */
async function dumpAndKill(ep) {
  const listing = await descendants(pid);
  ep.summary.attempts = (ep.summary.attempts ?? 0) + 1;
  if (!listing) {
    ep.summary.listing = "failed or timed out; retried while the call is still blocked";
    writeSummary(ep.dir, ep.summary);
    return false;
  }
  const { kids, ownPgid } = listing;
  ep.summary.listing = "ok";
  ep.summary.children = kids.map(({ pid: p, ppid, pgid, command, depth }) => ({ pid: p, ppid, pgid, command, depth }));
  ep.summary.killed = kids.length > 0;
  if (kids.length === 0 && Atomics.load(slots, CALL_START) > 0n)
    ep.summary.listing =
      "ok, but a sync call is blocked with no child under this fork: a re-parented descendant may hold its pipe (see the CI job-level dump); retried";
  writeSummary(ep.dir, ep.summary);
  if (kids.length === 0) return false;
  for (const k of kids) writeFileSync(join(ep.dir, `stacks-${k.pid}.txt`), `${k.command}\n\n${await stacks(k.pid)}`);
  // Kill only after the dumps, so the stacks show the children as they hung.
  for (const k of [...kids].sort((a, b) => b.depth - a.depth)) {
    try {
      process.kill(k.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const g of new Set(kids.map((k) => k.pgid))) {
    if (g > 1 && g !== ownPgid) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  return true;
}

async function check() {
  if (busy) return;
  const beatAt = Atomics.load(slots, BEAT);
  const callAt = Atomics.load(slots, CALL_START);
  // A new sync call starts a new episode, even if the heartbeat could not run between two calls.
  const beat = callAt > beatAt ? callAt : beatAt;
  const now = monoNow();
  const silent = now - beat;
  if (episode && episode.beat === beat) {
    // Same episode, already reported. If nothing was killed and a sync call is still blocked, a child may have been
    // missed (a failed listing, or one spawned late): look again, without counting a new event.
    if (!episode.killed && callAt > 0n && now - episode.lastTry >= RETRY_MS) {
      busy = true;
      try {
        episode.lastTry = monoNow();
        episode.killed = await dumpAndKill(episode);
      } finally {
        busy = false;
      }
    }
    return;
  }
  const call = Atomics.load(slots, CALL_TIMEOUT);
  const floor = Atomics.load(slots, TEST_FLOOR);
  let limit = BigInt(baseMs);
  if (floor > limit) limit = floor;
  if (call > 0n && call + BigInt(GRACE_MS) > limit) limit = call + BigInt(GRACE_MS);
  if (silent <= limit) return;
  busy = true;
  try {
    const n = Number(Atomics.load(slots, EVENTS)) + 1;
    const dir = join(runDir, `pid${pid}-ev${n}`);
    mkdirSync(dir, { recursive: true });
    const len = Number(Atomics.load(slots, FILE_LEN));
    const summary = {
      file: len > 0 ? new TextDecoder().decode(fileBytes.slice(0, len)) : "(before the first test file's hooks)",
      pid,
      silentMs: Number(silent),
      limitMs: Number(limit),
      children: [],
      killed: false,
      stacks: "pending",
      note: "a re-parented descendant is reached only through a detached child's process group; the CI job-level dump covers the rest",
      at: new Date().toISOString(),
    };
    episode = { beat, dir, summary, killed: false, lastTry: now };
    // The summary and the event count come FIRST, before even the `ps` listing (seconds under load). With no child to
    // kill, the main thread is running again and its afterEach may come next: it must already see the event to blame
    // the right test. A blocked thread with a child stays blocked until the kill, so it reads the final summary.
    // If the fork exits mid-dump, the summary still says what hung.
    writeSummary(dir, summary);
    Atomics.store(slots, EVENTS, BigInt(n));
    // The fork's own stacks first: the children are still hung, so this is the fork as it waited on them.
    writeFileSync(join(dir, `stacks-${pid}-fork.txt`), await stacks(pid));
    episode.killed = await dumpAndKill(episode);
    episode.lastTry = monoNow();
    summary.stacks = "written";
    writeSummary(dir, summary);
  } finally {
    busy = false;
  }
}

setInterval(() => {
  check().catch((e) => process.stderr.write(`sync-child watchdog: ${e?.stack ?? e}\n`));
}, pollMs);

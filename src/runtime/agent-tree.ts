import { execFile, spawnSync, type SpawnOptions } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { warn as ioWarn } from "../io.js";
import { TERMINATION_GRACE_MS, type TerminableAgent } from "../termination.js";

/**
 * Stopping a host agent stops everything it started.
 *
 * At `protocol` and `hostloop` the agent is a host process, and what it starts — Bash-tool shells and their
 * background jobs, hook commands, stdio MCP servers — are host processes too. Signalling the agent's pid
 * alone leaves all of them running (reparented to init, their process groups intact). Three layers find them:
 *
 *  - **The agent's own group.** The agent is spawned `detached` (its own session and process group, as
 *    Claude Desktop spawns it), so anything it starts without `detached` — MCP servers, hooks — shares that
 *    group and dies with one group signal, even after the agent itself has exited, as long as a member lives.
 *  - **The descendant walk.** One `ps` listing, a tree built in JS, walked from the agent and from every
 *    process already tracked. It finds children that made their own group (the Bash tool spawns its shell
 *    `detached`) and signals each one's group, so the shell's later children go with it. Tracked entries are
 *    identities — `(pid, start time)` — never bare pids: an entry whose start time changed is a recycled pid,
 *    and is dropped rather than walked or signalled.
 *  - **The orphan sweep.** A Bash call like `sleep 999 &` leaves the `sleep` reparented to init within
 *    milliseconds, before any walk can see it. Ancestry cannot attribute it, so the sweep attributes by what
 *    the orphan still carries. Linux: the run's `COWORK_HARNESS_RUN_TAG=<token>` in `/proc/<pid>/environ`
 *    (the cwd is never consulted there). macOS, which exposes no other process's environment: same uid ∧
 *    ppid 1 ∧ no controlling tty ∧ started during this run ∧ cwd under this run's work dir ∧ not the harness
 *    or its ancestry — each clause excludes a class of bystander (a terminal job, a pre-existing daemon, the
 *    operator's shell). Every sweep kill prints a `::warning::` line; `COWORK_HARNESS_NO_ORPHAN_SWEEP=1` turns
 *    the sweep off. Known misses: a macOS orphan that left the work dir, a Linux process started with a
 *    scrubbed env (`env -i`, `sudo`). Known wrong kill: a tmux/screen server started during the run from
 *    inside the work dir.
 *
 * Never signalled: pgid ≤ 1, the harness's own pid/pgid, or any pid/pgid in its ancestry (all read from the
 * same listing — Node has no `getpgid`). A tracked process that shares one of those groups is killed by pid.
 *
 * Without `detached` (Windows) the agent is signalled by pid only and nothing is listed.
 */

export const AGENT_DETACHED = process.platform !== "win32";

/**
 * The env key that marks every process started under one run. It rides into the Bash tool's children because
 * the staged agent builds that env from its own `process.env` minus a denylist (agent 2.1.284: the Bash spawn's
 * `env:MEr({…})` at byte 185644921 of the native binary spreads `hs()`, which returns `process.env` or a copy
 * of it with credential-shaped names deleted — `hs` exported from the chunk at byte 178942949). That denylist
 * matches names containing TOKEN, KEY, SECRET, AUTH, PAT, PASSWORD, CREDENTIAL, COOKIE, DSN, WEBHOOK, JWT and
 * similar, so this name must never contain one of those words, or the agent deletes it from every Bash child.
 */
export const RUN_TAG_ENV = "COWORK_HARNESS_RUN_TAG";
export const NO_ORPHAN_SWEEP_ENV = "COWORK_HARNESS_NO_ORPHAN_SWEEP";

/**
 * The synchronous listing (at construction, on a `result` frame, and in every terminate/force-kill except a
 * second signal's) is what the stop acts on: when it fails, the stop falls back to an earlier listing and a
 * process started since then can survive. `ps -A` has been measured at 1.4–2.4 s on a loaded Mac with ~1,300
 * processes, so the limit is 10 s — about four times that — and a listing that timed out is taken once more.
 * The listing runs before the grace period starts, so it never shortens the Desktop-matched settle and grace
 * windows; it does delay the start of the stop by that long.
 */
const PS_SYNC_TIMEOUT_MS = 10_000;
const PS_SYNC_ATTEMPTS = 2;
/** The drive loop's asynchronous refresh keeps a short limit. A refresh that times out is harmless — the next
 *  synchronous listing covers it — and refreshes are throttled, not serialized, so a long limit would let
 *  overlapping `ps -A` runs pile up under exactly the load that makes them slow. */
const PS_ASYNC_TIMEOUT_MS = 2000;
const LSOF_TIMEOUT_MS = 2000;
/** tool_result frames refresh at most this often; a `result` frame always refreshes. */
const REFRESH_MIN_INTERVAL_MS = 250;

/** The spawn options every host agent spawn goes through: its own session (for the group kill) and the run tag (for the orphan sweep). */
export function agentSpawnOptions<T extends SpawnOptions>(opts: T, runTag: string): T & { detached: boolean; env: NodeJS.ProcessEnv } {
  return { ...opts, detached: AGENT_DETACHED, env: { ...(opts.env ?? process.env), [RUN_TAG_ENV]: runTag } };
}

/** The tiers whose agent the termination handler stops (SIGTERM, grace, force-kill). `container` is not one:
 *  its agent lives in the container's pid namespace, which the container-phase thunk's `docker rm -f` ends. */
export function handlerOwnsAgent(fidelity: string): boolean {
  return fidelity === "protocol" || fidelity === "hostloop" || fidelity === "microvm";
}

/**
 * How long a host agent gets to stop, matching Claude Desktop's own agent stop: wait up to 2 s for it to exit
 * on its own, then SIGTERM, then SIGKILL its process group after a grace period — 5 s in Desktop, used at
 * hostloop. `protocol` has no Desktop counterpart and keeps the handler's default grace.
 */
export function hostAgentStopTiming(fidelity: string): { settleMs: number; graceMs: number } {
  return { settleMs: 2000, graceMs: fidelity === "hostloop" ? 5000 : TERMINATION_GRACE_MS };
}

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** The controlling terminal; undefined when the process has none. */
  tty: string | undefined;
  /** Start time, epoch ms (whole seconds — `ps` reports no finer). */
  start: number;
  comm: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o lstart` under `LC_ALL=C`, identical on macOS and procps: `Wed Sep 30 12:53:45 2026`, local time. */
function parseLstart(tokens: string[]): number | undefined {
  const [, mon, day, hms, year] = tokens;
  const m = MONTHS.indexOf(mon ?? "");
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(hms ?? "");
  if (m < 0 || !t || !/^\d{1,2}$/.test(day ?? "") || !/^\d{4}$/.test(year ?? "")) return undefined;
  return new Date(Number(year), m, Number(day), Number(t[1]), Number(t[2]), Number(t[3])).getTime();
}

/** Parse `ps -A -o pid=,ppid=,pgid=,uid=,tty=,lstart=,comm=`. `lstart` is five tokens and `comm` may hold
 *  spaces, so `comm` is last and takes the rest of the line. Unparseable lines are dropped. */
export function parsePsSnapshot(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const tok = line.trim().split(/\s+/);
    if (tok.length < 11) continue;
    const [pid, ppid, pgid, uid] = tok.slice(0, 4).map(Number);
    const start = parseLstart(tok.slice(5, 10));
    if (![pid, ppid, pgid, uid].every(Number.isInteger) || start === undefined) continue;
    const tty = tok[4] === "?" || tok[4] === "??" || tok[4] === "-" ? undefined : tok[4];
    rows.push({ pid, ppid, pgid, uid, tty, start, comm: tok.slice(10).join(" ") });
  }
  return rows;
}

/** Parse `lsof -Fpn` output: `p<pid>` opens a process, `n<path>` is the (cwd) file's name. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined && Number.isInteger(pid)) out.set(pid, line.slice(1));
  }
  return out;
}

/** Everything the tree agent touches outside itself — injected so every predicate is testable against a
 *  fixed process table with a recording `kill`. */
export interface AgentTreeDeps {
  platform: NodeJS.Platform;
  detach: boolean;
  selfPid: number;
  uid: number;
  env: NodeJS.ProcessEnv;
  now(): number;
  /** One consistent process listing, or undefined when `ps` failed. Synchronous: for the signal handler and
   *  the teardown, which must not yield. */
  snapshot(): ProcRow[] | undefined;
  /** The same listing without blocking the event loop — the drive loop's per-frame refresh. */
  snapshotAsync(): Promise<ProcRow[] | undefined>;
  /** `process.kill`; a negative target is a process group. Must not throw. */
  kill(target: number, sig: NodeJS.Signals): void;
  lsofCwd(pids: number[]): Map<number, string> | { error: string };
  procPids(): number[];
  procEnviron(pid: number): string | undefined;
  realpath(p: string): string;
  warn(msg: string): void;
}

const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,uid=,tty=,lstart=,comm="];
const PS_ENV = () => ({ ...process.env, LC_ALL: "C" });
const PS_MAX_BUFFER = 16 * 1024 * 1024;

/** One synchronous process listing, or undefined when `ps` failed. A listing that timed out is taken again,
 *  `attempts` times in all; any other failure (a non-zero exit, a missing `ps`, a `ps` killed by a signal —
 *  a terminal Ctrl-C reaches it too) is not retried. `ps` is overridable for tests. */
export function listProcessesSync(o: { timeoutMs?: number; attempts?: number; ps?: string } = {}): ProcRow[] | undefined {
  const attempts = Math.max(1, o.attempts ?? PS_SYNC_ATTEMPTS);
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync(o.ps ?? "ps", PS_ARGS, {
      encoding: "utf8",
      timeout: o.timeoutMs ?? PS_SYNC_TIMEOUT_MS,
      env: PS_ENV(),
      maxBuffer: PS_MAX_BUFFER,
    });
    if (!r.error && r.status === 0 && typeof r.stdout === "string") return parsePsSnapshot(r.stdout);
    if ((r.error as NodeJS.ErrnoException | undefined)?.code !== "ETIMEDOUT") return undefined;
  }
  return undefined;
}

function defaultDeps(): AgentTreeDeps {
  return {
    platform: process.platform,
    detach: AGENT_DETACHED,
    selfPid: process.pid,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    env: process.env,
    now: () => Date.now(),
    snapshot: () => listProcessesSync(),
    snapshotAsync: () =>
      new Promise((res) =>
        execFile(
          "ps",
          PS_ARGS,
          { encoding: "utf8", timeout: PS_ASYNC_TIMEOUT_MS, env: PS_ENV(), maxBuffer: PS_MAX_BUFFER },
          (err, stdout) => res(err ? undefined : parsePsSnapshot(stdout)),
        ),
      ),
    kill: (target, sig) => {
      try {
        process.kill(target, sig);
      } catch {
        /* ESRCH: already gone; EPERM: not ours to signal */
      }
    },
    lsofCwd: (pids) => {
      // -b: no blocking kernel calls (a stale network-mounted cwd would otherwise hang it); -w: no warnings.
      // A non-zero exit is normal here (lsof exits 1 when a listed pid has already exited), so only a spawn
      // failure or a timeout counts as failing.
      const r = spawnSync("lsof", ["-b", "-w", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], {
        encoding: "utf8",
        timeout: LSOF_TIMEOUT_MS,
      });
      if (r.error) return { error: r.error.message };
      if (r.signal) return { error: `lsof ended by ${r.signal}` };
      return parseLsofCwd(r.stdout ?? "");
    },
    procPids: () => {
      try {
        return readdirSync("/proc")
          .filter((n) => /^\d+$/.test(n))
          .map(Number);
      } catch {
        return [];
      }
    },
    procEnviron: (pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "utf8");
      } catch {
        return undefined; // ESRCH / EACCES (another uid) — not attributable, not ours
      }
    },
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
    warn: (m) => ioWarn(m),
  };
}

/** The harness itself and its ancestry, from one listing. `known` is false when the harness is not in it —
 *  its group is then unknown, and every kill falls back to pids. */
function harnessGuard(rows: ProcRow[], selfPid: number): { pids: Set<number>; pgids: Set<number>; known: boolean } {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const pids = new Set<number>([0, 1, selfPid]);
  const pgids = new Set<number>([0, 1]);
  let cur = byPid.get(selfPid);
  const known = cur !== undefined;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    pids.add(cur.pid);
    pgids.add(cur.pgid);
    if (cur.ppid <= 1) break;
    cur = byPid.get(cur.ppid);
  }
  return { pids, pgids, known };
}

export interface AgentTreeOptions {
  /** This run's tag value (the env var's value in the agent's env). */
  runTag: string;
  /** When the run started; the macOS sweep ignores anything that started earlier. */
  runStartMs: number;
  /** The run's work dir — the macOS sweep's cwd root. Omitted at hostloop, whose Bash runs in the sidecar
   *  and whose host agent sits outside the session tree. */
  workDir?: string;
  /** SIGTERM-to-SIGKILL grace for this agent (see {@link hostAgentStopTiming}). */
  graceMs?: number;
}

interface ChildLike {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | string | null;
  kill(sig?: NodeJS.Signals): boolean;
  once(event: "exit", fn: (...a: unknown[]) => void): unknown;
  stdin?: { end(): unknown } | null;
}

export interface TreeAgent extends TerminableAgent {
  readonly unconditionalForceKill: true;
  readonly graceMs?: number;
  /** Re-list processes and extend the tracked set from the agent and every tracked process still alive. */
  refresh(): void;
  /** Feed a parsed stream-json frame from the drive loop; refreshes on `result` and `tool_result` frames,
   *  asynchronously (see {@link idle}). */
  onFrame(msg: unknown): void;
  /** Resolves when the last asynchronous refresh has landed. */
  idle(): Promise<void>;
}

/** Frames that mark a point where the agent may have started (or be about to reap) a process. Partial-message
 *  `stream_event` frames never count — they arrive many times a second.
 *  A `tool_result` refresh cannot see a `(sleep &)` orphan (it is reparented before the result arrives) —
 *  that is the orphan sweep's job; this cadence exists for MCP servers and the shells of long-running tool calls. */
function isRefreshFrame(msg: unknown): boolean {
  const m = msg as { type?: unknown; message?: { content?: unknown } } | null;
  if (!m || typeof m !== "object") return false;
  if (m.type === "result") return true;
  if (m.type !== "user" || !Array.isArray(m.message?.content)) return false;
  return (m.message.content as Array<{ type?: unknown } | null>).some((b) => b?.type === "tool_result");
}

/** Wrap a host agent child so the termination handler and the teardown stop its whole process tree. */
export function agentTreeAgent(child: ChildLike, opts: AgentTreeOptions, deps: Partial<AgentTreeDeps> = {}): TreeAgent {
  const d: AgentTreeDeps = { ...defaultDeps(), ...deps };
  const running = () => child.exitCode === null && child.signalCode === null;
  const exited = new Promise<void>((res) => {
    if (!running()) return res();
    child.once("exit", () => res());
  });
  const signalLeader = (sig: NodeJS.Signals) => {
    try {
      if (running()) child.kill(sig);
    } catch {
      /* already gone */
    }
  };

  if (!d.detach) {
    // Windows: no process groups to signal and no `ps`; the agent alone, by pid.
    return {
      unconditionalForceKill: true,
      graceMs: opts.graceMs,
      alive: running,
      terminate: () => signalLeader("SIGTERM"),
      forceKill: () => signalLeader("SIGKILL"),
      exited: () => exited,
      refresh: () => {},
      idle: () => Promise.resolve(),
      onFrame: () => {},
    };
  }

  const tracked = new Map<number, { start: number }>();
  let lastRows: ProcRow[] | undefined;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  const isTracked = (r: ProcRow) => tracked.get(r.pid)?.start === r.start;

  const extend = (rows: ProcRow[]) => {
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    // Identity check: a tracked pid that is gone, or back with another start time, is not ours any more.
    for (const [pid, id] of tracked) if (byPid.get(pid)?.start !== id.start) tracked.delete(pid);
    // The leader is ours while it runs: an unreaped child's pid cannot be reused.
    const leader = child.pid !== undefined ? byPid.get(child.pid) : undefined;
    if (leader && running()) tracked.set(leader.pid, { start: leader.start });
    const kids = new Map<number, ProcRow[]>();
    for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
    const guard = harnessGuard(rows, d.selfPid);
    const queue = [...tracked.keys()];
    while (queue.length) {
      const pid = queue.shift()!;
      for (const k of kids.get(pid) ?? []) {
        if (guard.pids.has(k.pid) || isTracked(k)) continue;
        tracked.set(k.pid, { start: k.start });
        queue.push(k.pid);
      }
    }
  };

  // Asynchronous refreshes (the drive loop's) apply only if they are the newest one started and no
  // synchronous listing was taken since they began — an older listing must never prune what a newer one saw.
  let syncListings = 0;
  let asyncGen = 0;
  let inflight: Promise<void> = Promise.resolve();
  const refreshAsyncAt = (t: number) => {
    lastRefreshAt = t;
    const gen = ++asyncGen;
    const syncAtStart = syncListings;
    inflight = d
      .snapshotAsync()
      .then((rows) => {
        if (!rows || gen !== asyncGen || syncListings !== syncAtStart) return;
        lastRows = rows;
        extend(rows);
      })
      .catch(() => {
        /* a failed listing leaves the tracked set as it was; the teardown's own listing warns if it fails */
      });
  };

  /** Returns false when `ps` failed (the tracked set is then whatever the last listing gave). */
  const refreshAt = (t: number): boolean => {
    lastRefreshAt = t;
    syncListings++;
    const rows = d.snapshot();
    if (!rows) return false;
    lastRows = rows;
    extend(rows);
    return true;
  };

  // A stop that cannot list processes must say so: the run would otherwise end looking clean while what the
  // agent started keeps running. Once per agent.
  let listingWarned = false;
  const warnNoListing = () => {
    if (listingWarned) return;
    listingWarned = true;
    d.warn(
      lastRows
        ? `::warning:: [teardown] could not list processes (ps failed); stopping what the agent started from an earlier listing — a process it started since then may keep running\n`
        : `::warning:: [teardown] could not list processes (ps failed); stopping the agent by pid only — processes it started may keep running\n`,
    );
  };

  /** Signal every tracked, still-identical process: by group when that is safe, else by pid. Returns the pids
   *  the signal reached (for the sweep, so it does not report them again). */
  const signalTracked = (rows: ProcRow[], sig: NodeJS.Signals): Set<number> => {
    const guard = harnessGuard(rows, d.selfPid);
    const groups = new Set<number>();
    const pids = new Set<number>();
    for (const r of rows) {
      if (!isTracked(r) || guard.pids.has(r.pid)) continue;
      if (!guard.known || r.pgid <= 1 || guard.pgids.has(r.pgid)) pids.add(r.pid);
      else groups.add(r.pgid);
    }
    for (const g of groups) d.kill(-g, sig);
    for (const p of pids) d.kill(p, sig);
    const reached = new Set<number>(pids);
    for (const r of rows) if (groups.has(r.pgid)) reached.add(r.pid);
    return reached;
  };

  const killLine = (pid: number, comm: string, where: string) =>
    d.warn(`::warning:: [teardown] orphan sweep killed pid ${pid} (${comm}) ${where}\n`);

  const sweep = (rows: ProcRow[], reached: Set<number>, fast: boolean) => {
    if (d.env[NO_ORPHAN_SWEEP_ENV] === "1") return;
    const guard = harnessGuard(rows, d.selfPid);
    const skip = (pid: number) => guard.pids.has(pid) || reached.has(pid);
    if (d.platform === "linux") {
      // Env tag only. The cwd is never consulted here: without the tag nothing marks a process as this run's.
      const needle = `${RUN_TAG_ENV}=${opts.runTag}`;
      const comm = new Map(rows.map((r) => [r.pid, r.comm]));
      for (const pid of d.procPids()) {
        if (skip(pid)) continue;
        const environ = d.procEnviron(pid);
        if (!environ || !environ.split("\0").includes(needle)) continue;
        d.kill(pid, "SIGKILL");
        killLine(pid, comm.get(pid) ?? "?", `(it carried this run's ${RUN_TAG_ENV})`);
      }
      return;
    }
    if (d.platform !== "darwin" || !opts.workDir) return;
    const since = Math.floor(opts.runStartMs / 1000) * 1000; // `lstart` has whole seconds
    const candidates = rows.filter(
      (r) =>
        r.uid === d.uid &&
        r.ppid === 1 &&
        r.tty === undefined &&
        r.start >= since &&
        !guard.pgids.has(r.pgid) &&
        !skip(r.pid) &&
        !isTracked(r),
    );
    if (!candidates.length) return;
    if (fast) {
      // A second signal promises an immediate exit; lsof can take seconds.
      d.warn(`::warning:: [teardown] orphan sweep skipped on the second signal: ${candidates.length} candidate(s) not checked\n`);
      return;
    }
    const cwds = d.lsofCwd(candidates.map((r) => r.pid));
    if (!(cwds instanceof Map)) {
      d.warn(`::warning:: [teardown] orphan sweep skipped: could not read process cwds (${cwds.error})\n`);
      return;
    }
    const root = d.realpath(opts.workDir);
    for (const r of candidates) {
      const cwd = cwds.get(r.pid);
      if (cwd === undefined) continue;
      const real = d.realpath(cwd);
      if (real !== root && !real.startsWith(root + sep)) continue;
      d.kill(r.pid, "SIGKILL");
      killLine(r.pid, r.comm, `cwd=${cwd}`);
    }
  };

  // Capture the leader's own identity now, while it is certainly ours.
  if (child.pid !== undefined) refreshAt(d.now());

  return {
    unconditionalForceKill: true,
    graceMs: opts.graceMs,
    alive: running,
    exited: () => exited,
    idle: () => inflight,
    refresh: () => refreshAt(d.now()),
    onFrame: (msg) => {
      if (!isRefreshFrame(msg)) return;
      const t = d.now();
      // A `result` frame is never throttled: it is the last listing before the agent exits on the normal path,
      // when everything it started is about to be reparented out of reach of the walk.
      if ((msg as { type?: unknown }).type === "result") {
        // Synchronous, once per turn: this listing must be taken before the agent exits and its children are
        // reparented out of the walk's reach, and an asynchronous `ps` would race that exit.
        refreshAt(t);
        return;
      }
      if (t - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return;
      // tool_result frames come many times a turn: list without blocking the event loop.
      refreshAsyncAt(t);
    },
    terminate: () => {
      if (!refreshAt(d.now())) warnNoListing();
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      const reached = lastRows ? signalTracked(lastRows, "SIGTERM") : new Set<number>();
      if (child.pid === undefined || !reached.has(child.pid)) signalLeader("SIGTERM");
    },
    // Unconditional: it runs whether or not the leader is alive, because what it exists to reach — the tracked
    // groups and the orphans — outlives the leader. A second signal passes `fast` and reuses the last listing.
    forceKill: (o?: { fast?: boolean }) => {
      if (!o?.fast && !refreshAt(d.now())) warnNoListing();
      const rows = lastRows;
      if (rows) {
        const reached = signalTracked(rows, "SIGKILL");
        sweep(rows, reached, !!o?.fast);
      }
      signalLeader("SIGKILL");
    },
  };
}

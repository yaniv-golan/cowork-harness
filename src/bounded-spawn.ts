// A bounded child process: argv only (never a shell), a wall-clock timeout and byte caps, each of which SIGKILLs the
// child's whole process GROUP (the child is spawned `detached`, so a wrapper and everything it started die together;
// killing only the top pid can leave the real worker alive). It never throws on a nonzero exit: the caller decides
// what a failed run means.
//
// Two capture modes:
//   - `combinedMax`: ONE budget over stdout + stderr together (critique's turn spawn);
//   - `stdoutMax` + `stderrDrainMax`: stdout has its own cap (overflow kills), while stderr is drained and never
//     kills — only its first `stderrDrainMax` bytes are kept (a command metric: a script that warns once per odd
//     event must not lose its measurement, since that penalty would land on the arm with more odd events).
//
// Not promised: a grandchild that called setsid() has left the group and survives the kill.
import { spawn } from "node:child_process";

/** Every outstanding child's pid (its own group id), so an entry path's signal handler can kill them all. */
export const outstandingChildPids = new Set<number>();

export interface BoundedSpawnOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  combinedMax?: number;
  stdoutMax?: number;
  stderrDrainMax?: number;
}

export interface BoundedSpawnResult {
  stdout: Buffer;
  stderr: Buffer;
  /** null when the child was killed (timeout, cap) or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Which cap killed the group, if any. */
  truncated: false | "stdout" | "combined";
  /** The spawn itself failed (a missing binary): its message. */
  spawnError?: string;
}

export function killGroup(pid: number | undefined, kill: (sig: NodeJS.Signals) => void): void {
  try {
    if (pid) process.kill(-pid, "SIGKILL");
    else kill("SIGKILL");
  } catch {
    try {
      kill("SIGKILL"); // not our own group leader (already reaped, or non-POSIX)
    } catch {
      /* already gone */
    }
  }
}

export function boundedSpawnBuffers(cmd: string, args: readonly string[], o: BoundedSpawnOptions): Promise<BoundedSpawnResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      shell: false,
      ...(o.env !== undefined ? { env: o.env } : {}),
      ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    });
    if (child.pid) outstandingChildPids.add(child.pid);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated: BoundedSpawnResult["truncated"] = false;
    let spawnError: string | undefined;
    let settled = false;
    const kill = () => killGroup(child.pid, (s) => child.kill(s));
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return; // a killed child can still emit a trailing close/error; only the first result counts
      settled = true;
      clearTimeout(timer);
      if (child.pid) outstandingChildPids.delete(child.pid);
      resolvePromise({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        code,
        signal,
        timedOut,
        truncated,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(null, null);
    }, o.timeoutMs);
    /** Keep exactly the bytes that fit; past the cap, kill (or, for a drained stream, drop). */
    const take = (d: Buffer, used: number, max: number, sink: Buffer[]): number => {
      const room = Math.max(0, max - used);
      if (room > 0) sink.push(d.length <= room ? d : d.subarray(0, room));
      return used + d.length;
    };
    child.stdout.on("data", (d: Buffer) => {
      if (settled) return;
      if (o.combinedMax !== undefined) {
        const before = outBytes + errBytes;
        outBytes = take(d, before, o.combinedMax, out) - errBytes;
        if (outBytes + errBytes > o.combinedMax) {
          truncated = "combined";
          kill();
          finish(null, null);
        }
        return;
      }
      outBytes = take(d, outBytes, o.stdoutMax ?? Infinity, out);
      if (o.stdoutMax !== undefined && outBytes > o.stdoutMax) {
        truncated = "stdout";
        kill();
        finish(null, null);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (settled) return;
      if (o.combinedMax !== undefined) {
        const before = outBytes + errBytes;
        errBytes = take(d, before, o.combinedMax, err) - outBytes;
        if (outBytes + errBytes > o.combinedMax) {
          truncated = "combined";
          kill();
          finish(null, null);
        }
        return;
      }
      errBytes = take(d, errBytes, o.stderrDrainMax ?? Infinity, err); // drained: never kills
    });
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      spawnError = String(e);
      finish(null, null);
    });
  });
}

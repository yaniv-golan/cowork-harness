import { mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * A `DecisionChannel` is the wire the `ExternalDecider` talks over: it writes one request line and
 * reads one response line. Two implementations share the exact same protocol — only the endpoint
 * differs:
 *
 *  - `spawnChannel(cmd)` — a helper spawned ONCE (for `--decider-cmd`). We pipe each request to its
 *    stdin and read the answer from its stdout. For custom answer logic; runs to completion in one shot.
 *  - `fileChannel(dir)` — a file rendezvous (for `--decider-dir`). The driving agent answers each gate
 *    in-band via a Monitor on the dir. See `streamGates`/`answerGate` (the `gates`/`answer` commands).
 * All keep the CLI's stdout FREE (the protocol is on the helper's pipes / on disk), so they compose
 * with `--output-format json`. (The old `stdioChannel` — CLI's own stdout/stdin — was removed: `--decider-dir`
 * subsumes it and doesn't seize stdout.)
 */
export interface DecisionChannel {
  write(line: string): void;
  readLine(): Promise<string | null>;
  close?(): void;
  /** Copy the gate wire shapes (req/resp/.done) into `destDir` so they survive `close()`'s cleanup —
   *  the forensic evidence you want after a gate bug (Part 4). Only `fileChannel` has files to snapshot. */
  snapshot?(destDir: string): void;
}

/** A sequential line reader over a stream that buffers across chunk boundaries (readline does this). */
function lineReader(input: Readable): { next: () => Promise<string | null>; close: () => void } {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const queue: string[] = [];
  const waiters: ((v: string | null) => void)[] = [];
  let done = false;
  rl.on("line", (l) => (waiters.length ? waiters.shift()!(l) : queue.push(l)));
  rl.on("close", () => {
    done = true;
    while (waiters.length) waiters.shift()!(null);
  });
  return {
    next: () =>
      new Promise<string | null>((resolve) => {
        if (queue.length) return resolve(queue.shift()!);
        if (done) return resolve(null);
        waiters.push(resolve);
      }),
    close: () => rl.close(),
  };
}

const REQ = /^req-\d+\.json$/;
const RESP = /^resp-\d+\.json$/;
const seqOf = (f: string) => Number(f.match(/-(\d+)\.json/)?.[1] ?? 0);

/** Write the run-complete marker so a `gates --follow` watcher emits an explicit `{done:true}` and exits
 *  (resolves "silence is ambiguous"). Idempotent + sync (safe from a process exit handler). */
export function writeDoneMarker(dir: string): void {
  try {
    if (!existsSync(join(dir, "done.json"))) writeFileSync(join(dir, "done.json"), JSON.stringify({ done: true }) + "\n");
  } catch {
    /* dir may be gone */
  }
}

/**
 * The gate stream behind `cowork-harness gates <dir> --follow` — the harness OWNS the watcher so the
 * driving agent points ONE Monitor at this instead of hand-writing a zsh-safe find/seen-set/poll loop.
 * Emits one clean single-line JSON per NEW pending gate (`{seq, ...decision_request}`) and a terminal
 * `{"done":true}` when the run finishes. Resolves when done (or after one pass if `once`).
 */
export function streamGates(dir: string, write: (line: string) => void, opts: { pollMs?: number; once?: boolean } = {}): Promise<void> {
  const pollMs = opts.pollMs ?? (Number(process.env.COWORK_HARNESS_DECIDER_DIR_POLL_MS) || 500);
  const seen = new Set<string>();
  const tries = new Map<string, number>(); // per-file parse attempts — bound retries so a corrupt file drops loud
  return new Promise<void>((resolve) => {
    const tick = () => {
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        /* not created yet */
      }
      for (const f of files.filter((x) => REQ.test(x)).sort((a, b) => seqOf(a) - seqOf(b))) {
        if (seen.has(f)) continue;
        try {
          const body = readFileSync(join(dir, f), "utf8").trim();
          const parsed = JSON.parse(body);
          seen.add(f); // only mark consumed AFTER a clean parse — a mid-write is retried next tick
          write(JSON.stringify({ seq: seqOf(f), ...parsed }));
        } catch {
          // A transient mid-write is retried next tick; a PERSISTENTLY corrupt file would otherwise be
          // retried forever — bound it, then drop loud so the gap is visible (not a silent false-negative).
          const n = (tries.get(f) ?? 0) + 1;
          tries.set(f, n);
          if (n >= 3) {
            seen.add(f);
            process.stderr.write(`::warning:: [gates] ${f} is unreadable/malformed after ${n} tries — dropping\n`);
          }
        }
      }
      if (existsSync(join(dir, "done.json"))) {
        write(JSON.stringify({ done: true }));
        return resolve();
      }
      if (opts.once) return resolve();
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/** Write a gate answer atomically (temp+rename) with the right wire shape — behind `cowork-harness
 *  answer`. Hides the atomic write + the `{id, answers}` shape the driver had to hand-build. */
export function answerGate(dir: string, seq: number, answers: Record<string, string>): void {
  let id: string | undefined;
  try {
    id = JSON.parse(readFileSync(join(dir, `req-${seq}.json`), "utf8")).id;
  } catch {
    /* req may already be consumed; id is optional */
  }
  const tmp = join(dir, `.resp-${seq}.json.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...(id ? { id } : {}), answers }), { mode: 0o600 });
  renameSync(tmp, join(dir, `resp-${seq}.json`));
}

/** Read a gate's request (for `answer` to map a `--choose` to the question text). */
export function readGate(
  dir: string,
  seq: number,
): { id?: string; questions?: { question?: string; header?: string; options?: { label?: string }[]; multiSelect?: boolean }[] } {
  return JSON.parse(readFileSync(join(dir, `req-${seq}.json`), "utf8"));
}

/**
 * Channel C: file rendezvous (`--decider-dir <dir>`). The decision_request is written to `<dir>/req-N.json`
 * and the harness blocks polling for `<dir>/resp-N.json`. The DRIVING Claude agent arms a Monitor on the
 * dir (each new req file → a task-notification that wakes it) and writes the answer file — answering the
 * LIVE AskUserQuestion in-band (no resume, no re-worded question). Strictly serial: write req-N, block for
 * resp-N, then req-(N+1) — one outstanding gate at a time. The wire protocol is identical to the other
 * channels (the same ExternalDecider drives it); only the transport differs.
 */
export function fileChannel(dir: string): DecisionChannel {
  mkdirSync(dir, { recursive: true });
  // H3: do NOT silently clear — fail loud if the dir already holds gate files (forces a fresh dir per run).
  const stale = readdirSync(dir).filter((f) => REQ.test(f) || RESP.test(f));
  if (stale.length)
    throw new Error(
      `--decider-dir ${dir} already has gate files (${stale.slice(0, 3).join(", ")}…) — use a fresh, empty directory per run`,
    );
  const pollMs = Number(process.env.COWORK_HARNESS_DECIDER_DIR_POLL_MS) || 300;
  const timeoutMs = Number(process.env.COWORK_HARNESS_DECIDER_DIR_TIMEOUT_MS) || 600_000; // 10-min backstop → loud UnansweredError
  let seq = 0;
  let lastSnapshotSeq = 0; // watermark so a per-scenario snapshot() copies ONLY that scenario's new gates
  // #49: store the handler so it can be removed on close() — otherwise repeated fileChannel() calls in
  // one process accumulate "exit" listeners (MaxListenersExceededWarning after >10 channels).
  // Guarantee a completion marker on EVERY exit path (success, fail()/process.exit, throw) so a
  // `gates --follow` watcher always gets its terminal {done:true} and never hangs.
  const exitHandler = () => writeDoneMarker(dir);
  process.on("exit", exitHandler);
  return {
    write: (line) => {
      seq++;
      // H1: `line` is single-line JSON (ExternalDecider) — one `cat` = one Monitor event. M2: 0600 (it's on disk).
      const tmp = join(dir, `.req-${seq}.json.tmp`);
      writeFileSync(tmp, line.replace(/\n/g, " ") + "\n", { mode: 0o600 });
      renameSync(tmp, join(dir, `req-${seq}.json`)); // atomic — the watcher never sees a partial file
      process.stderr.write(`[gate] req-${seq} emitted → waiting for resp-${seq}.json\n`); // O2: lifecycle on stderr (even under --output-format json)
    },
    readLine: async () => {
      const resp = join(dir, `resp-${seq}.json`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        // M3: the agent writes resp via temp+rename (atomic) → if it exists, it's complete. Read+parse ONCE
        // (a bad parse fails loud in ExternalDecider — no retry-then-hang).
        if (existsSync(resp)) {
          const body = readFileSync(resp, "utf8");
          // O4: mark the gate consumed — rename `req-N.json` out of the `req-*.json` glob so the watcher
          // can't re-emit it, and the consumed signal is visible mid-run (distinguishes a re-emit from a
          // genuine agent re-ask, O3).
          try {
            renameSync(join(dir, `req-${seq}.json`), join(dir, `req-${seq}.json.done`));
          } catch {
            /* best-effort */
          }
          process.stderr.write(`[gate] resp-${seq} consumed (gate answered)\n`);
          return body;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return null; // timeout → ExternalDecider throws UnansweredError (loud, never silent)
    },
    snapshot: (destDir) => {
      // Copy THIS scenario's gate wire shapes into the run dir so they survive close()'s cleanup (Part 4).
      // The channel is reused across scenarios in a `run <dir/>` loop (one monotonic seq), so copy only
      // files newer than the last snapshot — otherwise scenario N's snapshot would also contain 1..N-1's.
      try {
        const files = readdirSync(dir).filter(
          (f) => (REQ.test(f) || RESP.test(f) || f.endsWith(".json.done")) && seqOf(f) > lastSnapshotSeq,
        );
        if (files.length) {
          mkdirSync(destDir, { recursive: true });
          for (const f of files) writeFileSync(join(destDir, f), readFileSync(join(dir, f)));
        }
        lastSnapshotSeq = seq; // advance past this scenario's gates
      } catch {
        /* dir may be gone / nothing to snapshot */
      }
    },
    close: () => {
      // #49: remove the exit listener registered for this channel so repeated fileChannel() calls
      // in one process don't accumulate listeners past the MaxListenersExceededWarning threshold.
      process.removeListener("exit", exitHandler);
      // That exit listener was the only writer of done.json — a long-lived embedder that close()s but
      // keeps running must still release a `gates --follow` watcher. Write the marker here too (idempotent,
      // and not matched by the cleanup globs below, so it survives).
      writeDoneMarker(dir);
      // Best-effort remove processed files on close (req/resp + .done markers + tmp).
      try {
        for (const f of readdirSync(dir))
          if (REQ.test(f) || RESP.test(f) || f.startsWith(".req-") || f.endsWith(".json.done")) rmSync(join(dir, f), { force: true });
      } catch {
        /* dir may be gone */
      }
    },
  };
}

/** A helper spawned once (`shell:true` so `'python answerer.py'` works). Request→its stdin, answer←its stdout. */
export function spawnChannel(cmd: string): DecisionChannel {
  // #8: `shell: true` is INTENTIONAL, not an injection surface. `--decider-cmd` is OPERATOR-supplied —
  // the same trust class as the harness process itself (whoever runs the harness wrote this string). Shell
  // interpretation is the documented ergonomic so `'python answerer.py'`, pipelines, and env-var prefixes
  // all work as written. There is no untrusted input here to escape, so we deliberately do NOT parse to argv.
  const child: ChildProcess = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
  const reader = lineReader(child.stdout as Readable);
  // #53: bound the wait on the helper's stdout — a hung-but-alive helper would otherwise block the harness
  // forever (only fileChannel had a deadline; this mirrors its 10-min backstop). On expiry kill the child
  // (so a wedged process can't linger) and reject LOUD, never a silent hang.
  const timeoutMs = Number(process.env.COWORK_HARNESS_DECIDER_CMD_TIMEOUT_MS) || 600_000;
  let dead = false;
  child.on("exit", () => (dead = true));
  child.on("error", () => (dead = true));
  // A broken-pipe write does NOT throw synchronously — when the helper closes its read end, the EPIPE is
  // delivered ASYNCHRONOUSLY as an `error` event on stdin. Without a listener Node escalates it to an
  // uncaughtException (the cross-test "write EPIPE" flake). Handle it: mark dead so the next write()/
  // readLine() throws the clean "helper exited" error, and swallow the async event itself.
  child.stdin?.on("error", () => (dead = true));
  return {
    write: (line) => {
      if (dead) throw new Error(`--decider-cmd helper exited before answering`);
      try {
        child.stdin!.write(line + "\n"); // EPIPE if the helper died mid-run → surface as an error
      } catch {
        throw new Error(`--decider-cmd helper closed its input (EPIPE) before answering`);
      }
    },
    readLine: () => {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<string | null>((_, reject) => {
        timer = setTimeout(() => {
          if (!dead)
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          reject(new Error(`--decider-cmd helper timed out before answering after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      return Promise.race([reader.next(), timeout]).finally(() => clearTimeout(timer));
    },
    close: () => {
      reader.close();
      if (!dead)
        try {
          child.kill();
        } catch {
          /* already gone */
        }
    },
  };
}

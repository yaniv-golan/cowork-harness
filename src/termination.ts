import { constants } from "node:os";
import type { ChildProcess } from "node:child_process";
import { warn } from "./io.js";

/**
 * The ONE owner of SIGINT/SIGTERM (and SIGHUP, off Windows) for a harness process.
 *
 * Without an owner, Node's default applies — die by the signal — and on a signal death no `"exit"` hook runs:
 * the crash-safety sweep never marks the run `"error"` (status.json stays `"running"`), and a host agent the
 * harness spawned is never told to stop, so it can finish a paid turn after the harness is gone. The pieces
 * that DID listen (the egress cleanup, the `--decider-cmd` helper cleanup) each installed their own listener,
 * and the first one to call `process.exit` starved the rest. They now register here instead.
 *
 * On the first signal:
 *  1. pin the exit status to 128+signo (an `"exit"` listener, so it holds whichever path ends the process);
 *  2. run the `helpers` steps (SIGKILL every `--decider-cmd` helper group);
 *  3. ask every registered agent to terminate;
 *  4. wait until they have all exited, bounded by {@link TERMINATION_GRACE_MS} — IMMEDIATELY when there are
 *     none, so a Ctrl-C of a command with no agent (`decide`, `chat`, a post-run phase) is not delayed —
 *     then force-kill: every agent that declares `unconditionalForceKill` (a host agent's process tree, whose
 *     children outlive the leader — see `agent-tree.ts`), and any other agent still alive, including one
 *     registered during the wait;
 *  5. run the `egress` steps (container/network reaping);
 *  6. `process.exit(128 + signo)`, which runs every `"exit"` hook (status sweep, helper sweep, done markers).
 *
 * A second signal during the wait skips straight to force-kill + egress + exit, and passes `{ fast: true }` so
 * the force-kill reuses what it already knows instead of listing processes again.
 *
 * Leaf-ish on purpose (imports only `io.js`) so the egress, decider and run layers can all register here
 * without an import cycle. Installation is lazy and idempotent: nothing listens until a caller that owns
 * something to clean up asks for it.
 */

export const TERMINATION_GRACE_MS = 2000;

/** Something the harness spawned that must not outlive it. */
export interface TerminableAgent {
  /** Still running? A dead agent is skipped. */
  alive(): boolean;
  /** The polite request (SIGTERM, or the tier's equivalent). Must be synchronous and must not throw. */
  terminate(): void;
  /** The last resort (SIGKILL, or the tier's equivalent). Must be synchronous and must not throw. `fast`: a
   *  second signal is waiting on it — skip any work that is not the kill itself. */
  forceKill(opts?: { fast?: boolean }): void;
  /** Force-kill even when {@link alive} is false. For an agent whose process tree outlives its leader; left
   *  unset where the force-kill is expensive and pointless once the agent is gone (a guest-side VM kill). */
  readonly unconditionalForceKill?: boolean;
  /** How long to wait between terminate() and forceKill(); default {@link TERMINATION_GRACE_MS}. The handler
   *  waits the longest any pending agent asks for. */
  readonly graceMs?: number;
  /** Resolves when the agent has exited. */
  exited(): Promise<void>;
  /** Resolves when any background bookkeeping the force-kill depends on has landed (awaited by the async
   *  teardown; the signal handler, which cannot wait, uses what it has). */
  idle?(): Promise<void>;
}

/** The plain case: a child process signalled by PID alone. The host agents (protocol, hostloop) use
 *  `agentTreeAgent` instead, which also stops everything the agent started. */
export function childProcessAgent(child: ChildProcess): TerminableAgent {
  const running = () => child.exitCode === null && child.signalCode === null;
  const exited = new Promise<void>((res) => {
    if (!running()) return res();
    child.once("exit", () => res());
  });
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (running()) child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  return { alive: running, terminate: () => signal("SIGTERM"), forceKill: () => signal("SIGKILL"), exited: () => exited };
}

type Phase = "helpers" | "egress";
type Step = { phase: Phase; run: (sig: NodeJS.Signals) => void };

const agents = new Set<() => TerminableAgent | undefined>();
const steps = new Set<Step>();
let installed = false;
let terminating: NodeJS.Signals | undefined;
let finished = false;

/** Register a (lazily resolved) agent; returns the de-register function for the normal path. */
export function registerAgent(get: () => TerminableAgent | undefined): () => void {
  agents.add(get);
  return () => agents.delete(get);
}

/** Register a synchronous cleanup step for a phase; returns the de-register function. */
export function registerTerminationStep(phase: Phase, run: (sig: NodeJS.Signals) => void): () => void {
  const s: Step = { phase, run };
  steps.add(s);
  return () => steps.delete(s);
}

/** The signal being handled, once one has arrived. */
export function terminationRequested(): NodeJS.Signals | undefined {
  return terminating;
}

const INTERRUPTS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
/** Exit statuses a shell gives a child an interrupt killed. Not 129 (SIGHUP): git exits 129 on a usage error, and a
 *  hang-up kills a process by signal, which the signal check above already reads. */
const INTERRUPT_STATUSES: ReadonlyMap<number, NodeJS.Signals> = new Map([
  [130, "SIGINT"],
  [143, "SIGTERM"],
]);

/** The interrupt a synchronous child died of: killed by SIGINT, SIGTERM or SIGHUP, or exiting 130 or 143 (a shell's
 *  128 + signo). A terminal Ctrl-C signals the whole foreground group, so a child the harness is blocked on can die of
 *  it before the harness's own handler has run: its failure is that interrupt, not an error of its own. A child its
 *  own `timeout` killed (spawnSync sends SIGTERM and sets ETIMEDOUT) timed out: that is not an interrupt. */
export function childInterruptSignal(r: {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: unknown;
  code?: unknown;
}): NodeJS.Signals | undefined {
  const timedOut = r.code === "ETIMEDOUT" || (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (timedOut) return undefined;
  if (r.signal && INTERRUPTS.includes(r.signal)) return r.signal;
  return r.status === null ? undefined : INTERRUPT_STATUSES.get(r.status);
}

/** A step stopped because a child it waited on died of an interrupt (see {@link childInterruptSignal}). The CLI's
 *  top level turns it into {@link interrupt}, never an error exit. */
export class InterruptedError extends Error {
  constructor(
    readonly signal: NodeJS.Signals,
    what: string,
  ) {
    super(`${what} was interrupted (${signal})`);
    this.name = "InterruptedError";
  }
}

/** Handle `sig` as if it had arrived: the same stop-and-exit sequence, exit status 128 + signo. For a caller that
 *  learned of the interrupt from a child before the process's own signal was handled. */
export function interrupt(sig: NodeJS.Signals): void {
  onSignal(sig);
}

/** Called by a caller about to start new work (the next scenario, a cassette write) once the process is
 *  being terminated: never returns, because the handler owns the exit and fires within the grace period.
 *  Parking instead of throwing keeps a Ctrl-C from surfacing as a stack trace / `internal` error. */
export async function parkIfTerminating(): Promise<void> {
  if (terminating) await new Promise<never>(() => {});
}

function runSteps(phase: Phase, sig: NodeJS.Signals): void {
  for (const s of [...steps])
    if (s.phase === phase)
      try {
        s.run(sig);
      } catch {
        /* best-effort during teardown */
      }
}

function liveAgents(): TerminableAgent[] {
  const out: TerminableAgent[] = [];
  for (const get of agents) {
    let a: TerminableAgent | undefined;
    try {
      a = get();
    } catch {
      a = undefined;
    }
    if (a && a.alive()) out.push(a);
  }
  return out;
}

function registeredAgents(): TerminableAgent[] {
  const out: TerminableAgent[] = [];
  for (const get of agents) {
    try {
      const a = get();
      if (a) out.push(a);
    } catch {
      /* not resolvable — nothing to stop */
    }
  }
  return out;
}

function finish(sig: NodeJS.Signals, fast = false): void {
  if (finished) return;
  finished = true;
  for (const a of registeredAgents())
    try {
      if (a.unconditionalForceKill || a.alive()) a.forceKill(fast ? { fast: true } : undefined);
    } catch {
      /* best-effort during teardown */
    }
  runSteps("egress", sig);
  process.exit(128 + (constants.signals[sig] ?? 0));
}

function onSignal(sig: NodeJS.Signals): void {
  if (terminating) {
    // A second signal: stop waiting.
    finish(terminating, true);
    return;
  }
  terminating = sig;
  const code = 128 + (constants.signals[sig] ?? 0);
  process.on("exit", () => {
    process.exitCode = code;
  });
  if (holds.size) {
    warn(`::warning:: [interrupt] ${sig} — finishing the session's result first; press Ctrl-C again to exit now\n`);
    deferred = sig;
    return;
  }
  proceed(sig);
}

function proceed(sig: NodeJS.Signals): void {
  const pending = liveAgents();
  // Only when there is an agent to stop (the wait that follows is what the operator would otherwise stare
  // at). Without one the exit is immediate and the egress step prints its own line when it reaps anything —
  // an unconditional line also fired in every test worker torn down by SIGTERM.
  if (pending.length) warn(`::warning:: [interrupt] ${sig} — stopping the agent and cleaning up before exit\n`);
  runSteps("helpers", sig);
  if (!pending.length) return finish(sig);
  for (const a of pending) a.terminate();
  const graceMs = Math.max(...pending.map((a) => a.graceMs ?? TERMINATION_GRACE_MS));
  const grace = new Promise<void>((res) => setTimeout(res, graceMs));
  void Promise.race([Promise.all(pending.map((a) => a.exited())), grace]).then(() => finish(sig));
}

const holds = new Set<symbol>();
let deferred: NodeJS.Signals | undefined;

/**
 * Hold a FIRST signal's exit until the returned release is called — for a short stretch whose output would
 * be lost to an exit (`chat` writing the session's result after its last turn). The signal still pins the
 * exit status and prints a line; the stop-and-exit sequence runs at release. A second signal exits at once,
 * as everywhere else.
 */
export function holdExit(): () => void {
  const h = Symbol("hold");
  holds.add(h);
  return () => {
    if (!holds.delete(h) || holds.size || !deferred) return;
    const sig = deferred;
    deferred = undefined;
    proceed(sig);
  };
}

/** Install the handler (idempotent). Every caller that spawns something which must not outlive the
 *  process calls this before spawning it. */
export function installTerminationHandler(): void {
  if (installed) return;
  installed = true;
  // A hung-up terminal (SIGHUP) or a closed pipe fails every later write to stdout/stderr with EIO/EPIPE, and
  // an unhandled stream error kills the process on the first warning line — before the agent's grace period
  // and force-kill, leaving what the agent started running. Those two codes are not worth dying for while
  // this handler owns the exit; anything else stays fatal, as it was.
  for (const stream of [process.stdout, process.stderr])
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EIO" || e.code === "EPIPE") return;
      throw e;
    });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // The terminal closing: the host agent runs in its own session (see agent-tree.ts), so the hangup reaches
  // only the harness — which must pass it on as a stop, or the agent and its tree outlive the terminal.
  // Not on Windows, where Node emulates SIGHUP for a closed console window with a hard ~10 s kill deadline.
  if (process.platform !== "win32") process.on("SIGHUP", onSignal);
}

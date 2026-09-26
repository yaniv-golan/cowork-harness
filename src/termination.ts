import { constants } from "node:os";
import type { ChildProcess } from "node:child_process";
import { warn } from "./io.js";

/**
 * The ONE owner of SIGINT/SIGTERM for a harness process.
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
 *     then force-kill any survivor, including one registered during the wait;
 *  5. run the `egress` steps (container/network reaping);
 *  6. `process.exit(128 + signo)`, which runs every `"exit"` hook (status sweep, helper sweep, done markers).
 *
 * A second signal during the wait skips straight to force-kill + egress + exit.
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
  /** The last resort (SIGKILL, or the tier's equivalent). Must be synchronous and must not throw. */
  forceKill(): void;
  /** Resolves when the agent has exited. */
  exited(): Promise<void>;
}

/** The plain case: an agent that is a direct child process, signalled by PID (never by group — the
 *  protocol agent is not a group leader, so a group signal would miss it). */
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

function finish(sig: NodeJS.Signals): void {
  if (finished) return;
  finished = true;
  for (const a of liveAgents()) a.forceKill();
  runSteps("egress", sig);
  process.exit(128 + (constants.signals[sig] ?? 0));
}

function onSignal(sig: NodeJS.Signals): void {
  if (terminating) {
    // A second signal: stop waiting.
    finish(terminating);
    return;
  }
  terminating = sig;
  const code = 128 + (constants.signals[sig] ?? 0);
  process.on("exit", () => {
    process.exitCode = code;
  });
  const pending = liveAgents();
  // Only when there is an agent to stop (the wait that follows is what the operator would otherwise stare
  // at). Without one the exit is immediate and the egress step prints its own line when it reaps anything —
  // an unconditional line also fired in every test worker torn down by SIGTERM.
  if (pending.length) warn(`::warning:: [interrupt] ${sig} — stopping the agent and cleaning up before exit\n`);
  runSteps("helpers", sig);
  if (!pending.length) return finish(sig);
  for (const a of pending) a.terminate();
  const grace = new Promise<void>((res) => setTimeout(res, TERMINATION_GRACE_MS));
  void Promise.race([Promise.all(pending.map((a) => a.exited())), grace]).then(() => finish(sig));
}

/** Install the handler (idempotent). Every caller that spawns something which must not outlive the
 *  process calls this before spawning it. */
export function installTerminationHandler(): void {
  if (installed) return;
  installed = true;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

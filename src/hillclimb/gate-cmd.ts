// `hillclimb run --gate-cmd`: a verifier the operator names on the command line, run once per pass before any of the
// variant's reps is scheduled. It runs on a throwaway copy of the variant's plugin snapshot, so nothing it writes can
// change what the reps measure. It runs on this host with the operator's privileges and full environment.
//
// The harness sha pins the command's TEXT (as its hash), not the verifier's files: a command that runs tests inside the
// plugin runs whatever the loop last wrote there.

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The variables the gate gets beside the operator's environment. */
export const GATE_VARIANT_DIR_ENV = "COWORK_HARNESS_VARIANT_DIR";
export const GATE_VARIANT_ID_ENV = "COWORK_HARNESS_VARIANT_ID";

/** The most of the gate's combined stdout+stderr kept on a `gate_failed` row (its tail). */
export const GATE_TAIL_BYTES = 4096;

export interface GateResult {
  ok: boolean;
  /** The exit code, when the command exited. */
  code: number | null;
  /** The signal that ended it, when one did (a timeout's kill included). */
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** The last GATE_TAIL_BYTES of stdout+stderr, interleaved as written. */
  tail: string;
  wallS: number;
}

export type GateRunner = (o: { cmd: string; snapshot: string; variant: string; timeoutS: number }) => Promise<GateResult>;

/** Copy the snapshot to a fresh temp dir, run `sh -c <cmd>` there in its own process group, and remove the copy. At
 *  `timeoutS` the whole group is killed (SIGKILL) and the gate has failed. The copy keeps every symlink as written: a
 *  relative in-plugin link stays relative, so it cannot point back into the real snapshot. */
export const runGateCommand: GateRunner = async ({ cmd, snapshot, variant, timeoutS }) => {
  const root = mkdtempSync(join(tmpdir(), "cowork-harness-gate-"));
  const copy = join(root, "variant");
  const t0 = Date.now();
  try {
    cpSync(snapshot, copy, { recursive: true, verbatimSymlinks: true });
    return await new Promise<GateResult>((resolveGate) => {
      let buf = Buffer.alloc(0);
      const keep = (b: Buffer) => {
        buf = Buffer.concat([buf, b]);
        if (buf.length > GATE_TAIL_BYTES) buf = buf.subarray(buf.length - GATE_TAIL_BYTES);
      };
      const child = spawn("sh", ["-c", cmd], {
        cwd: copy,
        env: { ...process.env, [GATE_VARIANT_DIR_ENV]: copy, [GATE_VARIANT_ID_ENV]: variant },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let timedOut = false;
      let settled = false;
      // How the shell ended, once it has: `close` waits for the pipes too, which a descendant that left the process
      // group (setsid) can hold open forever. After the timeout's kill the gate resolves on `exit` instead.
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        if (exited) done(exited.code, exited.signal);
      }, timeoutS * 1000);
      const done = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // An escaped descendant may still hold the pipes: stop reading them, so nothing keeps this process alive.
        child.stdout.destroy();
        child.stderr.destroy();
        const tail = buf.toString("utf8") + (spawnError ? `${buf.length ? "\n" : ""}${spawnError.message}` : "");
        resolveGate({
          ok: !timedOut && !spawnError && code === 0,
          code,
          signal,
          timedOut,
          tail,
          wallS: Math.round((Date.now() - t0) / 100) / 10,
        });
      };
      child.on("error", (e) => done(null, null, e));
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        if (timedOut) done(code, signal);
      });
      child.on("close", (code, signal) => done(code, signal));
    });
  } finally {
    // A copy the gate made unremovable (a read-only dir) is a stray temp dir, never a reason to lose the gate's result.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* left in the temp dir */
    }
  }
};

/** The `error` text of a `gate_failed` row. */
export function gateFailureText(g: GateResult, timeoutS: number): string {
  // The shell had exited by itself before the deadline (the kill is SIGKILL, so a killed shell has no code); what timed
  // out was a descendant still holding its output.
  if (g.timedOut && g.code !== null)
    return `the gate exited ${g.code}, but a background process kept its output open until --gate-timeout (${timeoutS}s); no rep of this variant ran`;
  if (g.timedOut) return `the gate command timed out after ${timeoutS}s; no rep of this variant ran`;
  if (g.signal) return `the gate command was killed by ${g.signal}; no rep of this variant ran`;
  if (g.code === null) return `the gate command could not be started; no rep of this variant ran`;
  return `the gate command exited ${g.code}; no rep of this variant ran`;
}

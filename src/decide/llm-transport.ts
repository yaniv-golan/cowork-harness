import { spawn } from "node:child_process";
import type { Complete } from "./decider.js";

/**
 * The default `LlmDecider` transport: shell out to the host `claude -p` (one-shot, headless). Chosen
 * over a direct `POST /v1/messages` (Opus H1): the harness PROCESS is not behind the egress proxy
 * (only the spawned agent child is), so a direct API call would bypass the very allowlist the harness
 * enforces. `claude -p` reuses the run's own auth path and is dogfood-consistent. One short, tool-less
 * call per gate on a small model — bounded cost/latency, no recursion into the harness.
 */
export const claudeCliComplete: Complete = (prompt, model) =>
  new Promise<string>((resolve, reject) => {
    const bin = process.env.COWORK_HARNESS_CLAUDE_BIN || "claude";
    // #53: bound the `claude -p` spawn — a hung-but-alive child would otherwise block the harness forever.
    // On expiry SIGKILL the child and reject LOUD; clear the timer on close/error so a fast call never leaks it.
    const timeoutMs = Number(process.env.COWORK_HARNESS_LLM_TIMEOUT_MS) || 600_000;
    const child = spawn(bin, ["-p", prompt, "--model", model], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`LLM decider transport (${bin} -p) timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Bound stdout too — the wall-clock timeout above caps a fully-hung child, but not one that is
    // actively spewing. Past the cap, SIGKILL and reject loud rather than growing the buffer unbounded.
    const maxBytes = Number(process.env.COWORK_HARNESS_LLM_MAX_BYTES) || 8 * 1024 * 1024;
    let out = "";
    let bytes = 0;
    child.stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > maxBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        clearTimeout(timer);
        reject(new Error(`LLM decider transport (${bin} -p) exceeded ${maxBytes} bytes — aborting`));
        return;
      }
      out += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`LLM decider transport (${bin} -p) failed to spawn: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`LLM decider transport (${bin} -p) exited ${code}`));
    });
  });

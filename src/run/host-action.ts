// A multi-leg scenario's HOST ACTION: a command run between prompt legs in the leg runtime (no agent, no tokens).
//
// "The leg runtime" means the same image or rootfs, user, agent-visible paths, network policy and env as the agent
// that ran the leg before it — not the same process (that agent has exited):
//   - container: a named one-shot `docker run` of the agent image over the same session tree, on its own egress
//     sidecar with the leg's allowlist, reaped on timeout or interrupt;
//   - microvm:   `limactl shell` in the same guest, the same session root;
//   - protocol:  a host subprocess (this tier has no isolation to reproduce, and the docs say so first).
// The env is the agent's own (the same builder), minus the credentials. Never a shell string: argv elements only, with
// `{status.<field>}` substituted per element and the substituted values checked (no leading `-`, no `..`, length, and
// containment under the agent-visible session root for anything path-like).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, posix, isAbsolute, resolve, relative, sep } from "node:path";
import { containedRealPath } from "../boundary-paths.js";
import { compileUserRegex } from "../regex.js";
import { evaluate } from "../assert.js";
import { scrub } from "../secrets.js";
import type { Assertion } from "../types.js";
import type { HostAction, HostActionAssertion } from "./multi-leg-scenario.js";

/** Bytes of stdout/stderr kept from an action. The rest is counted, never stored. */
export const ACTION_OUTPUT_CAP = 1024 * 1024;
/** Bytes of each stream recorded in action.json (after scrubbing). */
export const ACTION_OUTPUT_HEAD = 4096;
const MAX_ARG_BYTES = 4096;
const STATUS_MAX_BYTES = 1024 * 1024;

export type StatusRead = { ok: true; status: Record<string, unknown> } | { ok: false; why: string };

/** Read the action's status file (a work-root-relative JSON object) and check its `expect`. Any failure fails the leg:
 *  absent, not a regular file, too large, not JSON, not an object, or a field that does not match. */
export function readActionStatus(workRoot: string, spec: NonNullable<HostAction["status"]>): StatusRead {
  const root = resolve(workRoot);
  const abs = isAbsolute(spec.artifact) ? undefined : resolve(root, spec.artifact);
  const rel = abs === undefined ? ".." : relative(root, abs);
  if (abs === undefined || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    return { ok: false, why: `status: ${spec.artifact} is not a path under the work root` };
  let text: string;
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return { ok: false, why: `status: ${spec.artifact} is not a regular file` };
    if (!containedRealPath(root, abs)) return { ok: false, why: `status: ${spec.artifact} resolves outside the work root` };
    if (st.size > STATUS_MAX_BYTES) return { ok: false, why: `status: ${spec.artifact} is larger than ${STATUS_MAX_BYTES} bytes` };
    text = readFileSync(abs, "utf8");
  } catch {
    return { ok: false, why: `status: ${spec.artifact} is absent` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `status: ${spec.artifact} is not valid JSON (${(e as Error).message})` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return { ok: false, why: `status: ${spec.artifact} is not a JSON object` };
  const status = doc as Record<string, unknown>;
  for (const [field, want] of Object.entries(spec.expect ?? {})) {
    const got = status[field];
    const notNull =
      want !== null && typeof want === "object" && (want as { not_null?: unknown }).not_null === true && Object.keys(want).length === 1;
    if (notNull ? got === null || got === undefined : JSON.stringify(got) !== JSON.stringify(want))
      return {
        ok: false,
        why: `status: ${spec.artifact} field "${field}" is ${JSON.stringify(got)}, expected ${notNull ? "a non-null value" : JSON.stringify(want)}`,
      };
  }
  return { ok: true, status };
}

const TEMPLATE = /\{status\.([A-Za-z0-9_]+)\}/g;

/** Substitute `{status.<field>}` into each argv element and check what was substituted. `sessionRoot` is the root of
 *  the agent-visible paths (`/sessions/<id>` in a sandbox, the host work dir on protocol): a substituted element that
 *  looks like a path must resolve under it. Literal authored text is not checked. */
export function resolveActionArgv(
  run: readonly string[],
  status: Record<string, unknown> | undefined,
  sessionRoot: string,
): { ok: true; argv: string[] } | { ok: false; why: string } {
  const argv: string[] = [];
  for (const [i, el] of run.entries()) {
    let substituted = false;
    let bad: string | undefined;
    const out = el.replace(TEMPLATE, (_m, field: string) => {
      substituted = true;
      if (status === undefined) {
        bad ??= `run[${i}]: {status.${field}} needs a \`status:\` read`;
        return "";
      }
      const v = status[field];
      if (typeof v !== "string") {
        bad ??= `run[${i}]: {status.${field}} is ${v === undefined ? "absent" : JSON.stringify(v)} in the status file, not a string`;
        return "";
      }
      return v;
    });
    if (bad) return { ok: false, why: bad };
    if (substituted) {
      if (out.startsWith("-"))
        return { ok: false, why: `run[${i}]: a substituted value may not start with "-" (got ${JSON.stringify(out)})` };
      if (out.split(/[\\/]/).includes("..")) return { ok: false, why: `run[${i}]: a substituted value may not contain a ".." segment` };
      if (Buffer.byteLength(out) > MAX_ARG_BYTES)
        return { ok: false, why: `run[${i}]: a substituted value is longer than ${MAX_ARG_BYTES} bytes` };
      if (out.includes("/")) {
        const root = posix.resolve(sessionRoot);
        const target = isAbsolute(out) ? posix.resolve(out) : posix.resolve(root, out);
        if (target !== root && !target.startsWith(root + "/"))
          return { ok: false, why: `run[${i}]: ${JSON.stringify(out)} is outside the agent-visible session root ${root}` };
      }
    }
    argv.push(out);
  }
  return { ok: true, argv };
}

export interface ActionExec {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stdoutBytes: number;
  stderr: string;
  stderrBytes: number;
  durationMs: number;
  /** Why the action could not run at all (spawn failure), when it could not. */
  spawnError?: string;
}

/** Spawn `cmd args`, capped capture, killed (`kill()`) at the deadline. */
export function runCapped(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; kill: (child: ReturnType<typeof spawn>) => void },
): Promise<ActionExec> {
  const started = Date.now();
  return new Promise((res) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) {
      return res({
        exitCode: null,
        timedOut: false,
        stdout: "",
        stdoutBytes: 0,
        stderr: "",
        stderrBytes: 0,
        durationMs: 0,
        spawnError: (e as Error).message,
      });
    }
    const out = { s: "", n: 0 };
    const err = { s: "", n: 0 };
    const take = (b: { s: string; n: number }) => (d: Buffer) => {
      b.n += d.length;
      if (b.s.length < ACTION_OUTPUT_CAP) b.s += d.toString("utf8").slice(0, ACTION_OUTPUT_CAP - b.s.length);
    };
    child.stdout!.on("data", take(out));
    child.stderr!.on("data", take(err));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      opts.kill(child);
    }, opts.timeoutMs);
    let spawnError: string | undefined;
    child.on("error", (e) => (spawnError = e.message));
    child.on("close", (code) => {
      clearTimeout(t);
      res({
        exitCode: code,
        timedOut,
        stdout: out.s,
        stdoutBytes: out.n,
        stderr: err.s,
        stderrBytes: err.n,
        durationMs: Date.now() - started,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}

/** Kill a detached host subprocess's whole process group. */
export function killGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export interface ActionRecord {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: { sha256: string; bytes: number; head: string };
  stderr: { sha256: string; bytes: number; head: string };
  /** Files the action created or changed under the user-visible roots: (path, sha256). */
  produced: Array<{ path: string; sha256: string | null }>;
  /** Why the leg failed before or instead of running the command (status file, template, spawn). */
  refused?: string;
  assertions: Array<{ assertion: Record<string, unknown>; pass: boolean; message?: string }>;
  pass: boolean;
}

/** The recorded form of one output stream: scrubbed, hashed, and its first ACTION_OUTPUT_HEAD bytes. */
export function recordedStream(text: string, bytes: number, secrets: readonly string[]): ActionRecord["stdout"] {
  const clean = scrub(text, [...secrets]);
  return { sha256: sha256(clean), bytes, head: clean.slice(0, ACTION_OUTPUT_HEAD) };
}

/** Grade a host action: its own keys (exit_code, stdout_matches, stdout_not_matches) and its file keys. An unasserted
 *  exit code still has to be 0. `fileCtx` is the evaluation context for the file keys (work root, pre-run hashes). */
export function gradeAction(
  asserts: readonly HostActionAssertion[],
  exec: Pick<ActionExec, "exitCode" | "timedOut">,
  stdoutScrubbed: string,
  fileCtx: Parameters<typeof evaluate>[1],
): ActionRecord["assertions"] {
  const out: ActionRecord["assertions"] = [];
  const asserted = asserts.some((a) => (a as Record<string, unknown>).exit_code !== undefined);
  if (exec.timedOut) out.push({ assertion: { timeout: true }, pass: false, message: "the action timed out and was killed" });
  if (!asserted)
    out.push({
      assertion: { exit_code: 0 },
      pass: exec.exitCode === 0,
      ...(exec.exitCode === 0 ? {} : { message: `exited ${exec.exitCode}, expected 0 (default)` }),
    });
  const fileAsserts: Assertion[] = [];
  for (const a of asserts) {
    const o = a as Record<string, unknown>;
    if (o.exit_code !== undefined) {
      const pass = exec.exitCode === o.exit_code;
      out.push({ assertion: o, pass, ...(pass ? {} : { message: `exited ${exec.exitCode}, expected ${String(o.exit_code)}` }) });
    } else if (typeof o.stdout_matches === "string" || typeof o.stdout_not_matches === "string") {
      const key = typeof o.stdout_matches === "string" ? "stdout_matches" : "stdout_not_matches";
      const c = compileUserRegex(o[key] as string);
      if ("error" in c) {
        out.push({ assertion: o, pass: false, message: `bad regex in ${key}: ${c.error}` });
        continue;
      }
      const hit = c.re.test(stdoutScrubbed);
      const pass = key === "stdout_matches" ? hit : !hit;
      out.push({
        assertion: o,
        pass,
        ...(pass ? {} : { message: `${key} ${JSON.stringify(o[key])}: ${hit ? "matched" : "no match"} in stdout` }),
      });
    } else fileAsserts.push(a as Assertion);
  }
  if (fileAsserts.length)
    for (const r of evaluate(fileAsserts, fileCtx, { quietSharedCapture: true }))
      out.push({ assertion: r.assertion as Record<string, unknown>, pass: r.pass, ...(r.message ? { message: r.message } : {}) });
  return out;
}

/** Files under the user-visible roots that differ between two pre-run-manifest hash maps: created or changed. */
export function producedFiles(before: Record<string, string | null>, after: Record<string, string | null>): ActionRecord["produced"] {
  return Object.keys(after)
    .filter((p) => !(p in before) || before[p] !== after[p])
    .sort()
    .map((path) => ({ path, sha256: after[path] ?? null }));
}

export function writeActionRecord(legDir: string, rec: ActionRecord): void {
  mkdirSync(legDir, { recursive: true });
  const tmp = join(legDir, "action.json.tmp");
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, join(legDir, "action.json"));
}

/** Remove a named one-shot container (idempotent). */
export function removeContainer(runner: string, name: string): void {
  spawnSync(runner, ["rm", "-f", name], { stdio: "ignore" });
}

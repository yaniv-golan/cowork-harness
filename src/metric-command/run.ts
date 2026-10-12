// Execute one command metric: the staged, hashed bytes only, under a fixed interpreter, an env allowlist and caps,
// twice in fresh temp dirs, and parse its one number.
//
// What is promised (see docs/scenario.md "Command metrics"): argv-only spawn; the bytes that run are exactly the
// hashed, declared, contained files, staged out of the repo (re-read here, compared with the resolution's hash, and
// that same buffer staged — never the repo path); no harness secret or ambient env is passed; bounded stdout and time.
// NOT promised: confidentiality from a same-uid process or confinement of a determined Python script (the audit hook
// is a tripwire), network isolation, or the survival of a grandchild that called setsid().
import { createHash } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MetricCommandRecord, MetricUnavailable, ScenarioMetric } from "../types.js";
import { boundedSpawnBuffers } from "../bounded-spawn.js";
import { scrub } from "../secrets.js";
import { metricSig } from "../metric-sig.js";
import { parseMetricOutput } from "./output.js";
import { nodePermissionFlag, resolvePython } from "./interpreters.js";
import { commandFilePaths, commandFilesSha256, DEFAULT_COMMAND_TIMEOUT_MS, type ResolvedCommand } from "./resolve.js";

export const STDOUT_CAP = 4096;
export const STDERR_KEEP = 4096;

/** The harness's Python runner, shipped in the package's `python/` dir (resolves from src/ and dist/ alike). */
export const METRIC_RUNNER = fileURLToPath(new URL("../../python/metric-runner.py", import.meta.url));

export interface CommandMeasurement {
  id: string;
  value?: number;
  unavailable?: MetricUnavailable;
  why?: string;
  command: MetricCommandRecord;
  /** The scrubbed head of each run's stderr (both runs when they disagreed). */
  stderr: string;
}

export interface CommandRunInput {
  metric: ScenarioMetric & { command: string[] };
  resolved: ResolvedCommand;
  /** The exact events bytes the script reads; undefined when there are none (`no_events`). */
  events: Buffer | undefined;
  /** Why there are no events, for the message. */
  noEventsWhy?: string;
  /** The secret set stderr is scrubbed with before it is kept. */
  secrets: string[];
  /** Epoch ms after which no run may start; each run's timeout is cut to what is left. */
  deadline?: number;
}

/** The env a command gets: exactly these keys, nothing passed through. */
export function metricEnv(tmp: string, id: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: tmp,
    TMPDIR: tmp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    PYTHONHASHSEED: "0",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    COWORK_HARNESS_METRIC_ID: id,
  };
}

// A process-wide cap on concurrent metric commands across jobs.
const LIMIT = Math.max(1, Math.min(4, availableParallelism()));
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(f: () => Promise<T>): Promise<T> {
  if (active >= LIMIT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await f();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

type OneRun =
  | { ok: true; stdout: string; value: number; stderr: Buffer; ms: number }
  | { ok: false; unavailable: MetricUnavailable; why: string; stderr: Buffer; ms: number };

async function runOnce(
  input: CommandRunInput,
  files: ReadonlyArray<{ rel: string; bytes: Buffer }>,
  interp: { cmd: string; args: (tmp: string, scriptRel: string, events: string) => string[] },
): Promise<OneRun> {
  const started = Date.now();
  const left = input.deadline === undefined ? Infinity : input.deadline - started;
  const timeoutMs = Math.min(input.metric.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS, left);
  if (!(timeoutMs > 0))
    return {
      ok: false,
      unavailable: "command_timeout",
      why: "the run's deadline had passed before the command could start",
      stderr: Buffer.alloc(0),
      ms: 0,
    };
  // The real path: Node's permission model compares resolved paths, and macOS's temp dir sits behind a symlink.
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "cwh-metric-")));
  try {
    for (const f of files) {
      const dest = join(tmp, "stage", ...f.rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.bytes);
    }
    const eventsPath = join(tmp, "events.jsonl");
    writeFileSync(eventsPath, input.events!);
    const r = await boundedSpawnBuffers(interp.cmd, interp.args(tmp, input.resolved.scriptRel, eventsPath), {
      timeoutMs,
      cwd: tmp,
      env: metricEnv(tmp, input.metric.id),
      stdoutMax: STDOUT_CAP,
      stderrDrainMax: STDERR_KEEP,
    });
    const ms = Date.now() - started;
    const err = r.stderr;
    if (r.timedOut)
      return {
        ok: false,
        unavailable: "command_timeout",
        why: `no result within ${timeoutMs} ms (the process group was killed)`,
        stderr: err,
        ms,
      };
    if (r.truncated) return { ok: false, unavailable: "command_output", why: `stdout exceeded ${STDOUT_CAP} bytes`, stderr: err, ms };
    if (r.spawnError !== undefined)
      return { ok: false, unavailable: "command_failed", why: `could not start: ${r.spawnError}`, stderr: err, ms };
    if (r.code !== 0) {
      const sandbox = err
        .toString("utf8")
        .split("\n")
        .find((l) => l.includes("metric sandbox: "));
      const how = r.signal !== null ? `killed by ${r.signal}` : `exit ${r.code}`;
      return {
        ok: false,
        unavailable: "command_failed",
        why: sandbox ? `${how}; ${sandbox.slice(sandbox.indexOf("metric sandbox: ")).trim()}` : how,
        stderr: err,
        ms,
      };
    }
    const parsed = parseMetricOutput(r.stdout);
    if ("invalid" in parsed) return { ok: false, unavailable: "command_output", why: parsed.invalid, stderr: err, ms };
    return { ok: true, stdout: r.stdout.toString("utf8").trim(), value: parsed.value, stderr: err, ms };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Run one command metric live (or on a consented re-measure): read the files once, check them against the
 *  resolution, run twice, and report a value only when both runs print the same number. */
export async function runCommandMetric(input: CommandRunInput): Promise<CommandMeasurement> {
  const m = input.metric;
  const r = input.resolved;
  const record: MetricCommandRecord = { sig: metricSig(m), script: r.scriptRel, scriptSha256: r.scriptSha256 };
  const off = (unavailable: MetricUnavailable, why: string, extra: Partial<MetricCommandRecord> = {}, stderr = ""): CommandMeasurement => ({
    id: m.id,
    unavailable,
    why,
    command: { ...record, ...extra },
    stderr,
  });
  // ONE read per file: these buffers are hashed and staged; the repo paths never reach an interpreter.
  let files: Array<{ rel: string; bytes: Buffer }>;
  try {
    files = commandFilePaths(r).map((f) => ({ rel: f.rel, bytes: readFileSync(f.abs) }));
  } catch (e) {
    return off("command_missing", `a command file could not be read: ${(e as Error).message}`);
  }
  if (commandFilesSha256(files) !== r.scriptSha256)
    return off("command_changed", "a command file changed after the scenario was loaded (its content no longer matches the signature)");
  if (input.events === undefined) return off("no_events", input.noEventsWhy ?? "the run has no events.jsonl");
  const eventsSha256 = sha256(input.events);
  let interp: { cmd: string; args: (tmp: string, scriptRel: string, events: string) => string[] };
  let interpreter: string;
  if (r.scriptRel.endsWith(".py")) {
    const py = resolvePython();
    if ("refused" in py) return off("command_failed", py.refused, { eventsSha256 });
    interp = { cmd: py.executable, args: (tmp, rel, ev) => ["-S", "-s", "-B", METRIC_RUNNER, tmp, rel, ev, ...m.command.slice(1)] };
    interpreter = `${py.executable} ${py.version}`;
  } else {
    const flag = nodePermissionFlag();
    interp = {
      cmd: process.execPath,
      args: (tmp, rel, ev) => [flag, `--allow-fs-read=${tmp}`, join(tmp, "stage", ...rel.split("/")), ev, ...m.command.slice(1)],
    };
    interpreter = `${process.execPath} ${process.version}`;
  }
  const keep = (b: Buffer) => scrub(b.toString("utf8"), input.secrets);
  return withSlot(async () => {
    const first = await runOnce(input, files, interp);
    const base = { eventsSha256, interpreter, durationMs: first.ms };
    if (!first.ok) return off(first.unavailable, first.why, base, keep(first.stderr));
    const second = await runOnce(input, files, interp);
    const durationMs = first.ms + second.ms;
    if (!second.ok)
      return off(
        second.unavailable,
        `the second run failed: ${second.why}`,
        { ...base, durationMs },
        `${keep(first.stderr)}\n--- run 2 ---\n${keep(second.stderr)}`,
      );
    if (second.stdout !== first.stdout)
      return off(
        "nondeterministic",
        `two runs over the same events printed ${JSON.stringify(first.stdout)} and ${JSON.stringify(second.stdout)}`,
        { ...base, durationMs },
        `${keep(first.stderr)}\n--- run 2 ---\n${keep(second.stderr)}`,
      );
    return { id: m.id, value: first.value, command: { ...record, ...base, durationMs }, stderr: keep(first.stderr) };
  });
}

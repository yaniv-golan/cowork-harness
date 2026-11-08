// Child-process probe for test/outputs-delete-basis-linear.test.ts. Builds one named input, runs the REAL
// `outputsDeleteBasis` on it and prints `{"ms": <best-of-N CPU ms>, "basis": …}`. It runs in its own process, under a
// kernel CPU-time limit, so a catastrophic regex dies instead of blocking the test's worker: a synchronous hang cannot
// be pre-empted by a vitest timeout.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputsDeleteBasis, isOutputsDelete, scanEvents } from "../../src/run/execute.js";

const O = "/sessions/s/mnt/outputs";
const R = (s: string, n: number) => s.repeat(n);

export const PROBES: Record<string, () => string> = {
  // hang class: each of these once took seconds to forever. Kept UNDER the per-statement cap
  // (BASIS_STATEMENT_CAP), so the operand-level regexes themselves run on them — above the cap they would
  // be skipped and a regression in those regexes would go unseen.
  "wrapper chain: timeout … env × 140": () => R("timeout -k 5 10 env -i A=1 ", 140) + `rmx ${O}/a\nrm "$Q"`,
  "comprehension: for + 2000 spaces × 2": () => `python3 -c '[os.remove(p) for` + R(" ", 2000) + "x" + R(" ", 2000) + `y ${O}]'; rm "$Q"`,
  // quadratic class: realistic or adversarial single statements of 40–80k characters
  "minified JSON line, 80k": () => "echo " + R('{"a":', 16000) + ` > ${O}/x.json && rm -rf "$TMP"`,
  "os.remove( repeated, 40k": () => R("os.remove(", 4000) + `${O}/x; rm "$Q"`,
  "( repeated, 40k": () => R("(", 40000) + `rm "$Q" ${O}/x`,
  "{ repeated, 40k": () => R("{", 40000) + ` rm "$Q" ${O}/x`,
  "backtick repeated, 40k": () => R("`", 40000) + `rm "$Q" ${O}/x`,
  "$( repeated, 40k": () => R("$(", 20000) + `rm "$Q" ${O}/x`,
  // quadratic in the command-position regex itself (each `eval "` is a start). BASIS_COMMAND_CAP and
  // BASIS_STATEMENT_CAP each keep it fast, so this probe fails only when both go.
  'eval " repeated, 40k': () => R('eval "', 6700) + `rmx ${O}/x; rm "$Q"`,
  // detector token arms and pre-split passes: once quadratic on a missing flag / unclosed paren / long runs
  // of assignments. Each ends in `; rm "$Q"` so it is flagged and the classifier runs on it.
  "shred -a repeated, 81k": () => R("shred -a ", 9000) + `${O}/x; rm "$Q"`,
  "shred -a repeated, 162k": () => R("shred -a ", 18000) + `${O}/x; rm "$Q"`,
  "4000 vars, one segment referencing them all": () =>
    Array.from({ length: 4000 }, (_, i) => `v${i}=1`).join("\n") +
    "\n" +
    Array.from({ length: 4000 }, (_, i) => `$v${i}`).join("") +
    ` ${O}/x; rm "$Q"`,
  // variable expansion with `$`-valued variables: a one-line cascade (each value references the next) and a
  // fan-out (each value references another variable eight times), then one statement referencing them all.
  // Past EXPANSION_BUDGET the scanner decides without expanding; the smaller ones stay under it and run the
  // exact expansion.
  "cascade: v0=$v1 … × 4000, one line": () =>
    Array.from({ length: 4000 }, (_, i) => `v${i}=$v${i + 1}`).join(" ") +
    "\n" +
    Array.from({ length: 4000 }, (_, i) => `$v${i}`).join("") +
    ` ${O}/x; rm "$Q"`,
  "fan-out: vN=$w×8 × 4000": () =>
    Array.from({ length: 4000 }, (_, i) => `v${i}=${"$w".repeat(8)}`).join("\n") +
    "\nw=x\n" +
    Array.from({ length: 4000 }, (_, i) => `$v${i}`).join("") +
    ` ${O}/x; rm "$Q"`,
  // Two shapes the expansion budget does not bound tightly: distinct `$(mktemp)` variables referenced across
  // several segments (their resolution is one pass per variable per segment, outside the budget), and tens of
  // thousands of tiny segments (each costs more than it is charged). Sized well under the guard's bound; at
  // ~160 KB they measure ~0.16–0.25 s per flagged command.
  "mktemp: 1000 distinct $(mktemp) vars × 3 segments": () =>
    Array.from({ length: 1000 }, (_, i) => `m${i}=$(mktemp)`).join(" ") +
    ";" +
    Array.from({ length: 3 }, () => Array.from({ length: 1000 }, (_, i) => `$m${i}`).join("")).join(";") +
    `; echo ${O}/x; rm "$Q"`,
  "tiny segments: $a; × 2000": () => "a=1; " + "$a;".repeat(2000) + ` echo ${O}/x; rm "$Q"`,
  "under the expansion budget: cascade × 150": () =>
    Array.from({ length: 150 }, (_, i) => `v${i}=$v${i + 1}`).join(" ") +
    "\n" +
    Array.from({ length: 150 }, (_, i) => `$v${i}`).join("") +
    ` ${O}/x; rm "$Q"`,
  "find -x repeated, 80k": () => R("find -x ", 10000) + `${O}/x; rm "$Q"`,
  "a=$(mktemp repeated, 77k": () => R("a=$(mktemp ", 7000) + ` ${O}/x; rm "$Q"`,
  "4000 assignments then 80k echo": () => R("v=1 ", 4000) + "\n" + "echo " + R("x", 80000) + ` ${O}/x; rm "$Q"`,
  // the same shapes just under the whole-command cap, where the pre-split passes DO run
  "under the command cap: a=$(mktemp × 1400": () => R("a=$(mktemp ", 1400) + ` ${O}/x; rm "$Q"`,
  "under the command cap: 2000 assignment lines using a var": () => R("v=1 $w\n", 2000) + `${O}/x; rm "$Q"`,
  "under the command cap: shred -a × 1700": () => R("shred -a ", 1700) + `${O}/x; rm "$Q"`,
  // just under the per-statement cap, so the operand-level analysis itself runs on them
  "under the cap: $( × 2000": () => R("$(", 2000) + `rm "$Q" ${O}/x`,
  "under the cap: os.remove( × 400": () => R("os.remove(", 400) + `${O}/x; rm "$Q"`,
  'under the cap: eval " × 650': () => R('eval "', 650) + `rmx ${O}/x; rm "$Q"`,
};

/** The hang killer, in seconds of CPU time. It only has to catch a hang, so it sits well above a healthy probe's cost
 *  (startup, the tsx compile and the import graph: over 1 s on a quiet machine, several times that on a loaded runner). */
export const PROBE_CPU_LIMIT_S = 20;
/** Not a probe: burns CPU forever, after this file's whole import graph has loaded. */
export const SPIN_PROBE = "(spin)";
export const SPINNING = "spinning";

const PROBE_FILE = fileURLToPath(import.meta.url);

/** How a probe is spawned. The name is a positional argument: probe names hold `$(`, `"` and backticks, which the shell
 *  must never read. `exec` keeps the pid, so a signal from the limit is the one the caller sees. */
export function probeSpawn(name: string, cpuLimitS: number = PROBE_CPU_LIMIT_S): { file: string; args: string[]; options: SpawnOptions } {
  return {
    file: "/bin/sh",
    args: ["-c", 'ulimit -t "$1"; shift; exec "$@"', "sh", String(cpuLimitS), process.execPath, "--import", "tsx", PROBE_FILE, name],
    options: { stdio: ["ignore", "pipe", "pipe"] },
  };
}

export interface ProbeRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const live = new Set<ChildProcess>();

/** Runs a probe to its end. Its only kill is the CPU limit in `probeSpawn`; wall time passing is never a failure. */
export function runProbe(name: string, o: { cpuLimitS?: number; onSpawn?: (child: ChildProcess) => void } = {}): Promise<ProbeRun> {
  const { file, args, options } = probeSpawn(name, o.cpuLimitS);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    live.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status, signal) => {
      live.delete(child);
      resolve({ status, signal, stdout, stderr });
    });
    o.onSpawn?.(child);
  });
}

/** A test that timed out must not leave its child behind, least of all a stopped one. */
export function killLiveProbes(): void {
  for (const c of live) c.kill("SIGKILL");
}

// Only when run as the child entry point — importing PROBES from the test must not execute anything.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
const name = process.argv[2];
if (isEntry && name === SPIN_PROBE) {
  console.log(SPINNING);
  for (;;);
}
if (isEntry && name !== undefined) {
  const build = PROBES[name];
  if (!build) {
    console.error(`unknown probe ${name}`);
    process.exit(2);
  }
  const cmd = build();
  let best = Infinity;
  let bestDetector = Infinity;
  let basis = "";
  let flagged = false;
  // CPU time (user + system), not wall time: wall time also counts waiting for a core, which grows severalfold on a
  // loaded machine while the classifier's own cost does not.
  const cpuMs = (c0: NodeJS.CpuUsage) => {
    const c = process.cpuUsage(c0);
    return (c.user + c.system) / 1000;
  };
  for (let i = 0; i < 3; i++) {
    let c = process.cpuUsage();
    flagged = isOutputsDelete(cmd);
    bestDetector = Math.min(bestDetector, cpuMs(c));
    c = process.cpuUsage();
    basis = outputsDeleteBasis(cmd);
    best = Math.min(best, cpuMs(c));
  }
  // The whole per-command cost as a real run pays it: scanEvents runs the detector over every writable
  // mount, the finding snippet (its own expansion passes) and nothing else; the basis is timed above.
  const eventsDir = mkdtempSync(join(tmpdir(), "cwh-probe-"));
  const events = join(eventsDir, "events.jsonl");
  writeFileSync(
    events,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } }),
  );
  let bestScan = Infinity;
  for (let i = 0; i < 3; i++) {
    const c = process.cpuUsage();
    scanEvents(events, ["outputs", "proj"]);
    bestScan = Math.min(bestScan, cpuMs(c));
  }
  rmSync(eventsDir, { recursive: true, force: true });
  console.log(JSON.stringify({ ms: best, detectorMs: bestDetector, scanMs: bestScan, flagged, basis, chars: cmd.length }));
}

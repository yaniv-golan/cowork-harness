// Child-process probe for test/outputs-delete-basis-linear.test.ts. Builds one named input, runs the REAL
// `outputsDeleteBasis` on it and prints `{"ms": <best of N>, "basis": …}`. It runs in its own process so the
// test can SIGKILL a catastrophic regex instead of blocking its own worker: a synchronous hang cannot be
// pre-empted by a vitest timeout.
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
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
  // quadratic in the command-position regex itself (each `eval "` is a start); only the per-statement cap
  // keeps it fast — the probe that fails if the cap goes
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

// Only when run as the child entry point — importing PROBES from the test must not execute anything.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
const name = process.argv[2];
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
  for (let i = 0; i < 3; i++) {
    let t = performance.now();
    flagged = isOutputsDelete(cmd);
    bestDetector = Math.min(bestDetector, performance.now() - t);
    t = performance.now();
    basis = outputsDeleteBasis(cmd);
    best = Math.min(best, performance.now() - t);
  }
  // The whole per-command cost as a real run pays it: scanEvents runs the detector over every writable
  // mount, the finding snippet (its own expansion passes) and nothing else; the basis is timed above.
  const events = join(mkdtempSync(join(tmpdir(), "cwh-probe-")), "events.jsonl");
  writeFileSync(
    events,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } }),
  );
  let bestScan = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    scanEvents(events, ["outputs", "proj"]);
    bestScan = Math.min(bestScan, performance.now() - t);
  }
  console.log(JSON.stringify({ ms: best, detectorMs: bestDetector, scanMs: bestScan, flagged, basis, chars: cmd.length }));
}

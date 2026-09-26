// Child-process probe for test/outputs-delete-basis-linear.test.ts. Builds one named input, runs the REAL
// `outputsDeleteBasis` on it and prints `{"ms": <best of N>, "basis": …}`. It runs in its own process so the
// test can SIGKILL a catastrophic regex instead of blocking its own worker: a synchronous hang cannot be
// pre-empted by a vitest timeout.
import { pathToFileURL } from "node:url";
import { outputsDeleteBasis } from "../../src/run/execute.js";

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
  let basis = "";
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    basis = outputsDeleteBasis(cmd);
    best = Math.min(best, performance.now() - t);
  }
  console.log(JSON.stringify({ ms: best, basis, chars: cmd.length }));
}

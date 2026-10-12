// Child-process probe for test/privacy-regex-linear.test.ts. Runs ONE target (a scanner class, one rule of the
// shipped reference redaction policy, `hostPathLeaked`, or an end-to-end pass) over every adversarial input that
// applies to it and prints `{"perInput": {<input>: CPU ms}, "wallPerInput": {…}, "inputs": n}`. It runs in its own process so the test can
// SIGKILL a catastrophic regex instead of blocking its own worker: a synchronous regex cannot be pre-empted by a
// vitest timeout.
//
// Every target is DERIVED from the shipped code and policy (never a copy of a regex), so a new scanner class or
// policy rule is covered without editing this file.
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SCAN_PATTERNS, scanText } from "../../src/scan.js";
import { redactJsonLine, type RedactionPolicy } from "../../src/redact.js";
import { hostPathLeaked } from "../../src/run/execute.js";

/** Input length. 200k separates a quadratic regex from a linear one by 30× or more. Real event lines reach
 *  2 MB (an inlined image); the linear versions redact or scan one of those in about 0.25 s. */
export const N = 200_000;

const POLICY_JSON = JSON.parse(readFileSync(resolve(".cowork-redact.json"), "utf8")) as {
  patterns: { regex: string; label?: string; flags?: string }[];
};
export const POLICY_SOURCES = POLICY_JSON.patterns.map((p) => p.regex);
const POLICY: RedactionPolicy = {
  patterns: POLICY_JSON.patterns.map((p) => ({ re: new RegExp(p.regex, p.flags ?? "g"), label: p.label ?? "redacted" })),
  keyNames: [],
};

/** Every path-root literal the policy names (`/Users/`, `/private/tmp/`, …), found by shape in the rule
 *  sources, minus the `/mnt/` tail marker. A new root in the policy becomes a new set of inputs by itself. */
export const ROOTS: string[] = [
  ...new Set(POLICY_SOURCES.flatMap((s) => s.match(/(?:\/[A-Za-z]+)+\//g) ?? []).filter((r) => r.toLowerCase() !== "/mnt/")),
];

const rep = (s: string, n = N) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const zeroB64 = (n: number) =>
  Buffer.alloc(Math.ceil((n * 3) / 4))
    .toString("base64")
    .slice(0, n);

/** Inputs every target gets. Each was a multi-second case on at least one quadratic regex this guard exists for. */
const FIXED: Record<string, () => string> = {
  "letter run": () => rep("A"),
  "hex run": () => rep("0123456789abcdef"),
  "zero-filled base64": () => zeroB64(N),
  "raw JSON line, zero-filled base64 leaf": () =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: zeroB64(N) }] } }),
  "hyphenated run a-a-a…": () => rep("a-"),
  "slug run -Users-…": () => rep("-Users-"),
  "x@ then a.a.a…": () => "x@" + rep("a.", N - 2),
  "(60 letters + @) repeated": () => rep("a".repeat(60) + "@"),
  "(space + 1000 letters) repeated": () => rep(" " + "a".repeat(1000)),
};

/** Per-root inputs: a whitespace-free run of one repeated root, the same run followed by a separated `/mnt/`,
 *  and the root after each boundary character that is also a path-class member. */
function rootInputs(root: string): Record<string, () => string> {
  return {
    [`${root} repeated`]: () => rep(root),
    [`${root} repeated, then " /mnt/"`]: () => rep(root, N - 6) + " /mnt/",
    [`(${root} repeated`]: () => rep("(" + root),
    [`[${root} repeated`]: () => rep("[" + root),
    [`=${root} repeated`]: () => rep("=" + root),
  };
}

type Target = { run: (t: string) => unknown; roots: string[]; e2e?: boolean };
const g = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

export const TARGETS: Record<string, Target> = {};
DEFAULT_SCAN_PATTERNS.forEach((p, i) => {
  const re = g(p.re);
  TARGETS[`scan[${i}] ${p.cls}`] = { run: (t) => [...t.matchAll(re)].length, roots: p.cls === "path" ? ROOTS : [] };
});
POLICY.patterns.forEach((p, k) => {
  const re = g(p.re);
  // Root inputs only for the rules that name that root (case-insensitively, as the rules match).
  const roots = ROOTS.filter((r) => POLICY_SOURCES[k].toLowerCase().includes(r.toLowerCase()));
  TARGETS[`policy[${k}] ${p.label}`] = { run: (t) => t.replace(re, "x").length, roots };
});
TARGETS["hostPathLeaked"] = { run: (t) => hostPathLeaked(t), roots: ROOTS };
TARGETS["end to end: scanText, every class"] = { run: (t) => scanText(t, "t", []).length, roots: ROOTS, e2e: true };
TARGETS["end to end: redactJsonLine, whole policy"] = { run: (t) => redactJsonLine(t, POLICY).length, roots: ROOTS, e2e: true };

export function inputsFor(target: string): Record<string, () => string> {
  const t = TARGETS[target];
  return Object.assign({}, FIXED, ...t.roots.map(rootInputs));
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
const name = process.argv[2];
if (isEntry && name !== undefined) {
  const t = TARGETS[name];
  if (!t) {
    console.error(`unknown target ${name}`);
    process.exit(2);
  }
  // perInput is this process's CPU time (user + system), not wall time: wall time also counts waiting for a core,
  // which grows about fivefold on a loaded machine while the regex's own cost does not. wallPerInput is reported
  // for diagnosis only.
  const perInput: Record<string, number> = {};
  const wallPerInput: Record<string, number> = {};
  for (const [label, build] of Object.entries(inputsFor(name))) {
    const text = build();
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    t.run(text);
    wallPerInput[label] = performance.now() - t0;
    const c = process.cpuUsage(c0);
    perInput[label] = (c.user + c.system) / 1000;
  }
  console.log(JSON.stringify({ perInput, wallPerInput, inputs: Object.keys(perInput).length }));
}

// Source-text scan behind test/exit-guard.test.ts. A command asks to exit by throwing ExitRequested (src/run/exit.ts);
// a broad `catch` that can see one and does not rethrow it swallows the exit. This module finds every such catch in
// the files that can raise one, and every remaining `process.exit(` call.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SRC = "src";

export function srcFiles(root = SRC): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** The source with every comment blanked to spaces (newlines kept, so offsets and line numbers still match).
 *  String and template literals are skipped over, so a `//` inside a URL string is not taken for a comment. With
 *  `strings`, the contents of '…' and "…" literals are blanked too (template literals are kept: their `${}` is code). */
export function stripComments(src: string, opts: { strings?: boolean } = {}): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < src.length && src[k] !== c) {
        if (src[k] === "\\") k++;
        else if (c === "`" && src[k] === "$" && src[k + 1] === "{") {
          // skip a template expression, balancing braces (nested templates are rare enough to ignore)
          let depth = 1;
          k += 2;
          while (k < src.length && depth > 0) {
            if (src[k] === "{") depth++;
            else if (src[k] === "}") depth--;
            k++;
          }
          continue;
        }
        k++;
      }
      if (opts.strings && c !== "`") blank(i + 1, k);
      i = k + 1;
    } else i++;
  }
  return out.join("");
}

const lineOf = (src: string, offset: number) => src.slice(0, offset).split("\n").length;

/** Files that raise no exit request themselves but run code that can (a job, a pool item) and decide what a throw
 *  from it means: a catch there that turned a request into a row or an ordinary stop would end the run with the
 *  wrong code. Named, since no import marks them. */
export const CROSS_FILE_WRAPPERS = [
  join("src", "async-pool.ts"),
  join("src", "eval", "command.ts"),
  join("src", "eval", "job-runner.ts"),
  join("src", "hillclimb", "runner.ts"),
];

/**
 * The files whose catches must let an exit request through, matched on comment-free text:
 *  - the raisers: those that import `fail` from envelope.js or call `exitWith(` (and envelope.ts itself);
 *  - every importer of run/exit.js or async-pool.js: sentinel-aware by definition, or running pool items that can
 *    raise one;
 *  - the CROSS_FILE_WRAPPERS.
 * Known blind spot, unused in src today: a namespace import (`import * as env from "./envelope.js"` then `env.fail(`)
 * is not matched by the `fail` import criterion. A file that does it and calls no `exitWith(` would be unguarded.
 */
export function guardedFiles(files = srcFiles()): string[] {
  return files.filter((f) => {
    if (f.endsWith(join("run", "exit.ts"))) return false;
    if (CROSS_FILE_WRAPPERS.some((w) => f.endsWith(w))) return true;
    const s = stripComments(readFileSync(f, "utf8"));
    if (/import\s*(type\s*)?\{[^}]*\bfail\b[^}]*\}\s*from\s*"[^"]*envelope\.js"/.test(s)) return true;
    if (/\bexitWith\(/.test(s)) return true;
    if (/\bfail\(/.test(s) && f.endsWith(join("run", "envelope.ts"))) return true;
    if (/\bfrom\s*"[^"]*\/(exit|async-pool)\.js"/.test(s)) return true;
    return false;
  });
}

export interface CatchSite {
  file: string;
  line: number;
  binding?: string;
  /** How the catch lets an exit through: a rethrowIfExit first statement, a narrow rethrow, or a marker. */
  kind: "rethrowIfExit" | "narrow" | "marker" | "none";
  reason?: string;
  /** The catch's first statement, for the failure message. */
  first: string;
  /** `catch` for a `} catch` block, `.catch` for a promise handler. */
  form: "catch" | ".catch";
}

const MARKER = /\/\/\s*exit-safe:\s*(.+)$/;

function classify(binding: string | undefined, first: string): CatchSite["kind"] {
  if (!binding) return "none";
  if (first.startsWith(`rethrowIfExit(${binding});`)) return "rethrowIfExit";
  // `if (!(e instanceof UsageError)) throw e;` rethrows everything but one class. With ExitRequested as that class it
  // rethrows everything EXCEPT the request, so it swallows exactly what this guard is for.
  if (new RegExp(`^if \\(!\\(${binding} instanceof (?!ExitRequested\\b)[\\w$.]+\\)\\) throw ${binding};`).test(first)) return "narrow";
  // `if (e instanceof InterruptedError || e instanceof ExitRequested) throw e;`: rethrows the request by name.
  if (
    new RegExp(
      `^if \\((${binding} instanceof [\\w$.]+ \\|\\| )*${binding} instanceof ExitRequested( \\|\\| ${binding} instanceof [\\w$.]+)*\\) throw ${binding};`,
    ).test(first)
  )
    return "narrow";
  return "none";
}

/** A marker on the given line, or as the body's first line: a line holding only the marker comment, after a line
 *  whose body is still open. */
function markerAt(rawLines: string[], line: number): RegExpMatchArray | null {
  const bodyOpen = rawLines[line - 1].trimEnd().endsWith("{");
  return (
    rawLines[line - 1].match(MARKER) ??
    (bodyOpen && /^\s*\/\/\s*exit-safe:/.test(rawLines[line] ?? "") ? (rawLines[line] ?? "").match(MARKER) : null)
  );
}

const firstStatement = (src: string, bodyStart: number) =>
  src
    .slice(bodyStart, bodyStart + 300)
    .trimStart()
    .split("\n")[0]
    .trim();

/** Every `} catch` block and every `.catch(` promise handler in the file. A handler that is an arrow with a block body
 *  is classified like a catch block; an expression-bodied arrow or a function reference cannot be read, so it counts
 *  as letting nothing through unless it carries a marker. */
export function catchSites(file: string): CatchSite[] {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw, { strings: true });
  const rawLines = raw.split("\n");
  const rel = relative(process.cwd(), file);
  const out: CatchSite[] = [];
  for (const m of src.matchAll(/\}\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\))?\s*\{/g)) {
    const line = lineOf(src, m.index! + m[0].indexOf("catch"));
    const binding = m[1];
    const first = firstStatement(src, m.index! + m[0].length);
    const marker = markerAt(rawLines, line);
    let kind = classify(binding, first);
    if (kind === "none" && marker) kind = "marker";
    out.push({ file: rel, line, binding, kind, reason: marker?.[1].trim(), first, form: "catch" });
  }
  for (const m of src.matchAll(/\.catch\(/g)) {
    const line = lineOf(src, m.index!);
    const after = src.slice(m.index! + m[0].length);
    const arrow = after.match(/^\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)?\s*(?::[^)]*)?\)|([A-Za-z_$][\w$]*))\s*=>\s*(\{)?/);
    const binding = arrow ? (arrow[1] ?? arrow[2]) : undefined;
    const block = !!arrow?.[3];
    const first = block ? firstStatement(src, m.index! + m[0].length + arrow![0].length) : after.slice(0, 80).split("\n")[0].trim();
    const marker = markerAt(rawLines, line);
    let kind: CatchSite["kind"] = block ? classify(binding, first) : "none";
    if (kind === "none" && marker) kind = "marker";
    out.push({ file: rel, line, binding, kind, reason: marker?.[1].trim(), first, form: ".catch" });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Every `process.exit(` call in code (comments excluded), as `file:line`. */
export function processExitSites(files = srcFiles()): string[] {
  const out: string[] = [];
  for (const f of files) {
    const s = stripComments(readFileSync(f, "utf8"), { strings: true });
    for (const m of s.matchAll(/\bprocess\.exit\(/g)) out.push(`${relative(process.cwd(), f)}:${lineOf(s, m.index!)}`);
  }
  return out;
}

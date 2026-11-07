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
export const CROSS_FILE_WRAPPERS = [join("src", "eval", "command.ts"), join("src", "hillclimb", "runner.ts")];

/**
 * The files whose catches must let an exit request through: those that import `fail` from envelope.js, call
 * `exitWith(`, or define a `: never` wrapper over either, plus the CROSS_FILE_WRAPPERS. Matched on comment-free text.
 */
export function guardedFiles(files = srcFiles()): string[] {
  return files.filter((f) => {
    if (CROSS_FILE_WRAPPERS.some((w) => f.endsWith(w))) return true;
    const s = stripComments(readFileSync(f, "utf8"));
    if (/import\s*(type\s*)?\{[^}]*\bfail\b[^}]*\}\s*from\s*"[^"]*envelope\.js"/.test(s)) return true;
    if (/\bexitWith\(/.test(s) && !f.endsWith(join("run", "exit.ts"))) return true;
    if (/\bfail\(/.test(s) && f.endsWith(join("run", "envelope.ts"))) return true;
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
}

const MARKER = /\/\/\s*exit-safe:\s*(.+)$/;

export function catchSites(file: string): CatchSite[] {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw, { strings: true });
  const rawLines = raw.split("\n");
  const out: CatchSite[] = [];
  const re = /\}\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\))?\s*\{/g;
  for (const m of src.matchAll(re)) {
    const at = m.index! + m[0].indexOf("catch");
    const line = lineOf(src, at);
    const binding = m[1];
    const bodyStart = m.index! + m[0].length;
    const first = src
      .slice(bodyStart, bodyStart + 300)
      .trimStart()
      .split("\n")[0]
      .trim();
    // A marker on the catch line itself, or as the body's first line: a line that holds only the marker comment and
    // follows a catch line whose body is still open.
    const bodyOpen = rawLines[line - 1].trimEnd().endsWith("{");
    const marker =
      rawLines[line - 1].match(MARKER) ??
      (bodyOpen && /^\s*\/\/\s*exit-safe:/.test(rawLines[line] ?? "") ? (rawLines[line] ?? "").match(MARKER) : null);
    let kind: CatchSite["kind"] = "none";
    if (binding && first.startsWith(`rethrowIfExit(${binding});`)) kind = "rethrowIfExit";
    else if (binding && new RegExp(`^if \\(!\\(${binding} instanceof [\\w$.]+\\)\\) throw ${binding};`).test(first)) kind = "narrow";
    // `if (e instanceof InterruptedError || e instanceof ExitRequested) throw e;`: rethrows the request by name.
    else if (
      binding &&
      new RegExp(
        `^if \\((${binding} instanceof [\\w$.]+ \\|\\| )*${binding} instanceof ExitRequested( \\|\\| ${binding} instanceof [\\w$.]+)*\\) throw ${binding};`,
      ).test(first)
    )
      kind = "narrow";
    else if (marker) kind = "marker";
    out.push({ file: relative(process.cwd(), file), line, binding, kind, reason: marker?.[1].trim(), first });
  }
  return out;
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

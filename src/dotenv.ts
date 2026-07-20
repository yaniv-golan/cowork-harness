import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Thrown by `loadDotenv(file, { strict: true })` when the file cannot be read — missing, a
 * directory (`EISDIR`), unreadable (`EACCES`/`EPERM`), or any other `readFileSync` failure. Used
 * for an explicitly-requested (`--dotenv <path>`) file, where silently falling through to a
 * lower-precedence source would run against the wrong credentials with no indication anything
 * went wrong.
 */
export class DotenvReadError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    super(`--dotenv file could not be read: ${path} (${describeCause(cause)})`);
    this.name = "DotenvReadError";
  }
}

function describeCause(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Minimal `.env` loader (no dependency). Loads `KEY=VALUE` lines from `./.env` into `process.env`
 * at CLI startup so credentials (e.g. `CLAUDE_CODE_OAUTH_TOKEN`) don't have to be `export`ed each
 * run. Standard dotenv semantics: comments (`#`), surrounding quotes, an optional `export ` prefix,
 * and — importantly — **existing `process.env` values win** (an exported var is never overwritten).
 *
 * SECURITY: `.env` is a HOST-side credential store. It is read into this process's env and is NEVER
 * mounted into the sandbox. Keep it at the repo/working-dir root — do NOT place a `.env` inside a
 * mounted skill/project folder, or its contents would be copied into the agent's filesystem. The
 * token value is also scrubbed from all persisted run logs regardless of source.
 *
 * `strict` governs read-failure handling: the default (`false`, used for the automatic optional
 * locations — cwd `.env`, package-root `.env`) is best-effort — any failure to read just yields no
 * vars. Pass `{ strict: true }` for an explicitly-requested file to throw `DotenvReadError` instead
 * of silently returning `[]`, so a directory, a permissions fault, or a typo'd path fails loud
 * rather than falling through to a lower-precedence `.env`.
 */
export function loadDotenv(file = resolve(process.cwd(), ".env"), opts: { strict?: boolean } = {}): string[] {
  if (!existsSync(file)) {
    if (opts.strict) throw new DotenvReadError(file, new Error("no such file or directory"));
    return [];
  }
  const loaded: string[] = [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (opts.strict) throw new DotenvReadError(file, err);
    return [];
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    const quotedM = val.match(/^(["'])(.*)\1\s*(?:#.*)?$/);
    if (quotedM) {
      val = quotedM[2];
    } else {
      val = val.replace(/\s+#.*$/, "").trim();
    }
    // An empty value (`KEY=`) means "not provided" — skip it, so a blank template placeholder is
    // harmless and a later non-empty line (or an exported var) still wins.
    if (val === "") continue;
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded.push(key);
    }
  }
  return loaded;
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
 */
export function loadDotenv(file = resolve(process.cwd(), ".env")): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    const quoted = /^["']/.test(val);
    if (quoted && val.length >= 2 && val[0] === val[val.length - 1]) {
      val = val.slice(1, -1);
    } else {
      // strip a trailing inline comment from an unquoted value
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

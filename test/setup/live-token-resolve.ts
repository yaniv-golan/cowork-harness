// The pure half of the live lane's credential lookup: no side effects on import, so a unit test can load it without
// touching its own worker's environment. test/setup/live-token.ts is the setup file that applies it.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseDotenv } from "../../src/dotenv.js";

/** Where the live lane's token came from (a description, never the value). Test-only; read by the skip messages. */
export const LIVE_TOKEN_SOURCE_VAR = "COWORK_HARNESS_LIVE_TOKEN_SOURCE";

export interface LiveTokenLookup {
  token: string;
  source: string;
}

export interface LiveTokenPaths {
  home?: string;
  repoEnv?: string;
}

function fromDotenv(path: string): string {
  try {
    return parseDotenv(readFileSync(path, "utf8")).get("CLAUDE_CODE_OAUTH_TOKEN") ?? "";
  } catch {
    return "";
  }
}

/**
 * The live lane's token, first hit wins:
 *   1. CLAUDE_CODE_OAUTH_TOKEN exported in the environment
 *   2. COWORK_LIVE_DOTENV=<path>: the live-lane spelling of the CLI's `--dotenv <path>`. When set it is the only
 *      place looked at, and an unreadable file means no credential.
 *   3. ~/.cowork-harness-token
 *   4. this repo's .env (the CLI's own `<install>/.env` fallback)
 */
export function resolveLiveToken(env: NodeJS.ProcessEnv, paths: LiveTokenPaths = {}): LiveTokenLookup {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { token: env.CLAUDE_CODE_OAUTH_TOKEN, source: "environment" };
  const explicit = env.COWORK_LIVE_DOTENV;
  if (explicit) return { token: fromDotenv(explicit), source: `COWORK_LIVE_DOTENV (${explicit})` };
  const file = `${paths.home ?? homedir()}/.cowork-harness-token`;
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return { token: t, source: file };
  }
  const repoEnv = paths.repoEnv ?? resolve(".env");
  return { token: fromDotenv(repoEnv), source: repoEnv };
}

/** Fill CLAUDE_CODE_OAUTH_TOKEN from the lookup when it is unset or empty, and record where the lookup went. */
export function applyLiveToken(env: NodeJS.ProcessEnv, paths: LiveTokenPaths = {}): void {
  const { token, source } = resolveLiveToken(env, paths);
  if (token && !env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env[LIVE_TOKEN_SOURCE_VAR] = token ? source : `none (looked up: ${source})`;
}

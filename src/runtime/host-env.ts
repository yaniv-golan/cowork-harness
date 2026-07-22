/**
 * The single impure boundary: runtime auth/TZ values read from the host env.
 *
 * Auth-env fidelity (SPEC §3.2): real Cowork passes ONLY `CLAUDE_CODE_OAUTH_TOKEN` — the desktop
 * blanks `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_CUSTOM_HEADERS` and deletes them
 * (`rtA`/`itA`, app.asar). So when an OAuth token is present we mirror that and DROP the API-key
 * vars (prefer the token, exactly like the desktop). Only when there is no token do we pass
 * `ANTHROPIC_API_KEY` through — the CI/headless escape hatch the harness intentionally keeps.
 */
/**
 * Env keys whose VALUES are secrets and must never be rendered into a process argv (visible via
 * `ps`/`/proc/<pid>/cmdline`). Docker passes these by NAME only (`-e KEY`, inherited from the docker
 * client's env); the microVM reads them off a stdin prologue. Shared so the renderers can't drift.
 */
export const SECRET_ENV_KEYS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

export function runtimeAuthEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  // TZ parity: Desktop injects the resolved IANA zone into the agent env unconditionally
  // (Intl.DateTimeFormat().resolvedOptions().timeZone). Forwarding it only when the host shell exports
  // TZ would leave the agent with no timezone on a host without it set — diverging from Cowork on date
  // rendering / "today" resolution. Prefer the host value; otherwise resolve it the same way Desktop does.
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) e.TZ = tz;
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) {
    e.CLAUDE_CODE_OAUTH_TOKEN = token; // faithful: token only, no ANTHROPIC_* keys
  } else if (process.env.ANTHROPIC_API_KEY) {
    e.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // CI/headless fallback when no token
  }
  return e;
}

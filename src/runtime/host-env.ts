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
  // TZ parity: Desktop injects `Intl.DateTimeFormat().resolvedOptions().timeZone` into the agent env
  // UNCONDITIONALLY — it never forwards the shell's raw TZ. Match that exactly: Node's resolver already
  // honors a valid TZ export (a host-set IANA zone still flows through), but a legacy/non-IANA export
  // (US/Eastern, EST5EDT, an offset) is NORMALIZED to the IANA zone rather than forwarded raw. Also
  // guarantees a timezone even when the host exports none (else the agent diverges on date/"today").
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) e.TZ = tz;
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) {
    e.CLAUDE_CODE_OAUTH_TOKEN = token; // faithful: token only, no ANTHROPIC_* keys
  } else if (process.env.ANTHROPIC_API_KEY) {
    e.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // CI/headless fallback when no token
  }
  return e;
}

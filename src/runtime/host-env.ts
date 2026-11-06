/**
 * The single impure boundary: runtime auth/TZ values read from the host env.
 *
 * Auth-env fidelity (SPEC §3.2: container/microvm, and hostloop on the token path): real Cowork passes ONLY
 * `CLAUDE_CODE_OAUTH_TOKEN` — the desktop blanks `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
 * `ANTHROPIC_CUSTOM_HEADERS` and deletes them (`rtA`/`itA`, app.asar). So when an OAuth token is
 * present we mirror that and DROP the API-key vars (prefer the token, exactly like the desktop). Only
 * when there is no token do we pass `ANTHROPIC_API_KEY` through — the CI/headless escape hatch the
 * harness intentionally keeps.
 *
 * HOSTLOOP DIVERGENCE, measured 2026-09-06 (this function is imported by all three tiers, so the
 * sentence above is not the whole story). Desktop's NATIVE spawn wrapper — non-win32 only, and reached
 * solely from the host-loop branch — stages the token into a 0600 temp file, opens it, unlinks it, then
 * `delete env.CLAUDE_CODE_OAUTH_TOKEN` and `env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR="3"`. So at
 * hostloop production's agent receives the credential by FD and the harness's receives it by env var.
 *
 * This is a DELIVERY-MECHANISM divergence, not an auth or exposure one, and the reasons are worth
 * recording so nobody "fixes" it into a pipe-and-descriptor emulation:
 *   - the plain env var is still a first-class credential source in the agent (2.1.260 labels it
 *     "from CLAUDE_CODE_OAUTH_TOKEN"; 104 occurrences vs 25 for the FD variant), so auth is unaffected;
 *   - Desktop's own helper logs "falling back to env" and returns undefined on any I/O failure, i.e.
 *     production itself takes the harness's path whenever staging fails;
 *   - the agent's child-process scrubber lists `CLAUDE_CODE_OAUTH_TOKEN` FIRST, and it is the same
 *     binary here, so every Bash-tool subprocess is scrubbed identically in both;
 *   - at container/microvm production does NOT wrap at all — it passes the plain token into the guest,
 *     exactly as the harness does. The divergence is hostloop-only.
 * At hostloop the harness spawns a native process from an env that already holds the token, on the
 * operator's own machine, so nothing crosses a boundary that was closed before.
 *
 * HOSTLOOP INHERITANCE. Unlike container/microvm, the hostloop agent inherits the operator's whole shell
 * (`buildHostLoopNativeEnv`), so `runtimeAuthEnv` choosing the token was not enough on its own there: an
 * exported key still reached the agent beside it. When the token is what the agent is given, that builder
 * now drops `TOKEN_PATH_DROPPED_ENV_KEYS` from the inherited layer, so the agent's env no longer carries
 * them, as in Desktop. Desktop gets there differently: it builds the host-loop env from named keys and
 * never inherits a shell. The rest of the shell (`ANTHROPIC_BASE_URL` included) is still inherited here.
 * Only the environment is covered: a managed `settings.json` (`env`, `apiKeyHelper`) can still hand the
 * agent a key, in Desktop as well.
 */
/** The operator-shell keys the hostloop agent does not inherit when `runtimeAuthEnv` gives it the OAuth token.
 *  `ANTHROPIC_CUSTOM_HEADERS` is dropped only on the token path, a choice rather than a fidelity consequence (Desktop
 *  never passes the operator's): with no token, an API-key gateway that needs a header keeps working. */
export const TOKEN_PATH_DROPPED_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"] as const;
/**
 * Env keys whose VALUES are secrets and must never be rendered into a process argv (visible via
 * `ps`/`/proc/<pid>/cmdline`). Docker passes these by NAME only (`-e KEY`, inherited from the docker
 * client's env); the microVM reads them off a stdin prologue. Shared so the renderers can't drift.
 */
export const SECRET_ENV_KEYS = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

/** The credential key `runtimeAuthEnv` hands the agent on every isolated tier (container, microvm, hostloop): the
 *  OAuth token when set, else the API key, never `ANTHROPIC_AUTH_TOKEN`. At container and microvm it is the only one.
 *  At hostloop the agent also inherits the operator's shell, so with no token set an exported `ANTHROPIC_AUTH_TOKEN`
 *  (or `ANTHROPIC_CUSTOM_HEADERS`) still reaches it; with the token set they are dropped (`TOKEN_PATH_DROPPED_ENV_KEYS`).
 *  `runtimeAuthEnv` builds from it and `doctor` names it from it, so the two cannot disagree. */
export function runtimeAuthKey(env: NodeJS.ProcessEnv = process.env): "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | undefined {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  return undefined;
}

export function runtimeAuthEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  // TZ parity: Desktop injects `Intl.DateTimeFormat().resolvedOptions().timeZone` into the agent env
  // UNCONDITIONALLY — it never forwards the shell's raw TZ. Match that exactly: Node's resolver already
  // honors a valid TZ export (a host-set IANA zone still flows through), but a legacy/non-IANA export
  // (US/Eastern, EST5EDT, an offset) is NORMALIZED to the IANA zone rather than forwarded raw. Also
  // guarantees a timezone even when the host exports none (else the agent diverges on date/"today").
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) e.TZ = tz;
  // Faithful: the token only, no ANTHROPIC_* keys; the API key is the CI/headless fallback when no token is set.
  const key = runtimeAuthKey();
  if (key) e[key] = process.env[key]!;
  return e;
}

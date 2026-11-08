// `agent_env.passthrough`: operator-env names the hostloop agent is given beside the ones Desktop copies. What may be
// named depends on the baseline (the keys its spawn env sets), so the check runs before the run, where the baseline is
// resolved, not in the session schema.
import type { PlatformBaseline } from "../types.js";
import { SCRUBBED_AGENT_ENV_KEYS } from "../session.js";
import { AUTO_MEMORY_ENV_KEY } from "../loop-decision.js";
import { BACKGROUND_TASKS_ENV_KEY } from "./argv.js";
import { buildHostLoopNativeEnv } from "./hostloop.js";
import { runtimeAuthKey, SECRET_ENV_KEYS, SESSIONS_OAUTH_TOKEN_KEY, TOKEN_PATH_DROPPED_ENV_KEYS } from "./host-env.js";

/** The one header variable a passthrough may carry, and only when the agent is not given the OAuth token. */
const CUSTOM_HEADERS_KEY = "ANTHROPIC_CUSTOM_HEADERS";

/** The credential names a passthrough refuses: the agent is given exactly one credential (`runtimeAuthEnv`). */
export function passthroughCredentialKeys(): Set<string> {
  return new Set([...SECRET_ENV_KEYS, SESSIONS_OAUTH_TOKEN_KEY]);
}

/**
 * The names the harness sets or deletes in the hostloop agent's env itself, for this baseline: a passthrough of one
 * would be overwritten or dropped without a word. Derived, never listed: every key `buildHostLoopNativeEnv` emits over an
 * empty operator layer with a placeholder for every key the spawn's `extra` carries (CLAUDE_PLUGIN_ROOT, TZ and both
 * credentials), unioned over its gated conditions (connected folders; the Desktop-version gate, forced on through a
 * high app version), plus every name the builder deletes, plus the credentials. `ANTHROPIC_CUSTOM_HEADERS` is left
 * out unless the baseline itself sets it: whether it may pass depends on the credential (`passthroughRefusal`).
 */
export function passthroughRefusalSet(baseline: PlatformBaseline): Set<string> {
  const placeholders = { CLAUDE_PLUGIN_ROOT: "x", TZ: "x", CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_API_KEY: "x" };
  const out = new Set<string>();
  for (const b of [baseline, { ...baseline, appVersion: "999999.0.0" }])
    for (const k of Object.keys(
      buildHostLoopNativeEnv(b, { configDir: "/x", extra: placeholders, folderHostPaths: ["/x"], operatorEnv: {} }),
    ))
      out.add(k);
  for (const k of [
    ...SCRUBBED_AGENT_ENV_KEYS,
    AUTO_MEMORY_ENV_KEY,
    BACKGROUND_TASKS_ENV_KEY,
    "MAX_THINKING_TOKENS",
    ...TOKEN_PATH_DROPPED_ENV_KEYS.filter((k) => k !== CUSTOM_HEADERS_KEY),
    ...passthroughCredentialKeys(),
  ])
    out.add(k);
  return out;
}

/** Why this session's `agent_env.passthrough` cannot run at `tier`, or undefined. `env` is the harness's env, after
 *  every .env source (the credential it holds decides whether `ANTHROPIC_CUSTOM_HEADERS` may pass). */
export function passthroughRefusal(
  session: { agent_env: { passthrough?: readonly string[] } },
  tier: string,
  baseline: PlatformBaseline,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const names = session.agent_env.passthrough ?? [];
  if (!names.length) return undefined;
  const head = "`agent_env.passthrough`";
  if (tier === "container" || tier === "microvm")
    return `${head} applies at fidelity hostloop (protocol inherits your environment anyway): at fidelity ${tier} the agent runs in a sandbox with a fixed environment, so ${names.join(", ")} would not reach it. Remove it for this tier.`;
  const credentials = passthroughCredentialKeys();
  const cred = names.filter((n) => credentials.has(n));
  if (cred.length)
    return `${head} cannot carry a credential (${cred.join(", ")}): the agent is given exactly one, from CLAUDE_CODE_OAUTH_TOKEN or else ANTHROPIC_API_KEY.`;
  const owned = passthroughRefusalSet(baseline);
  const set = names.filter((n) => owned.has(n));
  if (set.length)
    return `${head} cannot name ${set.join(", ")}: the harness sets or removes ${set.length === 1 ? "it" : "them"} in the agent's environment itself (from the baseline and the session), so the value you pass would be overwritten or dropped.`;
  if (tier === "protocol") {
    const stripped = names.filter((n) => (baseline.bgEnvStrip?.knownVars ?? []).includes(n));
    if (stripped.length)
      return `${head} cannot name ${stripped.join(", ")} at fidelity protocol: Cowork strips ${stripped.length === 1 ? "it" : "them"} from the agent's environment (the baseline's bgEnvStrip), and so does the harness.`;
  }
  if (names.includes(CUSTOM_HEADERS_KEY) && runtimeAuthKey(env) === "CLAUDE_CODE_OAUTH_TOKEN")
    return `${head} cannot pass ${CUSTOM_HEADERS_KEY} while the agent is given the OAuth token: a header can carry a second credential beside it. Unset CLAUDE_CODE_OAUTH_TOKEN and use ANTHROPIC_API_KEY to send custom headers.`;
  return undefined;
}

/** The names-only stderr line for passthrough names this environment does not set, or undefined. */
export function passthroughUnsetNotice(names: readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const unset = (names ?? []).filter((n) => env[n] === undefined);
  return unset.length ? `[agent_env] passthrough: not set in this environment, so not passed: ${unset.join(", ")}` : undefined;
}

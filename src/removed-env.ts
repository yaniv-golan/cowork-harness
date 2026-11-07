// Environment variables a 5.x build no longer reads. Each one changed behaviour in 4.x, so an operator who still
// exports it expects that behaviour: a silent ignore would run something other than what they asked for. Refused at
// CLI startup, after every .env source the startup loads, naming what replaced it. An empty value counts as unset (the
// repo's unset idiom).

const REMOVED_ENV: ReadonlyArray<readonly [name: string, remedy: string]> = [
  [
    "COWORK_MANAGED_CONFIG",
    "fidelity protocol always gives the agent a managed config dir now, so the switch has nothing left to select. Unset it, " +
      "and put a credential in the environment or a .env (CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token), ANTHROPIC_API_KEY or " +
      "ANTHROPIC_AUTH_TOKEN): a Keychain or /login session is not used",
  ],
  [
    "COWORK_HARNESS_ALLOW_CONFIG_DIR_WRITE",
    "a pinned plugins.config_dir is now used only by the run that created it, and an existing directory the harness did not " +
      "create is refused, so there is nothing left to allow. Unset it, and point plugins.config_dir at a path that does not exist yet",
  ],
];

/** The refusal for every removed variable set to a non-empty value, or undefined when none is. */
export function removedEnvRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const hits = REMOVED_ENV.filter(([name]) => (env[name] ?? "") !== "");
  if (!hits.length) return undefined;
  return hits.map(([name, remedy]) => `${name} was removed in 5.0.0 — ${remedy}.`).join("\n");
}

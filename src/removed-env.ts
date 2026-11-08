// Environment variables a 5.x build no longer reads, removed or renamed. Each one changed behaviour in 4.x, so an operator who still
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

// Renamed in 5.0.0 into the COWORK_HARNESS_ namespace: the harness's own knobs, apart from the agent/proxy binary and
// image overrides and Desktop's COWORK_ARTIFACTS_ROOT. The old name is refused even when the new one is also set: the
// operator still exports a name this build no longer reads. Spelled out, not derived: the surface scrape reads quoted
// literals, and keeps the old names in the surface as refused names.
const RENAMED_ENV: ReadonlyArray<readonly [oldName: string, newName: string]> = [
  ["COWORK_LOCKDOWN", "COWORK_HARNESS_LOCKDOWN"],
  ["COWORK_LIMA_INSTANCE", "COWORK_HARNESS_LIMA_INSTANCE"],
  ["COWORK_LIMACTL", "COWORK_HARNESS_LIMACTL"],
  ["COWORK_VM_PROVISION_TIMEOUT_S", "COWORK_HARNESS_VM_PROVISION_TIMEOUT_S"],
  ["COWORK_VM_PROXY_PORT", "COWORK_HARNESS_VM_PROXY_PORT"],
  ["COWORK_VM_GATEWAY", "COWORK_HARNESS_VM_GATEWAY"],
  ["COWORK_CONTAINER_RUNTIME", "COWORK_HARNESS_CONTAINER_RUNTIME"],
  ["COWORK_SKIP_CAPABILITY_PROBE", "COWORK_HARNESS_SKIP_CAPABILITY_PROBE"],
];

/** Every name this build refuses at startup: the removed ones and the old spelling of each renamed one. */
export const REFUSED_ENV_NAMES: readonly string[] = [...REMOVED_ENV.map(([n]) => n), ...RENAMED_ENV.map(([n]) => n)];

/** The refusal for every removed or renamed variable set to a non-empty value, or undefined when none is. */
export function removedEnvRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const set = (name: string) => (env[name] ?? "") !== "";
  const lines = [
    ...REMOVED_ENV.filter(([name]) => set(name)).map(([name, remedy]) => `${name} was removed in 5.0.0 — ${remedy}.`),
    ...RENAMED_ENV.filter(([name]) => set(name)).map(([name, to]) => `${name} was renamed in 5.0.0 to ${to}. Set that instead.`),
  ];
  return lines.length ? lines.join("\n") : undefined;
}

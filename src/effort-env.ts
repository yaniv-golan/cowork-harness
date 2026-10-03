/** The env keys through which a shell export changes the effort or thinking a `claude` process uses — read from the
 *  agent binary (2.1.286) and the host CLI (2.1.288), which share the resolver:
 *  - `CLAUDE_CODE_EFFORT_LEVEL` is taken AHEAD of `--effort` (`unset`/`auto` mean "model default", which displaces
 *    the flag too); only a hook's effort value outranks it;
 *  - `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` sends an effort parameter for a model the binary has no effort data for;
 *  - `CLAUDE_CODE_DISABLE_THINKING` turns thinking off whatever the thinking flag says.
 *  Two consumers drop them from an inherited environment: the agent spawn on the env-inheriting tiers
 *  (`SCRUBBED_AGENT_ENV_KEYS`) and every host-`claude` grader call (`llm-transport`). */
export const EFFORT_THINKING_ENV_KEYS = [
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_DISABLE_THINKING",
] as const;

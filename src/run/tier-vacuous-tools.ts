import { WORKSPACE_TOOL_ALIASES, VM_LOOP_TOOL_ALIASES } from "../runtime/hostloop.js";

/** Tools a tier PROVABLY does not serve, and what to write instead.
 *
 * THE DEFECT. `tool_not_called: "Bash"` at `hostloop` passes vacuously, always: that tier replaces the
 * built-in shell with `mcp__workspace__bash`, so the run could never have called `Bash` whatever the
 * agent did. The assertion reads as a guarantee and verifies nothing. The inverse is equally broken —
 * `tool_not_called: "mcp__workspace__bash"` at `container`, where the built-in `Bash` is served instead.
 *
 * WHY THIS TABLE IS CLOSED, AND NOT DERIVED FROM THE LAUNCH PLAN. The obvious implementation computes
 * the offered set as `spawn.tools − disallowed + extraTools` (what `argv.ts` passes as `--tools`) and
 * rejects any pattern matching nothing in it. That is UNSOUND: the agent binary's own help text reads
 * "--tools … Specify the list of available tools **from the built-in set**", and every sandbox tier
 * separately passes `--mcp-config`. A session's `mcp.config` server — a documented feature the repo ships
 * an example of (`examples/data/mcp.json`) — registers tools that appear in no launch set, so
 * `tool_not_called: "mcp__example-fs__write_file"` would have been rejected while the tool was registered
 * and callable. That is the single most valuable kind of negative assertion there is.
 *
 * So this table names ONLY tools the harness itself removes or registers, per tier. It never consults
 * `spawn.tools`, which makes it immune to that hole by construction, independent of the baseline (a
 * `spawn`-less baseline cannot make it misfire), and unable to collide with any MCP name (the visualize prefix below is skipped when the session's own MCP config declares a server of that name). The cost is
 * that it under-approximates — `REPL` at hostloop is genuinely vacuous too and is not caught — which is
 * the correct side to err on when the verdict is a hard refusal.
 *
 * A fired reject therefore CANNOT be a false positive, which is why there is no opt-out. The repo's eight
 * `allow_*` modifiers all cover cases where the harness might be wrong about a real signal; here there is
 * no legitimate scenario to rescue. If one is ever found, the table is wrong and the table should change.
 */
const TIER_VACUOUS: Record<string, Record<string, string | null>> = {
  // The host loop disallows Bash and WebFetch and aliases both (WORKSPACE_TOOL_ALIASES), and disallows
  // NotebookEdit outright with no replacement.
  hostloop: { ...WORKSPACE_TOOL_ALIASES, NotebookEdit: null },
  // The VM loop keeps the built-in shell, so `Bash` is legitimate here — only the workspace shell is not
  // served, because this tier registers no workspace bash server.
  container: { mcp__workspace__bash: "Bash" },
  // microvm passes neither `disallowed` nor `extraTools` (runtime/microvm.ts), so it registers no
  // workspace server at all and keeps every built-in. Derived from that, not measured: the run population
  // this table was built against contains zero microvm runs.
  microvm: { mcp__workspace__bash: "Bash", mcp__workspace__web_fetch: "WebFetch" },
  // `protocol` is deliberately ABSENT. It passes no --tools/--allowedTools/--disallowedTools at all
  // (runtime/protocol.ts), so its surface is the operator's own host CLI registry — machine-dependent,
  // varying with their CLI version, and about a different product. Any verdict there would be noise.
};

/** The VM loop aliases WebFetch only when `coworkWebFetchViaApi` is on, so `WebFetch` at `container` is
 *  vacuous only in that configuration — passed in rather than read here, so this module stays pure. */
function containerVacuous(webFetchViaApi: boolean): Record<string, string | null> {
  return webFetchViaApi ? { ...TIER_VACUOUS.container, ...VM_LOOP_TOOL_ALIASES } : { ...TIER_VACUOUS.container };
}

export interface TierVacuousFinding {
  tool: string;
  tier: string;
  /** The tool to assert instead, or null when the tier removes it with no replacement. */
  instead: string | null;
  /** Set for a remote-devices tool: served only under `device_bridge: true` (`device-bridge-off`), or never served by
   *  the harness (`device-unserved`); or for a tool of production's `visualize` server, which the harness never
   *  registers (`visualize-unserved`). Absent for a tier-table tool. */
  reason?: "device-bridge-off" | "device-unserved" | "visualize-unserved";
}

const DEVICE_PREFIX = "mcp__remote-devices__";
/** What `device_bridge: true` serves (src/hostloop/remote-devices-handler.ts). */
const DEVICE_BRIDGE_SERVED = new Set(["device_bash", "get_device_info"]);
/** Production's remote-devices tools (the baseline `cloud.remoteDevicesTools` list). A bridged host server's tool
 *  nests one level deeper (`<server>__<tool>`) and is not in this list, so it is never refused. */
const REMOTE_DEVICE_TOOLS = new Set([
  "list_devices",
  "get_device_info",
  "device_list_dir",
  "device_stage_files",
  "device_commit_files",
  "device_bash",
  "device_request_folder_access",
  "device_request_delete_permission",
  "create_artifact",
  "update_artifact",
  "list_artifacts",
  "list_legacy_live_artifacts",
  "project_memory_read",
  "project_memory_write",
]);

const VISUALIZE_SERVER = "visualize";
const VISUALIZE_PREFIX = `mcp__${VISUALIZE_SERVER}__`;
/** The tools of production's in-process `visualize` server (Desktop's `getImagineServerDef`: the skill-argument
 *  form's `read_me` and `show_widget`). The harness registers no such server on any tier, so a negative assertion on
 *  either passes vacuously. Keep in sync with scenario.py's `_VISUALIZE_TOOLS`.
 *
 *  WHEN THE FORM STUB LANDS: the harness will then serve both tools under the planned `argument_form: on | form`
 *  (hostloop and container), so this refusal must become conditional on that key, the way `DEVICE_BRIDGE_SERVED`
 *  is on `device_bridge`. Thread the key in as `tierVacuousTool`'s `deviceBridge` flag is, here and in scenario.py. */
const VISUALIZE_TOOLS = new Set(["read_me", "show_widget"]);

/** Is this EXACT tool name provably unservable at this tier? Literals only — a glob is never rejected,
 *  since `mcp__*` or `Ba*` can match something the tier does serve. */
export function tierVacuousTool(
  pattern: string,
  tier: string,
  webFetchViaApi: boolean,
  deviceBridge = false,
  /** Server names the session's own `mcp.config` declares. A session server that happens to share a name with
   *  production's serves its tools, so a name it covers is never refused. */
  sessionMcpServers: ReadonlySet<string> = new Set(),
): TierVacuousFinding | undefined {
  // A pattern with a glob metacharacter is not a literal claim about one tool.
  if (/[*?]/.test(pattern)) return undefined;
  // The visualize tools are served by no tier. `protocol` stays out, as below.
  if (pattern.startsWith(VISUALIZE_PREFIX) && tier in TIER_VACUOUS && !sessionMcpServers.has(VISUALIZE_SERVER)) {
    if (VISUALIZE_TOOLS.has(pattern.slice(VISUALIZE_PREFIX.length)))
      return { tool: pattern, tier, instead: null, reason: "visualize-unserved" };
  }
  // The remote-devices tools are served by no tier on their own: two of them under device_bridge, the rest never.
  // `protocol` stays out, as below: its surface is the operator's own CLI registry.
  if (pattern.startsWith(DEVICE_PREFIX) && tier in TIER_VACUOUS) {
    const name = pattern.slice(DEVICE_PREFIX.length);
    if (DEVICE_BRIDGE_SERVED.has(name))
      return deviceBridge ? undefined : { tool: pattern, tier, instead: null, reason: "device-bridge-off" };
    if (REMOTE_DEVICE_TOOLS.has(name)) return { tool: pattern, tier, instead: null, reason: "device-unserved" };
  }
  const table = tier === "container" ? containerVacuous(webFetchViaApi) : TIER_VACUOUS[tier];
  if (!table || !(pattern in table)) return undefined;
  return { tool: pattern, tier, instead: table[pattern] ?? null };
}

/** The object form of `tool_not_called`: vacuous only when EVERY `tool` member is a literal the tier does
 *  not serve. One served member (`[Bash, mcp__workspace__bash]` — the portable spelling) or any glob keeps
 *  it satisfiable, so it is never refused. An `input`/`result` predicate cannot rescue a vacuous tool: a
 *  call that can never happen satisfies no predicate either. Returns the first unserved member's finding
 *  (for the message) when all are unserved. */
export function objectFormTierVacuous(
  value: { tool: string | string[] },
  tier: string,
  webFetchViaApi: boolean,
  deviceBridge = false,
  sessionMcpServers: ReadonlySet<string> = new Set(),
): TierVacuousFinding | undefined {
  const tools = Array.isArray(value.tool) ? value.tool : [value.tool];
  const findings = tools.map((t) => tierVacuousTool(t, tier, webFetchViaApi, deviceBridge, sessionMcpServers));
  if (findings.length === 0 || findings.some((f) => f === undefined)) return undefined;
  return findings[0];
}

/** Keys this refusal covers. Both are NEGATIVE tool assertions judged against a set of names the tier
 *  never produces, so both pass vacuously in exactly the same way.
 *
 *  `subagent_tool_absent` belongs here despite an earlier belief that it did not. It reads
 *  `ctx.subagentTools` — the tools sub-agents actually USED (`assert.ts:1418`) — NOT
 *  `subagents[].declaredTools`, so there is no second inventory and no category error. Corroborated by
 *  the run population: sub-agent `Bash` calls appear 20 times, all at `container`, never at `hostloop`.
 *  Excluding it left the harness refusing `tool_not_called: "Bash"` at hostloop while silently greening
 *  `subagent_tool_absent: "Bash"` — teaching an author that this class is caught, then not catching it. */
export type TierVacuousKey = "tool_not_called" | "subagent_tool_absent";

/** The load-time refusal text. Names what is wrong, why it can never hold, what to write instead, and —
 *  because an author will meet it — that `tool_called` behaves differently. */
export function tierVacuousMessage(f: TierVacuousFinding, key: TierVacuousKey, context: string): string {
  if (f.reason === "visualize-unserved")
    return (
      `${context}: \`${key}: "${f.tool}"\` can never be violated — the harness never serves the \`visualize\` server ` +
      `(production's skill-argument form tools), so the assertion passes vacuously. Drop it.` +
      `\nThe positive sibling is NOT refused: \`tool_called: "${f.tool}"\` fails normally.`
    );
  if (f.reason !== undefined)
    return (
      `${context}: \`${key}: "${f.tool}"\` can never be violated — ` +
      (f.reason === "device-bridge-off"
        ? `the harness serves \`${f.tool}\` only when the scenario sets \`device_bridge: true\` (with \`lane: remote\` and ` +
          `\`fidelity: container\`), so without it the assertion passes vacuously. Set device_bridge, or drop this assertion.`
        : `the harness serves no such device tool (\`device_bridge: true\` serves device_bash and get_device_info only), so ` +
          `the assertion passes vacuously. Drop it.`) +
      `\nThe positive sibling is NOT refused: \`tool_called: "${f.tool}"\` fails normally.`
    );
  const remedy =
    f.instead === null
      ? `The \`${f.tier}\` tier removes \`${f.tool}\` outright, so there is no replacement to assert — drop this assertion.`
      : `Assert \`${key}: "${f.instead}"\` instead: that is the tool \`${f.tier}\` actually serves in its place.`;
  return (
    `${context}: \`${key}: "${f.tool}"\` can never be violated at fidelity \`${f.tier}\` — that tier does not ` +
    `serve \`${f.tool}\` at all, so the assertion passes vacuously and verifies nothing. ${remedy}\n` +
    `The positive sibling is NOT refused: \`tool_called: "${f.tool}"\` fails normally, which is a legible red ` +
    `rather than a false green.`
  );
}

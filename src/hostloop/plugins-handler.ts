import type { McpHandler, McpResult } from "./workspace-handler.js";
import type { MountedPlugin } from "../session.js";

/**
 * The `plugins` sdk-MCP server, driver-side — models the Desktop-side plugin-discovery surface a real
 * cowork-lane session declares alongside `skills`/`workspace`/`cowork`: `list_plugins`, `search_plugins`,
 * `suggest_plugin_install`. Binary-verified (2026-07-24 confirmation pass, app.asar 1.24012.1): the tool inventory and all three inputSchemas, plus `list_plugins`'s
 * output envelope (`{contextLabel, plugins:[{pluginName, pluginId, description, skills}]}`), are pinned
 * to the extracted asar. `search_plugins`/`suggest_plugin_install`'s output envelopes were NOT captured
 * in the extraction (these two are advisory, adjacent
 * to the pinned `list_plugins` shape) — the response shapes below are a harness-authored deterministic
 * stub modeled to mirror the `skills` server's own widget-render-acknowledgment pattern for internal
 * consistency, not a captured constant. Same caveat as `skills-handler.ts` for the tool DESCRIPTION
 * strings: prose reconstructed from the confirmed semantic fragments, not a literal wire byte-string.
 *
 * Every tool is `_meta:{"anthropic/alwaysLoad":true}` (see `skills-handler.ts`'s header comment for why).
 *
 * `list_plugins` is populated from the session's actually-mounted plugins (`mountedPluginsFromPlan`),
 * deterministic and run-derived. `search_plugins`/`suggest_plugin_install` never search or install
 * anything — the real add/install happens out of band, outside the session; an empty-catalog `search_plugins`
 * result is the faithful stub, matching `suggest_skills`'s same posture.
 */

const LIST_PLUGINS_DESC =
  "List the plugins installed in this session, each with its skills. Omit keywords to show every " +
  "installed plugin; pass keywords to filter by topic over each plugin's name/description/skills. " +
  "context_label is a display-only header — it does not filter.";
const SEARCH_PLUGINS_DESC =
  "Search for a plugin that could help with the user's request. Pass userIntent as the request verbatim " +
  "or lightly paraphrased (not pre-tokenized keywords); keywords is optional extra filtering. Set " +
  "includeInstalled to also consider already-installed plugins (onboarding).";
const SUGGEST_PLUGIN_INSTALL_DESC =
  "Render an install suggestion for one or more plugins. contextLabel is a short (3-5 word) header " +
  '("For your …"); plugins is the list of candidates to suggest, each with pluginName, pluginId, and ' +
  "description.";

type JsonSchema = Record<string, unknown>;

export interface MakePluginsHandlerOptions {
  /** This session's mounted plugins — see `mountedPluginsFromPlan`. */
  mountedPlugins: MountedPlugin[];
  /** TEST SEAM — called for every `tools/call`, before dispatch. Deliberately not wired by
   *  container.ts/hostloop.ts (no run-telemetry sink for discovery calls today); it exists so tests can
   *  assert dispatch without a spawn. Do not describe it as run observability until something consumes it. */
  onCall?: (name: string, args: Record<string, unknown>) => void;
}

const tools: Array<{ name: string; description: string; inputSchema: JsonSchema; _meta: { "anthropic/alwaysLoad": true } }> = [
  {
    name: "list_plugins",
    description: LIST_PLUGINS_DESC,
    inputSchema: {
      type: "object",
      properties: {
        keywords: { type: "array", items: { type: "string" } },
        context_label: { type: "string" },
      },
      required: [],
    },
    _meta: { "anthropic/alwaysLoad": true },
  },
  {
    name: "search_plugins",
    description: SEARCH_PLUGINS_DESC,
    inputSchema: {
      type: "object",
      properties: {
        userIntent: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        includeInstalled: { type: "boolean" },
        trigger: { type: "string", enum: ["user_asked", "proactive"] },
      },
      required: ["userIntent"],
    },
    _meta: { "anthropic/alwaysLoad": true },
  },
  {
    name: "suggest_plugin_install",
    description: SUGGEST_PLUGIN_INSTALL_DESC,
    inputSchema: {
      type: "object",
      properties: {
        contextLabel: { type: "string" },
        plugins: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pluginName: { type: "string" },
              pluginId: { type: "string" },
              description: { type: "string" },
              backendId: { type: "string" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, description: { type: "string" } },
                  required: ["name"],
                },
              },
            },
            required: ["pluginName", "pluginId", "description"],
          },
        },
      },
      required: ["contextLabel", "plugins"],
    },
    _meta: { "anthropic/alwaysLoad": true },
  },
];

export function makePluginsHandler(opts: MakePluginsHandlerOptions): McpHandler {
  const { mountedPlugins, onCall } = opts;

  function callListPlugins(args: Record<string, unknown>): McpResult {
    const keywords = Array.isArray(args.keywords) ? args.keywords.filter((s): s is string => typeof s === "string") : undefined;
    const contextLabel = typeof args.context_label === "string" ? args.context_label : undefined;
    let plugins = mountedPlugins;
    if (keywords && keywords.length) {
      const needles = keywords.map((k) => k.toLowerCase());
      plugins = mountedPlugins.filter((p) => {
        const haystack = [p.pluginName, p.description ?? "", ...p.skills.flatMap((s) => [s.name, s.description ?? ""])]
          .join(" ")
          .toLowerCase();
        return needles.some((k) => haystack.includes(k));
      });
    }
    return {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              contextLabel,
              plugins: plugins.map((p) => ({
                pluginName: p.pluginName,
                pluginId: p.pluginId,
                description: p.description,
                skills: p.skills,
              })),
            }),
          },
        ],
      },
    };
  }

  function callSearchPlugins(args: Record<string, unknown>): McpResult {
    if (typeof args.userIntent !== "string" || args.userIntent === "") {
      return { error: { code: -32602, message: "search_plugins: userIntent is required" } };
    }
    const keywords = Array.isArray(args.keywords) ? args.keywords.filter((s): s is string => typeof s === "string") : [];
    return {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              userIntent: args.userIntent,
              keywords,
              matched_plugins: [],
              note:
                "No plugin catalog match — plugin search runs against Anthropic's live catalog, which this " +
                "harness does not model. Call suggest_plugin_install directly if you already know the plugin " +
                "to recommend.",
            }),
          },
        ],
      },
    };
  }

  function callSuggestPluginInstall(args: Record<string, unknown>): McpResult {
    if (typeof args.contextLabel !== "string" || args.contextLabel === "") {
      return { error: { code: -32602, message: "suggest_plugin_install: contextLabel is required" } };
    }
    if (!Array.isArray(args.plugins)) {
      return { error: { code: -32602, message: "suggest_plugin_install: plugins must be an array" } };
    }
    const malformed = args.plugins.some(
      (p) =>
        !p ||
        typeof p !== "object" ||
        typeof (p as Record<string, unknown>).pluginName !== "string" ||
        typeof (p as Record<string, unknown>).pluginId !== "string" ||
        typeof (p as Record<string, unknown>).description !== "string",
    );
    if (malformed) {
      return {
        error: { code: -32602, message: "suggest_plugin_install: each plugin requires pluginName, pluginId, and description" },
      };
    }
    return {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              contextLabel: args.contextLabel,
              plugins: args.plugins,
              note: "Plugin install widget rendered above with the listed plugins. Skip re-listing them in text.",
            }),
          },
        ],
      },
    };
  }

  return (_server, jr): McpResult => {
    const method = jr.method;
    if (method === "initialize")
      return {
        result: {
          protocolVersion: (jr.params && jr.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "plugins", version: "1.0.0" },
        },
      };
    if (method === "tools/list") return { result: { tools } };
    if (method === "tools/call") {
      const name = jr.params?.name;
      const args = (jr.params?.arguments ?? {}) as Record<string, unknown>;
      onCall?.(name, args);
      if (name === "list_plugins") return callListPlugins(args);
      if (name === "search_plugins") return callSearchPlugins(args);
      if (name === "suggest_plugin_install") return callSuggestPluginInstall(args);
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
    }
    return { result: {} }; // ping / notifications
  };
}

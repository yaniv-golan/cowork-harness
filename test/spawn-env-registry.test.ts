import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  classifySpawnEnvKey,
  registryEntries,
  SPAWN_ENV_CLASSES,
  SPAWN_ENV_PATTERNS,
  type SpawnEnvSite,
} from "../src/sync/spawn-env-registry.js";

// The window-site tables as they stood before the registry existed (SPAWN_ENV_ALLOWLIST and SPAWN_PIN_KEYS in
// src/sync/cowork-sync.ts at 88428ac0). deriveSpawnEnv reads only the window site, so the registry must yield exactly
// these two sets there: a host-loop or observed row (PATH, HOME, …) must never widen what the window scan admits.
const WINDOW_ALLOWLIST_BEFORE = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_ARTIFACT_HOST_GRANT",
  "CLAUDE_CODE_ACCOUNT_TAGGED_ID",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_ATTRIBUTION_PROJECT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_BRIEF",
  "CLAUDE_CODE_BRIEF_UPLOAD",
  "CLAUDE_CODE_COWORK_FRAME_ARTIFACTS",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_DESKTOP_SKILL_SWITCHES",
  "CLAUDE_CODE_DIAGNOSTICS_FILE",
  "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_DISABLE_FAST_MODE",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL",
  "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK",
  "CLAUDE_CODE_ENABLE_AUTO_MODE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_PLATFORM",
  "CLAUDE_CODE_HOST_SCHEDULED_RUN",
  "CLAUDE_CODE_MODEL_CATALOG",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_SKIP_PRECOMPACT_LOAD",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_TOOL",
  "CLAUDE_PROJECT_UUID",
  "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
  "DISABLE_BRIEF_MODE_STOP_HOOK",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_FEEDBACK_COMMAND",
  "DISABLE_GROWTHBOOK",
  "DISABLE_TELEMETRY",
  "ENABLE_TOOL_SEARCH",
  "MCP_CONNECT_TIMEOUT_MS",
  "TZ",
];
const WINDOW_PINS_BEFORE = [
  "API_TIMEOUT_MS",
  "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CLAUDE_CODE_DISABLE_AGENTS_FLEET",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_IS_COWORK",
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_QUESTION_EXTENDED",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_TAGS",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
  "DISABLE_AUTOUPDATER",
  "DISABLE_MICROCOMPACT",
  "ENABLE_PROMPT_CACHING_1H",
  "MCP_CONNECTION_NONBLOCKING",
  "MCP_TOOL_TIMEOUT",
  "PYTHONDONTWRITEBYTECODE",
  // Desktop 3.1623.4: an unconditional "" in W2, pinned after the registry existed.
  "CLAUDE_CODE_ENTRYPOINT_ON_REQUESTS",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
];

// Every env key NAME seen in Desktop's `[HostLoop] sdkOptions after patch` dumps (175 local host-loop sessions,
// Desktop 2.19675.0–2.31226.1). Names only: product vocabulary, nothing from the operator's environment.
const OBSERVED_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "API_FORCE_IDLE_TIMEOUT",
  "API_TIMEOUT_MS",
  "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CLAUDE_CODE_ACCOUNT_TAGGED_ID",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
  "CLAUDE_CODE_COWORK_FRAME_ARTIFACTS",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_DISABLE_AGENTS_FLEET",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_HOST_PLATFORM",
  "CLAUDE_CODE_HOST_SCHEDULED_RUN",
  "CLAUDE_CODE_IS_COWORK",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_PLUGIN_ATTRIBUTION",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SKILL_ATTRIBUTION",
  "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_TAGS",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
  "DISABLE_AUTOUPDATER",
  "DISABLE_MICROCOMPACT",
  "DOCUMENTS_MCP_SCRATCH_ROOT",
  "ENABLE_PROMPT_CACHING_1H",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_KEY_2",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_VALUE_1",
  "GIT_CONFIG_VALUE_2",
  "GIT_DIR",
  "HOME",
  "LOGNAME",
  "MCP_CONNECTION_NONBLOCKING",
  "MCP_TOOL_TIMEOUT",
  "NODE_USE_SYSTEM_CA",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "PATH",
  "PYTHONDONTWRITEBYTECODE",
  "SHELL",
  "TZ",
  "USER",
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
];

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("spawn-env registry — one classification per key, read through one function", () => {
  it("yields exactly the pre-registry window tables at the window site", () => {
    const window = registryEntries().filter((e) => e.sites.includes("window"));
    expect(sorted(window.filter((e) => e.class !== "pinned").map((e) => e.name))).toEqual(sorted(WINDOW_ALLOWLIST_BEFORE));
    expect(sorted(window.filter((e) => e.class === "pinned").map((e) => e.name))).toEqual(sorted(WINDOW_PINS_BEFORE));
  });

  it("does not let a non-window row or a pattern classify a key at the window site", () => {
    for (const name of ["PATH", "HOME", "GIT_CONFIG_KEY_0", "DOCUMENTS_MCP_SCRATCH_ROOT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]) {
      expect(classifySpawnEnvKey(name, "window"), name).toBeNull();
    }
  });

  it("classifies every name observed in Desktop's host-loop spawn dumps (68 names)", () => {
    expect(OBSERVED_NAMES).toHaveLength(68);
    const missing = OBSERVED_NAMES.filter((n) => classifySpawnEnvKey(n, "observed") === null);
    expect(missing).toEqual([]);
  });

  it("gives every entry a known class and a non-empty reason", () => {
    for (const e of registryEntries()) {
      expect(SPAWN_ENV_CLASSES, e.name).toContain(e.class);
      expect(e.reason.trim().length, e.name).toBeGreaterThan(0);
      expect(e.sites.length, e.name).toBeGreaterThan(0);
    }
    for (const p of SPAWN_ENV_PATTERNS) {
      expect(SPAWN_ENV_CLASSES).toContain(p.class);
      expect(p.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("anchors every pattern: it matches its examples in full and nothing broader", () => {
    for (const p of SPAWN_ENV_PATTERNS) {
      expect(p.re.source.startsWith("^") && p.re.source.endsWith("$"), p.re.source).toBe(true);
      for (const ok of p.examples) expect(p.re.test(ok), `${p.re.source} should match ${ok}`).toBe(true);
      for (const bad of p.counterexamples) expect(p.re.test(bad), `${p.re.source} must not match ${bad}`).toBe(false);
    }
  });

  it("never lets a name match two patterns, or both a pattern and an exact row", () => {
    const names = new Set([...registryEntries().map((e) => e.name), ...SPAWN_ENV_PATTERNS.flatMap((p) => p.examples)]);
    for (const n of names) {
      const hits = SPAWN_ENV_PATTERNS.filter((p) => p.re.test(n)).length;
      const exact = registryEntries().some((e) => e.name === n) ? 1 : 0;
      expect(hits + exact, n).toBeLessThanOrEqual(1);
    }
  });

  it("applies patterns only at the post-write and observed sites", () => {
    const sites: SpawnEnvSite[] = ["post-write", "observed"];
    for (const s of sites) expect(classifySpawnEnvKey("GIT_CONFIG_VALUE_7", s)?.class).toBe("host-loop-unmodeled");
    expect(classifySpawnEnvKey("GIT_CONFIG_VALUE_7", "window")).toBeNull();
  });

  it("returns null for a name nobody classified", () => {
    expect(classifySpawnEnvKey("ACME_INTERNAL_BILLING_ID", "observed")).toBeNull();
    expect(classifySpawnEnvKey("ACME_INTERNAL_BILLING_ID", "post-write")).toBeNull();
  });

  it("is the only reader of the classification tables in src/", () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith("spawn-env-registry.ts")) {
          // Code only: drop comments and string/template literals, so a table NAME inside a message is not a read.
          const t = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "")
            .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
          // A second table, or a direct read of one, would be a second classifier.
          if (
            /\b(?:const|let|var)\s+(?:SPAWN_ENV_ALLOWLIST|SPAWN_PIN_KEYS|EXTRA_ROWS)\b|(?:SPAWN_ENV_ALLOWLIST|SPAWN_PIN_KEYS|EXTRA_ROWS)\s*(?:\[|\.|\)| as\b)/.test(
              t,
            )
          )
            offenders.push(p);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
    const reg = readFileSync("src/sync/spawn-env-registry.ts", "utf8");
    expect(reg).not.toMatch(/export\s+const\s+(?:SPAWN_ENV_ALLOWLIST|SPAWN_PIN_KEYS|EXTRA_ROWS)\b/);
  });
});

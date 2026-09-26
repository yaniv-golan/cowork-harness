/**
 * Privacy SCANNER — the always-on CI safety net, distinct from the opt-in redactor. Where the
 * redactor mutates bytes (and is therefore conservative), the scanner only FLAGS, so it runs high-recall and
 * fails the build. A finding means "the redactor's policy has a gap (or wasn't configured)".
 *
 * Default classes (chosen for a low false-positive rate): email, currency, bare domain, local
 * absolute path (the recording machine's own filesystem — /Users, /home, /root, the macOS temp and
 * volume roots, and a slugged home segment like `-Users-<user>-…` under any root — not the in-VM
 * /sessions mount tree), machine-inventory (the sentinel boilerplate a tool emits when it has
 * LIVE-ENUMERATED local environment state — installed apps, running processes — into its
 * schema/description/output; matches the introducer phrase only, never app names or list shapes).
 * Multi-word proper names are deliberately NOT a default — too noisy (NVCA, Cap Table, Cooley GO)
 * to gate on; add them via config when a corpus warrants it. The allowlist suppresses
 * known-synthetic / public reference names.
 */
export interface ScanFinding {
  where: string; // a human locator, e.g. "events[3]" or "artifact outputs/x.json"
  cls: string; // matched class: email | currency | domain | path | machine-inventory | <custom>
  sample: string; // the matched text (already redaction-survived, so safe to surface)
}

/** An allowlist entry. `cls` undefined = applies to every class (a bare `--allow`); `cls` set = scoped to one
 *  finding class (`--allow-domain` → "domain"). Scoping plus whole-token anchoring stops a domain allow from
 *  silently clearing an email finding whose domain it happens to match. */
export interface AllowPattern {
  cls?: string;
  re: RegExp;
}

/** Allow entries may be authored as a bare RegExp (all-class, the ergonomic default) or a scoped {cls,re}. */
export type AllowInput = RegExp | AllowPattern;

function normAllow(a: AllowInput): AllowPattern {
  return a instanceof RegExp ? { re: a } : a;
}

export const DEFAULT_SCAN_PATTERNS: { re: RegExp; cls: string }[] = [
  { re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, cls: "email" },
  { re: /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|b|bn|million|billion)?/gi, cls: "currency" },
  {
    re: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|io|net|org|co|app|ai|dev|xyz|vc|fund|capital|tech|cloud|health|finance|us|uk|de|fr|ca|au|me|tv|info|biz|edu|gov|mil|ch|nl|se|no|it|jp|br|nz|in|sg|kr|mx|es|pt|pl|be|at|dk|fi|ie|ru|cn|tw|hu|cz|ro|il|za|ar|cl|pe|tr)\b/gi,
    cls: "domain",
  },
  {
    // A real local absolute path — the recording machine's own filesystem, not the in-VM /sessions/
    // mount tree. Boundary-anchored via a zero-width NEGATIVE LOOKBEHIND (not a capturing group — a
    // capturing group here would leak the boundary char itself into m[0]/ScanFinding.sample, e.g. a
    // leading space or quote, which then breaks --allow-path since allowed() anchors the allow-regex
    // against the WHOLE sample) so a substring like "whatever/home/x" doesn't false-match, only a
    // genuine path-like "/home/...". Modeled on the boundary approach in src/run/execute.ts's
    // hostPathLeaked — deliberately NOT sharing code with it: that function is an encoding-aware
    // boolean check over an agent's free-form output at run time, this is a plain match-extraction
    // over structured JSON at scan time (a deliberate design decision: structured extraction beats
    // a boolean over free-form text here). Unix-only by scope — a Windows path (C:\Users\...) does not match; this repo
    // records via Docker/Lima on macOS/Linux.
    // macOS-host-only prefixes (/private/var, /var/folders, /private/tmp, /Volumes) are included alongside
    // the universal /Users//home//root so a leaked temp-dir or external-volume host path is caught too.
    // `/private/tmp/` is the realpath of macOS `/tmp` and does not exist in the Linux VM/container, so it
    // is a host path by construction. `/opt/cowork/` is intentionally NOT here: the microvm tier
    // legitimately mounts the agent at /opt/cowork/agent (src/runtime/lima.ts), so its appearance in a
    // recording is expected, not a leak.
    //
    // Bare `/tmp/` is deliberately NOT a root: the in-VM HOME is `/tmp`, and clean recordings carry
    // host-neutral paths like `/tmp/cc-socks/<n>.sock`. What makes a temp path sensitive is the USERNAME
    // in it, and that usually sits in a SLUGGED segment — a Claude session scratchpad lives at
    // `/tmp/claude-<uid>/-Users-<user>-<project>/…` (macOS) or `/tmp/claude-<uid>/-home-<user>-…` (Linux).
    // The second alternative flags that one segment (`-Users-…`/`-home-…`/`-root-…`), whatever root it
    // sits under. Its segment start is string-start, `/`, a quote, or a newline (raw or the two-char JSON
    // escape, since this scans raw event lines): `ls ~/.claude/projects` prints one slug per line and
    // `~/.claude.json` keys projects by slug, with no path in front. NOT a space — ` -Users-only` in prose
    // stays clean — and so, by design, does a slug after a space or tab in `ls -l`, `tree` or `du` output. A slug-shaped segment inside an http(s) URL is not a host path and is skipped (the URL ends at
    // whitespace, a quote, `,` or `;`, so a path comma-joined after a URL is still seen). That look-back is
    // capped at 256 chars to keep the scan linear on a long unbroken run; past the cap a URL segment is
    // flagged, which fails safe. Known
    // false positive: a directory literally named `-home-…` inside the VM (clear it with `--allow-path`).
    // The segment stops at a backslash too, so a JSON-escaped `\n` ends it and the next line's slug is
    // its own finding. Under a listed root the first alternative already consumes the whole
    // path, slug included, so the slug arm only fires on an unlisted root such as bare `/tmp/`. Its sample
    // is just the segment, so a whole-token `--allow-path` can still clear it.
    //
    // The root boundary is whitespace, a quote, a backtick, `(`, `[`, `=`, `:` or `>` — a model reply
    // quotes a path in backticks ("Saved to `/Users/…`") — or a JSON-escaped `\n`/`\t`: this scans RAW
    // event lines, where a one-path-per-line tool result puts the two characters `\n` before each root.
    // For the same reason a path stops at a backslash, so each listed path is its own finding.
    //
    // The boundary also accepts a `://` prefix: in `computer:///Users/alice/…` or `file:///home/…` the
    // char before the root is the URI's own third slash, which the plain lookbehind rejects — so a host
    // path inside a link was never flagged. A `file://` URI may also carry a host part
    // (`file://localhost/Users/…`); that is accepted for `file:` only, so an http(s) URL whose path
    // happens to start `/home/` is not a host path. `/System/Volumes/` is the macOS data-volume spelling
    // of the same tree (`/System/Volumes/Data/Users/…`), as `df`/`mount`/`realpath` print it.
    //
    // The run-level `hostPathLeaked` detector (src/run/execute.ts) shares the zero-false-positive arms
    // (`/private/tmp/`, a `computer://`/`file://` prefix) but NOT the slug arm or `/System/Volumes/`: it
    // is a live verdict signal, and a slug-shaped name is a weaker signal than a root prefix.
    re: /(?:(?<![^\s"'(=:`\[>])|(?<=:\/\/|file:\/\/[^\s\/"']*|\\[nt]))(\/Users\/|\/home\/|\/root\/|\/private\/var\/|\/private\/tmp\/|\/var\/folders\/|\/System\/Volumes\/|\/Volumes\/)[^\s"'\\)]+|(?<!https?:\/\/[^\s"',;]{0,256})(?<=^|\/|"|'|\n|\\n)-(?:Users|home|root)-[^/\s"'\\)]+/gi,
    cls: "path",
  },
  {
    // Machine-inventory sentinel: the introducer boilerplate a tool emits when it has LIVE-ENUMERATED
    // local environment state (installed apps, running processes) into its schema/description/output —
    // e.g. computer-use's request_access description: "Available applications on this machine:
    // AppOne, AppTwo, AppThree, …".
    // NOTE: use a synthetic app list in this comment and in any test fixture — never a real captured one
    // (the class this comment documents exists specifically to stop that kind of leak from being committed).
    // Matches the PHRASE ONLY (bounded at the optional colon), not the trailing list — the sample stays
    // machine-independent and short, so a reviewed --allow-machine-inventory regex can whole-token match
    // it (allowed() anchors ^(?:…)$ against the WHOLE sample; a machine-varying list tail would make
    // every allow brittle — same lesson as the path class's lookbehind fix). The class deliberately does
    // NOT pattern-match app names or list shapes: enumerated Title-Case lists are ubiquitous legitimate
    // catalog content here (the same noise that got currency/domain excluded from manifest lines), while
    // this boilerplate is never legitimate synthetic-fixture content. Multiple entries may share this cls
    // (scanText loops entries, not classes) — extend by adding sibling regexes, not by widening this one.
    re: /\b(?:(?:available|installed|running)\s+(?:applications?|apps|processes)|(?:applications?|apps|processes)\s+(?:currently\s+)?(?:available|installed|running))\s+on\s+(?:this|the|your)\s+(?:machine|computer|system|device|mac|host)\b\s*:?/gi,
    cls: "machine-inventory",
  },
];

/** The high-precision subset scanned UNIVERSALLY — even on the agent capability-manifest messages: the
 *  `system/init` event, the `initialize` registry `control_response`, the MCP `initialize`
 *  `control_request` (Claude Code's own client handshake), and the MCP `initialize` `control_response`
 *  (the configured MCP server's own handshake reply) — see `isCapabilityManifest()` in
 *  `src/run/cassette.ts` for the exact shape match on all four. `email` because the registry's `account`
 *  field can carry the developer's own email (a real leak); `path` because those same messages' structural
 *  fields (`cwd`, `plugins[].path`, `memory_paths`) are exactly where a real local filesystem path —
 *  leaking a username, plugin-cache layout, or private marketplace name — lives; `machine-inventory`
 *  because a future capability-manifest variant that inlines MCP tool descriptions (plausible:
 *  `system/init` already lists `mcp_servers`) could carry a live-enumerated app/process inventory in a
 *  structural field, and the sentinel is never legitimate catalog boilerplate the way a skill/tool
 *  description's prose can be. The noisy classes (`currency`/`domain`) are the ones suppressed on those
 *  four manifest messages, where every hit is the agent's tool/skill catalog, MCP-server names, or the
 *  agent/server's own product identity (e.g. `claude.com`) — environment boilerplate a regex can't tell
 *  apart from customer data. None of `email`/`path`/`machine-inventory` share that ambiguity: a real
 *  address, a real absolute path, or the live-inventory sentinel are never legitimate catalog boilerplate.
 *  Everywhere else (assistant reasoning, tool I/O, decisions, the deliverable) gets the full net. */
export const MANIFEST_SCAN_PATTERNS = DEFAULT_SCAN_PATTERNS.filter(
  (p) => p.cls === "email" || p.cls === "path" || p.cls === "machine-inventory",
);

/** The `cls` of a leaked host-inventory finding. Separate from DEFAULT_SCAN_PATTERNS on purpose: those are
 *  text regexes, and this class is STRUCTURAL — it reads specific NAME fields of a decoded transcript event,
 *  which no `{re, cls}` entry can express. */
export const HOST_INVENTORY_CLS = "host-inventory";

/** SDK-MCP server names the harness itself serves. Anything else in a host-inheriting recording's
 *  `mcp_servers[]` is the recording machine's own inventory.
 *
 *  Kept as a literal (not imported from the handlers) to avoid a scan→hostloop dependency; a test calls each
 *  handler's `initialize` and asserts its `serverInfo.name` is in here, so the two cannot drift.
 *
 *  Deliberately server-level, NOT tool-level. A tool allowlist cannot work: a recorded MCP `tools/list`
 *  result carries the server's LOCAL names (`list_skills`), because the `mcp__<server>__` prefix is applied
 *  client-side — so an `mcp__*`-filtered tool check matches nothing on that surface. Server granularity also
 *  makes a new first-party TOOL free (no red, no maintenance) while still catching a new SERVER, which is
 *  the granularity of the inventory being protected. */
export const KNOWN_COWORK_SERVERS: ReadonlySet<string> = new Set(["cowork", "plugins", "skills", "workspace"]);

/** Agents present in a clean recording. A closed set, unlike slash commands (which legitimately vary), so it
 *  is a usable predicate rather than a threshold. Extend deliberately when the built-in roster changes. */
export const KNOWN_BUILTIN_AGENTS: ReadonlySet<string> = new Set([
  "claude",
  "claude-code-guide",
  "Explore",
  "general-purpose",
  "Plan",
  "statusline-setup",
]);

/** Skills the AGENT itself ships, present in a clean recording regardless of what a scenario mounts.
 *  Observed in every committed fixture across the sealed `container` tier (where no host config dir is
 *  reachable) and `hostloop`, and confirmed in the staged agent ELF — so a bare name outside this set
 *  came from the operator's own config dir, not the product.
 *
 *  Closed set, same contract as KNOWN_BUILTIN_AGENTS: extend it deliberately when the agent's built-in
 *  roster changes. A new built-in would surface on the first fresh recording after a `sync`.
 *
 *  EXTENDED 2026-08-19 (agent 2.1.234): the roster below `deep-research` surfaced exactly as that last
 *  sentence predicts — on the first fresh `protocol` recording after the 1.32885.1 sync, as 14
 *  host-inventory findings on a cassette that carries no operator inventory at all. They are product
 *  built-ins, established three ways rather than assumed:
 *    1. the recording was made against a MANAGED (fresh) config dir — `useManagedConfig` is on whenever
 *       ANTHROPIC_API_KEY is set (src/runtime/protocol.ts) — and its session stages no plugins or
 *       skills, so nothing reachable from the operator's own config dir could have been enumerated;
 *    2. every name is a bare literal in BOTH the staged agent ELF (2.1.234) and the host CLI, which is
 *       the criterion this doc comment already sets;
 *    3. negative control: ten personal/plugin skill names from the same machine (plaud-digest, overcut,
 *       docsend-to-pdf, skill-packager, proof-engine, transcription-reader, youtube-downloader, hookify,
 *       cowork-harness, pretext) are all ABSENT from that binary — so the substring test discriminates
 *       rather than matching everything.
 *  Known cost, same as KNOWN_BUILTIN_AGENTS: a bare name is exempted globally, so an operator whose own
 *  skill is named e.g. `debug` or `run` stops being flagged. That is inherent to a name-keyed closed set.
 *  The alternative — leaving the roster stale — reds every fresh protocol/hostloop recording on false
 *  positives and pushes people to a blanket `--allow-host-inventory`, which is strictly worse. */
export const KNOWN_BUILTIN_SKILLS: ReadonlySet<string> = new Set([
  "workflow-authoring", // measured 2026-08-29 against a SEALED protocol run (managed config dir, zero host skills)
  "batch",
  "claude-api",
  "code-review",
  "dataviz",
  "debug",
  "deep-research",
  // EXTENDED 2026-09-18 (agent 2.1.275, Desktop 2.2553.1): surfaced on the first fresh `container`
  // recording after this sync, on a cassette whose scenario declares `skills: []`. Product built-in by
  // the same three criteria as the roster above: (1) recorded at `container`, which is SEALED (HOME=/tmp,
  // no host ~/.claude) — stronger than the managed-config protocol case; (2) `"design"` is a bare quoted
  // literal 18x in BOTH the staged agent ELF and the host CLI; (3) negative control — five personal skill
  // names from the same machine (plaud-digest, overcut, docsend-to-pdf, skill-packager, proof-engine) are
  // all 0 in that binary. Note it is NOT a new arrival in this agent: `design-consent` is present 4x in
  // the 2.1.260 ELF too, and the design-consent/design-revoke SLASH COMMANDS were already in the
  // previously shipped, guard-passing cassette. What changed is only that the feature now also registers
  // in `skills[]` — an axis this scan treats more strictly than slash_commands — so allowlisting it
  // publishes nothing that the cassette on main did not already carry.
  "design",
  "design-sync",
  "doctor",
  "fewer-permission-prompts",
  "loop",
  "run",
  "run-skill-generator",
  "simplify",
  "update-config",
  "verify",
]);

/** `account` keys that identify the OPERATOR. A clean recording's account block is `{tokenSource,
 *  apiProvider}` only. `email` is usually redacted upstream by the time it reaches here — the load-bearing
 *  members are `organization` and `subscriptionType`, which no redaction rule touches. */
const ACCOUNT_IDENTITY_KEYS = ["email", "organization", "subscriptionType"] as const;

/**
 * Structural host-inventory scan over ONE decoded transcript event.
 *
 * Reads name fields only — never description/prose fields. That is a scoping choice (cheap, predictable,
 * bounded), not a false-positive necessity: legitimate `mcp__*` tokens do occur inside command
 * `description` text, but they name KNOWN servers and so could not have flagged anyway. Descriptions are
 * unbounded free text with no clean predicate, so they are out of scope by design — see the residual note
 * in docs/cassette.md.
 *
 * CALLER MUST TIER-GATE THIS. Only meaningful for a host-inheriting recording (`protocol`/`hostloop`, or
 * `cowork` resolving to hostloop). At `container` the agent is sealed, so a foreign server name is
 * necessarily one the scenario attached on purpose via `mcp.config` — a documented, supported feature —
 * and flagging it would red CI on a legitimate fixture.
 */
export function scanHostInventory(
  decoded: unknown,
  where: string,
  allow: AllowInput[],
  declaredPlugins: readonly string[] = [],
): ScanFinding[] {
  const out: ScanFinding[] = [];
  const norm = allow.map(normAllow);
  const push = (sample: string, detail: string) => {
    if (!allowed(sample, HOST_INVENTORY_CLS, norm)) out.push({ where: `${where} ${detail}`, cls: HOST_INVENTORY_CLS, sample });
  };
  // Plugin names the SCENARIO mounted. `declaredPlugins` covers payloads with no sibling `plugins[]` —
  // notably the registry `control_response`, whose agents arrive as `{name,description,model}` with no
  // plugin list beside them; the caller harvests those names from the events array and passes them here.
  const declared = new Set(declaredPlugins);

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;

    // A1 — foreign MCP server name. The axis that caught the real leak.
    if (Array.isArray(o.mcp_servers)) {
      for (const s of o.mcp_servers) {
        const name = (s as Record<string, unknown> | null)?.name;
        if (typeof name === "string" && !KNOWN_COWORK_SERVERS.has(name)) push(name, "mcp_servers[].name");
      }
    }
    // A2 — a prefixed tool naming a foreign server. Cheap defence-in-depth: it contributed nothing to the
    // shipped leak (an unconnected server declares no tools) and A1 largely subsumes it.
    if (Array.isArray(o.tools)) {
      for (const t of o.tools) {
        if (typeof t !== "string") continue;
        const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(t);
        if (m && !KNOWN_COWORK_SERVERS.has(m[1])) push(m[1], `tools[] (${t})`);
      }
    }
    // A3 — operator identity on the account block.
    if (o.account !== null && typeof o.account === "object") {
      const acct = o.account as Record<string, unknown>;
      for (const k of ACCOUNT_IDENTITY_KEYS) if (acct[k] !== undefined) push(k, `account.${k}`);
    }
    // A4 — an agent outside the built-in roster, EXCEPT one the scenario itself mounted.
    //
    // A plugin contributes its agents to the roster, and at `hostloop` — the tier a fleet actually
    // records at — that roster is the fixture, not the recording machine's inventory. This is the same
    // carve-out A1 makes for an `mcp.config`-attached server, and without it every plugin-with-agents
    // consumer hits a wall of false positives whose only documented remedy is inventing a regex.
    //
    // The provenance is in the payload already: `plugins[]` sits beside `agents[]` in the same init
    // object, and a plugin's agents are namespaced `<plugin>:<agent>`. So the subtraction is derivable
    // at scan time from an ALREADY-RECORDED cassette — no new cassette field, and no re-record.
    //
    // Deliberate residual: a host-leaked plugin's agents are namespaced too, so this trades a narrow
    // false-negative for the false-positive. That is the right trade — this check exists to catch a
    // FOREIGN machine's inventory, and an agent the scenario mounted is by construction not that.
    //
    // A5 — a SKILL outside the agent's built-ins, same two exemptions. This axis matters because at
    // `protocol` with local OAuth the harness keeps the operator's REAL CLAUDE_CONFIG_DIR (a fresh one
    // breaks OAuth — see src/runtime/protocol.ts), so the personal skills installed there are
    // discoverable and would be frozen into a committed fixture. A skill name is inventory in exactly
    // the way an MCP server name is: it says what the operator has installed.
    if (Array.isArray(o.agents) || Array.isArray(o.skills)) {
      // Plugins declared by THIS payload, plus any harvested from elsewhere in the stream.
      const local = new Set(declared);
      if (Array.isArray(o.plugins))
        for (const p of o.plugins) {
          const n = typeof p === "string" ? p : (p as Record<string, unknown> | null)?.name;
          if (typeof n === "string") local.add(n);
        }
      /** A `<plugin>:<name>` whose plugin the recording declares is the fixture, not the host's. */
      const fromDeclaredPlugin = (name: string): boolean => {
        const sep = name.indexOf(":");
        return sep > 0 && local.has(name.slice(0, sep));
      };
      if (Array.isArray(o.agents))
        for (const a of o.agents) {
          const name = typeof a === "string" ? a : (a as Record<string, unknown> | null)?.name;
          if (typeof name !== "string" || KNOWN_BUILTIN_AGENTS.has(name)) continue;
          if (fromDeclaredPlugin(name)) continue;
          push(name, "agents[]");
        }
      if (Array.isArray(o.skills))
        for (const s of o.skills) {
          const name = typeof s === "string" ? s : (s as Record<string, unknown> | null)?.name;
          if (typeof name !== "string" || KNOWN_BUILTIN_SKILLS.has(name)) continue;
          if (fromDeclaredPlugin(name)) continue;
          push(name, "skills[]");
        }
    }
    for (const v of Object.values(o)) visit(v);
  };

  visit(decoded);
  return out;
}

function allowed(sample: string, cls: string, allow: AllowPattern[]): boolean {
  // An allow suppresses a finding only when (a) it is unscoped OR scoped to this finding's class, AND (b) it
  // matches the WHOLE finding token. Anchoring with ^(?:…)$ is the fix: substring matching let a domain
  // allow (e.g. `example\.com`) silently clear an EMAIL finding (`alice@example.com`) whose domain matched —
  // a real founder@startup.com could then pass a gate that "has an email class". Test against a non-global
  // clone so a caller's /g regex can't carry lastIndex across calls.
  return allow.some((a) => {
    if (a.cls !== undefined && a.cls !== cls) return false;
    return new RegExp(`^(?:${a.re.source})$`, a.re.flags.replace("g", "")).test(sample);
  });
}

/** macOS system paths that identify no one and appear in ordinary recordings: from Desktop 2.7032.0 the
 *  host-loop agent runs at `/var/empty` and reports its realpath. Exact directory, or a path under it with
 *  no `..` segment (which could walk out of it into a path that does identify someone). */
const SYSTEM_CONSTANT_PATHS = ["/private/var/empty"];
function isSystemConstantPath(p: string): boolean {
  if (p.split("/").includes("..")) return false;
  return SYSTEM_CONSTANT_PATHS.some((c) => p === c || p.startsWith(`${c}/`));
}

/** Scan one string for PII matches, suppressing anything the (class-scoped, whole-token) allowlist covers. */
export function scanText(text: string, where: string, allow: AllowInput[], patterns = DEFAULT_SCAN_PATTERNS): ScanFinding[] {
  const out: ScanFinding[] = [];
  const norm = allow.map(normAllow);
  for (const { re, cls } of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      const sample = m[0];
      if (cls === "path" && isSystemConstantPath(sample)) continue;
      if (!allowed(sample, cls, norm)) out.push({ where, cls, sample });
    }
  }
  return out;
}

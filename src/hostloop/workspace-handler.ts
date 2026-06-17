import { warn } from "../io.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compile } from "../egress/proxy.js";

const pexec = promisify(execFile);
const MAX_REDIRECTS = 5; // Cowork's RZe redirect cap (Path B re-checks U1t per hop)

/** Port of Cowork's `XwA`: is the host a local / private / link-local address (SSRF backstop)? */
export function isLocalOrPrivate(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 loopback/ULA/link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  }
  return false;
}

/** Port of Cowork's `U1t` (Path B domain gate): scheme + private-address + the egress domain allowlist
 *  (the SAME `wen()`/`compile()` matcher the container egress uses). Returns a deny reason, or null = allow. */
export function u1t(u: URL, allow: string[], matcher: (h: string) => boolean): string | null {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `URL scheme "${u.protocol}" is not allowed. Use http or https.`;
  if (isLocalOrPrivate(u.hostname)) return `Host "${u.hostname}" is a local or private address.`;
  if (!allow.length) return "No network allowlist is configured for this session. The web_fetch tool is disabled.";
  if (!matcher(u.hostname))
    return `Web fetch was not allowed: ${u.hostname} is not in the session web-fetch allowlist. Ask to add this domain.`;
  return null;
}

/** A single redirect-manual network hop — injectable so the token-free suite can drive redirects/SSRF. */
export type RawFetch = (url: string) => Promise<{ status: number; location?: string; text(): Promise<string> }>;
const defaultRawFetch: RawFetch = async (url) => {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
  return { status: r.status, location: r.headers.get("location") ?? undefined, text: () => r.text() };
};

/**
 * The workspace SDK-MCP server, driver-side — reproduces Cowork's host-loop shell:
 * the agent loop (in the container) routes `mcp__workspace__bash`/`web_fetch` calls to
 * the DRIVER (host) over the control protocol; the driver executes them in the VM view
 * (`docker exec` into the agent's container, cwd = /sessions/<id>/mnt). The container
 * has no `/host` path, so `${CLAUDE_PLUGIN_ROOT}` (a host path) is unresolvable in bash
 * → a skill must self-heal via `find /sessions/<id>/mnt …`, exactly like production.
 *
 * The bash tool description is the verbatim Cowork string.
 */
type McpResult = { result: unknown } | { error: { code: number; message: string } };
// #30: the handler is async (web_fetch may await a provenance approval through the Decider).
export type McpHandler = (server: string, jsonrpc: { id?: unknown; method?: string; params?: any }) => McpResult | Promise<McpResult>;

/**
 * #30 — web_fetch provenance policy, injected by Run (which owns the URL set + the Decider). Omitted
 * (ref.current undefined) ⇒ allowlist-only behavior (unchanged). Created in execute.ts/chat.ts.
 */
export interface WebFetchProvenance {
  isAllowed(url: string): boolean; // normalized membership in the session's provenance set
  markAllowed(url: string): void; // add after an approval / permissive bypass
  requestApproval?: (domain: string, url: string) => Promise<boolean>; // routed through Run's Decider (recorded)
  promptGateOn: boolean; // coworkWebFetchPrompt — when false, a miss is a hard deny (no prompt)
  permissiveMode?: boolean; // bypassPermissions ⇒ pre-add + skip the check (Cowork's `cre`)
}

const BASH_DESC =
  "Run a shell command in the session's isolated Linux workspace. Your connected folders are mounted under {{mnt}}/ — the Shell access section of your system prompt lists the exact path for each folder. Each bash call is independent (no cwd/env carryover). Use absolute paths.";
const FETCH_DESC =
  "Fetch a URL from the session network (subject to the egress allowlist). web_fetch can only retrieve URLs that appeared in a user message or a prior result.";

export type EgressEntry = { host: string; decision: "allow" | "deny" };

export function makeWorkspaceHandler(
  containerName: string,
  vmMnt: string,
  runner = "docker",
  webFetchAllow: string[] = ["*"],
  onEgress?: (entry: EgressEntry) => void,
  provenanceRef?: { current?: WebFetchProvenance }, // #30: Run fills this before the stream starts
  rawFetch: RawFetch = defaultRawFetch, // per-hop fetch (redirect:manual) for BOTH paths; injectable
): McpHandler {
  // Per-handler (per-spawn) latch for the provenance-unenforced warning — was module-level, which
  // silenced the gap after the first run in a long-lived process. Each fresh handler warns once.
  const provWarned = { value: false };
  const tools = [
    {
      name: "bash",
      description: BASH_DESC.replace("{{mnt}}", vmMnt),
      inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number" } }, required: ["command"] },
    },
    {
      name: "web_fetch",
      description: FETCH_DESC,
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  ];
  return async (server, jr) => {
    const method = jr.method;
    if (method === "initialize")
      return {
        result: {
          protocolVersion: (jr.params && jr.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "workspace", version: "1.0.0" },
        },
      };
    if (method === "tools/list") return { result: { tools } };
    if (method === "tools/call") {
      const name = jr.params?.name;
      const a = jr.params?.arguments ?? {};
      if (name === "bash")
        return { result: await execInContainer(runner, containerName, vmMnt, String(a.command ?? ""), clampTimeout(a.timeout_ms)) };
      if (name === "web_fetch")
        return {
          result: await fetchViaHost(String(a.url ?? ""), webFetchAllow, onEgress, provenanceRef?.current, provWarned, rawFetch),
        };
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
    }
    return { result: {} }; // ping / notifications
  };
}

function textResult(text: string, isError = false) {
  const r: { content: { type: string; text: string }[]; isError?: boolean } = { content: [{ type: "text", text }] };
  if (isError) r.isError = true;
  return r;
}

// #29: clamp a model-requested bash timeout into a sane range. Guards NaN/negative/missing → the
// 120s default; floors at 1s and caps at 10min. This is INFERRED-parity for the bash tool — Cowork's
// binary-verified timeout_ms honoring is for web_fetch, not bash — but the bash inputSchema advertises
// timeout_ms, so we honor it rather than silently ignoring the requested value.
export function clampTimeout(ms: unknown): number {
  return Math.min(Math.max(Number(ms) || 120000, 1000), 600000);
}

async function execInContainer(runner: string, container: string, cwd: string, command: string, timeoutMs = 120000) {
  if (!command) return textResult("error: missing 'command'", true);
  // Async (execFile, not spawnSync) so the awaited MCP handler yields the event loop while the subprocess
  // runs — a slow `docker exec` no longer blocks all protocol I/O. Each call independent (fresh sh).
  try {
    const { stdout, stderr } = await pexec(runner, ["exec", "-w", cwd, container, "sh", "-c", command], {
      encoding: "utf8",
      timeout: timeoutMs, // #29: honor the model-requested timeout_ms (clamped at the call site)
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = (stdout ?? "") + (stderr ?? "");
    return textResult(out.length ? out : "(no output)");
  } catch (e: any) {
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    return textResult(`[exit ${e.code ?? 1}]\n${out}`, true);
  }
}

// Cowork routes web_fetch through the HOST API (gate 1978029737 `coworkWebFetchViaApi:true` →
// `POST /api/organizations/<org>/cowork/web_fetch`), NOT the container egress path that `bash` uses
// (binary-verified 2026-06-13, app.asar 1.12603.1). It is gated by a SEPARATE web-fetch hostname
// allowlist (`getWebFetchAllowedUrls`, `*` = unrestricted) plus a URL-provenance rule (#30). We mirror
// that: fetch host-side (so a reachable URL is not falsely egress-denied), gated by both.
/** Path A per-hop gate: scheme + private-address only — NO hostname allowlist (Path A is decoupled
 *  from the egress domain list per SPEC §6; the provenance set gates the initial URL). The SSRF
 *  backstop still applies on every hop so an approved/redirected URL can't reach `file://` or a
 *  private/metadata host (#43/#44). */
function schemePrivateGate(u: URL): string | null {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `URL scheme "${u.protocol}" is not allowed. Use http or https.`;
  if (isLocalOrPrivate(u.hostname)) return `Host "${u.hostname}" is a local or private address.`;
  return null;
}

/**
 * Follow redirects manually (cap MAX_REDIRECTS), re-running `gate` on EVERY hop. A redirect to a
 * gate-blocked host (private address, bad scheme, or off-allowlist on Path B) is refused — the SSRF
 * protection that `curl -L` lacked. Emits one egress allow/deny on the terminal decision. Shared by
 * both web_fetch paths; the gate is the only difference (Path A: scheme+private; Path B: full u1t).
 */
async function followWithRedirects(
  startUrl: string,
  rawFetch: RawFetch,
  gate: (u: URL) => string | null,
  onEgress?: (entry: EgressEntry) => void,
): Promise<ReturnType<typeof textResult>> {
  let cur: URL;
  try {
    cur = new URL(startUrl);
  } catch {
    return textResult("web_fetch failed: invalid URL", true);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = gate(cur);
    if (blocked) {
      onEgress?.({ host: cur.hostname, decision: "deny" });
      return textResult(hop === 0 ? blocked : `Redirect to ${cur.href} blocked: ${blocked}`, true);
    }
    let resp: Awaited<ReturnType<RawFetch>>;
    try {
      resp = await rawFetch(cur.href);
    } catch (e: any) {
      return textResult(`Fetch failed: ${e?.message ?? String(e)}`, true);
    }
    if (resp.status >= 300 && resp.status < 400) {
      // This intermediate hop WAS contacted (it passed the gate and we fetched it) before redirecting —
      // record the egress so the log reflects every host actually reached, not just the terminal one.
      onEgress?.({ host: cur.hostname, decision: "allow" });
      if (!resp.location) return textResult(`Redirect ${resp.status} from ${cur.href} had no Location header.`, true);
      try {
        cur = new URL(resp.location, cur);
      } catch {
        return textResult(`Redirect to an invalid URL: ${resp.location}`, true);
      }
      continue; // re-check the gate on the new host
    }
    onEgress?.({ host: cur.hostname, decision: "allow" });
    return textResult((await resp.text()).slice(0, 200000));
  }
  return textResult(`web_fetch failed: too many redirects (> ${MAX_REDIRECTS}).`, true);
}

async function fetchViaHost(
  url: string,
  allow: string[],
  onEgress?: (entry: EgressEntry) => void,
  prov?: WebFetchProvenance,
  warned?: { value: boolean },
  rawFetch: RawFetch = defaultRawFetch,
) {
  if (!url) return textResult("error: missing 'url'", true);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return textResult("web_fetch failed: invalid URL", true);
  }
  // Two paths (binary-verified G1t/U1t, app.asar 1.12603.1), selected by whether provenance is engaged:
  //  • PATH A (prov present ⇒ coworkWebFetchViaApi on): the exact-URL provenance SET is the ONLY gate —
  //    NO hostname allowlist. A miss → the per-domain approval (coworkWebFetchPrompt) via the Decider.
  //  • PATH B (prov absent ⇒ gate off): the fall-through hostname allowlist (the egress domain list).
  if (prov) {
    if (prov.permissiveMode) prov.markAllowed(url); // `cre` bypass: pre-add, skip the check
    if (!prov.isAllowed(url)) {
      if (prov.requestApproval && prov.promptGateOn) {
        if (await prov.requestApproval(host, url)) prov.markAllowed(url);
        else {
          onEgress?.({ host, decision: "deny" });
          return textResult("Web fetch was not allowed.", true);
        }
      } else {
        onEgress?.({ host, decision: "deny" });
        return textResult(
          "URL not in provenance set. web_fetch can only retrieve URLs that appeared in a user message " +
            "or a prior web_fetch result. Ask the user to include the URL in a message first.",
          true,
        );
      }
    }
    // Provenance satisfied. Cowork fetches server-side (host API); the hostname allowlist does NOT apply
    // here (decoupled from egress — the #30 conflation). But scheme + private-address ARE enforced per
    // hop (#43/#44): follow redirects manually instead of `curl -L`, blocking file:// / SSRF targets.
    return followWithRedirects(url, rawFetch, schemePrivateGate, onEgress);
  }
  // PATH B (provenance not enforced — coworkWebFetchViaApi off). Faithful port of U1t re-checked on EVERY
  // redirect hop (a redirect to a denied or private host is blocked — the SSRF false-green `curl -L` had).
  if (warned && !warned.value) {
    warned.value = true;
    warn("::warning:: web_fetch provenance is NOT enforced (fidelity gap vs Cowork)\n");
  }
  const matcher = compile(allow);
  return followWithRedirects(url, rawFetch, (u) => u1t(u, allow, matcher), onEgress);
}

import { warn } from "../io.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { compile } from "../egress/proxy.js";

const pexec = promisify(execFile);
const MAX_REDIRECTS = 5; // Cowork's RZe redirect cap (Path B re-checks U1t per hop)

/** Is a dotted-quad's four octets in a loopback/this-host/private/link-local range? */
function isPrivateIPv4Octets(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
  if (a === 192 && b === 168) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  return false;
}

/**
 * Parse the many literal IPv4 host forms a request can carry into canonical octets so the
 * private-range guard isn't defeated by an alternate encoding. Handles:
 *  - dotted quad: `127.0.0.1`
 *  - dotted with octal/hex parts: `0177.0.0.1`, `0x7f.0.0.1`
 *  - a single integer: `2130706433` (= 127.0.0.1), incl. hex `0x7f000001` / octal `017700000001`
 *  - 1–3 part short forms where the final part fills the remaining low bytes (`127.1`, `127.0.1`)
 * Returns the 32-bit value, or null if `host` is not an integer-style IPv4 literal.
 */
function parseIPv4Literal(host: string): number | null {
  const parseUInt = (tok: string): number | null => {
    if (!tok) return null;
    let val: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(tok)) val = parseInt(tok, 16);
    else if (/^0[0-7]+$/.test(tok)) val = parseInt(tok, 8);
    else if (/^[0-9]+$/.test(tok)) val = parseInt(tok, 10);
    else return null;
    return Number.isFinite(val) && val >= 0 ? val : null;
  };
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = parts.map(parseUInt);
  if (nums.some((n) => n === null)) return null;
  const u = nums as number[];
  // The leading parts are single bytes; the final part fills the remaining low-order bytes.
  let value = 0;
  for (let i = 0; i < u.length - 1; i++) {
    if (u[i] > 0xff) return null;
    value = (value << 8) | u[i];
  }
  const last = u[u.length - 1];
  const remainingBytes = 4 - (u.length - 1);
  const maxLast = remainingBytes >= 4 ? 0xffffffff : Math.pow(256, remainingBytes) - 1;
  if (last > maxLast) return null;
  value = (value * Math.pow(256, remainingBytes) + last) >>> 0;
  return value >>> 0;
}

/** Port of Cowork's `XwA`: is the host a local / private / link-local address (SSRF backstop)? */
export function isLocalOrPrivate(host: string): boolean {
  let h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;

  // normalize IPv4-mapped / IPv4-compatible IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`) down to
  // the embedded IPv4 so the v4 private-range checks below apply. net.isIP recognizes the literal.
  if (net.isIP(h) === 6) {
    const mapped = h.match(/^(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) {
      h = mapped[1];
    } else {
      // Pure IPv6: loopback / ULA (fc00::/7) / link-local (fe80::/10).
      if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
      // IPv4-mapped written in hex groups, e.g. `::ffff:7f00:0001`.
      const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16);
        const lo = parseInt(hexMapped[2], 16);
        return isPrivateIPv4Octets((hi >> 8) & 0xff, hi & 0xff);
      }
      return false;
    }
  }

  // Dotted-quad fast path (preserves the original behavior for the cases it already caught).
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m && Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255 && Number(m[4]) <= 255) {
    return isPrivateIPv4Octets(Number(m[1]), Number(m[2]));
  }

  // integer / octal / hex / short-form IPv4 literals that resolve to a private range
  // (e.g. `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1` all == 127.0.0.1).
  const v4 = parseIPv4Literal(h);
  if (v4 !== null) {
    return isPrivateIPv4Octets((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff);
  }
  return false;
}

/** Resolve a hostname to its address records — injectable so the token-free suite can drive the SSRF
 *  DNS backstop without real network/DNS (parallels the `RawFetch` seam). Defaults to node:dns lookup. */
export type Resolver = (host: string) => Promise<{ address: string }[]>;
const defaultResolver: Resolver = (host) => lookup(host, { all: true });

/**
 * SSRF backstop, async tier: a HOSTNAME (not a literal) can still resolve to a private/loopback
 * address. `isLocalOrPrivate` only catches literals; this resolves the name via DNS and runs EVERY
 * returned address through the same per-IP check. A literal IP would already have been caught by the
 * synchronous `isLocalOrPrivate` gate, so this is reached only for names that need resolution.
 *
 * Also RETURNS the vetted addresses so the caller can PIN the connection to exactly those IPs.
 * Resolving in the gate and then letting `fetch` re-resolve independently is a TOCTOU window (DNS
 * rebinding: the name can answer public for the check, private for the fetch). The caller hands these
 * addresses to `rawFetch`, which dials them directly with the original Host header, so the address
 * that passed the check is the one actually contacted.
 *
 * Returns `{ deny }` if any resolved address is local/private, or if the name fails to resolve
 * (fail-closed — matching the conservative posture of the surrounding gates, which deny on doubt).
 * Returns `{ addresses }` (possibly empty for a literal IP) = the host is allowed; pin these.
 */
async function resolveAndVet(host: string, resolve: Resolver): Promise<{ deny: string } | { addresses: string[] }> {
  // A bracket-stripped literal IP resolves to itself; the sync gate already covered literals, so skip
  // the DNS round-trip for them (and avoid lookup() quirks on literals). No pinning needed — fetch will
  // connect to the literal directly, and the literal already passed isLocalOrPrivate.
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare) !== 0) return { addresses: [] };
  let addrs: { address: string }[];
  try {
    addrs = await resolve(host);
  } catch {
    // Name does not resolve (NXDOMAIN, SERVFAIL, etc.) → fail closed.
    return { deny: `Host "${host}" could not be resolved.` };
  }
  if (!addrs.length) return { deny: `Host "${host}" could not be resolved.` };
  for (const { address } of addrs) {
    if (isLocalOrPrivate(address)) return { deny: `Host "${host}" resolves to a local or private address (${address}).` };
  }
  return { addresses: addrs.map((a) => a.address) };
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

/**
 * A single redirect-manual network hop — injectable so the token-free suite can drive redirects/SSRF.
 *
 * `pinnedAddresses` carries the IPs the SSRF backstop already vetted for this hop's hostname. The
 * default implementation dials those exact addresses (closing the DNS-rebind TOCTOU); an empty/omitted
 * list means "no pinning required" (literal-IP host, or an injected test fake that ignores it).
 */
export type RawFetch = (
  url: string,
  pinnedAddresses?: string[],
) => Promise<{ status: number; location?: string; text(): Promise<string>; body?: ReadableStream<Uint8Array> | null; truncated?: boolean }>;

/** Shared web_fetch response byte cap. The pinned path bounds buffering to this; followWithRedirects
 *  slices/streams to the same value — single source of truth so the two paths can't drift. */
const WEB_FETCH_BYTE_CAP = 200000;

/** Pin the connection to a pre-vetted IP: a Node http(s) request whose DNS `lookup` is overridden to
 *  hand back only the vetted address(es), so the host that passed the SSRF check is the host contacted.
 *  The Host header and TLS servername stay the original hostname (name-based vhosts / SNI keep working). */
function pinnedRequest(
  url: string,
  pinned: string[],
): Promise<{ status: number; location?: string; text(): Promise<string>; body?: ReadableStream<Uint8Array> | null; truncated?: boolean }> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const family = net.isIP(pinned[0]); // 4 | 6
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        servername: u.hostname, // SNI uses the real name, not the pinned IP
        // Override resolution: always return a vetted address, never re-resolve the name.
        lookup: (_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, addr: string, fam: number) => void) =>
          cb(null, pinned[0], family || 4),
        signal: AbortSignal.timeout(30000),
      },
      (res) => {
        // bound memory — every resolved (public DNS) host now pins, so this is the common path. Stop
        // buffering past WEB_FETCH_BYTE_CAP (followWithRedirects slices the returned text to the same cap,
        // so the observable output is unchanged) instead of buffering an arbitrarily large response in RAM.
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        let wasCapped = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            location: (res.headers.location as string | undefined) ?? undefined,
            text: async () => buf.toString("utf8"),
            body: null,
            truncated: wasCapped,
          });
        };
        res.on("data", (c: Buffer) => {
          if (settled) return;
          if (total < WEB_FETCH_BYTE_CAP) {
            const take = Math.min(c.length, WEB_FETCH_BYTE_CAP - total);
            chunks.push(take === c.length ? c : c.subarray(0, take));
            total += take;
          }
          if (total >= WEB_FETCH_BYTE_CAP) {
            wasCapped = true;
            res.destroy(); // stop the transfer once capped
            finish();
          }
        });
        res.on("end", finish);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const defaultRawFetch: RawFetch = async (url, pinnedAddresses) => {
  // when the SSRF backstop vetted specific addresses for a resolved hostname, dial THOSE addresses
  // (no independent re-resolution) so a rebinding name can't answer public for the check and private for
  // the fetch. Literal-IP hosts have no pinned addresses → the plain fetch path (unchanged).
  if (pinnedAddresses && pinnedAddresses.length) return pinnedRequest(url, pinnedAddresses);
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
  return { status: r.status, location: r.headers.get("location") ?? undefined, text: () => r.text(), body: r.body };
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
// the handler is async (web_fetch may await a provenance approval through the Decider).
export type McpHandler = (server: string, jsonrpc: { id?: unknown; method?: string; params?: any }) => McpResult | Promise<McpResult>;

/**
 * web_fetch provenance policy, injected by Run (which owns the URL set + the Decider). Omitted
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

export interface WorkspaceHandlerOptions {
  containerName: string;
  /** Mnt ROOT — used only for the bash tool's description text (which legitimately describes where
   *  ALL connected folders live), not as the exec cwd (see `execCwd`). */
  vmMnt: string;
  runner?: string;
  webFetchAllow?: string[];
  onEgress?: (entry: EgressEntry) => void;
  onInfraError?: (message: string) => void;
  /** Run fills this before the stream starts. */
  provenanceRef?: { current?: WebFetchProvenance };
  /** Per-hop fetch (redirect:manual) for BOTH web_fetch paths; injectable for tests. */
  rawFetch?: RawFetch;
  /** Per-hop DNS resolution for the SSRF backstop; injectable for tests. */
  resolve?: Resolver;
  /** Production's `vmCwd`: the first non-network-drive connected folder's mount name, falling back to
   *  `outputs` — never the bare mnt root. Defaults to `vmMnt` for callers that don't care about the
   *  distinction (e.g. tests exercising a single generic mount). */
  execCwd?: string;
}

export function makeWorkspaceHandler(opts: WorkspaceHandlerOptions): McpHandler {
  const {
    containerName,
    vmMnt,
    runner = "docker",
    webFetchAllow = ["*"],
    onEgress,
    onInfraError,
    provenanceRef,
    rawFetch = defaultRawFetch,
    resolve = defaultResolver,
    execCwd = vmMnt,
  } = opts;
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
        return {
          result: await execInContainer(runner, containerName, execCwd, String(a.command ?? ""), clampTimeout(a.timeout_ms), onInfraError),
        };
      if (name === "web_fetch")
        return {
          result: await fetchViaHost(String(a.url ?? ""), webFetchAllow, onEgress, provenanceRef?.current, provWarned, rawFetch, resolve),
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

// Clamp a model-requested bash timeout into a sane range. Guards NaN/negative/missing → the
// 120s default; floors at 1s and caps at 10min. This is INFERRED-parity for the bash tool — Cowork's
// binary-verified timeout_ms honoring is for web_fetch, not bash — but the bash inputSchema advertises
// timeout_ms, so we honor it rather than silently ignoring the requested value.
export function clampTimeout(ms: unknown): number {
  return Math.min(Math.max(Number(ms) || 120000, 1000), 600000);
}

/**
 * Tell a `docker exec` INFRASTRUCTURE failure apart from an ordinary bash non-zero exit.
 *
 * The old test (`ETIMEDOUT || killed || (!code && !stdout && !stderr)`) caught timeouts/kills/spawn
 * errors, but a daemon-level failure (container not found, daemon not running, `docker exec` usage
 * error) exits NON-ZERO WITH stderr — same shape as a real command exiting 1 with output. Returning
 * `[exit 125]\n<docker daemon text>` to the model leaks harness infra detail and hides the failure.
 *
 * The Docker CLI exits 125 for "the command itself failed" (could not run the container/exec), vs the
 * command's own non-zero exit which Docker propagates verbatim. We also match the daemon's stderr
 * signatures so a custom runner / non-125 daemon error is still classified as infra. The `e.error`
 * arm matches Cowork's own error-string surface ("Error response from daemon: …").
 */
export function isExecInfraError(e: { code?: unknown; killed?: boolean; stdout?: string; stderr?: string }): boolean {
  if (typeof e.code === "string") return true; // spawn failure — e.g. ENOENT, EACCES (also covers ETIMEDOUT)
  if (e.code === "ETIMEDOUT" || e.killed) return true; // timeout / SIGKILL
  if (!e.code && !e.stdout && !e.stderr) return true; // spawn failure (no exec at all)
  const stderr = (e.stderr ?? "").toLowerCase();
  if (stderr.includes("error response from daemon")) return true; // daemon rejected the exec
  if (stderr.includes("cannot connect to the docker daemon")) return true; // daemon down / socket gone
  // "no such container" / "is not running" ARE docker infra failures, but those exact words can also appear
  // in a LEGITIMATE command's own output (e.g. a `systemctl status` check that exits non-zero). Only treat
  // them as infra when they sit on a docker ERROR line — the CLI prefixes its own failures with
  // "Error response from daemon:" / "Error:" — not anywhere in arbitrary command stderr.
  return /^error\b.*\b(no such container|is not running)\b/m.test(stderr);
}

async function execInContainer(
  runner: string,
  container: string,
  cwd: string,
  command: string,
  timeoutMs = 120000,
  onInfraError?: (message: string) => void,
) {
  if (!command) return textResult("error: missing 'command'", true);
  // Async (execFile, not spawnSync) so the awaited MCP handler yields the event loop while the subprocess
  // runs — a slow `docker exec` no longer blocks all protocol I/O. Each call independent (fresh sh).
  try {
    const { stdout, stderr } = await pexec(runner, ["exec", "-w", cwd, container, "sh", "-c", command], {
      encoding: "utf8",
      timeout: timeoutMs, // honor the model-requested timeout_ms (clamped at the call site)
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = (stdout ?? "") + (stderr ?? "");
    return textResult(out.length ? out : "(no output)");
  } catch (e: any) {
    // classify Docker/container INFRASTRUCTURE failures (timeouts, spawn errors, container-not-found,
    // daemon errors, exit 125) before formatting — including the non-zero-WITH-stderr case the old
    // classifier missed. Infra detail is recorded for the run log and a GENERIC error is returned to the
    // model: leaking `[exit 125]\n<docker daemon text>` would both expose the harness and mislabel a
    // harness failure as the model's command exiting non-zero.
    if (isExecInfraError(e)) {
      // Raw detail (incl. the docker stderr) goes to onInfraError → events.jsonl, NOT to the model.
      const detail = [e.message, (e.stderr ?? "").trim()].filter(Boolean).join(": ") || String(e);
      onInfraError?.(detail);
      return textResult("[infrastructure error: see run log for details]", true);
    }
    // Genuine command non-zero exit: surface the command's own exit code + output to the model.
    const out = (e.stdout ?? "") + (e.stderr ?? "");
    return textResult(`[exit ${e.code ?? 1}]\n${out}`, true);
  }
}

// Cowork routes web_fetch through the HOST API (gate 1978029737 `coworkWebFetchViaApi:true` →
// `POST /api/organizations/<org>/cowork/web_fetch`), NOT the container egress path that `bash` uses
// (binary-verified 2026-06-13, app.asar 1.12603.1). It is gated by a SEPARATE web-fetch hostname
// allowlist (`getWebFetchAllowedUrls`, `*` = unrestricted) plus a URL-provenance rule. We mirror
// that: fetch host-side (so a reachable URL is not falsely egress-denied), gated by both.
/** Path A per-hop gate: scheme + private-address only — NO hostname allowlist (Path A is decoupled
 *  from the egress domain list per SPEC §6; the provenance set gates the initial URL). The SSRF
 *  backstop still applies on every hop so an approved/redirected URL can't reach `file://` or a
 *  private/metadata host. */
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
  resolve: Resolver,
  onEgress?: (entry: EgressEntry) => void,
): Promise<ReturnType<typeof textResult>> {
  let cur: URL;
  try {
    cur = new URL(startUrl);
  } catch {
    return textResult("web_fetch failed: invalid URL", true);
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Synchronous gate first (scheme + literal private-address, plus the allowlist on Path B), then the
    // async DNS backstop: a host that RESOLVES to a private/loopback address (or fails to resolve) is
    // denied even though its literal form passed — closing the SSRF gap the literal-only check left.
    const syncBlocked = gate(cur);
    if (syncBlocked) {
      onEgress?.({ host: cur.hostname, decision: "deny" });
      return textResult(hop === 0 ? syncBlocked : `Redirect to ${cur.href} blocked: ${syncBlocked}`, true);
    }
    // resolve ONCE and pin the fetch to the vetted address — no second, unchecked resolution inside
    // fetch (the DNS-rebind TOCTOU). `pinned` is empty for literal-IP hosts (already vetted synchronously).
    const vet = await resolveAndVet(cur.hostname, resolve);
    if ("deny" in vet) {
      onEgress?.({ host: cur.hostname, decision: "deny" });
      return textResult(hop === 0 ? vet.deny : `Redirect to ${cur.href} blocked: ${vet.deny}`, true);
    }
    let resp: Awaited<ReturnType<RawFetch>>;
    try {
      resp = await rawFetch(cur.href, vet.addresses);
    } catch (e: any) {
      onEgress?.({ host: cur.hostname, decision: "deny" });
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
      resp.body?.cancel().catch(() => {}); // drain the undici stream on redirect hops (no-op for body:null pinned/fake responses)
      continue; // re-check the gate on the new host
    }
    onEgress?.({ host: cur.hostname, decision: "allow" });
    const LIMIT = WEB_FETCH_BYTE_CAP;
    // stream via resp.body to avoid buffering the full response before truncation.
    // Falls back to resp.text() for injectable test fakes that don't provide a body stream.
    if (resp.body) {
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (total + value.length > LIMIT) {
            chunks.push(value.subarray(0, LIMIT - total));
            total = LIMIT;
            truncated = true;
            reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
          total += value.length;
        }
      }
      const decoder = new TextDecoder();
      const text = chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
      return textResult(truncated ? text + "\n[truncated]" : text);
    }
    const raw = await resp.text();
    const sliced = raw.slice(0, LIMIT);
    const wasTruncated = resp.truncated || sliced.length < raw.length;
    return textResult(wasTruncated ? sliced + "\n[truncated]" : sliced);
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
  resolve: Resolver = defaultResolver,
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
    // here (decoupled from egress). But scheme + private-address ARE enforced per
    // hop: follow redirects manually instead of `curl -L`, blocking file:// / SSRF targets.
    return followWithRedirects(url, rawFetch, schemePrivateGate, resolve, onEgress);
  }
  // PATH B (provenance not enforced — coworkWebFetchViaApi off). Faithful port of U1t re-checked on EVERY
  // redirect hop (a redirect to a denied or private host is blocked — the SSRF false-green `curl -L` had).
  if (warned && !warned.value) {
    warned.value = true;
    warn("::warning:: web_fetch provenance is NOT enforced (fidelity gap vs Cowork)\n");
  }
  const matcher = compile(allow);
  return followWithRedirects(url, rawFetch, (u) => u1t(u, allow, matcher), resolve, onEgress);
}

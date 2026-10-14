/**
 * The frozen search corpus for one run (`--search-corpus <pool>`): the load-time refusals, starting the interceptor
 * and its per-query log, the agent's env, and the frozen-promise check at the end.
 *
 * The frozen promise: no request carrying a server search tool reaches upstream while a corpus is active. It is
 * checked two ways. The interceptor's forward log counts forwarded bodies that carry one (must be 0); that shares the
 * request parser, so it catches forwarding bugs only. The second check shares nothing with the interceptor: per agent,
 * the WebSearch tool_uses in the agent's own record (the main loop from events.jsonl, each sub-agent from its own
 * transcript), minus their results that show no request was made, must equal the requests the interceptor recorded
 * for that agent. A search that slipped past the classifier shows up as a tool_use with no matching request. Either
 * failure is a run infra error: the run cannot be trusted as frozen.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PlatformBaseline, RunSearchCorpusResult, SearchAnchors } from "../types.js";
import { extractSearchAnchors } from "../sync/search-anchors.js";
import { registerCleanup } from "../egress/sidecar.js";
import { UsageError } from "../errors.js";
import { ServeFrames } from "./frames.js";
import { startInterceptor, type Interceptor, type Upstream } from "./interceptor.js";
import { noRequestKind } from "./no-request.js";
import { poolHash, readPool, resolvePoolDir } from "./pool.js";
import { SearchRegistry } from "./registry.js";
import { buildIndex } from "./retrieval.js";
import { dispatchAgentIds, joinCalls, type JoinResult } from "./join.js";
import type { ServeContext } from "./serve.js";

export interface SearchCorpusOption {
  /** A pool name under the pools dir, or a path. */
  pool: string;
  miss: "empty" | "error";
  /** Overrides the pool's floor; it changes the pool hash, since it changes what is served. */
  minScore?: number;
}

export const SEARCH_CORPUS_MISS_MODES = ["empty", "error"] as const;

/** The label every verdict surface prints for a run served from a pool. */
export function searchCorpusLabel(poolId: string, sha256: string): string {
  return `frozen search corpus ${poolId}@${sha256.slice(0, 8)} — recorded results, harness ranking, searches not billed; not live search; for steps around research, not a research-quality signal`;
}

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const ENV_RECIPE =
  "put a credential in the environment or a .env: echo CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) >> .env, or point at a file holding it with cowork-harness --dotenv <path> …";

/** Why this run cannot use a search corpus, or null. Every reason names what it refuses. */
export function searchCorpusRefusal(o: {
  fidelity: string;
  deviceBridge: boolean;
  baseline: PlatformBaseline;
  /** The credential the agent would be spawned with (`runtimeAuthEnv`). */
  authEnv: Record<string, string>;
  /** The agent's env before the interceptor's keys are added. */
  agentEnv: NodeJS.ProcessEnv;
  /** `--resume` or `--session-id`: a reused config dir holds earlier sessions' transcripts, which the check would count. */
  resume?: boolean;
}): string | null {
  if (o.deviceBridge) return "--search-corpus cannot be combined with a device_bridge scenario";
  if (o.fidelity === "protocol") return "--search-corpus is not available at fidelity protocol: run it at fidelity hostloop (or cowork)";
  if (o.fidelity !== "hostloop")
    return `--search-corpus is not available at fidelity ${o.fidelity} yet: run it at fidelity hostloop (or cowork, which resolves to hostloop)`;
  const anchors = o.baseline.agentBinary?.searchAnchors;
  if (!anchors)
    return `--search-corpus needs the baseline's web-search anchors, and ${o.baseline.appVersion ? `desktop-${o.baseline.appVersion}` : "this baseline"} has none: re-run \`cowork-harness sync\` with the agent staged`;
  if (!anchors.noRequest)
    return `--search-corpus needs the baseline's no-search result anchors (searchAnchors.noRequest), and ${o.baseline.appVersion ? `desktop-${o.baseline.appVersion}` : "this baseline"} predates them: open Cowork once so the agent is staged, then re-run \`cowork-harness sync\` with a current cowork-harness`;
  if (!o.authEnv.CLAUDE_CODE_OAUTH_TOKEN && !o.authEnv.ANTHROPIC_API_KEY)
    return `--search-corpus needs the agent's credential from the environment (the interceptor sees it in cleartext, so it must be one the harness already holds, never your own login): ${ENV_RECIPE}`;
  if (o.resume)
    return "--search-corpus cannot be combined with --resume or --session-id: a resumed session's earlier searches would be counted against this run";
  // The remote search route (a separate client and request shape the interceptor's checks never covered end to end).
  if (o.agentEnv.CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY)
    return "--search-corpus cannot run with CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY set: unset it for this run";
  if (/^(session_|cse_)/.test(o.agentEnv.CLAUDE_CODE_SESSION_ID ?? ""))
    return "--search-corpus cannot run with a remote-session CLAUDE_CODE_SESSION_ID (session_… or cse_…), which reaches the remote search route: unset it for this run";
  const proxy = PROXY_KEYS.find((k) => o.agentEnv[k]);
  if (proxy) return `--search-corpus cannot chain an existing proxy: ${proxy} is set for the agent; unset it for this run`;
  const base = o.agentEnv.ANTHROPIC_BASE_URL;
  if (base) {
    let host = "";
    try {
      host = new URL(base).hostname.toLowerCase();
    } catch {
      /* unparseable: refused below */
    }
    if (host !== "api.anthropic.com")
      return "--search-corpus intercepts api.anthropic.com only, and ANTHROPIC_BASE_URL points the agent elsewhere: unset it for this run";
  }
  return null;
}

/** Sorted-key JSON, so two anchor blocks compare by content whatever order their keys were written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** Why the agent binary a run is about to launch cannot be served from this baseline's anchors, or null. Its web-search
 *  anchors (the whole block, the no-request templates included) must equal the baseline's: otherwise the interceptor
 *  would refuse every search and the skill would run with no search evidence. Read from the exact binary the spawn
 *  resolved; a version change alone never refuses (the anchors have held across agent versions). Never quotes agent
 *  text. */
export function agentAnchorsRefusal(binaryPath: string, baselineAnchors: SearchAnchors): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(binaryPath);
  } catch (e) {
    return `--search-corpus: the agent this run would launch (${binaryPath}) could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}), so its web-search anchors cannot be checked`;
  }
  const got = extractSearchAnchors(buf);
  if (!got.ok)
    return `--search-corpus: the web-search anchors could not be read from it, the agent this run would launch (${binaryPath}); re-run \`cowork-harness sync\` with it staged`;
  const { source: _s, ...want } = baselineAnchors;
  if (canonical(got.anchors) !== canonical(want))
    return `--search-corpus: the agent this run would launch (${binaryPath}) has different web-search anchors from the baseline's, so every search would be refused; re-run \`cowork-harness sync\` with it staged`;
  return null;
}

export interface RunSearchCorpus {
  poolId: string;
  sha256: string;
  label: string;
  /** The keys to layer onto the agent's env, after everything else. */
  env: Record<string, string>;
  frames: ServeFrames;
  registry: SearchRegistry;
  ctx: ServeContext;
  /** `RunResult.searchCorpus`, read after `finish`. */
  result(): RunSearchCorpusResult;
  /** Stop the interceptor and remove its files; returns the frozen-promise infra error, if any. Idempotent.
   *  `configDir` is the agent's config dir, whose `projects/` holds the sub-agent transcripts. */
  finish(outDir: string, configDir?: string): Promise<string | null>;
}

export async function startRunSearchCorpus(o: {
  option: SearchCorpusOption;
  baseline: PlatformBaseline;
  outDir: string;
  /** The agent's env before the interceptor's keys: an operator NODE_EXTRA_CA_CERTS is kept, appended to the run CA. */
  agentEnv: NodeJS.ProcessEnv;
  upstream?: Upstream;
}): Promise<RunSearchCorpus> {
  const { manifest, records } = readPool(resolvePoolDir(o.option.pool));
  const params = o.option.minScore === undefined ? manifest.retrieval : { ...manifest.retrieval, minScore: o.option.minScore };
  const sha256 = o.option.minScore === undefined ? manifest.sha256 : poolHash(records, params);
  const anchors = o.baseline.agentBinary?.searchAnchors;
  const registry = new SearchRegistry();
  const logPath = join(o.outDir, "search-corpus.jsonl");
  writeFileSync(logPath, "", { mode: 0o600 });
  const ctx: ServeContext = {
    index: buildIndex(records, params),
    anchors,
    registry,
    miss: o.option.miss,
    log: (l) => appendFileSync(logPath, JSON.stringify(l) + "\n"),
  };
  const extra = o.agentEnv.NODE_EXTRA_CA_CERTS;
  let extraCaPem: string | undefined;
  if (extra) {
    try {
      extraCaPem = readFileSync(extra, "utf8");
    } catch {
      // Dropping it would leave the agent unable to verify the hosts it was set for, through the blind tunnels.
      throw new UsageError(`--search-corpus: NODE_EXTRA_CA_CERTS (${extra}) cannot be read; fix or unset it for this run`);
    }
  }
  const ic: Interceptor = await startInterceptor({
    ctx,
    ...(o.upstream ? { upstream: o.upstream } : {}),
    ...(extraCaPem ? { extraCaPem } : {}),
  });
  const tmp = mkdtempSync(join(tmpdir(), "cwh-search-ca-"));
  chmodSync(tmp, 0o700);
  const caFile = join(tmp, "ca.pem");
  writeFileSync(caFile, ic.caPem, { mode: 0o600 });
  const reap = () => rmSync(tmp, { recursive: true, force: true });
  const deregister = registerCleanup({ phase: "network", run: reap });
  const frames = new ServeFrames({
    registry,
    noRequest: anchors?.noRequest,
    pool: { poolId: manifest.poolId, sha256 },
    miss: o.option.miss,
    quiesce: () => ic.quiesce(5000),
  });

  let finished: Promise<string | null> | null = null;
  let joined: { join: JoinResult; toolUsesExpected: number } | undefined;
  return {
    poolId: manifest.poolId,
    sha256,
    label: searchCorpusLabel(manifest.poolId, sha256),
    env: {
      HTTPS_PROXY: ic.url,
      https_proxy: ic.url,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_EXTRA_CA_CERTS: caFile,
    },
    frames,
    registry,
    ctx,
    result() {
      const c = registry.counts();
      const f = frames.counts();
      // Before finish (a run that ended early), parented pairings stay unconfirmed: no dispatch is read.
      const j = joined ?? {
        join: joinCalls({ entries: registry.all(), pairings: frames.pairings(), dispatchAgents: new Map(), miss: o.option.miss }),
        toolUsesExpected: 0,
      };
      const tops = registry
        .all()
        .filter((e) => e.verdict === "served" && e.rounds.length > 0)
        .map((e) => Math.max(...e.rounds.map((r) => r.nscore)));
      return {
        poolId: manifest.poolId,
        sha256,
        label: searchCorpusLabel(manifest.poolId, sha256),
        miss: o.option.miss,
        interposition: "proxy-env+ca",
        credentialSource: "env",
        metrics: {
          requests: c.requests,
          served: c.served,
          miss: c.miss,
          refused: c.refused,
          retriesFolded: c.retriesFolded,
          unfinished: c.unfinished,
          passedThroughWithSearchTool: ctx.passedThroughWithSearchTool ?? 0,
          toolUses: f.toolUses,
          noRequest: f.noRequest,
          toolUsesExpected: j.toolUsesExpected,
          byAgent: c.byAgent,
          liveServerTools: ctx.liveServerTools ?? 0,
          ...(tops.length ? { meanTopScore: tops.reduce((a, b) => a + b, 0) / tops.length } : {}),
          shapeUnfenced: f.shapeUnfenced,
          unattributed: j.join.unattributed,
          unattributedExpected: j.join.unattributedExpected,
          reassigned: j.join.reassigned,
          attributionUncertain: j.join.attributionUncertain,
        },
        calls: j.join.calls,
      };
    },
    finish(outDir: string, configDir?: string) {
      finished ??= (async () => {
        await ic.quiesce(5000);
        await ic.close();
        reap();
        deregister();
        // One line per request still being classified when the run closed: counted in `requests`, never framed.
        const ts = new Date().toISOString();
        for (let i = 0; i < registry.counts().unfinished; i++)
          appendFileSync(logPath, JSON.stringify({ ts, verdict: "unfinished" }) + "\n");
        const cfg = configDir ?? join(outDir, "claude-config");
        const fp = frozenPromise({ outDir, configDir: cfg, registry, ctx, frames, noRequest: anchors?.noRequest });
        // What the check above read, read once: the join only attributes, never changes that verdict, and never throws
        // past it (an unreadable file is the check's by-name error, and the join sees nothing from it).
        const dispatchAgents = dispatchAgentIds(fp.events, fp.transcripts);
        joined = {
          join: joinCalls({ entries: registry.all(), pairings: frames.pairings(), dispatchAgents, miss: o.option.miss }),
          toolUsesExpected: fp.toolUsesExpected,
        };
        return fp.error;
      })();
      return finished;
    },
  };
}

type Block = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
};

/** WebSearch tool_uses in one agent's record, and how many of their results made no request. */
function agentSide(
  lines: string[],
  o: { mainOnly?: boolean; parentedOnly?: boolean; noRequest: Parameters<typeof noRequestKind>[1]; denied: ReadonlySet<string> },
) {
  const ids = new Set<string>();
  let uses = 0;
  let noReq = 0;
  for (const line of lines) {
    if (!line.includes("WebSearch") && !line.includes("tool_result")) continue;
    let m: { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.mainOnly && typeof m.parent_tool_use_id === "string") continue;
    if (o.parentedOnly && typeof m.parent_tool_use_id !== "string") continue;
    const content = m?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (m.type === "assistant" && b?.type === "tool_use" && b.name === "WebSearch" && typeof b.id === "string" && !ids.has(b.id)) {
        ids.add(b.id);
        uses++;
      } else if (m.type === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string" && ids.has(b.tool_use_id)) {
        if (
          noRequestKind({ content: b.content, ...(b.is_error === true ? { is_error: true } : {}) }, o.noRequest, {
            deniedByHarness: o.denied.has(b.tool_use_id),
          })
        )
          noReq++;
      }
    }
  }
  return { uses, noReq, expected: uses - noReq };
}

function transcripts(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) transcripts(p, out);
    else if (/^agent-.+\.jsonl$/.test(n) && basename(dir) === "subagents") out.push(p);
  }
  return out;
}

/** The frozen-promise check over a finished run dir. Null when it holds. */
export function frozenPromiseError(o: Parameters<typeof frozenPromise>[0]): string | null {
  return frozenPromise(o).error;
}

/** The frozen-promise check, and the requests the agents' own records say were made (main loop and transcripts). */
export function frozenPromise(o: {
  outDir: string;
  /** The agent's config dir (default `<outDir>/claude-config`). */
  configDir?: string;
  registry: SearchRegistry;
  ctx: Pick<ServeContext, "passedThroughWithSearchTool">;
  frames: Pick<ServeFrames, "deniedIds">;
  noRequest: Parameters<typeof noRequestKind>[1];
}): {
  error: string | null;
  toolUsesExpected: number;
  /** What it read, for the join to reuse: the stream record's lines, and each transcript's. */
  events: string[];
  transcripts: { agentId: string; lines: string[] }[];
} {
  const problems: string[] = [];
  if ((o.ctx.passedThroughWithSearchTool ?? 0) > 0)
    problems.push(`${o.ctx.passedThroughWithSearchTool} request(s) carrying a server search tool were forwarded upstream`);
  const counts = o.registry.counts();
  const denied = o.frames.deniedIds();
  const intercepted = (a: string) => {
    const c = counts.byAgent[a];
    return c ? c.served + c.miss + c.refused : 0;
  };
  const eventsPath = join(o.outDir, "events.jsonl");
  // The run's own stream record: without it, a sub-agent-only run would balance on its transcripts alone, and the
  // parented floor below would read nothing. Any intercepted request makes its absence an error.
  let events: string[] = [];
  if (!existsSync(eventsPath)) {
    if (counts.requests > 0) problems.push("events.jsonl is missing, so the run's own record of its searches cannot be read");
  } else
    try {
      events = readFileSync(eventsPath, "utf8").split("\n");
    } catch (e) {
      problems.push(`events.jsonl could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  const main = agentSide(events, { mainOnly: true, noRequest: o.noRequest, denied });
  const sides: [string, number][] = [["main", main.expected]];
  let inTranscripts = 0;
  const read: { agentId: string; lines: string[] }[] = [];
  for (const f of transcripts(join(o.configDir ?? join(o.outDir, "claude-config"), "projects"))) {
    const id = /^agent-(.+)\.jsonl$/.exec(basename(f))![1]!;
    let lines: string[];
    try {
      lines = readFileSync(f, "utf8").split("\n");
    } catch (e) {
      problems.push(`sub-agent ${id}'s transcript could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      continue;
    }
    read.push({ agentId: id, lines });
    const expected = agentSide(lines, { noRequest: o.noRequest, denied }).expected;
    inTranscripts += expected;
    sides.push([id, expected]);
  }
  // A floor that does not depend on finding the transcripts: the sub-agents' searches that also streamed into the main
  // record (parented frames) must all be in some transcript. A moved or renamed transcript dir cannot read as green.
  const parented = agentSide(events, { parentedOnly: true, noRequest: o.noRequest, denied }).expected;
  if (parented > inTranscripts)
    problems.push(`sub-agents made ${parented} search request(s) in the main stream, and their transcripts hold ${inTranscripts}`);
  const seen = new Set(sides.map(([a]) => a));
  for (const a of Object.keys(counts.byAgent)) if (!seen.has(a)) sides.push([a, 0]);
  for (const [a, expected] of sides) {
    const got = intercepted(a);
    if (got !== expected)
      problems.push(
        `${a === "main" ? "the main agent" : `sub-agent ${a}`} made ${expected} search request(s) by its own record, and the interceptor saw ${got}`,
      );
  }
  if (counts.unfinished) problems.push(`${counts.unfinished} request(s) were still being classified when the run closed`);
  return {
    error: problems.length ? `search corpus: the frozen promise could not be confirmed: ${problems.join("; ")}` : null,
    toolUsesExpected: main.expected + inTranscripts,
    events,
    transcripts: read,
  };
}

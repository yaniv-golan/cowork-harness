/**
 * The serve frames: one `{"_emu":"search_corpus_serve", …}` line in events.jsonl per intercepted search request,
 * written by the session stream, the only writer. A frame goes directly after the WebSearch tool_result it answers
 * (main loop or a parented sub-agent result: `streamed: true`). A request whose tool_result never streams (a depth-2
 * sub-agent's, or one the agent never finished) is framed when the session closes (`streamed: false`), after the
 * interceptor has quiesced. So every intercepted request gets exactly one frame, and every frame lands before the
 * stream is closed.
 *
 * A tool_result is joined to its registry entry by key: the query and the domain lists from its WebSearch tool_use.
 * Retrieval is deterministic given those and the pool, so two same-key requests name the same records whichever
 * pairing is taken. A tool_result that shows no request was made (`noRequestKind`) never takes an entry, so it cannot
 * steal a later request's frame. Frames carry no credential, header or host path.
 */

import { noRequestKind, type NoRequestAnchors } from "./no-request.js";
import type { RegistryEntry, SearchRegistry } from "./registry.js";

export const SERVE_FRAME = "search_corpus_serve";

interface PendingUse {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  parentToolUseId?: string;
}

const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

export class ServeFrames {
  private readonly uses = new Map<string, PendingUse>();
  private readonly deniedIds_ = new Set<string>();
  private toolUses = 0;
  private noRequest = 0;

  constructor(
    private readonly o: {
      registry: SearchRegistry;
      noRequest: NoRequestAnchors | undefined;
      pool: { poolId: string; sha256: string };
      quiesce: () => Promise<{ abandoned: number }>;
    },
  ) {}

  /** The harness denied this WebSearch tool_use: its result made no request. */
  denied(toolUseId: string): void {
    this.deniedIds_.add(toolUseId);
  }

  /** One parsed stream frame in; the serve frame lines to write directly after it out. */
  observe(msg: unknown): string[] {
    const m = msg as { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
    const content = m?.message?.content;
    if (!Array.isArray(content)) return [];
    const parent = typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : undefined;
    const out: string[] = [];
    for (const b of content as Record<string, unknown>[]) {
      if (m.type === "assistant" && b?.type === "tool_use" && b.name === "WebSearch" && typeof b.id === "string") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        if (typeof input.query !== "string") continue;
        this.toolUses++;
        const allowedDomains = strings(input.allowed_domains);
        const blockedDomains = strings(input.blocked_domains);
        this.uses.set(b.id, {
          query: input.query,
          ...(allowedDomains?.length ? { allowedDomains } : {}),
          ...(blockedDomains?.length ? { blockedDomains } : {}),
          ...(parent ? { parentToolUseId: parent } : {}),
        });
      } else if (m.type === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const use = this.uses.get(b.tool_use_id);
        if (!use) continue;
        this.uses.delete(b.tool_use_id);
        const kind = noRequestKind({ content: b.content, ...(b.is_error === true ? { is_error: true } : {}) }, this.o.noRequest, {
          deniedByHarness: this.deniedIds_.has(b.tool_use_id),
        });
        if (kind) {
          this.noRequest++;
          continue;
        }
        const e = this.o.registry.take(use);
        if (!e) continue;
        out.push(
          this.line(e, {
            streamed: true,
            toolUseId: b.tool_use_id,
            ...(use.parentToolUseId ? { parentToolUseId: use.parentToolUseId } : {}),
          }),
        );
      }
    }
    return out;
  }

  /** At session close: let the interceptor finish classifying, then frame every request no tool_result took. */
  async finish(): Promise<string[]> {
    await this.o.quiesce();
    return this.o.registry.unconsumed().map((e) => this.line(e, { streamed: false, ...(e.agentId ? { agentId: e.agentId } : {}) }));
  }

  /** The WebSearch tool_uses the harness denied. */
  deniedIds(): ReadonlySet<string> {
    return this.deniedIds_;
  }

  /** WebSearch tool_uses seen in the stream, and how many of their results made no request. */
  counts(): { toolUses: number; noRequest: number } {
    return { toolUses: this.toolUses, noRequest: this.noRequest };
  }

  private line(e: RegistryEntry, head: Record<string, unknown>): string {
    return JSON.stringify({
      _emu: SERVE_FRAME,
      ...head,
      query: e.query,
      ...(e.allowedDomains?.length ? { allowedDomains: e.allowedDomains } : {}),
      ...(e.blockedDomains?.length ? { blockedDomains: e.blockedDomains } : {}),
      ordinal: e.ordinal,
      pool: this.o.pool,
      verdict: e.verdict,
      rounds: e.rounds,
    });
  }
}

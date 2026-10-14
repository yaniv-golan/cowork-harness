/**
 * The frozen search corpus's record of every intercepted request, filled by the interceptor synchronously when it
 * classifies a request and before it writes the response. The session stream reads it to write one serve frame per
 * intercepted request, and the run reads its counts for the frozen-promise check, so a served request whose
 * tool_result never arrives is still on record.
 *
 * Requests are counted logically: a `stream: false` retry of an agent's previous request is folded into it, as the
 * agent-side count folds it. Each agent's requests are numbered from 1 (the main loop's agent id is null).
 */

/** One served round, as the frame and the run's per-call record carry it. */
export interface FrameRound {
  match: "exact" | "nearby";
  /** This round's score over the query's reachable maximum. */
  nscore: number;
  sourceQuery: string;
  recordId: string;
  sourceSkill: string | null;
  urls: string[];
}

export interface RegistryInput {
  /** `x-claude-code-agent-id`; null for the main loop and an inline skill. A Task sub-agent, an `Agent(fork)` and a
   *  `context: fork` skill each send it and write their own transcript (measured on 2.1.295), so a fork is keyed like a
   *  sub-agent here, unlike tool-call origin, where a fork counts as main. */
  agentId: string | null;
  route: "messages" | "ccr";
  verdict: "served" | "miss" | "refused";
  /** Null when the request was refused before its query could be read (an undecodable body, a prefix mismatch). */
  query: string | null;
  allowedDomains?: string[];
  blockedDomains?: string[];
  rounds: FrameRound[];
  /** Every URL the served exact records carry, those deduped out of their round included (see `Selection.exactUrls`). */
  exactUrls?: string[];
  /** What identifies a retry of this request (its body without `stream`); null when it has none. */
  retryKey: string | null;
}

export interface RegistryEntry extends Readonly<RegistryInput> {
  readonly ordinal: number;
}

export interface SearchKey {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface RegistryCounts {
  /** Every request seen, unfinished ones included; folded retries are not requests. */
  requests: number;
  served: number;
  miss: number;
  refused: number;
  retriesFolded: number;
  /** Still classifying when the session closed: logged, never framed, never counted as served, miss or refused. */
  unfinished: number;
  byAgent: Record<string, { served: number; miss: number; refused: number }>;
}

const list = (xs: string[] | undefined) => JSON.stringify(xs ?? []);
const keyOf = (k: SearchKey) => `${JSON.stringify(k.query)}|${list(k.allowedDomains)}|${list(k.blockedDomains)}`;
const agentKey = (agentId: string | null) => agentId ?? "main";

export class SearchRegistry {
  private readonly entries: RegistryEntry[] = [];
  private readonly consumed = new Set<RegistryEntry>();
  private readonly ordinals = new Map<string, number>();
  private closedFlag = false;
  private readonly inFlight = new Set<number>();
  private nextToken = 1;
  private folded = 0;
  private unfinished = 0;

  /** A request has started classifying. */
  begin(): number {
    const t = this.nextToken++;
    this.inFlight.add(t);
    return t;
  }

  /** Its classification finished (recorded, folded, or passed through as no search at all). */
  end(token: number): void {
    this.inFlight.delete(token);
  }

  pending(): number {
    return this.inFlight.size;
  }

  /** The session is closing and will not wait longer: every request still classifying is counted unfinished. */
  abandonPending(): number {
    const n = this.inFlight.size;
    this.unfinished += n;
    this.inFlight.clear();
    return n;
  }

  /** No request is recorded after this: the session has written the frames for what was recorded. */
  close(): void {
    this.closedFlag = true;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  record(input: RegistryInput): RegistryEntry {
    if (this.closedFlag) throw new Error("the search registry is closed");
    const a = agentKey(input.agentId);
    const ordinal = (this.ordinals.get(a) ?? 0) + 1;
    this.ordinals.set(a, ordinal);
    const entry: RegistryEntry = Object.freeze({
      ...input,
      ...(input.allowedDomains ? { allowedDomains: [...input.allowedDomains] } : {}),
      ...(input.blockedDomains ? { blockedDomains: [...input.blockedDomains] } : {}),
      rounds: input.rounds.map((r) => ({ ...r, urls: [...r.urls] })),
      ...(input.exactUrls ? { exactUrls: [...input.exactUrls] } : {}),
      ordinal,
    });
    this.entries.push(entry);
    return entry;
  }

  /** The agent's latest request with this retry key, when this one retries it; the retry is counted as folded. Another
   *  request of the same agent may be in flight in between (WebSearch calls run concurrently). */
  retryOf(agentId: string | null, retryKey: string): RegistryEntry | undefined {
    const a = agentKey(agentId);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (agentKey(e.agentId) === a && e.retryKey !== null && e.retryKey === retryKey) {
        this.folded++;
        return e;
      }
    }
    return undefined;
  }

  /** The earliest entry for this key the stream has not framed yet; it is then framed. A fence narrows it: a result in
   *  the main loop's stream (`parented: false`) takes only an entry with no agent id (the main loop, an inline skill), a
   *  parented one only an entry with one (a sub-agent or a fork); `verdicts` keeps only the answers the result shows. */
  take(key: SearchKey, fence: { parented?: boolean; verdicts?: readonly RegistryEntry["verdict"][] } = {}): RegistryEntry | undefined {
    const k = keyOf(key);
    const e = this.entries.find(
      (x) =>
        x.query !== null &&
        !this.consumed.has(x) &&
        keyOf(x as SearchKey) === k &&
        (fence.parented === undefined || (x.agentId !== null) === fence.parented) &&
        (fence.verdicts === undefined || fence.verdicts.includes(x.verdict)),
    );
    if (e) this.consumed.add(e);
    return e;
  }

  /** Entries no streamed tool_result took, in record order: framed at close as unstreamed. */
  unconsumed(): RegistryEntry[] {
    return this.entries.filter((e) => !this.consumed.has(e));
  }

  all(): RegistryEntry[] {
    return [...this.entries];
  }

  counts(): RegistryCounts {
    const byAgent: RegistryCounts["byAgent"] = {};
    const c = { served: 0, miss: 0, refused: 0 };
    for (const e of this.entries) {
      c[e.verdict]++;
      const a = (byAgent[agentKey(e.agentId)] ??= { served: 0, miss: 0, refused: 0 });
      a[e.verdict]++;
    }
    return { requests: this.entries.length + this.unfinished, ...c, retriesFolded: this.folded, unfinished: this.unfinished, byAgent };
  }
}

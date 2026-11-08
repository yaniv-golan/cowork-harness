// The served-model assertion of runner-scaffold.mjs (runner-scaffold.mjs l.476-494), applied to the main loop.
//
// The model under test is the one the MAIN loop ran on; sub-agents may legitimately run on another model
// (`subagent_model:`), so they are excluded. RunResult.modelPinHonored is not used for this: it is
// `observed.some(m => m === pin)` over every model seen anywhere in the run, sub-agents included
// (src/run/model-provenance.ts:123; src/run/run.ts:856-861), so a main loop that switched models mid-run
// still reads as "honored". It stays an additional trigger in the row classifier.

import { isLiveModelId } from "../types.js";
import { modelIdMatches, normalizeModelId } from "../run/model-provenance.js";
import { currentTurnEventLines } from "../run/turn-events.js";

/** Distinct live models on the current turn's main-loop assistant events (no `parent_tool_use_id`), in
 *  first-seen order. `<synthetic>` and model-less events are skipped. */
export function mainLoopModels(lines: readonly string[]): string[] {
  const seen: string[] = [];
  for (const line of currentTurnEventLines([...lines])) {
    if (!line.includes('"assistant"')) continue;
    let o: { type?: unknown; parent_tool_use_id?: unknown; message?: { model?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== "assistant" || o.parent_tool_use_id) continue;
    const m = o.message?.model;
    if (isLiveModelId(m) && !seen.includes(m)) seen.push(m);
  }
  return seen;
}

/** The first main-loop model that the pin does not account for, or undefined when every one matches it
 *  (`modelIdMatches`: exactly, or by a documented alias → snapshot resolution — 'foo-latest' / 'foo-0' / 'foo'
 *  served as 'foo-20250101', 'foo@20250101' or 'foo-2025-01-01'). Anything else — another snapshot of the pin, a
 *  sibling model, or the bare base id served for an alias (an unversioned echo that can hide snapshot drift) — is a
 *  substitution. No pin ⇒ no check, as the scaffold skips it without --model. */
export function servedModelMismatch(pin: string | undefined, models: readonly string[]): string | undefined {
  if (pin === undefined) return undefined;
  return models.find((served) => !modelIdMatches(pin, served));
}

/** The effort levels an agent request carries (`output_config.effort`). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** What the agent's own session transcript says about the effort of its main-loop calls. */
export interface SentEffort {
  /** Distinct efforts sent, in first-seen order. */
  values: string[];
  /** Main-loop calls that went out with no effort (the agent retried without one, or a model with no selector). */
  unsent: number;
  /** Main-loop calls whose recorded effort is not an effort level. Never kept as a value: the transcript is
   *  agent-writable evidence, and a row records only a known level. */
  invalid: number;
  /** Main-loop calls with a live model. */
  calls: number;
}

/** The effort each main-loop call went out with, read from the agent's own session transcript
 *  (`<config>/projects/<cwd>/<session>.jsonl`, which `events.jsonl` does not carry). The agent stamps every assistant
 *  line with the effort of the request that produced it — the request's final `output_config.effort`, so after the
 *  env override, the model's caps and the thinking-off clamp — as `effort`, overridden by `perTurnEffort` when set;
 *  neither is present when the request went out without one. Main loop only (`isSidechain` false; sub-agents write
 *  their own files); `<synthetic>` API-error lines carry none and are skipped, as `mainLoopModels` skips them.
 *
 *  The whole file is read, and it holds only the current turn: every hillclimb attempt gets a fresh run id
 *  (`attemptRunId`, job.ts), and `executeScenario` refuses `--resume` / `--session-id` with a pre-assigned run id, so
 *  no attempt continues an earlier session. The file has no turn marker to scope a resumed session by. */
export function sentEffort(transcript: readonly string[]): SentEffort {
  const out: SentEffort = { values: [], unsent: 0, invalid: 0, calls: 0 };
  for (const line of transcript) {
    if (!line.includes('"assistant"')) continue;
    let o: { type?: unknown; isSidechain?: unknown; effort?: unknown; perTurnEffort?: unknown; message?: { model?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== "assistant" || o.isSidechain === true || !isLiveModelId(o.message?.model)) continue;
    out.calls++;
    const e =
      typeof o.perTurnEffort === "string" && o.perTurnEffort
        ? o.perTurnEffort
        : typeof o.effort === "string" && o.effort
          ? o.effort
          : undefined;
    if (e === undefined) out.unsent++;
    else if (!(EFFORT_LEVELS as readonly string[]).includes(e)) out.invalid++;
    else if (!out.values.includes(e)) out.values.push(e);
  }
  return out;
}

/** One requested model whose scored rows were served more than one model id. */
export interface ServedModelSplit {
  requested: string;
  served: string[];
  /** The cases whose rows carry the split, sorted. */
  cases: string[];
  /** Every row of this pin was written under `--allow-model-split` (`meta.model_split_allowed`). */
  allowed: boolean;
}

/** Over a variant's `results.jsonl`: each requested model (`meta.model_requested`) whose scored rows record more than
 *  one served `model` among those that match it. A pin matches its dated snapshots, so an undated pin can be served
 *  two of them (a snapshot rolled between passes, or during one): the variant's scores then come from two models.
 *  Rows that record no request, or whose served model is not the pin's (a substitution, already an error row), are
 *  not counted. Lines that do not parse are skipped (schema-check reports them). */
export function servedModelSplits(results: string | null | undefined): ServedModelSplit[] {
  const by = new Map<string, { served: Set<string>; cases: Set<string>; allowed: boolean }>();
  for (const line of (results ?? "").split("\n")) {
    if (!line.trim()) continue;
    let r: { prompt_id?: unknown; model?: unknown; meta?: { model_requested?: unknown; model_split_allowed?: unknown } };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const req = r.meta?.model_requested;
    if (typeof req !== "string" || typeof r.model !== "string" || !modelIdMatches(req, r.model)) continue;
    const k = normalizeModelId(req);
    const e = by.get(k) ?? { served: new Set<string>(), cases: new Set<string>(), allowed: true };
    e.served.add(normalizeModelId(r.model));
    e.cases.add(String(r.prompt_id));
    if (r.meta?.model_split_allowed !== true) e.allowed = false;
    by.set(k, e);
  }
  return [...by.entries()]
    .filter(([, e]) => e.served.size > 1)
    .map(([requested, e]) => ({ requested, served: [...e.served].sort(), cases: [...e.cases].sort(), allowed: e.allowed }));
}

/** The one sentence each surface (the pre-spend refusal, the post-pass failure, `hillclimb check`) prints for a split. */
export function servedModelSplitText(variant: string, s: ServedModelSplit): string {
  return (
    `variant ${variant}'s scored rows for model ${s.requested} were served ${s.served.join(" and ")} ` +
    `(cases ${s.cases.join(", ")}): its scores come from more than one model. Start a fresh flow dir and pin the dated id, or pass --allow-model-split (recorded on every row)`
  );
}

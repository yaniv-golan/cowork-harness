// The served-model assertion of runner-scaffold.mjs (runner-scaffold.mjs l.476-494), applied to the main loop.
//
// The model under test is the one the MAIN loop ran on; sub-agents may legitimately run on another model
// (`subagent_model:`), so they are excluded. RunResult.modelPinHonored is not used for this: it is
// `observed.some(m => m === pin)` over every model seen anywhere in the run, sub-agents included
// (src/run/model-provenance.ts:123; src/run/run.ts:856-861), so a main loop that switched models mid-run
// still reads as "honored". It stays an additional trigger in the row classifier.

import { isLiveModelId } from "../types.js";
import { normalizeModelId } from "../run/model-provenance.js";
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

// the scaffold's documented alias → snapshot shapes: 'foo-latest' / 'foo-0' / 'foo' served as 'foo-20250101',
// 'foo@20250101' or 'foo-2025-01-01'.
const SNAPSHOT_SUFFIX = /^[-@](\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The first main-loop model that the pin does not account for, or undefined when every one matches the
 *  pin exactly or by a documented alias → snapshot resolution. Anything else — another snapshot of the
 *  pin, a sibling model, or the bare base id served for an alias (an unversioned echo that can hide
 *  snapshot drift) — is a substitution. No pin ⇒ no check, as the scaffold skips it without --model. */
export function servedModelMismatch(pin: string | undefined, models: readonly string[]): string | undefined {
  if (pin === undefined) return undefined;
  const want = normalizeModelId(pin);
  const base = want.replace(/-latest$|-0$/, "");
  for (const served of models) {
    const got = normalizeModelId(served);
    if (got === want) continue;
    const rest = got.startsWith(base) ? got.slice(base.length) : null;
    if (rest !== null && SNAPSHOT_SUFFIX.test(rest)) continue;
    return served;
  }
  return undefined;
}

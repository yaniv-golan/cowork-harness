/**
 * The one recogniser for a WebSearch tool_result that shows NO nested request was made, so the frozen-promise check
 * does not expect one from the interceptor, and the session stream does not spend a registry entry on it.
 *
 * Three agent-side outcomes answer a WebSearch without a request:
 * - `validation`: the tool's input check refused it. The agent's tool runner returns the message inside its
 *   `<tool_use_error>` wrapper with `is_error`; the inner message must hash to one of the two recorded messages, or
 *   start with the runner's recorded schema-failure prefix (a query too short for the input schema). Only a WebSearch
 *   tool_use's result is ever passed here, so the runner's prefix on another tool's result is never read.
 * - `permission`: the harness denied the tool. Recognised from the harness's own decision for that tool_use, never
 *   from text: a denial the harness did not make (a settings rule the agent applies itself) is not recognised, so the
 *   frozen-promise check reports a request that never arrived. A false red, never a false green.
 * - `budget`: the search budget is used up. The result is an ordinary results envelope whose one entry is a text
 *   built from a fixed prefix, the word `turn` or `session`, a fixed fragment, then variables. The prefix and the
 *   fragment must hash to the recorded ones; the rest is not checked.
 *
 * The anchors are hashes from `agentBinary.searchAnchors.noRequest`, never agent text. An answered request, including
 * the harness's own "Web search error: unavailable" refusal, is not a no-request result.
 */

import { createHash } from "node:crypto";
import type { SearchAnchors } from "../types.js";
import { parseWebSearchResult } from "./render.js";

export type NoRequestAnchors = NonNullable<SearchAnchors["noRequest"]>;
export type NoRequestKind = "validation" | "permission" | "budget";

/** The agent's tool runner wraps a refused input this way: public tool-runner behaviour, not prose. */
const ERROR_OPEN = "<tool_use_error>";
const ERROR_CLOSE = "</tool_use_error>";

type Hashed = { sha256: string; bytes: number };

function matches(bytes: Buffer, h: Hashed): boolean {
  return bytes.length === h.bytes && createHash("sha256").update(bytes).digest("hex") === h.sha256;
}

/** A tool_result's text: a string, or exactly one text block (a child transcript's form). */
function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length === 1) {
    const b = content[0] as { type?: unknown; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") return b.text;
  }
  return null;
}

export function noRequestKind(
  block: { content: unknown; is_error?: boolean },
  anchors: NoRequestAnchors | undefined,
  o: { deniedByHarness: boolean },
): NoRequestKind | null {
  if (o.deniedByHarness) return "permission";
  if (!anchors) return null;
  const text = textOf(block.content);
  if (text === null) return null;

  if (block.is_error === true && text.startsWith(ERROR_OPEN) && text.endsWith(ERROR_CLOSE)) {
    const inner = Buffer.from(text.slice(ERROR_OPEN.length, text.length - ERROR_CLOSE.length), "utf8");
    if (matches(inner, anchors.missingQuery) || matches(inner, anchors.bothDomainLists)) return "validation";
    // The runner's schema failure (a query too short for the input schema): its fixed prefix, then a detail not checked.
    const iv = anchors.inputValidationPrefix;
    if (iv && matches(inner.subarray(0, iv.bytes), iv)) return "validation";
    return null;
  }

  const parsed = parseWebSearchResult(text);
  if (!parsed.ok || parsed.result.entries.length !== 1) return null;
  const only = parsed.result.entries[0]!;
  if (only.kind !== "text") return null;
  const b = Buffer.from(only.text, "utf8");
  const p1 = anchors.budgetPrefix.bytes;
  if (!matches(b.subarray(0, p1), anchors.budgetPrefix)) return null;
  const rest = b.subarray(p1).toString("utf8");
  const scope = rest.startsWith("turn") ? "turn" : rest.startsWith("session") ? "session" : null;
  if (scope === null) return null;
  const after = Buffer.from(rest.slice(scope.length), "utf8");
  return matches(after.subarray(0, anchors.budgetFragment.bytes), anchors.budgetFragment) ? "budget" : null;
}

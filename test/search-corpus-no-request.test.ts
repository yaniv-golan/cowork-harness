import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractSearchAnchors, SEARCH_ANCHOR_CALL_SITE } from "../src/sync/search-anchors.js";
import { noRequestKind } from "../src/search-corpus/no-request.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";

// Every fixture here is CONSTRUCTED FROM BINARY OFFSETS, NOT YET OBSERVED ON THE WIRE: no kept run carries any of
// these shapes. The prose is invented; only the shapes follow the 2.1.295 agent (the validateInput messages inside the
// tool runner's error wrapper with is_error, and the budget-cap string as the one text entry of an ordinary results
// envelope).
const h = (t: string) => ({ sha256: createHash("sha256").update(t, "utf8").digest("hex"), bytes: Buffer.byteLength(t) });
const MISSING = "Error: nothing to look up";
const BOTH = "Error: pick one list of domains, not both";
const P1 = "Search skipped: this ";
const P2 = " has spent its search allowance (";
const IVE = "Bad tool input here: ";
const anchors = {
  missingQuery: h(MISSING),
  bothDomainLists: h(BOTH),
  budgetPrefix: h(P1),
  budgetFragment: h(P2),
  inputValidationPrefix: h(IVE),
};
const REM = "REMINDER: cite the sources above.";
const wrapped = (m: string) => `<tool_use_error>${m}</tool_use_error>`;
const envelope = (entries: Parameters<typeof renderWebSearchResult>[0]["entries"]) =>
  renderWebSearchResult({ query: "q", entries, reminder: REM });
const budget = (scope: string, tail: string) => envelope([{ kind: "text", text: `${P1}${scope}${P2}${tail}` }]);
const kind = (content: unknown, isError = false, deniedByHarness = false) =>
  noRequestKind({ content, ...(isError ? { is_error: true } : {}) }, anchors, { deniedByHarness });

describe("noRequestKind: a WebSearch tool_result that shows no request was made", () => {
  it("validateInput: is_error, the runner's wrapper, and an exact hash of the inner message", () => {
    expect(kind(wrapped(MISSING), true)).toBe("validation");
    expect(kind(wrapped(BOTH), true)).toBe("validation");
    expect(kind([{ type: "text", text: wrapped(MISSING) }], true)).toBe("validation"); // a child transcript's block form
  });

  it("validateInput never matches without is_error, outside the wrapper, or on a message that only starts the same", () => {
    expect(kind(wrapped(MISSING), false)).toBeNull();
    expect(kind(MISSING, true)).toBeNull();
    expect(kind(wrapped(`${MISSING} and more`), true)).toBeNull();
    expect(kind(wrapped("Error: something else"), true)).toBeNull();
    // a served result whose text merely begins with "Error" is never a validation refusal
    expect(kind(envelope([{ kind: "text", text: `${MISSING} was the old message` }]))).toBeNull();
  });

  it("a schema failure (a query too short for the tool's input): is_error, the wrapper and the hashed runner prefix; the detail is not checked", () => {
    expect(kind(wrapped(`${IVE}[{"code":"too_small","minimum":2}]`), true)).toBe("validation");
    expect(kind(wrapped(`${IVE}anything`), false)).toBeNull();
    expect(kind(wrapped(`Other prefix: ${IVE}`), true)).toBeNull();
  });

  it("a permission denial is the harness's own decision for that tool_use, never a text match", () => {
    expect(kind(wrapped("The user declined."), true, true)).toBe("permission");
    expect(kind("anything at all", false, true)).toBe("permission");
  });

  it("a denial with no harness decision (e.g. a settings deny rule the agent applies itself) is NOT recognised: the agent-side count then goes red, never green", () => {
    expect(kind(wrapped("Permission to use WebSearch has been denied."), true, false)).toBeNull();
  });

  it("the budget cap: the one text entry, P1, turn or session, P2; the tail is not checked", () => {
    // both refill branches and the env-dependent suffix differ only in the tail
    expect(kind(budget("turn", "limit: 8 calls per turn, shared by every agent in it). Continue."))).toBe("budget");
    expect(kind(budget("session", "limit: 8 calls, shared by every agent in this session; it does not refill). Continue."))).toBe("budget");
    expect(
      kind(budget("turn", "limit: 8 calls shared by every agent in this turn; the budget refills at about 4 calls per hour). Wait.")),
    ).toBe("budget");
    expect(kind(budget("session", "x). Continue. If more searches are genuinely needed, ask the user to raise THE_LIMIT."))).toBe("budget");
  });

  it("the budget cap never matches another scope word, a changed fragment, or a text that is not the lone entry", () => {
    expect(kind(budget("week", "x)."))).toBeNull();
    expect(kind(envelope([{ kind: "text", text: `${P1}turn has used up its allowance (x).` }]))).toBeNull();
    // a served result whose text starts like P1 but sits after links: not a lone text entry
    expect(
      kind(
        envelope([
          { kind: "links", links: [{ title: "t", url: "https://t" }] },
          { kind: "text", text: `${P1}turn${P2}x).` },
        ]),
      ),
    ).toBeNull();
    // (Two adjacent text entries render as one, the agent's own join, so they are the same bytes as one longer tail.)
    expect(kind("not an envelope")).toBeNull();
  });

  it("an ordinary served, missed or refused result is not a no-request result", () => {
    expect(
      kind(
        envelope([
          { kind: "links", links: [{ title: "t", url: "https://t" }] },
          { kind: "text", text: "prose" },
        ]),
      ),
    ).toBeNull();
    expect(kind(envelope([{ kind: "links", links: [] }]))).toBeNull(); // a miss: "No links found."
    expect(kind(envelope([{ kind: "text", text: "Web search error: unavailable" }]))).toBeNull(); // a refusal: answered
  });

  it("without anchors (a baseline that predates them) nothing matches but a harness denial", () => {
    expect(noRequestKind({ content: wrapped(MISSING), is_error: true }, undefined, { deniedByHarness: false })).toBeNull();
    expect(noRequestKind({ content: "x" }, undefined, { deniedByHarness: true })).toBe("permission");
  });
});

// Local only: the real agent's own literals, read from the binary at test time (never committed), built into the
// result shapes the agent emits, recognised with the anchors `sync` extracts from the same binary.
const AGENT = join(homedir(), "cowork-agent-backup/vm-elf/2.1.295/claude");
describe.skipIf(!existsSync(AGENT))("noRequestKind against the real 2.1.295 literals (local only)", () => {
  it("recognises the agent's own validation messages and budget text with the anchors sync extracts", () => {
    const buf = readFileSync(AGENT);
    const r = extractSearchAnchors(buf);
    if (!r.ok) throw new Error(r.defects.join("; "));
    const nr = r.anchors.noRequest!;
    const at = buf.indexOf(SEARCH_ANCHOR_CALL_SITE);
    const win = buf.subarray(at - 6000, at).toString("latin1");
    const msg = (code: number) => new RegExp(`message:"([^"]*)",errorCode:${code}\\}`).exec(win)![1]!;
    const tpl = /results:\[`([^`$]*)\$\{[\w$]+\}([^`$]*)\$\{/.exec(win)!;
    const wrap = (m: string) => `<tool_use_error>${m}</tool_use_error>`;
    expect(noRequestKind({ content: wrap(msg(1)), is_error: true }, nr, { deniedByHarness: false })).toBe("validation");
    expect(noRequestKind({ content: wrap(msg(2)), is_error: true }, nr, { deniedByHarness: false })).toBe("validation");
    for (const scope of ["turn", "session"]) {
      const text = renderWebSearchResult({
        query: "q",
        entries: [{ kind: "text", text: `${tpl[1]}${scope}${tpl[2]}limit: 8). x` }],
        reminder: REM,
      });
      expect(noRequestKind({ content: text }, nr, { deniedByHarness: false }), scope).toBe("budget");
    }
  });
});

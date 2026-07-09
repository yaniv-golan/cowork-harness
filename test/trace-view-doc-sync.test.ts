import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Anti-drift tripwire: the `trace --view` enum lives in two places that must agree —
// src/cli.ts's VIEWS array (what the CLI actually accepts) and README.md's trace row (what a
// user reading the docs believes is accepted). Neither is generated from the other, so a view
// added/renamed/removed in one and not the other silently rots. Source of truth is src/cli.ts;
// the module is NOT imported here (it has side effects on load) — its VIEWS array literal is
// regex-parsed out of the source text instead, same technique as the COMMANDS parse in
// test/cli-help.test.ts.

describe("trace --view enum ↔ README docs", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");
  const viewsIdx = src.indexOf("const VIEWS = [");
  const viewsBlock = src.slice(viewsIdx, src.indexOf("]", viewsIdx));
  const cliViews = [...viewsBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const readme = readFileSync(resolve("README.md"), "utf8");
  // The trace row documents the view list as `--view tools\|questions\|...\|usage` inside a
  // markdown table cell — pipes are backslash-escaped there to avoid breaking the table, so the
  // separator to split on is the literal two-character sequence `\|`, not a bare `|`.
  // Require at least one escaped pipe so this matches the trace row's full enum list rather than
  // the single-view usage example elsewhere in the README (e.g. `--view tools` in a quickstart
  // snippet, which has no `\|` and would otherwise match first).
  const viewListMatch = readme.match(/--view ([a-zA-Z0-9-]+(?:\\\|[a-zA-Z0-9-]+)+)/);

  it("parsed a sane VIEWS set from src/cli.ts (guards against the array literal moving/renaming)", () => {
    expect(cliViews.length).toBeGreaterThan(3);
    expect(cliViews).toContain("tools");
    expect(cliViews).toContain("usage");
  });

  it("found the --view list documented in README.md's trace row", () => {
    expect(viewListMatch, "README.md's trace row no longer has a `--view a|b|c` list in the expected shape").not.toBeNull();
  });

  it("src/cli.ts VIEWS and README.md's documented --view list are the same set", () => {
    const readmeViews = (viewListMatch?.[1] ?? "").split("\\|");
    const missingFromReadme = cliViews.filter((v) => !readmeViews.includes(v));
    const extraInReadme = readmeViews.filter((v) => !cliViews.includes(v));
    expect(
      { missingFromReadme, extraInReadme },
      `README.md's trace --view list is out of sync with src/cli.ts VIEWS.\n` +
        `cli VIEWS: ${cliViews.join(", ")}\n` +
        `README --view: ${readmeViews.join(", ")}`,
    ).toEqual({ missingFromReadme: [], extraInReadme: [] });
  });
});

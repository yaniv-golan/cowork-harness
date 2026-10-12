import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestRun, recordId } from "../src/search-corpus/harvest.js";
import { renderWebSearchResult } from "../src/search-corpus/render.js";

// Synthetic run dir in the harness's per-turn layout. All web text is invented.
const REM = "REMINDER: cite the sources above.";
const result = (query: string, links: { title: string; url: string }[], text: string) =>
  renderWebSearchResult({ query, entries: [{ kind: "links", links }, ...(text ? [{ kind: "text" as const, text }] : [])], reminder: REM });
const use = (id: string, query: string, parent?: string) =>
  JSON.stringify({
    type: "assistant",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_use", id, name: "WebSearch", input: { query } }] },
  });
const res = (id: string, content: unknown, parent?: string, isError = false) =>
  JSON.stringify({
    type: "user",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  });

function runDir(o: { events: string[]; child?: string[]; result?: object }): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-harvest-"));
  const d = join(root, "my-scenario", "local_abc");
  mkdirSync(join(d, "turns", "1"), { recursive: true });
  writeFileSync(
    join(d, "events.jsonl"),
    [JSON.stringify({ type: "system", subtype: "init", claude_code_version: "9.9.9" }), ...o.events].join("\n"),
  );
  writeFileSync(
    join(d, "turns", "1", "result.json"),
    JSON.stringify(
      o.result ?? {
        scenario: "my-scenario",
        baseline: "1.2.3",
        models: ["m-1"],
        skillCommit: "abc123",
        fingerprint: { contentSig: "sig-1", skillSources: ["../../plugins/my-skill"] },
      },
    ),
  );
  writeFileSync(join(d, "status.json"), JSON.stringify({ startedAt: "2026-10-01T00:00:00Z" }));
  if (o.child) {
    const sub = join(d, "claude-config", "projects", "p", "s", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-a1.jsonl"), o.child.join("\n"));
  }
  return d;
}

describe("harvestRun", () => {
  it("harvests a main-loop search with its provenance, and no host path", () => {
    const d = runDir({
      events: [use("t1", "widget market"), res("t1", result("widget market", [{ title: "A", url: "https://a" }], "Big."))],
    });
    const { records, counts } = harvestRun(d);
    expect(counts).toMatchObject({ results: 1, records: 1 });
    expect(records[0]).toMatchObject({
      query: "widget market",
      links: [{ title: "A", url: "https://a" }],
      text: "Big.",
      origin: "events",
      agent: "main",
    });
    expect(records[0]!.id).toBe(recordId({ query: "widget market", links: [{ title: "A", url: "https://a" }], text: "Big." }));
    expect(records[0]!.source).toMatchObject({
      scenario: "my-scenario",
      skill: "my-skill",
      skillRef: "abc123",
      variantHash: "sig-1",
      agentVersion: "9.9.9",
      desktopVersion: "1.2.3",
      model: "m-1",
      recordedAt: "2026-10-01T00:00:00Z",
    });
    expect(records[0]!.source.runRef).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(records)).not.toContain(tmpdir());
  });

  it("keeps a sub-agent search once when both its transcript and its parented frames carry it", () => {
    const r = result("q sub", [{ title: "S", url: "https://s" }], "Sub prose.");
    const d = runDir({
      events: [use("p1", "q sub", "task1"), res("p1", r, "task1")],
      child: [use("c1", "q sub"), res("c1", [{ type: "text", text: r }])],
    });
    const { records, counts } = harvestRun(d);
    expect(records).toHaveLength(1);
    expect(records[0]!.agent).toBe("subagent");
    expect(counts.duplicates).toBe(1);
  });

  it("harvests a sub-agent search whose transcript was not captured", () => {
    const d = runDir({ events: [use("p1", "only parented", "task1"), res("p1", result("only parented", [], "x"), "task1")] });
    expect(harvestRun(d).records.map((r) => r.agent)).toEqual(["subagent"]);
  });

  it("skips and counts error results, unreadable text, a query mismatch and an agent search-error line", () => {
    const d = runDir({
      events: [
        use("e1", "q"),
        res("e1", "boom", undefined, true),
        use("e2", "q"),
        res("e2", "not the agent format"),
        use("e3", "asked"),
        res("e3", result("other query", [], "x")),
        use("e4", "q"),
        res("e4", renderWebSearchResult({ query: "q", entries: [{ kind: "text", text: "Web search error: unavailable" }], reminder: REM })),
      ],
    });
    expect(harvestRun(d).counts).toMatchObject({ results: 4, records: 0, errorResults: 1, unparsed: 1, queryMismatch: 1, searchErrors: 1 });
  });

  it("splits a multi-search result into one record per link set", () => {
    const text = renderWebSearchResult({
      query: "q",
      entries: [
        { kind: "links", links: [{ title: "1", url: "u1" }] },
        { kind: "text", text: "one" },
        { kind: "links", links: [{ title: "2", url: "u2" }] },
        { kind: "text", text: "two" },
      ],
      reminder: REM,
    });
    const d = runDir({ events: [use("t", "q"), res("t", text)] });
    expect(harvestRun(d).records.map((r) => [r.links[0]!.url, r.text])).toEqual([
      ["u1", "one"],
      ["u2", "two"],
    ]);
  });

  it("records null provenance fields rather than inventing them", () => {
    const d = runDir({ events: [use("t", "q"), res("t", result("q", [], "x"))], result: { scenario: "s" } });
    expect(harvestRun(d).records[0]!.source).toMatchObject({ skillRef: null, variantHash: null, model: null, desktopVersion: null });
  });
});

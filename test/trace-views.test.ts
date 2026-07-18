import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTrace,
  buildToolErrors,
  formatToolErrors,
  buildFilesView,
  formatFilesView,
  buildUsageView,
  formatUsageView,
} from "../src/run/trace-view.js";

const assistant = (blocks: unknown[], parent?: string) => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: blocks },
});
const userResult = (toolUseId: string, isError: boolean, text: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: text }] },
});

/** Write an events.jsonl (and optional sibling result.json) into a fresh run dir; return the events.jsonl
 *  path — exactly what `resolveEventsFile` yields and what the build* views consume. */
function runDir(events: unknown[], result?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "cwh-trace-views-"));
  writeFileSync(join(dir, "events.jsonl"), events.map((l) => JSON.stringify(l)).join("\n"));
  if (result) writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  return join(dir, "events.jsonl");
}

// ── Item 6: tool-errors view + resultTextFull (multi-line stderr no longer dropped) ──────────────
describe("trace --view tool-errors", () => {
  const MULTILINE = "exit status 1: command failed\nstderr line two: the real cause\nstderr line three: hint";

  it("error rows keep a fuller multi-line capture in resultTextFull; resultText stays first-line/120", () => {
    const f = runDir([
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "python3 build.py" } }]),
      userResult("toolu_1", true, MULTILINE),
      { type: "result", is_error: false },
    ]);
    const bash = buildTrace(f).find((r) => r.kind === "tool" && r.name === "Bash")!;
    expect(bash.resultStatus).toBe("error");
    // resultText: the pre-existing first-line-only field the other views use
    expect(bash.resultText).toBe("exit status 1: command failed");
    expect(bash.resultText).not.toContain("stderr line two");
    // resultTextFull: the new fuller capture — multi-line, preserves the real cause
    expect(bash.resultTextFull).toContain("stderr line two: the real cause");
    expect(bash.resultTextFull).toContain("stderr line three");
  });

  it("caps resultTextFull at ~4KB so a runaway stderr can't balloon the envelope", () => {
    const huge = "boom\n" + "x".repeat(10_000);
    const f = runDir([
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat big" } }]),
      userResult("toolu_1", true, huge),
      { type: "result", is_error: false },
    ]);
    const bash = buildTrace(f).find((r) => r.kind === "tool" && r.name === "Bash")!;
    expect(bash.resultTextFull!.length).toBeLessThanOrEqual(4096);
  });

  it("buildToolErrors lists one row per errored tool call, with full command + full stderr; ok calls excluded", () => {
    const f = runDir([
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "python3 build.py" } }]),
      userResult("toolu_1", true, MULTILINE),
      assistant([{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x" } }]),
      userResult("toolu_2", false, "file contents"),
      { type: "result", is_error: false },
    ]);
    const rows = buildToolErrors(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Bash" });
    expect(rows[0].detail).toContain("python3 build.py");
    expect(rows[0].resultText).toContain("stderr line two: the real cause");
    // text render surfaces command + multi-line stderr
    const txt = formatToolErrors(rows);
    expect(txt).toContain("python3 build.py");
    expect(txt).toContain("stderr line three");
  });

  it("formatToolErrors reports no errors cleanly", () => {
    expect(formatToolErrors([])).toContain("no tool errors");
  });
});

// ── Item 9: files view — workspaceFiles[] tree + diff vs preRunHashes ─────────────────────────────
describe("trace --view files", () => {
  const events = [{ type: "result", is_error: false }];

  it("classifies each file and diffs it against preRunHashes (added/modified/removed/unchanged)", () => {
    const f = runDir(events, {
      workspaceFiles: [
        { path: "out/report.md", bytes: 10, sha256: "newhash", class: "output" }, // added (not in pre)
        { path: "in/data.csv", bytes: 20, sha256: "changed", class: "input" }, // modified
        { path: "in/keep.txt", bytes: 5, sha256: "same", class: "input" }, // unchanged
      ],
      preRunHashes: {
        "in/data.csv": "original",
        "in/keep.txt": "same",
        "in/gone.txt": "wasHere", // removed (present pre, absent post)
      },
    });
    const v = buildFilesView(f);
    expect(v.available).toBe(true);
    expect(v.diffAvailable).toBe(true);
    const byPath = Object.fromEntries(v.rows.map((r) => [r.path, r.diff]));
    expect(byPath["out/report.md"]).toBe("added");
    expect(byPath["in/data.csv"]).toBe("modified");
    expect(byPath["in/keep.txt"]).toBe("unchanged");
    expect(byPath["in/gone.txt"]).toBe("removed");
    // grouped tree render mentions the classes
    const txt = formatFilesView(v);
    expect(txt).toContain("output");
    expect(txt).toContain("report.md");
  });

  it("per-entry: a null pre-hash or a hashError (undefined sha256) yields 'unavailable', never a false 'unchanged'", () => {
    const f = runDir(events, {
      workspaceFiles: [
        { path: "in/scrubbed.txt", bytes: 5, sha256: "abc", class: "input" }, // pre-hash is null
        { path: "out/nohash.bin", bytes: 5, hashError: "over cap", class: "output" }, // sha256 undefined
      ],
      preRunHashes: { "in/scrubbed.txt": null },
    });
    const byPath = Object.fromEntries(buildFilesView(f).rows.map((r) => [r.path, r.diff]));
    expect(byPath["in/scrubbed.txt"]).toBe("unavailable");
    expect(byPath["out/nohash.bin"]).toBe("unavailable");
  });

  it("degrade: no sibling result.json → not a crash, an explanatory 'needs a run dir'", () => {
    const f = runDir(events); // no result.json
    const v = buildFilesView(f);
    expect(v.available).toBe(false);
    expect(formatFilesView(v)).toMatch(/run dir/i);
  });

  it("degrade: preRunHashes absent (microvm/pre-0.27) → diff column 'unavailable' for every row", () => {
    const f = runDir(events, {
      workspaceFiles: [{ path: "out/a.md", bytes: 1, sha256: "h", class: "output" }],
    });
    const v = buildFilesView(f);
    expect(v.available).toBe(true);
    expect(v.diffAvailable).toBe(false);
    expect(v.rows.every((r) => r.diff === "unavailable")).toBe(true);
  });

  // workspaceFiles ABSENT (undefined) means evidence-unavailable (replay, or a live run whose workspace
  // root vanished — the honest-marker lane), distinct from [] (a run that wrote nothing). The `?? []`
  // collapse erased that distinction; these lock the honest passthrough.
  it("workspaceFiles ABSENT → workspaceFilesRecorded:false and a loud UNAVAILABLE marker (not the empty-tree line)", () => {
    const f = runDir(events, { result: "success" }); // no workspaceFiles key at all
    const v = buildFilesView(f);
    expect(v.available).toBe(true);
    expect(v.workspaceFilesRecorded).toBe(false);
    expect(formatFilesView(v)).toMatch(/UNAVAILABLE/);
  });

  it("workspaceFiles: [] → workspaceFilesRecorded:true and an affirming empty-workspace line — and the two texts differ", () => {
    const absent = buildFilesView(runDir(events, { result: "success" }));
    const empty = buildFilesView(runDir(events, { workspaceFiles: [] }));
    expect(empty.available).toBe(true);
    expect(empty.workspaceFilesRecorded).toBe(true);
    // genuinely-empty must NOT say UNAVAILABLE, and must read differently from the absent case
    expect(formatFilesView(empty)).not.toMatch(/UNAVAILABLE/);
    expect(formatFilesView(empty)).not.toBe(formatFilesView(absent));
  });

  // The defect the fix must actually kill: workspaceFiles absent BUT preRunHashes present (the live
  // root-vanished shape — execute.ts sets workspaceFiles undefined on rootAbsent yet still persists
  // preRunHashes). The old removed-diff loop then emits a phantom "removed" row per pre-run file. A test WITHOUT preRunHashes
  // passes even against the unfixed collapse, so this preRunHashes-present case is the one that catches it.
  it("workspaceFiles absent + preRunHashes present → NO phantom 'removed' rows (rows:[], diffAvailable:false)", () => {
    const f = runDir(events, {
      result: "success",
      preRunHashes: { "in/a.txt": "h1", "in/b.txt": "h2", "in/c.txt": "h3" },
    });
    const v = buildFilesView(f);
    expect(v.workspaceFilesRecorded).toBe(false);
    expect(v.rows).toEqual([]); // NOT three "removed" rows
    expect(v.diffAvailable).toBe(false); // evidence-unavailable is not "an available, empty diff"
    expect(formatFilesView(v)).toMatch(/UNAVAILABLE/);
  });
});

// ── Item 10: usage view — modelUsage per-model tokens/cost/cache-ratio ────────────────────────────
describe("trace --view usage", () => {
  const events = [{ type: "result", is_error: false }];

  it("renders per-model tokens/cost and a cache-read ratio", () => {
    const f = runDir(events, {
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 300, cacheCreationInputTokens: 100, costUSD: 1.25 },
        "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 },
      },
    });
    const v = buildUsageView(f);
    expect(v.rows).toHaveLength(2);
    const opus = v.rows.find((r) => r.model === "claude-opus-4-8")!;
    expect(opus.costUSD).toBe(1.25);
    // 300 / (100 + 300 + 100) = 0.6
    expect(opus.cacheReadRatio).toBeCloseTo(0.6, 5);
    const txt = formatUsageView(v);
    expect(txt).toContain("claude-opus-4-8");
    expect(txt).toContain("60%");
  });

  it("degrade: no sibling result.json → 'needs a run dir'", () => {
    const v = buildUsageView(runDir(events));
    expect(v.rows).toHaveLength(0);
    expect(v.note).toMatch(/run dir/i);
    expect(formatUsageView(v)).toMatch(/run dir/i);
  });

  it("degrade: empty modelUsage → 'no usage recorded'", () => {
    const v = buildUsageView(runDir(events, { modelUsage: {} }));
    expect(v.rows).toHaveLength(0);
    expect(v.note).toMatch(/no usage/i);
  });
});

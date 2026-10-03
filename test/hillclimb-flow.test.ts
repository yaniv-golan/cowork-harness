// The flow-dir writer: every byte the runner writes into `.claude/hillclimb/<flow>/` goes through here, over
// the shared no-follow root (src/hillclimb/fs.ts), redacted (secrets, then host paths) — the flow dir is
// model-influenced AND committable (runner-scaffold.mjs runner-scaffold.mjs l.34-131, 343-455; build-eval.md build-eval.md l.213-219).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FlowWriter, flowHashOf, redactDeep, slotsIn } from "../src/hillclimb/flow.js";
import { FsRefusal } from "../src/hillclimb/fs.js";
import { UsageError } from "../src/errors.js";

let cwd: string;
const SECRET = "sk-ant-test-0123456789abcdef";
const open = (variant = "baseline") => FlowWriter.open(".claude/hillclimb/f", variant, { cwd, secrets: [SECRET] });
const flow = () => join(cwd, ".claude/hillclimb/f");
const lines = (p: string) =>
  readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "hc-flow-")));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("FlowWriter.open — preflight before any spend (runner-scaffold.mjs l.343-385)", () => {
  it("creates the variant's traces dir", () => {
    open("v2");
    expect(existsSync(join(flow(), "v2", "traces"))).toBe(true);
  });

  it("refuses a planted symlink at results.jsonl, _state.json or summary.json", () => {
    for (const rel of ["baseline/results.jsonl", "_state.json", "baseline/summary.json"]) {
      rmSync(flow(), { recursive: true, force: true });
      mkdirSync(join(flow(), "baseline"), { recursive: true });
      symlinkSync(join(cwd, "elsewhere"), join(flow(), rel));
      expect(() => open(), rel).toThrow(FsRefusal);
    }
  });

  it("refuses a symlinked ancestor of a relative --flow", () => {
    mkdirSync(join(cwd, "real"), { recursive: true });
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    symlinkSync(join(cwd, "real"), join(cwd, ".claude", "hillclimb"));
    expect(() => open()).toThrow(FsRefusal);
  });
});

describe("FlowWriter — state, resume, rows", () => {
  it("_state.json: absent is {}, unparsable refuses before spend, a valid one is read", () => {
    const w = open();
    expect(w.state()).toEqual({});
    writeFileSync(join(flow(), "_state.json"), "{nope");
    expect(() => w.state()).toThrow(UsageError);
    writeFileSync(join(flow(), "_state.json"), JSON.stringify({ harness_sha: "x", train_ids: ["a"] }));
    expect(w.state()).toEqual({ harness_sha: "x", train_ids: ["a"] });
  });

  it("the resume set holds every (prompt_id, rep) already in results.jsonl; malformed lines are skipped", () => {
    const w = open();
    w.appendResult({ prompt_id: "a", rep: 0 });
    w.appendResult({ prompt_id: "a", rep: 1 });
    writeFileSync(join(flow(), "baseline", "results.jsonl"), readFileSync(join(flow(), "baseline", "results.jsonl"), "utf8") + "{torn");
    expect([...slotsIn(w.readVariantFile("results.jsonl"))].sort()).toEqual(["a\u00000", "a\u00001"]);
  });

  it("errors never occupy a slot: an errors.jsonl line is not in the resume set (runner-scaffold.mjs l.549-551)", () => {
    const w = open();
    w.appendError({ prompt_id: "b", rep: 0, failure_class: "error" });
    expect(slotsIn(w.readVariantFile("results.jsonl")).size).toBe(0);
    expect(lines(join(flow(), "baseline", "errors.jsonl"))).toEqual([{ prompt_id: "b", rep: 0, failure_class: "error" }]);
  });

  it("a torn final line is isolated before the next append (runner-scaffold.mjs l.452-455)", () => {
    const w = open();
    writeFileSync(join(flow(), "baseline", "results.jsonl"), '{"prompt_id":"a","rep":0}\n{"prompt_id":"a","re');
    w.appendResult({ prompt_id: "b", rep: 0 });
    const text = readFileSync(join(flow(), "baseline", "results.jsonl"), "utf8").split("\n");
    expect(text[2]).toBe('{"prompt_id":"b","rep":0}');
  });

  it("errors.jsonl gets the same torn-line guard", () => {
    const w = open();
    writeFileSync(join(flow(), "baseline", "errors.jsonl"), '{"prompt_id":"a","rep":0,"failure_class":"err');
    w.appendError({ prompt_id: "b", rep: 0 });
    expect(readFileSync(join(flow(), "baseline", "errors.jsonl"), "utf8").split("\n")[1]).toBe('{"prompt_id":"b","rep":0}');
  });

  it("every written string is redacted: secrets first, then host paths", () => {
    const w = open();
    w.appendResult({ prompt_id: "a", rep: 0, meta: { note: `token ${SECRET} at ${homedir()}/proj/x`, nested: [`/opt/build/${SECRET}`] } });
    const text = readFileSync(join(flow(), "baseline", "results.jsonl"), "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(homedir());
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("~/proj/x");
  });

  it("writes traces/<id>_rep<k>.json as a pretty JSON list, redacted", () => {
    const w = open();
    w.writeTrace("case-a", 1, [{ role: "user", content: `see ${homedir()}/notes` }]);
    const t = JSON.parse(readFileSync(join(flow(), "baseline", "traces", "case-a_rep1.json"), "utf8"));
    expect(t).toEqual([{ role: "user", content: "see ~/notes" }]);
  });
});

describe("FlowWriter — summary.json, approval, progress", () => {
  it("summary.json: created with the runner's keys; a loop-written summary keeps every key and gains the missing ones", () => {
    const w = open();
    w.mergeSummary({ model: "claude-x", source_sig: "abc" });
    expect(JSON.parse(readFileSync(join(flow(), "baseline", "summary.json"), "utf8"))).toEqual({ model: "claude-x", source_sig: "abc" });
    writeFileSync(join(flow(), "baseline", "summary.json"), JSON.stringify({ description: "loop's", model: "claude-loop" }));
    w.mergeSummary({ model: "claude-x", source_sig: "abc" });
    expect(JSON.parse(readFileSync(join(flow(), "baseline", "summary.json"), "utf8"))).toEqual({
      description: "loop's",
      model: "claude-loop",
      source_sig: "abc",
    });
  });

  it("--approve-harness writes harness_sha and keeps every loop-owned key (runner-scaffold.mjs l.262-266)", () => {
    const w = open();
    writeFileSync(
      join(flow(), "_state.json"),
      JSON.stringify({ best: { round: 1 }, harness_sha: "old", harness_files: { "a.yaml": "0" } }),
    );
    w.approveHarness("new", undefined, { "b.yaml": "1" });
    // The per-entry hashes are replaced whole: an entry the new sha no longer covers is never kept.
    expect(JSON.parse(readFileSync(join(flow(), "_state.json"), "utf8"))).toEqual({
      best: { round: 1 },
      harness_sha: "new",
      harness_files: { "b.yaml": "1" },
    });
  });

  it("progress.txt holds the last progress line", () => {
    const w = open();
    w.writeProgress("[baseline] 1/2 done (1 ok, 0 failed), 3s elapsed, ~3s left");
    expect(readFileSync(join(flow(), "baseline", "progress.txt"), "utf8")).toBe(
      "[baseline] 1/2 done (1 ok, 0 failed), 3s elapsed, ~3s left\n",
    );
  });
});

describe("FlowWriter — the variant lock (stricter than S: two runners on one variant would duplicate rows)", () => {
  it("a second holder is refused while the first holds it; release frees it", () => {
    const a = open();
    const release = a.lock();
    expect(() => open().lock()).toThrow(/another hillclimb process .* holds .*\.lock/);
    release();
    expect(() => open().lock()()).not.toThrow();
  });

  it("a lock left by a dead process is taken over", () => {
    const w = open();
    writeFileSync(join(flow(), "baseline", ".lock"), JSON.stringify({ pid: 2 ** 22 + 12345, started: "2000-01-01T00:00:00Z" }));
    expect(() => w.lock()()).not.toThrow();
  });
});

describe("redactDeep", () => {
  it("leaves numbers, booleans and keys alone", () => {
    expect(redactDeep({ a: 1, b: true, [homedir()]: "x" }, [])).toEqual({ a: 1, b: true, [homedir()]: "x" });
  });
});

describe("flowHashOf — one identity for a flow, before and after its dir exists", () => {
  it("is the same for a not-yet-created flow and the created one, through a symlinked ancestor", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "hc-fh-")));
    const alias = join(tmpdir(), `hc-fh-alias-${process.pid}`);
    symlinkSync(real, alias);
    try {
      const before = flowHashOf(join(alias, "a", "flow"));
      mkdirSync(join(real, "a", "flow"), { recursive: true });
      expect(flowHashOf(join(alias, "a", "flow"))).toBe(before);
      expect(flowHashOf(join(real, "a", "flow"))).toBe(before);
      expect(before).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      unlinkSync(alias);
      rmSync(real, { recursive: true, force: true });
    }
  });
});

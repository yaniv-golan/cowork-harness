// extractMetrics / measureMetrics: every evidence gate and its reason, the order the gates run in, the pre_run rule
// (content hash against the pre-run manifest — a byte-identical rewrite is untouched), and the output shape.
// Pure: hand-built contexts over a temp tree. Synthetic data only.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMetrics, measureMetrics, metricsFor, type MetricsContext } from "../src/metrics.js";
import type { ScenarioMetric } from "../src/types.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
let root: string;
let mnt: string;
const put = (rel: string, body: string | Buffer) => {
  const p = join(mnt, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "metrics-x-")));
  mnt = join(root, "mnt");
  mkdirSync(join(mnt, "outputs"), { recursive: true });
});
const ctx = (over: Partial<MetricsContext> = {}): MetricsContext => ({
  workRoot: mnt,
  userVisiblePrefixes: ["outputs"],
  preRunHashes: {},
  preRunPaths: [],
  ...over,
});
const m = (artifact: string, path = "n", id = "n"): ScenarioMetric => ({ id, artifact, path, better: "higher", scale: 10 });
const one = (c: MetricsContext, d: ScenarioMetric) => extractMetrics(c, [d])[0];

describe("a value", () => {
  it("a new file's number at a dotted path", () => {
    put("outputs/m.json", '{"a":{"b":3.5}}');
    expect(one(ctx(), m("outputs/m.json", "a.b"))).toEqual({ id: "n", value: 3.5 });
  });
  it("an array index and an array's length", () => {
    put("outputs/m.json", '{"items":[{"s":4},{"s":5}]}');
    expect(one(ctx(), m("outputs/m.json", "items.1.s"))).toEqual({ id: "n", value: 5 });
    expect(one(ctx(), m("outputs/m.json", "items.length"))).toEqual({ id: "n", value: 2 });
  });
  it("a pre-run file the run rewrote with different bytes", () => {
    put("outputs/m.json", '{"n":2}');
    expect(one(ctx({ preRunHashes: { "outputs/m.json": sha('{"n":1}') } }), m("outputs/m.json"))).toEqual({ id: "n", value: 2 });
  });
});

describe("shape and order", () => {
  it("one entry per declaration, in declaration order, each with exactly one of value / unavailable", () => {
    put("outputs/a.json", '{"n":1}');
    put("outputs/c.json", '{"n":"x"}');
    const out = extractMetrics(ctx(), [
      m("outputs/c.json", "n", "zz"),
      m("outputs/missing.json", "n", "aa"),
      m("outputs/a.json", "n", "mm"),
    ]);
    expect(out).toEqual([
      { id: "zz", unavailable: "not_a_number" },
      { id: "aa", unavailable: "missing_artifact" },
      { id: "mm", value: 1 },
    ]);
    for (const e of out) expect(("value" in e ? 1 : 0) + ("unavailable" in e ? 1 : 0)).toBe(1);
  });
  it("metricsFor: absent when none are declared, an empty list included", () => {
    expect(metricsFor(ctx(), undefined)).toBeUndefined();
    expect(metricsFor(ctx(), [])).toBeUndefined();
    expect(metricsFor(ctx(), [m("outputs/x.json")])).toEqual([{ id: "n", unavailable: "missing_artifact" }]);
  });
});

describe("every gate's reason", () => {
  it("lane remote, even when the file is there", () => {
    put("outputs/m.json", '{"n":1}');
    expect(one(ctx({ lane: "remote" }), m("outputs/m.json"))).toEqual({ id: "n", unavailable: "remote" });
    expect(one(ctx({ preRunOrigin: "remote-unavailable" }), m("outputs/m.json")).unavailable).toBe("remote");
  });
  it("no work tree: pruned", () => {
    expect(one(ctx({ workRoot: join(root, "gone") }), m("outputs/m.json")).unavailable).toBe("pruned");
    expect(one(ctx({ workRoot: "" }), m("outputs/m.json")).unavailable).toBe("pruned");
  });
  it("missing file, a directory, a symlink escaping the root: missing_artifact", () => {
    expect(one(ctx(), m("outputs/none.json")).unavailable).toBe("missing_artifact");
    mkdirSync(join(mnt, "outputs", "dir.json"));
    expect(one(ctx(), m("outputs/dir.json")).unavailable).toBe("missing_artifact");
    writeFileSync(join(root, "outside.json"), '{"n":1}');
    symlinkSync(join(root, "outside.json"), join(mnt, "outputs", "esc.json"));
    expect(one(ctx(), m("outputs/esc.json")).unavailable).toBe("missing_artifact");
  });
  it("a live read-only folder and a replay read-only entry: readonly", () => {
    put("outputs/m.json", '{"n":1}');
    expect(one(ctx({ readonlyFolderRoots: ["outputs"] }), m("outputs/m.json")).unavailable).toBe("readonly");
    expect(one(ctx({ truncatedPaths: new Map([["outputs/m.json", "readonly" as const]]) }), m("outputs/m.json")).unavailable).toBe(
      "readonly",
    );
  });
  it("replay body-less: size, fixture / input → pre_run, unreadable → missing_artifact", () => {
    put("outputs/m.json", "");
    const tp = (r: "size" | "fixture" | "input" | "unreadable" | undefined) => ctx({ truncatedPaths: new Map([["outputs/m.json", r]]) });
    expect(one(tp("size"), m("outputs/m.json")).unavailable).toBe("size");
    expect(one(tp("fixture"), m("outputs/m.json")).unavailable).toBe("pre_run");
    expect(one(tp("input"), m("outputs/m.json")).unavailable).toBe("pre_run");
    expect(one(tp("unreadable"), m("outputs/m.json")).unavailable).toBe("missing_artifact");
    expect(one(tp(undefined), m("outputs/m.json")).unavailable).toBe("missing_artifact");
  });
  it("replay body-less over the cap but untouched: pre_run, not size", () => {
    put("outputs/m.json", "");
    const c = ctx({
      truncatedPaths: new Map([["outputs/m.json", "size" as const]]),
      preRunHashes: { "outputs/m.json": "h".repeat(64) },
      postRunHashes: { "outputs/m.json": "h".repeat(64) },
    });
    expect(one(c, m("outputs/m.json")).unavailable).toBe("pre_run");
  });
  it("replay body-less over the cap but outside the walked roots: pre_run, not a cap to raise", () => {
    put("other/q.json", "");
    const c = ctx({ truncatedPaths: new Map([["other/q.json", "size" as const]]), postRunHashes: { "other/q.json": "h".repeat(64) } });
    const [x] = measureMetrics(c, [m("other/q.json")]);
    expect([x.unavailable, x.evidenceLimited === true, x.remedy]).toEqual(["pre_run", false, undefined]);
  });
  it("a replay link placeholder is not evidence-limited: the live run reads a link as pre_run too", () => {
    put("outputs/m.json", "");
    expect(measureMetrics(ctx({ linkPaths: new Set(["outputs/m.json"]) }), [m("outputs/m.json")])[0].evidenceLimited).toBeUndefined();
  });
  it("a replay link placeholder: pre_run", () => {
    put("outputs/m.json", "");
    expect(one(ctx({ linkPaths: new Set(["outputs/m.json"]) }), m("outputs/m.json")).unavailable).toBe("pre_run");
  });
  it("over the 10 MiB cap: size — checked BEFORE authorship, whose own re-hash cap would read it as pre_run", () => {
    put("outputs/big.json", Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    process.env.COWORK_HARNESS_PRERUN_HASH_CAP = "16";
    try {
      expect(one(ctx(), m("outputs/big.json")).unavailable).toBe("size");
    } finally {
      delete process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
    }
  });
  it("not JSON: not_json", () => {
    put("outputs/m.json", "{nope");
    expect(one(ctx(), m("outputs/m.json")).unavailable).toBe("not_json");
  });
  it("an absent key or an unresolvable intermediate: missing_path", () => {
    put("outputs/m.json", '{"a":{"b":1},"s":"x"}');
    expect(one(ctx(), m("outputs/m.json", "a.c")).unavailable).toBe("missing_path");
    expect(one(ctx(), m("outputs/m.json", "x.y")).unavailable).toBe("missing_path");
    expect(one(ctx(), m("outputs/m.json", "s.y")).unavailable).toBe("missing_path");
  });
  it("never coerced, never 0: not_a_number", () => {
    for (const v of ['"42"', "true", "null", "{}", "[]", "1e999"]) {
      put("outputs/m.json", `{"n":${v}}`);
      expect(one(ctx(), m("outputs/m.json")), v).toEqual({ id: "n", unavailable: "not_a_number" });
    }
  });
});

describe("pre_run: the run did not write the file", () => {
  it("an untouched pre-run file", () => {
    put("outputs/m.json", '{"n":1}');
    expect(one(ctx({ preRunHashes: { "outputs/m.json": sha('{"n":1}') } }), m("outputs/m.json")).unavailable).toBe("pre_run");
  });
  it("a file the run rewrote with byte-identical content reads as untouched", () => {
    const body = '{"n":7}';
    put("outputs/m.json", body); // the pre-run content …
    const pre = { "outputs/m.json": sha(body) };
    put("outputs/m.json", body); // … written again, unchanged
    expect(one(ctx({ preRunHashes: pre }), m("outputs/m.json"))).toEqual({ id: "n", unavailable: "pre_run" });
  });
  it("a --resume turn, even for a new file", () => {
    put("outputs/m.json", '{"n":1}');
    expect(one(ctx({ resume: true }), m("outputs/m.json")).unavailable).toBe("pre_run");
  });
  it("no pre-run manifest: no_manifest (authorship cannot be decided), evidence-limited, the remedy a re-run", () => {
    put("outputs/m.json", '{"n":1}');
    expect(one(ctx({ preRunHashes: undefined }), m("outputs/m.json"))).toEqual({ id: "n", unavailable: "no_manifest" });
    const x = measureMetrics(ctx({ preRunHashes: undefined }), [m("outputs/m.json")])[0]!;
    expect([x.unavailable, x.evidenceLimited]).toEqual(["no_manifest", true]);
    expect(x.remedy).toMatch(/^re-run the case: declaring a metric arms the pre-run manifest/);
  });
  it("a null pre-run hash", () => {
    put("outputs/m.json", '{"n":1}');
    expect(one(ctx({ preRunHashes: { "outputs/m.json": null } }), m("outputs/m.json")).unavailable).toBe("pre_run");
  });
  it("a second hard link", () => {
    put("outputs/m.json", '{"n":1}');
    linkSync(join(mnt, "outputs", "m.json"), join(mnt, "outputs", "h.json"));
    expect(one(ctx(), m("outputs/h.json")).unavailable).toBe("pre_run");
  });
  it("a symlink at the path, inside the root", () => {
    put("outputs/real.json", '{"n":1}');
    symlinkSync(join(mnt, "outputs", "real.json"), join(mnt, "outputs", "l.json"));
    expect(one(ctx(), m("outputs/l.json")).unavailable).toBe("pre_run");
  });
  it("a path reached through a symlinked directory inside the root", () => {
    put("outputs/realdir/m.json", '{"n":1}');
    symlinkSync(join(mnt, "outputs", "realdir"), join(mnt, "outputs", "via"));
    expect(one(ctx(), m("outputs/via/m.json")).unavailable).toBe("pre_run");
  });
  it("a path outside the folders the pre-run walk covers", () => {
    put(".local-plugins/p/score.json", '{"n":9}');
    expect(one(ctx(), m(".local-plugins/p/score.json")).unavailable).toBe("pre_run");
  });
});

describe("a recorded post-run anchor (regrade)", () => {
  it("bytes that match the run's recorded hash: measured; edited since, or never recorded: pruned", () => {
    put("outputs/m.json", '{"n":1}');
    expect(one(ctx({ recordedPostRunHashes: { "outputs/m.json": sha('{"n":1}') } }), m("outputs/m.json"))).toEqual({ id: "n", value: 1 });
    expect(one(ctx({ recordedPostRunHashes: { "outputs/m.json": sha('{"n":0}') } }), m("outputs/m.json")).unavailable).toBe("pruned");
    expect(one(ctx({ recordedPostRunHashes: {} }), m("outputs/m.json")).unavailable).toBe("pruned");
  });
});

describe("evidence-limited outcomes are marked (replay warns on these)", () => {
  it("no work tree, a body the recording did not keep, a missing hash — but not an untouched file or a missing one", () => {
    put("outputs/u.json", '{"n":1}');
    put("outputs/s.json", "");
    const c = ctx({
      preRunHashes: { "outputs/u.json": sha('{"n":1}'), "outputs/nh.json": null },
      truncatedPaths: new Map([["outputs/s.json", "size" as const]]),
    });
    put("outputs/nh.json", '{"n":1}');
    const out = measureMetrics(c, [
      m("outputs/u.json", "n", "u"),
      m("outputs/s.json", "n", "s"),
      m("outputs/nh.json", "n", "nh"),
      m("outputs/x.json", "n", "x"),
    ]);
    expect(out.map((x) => [x.id, x.unavailable, x.evidenceLimited === true])).toEqual([
      ["u", "pre_run", false],
      ["s", "size", true],
      ["nh", "pre_run", true],
      ["x", "missing_artifact", false],
    ]);
    expect(measureMetrics(ctx({ workRoot: "" }), [m("outputs/u.json")])[0].evidenceLimited).toBe(true);
  });
});

describe("purity", () => {
  it("writes nothing: the tree's names and mtimes are unchanged", () => {
    put("outputs/m.json", '{"n":1}');
    const snap = () =>
      readdirSync(join(mnt, "outputs"))
        .sort()
        .map((n) => `${n}:${statSync(join(mnt, "outputs", n)).mtimeMs}`);
    const before = snap();
    extractMetrics(ctx(), [m("outputs/m.json"), m("outputs/none.json")]);
    expect(snap()).toEqual(before);
  });
});

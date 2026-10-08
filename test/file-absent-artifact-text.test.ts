import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluate, type AssertContext } from "../src/assert.js";
import { LIVE_ONLY_KEYS, MANIFEST_KEYS } from "../src/run/cassette.js";
import type { Assertion } from "../src/types.js";

// Two keys, one shared theme: a NEGATIVE check must never pass because the evidence was missing.
// `file_absent` is the dangerous inverse of `file_exists` (which fails safe when it can't see a file);
// `artifact_text`'s `not_contains` is the dangerous inverse of `contains`.

function work(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-fa-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function ctx(workRoot: string, over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set<string>(),
    subagentTools: new Set<string>(),
    filesRead: [],
    initTools: [],
    workRoot,
    userVisiblePrefixes: ["outputs"],
    readonlyFolderRoots: [],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    result: "success",
    ...over,
  } as unknown as AssertContext;
}
const run = (a: Assertion, c: AssertContext) => evaluate([a], c)[0];

describe("file_absent", () => {
  it("passes when the path is not there, fails when it is", () => {
    const root = work({ "outputs/report.md": "hi" });
    expect(run({ file_absent: "outputs/report.json" }, ctx(root)).pass).toBe(true);
    const r = run({ file_absent: "outputs/report.md" }, ctx(root));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/file exists but was asserted absent/);
  });

  it("refuses a path that escapes the work root", () => {
    expect(run({ file_absent: "../etc/passwd" }, ctx(work())).pass).toBe(false);
    expect(run({ file_absent: "/etc/passwd" }, ctx(work())).pass).toBe(false);
  });

  // The two lanes where "not found locally" is not evidence of absence. `file_exists` has neither
  // guard because it fails safe there; copying it verbatim would have shipped a false green.
  it("fails evidence-unavailable on lane: remote", () => {
    const r = run({ file_absent: "outputs/x" }, ctx(work(), { lane: "remote" }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/lane: remote/);
  });

  it("fails evidence-unavailable when the run's filesystem was never local", () => {
    const r = run({ file_absent: "outputs/x" }, ctx(work(), { preRunOrigin: "remote-unavailable" }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/evidence unavailable/);
  });

  // ...but NOT the exhaustive-family guard. `local-unreadable` means the pre-run BASELINE is
  // incomplete, which says nothing about whether THIS path is on the post-run tree.
  it("still evaluates under preRunOrigin: local-unreadable — that flag is about the baseline, not this path", () => {
    const root = work({ "outputs/report.md": "hi" });
    expect(run({ file_absent: "outputs/nope" }, ctx(root, { preRunOrigin: "local-unreadable" })).pass).toBe(true);
    expect(run({ file_absent: "outputs/report.md" }, ctx(root, { preRunOrigin: "local-unreadable" })).pass).toBe(false);
  });

  it("is LIVE-only, not a manifest key — absence is unprovable from a health-less manifest", () => {
    expect(LIVE_ONLY_KEYS).toContain("file_absent");
    expect(MANIFEST_KEYS).not.toContain("file_absent");
  });
});

describe("artifact_text", () => {
  const root = () =>
    work({ "outputs/report.json": '{"report_markdown":"see criteria.md for the rubric"}', "outputs/report.md": "clean prose" });

  it("catches the leak in the surface that still has it, and passes the one that does not", () => {
    // The reported shape: a fix applied to report.md alone looks complete while report.json carries 13
    // more copies. One entry per delivered surface is the point.
    const leaked = run({ artifact_text: { artifact: "outputs/report.json", not_contains: ["criteria.md"] } }, ctx(root()));
    expect(leaked.pass).toBe(false);
    expect(leaked.message).toMatch(/unexpectedly contains/);
    expect(run({ artifact_text: { artifact: "outputs/report.md", not_contains: ["criteria.md"] } }, ctx(root())).pass).toBe(true);
  });

  it("supports contains / matches / not_matches", () => {
    expect(run({ artifact_text: { artifact: "outputs/report.md", contains: ["clean"] } }, ctx(root())).pass).toBe(true);
    expect(run({ artifact_text: { artifact: "outputs/report.md", contains: ["absent"] } }, ctx(root())).pass).toBe(false);
    expect(run({ artifact_text: { artifact: "outputs/report.md", matches: "^clean" } }, ctx(root())).pass).toBe(true);
    expect(run({ artifact_text: { artifact: "outputs/report.md", not_matches: "rubric" } }, ctx(root())).pass).toBe(true);
  });

  it("requires a matcher, and reports a bad regex rather than silently not matching", () => {
    expect(run({ artifact_text: { artifact: "outputs/report.md" } }, ctx(root())).pass).toBe(false);
    expect(run({ artifact_text: { artifact: "outputs/report.md", matches: "([" } }, ctx(root())).message).toMatch(/bad regex/);
  });

  it("a missing file fails rather than passing a negative check vacuously", () => {
    const r = run({ artifact_text: { artifact: "outputs/nope.md", not_contains: ["secret"] } }, ctx(root()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/file not found/);
  });

  // THE false-green this key must not ship: a manifest entry recorded as a link materializes as a real
  // 0-byte placeholder on a channel separate from `truncated`. artifact_json survives it only because
  // JSON.parse("") throws; a text matcher would read the placeholder and report "not contains" ✓.
  it("fails evidence-unavailable on a path recorded as a symlink at record time", () => {
    const r = run(
      { artifact_text: { artifact: "outputs/report.md", not_contains: ["criteria.md"] } },
      ctx(root(), { linkPaths: new Set(["outputs/report.md"]) }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/symlink\/hardlink at record time/);
  });

  it("fails evidence-unavailable on a body-less (over-cap) target, naming the remedy", () => {
    const r = run(
      { artifact_text: { artifact: "outputs/report.md", contains: ["clean"] } },
      ctx(root(), { truncatedPaths: new Map([["outputs/report.md", "size"]]) }),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/--max-artifact-bytes/);
  });

  // A binary body decoded as UTF-8 is replacement characters. A negative match over that "passes"
  // against bytes it never read; a positive one is merely false, which is harmless.
  it("fails the NEGATIVE matchers on a non-UTF-8 body, but still evaluates the positive ones", () => {
    const bin = work();
    writeFileSync(join(bin, "outputs.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const neg = run({ artifact_text: { artifact: "outputs.bin", not_contains: ["secret"] } }, ctx(bin));
    expect(neg.pass).toBe(false);
    expect(neg.message).toMatch(/not lossless UTF-8/);
    expect(run({ artifact_text: { artifact: "outputs.bin", contains: ["secret"] } }, ctx(bin)).pass).toBe(false);
  });

  it("is refused on `lane: remote`, though the body on disk would match", () => {
    // `lane: remote` executes locally, so outputs/report.md IS on disk and `contains: ["clean"]` passes on
    // `lane: local`. Without the lane branch this would be a pass over a body the cloud lane never shows anyone.
    expect(run({ artifact_text: { artifact: "outputs/report.md", contains: ["clean"] } }, ctx(root())).pass).toBe(true);
    const r = run({ artifact_text: { artifact: "outputs/report.md", contains: ["clean"] } }, ctx(root(), { lane: "remote" }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/lane: remote/);
    expect(r.message).not.toMatch(/file not found/);
  });

  it("is a manifest key — a named body survives the manifest, unlike exhaustive absence", () => {
    expect(MANIFEST_KEYS).toContain("artifact_text");
  });
});

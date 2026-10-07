import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { Assertion as AssertionSchema } from "../src/types.js";
import { buildManifest, materializeManifest } from "../src/run/cassette.js";
import { collectArtifactPathsWithHealth } from "../src/run/artifacts.js";

// Parity and false-green cases the glob form of `artifact_json` must hold: a link on the PATH to a match (not only
// a link match), a read error, the walk's entry bound, hardlink parity and a trailing-slash glob.

function ctx(workRoot: string, over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    ...over,
  };
}
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-aj-glob2-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const status = (s: string) => JSON.stringify({ status: s });
const GLOB = "outputs/artifacts/runs/*/run_status.json";
const both = (root: string, match: "each" | "any") => {
  const a = [{ artifact_json: { artifact: GLOB, match, path: "status", equals: "ok" } }];
  const replay = materializeManifest(buildManifest(root), ["outputs", ".projects"]);
  try {
    const [live] = evaluate(a, ctx(root));
    const [rep] = evaluate(
      a,
      ctx(replay.workRoot, { userVisiblePrefixes: replay.prefixes, truncatedPaths: replay.truncatedPaths, linkPaths: replay.linkPaths }),
    );
    return { live, rep };
  } finally {
    rmSync(replay.workRoot, { recursive: true, force: true });
  }
};

describe("artifact_json glob — a link on the path to a match", () => {
  it("a symlinked directory in the literal prefix is evidence-unavailable on both lanes (never a live pass)", () => {
    const root = tree({ "outputs/real/runs/r1/run_status.json": status("ok") });
    symlinkSync(join(root, "outputs/real"), join(root, "outputs/artifacts"));
    for (const match of ["each", "any"] as const) {
      const { live, rep } = both(root, match);
      expect(live.pass, match).toBe(false);
      expect(rep.pass, match).toBe(false);
      expect(live.message, match).toContain("evidence unavailable");
      expect(rep.message, match).toContain("evidence unavailable");
      expect(live.message, match).toContain("outputs/artifacts");
    }
  });
  it("a symlinked directory in a wildcard position is evidence-unavailable under each, not skipped", () => {
    const root = tree({ "outputs/artifacts/runs/r1/run_status.json": status("ok"), "outputs/elsewhere/run_status.json": status("failed") });
    symlinkSync(join(root, "outputs/elsewhere"), join(root, "outputs/artifacts/runs/r2"));
    const { live, rep } = both(root, "each");
    expect(live.pass).toBe(false);
    expect(rep.pass).toBe(false);
    expect(live.message).toContain("evidence unavailable");
    expect(live.message).toContain("outputs/artifacts/runs/r2");
    expect(rep.message).toContain("outputs/artifacts/runs/r2");
  });
  it("a link that cannot lead to a match is ignored", () => {
    const root = tree({ "outputs/artifacts/runs/r1/run_status.json": status("ok"), "outputs/elsewhere/x.txt": "x" });
    symlinkSync(join(root, "outputs/elsewhere"), join(root, "outputs/unrelated"));
    const { live, rep } = both(root, "each");
    expect(live.pass).toBe(true);
    expect(rep.pass).toBe(true);
  });
  it("hardlink matches: same verdicts on both lanes", () => {
    const root = tree({ "outputs/artifacts/runs/r1/run_status.json": status("ok"), "outputs/src.json": status("ok") });
    mkdirSync(join(root, "outputs/artifacts/runs/r2"), { recursive: true });
    linkSync(join(root, "outputs/src.json"), join(root, "outputs/artifacts/runs/r2/run_status.json"));
    for (const match of ["each", "any"] as const) {
      const { live, rep } = both(root, match);
      expect(rep.pass, match).toBe(live.pass);
      expect(live.pass, match).toBe(match === "any");
    }
  });
});

describe("artifact_json glob — read errors and walk bounds", () => {
  it.skipIf(process.getuid?.() === 0)(
    "an unreadable match is evidence-unavailable, as its 'unreadable' cassette entry is on replay",
    () => {
      const root = tree({
        "outputs/artifacts/runs/r1/run_status.json": status("failed"),
        "outputs/artifacts/runs/r2/run_status.json": status("ok"),
      });
      chmodSync(join(root, "outputs/artifacts/runs/r2/run_status.json"), 0o000);
      try {
        const [live] = evaluate([{ artifact_json: { artifact: GLOB, match: "any", path: "status", equals: "ok" } }], ctx(root));
        expect(live.pass).toBe(false);
        expect(live.message).toContain("evidence unavailable");
      } finally {
        chmodSync(join(root, "outputs/artifacts/runs/r2/run_status.json"), 0o644);
      }
    },
  );
  it("the entry bound stops the walk and marks it incomplete", () => {
    const root = tree({ "outputs/a/1.json": "{}", "outputs/a/2.json": "{}", "outputs/a/3.json": "{}", "outputs/a/4.json": "{}" });
    const w = collectArtifactPathsWithHealth(root, ["outputs"], { maxDepth: 32, maxEntries: 3 });
    expect(w.complete).toBe(false);
    expect(w.entries.length).toBe(3);
    const ok = collectArtifactPathsWithHealth(root, ["outputs"], { maxDepth: 32, maxEntries: 4 });
    expect(ok.complete).toBe(true);
  });
});

describe("artifact_json glob — load", () => {
  it("a glob ending in `/` is a load error (a directory glob would silently match files)", () => {
    const r = AssertionSchema.safeParse({ artifact_json: { artifact: "outputs/*/", match: "each", path: "x" } });
    expect(r.success).toBe(false);
  });
});

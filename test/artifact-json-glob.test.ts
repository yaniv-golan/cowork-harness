import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { Assertion as AssertionSchema } from "../src/types.js";
import { buildManifest, materializeManifest, artifactJsonTargetsTruncated } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

// `artifact_json` with a glob in `artifact` and an explicit `match: each | any`. One walk serves both lanes: it is
// rooted at the user-visible roots (+ uploads), which is exactly what replay materializes, so a match can never
// exist on one lane and vanish on the other.

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
  const root = mkdtempSync(join(tmpdir(), "cwh-aj-glob-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const status = (s: string) => JSON.stringify({ status: s });
const GLOB = "outputs/artifacts/runs/*/run_status.json";

describe("artifact_json glob — load rules", () => {
  it("a glob without `match` is a load error (explicit beats a default)", () => {
    const r = AssertionSchema.safeParse({ artifact_json: { artifact: GLOB, path: "status", equals: "ok" } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("match");
  });
  it("`match` on a literal path is a load error (it would do nothing)", () => {
    const r = AssertionSchema.safeParse({ artifact_json: { artifact: "outputs/a.json", match: "each", path: "x", equals: 1 } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("match");
  });
  it("`match` takes only each | any", () => {
    expect(AssertionSchema.safeParse({ artifact_json: { artifact: GLOB, match: "all", path: "status" } }).success).toBe(false);
    expect(AssertionSchema.safeParse({ artifact_json: { artifact: GLOB, match: "each", path: "status" } }).success).toBe(true);
    expect(AssertionSchema.safeParse({ artifact_json: { artifact: GLOB, match: "any", path: "status" } }).success).toBe(true);
  });
  it("`[` is literal, as in every other harness glob: no `*`/`?` means a literal path", () => {
    expect(AssertionSchema.safeParse({ artifact_json: { artifact: "outputs/[a].json", path: "x" } }).success).toBe(true);
  });
});

describe("artifact_json glob — each / any", () => {
  it("each: passes when every match satisfies the predicate", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("ok"),
      "outputs/artifacts/runs/r2/run_status.json": status("ok"),
    });
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(true);
  });
  it("each: one failing match fails, and the message names the passing and the failing file", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("ok"),
      "outputs/artifacts/runs/r2/run_status.json": status("failed"),
    });
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("outputs/artifacts/runs/r2/run_status.json");
    expect(r.message).toContain("outputs/artifacts/runs/r1/run_status.json");
    expect(r.message).not.toContain("evidence unavailable");
  });
  it("any: one satisfying match passes", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("failed"),
      "outputs/artifacts/runs/r2/run_status.json": status("ok"),
    });
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "any", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(true);
  });
  it("any: no satisfying match fails and lists the files", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("failed"),
      "outputs/artifacts/runs/r2/run_status.json": status("failed"),
    });
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "any", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("outputs/artifacts/runs/r1/run_status.json");
    expect(r.message).toContain("outputs/artifacts/runs/r2/run_status.json");
  });
  it("matching is case-sensitive over native names (no folding)", () => {
    const root = tree({ "outputs/artifacts/runs/r1/Run_Status.json": status("ok") });
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "any", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(false);
  });
  it("authored: true applies to each match", () => {
    const root = tree({ "outputs/artifacts/runs/r1/run_status.json": status("ok") });
    const pre = { "outputs/artifacts/runs/r1/run_status.json": "x" };
    // A pre-run hash that differs from the current file ⇒ "rewritten" ⇒ authored.
    const [ok] = evaluate(
      [{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok", authored: true } }],
      ctx(root, { preRunHashes: pre, preRunPaths: Object.keys(pre), preRunOrigin: "local" } as Partial<AssertContext>),
    );
    expect(ok.message ?? "").not.toMatch(/untouched pre-run file/);
  });
});

describe("artifact_json glob — zero, over-cap, and unavailable matches", () => {
  it("zero matches fails, naming the glob and what the nearest directory holds", () => {
    const root = tree({ "outputs/artifacts/runs/r1/status.json": status("ok") });
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(false);
    expect(r.message).toContain(GLOB);
    expect(r.message).toContain("no file matches");
    expect(r.message).toContain("r1");
  });
  it("a file outside the user-visible roots never matches — on any lane", () => {
    const root = tree({ "work/artifacts/runs/r1/run_status.json": status("ok") });
    const [r] = evaluate(
      [{ artifact_json: { artifact: "work/artifacts/runs/*/run_status.json", match: "each", path: "status", equals: "ok" } }],
      ctx(root),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toContain("no file matches");
  });
  it("more than 200 matches is evidence-unavailable, not a partial verdict", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) files[`outputs/artifacts/runs/r${i}/run_status.json`] = status("ok");
    const root = tree(files);
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("evidence unavailable");
    expect(r.message).toContain("200");
  });
  it("exactly 200 matches is evaluated", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) files[`outputs/artifacts/runs/r${i}/run_status.json`] = status("ok");
    const root = tree(files);
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(true);
  });
  it("a symlink match is evidence-unavailable under each, even when its target is a valid in-root file", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("ok"),
      "outputs/real.json": status("ok"),
    });
    mkdirSync(join(root, "outputs/artifacts/runs/r2"), { recursive: true });
    symlinkSync(join(root, "outputs/real.json"), join(root, "outputs/artifacts/runs/r2/run_status.json"));
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("evidence unavailable");
    expect(r.message).toContain("outputs/artifacts/runs/r2/run_status.json");
  });
  it("any: a passing regular match carries the verdict past an unavailable one", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("ok"),
      "outputs/real.json": status("ok"),
    });
    mkdirSync(join(root, "outputs/artifacts/runs/r2"), { recursive: true });
    symlinkSync(join(root, "outputs/real.json"), join(root, "outputs/artifacts/runs/r2/run_status.json"));
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "any", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(true);
  });
  it("any: no pass and an unavailable match is evidence-unavailable, not a plain fail", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("failed"),
      "outputs/real.json": status("ok"),
    });
    mkdirSync(join(root, "outputs/artifacts/runs/r2"), { recursive: true });
    symlinkSync(join(root, "outputs/real.json"), join(root, "outputs/artifacts/runs/r2/run_status.json"));
    const [r] = evaluate([{ artifact_json: { artifact: GLOB, match: "any", path: "status", equals: "ok" } }], ctx(root));
    expect(r.pass).toBe(false);
    expect(r.message).toContain("evidence unavailable");
  });
  it("a walk deeper than the depth bound is evidence-unavailable (the walk could not see everything)", () => {
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join("/");
    const root = tree({ "outputs/x/run_status.json": status("ok"), [`outputs/${deep}/run_status.json`]: status("ok") });
    const [r] = evaluate(
      [{ artifact_json: { artifact: "outputs/**/run_status.json", match: "each", path: "status", equals: "ok" } }],
      ctx(root),
    );
    expect(r.pass).toBe(false);
    expect(r.message).toContain("evidence unavailable");
  });
  it("an unsafe glob (`..` or absolute) fails as unsafe", () => {
    const root = tree({});
    for (const artifact of ["../outputs/*.json", "/outputs/*.json", "outputs/../../*.json"]) {
      const [r] = evaluate([{ artifact_json: { artifact, match: "each", path: "x" } }], ctx(root));
      expect(r.pass, artifact).toBe(false);
      expect(r.message, artifact).toContain("unsafe");
    }
  });
});

// The replay-parity exit criterion: a real tree holding a regular match, a symlink match and a match over the
// live body cap (10 MiB), recorded with the REAL buildManifest and replayed with the REAL materializeManifest.
// Both lanes must agree on the verdict and on which files are evidence-unavailable.
describe("artifact_json glob — replay parity on a cassette with a link entry and an over-cap entry", () => {
  const BIG = 10 * 1024 * 1024 + 1;
  function recorded() {
    const root = tree({ "outputs/artifacts/runs/r1/run_status.json": status("ok"), "outputs/real.json": status("ok") });
    mkdirSync(join(root, "outputs/artifacts/runs/r2"), { recursive: true });
    symlinkSync(join(root, "outputs/real.json"), join(root, "outputs/artifacts/runs/r2/run_status.json"));
    mkdirSync(join(root, "outputs/artifacts/runs/r3"), { recursive: true });
    writeFileSync(join(root, "outputs/artifacts/runs/r3/run_status.json"), Buffer.alloc(BIG, 0x20));
    const manifest = buildManifest(root);
    const replay = materializeManifest(manifest, ["outputs", ".projects"]);
    return { root, manifest, replay };
  }
  const unavailableFiles = (m: string | undefined) =>
    ["r1", "r2", "r3"].filter((r) => new RegExp(`unavailable[^\\n]*runs/${r}/run_status\\.json`).test(m ?? ""));

  for (const match of ["each", "any"] as const) {
    it(`${match}: same verdict and same unavailable files on live and replay`, () => {
      const { root, manifest, replay } = recorded();
      try {
        // the walker really emitted the link entry, and the big file really went hash-only
        expect(manifest.find((e) => e.path === "outputs/artifacts/runs/r2/run_status.json")?.linkKind).toBe("symlink");
        expect(manifest.find((e) => e.path === "outputs/artifacts/runs/r3/run_status.json")?.truncationReason).toBe("size");
        const a = [{ artifact_json: { artifact: GLOB, match, path: "status", equals: "ok" } }];
        const [live] = evaluate(a, ctx(root));
        const [rep] = evaluate(
          a,
          ctx(replay.workRoot, {
            userVisiblePrefixes: replay.prefixes,
            truncatedPaths: replay.truncatedPaths,
            linkPaths: replay.linkPaths,
          }),
        );
        expect(rep.pass).toBe(live.pass);
        expect(live.pass).toBe(match === "any");
        expect(unavailableFiles(rep.message)).toEqual(unavailableFiles(live.message));
        if (match === "each") expect(unavailableFiles(live.message)).toEqual(["r2", "r3"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(replay.workRoot, { recursive: true, force: true });
      }
    });
  }
});

describe("artifact_json glob — the record-time guard sees glob matches", () => {
  it("a glob match stored hash-only by size is refused at record (it would pass live and fail replay)", () => {
    const root = tree({
      "outputs/artifacts/runs/r1/run_status.json": status("ok"),
      "outputs/artifacts/runs/r2/run_status.json": JSON.stringify({ status: "ok", pad: "x".repeat(200) }),
    });
    const manifest = buildManifest(root, 64);
    const scenario = {
      assert: [{ artifact_json: { artifact: GLOB, match: "each", path: "status", equals: "ok" } }],
    } as unknown as Scenario;
    expect(artifactJsonTargetsTruncated(scenario, root, manifest)).toEqual(["outputs/artifacts/runs/r2/run_status.json"]);
  });
});

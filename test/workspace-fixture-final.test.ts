// workspace_fixture: the last spellings and turn shapes that could let a run that did nothing pass on fixture
// content — Unicode normalization, a --resume turn, renamed / copied / hard-linked fixture files — plus the
// refusal keyed on the run's recorded evidence and lint's machine-independence. Every case runs the REAL chain
// (stage → capturePreRunManifest → readPreRunManifest*), never hand-built pre-run hashes. Synthetic data only.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedFixtureRefusal, scanWorkspaceFixture, workspaceFixtureAssertRefusal } from "../src/fixture/workspace.js";
import { stageWorkspace } from "../src/runtime/stage.js";
import { capturePreRunManifest, readPreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { captureAuthoredFilesWithHealth } from "../src/run/artifacts.js";
import { evaluate, type AssertContext } from "../src/assert.js";
import { loaderFindings } from "../src/run/lint-load.js";
import type { LaunchPlan } from "../src/session.js";
import type { Assertion, Scenario } from "../src/types.js";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubEnv("COWORK_HARNESS_GITSET", "0");
});
afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

const NFD = "café.md";
const NFC = "café.md";

function makeFixture(extra: Record<string, string> = {}): string {
  const dir = join(tmp("wsff-"), "fx");
  mkdirSync(join(dir, "scores"), { recursive: true });
  writeFileSync(join(dir, "report.md"), "# Step 1 report\n");
  writeFileSync(join(dir, "scores", "deck.json"), '{"score":7}\n');
  for (const [k, v] of Object.entries(extra)) writeFileSync(join(dir, k), v);
  return dir;
}
function planFor(fixtureDir: string, over: Partial<LaunchPlan> = {}): LaunchPlan {
  const root = tmp("wsff-plan-");
  const configDir = join(root, "config");
  mkdirSync(join(configDir, "skills"), { recursive: true });
  mkdirSync(join(configDir, "projects"), { recursive: true });
  writeFileSync(join(configDir, "settings.json"), "{}");
  return {
    configDir,
    mcpConfig: null,
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    baseEnv: {},
    permissionMode: "default",
    permissionParity: "cowork",
    resume: false,
    capturePreRun: true,
    workspaceFixture: scanWorkspaceFixture(fixtureDir),
    ...over,
  } as unknown as LaunchPlan;
}
function actx(over: Partial<AssertContext>): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    mountDeletes: [],
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
/** The real chain; the step does nothing unless `act` changes outputs/. */
function run(extra: Record<string, string> = {}, act?: (outputs: string) => void) {
  const base = tmp("wsff-live-");
  const mnt = join(base, "mnt");
  const outDir = join(base, "out");
  mkdirSync(outDir);
  const plan = planFor(makeFixture(extra));
  stageWorkspace(plan, mnt, { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" });
  capturePreRunManifest(plan, mnt, outDir, "container");
  act?.(join(mnt, "outputs"));
  return {
    mnt,
    outDir,
    plan,
    files: plan.workspaceFixture!.files,
    ctx: (over: Partial<AssertContext> = {}) =>
      actx({ workRoot: mnt, preRunHashes: readPreRunManifestHashes(outDir), preRunPaths: readPreRunManifest(outDir), ...over }),
  };
}
const sc = (assert: Assertion[]) => ({ name: "s", assert }) as Pick<Scenario, "name" | "assert">;

/** Does the temp filesystem treat NFC and NFD spellings as one name (macOS APFS)? */
function normalizationInsensitiveFs(): boolean {
  const d = tmp("wsff-norm-");
  writeFileSync(join(d, NFD), "");
  return existsSync(join(d, NFC));
}

describe("Unicode normalization: an NFC/NFD spelling of a fixture file name", () => {
  it.each([
    ["NFD on disk, NFC asserted", NFD, NFC],
    ["NFC on disk, NFD asserted", NFC, NFD],
  ])("%s: the load refusal catches it (on every platform)", (_n, onDisk, asserted) => {
    const r = run({ [onDisk]: "bonjour\n" });
    expect(workspaceFixtureAssertRefusal(sc([{ file_exists: `outputs/${asserted}` }]), r.files)).toMatch(/already provides/);
  });

  it.each([
    ["NFD on disk, NFC asserted", NFD, NFC],
    ["NFC on disk, NFD asserted", NFC, NFD],
  ])("%s: `authored: true` fails as an untouched pre-run file, not as a 'symlinked directory'", (_n, onDisk, asserted) => {
    const r = run({ [onDisk]: "bonjour\n" });
    const [fe, at] = evaluate(
      [
        { file_exists: { path: `outputs/${asserted}`, authored: true } },
        { artifact_text: { artifact: `outputs/${asserted}`, contains: ["bonjour"], authored: true } },
      ],
      r.ctx(),
    );
    expect(fe!.pass).toBe(false);
    expect(at!.pass).toBe(false);
    if (normalizationInsensitiveFs()) {
      expect(fe!.message).toMatch(/untouched pre-run file/);
      expect(fe!.message).not.toMatch(/symlinked directory/);
    }
  });
});

describe("a --resume turn: authorship is decided per invocation", () => {
  it("turn 2 does nothing — both `authored: true` asserts FAIL evidence-unavailable, though turn 1 wrote/rewrote the files", () => {
    const fixture = makeFixture();
    const base = tmp("wsff-res-");
    const mnt = join(base, "mnt");
    const outDir = join(base, "out");
    mkdirSync(outDir);
    const plan = planFor(fixture);
    stageWorkspace(plan, mnt, { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" });
    capturePreRunManifest(plan, mnt, outDir, "container");
    writeFileSync(join(mnt, "outputs", "memo.md"), "turn 1 memo\n");
    writeFileSync(join(mnt, "outputs", "report.md"), "turn 1 rewrote\n");
    // turn 2 resumes the session and does nothing; it captures no manifest of its own
    const plan2 = { ...plan, resume: true } as LaunchPlan;
    stageWorkspace(plan2, mnt, { sessionRoot: "/sessions/t", vmSessionRoot: "/sessions/t" });
    capturePreRunManifest(plan2, mnt, outDir, "container");
    const preRunHashes = readPreRunManifestHashes(outDir);
    expect(preRunHashes).toBeDefined(); // turn 1's manifest is what a resume turn reads — not "no manifest"
    const res = evaluate(
      [{ file_exists: { path: "outputs/memo.md", authored: true } }, { file_exists: { path: "outputs/report.md", authored: true } }],
      actx({ workRoot: mnt, preRunHashes, preRunPaths: readPreRunManifest(outDir), resume: true }),
    );
    for (const r of res) {
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/evidence unavailable: .*--resume turn/);
    }
  });
});

describe("rename, copy and hard link of an untouched fixture file", () => {
  const cases: Array<[string, (o: string) => void]> = [
    ["rename", (o) => renameSync(join(o, "report.md"), join(o, "final.md"))],
    ["copy", (o) => writeFileSync(join(o, "final.md"), readFileSync(join(o, "report.md")))],
  ];
  it.each(cases)(
    "%s to a new name is new content at a new path: authored, exactly as the judge's authored capture counts it",
    (_n, act) => {
      const r = run({}, act);
      const [v] = evaluate([{ file_exists: { path: "outputs/final.md", authored: true } }], r.ctx());
      const captured = captureAuthoredFilesWithHealth(r.mnt, ["outputs"], [], readPreRunManifestHashes(r.outDir)).files.map((f) => f.path);
      expect(v!.pass).toBe(true);
      expect(captured).toContain("outputs/final.md");
    },
  );

  it("a hard link is evidence-unavailable for `authored`, matching the capture, which excludes it", () => {
    const r = run({}, (o) => linkSync(join(o, "report.md"), join(o, "final.md")));
    const [v] = evaluate([{ file_exists: { path: "outputs/final.md", authored: true } }], r.ctx());
    const captured = captureAuthoredFilesWithHealth(r.mnt, ["outputs"], [], readPreRunManifestHashes(r.outDir)).files.map((f) => f.path);
    expect(v!.pass).toBe(false);
    expect(v!.message).toMatch(/evidence unavailable: .*hard link/);
    expect(captured).not.toContain("outputs/final.md");
  });
});

describe("the recorded-list refusal keys on the run's evidence, not the YAML's declaration", () => {
  it("refuses when the run recorded a fixture list even if the scenario omits workspace_fixture", () => {
    expect(recordedFixtureRefusal({ name: "s", assert: [{ file_exists: "outputs/report.md" }] }, [["report.md", "h"]])).toMatch(
      /already provides/,
    );
    expect(recordedFixtureRefusal({ name: "s", assert: [{ file_exists: "outputs/report.md" }] }, undefined)).toBeUndefined();
    expect(recordedFixtureRefusal({ name: "s", assert: [{ file_exists: "outputs/report.md" }] }, [])).toBeUndefined();
  });
});

describe("lint's fixture checks do not depend on the machine", () => {
  function onDisk(ref: string, withDir: boolean): string {
    const root = tmp("wsff-lint-");
    if (withDir) {
      mkdirSync(join(root, "fx"));
      writeFileSync(join(root, "fx", "a.md"), "a");
    }
    const p = join(root, "s.yaml");
    writeFileSync(p, `fidelity: container\nprompt: p\nworkspace_fixture: ${ref}\nassert:\n  - result: success\n`);
    return p;
  }
  const rules = (f: string) => loaderFindings([f], { loadBaseline: () => ({}) }).map((x) => [x.severity, x.rule]);

  it("a missing ABSOLUTE or `~` fixture is a WARNING (it cannot be checked here), never an ERROR", () => {
    for (const ref of [join(tmp("wsff-abs-"), "nope"), "~/definitely-not-a-fixture-dir-xyz"]) {
      const r = rules(onDisk(ref, false));
      expect(r.some(([s, id]) => s === "ERROR" && id === "workspace-fixture-invalid")).toBe(false);
      expect(r).toContainEqual(["WARN", "workspace-fixture-not-relative"]);
    }
  });
  it("a missing scenario-RELATIVE fixture is an ERROR; an existing absolute one warns that it should be relative", () => {
    expect(rules(onDisk("fx", false))).toContainEqual(["ERROR", "workspace-fixture-invalid"]);
    const root = tmp("wsff-absok-");
    mkdirSync(join(root, "fx"));
    writeFileSync(join(root, "fx", "a.md"), "a");
    expect(rules(onDisk(join(root, "fx"), false))).toEqual([["WARN", "workspace-fixture-not-relative"]]);
    expect(rules(onDisk("fx", true))).toEqual([]);
  });
});

describe("the resume flag reaches the assertion context on every lane that evaluates `authored`", () => {
  it("verify-run never evaluates a --resume turn: it refuses a multi-turn run dir (so it needs no resume flag)", async () => {
    const { assertContextFromRunDir } = await import("../src/run/verify-context.js");
    const root = join(tmp("wsff-vr-"), "run");
    const workDir = join(root, "work", "session", "mnt");
    mkdirSync(join(workDir, "outputs"), { recursive: true });
    for (const t of [1, 2]) {
      const d = join(root, "turns", String(t));
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "result.json"),
        JSON.stringify({
          scenario: "s",
          fidelity: "container",
          result: "success",
          turn: t,
          outDir: root,
          workDir,
          assertions: [],
          egress: [],
        }),
      );
      writeFileSync(join(d, "run.jsonl"), JSON.stringify({ t: "run", scenario: "s" }));
      writeFileSync(join(d, "trace.json"), JSON.stringify({ questions: [], steps: [] }));
    }
    const loaded = assertContextFromRunDir(root, { name: "s", assert: [] } as unknown as Scenario);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && "message" in loaded ? loaded.message : "").toMatch(/holds 2 turns/);
  });
});

describe("case folds toLowerCase alone does not model (ß/SS, final sigma, the ﬁ ligature)", () => {
  const rows: Array<[string, string]> = [
    ["stra\u00dfe.md", "STRASSE.md"],
    ["\u03bf\u03b4\u03bf\u03c2.md", "\u03bf\u03b4\u03bf\u03c3.md"],
    ["\ufb01le.md", "file.md"],
    ["stra\u00dfe.md", "STRA\u1e9eE.md"],
  ];
  it.each(rows)("fixture %s, asserted %s: the load refusal catches it (on every platform)", (disk, asserted) => {
    const r = run({ [disk]: "x\n" });
    expect(workspaceFixtureAssertRefusal(sc([{ file_exists: `outputs/${asserted}` }]), r.files)).toMatch(/already provides/);
  });
  it.each(rows)(
    "fixture %s, asserted %s: `authored: true` fails as untouched where the filesystem folds them (never 'symlinked directory')",
    (disk, asserted) => {
      const r = run({ [disk]: "x\n" });
      const [v] = evaluate([{ file_exists: { path: `outputs/${asserted}`, authored: true } }], r.ctx());
      expect(v!.pass).toBe(false);
      if (existsSync(join(r.mnt, "outputs", asserted))) {
        expect(v!.message).toMatch(/untouched pre-run file/);
        expect(v!.message).not.toMatch(/symlinked directory/);
      }
    },
  );
});

// workspace_fixture hardening: every way a run that did NOTHING could still pass `authored: true` or a presence
// assertion on fixture-only content, and every entry point that must refuse such an assertion before it is
// evaluated. Synthetic data only, built in temp dirs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const spawnMock = vi.fn(() => ({ stdin: null, stdout: null, stderr: null }));
vi.mock("node:child_process", async (orig) => {
  const real = (await orig()) as typeof import("node:child_process");
  return { ...real, spawn: (...a: unknown[]) => (spawnMock as unknown as (...x: unknown[]) => unknown)(...a) };
});

import { scanWorkspaceFixture, workspaceFixtureAssertRefusal, recordedFixtureRefusal } from "../src/fixture/workspace.js";
import { stageWorkspace } from "../src/runtime/stage.js";
import { spawnProtocol } from "../src/runtime/protocol.js";
import { evaluate, type AssertContext } from "../src/assert.js";
import { readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { captureAuthoredFilesWithHealth } from "../src/run/artifacts.js";
import { authoredCaptureOpts } from "../src/run/authored-capture-opts.js";
import { loadScenarioPure, scenarioArmsPreRunManifest } from "../src/run/execute.js";
import { loaderFindings } from "../src/run/lint-load.js";
import { loadSession, resolveLaunchSources } from "../src/session.js";
import { loadBaseline } from "../src/baseline.js";
import { UsageError } from "../src/errors.js";
import { redactCassette, replayCassette, preSpendVerdicts, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";
import type { LaunchPlan } from "../src/session.js";
import type { Assertion, PlatformBaseline, Scenario } from "../src/types.js";
import type { RedactionPolicy } from "../src/redact.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const LIVE = loadBaseline("latest").appVersion;

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  spawnMock.mockClear();
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubEnv("COWORK_HARNESS_GITSET", "0");
});
afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

function makeFixture(): string {
  const dir = join(tmp("wsfh-"), "after-step-1");
  mkdirSync(join(dir, "scores"), { recursive: true });
  writeFileSync(join(dir, "report.md"), "# Step 1 report\n");
  writeFileSync(join(dir, "scores", "deck.json"), '{"score":7}\n');
  return dir;
}

function planFor(fixtureDir: string, over: Partial<LaunchPlan> = {}): LaunchPlan {
  const root = tmp("wsfh-plan-");
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
    workspaceFixture: scanWorkspaceFixture(fixtureDir),
    ...over,
  } as LaunchPlan;
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

/** A live run where the step did NOTHING: the outputs tree is exactly the fixture. */
function idleRun() {
  const dir = makeFixture();
  const mnt = join(tmp("wsfh-live-"), "mnt");
  const plan = planFor(dir);
  stageWorkspace(plan, mnt);
  const preRunHashes: Record<string, string | null> = {};
  for (const f of plan.workspaceFixture!.files) preRunHashes[`outputs/${f.path}`] = f.sha256;
  return { mnt, preRunHashes, preRunPaths: Object.keys(preRunHashes), files: plan.workspaceFixture!.files };
}
const sc = (assert: Assertion[]) => ({ name: "s", assert }) as Pick<Scenario, "name" | "assert">;

/** Does this platform's temp filesystem fold case (macOS APFS by default)? */
function caseInsensitiveFs(): boolean {
  const d = tmp("wsfh-case-");
  writeFileSync(join(d, "a"), "");
  return existsSync(join(d, "A"));
}

describe("a fixture DIRECTORY never passes on fixture-only content", () => {
  it("the load refusal catches a path that is a parent directory of a fixture file (and outputs/ itself)", () => {
    const { files } = idleRun();
    for (const p of ["outputs/scores", "outputs/scores/", "./outputs/scores", "outputs"])
      expect(workspaceFixtureAssertRefusal(sc([{ file_exists: p }]), files), p).toMatch(/pass on the fixture alone/);
    expect(workspaceFixtureAssertRefusal(sc([{ user_visible_artifact: "outputs/charts" }]), files)).toBeUndefined();
  });

  it("`authored: true` on a directory fails — it applies to a regular file (live)", () => {
    const { mnt, preRunHashes, preRunPaths } = idleRun();
    const [fe, uva] = evaluate(
      [{ file_exists: { path: "outputs/scores", authored: true } }, { user_visible_artifact: { path: "outputs/scores", authored: true } }],
      actx({ workRoot: mnt, preRunHashes, preRunPaths }),
    );
    expect(fe!.pass).toBe(false);
    expect(fe!.message).toMatch(/applies to a file.*is a directory/);
    expect(uva!.pass).toBe(false);
  });

  it("…and on replay, where the materialized tree has the directory but the manifest has no entry for it", async () => {
    const deck = '{"score":7}\n';
    const c = {
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "p",
        answers: [],
        expect_denied: [],
        assert: [{ file_exists: { path: "outputs/scores", authored: true } }],
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init", tools: [] }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      fingerprint: { baseline: LIVE },
      artifacts: [{ path: "outputs/scores/deck.json", bytes: deck.length, sha256: sha(deck), body: deck }],
      userVisibleRoots: ["outputs"],
      preRunPaths: ["outputs/scores/deck.json"],
      preRunHashes: { "outputs/scores/deck.json": sha(deck) },
    } as unknown as Cassette;
    const [r] = (await replayCassette(c, [])).assertions.filter((a) => a.source !== "staleness");
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/is a directory/);
  });
});

describe("a different-case path never passes on fixture-only content", () => {
  it("the load refusal compares case-folded, on every platform", () => {
    const { files } = idleRun();
    expect(workspaceFixtureAssertRefusal(sc([{ file_exists: "outputs/REPORT.md" }]), files)).toMatch(/pass on the fixture alone/);
    expect(workspaceFixtureAssertRefusal(sc([{ file_exists: "outputs/Scores" }]), files)).toMatch(/pass on the fixture alone/);
  });

  it("`authored: true` on a different-case name of an untouched fixture file FAILS (macOS: same file; Linux: not found)", () => {
    const { mnt, preRunHashes, preRunPaths } = idleRun();
    const [r] = evaluate(
      [{ file_exists: { path: "outputs/REPORT.md", authored: true } }],
      actx({ workRoot: mnt, preRunHashes, preRunPaths }),
    );
    expect(r!.pass).toBe(false);
    if (caseInsensitiveFs()) expect(r!.message).toMatch(/untouched pre-run file/);
  });
});

describe("a symlink at a fixture path is never authored evidence", () => {
  it("replacing an untouched fixture file with a link to other content does not pass `authored: true`", () => {
    const { mnt, preRunHashes, preRunPaths } = idleRun();
    rmSync(join(mnt, "outputs", "report.md"));
    symlinkSync("scores/deck.json", join(mnt, "outputs", "report.md"));
    const [r] = evaluate(
      [{ file_exists: { path: "outputs/report.md", authored: true } }],
      actx({ workRoot: mnt, preRunHashes, preRunPaths }),
    );
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/symlink/);
  });

  it("a path reached through a symlinked directory is not authored evidence either", () => {
    const { mnt, preRunHashes, preRunPaths } = idleRun();
    mkdirSync(join(mnt, "elsewhere"));
    writeFileSync(join(mnt, "elsewhere", "new.md"), "x");
    symlinkSync(join(mnt, "elsewhere"), join(mnt, "outputs", "linked"));
    const [r] = evaluate(
      [{ file_exists: { path: "outputs/linked/new.md", authored: true } }],
      actx({ workRoot: mnt, preRunHashes, preRunPaths }),
    );
    expect(r!.pass).toBe(false);
  });
});

describe("redaction of an untouched fixture body keeps it decidable on replay", () => {
  const policy: RedactionPolicy = { patterns: [{ re: /Acme/g, label: "customer" }], keyNames: [] };
  const untouched = "Acme Corp — step 1 scores\n";
  const cas = (assert: unknown[]) =>
    ({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "p",
        answers: [],
        expect_denied: [],
        assert,
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init", tools: [] }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      controlOut: [],
      cassetteVersion: CASSETTE_VERSION,
      fingerprint: { baseline: LIVE },
      artifacts: [{ path: "outputs/report.md", bytes: untouched.length, sha256: sha(untouched), body: untouched }],
      userVisibleRoots: ["outputs"],
      preRunPaths: ["outputs/report.md"],
      preRunHashes: { "outputs/report.md": sha(untouched) },
    }) as unknown as Cassette;

  it("the pre-run hash is remapped to the redacted body's sha: input_unmodified passes, `authored: true` fails as untouched", async () => {
    const red = redactCassette(
      cas([{ input_unmodified: "outputs/report.md" }, { file_exists: { path: "outputs/report.md", authored: true } }]),
      policy,
    );
    expect(red.preRunHashes!["outputs/report.md"]).toBe(red.artifacts![0]!.sha256);
    const [unmodified, authored] = (await replayCassette(red, [])).assertions.filter((a) => a.source !== "staleness");
    expect(unmodified!.pass).toBe(true);
    expect(authored!.pass).toBe(false);
    expect(authored!.message).toMatch(/untouched pre-run file/);
  });
});

describe("refusal from a RECORDED fixture file list (verify-run, --resume, --assert-from)", () => {
  const fx = (assert: Assertion[]) =>
    ({ name: "s", workspace_fixture: "/fx", assert }) as Pick<Scenario, "name" | "assert" | "workspace_fixture">;

  it("refuses against the recorded list, accepts `authored:`", () => {
    const sigs: Array<[string, string]> = [["report.md", "h"]];
    expect(recordedFixtureRefusal(fx([{ file_exists: "outputs/report.md" }]), sigs)).toMatch(/pass on the fixture alone/);
    expect(recordedFixtureRefusal(fx([{ file_exists: { path: "outputs/report.md", authored: false } }]), sigs)).toBeUndefined();
    expect(recordedFixtureRefusal({ name: "s", assert: [{ file_exists: "outputs/report.md" }] }, sigs)).toBeUndefined(); // no fixture
  });

  it("a redacted fixture path, or no recorded list, refuses an unannotated outputs/ presence assert as unverifiable", () => {
    const redacted: Array<[string, string]> = [["[REDACTED:customer:ab12]-report.md", "h"]];
    expect(recordedFixtureRefusal(fx([{ file_exists: "outputs/Acme-report.md" }]), redacted)).toMatch(/cannot be checked/);
    expect(recordedFixtureRefusal(fx([{ file_exists: "outputs/x.md" }]), undefined)).toMatch(/cannot be checked/);
    expect(recordedFixtureRefusal(fx([{ file_exists: { path: "outputs/x.md", authored: true } }]), undefined)).toBeUndefined();
    expect(recordedFixtureRefusal(fx([{ transcript_contains: "x" }]), undefined)).toBeUndefined();
  });
});

describe("lint runs the fixture checks", () => {
  function onDisk(assert: string, fixture = true): string {
    const root = tmp("wsfh-lint-");
    if (fixture) {
      mkdirSync(join(root, "fx"));
      writeFileSync(join(root, "fx", "report.md"), "r");
    }
    const p = join(root, "s.yaml");
    writeFileSync(p, `fidelity: container\nprompt: p\nworkspace_fixture: fx\nassert:\n${assert}`);
    return p;
  }
  it("reports a vacuous presence assertion on a fixture file as an ERROR", () => {
    const f = loaderFindings([onDisk("  - file_exists: outputs/report.md\n")], { loadBaseline: () => ({}) });
    expect(f.map((x) => [x.severity, x.rule])).toContainEqual(["ERROR", "workspace-fixture-vacuous-assert"]);
  });
  it("reports a fixture the run would refuse (missing dir) as an ERROR, and is silent on a clean one", () => {
    expect(loaderFindings([onDisk("  - result: success\n", false)], { loadBaseline: () => ({}) }).map((x) => x.rule)).toContain(
      "workspace-fixture-invalid",
    );
    expect(loaderFindings([onDisk("  - file_exists: {path: outputs/report.md, authored: true}\n")], { loadBaseline: () => ({}) })).toEqual(
      [],
    );
  });
});

describe("the semantic_matches evidence on the REAL chain: stage → manifest → read → capture", () => {
  it("an untouched fixture file is not authored evidence; a rewritten one and a new one are", () => {
    const dir = makeFixture();
    const outDir = join(tmp("wsfh-chain-"), "run");
    const scenario = { assert: [{ semantic_matches: { rubric: ["r"] } }], workspace_fixture: dir } as unknown as Scenario;
    const plan = planFor(dir, { capturePreRun: scenarioArmsPreRunManifest(scenario) });
    spawnProtocol({ name: "fx" } as unknown as Scenario, {} as unknown as PlatformBaseline, plan, outDir);
    const work = join(outDir, "work");
    writeFileSync(join(work, "outputs", "report.md"), "# Step 2 rewrote it\n");
    writeFileSync(join(work, "outputs", "memo.md"), "new");
    const pre = readPreRunManifestHashes(outDir);
    expect(pre).toBeDefined();
    const { files } = captureAuthoredFilesWithHealth(work, ["outputs"], [], pre, authoredCaptureOpts({ workRoot: work, runDir: outDir }));
    const paths = files.map((f) => f.path);
    expect(paths).toContain("outputs/report.md");
    expect(paths).toContain("outputs/memo.md");
    expect(paths).not.toContain("outputs/scores/deck.json");
  });
});

describe("caps and wording", () => {
  it("a fixture file larger than the pre-run hash cap is refused (its authorship could never be decided)", () => {
    const dir = makeFixture();
    vi.stubEnv("COWORK_HARNESS_PRERUN_HASH_CAP", "8");
    expect(() => scanWorkspaceFixture(dir)).toThrow(/COWORK_HARNESS_PRERUN_HASH_CAP/);
  });
  it("the git-mode refusal says 'tracked', not 'committed'", () => {
    vi.stubEnv("COWORK_HARNESS_GITSET", "1");
    const repo = tmp("wsfh-git-");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "fx"));
    writeFileSync(join(repo, "fx", "a.md"), "a");
    let msg = "";
    try {
      scanWorkspaceFixture(join(repo, "fx"));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/only tracked files/);
    expect(msg).not.toMatch(/committed/);
  });
});

describe("the recorded fixture ref never carries host path components", () => {
  it("record refuses before any spend when the ref climbs above the cassette's repo", () => {
    const root = tmp("wsfh-ref-");
    mkdirSync(join(root, "proj"));
    spawnSync("git", ["init", "-q"], { cwd: join(root, "proj") });
    const cassettePath = join(root, "proj", "cassettes", "s.cassette.json");
    const sc2 = {
      name: "s",
      prompt: "p",
      fidelity: "container",
      answers: [],
      assert: [],
      workspace_fixture: join(tmp("wsfh-far-"), "fx"),
    } as unknown as Scenario;
    const v = preSpendVerdicts(sc2, cassettePath, { explicitOutPath: true });
    expect(v).toContainEqual(expect.objectContaining({ kind: "refuse", message: expect.stringMatching(/workspace_fixture .* outside/) }));
    const near = { ...sc2, workspace_fixture: join(root, "proj", "fixtures", "fx") } as Scenario;
    expect(preSpendVerdicts(near, cassettePath, { explicitOutPath: true }).some((x) => /workspace_fixture/.test(x.message))).toBe(false);
  });
  it("outside a git work tree the bound is the cassette's own directory", () => {
    const root = tmp("wsfh-ref-nogit-");
    const cassettePath = join(root, "s.cassette.json");
    const inside = {
      name: "s",
      prompt: "p",
      fidelity: "container",
      answers: [],
      assert: [],
      workspace_fixture: join(root, "fx"),
    } as unknown as Scenario;
    expect(preSpendVerdicts(inside, cassettePath, { explicitOutPath: true }).some((x) => /workspace_fixture/.test(x.message))).toBe(false);
    const above = { ...inside, workspace_fixture: join(tmp("wsfh-ref-other-"), "fx") } as Scenario;
    expect(preSpendVerdicts(above, cassettePath, { explicitOutPath: true })).toContainEqual(
      expect.objectContaining({ kind: "refuse", message: expect.stringMatching(/outside the cassette's directory/) }),
    );
  });
});

describe("overlap refusal covers every staged source kind", () => {
  it.each(["skills", "plugin", "upload"] as const)("refuses a fixture that holds a %s source", (kind) => {
    const dir = makeFixture();
    const inner = join(dir, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, kind === "upload" ? "up.pdf" : "SKILL.md"), "x");
    const session =
      kind === "skills"
        ? loadSession({ skills: { local: [inner] } })
        : kind === "plugin"
          ? loadSession({ plugins: { local_plugins: [inner] } })
          : loadSession({ uploads: [join(inner, "up.pdf")] });
    expect(() =>
      resolveLaunchSources(session, loadBaseline("latest"), "container", false, {
        stageFilters: false,
        quiet: true,
        workspaceFixture: dir,
      }),
    ).toThrow(/overlaps a staged source/);
  });
});

describe("scenario-relative ref, as written", () => {
  it("the loader keeps the as-written ref beside the resolved path, and it survives a spread", async () => {
    const root = tmp("wsfh-asw-");
    mkdirSync(join(root, "fixtures", "fx"), { recursive: true });
    writeFileSync(join(root, "fixtures", "fx", "a.md"), "a");
    const p = join(root, "s.yaml");
    writeFileSync(p, "fidelity: container\nprompt: p\nworkspace_fixture: fixtures/fx\n");
    const loaded = loadScenarioPure(p);
    const { workspaceFixtureAsWritten } = await import("../src/fixture/workspace.js");
    expect(loaded.workspace_fixture).toBe(join(root, "fixtures", "fx"));
    expect(workspaceFixtureAsWritten({ ...loaded })).toBe("fixtures/fx");
    expect(JSON.stringify(loaded)).not.toContain('"fixtures/fx"'); // never serialized into a cassette
  });
});

void readFileSync;
void resolve;
void UsageError;

describe("no_lost_write_back on a workspace_fixture HTML", () => {
  const LOST_FORM = `<!DOCTYPE html><html><body><form method="post" action="/submit"><button>Save</button></form></body></html>`;
  it("a fixture HTML the step REWROTE is the skill's own artifact: a lost write-back hard-fails (outputs/ holds only this session's work)", () => {
    const root = tmp("wsfh-nlwb-");
    const wr = join(root, "session", "mnt");
    mkdirSync(join(wr, "outputs"), { recursive: true });
    writeFileSync(join(wr, "outputs", "form.html"), LOST_FORM);
    const [r] = evaluate(
      [{ no_lost_write_back: true }],
      actx({
        workRoot: wr,
        // a pre-run hash = the fixture staged it; it is in the authored set = the step rewrote it
        preRunHashes: { "outputs/form.html": "fixture-version" },
        authoredFiles: [{ path: "outputs/form.html", content: "" }],
      }),
    );
    expect(r!.pass).toBe(false);
    expect(r!.message).toContain("outputs/form.html");
  });
});

describe("a --resume turn refuses against the file list turn 1 recorded", () => {
  it("refuses an unannotated presence assert on a fixture file before anything runs, though the fixture dir is gone", async () => {
    const runs = tmp("wsfh-runs-");
    vi.stubEnv("COWORK_HARNESS_RUNS_DIR", runs);
    const { executeScenario, runOutDir } = await import("../src/run/execute.js");
    const scenario = {
      name: "step2",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      lane: "local",
      execution: "local",
      prompt: "p",
      answers: [],
      expect_denied: [],
      skills: [],
      requires_capabilities: [],
      assert: [{ file_exists: "outputs/report.md" }],
      workspace_fixture: join(tmp("wsfh-gone-"), "fx-deleted-since"),
    } as unknown as Scenario;
    const outDir = runOutDir("step2", "sess-x");
    mkdirSync(join(outDir, "turns", "1"), { recursive: true });
    writeFileSync(
      join(outDir, "turns", "1", "result.json"),
      JSON.stringify({ fingerprint: { baseline: LIVE, workspaceFixtureFileSigs: [["report.md", "h"]] } }),
    );
    await expect(executeScenario(scenario, { sessionId: "x", resume: true, modelOverride: "claude-test" })).rejects.toThrow(
      /pass on the fixture alone/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("live RunResult.workspaceFixture is the as-written ref at every live assembly site", () => {
  it("execute.ts reports workspaceFixtureAsWritten(scenario), never the resolved path", () => {
    const src = readFileSync(resolve("src/run/execute.ts"), "utf8");
    expect(src.match(/workspaceFixture: workspaceFixtureAsWritten\(scenario\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/^\s+workspaceFixture: scenario\.workspace_fixture,\s*$/m);
  });
});

// `workspace_fixture`: the scan's refusals, the signature, staging on every tier (fresh run only), the load-time
// refusal of presence/body assertions on fixture files, and the `authored` rule. Token-free and spawn-free: every
// fixture here is synthetic, built in a temp dir.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnMock = vi.fn(() => ({ stdin: null, stdout: null, stderr: null }));
vi.mock("node:child_process", async (orig) => {
  const real = (await orig()) as typeof import("node:child_process");
  return { ...real, spawn: (...a: unknown[]) => (spawnMock as unknown as (...x: unknown[]) => unknown)(...a) };
});

import {
  scanWorkspaceFixture,
  scenarioWorkspaceFixture,
  stageWorkspaceFixture,
  workspaceFixtureAssertRefusal,
  workspaceFixtureSig,
  WORKSPACE_FIXTURE_MAX_BYTES_ENV,
} from "../src/fixture/workspace.js";
import { stageWorkspace } from "../src/runtime/stage.js";
import { stageHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { spawnProtocol } from "../src/runtime/protocol.js";
import { readOutputsBaseline, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { captureAuthoredFiles, collectArtifactPathsWithHealth, deliverableArtifacts } from "../src/run/artifacts.js";
import { outputsDeleteTier } from "../src/run/outputs-delete-tier.js";
import { captureInputHostPathCorpus, isInputBorneHostPath, readInputHostPathCorpus } from "../src/run/input-host-paths.js";
import {
  clearForFreshPinnedRun,
  launchSourcesPreflight,
  outputsFsDiff,
  outputsPathHasher,
  loadScenarioPure,
  scenarioArmsPreRunManifest,
  sessionOriginSources,
} from "../src/run/execute.js";
import { loadSession, resolveLaunchSources } from "../src/session.js";
import { loadBaseline } from "../src/baseline.js";
import { ScenarioObject } from "../src/types.js";
import { buildScaffold } from "../src/run/scaffold.js";
import { parse as parseYaml } from "yaml";
import { evaluate, type AssertContext } from "../src/assert.js";
import { UsageError } from "../src/errors.js";
import type { LaunchPlan } from "../src/session.js";
import type { Assertion, PlatformBaseline, Scenario } from "../src/types.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** A synthetic two-step-pipeline fixture: step 1's scored deck and its notes. */
function makeFixture(): string {
  const dir = join(tmp("wsfx-"), "after-step-1");
  mkdirSync(join(dir, "scores"), { recursive: true });
  writeFileSync(join(dir, "report.md"), "# Step 1 report\n\nscore: 7/10\n");
  writeFileSync(join(dir, "scores", "deck.json"), '{"score":7}\n');
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho step2\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  return dir;
}

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

describe("scanWorkspaceFixture — refusals (exit 2, before any spawn)", () => {
  it("lists every regular file with its digest and exec bit, sorted", () => {
    const dir = makeFixture();
    const s = scanWorkspaceFixture(dir);
    expect(s.files.map((f) => f.path)).toEqual(["report.md", "run.sh", "scores/deck.json"]);
    expect(s.files[0]!.sha256).toBe(sha("# Step 1 report\n\nscore: 7/10\n"));
    expect(s.files.find((f) => f.path === "run.sh")!.exec).toBe(true);
    expect(s.files.find((f) => f.path === "report.md")!.exec).toBe(false);
    expect(s.fileSigs.find(([p]) => p === "run.sh")![1]).toMatch(/\+x$/);
  });

  it("refuses a missing dir, a file, and a symlinked root", () => {
    const base = tmp("wsfx-bad-");
    expect(() => scanWorkspaceFixture(join(base, "nope"))).toThrow(UsageError);
    writeFileSync(join(base, "f"), "x");
    expect(() => scanWorkspaceFixture(join(base, "f"))).toThrow(/not a directory/);
    const dir = makeFixture();
    symlinkSync(dir, join(base, "link"));
    expect(() => scanWorkspaceFixture(join(base, "link"))).toThrow(/symlink/);
  });

  it("refuses a symlink anywhere in the tree, naming it", () => {
    const dir = makeFixture();
    symlinkSync("/etc/hosts", join(dir, "scores", "leak"));
    expect(() => scanWorkspaceFixture(dir)).toThrow(/"scores\/leak" is a symlink/);
  });

  it("refuses a hard-linked file", () => {
    const dir = makeFixture();
    linkSync(join(dir, "report.md"), join(tmp("wsfx-hl-"), "other-name"));
    expect(() => scanWorkspaceFixture(dir)).toThrow(/"report.md" has a second hard link/);
  });

  it.each([".claude/settings.json", ".git/HEAD", ".mcp.json", "CLAUDE.md", "sub/claude.local.md", "Sub/.Claude/x"])(
    "refuses the agent-config path %s",
    (rel) => {
      const dir = makeFixture();
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), "{}");
      expect(() => scanWorkspaceFixture(dir)).toThrow(/agent configuration, not a deliverable/);
    },
  );

  it("skips OS metadata files: never staged, never hashed", () => {
    const dir = makeFixture();
    const before = scanWorkspaceFixture(dir).sig;
    writeFileSync(join(dir, ".DS_Store"), "finder");
    writeFileSync(join(dir, "scores", "Thumbs.db"), "x");
    const after = scanWorkspaceFixture(dir);
    expect(after.sig).toBe(before);
    expect(after.files.map((f) => f.path)).not.toContain(".DS_Store");
  });

  it("refuses an empty fixture (it tests nothing)", () => {
    const dir = join(tmp("wsfx-empty-"), "f");
    mkdirSync(dir);
    writeFileSync(join(dir, ".DS_Store"), "x");
    expect(() => scanWorkspaceFixture(dir)).toThrow(/holds no file to stage/);
  });

  it("refuses a fixture over the size cap, and the env var overrides it", () => {
    const dir = makeFixture();
    vi.stubEnv(WORKSPACE_FIXTURE_MAX_BYTES_ENV, "16");
    expect(() => scanWorkspaceFixture(dir)).toThrow(/larger than 16 bytes/);
    vi.stubEnv(WORKSPACE_FIXTURE_MAX_BYTES_ENV, "1000000");
    expect(() => scanWorkspaceFixture(dir)).not.toThrow();
    vi.stubEnv(WORKSPACE_FIXTURE_MAX_BYTES_ENV, "lots");
    expect(() => scanWorkspaceFixture(dir)).toThrow(/must be a whole number/);
  });

  it("in git mode, refuses an untracked file and accepts the tracked set", () => {
    vi.stubEnv("COWORK_HARNESS_GITSET", "1");
    const repo = tmp("wsfx-git-");
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git("init", "-q");
    const dir = join(repo, "fixtures", "step1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), "tracked");
    git("add", "fixtures/step1/report.md");
    expect(scanWorkspaceFixture(dir).files.map((f) => f.path)).toEqual(["report.md"]);
    writeFileSync(join(dir, "scratch.md"), "untracked");
    expect(() => scanWorkspaceFixture(dir)).toThrow(/"scratch.md" is not tracked by git/);
  });
});

describe("workspaceFixtureSig — what counts as drift", () => {
  it("is independent of listing order", () => {
    const files = [
      { path: "b", sha256: "1", exec: false },
      { path: "a", sha256: "2", exec: true },
    ];
    expect(workspaceFixtureSig(files)).toBe(workspaceFixtureSig([...files].reverse()));
  });

  it("changes on a content edit and on the exec bit, NOT on other permission bits", () => {
    const dir = makeFixture();
    const base = scanWorkspaceFixture(dir).sig;
    chmodSync(join(dir, "report.md"), 0o600); // a umask difference between checkouts — not drift
    expect(scanWorkspaceFixture(dir).sig).toBe(base);
    chmodSync(join(dir, "report.md"), 0o744);
    expect(scanWorkspaceFixture(dir).sig).not.toBe(base);
    chmodSync(join(dir, "report.md"), 0o644);
    expect(scanWorkspaceFixture(dir).sig).toBe(base);
    writeFileSync(join(dir, "report.md"), "edited");
    expect(scanWorkspaceFixture(dir).sig).not.toBe(base);
  });

  it("scenarioWorkspaceFixture lists exactly the scanned files and the same sig (the gate-digest helper)", () => {
    const dir = makeFixture();
    const listed = scenarioWorkspaceFixture({ workspace_fixture: dir })!;
    const scan = scanWorkspaceFixture(dir);
    expect(listed.sig).toBe(scan.sig);
    expect(listed.files.map((f) => [f.path, f.sha256, f.exec])).toEqual(scan.files.map((f) => [f.path, f.sha256, f.exec]));
    expect(scenarioWorkspaceFixture({})).toBeNull();
  });
});

function planFor(fixtureDir: string | undefined, over: Partial<LaunchPlan> = {}): LaunchPlan {
  const root = tmp("wsfx-plan-");
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
    ...(fixtureDir ? { workspaceFixture: scanWorkspaceFixture(fixtureDir) } : {}),
    ...over,
  } as LaunchPlan;
}

describe("staging — copied into outputs/ on a fresh run, never on resume", () => {
  it("stageWorkspaceFixture keeps permission bits and refuses a non-empty outputs dir", () => {
    const dir = makeFixture();
    const out = join(tmp("wsfx-out-"), "outputs");
    mkdirSync(out);
    stageWorkspaceFixture(scanWorkspaceFixture(dir), out);
    expect(readFileSync(join(out, "scores", "deck.json"), "utf8")).toBe('{"score":7}\n');
    expect(statSync(join(out, "run.sh")).mode & 0o777).toBe(0o755);
    expect(() => stageWorkspaceFixture(scanWorkspaceFixture(dir), out)).toThrow(/outputs dir .* is not empty/);
  });

  it("refuses a fixture edited between the scan and staging", () => {
    const dir = makeFixture();
    const scan = scanWorkspaceFixture(dir);
    writeFileSync(join(dir, "report.md"), "changed after load");
    const out = join(tmp("wsfx-out-"), "outputs");
    mkdirSync(out);
    expect(() => stageWorkspaceFixture(scan, out)).toThrow(/changed between the scan and staging/);
  });

  it("container/microvm stageWorkspace: stages on a fresh run, and NOT on resume", () => {
    const dir = makeFixture();
    const mnt = join(tmp("wsfx-ct-"), "mnt");
    stageWorkspace(planFor(dir), mnt);
    expect(readFileSync(join(mnt, "outputs", "report.md"), "utf8")).toContain("Step 1");
    // turn 2: the skill rewrote the report in turn 1; a resume must leave it alone
    writeFileSync(join(mnt, "outputs", "report.md"), "rewritten by turn 1");
    stageWorkspace(planFor(dir, { resume: true }), mnt);
    expect(readFileSync(join(mnt, "outputs", "report.md"), "utf8")).toBe("rewritten by turn 1");
  });

  it("container/microvm stageWorkspace refuses a non-empty outputs dir on a fresh run (a stale pinned-session tree)", () => {
    const dir = makeFixture();
    const mnt = join(tmp("wsfx-ct-"), "mnt");
    mkdirSync(join(mnt, "outputs"), { recursive: true });
    writeFileSync(join(mnt, "outputs", "stale.md"), "from a previous run");
    expect(() => stageWorkspace(planFor(dir), mnt)).toThrow(/is not empty/);
  });

  it("hostloop stageHostLoopWorkspace: stages on a fresh run, and NOT on resume", () => {
    const dir = makeFixture();
    const mnt = join(tmp("wsfx-hl-"), "mnt");
    stageHostLoopWorkspace(planFor(dir), mnt);
    expect(readFileSync(join(mnt, "outputs", "scores", "deck.json"), "utf8")).toBe('{"score":7}\n');
    writeFileSync(join(mnt, "outputs", "scores", "deck.json"), '{"score":9}');
    stageHostLoopWorkspace(planFor(dir, { resume: true }), mnt);
    expect(readFileSync(join(mnt, "outputs", "scores", "deck.json"), "utf8")).toBe('{"score":9}');
  });

  it("protocol: stages before the pre-run manifest, and a resumed turn does NOT re-copy (protocol re-stages mounts every turn)", () => {
    const dir = makeFixture();
    const outDir = join(tmp("wsfx-proto-"), "run");
    const SC = { name: "fx" } as unknown as Scenario;
    const BL = {} as unknown as PlatformBaseline;
    spawnProtocol(SC, BL, planFor(dir, { capturePreRun: true }), outDir);
    const work = join(outDir, "work");
    expect(readFileSync(join(work, "outputs", "report.md"), "utf8")).toContain("Step 1");
    // staged BEFORE the manifest: the fixture file is a pre-run path with its hash
    expect(readPreRunManifestHashes(outDir)?.["outputs/report.md"]).toBe(sha("# Step 1 report\n\nscore: 7/10\n"));
    writeFileSync(join(work, "outputs", "report.md"), "rewritten by turn 1");
    spawnProtocol(SC, BL, planFor(dir, { resume: true }), outDir);
    expect(readFileSync(join(work, "outputs", "report.md"), "utf8")).toBe("rewritten by turn 1");
  });
});

describe("load-time refusal: a presence/body assertion on a fixture file must state `authored:`", () => {
  const files = [{ path: "report.md" }, { path: "scores/deck.json" }];
  const sc = (assert: Assertion[]) => ({ name: "step2", assert }) as Pick<Scenario, "name" | "assert">;

  it("refuses each of the four keys on a fixture path, in ONE message listing all of them", () => {
    const msg = workspaceFixtureAssertRefusal(
      sc([
        { file_exists: "outputs/report.md" },
        { user_visible_artifact: "outputs/scores/deck.json" },
        { artifact_text: { artifact: "outputs/report.md", contains: ["score"] } },
        { artifact_json: { artifact: "./outputs/scores/deck.json", path: "score", equals: 7 } },
      ]),
      files,
    );
    expect(msg).toMatch(/4 assertion\(s\)/);
    expect(msg).toMatch(/file_exists outputs\/report.md/);
    expect(msg).toMatch(/authored: true/);
  });

  it("accepts `authored: true` / `authored: false`, and a path the fixture does not provide", () => {
    expect(
      workspaceFixtureAssertRefusal(
        sc([
          { file_exists: { path: "outputs/report.md", authored: true } },
          { user_visible_artifact: { path: "outputs/scores/deck.json", authored: false } },
          { artifact_text: { artifact: "outputs/report.md", contains: ["x"], authored: false } },
          { file_exists: "outputs/step2.md" },
        ]),
        files,
      ),
    ).toBeUndefined();
  });

  it("does not refuse the object form with no `authored` silently: it is refused like the string form", () => {
    expect(workspaceFixtureAssertRefusal(sc([{ file_exists: { path: "outputs/report.md" } }]), files)).toMatch(/1 assertion/);
  });
});

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

describe("authorship — an untouched fixture file is pre-run, a rewritten one is authored", () => {
  /** A live work root after staging + a run that rewrote the report and left the deck alone. */
  function liveRun() {
    const dir = makeFixture();
    const mnt = join(tmp("wsfx-live-"), "mnt");
    const plan = planFor(dir);
    stageWorkspace(plan, mnt);
    const preRunHashes: Record<string, string | null> = {};
    for (const f of plan.workspaceFixture!.files) preRunHashes[`outputs/${f.path}`] = f.sha256;
    writeFileSync(join(mnt, "outputs", "report.md"), "# Step 2 report\n");
    writeFileSync(join(mnt, "outputs", "step2.md"), "new");
    return { mnt, preRunHashes, preRunPaths: Object.keys(preRunHashes) };
  }

  it("captureAuthoredFiles (the semantic_matches evidence): rewritten + new are authored, untouched is not", () => {
    const { mnt, preRunHashes } = liveRun();
    const authored = captureAuthoredFiles(mnt, ["outputs"], [], preRunHashes).map((f) => f.path);
    expect(authored).toContain("outputs/report.md");
    expect(authored).toContain("outputs/step2.md");
    expect(authored).not.toContain("outputs/scores/deck.json");
    expect(authored).not.toContain("outputs/run.sh");
  });

  it("`authored: true` fails on an untouched fixture file and passes on a rewritten or new one (live)", () => {
    const { mnt, preRunHashes, preRunPaths } = liveRun();
    const c = actx({ workRoot: mnt, preRunHashes, preRunPaths });
    const [untouched, rewritten, fresh, json] = evaluate(
      [
        { file_exists: { path: "outputs/scores/deck.json", authored: true } },
        { user_visible_artifact: { path: "outputs/report.md", authored: true } },
        { file_exists: { path: "outputs/step2.md", authored: true } },
        { artifact_json: { artifact: "outputs/scores/deck.json", path: "score", equals: 7, authored: true } },
      ],
      c,
    );
    expect(untouched!.pass).toBe(false);
    expect(untouched!.message).toMatch(/untouched pre-run file/);
    expect(rewritten!.pass).toBe(true);
    expect(fresh!.pass).toBe(true);
    expect(json!.pass).toBe(false);
  });

  it("`authored: false` and the string form do not check authorship", () => {
    const { mnt, preRunHashes, preRunPaths } = liveRun();
    const r = evaluate(
      [{ file_exists: { path: "outputs/scores/deck.json", authored: false } }, { file_exists: "outputs/scores/deck.json" }],
      actx({ workRoot: mnt, preRunHashes, preRunPaths }),
    );
    expect(r.every((x) => x.pass)).toBe(true);
  });

  it("no_unexpected_files never trips on fixture files (they are pre-run); a new file still counts", () => {
    const { mnt, preRunHashes, preRunPaths } = liveRun();
    const c = actx({ workRoot: mnt, preRunHashes, preRunPaths, preRunLinkAware: true });
    const [allowsNew, allowsNothing] = evaluate([{ no_unexpected_files: ["outputs/step2.md"] }, { no_unexpected_files: [] }], c);
    expect(allowsNew!.pass).toBe(true);
    expect(allowsNothing!.pass).toBe(false);
    expect(allowsNothing!.message).toMatch(/outputs\/step2\.md/);
    expect(allowsNothing!.message).not.toMatch(/deck\.json|run\.sh/);
  });

  it("input_unmodified guards a fixture file: untouched passes, rewritten fails", () => {
    const { mnt, preRunHashes, preRunPaths } = liveRun();
    const c = actx({ workRoot: mnt, preRunHashes, preRunPaths });
    const [untouched, rewritten] = evaluate([{ input_unmodified: "outputs/scores/**" }, { input_unmodified: "outputs/report.md" }], c);
    expect(untouched!.pass).toBe(true);
    expect(rewritten!.pass).toBe(false);
    expect(rewritten!.message).toMatch(/modified in place: outputs\/report\.md/);
  });

  it("no pre-run manifest ⇒ evidence-unavailable (never read as authored)", () => {
    const { mnt } = liveRun();
    const [r] = evaluate([{ file_exists: { path: "outputs/step2.md", authored: true } }], actx({ workRoot: mnt }));
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/evidence unavailable: .*no pre-run manifest/);
  });

  it("a null pre-run hash ⇒ evidence-unavailable, not authored", () => {
    const { mnt, preRunHashes, preRunPaths } = liveRun();
    const [r] = evaluate(
      [{ file_exists: { path: "outputs/report.md", authored: true } }],
      actx({ workRoot: mnt, preRunHashes: { ...preRunHashes, "outputs/report.md": null }, preRunPaths }),
    );
    expect(r!.pass).toBe(false);
    expect(r!.message).toMatch(/evidence unavailable/);
  });

  it("replay reads the manifest hashes: equal ⇒ pre-run (fail), different ⇒ authored", () => {
    const root = tmp("wsfx-replay-");
    mkdirSync(join(root, "outputs"));
    writeFileSync(join(root, "outputs", "a.md"), "");
    writeFileSync(join(root, "outputs", "b.md"), "");
    const c = actx({
      workRoot: root,
      preRunHashes: { "outputs/a.md": "h1", "outputs/b.md": "h2" },
      preRunPaths: ["outputs/a.md", "outputs/b.md"],
      postRunHashes: { "outputs/a.md": "h1", "outputs/b.md": "h3" },
    });
    const [a, b] = evaluate(
      [{ file_exists: { path: "outputs/a.md", authored: true } }, { file_exists: { path: "outputs/b.md", authored: true } }],
      c,
    );
    expect(a!.pass).toBe(false);
    expect(b!.pass).toBe(true);
  });

  it("does not touch disk outside the work root: an escaping path is refused", () => {
    const [r] = evaluate([{ file_exists: { path: "../x", authored: true } }], actx({ workRoot: tmp("wsfx-esc-"), preRunHashes: {} }));
    expect(r!.pass).toBe(false);
    expect(existsSync("/nonexistent")).toBe(false);
  });
});

describe("the scenario key — resolution, arming, origin, pre-spawn refusal", () => {
  /** A scenario file next to its fixture, the way a consumer lays it out. */
  function scenarioOnDisk(body: string, fixtureRel = "fixtures/after-step-1"): { path: string; fixture: string } {
    const root = tmp("wsfx-sc-");
    const fixture = join(root, ...fixtureRel.split("/"));
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "report.md"), "# Step 1 report\n");
    const path = join(root, "step2.yaml");
    writeFileSync(path, body);
    return { path, fixture };
  }

  it("resolves workspace_fixture relative to the scenario FILE (not the cwd), like session:", () => {
    const { path, fixture } = scenarioOnDisk(
      "fidelity: container\nprompt: do step 2\nworkspace_fixture: fixtures/after-step-1\nassert:\n  - result: success\n",
    );
    expect(loadScenarioPure(path).workspace_fixture).toBe(fixture);
  });

  it("refuses a blank workspace_fixture at load", () => {
    const { path } = scenarioOnDisk("fidelity: container\nprompt: x\nworkspace_fixture: '  '\n");
    expect(() => loadScenarioPure(path)).toThrow(/workspace_fixture must name a directory/);
  });

  it("a fixture ARMS the pre-run manifest, and so does `authored: true` without one", () => {
    const base = { prompt: "x", fidelity: "container" } as const;
    expect(scenarioArmsPreRunManifest(ScenarioObject.parse({ ...base, assert: [{ result: "success" }] }))).toBe(false);
    expect(scenarioArmsPreRunManifest(ScenarioObject.parse({ ...base, workspace_fixture: "/x" }))).toBe(true);
    expect(
      scenarioArmsPreRunManifest(ScenarioObject.parse({ ...base, assert: [{ file_exists: { path: "outputs/a", authored: true } }] })),
    ).toBe(true);
    expect(
      scenarioArmsPreRunManifest(
        ScenarioObject.parse({ ...base, assert: [{ artifact_text: { artifact: "outputs/a", contains: ["x"], authored: true } }] }),
      ),
    ).toBe(true);
  });

  it("the fixture joins the pinned-session origin identity", () => {
    const session = loadSession({});
    const without = sessionOriginSources(session, "(inline)");
    const dir = makeFixture();
    expect(sessionOriginSources(session, "(inline)", dir)).toEqual([...without, dir].sort());
  });

  it("pre-flight refuses (UsageError ⇒ exit 2, nothing spawned) a vacuous assertion on a fixture file and a broken fixture", () => {
    const { path } = scenarioOnDisk(
      "fidelity: container\nprompt: do step 2\nworkspace_fixture: fixtures/after-step-1\nassert:\n  - file_exists: outputs/report.md\n",
    );
    const sc = loadScenarioPure(path);
    expect(() => launchSourcesPreflight(sc, "claude-test", { quiet: true })).toThrow(/pass on the fixture alone/);
    const ok = loadScenarioPure(path);
    ok.assert = [{ file_exists: { path: "outputs/report.md", authored: true } }];
    expect(() => launchSourcesPreflight(ok, "claude-test", { quiet: true })).not.toThrow();
    const missing = { ...ok, workspace_fixture: join(tmp("wsfx-miss-"), "gone") };
    expect(() => launchSourcesPreflight(missing, "claude-test", { quiet: true })).toThrow(UsageError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a fixture that is (or holds) a mounted folder — it would be staged twice", () => {
    const dir = makeFixture();
    const session = loadSession({ folders: [{ from: dir, mode: "rw" }] });
    expect(() =>
      resolveLaunchSources(session, loadBaseline("latest"), "container", false, {
        stageFilters: false,
        quiet: true,
        workspaceFixture: dir,
      }),
    ).toThrow(/overlaps a staged source/);
  });

  it("a resumed launch does not scan (a fixture is turn-1 state; its dir may be gone)", () => {
    const s = resolveLaunchSources(loadSession({}), loadBaseline("latest"), "container", true, {
      quiet: true,
      workspaceFixture: join(tmp("wsfx-gone-"), "nope"),
    });
    expect(s.workspaceFixture).toBeUndefined();
  });
});

describe("RunResult.artifacts[].preRun — inherited vs produced", () => {
  it("marks an untouched pre-run file, never a rewritten or new one, and nothing without a manifest", () => {
    const wf = [
      { path: "outputs/kept.md", bytes: 1, sha256: "a", class: "output" as const },
      { path: "outputs/rewritten.md", bytes: 1, sha256: "b2", class: "output" as const },
      { path: "outputs/new.md", bytes: 1, sha256: "c", class: "output" as const },
      { path: "uploads/in.pdf", bytes: 1, sha256: "d", class: "input" as const },
    ];
    const pre = { "outputs/kept.md": "a", "outputs/rewritten.md": "b1", "uploads/in.pdf": "d" };
    expect(deliverableArtifacts(wf, pre)).toEqual([
      { path: "outputs/kept.md", bytes: 1, preRun: true },
      { path: "outputs/rewritten.md", bytes: 1 },
      { path: "outputs/new.md", bytes: 1 },
    ]);
    expect(deliverableArtifacts(wf, undefined)!.some((a) => "preRun" in a)).toBe(false);
  });
});

describe("host-path corpus: a fixture is user-supplied input", () => {
  it("tokenizes the staged fixture files (and only them) so quoting one is not a host_path_leak", () => {
    const dir = join(tmp("wsfx-hp-"), "fx");
    mkdirSync(dir);
    writeFileSync(join(dir, "notes.md"), "source: /Users/alice/decks/acme.pdf\n");
    const mnt = join(tmp("wsfx-hp-mnt-"), "mnt");
    const plan = planFor(dir);
    stageWorkspace(plan, mnt);
    writeFileSync(join(mnt, "outputs", "agent-wrote.md"), "/Users/alice/secret/elsewhere\n"); // not a fixture file
    const outDir = tmp("wsfx-hp-out-");
    captureInputHostPathCorpus(plan, mnt, outDir);
    const corpus = readInputHostPathCorpus(outDir);
    expect(corpus.has("/Users/alice/decks/acme.pdf")).toBe(true);
    expect(corpus.has("/Users/alice/secret/elsewhere")).toBe(false);
    expect(isInputBorneHostPath("/Users/alice/decks/acme.pdf", { tokens: corpus, neverExemptRoots: [outDir] })).toBe(true);
  });
});

describe("scaffold from a fixture run", () => {
  function keptRun(result: Record<string, unknown>): string {
    const dir = tmp("wsfx-scaffold-");
    const events = join(dir, "events.jsonl");
    writeFileSync(events, JSON.stringify({ type: "result", subtype: "success", is_error: false }));
    mkdirSync(join(dir, "turns", "1"), { recursive: true });
    writeFileSync(join(dir, "turns", "1", "result.json"), JSON.stringify(result));
    return events;
  }

  it("re-emits workspace_fixture and asserts only what the step produced (inherited files are skipped, and said so)", () => {
    const yaml = buildScaffold(
      keptRun({
        prompt: "do step 2",
        fidelity: "container",
        result: "success",
        workspaceFixture: "fixtures/after-step-1",
        artifacts: [
          { path: "outputs/report.md", bytes: 10, preRun: true },
          { path: "outputs/step2.md", bytes: 5 },
        ],
        subagents: [],
      }),
    );
    const doc = parseYaml(yaml.replace(/^#.*$/gm, "")) as { workspace_fixture: string; assert: Array<Record<string, unknown>> };
    expect(doc.workspace_fixture).toBe("fixtures/after-step-1"); // verbatim, as the scenario wrote it
    expect(doc.assert).toContainEqual({ file_exists: "outputs/step2.md" });
    expect(doc.assert.some((a) => JSON.stringify(a).includes("outputs/report.md"))).toBe(false);
    expect(yaml).toMatch(/1 inherited file/);
    // the scaffolded scenario loads, and passes the pre-spawn refusal (no vacuous assert on a fixture file)
    expect(workspaceFixtureAssertRefusal({ name: "s", assert: doc.assert as Assertion[] }, [{ path: "report.md" }])).toBeUndefined();
  });

  it("a run without a fixture scaffolds exactly as before", () => {
    const yaml = buildScaffold(
      keptRun({ prompt: "p", fidelity: "container", result: "success", artifacts: [{ path: "outputs/a.md", bytes: 1 }], subagents: [] }),
    );
    expect(yaml).not.toMatch(/workspace_fixture|inherited/);
  });
});

describe("microvm: a fresh pinned re-run starts with empty outputs", () => {
  it("clears the VM work tree's outputs (which lives outside the run dir) at microvm, and only there", () => {
    const vmWork = tmp("wsfx-vmwork-");
    const outDir = join(tmp("wsfx-run-"), "sess-x");
    for (const tier of ["microvm", "container"]) {
      mkdirSync(join(vmWork, "sess-x", "mnt", "outputs"), { recursive: true });
      writeFileSync(join(vmWork, "sess-x", "mnt", "outputs", "stale.md"), "previous run");
      mkdirSync(outDir, { recursive: true });
      clearForFreshPinnedRun(outDir, tier, "sess-x", vmWork);
      expect(existsSync(outDir)).toBe(false);
      expect(existsSync(join(vmWork, "sess-x", "mnt", "outputs", "stale.md"))).toBe(tier !== "microvm");
    }
  });
});

describe("deleting a fixture file is an outputs delete (harness policy, not production's)", () => {
  it("the turn-start outputs baseline holds the fixture, so a removed fixture file is a filesystem-proven delete", () => {
    const dir = makeFixture();
    const outDir = join(tmp("wsfx-del-"), "run");
    spawnProtocol({ name: "fx" } as unknown as Scenario, {} as unknown as PlatformBaseline, planFor(dir), outDir);
    const work = join(outDir, "work");
    rmSync(join(work, "outputs", "report.md"));
    const d = outputsFsDiff(readOutputsBaseline(outDir), collectArtifactPathsWithHealth(work, ["outputs"]), outputsPathHasher(work));
    expect(d.status).toBe("findings");
    expect(d.findings.join(" ")).toMatch(/outputs\/report\.md/);
    // and that is a verdict failure by default (outputsDeleteTier "fail")
    expect(outputsDeleteTier({ outputsDeletes: d.findings, outputsDeleteBasis: d.findings.map(() => "fs-diff") }, d)).toBe("fail");
  });
});

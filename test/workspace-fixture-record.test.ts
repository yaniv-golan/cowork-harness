// End to end through the REAL record tail: a fixture scenario loaded from disk, staged by the protocol tier
// (spawn stubbed — no agent, no tokens), the pre-run manifest the tier captures, `freezeRecordedRun` writing
// the cassette, then `readCassette` + `replayCassette` on the file it wrote. Nothing in the cassette is built
// by hand. Synthetic data only.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnMock = vi.fn(() => ({ stdin: null, stdout: null, stderr: null }));
vi.mock("node:child_process", async (orig) => {
  const real = (await orig()) as typeof import("node:child_process");
  return { ...real, spawn: (...a: unknown[]) => (spawnMock as unknown as (...x: unknown[]) => unknown)(...a) };
});

import { scanWorkspaceFixture, withWorkspaceFixtureSig } from "../src/fixture/workspace.js";
import { spawnProtocol } from "../src/runtime/protocol.js";
import { readPreRunManifest, readPreRunManifestHashes } from "../src/run/pre-run-manifest.js";
import { loadScenarioPure, scenarioArmsPreRunManifest } from "../src/run/execute.js";
import { freezeRecordedRun, readCassette, replayCassette } from "../src/run/cassette.js";
import { computeVerdict } from "../src/run/verdict.js";
import { loadBaseline } from "../src/baseline.js";
import type { LaunchPlan } from "../src/session.js";
import type { PlatformBaseline, RunResult } from "../src/types.js";

const LIVE = loadBaseline("latest").appVersion;
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

const BIN = Buffer.from([0, 1, 2, 3, 255, 0, 9]);

/** A scenario bundle on disk: the scenario YAML and its fixture, side by side. */
function bundle(): { root: string; scenarioPath: string; fixture: string } {
  const root = tmp("wsfr-");
  const fixture = join(root, "fixtures", "after-scoring");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "report.md"), "# Scores\n\ntotal: 7\n");
  writeFileSync(join(fixture, "deck.bin"), BIN); // untouched binary → hash-only
  writeFileSync(join(fixture, "chart.bin"), BIN); // the step rewrites it → a deliverable, inlined
  const scenarioPath = join(root, "step2.yaml");
  writeFileSync(
    scenarioPath,
    [
      "fidelity: protocol",
      "prompt: Draft the memo from the scored deck.",
      "workspace_fixture: fixtures/after-scoring",
      "assert:",
      "  - result: success",
      "  - file_exists: {path: outputs/memo.md, authored: true}",
      "  - file_exists: {path: outputs/chart.bin, authored: true}",
      "  - file_exists: {path: outputs/deck.bin, authored: false}",
      "  - artifact_text: {artifact: outputs/report.md, contains: [total], authored: false}",
      "  - input_unmodified: outputs/deck.bin",
      "",
    ].join("\n"),
  );
  return { root, scenarioPath, fixture };
}

async function recordIt() {
  const b = bundle();
  const scenario = loadScenarioPure(b.scenarioPath);
  const outDir = join(tmp("wsfr-run-"), "run");
  const root = tmp("wsfr-plan-");
  mkdirSync(join(root, "config", "skills"), { recursive: true });
  const plan = {
    configDir: join(root, "config"),
    mcpConfig: null,
    mounts: [],
    pluginDirs: [],
    egressAllow: [],
    baseEnv: {},
    permissionMode: "default",
    permissionParity: "cowork",
    resume: false,
    capturePreRun: scenarioArmsPreRunManifest(scenario, true),
    workspaceFixture: scanWorkspaceFixture(scenario.workspace_fixture!),
  } as unknown as LaunchPlan;
  spawnProtocol(scenario, {} as unknown as PlatformBaseline, plan, outDir);
  // What the "agent" did: wrote the memo, rewrote the chart, left report.md and deck.bin alone.
  const work = join(outDir, "work");
  writeFileSync(join(work, "outputs", "memo.md"), "# Memo\n");
  writeFileSync(join(work, "outputs", "chart.bin"), Buffer.from([7, 7, 0, 7]));
  writeFileSync(
    join(outDir, "events.jsonl"),
    [
      JSON.stringify({ type: "system", subtype: "init", tools: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
    ].join("\n"),
  );
  writeFileSync(join(outDir, "control-out.jsonl"), "");
  const result = {
    mode: "run",
    command: "record",
    scenario: scenario.name,
    prompt: scenario.prompt,
    fidelity: "protocol",
    effectiveFidelity: "protocol",
    result: "success",
    baseline: LIVE,
    outDir,
    workDir: work,
    outputsDir: join(work, "outputs"),
    userVisibleRoots: ["outputs"],
    preRunPaths: readPreRunManifest(outDir),
    preRunHashes: readPreRunManifestHashes(outDir),
    fingerprint: withWorkspaceFixtureSig({ baseline: LIVE, hashFormat: "jcs1" }, plan.workspaceFixture),
    assertions: [],
    egress: [],
  } as unknown as RunResult;
  expect(computeVerdict(result, "live").pass).toBe(true);
  const cassettePath = join(b.root, "step2.cassette.json");
  await freezeRecordedRun(scenario, { noRedact: true, allowFailing: false, cassettePath, scenarioSourceFile: b.scenarioPath }, [], result);
  const stderr = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
  return { ...b, cassettePath, plan, stderr };
}

describe("record → replay of a fixture scenario through the real record tail", () => {
  it("freezes the relative ref, the staged signature, hash-only untouched binaries, and says what it inlined", async () => {
    const { cassettePath, plan, stderr } = await recordIt();
    const raw = JSON.parse(readFileSync(cassettePath, "utf8"));
    expect(raw.cassetteVersion).toBe(14);
    expect(raw.scenario.workspace_fixture).toBe("fixtures/after-scoring");
    // the signature survives from the RunResult into the cassette fingerprint
    expect(raw.fingerprint.workspaceFixtureSig).toBe(plan.workspaceFixture!.sig);
    expect(raw.fingerprint.workspaceFixtureFileSigs).toEqual(plan.workspaceFixture!.fileSigs);
    const byPath = new Map((raw.artifacts as Array<Record<string, unknown>>).map((a) => [a.path, a]));
    expect(byPath.get("outputs/deck.bin")).toMatchObject({ truncated: true, truncationReason: "fixture" });
    expect(byPath.get("outputs/deck.bin")!.body).toBeUndefined();
    expect(byPath.get("outputs/chart.bin")!.body).toBeDefined();
    expect(byPath.get("outputs/report.md")!.body).toContain("total: 7");
    expect(stderr).toMatch(/workspace_fixture — 1 untouched fixture file\(s\) \(19 bytes\) are inlined/);
    expect(stderr).toMatch(/1 untouched binary file\(s\) recorded hash-only/);
  });

  it("replays green from the written file, reports the scenario-relative ref, and a fixture edit stales it", async () => {
    const { cassettePath, root, fixture } = await recordIt();
    const rc = readCassette(cassettePath);
    if ("error" in rc) throw new Error(rc.error);
    const r = await replayCassette(rc.cassette, [], { cassetteDir: root });
    expect(r.assertions.filter((a) => !a.pass).map((a) => a.message)).toEqual([]);
    expect((r.staleness ?? []).some((s) => s.class.includes("fixture"))).toBe(false);
    expect(r.workspaceFixture).toBe("fixtures/after-scoring");
    writeFileSync(join(fixture, "report.md"), "# Scores\n\ntotal: 8\n");
    const stale = await replayCassette(rc.cassette, [], { cassetteDir: root });
    expect(stale.staleness).toEqual([expect.objectContaining({ class: "fixture" })]);
  });
});

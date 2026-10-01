// What a fixture run freezes into a cassette, and how replay reads it back: the fixture ref stays relative to the
// cassette, untouched binary fixture files are hash-only, redaction never manufactures authorship, and the
// verify-cassettes gate treats an unverifiable fixture as "could not verify" (exit 3). Synthetic data only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cassetteFixtureRef,
  embeddedScenario,
  fixtureBinariesHashOnly,
  recordingShapingDrift,
  redactCassette,
  assertRedactionVerdictPreserved,
  replayCassette,
  scanCassette,
  CASSETTE_VERSION,
  type Cassette,
  type ManifestEntry,
} from "../src/run/cassette.js";
import { computeVerdict } from "../src/run/verdict.js";
import { loadBaseline } from "../src/baseline.js";
import type { RedactionPolicy } from "../src/redact.js";
import type { Scenario } from "../src/types.js";

const LIVE = loadBaseline("latest").appVersion;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => errSpy.mockRestore());

describe("the fixture ref is relocatable", () => {
  it("is stored relative to the cassette, and re-resolved for a re-record from the embedded snapshot", () => {
    const root = tmp("wsfx-ref-");
    const cassettePath = join(root, "cassettes", "step2.cassette.json");
    const fixture = join(root, "fixtures", "step1");
    const ref = cassetteFixtureRef(fixture, cassettePath);
    expect(ref).toBe("../fixtures/step1");
    const sc = { session: "(inline)", workspace_fixture: ref } as unknown as Scenario;
    expect(embeddedScenario(sc, cassettePath).workspace_fixture).toBe(fixture);
    expect(embeddedScenario({ session: "(inline)" } as unknown as Scenario, cassettePath).workspace_fixture).toBeUndefined();
  });

  it("recording-shaping drift compares both sides as absolute paths, never as strings", () => {
    const root = tmp("wsfx-shape-");
    const frozen = { workspace_fixture: "../fixtures/step1" } as unknown as Scenario;
    const same = { workspace_fixture: join(root, "fixtures", "step1") } as unknown as Scenario;
    const moved = { workspace_fixture: join(root, "fixtures", "other") } as unknown as Scenario;
    const none = {} as unknown as Scenario;
    const dir = join(root, "cassettes");
    expect(recordingShapingDrift(frozen, same, dir)).not.toContain("workspace_fixture");
    expect(recordingShapingDrift(frozen, moved, dir)).toContain("workspace_fixture");
    expect(recordingShapingDrift(frozen, none, dir)).toContain("workspace_fixture");
    expect(recordingShapingDrift(none, same, dir)).toContain("workspace_fixture");
    expect(recordingShapingDrift(frozen, same, undefined)).toContain("workspace_fixture"); // cannot resolve ≠ match
  });
});

describe("untouched BINARY fixture files are hash-only; text ones stay inline", () => {
  const bin = Buffer.from([0, 1, 2, 255]);
  const entry = (path: string, body: Buffer | string): ManifestEntry =>
    typeof body === "string"
      ? { path, bytes: body.length, sha256: sha(body), body }
      : { path, bytes: body.length, sha256: sha(body), body: body.toString("base64"), encoding: "base64" };

  it("drops the body of an untouched binary fixture file only", () => {
    const rewrittenBin = Buffer.from([9, 9, 0]);
    const out = fixtureBinariesHashOnly(
      [
        entry("outputs/deck.pptx", bin), // fixture, untouched, binary → hash-only
        entry("outputs/chart.png", rewrittenBin), // fixture, REWRITTEN binary → a deliverable, kept
        entry("outputs/report.md", "text"), // fixture, untouched, text → inline
        entry("outputs/new.bin", bin), // not a fixture file → kept
      ],
      ["deck.pptx", "chart.png", "report.md"],
      { "outputs/deck.pptx": sha(bin), "outputs/chart.png": sha("old"), "outputs/report.md": sha("text") },
    );
    expect(out[0]).toEqual({ path: "outputs/deck.pptx", bytes: 4, sha256: sha(bin), truncated: true, truncationReason: "fixture" });
    expect(out[1]!.body).toBeDefined();
    expect(out[2]!.body).toBe("text");
    expect(out[3]!.body).toBeDefined();
  });

  it("a hash-only fixture entry raises no committed-binary privacy finding; an inline one does", () => {
    const base = { scenario: { prompt: "x" }, events: [], controlOut: [] };
    const inline = scanCassette({ ...base, artifacts: [entry("outputs/deck.pptx", bin)] } as never, []);
    expect(inline.some((f) => f.cls === "binary")).toBe(true);
    const hashOnly = fixtureBinariesHashOnly([entry("outputs/deck.pptx", bin)], ["deck.pptx"], { "outputs/deck.pptx": sha(bin) });
    expect(scanCassette({ ...base, artifacts: hashOnly } as never, []).some((f) => f.cls === "binary")).toBe(false);
  });
});

/** A replayable cassette whose manifest holds a fixture run's outputs. */
function fixtureCassette(assert: unknown[], artifacts: ManifestEntry[], preRunHashes: Record<string, string | null>): Cassette {
  return {
    scenario: {
      name: "c",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "do step 2",
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
    artifacts,
    userVisibleRoots: ["outputs"],
    preRunPaths: Object.keys(preRunHashes),
    preRunHashes,
  } as unknown as Cassette;
}

const results = async (c: Cassette) => (await replayCassette(c, [])).assertions.filter((a) => a.source !== "staleness");

describe("replay of a hash-only fixture entry", () => {
  it("file_exists passes (path + sha prove it); a body assertion is evidence-unavailable, naming the cause", async () => {
    const bin = Buffer.from([0, 1, 2]);
    const c = fixtureCassette(
      [
        { file_exists: { path: "outputs/deck.pptx", authored: false } },
        { artifact_text: { artifact: "outputs/deck.pptx", contains: ["x"], authored: false } },
      ],
      [{ path: "outputs/deck.pptx", bytes: 3, sha256: sha(bin), truncated: true, truncationReason: "fixture" }],
      { "outputs/deck.pptx": sha(bin) },
    );
    const [exists, text] = await results(c);
    expect(exists!.pass).toBe(true);
    expect(text!.pass).toBe(false);
    expect(text!.message).toMatch(/untouched binary workspace_fixture file/);
  });
});

describe("redaction never manufactures authorship", () => {
  const ACME = /Acme/g;
  const policy: RedactionPolicy = { patterns: [{ re: ACME, label: "customer" }], keyNames: [] };
  const untouched = "Acme Corp — step 1 scores\n";
  const oldNotes = "notes v1\n";
  const newNotes = "Acme notes rewritten by step 2\n";

  const recorded = () =>
    fixtureCassette(
      [
        { file_exists: { path: "outputs/report.md", authored: true } },
        { file_exists: { path: "outputs/notes.md", authored: true } },
        { input_unmodified: "outputs/report.md" },
      ],
      [
        { path: "outputs/report.md", bytes: untouched.length, sha256: sha(untouched), body: untouched },
        { path: "outputs/notes.md", bytes: newNotes.length, sha256: sha(newNotes), body: newNotes },
      ],
      { "outputs/report.md": sha(untouched), "outputs/notes.md": sha(oldNotes) },
    );

  it("before redaction: the untouched fixture file is pre-run (authored fails), the rewritten one is authored", async () => {
    const [report, notes, unmodified] = await results(recorded());
    expect(report!.pass).toBe(false);
    expect(report!.message).toMatch(/untouched pre-run file/);
    expect(notes!.pass).toBe(true);
    expect(unmodified!.pass).toBe(true);
  });

  it("a policy that rewrites an untouched fixture body remaps its pre-run hash to the redacted sha: it stays untouched on replay (authored fails as pre-run, input_unmodified passes), and the record self-check accepts it", async () => {
    const base = recorded();
    const red = redactCassette(base, policy);
    expect(red.preRunHashes!["outputs/report.md"]).toBe(red.artifacts!.find((a) => a.path === "outputs/report.md")!.sha256);
    const [report, notes, unmodified] = await results(red);
    expect(report!.pass).toBe(false);
    expect(report!.message).toMatch(/untouched pre-run file/);
    // the file the step DID rewrite keeps its raw pre-run hash, so it is still (truly) authored
    expect(red.preRunHashes!["outputs/notes.md"]).toBe(sha(oldNotes));
    expect(notes!.pass).toBe(true);
    expect(unmodified!.pass).toBe(true);
    await expect(assertRedactionVerdictPreserved(base, red)).resolves.toBeUndefined();
  });

  it("a policy that matches nothing leaves every pre-run hash alone", () => {
    const red = redactCassette(recorded(), { patterns: [{ re: /Zzz/g, label: "x" }], keyNames: [] });
    expect(red.preRunHashes).toEqual(recorded().preRunHashes);
  });
});

const CLI = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI))("verify-cassettes", () => {
  it("an unverifiable fixture is 'could not verify' (exit 3), not a pass", () => {
    const dir = tmp("wsfx-verify-");
    const c = {
      ...fixtureCassette([{ result: "success" }], [], {}),
      $schema: `https://raw.githubusercontent.com/yaniv-golan/cowork-harness/main/schema/cassette.v${CASSETTE_VERSION}.json`,
      generator: "cowork-harness",
    } as Cassette;
    (c.scenario as Scenario).workspace_fixture = "fixtures/gone";
    c.fingerprint = { baseline: LIVE, hashFormat: "jcs1", workspaceFixtureSig: "0".repeat(64), workspaceFixtureFileSigs: [] };
    mkdirSync(join(dir, "cassettes"));
    const f = join(dir, "cassettes", "c.cassette.json");
    writeFileSync(f, JSON.stringify(c));
    const r = spawnSync("node", [CLI, "verify-cassettes", f, "--output-format", "json"], { encoding: "utf8", cwd: dir });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stdout).toMatch(/workspace_fixture fixtures\/gone/);
  });
});

describe.skipIf(!existsSync(CLI))("replay --assert-from on a fixture cassette", () => {
  /** A cassette dir with its fixture beside it, recorded against `fixtures/step1/report.md`. */
  function setup(onDiskAssert: string): { dir: string } {
    const dir = join(tmp("wsfx-af-"), "nested");
    mkdirSync(join(dir, "fixtures", "step1"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "step1", "report.md"), "# step 1\n");
    const c = fixtureCassette([{ result: "success" }], [], {});
    (c.scenario as Scenario).name = "c";
    (c.scenario as Scenario).workspace_fixture = "fixtures/step1";
    c.fingerprint = { baseline: LIVE, hashFormat: "jcs1", workspaceFixtureSig: "x", workspaceFixtureFileSigs: [["report.md", "x"]] };
    writeFileSync(join(dir, "c.cassette.json"), JSON.stringify(c));
    writeFileSync(
      join(dir, "c.yaml"),
      `fidelity: container\nprompt: do step 2\nworkspace_fixture: fixtures/step1\nassert:\n${onDiskAssert}`,
    );
    return { dir };
  }
  const run = (dir: string) =>
    spawnSync("node", [CLI, "replay", "c.cassette.json", "--assert-from", "c.yaml"], { encoding: "utf8", cwd: dir });

  it("refuses an on-disk presence assertion on a file the recording's fixture provided, with no `authored:`", () => {
    const r = run(setup("  - file_exists: outputs/report.md\n").dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/pass on the fixture alone/);
  });

  it("accepts it once `authored:` is stated", () => {
    const r = run(setup("  - file_exists: {path: outputs/report.md, authored: false}\n").dir);
    expect(r.stderr + r.stdout).not.toMatch(/pass on the fixture alone/);
  });
});

describe.skipIf(!existsSync(CLI))("verify-run on a fixture run", () => {
  function keptFixtureRun(onDiskAssert: string): { root: string; scenario: string } {
    const root = join(tmp("wsfx-vr-"), "run");
    const workDir = join(root, "work", "session", "mnt");
    mkdirSync(join(workDir, "outputs"), { recursive: true });
    writeFileSync(join(workDir, "outputs", "report.md"), "# step 1\n");
    const t1 = join(root, "turns", "1");
    mkdirSync(t1, { recursive: true });
    writeFileSync(
      join(t1, "result.json"),
      JSON.stringify({
        scenario: "s",
        fidelity: "container",
        baseline: LIVE,
        result: "success",
        decisions: [],
        toolCounts: {},
        gateDeliveries: [],
        egress: [],
        assertions: [],
        subagents: [],
        outDir: root,
        workDir,
        durationMs: 1,
        scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
        fingerprint: { baseline: LIVE, workspaceFixtureSig: "x", workspaceFixtureFileSigs: [["report.md", "x"]] },
      }),
    );
    writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "s" }));
    writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [], steps: [] }));
    const dir = tmp("wsfx-vr-sc-");
    mkdirSync(join(dir, "fx"));
    writeFileSync(join(dir, "fx", "report.md"), "# step 1\n");
    const scenario = join(dir, "s.yaml");
    writeFileSync(scenario, `fidelity: container\nprompt: p\nworkspace_fixture: fx\nassert:\n${onDiskAssert}`);
    return { root, scenario };
  }
  it("refuses (exit 2) a presence assertion on a file the run's fixture provided, with no `authored:`", () => {
    const { root, scenario } = keptFixtureRun("  - file_exists: outputs/report.md\n");
    const r = spawnSync("node", [CLI, "verify-run", root, scenario], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/pass on the fixture alone/);
  });
  it("evaluates it once `authored:` is stated", () => {
    const { root, scenario } = keptFixtureRun("  - file_exists: {path: outputs/report.md, authored: false}\n");
    const r = spawnSync("node", [CLI, "verify-run", root, scenario], { encoding: "utf8" });
    expect(r.stderr + r.stdout).not.toMatch(/pass on the fixture alone/);
    expect(r.status).toBe(0);
  });
});

// A workspace_fixture is test input the skill reads, so a cassette carries its content signature and replay
// recomputes it from the scenario's fixture dir (resolved against the cassette). A changed fixture is a `fixture`
// finding (warns by default; --strict, --fail-on-skill-drift and an explicit --session fail it); a recorded
// signature that cannot be checked today is `unverifiable-fixture`, which fails the default gate.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStaleness, replayCassette, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";
import { computeVerdict } from "../src/run/verdict.js";
import { loadBaseline } from "../src/baseline.js";
import { scanWorkspaceFixture } from "../src/fixture/workspace.js";

const LIVE = loadBaseline("latest").appVersion;

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.stubEnv("COWORK_HARNESS_GITSET", "0");
});
afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllEnvs();
});

/** A cassette dir holding `fixtures/step1/` and a cassette recorded against it (fixture stored cassette-relative). */
function recorded(): { cassetteDir: string; fixture: string; cassette: Cassette } {
  const cassetteDir = realpathSync(mkdtempSync(join(tmpdir(), "wsfx-stale-")));
  const fixture = join(cassetteDir, "fixtures", "step1");
  mkdirSync(join(fixture, "data"), { recursive: true });
  writeFileSync(join(fixture, "report.md"), "# step 1\n");
  writeFileSync(join(fixture, "data", "scores.json"), '{"s":1}\n');
  const scan = scanWorkspaceFixture(fixture);
  const cassette = {
    scenario: {
      name: "c",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "do step 2",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
      workspace_fixture: "fixtures/step1",
    },
    events: [
      JSON.stringify({ type: "system", subtype: "init", tools: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: [],
    cassetteVersion: CASSETTE_VERSION,
    fingerprint: { baseline: LIVE, workspaceFixtureSig: scan.sig, workspaceFixtureFileSigs: scan.fileSigs },
  } as unknown as Cassette;
  return { cassetteDir, fixture, cassette };
}

const classes = (c: Cassette, dir: string | undefined) => computeStaleness(c, dir).findings.filter((f) => f.class.includes("fixture"));

describe("computeStaleness — the fixture signature", () => {
  it("an unchanged fixture is clean; a reorder-free recompute matches", () => {
    const { cassetteDir, cassette } = recorded();
    expect(classes(cassette, cassetteDir)).toEqual([]);
  });

  it("a content edit is a `fixture` finding naming the file", () => {
    const { cassetteDir, fixture, cassette } = recorded();
    writeFileSync(join(fixture, "data", "scores.json"), '{"s":2}\n');
    const f = classes(cassette, cassetteDir);
    expect(f).toEqual([expect.objectContaining({ class: "fixture" })]);
    expect(f[0]!.message).toMatch(/data\/scores\.json/);
  });

  it("an added or removed file is a `fixture` finding", () => {
    const { cassetteDir, fixture, cassette } = recorded();
    writeFileSync(join(fixture, "extra.md"), "x");
    expect(classes(cassette, cassetteDir)[0]!.message).toMatch(/extra\.md/);
    rmSync(join(fixture, "extra.md"));
    rmSync(join(fixture, "report.md"));
    expect(classes(cassette, cassetteDir)[0]!.message).toMatch(/report\.md/);
  });

  it("a permission change other than the exec bit is NOT drift; the exec bit is", () => {
    const { cassetteDir, fixture, cassette } = recorded();
    chmodSync(join(fixture, "report.md"), 0o600);
    expect(classes(cassette, cassetteDir)).toEqual([]);
    chmodSync(join(fixture, "report.md"), 0o755);
    expect(classes(cassette, cassetteDir)).toEqual([expect.objectContaining({ class: "fixture" })]);
  });

  it("a missing fixture dir, or no cassette dir to resolve it against, is `unverifiable-fixture`", () => {
    const { cassetteDir, fixture, cassette } = recorded();
    expect(classes(cassette, undefined)).toEqual([expect.objectContaining({ class: "unverifiable-fixture" })]);
    rmSync(fixture, { recursive: true });
    const gone = classes(cassette, cassetteDir);
    expect(gone).toEqual([expect.objectContaining({ class: "unverifiable-fixture" })]);
    expect(gone[0]!.message).toMatch(/^workspace_fixture fixtures\/step1: no such directory/);
  });

  it("a fixture the scan now refuses (a planted symlink) is `unverifiable-fixture`, not a crash", () => {
    const { cassetteDir, fixture, cassette } = recorded();
    symlinkSync("/etc/hosts", join(fixture, "link"));
    expect(classes(cassette, cassetteDir)).toEqual([expect.objectContaining({ class: "unverifiable-fixture" })]);
  });

  it("a fixture scenario with NO recorded signature is `unverifiable-fixture` (never a silent skip)", () => {
    const { cassetteDir, cassette } = recorded();
    const bare = { ...cassette, fingerprint: { baseline: LIVE } } as Cassette;
    expect(classes(bare, cassetteDir)).toEqual([expect.objectContaining({ class: "unverifiable-fixture" })]);
  });

  it("a scenario without a fixture gets no fixture finding", () => {
    const { cassetteDir, cassette } = recorded();
    const plain = { ...cassette, scenario: { ...cassette.scenario, workspace_fixture: undefined } } as Cassette;
    expect(classes(plain, cassetteDir)).toEqual([]);
  });
});

describe("replay gate: `fixture` warns, `unverifiable-fixture` fails, both escalate", () => {
  const ok = (r: Awaited<ReturnType<typeof replayCassette>>) => computeVerdict(r, "replay").pass;

  it("default: fixture drift is surfaced but green; an unverifiable fixture is red", async () => {
    const drift = recorded();
    writeFileSync(join(drift.fixture, "report.md"), "edited");
    const r1 = await replayCassette(drift.cassette, [], { cassetteDir: drift.cassetteDir });
    expect(r1.staleness).toEqual([expect.objectContaining({ class: "fixture" })]);
    expect(ok(r1)).toBe(true);

    const gone = recorded();
    rmSync(gone.fixture, { recursive: true });
    const r2 = await replayCassette(gone.cassette, [], { cassetteDir: gone.cassetteDir });
    expect(r2.staleness).toEqual([expect.objectContaining({ class: "unverifiable-fixture" })]);
    expect(ok(r2)).toBe(false);
  });

  it("--fail-on-skill-drift fails fixture drift (the fixture is test input the skill reads)", async () => {
    const d = recorded();
    writeFileSync(join(d.fixture, "report.md"), "edited");
    expect(ok(await replayCassette(d.cassette, [], { cassetteDir: d.cassetteDir, failOnSkillDrift: true }))).toBe(false);
  });

  it("an explicit --session never lowers the verdict: fixture drift fails under it", async () => {
    const d = recorded();
    writeFileSync(join(d.fixture, "report.md"), "edited");
    const session = join(d.cassetteDir, "session.yaml");
    writeFileSync(session, "{}\n");
    expect(ok(await replayCassette(d.cassette, [], { cassetteDir: d.cassetteDir, sessionOverride: session }))).toBe(false);
  });

  it("--strict fails fixture drift (superset)", async () => {
    const d = recorded();
    writeFileSync(join(d.fixture, "report.md"), "edited");
    expect(ok(await replayCassette(d.cassette, [], { cassetteDir: d.cassetteDir, strict: true }))).toBe(false);
  });

  it("an unchanged fixture replays green on every gate", async () => {
    const d = recorded();
    expect(ok(await replayCassette(d.cassette, [], { cassetteDir: d.cassetteDir, failOnSkillDrift: true }))).toBe(true);
  });
});

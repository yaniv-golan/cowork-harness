// A cassette's path-bearing metadata is stored RELATIVE to the cassette, so a reference that climbs out of
// the tree into a home directory (`../../../Users/<name>/…`) carries the recording user's name without ever
// starting with `/Users/`. The absolute-path class cannot see it; `verify-cassettes` must.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanCassette, type Cassette } from "../src/run/cassette.js";

const cassette = (session: string, extra: Partial<Cassette> = {}) =>
  ({
    scenario: { name: "c", baseline: "latest", session, fidelity: "container", prompt: "hi", answers: [], expect_denied: [], assert: [] },
    events: [],
    ...extra,
  }) as unknown as Cassette;

const pathFindings = (c: Cassette) => scanCassette(c, []).filter((f) => f.cls === "path");

describe("scanCassette: a relative reference that climbs into a home directory is a path finding", () => {
  for (const session of ["../../../Users/someone/s.yaml", "../home/someone/s.yaml", "..\\..\\Users\\someone\\s.yaml", "../../root/s.yaml"])
    it(`flags scenario.session ${JSON.stringify(session)}`, () => {
      const f = pathFindings(cassette(session));
      expect(f.map((x) => x.where)).toContain("metadata:scenario.session");
    });

  it("flags the same shape in scenarioSource and fingerprint.skillSources", () => {
    const f = pathFindings(
      cassette("../sessions/s.yaml", {
        scenarioSource: "../../Users/someone/sc.yaml",
        fingerprint: { baseline: "x", skillSources: ["../../../home/someone/skill"] },
      } as Partial<Cassette>),
    );
    expect(f.map((x) => x.where).sort()).toEqual(["fingerprint.skillSources", "metadata:scenarioSource"]);
  });

  for (const session of [
    "../sessions/default.yaml",
    "../../e2e/sessions/minimal.yaml",
    "~/s/session.yaml",
    "(inline)",
    "../Users.yaml",
    "./users/x.yaml",
  ])
    it(`leaves ${JSON.stringify(session)} clean`, () => {
      expect(pathFindings(cassette(session))).toEqual([]);
    });
});

const CLI = resolve("dist/cli.js");
describe.skipIf(!existsSync(CLI))("verify-cassettes: the climb-out finding gates", () => {
  it("a cassette whose session climbs into a home directory exits 1 with the finding", () => {
    const c = JSON.parse(readFileSync("examples/replays/example-pdf-skill.cassette.json", "utf8"));
    c.scenario.session = "../../../Users/someone/s.yaml";
    const d = mkdtempSync(join(tmpdir(), "cwh-climb-"));
    const f = join(d, "x.cassette.json");
    writeFileSync(f, JSON.stringify(c));
    const r = spawnSync("node", [CLI, "verify-cassettes", f, "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "1" },
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/metadata:scenario\.session/);
  });
});

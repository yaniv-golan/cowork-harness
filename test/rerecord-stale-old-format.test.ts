// An older-format cassette this build refuses to read (below the v12 floor, or missing a field replay now requires)
// is not a dead end: `record --rerecord-stale` reads just its scenario source from the raw JSON and re-records from the
// on-disk scenario. Driven through the real CLI with the stub agent (no model, no spend).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeStubFixture, spawnCli, exited, POSIX } from "./helpers/stub-agent.js";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

const can = POSIX && existsSync(resolve("dist/cli.js"));
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const OK = [
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "stub", total_cost_usd: 0.01 }),
  "cat >/dev/null",
].join("\n");

async function cli(f: ReturnType<typeof makeStubFixture>, args: string[]) {
  const c = spawnCli(f, args);
  const { code } = await exited(c, 60_000);
  return { code, stdout: c.stdoutText(), stderr: c.stderrText() };
}

/** Record a real cassette, then age it with `age`. Returns the cassette path. */
async function agedCassette(f: ReturnType<typeof makeStubFixture>, age: (c: Record<string, unknown>) => void): Promise<string> {
  const dir = join(f.cwd, "cassettes");
  mkdirSync(dir, { recursive: true });
  const cass = join(dir, "stub.cassette.json");
  const rec = await cli(f, ["record", f.scenario, "--out", cass]);
  expect(rec.code, rec.stderr).toBe(0);
  const c = JSON.parse(readFileSync(cass, "utf8"));
  expect(c.scenarioSource).toBeTruthy(); // the recorder persisted where its scenario lives
  age(c);
  writeFileSync(cass, JSON.stringify(c));
  return cass;
}

describe.runIf(can)("record --rerecord-stale re-records an older-format cassette from its on-disk scenario", () => {
  it.each([
    ["v11 (below the floor; a 4.x rehash could migrate it)", (c: Record<string, unknown>) => void (c.cassetteVersion = 11)],
    ["v9 (below the floor; nothing but a re-record)", (c: Record<string, unknown>) => void (c.cassetteVersion = 9)],
    ["no controlOut", (c: Record<string, unknown>) => void delete c.controlOut],
    ["no userVisibleRoots", (c: Record<string, unknown>) => void delete c.userVisibleRoots],
  ])(
    "%s",
    async (_, age) => {
      const f = makeStubFixture(OK);
      try {
        const cass = await agedCassette(f, age);
        // It is refused on read…
        const rep = await cli(f, ["replay", cass]);
        expect(rep.code).toBe(2);
        // …and --rerecord-stale picks it up and re-records it in place, from the scenario file.
        const rr = await cli(f, ["record", "--rerecord-stale", join(f.cwd, "cassettes"), "--output-format", "json"]);
        expect(rr.code, rr.stderr).toBe(0);
        const env = JSON.parse(rr.stdout);
        expect(env.payload?.items ?? env.items).toBeDefined();
        const items = env.payload?.items ?? env.items;
        expect(items).toHaveLength(1);
        expect(items[0].status, JSON.stringify(items[0])).toBe("recorded");
        const fresh = JSON.parse(readFileSync(cass, "utf8"));
        expect(fresh.cassetteVersion).toBeGreaterThanOrEqual(12);
        expect(fresh.controlOut.length).toBeGreaterThan(0);
        expect(Array.isArray(fresh.userVisibleRoots)).toBe(true);
        expect((await cli(f, ["replay", cass])).code).toBe(0);
      } finally {
        f.cleanup();
      }
    },
    180_000,
  );

  it("a NEWER build's cassette that looks stale (baseline moved) is never re-recorded: bytes unchanged, upgrade named, not exit 0", async () => {
    const f = makeStubFixture(OK);
    try {
      const v = CASSETTE_VERSION + 1;
      const cass = await agedCassette(f, (c) => {
        c.cassetteVersion = v;
        c.fingerprint = { ...(c.fingerprint as object), baseline: "0.0.0-does-not-exist", hashFormat: "jcs1" };
      });
      const before = readFileSync(cass);
      const rr = await cli(f, ["record", "--rerecord-stale", join(f.cwd, "cassettes"), "--output-format", "json"]);
      expect(rr.code).not.toBe(0);
      const env = JSON.parse(rr.stdout);
      const items = env.payload?.items ?? env.items;
      expect(items).toHaveLength(1); // it WAS selected as stale — the guard, not the selection, keeps it safe
      expect(items[0].status).toBe("failed");
      expect(items[0].error).toBe(`stamped v${v}, newer than this build (v${CASSETTE_VERSION}) — upgrade cowork-harness to re-record`);
      expect(readFileSync(cass).equals(before)).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("with no on-disk scenario it fails naming why — there is no readable embedded snapshot", async () => {
    const f = makeStubFixture(OK);
    try {
      const cass = await agedCassette(f, (c) => {
        c.cassetteVersion = 11;
        c.scenarioSource = "gone.yaml";
        (c.scenario as Record<string, unknown>).name = "no-such-scenario";
      });
      const rr = await cli(f, ["record", "--rerecord-stale", join(f.cwd, "cassettes"), "--from-embedded", "--output-format", "json"]);
      expect(rr.code).toBe(1);
      const env = JSON.parse(rr.stdout);
      const items = env.payload?.items ?? env.items;
      expect(items[0].status).toBe("failed");
      expect(items[0].error).toContain('no on-disk scenario found for "no-such-scenario"');
      expect(items[0].error).toContain("no embedded snapshot to fall back on");
      expect(items[0].error).toContain(`record <scenario.yaml> --out ${cass}`);
    } finally {
      f.cleanup();
    }
  }, 180_000);
});

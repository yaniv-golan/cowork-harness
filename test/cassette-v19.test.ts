// Cassette v19: an interpretation bump, not a shape or hashing one. A frozen `assert:` entry carrying `allow_max_turns`
// stamps v19, so a v18 reader refuses the cassette as too new (upgrade) instead of rejecting the key as unrecognized
// (re-record). The modifier acts on the replayed verdict with the new optional top-level `turnCap`; `timeout` rides
// beside it, informational. Every other recording stamps exactly what it did.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import {
  CASSETTE_VERSION,
  V19_ASSERT_FEATURES,
  cassetteSchemaUrl,
  readCassette,
  requiredVersionFor,
  type Cassette,
} from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

const schema = () => JSON.parse(readFileSync(join(process.cwd(), "schema", "cassette.v19.json"), "utf8"));

describe("cassette v19", () => {
  it("this build reads v19, and ships its schema next to v18's", () => {
    expect(CASSETTE_VERSION).toBeGreaterThanOrEqual(19);
    const s = schema();
    expect(s.$id).toBe(cassetteSchemaUrl(19));
    expect(s.title).toBe("cowork-harness cassette v19");
    expect(s.description).toContain("allow_max_turns");
    expect(existsSync(join(process.cwd(), "schema", "cassette.v18.json"))).toBe(true);
  });

  it("the schema carries the optional top-level turnCap and timeout, with the RunResult shapes", () => {
    const { properties: p, required } = schema();
    expect(p.turnCap.required).toEqual(["maxTurns", "source"]);
    expect(p.turnCap.properties.source.const).toBe("session");
    expect(p.timeout.required).toEqual(["ms", "source"]);
    expect(p.timeout.properties.source.enum).toEqual(["flag", "scenario", "runner"]);
    expect(required ?? []).not.toContain("turnCap");
    expect(required ?? []).not.toContain("timeout");
  });

  it("allow_max_turns stamps v19, alone or beside another key; its absence stamps exactly what it did", () => {
    const base = { prompt: "x", fidelity: "protocol" };
    expect(requiredVersionFor({ ...base, assert: [{ allow_max_turns: true }] })).toBe(19);
    expect(requiredVersionFor({ ...base, assert: [{ result: "error", allow_max_turns: true }] })).toBe(19);
    expect(requiredVersionFor({ ...base, assert: [{ result: "error" }] })).toBeLessThan(19);
    expect(requiredVersionFor({ fidelity: "protocol", legs: [] })).toBe(18);
  });

  it("each V19 feature predicate has a sample it matches, and a v18-era assertion it does not", () => {
    for (const f of V19_ASSERT_FEATURES) {
      expect(f({ allow_max_turns: true })).toBe(true);
      expect(f({ result: "error" })).toBe(false);
      expect(f(null)).toBe(false);
    }
  });

  it("a v18 recording, with no turnCap or timeout, still reads", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "v18-plain-")));
    try {
      const f = join(dir, "old.cassette.json");
      const c = {
        scenario: {
          name: "plain",
          baseline: "latest",
          session: "(inline)",
          fidelity: "protocol",
          prompt: "hi",
          answers: [],
          expect_denied: [],
          assert: [{ result: "error" }],
        } as unknown as Scenario,
        events: [JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 1 })],
        controlOut: [],
        cassetteVersion: 18,
        userVisibleRoots: ["outputs"],
        fingerprint: { baseline: loadBaseline("latest").appVersion, hashFormat: "jcs1" },
      } as unknown as Cassette;
      writeFileSync(f, JSON.stringify(c));
      const read = readCassette(f);
      expect("error" in read ? read.error : "ok").toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

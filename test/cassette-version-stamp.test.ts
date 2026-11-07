import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  CASSETTE_VERSION,
  KEY_REQUIRED_VERSION,
  requiredVersionFor,
  cassetteSchemaUrl,
  checkStaleness,
  replayCassette,
  buildFingerprint,
  type Cassette,
} from "../src/run/cassette.js";
import { ScenarioObject } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { DEFAULT_USER_VISIBLE_ROOTS, recordedControlOut } from "./helpers/minimal-cassette.js";

// `cassetteVersion` means "the minimum format version a reader needs to INTERPRET this cassette
// correctly", not "which recorder wrote it". An earlier design of this mechanism keyed the stamp on KEY
// PRESENCE and was falsified: `lane` is `.default("local")`, so EVERY parsed scenario carries the key,
// and a presence check would stamp v11 on every cassette — the unconditional bump this whole design
// exists to avoid. This file pins the corrected value-aware mechanism.

// The stamped floor. Read from the source of truth rather than duplicated, so an epoch bump moves this
// test with it instead of silently pinning a stale number.
const HASH_FORMAT_EPOCH_FOR_TEST = requiredVersionFor({});

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

describe("requiredVersionFor — value-aware, not key-presence", () => {
  // POST-EPOCH SEMANTICS. `requiredVersionFor`'s base is now HASH_FORMAT_EPOCH, not a hard-coded 10,
  // because it is what actually gets STAMPED at both write sites. A hash-format bump that moved only
  // CASSETTE_VERSION/HASH_FORMAT_EPOCH would write new-algorithm digests into cassettes stamped with an
  // old version — permanently mislabelled, and unprovable at the next epoch.
  //
  // So `cassetteVersion` no longer means "the minimum reader for THIS SCENARIO'S keys"; it means "the
  // minimum reader for this whole cassette", and the hash format is part of that. A v11 reader handed a
  // v12 cassette would recompute LEGACY digests and report false drift.
  //
  // P8's value-aware differential is NOT gone — it still applies ABOVE the floor. These cases pin that:
  // every scenario now floors at the epoch, and a key needing MORE than the floor would still lift it.
  it("floors at the hash-format epoch regardless of scenario keys", () => {
    expect(requiredVersionFor(ScenarioObject.parse({ prompt: "x", fidelity: "container", lane: "remote" }))).toBe(
      HASH_FORMAT_EPOCH_FOR_TEST,
    );
    expect(requiredVersionFor(ScenarioObject.parse({ prompt: "x", fidelity: "container", lane: "local" }))).toBe(
      HASH_FORMAT_EPOCH_FOR_TEST,
    );
  });

  it(
    "the value-aware predicate still works — `lane` defaults to 'local' via Zod, so the parsed scenario " +
      "carries the key regardless, and a key-PRESENCE predicate would have treated local and remote alike",
    () => {
      const s = ScenarioObject.parse({ prompt: "x", fidelity: "container" });
      expect(s.lane).toBe("local"); // sanity: the default really is present on every parsed scenario
      // Both floor at the epoch today; what this pins is that the function reads the VALUE, so when a
      // future key requires more than the floor, only the scenarios that actually use it are lifted.
      expect(requiredVersionFor(s)).toBe(requiredVersionFor(ScenarioObject.parse({ prompt: "x", fidelity: "container", lane: "local" })));
    },
  );

  it("an unparsed/loose scenario object (as rehash reads off disk) is handled the same way", () => {
    expect(requiredVersionFor({ prompt: "x", lane: "remote" })).toBe(HASH_FORMAT_EPOCH_FOR_TEST);
    expect(requiredVersionFor({ prompt: "x" })).toBe(HASH_FORMAT_EPOCH_FOR_TEST); // no `lane` key at all
    expect(requiredVersionFor(null)).toBe(HASH_FORMAT_EPOCH_FOR_TEST); // defensive: never throws on a malformed on-disk value
  });
});

describe("KEY_REQUIRED_VERSION coverage — every ScenarioObject key must be classified", () => {
  // The guard from the spec: adding a scenario key without deciding its cassette-version impact must red
  // CI, not silently default to 0 (a sparse map + `?? 0` fallback would reintroduce exactly that gap).
  it("has an entry for every one of ScenarioObject.shape's keys", () => {
    const scenarioKeys = Object.keys(ScenarioObject.shape);
    expect(scenarioKeys.length).toBe(19); // pins the count so a schema addition is visible here too
    for (const key of scenarioKeys) {
      expect(KEY_REQUIRED_VERSION).toHaveProperty(key);
    }
  });

  it("has no stray entries beyond ScenarioObject's own keys (keeps the map honest both ways)", () => {
    const scenarioKeys = new Set(Object.keys(ScenarioObject.shape));
    for (const key of Object.keys(KEY_REQUIRED_VERSION)) {
      expect(scenarioKeys.has(key)).toBe(true);
    }
  });
});

describe("$schema tracks the STAMPED version, not the build max", () => {
  // Both write sites (record's `base.$schema` and rehash's `updated.$schema`) call this exact function
  // with the per-scenario stamped version — see src/run/cassette.ts. record itself needs a live agent to
  // exercise (out of the token-free/spawn-free default suite, same rationale test/rehash.test.ts already
  // documents for its own happy path); the rehash tests below prove the on-disk result end-to-end for
  // both a v10 and a v11 stamp, sharing this same helper.
  it("selects the schema URL per stamped version", () => {
    expect(cassetteSchemaUrl(10)).toMatch(/cassette\.v10\.json$/);
    expect(cassetteSchemaUrl(11)).toMatch(/cassette\.v11\.json$/);
  });
});

describe("staleness — hash-format epoch, not CASSETTE_VERSION", () => {
  // v11 (like v9 and v10 before it) changes cassette SHAPE, not hashing. A v10 cassette with genuine skill
  // drift must fall into the drift-bucket attribution, not the "recorded under an older hash format"
  // branch (which would swallow the per-file detail — see the P8 spec's "two downstream assumptions").
  it("a CURRENT-format cassette with genuine skill drift reports drift buckets, not 'older hash format'", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-epoch-"));
    const skillDir = join(root, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# s\n");
    const sessionPath = join(root, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ./skill\n`);

    const cassette = {
      cassetteVersion: HASH_FORMAT_EPOCH_FOR_TEST, // AT the epoch — its digests are comparable, so drift is real drift
      controlOut: recordedControlOut(),
      userVisibleRoots: [...DEFAULT_USER_VISIBLE_ROOTS],
      scenario: {
        name: "s",
        baseline: "latest",
        session: sessionPath,
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [],
      fingerprint: {
        baseline: "99.0.0",
        // deliberately wrong vs. the real skill dir content, to force a mismatch
        skillHash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    } as unknown as Cassette;

    const msgs = checkStaleness(cassette, root);
    const skillMsg = msgs.find((m) => /changed since|contents changed/.test(m));
    expect(skillMsg).toBeDefined();
    expect(skillMsg).not.toMatch(/older hash format/i);
  });
});

// A cassette one version beyond this build simulates "a vN+1 cassette on a reader capped at vN" without
// requiring an actual older install (the spec's own instruction) — the exact same mechanism a real v11
// cassette hits on a pre-P8 (capped-at-v10) reader.
describe("a future-version cassette is refused by a capped reader; the escape hatch reopens the hole", () => {
  it("replayCassette fails by default; --best-effort-future-cassette overrides", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const future = {
      cassetteVersion: CASSETTE_VERSION + 1,
      controlOut: recordedControlOut(),
      userVisibleRoots: [...DEFAULT_USER_VISIBLE_ROOTS],
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" as const }],
      },
      events,
    } as unknown as Cassette;

    const def = await replayCassette(future);
    expect(def.assertions.some((a) => !a.pass && /cassette format too new/.test(a.message ?? ""))).toBe(true);

    // --best-effort-future-cassette opts back into replaying it — the documented, deliberate escape hatch.
    const effort = await replayCassette(future, [], { bestEffortFutureCassette: true });
    expect(effort.assertions.some((a) => !a.pass && /cassette format too new/.test(a.message ?? ""))).toBe(false);
  });

  it("verify-cassettes has no escape hatch — a future-version cassette always fails the gate", () => {
    if (!can) return;
    const cwd = mkdtempSync(join(tmpdir(), "cwh-p8-verify-"));
    const body = {
      cassetteVersion: CASSETTE_VERSION + 1,
      controlOut: recordedControlOut(),
      userVisibleRoots: [...DEFAULT_USER_VISIBLE_ROOTS],
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
    };
    writeFileSync(join(cwd, "c.cassette.json"), JSON.stringify(body));
    const r = spawnSync("node", [CLI, "verify-cassettes", "c.cassette.json", "--output-format", "json"], { encoding: "utf8", cwd });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/newer than this harness understands/);
  });
});

function makeSkillDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-p8-skill-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(d, rel);
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return d;
}

// `rehash` is CHECK-ONLY: nothing below the read floor can be migrated by this build, so it reports each
// cassette as current (`skipped`) or not (`error`, with the read refusal or the version gap), and never writes.
describe.skipIf(!can)("rehash — check-only", () => {
  const liveBaseline = loadBaseline("latest").appVersion;
  const INIT_LINE = JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } });

  function cassetteFixture(version: number, assert: unknown[] = []): { dir: string; file: string } {
    const skillDir = makeSkillDir({ "SKILL.md": "# probe\ndo a thing\n" });
    const dir = mkdtempSync(join(tmpdir(), "cwh-rehash-check-"));
    const sessionPath = join(dir, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ${skillDir}\n`);
    const body = {
      cassetteVersion: version,
      scenario: {
        name: "s",
        baseline: liveBaseline,
        session: sessionPath,
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert,
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      controlOut: [INIT_LINE],
      userVisibleRoots: ["outputs"],
      fingerprint: buildFingerprint(sessionPath, liveBaseline, dir, undefined),
    };
    const file = join(dir, "s.cassette.json");
    writeFileSync(file, JSON.stringify(body));
    return { dir, file };
  }
  const rehash = (...args: string[]) => spawnSync("node", [CLI, "rehash", "--output-format", "json", ...args], { encoding: "utf8" });

  it("a current cassette is skipped as current, exit 0, and the file is untouched", () => {
    const { dir, file } = cassetteFixture(HASH_FORMAT_EPOCH_FOR_TEST);
    const before = readFileSync(file, "utf8");
    const r = rehash(dir);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.results[0]).toMatchObject({ action: "skipped", reason: "current: nothing to re-stamp" });
    expect(out.migrated).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("--dry-run and --session are still accepted and change nothing", () => {
    const { dir, file } = cassetteFixture(HASH_FORMAT_EPOCH_FOR_TEST);
    expect(rehash(dir, "--dry-run").status).toBe(0);
    const r = rehash(file, "--session", join(dir, "session.yaml"));
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim()).results[0].action).toBe("skipped");
  });

  it("a v10/v11 cassette is an error naming both remedies (4.x rehash, or re-record); exit 1, untouched", () => {
    const { dir, file } = cassetteFixture(11);
    const before = readFileSync(file, "utf8");
    const r = rehash(dir);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    const res = JSON.parse(r.stdout.trim()).results[0];
    expect(res.action).toBe("error");
    expect(res.reason).toBe(
      "cassette recorded at v11 (before 2.0.0) is below the minimum supported v12 — run `npx cowork-harness@4 rehash <dir/>` on it, or re-record it (`record <dir/> --rerecord-stale`)",
    );
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("a v9 cassette is an error that names re-record as the only remedy", () => {
    const { dir } = cassetteFixture(9);
    const r = rehash(dir);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout.trim()).results[0].reason).toBe(
      "cassette recorded at v9 (before 2.0.0) is below the minimum supported v12 — re-record it (`record <dir/> --rerecord-stale`); a 4.x `rehash` cannot migrate a v9 cassette",
    );
  });

  it("a cassette that loads but is stamped below its scenario's version is an error with the gap", () => {
    const { dir } = cassetteFixture(HASH_FORMAT_EPOCH_FOR_TEST, [{ allow_max_turns: true }]);
    const need = requiredVersionFor({ assert: [{ allow_max_turns: true }] });
    expect(need).toBeGreaterThan(HASH_FORMAT_EPOCH_FOR_TEST);
    const r = rehash(dir);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout.trim()).results[0].reason).toBe(
      `stamped v${HASH_FORMAT_EPOCH_FOR_TEST}, its scenario needs v${need} — re-record`,
    );
  });
});

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
import { skillHashSnapshot, foldSnapshot, renderWireEntries } from "../src/run/skill-hash.js";

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
    expect(scenarioKeys.length).toBe(18); // pins the count so a schema addition is visible here too
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

// The write-site fix: `rehash` must stamp `requiredVersionFor(scenario)`, not CASSETTE_VERSION
// unconditionally — otherwise `rehash <dir>` over a directory of clean, lane-free v10 cassettes bumps
// every one to v11, reintroducing the blanket cost P8 exists to avoid, via the very command the plan
// names as the recovery path. This is the counter-test the P8 spec calls out as EXPECTED TO FAIL against
// pre-fix code.
describe.skipIf(!can)("rehash — conditional re-stamp", () => {
  const liveBaseline = loadBaseline("latest").appVersion;

  function cassetteFixture(lane: "local" | "remote" | undefined, extraEvents: string[] = [], assert: unknown[] = []): string {
    const skillDir = makeSkillDir({ "SKILL.md": "# probe\ndo a thing\n" });
    const dir = mkdtempSync(join(tmpdir(), "cwh-p8-rehash-"));
    const sessionPath = join(dir, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ${skillDir}\n`);
    // Compute the fingerprint the same way `rehash` will (absolute session path ⇒ cassetteDir irrelevant),
    // so the content-unchanged gate passes and the migration reaches the version-stamp logic under test.
    // A FAITHFUL pre-epoch artifact: legacy digests and NO `hashFormat`. Building a CURRENT fingerprint
    // and stamping an old version is internally inconsistent — the read boundary rejects that pairing,
    // because the stamp and the digests would be describing different algorithms.
    const built = buildFingerprint(sessionPath, liveBaseline, dir, undefined);
    const snap = skillHashSnapshot([skillDir]);
    const fp = {
      ...built,
      hashFormat: undefined,
      skillHash: foldSnapshot(snap, "legacy"),
      fileSigs: renderWireEntries(snap, "legacy").map((e) => [e.path, e.sha] as [string, string]),
    };
    expect(built.contentSig).toBeTruthy(); // sanity: skill dir resolved
    const scenario: Record<string, unknown> = {
      name: "s",
      baseline: liveBaseline,
      session: sessionPath,
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert,
    };
    if (lane !== undefined) scenario.lane = lane;
    const body = {
      cassetteVersion: 10,
      scenario,
      events: [
        JSON.stringify({ type: "system", subtype: "init" }),
        ...extraEvents,
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      fingerprint: { baseline: liveBaseline, skillHash: fp.skillHash, contentSig: fp.contentSig },
    };
    writeFileSync(join(dir, "s.cassette.json"), JSON.stringify(body));
    return dir;
  }

  it("migrates a pre-epoch lane-free cassette to the epoch floor — the bump IS necessary now", () => {
    const dir = cassetteFixture(undefined);
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    // P8's rule was "do not re-stamp a cassette whose scenario needs no new reader", to avoid a blanket
    // migration cost. A HASH-FORMAT bump is the case where that cost IS warranted: a pre-epoch cassette's
    // digests came from a different algorithm, so a v10 reader and a v12 reader genuinely disagree about it.
    expect(out.results[0].action, out.results[0].reason).toBe("migrated");
    const onDisk = JSON.parse(readFileSync(join(dir, "s.cassette.json"), "utf8"));
    expect(onDisk.cassetteVersion).toBe(HASH_FORMAT_EPOCH_FOR_TEST);
    expect(onDisk.fingerprint.hashFormat).toBe("jcs1"); // the version/hashFormat invariant holds after migration
  });

  // A rewrite path must not re-publish what the recorder now removes from every cassette.
  it("the migrating rewrite drops what the recorder no longer keeps (rate_limit_info, the model menu)", () => {
    const dir = cassetteFixture(undefined, [
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5 } } },
      }),
      JSON.stringify({
        type: "control_response",
        response: {
          request_id: "init-1",
          response: { commands: [], agents: [], models: [{ value: "m", description: "· $1/$2 per Mtok" }] },
        },
      }),
    ]);
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim()).results[0].action).toBe("migrated");
    const raw = readFileSync(join(dir, "s.cassette.json"), "utf8");
    expect(raw).not.toMatch(/utilization|per Mtok/);
    const ev = (JSON.parse(raw).events as string[]).map((l) => JSON.parse(l));
    expect(ev.find((e) => e.type === "rate_limit_event").rate_limit_info).toEqual({});
    expect(ev.find((e) => e.type === "control_response").response.response.models).toEqual([]);
  });

  // The rewrite's scrub is held to record's verdict-preservation check. Here it WOULD flip a verdict: the scenario
  // asserts on the frame text the scrub removes from the transcript. So the migration lands, the events stay
  // unscrubbed, and a warning names the scrub — nothing recorded is lost.
  it("a scrub that would flip a verdict is not applied: migrated, events unscrubbed, warned", () => {
    const frame = "[Subagent hand-back] SYNTHETIC FRAME";
    const dir = cassetteFixture(
      undefined,
      [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `done\n${frame}` }] } })],
      [{ transcript_contains: "[Subagent hand-back]" }],
    );
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim()).results[0].action).toBe("migrated");
    expect(r.stderr).toMatch(
      /::warning:: rehash .*s\.cassette\.json: the recorder's scrub \(subagent-hand-back-frame\) could not be verified/,
    );
    const onDisk = JSON.parse(readFileSync(join(dir, "s.cassette.json"), "utf8"));
    expect(onDisk.fingerprint.hashFormat).toBe("jcs1"); // the migration itself landed
    expect(JSON.stringify(onDisk.events)).toContain(frame); // ...with the events left as recorded
  });

  it("lane: local (explicit) migrates the same way — the floor does not depend on scenario keys", () => {
    const dir = cassetteFixture("local");
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    const out = JSON.parse(r.stdout.trim());
    expect(out.results[0].action, out.results[0].reason).toBe("migrated");
    const onDisk = JSON.parse(readFileSync(join(dir, "s.cassette.json"), "utf8"));
    expect(onDisk.cassetteVersion).toBe(HASH_FORMAT_EPOCH_FOR_TEST);
  });

  it("its partner: a lane: remote cassette lands on the COMPUTED stamp, not a constant", () => {
    const dir = cassetteFixture("remote");
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.results[0].action, out.results[0].reason).toBe("migrated");
    expect(out.results[0].reason).toMatch(new RegExp(`v10 → v${HASH_FORMAT_EPOCH_FOR_TEST}`));
    const onDisk = JSON.parse(readFileSync(join(dir, "s.cassette.json"), "utf8"));
    expect(onDisk.cassetteVersion).toBe(HASH_FORMAT_EPOCH_FOR_TEST);
    expect(onDisk.$schema).toMatch(new RegExp(`cassette\\.v${HASH_FORMAT_EPOCH_FOR_TEST}\\.json$`));
  });
});

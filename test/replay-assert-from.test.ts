import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadBaseline } from "../src/baseline.js";
import { CASSETTE_VERSION, RECORDING_SHAPING_FIELDS } from "../src/run/cassette.js";

// On-disk re-assert opt-in + per-result verdict — exercised through the BUILT CLI so the
// cmdReplay→replayCassette wiring is covered (a unit test on replayCassette can't see the flag plumbing).
// Token-free and spawn-only: replay needs no agent/Docker. Needs dist/cli.js (the `ci` script builds first).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const LIVE = loadBaseline("latest").appVersion;

function tmp(): string {
  // NESTED one level inside the mkdtemp root on purpose. A cassette here can record a `../`-relative
  // `session:` (see "a sessioned scenario does NOT spuriously hard-fail"), which production resolves with
  // a single join against the cassette's own dir. Written straight into `<tmpdir>/cc-reassert-X/`, that
  // lands on `$TMPDIR/sessions/…` — world-writable, outside this test's control, and in practice
  // populated on developer machines. It does not change a verdict here today (session is excluded from
  // the drift set), but the isolation should not depend on that staying true: the same shape one level
  // up silently disarmed 17 cases in test/session-override.test.ts.
  const root = mkdtempSync(join(tmpdir(), "cc-reassert-"));
  const d = join(root, "nested");
  mkdirSync(d);
  return d;
}
function write(cwd: string, name: string, body: string): void {
  writeFileSync(join(cwd, name), body);
}
function replay(cwd: string, args: string[]) {
  const r = spawnSync("node", [CLI, "replay", ...args], { encoding: "utf8", cwd });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* text mode */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

const events = (text = "hello there", endQuestion = false) => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: endQuestion ? "which file did you mean?" : text }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

// Frozen cassette factory. `endQuestion` makes the run end on a "?" with no tools → stalledOnQuestion on replay.
// `name` MUST match the basename of the sibling YAML for --reassert auto-resolution (_findScenarioOnDisk keys
// on scenario.name → <name>.yaml), so it is explicit here.
function cassetteJson(opts: {
  name?: string;
  assert?: unknown[];
  prompt?: string;
  fingerprint?: object;
  endQuestion?: boolean;
  session?: string;
  lane?: "local" | "remote";
}): string {
  return JSON.stringify({
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: opts.name ?? "c",
      baseline: "latest",
      session: opts.session ?? "(inline)",
      fidelity: "container",
      ...(opts.lane ? { lane: opts.lane } : {}),
      prompt: opts.prompt ?? "do the thing",
      answers: [],
      expect_denied: [],
      assert: opts.assert ?? [{ result: "success" }],
    },
    events: events("hello there", opts.endQuestion ?? false),
    controlOut: [],
    // Stamped at CASSETTE_VERSION, so a hand-built fingerprint must declare the current hash format —
    // the read boundary refuses a stamp/format mismatch, because the two would describe different algorithms.
    ...(opts.fingerprint ? { fingerprint: { hashFormat: "jcs1", ...opts.fingerprint } } : {}),
  });
}

// Minimal sibling scenario YAML (parseScenarioFile-valid). `name`/`prompt` default to match the cassette.
function scenarioYaml(opts: { name?: string; prompt?: string; assert?: string; session?: string; lane?: "local" | "remote" } = {}): string {
  return (
    `name: ${opts.name ?? "c"}\n` +
    `fidelity: container\nprompt: ${opts.prompt ?? "do the thing"}\n` +
    (opts.session ? `session: ${opts.session}\n` : "") +
    (opts.lane ? `lane: ${opts.lane}\n` : "") +
    `assert:\n${opts.assert ?? "  - result: success\n"}`
  );
}

describe.skipIf(!can)("replay default — frozen assertions drive; only the SILENT no-op dies", () => {
  it("verdict is UNCHANGED when a sibling YAML's assert: differs (frozen copy still authoritative)", () => {
    const cwd = tmp();
    // Frozen assert passes; the sibling's would FAIL. Default replay must still be green (frozen drives).
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ transcript_contains: "hello" }] }));
    write(cwd, "c.yaml", scenarioYaml({ assert: "  - transcript_contains: NEVER_PRESENT\n" }));
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
  });

  it("emits a discoverability ::notice:: naming --assert-from when the sibling assert differs", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "c.yaml", scenarioYaml({ assert: "  - transcript_contains: hello\n" }));
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/different `assert:` block/);
    expect(r.stderr).toMatch(/--assert-from/);
  });

  it("NO notice when the sibling assert matches the frozen copy", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "c.yaml", scenarioYaml({ assert: "  - result: success\n" }));
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/different `assert:` block/);
  });

  it("a bad/mid-edit sibling YAML never hard-errors the default lane (decoration only)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "c.yaml", "this: is: not: valid: yaml: [");
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(r.code).toBe(0); // frozen asserts still drive
    expect(r.json?.ok).toBe(true);
  });

  it("live-only no_lost_write_back is STRIPPED on replay (loud-skip, not a hard-fail on the embedding cassette)", () => {
    const cwd = tmp();
    // A cassette embedding no_lost_write_back. On replay there is no authoredFiles/preRunHashes, so if the
    // key were EVALUATED it would fail-closed (could-not-verify) and red the whole replay. Because it is
    // classified LIVE_ONLY_KEYS it is stripped before evaluation — the sibling transcript_contains drives.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ no_lost_write_back: true }, { transcript_contains: "hello" }] }));
    write(cwd, "c.yaml", scenarioYaml({ assert: "  - no_lost_write_back: true\n  - transcript_contains: hello\n" }));
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
  });
});

// A sibling that fails SCHEMA validation used to be swallowed whole by the decoration block's catch, so a
// scenario carrying a key from a newer release replayed with no signal at all — the loader's loud rejection
// was invisible through `replay`, and a consumer reasonably concluded the runtime silently accepted the key.
// The distinction that matters: a HALF-WRITTEN sibling must stay silent (that is what the catch is for), a
// SCHEMA-INVALID one must not. Both directions are pinned here; loosening either reds a case.
describe.skipIf(!can)("replay default — a schema-invalid sibling is announced, a half-written one is not", () => {
  it("emits a ::notice:: naming the offending key when the sibling fails schema validation", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({}));
    // `someFutureKey` stands in for a key from a newer release — the exact shape of the original report.
    write(cwd, "c.yaml", scenarioYaml() + "someFutureKey: remote\n");
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.stderr).toMatch(/does not load/);
    expect(r.stderr).toMatch(/someFutureKey/);
    // Points at the loader check rather than leaving the reader to find it.
    expect(r.stderr).toMatch(/--dry-run/);
  });

  it("the notice does NOT move the verdict or the exit code (decoration only)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ transcript_contains: "hello" }] }));
    write(cwd, "c.yaml", scenarioYaml() + "someFutureKey: remote\n");
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
  });

  it("stays SILENT when the sibling is unparseable YAML (the half-written-file property)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({}));
    write(cwd, "c.yaml", 'name: c\nprompt: "unterminated\n  - [oops\n');
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/does not load/);
  });

  it("stays SILENT when there is no sibling at all", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({}));
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/does not load/);
  });

  it("a schema-invalid sibling suppresses the assert-drift notice (there is nothing parsed to compare)", () => {
    const cwd = tmp();
    // The sibling's assert: differs AND the file is schema-invalid. Only the load notice can fire — this
    // pins that the drift notice's absence here is understood, not an accident of ordering.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "c.yaml", scenarioYaml({ assert: "  - transcript_contains: hello\n" }) + "someFutureKey: remote\n");
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.stderr).toMatch(/does not load/);
    expect(r.stderr).not.toMatch(/different `assert:` block/);
  });
});

describe.skipIf(!can)("replay opt-in — --assert-from / --reassert, safe by construction", () => {
  it("the founder loop: --assert-from adding allow_stall flips a stalled run green", () => {
    const cwd = tmp();
    // Frozen run stalled on a question with no allow_stall → default replay FAILS.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }], endQuestion: true }));
    const base = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(base.code).toBe(1);
    expect(base.json?.ok).toBe(false);
    // On-disk adds allow_stall (no recording-shaping drift) → re-assert greens it.
    write(cwd, "edit.yaml", scenarioYaml({ assert: "  - result: success\n  - allow_stall: true\n" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
  });

  it("a sessioned scenario does NOT spuriously hard-fail (session excluded from drift)", () => {
    const cwd = tmp();
    // Frozen session stored cassette-relative; on-disk session resolves absolute — a naive string-equal would
    // brick this. session is excluded from the drift set, so re-assert proceeds.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }], session: "../sessions/s.yaml" }));
    write(cwd, "edit.yaml", scenarioYaml({ assert: "  - result: success\n", session: "s.yaml" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
  });

  it("recording-shaping drift (prompt) HARD-FAILS and names the field", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ prompt: "do the thing" }));
    write(cwd, "edit.yaml", scenarioYaml({ prompt: "a totally different task" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/prompt/);
    expect(r.stderr).toMatch(/drifted from the recording/);
  });

  // P6: `lane` conditions assertion outcomes (src/assert.ts) but was missing from recordingShapingDrift's
  // comparison set — a lane-flipped sibling used to silently re-check under the WRONG delivery contract.
  it("recording-shaping drift (lane) HARD-FAILS and names the field", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ lane: "local" }));
    write(cwd, "edit.yaml", scenarioYaml({ lane: "remote" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/lane/);
    expect(r.stderr).toMatch(/drifted from the recording/);
  });

  it("a matching lane (explicit on both sides, or omitted on both — defaults to local) does NOT drift", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ lane: "remote" }));
    write(cwd, "edit.yaml", scenarioYaml({ lane: "remote" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);

    write(cwd, "c2.cassette.json", cassetteJson({ name: "c2" })); // lane omitted (defaults to local)
    write(cwd, "edit2.yaml", scenarioYaml({ name: "c2" })); // lane omitted too
    const r2 = replay(cwd, ["c2.cassette.json", "--assert-from", "edit2.yaml", "--output-format", "json"]);
    expect(r2.code).toBe(0);
    expect(r2.json?.ok).toBe(true);
  });

  it("recording-shaping drift in answers / baseline / skills each HARD-FAILS and names the field", () => {
    const cwd = tmp();
    // Frozen carries explicit answers/baseline/skills; each edited-in-isolation sibling must hard-fail.
    const frozen = JSON.stringify({
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "c",
        baseline: "1.2.3",
        session: "(inline)",
        fidelity: "container",
        prompt: "do the thing",
        answers: [{ when_question: "go?", choose: "Yes" }],
        skills: ["alpha"],
        expect_denied: [],
        assert: [{ result: "success" }],
      },
      events: events(),
      controlOut: [],
    });
    write(cwd, "c.cassette.json", frozen);
    const base = "name: c\nfidelity: container\nprompt: do the thing\n";
    const cases: Array<[string, string]> = [
      [
        "answers",
        base + "baseline: 1.2.3\nskills:\n  - alpha\nanswers:\n  - when_question: go?\n    choose: No\nassert:\n  - result: success\n",
      ],
      [
        "baseline",
        base + "baseline: 9.9.9\nskills:\n  - alpha\nanswers:\n  - when_question: go?\n    choose: Yes\nassert:\n  - result: success\n",
      ],
      [
        "skills",
        base + "baseline: 1.2.3\nskills:\n  - beta\nanswers:\n  - when_question: go?\n    choose: Yes\nassert:\n  - result: success\n",
      ],
    ];
    for (const [field, yaml] of cases) {
      write(cwd, "edit.yaml", yaml);
      const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml"]);
      expect(r.code, `drift in ${field} should hard-fail`).not.toBe(0);
      expect(r.stderr, `error should name ${field}`).toMatch(new RegExp(field));
    }
  });

  it("a matching sibling (answers/baseline/skills all unchanged) does NOT spuriously drift-fail", () => {
    const cwd = tmp();
    write(
      cwd,
      "c.cassette.json",
      JSON.stringify({
        cassetteVersion: CASSETTE_VERSION,
        scenario: {
          name: "c",
          baseline: "1.2.3",
          session: "(inline)",
          fidelity: "container",
          prompt: "do the thing",
          answers: [{ when_question: "go?", choose: "Yes" }],
          skills: ["alpha"],
          expect_denied: [],
          assert: [{ result: "success" }],
        },
        events: events(),
        controlOut: [],
      }),
    );
    write(
      cwd,
      "edit.yaml",
      "name: c\nfidelity: container\nprompt: do the thing\nbaseline: 1.2.3\nskills:\n  - alpha\nanswers:\n  - when_question: go?\n    choose: Yes\nassert:\n  - transcript_contains: hello\n",
    );
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
  });

  it("skill staleness HARD-FAILS on the opt-in path WITHOUT --strict", () => {
    const cwd = tmp();
    // A recorded skillHash over an unresolvable (inline) session → `unverifiable-skill` staleness (a member of
    // SKILL_DRIFT_CLASSES, same gate as a real `skill` content drift — that real-drift escalation is itself
    // covered in replay-staleness-json.test.ts). Default replay only WARNs; --assert-from implies
    // --fail-on-skill-drift → it must FAIL, and the failure must be ATTRIBUTABLE to staleness (not some
    // unrelated throw), so we assert the signal text.
    write(
      cwd,
      "c.cassette.json",
      cassetteJson({ assert: [{ result: "success" }], fingerprint: { baseline: LIVE, skillHash: "deadbeef" } }),
    );
    write(cwd, "edit.yaml", scenarioYaml({ assert: "  - result: success\n" }));
    const dflt = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    // CHANGED IN 2.0.0: `unverifiable-skill` now fails the DEFAULT verdict too — "could not be checked"
    // is not "checked and unchanged". The default/opt-in contrast this test was built around still holds
    // for `skill` / `shared-root`, which continue to require --fail-on-skill-drift.
    expect(dflt.code).not.toBe(0);
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml", "--output-format", "json"]);
    expect(r.code).not.toBe(0); // opt-in lane: skill drift is a hard fail
    expect(r.json?.ok).toBe(false);
    const signals = r.json?.results?.[0]?.verdict?.signals ?? [];
    expect(signals.some((s: any) => /skill|stale/i.test(s.message))).toBe(true); // failure is the staleness escalation, not an unrelated error
  });

  it("the notice does NOT claim the session/model is verified (it isn't drift-checked or fingerprinted)", () => {
    const cwd = tmp();
    // The model lives in the session, which is excluded from the drift set and never fingerprinted — so the
    // notice must not blanket-claim "recording-shaping fields verified unchanged"; it must flag the session gap.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "edit.yaml", scenarioYaml({ assert: "  - result: success\n" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml"]);
    expect(r.stderr).not.toMatch(/recording-shaping fields verified unchanged/); // the over-broad claim is gone
    expect(r.stderr).toMatch(/session.*NOT verified/); // and the gap is stated
  });

  it("a fingerprint-less cassette WARNS that skill drift is unverifiable on --assert-from (no false reassurance)", () => {
    const cwd = tmp();
    // No fingerprint → computeStaleness has nothing to escalate. The path must NOT claim "skill-drift will
    // hard-fail"; it must warn the guard is inert so the author isn't falsely reassured.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "edit.yaml", scenarioYaml({ assert: "  - result: success\n" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml"]);
    expect(r.stderr).toMatch(/skill-content drift can NOT be verified|no skill fingerprint/);
    expect(r.stderr).not.toMatch(/skill-drift will hard-fail/);
  });

  it("an invalid --assert-from file is a hard error for that cassette, attributed to the parse", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "bad.yaml", "name: c\nprompt: x\nassert:\n  - oops: [");
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "bad.yaml"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/bad\.yaml/); // the error names the on-disk file the user pointed at
  });

  it("--reassert resolves each cassette's own sibling and re-asserts against it (happy path)", () => {
    const cwd = tmp();
    // Frozen assert FAILS (transcript_contains a string not present); the sibling fixes it to a passing one.
    // Green can ONLY come from --reassert resolving c.yaml and swapping in its assert.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ transcript_contains: "NOT_IN_TRANSCRIPT" }] }));
    write(cwd, "c.yaml", scenarioYaml({ assert: "  - transcript_contains: hello\n" }));
    const base = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(base.json?.ok).toBe(false); // frozen assert fails
    const r = replay(cwd, ["c.cassette.json", "--reassert", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.results?.[0]?.result).toBe("success"); // the swapped-in sibling assert was actually evaluated
  });

  it("--reassert over a dir keeps going when one sibling is invalid (batch not aborted)", () => {
    const cwd = tmp();
    // Names MUST match siblings for auto-resolution. c1 has an invalid sibling → per-cassette parse error;
    // c2 has a valid matching sibling → still evaluated to success (the bad one did not abort the walk).
    write(cwd, "c1.cassette.json", cassetteJson({ name: "c1", assert: [{ result: "success" }] }));
    write(cwd, "c1.yaml", "name: c1\nprompt: do the thing\nassert:\n  - oops: [");
    write(cwd, "c2.cassette.json", cassetteJson({ name: "c2", assert: [{ result: "success" }] }));
    write(cwd, "c2.yaml", scenarioYaml({ name: "c2", assert: "  - result: success\n" }));
    const r = replay(cwd, [".", "--reassert", "--output-format", "json"]);
    const outcomes = (r.json?.results ?? []).map((x: any) => x.result);
    expect(outcomes.length).toBe(2); // both tallied — the bad one did not abort the walk
    expect(outcomes.filter((o: string) => o === "error").length).toBe(1); // c1's invalid sibling → one per-file error
    expect(outcomes.filter((o: string) => o === "success").length).toBe(1); // c2's healthy sibling → still evaluated, not skipped
    expect(r.code).not.toBe(0); // overall non-zero because c1 errored
  });

  it("warns per-key for a newly-added on-disk assert key that can't be checked on this cassette", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] })); // no artifact manifest
    write(cwd, "edit.yaml", scenarioYaml({ assert: "  - result: success\n  - file_exists: outputs/x.json\n" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml"]);
    expect(r.stderr).toMatch(/file_exists.*not checkable/);
  });

  it("an uncheckable added key is SKIPPED, not failed — verdict tracks only the checkable keys", () => {
    const cwd = tmp();
    // file_exists (no manifest) would FAIL if evaluated; it must be stripped, leaving the green content key.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "edit.yaml", scenarioYaml({ assert: "  - transcript_contains: hello\n  - file_exists: outputs/missing.json\n" }));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml", "--output-format", "json"]);
    expect(r.json?.ok).toBe(true); // the swapped block's checkable half passed; the live-only key was skipped, not failed
    expect(r.stderr).toMatch(/skipped \d+ filesystem\/egress/); // replayCassette's own aggregate skip warning still fires post-swap
  });

  it("warns that an edited on-disk expect_denied is sourced but inert on replay (live-only)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(
      cwd,
      "edit.yaml",
      "name: c\nfidelity: container\nprompt: do the thing\nexpect_denied:\n  - evil.example.com\nassert:\n  - result: success\n",
    );
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml"]);
    expect(r.stderr).toMatch(/expect_denied.*live-only/);
  });

  it("--assert-from and --reassert are mutually exclusive (usage error, exit 2)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({}));
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "x.yaml", "--reassert"]);
    expect(r.code).toBe(2);
  });
});

describe.skipIf(!can)("replay — per-result verdict in the JSON envelope", () => {
  it("each results[] entry carries verdict {pass, signals, guards}", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    const v = r.json?.results?.[0]?.verdict;
    expect(v).toBeTruthy();
    expect(v.pass).toBe(true);
    expect(Array.isArray(v.signals)).toBe(true);
    expect(Array.isArray(v.guards)).toBe(true);
    expect(r.json?.ok).toBe(true);
  });

  it("an all-green-assertions run that stalled is verdict.pass=false with a `stalled` signal", () => {
    const cwd = tmp();
    // assertion passes, but the run stalled on a question → ok:false purely on the signal.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ transcript_contains: "which file" }], endQuestion: true }));
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    const res = r.json?.results?.[0];
    expect(res.assertions.every((a: any) => a.pass)).toBe(true); // all assertions green
    expect(res.verdict.pass).toBe(false); // ...yet the run failed
    expect(res.verdict.signals.some((s: any) => s.code === "stalled")).toBe(true);
    expect(r.json?.ok).toBe(false); // top-level ok == every(verdict.pass)
  });
});

// P6: the three sites that enumerate the recording-shaping drift set (the --reassert notice, `replay --help`,
// and the `cmdReplay` doc comment) must all name every field actually compared by `recordingShapingDrift` —
// including `lane`, which was missing from all three before this fix (two of the three were ALSO already
// stale, omitting `fidelity`/`requires_capabilities`). Derived from the single exported `RECORDING_SHAPING_FIELDS`
// list so the enumeration can't drift a fourth time.
describe("P6 — recording-shaping drift enumeration derives from RECORDING_SHAPING_FIELDS", () => {
  it("RECORDING_SHAPING_FIELDS includes `lane` and `workspace_fixture` alongside the other six authored fields", () => {
    expect([...RECORDING_SHAPING_FIELDS].sort()).toEqual(
      ["prompt", "baseline", "fidelity", "lane", "answers", "skills", "requires_capabilities", "workspace_fixture"].sort(),
    );
  });

  it.skipIf(!can)("the --reassert notice names every field in RECORDING_SHAPING_FIELDS", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ transcript_contains: "NOT_IN_TRANSCRIPT" }] }));
    write(cwd, "c.yaml", scenarioYaml({ assert: "  - transcript_contains: hello\n" }));
    const r = replay(cwd, ["c.cassette.json", "--reassert"]);
    for (const field of RECORDING_SHAPING_FIELDS) expect(r.stderr, `notice should name ${field}`).toContain(field);
  });

  it.skipIf(!can)("`replay --help` names every field in RECORDING_SHAPING_FIELDS in the --assert-from/--reassert line", () => {
    const r = spawnSync("node", [CLI, "replay", "--help"], { encoding: "utf8", cwd: tmp() });
    const text = (r.stderr || "") + (r.stdout || "");
    for (const field of RECORDING_SHAPING_FIELDS) expect(text, `--help should name ${field}`).toContain(field);
  });

  it("the cmdReplay doc comment above `replay <file|dir>` in src/cli.ts's cassette.ts names every field", () => {
    const src = readFileSync(resolve("src/run/cassette.ts"), "utf8");
    const start = src.indexOf("/** `replay <file|dir>`");
    const end = src.indexOf("*/", start);
    expect(start, "could not locate the cmdReplay doc comment").toBeGreaterThan(-1);
    const block = src.slice(start, end);
    for (const field of RECORDING_SHAPING_FIELDS) expect(block, `doc comment should name ${field}`).toContain(field);
  });

  // The shipped skill is a FOURTH hand-maintained copy of this enumeration, and the one an agent actually
  // reads. It went stale exactly the way the three in-repo copies had — listing six fields while the guard
  // compared seven — so a reader would not learn that a lane flip is caught. Consolidating the code copies
  // without pinning this one would have left the drift live in the highest-traffic surface.
  it("the shipped skill's gotcha-17 drift list names every field (references/gotchas.md is a fourth copy)", () => {
    const skill = readFileSync(resolve(".claude/skills/cowork-harness/references/gotchas.md"), "utf8");
    const start = skill.indexOf("17. **Editing `scenarios/*.yaml`");
    expect(start, "could not locate gotcha 17 in references/gotchas.md").toBeGreaterThan(-1);
    const gotcha = skill.slice(start, skill.indexOf("\n18. ", start));
    // Bound to the DRIFT-LIST sentence, not the whole gotcha. Scoping only to gotcha 17 makes this test
    // decoration: its "*Why:*" sentence already names `lane:` among the frozen keys, so a `toContain("lane")`
    // over the whole block passes even when the drift list itself omits it — verified by mutation. The
    // slash-delimited run of backticked field names is the thing that must stay in sync.
    const list = /hard-fails\*\* if\s+([^]*?)\s+or the skill content/.exec(gotcha)?.[1];
    expect(list, "could not locate gotcha 17's drift-field list").toBeTruthy();
    for (const field of RECORDING_SHAPING_FIELDS) expect(list, `gotcha 17's drift list should name ${field}`).toContain(`\`${field}\``);
  });
});

// P2: an unknown top-level key on the FROZEN scenario is invisible to replay by design (looseObject
// passthrough) — but that silence stops being harmless once the cassette's own cassetteVersion says a
// newer build wrote it (this build may not understand what the key means). Fires ONLY when the cassette
// is future-versioned, paired with the version signal rather than diffed on every replay — see the P2
// design note in src/run/cassette.ts (avoids per-replay spam from a future release's new DEFAULTED key).
describe.skipIf(!can)("P2 — unknown top-level frozen-scenario key on a future-version cassette", () => {
  function futureCassetteWithExtraKey(extraKeys: Record<string, unknown>): string {
    return JSON.stringify({
      cassetteVersion: CASSETTE_VERSION + 1,
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "do the thing",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" }],
        ...extraKeys,
      },
      events: events("hello there", false),
      controlOut: [],
    });
  }

  it("notices the unknown key by name, without --best-effort-future-cassette", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", futureCassetteWithExtraKey({ someFutureKey: "remote" }));
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.stderr).toMatch(/unknown top-level key/);
    expect(r.stderr).toContain("someFutureKey");
  });

  it("verdict and exit code are UNCHANGED by the notice — identical to the same cassette without the extra key", () => {
    const cwd = tmp();
    write(cwd, "with.cassette.json", futureCassetteWithExtraKey({ someFutureKey: "remote" }));
    write(cwd, "without.cassette.json", futureCassetteWithExtraKey({}));
    const withExtra = replay(cwd, ["with.cassette.json", "--best-effort-future-cassette", "--output-format", "json"]);
    const withoutExtra = replay(cwd, ["without.cassette.json", "--best-effort-future-cassette", "--output-format", "json"]);
    expect(withExtra.code).toBe(withoutExtra.code);
    expect(withExtra.json?.ok).toBe(withoutExtra.json?.ok);
    expect(withExtra.json?.results?.[0]?.verdict).toEqual(withoutExtra.json?.results?.[0]?.verdict);
    // The notice appears only on the cassette that actually carries the extra key.
    expect(withExtra.stderr).toContain("someFutureKey");
    expect(withoutExtra.stderr).not.toMatch(/unknown top-level key/);
  });

  // The two halves of the documented contract (references/authoring.md, docs/scenario.md). A key that changes
  // what a verdict means lifts the recorder's stamp, so THIS reader sees a future cassette and refuses it —
  // it does not evaluate it green with the key ignored.
  it("REFUSES the future-version cassette without the override (a meaning-changing key is never silently ignored)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", futureCassetteWithExtraKey({ someFutureKey: "remote" }));
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(r.code).not.toBe(0);
    expect(r.json?.ok).toBe(false);
    expect(JSON.stringify(r.json)).toMatch(/cassette format too new/);
  });

  // …and a meaning-neutral key (stamped `() => 0`) leaves the stamp at this build's version, so the cassette
  // replays exactly as if the key were absent: ignored by design, the forward tolerance of the frozen scenario.
  it("a same-version cassette carrying an extra key replays GREEN, identical to one without it (ignored by design)", () => {
    const cwd = tmp();
    const withKey = JSON.parse(futureCassetteWithExtraKey({ someNeutralKey: "x" }));
    withKey.cassetteVersion = CASSETTE_VERSION;
    const withoutKey = JSON.parse(futureCassetteWithExtraKey({}));
    withoutKey.cassetteVersion = CASSETTE_VERSION;
    write(cwd, "with.cassette.json", JSON.stringify(withKey));
    write(cwd, "without.cassette.json", JSON.stringify(withoutKey));
    const a = replay(cwd, ["with.cassette.json", "--output-format", "json"]);
    const b = replay(cwd, ["without.cassette.json", "--output-format", "json"]);
    expect(a.code).toBe(0);
    expect(a.code).toBe(b.code);
    expect(a.json?.results?.[0]?.verdict).toEqual(b.json?.results?.[0]?.verdict);
  });

  it("stays SILENT on an ordinary SAME-version cassette, even one carrying an extra key (no false positives)", () => {
    const cwd = tmp();
    const body = JSON.parse(futureCassetteWithExtraKey({ someFutureKey: "remote" }));
    body.cassetteVersion = CASSETTE_VERSION; // not future — this build wrote (or could have written) this version
    write(cwd, "c.cassette.json", JSON.stringify(body));
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.stderr).not.toMatch(/unknown top-level key/);
  });

  it("stays SILENT on an ordinary future-version-free replay of a normal cassette (no false positives)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    const r = replay(cwd, ["c.cassette.json"]);
    expect(r.stderr).not.toMatch(/unknown top-level key/);
  });

  it("does not throw / crash even when scenario carries several unknown keys", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", futureCassetteWithExtraKey({ someFutureKey: "remote", anotherNewKey: 42 }));
    const r = replay(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(r.json).toBeTruthy(); // valid JSON envelope emitted — no crash mid-report
    expect(r.stderr).toContain("someFutureKey");
    expect(r.stderr).toContain("anotherNewKey");
  });
});

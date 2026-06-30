import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadBaseline } from "../src/baseline.js";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

// Part A (on-disk re-assert opt-in) + Part B (per-result verdict) — exercised through the BUILT CLI so the
// cmdReplay→replayCassette wiring is covered (a unit test on replayCassette can't see the flag plumbing).
// Token-free and spawn-only: replay needs no agent/Docker. Needs dist/cli.js (the `ci` script builds first).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const LIVE = loadBaseline("latest").appVersion;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cc-reassert-"));
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
}): string {
  return JSON.stringify({
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: opts.name ?? "c",
      baseline: "latest",
      session: opts.session ?? "(inline)",
      fidelity: "container",
      prompt: opts.prompt ?? "do the thing",
      answers: [],
      expect_denied: [],
      assert: opts.assert ?? [{ result: "success" }],
    },
    events: events("hello there", opts.endQuestion ?? false),
    controlOut: [],
    ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
  });
}

// Minimal sibling scenario YAML (parseScenarioFile-valid). `name`/`prompt` default to match the cassette.
function scenarioYaml(opts: { name?: string; prompt?: string; assert?: string; session?: string } = {}): string {
  return (
    `name: ${opts.name ?? "c"}\n` +
    `prompt: ${opts.prompt ?? "do the thing"}\n` +
    (opts.session ? `session: ${opts.session}\n` : "") +
    `assert:\n${opts.assert ?? "  - result: success\n"}`
  );
}

describe.skipIf(!can)("replay A-default — frozen assertions drive; only the SILENT no-op dies", () => {
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
});

describe.skipIf(!can)("replay A-optin — --assert-from / --reassert, safe by construction", () => {
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

  it("[R3-#2] a sessioned scenario does NOT spuriously hard-fail (session excluded from drift)", () => {
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
    const base = "name: c\nprompt: do the thing\n";
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
      "name: c\nprompt: do the thing\nbaseline: 1.2.3\nskills:\n  - alpha\nanswers:\n  - when_question: go?\n    choose: Yes\nassert:\n  - transcript_contains: hello\n",
    );
    const r = replay(cwd, ["c.cassette.json", "--assert-from", "edit.yaml", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
  });

  it("[R3-#1] skill staleness HARD-FAILS on the opt-in path WITHOUT --strict (Round-2 regression)", () => {
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
    expect(dflt.code).toBe(0); // default lane: staleness is warn-only
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

  it("[P1] an invalid --assert-from file is a hard error for that cassette, attributed to the parse", () => {
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

  it("[P1] --reassert over a dir keeps going when one sibling is invalid (batch not aborted)", () => {
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

  it("[#4] warns that an edited on-disk expect_denied is sourced but inert on replay (live-only)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "edit.yaml", "name: c\nprompt: do the thing\nexpect_denied:\n  - evil.example.com\nassert:\n  - result: success\n");
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

describe.skipIf(!can)("replay Part B — per-result verdict in the JSON envelope", () => {
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

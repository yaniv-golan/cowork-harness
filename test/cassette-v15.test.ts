import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CASSETTE_VERSION, V15_ASSERT_FEATURES, V14_ASSERT_FEATURES, requiredVersionFor, cassetteSchemaUrl } from "../src/run/cassette.js";

// v15 is the next shared interpretation bump, landed on its own before any key uses it. The stamp is
// requirement-based (requiredVersionFor), so raising CASSETTE_VERSION alone moves no cassette's stamp.

/** One sample assertion per V15_ASSERT_FEATURES predicate, in the same order. A key that appends a predicate there
 *  appends its sample here; the coverage test below fails until it does. */
const V15_SAMPLES: unknown[] = [
  { no_hook_event_blocked: true },
  { hook_event_blocked: { event: "Stop", max: 0 } },
  { hook_decision: { event: "PreToolUse", decision: "deny" } },
  { gates_all_scripted: true },
  { artifact_json: { artifact: "outputs/artifacts/runs/*/run_status.json", match: "each", path: "status", equals: "complete" } },
];

describe("cassette v15", () => {
  it("this build writes and reads v15, and ships its schema", () => {
    expect(CASSETTE_VERSION).toBe(15);
    expect(cassetteSchemaUrl(15)).toMatch(/schema\/cassette\.v15\.json$/);
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schema", "cassette.v15.json"), "utf8"));
    expect(schema.$id).toBe(cassetteSchemaUrl(15));
    expect(schema.title).toBe("cowork-harness cassette v15");
    expect(existsSync(join(process.cwd(), "schema", "cassette.v14.json"))).toBe(true); // v14 stays as history
  });

  it("every V15 predicate has a sample that it alone lifts to 15", () => {
    expect(V15_SAMPLES).toHaveLength(V15_ASSERT_FEATURES.length);
    V15_ASSERT_FEATURES.forEach((f, i) => {
      const a = V15_SAMPLES[i];
      expect(f(a)).toBe(true);
      expect(V15_ASSERT_FEATURES.filter((g) => g(a))).toHaveLength(1);
      expect(V14_ASSERT_FEATURES.some((g) => g(a))).toBe(false);
      expect(requiredVersionFor({ prompt: "x", assert: [a] })).toBe(15);
    });
  });

  it("the stamp consults the V15 list: a predicate appended to it lifts a matching assertion to 15", () => {
    const list = V15_ASSERT_FEATURES as Array<(a: unknown) => boolean>;
    const probe = (a: unknown) => !!a && typeof a === "object" && "__v15_probe" in (a as object);
    list.push(probe);
    try {
      expect(requiredVersionFor({ prompt: "x", assert: [{ __v15_probe: true }] })).toBe(15);
      expect(requiredVersionFor({ prompt: "x", assert: [{ result: "success" }] })).toBe(12);
    } finally {
      list.splice(list.indexOf(probe), 1);
    }
  });

  it("the hook keys: every new form stamps 15; the bare hook_event_blocked, which a v14 reader reads, does not", () => {
    for (const a of [
      { no_hook_event_blocked: { event: "Stop" } },
      { hook_event_blocked: { event: "PreToolUse", tool: "Bash", via: "json", min: 1 } },
      { hook_decision: { event: "Stop", decision: "block", max: 0 } },
    ])
      expect(requiredVersionFor({ prompt: "x", assert: [a] }), JSON.stringify(a)).toBe(15);
    expect(requiredVersionFor({ prompt: "x", assert: [{ hook_event_blocked: "Stop" }] })).toBe(12);
  });

  it("an artifact_json glob stamps 15 by its glob or its match key; a literal path stamps as before", () => {
    const v = (aj: object) => requiredVersionFor({ prompt: "x", assert: [{ artifact_json: { path: "status", equals: "ok", ...aj } }] });
    // A v14 reader would grade a glob without `match` as a literal path that never exists: a wrong verdict, not a refusal.
    expect(v({ artifact: "outputs/runs/*/s.json" })).toBe(15);
    expect(v({ artifact: "outputs/**/s.json", match: "any" })).toBe(15);
    expect(v({ artifact: "outputs/s.json", match: "each" })).toBe(15);
    expect(v({ artifact: "outputs/runs/?.json", match: "each", authored: true })).toBe(15);
    expect(v({ artifact: "outputs/s.json" })).toBe(12);
    expect(v({ artifact: "outputs/s.json", authored: true })).toBe(14);
  });

  // `lane: remote` alone stamps v11 (KEY_REQUIRED_VERSION). With an artifact_json entry it needs v15: a v14 reader grades
  // that key over the local work-root file, a pass the remote lane's contract says cannot be evidence. Both values are
  // in the frozen scenario, so rehash reads them where record does.
  it("lane: remote with an artifact_json entry stamps 15; either one alone stamps as before", () => {
    const aj = { artifact_json: { artifact: "outputs/s.json", path: "status", equals: "ok" } };
    expect(requiredVersionFor({ prompt: "x", lane: "remote", assert: [aj] })).toBe(15);
    expect(requiredVersionFor({ prompt: "x", lane: "remote", assert: [{ result: "success" }, aj] })).toBe(15);
    expect(requiredVersionFor({ prompt: "x", lane: "remote", assert: [{ result: "success" }] })).toBe(12);
    expect(requiredVersionFor({ prompt: "x", lane: "local", assert: [aj] })).toBe(12);
    expect(requiredVersionFor({ prompt: "x", assert: [aj] })).toBe(12);
    // artifact_text has refused on this lane since it shipped, so every reader that knows the key already does.
    expect(
      requiredVersionFor({ prompt: "x", lane: "remote", assert: [{ artifact_text: { artifact: "outputs/s.md", contains: ["a"] } }] }),
    ).toBe(12);
  });

  // `answerChannel` is frozen at the cassette's top level, not in the scenario, and a v14 reader ignores an unknown
  // top-level key: it would replay a run parked at a question as the `stalled` fail. The floor routes it to "too new".
  it("a recording with no answer channel stamps 15; the frozen field is read beside the scenario", () => {
    expect(requiredVersionFor({ prompt: "x" }, { answerChannel: "none" })).toBe(15);
    expect(requiredVersionFor({ prompt: "x" }, { answerChannel: undefined })).toBe(12);
    expect(requiredVersionFor({ prompt: "x" }, {})).toBe(12);
    // Any value an on-disk cassette could carry that is not `none` leaves the stamp alone.
    expect(requiredVersionFor({ prompt: "x" }, { answerChannel: "stdio" })).toBe(12);
  });

  // The floor holds only where the frozen value is passed: a write site that calls with the scenario alone would
  // stamp a no-channel recording 12. Each stamping call in the source must pass a second argument.
  it("every stamping call site passes the frozen fields", () => {
    const src = readFileSync(join(process.cwd(), "src", "run", "cassette.ts"), "utf8");
    const calls = [...src.matchAll(/requiredVersionFor\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)]
      .map((m) => m[1])
      .filter((args) => !args.includes(": unknown")); // the definition
    expect(calls).toHaveLength(3);
    for (const args of calls) expect(args, args).toMatch(/,\s*\S/);
  });

  it("the bump alone stamps nothing at 15: a plain scenario still stamps the epoch floor", () => {
    expect(requiredVersionFor({ prompt: "x" })).toBe(12);
    expect(requiredVersionFor({ prompt: "x", assert: [{ result: "success" }] })).toBe(12);
  });

  it("no committed cassette's required version moves: each still requires its stamp (or the epoch floor 12)", () => {
    const files = execFileSync("git", ["ls-files", "*.cassette.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const c = JSON.parse(readFileSync(f, "utf8")) as { scenario: unknown; cassetteVersion: number };
      // A pre-epoch stamp (10) is still read; this build would stamp it at the epoch floor.
      expect({ f, v: requiredVersionFor(c.scenario) }).toEqual({ f, v: Math.max(c.cassetteVersion, 12) });
    }
  });
});

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { preSpendVerdicts } from "../src/run/cassette.js";
import { parseScenarioFile, executeScenario } from "../src/run/execute.js";

// WHY THIS FILE EXISTS. `record --dry-run` is the token-free rehearsal for a PAID command, and it used to
// re-implement the pre-spend checks by hand. `hostInventoryPreflight` shipped 2026-08-04; bbd5bf5
// (2026-08-07), whose title is "make --dry-run refuse what the real record refuses", swept in the two checks
// returning `string | undefined` and missed the one returning a `{kind}` verdict. It stayed missing 19 days.
//
// A registry of check objects was designed and REJECTED: it guarantees every REGISTERED check runs
// everywhere, but nothing stops the next one being called inline and never registered — exactly how the gap
// happened. The fix is one function (`preSpendVerdicts`) plus the source scan at the bottom of this file,
// which is what actually keeps it the only site. The parity tests alone would not.

// A run must resolve a model (4.0.0), and on `record` that refusal comes before these checks, so the helper
// pins one through the env channel by default. The model check's own parity case passes `{}` to clear it.
const PINNED = { COWORK_HARNESS_MODEL: "claude-sonnet-5" };
const cli = (args: string[], cwd: string, env: Record<string, string> = PINNED) => {
  const r = spawnSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COWORK_HARNESS_MODEL: "", ...env },
  });
  return { code: r.status ?? 1, text: (r.stdout ?? "") + (r.stderr ?? "") };
};

/** A git repo, so `isRepoVisiblePath` (which asks git) answers truthfully. */
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-ps-"));
  execFileSync("git", ["init", "-q"], { cwd: d, stdio: "pipe" });
  return d;
}

const HOSTLOOP = (name: string) => `name: ${name}\nprompt: go\nfidelity: hostloop\nassert:\n  - result: success\n`;
const PROMPT_GATE = (name: string) =>
  `name: ${name}\nprompt: go\nfidelity: container\non_unanswered: prompt\nassert:\n  - result: success\n`;

/** One fixture per check `preSpendVerdicts` can emit. Keyed by a substring unique to that check's message.
 *  A check with no entry here is caught by the coverage test below — that is the property that makes this
 *  file a guard rather than a sample. */
const FIXTURES: { id: string; yaml: (n: string) => string; expect: RegExp; kind: "refuse" | "warn" }[] = [
  { id: "prompt-policy", yaml: PROMPT_GATE, expect: /on_unanswered: prompt/, kind: "refuse" },
  { id: "host-inventory", yaml: HOSTLOOP, expect: /refusing to record into a repo-visible path/, kind: "refuse" },
];

describe("preSpendVerdicts — every check refuses on the real path AND in the single-file preview", () => {
  // The pair that matters. Asserting only "both are non-zero" is not enough: the real arm hits an auth guard
  // before any per-scenario check when no token is present, so a non-zero assertion passes for the wrong
  // reason (measured — the repo-root .env is the only thing that made the pre-existing parity test honest).
  // So both sides are asserted on the MESSAGE.
  it.each(FIXTURES)("$id — the preview reports exactly what the real path would refuse", (f) => {
    const w = repo();
    mkdirSync(join(w, "cassettes"), { recursive: true });
    writeFileSync(join(w, "s.yaml"), f.yaml("probe"));

    // The unit: what the real path computes. Driving the real CLI would spend money — `preSpendVerdicts` is
    // precisely the seam that makes this checkable without a paid run.
    const sc = parseScenarioFile(join(w, "s.yaml"));
    const real = preSpendVerdicts(sc, join(w, "cassettes", "probe.cassette.json"), { scenarioSourceFile: join(w, "s.yaml") });
    const hit = real.find((v) => f.expect.test(v.message));
    expect(hit, `${f.id}: no verdict matched ${f.expect}`).toBeDefined();
    expect(hit!.kind, `${f.id}: fixture must produce a ${f.kind}`).toBe(f.kind);

    // ...and the CLI preview says the same thing, from the same inputs.
    const dry = cli(["record", join(w, "s.yaml"), "--out", join(w, "cassettes", "probe.cassette.json"), "--dry-run"], w);
    if (f.kind === "refuse") expect(dry.code, `${f.id}: preview must refuse`).not.toBe(0);
    expect(dry.text, `${f.id}: preview must carry the real message`).toMatch(f.expect);
  });

  // COVERAGE. A check added to preSpendVerdicts with no fixture above is silently untested — the same shape
  // of hole this whole file exists to close. Enumerate what the function can emit and require a fixture for
  // each. (Kept honest by the source scan: a check called OUTSIDE the function fails there instead.)
  it("every check preSpendVerdicts can emit has a fixture", () => {
    const src = readFileSync(join("src", "run", "cassette.ts"), "utf8");
    const body = src.slice(src.indexOf("export function preSpendVerdicts("), src.indexOf("\nasync function recordScenarioObject("));
    const emitted = [
      ...new Set([...body.matchAll(/(promptPolicyRejection|hostInventoryPreflight|cassettePortabilityPreflight)\(/g)].map((m) => m[1])),
    ];
    // Names → fixture ids. A NEW check appears here as an unmapped name and fails loudly.
    const MAP: Record<string, string> = {
      promptPolicyRejection: "prompt-policy",
      hostInventoryPreflight: "host-inventory",
      cassettePortabilityPreflight: "portability",
    };
    const ids = new Set(FIXTURES.map((f) => f.id));
    // portability is warn-only and covered by its own suite (test/cassette-portability.test.ts); listed as a
    // deliberate exemption rather than silently absent.
    const EXEMPT = new Set(["portability"]);
    const missing = emitted.map((n) => MAP[n] ?? `UNMAPPED:${n}`).filter((id) => !ids.has(id) && !EXEMPT.has(id));
    expect(missing, `preSpendVerdicts emits checks with no fixture in this file: ${missing.join(", ")}`).toEqual([]);
  });
});

// The model check is not in preSpendVerdicts: on the real path it fires inside executeScenario, which every
// lane funnels through, and `record` mirrors it with `unresolvedModelPreflight`. This pins the preview to the
// real path's text, the way the pairs above pin theirs, so the two cannot drift apart.
describe("the unresolved-model refusal: the preview carries the real path's message", () => {
  it("executeScenario and `record <file> --dry-run` refuse with the same text", async () => {
    const w = repo();
    writeFileSync(join(w, "s.yaml"), `name: probe\nprompt: go\nfidelity: protocol\nassert:\n  - result: success\n`);
    const sc = parseScenarioFile(join(w, "s.yaml"));
    const prev = { model: process.env.COWORK_HARNESS_MODEL, runs: process.env.COWORK_HARNESS_RUNS_DIR };
    delete process.env.COWORK_HARNESS_MODEL;
    process.env.COWORK_HARNESS_RUNS_DIR = join(mkdtempSync(join(tmpdir(), "cwh-ps-runs-")), "runs");
    let real = "";
    try {
      real = ((await executeScenario(sc).catch((e: unknown) => e)) as Error).message;
    } finally {
      if (prev.model !== undefined) process.env.COWORK_HARNESS_MODEL = prev.model;
      if (prev.runs === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
      else process.env.COWORK_HARNESS_RUNS_DIR = prev.runs;
    }
    expect(real).toMatch(/no model is pinned/);
    const dry = cli(["record", join(w, "s.yaml"), "--dry-run"], w, {});
    expect(dry.code).toBe(1);
    expect(dry.text).toContain(real);
  });
});

describe("the batch preview advises, and never gates, on a path it is guessing", () => {
  // THE REGRESSION THAT KILLED THE FIRST DESIGN. Refusing here was measured against a real consumer: 26 of
  // 27 of their scenarios would have flipped to refused, while the real record accepts every one — their CI
  // dry-runs the directory from the repo root, but the real record writes elsewhere via --out and decides
  // --allow-host-inventory-fixture per scenario from the filesystem. This arm knows neither, so its verdict
  // is a guess, and a guess must not gate.
  it("a host-inheriting batch is NOTED, not refused, and the exit code stays 0", () => {
    const w = repo();
    mkdirSync(join(w, "scen"), { recursive: true });
    writeFileSync(join(w, "scen", "a.yaml"), HOSTLOOP("alpha"));
    writeFileSync(join(w, "scen", "b.yaml"), HOSTLOOP("beta"));
    const r = cli(["record", join(w, "scen"), "--dry-run"], w);
    expect(r.code, "a guessed verdict must not gate the batch").toBe(0);
    expect(r.text).toMatch(/would-refuse \(advisory\)/);
    expect(r.text, "must say what it assumed, or a reader cannot tell a guess from a verdict").toMatch(/ADVISORY, not this run's verdict/);
  });

  // The label must follow the VERDICT KIND, not just "this is a note". `cassettePortabilityPreflight`
  // returns only ok|warn — it can never refuse — and `hostInventoryPreflight` returns warn whenever the
  // target cassette already EXISTS, which is every re-record corpus sitting at the default path. Labelling
  // those "would-refuse" told the reader the real record would refuse a run it would in fact accept, on the
  // one arm whose whole design principle is "do not assert what you cannot know".
  it("a WARN-kind verdict is labelled would-warn, not would-refuse", () => {
    const w = repo();
    mkdirSync(join(w, "scen"), { recursive: true });
    writeFileSync(join(w, "scen", "a.yaml"), HOSTLOOP("alpha"));
    // Pre-create the default cassette target: that is what flips hostInventoryPreflight refuse -> warn.
    const existing = join(w, "cassettes", "alpha.cassette.json");
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, "{}");
    const r = cli(["record", join(w, "scen"), "--dry-run"], w);
    expect(r.code, "still advisory, still non-gating").toBe(0);
    expect(r.text, "a warn-kind verdict must not claim the real record would refuse").toMatch(/would-warn \(advisory\)/);
  });

  it("--quiet suppresses the advisory notes but never a refusal", () => {
    const w = repo();
    mkdirSync(join(w, "scen"), { recursive: true });
    writeFileSync(join(w, "scen", "a.yaml"), HOSTLOOP("alpha"));
    writeFileSync(join(w, "scen", "b.yaml"), PROMPT_GATE("beta"));
    const r = cli(["record", join(w, "scen"), "--dry-run", "--quiet"], w);
    expect(r.text).not.toMatch(/would-refuse/);
    expect(r.text, "a real refusal survives --quiet").toMatch(/on_unanswered: prompt/);
    expect(r.code, "the path-INDEPENDENT refusal still gates").not.toBe(0);
  });

  // Path-independent, so it refuses on both arms: a dir target takes no --out, so both really do use the
  // default path. This is the line between "notes" and "refusals" on this arm.
  it("two scenarios sharing a default cassette path are REFUSED, not noted", () => {
    const w = repo();
    mkdirSync(join(w, "scen"), { recursive: true });
    // `slugForPath` maps BOTH path separators to "-", so these two distinct names share one default path.
    // (A first draft used "my run" / "my-run", which do NOT collide — a space is preserved. The guard was
    // right and the fixture was wrong; verified against slugForPath directly before trusting either.)
    writeFileSync(join(w, "scen", "a.yaml"), `name: a/b\nprompt: go\nfidelity: container\nassert:\n  - result: success\n`);
    writeFileSync(join(w, "scen", "b.yaml"), `name: a\\b\nprompt: go\nfidelity: container\nassert:\n  - result: success\n`);
    const r = cli(["record", join(w, "scen"), "--dry-run"], w);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/share a cassette output path/);
  });
});

describe("the source scan — what actually stops the next check from being missed", () => {
  const src = readFileSync(join("src", "run", "cassette.ts"), "utf8");

  // A parity test only covers checks that ARE in preSpendVerdicts. The original defect was a check called
  // INLINE in recordScenarioObject and never mirrored — a registry or a fixture table cannot see that. This
  // can.
  it("no pre-spend check is called outside preSpendVerdicts", () => {
    const fnStart = src.indexOf("export function preSpendVerdicts(");
    const fnEnd = src.indexOf("\nasync function recordScenarioObject(");
    expect(fnStart, "preSpendVerdicts moved — fix this anchor").toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const m of src.matchAll(/\b(hostInventoryPreflight|cassettePortabilityPreflight|promptPolicyRejection)\(/g)) {
      const at = m.index!;
      if (at >= fnStart && at < fnEnd) continue; // inside the one legal site
      const lineStart = src.lastIndexOf("\n", at) + 1;
      const line = src.slice(lineStart, src.indexOf("\n", at));
      if (/^export function |^function /.test(line)) continue; // declarations are not calls
      // ALLOWLIST — deliberate duplicates, each with its reason. Kept as exact source lines so a DIFFERENT
      // call cannot hide behind an entry: changing the line re-offends.
      const ALLOWED = [
        // The batch dry-run refuses the PATH-INDEPENDENT checks itself, because its path-dependent verdicts
        // are advisory (it cannot know --out or the per-item flags) and must not gate. Calling
        // preSpendVerdicts alone there would either gate on a guess or drop this refusal entirely.
        "const why = promptPolicyRejection(sc) ?? assertContradiction(sc);",
      ];
      if (ALLOWED.includes(line.trim())) continue;
      offenders.push(`${line.trim().slice(0, 90)}`);
    }
    expect(offenders, `pre-spend checks called outside preSpendVerdicts — the preview cannot see these:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });
});

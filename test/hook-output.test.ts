// `hook_output_contains` / `hook_output_not_contains` over hook_response frames exactly as a run records them
// (parseMessage over the committed recording test/fixtures/hook-frames/), and through `verify-run` over real kept run
// dirs (copied first — verify-run reads them; nothing here writes into ~/.cowork-harness).
import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseMessage } from "../src/agent/session.js";
import { ScenarioObject, type Assertion } from "../src/types.js";
import { requiredVersionFor } from "../src/run/cassette.js";
import { loadHookFrames } from "./helpers/hook-frames.js";

/** contextEvents as Run records them, optionally with each frame's fields edited (still the recorded frames). */
function recorded(edit?: (f: Record<string, unknown>) => Record<string, unknown>) {
  return loadHookFrames()
    .map((f) => (edit ? edit({ ...f }) : f))
    .flatMap((f) => parseMessage(f))
    .flatMap((e) => (e.type === "system_event" ? [{ subtype: e.subtype, data: e.data }] : []));
}
const ctx = (contextEvents: AssertContext["contextEvents"]) =>
  ({ transcript: "", toolsCalled: new Set(), questions: [], subagents: [], contextEvents }) as unknown as AssertContext;
const run = (a: Assertion, c: AssertContext) => evaluate([a], c)[0]!;
const STOP_STDERR = "Your final message must end with the word PINEAPPLE";
const TOKEN = "[REDACTED:path:0123456789ab]";

describe("hook_output_* over the recorded Stop frames (block, then pass)", () => {
  it("contains: a literal on stderr passes, naming the frame", () => {
    const r = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: STOP_STDERR } } as Assertion, ctx(recorded()));
    expect(r.pass).toBe(true);
    expect(r.evidence).toMatch(/Stop printed .* on stderr/);
  });

  it("not_contains: the same text fails, with the exit code and an excerpt", () => {
    const r = run({ hook_output_not_contains: { event: "Stop", stream: "stderr", text: STOP_STDERR } } as Assertion, ctx(recorded()));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/1 `Stop` hook frame\(s\) printed .* \(exit 2\): "Your final message/);
  });

  it("text is case-sensitive, matches is a case-insensitive regex; stream narrows", () => {
    const c = ctx(recorded());
    expect(run({ hook_output_contains: { event: "Stop", text: STOP_STDERR.toLowerCase() } } as Assertion, c).pass).toBe(false);
    expect(run({ hook_output_contains: { event: "Stop", matches: "pineapple" } } as Assertion, c).pass).toBe(true);
    expect(run({ hook_output_contains: { event: "Stop", stream: "stdout", matches: "pineapple" } } as Assertion, c).pass).toBe(false);
  });

  it("never vacuous: an event that never fired fails both keys; no context events cannot verify", () => {
    for (const k of ["hook_output_contains", "hook_output_not_contains"]) {
      const r = run({ [k]: { event: "PostToolUse", text: "x" } } as unknown as Assertion, ctx(recorded()));
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/no hook_response frame for `PostToolUse`/);
      expect(run({ [k]: { event: "Stop", text: "x" } } as unknown as Assertion, ctx(undefined)).message).toMatch(/cannot verify/);
    }
  });

  it("not_contains needs both fields under stream: any — a frame without one is evidence-unavailable", () => {
    const c = ctx(recorded((f) => (f.subtype === "hook_response" ? { ...f, stdout: undefined } : f)));
    const r = run({ hook_output_not_contains: { event: "Stop", text: "never printed" } } as Assertion, c);
    expect(r.message).toMatch(/^evidence unavailable: .*carry no stdout and stderr field/);
  });
});

// A replayed cassette or a scrubbed run dir can carry output a redaction policy rewrote: a literal HIT outside the
// token still counts; a literal miss, and any regex result, cannot be trusted (`.` matches the token's own text).
describe("hook_output_* over redacted output", () => {
  const redacted = (stderr: string) => ctx(recorded((f) => (f.subtype === "hook_response" ? { ...f, stderr } : f)));

  it("a literal hit outside the token counts, both ways", () => {
    const c = redacted(`no handover.txt under ${TOKEN}`);
    expect(run({ hook_output_contains: { event: "Stop", text: "no handover.txt" } } as Assertion, c).pass).toBe(true);
    expect(run({ hook_output_not_contains: { event: "Stop", text: "no handover.txt" } } as Assertion, c).pass).toBe(false);
  });

  it("a literal miss over a rewritten stream is evidence-unavailable, never a pass of not_contains", () => {
    const r = run({ hook_output_not_contains: { event: "Stop", text: "/Users/x" } } as Assertion, redacted(`wrote ${TOKEN}`));
    expect(r.message).toMatch(/^evidence unavailable: .*rewritten by a redaction policy/);
  });

  it.each([
    ["hook_output_contains", "^wrote .$"],
    ["hook_output_not_contains", "wrote [^/]"],
  ])("%s with a regex over a rewritten stream is evidence-unavailable, never a verdict", (k, re) => {
    const r = run({ [k]: { event: "Stop", matches: re } } as unknown as Assertion, redacted(`wrote ${TOKEN}`));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable:/);
  });

  it("a needle the policy rewrote is evidence-unavailable", () => {
    const r = run({ hook_output_not_contains: { event: "Stop", text: `under ${TOKEN}` } } as Assertion, ctx(recorded()));
    expect(r.message).toMatch(/^evidence unavailable: .*rewritten by the cassette's redaction policy/);
  });
});

describe("hook_output_*: load time and cassette version", () => {
  const parse = (a: unknown) => ScenarioObject.safeParse({ prompt: "x", fidelity: "container", assert: [a] });
  it.each([
    [{ hook_output_contains: { event: "Stop" } }],
    [{ hook_output_contains: { event: "Stop", text: "a", matches: "b" } }],
    [{ hook_output_contains: { event: "Stop", text: "" } }],
    [{ hook_output_not_contains: { event: "NotAnEvent", text: "a" } }],
    [{ hook_output_not_contains: { event: "Stop", stream: "both", text: "a" } }],
  ])("refuses %j before the spawn", (a) => expect(parse(a).success).toBe(false));

  it("stamps cassette v14 (a v13 reader's schema rejects the keys)", () => {
    expect(requiredVersionFor({ assert: [{ hook_output_not_contains: { event: "Stop", text: "x" } }] })).toBe(14);
    expect(requiredVersionFor({ assert: [{ hook_output_contains: { event: "Stop", text: "x" } }] })).toBe(14);
  });
});

// The kept run dirs that motivated the keys: a Stop hook that exits 0 and says on stderr it found no handover.txt.
// Copied to a temp dir; skipped where they do not exist (another machine, CI).
const RUNS = join(homedir(), ".cowork-harness", "runs");
const KEPT = {
  red: ["market-sizing-remote-lane/local_7qcmp24hnu", "competitive-positioning-smoke/local_8744vvfe2j"],
  green: ["cap-table-antihallucination/local_8zs3h2oku6"],
};
const CLI = resolve("dist/cli.js");
const have = existsSync(CLI) && [...KEPT.red, ...KEPT.green].every((d) => existsSync(join(RUNS, d, "turns")));

describe.runIf(have)("verify-run over the kept run dirs (positive controls)", () => {
  const verify = (rel: string, assertYaml: string) => {
    const tmp = mkdtempSync(join(tmpdir(), "hook-output-kept-"));
    const dir = join(tmp, "run");
    cpSync(join(RUNS, rel), dir, { recursive: true });
    const sc = join(tmp, "probe.yaml");
    writeFileSync(sc, `name: probe\nfidelity: hostloop\nprompt: "x"\nassert:\n${assertYaml}`);
    return spawnSync(process.execPath, [CLI, "verify-run", dir, sc], { encoding: "utf8", cwd: tmp, timeout: 120_000 });
  };
  const NOT = `  - hook_output_not_contains:\n      event: Stop\n      stream: stderr\n      text: "no handover.txt"\n`;

  it.each(KEPT.red)(
    "%s: the fail-open stderr fails hook_output_not_contains (and hook_output_contains finds it)",
    (rel) => {
      const r = verify(rel, NOT);
      expect(r.status, r.stderr + r.stdout).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/hook_output_not_contains/);
      expect(verify(rel, NOT.replace("not_contains", "contains")).status).toBe(0);
    },
    180_000,
  );

  it.each(KEPT.green)(
    "%s: a clean Stop stderr passes",
    (rel) => {
      const r = verify(rel, NOT);
      expect(r.status, r.stderr + r.stdout).toBe(0);
    },
    180_000,
  );
});

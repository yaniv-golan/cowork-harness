// `hook_output_contains` / `hook_output_not_contains` over hook_response frames exactly as a run records them
// (parseMessage over the committed recording test/fixtures/hook-frames/), and through `verify-run` over real kept run
// dirs (copied first — verify-run reads them; nothing here writes into ~/.cowork-harness).
import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseMessage } from "../src/agent/session.js";
import { ScenarioObject, type Assertion } from "../src/types.js";
import {
  CASSETTE_VERSION,
  redactCassette,
  redactionRewroteHookOutput,
  replayCassette,
  requiredVersionFor,
  type Cassette,
} from "../src/run/cassette.js";
import { loadRedactionPolicy } from "../src/redact.js";
import { loadBaseline } from "../src/baseline.js";
import { assertContradiction, hookOutputContradictions } from "../src/run/execute.js";
import { warnAmbiguousHookOutput } from "../src/run/hook-events.js";
import type { Scenario } from "../src/types.js";
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
    // `matches: "\bfailed open\b"` in double-quoted YAML loads a BACKSPACE, not a word boundary — a needle no hook
    // prints, so the negative key would pass silently. The same YAML escape reaches `text`.
    [{ hook_output_not_contains: { event: "Stop", matches: "\bfailed open\b" } }],
    [{ hook_output_not_contains: { event: "Stop", text: "\bfailed open" } }],
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
      expect(r.stdout + r.stderr).toMatch(
        /hook_output_not_contains: \d+ `Stop` hook frame\(s\) printed "no handover\.txt" on stderr: .*no handover\.txt/,
      );
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

describe("hook_output_*: control characters, excerpts and listing caps", () => {
  const parse = (a: unknown) => ScenarioObject.safeParse({ prompt: "x", fidelity: "container", assert: [a] });
  it("accepts the single-quoted spelling of the same regex (a real word boundary)", () => {
    expect(parse({ hook_output_not_contains: { event: "Stop", matches: "\\bfailed open\\b" } }).success).toBe(true);
  });

  const withStderr = (stderr: string) => ctx(recorded((f) => (f.subtype === "hook_response" ? { ...f, stderr } : f)));

  it("the evidence excerpt is centred on the hit, within the ~200-char bound", () => {
    const long = `${"a".repeat(500)} NEEDLE-HERE ${"b".repeat(500)}`;
    const r = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: "NEEDLE-HERE" } } as Assertion, withStderr(long));
    expect(r.pass).toBe(true);
    const shown = JSON.parse(r.evidence!.slice(r.evidence!.indexOf(': "') + 2)) as string;
    expect(shown).toContain("NEEDLE-HERE");
    expect(shown.startsWith("…") && shown.endsWith("…")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(202);
    // a regex hit is centred the same way
    const m = run({ hook_output_not_contains: { event: "Stop", stream: "stderr", matches: "needle-h" } } as Assertion, withStderr(long));
    expect(m.message).toMatch(/NEEDLE-HERE/);
  });

  it("a literal next to a redaction token is found in the untouched segment; a token is never cut in half", () => {
    const s = `${"x".repeat(300)} wrote ${TOKEN} then failed open ${"y".repeat(300)}`;
    const r = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: "failed open" } } as Assertion, withStderr(s));
    expect(r.pass).toBe(true);
    expect(r.evidence).toMatch(/\(redacted\) then failed open/);
    expect(r.evidence).not.toMatch(/REDACTED/);
    // a literal spanning a token boundary is not a hit (it could only match the token's own text)
    const span = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: "wrote [REDACTED" } } as Assertion, withStderr(s));
    expect(span.pass).toBe(false);
  });

  it("the seen: list names at most 5 frames, then +N more", () => {
    const frames = Array.from({ length: 8 }, (_, i) => ({
      subtype: "hook_response",
      data: { hook_event: "PreToolUse", hook_name: `PreToolUse:${i}`, stdout: "", stderr: `ok ${i}`, exit_code: 0 },
    }));
    const r = run({ hook_output_contains: { event: "PreToolUse", text: "never" } } as Assertion, ctx(frames));
    expect(r.message).toMatch(/PreToolUse:4: .*; \+3 more$/);
    expect(r.message).not.toMatch(/PreToolUse:5/);
    const hits = run({ hook_output_not_contains: { event: "PreToolUse", text: "ok" } } as Assertion, ctx(frames));
    expect(hits.message).toMatch(/8 `PreToolUse` hook frame\(s\).*; \+3 more$/);
  });

  it("contains: a miss with SOME frames lacking the field is evidence-unavailable, as for not_contains", () => {
    let n = 0;
    const c = ctx(recorded((f) => (f.subtype === "hook_response" && n++ === 0 ? { ...f, stderr: undefined } : f)));
    const r = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: "never printed" } } as Assertion, c);
    expect(r.message).toMatch(/^evidence unavailable: .*\(1 without the stderr field\)/);
    // with every field present, the same miss is a plain fail
    const plain = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: "never printed" } } as Assertion, ctx(recorded()));
    expect(plain.message).toMatch(/^hook_output_contains: no `Stop` hook printed/);
  });
});

// Through the REAL replay path: the recorded frames frozen into a cassette, re-driven by replayCassette.
const POLICY = loadRedactionPolicy([resolve(".")]); // the repo's own .cowork-redact.json
const LIVE = loadBaseline("latest").appVersion;
const line = (o: unknown) => JSON.stringify(o);
function hookCassette(assert: Record<string, unknown>[], stderr?: (s: string) => string): Cassette {
  const frames = loadHookFrames().map((f) =>
    stderr && f.subtype === "hook_response" && typeof f.stderr === "string" && f.stderr ? { ...f, stderr: stderr(f.stderr) } : f,
  );
  return {
    scenario: {
      name: "hook-output-replay",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert,
    } as unknown as Scenario,
    events: [
      line({ type: "system", subtype: "init", tools: [], skills: [] }),
      ...frames.map(line),
      line({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: [],
    cassetteVersion: CASSETTE_VERSION,
    userVisibleRoots: ["outputs"],
    fingerprint: { baseline: LIVE },
  } as unknown as Cassette;
}
const replayed = async (c: Cassette, key: string) => (await replayCassette(c, [])).assertions.find((a) => key in a.assertion)!;

describe("hook_output_* on replay (frozen frames, re-driven)", () => {
  const CONTAINS = { hook_output_contains: { event: "Stop", stream: "stderr", text: "PINEAPPLE" } };
  const NOT = { hook_output_not_contains: { event: "Stop", stream: "stderr", text: "no handover.txt" } };

  it("over the plain recorded frames: contains passes, not_contains passes (the text was never printed)", async () => {
    const c = hookCassette([CONTAINS, NOT]);
    expect((await replayed(c, "hook_output_contains")).pass).toBe(true);
    expect((await replayed(c, "hook_output_not_contains")).pass).toBe(true);
  });

  it("with the stderr tokenised by the repo policy: not_contains is evidence-unavailable, never a pass", async () => {
    const base = hookCassette([NOT], (s) => `${s} (cwd /Users/acme/project)`);
    const red = redactCassette(base, POLICY);
    expect(red.events.some((l) => l.includes("hook_response") && l.includes("[REDACTED"))).toBe(true);
    expect((await replayed(base, "hook_output_not_contains")).pass).toBe(true);
    const v = await replayed(red, "hook_output_not_contains");
    expect(v.pass).toBe(false);
    expect(v.message).toMatch(/^evidence unavailable: .*rewritten by a redaction policy/);
  });
});

describe("record-time finding: redactionRewroteHookOutput", () => {
  const tokenised = (s: string) => `${s} (cwd /Users/acme/project)`;

  it("names an assertion whose selected stream redaction tokenised", () => {
    const base = hookCassette([{ hook_output_not_contains: { event: "Stop", stream: "stderr", text: "no handover.txt" } }], tokenised);
    const f = redactionRewroteHookOutput(base, redactCassette(base, POLICY));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/^assert\[0\] hook_output_not_contains on Stop: 1 `Stop` hook_response frame carries a redaction token in stderr/);
    // stream: any reads stderr too
    const any = hookCassette([{ hook_output_contains: { event: "Stop", matches: "x" } }], tokenised);
    expect(redactionRewroteHookOutput(any, redactCassette(any, POLICY))[0]).toMatch(/in stdout or stderr/);
  });

  it("names a needle the policy itself rewrote", () => {
    const base = hookCassette([{ hook_output_not_contains: { event: "Stop", text: "/Users/acme/secret" } }]);
    const f = redactionRewroteHookOutput(base, redactCassette(base, POLICY));
    expect(f.some((m) => /assert\[0\] hook_output_not_contains\.text "\/Users\/acme\/secret" was itself rewritten/.test(m))).toBe(true);
  });

  it("is silent for another event, an unselected stream, and a clean stream", () => {
    for (const a of [
      { hook_output_not_contains: { event: "PreToolUse", text: "x" } },
      { hook_output_not_contains: { event: "Stop", stream: "stdout", text: "x" } },
    ]) {
      const base = hookCassette([a], tokenised);
      expect(redactionRewroteHookOutput(base, redactCassette(base, POLICY))).toEqual([]);
    }
    const clean = hookCassette([{ hook_output_not_contains: { event: "Stop", text: "x" } }]);
    expect(redactionRewroteHookOutput(clean, redactCassette(clean, POLICY))).toEqual([]);
  });
});

describe("hook_output_* contradiction (same event, stream and needle in both keys)", () => {
  const sc = (assert: unknown[]) => ({ name: "t", prompt: "hi", assert }) as unknown as Scenario;
  it("is refused, naming the pair", () => {
    const msg = assertContradiction(
      sc([
        { hook_output_contains: { event: "Stop", stream: "stderr", text: "x" } },
        { hook_output_not_contains: { event: "Stop", stream: "stderr", text: "x" } },
      ]),
    );
    expect(msg).toMatch(/`hook_output_not_contains` alongside `hook_output_contains` for Stop text "x"/);
    expect(msg).toMatch(/no run can satisfy both/);
    // not_contains on `any` covers a positive on one stream
    expect(
      hookOutputContradictions([
        { hook_output_contains: { event: "Stop", stream: "stdout", matches: "a" } },
        { hook_output_not_contains: { event: "Stop", matches: "a" } },
      ] as Assertion[]),
    ).toHaveLength(1);
  });

  it.each([
    ["another event", { event: "SessionStart", stream: "stderr", text: "x" }],
    ["another needle", { event: "Stop", stream: "stderr", text: "y" }],
    ["text vs matches", { event: "Stop", stream: "stderr", matches: "x" }],
    ["negative on a narrower stream than the positive", { event: "Stop", stream: "stdout", text: "x" }],
  ])("is not flagged for %s", (_l, neg) => {
    const pos = { event: "Stop", stream: neg.stream === "stdout" ? "any" : "stderr", text: "x" };
    expect(hookOutputContradictions([{ hook_output_contains: pos }, { hook_output_not_contains: neg }] as Assertion[])).toEqual([]);
  });
});

describe("warnAmbiguousHookOutput: output that cannot be attributed to one plugin", () => {
  const plugin = (events: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "hook-output-plugin-"));
    mkdirSync(join(root, "hooks"));
    writeFileSync(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: "true" }] }]])) }),
    );
    return root;
  };
  const NOT = [{ hook_output_not_contains: { event: "Stop", text: "x" } }];
  const msgs = (roots: string[], asserts: unknown[], host = false) => {
    const out: string[] = [];
    warnAmbiguousHookOutput(roots, asserts as Assertion[], host, (m) => out.push(m));
    return out;
  };

  it("warns when two staged plugins declare the asserted event", () => {
    const out = msgs([plugin(["Stop"]), plugin(["Stop", "PreToolUse"])], NOT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/hook_output_\* on `Stop`: 2 staged plugins declare `Stop`.*carry no plugin id/);
  });

  it("warns when allow_host_hooks is set, even with one plugin", () => {
    expect(msgs([plugin(["Stop"])], NOT, true)[0]).toMatch(/`allow_host_hooks` is set/);
  });

  it("is silent with one declaring plugin, when the second declares another event, or with no hook_output_* key", () => {
    expect(msgs([plugin(["Stop"])], NOT)).toEqual([]);
    expect(msgs([plugin(["Stop"]), plugin(["PreToolUse"])], NOT)).toEqual([]);
    expect(msgs([plugin(["Stop"]), plugin(["Stop"])], [{ hook_event_fired: "Stop" }], true)).toEqual([]);
  });
});

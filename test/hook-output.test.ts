// `hook_output_contains` / `hook_output_not_contains` over hook_response frames exactly as a run records them
// (parseMessage over the committed recording test/fixtures/hook-frames/), and through `verify-run` over real kept run
// dirs (copied first — verify-run reads them; nothing here writes into ~/.cowork-harness).
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluate, type AssertContext } from "../src/assert.js";
import { parseMessage } from "../src/agent/session.js";
import { ScenarioObject, type Assertion } from "../src/types.js";
import {
  CASSETTE_VERSION,
  assertRedactionVerdictPreserved,
  freezeRecordedRun,
  redactCassette,
  redactionRewroteHookOutput,
  replayCassette,
  requiredVersionFor,
  type Cassette,
} from "../src/run/cassette.js";
import { loadRedactionPolicy } from "../src/redact.js";
import { loadBaseline } from "../src/baseline.js";
import { assertContradiction, hookOutputContradictions, warnAmbiguousHookOutputForPlan } from "../src/run/execute.js";
import { warnAmbiguousHookOutput } from "../src/run/hook-events.js";
import type { RunResult, Scenario } from "../src/types.js";
import type { LaunchPlan } from "../src/session.js";
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
// Verified where they are (verify-run only reads; a copy is refused, its result.json naming the original); skipped
// where they do not exist (another machine, CI).
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
    const dir = join(RUNS, rel);
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

  it("warns when the operator's hooks are visible (protocol off the sealed config dir), even with one plugin", () => {
    const out = msgs([plugin(["Stop"])], NOT, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/reads your real config dir.*plugin installed on this machine may also answer it/);
    expect(out[0]).not.toMatch(/allow_host_hooks/);
  });

  it("is silent with one declaring plugin, when the second declares another event, or with no hook_output_* key", () => {
    expect(msgs([plugin(["Stop"])], NOT)).toEqual([]);
    expect(msgs([plugin(["Stop"]), plugin(["PreToolUse"])], NOT)).toEqual([]);
    expect(msgs([plugin(["Stop"]), plugin(["Stop"])], [{ hook_event_fired: "Stop" }], true)).toEqual([]);
  });

  it("covers the blocked and decision keys too, naming the keys that read the event", () => {
    const two = [plugin(["Stop", "PreToolUse"]), plugin(["Stop", "PreToolUse"])];
    const out = msgs(two, [
      { hook_event_blocked: "Stop" },
      { hook_event_blocked: { event: "Stop", max: 0 } },
      { hook_decision: { event: "PreToolUse", decision: "deny" } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/hook_decision on `PreToolUse`: 2 staged plugins/);
    expect(out[1]).toMatch(/hook_event_blocked on `Stop`: 2 staged plugins/);
  });

  it("no_hook_event_blocked: true reads every event, so it warns for each event two plugins declare", () => {
    const out = msgs([plugin(["Stop", "PreToolUse"]), plugin(["Stop"])], [{ no_hook_event_blocked: true }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no_hook_event_blocked on `Stop`: 2 staged plugins/);
    expect(msgs([plugin(["Stop"])], [{ no_hook_event_blocked: true }])).toEqual([]);
  });

  it("no_hook_event_blocked: true with operator hooks visible warns even when no staged plugin declares hooks", () => {
    const out = msgs([], [{ no_hook_event_blocked: true }], true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no_hook_event_blocked on `any event`: this protocol run reads your real config dir/);
  });
});

// A hook_started whose hook_response never arrived (paired by hook_id): an async or backgrounded hook, or one still
// running at teardown. Built from the recorded frames by DROPPING response lines, never by typing new ones.
describe("hook_output_*: a hook that started without a response", () => {
  const responses = loadHookFrames().filter((f) => f.subtype === "hook_response");
  const without = (...ids: unknown[]) =>
    ctx(
      loadHookFrames()
        .filter((f) => !(f.subtype === "hook_response" && ids.includes(f.hook_id)))
        .flatMap((f) => parseMessage(f))
        .flatMap((e) => (e.type === "system_event" ? [{ subtype: e.subtype, data: e.data }] : [])),
    );
  const second = responses[1]!.hook_id;

  it("not_contains is evidence-unavailable, not a pass, when the clean second response is missing", () => {
    // Control: with both responses the same assertion passes.
    expect(run({ hook_output_not_contains: { event: "Stop", text: "no handover.txt" } } as Assertion, ctx(recorded())).pass).toBe(true);
    const r = run({ hook_output_not_contains: { event: "Stop", text: "no handover.txt" } } as Assertion, without(second));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable: hook_output_not_contains: 1 `Stop` hook\(s\) started without a response/);
  });

  it("a hit on a frame that did respond still fails not_contains and passes contains", () => {
    const c = without(second);
    expect(run({ hook_output_not_contains: { event: "Stop", text: STOP_STDERR } } as Assertion, c).message).toMatch(
      /^hook_output_not_contains: 1 `Stop` hook frame/,
    );
    expect(run({ hook_output_contains: { event: "Stop", text: STOP_STDERR } } as Assertion, c).pass).toBe(true);
  });

  it("contains: a miss names the unanswered hook and is evidence-unavailable", () => {
    const r = run({ hook_output_contains: { event: "Stop", text: "never printed" } } as Assertion, without(second));
    expect(r.message).toMatch(/^evidence unavailable: hook_output_contains: .*\(1 `Stop` hook\(s\) started without a response\)/);
  });

  it("no response at all: both keys evidence-unavailable, never 'the plugin declares no such hook'", () => {
    for (const k of ["hook_output_contains", "hook_output_not_contains"]) {
      const r = run({ [k]: { event: "Stop", text: "x" } } as unknown as Assertion, without(...responses.map((f) => f.hook_id)));
      expect(r.message).toMatch(/^evidence unavailable: .*2 `Stop` hook\(s\) started without a response/);
      expect(r.message).not.toMatch(/declares no such hook/);
    }
  });

  it("a recording without hook_started frames grades as before", () => {
    const c = ctx(recorded().filter((e) => e.subtype !== "hook_started"));
    expect(run({ hook_output_not_contains: { event: "Stop", text: "no handover.txt" } } as Assertion, c).pass).toBe(true);
  });
});

// The agent's spill note (read from the staged binary): an async hook's output past the in-memory cap is cut, the
// note is appended to stdout, and stderr comes back "".
describe("hook_output_*: output the agent truncated", () => {
  const SPILL = "\nOutput truncated (9000KB total). Full output saved to: /tmp/x/tasks/abc.output";
  const truncated = (stdout: string) =>
    ctx(recorded((f) => (f.subtype === "hook_response" && f.exit_code === 0 ? { ...f, stdout: `${stdout}${SPILL}`, stderr: "" } : f)));

  it("not_contains is evidence-unavailable on a miss", () => {
    const r = run({ hook_output_not_contains: { event: "Stop", stream: "stderr", text: "no handover.txt" } } as Assertion, truncated("ok"));
    expect(r.message).toMatch(/^evidence unavailable: .*1 `Stop` frame\(s\) carry output the agent truncated/);
  });

  it("a hit before the note still counts; the note itself is never matched", () => {
    expect(
      run({ hook_output_contains: { event: "Stop", stream: "stdout", text: "kept part" } } as Assertion, truncated("kept part")).pass,
    ).toBe(true);
    const r = run({ hook_output_contains: { event: "Stop", matches: "output truncated" } } as Assertion, truncated("ok"));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/^evidence unavailable: .*\(1 carry output the agent truncated\)/);
  });
});

describe("hook_output_* evidence excerpts", () => {
  afterEach(() => vi.unstubAllEnvs());
  const withStderr = (stderr: string) => ctx(recorded((f) => (f.subtype === "hook_response" ? { ...f, stderr } : f)));
  const shown = (evidence: string) => JSON.parse(evidence.slice(evidence.indexOf(': "') + 2)) as string;

  it.each([
    ["labelled tokens", TOKEN],
    ["bare tokens (as long as their rendering)", "[REDACTED]"],
  ])("widening the start around %s never cuts the hit off the end", (_l, tok) => {
    const s = "a".repeat(500) + tok.repeat(30) + "NEEDLE";
    const r = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: "NEEDLE" } } as Assertion, withStderr(s));
    expect(r.pass).toBe(true);
    expect(shown(r.evidence!)).toMatch(/NEEDLE$/);
    // With text after the hit, the widened start pulls the end in by the same amount: the ~200-char bound holds.
    const tail = run(
      { hook_output_contains: { event: "Stop", stream: "stderr", text: "NEEDLE" } } as Assertion,
      withStderr(`${s} ${"b".repeat(300)}`),
    );
    expect(shown(tail.evidence!)).toContain("NEEDLE");
    expect(shown(tail.evidence!).length).toBeLessThanOrEqual(202);
    expect(shown(r.evidence!)).not.toMatch(/REDACTED/);
  });

  it("the whole stream is scrubbed before it is cut: a secret at the window's edge leaves no fragment", () => {
    const secret = "sk-test-0123456789abcdefSECRET";
    vi.stubEnv("COWORK_HARNESS_SCRUB_VALUES", secret);
    // The un-scrubbed window would start mid-secret (its tail "SECRET" visible); scrubbed first, it cannot.
    for (const pad of [80, 90, 95, 100, 110]) {
      const s = "x".repeat(300) + secret + "y".repeat(pad) + "NEEDLE" + "z".repeat(300);
      const r = run({ hook_output_contains: { event: "Stop", stream: "stderr", text: "NEEDLE" } } as Assertion, withStderr(s));
      expect(r.pass).toBe(true);
      const ex = shown(r.evidence!);
      expect(ex).toContain("NEEDLE");
      for (let n = 4; n <= secret.length; n++) expect(ex).not.toContain(secret.slice(-n));
      for (let n = 4; n <= secret.length; n++) expect(ex).not.toContain(secret.slice(0, n));
    }
  });
});

// record's redaction self-check: a failing hook_output_* assertion over a stream the policy rewrote is not a
// verdict manufactured by redaction (only its quoted excerpt and evidence label change), so it must not refuse.
describe("record's redaction self-check over hook_output_* failures", () => {
  const tokenised = (s: string) => `${s} (cwd /Users/acme/project)`;
  it.each([
    ["a contains miss", { hook_output_contains: { event: "Stop", stream: "stderr", text: "never printed" } }],
    ["a not_contains hit", { hook_output_not_contains: { event: "Stop", stream: "stderr", text: "PINEAPPLE" } }],
  ])("%s does not make record refuse", async (_l, a) => {
    const base = hookCassette([a], tokenised);
    const red = redactCassette(base, POLICY);
    // the messages really do differ — this is the case the carve-out exists for
    const [mb, mr] = [(await replayed(base, Object.keys(a)[0]!)).message, (await replayed(red, Object.keys(a)[0]!)).message];
    expect(mb).not.toBe(mr);
    await expect(assertRedactionVerdictPreserved(base, red)).resolves.toBeUndefined();
  });

  it("GUARD-SENSITIVITY: a pass that redaction turns into a fail is still refused", async () => {
    const base = hookCassette([{ hook_output_not_contains: { event: "Stop", stream: "stderr", text: "no handover.txt" } }], tokenised);
    await expect(assertRedactionVerdictPreserved(base, redactCassette(base, POLICY))).rejects.toThrow(
      /redaction changed assertion failures/,
    );
  });

  it("GUARD-SENSITIVITY: two entries of the same key trading outcomes are still refused", async () => {
    const A = [
      { hook_output_contains: { event: "Stop", stream: "stderr", text: "ALPHA" } },
      { hook_output_contains: { event: "Stop", stream: "stderr", text: "BETA" } },
    ];
    await expect(
      assertRedactionVerdictPreserved(
        hookCassette(A, () => "ALPHA here"),
        hookCassette(A, () => "BETA here"),
      ),
    ).rejects.toThrow(/redaction changed assertion failures/);
  });

  it("another key's failing message keeps the full comparison", async () => {
    const base = hookCassette(
      [{ transcript_contains: "never said" }, { hook_output_contains: { event: "Stop", text: "PINEAPPLE" } }],
      tokenised,
    );
    await expect(assertRedactionVerdictPreserved(base, redactCassette(base, POLICY))).resolves.toBeUndefined();
  });
});

// The record path end to end: freezeRecordedRun over a run dir whose Stop stderr the repo policy tokenises.
describe("freezeRecordedRun emits the hook_output_* redaction finding", () => {
  it("warns naming the assertion, and still writes the cassette", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "hook-output-freeze-"));
    const frames = loadHookFrames().map((f) =>
      f.subtype === "hook_response" && typeof f.stderr === "string" && f.stderr
        ? { ...f, stderr: `${f.stderr} (cwd /Users/acme/project)` }
        : f,
    );
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        line({ type: "system", subtype: "init", tools: [], skills: [] }),
        ...frames.map(line),
        line({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    );
    writeFileSync(join(outDir, "control-out.jsonl"), "");
    const scenario = ScenarioObject.parse({
      name: "hook-output-freeze",
      fidelity: "container",
      prompt: "hi",
      assert: [{ hook_output_contains: { event: "Stop", stream: "stderr", text: "PINEAPPLE" } }],
    }) as unknown as Scenario;
    const result = {
      mode: "run",
      command: "record",
      scenario: scenario.name,
      prompt: scenario.prompt,
      fidelity: "container",
      effectiveFidelity: "container",
      result: "success",
      baseline: LIVE,
      outDir,
      userVisibleRoots: ["outputs"],
      fingerprint: { baseline: LIVE, hashFormat: "jcs1" },
      assertions: [],
      egress: [],
    } as unknown as RunResult;
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const cassettePath = join(outDir, "c.cassette.json");
      await freezeRecordedRun(scenario, { noRedact: false, allowFailing: true, cassettePath }, [], result);
      const stderr = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(stderr).toMatch(
        /::warning:: record: assert\[0\] hook_output_contains on Stop: 1 `Stop` hook_response frame carries a redaction token in stderr/,
      );
      expect(existsSync(cassettePath)).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// The plan-level wiring: which mounts count, and when the operator's own hooks are visible.
describe("warnAmbiguousHookOutputForPlan", () => {
  afterEach(() => vi.unstubAllEnvs());
  const hooked = () => {
    const root = mkdtempSync(join(tmpdir(), "hook-output-plan-"));
    mkdirSync(join(root, "hooks"));
    writeFileSync(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
    );
    return root;
  };
  const NOT = [{ hook_output_not_contains: { event: "Stop", text: "x" } }] as Assertion[];
  const msgs = (plan: Partial<LaunchPlan>, tier: string) => {
    const out: string[] = [];
    warnAmbiguousHookOutputForPlan(plan as LaunchPlan, tier, NOT, (m) => out.push(m));
    return out;
  };
  const configDir = () => mkdtempSync(join(tmpdir(), "hook-output-cfg-"));

  it("counts plugin mounts only: a folder holding a hooks.json is not a second plugin", () => {
    const mounts = [
      { kind: "local-plugin", hostPath: hooked() },
      { kind: "folder", hostPath: hooked() },
    ] as LaunchPlan["mounts"];
    expect(msgs({ mounts, configDir: configDir() }, "container")).toEqual([]);
    const two = [
      { kind: "local-plugin", hostPath: hooked() },
      { kind: "marketplace-plugin", hostPath: hooked() },
    ] as LaunchPlan["mounts"];
    expect(msgs({ mounts: two, configDir: configDir() }, "container")[0]).toMatch(/2 staged plugins declare `Stop`/);
  });

  it("protocol reading the operator's real config dir warns; sealed, or another tier, does not", () => {
    const operator = configDir();
    vi.stubEnv("CLAUDE_CONFIG_DIR", operator);
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) vi.stubEnv(k, "");
    const mounts = [{ kind: "local-plugin", hostPath: hooked() }] as LaunchPlan["mounts"];
    const plan = { mounts, configDir: configDir(), baseEnv: {} };
    vi.stubEnv("COWORK_MANAGED_CONFIG", "0");
    expect(msgs(plan, "protocol")[0]).toMatch(/reads your real config dir/);
    expect(msgs(plan, "container")).toEqual([]);
    vi.stubEnv("COWORK_MANAGED_CONFIG", "1");
    expect(msgs(plan, "protocol")).toEqual([]);
    // managed, but the "managed" dir IS the operator's: still visible
    expect(msgs({ ...plan, configDir: operator }, "protocol")[0]).toMatch(/reads your real config dir/);
    // a bad COWORK_MANAGED_CONFIG is left for the spawn to refuse
    vi.stubEnv("COWORK_MANAGED_CONFIG", "yes");
    expect(() => msgs(plan, "protocol")).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadBaseline } from "../src/baseline.js";
import { buildSessionFingerprint } from "../src/run/cassette.js";
import { loadSession, buildLaunchPlan, applySessionOverrides } from "../src/session.js";
import { agentArgs } from "../src/runtime/argv.js";
import { Run } from "../src/run/run.js";
import { parseMessage } from "../src/agent/session.js";
import type { AgentEvent, AgentSession, DecisionResponse } from "../src/agent/session.js";
import { ScriptedDecider } from "../src/decide/decider.js";
import {
  deriveModelProvenance,
  noModelProvenance,
  unresolvedModelRefusal,
  ModelUnresolvedError,
  envModelDefault,
  resolvePinnedModel,
} from "../src/run/model-provenance.js";
import { UsageError } from "../src/errors.js";

/** The point of these tests is the THIRD state.
 *
 *  The natural implementation — `pinned && observed.length && !observed.includes(pinned)` — passes
 *  silently when there is no evidence, rendering "we could not tell" as "the pin held". That is the false
 *  green this module exists to prevent, so the no-evidence cases are asserted as `undefined` explicitly
 *  rather than left to a truthiness check that would accept either answer. */
describe("deriveModelProvenance", () => {
  it("pinned, model observed, no fallback → honored", () => {
    const p = deriveModelProvenance("claude-opus-5", ["claude-opus-5"], []);
    expect(p.modelPinHonored).toBe(true);
    expect(p.modelSource).toBe("user_setting");
  });

  it("pinned but the agent fell back → NOT honored, even though the pinned id is still in models[]", () => {
    // The pinned model appears in `models` because the first turns used it; the fallback happened later.
    // An id-membership check alone would call this honored — the fallback EVENT is what refutes it, and
    // this case is the reason the check consults it rather than diffing ids.
    const p = deriveModelProvenance(
      "claude-opus-5",
      ["claude-opus-5", "claude-sonnet-5"],
      [{ trigger: "model_not_found", originalModel: "claude-opus-5", fallbackModel: "claude-sonnet-5" }],
    );
    expect(p.modelPinHonored).toBe(false);
  });

  it("pinned, but a DIFFERENT model ran with no fallback event → not honored", () => {
    const p = deriveModelProvenance("claude-opus-5", ["claude-sonnet-5"], []);
    expect(p.modelPinHonored).toBe(false);
  });

  it("pinned but NO model evidence → unverifiable, never a pass", () => {
    // The unreadable-cassette lane sets `models: undefined`. Reporting `true` here would be a green
    // built on nothing.
    expect(deriveModelProvenance("claude-opus-5", undefined, []).modelPinHonored).toBeUndefined();
    expect(deriveModelProvenance("claude-opus-5", [], []).modelPinHonored).toBeUndefined();
  });

  it("nothing pinned → unresolved, and honored is unverifiable rather than true", () => {
    const p = deriveModelProvenance(undefined, ["claude-sonnet-5"], []);
    expect(p.modelSource).toBe("unresolved");
    expect(p.modelPinHonored).toBeUndefined();
  });

  it("drops `<synthetic>` before judging the pin", () => {
    // A locally-fabricated assistant turn stamps `<synthetic>`; counting it as a live id would make a
    // synthesized turn look like a model substitution.
    const p = deriveModelProvenance("claude-opus-5", ["claude-opus-5", "<synthetic>"], []);
    expect(p.modelPinHonored).toBe(true);
  });

  it("a run whose ONLY model id is `<synthetic>` is unverifiable, not a failure", () => {
    // After filtering there is no live evidence at all — the same no-evidence case as an empty array,
    // and it must not read as "the agent ran a different model".
    expect(deriveModelProvenance("claude-opus-5", ["<synthetic>"], []).modelPinHonored).toBeUndefined();
  });

  it("carries fallbacks through even when the pin is unverifiable", () => {
    // Replay passes `undefined` for the pin but the recorded fallbacks are real facts from the recording.
    const fallbacks = [{ trigger: "overloaded" }];
    const p = deriveModelProvenance(undefined, ["claude-sonnet-5"], fallbacks);
    expect(p.modelPinHonored).toBeUndefined();
    expect(p.modelFallbacks).toEqual(fallbacks);
  });

  // --- alias / [1m] / case: a pin the AGENT considers honored must not report a confident `false` ---
  // The mirror image of the false green above. `false` is documented as "the agent fell back off it";
  // asserting that from a string mismatch the binary itself does not make is a false RED.

  // LIVE-VERIFIED 2026-08-30: `run --model opus` ran and the agent reported `claude-opus-5` — it RESOLVES
  // a family alias to a concrete id rather than echoing the alias back. So a family pin is checkable as
  // MEMBERSHIP (equality would report a false `false`), while an alias naming no family is not.
  it("a family-alias pin is honored by any member of that family", () => {
    expect(deriveModelProvenance("opus", ["claude-opus-4-8"], []).modelPinHonored).toBe(true);
    expect(deriveModelProvenance("opus", ["claude-opus-5"], []).modelPinHonored).toBe(true);
    expect(deriveModelProvenance("sonnet", ["claude-sonnet-4-6"], []).modelPinHonored).toBe(true);
  });

  it("a family-alias pin still catches a model from the WRONG family", () => {
    // The check must not be so loose that it can no longer fail — the whole point of the field.
    expect(deriveModelProvenance("opus", ["claude-sonnet-5"], []).modelPinHonored).toBe(false);
    expect(deriveModelProvenance("haiku", ["claude-opus-5"], []).modelPinHonored).toBe(false);
  });

  it("an alias naming no family stays unverifiable", () => {
    // `best` can map to anything the account offers; `opusplan` selects a planning mode. Neither can be
    // checked against a resolved id, so `undefined` is the only honest answer.
    for (const alias of ["best", "opusplan"])
      expect(deriveModelProvenance(alias, ["claude-opus-4-8"], []).modelPinHonored, alias).toBeUndefined();
  });

  it("a `[1m]` pin is honored by the bare id", () => {
    // `[1m]` selects a context window on the SAME model — the binary strips it before comparing.
    expect(deriveModelProvenance("claude-sonnet-4-6[1m]", ["claude-sonnet-4-6"], []).modelPinHonored).toBe(true);
  });

  it("comparison is case-insensitive, as the binary's own comparator is", () => {
    expect(deriveModelProvenance("Claude-Opus-4-8", ["claude-opus-4-8"], []).modelPinHonored).toBe(true);
  });

  it("a genuinely different model still reports false", () => {
    // The normalization must not be so eager that it can no longer detect a real substitution.
    expect(deriveModelProvenance("claude-opus-5", ["claude-sonnet-5"], []).modelPinHonored).toBe(false);
  });

  // --- fallback attribution: only a fallback OFF the pin refutes the pin ---

  it("a fallback whose target IS the pinned model does not refute it", () => {
    // Reachable via `subagent_model:`: a sub-agent's haiku overloads and falls back onto the pinned opus.
    expect(
      deriveModelProvenance(
        "claude-opus-4-8",
        ["claude-opus-4-8"],
        [{ trigger: "overloaded", originalModel: "claude-haiku-4-5", fallbackModel: "claude-opus-4-8" }],
      ).modelPinHonored,
    ).toBe(true);
  });

  it("a fallback OFF the pinned model does refute it", () => {
    expect(
      deriveModelProvenance(
        "claude-opus-5",
        ["claude-opus-5"],
        [{ trigger: "model_not_found", originalModel: "claude-opus-5", fallbackModel: "claude-sonnet-5" }],
      ).modelPinHonored,
    ).toBe(false);
  });

  it("an UNATTRIBUTED fallback counts against the pin — fail toward reporting", () => {
    // No `originalModel` means we cannot rule out that it was the pinned turn. Silence would be the
    // riskier default: the whole point of the field is to surface a model that did not run as stated.
    expect(deriveModelProvenance("claude-opus-5", ["claude-opus-5"], [{ trigger: "overloaded" }]).modelPinHonored).toBe(false);
  });

  it("noModelProvenance claims nothing", () => {
    const p = noModelProvenance();
    expect(p.modelPinHonored).toBeUndefined();
    expect(p.modelFallbacks).toBeUndefined();
    expect(p.modelSource).toBe("unresolved");
  });
});

describe("unresolvedModelRefusal", () => {
  it("names the key, the flag and the environment variable, never a file path", () => {
    const w = unresolvedModelRefusal('scenario "s"');
    expect(w).toContain("`model:`");
    expect(w).toContain("--model");
    expect(w).toContain("COWORK_HARNESS_MODEL");
    // House style names keys and flags: the `skill` lane builds its session inline and has no file to
    // point at, so an "edit <file>" instruction would be wrong for exactly the lane that most needs it.
    expect(w).not.toMatch(/edit .*\.yaml|the file to edit/i);
  });

  it("names what was refused", () => {
    expect(unresolvedModelRefusal('scenario "my-scenario"')).toContain('scenario "my-scenario"');
  });

  it("describes a refusal, not a deprecation", () => {
    const w = unresolvedModelRefusal('scenario "s"');
    expect(w).not.toMatch(/deprecat|next major|::warning::/i);
  });

  it("states the instructions consequence, not just answer quality", () => {
    expect(unresolvedModelRefusal('scenario "s"')).toMatch(/INSTRUCTIONS/);
  });

  it("ModelUnresolvedError is a UsageError, so every lane maps it to its usage exit", () => {
    const e = new ModelUnresolvedError('scenario "s"');
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toBe(unresolvedModelRefusal('scenario "s"'));
  });
});

describe("envModelDefault", () => {
  it("reads COWORK_HARNESS_MODEL, and treats an empty value as unset", () => {
    // An empty model string must never reach argv (SPEC §CB-2), and must not satisfy the refusal either.
    expect(envModelDefault({ COWORK_HARNESS_MODEL: "claude-sonnet-5" })).toBe("claude-sonnet-5");
    expect(envModelDefault({ COWORK_HARNESS_MODEL: "" })).toBeUndefined();
    expect(envModelDefault({})).toBeUndefined();
  });
});

/** The message is unit-tested above; what these guard is that it is still WIRED before the spend. The
 *  behaviour is executed in test/model-required.test.ts; this is the cheap ordering check. */
describe("the refusal is wired before the agent is driven", () => {
  const read = (p: string) => readFileSync(resolve(p), "utf8");

  it("executeScenario throws it before the run dir is chosen and before run.drive(", () => {
    const src = read("src/run/execute.ts");
    const refuseAt = src.indexOf("throw new ModelUnresolvedError(");
    const outDirAt = src.indexOf("const outDir = runOutDir(");
    const driveAt = src.indexOf("run.drive(");
    expect(refuseAt).toBeGreaterThan(-1);
    expect(outDirAt).toBeGreaterThan(-1);
    expect(driveAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeLessThan(outDirAt);
    expect(refuseAt).toBeLessThan(driveAt);
  });

  it("chat refuses before its --raw branch, so both chat lanes refuse", () => {
    const src = read("src/run/chat.ts");
    const refuseAt = src.indexOf("unresolvedModelRefusal(");
    const rawAt = src.indexOf("if (raw) {");
    expect(refuseAt).toBeGreaterThan(-1);
    expect(rawAt).toBeGreaterThan(-1);
    expect(refuseAt).toBeLessThan(rawAt);
  });
});

/** The `--model` flag has to survive the whole chain — CLI token → session override → `LaunchPlan.model`
 *  → `--model` in argv. A flag that parses but never reaches the spawn is worse than no flag: the user
 *  believes the run is pinned, the warning goes quiet, and the run is still unpinned. */
describe("--model reaches the launch plan and the argv", () => {
  const baseline = loadBaseline("latest");
  const out = () => mkdtempSync(join(tmpdir(), "mp-out-"));
  const planFor = (session: Parameters<typeof buildLaunchPlan>[0]) => buildLaunchPlan(session, baseline, out(), "container", false);

  it("a session with no model produces a plan with no model — the state executeScenario refuses", () => {
    expect(planFor(loadSession({})).model).toBeUndefined();
  });

  it("applySessionOverrides({model}) — what --model does — lands on the plan", () => {
    const overridden = applySessionOverrides(loadSession({}), { model: "claude-opus-5" });
    expect(planFor(overridden).model).toBe("claude-opus-5");
  });

  it("the override BEATS a session file that pinned something else", () => {
    const overridden = applySessionOverrides(loadSession({ model: "claude-sonnet-5" }), { model: "claude-opus-5" });
    expect(planFor(overridden).model).toBe("claude-opus-5");
  });

  it("a planned model actually emits `--model <id>` in the agent argv", () => {
    // The last link. argv emits the flag conditionally, so a plan carrying the model is necessary but
    // not sufficient — this asserts the flag and its value land adjacently in the real argv.
    const argv = agentArgs(baseline, planFor(applySessionOverrides(loadSession({}), { model: "claude-opus-5" })), { mntRoot: "/mnt" });
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5");
  });

  it("no planned model emits NO --model flag", () => {
    const argv = agentArgs(baseline, planFor(loadSession({})), { mntRoot: "/mnt" });
    expect(argv).not.toContain("--model");
  });
});

/** The ingestion path, end to end and token-free: a raw stream-json `system`/`model_fallback` message
 *  through `parseMessage` into a `Run`, checked as it lands in `RunRecord.modelFallbacks`.
 *
 *  Worth its own test because the field NAMES cross a boundary here — the wire is snake_case
 *  (`original_model`), the record is camelCase (`originalModel`) — and nothing else in the suite would
 *  notice if that mapping were wrong. Every earlier test in this file starts from an already-shaped
 *  object and so cannot see it. */
describe("model_fallback ingestion, wire → record", () => {
  class MockSession implements AgentSession {
    constructor(private events: AgentEvent[]) {}
    async *start(): AsyncIterable<AgentEvent> {
      for (const e of this.events) yield e;
    }
    sendUserTurn() {}
    respond(_id: string, _r: DecisionResponse) {
      return { delivered: true };
    }
    close() {}
  }

  const wire = {
    type: "system",
    subtype: "model_fallback",
    trigger: "model_not_found",
    original_model: "claude-opus-5",
    fallback_model: "claude-sonnet-5",
  };

  it("parseMessage carries an unknown system subtype through with its payload intact", () => {
    const evs = parseMessage(wire);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "system_event", subtype: "model_fallback" });
    // The envelope keys are stripped; every payload field must survive.
    expect((evs[0] as { data: Record<string, unknown> }).data).toEqual({
      trigger: "model_not_found",
      original_model: "claude-opus-5",
      fallback_model: "claude-sonnet-5",
    });
  });

  it("Run records it with the wire fields mapped onto the record's own names", async () => {
    const rec = await new Run(new MockSession(parseMessage(wire)), new ScriptedDecider([])).drive("go");
    expect(rec.modelFallbacks).toEqual([{ trigger: "model_not_found", originalModel: "claude-opus-5", fallbackModel: "claude-sonnet-5" }]);
  });

  it("a fallback with no model names still records its trigger", async () => {
    // `original_model`/`fallback_model` are optional in the record's own type; the trigger is what the
    // verdict message needs, so a partial payload must not be dropped wholesale.
    const evs = parseMessage({ type: "system", subtype: "model_fallback", trigger: "overloaded" });
    const rec = await new Run(new MockSession(evs), new ScriptedDecider([])).drive("go");
    expect(rec.modelFallbacks).toEqual([{ trigger: "overloaded" }]);
  });

  it("a malformed trigger degrades to `unknown` rather than dropping the event", async () => {
    // Losing the event entirely would report a fallback-free run — a false clean on the exact condition
    // this channel exists to surface.
    const evs = parseMessage({ type: "system", subtype: "model_fallback", trigger: 42 });
    const rec = await new Run(new MockSession(evs), new ScriptedDecider([])).drive("go");
    expect(rec.modelFallbacks).toEqual([{ trigger: "unknown" }]);
  });

  it("an ordinary run records no fallbacks", async () => {
    const rec = await new Run(
      new MockSession([{ type: "assistant_text", text: "hi", model: "claude-opus-5" }]),
      new ScriptedDecider([]),
    ).drive("go");
    expect(rec.modelFallbacks).toEqual([]);
  });
});

/** Precedence. The regression this guards was introduced by the very change meant to fix unpinned
 *  models: `COWORK_HARNESS_MODEL` was read as an OVERRIDE rather than a default, so it silently outranked
 *  a session file's declared `model:` — a machine-scoped variable deciding the run's model while
 *  `modelSource` still reported `user_setting`. A stray line in a repo `.env` would have done it to every
 *  clone. */
describe("resolvePinnedModel — precedence", () => {
  it("an explicit --model / matrix axis outranks the session file", () => {
    expect(resolvePinnedModel("claude-opus-5", "claude-opus-4-8", undefined)).toBe("claude-opus-5");
  });

  it("the ENV DEFAULT NEVER outranks a session file that declares a model", () => {
    // The regression, stated as a test. If this ever flips, the run's model is a property of the shell.
    expect(resolvePinnedModel(undefined, "claude-opus-4-8", "claude-haiku-4-5")).toBe("claude-opus-4-8");
  });

  it("the env default fills a gap when the session declares nothing", () => {
    expect(resolvePinnedModel(undefined, undefined, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("an explicit flag outranks the env default too", () => {
    expect(resolvePinnedModel("claude-opus-5", undefined, "claude-haiku-4-5")).toBe("claude-opus-5");
  });

  it("nothing pinned anywhere → undefined, the state that is refused", () => {
    expect(resolvePinnedModel(undefined, undefined, undefined)).toBeUndefined();
  });
});

/** SPEC §CB-2: an empty or whitespace `--model` value is a usage error, never a silently-propagated empty
 *  model string. `record` inherits this from the shared parser; `run` hand-rolls its loop (because the
 *  session-less lanes take `--model` out of the leftovers themselves), so it has to enforce the rule
 *  itself — and did not, until this test. An accepted empty value started a real, spending run. */
describe("SPEC CB-2 — an empty --model value never reaches a run", () => {
  const runCli = (args: string[]) => {
    const r = spawnSync("npx", ["tsx", "src/cli.ts", ...args], { encoding: "utf8", cwd: resolve(".") });
    return `${r.stdout}${r.stderr}`;
  };

  for (const form of [["--model", ""], ["--model", "   "], ["--model="]]) {
    it(`rejects \`${form.join(" ")}\` before spending`, () => {
      const out = runCli(["run", "e2e/scenarios/smoke-multiselect.yaml", ...form]);
      expect(out).toMatch(/--model requires a model id/);
      // The load-bearing half: it must not have STARTED a run.
      expect(out).not.toMatch(/running…/);
    });
  }
});

/** The `model_fallback` chain, end to end through the REAL CLI — the only way it can be exercised.
 *
 *  **Why synthetic and not live:** none of the six triggers can be provoked on demand. Measured
 *  2026-08-30 against a real agent: `--model <nonexistent>` does NOT fall back — the binary validates at
 *  startup and refuses the turn ("There's an issue with the selected model … It may not exist or you may
 *  not have access to it"), exiting with `resultErrorKind: "agent"` for $0.0000. So `model_not_found` is
 *  pre-empted before a turn exists. `overloaded`/`server_error` are transient, and
 *  `permission_denied`/`model_blocked` need an entitlement-restricted model. The agent-emits half is
 *  therefore unexerciseable by choice; the harness half — every line of code this repo owns — is fully
 *  exerciseable by injecting the frame the agent would have sent, which is what this does.
 *
 *  Injecting into a real cassette and replaying covers the whole path (parseMessage → Run → record →
 *  assembleRunResult → verdict) rather than the unit seams the tests above cover individually. */
describe("model_fallback surfaces through a real replay", () => {
  const FIXTURE = resolve("examples/replays/example-multiselect-gate.cassette.json");

  const replayWithFallback = (frame: Record<string, unknown>) => {
    const cassette = JSON.parse(readFileSync(FIXTURE, "utf8"));
    // After the init frame, so it lands mid-stream the way a real one would.
    cassette.events.splice(1, 0, JSON.stringify(frame));
    const dir = mkdtempSync(join(tmpdir(), "cwh-fb-"));
    const path = join(dir, "fb.cassette.json");
    writeFileSync(path, JSON.stringify(cassette));
    const r = spawnSync("npx", ["tsx", "src/cli.ts", "replay", path], { encoding: "utf8", cwd: resolve(".") });
    return `${r.stdout}${r.stderr}`;
  };

  it("a persistent trigger reaches the verdict as a warn signal, naming both models", () => {
    const out = replayWithFallback({
      type: "system",
      subtype: "model_fallback",
      trigger: "model_not_found",
      original_model: "claude-opus-5",
      fallback_model: "claude-sonnet-5",
    });
    expect(out).toMatch(/model_fallback:/);
    expect(out).toMatch(/fell back off claude-opus-5 to claude-sonnet-5/);
    expect(out).toMatch(/trigger: model_not_found/);
    // Persistent triggers must say so — that is the half that tells a reader whether to act.
    expect(out).toMatch(/persistent rather than transient/);
    // A warn never flips the verdict.
    expect(out).toMatch(/✓ success/);
  });

  it("a transient trigger says a re-run may hold", () => {
    const out = replayWithFallback({ type: "system", subtype: "model_fallback", trigger: "overloaded" });
    expect(out).toMatch(/trigger: overloaded/);
    expect(out).toMatch(/transient — a re-run may well hold/);
  });

  it("on replay — which pins nothing — it never claims a pinned model exists", () => {
    // Replay resolves no model by design, so the "change the pinned id" advice would name nothing.
    const out = replayWithFallback({ type: "system", subtype: "model_fallback", trigger: "model_not_found" });
    expect(out).not.toMatch(/until the pinned id is changed/);
    expect(out).toMatch(/nor any model the scenario names/);
  });
});

/** The pre-coverage note fires on EVERY cassette recorded before the field existed — for a consumer with
 *  a dozen heavy cassettes that is a dozen identical lines competing with the findings that are genuinely
 *  per-file. The renderer keeps notes per-file deliberately (attribution is what a verify sweep is for),
 *  so LENGTH is the part that was ours to fix: the note states what and what-to-do, and the reasoning
 *  lives in docs/fidelity-gaps.md where it is read once instead of N times. */
describe("the pre-coverage note stays terse", () => {
  // Since the 2.2553.1 re-records EVERY committed cassette carries `model` coverage, so no committed
  // fixture emits this note any more — which is the right end state, and also the reason this test can
  // no longer read it off `examples/replays`. Build a pre-coverage cassette SYNTHETICALLY instead: a real
  // cassette whose sessionFingerprint is rewritten to the pre-`model` hash, in a temp tree that keeps the
  // relative `../../e2e/sessions/…` layout so the session still resolves. The alternative — "assert the
  // note's shape only when one is present" — would be a test that cannot fail.
  const preCoverageDir = (): string => {
    const src = resolve("examples/replays/example-multiselect-gate.cassette.json");
    const cassette = JSON.parse(readFileSync(src, "utf8"));
    const root = mkdtempSync(join(tmpdir(), "cwh-precov-"));
    const replays = join(root, "examples", "replays");
    const sessions = join(root, "e2e", "sessions");
    mkdirSync(replays, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    copyFileSync(resolve("e2e/sessions/minimal.yaml"), join(sessions, "minimal.yaml"));
    const preModel = buildSessionFingerprint(cassette.scenario.session, replays, undefined, { omitModel: true });
    expect(preModel, "could not build the pre-`model` fingerprint for the synthetic fixture").toBeDefined();
    cassette.sessionFingerprint = preModel;
    writeFileSync(join(replays, "precoverage.cassette.json"), JSON.stringify(cassette));
    return replays;
  };

  it("is one line, in the same register as the prompt-assets note beside it", () => {
    const out = spawnSync("npx", ["tsx", "src/cli.ts", "verify-cassettes", preCoverageDir()], {
      encoding: "utf8",
      cwd: resolve("."),
    });
    const line = `${out.stdout}${out.stderr}`.split("\n").find((l) => l.includes("[note] session-fingerprint"));
    expect(line, "expected a pre-coverage note on the synthetic pre-`model` cassette").toBeDefined();
    const message = line!.split("[note] ")[1];
    // The prompt-assets precedent is ~130 chars. A paragraph here regressed to ~370.
    expect(message.length).toBeLessThan(200);
    // Still actionable: it must name the field and the remedy.
    expect(message).toMatch(/model/);
    expect(message).toMatch(/Re-record/);
  });

  it("never fails the gate — a consumer upgrading must not see red for this", () => {
    const out = spawnSync("npx", ["tsx", "src/cli.ts", "verify-cassettes", "examples/replays"], {
      encoding: "utf8",
      cwd: resolve("."),
    });
    expect(out.status, "pre-coverage cassettes must stay clean").toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/cassette\(s\) clean/);
  });
});

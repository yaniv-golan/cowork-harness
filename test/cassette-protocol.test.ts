import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayCassette, parseMaxArtifactBytes, buildManifest, readCassette, defaultCassettePath } from "../src/run/cassette.js";
import { slugForPath } from "../src/run/execute.js";

/** Silence ::warning:: noise these tests intentionally provoke. */
const origWrite = process.stderr.write.bind(process.stderr);
afterEach(() => {
  process.stderr.write = origWrite;
});
function muteStderr(): string[] {
  const lines: string[] = [];
  process.stderr.write = ((s: string | Uint8Array) => (lines.push(String(s)), true)) as typeof process.stderr.write;
  return lines;
}

const makeScenario = (assert: unknown[]) => ({
  name: "c",
  baseline: "latest",
  session: "(inline)",
  fidelity: "container" as const,
  prompt: "hi",
  answers: [],
  expect_denied: [],
  assert,
});

/** A minimal full-fidelity cassette: one permission decision + a matching control_response. */
function permCassette(controlOut: string[], assert: unknown[] = [{ result: "success" as const }]): any {
  const events = [
    JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
    JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "toolu_1", input: { path: "x" } },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ];
  return { scenario: makeScenario(assert), events, controlOut };
}

const allowFrame = (rid: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: rid, response: { behavior: "allow", updatedInput: {}, ...extra } },
  });

describe("malformed controlOut lines are an unconditional cassette-corruption failure", () => {
  it("fails replay_protocol_fidelity even without --strict (not warn-and-skip)", async () => {
    muteStderr();
    // A malformed (non-JSON) controlOut line that is not referenced by any decision used to be silently
    // dropped, letting a corrupt cassette green. Now it is an unconditional failure.
    const cassette = permCassette(["{ this is not valid json", allowFrame("req-1")]);
    const r = await replayCassette(cassette); // NO --strict
    const fail = r.assertions.find((a) => !a.pass && /control-out\.jsonl line .* is not valid JSON/.test(a.message ?? ""));
    expect(fail).toBeDefined();
    expect((fail!.assertion as any).replay_protocol_fidelity).toBe(true);
  });
});

describe("conflicting duplicate controlOut IDs are an unconditional corruption failure", () => {
  it("fails replay_protocol_fidelity even without --strict when two entries share an id with different bodies", async () => {
    muteStderr();
    const cassette = permCassette([
      allowFrame("req-1"),
      // same request_id, DIFFERENT body (deny) — contradictory protocol data.
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: "req-1", response: { behavior: "deny", message: "nope" } },
      }),
    ]);
    const r = await replayCassette(cassette); // NO --strict
    const fail = r.assertions.find((a) => !a.pass && /duplicate request_id "req-1" with differing bodies/.test(a.message ?? ""));
    expect(fail).toBeDefined();
    expect((fail!.assertion as any).replay_protocol_fidelity).toBe(true);
  });

  it("byte-identical duplicate ids do NOT fail (deduped)", async () => {
    muteStderr();
    const cassette = permCassette([allowFrame("req-1"), allowFrame("req-1")]);
    const r = await replayCassette(cassette);
    expect(r.assertions.some((a) => !a.pass && /duplicate request_id/.test(a.message ?? ""))).toBe(false);
  });
});

describe("skill_triggered / no_skill_triggered evaluate end-to-end on replay (Wave 1 / E8)", () => {
  it("skill_triggered passes when the cassette's re-drive shows the skill invoked", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Skill"] }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "my-pdf-skill:my-pdf-skill" } }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette: any = { scenario: makeScenario([{ skill_triggered: "my-pdf-skill" }]), events, controlOut: [] };
    const r = await replayCassette(cassette);
    expect(r.assertions.every((a) => a.pass)).toBe(true);
  });

  it("no_skill_triggered fails end-to-end when the cassette's re-drive shows a matching skill invoked", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Skill"] }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "my-pdf-skill:my-pdf-skill" } }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette: any = { scenario: makeScenario([{ no_skill_triggered: "my-pdf-skill" }]), events, controlOut: [] };
    const r = await replayCassette(cassette);
    expect(r.assertions.some((a) => !a.pass)).toBe(true);
  });
});

describe("budget assertions evaluate end-to-end on replay (Wave 1 / E6a)", () => {
  it("max_cost_usd/max_tokens/tool_calls_max pass against a recorded cassette within budget", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { path: "x" } }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.02,
      }),
    ];
    const cassette: any = {
      scenario: makeScenario([{ max_cost_usd: 0.05 }, { max_tokens: 200 }, { tool_calls_max: 5 }]),
      events,
      controlOut: [],
    };
    const r = await replayCassette(cassette);
    expect(r.assertions.every((a) => a.pass)).toBe(true);
  });

  it("max_cost_usd fails end-to-end when the cassette's re-drive exceeds budget", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 1.5 }),
    ];
    const cassette: any = { scenario: makeScenario([{ max_cost_usd: 0.5 }]), events, controlOut: [] };
    const r = await replayCassette(cassette);
    expect(r.assertions.some((a) => !a.pass)).toBe(true);
  });
});

describe("max_turns evaluates end-to-end on replay (Wave 2 / E6b)", () => {
  it("passes when the re-drive's turn count is within budget, fails when it exceeds it", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: [] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3 }),
    ];
    const passCassette: any = { scenario: makeScenario([{ max_turns: 5 }]), events, controlOut: [] };
    const passResult = await replayCassette(passCassette);
    expect(passResult.assertions.every((a) => a.pass)).toBe(true);

    const failCassette: any = { scenario: makeScenario([{ max_turns: 2 }]), events, controlOut: [] };
    const failResult = await replayCassette(failCassette);
    expect(failResult.assertions.some((a) => !a.pass)).toBe(true);
  });
});

describe("replay surfaces usage/cost from the re-driven record (Wave 0 seam)", () => {
  it("includes usage.turns and cost.usd on a replayed RunResult when the cassette recorded them", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: [] }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { output_tokens: 5 },
        total_cost_usd: 0.02,
        num_turns: 3,
      }),
    ];
    const cassette: any = { scenario: makeScenario([{ result: "success" as const }]), events, controlOut: [] };
    const r = await replayCassette(cassette);
    expect(r.usage).toMatchObject({ output_tokens: 5, turns: 3 });
    expect(r.cost).toMatchObject({ usd: 0.02 });
  });
});

describe("a malformed control frame in events fails per-cassette (does not throw / abort the batch)", () => {
  it("a non-string request_id on a control_request becomes a replay_protocol_fidelity failure, not a throw", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      // request_id is a number → toDecisionRequest throws; replay must catch it per-line and continue.
      JSON.stringify({
        type: "control_request",
        request_id: 999,
        request: { subtype: "can_use_tool", tool_name: "Write", input: { path: "x" } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette: any = { scenario: makeScenario([{ result: "success" as const }]), events, controlOut: [] };
    // Must NOT throw — the per-line catch converts it to a failing assertion.
    const r = await replayCassette(cassette);
    const fail = r.assertions.find((a) => !a.pass && /malformed control frame/.test(a.message ?? ""));
    expect(fail).toBeDefined();
    expect((fail!.assertion as any).replay_protocol_fidelity).toBe(true);
  });

  it("a malformed AskUserQuestion body becomes a replay_protocol_fidelity failure, not a throw", async () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["AskUserQuestion"] }),
      JSON.stringify({
        type: "control_request",
        request_id: "q-1",
        request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: "not-an-array" } },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const cassette: any = { scenario: makeScenario([{ result: "success" as const }]), events, controlOut: [] };
    const r = await replayCassette(cassette);
    expect(r.assertions.some((a) => !a.pass && /malformed control frame/.test(a.message ?? ""))).toBe(true);
  });
});

describe("COWORK_HARNESS_MAX_ARTIFACT_BYTES uses the same positive-integer validator as the flag", () => {
  it("parseMaxArtifactBytes rejects invalid / non-positive and floors valid", () => {
    expect(parseMaxArtifactBytes("not-a-number")).toBeNull();
    expect(parseMaxArtifactBytes("0")).toBeNull();
    expect(parseMaxArtifactBytes("-5")).toBeNull();
    expect(parseMaxArtifactBytes("128.9")).toBe(128);
    expect(parseMaxArtifactBytes("64")).toBe(64);
  });

  it("an invalid env value FAILS LOUD during manifest build (no silent fall-back to the default)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-mab-"));
    mkdirSync(join(d, "outputs"), { recursive: true });
    writeFileSync(join(d, "outputs", "x.json"), "{}");
    const prev = process.env.COWORK_HARNESS_MAX_ARTIFACT_BYTES;
    process.env.COWORK_HARNESS_MAX_ARTIFACT_BYTES = "garbage";
    try {
      // buildManifest with no explicit cap → defaultBodyCap() reads the env and must throw.
      expect(() => buildManifest(d)).toThrow(/COWORK_HARNESS_MAX_ARTIFACT_BYTES must be a positive integer/);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_MAX_ARTIFACT_BYTES;
      else process.env.COWORK_HARNESS_MAX_ARTIFACT_BYTES = prev;
    }
  });
});

describe("default cassette path is computed identically (slugForPath) for dry-run and live record", () => {
  it("routes a name with a path separator through slugForPath (no unintended sub-directory; matches live record)", () => {
    const name = "My Run / v2";
    const p = defaultCassettePath(name);
    // It routes through slugForPath — NOT the raw name. The raw name would create `cassettes/My Run / v2…`
    // (an unintended `My Run ` sub-dir); slugForPath converts `/` → `-` so the file lands directly under
    // `cassettes/`. This is exactly what recordScenarioObject uses, so dry-run can't diverge from record.
    expect(p).toBe(join("cassettes", `${slugForPath(name)}.cassette.json`));
    expect(p).not.toContain("/v2"); // the inner slash was slugified, not preserved
    expect(p.split("/").length).toBe(2); // "cassettes" + "<slug>.cassette.json" — no extra dir
  });

  it("a plain name is unchanged structurally", () => {
    expect(defaultCassettePath("simple")).toBe(join("cassettes", "simple.cassette.json"));
  });
});

describe("scenario.assert is validated-and-warned, never strict-rejected (forward-compat)", () => {
  it("a malformed assert element (type-wrong known field) WARNS but the cassette still LOADS (no hard reject)", () => {
    const lines = muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const d = mkdtempSync(join(tmpdir(), "cwh-a29-"));
    const cp = join(d, "fwd.cassette.json");
    // transcript_contains must be a string — a number is a malformed assertion shape.
    writeFileSync(cp, JSON.stringify({ scenario: makeScenario([{ transcript_contains: 123 }, { result: "success" }]), events }));
    const r = readCassette(cp);
    // Crucially: NOT an error — validate-and-WARN, never strict-reject (CassetteShape is .passthrough(),
    // so a cassette from a newer harness must still load). A strict-by-default load here would be a
    // forward-compat regression.
    expect("error" in r).toBe(false);
    // The malformed element is surfaced as a loud (non-fatal) warning.
    expect(lines.join("")).toMatch(/scenario\.assert\[0\] is not a recognized assertion shape/);
  });

  it("an UNKNOWN assert key (newer-harness forward-compat) loads WITHOUT error", () => {
    muteStderr();
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const d = mkdtempSync(join(tmpdir(), "cwh-a29b-"));
    const cp = join(d, "fwd.cassette.json");
    // A future assertion key this build doesn't know — must NOT be rejected (forward-compat).
    writeFileSync(cp, JSON.stringify({ scenario: makeScenario([{ some_future_assertion_key: "value" }]), events }));
    expect("error" in readCassette(cp)).toBe(false);
  });
});

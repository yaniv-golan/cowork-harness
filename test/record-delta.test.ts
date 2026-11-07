import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { behaviourSummary, describeBehaviourDelta, type Cassette, type ManifestEntry } from "../src/run/cassette.js";
import { recordedControlOut } from "./helpers/minimal-cassette.js";

// Minimal fixture builder — `behaviourSummary` only reads controlOut/events/artifacts, so we don't
// need a full Cassette (scenario, fingerprint, etc). The Pick<> signature on behaviourSummary is what
// lets us get away with this; if that signature ever widens, this file (not just the impl) breaks loudly.
function fixture(partial: { controlOut?: string[]; events?: string[]; artifacts?: ManifestEntry[] }) {
  return partial as Pick<Cassette, "controlOut" | "events" | "artifacts">;
}

// A single-select controlOut entry, matching the real shape confirmed below from
// examples/replays/example-multiselect-gate.cassette.json: a JSON *string* per controlOut entry,
// nested at response.response.updatedInput.questions[].
function gateEntry(questions: unknown[]): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "abc",
      response: { behavior: "allow", updatedInput: { questions } },
    },
  });
}

const ONE_QUESTION = [
  {
    question: "Which features should be enabled?",
    header: "Features",
    options: [{ label: "Auth", description: "auth" }],
    multiSelect: false,
  },
];

function toolUseEvent(toolNames: string[]): string {
  return JSON.stringify({
    message: {
      role: "assistant",
      content: toolNames.map((name) => ({ type: "tool_use", id: `t-${name}`, name, input: {} })),
    },
  });
}

describe("behaviourSummary", () => {
  it("counts one gate from a controlOut entry shaped like a real recorded AskUserQuestion answer", () => {
    const c = fixture({ controlOut: [gateEntry(ONE_QUESTION)] });
    expect(behaviourSummary(c).gates).toBe(1);
  });

  it("reports 0 gates when the fixture carries no controlOut (behaviourSummary reads the raw document)", () => {
    expect(behaviourSummary(fixture({})).gates).toBe(0);
  });

  it("reports 0 gates when controlOut is present but empty", () => {
    expect(behaviourSummary(fixture({ controlOut: recordedControlOut() })).gates).toBe(0);
  });

  // Regression guard: a truncated/corrupt controlOut line must not crash the whole delta report —
  // it's a reporting nicety layered on top of a successful record, not a check that should abort it.
  it("skips a malformed (unparseable) controlOut line without throwing", () => {
    const c = fixture({ controlOut: ["{not valid json", gateEntry(ONE_QUESTION)] });
    expect(() => behaviourSummary(c)).not.toThrow();
    expect(behaviourSummary(c).gates).toBe(1);
  });

  it("counts tool_use blocks across events, including multiple blocks in one message", () => {
    const c = fixture({
      events: [toolUseEvent(["Read"]), toolUseEvent(["Write", "Bash"]), JSON.stringify({ message: { role: "user", content: "hi" } })],
    });
    expect(behaviourSummary(c).toolCalls).toBe(3);
  });

  it("skips a malformed events line without throwing", () => {
    const c = fixture({ events: ["not json at all", toolUseEvent(["Read"])] });
    expect(() => behaviourSummary(c)).not.toThrow();
    expect(behaviourSummary(c).toolCalls).toBe(1);
  });

  it("reports artifacts as the manifest length", () => {
    const artifacts = [{ path: "outputs/a.txt" }, { path: "outputs/b.txt" }] as unknown as ManifestEntry[];
    expect(behaviourSummary(fixture({ artifacts })).artifacts).toBe(2);
  });

  // The synthetic fixtures above encode MY assumption about the real nesting; if that assumption is
  // wrong, they'd pass anyway (they'd just be testing the wrong shape). Running against a real,
  // committed cassette is what actually catches a bad shape guess — it fails loudly if `behaviourSummary`
  // stops reading what real `record` output actually contains.
  it("produces sane counts against the real example-multiselect-gate cassette (has a gate)", () => {
    const cassette = JSON.parse(readFileSync(resolve("examples/replays/example-multiselect-gate.cassette.json"), "utf8")) as Cassette;
    const summary = behaviourSummary(cassette);
    expect(summary.gates).toBeGreaterThanOrEqual(1);
    expect(summary.toolCalls).toBeGreaterThanOrEqual(1); // the scripted AskUserQuestion call itself
  });

  it("produces sane counts against the real example-pdf-skill cassette (has tool calls)", () => {
    const cassette = JSON.parse(readFileSync(resolve("examples/replays/example-pdf-skill.cassette.json"), "utf8")) as Cassette;
    const summary = behaviourSummary(cassette);
    expect(summary.toolCalls).toBeGreaterThanOrEqual(1);
    expect(summary.artifacts).toBe((cassette.artifacts ?? []).length);
  });
});

describe("describeBehaviourDelta", () => {
  // The headline regression this feature exists to surface: a skill that silently stops asking.
  it("renders a gate-count drop as 'gates 2 → 0'", () => {
    const msg = describeBehaviourDelta({ gates: 2, toolCalls: 5, artifacts: 1 }, { gates: 0, toolCalls: 5, artifacts: 1 });
    expect(msg).toBe("gates 2 → 0");
  });

  it("names every changed dimension, comma-separated, when more than one moves", () => {
    const msg = describeBehaviourDelta({ gates: 1, toolCalls: 3, artifacts: 2 }, { gates: 0, toolCalls: 4, artifacts: 5 });
    expect(msg).toBe("gates 1 → 0, tool calls 3 → 4, artifacts 2 → 5");
  });

  // Silence would be ambiguous between "nothing moved" and "nobody looked" — assert the actual
  // sentinel string the implementation emits, not just that it's non-empty.
  it("renders identical summaries as an explicit 'no behavioural change' message, not an empty string", () => {
    const same = { gates: 1, toolCalls: 2, artifacts: 3 };
    const msg = describeBehaviourDelta(same, { ...same });
    expect(msg).toBe("no behavioural change (transcript wording only)");
  });
});

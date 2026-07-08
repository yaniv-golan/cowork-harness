import { describe, it, expect } from "vitest";
import { replayCassette } from "../src/run/cassette.js";

/** A minimal cassette structure for testing. */
function makeMinimalCassette(overrides: Record<string, any> = {}): any {
  return {
    scenario: {
      name: "test",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: [JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] }), JSON.stringify({ type: "result", subtype: "success", is_error: false })],
    controlOut: [],
    ...overrides,
  };
}

describe("Cassette.environment field", () => {
  it("a cassette WITH environment field carries location, tier, and optionally agentBinaryFormat", async () => {
    const cassette = makeMinimalCassette({
      environment: {
        location: "local",
        tier: "hostloop",
        agentBinaryFormat: "elf",
      },
    });
    expect(cassette.environment).toEqual({
      location: "local",
      tier: "hostloop",
      agentBinaryFormat: "elf",
    });
  });

  it("an OLDER cassette WITHOUT environment field still replays successfully (backward-compat)", async () => {
    // Omit the environment field entirely — it's optional.
    const cassette = makeMinimalCassette();
    delete cassette.environment;

    // Replay should succeed without error, ignoring the missing field.
    const result = await replayCassette(cassette);
    expect(result.result).toBe("success");
    // The cassette lacks environment, so it should replay cleanly.
    expect(result).toBeDefined();
  });

  it("environment.agentBinaryFormat is optional — can be omitted", async () => {
    const cassette = makeMinimalCassette({
      environment: {
        location: "local",
        tier: "container",
        // agentBinaryFormat deliberately omitted
      },
    });
    expect(cassette.environment.location).toBe("local");
    expect(cassette.environment.tier).toBe("container");
    expect(cassette.environment.agentBinaryFormat).toBeUndefined();
  });

  it("environment.tier is optional — can be omitted", async () => {
    const cassette = makeMinimalCassette({
      environment: {
        location: "local",
        // tier deliberately omitted
      },
    });
    expect(cassette.environment.location).toBe("local");
    expect(cassette.environment.tier).toBeUndefined();
  });
});

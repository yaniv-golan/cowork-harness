import { describe, it, expect, vi } from "vitest";

// RISK 3 (D7's sibling): when the baseline can't be loaded, the unified `computeStaleness` emits an
// `unverifiable-baseline` finding, and the class-blind `checkStaleness` string adapter MUST forward it so
// `verify-cassettes` / the re-record work-list stay RED (can't verify ⇒ not green). Filtering it in the
// adapter would silently false-green those gates — the exact regression the unification could have introduced.
// Isolated in its own file because it mocks `loadBaseline` to throw.

vi.mock("../src/baseline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/baseline.js")>();
  return {
    ...actual,
    loadBaseline: () => {
      throw new Error("no baseline shipped (simulated)");
    },
  };
});

const { computeStaleness, checkStaleness, CASSETTE_VERSION } = await import("../src/run/cassette.js");
type Cassette = import("../src/run/cassette.js").Cassette;

const cassette = (): Cassette =>
  ({
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "c",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container" as const,
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [],
    },
    events: [],
    fingerprint: { baseline: "1.2.3" },
  }) as unknown as Cassette;

describe("staleness — unloadable baseline forwarded by the class-blind adapter (RISK 3)", () => {
  it("computeStaleness emits an `unverifiable-baseline` finding when the baseline can't load", () => {
    const findings = computeStaleness(cassette(), undefined);
    expect(findings.some((f) => f.class === "unverifiable-baseline")).toBe(true);
  });

  it("checkStaleness (string adapter) forwards it, so verify-cassettes stays RED", () => {
    const msgs = checkStaleness(cassette(), "");
    expect(msgs.length).toBeGreaterThan(0); // staleAny = staleness.length > 0 ⇒ gate fails
    expect(msgs.some((m) => /cannot load the latest baseline/.test(m))).toBe(true);
  });
});

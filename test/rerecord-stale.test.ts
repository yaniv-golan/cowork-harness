import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { selectStaleCassettes } from "../src/run/cassette.js";

const cassette = (fingerprint?: unknown) => ({
  scenario: {
    name: "c",
    baseline: "latest",
    session: "(inline)",
    fidelity: "container",
    prompt: "hi",
    answers: [],
    expect_denied: [],
    assert: [],
  },
  events: [],
  ...(fingerprint ? { fingerprint } : {}),
});

describe("selectStaleCassettes — B2 selection", () => {
  it("returns only cassettes whose fingerprint drifted", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-rrs-"));
    writeFileSync(join(d, "stale.cassette.json"), JSON.stringify(cassette({ baseline: "0.0.0-ancient" })));
    writeFileSync(join(d, "fresh.cassette.json"), JSON.stringify(cassette())); // no fingerprint → not stale
    const stale = selectStaleCassettes(d);
    expect(stale.map((s) => basename(s.path))).toEqual(["stale.cassette.json"]);
    expect(stale[0].staleness.length).toBeGreaterThan(0);
  });
});

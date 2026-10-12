import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regradeRecordedAction, readMultiLegCassette } from "../src/run/multi-leg-cassette.js";
import type { Leg } from "../src/run/multi-leg-scenario.js";

// Replay re-grades a host action from its record: a live failure stands, and the kept stdout head never proves an
// absence past it.
const rec = (over: Record<string, unknown> = {}) =>
  ({
    argv: ["x"],
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdout: { sha256: "", bytes: 9000, head: "a".repeat(4096) },
    stderr: { sha256: "", bytes: 0, head: "" },
    produced: [],
    assertions: [],
    pass: true,
    ...over,
  }) as never;
const leg = (assert: unknown[]): Leg => ({ id: "apply", host_action: { run: ["x"], timeout: 120 }, assert }) as unknown as Leg;

describe("regradeRecordedAction", () => {
  it("a stdout_not_matches whose forbidden text may lie past the kept head is evidence-unavailable", () => {
    expect(regradeRecordedAction(leg([{ stdout_not_matches: "ERROR" }]), rec()).status).toBe("failed");
  });
  it("a stdout assertion that failed when recorded still fails", () => {
    const a = { stdout_not_matches: "a" };
    const r = rec({ stdout: { sha256: "", bytes: 1, head: "b" }, assertions: [{ assertion: a, pass: false, message: "matched" }] });
    expect(regradeRecordedAction(leg([a]), r).status).toBe("failed");
  });
  it("a fully kept stdout re-grades on its content", () => {
    const r = rec({ stdout: { sha256: "", bytes: 3, head: "ok\n" } });
    expect(regradeRecordedAction(leg([{ stdout_matches: "ok" }]), r).status).toBe("passed");
  });
});

describe("readMultiLegCassette", () => {
  it("refuses a cassette whose legs do not match its scenario's (empty, dropped or reordered)", () => {
    const d = mkdtempSync(join(tmpdir(), "mlc-"));
    const base = {
      cassetteVersion: 18,
      scenario: { name: "x", session: "(inline)", legs: [{ id: "a" }, { id: "b" }] },
      verdict: { pass: true },
    };
    for (const legs of [
      [],
      [{ id: "a", kind: "prompt", status: "skipped" }],
      [
        { id: "b", kind: "prompt", status: "skipped" },
        { id: "a", kind: "prompt", status: "skipped" },
      ],
    ]) {
      const p = join(d, "c.cassette.json");
      writeFileSync(p, JSON.stringify({ ...base, legs }));
      expect(readMultiLegCassette(p)).toEqual({ error: expect.stringMatching(/do not match the scenario's legs/) });
    }
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactionPreflightMessage, resolvePreflightTier } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

// D3 (consumer feedback S3): the empty-redaction-policy discovery used to happen AFTER the paid live
// run (recordScenarioObject's post-run policy load). The preflight computes the same tier+policy facts
// pre-spawn; these tests pin the message conditions. Policy dirs are always explicit tmp dirs here —
// the repo's own .cowork-redact.json (cwd) must not leak into the fixtures.

const scenario = (over: Partial<Scenario> = {}): Scenario =>
  ({
    name: "s",
    baseline: "latest",
    session: "(inline)",
    fidelity: "hostloop",
    prompt: "hi",
    answers: [],
    expect_denied: [],
    assert: [],
    skills: [],
    requires_capabilities: [],
    ...over,
  }) as Scenario;

const emptyDir = () => mkdtempSync(join(tmpdir(), "cwh-preflight-"));

describe("redactionPreflightMessage — fires only for host-path-bearing tiers with an empty policy", () => {
  it("hostloop + empty policy → ::warning:: naming the path-scanner consequence and the universal net", () => {
    const msg = redactionPreflightMessage([{ scenario: scenario(), policyDirs: [emptyDir()] }]);
    expect(msg).toMatch(/^::warning::/);
    expect(msg).toMatch(/`path` scanner/);
    expect(msg).toMatch(/init-redact/);
    expect(msg).toMatch(/universal net/); // container can trip the scanner too — the net stays on
  });

  it("protocol + empty policy → warns too (no sandbox — real cwd paths)", () => {
    const msg = redactionPreflightMessage([{ scenario: scenario({ fidelity: "protocol" }), policyDirs: [emptyDir()] }]);
    expect(msg).toMatch(/\(protocol\)/);
  });

  it("container + empty policy → null (VM paths, not host paths)", () => {
    expect(redactionPreflightMessage([{ scenario: scenario({ fidelity: "container" }), policyDirs: [emptyDir()] }])).toBeNull();
  });

  it("hostloop + a .cowork-redact.json in the search set → null", () => {
    const d = emptyDir();
    writeFileSync(join(d, ".cowork-redact.json"), JSON.stringify({ patterns: [{ regex: "/Users/[^\\s]+", label: "p" }] }));
    expect(redactionPreflightMessage([{ scenario: scenario(), policyDirs: [d] }])).toBeNull();
  });

  it("hostloop + COWORK_HARNESS_REDACT_PATTERNS set → null (env is part of the assembled policy)", () => {
    const prev = process.env.COWORK_HARNESS_REDACT_PATTERNS;
    process.env.COWORK_HARNESS_REDACT_PATTERNS = "/Users/[^\\s]+";
    try {
      expect(redactionPreflightMessage([{ scenario: scenario(), policyDirs: [emptyDir()] }])).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_REDACT_PATTERNS;
      else process.env.COWORK_HARNESS_REDACT_PATTERNS = prev;
    }
  });

  it("batch: one message naming every risky scenario (once-per-batch, not N duplicates)", () => {
    const d = emptyDir();
    const msg = redactionPreflightMessage([
      { scenario: scenario({ name: "a" }), policyDirs: [d] },
      { scenario: scenario({ name: "b", fidelity: "container" }), policyDirs: [d] },
      { scenario: scenario({ name: "c", fidelity: "protocol" }), policyDirs: [d] },
    ]);
    expect(msg).toMatch(/a \(hostloop\)/);
    expect(msg).toMatch(/c \(protocol\)/);
    expect(msg).not.toMatch(/\bb \(/); // container sibling not named
  });

  it("a malformed .cowork-redact.json THROWS at preflight — pre-spawn, before the run is paid for", () => {
    const d = emptyDir();
    writeFileSync(join(d, ".cowork-redact.json"), "{ not json");
    expect(() => redactionPreflightMessage([{ scenario: scenario(), policyDirs: [d] }])).toThrow(/invalid \.cowork-redact\.json/);
  });
});

describe("resolvePreflightTier", () => {
  it("explicit tiers pass through untouched", () => {
    expect(resolvePreflightTier(scenario({ fidelity: "container" }))).toBe("container");
    expect(resolvePreflightTier(scenario({ fidelity: "protocol" }))).toBe("protocol");
  });

  it("cowork + unresolvable baseline → 'unresolvable' (preflight stays quiet; the run fails loudly itself)", () => {
    const t = resolvePreflightTier(scenario({ fidelity: "cowork", baseline: "no-such-baseline-xyz" }));
    expect(t).toBe("unresolvable");
    expect(
      redactionPreflightMessage([
        { scenario: scenario({ fidelity: "cowork", baseline: "no-such-baseline-xyz" }), policyDirs: [emptyDir()] },
      ]),
    ).toBeNull();
  });

  it("cowork + latest resolves to whatever the loop gate says (hostloop or container, never cowork)", () => {
    expect(["hostloop", "container"]).toContain(resolvePreflightTier(scenario({ fidelity: "cowork" })));
  });
});

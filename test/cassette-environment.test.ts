import { describe, it, expect } from "vitest";
import { replayCassette, buildEnvironmentProvenance, computeStaleness, imageProvenanceMismatch } from "../src/run/cassette.js";
import { readFileSync } from "node:fs";
import { recordedControlOut } from "./helpers/minimal-cassette.js";

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
    events: [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: recordedControlOut(),
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

describe("RunResult.execution — replay-site wiring (reads Cassette.environment)", () => {
  it("a replay of a cassette WITH environment stamped reproduces that location", async () => {
    const cassette = makeMinimalCassette({
      environment: { location: "local", tier: "hostloop", agentBinaryFormat: "elf" },
    });
    const result = await replayCassette(cassette);
    expect(result.execution).toEqual({ location: "local" });
  });

  it("a replay of a cassette WITHOUT environment (older/pre-taxonomy) yields execution: undefined — not a false 'local' claim", async () => {
    const cassette = makeMinimalCassette();
    delete cassette.environment;
    const result = await replayCassette(cassette);
    expect(result.execution).toBeUndefined();
  });
});

// --- harnessVersion provenance + the discovery-surface note (1.11.0) ------------------------------
describe("buildEnvironmentProvenance — recording provenance (pure, offline-testable)", () => {
  // Read package.json DIRECTLY rather than comparing against pkgVersion(): asserting
  // toBe(pkgVersion()) is circular — it survives the mutation "return a wrong constant sourced from
  // that same call". The point of extracting the helper was an assertion that can actually fail.
  const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

  it("stamps the recording CLI's version", () => {
    expect(buildEnvironmentProvenance("container", "elf").harnessVersion).toBe(declared);
  });
  it("always marks the recording local, and passes tier/format through", () => {
    // toStrictEqual, not toEqual: toEqual ignores keys whose value is `undefined`, so an unconditional
    // `agentImage: undefined` would slip in unnoticed and this assertion would stop pinning the key set.
    expect(buildEnvironmentProvenance("hostloop", "macho")).toStrictEqual({
      location: "local",
      tier: "hostloop",
      agentBinaryFormat: "macho",
      harnessVersion: declared,
    });
  });
  it("tolerates an absent tier / binary format", () => {
    const e = buildEnvironmentProvenance(undefined, undefined);
    expect(e.location).toBe("local");
    expect(e.harnessVersion).toBe(declared);
  });

  it("omits agentImage entirely when none was resolved (non-container tiers)", () => {
    // Not `agentImage: undefined` — the key must be absent, or every protocol-tier cassette grows a
    // meaningless null field and the schema's "absence is meaningful" contract stops being true.
    expect("agentImage" in buildEnvironmentProvenance("protocol", "elf")).toBe(false);
  });

  it("records the ref plus whichever identities exist", () => {
    const e = buildEnvironmentProvenance("container", "elf", {
      ref: "cowork-agent-base:2",
      configId: "sha256:" + "a".repeat(64),
      registryDigest: "sha256:" + "b".repeat(64),
    });
    expect(e.agentImage?.ref).toBe("cowork-agent-base:2");
    expect(e.agentImage?.registryDigest).toBe("sha256:" + "b".repeat(64));
  });

  it("records a locally built image by config id alone", () => {
    // A local build has empty RepoDigests; recording only the ref would make it indistinguishable from
    // a pulled one, which is exactly the drift Task 6 has to be able to see.
    const e = buildEnvironmentProvenance("container", "elf", {
      ref: "cowork-agent-base:2",
      configId: "sha256:" + "c".repeat(64),
    });
    expect(e.agentImage?.registryDigest).toBeUndefined();
    expect(e.agentImage?.configId).toBe("sha256:" + "c".repeat(64));
  });
});

describe("imageProvenanceMismatch — did this replay use the rootfs the recording used?", () => {
  const A = "sha256:" + "a".repeat(64);
  const B = "sha256:" + "b".repeat(64);

  it("prefers registryDigest — the only cross-machine-comparable identity", () => {
    // Machine A recorded a pulled image; machine B pulled the SAME digest but its local config id
    // differs by construction. Comparing configId first would warn on every cross-machine replay —
    // i.e. on the exact case this field exists to serve.
    expect(
      imageProvenanceMismatch({ ref: "x:2", configId: A, registryDigest: A }, { ref: "x:2", configId: B, registryDigest: A }),
    ).toBeNull();
  });

  it("warns when registry digests differ even if the config ids happen to match", () => {
    expect(
      imageProvenanceMismatch({ ref: "x:2", configId: A, registryDigest: A }, { ref: "x:2", configId: A, registryDigest: B }),
    ).toContain("recorded against");
  });

  it("warns when a pulled recording is replayed against a local build", () => {
    // registryDigest on one side only IS drift — a local rebuild replaced a pulled image — and it is
    // invisible to any same-field comparison.
    expect(imageProvenanceMismatch({ ref: "x:2", registryDigest: A }, { ref: "x:2", configId: B })).toContain("locally built");
  });

  it("is null when the recording predates the field", () => {
    expect(imageProvenanceMismatch(undefined, { ref: "x:2", configId: A })).toBeNull();
  });

  it("is null when the current image cannot be identified at all", () => {
    // Daemon down / image absent: there is nothing trustworthy to compare, and warning on every such
    // replay would train the reader to ignore the message.
    expect(imageProvenanceMismatch({ ref: "x:2", registryDigest: A }, { ref: "x:2" })).toBeNull();
  });

  it("does not warn merely because the ref changed", () => {
    // Same content under a different tag is not drift; a ref comparison would false-positive on every
    // COWORK_AGENT_IMAGE retag.
    expect(imageProvenanceMismatch({ ref: "x:2", registryDigest: A }, { ref: "y:dev", registryDigest: A })).toBeNull();
  });

  it("falls back to configId only when neither side has a registry digest", () => {
    expect(imageProvenanceMismatch({ ref: "x:2", configId: A }, { ref: "x:2", configId: A })).toBeNull();
    expect(imageProvenanceMismatch({ ref: "x:2", configId: A }, { ref: "x:2", configId: B })).toContain("recorded against");
  });
});

// --- replaced-builtin note ------------------------------------------------------------------------
// The gap this closes, hit for real: example-pdf-skill recorded `WebFetch` at container and asserted
// `tool_not_called: WebFetch`. When the harness started modelling production's VM-loop swap, that tool
// stopped existing there — the assertion could never be violated and passed VACUOUSLY, while
// verify-cassettes exited 0 throughout. Staleness keys on baseline/skillHash, so a fixture can describe a
// tool surface the harness no longer produces and nothing notices.
describe("replaced-builtin note — a fixture naming a tool this build no longer offers at that tier", () => {
  const notesFor = (o: Record<string, any>) => computeStaleness(makeMinimalCassette(o) as any, undefined).notes.join(" | ");
  const init = (tools?: unknown) =>
    JSON.stringify(tools === undefined ? { type: "system", subtype: "init" } : { type: "system", subtype: "init", tools });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });
  const D = ["mcp__skills__list_skills"]; // silence the sibling discovery note

  it("FIRES on WebFetch at container — VM-loop replaces it with the workspace tool", () => {
    const n = notesFor({ events: [init(["Bash", "WebFetch", ...D]), result], effectiveFidelity: "container" });
    expect(n).toContain("replaced-builtin");
    expect(n).toContain("WebFetch");
  });

  // The tier asymmetry is the substance, not a detail: the Bash/WebFetch replacement is HOST-LOOP-only,
  // so a container fixture carrying built-in Bash is FAITHFUL and must not be nagged.
  it("is SILENT on Bash at container — VM-loop keeps the built-in shell", () => {
    const n = notesFor({ events: [init(["Bash", ...D]), result], effectiveFidelity: "container" });
    expect(n).not.toContain("replaced-builtin");
  });

  it("FIRES on Bash at hostloop — that loop DOES replace it", () => {
    expect(notesFor({ events: [init(["Bash", ...D]), result], effectiveFidelity: "hostloop" })).toContain("replaced-builtin");
  });

  it("is SILENT once the inventory carries the workspace tool instead", () => {
    const n = notesFor({ events: [init(["mcp__workspace__web_fetch", ...D]), result], effectiveFidelity: "container" });
    expect(n).not.toContain("replaced-builtin");
  });

  it("is SILENT when the init event carries no tools key — no evidence is not 'stale'", () => {
    expect(notesFor({ events: [init(undefined), result], effectiveFidelity: "hostloop" })).not.toContain("replaced-builtin");
  });

  // Pins the tier the IMPLEMENTATION does not cover. spawnMicroVm never receives `webFetchViaApi`, so
  // that tier still offers the built-in WebFetch — a note here would tell users to re-record a cassette
  // that faithfully describes what this build produces. Delete this only alongside wiring microvm up.
  // spawnHostLoop disallows NotebookEdit alongside Bash/WebFetch. It has no workspace replacement — the
  // tier removes it outright — but `tool_not_called: NotebookEdit` is vacuous there all the same.
  it("FIRES on NotebookEdit at hostloop, which removes it outright rather than replacing it", () => {
    const n = notesFor({ events: [init(["NotebookEdit", ...D]), result], effectiveFidelity: "hostloop" });
    expect(n).toContain("replaced-builtin");
    expect(n).toContain("NotebookEdit");
  });

  it("is SILENT on NotebookEdit at container, which still offers it", () => {
    const n = notesFor({ events: [init(["NotebookEdit", ...D]), result], effectiveFidelity: "container" });
    expect(n).not.toContain("replaced-builtin");
  });

  it("is SILENT at microvm — that tier still offers the built-in WebFetch", () => {
    const n = notesFor({ events: [init(["Bash", "WebFetch", ...D]), result], effectiveFidelity: "microvm" });
    expect(n).not.toContain("replaced-builtin");
  });

  it("is SILENT at protocol, which has no workspace server to replace anything with", () => {
    const n = notesFor({ events: [init(["Bash", "WebFetch", ...D]), result], effectiveFidelity: "protocol" });
    expect(n).not.toContain("replaced-builtin");
  });
});

describe("discovery-surface note — answers \'does this cassette predate the discovery tools?\'", () => {
  const notesFor = (o: Record<string, any>) => computeStaleness(makeMinimalCassette(o) as any, undefined).notes.join(" | ");
  const init = (tools?: unknown) =>
    JSON.stringify(tools === undefined ? { type: "system", subtype: "init" } : { type: "system", subtype: "init", tools });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });

  it("FIRES on a container cassette whose recorded inventory lacks the discovery tools", () => {
    const n = notesFor({ events: [init(["Bash", "Read"]), result], effectiveFidelity: "container" });
    expect(n).toContain("discovery-surface");
    expect(n).toContain("container");
  });
  it("FIRES on hostloop too", () => {
    expect(notesFor({ events: [init(["Bash"]), result], effectiveFidelity: "hostloop" })).toContain("discovery-surface");
  });
  it("is SILENT once the inventory carries the discovery tools", () => {
    const n = notesFor({ events: [init(["Bash", "mcp__skills__list_skills"]), result], effectiveFidelity: "container" });
    expect(n).not.toContain("discovery-surface");
  });

  // The guard that keeps a synthetic fixture from being told to re-record. An init event with NO
  // `tools` key (test/evals/files/report-check.cassette.json is exactly this shape) is NO EVIDENCE —
  // not "the tools are missing".
  it("is SILENT when the init event carries no tools key at all", () => {
    expect(notesFor({ events: [init(undefined), result], effectiveFidelity: "hostloop" })).not.toContain("discovery-surface");
  });
  it("is SILENT on an empty tools array (same no-evidence rule)", () => {
    expect(notesFor({ events: [init([]), result], effectiveFidelity: "container" })).not.toContain("discovery-surface");
  });

  // Re-recording at these tiers would NEVER produce the tools, so the advice would be a dead end.
  it("is SILENT at microvm and protocol", () => {
    for (const tier of ["microvm", "protocol"]) {
      expect(notesFor({ events: [init(["Bash"]), result], effectiveFidelity: tier })).not.toContain("discovery-surface");
    }
  });
  it("is SILENT when no tier resolves (never guess a tier into an advisory)", () => {
    const n = notesFor({
      events: [init(["Bash"]), result],
      effectiveFidelity: undefined,
      scenario: { ...makeMinimalCassette().scenario, fidelity: "cowork" },
    });
    expect(n).not.toContain("discovery-surface");
  });

  // The oldest cassettes predate BOTH environment.tier and effectiveFidelity — the population the
  // note most wants to reach. scenario.fidelity is the third source for exactly that reason.
  it("falls back to a non-cowork scenario.fidelity when the newer tier fields are absent", () => {
    const n = notesFor({
      events: [init(["Bash"]), result],
      effectiveFidelity: undefined,
      scenario: { ...makeMinimalCassette().scenario, fidelity: "container" },
    });
    expect(n).toContain("discovery-surface");
  });
  it("prefers environment.tier over effectiveFidelity", () => {
    const n = notesFor({
      events: [init(["Bash"]), result],
      effectiveFidelity: "protocol",
      environment: { location: "local", tier: "container" },
    });
    expect(n).toContain("container");
  });

  // `events` is typed as required but several callers reach computeStaleness with it absent
  // (checkStaleness in the staleness/agent-scope suites). The first cut of this crashed the whole
  // staleness path with "cassette.events is not iterable" — 7 suite failures.
  it("does not throw when the cassette carries no events array at all", () => {
    const c = makeMinimalCassette({ effectiveFidelity: "container" }) as any;
    delete c.events;
    expect(() => computeStaleness(c, undefined)).not.toThrow();
    expect(computeStaleness(c, undefined).notes.join(" ")).not.toContain("discovery-surface");
  });

  it("is a NOTE, never a gating finding (a finding would red every consumer's fleet on upgrade)", () => {
    const r = computeStaleness(makeMinimalCassette({ events: [init(["Bash"]), result], effectiveFidelity: "container" }) as any, undefined);
    expect(r.notes.join(" ")).toContain("discovery-surface");
    expect(r.findings.map((f) => f.class)).not.toContain("discovery-surface");
    expect(r.findings.some((f) => JSON.stringify(f).includes("discovery-surface"))).toBe(false);
  });
});

// --- the staleness NOTES channel: grouping contract + severity + batch sink (1.11.1) --------------
// These guard behaviour that was previously verified only by eyeballing CLI output. Reverting either
// change left the whole suite green at 4520 — the same "call-site omission a unit test can't see" hole
// the A2 live probes exist to close, so it is closed here properly.
describe("staleness notes — kind prefix, severity, and batch aggregation", () => {
  const initEvt = (tools: string[]) => JSON.stringify({ type: "system", subtype: "init", tools });
  const resultEvt = JSON.stringify({ type: "result", subtype: "success", is_error: false });

  /** Capture stderr around an async call (the notes channel writes there, not to stdout). */
  async function captureStderr(fn: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (c: unknown) => (seen.push(String(c)), true);
    try {
      await fn();
    } finally {
      (process.stderr as unknown as { write: unknown }).write = orig;
    }
    return seen;
  }

  // The batch summary groups by a leading `kind:` token. A producer that omits one silently lands in a
  // catch-all bucket and stops aggregating — so the contract is pinned for EVERY producer, not just the
  // three that WS-C touched.
  // Source-scanned, NOT fixture-driven, on purpose: a fixture only reaches the producers it happens to
  // trigger (a fingerprint-less cassette never reaches promptAssetStaleness), so a fixture-only test
  // silently exempts the rest — verified: dropping the `prompt-assets:` prefix passed a fixture-only
  // version of this test. Every note literal in the module must carry a kind, whatever fires it.
  it("EVERY note literal in cassette.ts carries a `kind:` prefix (all producers, not just the reachable ones)", () => {
    const src = readFileSync(new URL("../src/run/cassette.ts", import.meta.url), "utf8");
    const literals = [...src.matchAll(/\bnote:\s*(?:`|")([^`"]{10,})/g), ...src.matchAll(/notes\.push\(\s*(?:`|")([^`"]{10,})/g)].map(
      (m) => m[1],
    );
    expect(literals.length, "found no note literals — the scan regex has rotted").toBeGreaterThanOrEqual(4);
    const unprefixed = literals.filter((l) => !/^[a-z-]+: /.test(l));
    expect(
      unprefixed,
      `note literal(s) with no kind: prefix — the batch grouper buckets these as "note" and they stop ` +
        `aggregating: ${unprefixed.map((l) => l.slice(0, 60)).join(" | ")}`,
    ).toEqual([]);
  });

  it("every note computeStaleness emits at runtime also carries the prefix", () => {
    const c = makeMinimalCassette({
      events: [initEvt(["Bash"]), resultEvt],
      effectiveFidelity: "container",
    }) as any;
    const { notes } = computeStaleness(c, undefined);
    expect(notes.length, "fixture produced no notes — this test would be vacuous").toBeGreaterThan(0);
    for (const n of notes) expect(n, `note has no kind: prefix -> ${n}`).toMatch(/^[a-z-]+: /);
  });

  it("notes are emitted at ::notice::, never ::warning:: (they are non-gating by construction)", async () => {
    const c = makeMinimalCassette({ events: [initEvt(["Bash"]), resultEvt], effectiveFidelity: "container" }) as any;
    const lines = await captureStderr(() => replayCassette(c, [], {}).catch(() => undefined));
    const noteLines = lines.filter((l) => l.includes("cassette note:"));
    expect(noteLines.length, "no note line was emitted — the test would be vacuous").toBeGreaterThan(0);
    for (const l of noteLines) {
      expect(l, "a non-gating note must not outrank the actionable assert-drift ::notice::").toContain("::notice::");
      expect(l).not.toContain("::warning::");
    }
  });

  it("a notesSink diverts notes off stderr so a batch caller can aggregate them", async () => {
    const c = makeMinimalCassette({ events: [initEvt(["Bash"]), resultEvt], effectiveFidelity: "container" }) as any;
    const collected: string[] = [];
    const lines = await captureStderr(() => replayCassette(c, [], { notesSink: (ns) => collected.push(...ns) }).catch(() => undefined));
    expect(collected.length, "the sink received nothing").toBeGreaterThan(0);
    expect(
      lines.filter((l) => l.includes("cassette note:")),
      "notes must NOT also hit stderr when sunk",
    ).toEqual([]);
  });

  // Guard the blast radius: WS-D changed the NOTES channel only. Findings gate the exit code and must
  // stay ::warning::; assert-drift's deliberate ::notice:: is likewise untouched.
  it("staleness FINDINGS still emit at ::warning:: (only the notes channel was de-escalated)", () => {
    const src = readFileSync(new URL("../src/run/cassette.ts", import.meta.url), "utf8");
    expect(src).toContain("::warning:: [replay] cassette stale:");
    expect(src).toContain("::notice:: [replay] cassette note:");
  });
});

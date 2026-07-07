import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

// `replay --reassert --write` — persist a token-free-revalidated assert block back into the cassette when
// ONLY the assert block changed (the whole point: adopt a stream-derivable assertion edit without a paid
// re-record). Exercised through the built CLI so the cmdReplay wiring + on-disk write are covered.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cc-reassert-write-"));
}
function write(cwd: string, name: string, body: string): void {
  writeFileSync(join(cwd, name), body);
}
function replay(cwd: string, args: string[]) {
  const r = spawnSync("node", [CLI, "replay", ...args], { encoding: "utf8", cwd });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* text mode */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function readCassette(cwd: string, name = "c.cassette.json"): any {
  return JSON.parse(readFileSync(join(cwd, name), "utf8"));
}

const events = (text = "hello there") => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

function cassetteJson(opts: { name?: string; assert?: unknown[]; controlOut?: unknown[] } = {}): string {
  return JSON.stringify(
    {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: opts.name ?? "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "do the thing",
        answers: [],
        expect_denied: [],
        assert: opts.assert ?? [{ result: "success" }],
      },
      events: events(),
      controlOut: opts.controlOut ?? [],
    },
    null,
    2,
  );
}
function scenarioYaml(assertBody: string, extra = ""): string {
  return `name: c\nprompt: do the thing\n${extra}assert:\n${assertBody}`;
}

describe.skipIf(!can)("replay --reassert --write — persist a stream-derivable assert edit", () => {
  it("(a) writes the re-asserted block back; a plain replay is then green off the frozen copy", () => {
    const cwd = tmp();
    // Frozen assert FAILS; the sibling fixes it. Plain replay must be red first, green after --write.
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ transcript_contains: "NOT_PRESENT" }] }));
    write(cwd, "c.yaml", scenarioYaml("  - transcript_contains: hello\n"));
    expect(replay(cwd, ["c.cassette.json", "--output-format", "json"]).json?.ok).toBe(false);

    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write", "--output-format", "json"]);
    expect(w.code).toBe(0);
    expect(w.stderr).toMatch(/wrote the re-asserted block/);
    // the on-disk cassette's frozen assert is now the sibling's
    expect(readCassette(cwd).scenario.assert).toEqual([{ transcript_contains: "hello" }]);
    // ...so a PLAIN replay (frozen drives) is now green
    expect(replay(cwd, ["c.cassette.json", "--output-format", "json"]).json?.ok).toBe(true);
  });

  it("(h) events / controlOut / fingerprint are byte-identical after a successful write", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }], controlOut: [JSON.stringify({ some: "frame" })] }));
    write(cwd, "c.yaml", scenarioYaml("  - transcript_contains: hello\n"));
    const before = readCassette(cwd);
    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write", "--output-format", "json"]);
    expect(w.code).toBe(0);
    const after = readCassette(cwd);
    expect(after.events).toEqual(before.events); // events untouched
    expect(after.controlOut).toEqual(before.controlOut); // controlOut untouched
    expect(after.cassetteVersion).toBe(before.cassetteVersion);
    expect(after.scenario.assert).not.toEqual(before.scenario.assert); // ONLY the assert block changed
  });

  it("(f) idempotent: a second --write is a no-op (no churn) once the block already matches", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, "c.yaml", scenarioYaml("  - transcript_contains: hello\n"));
    expect(replay(cwd, ["c.cassette.json", "--reassert", "--write"]).code).toBe(0);
    const afterFirst = readFileSync(join(cwd, "c.cassette.json"), "utf8");
    const second = replay(cwd, ["c.cassette.json", "--reassert", "--write"]);
    expect(second.code).toBe(0);
    expect(second.stderr).toMatch(/already matches|no write/);
    expect(readFileSync(join(cwd, "c.cassette.json"), "utf8")).toBe(afterFirst); // byte-identical, no re-serialize churn
  });
});

describe.skipIf(!can)("replay --reassert --write — refuse buckets (no silent false-green)", () => {
  it("(b) refuses an added key that would SILENTLY SKIP on this cassette (no manifest/hashes); cassette unchanged", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] })); // no artifacts manifest / no preRunHashes
    write(cwd, "c.yaml", scenarioYaml("  - result: success\n  - input_unmodified:\n      - inputs/data.csv\n"));
    const before = readFileSync(join(cwd, "c.cassette.json"), "utf8");
    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write"]);
    expect(w.code).not.toBe(0);
    expect(w.stderr).toMatch(/refusing to --write/);
    expect(w.stderr).toMatch(/input_unmodified/);
    expect(readFileSync(join(cwd, "c.cassette.json"), "utf8")).toBe(before); // untouched
  });

  it("(c) a LIVE-ONLY key (stripped on replay, frozen by record) is written, NOT refused", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    // transcript_no_host_path is live-only; transcript_contains is the checkable, passing half.
    write(cwd, "c.yaml", scenarioYaml("  - transcript_contains: hello\n  - transcript_no_host_path: true\n"));
    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write", "--output-format", "json"]);
    expect(w.code).toBe(0); // NOT refused
    expect(w.stderr).toMatch(/live-only|sourced, NOT evaluated|not checkable/i);
    const written = readCassette(cwd).scenario.assert;
    expect(written).toContainEqual({ transcript_no_host_path: true }); // frozen per record semantics
  });

  it("(g) a FAILING reassert verdict is refused without --allow-failing, and written with it", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    // transcript_contains a string NOT in the events → the reassert verdict FAILS.
    write(cwd, "c.yaml", scenarioYaml("  - transcript_contains: DEFINITELY_ABSENT\n"));
    const refused = replay(cwd, ["c.cassette.json", "--reassert", "--write"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/refusing to --write a FAILING/i);
    // cassette still holds the original passing assert
    expect(readCassette(cwd).scenario.assert).toEqual([{ result: "success" }]);
    // with --allow-failing it WRITES the red block (mirrors record --allow-failing). The exit stays non-zero
    // — the replay verdict genuinely failed — but the write happened, which is the point.
    const forced = replay(cwd, ["c.cassette.json", "--reassert", "--write", "--allow-failing"]);
    expect(forced.stderr).toMatch(/wrote the re-asserted block/);
    expect(readCassette(cwd).scenario.assert).toEqual([{ transcript_contains: "DEFINITELY_ABSENT" }]);
  });

  it("(d) a recording-shaping (prompt) drift hard-fails --reassert BEFORE any write; cassette unchanged", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    // The sibling changes the PROMPT (a recording-shaping field): the frozen events no longer correspond to
    // this scenario, so --reassert must hard-fail before the write step ever runs — you must re-record.
    write(cwd, "c.yaml", "name: c\nprompt: a DIFFERENT prompt\nassert:\n  - transcript_contains: hello\n");
    const before = readFileSync(join(cwd, "c.cassette.json"), "utf8");
    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write"]);
    expect(w.code).not.toBe(0);
    expect(w.stderr).toMatch(/drift|re-record/i);
    expect(readFileSync(join(cwd, "c.cassette.json"), "utf8")).toBe(before); // untouched — no partial write
  });
});

describe.skipIf(!can)("replay --reassert --write — redaction v2 (block-only, verdict-preserving)", () => {
  it("(e) a policy is active but the edited assert has no policy-matched content → write succeeds, events stay byte-identical", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ transcript_contains: "hello" }] }));
    // policy would redact "hello" (present in the EVENTS) if the whole cassette were redacted — the
    // block-only write must leave events untouched.
    write(cwd, ".cowork-redact.json", JSON.stringify({ patterns: [{ regex: "hello", label: "greeting" }] }));
    // edited assert uses a different, passing value with no "hello" in it → nothing to redact in the block
    write(cwd, "c.yaml", scenarioYaml("  - transcript_contains: there\n"));
    const before = readCassette(cwd);
    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write", "--output-format", "json"]);
    expect(w.code).toBe(0);
    const after = readCassette(cwd);
    expect(after.events).toEqual(before.events); // NOT whole-cassette redacted — "hello there" survives in events
    expect(after.scenario.assert).toEqual([{ transcript_contains: "there" }]);
  });

  it("(e2) a redaction that would FLIP the replay verdict is refused (verdict-preservation)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({ assert: [{ result: "success" }] }));
    write(cwd, ".cowork-redact.json", JSON.stringify({ patterns: [{ regex: "hello", label: "greeting" }] }));
    // the edited assert keys on "hello"; redacting it to [REDACTED] makes the redacted block FAIL while the
    // raw block passes → verdict divergence → must refuse rather than write a manufactured green.
    write(cwd, "c.yaml", scenarioYaml("  - transcript_contains: hello\n"));
    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write"]);
    expect(w.code).not.toBe(0);
    expect(w.stderr).toMatch(/redact|verdict/i);
    expect(readCassette(cwd).scenario.assert).toEqual([{ result: "success" }]); // unchanged
  });

  it("(M2) a redaction that touched a SHAPING field (prompt) → frozen-redacted vs on-disk-plaintext hard-fails --write", () => {
    // The M2 bound: when a record-time policy matched the prompt/answers, the cassette froze the REDACTED
    // prompt while the authored file stays plaintext. `recordingShapingDrift` compares the two and hard-fails
    // BEFORE --write — a redacting consumer who edits a shaping field must re-record, not --write.
    const cwd = tmp();
    const cass = JSON.parse(cassetteJson({ assert: [{ result: "success" }] }));
    cass.scenario.prompt = "call [REDACTED:apikey]"; // frozen prompt, redacted at record time
    write(cwd, "c.cassette.json", JSON.stringify(cass, null, 2));
    write(cwd, ".cowork-redact.json", JSON.stringify({ patterns: [{ regex: "ACME-\\d+-KEY", label: "apikey" }] }));
    write(cwd, "c.yaml", "name: c\nprompt: call ACME-1234-KEY\nassert:\n  - transcript_contains: hello\n"); // plaintext
    const before = readFileSync(join(cwd, "c.cassette.json"), "utf8");
    const w = replay(cwd, ["c.cassette.json", "--reassert", "--write"]);
    expect(w.code).not.toBe(0);
    expect(w.stderr).toMatch(/drift|re-record/i);
    expect(readFileSync(join(cwd, "c.cassette.json"), "utf8")).toBe(before); // unchanged — must re-record
  });
});

describe.skipIf(!can)("replay --write — usage gates", () => {
  it("--write without --reassert/--assert-from is a usage error (exit 2)", () => {
    const cwd = tmp();
    write(cwd, "c.cassette.json", cassetteJson({}));
    const r = replay(cwd, ["c.cassette.json", "--write"]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/--write/);
  });

  it("--assert-from <one file> --write over a DIR is refused (cross-assert footgun)", () => {
    const cwd = tmp();
    write(cwd, "c1.cassette.json", cassetteJson({ name: "c1" }));
    write(cwd, "c2.cassette.json", cassetteJson({ name: "c2" }));
    write(cwd, "edit.yaml", scenarioYaml("  - result: success\n"));
    const r = replay(cwd, [".", "--assert-from", "edit.yaml", "--write"]);
    expect(r.code).toBe(2);
  });
});

describe.skipIf(!can)("replay --reassert --write — directory (per-cassette sibling)", () => {
  it("writes EACH cassette's own sibling block over a directory target", () => {
    const cwd = tmp();
    // Two cassettes whose frozen asserts both FAIL; each has its own sibling that fixes it differently.
    write(cwd, "c1.cassette.json", cassetteJson({ name: "c1", assert: [{ transcript_contains: "NOPE" }] }));
    write(cwd, "c1.yaml", scenarioYaml("  - transcript_contains: hello\n"));
    write(cwd, "c2.cassette.json", cassetteJson({ name: "c2", assert: [{ transcript_contains: "NOPE" }] }));
    write(cwd, "c2.yaml", scenarioYaml("  - transcript_contains: there\n"));
    const w = replay(cwd, [".", "--reassert", "--write", "--output-format", "json"]);
    expect(w.code).toBe(0);
    // --reassert resolves each cassette's OWN sibling (not one shared block), so the two land differently.
    expect(readCassette(cwd, "c1.cassette.json").scenario.assert).toEqual([{ transcript_contains: "hello" }]);
    expect(readCassette(cwd, "c2.cassette.json").scenario.assert).toEqual([{ transcript_contains: "there" }]);
    // both plain replays are now green off their frozen copies
    expect(replay(cwd, ["c1.cassette.json", "--output-format", "json"]).json?.ok).toBe(true);
    expect(replay(cwd, ["c2.cassette.json", "--output-format", "json"]).json?.ok).toBe(true);
  });
});

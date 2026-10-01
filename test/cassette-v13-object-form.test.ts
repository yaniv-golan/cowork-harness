import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASSETTE_VERSION, requiredVersionFor, readCassette } from "../src/run/cassette.js";
import { ScenarioObject } from "../src/types.js";

// An object-form tool_called / tool_not_called changes what a replay verdict MEANS (it reads inputs,
// scope and paired results a v12 reader has never heard of), so the cassette must lift its stamp to v13.
// Without the lift, an older CLI rejects the frozen assertion as "unrecognized … Fix the assertion, or
// re-record" — the wrong remedy, and the `--best-effort-future-cassette` path is unreachable. With it, an
// older CLI says "cassette format too new; upgrade", which is the truth.

const parse = (assert: unknown[]) => ScenarioObject.parse({ prompt: "x", fidelity: "container", assert });

describe("the `assert` entry of the stamp is value-aware", () => {
  it("an object-form tool_called lifts the stamp to 13", () => {
    expect(requiredVersionFor(parse([{ tool_called: { tool: "Bash", input: { command: "x" } } }]))).toBe(13);
  });
  it("an object-form tool_not_called lifts the stamp to 13 — even the {tool} shorthand, which an older reader cannot parse", () => {
    expect(requiredVersionFor(parse([{ tool_not_called: { tool: "Bash" } }]))).toBe(13);
  });
  it("string-form scenarios keep stamping 12", () => {
    expect(requiredVersionFor(parse([{ tool_called: "Bash" }, { tool_not_called: "Write" }, { result: "success" }]))).toBe(12);
    expect(requiredVersionFor(parse([]))).toBe(12);
  });
  it("a loose on-disk scenario (as rehash reads it) is judged the same way", () => {
    expect(requiredVersionFor({ prompt: "x", assert: [{ tool_called: { tool: "Bash" } }] })).toBe(13);
    expect(requiredVersionFor({ prompt: "x", assert: "not-an-array" })).toBe(12);
  });
  it("this build writes and reads at least v13 (v14 since include_fork_results)", () => {
    expect(CASSETTE_VERSION).toBeGreaterThanOrEqual(13);
  });
});

describe("a v12-only reader's view of a v13 cassette", () => {
  // Simulated by stamping one version ABOVE this build's max: the reader then takes exactly the
  // future-cassette path a v12 build takes for a v13 cassette.
  const cassette = (version: number) =>
    JSON.stringify({
      cassetteVersion: version,
      scenario: {
        name: "s",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ tool_called: { tool: "Bash", inputz: "a key from the future" } }],
      },
      events: [],
      controlOut: [],
    });

  const readCassetteFromString = (text: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "cwh-v13-")), "c.cassette.json");
    writeFileSync(f, text);
    return readCassette(f);
  };

  it("tolerates (warns on) an unrecognized assertion in a FUTURE cassette instead of demanding a re-record", () => {
    const r = readCassetteFromString(cassette(CASSETTE_VERSION + 1));
    expect("error" in r ? r.error : "").toBe("");
  });

  it("a CURRENT-version cassette with an unrecognized assertion is still refused", () => {
    const r = readCassetteFromString(cassette(CASSETTE_VERSION));
    expect("error" in r ? r.error : "").toMatch(/unrecognized assertion/);
  });
});

// A FUTURE cassette must be refused BEFORE any assertion is evaluated. 3.10.0's `replay` printed
// "tolerated", then evaluated the v13 object form with v12 code and crashed (`glob.replace is not a
// function`, exit 2). The next format bump must not repeat that: an assertion shape this build cannot
// evaluate is exactly what a future cassette carries.
import { replayCassette } from "../src/run/cassette.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const futureCassette = () => ({
  cassetteVersion: CASSETTE_VERSION + 1,
  scenario: {
    name: "future",
    baseline: "latest",
    session: "(inline)",
    fidelity: "container",
    prompt: "hi",
    answers: [],
    expect_denied: [],
    // A shape this build's evaluator cannot handle: `tool` must be a glob string or a list of them.
    assert: [{ tool_called: { tool: 42, from_the_future: true } }],
  },
  events: [
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ],
  controlOut: [],
});

describe("replay refuses a future cassette before evaluating it", () => {
  it("returns the 'too new' refusal instead of throwing", async () => {
    const r = await replayCassette(futureCassette() as never, []);
    expect(r.assertions.some((a) => a.source === "cassette-format" && /too new/.test(a.message ?? ""))).toBe(true);
    expect(r.assertions.every((a) => a.source === "cassette-format")).toBe(true); // nothing else was evaluated
  });

  it.skipIf(!existsSync(resolve("dist/cli.js")))("the CLI exits non-zero with 'too new', never a crash", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cwh-future-")), "f.cassette.json");
    writeFileSync(f, JSON.stringify(futureCassette()));
    const r = spawnSync("node", [resolve("dist/cli.js"), "replay", f], { encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/too new|newer than this harness/);
    expect(out).not.toMatch(/is not a function|TypeError/);
    expect(r.status).toBe(1);
  });
});

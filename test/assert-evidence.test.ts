import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}

// Item 12: `replay --explain` — a per-PASSING-assert evidence trail so a green isn't trusted blind.
// The evaluator surfaces an optional `evidence` string on passing checks; the named high-value keys
// (file_exists / max_tokens / max_cost_usd / tool_called / transcript_contains / result) name the concrete
// file/value/tool they matched.
describe("assert evidence — passing checks surface a concrete evidence trail", () => {
  it("max_tokens evidence names the actual total vs the bound", () => {
    const [r] = evaluate([{ max_tokens: 1000 }], ctx({ tokensTotal: 250 }));
    expect(r.pass).toBe(true);
    expect(r.evidence).toBeTruthy();
    expect(r.evidence).toContain("250");
    expect(r.evidence).toContain("1000");
  });

  it("max_cost_usd evidence names the actual cost vs the bound", () => {
    const [r] = evaluate([{ max_cost_usd: 2 }], ctx({ costUsd: 0.5 }));
    expect(r.pass).toBe(true);
    expect(r.evidence).toContain("0.5");
  });

  it("tool_called evidence names the tool", () => {
    const [r] = evaluate([{ tool_called: "Bash" }], ctx({ toolsCalled: new Set(["Bash"]) }));
    expect(r.pass).toBe(true);
    expect(r.evidence).toContain("Bash");
  });

  it("transcript_contains evidence names the matched needle", () => {
    const [r] = evaluate([{ transcript_contains: "cap table" }], ctx({ transcript: "here is the cap table you asked for" }));
    expect(r.pass).toBe(true);
    expect(r.evidence).toContain("cap table");
  });

  it("file_exists evidence names the concrete file that was found", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-evidence-"));
    writeFileSync(join(dir, "report.md"), "hi");
    const [r] = evaluate([{ file_exists: "report.md" }], ctx({ workRoot: dir }));
    expect(r.pass).toBe(true);
    expect(r.evidence).toContain("report.md");
  });

  it("a failing check carries a message and NO evidence (evidence is for passes)", () => {
    const [r] = evaluate([{ max_tokens: 100 }], ctx({ tokensTotal: 999 }));
    expect(r.pass).toBe(false);
    expect(r.evidence).toBeUndefined();
    expect(r.message).toBeTruthy();
  });

  it("a passing check with no evidence to surface omits the field (opt-out is clean)", () => {
    // allow_stall is a verdict modifier — always passes, nothing concrete to cite
    const [r] = evaluate([{ allow_stall: true } as any], ctx());
    expect(r.pass).toBe(true);
    expect(r.evidence).toBeUndefined();
  });
});

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
describe.skipIf(!can)("replay --explain — prints the passing-assert evidence trail", () => {
  it("emits an [explain] block naming the passing assert's evidence", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-explain-"));
    writeFileSync(
      join(cwd, "c.cassette.json"),
      JSON.stringify({
        cassetteVersion: CASSETTE_VERSION,
        scenario: {
          name: "c",
          baseline: "latest",
          session: "(inline)",
          fidelity: "container",
          prompt: "do the thing",
          answers: [],
          expect_denied: [],
          assert: [{ transcript_contains: "hello" }],
        },
        events: [
          JSON.stringify({ type: "system", subtype: "init", tools: [] }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello there" }] } }),
          JSON.stringify({ type: "result", subtype: "success", is_error: false }),
        ],
        controlOut: [],
      }),
    );
    const r = spawnSync("node", [CLI, "replay", "c.cassette.json", "--explain"], { encoding: "utf8", cwd });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/\[explain\]/);
    expect(r.stderr).toMatch(/transcript_contains/);
    expect(r.stderr).toMatch(/hello/);
  });
});

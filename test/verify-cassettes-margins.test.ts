import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CASSETTE_VERSION } from "../src/run/cassette.js";

// `verify-cassettes --margins` — for each count-bound assertion, fold the RECORDED count from a replay and
// report recorded vs budget + a margin ratio, so a brittle single-sample budget is visible without a paid
// `run --repeat`. Exercised through the built CLI.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "cc-margins-"));
}
// A cassette with 2 Bash tool calls (→ toolCallsTotal = 2) and a generous tool_calls_max budget.
function cassetteWithTwoToolCalls(assert: unknown[]): string {
  return JSON.stringify({
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "c",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "do the thing",
      answers: [],
      expect_denied: [],
      assert,
    },
    events: [
      JSON.stringify({ type: "system", subtype: "init", tools: [] }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "a" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "b" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: false, content: "ok" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: [],
  });
}
function verify(cwd: string, args: string[]) {
  const r = spawnSync("node", [CLI, "verify-cassettes", ...args], { encoding: "utf8", cwd });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* text */
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

describe.skipIf(!can)("verify-cassettes --margins", () => {
  it("reports recorded vs budget + margin for a count-bound assert (JSON)", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "c.cassette.json"), cassetteWithTwoToolCalls([{ tool_calls_max: 10 }, { result: "success" }]));
    const r = verify(cwd, ["c.cassette.json", "--margins", "--output-format", "json"]);
    expect(r.code).toBe(0);
    const fileEntry = (r.json?.margins ?? []).find((m: any) => m.file.endsWith("c.cassette.json"));
    expect(fileEntry).toBeTruthy();
    const row = fileEntry.rows.find((x: any) => x.key === "tool_calls_max");
    expect(row).toBeTruthy();
    expect(row.recorded).toBe(2);
    expect(row.budget).toBe(10);
    expect(row.margin).toBeCloseTo(5, 5); // 10 / 2
  });

  it("emits the single-sample caveat (text)", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "c.cassette.json"), cassetteWithTwoToolCalls([{ tool_calls_max: 10 }]));
    const r = verify(cwd, ["c.cassette.json", "--margins"]);
    expect(r.stdout + r.stderr).toMatch(/single-sample|one cassette|variance/i);
    expect(r.stdout + r.stderr).toMatch(/tool_calls_max/);
  });

  it("without --margins, no margin report is produced (base command unchanged)", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "c.cassette.json"), cassetteWithTwoToolCalls([{ tool_calls_max: 10 }]));
    const r = verify(cwd, ["c.cassette.json", "--output-format", "json"]);
    expect(r.code).toBe(0);
    expect(r.json?.margins).toBeUndefined();
  });
});

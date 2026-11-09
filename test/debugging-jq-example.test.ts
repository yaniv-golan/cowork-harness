import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { replayCassette } from "../src/run/cassette.js";
import { withReplayContract } from "./helpers/minimal-cassette.js";

// The hand-grading recipe in docs/debugging.md, run as written over a result the replay lane produced.
const HAVE_JQ = spawnSync("jq", ["--version"]).status === 0;
if (!HAVE_JQ) {
  if (process.env.CI) throw new Error("jq is required in CI");
  process.stderr.write("::warning:: debugging jq example SKIPPED: no jq on this machine\n");
}

function documentedFilter(): string {
  const m = readFileSync(resolve("docs/debugging.md"), "utf8").match(/jq -r '([^\n]*)' <run>\/turns\/1\/result\.json/);
  if (!m) throw new Error("the jq example is gone from docs/debugging.md");
  return m[1]!;
}

async function resultFile(assert: unknown[]): Promise<string> {
  const events = [
    JSON.stringify({ type: "system", subtype: "init", tools: [] }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ];
  const cassette = {
    scenario: {
      name: "d",
      baseline: "latest",
      session: "(inline)",
      fidelity: "protocol",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert,
    },
    events,
    preRunPaths: [],
    artifacts: [],
  } as any;
  const file = join(mkdtempSync(join(tmpdir(), "debugging-jq-")), "result.json");
  writeFileSync(file, JSON.stringify(await replayCassette(withReplayContract(cassette), [], { notesSink: () => {} })));
  return file;
}
const run = (file: string) => execFileSync("jq", ["-r", documentedFilter(), file], { encoding: "utf8" });

describe.skipIf(!HAVE_JQ)("the jq example in docs/debugging.md", () => {
  it("prints the failed check and leaves out the passing one", async () => {
    const out = run(await resultFile([{ result: "success" }, { result: "error" }]));
    expect(out).toContain('{"result":"error"}');
    expect(out).not.toContain('{"result":"success"}');
  });
  it("prints nothing when every check passed", async () => expect(run(await resultFile([{ result: "success" }]))).toBe(""));
  it("says so when there are no assertions, including on a file with no such key", () => {
    const dir = mkdtempSync(join(tmpdir(), "debugging-jq-"));
    for (const body of ['{"assertions":[]}', "{}"]) {
      writeFileSync(join(dir, "r.json"), body);
      expect(run(join(dir, "r.json"))).toBe("no assertions recorded\n");
    }
  });
});

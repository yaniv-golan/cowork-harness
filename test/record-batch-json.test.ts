import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `record <dir/>` and `record --rerecord-stale <dir/>` under --output-format json print exactly ONE
// document, last, right before the exit — and its `ok` is the exit code's verdict (ok ⇔ exit 0), the same
// rule single-file `record` follows. Before this, both batch arms printed NOTHING on stdout: a consumer
// reading the envelope got an empty string for a batch that recorded, failed, or had nothing to do.
//
// Token-free by construction: a dummy key passes the credential guard and COWORK_HARNESS_FORBID_SPAWN (set
// by the test setup) refuses the item at the spawn guard, so the batch's failure path runs for real
// through the same producer a paid recording uses, and nothing is spent. What this cannot show is a real
// recording's stdout staying clean — no stdout writer exists on that path today.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const { COWORK_HARNESS_OUTPUT_FORMAT: _inherited, ...inheritedEnv } = process.env;

function record(args: string[], cwd: string) {
  const r = spawnSync("node", [CLI, "record", ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...inheritedEnv,
      COWORK_HARNESS_RUNS_DIR: join(mkdtempSync(join(tmpdir(), "rec-batch-runs-")), "runs"),
      COWORK_HARNESS_FORBID_SPAWN: "1",
      COWORK_HARNESS_MODEL: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "sk-ant-dummy-not-a-real-key",
    },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function oneDoc(stdout: string, stderr: string): any {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`stdout is not exactly one JSON document (${(e as Error).message}):\n${stdout}\nstderr:\n${stderr}`);
  }
}

describe.skipIf(!can)("record batch arms — one JSON document, ok ⇔ exit 0", () => {
  it("record <dir/>: a failed item is one ok:false document, exit 1, the item names its failure", () => {
    const work = mkdtempSync(join(tmpdir(), "rec-batch-"));
    const dir = join(work, "scenarios");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.yaml"), `name: batch-a\nprompt: "say hi"\nfidelity: protocol\nassert:\n  - result: success\n`);
    const r = record([dir, "--model", "claude-test-model", "--output-format", "json"], work);
    const doc = oneDoc(r.stdout, r.stderr);
    expect(r.code, r.stderr).toBe(1);
    expect(doc.command).toBe("record");
    expect(doc.ok).toBe(false);
    expect(doc.error).toBe(null);
    expect(doc.target).toBe(dir);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].file).toBe(join(dir, "a.yaml"));
    expect(doc.items[0].status).toBe("failed");
    expect(doc.items[0].error).toMatch(/COWORK_HARNESS_FORBID_SPAWN/);
    expect(doc.results, "the batch publishes items[] only").toBeUndefined();
  });

  it("record <dir/> in text mode still prints nothing on stdout", () => {
    const work = mkdtempSync(join(tmpdir(), "rec-batch-"));
    const dir = join(work, "scenarios");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.yaml"), `name: batch-a\nprompt: "say hi"\nfidelity: protocol\nassert:\n  - result: success\n`);
    const r = record([dir, "--model", "claude-test-model"], work);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/✗ record: 1 of 1 failed/);
  });

  it("record --rerecord-stale <dir/> with nothing stale: one ok:true document, exit 0, no items", () => {
    const work = mkdtempSync(join(tmpdir(), "rec-batch-"));
    const empty = join(work, "cassettes");
    mkdirSync(empty);
    const r = record(["--rerecord-stale", empty, "--output-format", "json"], work);
    const doc = oneDoc(r.stdout, r.stderr);
    expect(r.code, r.stderr).toBe(0);
    expect(doc.command).toBe("record");
    expect(doc.ok).toBe(true);
    expect(doc.rerecordStale).toBe(true);
    expect(doc.items).toEqual([]);
    expect(doc.error).toBe(null);
  });
});

// Metrics on replay, over a REAL cassette: `record` drives a stub agent through the protocol tier (no model call),
// then `replay` re-measures the frozen declaration against the cassette's own manifest. A metric the recording
// cannot support (a body over the inline cap, a nulled pre-run hash) is warned about once, naming it; a metric
// that reads what the run did (an untouched fixture file) is not. `--assert-from` measures the ON-DISK
// declaration. Synthetic data only.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

const can = POSIX && existsSync(CLI);
const DUMMY = { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" };
const STUB = [
  `printf '{"words": 1200}' > outputs/m.json`,
  `printf '{"n": 1, "pad": "%s"}' "$(printf 'x%.0s' $(seq 1 200))" > outputs/big.json`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub","model":"claude-sonnet-5","tools":[],"cwd":"/tmp"}'`,
  `printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"session_id":"stub"}'`,
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"stub","num_turns":1,"total_cost_usd":0.01,"usage":{"input_tokens":1,"output_tokens":1}}'`,
  "cat >/dev/null",
].join("\n");

const metric = (id: string, artifact: string, path: string) =>
  `  - {id: ${id}, artifact: ${artifact}, path: ${path}, better: higher, scale: 5000}`;
function scenario(f: StubFixture, file: string, metrics: string[], head: string[] = ["workspace_fixture: ./fx"]): string {
  const fx = join(f.cwd, "fx");
  if (!existsSync(fx) && head.includes("workspace_fixture: ./fx")) {
    mkdirSync(fx);
    writeFileSync(join(fx, "kept.json"), '{"n": 44, "note": "a fixture file the step never touches"}');
  }
  const p = join(f.cwd, file);
  writeFileSync(
    p,
    [
      "name: mr",
      "baseline: latest",
      "fidelity: protocol",
      "prompt: say hi",
      ...head,
      "metrics:",
      ...metrics,
      "assert:",
      "  - result: success",
    ].join("\n") + "\n",
  );
  return p;
}
async function cli(f: StubFixture, args: string[]) {
  const c = spawnCli(f, args);
  const r = await exited(c, 60_000);
  return { ...r, stdout: c.stdoutText(), stderr: c.stderrText() };
}
const METRICS = [
  metric("words", "outputs/m.json", "words"),
  metric("big", "outputs/big.json", "n"),
  metric("kept", "outputs/kept.json", "n"),
];

describe.runIf(can)("metrics over a recorded cassette (record → replay, stub agent)", () => {
  it("replay re-measures from the manifest; one warning names only what the recording cannot support", async () => {
    const f = makeStubFixture(STUB, DUMMY);
    try {
      const sc = scenario(f, "mr.yaml", METRICS);
      const cass = join(f.cwd, "mr.cassette.json");
      const rec = await cli(f, ["record", sc, "--out", cass, "--max-artifact-bytes", "64", "--output-format", "json"]);
      expect(rec.code, rec.stderr).toBe(0);
      expect(JSON.parse(rec.stdout).results[0].metrics).toEqual([
        { id: "words", value: 1200 },
        { id: "big", value: 1 },
        { id: "kept", unavailable: "pre_run" },
      ]);
      const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(rep.code, rep.stderr).toBe(0);
      expect(JSON.parse(rep.stdout).results[0].metrics).toEqual([
        { id: "words", value: 1200 },
        { id: "big", unavailable: "size" },
        { id: "kept", unavailable: "pre_run" },
      ]);
      const warnings = rep.stderr.split("\n").filter((l) => l.includes("[replay] metrics:"));
      expect(warnings, rep.stderr).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /1\/3 not measurable from this cassette \(big: size — larger than the recorded artifact-body cap; re-record with a larger --max-artifact-bytes\)/,
      );
      expect(warnings[0]).not.toMatch(/kept|words/);

      // --assert-from: the on-disk declaration is measured, not the frozen one.
      const onDisk = scenario(f, "mr-edit.yaml", [metric("words_again", "outputs/m.json", "words")]);
      const re = await cli(f, ["replay", cass, "--assert-from", onDisk, "--output-format", "json"]);
      expect(re.code, re.stderr).toBe(0);
      expect(JSON.parse(re.stdout).results[0].metrics).toEqual([{ id: "words_again", value: 1200 }]);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("replay notices a metrics: drift; --assert-from --write persists a metrics-only change", async () => {
    const f = makeStubFixture(STUB, DUMMY);
    try {
      const sc = scenario(f, "mr.yaml", [metric("words", "outputs/m.json", "words")]);
      const cass = join(f.cwd, "mr.cassette.json");
      const rec = await cli(f, ["record", sc, "--out", cass, "--output-format", "json"]);
      expect(rec.code, rec.stdout).toBe(0);
      // Edit ONLY metrics on disk (the asserts are unchanged).
      const edited = scenario(f, "mr.yaml", [metric("words", "outputs/m.json", "words"), metric("again", "outputs/m.json", "words")]);
      const plain = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(plain.stderr).toMatch(/has a different `metrics:` block; replay measured the metrics frozen in the cassette/);
      expect(JSON.parse(plain.stdout).results[0].metrics).toEqual([{ id: "words", value: 1200 }]);
      const w = await cli(f, ["replay", cass, "--assert-from", edited, "--write", "--output-format", "json"]);
      expect(w.code, w.stderr).toBe(0);
      expect(w.stderr).not.toMatch(/already matches/);
      expect(JSON.parse(readFileSync(cass, "utf8")).scenario.metrics.map((m: { id: string }) => m.id)).toEqual(["words", "again"]);
      const after = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(JSON.parse(after.stdout).results[0].metrics).toEqual([
        { id: "words", value: 1200 },
        { id: "again", value: 1200 },
      ]);
      expect(after.stderr).not.toMatch(/different `metrics:`/);
    } finally {
      f.cleanup();
    }
  }, 180_000);

  it("a nulled pre-run hash (a connected-folder file over the pre-run hash cap) is a cassette-caused pre_run: warned, naming it", async () => {
    const f = makeStubFixture(STUB, { ...DUMMY, COWORK_HARNESS_PRERUN_HASH_CAP: "16" });
    try {
      const data = join(f.cwd, "data");
      mkdirSync(data);
      writeFileSync(join(data, "x.json"), '{"n": 5, "note": "larger than the sixteen-byte cap"}');
      writeFileSync(join(f.cwd, "s.yaml"), `folders:\n  - { from: ${data}, mode: rw }\n`);
      const sc = scenario(f, "mr.yaml", [metric("inherited", "data/x.json", "n")], ["session: ./s.yaml"]);
      const cass = join(f.cwd, "mr.cassette.json");
      const rec = await cli(f, ["record", sc, "--out", cass, "--output-format", "json"]);
      expect(rec.code, rec.stdout).toBe(0);
      const c = JSON.parse(readFileSync(cass, "utf8"));
      expect(c.preRunHashes["data/x.json"]).toBeNull();
      const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(JSON.parse(rep.stdout).results[0].metrics).toEqual([{ id: "inherited", unavailable: "pre_run" }]);
      expect(rep.stderr).toMatch(
        /\[replay\] metrics: 1\/1 not measurable from this cassette \(inherited: pre_run — its pre-run hash is unavailable/,
      );
      // The live run could not hash it either, so a re-record would not measure it: no such remedy is offered.
      expect(rep.stderr.split("\n").find((l) => l.includes("[replay] metrics:"))).not.toMatch(/re-record/);
    } finally {
      f.cleanup();
    }
  }, 180_000);
});

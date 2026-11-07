// `record` refuses to freeze a run whose control-out.jsonl is missing or empty. Every driven session writes at least
// its `initialize` request there, so an empty one means the responses were never captured — and a cassette frozen
// from it would fail every decision on replay as truncated (or, before the read contract, load with none graded).
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeRecordedRun, RecordPostRunRefusalError } from "../src/run/cassette.js";
import { loadBaseline } from "../src/baseline.js";
import { ScenarioObject } from "../src/types.js";
import type { RunResult, Scenario } from "../src/types.js";
import { INIT_CONTROL_LINE } from "./helpers/minimal-cassette.js";

const LIVE = loadBaseline("latest").appVersion;
const line = (o: unknown) => JSON.stringify(o);

function fixture(controlOut: "absent" | "empty" | "init") {
  const outDir = mkdtempSync(join(tmpdir(), "record-empty-controlout-"));
  writeFileSync(
    join(outDir, "events.jsonl"),
    [line({ type: "system", subtype: "init", tools: [], skills: [] }), line({ type: "result", subtype: "success", is_error: false })].join(
      "\n",
    ),
  );
  if (controlOut === "empty") writeFileSync(join(outDir, "control-out.jsonl"), "");
  if (controlOut === "init") writeFileSync(join(outDir, "control-out.jsonl"), INIT_CONTROL_LINE + "\n");
  const scenario = ScenarioObject.parse({ name: "empty-controlout", fidelity: "container", prompt: "hi" }) as unknown as Scenario;
  const result = {
    mode: "run",
    command: "record",
    scenario: scenario.name,
    prompt: scenario.prompt,
    fidelity: "container",
    effectiveFidelity: "container",
    result: "success",
    baseline: LIVE,
    outDir,
    userVisibleRoots: ["outputs"],
    fingerprint: { baseline: LIVE, hashFormat: "jcs1" },
    assertions: [],
    egress: [],
  } as unknown as RunResult;
  return { outDir, scenario, result, cassettePath: join(outDir, "c.cassette.json") };
}

async function freeze(f: ReturnType<typeof fixture>): Promise<unknown> {
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await freezeRecordedRun(f.scenario, { noRedact: false, allowFailing: true, cassettePath: f.cassettePath }, [], f.result);
    return undefined;
  } catch (e) {
    return e;
  } finally {
    errSpy.mockRestore();
  }
}

describe("record refuses a run with no captured control responses", () => {
  it.each(["absent", "empty"] as const)(
    "control-out.jsonl %s: RecordPostRunRefusalError, carrying the run, and no cassette written",
    async (kind) => {
      const f = fixture(kind);
      const e = await freeze(f);
      expect(e).toBeInstanceOf(RecordPostRunRefusalError);
      const err = e as RecordPostRunRefusalError;
      expect(err.message).toBe(
        `control-out.jsonl in ${f.outDir} is missing or empty — the run's control responses were not captured, so a ` +
          `cassette could not grade its decisions on replay. Re-run the record.`,
      );
      expect(err.result).toBe(f.result); // a post-run refusal reports the run (its verdict and cost)
      expect(existsSync(f.cassettePath)).toBe(false);
    },
  );

  it("the control: with the initialize line present, the same run freezes", async () => {
    const f = fixture("init");
    expect(await freeze(f)).toBeUndefined();
    expect(existsSync(f.cassettePath)).toBe(true);
  });
});

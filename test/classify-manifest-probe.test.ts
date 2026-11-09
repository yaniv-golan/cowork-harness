import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { classifyManifestProbe, ManifestProbeEvidenceError, type ManifestProbeOutcome } from "../scripts/classify-manifest-probe.js";
import { replayCassette } from "../src/run/cassette.js";
import type { RunResult } from "../src/types.js";
import { withReplayContract } from "./helpers/minimal-cassette.js";

// Every case starts from a real kept run of the probe and goes through the replay re-drive, so the classifier reads
// what the producer writes. In that run a sub-agent's Write to the read-only attached folder was refused, a shell
// write there failed, and a shell write to the outputs folder worked. Each case changes only the frames it names.
const FIXTURE = join(import.meta.dirname, "fixtures", "hillclimb-runs", "fanout-probe", "events.jsonl");
// The published shape of the fields the classifier reads, so a case the producer's schema does not allow cannot pass.
const CLASSIFIER_INPUTS = ["fileToolAttempts", "toolResults", "pathDenials", "toolCalls"];
const schema = JSON.parse(readFileSync(resolve("schema/run-result.json"), "utf8"));
const validate = new Ajv({ strict: false, allErrors: true }).compile({
  $defs: schema.$defs,
  type: "object",
  required: CLASSIFIER_INPUTS,
  properties: Object.fromEntries(CLASSIFIER_INPUTS.map((k) => [k, schema.properties[k]])),
});

const WRITE_USE = 11; // the sub-agent's Write
const WRITE_RESULT = 12;
const FAILED_SHELL = [13, 14];
const OUTPUTS_SHELL = [17, 18];
const HOST_NOTE = "/Users/someone/.cowork-harness/runs/probe/local_1/work/session/mnt/outputs/manifest-probe-check.md";
const VM_NOTE = "/sessions/local_1/mnt/outputs/manifest-probe-check.md";

type Frame = { message: { content: Array<Record<string, unknown>> } };
const frames = (): string[] => readFileSync(FIXTURE, "utf8").trim().split("\n");
function edit(lines: string[], i: number, change: (block: Record<string, unknown>) => void): void {
  const f = JSON.parse(lines[i]!) as Frame;
  change(f.message.content[0]!);
  lines[i] = JSON.stringify(f);
}
const writeTo = (lines: string[], path: string) => edit(lines, WRITE_USE, (b) => ((b.input as Record<string, unknown>).file_path = path));
const without = (lines: string[], drop: number[]) => lines.filter((_, i) => !drop.includes(i));
function fromMainLoop(lines: string[], indexes: number[]): void {
  for (const i of indexes) lines[i] = JSON.stringify({ ...JSON.parse(lines[i]!), parent_tool_use_id: null });
}

async function replayed(lines: string[]): Promise<RunResult> {
  const cassette = {
    scenario: {
      name: "probe",
      baseline: "latest",
      session: "(inline)",
      fidelity: "hostloop" as const,
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: lines,
    preRunPaths: [],
    artifacts: [],
  } as any;
  const r = await replayCassette(withReplayContract(cassette), [], { notesSink: () => {} });
  expect(validate(JSON.parse(JSON.stringify(r))), JSON.stringify(validate.errors)).toBe(true);
  return r;
}

const CASES: Array<[string, () => string[], ManifestProbeOutcome]> = [
  ["as recorded: the shell delivered after the Write was refused", frames, "shell write"],
  [
    "the Write of the note reached the outputs host path",
    () => {
      const l = frames();
      writeTo(l, HOST_NOTE);
      edit(l, WRITE_RESULT, (b) => delete b.is_error);
      return l;
    },
    "host-path write",
  ],
  [
    "a host-path Write the tool rejected is not a delivery",
    () => {
      const l = frames();
      writeTo(l, HOST_NOTE);
      return without(l, OUTPUTS_SHELL);
    },
    "no sub-agent write",
  ],
  [
    "a Write to a /sessions/ path was refused, and the shell then delivered",
    () => {
      const l = frames();
      writeTo(l, VM_NOTE);
      return l;
    },
    "vm-path refused",
  ],
  [
    "a refused /sessions/ Write followed by a good host-path Write is still the refusal",
    () => {
      const l = frames();
      writeTo(l, VM_NOTE);
      const retry = l.slice(WRITE_USE, WRITE_RESULT + 1).map((f) => f.replaceAll("toolu_0176Eg3XKaFQXtt6ryDahg2e", "toolu_later"));
      l.splice(WRITE_RESULT + 1, 0, ...retry);
      edit(l, WRITE_RESULT + 1, (b) => ((b.input as Record<string, unknown>).file_path = HOST_NOTE));
      edit(l, WRITE_RESULT + 2, (b) => delete b.is_error);
      return l;
    },
    "vm-path refused",
  ],
  [
    "every delivery attempt removed",
    () => without(frames(), [WRITE_USE, WRITE_RESULT, ...FAILED_SHELL, ...OUTPUTS_SHELL]),
    "no sub-agent write",
  ],
  ["a shell command that failed is not a delivery", () => without(frames(), OUTPUTS_SHELL), "no sub-agent write"],
  [
    "a host-path Write by the main loop is not the sub-agent's",
    () => {
      const l = frames();
      writeTo(l, HOST_NOTE);
      edit(l, WRITE_RESULT, (b) => delete b.is_error);
      fromMainLoop(l, [WRITE_USE, WRITE_RESULT]);
      return without(l, OUTPUTS_SHELL);
    },
    "no sub-agent write",
  ],
  [
    "a shell write by the main loop is not the sub-agent's",
    () => {
      const l = frames();
      fromMainLoop(l, OUTPUTS_SHELL);
      return l;
    },
    "no sub-agent write",
  ],
];

describe("classify-manifest-probe, over the replay re-drive of a kept run", () => {
  for (const [name, build, want] of CASES) it(name, async () => expect(classifyManifestProbe(await replayed(build()))).toBe(want));

  it("a result without the telemetry claims no outcome", () => {
    expect(() => classifyManifestProbe({})).toThrow(ManifestProbeEvidenceError);
    expect(() => classifyManifestProbe({ fileToolAttempts: [], toolResults: [] })).toThrow(/shell write cannot be ruled out/);
  });

  it("the command prints exactly one outcome, and exits 2 on an unreadable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "classify-probe-"));
    const file = join(dir, "result.json");
    writeFileSync(file, JSON.stringify(await replayed(frames())));
    const run = (...a: string[]) =>
      spawnSync("npx", ["--no-install", "tsx", "scripts/classify-manifest-probe.ts", ...a], { encoding: "utf8", timeout: 60_000 });
    const ok = run(file);
    expect([ok.status, ok.stdout]).toEqual([0, "shell write\n"]);
    expect(run(join(dir, "absent.json")).status).toBe(2);
    expect(run().status).toBe(2);
  }, 120_000);
});

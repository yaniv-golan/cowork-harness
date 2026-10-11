// `device_bridge: true` serves the remote lane's device tools (device_bash, get_device_info) from a second
// container. It is valid only with `lane: remote` and `fidelity: container`; the loader and the published schema
// must refuse every other pairing alike, and a cassette that uses it must be too new for a v16 reader.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { SCHEMA_DIR } from "../scripts/gen-schema.js";
import { Scenario } from "../src/types.js";
import { preSpendVerdicts, requiredVersionFor } from "../src/run/cassette.js";
import { parseScenarioFile, scenarioInputFindings } from "../src/run/execute.js";
import { deviceBridgeFolderAssertRefusal } from "../src/runtime/device-container.js";
import { laneRemoteLoadRefusal } from "../src/run/lane-notice.js";

const ajv = new Ajv({ strict: true });
const validateScenario = ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, "scenario.schema.json"), "utf8")));

const OK = { prompt: "x", fidelity: "container", lane: "remote", device_bridge: true };

describe("device_bridge scenario key", () => {
  it("is accepted with lane: remote and fidelity: container, by the loader and the published schema", () => {
    expect(Scenario.safeParse(OK).success).toBe(true);
    expect(validateScenario(OK)).toBe(true);
  });

  it.each([
    ["lane omitted (defaults to local)", { prompt: "x", fidelity: "container", device_bridge: true }],
    ["lane: local", { ...OK, lane: "local" }],
    ["fidelity: hostloop", { ...OK, fidelity: "hostloop" }],
    ["fidelity: cowork", { ...OK, fidelity: "cowork" }],
    ["fidelity: protocol", { ...OK, fidelity: "protocol" }],
    ["fidelity: microvm", { ...OK, fidelity: "microvm" }],
  ])("is refused with %s, by the loader and the published schema", (_label, doc) => {
    const parsed = Scenario.safeParse(doc);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toContain("device_bridge");
    expect(validateScenario(doc)).toBe(false);
  });

  it("only `true` is valid (omit the key to turn it off)", () => {
    expect(Scenario.safeParse({ ...OK, device_bridge: false }).success).toBe(false);
    expect(validateScenario({ ...OK, device_bridge: false })).toBe(false);
  });

  it("an omitted key is not written back into the parsed scenario (no default lands in a frozen cassette)", () => {
    const parsed = Scenario.parse({ prompt: "x", fidelity: "container", lane: "remote" });
    expect("device_bridge" in parsed).toBe(false);
  });
});

describe("device_bridge cassette stamp", () => {
  it("a scenario using it stamps v17", () => {
    expect(requiredVersionFor(Scenario.parse(OK))).toBe(17);
  });
  it("the same scenario without it stamps exactly what it did", () => {
    const { device_bridge: _drop, ...without } = OK;
    expect(requiredVersionFor(Scenario.parse(without))).toBeLessThan(17);
    expect(requiredVersionFor({ prompt: "x", lane: "remote" })).toBe(
      requiredVersionFor({ prompt: "x", lane: "remote", device_bridge: undefined }),
    );
  });
});

// Under the bridge the folders live in the device container, and grading reads the agent's tree, which holds none of
// them. A file assertion on a folder path would grade the wrong tree (fail on a file device_bash wrote, or pass on
// one the agent made in its own container), so it is refused before the run.
describe("deviceBridgeFolderAssertRefusal", () => {
  const sc = (assert: unknown[]) => ({ device_bridge: true as const, assert }) as never;
  it("refuses file_exists and input_unmodified on a connected folder's path, in either form", () => {
    for (const a of [
      { file_exists: "proj/report.md" },
      { file_exists: { path: "proj/report.md", authored: true } },
      { input_unmodified: "proj/**" },
      { input_unmodified: ["outputs/x", "proj/a.txt"] },
      { input_unmodified: "pr*/a.txt" },
    ])
      expect(deviceBridgeFolderAssertRefusal(sc([a]), ["proj"]), JSON.stringify(a)).toMatch(/device_bridge.*proj/);
  });
  it("leaves outputs paths, other folders' names and a scenario without the bridge alone", () => {
    expect(
      deviceBridgeFolderAssertRefusal(sc([{ file_exists: "outputs/r.md" }, { input_unmodified: "notes/**" }]), ["proj"]),
    ).toBeUndefined();
    expect(deviceBridgeFolderAssertRefusal({ assert: [{ file_exists: "proj/r.md" }] } as never, ["proj"])).toBeUndefined();
  });
});

// The refusal must come before any spend: `record --dry-run` previews the pre-spend refusals, and eval/hillclimb run
// scenarioInputFindings over a whole batch before the first item spends.
describe("the folder-path refusal is pre-spend", () => {
  function scenarioOnFolder(assertLine: string) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "db-prespend-")));
    mkdirSync(join(dir, "proj"));
    writeFileSync(join(dir, "s.yaml"), "folders:\n  - from: ./proj\n    mode: rw\n");
    const f = join(dir, "sc.yaml");
    writeFileSync(
      f,
      `name: db\nbaseline: latest\nsession: s.yaml\nfidelity: container\nlane: remote\ndevice_bridge: true\nprompt: hi\nassert:\n${assertLine}`,
    );
    return { scenario: parseScenarioFile(f), dir };
  }
  it("preSpendVerdicts refuses file_exists on a connected folder's path", () => {
    const { scenario, dir } = scenarioOnFolder("  - file_exists: proj/report.md\n");
    const v = preSpendVerdicts(scenario, join(dir, "x.cassette.json"), {});
    expect(v.some((x) => x.kind === "refuse" && /device_bridge.*proj/.test(x.message))).toBe(true);
    const ok = scenarioOnFolder("  - file_exists: outputs/report.md\n");
    expect(preSpendVerdicts(ok.scenario, join(ok.dir, "x.cassette.json"), {}).some((x) => /device_bridge/.test(x.message))).toBe(false);
  });
  it("scenarioInputFindings reports it, so a batch refuses before its first item spends", () => {
    const { scenario } = scenarioOnFolder("  - input_unmodified: proj/**\n");
    const f = scenarioInputFindings(scenario, "claude-sonnet-5", { quiet: true });
    expect(String(f.vacuity?.message ?? "")).toMatch(/device_bridge.*proj/);
  });
});

// A bridge author refused a delivery- or body-shaped key is told what the bridge offers: the device_bash call. Without
// the bridge the message is unchanged.
describe("the remote-lane refusal names the device_bash route under the bridge", () => {
  it("adds the device_bash hint only when device_bridge is set", () => {
    const withBridge = laneRemoteLoadRefusal({
      lane: "remote",
      device_bridge: true,
      assert: [{ artifact_text: { path: "x", contains: "y" } }],
    });
    const without = laneRemoteLoadRefusal({ lane: "remote", assert: [{ artifact_text: { path: "x", contains: "y" } }] });
    expect(withBridge).toMatch(/device_bridge.*tool_called: \{tool: mcp__remote-devices__device_bash/);
    expect(without).not.toMatch(/device_bash/);
  });
});

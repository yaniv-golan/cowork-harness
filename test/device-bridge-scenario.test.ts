// `device_bridge: true` serves the remote lane's device tools (device_bash, get_device_info) from a second
// container. It is valid only with `lane: remote` and `fidelity: container`; the loader and the published schema
// must refuse every other pairing alike, and a cassette that uses it must be too new for a v16 reader.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { SCHEMA_DIR } from "../scripts/gen-schema.js";
import { Scenario } from "../src/types.js";
import { requiredVersionFor } from "../src/run/cassette.js";

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

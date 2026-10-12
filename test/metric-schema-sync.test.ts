// The published scenario schema mirrors the metric loader's source rule by hand (gen-schema's `allOf`/`oneOf`): an
// artifact metric (`artifact` + `path`, no command fields) or a command metric (`command`, no `artifact`/`path`). The
// two must agree on every case the schema can express; the command's extension and path shape stay loader-only.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { ScenarioMetric } from "../src/types.js";

const schema = JSON.parse(readFileSync("schema/scenario.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateItem = ajv.compile({ ...schema.properties.metrics.items, definitions: schema.definitions, $defs: schema.$defs });

const base = { id: "n", better: "lower", unbounded: true };
describe("metric source rule: zod and the published JSON schema agree", () => {
  it.each([
    [{ artifact: "outputs/m.json", path: "x" }, true],
    [{ command: ["metrics/c.py"] }, true],
    [{ command: ["metrics/c.mjs", "--strict"], deps: ["metrics/d.mjs"], timeout_ms: 60000 }, true],
    [{}, false],
    [{ artifact: "outputs/m.json" }, false],
    [{ artifact: "outputs/m.json", path: "x", command: ["metrics/c.py"] }, false],
    [{ command: ["metrics/c.py"], path: "x" }, false],
    [{ command: ["metrics/c.py"], artifact: "outputs/m.json" }, false],
    [{ artifact: "outputs/m.json", path: "x", deps: ["d.py"] }, false],
    [{ artifact: "outputs/m.json", path: "x", timeout_ms: 5000 }, false],
    [{ command: ["metrics/c.py"], timeout_ms: 999 }, false],
    [{ command: ["metrics/c.py"], timeout_ms: 300001 }, false],
    [{ command: [] }, false],
  ])("%j", (m, valid) => {
    const doc = { ...base, ...m };
    expect(ScenarioMetric.safeParse(doc).success, "zod").toBe(valid);
    expect(validateItem(doc), `json schema: ${JSON.stringify(validateItem.errors)}`).toBe(valid);
  });
});

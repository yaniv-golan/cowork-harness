// Behavioural backstop for the PUBLISHED JSON schemas (schema/*.json), complementing the byte-level
// drift guard in schema.test.ts. The drift guard only proves "the committed file matches the zod source";
// it cannot prove the emitted JSON schema actually accepts/rejects the right documents. This validates the
// committed schemas with a draft-07 validator (ajv) against real fixtures — the load-bearing guard against
// the zod-4 `z.toJSONSchema` "every defaulted field becomes required" regression (B1 / B1-NESTED).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { SCHEMA_DIR } from "../scripts/gen-schema.js";

const ajv = new Ajv({ strict: true });
const load = (f: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
const validateScenario = ajv.compile(load("scenario.schema.json"));
const validateSession = ajv.compile(load("session.schema.json"));

describe("published scenario.schema.json validates via ajv (draft-07)", () => {
  it("accepts a MINIMAL scenario (only `prompt`) — guards B1: defaulted fields must NOT be required", () => {
    expect(validateScenario({ prompt: "do the thing" })).toBe(true);
  });
  it("rejects an unknown top-level key (strictObject fail-closed preserved)", () => {
    expect(validateScenario({ prompt: "x", bogus: true })).toBe(false);
  });
});

describe("published session.schema.json validates via ajv (draft-07)", () => {
  it("accepts an empty session (every field optional or defaulted)", () => {
    expect(validateSession({})).toBe(true);
  });
  it("accepts a PARTIAL session exercising nested defaults — guards B1-NESTED", () => {
    // folders[].mode, plugins.config_dir/marketplaces/..., egress.extra_allow are all `.default()`d;
    // if the recursive required-strip missed any nesting level, one of these omissions would reject.
    expect(validateSession({ folders: [{ from: "/x" }], plugins: { enabled: ["p@m"] }, egress: { unrestricted: true } })).toBe(true);
  });
  it("rejects an unknown NESTED key (nested objects stay fail-closed — not loosened by `io:input`)", () => {
    expect(validateSession({ folders: [{ from: "/x", surprise: true }] })).toBe(false);
  });
});

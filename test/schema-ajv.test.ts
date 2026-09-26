// Behavioural backstop for the PUBLISHED JSON schemas (schema/*.json), complementing the byte-level
// drift guard in schema.test.ts. The drift guard only proves "the committed file matches the zod source";
// it cannot prove the emitted JSON schema actually accepts/rejects the right documents. This validates the
// committed schemas with a draft-07 validator (ajv) against real fixtures — the load-bearing guard against
// the zod-4 `z.toJSONSchema` "every defaulted field becomes required" regression.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { SCHEMA_DIR } from "../scripts/gen-schema.js";
import { Scenario } from "../src/types.js";

const ajv = new Ajv({ strict: true });
const load = (f: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
const validateScenario = ajv.compile(load("scenario.schema.json"));
const validateSession = ajv.compile(load("session.schema.json"));

describe("published scenario.schema.json validates via ajv (draft-07)", () => {
  it("accepts a MINIMAL scenario (only `prompt`) — guards that defaulted fields are NOT required", () => {
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
  it("accepts a PARTIAL session exercising nested defaults", () => {
    // folders[].mode, plugins.config_dir/marketplaces/..., egress.extra_allow are all `.default()`d;
    // if the recursive required-strip missed any nesting level, one of these omissions would reject.
    expect(validateSession({ folders: [{ from: "/x" }], plugins: { enabled: ["p@m"] }, egress: { unrestricted: true } })).toBe(true);
  });
  it("rejects an unknown NESTED key (nested objects stay fail-closed — not loosened by `io:input`)", () => {
    expect(validateSession({ folders: [{ from: "/x", surprise: true }] })).toBe(false);
  });
});

// ── The gap the schema's own `description` now declares (T-G5) ─────────────────────────────────────
//
// `scenario.schema.json` mirrors the two mutually-exclusive delete-assertion rules and nothing else, so
// it is not the authority on what runs. An editor or a CI step that validates against it alone will green
// a file the harness refuses. The description says so; these pin the two examples it names, from BOTH
// sides — so mirroring a rule in later, or dropping one, fails here and forces the text to be updated.

describe("published scenario.schema.json is structural, and says so", () => {
  it("accepts a matcher-less `answers:` entry that the LOADER refuses", () => {
    const doc = { prompt: "x", answers: [{}] };
    expect(validateScenario(doc), "the JSON schema started rejecting this — update the description").toBe(true);
    const parsed = Scenario.safeParse(doc);
    expect(parsed.success, "the loader started accepting a matcher-less answer rule").toBe(false);
    if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).toContain("no matcher");
  });

  it("accepts `lane: remote` with a delivery-shaped assertion, which is refused at load time", () => {
    // Refused by `execute.ts`'s lane check and by `lint`'s `lane-remote-incompatible-key` — NOT by the
    // zod schema, which is why `Scenario.safeParse` passing here is the point rather than a bug.
    const doc = { prompt: "x", lane: "remote", assert: [{ user_visible_artifact: "outputs/x.md" }] };
    expect(validateScenario(doc)).toBe(true);
    expect(Scenario.safeParse(doc).success, "this moved into the zod schema — update the description").toBe(true);
  });

  it("still rejects what it DOES mirror (the delete-assertion contradiction)", () => {
    // The counterweight: "structural only" must not become "checks nothing".
    expect(validateScenario({ prompt: "x", assert: [{ no_delete_in_outputs: true }, { allow_outputs_delete: true }] })).toBe(false);
  });

  it("the description points at the checks that catch the two cases above", () => {
    // `cowork-harness lint` runs the real loader, so it catches both; `record --dry-run` adds the pre-spend
    // refusals. A description naming neither would send an author to the schema alone, which reports clean.
    const d = load("scenario.schema.json").description as string;
    expect(d).toContain("lint");
    expect(d).toContain("--dry-run");
    expect(d).toMatch(/STRUCTURAL/);
  });
});

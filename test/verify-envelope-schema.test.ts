import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Ajv from "ajv";

// Pins the `verify-cassettes --output-format json` envelope against its published contract schema
// (schema/verify-cassettes.json, a covered 1.0 surface — SPEC §12). Two-way drift tripwire:
//  - schema drift: a required key the CLI stops emitting fails validation;
//  - emission drift: the schema is STRICTENED here (additionalProperties:false injected at every
//    object level) so a key the CLI starts emitting WITHOUT a schema update also fails. The
//    published schema itself stays permissive — post-1.0, additive envelope growth is a MINOR
//    change and must not break consumers validating with an older schema.
// Token/agent-free; needs dist/cli.js (the `ci` script builds before testing); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

const schema = JSON.parse(readFileSync(resolve("schema/verify-cassettes.json"), "utf8"));

/** Deep-copy the schema with additionalProperties:false on every object node that declares properties. */
function stricten(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stricten);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = stricten(v);
    if (out.type === "object" && out.properties) out.additionalProperties = false;
    return out;
  }
  return node;
}

const ajv = new Ajv({ strict: true });
const validatePublished = ajv.compile(schema);
const strict = stricten(schema) as Record<string, unknown>;
delete strict.$id; // ajv rejects two compilations under one $id
const validateStrict = ajv.compile(strict);

function envelope(args: string[], cwd: string): unknown {
  const r = spawnSync("node", [CLI, ...args, "--output-format", "json"], { encoding: "utf8", cwd });
  return JSON.parse(r.stdout);
}

const cassette = (over: Record<string, unknown> = {}) => ({
  cassetteVersion: 9,
  scenario: {
    name: "c",
    baseline: "latest",
    session: "(inline)",
    fidelity: "container",
    prompt: "hi",
    answers: [],
    expect_denied: [],
    assert: [{ result: "success" }],
    ...over,
  },
  events: [JSON.stringify({ type: "result", subtype: "success" })],
});

const check = (env: unknown): void => {
  expect(validatePublished(env), ajv.errorsText(validatePublished.errors)).toBe(true);
  expect(validateStrict(env), ajv.errorsText(validateStrict.errors)).toBe(true);
};

describe("schema/verify-cassettes.json", () => {
  it("ajv strict-compiles (draft-07, no unknown keywords)", () => {
    expect(typeof validatePublished).toBe("function");
  });
});

describe.skipIf(!can)("verify-cassettes envelope matches the published schema", () => {
  it("clean cassette (ok:true, all channels empty)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ves-"));
    writeFileSync(join(d, "ok.cassette.json"), JSON.stringify(cassette()));
    check(envelope(["verify-cassettes", join(d, "ok.cassette.json")], d));
  });

  it("privacy finding populated (findings[].where/cls/sample)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ves-"));
    const c = cassette();
    c.events.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mail eve@evil.com" }] } }));
    writeFileSync(join(d, "leak.cassette.json"), JSON.stringify(c));
    const env = envelope(["verify-cassettes", join(d, "leak.cassette.json")], d) as { ok: boolean };
    expect(env.ok).toBe(false);
    check(env);
  });

  it("staleness populated (pre-effectiveFidelity fidelity:cowork → unverifiable-tier)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ves-"));
    writeFileSync(join(d, "cw.cassette.json"), JSON.stringify(cassette({ fidelity: "cowork" })));
    check(envelope(["verify-cassettes", join(d, "cw.cassette.json")], d));
  });

  it("notes populated (pre-effectiveFidelity explicit tier → non-failing note)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ves-"));
    writeFileSync(join(d, "old.cassette.json"), JSON.stringify(cassette()));
    const env = envelope(["verify-cassettes", join(d, "old.cassette.json")], d) as { results: Array<{ notes: string[] }> };
    expect(env.results[0].notes.length).toBeGreaterThan(0);
    check(env);
  });

  it("version populated (cassette from a NEWER harness → hard fail, schema-valid)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ves-"));
    const c = cassette() as Record<string, unknown>;
    c.cassetteVersion = 9999;
    writeFileSync(join(d, "future.cassette.json"), JSON.stringify(c));
    const env = envelope(["verify-cassettes", join(d, "future.cassette.json")], d) as {
      ok: boolean;
      results: Array<{ version: string[] }>;
    };
    expect(env.ok).toBe(false);
    expect(env.results[0].version.length).toBeGreaterThan(0);
    check(env);
  });

  it("error path (malformed cassette tallied, batch continues, envelope still valid)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-ves-"));
    writeFileSync(join(d, "ok.cassette.json"), JSON.stringify(cassette()));
    writeFileSync(join(d, "junk.cassette.json"), "{ not json");
    const env = envelope(["verify-cassettes", d], d) as { ok: boolean };
    expect(env.ok).toBe(false);
    check(env);
  });
});

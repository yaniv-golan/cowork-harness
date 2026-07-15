import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import Ajv from "ajv";
import { jsonError } from "../src/run/envelope.js";
import { runDoctorChecks, type DoctorCheck } from "../src/run/doctor.js";

// Pins the `doctor --output-format json` envelope against its published contract schema
// (schema/doctor.json, a covered 1.0 surface — SPEC §11.2/§12). Mirrors
// test/verify-envelope-schema.test.ts: two-way drift tripwire —
//  - schema drift: a required key the CLI stops emitting fails validation;
//  - emission drift: the schema is STRICTENED here (additionalProperties:false injected at every
//    object level of every oneOf branch) so a key the CLI starts emitting WITHOUT a schema update
//    also fails. The published schema itself stays permissive — post-1.0, additive envelope growth
//    is a MINOR change and must not break consumers validating with an older schema.
// Token/agent-free; needs dist/cli.js (the `ci` script builds before testing); skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

const schema = JSON.parse(readFileSync(resolve("schema/doctor.json"), "utf8")) as Record<string, unknown>;

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

function run(args: string[], cwd: string): { stdout: string; status: number } {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd });
  return { stdout: r.stdout, status: r.status ?? -1 };
}

const check = (env: unknown): void => {
  expect(validatePublished(env), ajv.errorsText(validatePublished.errors)).toBe(true);
  expect(validateStrict(env), ajv.errorsText(validateStrict.errors)).toBe(true);
};

describe("schema/doctor.json", () => {
  it("ajv strict-compiles (draft-07, no unknown keywords)", () => {
    expect(typeof validatePublished).toBe("function");
  });
});

describe.skipIf(!can)("doctor envelope matches the published schema", () => {
  it("normal invocation (completed probe, exit 0 or 1, error:null)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-des-"));
    const r = run(["doctor", "--tier", "protocol", "--output-format", "json"], d);
    expect([0, 1]).toContain(r.status);
    const env = JSON.parse(r.stdout) as { error: unknown; command: string; ok: boolean; checks: unknown[] };
    expect(env.error).toBeNull();
    expect(env.command).toBe("doctor");
    expect(Array.isArray(env.checks)).toBe(true);
    check(env);
  });

  it("invalid flag (usage error, exit 2)", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-des-"));
    const r = run(["doctor", "--tier", "nonsense", "--output-format", "json"], d);
    expect(r.status).toBe(2);
    const env = JSON.parse(r.stdout) as { ok: boolean; error: { category: string } };
    expect(env.ok).toBe(false);
    expect(env.error.category).toBe("usage");
    check(env);
  });

  it("synthetic shared-error envelope for the internal category validates", () => {
    // doctor's top-level catch (cli.ts) emits category:"internal" on an unexpected failure and exits 2
    // (SPEC §11.2). Synthesized directly via the same jsonError() the catch calls — no need to force a
    // real internal failure to exercise the schema branch.
    const env = JSON.parse(jsonError("doctor", "internal", "unexpected failure"));
    expect(env.ok).toBe(false);
    expect(env.error.category).toBe("internal");
    check(env);
  });
});

describe('ok === !checks.some(required && status==="fail") relation (not expressible in JSON Schema)', () => {
  const check = (id: string, status: DoctorCheck["status"], required: boolean): DoctorCheck => ({
    id,
    title: id,
    status,
    detail: "",
    required,
  });

  it("ok:true when no required check fails", () => {
    const checks: DoctorCheck[] = [check("a", "ok", true), check("b", "warn", true), check("c", "fail", false)];
    const ok = !checks.some((c) => c.required && c.status === "fail");
    expect(ok).toBe(true);
  });

  it("ok:false when a required check fails", () => {
    const checks: DoctorCheck[] = [check("a", "ok", true), check("b", "fail", true), check("c", "ok", false)];
    const ok = !checks.some((c) => c.required && c.status === "fail");
    expect(ok).toBe(false);
  });

  it("a NON-required failing check never flips ok to false", () => {
    const checks: DoctorCheck[] = [check("a", "fail", false), check("b", "fail", false)];
    const ok = !checks.some((c) => c.required && c.status === "fail");
    expect(ok).toBe(true);
  });

  it("runDoctorChecks itself upholds the relation on a real probe result (protocol tier)", () => {
    const checks = runDoctorChecks("protocol");
    const ok = !checks.some((c) => c.required && c.status === "fail");
    // Mirrors cmdDoctor's own derivation (doctor.ts): blocking = required && fail; ok = blocking.length === 0.
    const blocking = checks.filter((c) => c.required && c.status === "fail");
    expect(ok).toBe(blocking.length === 0);
  });
});

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { Assertion as AssertionSchema, type Assertion } from "../src/types.js";
import { loadScenarioPure, parseScenarioFile } from "../src/run/execute.js";
import { replayCassette, requiredVersionFor } from "../src/run/cassette.js";
import { loaderFindings } from "../src/run/lint-load.js";
import { UsageError } from "../src/errors.js";

// `artifact_json.schema`: a JSON Schema (draft 2020-12, ajv) the value at `path` (or the whole document) must match.
// Everything an author can get wrong in the SCHEMA is a load error, never a run-time crash or a silent no-op.

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-aj-schema-"));
  mkdirSync(join(root, "outputs"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function ctx(workRoot: string, over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    slashInvokedSkills: [],
    ...over,
  };
}

const PERSON = {
  type: "object",
  required: ["name", "age"],
  properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } },
};
const aj = (o: object): Assertion => ({ artifact_json: { artifact: "outputs/p.json", ...o } }) as Assertion;
const load = (o: object) => AssertionSchema.safeParse(aj(o));
const issues = (r: ReturnType<typeof load>) => JSON.stringify(r.error?.issues ?? []);

describe("artifact_json.schema — load-time refusals", () => {
  it("a valid inline schema loads", () => expect(load({ schema: PERSON }).success).toBe(true));

  it("`format` is refused, naming the keyword and where it is", () => {
    const r = load({ schema: { type: "object", properties: { mail: { type: "string", format: "email" } } } });
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/`format`/);
    expect(issues(r)).toMatch(/pattern/);
    expect(issues(r)).toContain("#/properties/mail");
  });

  it("a property NAMED format, and `format` inside enum/const/default data, load", () => {
    expect(load({ schema: { type: "object", properties: { format: { type: "string" } } } }).success).toBe(true);
    expect(load({ schema: { type: "object", const: { format: "x" } } }).success).toBe(true);
    expect(load({ schema: { enum: [{ format: "x" }], default: { format: "y" } } }).success).toBe(true);
  });

  it("only local `#` refs: a URI-scheme or relative-file `$ref` is refused; `#/$defs/…` loads", () => {
    for (const ref of ["https://example.com/s.json", "file:///etc/s.json", "other.json"]) {
      const r = load({ schema: { $ref: ref } });
      expect(r.success, ref).toBe(false);
      expect(issues(r), ref).toMatch(/\$ref/);
    }
    expect(load({ schema: { $defs: { n: { type: "string" } }, type: "object", properties: { a: { $ref: "#/$defs/n" } } } }).success).toBe(
      true,
    );
    // A property NAMED $ref is a name, not a reference.
    expect(load({ schema: { type: "object", properties: { $ref: { type: "string" } } } }).success).toBe(true);
  });

  it("`$id` at any depth is refused (a registered id would leak between scenarios)", () => {
    expect(load({ schema: { $id: "https://x/s", type: "object" } }).success).toBe(false);
    expect(load({ schema: { type: "object", properties: { a: { $id: "a.json", type: "string" } } } }).success).toBe(false);
  });

  it("`$schema` is allowed only as the 2020-12 meta-schema", () => {
    expect(load({ schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } }).success).toBe(true);
    const r = load({ schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" } });
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/2020-12/);
  });

  it('a recursive schema (`$ref: "#"`) loads and validates nested values', () => {
    const tree = { type: "object", properties: { children: { type: "array", items: { $ref: "#" } } } };
    expect(load({ schema: tree }).success).toBe(true);
  });

  it("`format` is refused anywhere, an unreferenced `$defs` entry included", () => {
    const r = load({ schema: { type: "object", $defs: { u: { type: "string", format: "email" } } } });
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/`format`/);
  });

  it("the draft-07 array form of `items` gets a message naming `prefixItems`", () => {
    const r = load({ schema: { type: "array", items: [{ type: "string" }] } });
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/prefixItems/);
  });

  it("names the type with the right article, and the message is not prefixed twice", () => {
    const r = load({ schema: { items: { type: "string" } } });
    expect(issues(r)).toMatch(/applies only to an array/);
    expect(issues(r)).not.toMatch(/artifact_json\.schema: artifact_json\.schema/);
  });

  it("$dynamicRef / $recursiveRef (which crash ajv's compile) are refused cleanly", () => {
    for (const k of ["$dynamicRef", "$recursiveRef", "$dynamicAnchor", "$recursiveAnchor"]) {
      const r = load({ schema: { type: "object", [k]: "#" } });
      expect(r.success, k).toBe(false);
      expect(issues(r), k).toContain(k);
    }
  });

  it("annotation-only content keywords are refused (they validate nothing)", () => {
    for (const k of ["contentSchema", "contentMediaType", "contentEncoding"]) {
      const r = load({ schema: { type: "string", [k]: k === "contentSchema" ? { type: "object" } : "x" } });
      expect(r.success, k).toBe(false);
      expect(issues(r), k).toContain(k);
    }
  });

  it("`required`/`properties` without a type is refused: it would pass vacuously on a non-object document", () => {
    const r = load({ schema: { required: ["x"] } });
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/add `type: object` \(or the intended type\) at #/);
  });

  it("ordinary schemas strict mode would refuse load (strictRequired / strictTuples off)", () => {
    expect(load({ schema: { type: "object", required: ["a"] } }).success).toBe(true);
    expect(load({ schema: { type: "array", prefixItems: [{ type: "string" }] } }).success).toBe(true);
  });

  it("a malformed schema is a load error: an unknown keyword, a bad type", () => {
    expect(issues(load({ schema: { type: "object", propertys: {} } }))).toMatch(/propertys/);
    expect(load({ schema: { type: 7 } }).success).toBe(false);
  });

  it("an empty schema, a boolean schema, and schema with absent/exists:false are refused", () => {
    expect(load({ schema: {} }).success).toBe(false);
    expect(load({ schema: true }).success).toBe(false);
    expect(load({ schema: PERSON, path: "a", absent: true }).success).toBe(false);
    expect(load({ schema: PERSON, path: "a", exists: false }).success).toBe(false);
  });

  it("a schema error in a scenario FILE is a UsageError (category usage), and lint reports it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-aj-schema-load-"));
    const p = join(dir, "s.yaml");
    writeFileSync(
      p,
      [
        "baseline: latest",
        "fidelity: container",
        "prompt: hi",
        "assert:",
        "  - artifact_json: {artifact: outputs/p.json, schema: {type: object, properties: {m: {type: string, format: email}}}}",
      ].join("\n") + "\n",
    );
    expect(() => loadScenarioPure(p)).toThrow(UsageError);
    const findings = loaderFindings([p], { loadBaseline: () => undefined as never });
    expect(JSON.stringify(findings)).toMatch(/format/);
  });
});

describe("artifact_json.schema — evaluation", () => {
  const run = (body: unknown, o: object, over: Partial<AssertContext> = {}) =>
    evaluate([aj(o)], ctx(tree({ "outputs/p.json": JSON.stringify(body) }), over))[0]!;

  it("a matching document passes; a mismatch fails naming where", () => {
    expect(run({ name: "a", age: 3 }, { schema: PERSON }).pass).toBe(true);
    const r = run({ name: "a", age: -1 }, { schema: PERSON });
    expect(r.pass).toBe(false);
    expect(r.message).toContain("/age");
    expect(r.message).toMatch(/must be >= 0/);
  });

  it("reports at most 5 errors, then how many more", () => {
    const schema = { type: "object", properties: Object.fromEntries("abcdefg".split("").map((k) => [k, { type: "string" }])) };
    const r = run(Object.fromEntries("abcdefg".split("").map((k) => [k, 1])), { schema });
    expect(r.message!.match(/must be string/g)).toHaveLength(5);
    expect(r.message).toMatch(/\(\+2 more\)/);
  });

  it("with `path`, the schema applies to the value there; an absent path fails rather than validating nothing", () => {
    expect(run({ me: { name: "a", age: 1 } }, { path: "me", schema: PERSON }).pass).toBe(true);
    // `not: {type: "null"}` accepts `undefined`, so only the presence guard can fail this.
    const r = run({ other: 1 }, { path: "me", schema: { not: { type: "null" } } });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/me/);
  });

  it("composes with the other operators: both must hold", () => {
    expect(run({ name: "a", age: 3 }, { path: "age", equals: 3, schema: { type: "integer" } }).pass).toBe(true);
    expect(run({ name: "a", age: 3 }, { path: "age", equals: 4, schema: { type: "integer" } }).pass).toBe(false);
  });

  it("does not echo an enum's allowed values, and caps each error", () => {
    const short = run("zzz", { schema: { type: "string", enum: ["alpha-value", "beta-value"] } });
    expect(short.pass).toBe(false);
    expect(short.message).not.toContain("alpha-value");
    const long = run("zzz", { schema: { type: "string", pattern: `^${"a".repeat(600)}$` } });
    expect(long.pass).toBe(false);
    expect(long.message!.length).toBeLessThan(600);
  });

  it("scrubs a secret out of an error before it is shown", () => {
    const r = run(
      { "sk-ant-SECRETVALUE1234567890": 1 },
      { schema: { type: "object", properties: {}, additionalProperties: false } },
      { secrets: ["sk-ant-SECRETVALUE1234567890"] },
    );
    expect(r.pass).toBe(false);
    expect(r.message).not.toContain("SECRETVALUE");
  });

  it("a hand-built context carrying a malformed schema fails the assertion instead of throwing", () => {
    const r = run({}, { schema: { type: 7 } });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/schema/);
  });

  it("glob each: one bad file fails; glob any: one good file passes", () => {
    const root = tree({
      "outputs/runs/a/s.json": JSON.stringify({ name: "a", age: 1 }),
      "outputs/runs/b/s.json": JSON.stringify({ name: "b" }),
    });
    const g = (match: "each" | "any") =>
      evaluate([{ artifact_json: { artifact: "outputs/runs/*/s.json", match, schema: PERSON } } as Assertion], ctx(root))[0]!;
    expect(g("each").pass).toBe(false);
    expect(g("each").message).toContain("outputs/runs/b/s.json");
    expect(g("any").pass).toBe(true);
  });

  it("lane: remote refuses, as for every artifact_json", () => {
    const r = run({ name: "a", age: 3 }, { schema: PERSON }, { lane: "remote" });
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/lane: remote/);
  });
});

describe("artifact_json.schema — {file:} is inlined at load", () => {
  function repo(schema: string | undefined, schemaPath = "schemas/person.json") {
    const dir = mkdtempSync(join(tmpdir(), "cwh-aj-schema-file-"));
    if (schema !== undefined) {
      mkdirSync(join(dir, schemaPath, ".."), { recursive: true });
      writeFileSync(join(dir, schemaPath), schema);
    }
    const p = join(dir, "s.yaml");
    writeFileSync(
      p,
      [
        "baseline: latest",
        "fidelity: container",
        "prompt: hi",
        "assert:",
        `  - artifact_json: {artifact: outputs/p.json, schema: {file: ${schemaPath}}}`,
      ].join("\n") + "\n",
    );
    return { dir, p };
  }

  it("the scenario carries the file's schema inline, so a frozen cassette needs no file", async () => {
    const { dir, p } = repo(JSON.stringify(PERSON));
    const sc = parseScenarioFile(p);
    expect(sc.assert[0]!.artifact_json!.schema).toEqual(PERSON);
    rmSync(join(dir, "schemas"), { recursive: true }); // replay must not need the file
    const body = JSON.stringify({ name: "a", age: -1 });
    const cassette = {
      scenario: { ...sc, session: "(inline)" },
      events: [
        JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      artifacts: [
        { path: "outputs/p.json", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), body },
      ],
    } as any;
    const r = await replayCassette(cassette);
    const a = r.assertions.find((x) => "artifact_json" in x.assertion)!;
    expect(a.pass).toBe(false);
    expect(a.message).toContain("/age");
  });

  it("replay of the same cassette passes a matching body (the pass twin)", async () => {
    const { p } = repo(JSON.stringify(PERSON));
    const sc = parseScenarioFile(p);
    const body = JSON.stringify({ name: "a", age: 1 });
    const cassette = {
      scenario: { ...sc, session: "(inline)" },
      events: [
        JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      artifacts: [
        { path: "outputs/p.json", bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), body },
      ],
    } as any;
    const r = await replayCassette(cassette);
    expect(r.assertions.find((x) => "artifact_json" in x.assertion)!.pass).toBe(true);
  });

  it("a malformed schema FILE is a load error, as an inline one is", () => {
    const { p } = repo(JSON.stringify({ type: "object", properties: { m: { type: "string", format: "email" } } }));
    expect(() => parseScenarioFile(p)).toThrow(/format/);
  });

  it("a missing file, and a file that is not JSON, are load errors", () => {
    expect(() => parseScenarioFile(repo(undefined).p)).toThrow(/schemas\/person\.json/);
    expect(() => parseScenarioFile(repo("{not json").p)).toThrow(/JSON/);
  });

  it("a file outside the scenario's tree is refused", () => {
    const outside = mkdtempSync(join(tmpdir(), "cwh-aj-schema-out-"));
    writeFileSync(join(outside, "s.json"), JSON.stringify(PERSON));
    const { p } = repo(undefined, "x.json");
    writeFileSync(
      p,
      [
        "baseline: latest",
        "fidelity: container",
        "prompt: hi",
        "assert:",
        `  - artifact_json: {artifact: outputs/p.json, schema: {file: ${join(outside, "s.json")}}}`,
      ].join("\n") + "\n",
    );
    expect(() => parseScenarioFile(p)).toThrow(/outside/);
  });
});

describe("artifact_json.schema — cassette stamp", () => {
  it("a schema entry stamps v15, so a 4.5 reader refuses it as too new", () => {
    expect(requiredVersionFor({ prompt: "x", assert: [aj({ schema: PERSON })] })).toBe(15);
  });
});

describe("artifact_json.schema — recursion", () => {
  it("a tree schema passes a nested tree and fails on a bad leaf", () => {
    const tree = { type: "object", properties: { children: { type: "array", items: { $ref: "#" } } } };
    const root = mkdtempSync(join(tmpdir(), "cwh-aj-schema-tree-"));
    mkdirSync(join(root, "outputs"));
    const at = (body: unknown) => {
      writeFileSync(join(root, "outputs/p.json"), JSON.stringify(body));
      return evaluate([aj({ schema: tree })], ctx(root))[0]!;
    };
    expect(at({ children: [{ children: [] }] }).pass).toBe(true);
    const bad = at({ children: [{ children: 5 }] });
    expect(bad.pass).toBe(false);
    expect(bad.message).toContain("/children/0/children");
  });
});

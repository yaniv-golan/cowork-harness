import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSchemas, buildAssertionKeys, SCHEMA_DIR, ASSERTION_KEYS_PATH } from "../scripts/gen-schema.js";
import { AnswerRule, Assertion, Scenario, ScenarioObject, VERDICT_MODIFIER_KEYS, FIDELITY_TIERS } from "../src/types.js";
import { SERVED_HOOK_EVENTS, KNOWN_HOOK_EVENTS, LIVE_VERIFIED_PLUGIN_HOOK_EVENTS } from "../src/agent/session.js";

const SCENARIO_PY = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const PY = process.env.PYTHON ?? "python3";
const HAVE_PY = spawnSync(PY, ["--version"], { stdio: "ignore" }).status === 0;
/** Import scenario.py by path and print one of its module-level key sets as sorted JSON (stdout). */
function pyKeySet(name: string): string[] {
  const code = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('scn',${JSON.stringify(SCENARIO_PY)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(sorted(getattr(m,${JSON.stringify(name)}))))`;
  const r = spawnSync(PY, ["-c", code], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python extract of ${name} failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

/** Same idea as pyKeySet, but for a module-level DICT constant (e.g. `_EMBEDDED_ENUMS`) — pyKeySet's
 *  `sorted(getattr(...))` iterates a dict's KEYS only, silently dropping every value, so a dict needs its
 *  own reader rather than being forced through the set-shaped one. */
function pyDict(name: string): Record<string, unknown> {
  const code = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('scn',${JSON.stringify(SCENARIO_PY)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(getattr(m,${JSON.stringify(name)})))`;
  const r = spawnSync(PY, ["-c", code], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python extract of ${name} failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

describe("AnswerRule rejects inert rules, accepts valid shapes", () => {
  it("rejects a matcher-less or action-less rule", () => {
    expect(AnswerRule.safeParse({}).success).toBe(false);
    expect(AnswerRule.safeParse({ grant: "once" }).success).toBe(false); // no matcher
    expect(AnswerRule.safeParse({ when_question: "fmt" }).success).toBe(false); // matcher, no action
    expect(AnswerRule.safeParse({ when_tool: "Bash" }).success).toBe(false); // matcher, no action
    expect(AnswerRule.safeParse({ when_tool: "Bash", else: "deny" }).success).toBe(false); // `else` alone is inert
  });
  it("accepts a valid question rule and a valid tool rule", () => {
    expect(AnswerRule.safeParse({ when_question: "fmt", choose: "PDF" }).success).toBe(true);
    expect(AnswerRule.safeParse({ when_question: "name", answer: "Acme" }).success).toBe(true);
    expect(AnswerRule.safeParse({ when_tool: "Write", decide: "allow" }).success).toBe(true);
    expect(AnswerRule.safeParse({ when_tool: "Bash", allow_if: "true", else: "deny" }).success).toBe(true);
  });

  // `choose` and `answer` are mutually exclusive at schema time (not only on a matching rule).
  it("rejects a rule that sets both `choose` and `answer`", () => {
    const r = AnswerRule.safeParse({ when_question: "name", choose: "PDF", answer: "Acme" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /both `choose` and `answer`/.test(i.message))).toBe(true);
    // each alone is still valid (regression guard)
    expect(AnswerRule.safeParse({ when_question: "name", choose: "PDF" }).success).toBe(true);
    expect(AnswerRule.safeParse({ when_question: "name", answer: "Acme" }).success).toBe(true);
  });

  // `grant` is only valid on an ALLOW outcome of a `webfetch:` tool rule. Inert placements reject.
  it("rejects inert `grant` placements (question / non-webfetch / deny)", () => {
    expect(AnswerRule.safeParse({ when_question: "fmt", choose: "PDF", grant: "domain" }).success).toBe(false); // question rule
    expect(AnswerRule.safeParse({ when_tool: "Bash", decide: "allow", grant: "domain" }).success).toBe(false); // non-webfetch tool
    expect(AnswerRule.safeParse({ when_tool: "webfetch:x.com", decide: "deny", grant: "domain" }).success).toBe(false); // deny outcome
  });

  it("accepts `grant` on an allow / allow_if web_fetch rule", () => {
    expect(AnswerRule.safeParse({ when_tool: "webfetch:x.com", decide: "allow", grant: "domain" }).success).toBe(true);
    expect(AnswerRule.safeParse({ when_tool: "webfetch:x.com", decide: "allow", grant: "once" }).success).toBe(true);
    expect(AnswerRule.safeParse({ when_tool: "webfetch:x.com", allow_if: "true", grant: "domain" }).success).toBe(true);
  });
});

describe("hook_event_fired / hook_event_blocked take a hook event the agent recognises", () => {
  it("rejects an unknown hook name at LOAD time", () => {
    expect(Assertion.safeParse({ hook_event_fired: "Stopp" }).success).toBe(false);
    expect(Assertion.safeParse({ hook_event_blocked: "stop" }).success).toBe(false);
  });
  it("accepts every KNOWN_HOOK_EVENTS member", () => {
    for (const e of KNOWN_HOOK_EVENTS) {
      expect(Assertion.safeParse({ hook_event_fired: e }).success).toBe(true);
      expect(Assertion.safeParse({ hook_event_blocked: e }).success).toBe(true);
    }
  });
});

describe("count assertions require nonnegative integers", () => {
  it("rejects negative and fractional counts", () => {
    expect(Assertion.safeParse({ dispatch_count_max: -1 }).success).toBe(false);
    expect(Assertion.safeParse({ dispatch_count_max: 1.5 }).success).toBe(false);
    expect(Assertion.safeParse({ questions_count_max: -2 }).success).toBe(false);
    expect(Assertion.safeParse({ questions_count_max: 0.5 }).success).toBe(false);
  });
  it("accepts 0 and positive integers", () => {
    expect(Assertion.safeParse({ dispatch_count_max: 0 }).success).toBe(true);
    expect(Assertion.safeParse({ questions_count_max: 3 }).success).toBe(true);
  });
});

describe("no_delete_in_outputs accepts only `true` (the `false` footgun is rejected)", () => {
  it("accepts `true` and absence", () => {
    expect(Assertion.safeParse({ no_delete_in_outputs: true }).success).toBe(true);
    expect(Assertion.safeParse({}).success).toBe(true);
  });
  it("rejects `false` (would be a silent no-effect — omit the assertion to allow deletes)", () => {
    expect(Assertion.safeParse({ no_delete_in_outputs: false }).success).toBe(false);
  });
});

// Guard: the committed schema/*.schema.json must match what the zod schemas produce.
// If this fails, a zod schema changed without regenerating — run `npm run schema`.
describe("JSON schema is in sync with the zod source", () => {
  const generated = buildSchemas();
  for (const [file, body] of Object.entries(generated)) {
    it(`schema/${file} is up to date (run \`npm run schema\` if this fails)`, () => {
      const committed = readFileSync(join(SCHEMA_DIR, file), "utf8");
      expect(committed).toBe(body);
    });
  }
});

// Guard: the linter's assertion-key list (read by scenario.py) must match the zod Assertion schema, so
// `cowork-harness lint` can't drift and flag a real key as unknown. Run `npm run schema` if this fails.
describe("scenario.py assertion-keys.json is in sync with the zod Assertion schema", () => {
  it("the committed assertion-keys.json matches buildAssertionKeys()", () => {
    expect(readFileSync(ASSERTION_KEYS_PATH, "utf8")).toBe(buildAssertionKeys());
  });
  it("the generated key set equals Object.keys(Assertion.shape) (no silent filtering)", () => {
    const keys = JSON.parse(buildAssertionKeys()).keys as string[];
    expect([...keys].sort()).toEqual([...Object.keys(Assertion.shape)].sort());
  });
  // Guard: the linter's TOP-LEVEL key list must match the zod ScenarioObject schema — the bug that
  // false-flagged a valid `requires_capabilities` as unknown was a hand-maintained list drifting from the
  // schema. Generate from `ScenarioObject.shape` (the strictObject, NOT the `Scenario` preprocess wrapper).
  it("topLevelKeys equals Object.keys(ScenarioObject.shape) (no silent filtering)", () => {
    const keys = JSON.parse(buildAssertionKeys()).topLevelKeys as string[];
    expect([...keys].sort()).toEqual([...Object.keys(ScenarioObject.shape)].sort());
  });
  it("requires_capabilities is in topLevelKeys (regression: the drift that false-flagged it)", () => {
    const keys = JSON.parse(buildAssertionKeys()).topLevelKeys as string[];
    expect(keys).toContain("requires_capabilities");
  });
  // allow_host_writes is a top-level scenario field (a pre-run consent gate, not a post-run verdict
  // modifier) — ScenarioObject is a strictObject, so it must round-trip through parse() and appear in
  // the generated topLevelKeys cascade like any other field, while staying OUT of VERDICT_MODIFIER_KEYS.
  it("allow_host_writes round-trips through ScenarioObject.parse() and is in topLevelKeys, not VERDICT_MODIFIER_KEYS", () => {
    const parsed = ScenarioObject.parse({ prompt: "x", fidelity: "container", allow_host_writes: true });
    expect(parsed.allow_host_writes).toBe(true);
    const keys = JSON.parse(buildAssertionKeys()).topLevelKeys as string[];
    expect(keys).toContain("allow_host_writes");
    expect([...VERDICT_MODIFIER_KEYS]).not.toContain("allow_host_writes");
  });
  it("verdictModifierKeys matches VERDICT_MODIFIER_KEYS", () => {
    const gen = JSON.parse(buildAssertionKeys()).verdictModifierKeys as string[];
    expect([...gen].sort()).toEqual([...VERDICT_MODIFIER_KEYS].sort());
  });
  // The single-source guard: VERDICT_MODIFIER_KEYS must equal EXACTLY the `allow_`-prefixed Assertion keys.
  // Catches both directions — a new `allow_*` schema field not added to the list, and a list entry with no
  // field. (Every verdict modifier is `allow_<thing>`; if a future modifier breaks that convention, update
  // this test deliberately.) This is what prevents the "added a modifier but forgot a touch-point" class.
  it("VERDICT_MODIFIER_KEYS equals the allow_-prefixed Assertion keys (single-source convention)", () => {
    const allowKeys = Object.keys(Assertion.shape).filter((k) => k.startsWith("allow_"));
    expect([...VERDICT_MODIFIER_KEYS].sort()).toEqual(allowKeys.sort());
  });
  // scenario.py keeps EMBEDDED fallbacks (used only when assertion-keys.json is missing). They must equal the
  // generated lists, else a missing-file run reintroduces the very drift these fixes target. The runtime file
  // is generated (can't drift); these guard the in-code fallbacks. Skipped if python3 is unavailable.
  it.skipIf(!HAVE_PY)("scenario.py _EMBEDDED_TOP_LEVEL_KEYS equals the generated topLevelKeys", () => {
    const gen = (JSON.parse(buildAssertionKeys()).topLevelKeys as string[]).slice().sort();
    expect(pyKeySet("_EMBEDDED_TOP_LEVEL_KEYS")).toEqual(gen);
  });
  it.skipIf(!HAVE_PY)("scenario.py _CLASSIFIED_KEYS equals the generated assert keys", () => {
    const gen = (JSON.parse(buildAssertionKeys()).keys as string[]).slice().sort();
    expect(pyKeySet("_CLASSIFIED_KEYS")).toEqual(gen);
  });

  // Hook events, same single-source discipline as the key lists above. The served set is the one that
  // MUST NOT drift silently: it decides which declared hook the linter warns about, so a stale copy would
  // keep warning about an event the harness had since started serving (or, worse, stop warning about one
  // it dropped). Both directions are covered — generated-vs-source and python-fallback-vs-generated.
  it("servedHookEvents matches SERVED_HOOK_EVENTS and is a subset of KNOWN_HOOK_EVENTS", () => {
    const gen = JSON.parse(buildAssertionKeys()).servedHookEvents as string[];
    expect([...gen].sort()).toEqual([...SERVED_HOOK_EVENTS].sort());
    expect(KNOWN_HOOK_EVENTS).toEqual(expect.arrayContaining(gen));
  });
  it("knownHookEvents matches KNOWN_HOOK_EVENTS", () => {
    const gen = JSON.parse(buildAssertionKeys()).knownHookEvents as string[];
    expect([...gen].sort()).toEqual([...KNOWN_HOOK_EVENTS].sort());
  });
  it.skipIf(!HAVE_PY)("scenario.py _FALLBACK_SERVED_HOOK_EVENTS equals the generated servedHookEvents", () => {
    const gen = (JSON.parse(buildAssertionKeys()).servedHookEvents as string[]).slice().sort();
    expect(pyKeySet("_FALLBACK_SERVED_HOOK_EVENTS")).toEqual(gen);
  });
  it.skipIf(!HAVE_PY)("scenario.py _FALLBACK_KNOWN_HOOK_EVENTS equals the generated knownHookEvents", () => {
    const gen = (JSON.parse(buildAssertionKeys()).knownHookEvents as string[]).slice().sort();
    expect(pyKeySet("_FALLBACK_KNOWN_HOOK_EVENTS")).toEqual(gen);
  });
  it("liveVerifiedHookEvents matches LIVE_VERIFIED_PLUGIN_HOOK_EVENTS and is a subset of KNOWN_HOOK_EVENTS", () => {
    const gen = JSON.parse(buildAssertionKeys()).liveVerifiedHookEvents as string[];
    expect([...gen].sort()).toEqual([...LIVE_VERIFIED_PLUGIN_HOOK_EVENTS].sort());
    expect(KNOWN_HOOK_EVENTS).toEqual(expect.arrayContaining(gen));
  });
  it.skipIf(!HAVE_PY)("scenario.py _FALLBACK_LIVE_VERIFIED_HOOK_EVENTS equals the generated liveVerifiedHookEvents", () => {
    const gen = (JSON.parse(buildAssertionKeys()).liveVerifiedHookEvents as string[]).slice().sort();
    expect(pyKeySet("_FALLBACK_LIVE_VERIFIED_HOOK_EVENTS")).toEqual(gen);
  });

  // The enum-value map backs scenario.py's `enum-value-invalid` rule — a hand-picked list of four
  // top-level fields (fidelity/execution/lane/on_unanswered) was the bug being fixed here, so pin
  // coverage of the nested answers[]/assert[] enums too, not just the top-level ones.
  it("enums covers every enum-valued scenario field, top-level and nested", () => {
    const enums = JSON.parse(buildAssertionKeys()).enums as Record<string, string[]>;
    expect(Object.keys(enums).sort()).toEqual(
      [
        "fidelity",
        "execution",
        "lane",
        "on_unanswered",
        "metrics.better",
        "answers.decide",
        "answers.else",
        "answers.grant",
        "assert.result",
        "assert.path_denied.source",
        "assert.path_denied.agent_scope",
        "assert.question_options.order",
        "assert.hook_event_fired",
        "assert.hook_event_blocked",
        "assert.hook_output_contains.event",
        "assert.hook_output_contains.stream",
        "assert.hook_output_not_contains.event",
        "assert.hook_output_not_contains.stream",
        // reached through a union arm (the object form of tool_called / tool_not_called)
        "assert.tool_called.scope",
        "assert.tool_not_called.scope",
        "assert.semantic_pairwise.pass_if",
        "assert.semantic_pairwise.order",
      ].sort(),
    );
    expect(enums.fidelity).toEqual([...FIDELITY_TIERS]);
    // `cloud-describe` IS a valid schema value for `execution` — the runtime-reserved carve-out lives in
    // scenario.py's fix-text composition (_enum_fix_values), not in this map, which stays a faithful
    // mirror of what the schema accepts.
    expect(enums.execution).toEqual(["local", "cloud-describe"]);
  });
  it.skipIf(!HAVE_PY)("scenario.py _EMBEDDED_ENUMS equals the generated enums", () => {
    const gen = JSON.parse(buildAssertionKeys()).enums as Record<string, string[]>;
    expect(pyDict("_EMBEDDED_ENUMS")).toEqual(gen);
  });
});

// execution is an execution-LOCATION axis, orthogonal to fidelity (a local privilege tier) — see the
// adjacent field comment in src/types.ts. `cloud-describe` is reserved (no runner exists yet) and is
// rejected at load time (see execute.test.ts); only `local` is a live, runnable value today.
describe("execution field (location axis, orthogonal to fidelity)", () => {
  it("defaults to `local` when omitted", () => {
    expect(ScenarioObject.parse({ prompt: "x", fidelity: "container" }).execution).toBe("local");
  });
  it("accepts an explicit `local` value", () => {
    expect(ScenarioObject.parse({ prompt: "x", fidelity: "container", execution: "local" }).execution).toBe("local");
  });
  it("round-trips `cloud-describe` through the schema itself (the load-time reject lives in execute.ts, not here)", () => {
    expect(ScenarioObject.parse({ prompt: "x", fidelity: "container", execution: "cloud-describe" }).execution).toBe("cloud-describe");
  });
  it("rejects an unknown execution value", () => {
    expect(ScenarioObject.safeParse({ prompt: "x", fidelity: "container", execution: "bogus" }).success).toBe(false);
  });
  it("is in topLevelKeys and is not a VERDICT_MODIFIER_KEYS entry", () => {
    const keys = JSON.parse(buildAssertionKeys()).topLevelKeys as string[];
    expect(keys).toContain("execution");
    expect([...VERDICT_MODIFIER_KEYS]).not.toContain("execution");
  });
});

// A zod `.superRefine` has no JSON Schema representation, so `z.toJSONSchema` drops it silently. The
// loader would then reject a scenario the PUBLISHED schema accepts — an editor or a schema-validating CI
// step would green a file that cannot run. gen-schema mirrors the rule by hand; this validates the emitted
// schema with a real validator so a forgotten mirror fails loudly instead of drifting.
describe("published scenario schema enforces cross-key rules the loader enforces", () => {
  const compiled = (): ((d: unknown) => boolean) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Ajv = require("ajv");
    const schema = JSON.parse(buildSchemas()["scenario.schema.json"]);
    // strict mode on purpose — the same bar test/schema-ajv.test.ts holds the whole schema to.
    return new Ajv({ strict: true }).compile(schema) as (d: unknown) => boolean;
  };

  it("accepts either outputs-delete key alone", () => {
    const v = compiled();
    expect(v({ prompt: "x", fidelity: "container", assert: [{ no_delete_in_outputs: true }] })).toBe(true);
    expect(v({ prompt: "x", fidelity: "container", assert: [{ allow_outputs_delete: true }] })).toBe(true);
  });

  it("rejects the mutually exclusive pair, in one entry OR across entries", () => {
    const v = compiled();
    expect(v({ prompt: "x", fidelity: "container", assert: [{ no_delete_in_outputs: true, allow_outputs_delete: true }] })).toBe(false);
    expect(v({ prompt: "x", fidelity: "container", assert: [{ no_delete_in_outputs: true }, { allow_outputs_delete: true }] })).toBe(false);
  });
});

describe("cross-key rule: allow_delete_in must not waive outputs alongside no_delete_in_outputs", () => {
  it("the loader rejects the contradiction", () => {
    const bad = { prompt: "p", fidelity: "container", assert: [{ no_delete_in_outputs: true }, { allow_delete_in: ["outputs"] }] };
    expect(Scenario.safeParse(bad).success).toBe(false);
  });
  it("waiving a DIFFERENT mount alongside no_delete_in_outputs is fine — not a contradiction", () => {
    const ok = { prompt: "p", fidelity: "container", assert: [{ no_delete_in_outputs: true }, { allow_delete_in: ["reports"] }] };
    expect(Scenario.safeParse(ok).success).toBe(true);
  });
  it("no_delete_in_mounts + allow_delete_in COMPOSE — 'none except these' is coherent", () => {
    const ok = { prompt: "p", fidelity: "container", assert: [{ no_delete_in_mounts: true }, { allow_delete_in: ["reports"] }] };
    expect(Scenario.safeParse(ok).success).toBe(true);
  });
  it("the published JSON Schema mirrors the refinement (editors/CI must agree with the loader)", () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schema/scenario.schema.json"), "utf8"));
    expect(JSON.stringify(schema.not)).toMatch(/allow_delete_in/);
  });
});

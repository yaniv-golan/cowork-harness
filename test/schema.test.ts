import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSchemas, SCHEMA_DIR } from "../scripts/gen-schema.js";
import { AnswerRule, Assertion } from "../src/types.js";

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

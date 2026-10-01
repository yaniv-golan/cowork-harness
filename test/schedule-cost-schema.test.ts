// The covered cost summary `eval --dry-run` emits as `plan.cost`, pinned against its published schema: every covered key is required and typed, the schema names exactly those keys,
// and the experimental keys beside them are allowed (the schema is permissive, like every covered envelope).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import { estimateScheduleCost, scheduleCostJson, type CostHistory } from "../src/eval/planner.js";

const schema = JSON.parse(readFileSync(resolve("schema/schedule-cost.json"), "utf8")) as {
  required: string[];
  properties: Record<string, unknown>;
  additionalProperties?: boolean;
};
const ajv = new Ajv({ strict: true });
const validate = ajv.compile(schema);

const COVERED = ["jobs", "meanUsd", "p50Usd", "p95Usd", "worstObservedUsd", "lowerBound", "unpriced", "pricedRuns", "thinnest"];

const history = (scenario: string, agent: number[]): CostHistory => ({
  scenario,
  samples: agent.map((agentUsd) => ({ agentUsd })),
  ...(agent.length ? { budgetGateWorstUsd: Math.max(...agent) } : {}),
  budgetGatePricedRuns: agent.length,
  distinctSkillHashes: 1,
  distinctTiers: 1,
});

describe("schema/schedule-cost.json", () => {
  it("names exactly the covered keys, every one required, and stays open to experimental keys", () => {
    expect(Object.keys(schema.properties).sort()).toEqual([...COVERED].sort());
    expect([...schema.required].sort()).toEqual([...COVERED].sort());
    expect(schema.additionalProperties).not.toBe(false);
  });

  it("accepts what scheduleCostJson emits — priced, partly unpriced, and nothing priced (thinnest null)", () => {
    for (const items of [
      [{ scenario: "a", jobs: 10, history: history("a", [1, 2, 3]) }],
      [
        { scenario: "a", jobs: 10, history: history("a", [1]) },
        { scenario: "none", jobs: 10, history: history("none", []) },
      ],
      [{ scenario: "none", jobs: 10, history: history("none", []) }],
    ]) {
      const j = scheduleCostJson(estimateScheduleCost(items));
      expect(validate(j), ajv.errorsText(validate.errors)).toBe(true);
    }
  });

  it("rejects an object missing a covered key", () => {
    const j = scheduleCostJson(estimateScheduleCost([{ scenario: "a", jobs: 2, history: history("a", [1]) }])) as unknown as Record<
      string,
      unknown
    >;
    for (const k of COVERED) {
      const copy = { ...j };
      delete copy[k];
      expect(validate(copy), k).toBe(false);
    }
  });
});

describe("where the covered summary is promised", () => {
  const read = (p: string) => readFileSync(resolve(p), "utf8");
  it("only on `eval --dry-run`, at `plan.cost`, validated by this schema — no other command is promised", () => {
    const desc = (schema as unknown as { description: string }).description;
    expect(desc).not.toMatch(/hillclimb run --dry-run/);
    expect(desc).toMatch(/`plan\.cost`/);
    for (const f of ["SPEC.md", "CHANGELOG.md", "src/eval/plan.ts", "src/eval/planner.ts", "test/schedule-cost-schema.test.ts"])
      expect(read(f).replace(/expect\([^\n]*hillclimb run --dry-run[^\n]*\n/g, ""), f).not.toMatch(/hillclimb run --dry-run/);
    expect(read("SPEC.md").replace(/\s+/g, " ")).toMatch(
      /`plan\.cost` in the `eval --dry-run` JSON envelope, validated by `schema\/schedule-cost\.json`/,
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";

// Arm-able statSync failure: node:fs is real except statSync throws while `armed.value` is true.
// A permission (EACCES) fixture won't fire under a root CI, so simulate the throw via the module mock.
const armed = vi.hoisted(() => ({ value: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    statSync: (...args: Parameters<typeof real.statSync>) => {
      if (armed.value) throw new Error("EACCES: simulated stat failure");
      return real.statSync(...args);
    },
  };
});

function ctx(workRoot: string, over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}

beforeEach(() => (armed.value = false));

// #7: statSync must be guarded alongside readFileSync. evaluate()/check() are synchronous with no error
// boundary, so a statSync throw (TOCTOU/EACCES on a file that existed at existsSync) must fail the
// assertion, not crash verification.
describe("artifact_json — statSync throwing must fail the assertion, not crash evaluate()", () => {
  it("returns a controlled failure carrying the OS error, and never throws", () => {
    const workRoot = mkdtempSync(join(tmpdir(), "cwh-aj-stat-"));
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    // A REAL, valid JSON file: if statSync did NOT throw, this assertion would PASS and the test would
    // fail loudly — so a non-firing mock can't masquerade as a green.
    writeFileSync(join(workRoot, "outputs", "data.json"), JSON.stringify({ a: 1 }));

    armed.value = true; // statSync now throws inside evaluate()
    let result!: ReturnType<typeof evaluate>;
    expect(() => {
      result = evaluate([{ artifact_json: { artifact: "outputs/data.json", path: "a", equals: 1 } }], ctx(workRoot));
    }).not.toThrow();

    const [r] = result;
    expect(r.pass).toBe(false);
    expect(r.message ?? "").toMatch(/could not be read\/parsed|EACCES/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeSurface } from "../scripts/lib/surface.js";

// Snapshot-sync guard over the harness's structured, machine-checkable public surfaces: schema/*.json
// field paths + enums (including exit-code enums), action.yml's inputs + outputs, and the documented
// COWORK_* env-var set. See scripts/lib/surface.ts for exactly what's covered and what's deliberately
// left to a manual release checklist instead (the CLI command/flag surface, exit-code semantics, and
// the Zod-only PlatformBaseline shape).
//
// Pre-1.0 behavior: ANY drift — addition, removal, or change — fails this test, forcing a conscious
// `npm run gen:surface` regen + diff review before it ships. That's deliberately stricter than the
// eventual policy (a pure addition is fine at 1.0), because pre-1.0 the goal is just to make every
// structural surface change visible, not yet to enforce semver.
//
// 1.0 upgrade: switch this test to call `checkSurface()` (scripts/check-surface.ts) and hard-fail
// only on its `removed`/`changed` buckets — a pure `added` result should pass without touching the
// baseline at that point, since additions aren't a compatibility break.
describe("surface-contract snapshot", () => {
  it("computeSurface() matches the committed test/fixtures/surface-baseline.json", () => {
    const baseline = JSON.parse(readFileSync(resolve("test/fixtures/surface-baseline.json"), "utf8"));
    // Round-trip through JSON so the comparison sees exactly what gen-surface.ts would have written
    // (e.g. `undefined` fields dropped), not an object with keys the serialized baseline never had.
    const current = JSON.parse(JSON.stringify(computeSurface()));
    expect(
      current,
      "the structured surface (schema/*.json, action.yml IO, or documented COWORK_* env vars) drifted " +
        "from test/fixtures/surface-baseline.json. Run `npm run gen:surface` to regenerate, then review " +
        "the diff — especially any removal or type/enum change. Pre-1.0 that's still allowed to ship, but " +
        "it must be a conscious decision (commit the regenerated baseline alongside the surface change); " +
        "at 1.0, a removed/changed entry there requires a major version bump.",
    ).toEqual(baseline);
  });
});

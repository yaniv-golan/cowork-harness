// The cassette side of `workspace_fixture` and `authored`: both are v14 features (an older reader would replay a
// fixture cassette without knowing its staleness check, or reject the object form with the wrong "re-record"
// remedy). Never a version bump — each adds its entry to the shared v14 lists.

import { describe, it, expect } from "vitest";
import { KEY_REQUIRED_VERSION, V14_ASSERT_FEATURES, requiredVersionFor } from "../src/run/cassette.js";
import { ScenarioObject } from "../src/types.js";

const parse = (o: Record<string, unknown>) => ScenarioObject.parse({ prompt: "x", fidelity: "container", ...o });

describe("v14 stamp: workspace_fixture (top-level key)", () => {
  it("stamps 14 iff the key is present", () => {
    expect(requiredVersionFor(parse({ workspace_fixture: "fixtures/step1" }))).toBe(14);
    expect(requiredVersionFor(parse({}))).toBeLessThan(14);
    expect(KEY_REQUIRED_VERSION.workspace_fixture!(undefined)).toBe(0);
    expect(KEY_REQUIRED_VERSION.workspace_fixture!("fixtures/step1")).toBe(14);
  });
  it("a loose on-disk scenario (as rehash reads it) is judged the same way", () => {
    expect(requiredVersionFor({ prompt: "x", workspace_fixture: "f" })).toBe(14);
  });
});

describe("v14 stamp: the `authored` modifier (assert-level)", () => {
  it("the object form of file_exists / user_visible_artifact stamps 14 — with or without `authored`", () => {
    expect(requiredVersionFor(parse({ assert: [{ file_exists: { path: "outputs/a" } }] }))).toBe(14);
    expect(requiredVersionFor(parse({ assert: [{ user_visible_artifact: { path: "outputs/a", authored: false } }] }))).toBe(14);
  });
  it("`authored` on artifact_text / artifact_json stamps 14, whatever its value", () => {
    expect(requiredVersionFor(parse({ assert: [{ artifact_text: { artifact: "outputs/a", contains: ["x"], authored: false } }] }))).toBe(
      14,
    );
    expect(requiredVersionFor(parse({ assert: [{ artifact_json: { artifact: "outputs/a.json", exists: true, authored: true } }] }))).toBe(
      14,
    );
  });
  it("the string forms and an artifact_* without `authored` keep the stamp where it was", () => {
    expect(
      requiredVersionFor(
        parse({
          assert: [
            { file_exists: "outputs/a" },
            { user_visible_artifact: "outputs/a" },
            { artifact_text: { artifact: "a", contains: ["x"] } },
          ],
        }),
      ),
    ).toBeLessThan(14);
  });
  it("is one appended predicate on the shared list", () => {
    expect(V14_ASSERT_FEATURES.some((f) => f({ file_exists: { path: "outputs/a" } }))).toBe(true);
    expect(V14_ASSERT_FEATURES.some((f) => f({ file_exists: "outputs/a" }))).toBe(false);
  });
});

// T-D4 — the record-time secret-scrub warning names an assertion that does NOT fail.
//
// When a whole-field encoded artifact body is replaced with a `[REDACTED:*]` marker, `record` warns:
//
//   "body replaced with redaction marker; artifact_json/user_visible_artifact assertions on this
//    artifact will fail at replay"
//
// `user_visible_artifact` does not read the body at all — it checks lane, link-kind, truncation, the
// user-visible prefix, and existence. The marker is written to disk with a recomputed sha256, so the file
// exists under a visible prefix and the assertion PASSES. `materializeManifest`'s own doc comment already
// says as much ("file_exists and user_visible_artifact PASS from the manifest; only artifact_json fails
// loud"), so the warning contradicts a comment in the same file.
//
// This matters beyond wording: a reader who trusts the warning concludes that a passing
// `user_visible_artifact` proves the scrubbed content survived. It proves only that a file is there.
//
// These tests assert the BEHAVIOUR the warning describes, not the warning's phrasing — a string test
// would go green against a reworded-but-still-wrong message.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";

const MARKER = "[REDACTED:base64]";

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    mountDeletes: [],
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
const pass = (r: ReturnType<typeof evaluate>) => r.every((x) => x.pass);

/** A work root holding one outputs artifact whose body is the redaction marker — what replay
 *  materializes after a whole-field scrub. */
function rootWithMarkerArtifact(): string {
  const root = mkdtempSync(join(tmpdir(), "d4-marker-"));
  mkdirSync(join(root, "outputs"), { recursive: true });
  writeFileSync(join(root, "outputs", "report.json"), MARKER);
  return root;
}

describe("T-D4 · what a [REDACTED:*] body actually does to each assertion", () => {
  it("user_visible_artifact PASSES — it never reads the body (the warning says it fails)", () => {
    const c = ctx({ workRoot: rootWithMarkerArtifact() });
    expect(
      pass(evaluate([{ user_visible_artifact: "outputs/report.json" }], c)),
      "user_visible_artifact failed on a marker body — if this is now correct, the T-D4 warning was right and this test should be retired",
    ).toBe(true);
  });

  it("file_exists PASSES for the same reason", () => {
    const c = ctx({ workRoot: rootWithMarkerArtifact() });
    expect(pass(evaluate([{ file_exists: "outputs/report.json" }], c))).toBe(true);
  });

  it("artifact_json FAILS — it parses the body, and the marker is not JSON", () => {
    const c = ctx({ workRoot: rootWithMarkerArtifact() });
    expect(
      pass(evaluate([{ artifact_json: { artifact: "outputs/report.json", path: "$.rows", equals: 5 } }], c)),
      "artifact_json passed over a redaction marker — that would be a false green on scrubbed content",
    ).toBe(false);
  });

  it("artifact_text FAILS — the marker is not the expected content", () => {
    const c = ctx({ workRoot: rootWithMarkerArtifact() });
    expect(pass(evaluate([{ artifact_text: { artifact: "outputs/report.json", contains: ["revenue"] } }], c))).toBe(false);
  });
});

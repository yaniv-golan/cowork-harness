import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { COMPOSER_ID, composeJudgedDocument, type AssertContext } from "../src/assert.js";

// A frozen semantic_pairwise reference is only compared with a run composed by the SAME composer (COMPOSER_ID is
// part of the compose key). This pins the composer's output for a fixed input: when it changes, the frozen
// references built by the old composer must stop matching new runs — bump COMPOSER_ID in src/assert.ts, then
// update the pinned values below in the same commit.
const PINNED = { composerId: "judged-doc-1", sha256: "5dc8a29de73681edd61969396a7ad2408f34c23d51d337d4f0ca81dc0fb32261" };

function ctx(): AssertContext {
  return {
    transcript: "I read the inputs.\nI wrote the report.",
    finalMessage: "The report is in outputs/report.md.",
    authoredFiles: [{ path: "outputs/report.md", content: "# Report\nThe main risk is concentration.\n", truncated: false }] as never,
    authoredFilesHealth: { omittedPaths: [], totalCapExhausted: false, readErrors: [] } as never,
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/x",
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
  };
}

describe("COMPOSER_ID tracks composeJudgedDocument's output", () => {
  it("the composer's output for a fixed input is unchanged — or COMPOSER_ID was bumped with it", () => {
    const doc = composeJudgedDocument(ctx(), false, undefined, false).doc;
    // The fixed input must exercise every section kind, or the pin guards less than it claims.
    expect(doc).toContain("The report is in outputs/report.md.");
    expect(doc).toContain("I wrote the report.");
    expect(doc).toContain("The main risk is concentration.");
    const sha = createHash("sha256").update(doc).digest("hex");
    expect({ composerId: COMPOSER_ID, sha256: sha }).toEqual(PINNED);
  });
});

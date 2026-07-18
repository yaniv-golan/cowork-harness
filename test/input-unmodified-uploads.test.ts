import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { buildManifest } from "../src/run/cassette.js";
import { evaluate, type AssertContext } from "../src/assert.js";

// Item 2: input_unmodified must be able to guard UPLOADED files (uploads/**), not just connected folders.
// Uploads enter the manifest as a read-only INPUT root — captured hash-only (body-less, reason "input") so a
// user's private upload is never inlined into a committed cassette, yet the sha256 lets input_unmodified
// compare pre/post, and a change is attributed to the AGENT (unlike a "readonly" connected folder).

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

describe("buildManifest captures uploads/** body-less with reason 'input'", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cwh-ium-up-"));
    mkdirSync(join(root, "uploads"), { recursive: true });
    mkdirSync(join(root, "outputs"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("records an uploaded file hash-only (real sha256, NO body — privacy) with truncationReason 'input'", () => {
    writeFileSync(join(root, "uploads", "safe.xlsx"), "PRIVATE CAP TABLE CONTENT");
    writeFileSync(join(root, "outputs", "report.md"), "the deliverable");
    const m = buildManifest(root, 1024 * 1024, ["outputs"]); // inputRoots defaults to ["uploads"]
    const up = m.find((e) => e.path === "uploads/safe.xlsx");
    expect(up, "the upload must be in the manifest").toBeDefined();
    expect(up!.truncated).toBe(true);
    expect(up!.truncationReason).toBe("input");
    expect(up!.sha256).toBe(sha("PRIVATE CAP TABLE CONTENT")); // real hash — enables input_unmodified
    expect(up!.body).toBeUndefined(); // the private content is NOT inlined into the cassette
    // the deliverable keeps its body (userVisible root, not body-less)
    const out = m.find((e) => e.path === "outputs/report.md");
    expect(out!.body).toBe("the deliverable");
  });

  it("no uploads dir → no input entries (the always-on walk is a harmless no-op)", () => {
    writeFileSync(join(root, "outputs", "x.md"), "x");
    const m = buildManifest(root, 1024 * 1024, ["outputs"]);
    expect(m.some((e) => e.path.startsWith("uploads/"))).toBe(false);
  });
});

// AssertContext helper (minimal — only the fields input_unmodified reads).
function ctx(over: Partial<AssertContext>): AssertContext {
  return {
    transcript: "",
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
    ...over,
  } as AssertContext;
}

describe("input_unmodified guards an upload on the replay lane (pre vs post hash, no false-fail)", () => {
  it("passes when the upload is unchanged; the readonly-external excuse does NOT apply (it's the agent's tree)", () => {
    const c = ctx({
      preRunHashes: { "uploads/safe.xlsx": sha("orig") },
      postRunHashes: { "uploads/safe.xlsx": sha("orig") }, // replay: authoritative post hash from the cassette
      readonlyFolderRoots: [], // uploads are NOT a readonly connected folder
    });
    expect(evaluate([{ input_unmodified: ["uploads/**"] }], c)[0].pass).toBe(true);
  });

  it("FAILS (attributed to the agent) when the upload's content changed — not excused as external", () => {
    const c = ctx({
      preRunHashes: { "uploads/safe.xlsx": sha("orig") },
      postRunHashes: { "uploads/safe.xlsx": sha("MUTATED") },
      readonlyFolderRoots: [],
    });
    const [r] = evaluate([{ input_unmodified: "uploads/**" }], c); // bare-string form too
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/modified in place/);
    expect(r.message).not.toMatch(/EXTERNAL/); // NOT the readonly-connected-folder external excuse
  });
});

// input_unmodified vacuous-pass and manifest-path-escape / unbounded-read guards.
describe("input_unmodified fails loud instead of vacuously passing", () => {
  it("a glob matching ZERO pre-run paths fails (was a silent vacuous pass)", () => {
    const c = ctx({
      preRunHashes: { "uploads/safe.xlsx": sha("orig") },
      postRunHashes: { "uploads/safe.xlsx": sha("orig") },
    });
    const [r] = evaluate([{ input_unmodified: "uploads/DOES-NOT-EXIST/**" }], c);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/matched no pre-run/);
  });

  it("a manifest key escaping workRoot fails evidence-unavailable (live lane, never reads outside)", () => {
    const wr = mkdtempSync(join(tmpdir(), "cwh-ium-esc-"));
    try {
      // A hostile/hand-edited manifest key. No postRunHashes ⇒ live lane ⇒ would readFileSync(join(wr, key)).
      const c = ctx({ workRoot: wr, preRunHashes: { "../escape.txt": sha("orig") } });
      const [r] = evaluate([{ input_unmodified: "**" }], c);
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/escape the workspace root/);
    } finally {
      rmSync(wr, { recursive: true, force: true });
    }
  });

  it("a matched file over the post-run hash cap fails evidence-unavailable (bounded read)", () => {
    const wr = mkdtempSync(join(tmpdir(), "cwh-ium-cap-"));
    const prev = process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
    try {
      writeFileSync(join(wr, "big.bin"), Buffer.alloc(4096));
      process.env.COWORK_HARNESS_PRERUN_HASH_CAP = "1024";
      const c = ctx({ workRoot: wr, preRunHashes: { "big.bin": sha("placeholder") } });
      const [r] = evaluate([{ input_unmodified: "big.bin" }], c);
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/over size cap/);
    } finally {
      if (prev === undefined) delete process.env.COWORK_HARNESS_PRERUN_HASH_CAP;
      else process.env.COWORK_HARNESS_PRERUN_HASH_CAP = prev;
      rmSync(wr, { recursive: true, force: true });
    }
  });
});

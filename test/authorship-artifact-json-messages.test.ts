// Byte-exact characterization of every branch of the `authored: true` decision and of the `artifact_json`
// evidence gates: the whole `pass` + `message`/`evidence` per constructed case. Both are shared with the
// metrics extractor, so a refactor that rewords or drops a message must fail here rather than pass a suite
// that pins only fragments. Paths under the temp root print as <root>. Synthetic data only.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import type { Assertion } from "../src/types.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let root: string;
let mnt: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "authchar-")));
  mnt = join(root, "mnt");
  mkdirSync(join(mnt, "outputs", "sub"), { recursive: true });
  writeFileSync(join(mnt, "outputs", "new.json"), '{"a":{"b":3},"n":null}');
  writeFileSync(join(mnt, "outputs", "same.json"), '{"a":1}');
  writeFileSync(join(mnt, "outputs", "changed.json"), '{"a":2}');
  writeFileSync(join(mnt, "outputs", "bad.json"), "{not json");
  writeFileSync(join(root, "outside.json"), "{}");
});
afterEach(() => vi.unstubAllEnvs());

const PRE = (): Record<string, string | null> => ({
  "outputs/same.json": sha('{"a":1}'),
  "outputs/changed.json": sha('{"a":1}'),
  "outputs/nullhash.json": null,
});
function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: mnt,
    userVisiblePrefixes: ["outputs"],
    preRunHashes: PRE(),
    preRunPaths: Object.keys(PRE()),
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
function one(a: Assertion, c: AssertContext): string {
  const [r] = evaluate([a], c);
  const text = r.pass ? `PASS ${r.evidence ?? ""}` : `FAIL ${r.message ?? ""}`;
  return text.split(root).join("<root>");
}
const authored = (artifact: string): Assertion => ({ artifact_json: { artifact, authored: true } }) as Assertion;
const aj = (artifact: string, extra: Record<string, unknown> = {}): Assertion => ({ artifact_json: { artifact, ...extra } }) as Assertion;

describe("authored: true — every branch, byte-exact", () => {
  it("remote-unavailable baseline", () => {
    expect(one(authored("outputs/new.json"), ctx({ preRunOrigin: "remote-unavailable" }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — the pre-run manifest is not locally observable (remote)"`,
    );
  });
  it("a --resume turn", () => {
    expect(one(authored("outputs/new.json"), ctx({ resume: true }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — this is a --resume turn: authorship is decided per invocation, and a resume turn captures no pre-run manifest of its own (the one on disk is the first turn's), so what THIS turn wrote cannot be told apart from earlier turns' work"`,
    );
  });
  it("no pre-run manifest", () => {
    expect(one(authored("outputs/new.json"), ctx({ preRunHashes: undefined }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — no pre-run manifest for this run/cassette (it predates the manifest, or nothing armed it) — authorship cannot be decided"`,
    );
  });
  it("an absolute path", () => {
    expect(one(authored("/etc/hosts"), ctx())).toMatchInlineSnapshot(
      `"FAIL unsafe artifact_json path "/etc/hosts" — must stay under the work root (no absolute paths or "..")"`,
    );
  });
  it("not found", () => {
    expect(one(authored("outputs/missing.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json {authored: true}: "outputs/missing.json" not found — nothing this run wrote is there"`,
    );
  });
  it("a symlink at the path", () => {
    symlinkSync(join(mnt, "outputs", "new.json"), join(mnt, "outputs", "link.json"));
    expect(one(authored("outputs/link.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/link.json" — it is a symlink — a link is never authored evidence (the pre-run manifest never hashes one)"`,
    );
  });
  it("a replay link entry", () => {
    expect(one(authored("outputs/new.json"), ctx({ linkPaths: new Set(["outputs/new.json"]) }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — it is a symlink — a link is never authored evidence (the pre-run manifest never hashes one)"`,
    );
  });
  it("a directory", () => {
    expect(one(authored("outputs/sub"), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json {authored: true}: \`authored\` applies to a file — "outputs/sub" is a directory (assert on a file the step writes inside it)"`,
    );
  });
  it("not a regular file (a FIFO)", () => {
    execFileSync("mkfifo", [join(mnt, "outputs", "pipe")]);
    // file_exists, not artifact_json: artifact_json would block reading the FIFO.
    expect(one({ file_exists: { path: "outputs/pipe", authored: true } } as Assertion, ctx())).toMatchInlineSnapshot(
      `"FAIL file_exists {authored: true}: "outputs/pipe" is not a regular file"`,
    );
  });
  it("a second hard link", () => {
    linkSync(join(mnt, "outputs", "new.json"), join(mnt, "outputs", "hard.json"));
    expect(one(authored("outputs/hard.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/hard.json" — it has a second hard link (another name for the same file) — the authored-file capture excludes it too"`,
    );
  });
  it("reached through a symlinked directory", () => {
    mkdirSync(join(mnt, "real"));
    writeFileSync(join(mnt, "real", "x.json"), "{}");
    symlinkSync(join(mnt, "real"), join(mnt, "outputs", "via"));
    expect(one(authored("outputs/via/x.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/via/x.json" — it is reached through a symlinked directory — a link is never authored evidence"`,
    );
  });
  it("existed before as a link (in preRunPaths, not hashed)", () => {
    expect(one(authored("outputs/new.json"), ctx({ preRunPaths: ["outputs/new.json"] }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — it existed before the run as a link, whose content was never hashed"`,
    );
  });
  it("a path outside the walked pre-run roots", () => {
    mkdirSync(join(mnt, ".local-plugins"));
    writeFileSync(join(mnt, ".local-plugins", "x.json"), "{}");
    expect(one(authored(".local-plugins/x.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on ".local-plugins/x.json" — it is outside the folders the pre-run manifest covers (outputs, uploads), so whether this run wrote it cannot be decided"`,
    );
  });
  it("a new path on a local-unreadable baseline", () => {
    expect(one(authored("outputs/new.json"), ctx({ preRunOrigin: "local-unreadable" }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — the pre-run baseline is incomplete (a connected-folder source was unreadable), so a new path cannot be proven new"`,
    );
  });
  it("a new path too large to hash", () => {
    vi.stubEnv("COWORK_HARNESS_PRERUN_HASH_CAP", "4");
    expect(one(authored("outputs/new.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — the file is too large to hash post-run (COWORK_HARNESS_PRERUN_HASH_CAP)"`,
    );
  });
  it("a new path with no post-run record (replay hashes lack it)", () => {
    expect(one(authored("outputs/new.json"), ctx({ postRunHashes: {} }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/new.json" — there is no post-run record of it as a regular file"`,
    );
  });
  it("a new path", () => {
    expect(one(authored("outputs/new.json"), ctx())).toMatchInlineSnapshot(`"PASS artifact_json: "outputs/new.json" is new this run"`);
  });
  it("a null pre-run hash", () => {
    writeFileSync(join(mnt, "outputs", "nullhash.json"), "{}");
    expect(one(authored("outputs/nullhash.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/nullhash.json" — its pre-run hash is unavailable (over COWORK_HARNESS_PRERUN_HASH_CAP, unreadable, or nulled because the recorded body was secret-scrubbed)"`,
    );
  });
  it("a pre-run path too large to hash post-run", () => {
    vi.stubEnv("COWORK_HARNESS_PRERUN_HASH_CAP", "4");
    expect(one(authored("outputs/changed.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/changed.json" — the file is too large to hash post-run (COWORK_HARNESS_PRERUN_HASH_CAP)"`,
    );
  });
  it("a pre-run path with no post-run hash", () => {
    expect(one(authored("outputs/changed.json"), ctx({ postRunHashes: {} }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json {authored: true} on "outputs/changed.json" — there is no post-run hash for it (removed, or unreadable)"`,
    );
  });
  it("an untouched pre-run file", () => {
    expect(one(authored("outputs/same.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json {authored: true}: "outputs/same.json" is an untouched pre-run file (its content equals what was there before the run — e.g. a workspace_fixture file the step never rewrote), not something this run wrote"`,
    );
  });
  it("a rewritten pre-run file", () => {
    expect(one(authored("outputs/changed.json"), ctx())).toMatchInlineSnapshot(
      `"PASS artifact_json: "outputs/changed.json" was rewritten this run"`,
    );
  });
});

describe("artifact_json evidence gates — every branch, byte-exact", () => {
  it("an absolute path", () => {
    expect(one(aj("/etc/hosts"), ctx())).toMatchInlineSnapshot(
      `"FAIL unsafe artifact_json path "/etc/hosts" — must stay under the work root (no absolute paths or "..")"`,
    );
  });
  it("a replay link entry", () => {
    expect(one(aj("outputs/new.json"), ctx({ linkPaths: new Set(["outputs/new.json"]) }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: "outputs/new.json" was a symlink/hardlink at record time — its content is not in the cassette (replay materializes a 0-byte placeholder); re-record or assert on the deliverable"`,
    );
  });
  it("a symlink escaping the root", () => {
    symlinkSync(join(root, "outside.json"), join(mnt, "outputs", "esc.json"));
    expect(one(aj("outputs/esc.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL unsafe artifact_json path "outputs/esc.json" — symlink target escapes the work root"`,
    );
  });
  it("not found", () => {
    expect(one(aj("outputs/missing.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: file not found: outputs/missing.json (under <root>/mnt)"`,
    );
  });
  it("body-less on replay: fixture", () => {
    const truncatedPaths = new Map([["outputs/new.json", "fixture" as const]]);
    expect(one(aj("outputs/new.json"), ctx({ truncatedPaths }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json target "outputs/new.json" was captured body-less (an untouched binary workspace_fixture file — recorded hash-only; assert artifact_json on what the step writes) — content is not in the cassette, so it cannot be evaluated on replay"`,
    );
  });
  it("body-less on replay: input", () => {
    const truncatedPaths = new Map([["outputs/new.json", "input" as const]]);
    expect(one(aj("outputs/new.json"), ctx({ truncatedPaths }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json target "outputs/new.json" was captured body-less (an uploaded input — its content is captured hash-only, never inlined; assert artifact_json on a deliverable instead) — content is not in the cassette, so it cannot be evaluated on replay"`,
    );
  });
  it("body-less on replay: readonly", () => {
    const truncatedPaths = new Map([["outputs/new.json", "readonly" as const]]);
    expect(one(aj("outputs/new.json"), ctx({ truncatedPaths }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json target "outputs/new.json" was captured body-less (read-only connected-folder input — its content is never captured; assert artifact_json on a deliverable instead) — content is not in the cassette, so it cannot be evaluated on replay"`,
    );
  });
  it("body-less on replay: size", () => {
    const truncatedPaths = new Map([["outputs/new.json", "size" as const]]);
    expect(one(aj("outputs/new.json"), ctx({ truncatedPaths }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json target "outputs/new.json" was captured body-less (larger than the artifact-body cap — raise --max-artifact-bytes to capture it) — content is not in the cassette, so it cannot be evaluated on replay"`,
    );
  });
  it("body-less on replay: unreadable", () => {
    const truncatedPaths = new Map([["outputs/new.json", "unreadable" as const]]);
    expect(one(aj("outputs/new.json"), ctx({ truncatedPaths }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json target "outputs/new.json" was captured body-less (a read-only connected-folder input, or an artifact larger than the body cap — if an input, assert on a deliverable; if a large deliverable, raise --max-artifact-bytes) — content is not in the cassette, so it cannot be evaluated on replay"`,
    );
  });
  it("body-less on replay: undefined", () => {
    const truncatedPaths = new Map<string, undefined>([["outputs/new.json", undefined]]);
    expect(one(aj("outputs/new.json"), ctx({ truncatedPaths }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json target "outputs/new.json" was captured body-less (a read-only connected-folder input, or an artifact larger than the body cap — if an input, assert on a deliverable; if a large deliverable, raise --max-artifact-bytes) — content is not in the cassette, so it cannot be evaluated on replay"`,
    );
  });
  it("a live read-only folder", () => {
    expect(one(aj("outputs/new.json"), ctx({ readonlyFolderRoots: ["outputs"] }))).toMatchInlineSnapshot(
      `"FAIL evidence unavailable: artifact_json target "outputs/new.json" was captured body-less (read-only connected-folder input — its content is never captured; assert artifact_json on a deliverable instead) — content is not in the cassette, so it cannot be evaluated on replay"`,
    );
  });
  it("over the 10 MiB cap", () => {
    writeFileSync(join(mnt, "outputs", "big.json"), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    expect(one(aj("outputs/big.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: file too large to parse as JSON (10485761 bytes, limit 10 MiB)"`,
    );
  });
  it("not valid JSON", () => {
    expect(one(aj("outputs/bad.json"), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: outputs/bad.json could not be read/parsed as JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)"`,
    );
  });
  it("a directory", () => {
    expect(one(aj("outputs/sub"), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: outputs/sub could not be read/parsed as JSON: EISDIR: illegal operation on a directory, read"`,
    );
  });
  it("an unresolvable intermediate", () => {
    expect(one(aj("outputs/new.json", { path: "x.y" }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: path "x.y" unresolvable in outputs/new.json — intermediate "x" is missing or not an object"`,
    );
  });
  it("no operator, present / absent", () => {
    expect(one(aj("outputs/new.json", { path: "a.b" }), ctx())).toMatchInlineSnapshot(`"PASS "`);
    expect(one(aj("outputs/new.json", { path: "a.c" }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: "a.c" is not present (no operator given → existence check)"`,
    );
  });
  it("operators", () => {
    expect(one(aj("outputs/new.json", { path: "a.b", gt: 5 }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: "a.b" = 3, expected > 5"`,
    );
    expect(one(aj("outputs/new.json", { path: "a.b", equals: 4 }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: "a.b" = 3, expected 4"`,
    );
    expect(one(aj("outputs/new.json", { path: "n", is_null: false }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: "n" is_null=true, expected false"`,
    );
    expect(one(aj("outputs/new.json", { path: "a.b", in: [1, 2] }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: "a.b" = 3, expected one of [1,2]"`,
    );
    expect(one(aj("outputs/new.json", { path: "a.b", exists: false }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: "a.b" exists=true, expected false"`,
    );
    expect(one(aj("outputs/new.json", { path: "a.c", absent: false }), ctx())).toMatchInlineSnapshot(
      `"FAIL artifact_json: "a.c" absent=true, expected false"`,
    );
    expect(one(aj("outputs/new.json", { path: "a.b", gt: 1 }), ctx())).toMatchInlineSnapshot(`"PASS "`);
  });
  it("authored + artifact_json together on a new file: both evidence lines", () => {
    expect(one(aj("outputs/new.json", { path: "a.b", authored: true }), ctx())).toMatchInlineSnapshot(
      `"PASS artifact_json: "outputs/new.json" is new this run"`,
    );
  });
});

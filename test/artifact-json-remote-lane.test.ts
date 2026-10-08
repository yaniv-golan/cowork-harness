import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { replayCassette } from "../src/run/cassette.js";
import type { Assertion } from "../src/types.js";

// `lane: remote` still EXECUTES locally, so the file a skill wrote is on the local work root. The contract it
// models is a remote container whose filesystem is not locally observable: a body read here grades a file the
// cloud lane would never show anyone. `artifact_text` refuses for that reason; `artifact_json` must too, in every
// form and on every lane that grades it. Every case below puts a file on disk that the assertion would PASS on
// `lane: local`, so a missing branch reads as a pass, never as a coincidental red.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-aj-remote-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function ctx(workRoot: string, over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot,
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
    ...over,
  };
}

const ok = JSON.stringify({ status: "ok" });
const files = { "outputs/state.json": ok, "outputs/runs/a/run_status.json": ok, "outputs/runs/b/run_status.json": ok };
const LANE = /artifact_json cannot be evaluated on `lane: remote` — a remote container's filesystem is not locally observable/;

const literal: Assertion = { artifact_json: { artifact: "outputs/state.json", path: "status", equals: "ok" } };
const globOf = (match: "each" | "any"): Assertion => ({
  artifact_json: { artifact: "outputs/runs/*/run_status.json", match, path: "status", equals: "ok" },
});

describe("artifact_json on `lane: remote` — evidence unavailable, every form", () => {
  for (const [name, a] of [
    ["a literal path", literal],
    ["a glob, match: each", globOf("each")],
    ["a glob, match: any", globOf("any")],
  ] as const) {
    it(`${name}: passes on lane: local, refused on lane: remote`, () => {
      const root = tree(files);
      const local = evaluate([a], ctx(root));
      expect(local.every((r) => r.pass)).toBe(true);
      const remote = evaluate([a], ctx(root, { lane: "remote" }));
      expect(remote).toHaveLength(1);
      expect(remote[0].pass).toBe(false);
      expect(remote[0].message).toMatch(LANE);
    });
  }

  it("an unsafe path is still refused on the lane, not graded (lane first, as artifact_text)", () => {
    const r = evaluate([{ artifact_json: { artifact: "../x.json", path: "a", equals: 1 } }], ctx(tree(files), { lane: "remote" }));
    expect(r[0].pass).toBe(false);
    expect(r[0].message).toMatch(LANE);
  });

  it("gives the same reason as artifact_text, so the two read alike", () => {
    const root = tree(files);
    const reason = (m?: string) => m?.replace(/^artifact_(json|text) /, "").replace(/no body to (scan|parse)/, "no body to read");
    const aj = evaluate([literal], ctx(root, { lane: "remote" }))[0];
    const at = evaluate([{ artifact_text: { artifact: "outputs/state.json", contains: ["ok"] } }], ctx(root, { lane: "remote" }))[0];
    expect(at.pass).toBe(false);
    expect(reason(aj.message)).toBe(reason(at.message));
  });
});

describe("artifact_json `authored: true` on `lane: remote` — the lane refusal alone", () => {
  const authoredCtx = (root: string) =>
    ctx(root, {
      lane: "remote",
      preRunHashes: { "outputs/changed.json": sha('{"a":1}'), "outputs/same.json": sha('{"a":1}') },
      preRunPaths: ["outputs/changed.json", "outputs/same.json"],
    });
  const roots = () => tree({ "outputs/changed.json": '{"a":2}', "outputs/same.json": '{"a":1}' });

  // Authorship compares the container's file with the pre-run manifest, so on this lane it is a read of the same
  // unobservable file: the lane refusal is reported, whether authorship would have passed or failed locally.
  for (const file of ["outputs/changed.json", "outputs/same.json"])
    it(`${file}: the lane refusal is what fails the assertion`, () => {
      const [r] = evaluate([{ artifact_json: { artifact: file, authored: true, path: "a", exists: true } }], authoredCtx(roots()));
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(LANE);
    });
});

describe("artifact_json on a replayed `lane: remote` cassette", () => {
  const events = [
    JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false }),
  ];
  const cassette = (lane: "local" | "remote", a: Assertion) =>
    ({
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        lane,
        assert: [a, { result: "success" as const }],
      },
      events,
      artifacts: Object.entries(files).map(([path, body]) => ({ path, bytes: Buffer.byteLength(body), sha256: sha(body), body })),
    }) as any;

  for (const [name, a] of [
    ["a literal path", literal],
    ["a glob, match: each", globOf("each")],
    ["a glob, match: any", globOf("any")],
  ] as const) {
    it(`${name}: the lane: local twin passes, lane: remote fails on the lane`, async () => {
      const local = await replayCassette(cassette("local", a));
      expect(local.assertions.filter((x) => !x.pass)).toHaveLength(0);
      const remote = await replayCassette(cassette("remote", a));
      const failed = remote.assertions.filter((x) => !x.pass);
      expect(failed).toHaveLength(1);
      expect(failed[0].message).toMatch(LANE);
    });
  }
});

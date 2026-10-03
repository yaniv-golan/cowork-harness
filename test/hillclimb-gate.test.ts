// The harness-integrity gate (runner-scaffold.mjs runner-scaffold.mjs l.216-277): a sha256 over sorted (relpath\0bytes\0)
// entries, compared with _state.json.harness_sha. It is a CHANGE DETECTOR over what defines the measurement
// (scenario, session, answers, uploads, lockfiles, harness version, baseline) — never over the skill dir the
// loop edits each round, or every round would stop for approval.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowHarnessDigest, harnessDigest, gateDecision, listedInside, harnessChangeText } from "../src/hillclimb/gate.js";

let cwd: string;
const put = (rel: string, body: string) => {
  mkdirSync(join(cwd, rel, ".."), { recursive: true });
  writeFileSync(join(cwd, rel), body);
};
const base = () => ({
  cwd,
  listed: [] as string[],
  derived: [join(cwd, "evals/a.yaml"), join(cwd, "evals/_session.yaml")],
  virtual: { "cowork-harness-version": "4.3.0", baseline: "2.9939.4" } as Record<string, string>,
});

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "hc-gate-")));
  put("evals/a.yaml", "prompt: a\n");
  put("evals/_session.yaml", "model: x\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("harnessDigest", () => {
  it("is S's construction: sha256 over sorted (relpath \\0 bytes \\0), plus the virtual entries", () => {
    const d = harnessDigest(base());
    const h = createHash("sha256");
    // files sorted by path, then virtual entries sorted by name, each as name\0value\0
    for (const [rel, body] of [
      ["evals/_session.yaml", "model: x\n"],
      ["evals/a.yaml", "prompt: a\n"],
    ])
      h.update(rel).update("\0").update(body).update("\0");
    for (const [k, v] of [
      ["<baseline>", "2.9939.4"],
      ["<cowork-harness-version>", "4.3.0"],
    ])
      h.update(k).update("\0").update(v).update("\0");
    expect(d.sha).toBe(h.digest("hex"));
    expect(d.hashed).toEqual(["evals/_session.yaml", "evals/a.yaml", "<baseline>", "<cowork-harness-version>"]);
  });

  it("without a tag the sha is the one recorded before tags existed: an approved flow keeps its approval", () => {
    // Pinned literal, computed on the code before `tags` was added; it must never move.
    expect(harnessDigest(base()).sha).toBe("d8183115d25b62619e3997ca38c67bd0392cd57d4c030d9370912e5bee91ee71");
    expect(harnessDigest({ ...base(), tags: [] }).sha).toBe("d8183115d25b62619e3997ca38c67bd0392cd57d4c030d9370912e5bee91ee71");
  });

  it("the keys an approval records beside the sha (harness_skill, harness_files) are not hashed: the pinned sha holds", () => {
    const flow = (state: Record<string, unknown>) =>
      flowHarnessDigest({ cwd, state, derived: base().derived, harnessVersion: "4.3.0", baselineId: "2.9939.4" }).sha;
    expect(flow({})).toBe("d8183115d25b62619e3997ca38c67bd0392cd57d4c030d9370912e5bee91ee71");
    expect(flow({ harness_sha: "x", harness_files: { "evals/a.yaml": "0".repeat(64) }, harness_skill: "s" })).toBe(
      "d8183115d25b62619e3997ca38c67bd0392cd57d4c030d9370912e5bee91ee71",
    );
  });

  it("a tag (the --skill selection) joins the sha after the virtual entries and shows in what was hashed", () => {
    const d = harnessDigest({ ...base(), tags: ["skill:a"] });
    const h = createHash("sha256");
    for (const [rel, body] of [
      ["evals/_session.yaml", "model: x\n"],
      ["evals/a.yaml", "prompt: a\n"],
      ["<baseline>", "2.9939.4"],
      ["<cowork-harness-version>", "4.3.0"],
    ])
      h.update(rel).update("\0").update(body).update("\0");
    h.update("skill:a").update("\0");
    expect(d.sha).toBe(h.digest("hex"));
    expect(d.hashed).toEqual(["evals/_session.yaml", "evals/a.yaml", "<baseline>", "<cowork-harness-version>", "skill:a"]);
    expect(harnessDigest({ ...base(), tags: ["skill:b"] }).sha).not.toBe(d.sha);
    expect(harnessDigest(base()).sha).not.toBe(d.sha);
  });

  it("an edit to any derived file flips the sha; so does a version or baseline change", () => {
    const before = harnessDigest(base()).sha;
    put("evals/_session.yaml", "model: y\n");
    expect(harnessDigest(base()).sha).not.toBe(before);
    put("evals/_session.yaml", "model: x\n");
    expect(harnessDigest(base()).sha).toBe(before);
    expect(harnessDigest({ ...base(), virtual: { "cowork-harness-version": "4.3.1", baseline: "2.9939.4" } }).sha).not.toBe(before);
    expect(harnessDigest({ ...base(), virtual: { "cowork-harness-version": "4.3.0", baseline: "2.9940.0" } }).sha).not.toBe(before);
  });

  it("picks up a lockfile in cwd, and notes when there is none (runner-scaffold.mjs l.241-243, 261)", () => {
    expect(harnessDigest(base()).lockfiles).toEqual([]);
    put("package-lock.json", "{}");
    const d = harnessDigest(base());
    expect(d.lockfiles).toEqual(["package-lock.json"]);
    expect(d.hashed).toContain("package-lock.json");
  });

  it("an unreadable LISTED path is skipped with a warning (runner-scaffold.mjs l.249-253); a duplicate path is hashed once", () => {
    const d = harnessDigest({ ...base(), listed: ["missing.mjs", "evals/a.yaml"] });
    expect(d.skipped).toEqual([{ path: "missing.mjs", code: "ENOENT" }]);
    expect(d.hashed.filter((p) => p === "evals/a.yaml")).toHaveLength(1);
  });

  it("an unreadable DERIVED path throws — the measurement itself is missing", () => {
    expect(() => harnessDigest({ ...base(), derived: [join(cwd, "evals/gone.yaml")] })).toThrow(/gone\.yaml/);
  });
});

describe("listedInside — a harness path inside the skill dir would stop every round", () => {
  it("names the listed entries that resolve inside the skill dir", () => {
    put("plugin/skills/x/SKILL.md", "s");
    put("eval/grade.mjs", "g");
    expect(listedInside(cwd, ["plugin/skills/x/SKILL.md", "eval/grade.mjs"], join(cwd, "plugin"))).toEqual(["plugin/skills/x/SKILL.md"]);
  });

  it("a listed entry that no longer exists is no error: outside the skill dir it passes, inside it is still named", () => {
    put("plugin/skills/x/SKILL.md", "s");
    // e.g. a fixture file renamed after state-template listed it: the digest skips it with a warning
    expect(listedInside(cwd, ["fx/gone.csv", "plugin/skills/x/gone.md"], join(cwd, "plugin"))).toEqual(["plugin/skills/x/gone.md"]);
  });
});

describe("gateDecision (runner-scaffold.mjs l.259-276)", () => {
  const sha = "a".repeat(64);
  it("matching sha runs", () => expect(gateDecision({ harness_sha: sha }, sha, false)).toEqual({ kind: "ok" }));
  it("--approve-harness records the new sha", () => expect(gateDecision({ harness_sha: "b" }, sha, true)).toEqual({ kind: "approve" }));
  it("absent sha refuses, telling the user to approve", () => expect(gateDecision({}, sha, false)).toEqual({ kind: "absent" }));
  it("a different sha refuses", () => expect(gateDecision({ harness_sha: "b".repeat(64) }, sha, false)).toEqual({ kind: "mismatch" }));
});

describe("per-entry hashes: what an approval records, so a refusal can name what changed", () => {
  it("every hashed entry gets its own sha256 (files, virtual entries, tags); editing one file moves only its entry", () => {
    const before = harnessDigest({ ...base(), tags: ["skill:a"] });
    expect(Object.keys(before.entries)).toEqual(before.hashed);
    for (const v of Object.values(before.entries)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    put("evals/a.yaml", "prompt: b\n");
    const after = harnessDigest({ ...base(), tags: ["skill:a"] });
    const moved = Object.keys(after.entries).filter((k) => after.entries[k] !== before.entries[k]);
    expect(moved).toEqual(["evals/a.yaml"]);
  });

  it("names the changed entries first and counts the unchanged ones, never listing them", () => {
    const approved = harnessDigest(base());
    const state = { harness_sha: approved.sha, harness_files: approved.entries };
    put("evals/a.yaml", "prompt: b\n");
    expect(harnessChangeText(state, harnessDigest(base()))).toBe("changed: evals/a.yaml; and 3 unchanged");
  });

  it("an entry that appeared or went away is named as new or removed", () => {
    const approved = harnessDigest({ ...base(), tags: ["skill:a"] });
    const state = { harness_sha: approved.sha, harness_files: approved.entries };
    put("evals/b.yaml", "prompt: b\n");
    const now = harnessDigest({ ...base(), derived: [...base().derived, join(cwd, "evals/b.yaml")] });
    expect(harnessChangeText(state, now)).toBe("changed: evals/b.yaml (new), skill:a (removed); and 4 unchanged");
  });

  it("an approval that recorded no per-entry hashes (an older one) says so and lists every file, as before", () => {
    const now = harnessDigest(base());
    const text = "changed: unknown (older approval); files: evals/_session.yaml, evals/a.yaml, <baseline>, <cowork-harness-version>";
    expect(harnessChangeText({ harness_sha: "b".repeat(64) }, now)).toBe(text);
    // A value that is not a name -> sha map is read as no record, never trusted.
    expect(harnessChangeText({ harness_sha: "b".repeat(64), harness_files: ["evals/a.yaml"] }, now)).toBe(text);
    expect(harnessChangeText({ harness_sha: "b".repeat(64), harness_files: { "evals/a.yaml": 3 } }, now)).toBe(text);
  });

  it("recorded hashes that all still match a sha that moved name no culprit, and list every file", () => {
    const now = harnessDigest(base());
    expect(harnessChangeText({ harness_sha: "b".repeat(64), harness_files: now.entries }, now)).toBe(
      "changed: none identified; files: evals/_session.yaml, evals/a.yaml, <baseline>, <cowork-harness-version>",
    );
  });
});

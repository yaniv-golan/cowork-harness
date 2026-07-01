import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile, sessionOriginSources, sessionOriginKey, collectArtifacts } from "../src/run/execute.js";
import { loadSession } from "../src/session.js";

// the pinned-session (`sess-<id>`) cross-project overwrite guard. All collision cases throw at the
// existsSync(outDir) check BEFORE buildLaunchPlan / any runtime spawn, so they're token-free and need no
// Docker. The guard identifies a run by its mounted-SOURCE content (a `.origin` marker); a foreign or
// missing marker, or a sourceless (inline) session whose identity can't be confirmed, must error — never
// delete (fail closed).

let scnDir: string;
function bundle(name: string, sessionYaml: string) {
  scnDir = mkdtempSync(join(tmpdir(), "cwh-scn-"));
  writeFileSync(join(scnDir, "s.yaml"), sessionYaml);
  writeFileSync(join(scnDir, `${name}.yaml`), `name: ${name}\nbaseline: latest\nsession: ./s.yaml\nfidelity: protocol\nprompt: hi\n`);
  return parseScenarioFile(join(scnDir, `${name}.yaml`));
}
function inlineScenario(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "cwh-scn-"));
  const f = join(dir, `${name}.yaml`);
  writeFileSync(f, `name: ${name}\nbaseline: latest\nsession: (inline)\nfidelity: protocol\nprompt: hi\n`);
  return parseScenarioFile(f);
}
/** A scenario whose session mounts a real folder → a CONFIRMABLE origin (non-empty source set). */
function sourcedScenario(name: string): { scenario: ReturnType<typeof parseScenarioFile>; src: string } {
  const src = mkdtempSync(join(tmpdir(), "cwh-src-"));
  writeFileSync(join(src, "f.txt"), "x");
  return { scenario: bundle(name, `folders:\n  - from: ${src}\n`), src };
}

/** Pre-create a pinned run dir at <root>/<slug>/sess-<id> with the given `.origin` (or none). */
function seedPinnedDir(root: string, slug: string, id: string, origin?: object): string {
  const dir = join(root, slug, `sess-${id}`);
  mkdirSync(dir, { recursive: true });
  if (origin) writeFileSync(join(dir, ".origin"), JSON.stringify(origin));
  writeFileSync(join(dir, "PRIOR.txt"), "prior project data"); // proof it survives a blocked run
  return dir;
}

describe("execute — origin identity (mounted-source, content-stable)", () => {
  it("distinct source sets → distinct keys; the SAME set → the same key (so a same-project refresh works)", () => {
    const a = mkdtempSync(join(tmpdir(), "cwh-A-"));
    const b = mkdtempSync(join(tmpdir(), "cwh-B-"));
    const sessA = loadSession({ folders: [{ from: a }] });
    const sessB = loadSession({ folders: [{ from: b }] });
    const keyA = sessionOriginKey(sessionOriginSources(sessA, "(inline)"), "(inline)");
    const keyB = sessionOriginKey(sessionOriginSources(sessB, "(inline)"), "(inline)");
    expect(keyA).not.toBe(keyB); // different projects → different identity
    expect(sessionOriginKey(sessionOriginSources(sessA, "(inline)"), "(inline)")).toBe(keyA); // stable
  });

  it("a sourceless inline session has an EMPTY source set (→ unconfirmable identity)", () => {
    expect(sessionOriginSources(loadSession({}), "(inline)")).toEqual([]);
  });

  it("a declared-but-missing source is still part of the identity (presence-invariant, no softMissing flip)", () => {
    const present = mkdtempSync(join(tmpdir(), "cwh-present-"));
    const missing = join(present, "does-not-exist-subdir");
    const sess = loadSession({
      folders: [{ from: present }, { from: missing }],
    });
    // The missing folder is retained in the key, so the identity doesn't change if it later appears/vanishes.
    expect(sessionOriginSources(sess, "(inline)").some((p) => p.endsWith("does-not-exist-subdir"))).toBe(true);
  });

  // The `.origin` marker lives at outDir/.origin — ABOVE workRoot (outDir/work/session/mnt) — so it is
  // structurally invisible to collectArtifacts / file_exists / user_visible_artifact. Regression guard
  // against a future move of the marker into the staged tree (the plan's required check).
  it("collectArtifacts never returns the .origin marker (it is above workRoot)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "cwh-marker-"));
    writeFileSync(join(outDir, ".origin"), JSON.stringify({ originKey: "k", sourceHint: "x" }));
    const workRoot = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workRoot, "outputs"), { recursive: true });
    writeFileSync(join(workRoot, "outputs", "real.txt"), "hello");
    const paths = collectArtifacts(workRoot, ["outputs"]).map((g) => g.path);
    expect(paths).toContain("outputs/real.txt");
    expect(paths.join("|")).not.toContain(".origin");
  });
});

describe("execute — pinned-session cross-project guard", () => {
  const prev = process.env.COWORK_HARNESS_RUNS_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
    else process.env.COWORK_HARNESS_RUNS_DIR = prev;
    delete process.env.COWORK_HARNESS_ALLOW_FOREIGN_RESUME;
  });

  it("a CONFIRMABLE different-project collision throws and does NOT delete the prior dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-guard-"));
    process.env.COWORK_HARNESS_RUNS_DIR = root;
    const dir = seedPinnedDir(root, "guard-a", "ci", { originKey: "deadbeefdeadbeef", sourceHint: "/other/proj" });
    const { scenario } = sourcedScenario("guard-a");
    await expect(executeScenario(scenario, { sessionId: "ci" })).rejects.toThrow(/already in use by another project at \/other\/proj/);
    expect(existsSync(join(dir, "PRIOR.txt"))).toBe(true);
  });

  it("an UNCONFIRMABLE (sourceless inline) collision throws and does NOT delete — no cwd-axis silent rm", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-guard-inline-"));
    process.env.COWORK_HARNESS_RUNS_DIR = root;
    // A marker is present, but the inline run has no source → identity can't be confirmed → must not rm.
    const dir = seedPinnedDir(root, "guard-inline", "ci", { originKey: "anything", sourceHint: "/x" });
    await expect(executeScenario(inlineScenario("guard-inline"), { sessionId: "ci" })).rejects.toThrow(
      /mounts no source to identify it as yours/,
    );
    expect(existsSync(join(dir, "PRIOR.txt"))).toBe(true);
  });

  it("fails CLOSED on a missing/partial marker (crashed prior run) — throws, does not delete", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-guard2-"));
    process.env.COWORK_HARNESS_RUNS_DIR = root;
    const dir = seedPinnedDir(root, "guard-b", "ci"); // confirmable session, but the dir has NO .origin
    const { scenario } = sourcedScenario("guard-b");
    await expect(executeScenario(scenario, { sessionId: "ci" })).rejects.toThrow(/or delete .* to reset/);
    expect(existsSync(join(dir, "PRIOR.txt"))).toBe(true);
  });

  it("blocks --resume onto a different project's session (override via env)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-guard3-"));
    process.env.COWORK_HARNESS_RUNS_DIR = root;
    const dir = seedPinnedDir(root, "guard-c", "ci", { originKey: "deadbeefdeadbeef", sourceHint: "/other/proj" });
    writeFileSync(join(dir, "session.json"), JSON.stringify({ sessionId: "ci", agentSessionId: "u" }));
    const { scenario } = sourcedScenario("guard-c");
    await expect(executeScenario(scenario, { sessionId: "ci", resume: true })).rejects.toThrow(/belongs to another project/);
  });
});

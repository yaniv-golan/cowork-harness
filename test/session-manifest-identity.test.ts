import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionManifest, executeScenario, parseScenarioFile } from "../src/run/execute.js";

// The manifest's NAME makes it the first thing anyone opens in a run dir, but it held only opaque ids —
// so a consumer running three concurrent critiques could not tell which run was which without opening each
// turn's result.json. The identity fields added for that are ADDITIVE-OPTIONAL: `readSessionManifest`
// validates `sessionId` and `fidelity` only (both required), so a manifest without `scenario`/`prompt` still resumes.

function manifest(root: string, body: Record<string, unknown>): string {
  const p = join(root, "session.json");
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe("session manifest — identity fields never gate resume", () => {
  it("resumes a manifest that has none of the signpost fields (scenario, prompt)", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-sm-"));
    const p = manifest(root, { sessionId: "s1", agentSessionId: "agent-1", fidelity: "container" });
    expect(readSessionManifest(p, "s1", "container")).toBe("agent-1");
  });

  it("resumes when the identity fields are present", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-sm-"));
    const p = manifest(root, {
      sessionId: "s1",
      agentSessionId: "agent-1",
      fidelity: "container",
      scenario: "skill-my-plugin",
      prompt: "do the thing",
    });
    expect(readSessionManifest(p, "s1", "container")).toBe("agent-1");
  });

  it("still fails closed on the things resume DOES validate", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-sm-"));
    const p = manifest(root, {
      sessionId: "s1",
      agentSessionId: "agent-1",
      fidelity: "container",
      scenario: "x",
      prompt: "y",
    });
    // wrong session id — a copied/stale manifest must not resume someone else's conversation
    expect(() => readSessionManifest(p, "s2", "container")).toThrow(/session ID mismatch/);
    // wrong tier — the agent's conversation store is tier-local
    expect(() => readSessionManifest(p, "s1", "hostloop")).toThrow(/fidelity/);
  });

  it("ignores an identity field of the wrong type rather than refusing to resume", () => {
    // Identity is a signpost; it must never be able to strand a session.
    const root = mkdtempSync(join(tmpdir(), "cwh-sm-"));
    const p = manifest(root, {
      sessionId: "s1",
      agentSessionId: "agent-1",
      fidelity: "container",
      scenario: 42,
      prompt: null,
    });
    expect(readSessionManifest(p, "s1", "container")).toBe("agent-1");
  });
});

describe("session manifest — the WRITER records identity", () => {
  // The tolerance tests above import only `readSessionManifest`, which this change does not touch — they
  // pass verbatim against the previous revision, so alone they would let a regression that drops these
  // fields ship invisibly. This drives the real write site. A fresh pinned session at hostloop WITHOUT
  // `allow_host_writes` writes the manifest and then refuses at the write-consent gate, which sits before
  // any spawn — so the writer is exercised token-free, Docker-free, in well under a second.
  it("writes scenario and prompt at the real write site", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-mw-"));
    process.env.COWORK_HARNESS_RUNS_DIR = root;
    const src = mkdtempSync(join(tmpdir(), "cwh-mw-src-"));
    writeFileSync(join(src, "f.txt"), "x");
    const scnDir = mkdtempSync(join(tmpdir(), "cwh-mw-scn-"));
    // `mode: rw` — the real key. This fixture said `write: true`, which is not a Folder field: it was
    // silently stripped and the folder fell back to the `rw` DEFAULT, so the consent gate fired by
    // accident rather than by what the fixture asked for. Strict parsing surfaced it.
    writeFileSync(join(scnDir, "s.yaml"), `folders:\n  - from: ${src}\n    mode: rw\n`);
    writeFileSync(
      join(scnDir, "w.yaml"),
      `name: manifest-writer\nbaseline: latest\nsession: ./s.yaml\nfidelity: hostloop\nprompt: identify me\n`,
    );
    const scenario = parseScenarioFile(join(scnDir, "w.yaml"));
    // Refused at the host-write consent gate — AFTER the manifest is written, BEFORE anything spawns.
    await expect(executeScenario(scenario, { modelOverride: "claude-sonnet-5", sessionId: "mw1" })).rejects.toThrow(/allow_host_writes/);
    const m = JSON.parse(readFileSync(join(root, "manifest-writer", "sess-mw1", "session.json"), "utf8"));
    expect(m.scenario).toBe("manifest-writer");
    expect(m.prompt).toBe("identify me");
    // ...without disturbing what resume actually needs.
    expect(m.sessionId).toBe("mw1");
    expect(m.fidelity).toBe("hostloop");
    expect(typeof m.agentSessionId).toBe("string");
  });
});

import { describe, it, expect } from "vitest";
import { generateSubagentFolderManifest, subagentGeneratedPromptText, SUBAGENT_SKILL_SENTENCE } from "../src/prompt/subagent-manifest.js";
import { renderPrompts } from "../src/prompt.js";
import { loadBaseline } from "../src/baseline.js";
import { SessionConfig } from "../src/session.js";

/**
 * The folder manifest and trailing sentence Desktop composes in code, outside the overridable section
 * (>= 1.46388.3). Mirrors `Bd`/`Rd` in app.asar 1.46388.3 `index.chunk-BInHX3er.js`.
 */
describe("generateSubagentFolderManifest", () => {
  const VM = "/sessions/vm_abc";
  const HOST = "/Users/x/run/work/session/mnt/outputs";

  it("outputs dir only → the LIST variant with one bullet", () => {
    const out = generateSubagentFolderManifest({ vmCwd: VM, hostCwd: HOST, hostOutputsDir: HOST, folders: [] });
    expect(out).toContain("take the first path on each line below");
    expect(out).toContain(`- \`${HOST}\` (this session's outputs folder; shell: \`${VM}/mnt/outputs/\`)`);
    expect(out).not.toContain("act on the user's computer");
  });

  it("every attached folder gets its host↔shell mapping, in order", () => {
    const out = generateSubagentFolderManifest({
      vmCwd: VM,
      hostCwd: HOST,
      hostOutputsDir: HOST,
      folders: [
        { hostPath: "/Users/x/a", mountPath: "a", reachable: true },
        { hostPath: "/Users/x/b", mountPath: "b-2", reachable: true },
      ],
    });
    expect(out).toContain("- `/Users/x/a` (shell: `" + VM + "/mnt/a/`)");
    expect(out).toContain("- `/Users/x/b` (shell: `" + VM + "/mnt/b-2/`)");
    expect(out.indexOf("/Users/x/a")).toBeLessThan(out.indexOf("/Users/x/b"));
  });

  it("an unreachable folder is LISTED as unreachable, never given a shell path", () => {
    const out = generateSubagentFolderManifest({
      vmCwd: VM,
      hostCwd: HOST,
      folders: [{ hostPath: "/Users/x/gone", mountPath: "gone", reachable: false }],
    });
    expect(out).toContain("- `/Users/x/gone` (the shell cannot reach this folder)");
    // Handing the model a shell path for a folder the shell cannot reach is the failure this line exists
    // to prevent — assert the path is absent, not merely that the sentence is present.
    expect(out).not.toContain(`${VM}/mnt/gone/`);
  });

  it("EMPTY case (no outputs dir, no folders) → the OTHER prose, and no bullet list at all", () => {
    const out = generateSubagentFolderManifest({ vmCwd: VM, hostCwd: HOST, folders: [] });
    expect(out).toContain("act on the user's computer");
    expect(out).not.toContain("take the first path");
    expect(out).not.toContain("Folders on the user's computer");
    expect(out).not.toMatch(/^- /m);
  });

  it("both variants name the file tools and state where relative paths resolve", () => {
    for (const out of [
      generateSubagentFolderManifest({ vmCwd: VM, hostCwd: HOST, folders: [] }),
      generateSubagentFolderManifest({ vmCwd: VM, hostCwd: HOST, hostOutputsDir: HOST, folders: [] }),
    ]) {
      expect(out).toContain("Read, Write, Edit, Glob, Grep");
      expect(out).toContain("reject `/sessions/` paths");
      expect(out).toContain(`Relative paths in these tools start at \`${HOST}\`.`);
    }
  });

  it("the relative-paths clause names the HOST cwd, not the VM root (host/VM swap guard)", () => {
    const out = generateSubagentFolderManifest({ vmCwd: VM, hostCwd: HOST, hostOutputsDir: HOST, folders: [] });
    expect(out).toContain(`start at \`${HOST}\``);
    expect(out).not.toContain(`start at \`${VM}\``);
  });

  it("subagentGeneratedPromptText covers every constant the module can emit", () => {
    const text = subagentGeneratedPromptText();
    for (const fragment of [
      "this session's outputs folder",
      "the shell cannot reach this folder",
      "take the first path on each line below",
      "act on the user's computer",
      "Folders on the user's computer",
      "call the `Skill` tool",
    ]) {
      expect(text, `missing from the staleness fingerprint: ${fragment}`).toContain(fragment);
    }
  });
});

describe("renderPrompts — composed sub-agent append (Desktop >= 1.46388.3)", () => {
  const baseline = loadBaseline("desktop-1.46388.3");
  const session = SessionConfig.parse({});
  const sessionId = "vm_abc";
  const hostCwd = "/Users/x/run/work/session/mnt/outputs";

  const hostloop = (folders?: { hostPath: string; mountPath: string; reachable: boolean }[]) =>
    renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "hostloop",
      hostCwd,
      hostOutputsDir: hostCwd,
      subagentFolders: folders,
    }).subagentAppend!;

  it("host-loop: section THEN manifest THEN the trailing sentence, in production's order", () => {
    const out = hostloop([{ hostPath: "/Users/x/proj", mountPath: "project", reachable: true }]);
    const section = out.indexOf("## Cowork environment");
    const manifest = out.indexOf("Read, Write, Edit, Glob, Grep");
    const suffix = out.indexOf("call the `Skill` tool");
    expect(section).toBeGreaterThanOrEqual(0);
    expect(manifest).toBeGreaterThan(section);
    expect(suffix).toBeGreaterThan(manifest);
    expect(out).toContain("- `/Users/x/proj` (shell: `/sessions/vm_abc/mnt/project/`)");
  });

  it("VM tiers get the trailing sentence but NEVER the manifest (it is hostLoopMode-gated)", () => {
    const out = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" }).subagentAppend!;
    expect(out).toContain("call the `Skill` tool");
    expect(out).not.toContain("Read, Write, Edit, Glob, Grep");
    expect(out).not.toContain("Folders on the user's computer");
  });

  it("protocol still gets no append at all (decided divergence, unchanged)", () => {
    expect(renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "protocol" }).subagentAppend).toBeUndefined();
  });

  it("no unresolved {{…}} tokens survive in the composed append", () => {
    expect(hostloop([{ hostPath: "/Users/x/proj", mountPath: "project", reachable: true }])).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("the section names the VM root as the shell's start dir — the host cwd belongs to the manifest", () => {
    const out = hostloop();
    const sectionOnly = out.slice(0, out.indexOf("Read, Write, Edit, Glob, Grep"));
    expect(sectionOnly).toContain("/sessions/vm_abc");
    expect(sectionOnly, "the host cwd moved OUT of the overridable section at 1.46388.3").not.toContain(hostCwd);
  });
});

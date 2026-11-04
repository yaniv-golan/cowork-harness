import { describe, it, expect } from "vitest";
import {
  generateSubagentFolderManifest,
  subagentGeneratedPromptText,
  subagentRetryPart,
  SUBAGENT_SKILL_SENTENCE,
} from "../src/prompt/subagent-manifest.js";
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
      expect(out).toContain("Pass absolute paths to these tools.");
    }
  });

  // Desktop 2.7032.0 replaced the cwd sentence with a constant, so the host/VM swap this used to guard
  // can no longer be expressed in the manifest's PROSE — there is no path in it any more. The swap is
  // still possible in the MOUNT lines, which is where the guard moves: the host path is the user's, the
  // shell path is the VM's, and rendering either under the other's root is the same defect this caught.
  it("the mount lines keep host and VM paths on their own sides (host/VM swap guard)", () => {
    const out = generateSubagentFolderManifest({
      vmCwd: VM,
      hostCwd: HOST,
      hostOutputsDir: HOST,
      folders: [{ hostPath: `${HOST}/docs`, mountPath: "docs", reachable: true }],
    });
    expect(out).toContain(`- \`${HOST}/docs\` (shell: \`${VM}/mnt/docs/\`)`);
    expect(out).not.toContain(`\`${VM}/docs\``);
    expect(out).not.toContain(`shell: \`${HOST}/mnt/`);
    // And the retired sentence must not come back without this file being updated.
    expect(out).not.toContain("Relative paths in these tools start at");
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

// Desktop 4.16336.0: a third, host-loop-only part between the manifest and the skill sentence, whose arm follows
// gate 1978029737 field workspaceBashDownloadStatus. No 4.16336.0 baseline exists yet at this commit, so the
// 4.4212.0 baseline is re-versioned and its gate value set explicitly.
describe("renderPrompts — sub-agent retry part (Desktop >= 4.16336.0)", () => {
  const session = SessionConfig.parse({});
  const sessionId = "vm_abc";
  const hostCwd = "/Users/x/run/work/session/mnt/outputs";
  const withGate = (appVersion: string, downloadStatus: boolean | undefined) => {
    const b = structuredClone(loadBaseline("desktop-4.4212.0")) as unknown as {
      appVersion: string;
      provenance: { gates: Record<string, { value?: Record<string, unknown> }> };
    };
    b.appVersion = appVersion;
    const key = Object.keys(b.provenance.gates).find((k) => k === "1978029737" || k.endsWith(":1978029737"))!;
    const value = { ...(b.provenance.gates[key]!.value ?? {}) };
    if (downloadStatus === undefined) delete value.workspaceBashDownloadStatus;
    else value.workspaceBashDownloadStatus = downloadStatus;
    b.provenance.gates[key] = { ...b.provenance.gates[key], value };
    return b as unknown as ReturnType<typeof loadBaseline>;
  };
  const render = (b: ReturnType<typeof loadBaseline>, effectiveFidelity: "hostloop" | "container") =>
    renderPrompts(b, session, sessionId, "project", {
      effectiveFidelity,
      ...(effectiveFidelity === "hostloop" ? { hostCwd, hostOutputsDir: hostCwd, subagentFolders: [] } : {}),
    }).subagentAppend!;

  it("host-loop: manifest THEN retry part THEN the skill sentence", () => {
    const out = render(withGate("4.16336.0", true), "hostloop");
    const manifest = out.indexOf("Read, Write, Edit, Glob, Grep");
    const retry = out.indexOf('"Workspace still starting"');
    const suffix = out.indexOf("call the `Skill` tool");
    expect(manifest).toBeGreaterThanOrEqual(0);
    expect(retry).toBeGreaterThan(manifest);
    expect(suffix).toBeGreaterThan(retry);
    expect(out).toContain(subagentRetryPart(true));
  });

  it("the arm follows the recorded gate; an absent field takes production's default (off)", () => {
    expect(render(withGate("4.16336.0", true), "hostloop")).toContain('"Workspace still downloading"');
    for (const v of [false, undefined]) {
      const out = render(withGate("4.16336.0", v), "hostloop");
      expect(out).toContain(subagentRetryPart(false));
      expect(out).not.toContain("Workspace still downloading");
    }
  });

  it("VM tiers never get it; nor does a baseline older than 4.16336.0", () => {
    expect(render(withGate("4.16336.0", true), "container")).not.toContain("Workspace still starting");
    expect(render(withGate("4.4212.0", true), "hostloop")).not.toContain("Workspace still starting");
  });

  it("both arms are in the cassette-staleness text", () => {
    const text = subagentGeneratedPromptText();
    expect(text).toContain(subagentRetryPart(false));
    expect(text).toContain(subagentRetryPart(true));
  });
});

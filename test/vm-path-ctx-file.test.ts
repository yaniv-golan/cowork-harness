import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeVmPathContextFile, loadVmPathContext, MOUNTS_FILE } from "../src/run/vm-path-ctx-file.js";
import { buildTrace } from "../src/run/trace-view.js";
import { makeDisplayTranslator } from "../src/run/display-translate.js";
import { buildManifest } from "../src/run/cassette.js";
import type { VmPathContext } from "../src/vm-paths.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("vm-path-ctx-file: write/read round-trip (Item 2 — mounts.json)", () => {
  it("round-trips a ctx with folders (Map -> object -> Map), sessionId, and effectiveFidelity", () => {
    const outDir = tmp("cwh-mounts-rt-");
    const ctx: VmPathContext = {
      sessionId: "sess-abc",
      outputsHostDir: "/Users/dev/.cowork-harness/runs/x/work/session/mnt/outputs",
      uploadsHostDir: "/Users/dev/.cowork-harness/runs/x/work/session/mnt/uploads",
      folders: new Map([
        ["myproj", "/Users/dev/code/myproj"],
        ["docs", "/Users/dev/Documents/docs"],
      ]),
    };
    writeVmPathContextFile(outDir, ctx, "hostloop");
    expect(existsSync(join(outDir, MOUNTS_FILE))).toBe(true);

    const loaded = loadVmPathContext(outDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.effectiveFidelity).toBe("hostloop");
    expect(loaded!.ctx.sessionId).toBe("sess-abc");
    expect(loaded!.ctx.outputsHostDir).toBe(ctx.outputsHostDir);
    expect(loaded!.ctx.uploadsHostDir).toBe(ctx.uploadsHostDir);
    expect(loaded!.ctx.folders).toBeInstanceOf(Map);
    expect(loaded!.ctx.folders.get("myproj")).toBe("/Users/dev/code/myproj");
    expect(loaded!.ctx.folders.get("docs")).toBe("/Users/dev/Documents/docs");
    // dormant fields are never persisted, and the reader leaves them unset.
    expect(loaded!.ctx.hostHomeResolver).toBeUndefined();
    expect(loaded!.ctx.autoMemoryHostDir).toBeUndefined();
  });

  it("round-trips a ctx with NO folders and no outputs/uploads dirs (e.g. an upload-only or empty session)", () => {
    const outDir = tmp("cwh-mounts-empty-");
    const ctx: VmPathContext = { sessionId: "sess-empty", folders: new Map() };
    writeVmPathContextFile(outDir, ctx, "container");
    const loaded = loadVmPathContext(outDir);
    expect(loaded).toMatchObject({ effectiveFidelity: "container" });
    expect(loaded!.ctx.sessionId).toBe("sess-empty");
    expect(loaded!.ctx.folders.size).toBe(0);
    expect(loaded!.ctx.outputsHostDir).toBeUndefined();
    expect(loaded!.ctx.uploadsHostDir).toBeUndefined();
  });

  it("the on-disk shape matches the plan's schema exactly (v/sessionId/effectiveFidelity/folders as a plain object)", () => {
    const outDir = tmp("cwh-mounts-shape-");
    writeVmPathContextFile(outDir, { sessionId: "s1", folders: new Map([["f", "/h/f"]]) }, "hostloop");
    const raw = JSON.parse(readFileSync(join(outDir, MOUNTS_FILE), "utf8"));
    expect(raw).toEqual({ v: 1, sessionId: "s1", effectiveFidelity: "hostloop", folders: { f: "/h/f" } });
  });
});

describe("vm-path-ctx-file: absent/corrupt/future-version all degrade to null", () => {
  it("absent mounts.json -> null (no throw)", () => {
    const outDir = tmp("cwh-mounts-absent-");
    expect(loadVmPathContext(outDir)).toBeNull();
  });

  it("corrupt (non-JSON) mounts.json -> null (no throw)", () => {
    const outDir = tmp("cwh-mounts-corrupt-");
    writeFileSync(join(outDir, MOUNTS_FILE), "{ this is not valid json");
    expect(loadVmPathContext(outDir)).toBeNull();
  });

  it("a future major version (v: 2) -> null (degrade, don't guess at an unknown shape)", () => {
    const outDir = tmp("cwh-mounts-v2-");
    writeFileSync(join(outDir, MOUNTS_FILE), JSON.stringify({ v: 2, sessionId: "s", effectiveFidelity: "hostloop", folders: {} }));
    expect(loadVmPathContext(outDir)).toBeNull();
  });

  it("a v1 file missing required fields -> null", () => {
    const outDir = tmp("cwh-mounts-missing-");
    writeFileSync(join(outDir, MOUNTS_FILE), JSON.stringify({ v: 1, folders: {} })); // no sessionId/effectiveFidelity
    expect(loadVmPathContext(outDir)).toBeNull();
  });

  it("unknown-field tolerance: an extra field from a NEWER writer is ignored, not rejected", () => {
    const outDir = tmp("cwh-mounts-fwd-");
    writeFileSync(
      outDir + "/" + MOUNTS_FILE,
      JSON.stringify({ v: 1, sessionId: "s", effectiveFidelity: "hostloop", folders: {}, someFutureField: "x" }),
    );
    const loaded = loadVmPathContext(outDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.ctx.sessionId).toBe("s");
  });
});

describe("vm-path-ctx-file: write is best-effort (never throws, per the status.json convention)", () => {
  it("a write into a non-existent/unwritable outDir warns but does not throw", () => {
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => {
      chunks.push(String(s));
      return true;
    };
    try {
      // a path under a file (not a directory) can never be written into.
      const base = tmp("cwh-mounts-badwrite-");
      const notADir = join(base, "im-a-file");
      writeFileSync(notADir, "x");
      expect(() => writeVmPathContextFile(join(notADir, "nested"), { sessionId: "s", folders: new Map() }, "hostloop")).not.toThrow();
    } finally {
      (process.stderr as any).write = origWrite;
    }
    expect(chunks.join("")).toMatch(/::warning::/);
  });
});

describe("trace --translate-paths plumbing threads pre-slice through buildTrace (Item 2's consumer)", () => {
  it("buildTrace's translate option rewrites a VM path inside a tool row's JSON detail before the 100-char slice", () => {
    const dir = tmp("cwh-trace-translate-");
    const f = join(dir, "events.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "system", subtype: "init", tools: ["Read"] }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/sessions/sess-1/mnt/myproj/report.pdf" } }],
          },
        }),
        JSON.stringify({ type: "result", is_error: false }),
      ].join("\n"),
    );
    const ctx: VmPathContext = { sessionId: "sess-1", folders: new Map([["myproj", "/Users/dev/myproj"]]) };
    const translate = makeDisplayTranslator({ ctx, effectiveFidelity: "hostloop", shareable: false });

    const untranslated = buildTrace(f);
    expect(untranslated.find((r) => r.kind === "tool")?.detail).toContain("/sessions/sess-1/mnt/myproj/report.pdf");

    const translated = buildTrace(f, { translate });
    const row = translated.find((r) => r.kind === "tool");
    expect(row?.detail).toContain("/Users/dev/myproj/report.pdf");
    expect(row?.detail).not.toContain("/sessions/sess-1/mnt/");
  });

  it("defaults to identity when no translate is passed (buildTrace/buildTraceFromEvents unchanged for every existing caller)", () => {
    const dir = tmp("cwh-trace-identity-");
    const f = join(dir, "events.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
        }),
        JSON.stringify({ type: "result", is_error: false }),
      ].join("\n"),
    );
    const rows = buildTrace(f);
    expect(rows.find((r) => r.kind === "tool")?.detail).toContain("ls");
  });
});

// CLI-level: the actual `trace --translate-paths` wiring in src/cli.ts (loadVmPathContext + the
// hostloop/mounts.json gate + json-stays-raw). Needs the built dist/cli.js; skips cleanly otherwise.
const CLI = resolve("dist/cli.js");
const canCli = existsSync(CLI);

function seedHostloopRun(sessionId: string, folderMount: string, folderHost: string): string {
  const runsDir = tmp("cwh-trace-cli-runs-");
  const outDir = join(runsDir, "a-scenario", "local_1");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "events.jsonl"),
    [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Read"] }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: `/sessions/${sessionId}/mnt/${folderMount}/report.pdf` } },
          ],
        },
      }),
      JSON.stringify({ type: "result", is_error: false }),
    ].join("\n"),
  );
  writeVmPathContextFile(outDir, { sessionId, folders: new Map([[folderMount, folderHost]]) }, "hostloop");
  return runsDir;
}

function runCli(args: string[], runsDir: string) {
  const cwd = tmp("cwh-trace-cli-cwd-");
  const env = { ...process.env, COWORK_HARNESS_RUNS_DIR: runsDir };
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!canCli)("cli trace --translate-paths (CLI-level, Item 2's first consumer)", () => {
  it("WITHOUT the flag: text output shows the raw VM path", () => {
    const runsDir = seedHostloopRun("sess-cli-1", "myproj", "/Users/dev/myproj");
    const r = runCli(["trace", "local_1"], runsDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/sessions/sess-cli-1/mnt/myproj/report.pdf");
  });

  it("WITH the flag, at hostloop with a matching mounts.json: text output shows the host path instead", () => {
    const runsDir = seedHostloopRun("sess-cli-2", "myproj", "/Users/dev/myproj");
    const r = runCli(["trace", "local_1", "--translate-paths"], runsDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/Users/dev/myproj/report.pdf");
    expect(r.stdout).not.toContain("/sessions/sess-cli-2/mnt/");
  });

  it("WITH the flag but NO mounts.json: degrades to the raw VM path (no crash)", () => {
    const runsDir = tmp("cwh-trace-cli-nomounts-");
    const outDir = join(runsDir, "a-scenario", "local_1");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/sessions/s/mnt/x/f.pdf" } }] },
        }),
        JSON.stringify({ type: "result", is_error: false }),
      ].join("\n"),
    );
    const r = runCli(["trace", "local_1", "--translate-paths"], runsDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/sessions/s/mnt/x/f.pdf");
  });

  it("WITH the flag but effectiveFidelity is NOT hostloop (e.g. container): stays untranslated", () => {
    const runsDir = tmp("cwh-trace-cli-container-");
    const outDir = join(runsDir, "a-scenario", "local_1");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/sessions/sess-3/mnt/myproj/report.pdf" } }],
          },
        }),
        JSON.stringify({ type: "result", is_error: false }),
      ].join("\n"),
    );
    writeVmPathContextFile(outDir, { sessionId: "sess-3", folders: new Map([["myproj", "/Users/dev/myproj"]]) }, "container");
    const r = runCli(["trace", "local_1", "--translate-paths"], runsDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/sessions/sess-3/mnt/myproj/report.pdf");
  });

  it("--output-format json ALWAYS stays raw, even with --translate-paths at hostloop", () => {
    const runsDir = seedHostloopRun("sess-cli-4", "myproj", "/Users/dev/myproj");
    const r = runCli(["trace", "local_1", "--translate-paths", "--output-format", "json"], runsDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/sessions/sess-cli-4/mnt/myproj/report.pdf");
    expect(r.stdout).not.toContain("/Users/dev/myproj/report.pdf");
  });

  it("--translate-paths is a recognized flag (not rejected as unknown)", () => {
    const runsDir = seedHostloopRun("sess-cli-5", "myproj", "/Users/dev/myproj");
    const r = runCli(["trace", "local_1", "--translate-paths"], runsDir);
    expect(r.stderr).not.toMatch(/unknown flag/);
  });
});

// Item 2, point 5: cassettes structurally can't carry mounts.json — `record` snapshots exactly
// `events.jsonl` + `control-out.jsonl` + buildManifest(result.workDir, …, recordRoots), and workDir
// (`<outDir>/work/...`) is a SIBLING of mounts.json (which lives at the outDir ROOT). A live end-to-end
// recordScenarioObject() test needs a real run (see test/cli-json.test.ts's own note on this same
// limitation for $schema/generator) — this is the cheap, spawn-free proof of the structural claim:
// buildManifest only ever walks <workRoot>/<root> subtrees, so an outDir-root mounts.json is
// unreachable regardless of the configured recordRoots.
describe("mounts.json cannot leak into a recorded cassette (structural — buildManifest never walks above workRoot)", () => {
  it("a mounts.json sibling of workDir is absent from buildManifest's artifacts, even though a real artifact under a root IS present", () => {
    const outDir = tmp("cwh-cassette-excl-");
    const workDir = join(outDir, "work", "session", "mnt");
    mkdirSync(join(workDir, "outputs"), { recursive: true });
    writeFileSync(join(workDir, "outputs", "result.txt"), "hi");
    // mounts.json at the outDir ROOT — a sibling of "work", never under workDir.
    writeVmPathContextFile(outDir, { sessionId: "s", folders: new Map() }, "hostloop");
    expect(existsSync(join(outDir, MOUNTS_FILE))).toBe(true);

    const manifest = buildManifest(workDir, undefined, ["outputs"]);
    expect(manifest.some((e) => e.path.includes("mounts"))).toBe(false);
    expect(manifest.some((e) => e.path === "outputs/result.txt")).toBe(true);
  });
});

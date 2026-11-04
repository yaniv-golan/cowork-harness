// $0 acceptance probe for the host-loop outside-folder fence: the staged native agent, given the harness's own
// fenced --settings, reports every key in its flagSettings source, and merges a later apply_flag_settings into it
// (production sends the same keys at spawn and again right after, and relies on that merge). Control requests only,
// no user message, no credential in the child's env: no model call is possible. macOS only; skips loudly when the
// native agent is not staged.
//
// Not measured here: whether the agent drops a malformed exempt entry. It filters them lazily, inside a file-tool
// permission check, so no log line exists until a tool runs, which needs a model turn. The harness's own entry rule
// is unit-tested in hostloop-fence-model.test.ts; what a real Read or Write then does is the live run's to show.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadBaseline, resolveHostAgentBinary } from "../src/baseline.js";
import { hostLoopPermissionArgs } from "../src/hostloop/process-cwd.js";

const NATIVE = (() => {
  if (process.platform !== "darwin") return null;
  try {
    return resolveHostAgentBinary(loadBaseline("latest"));
  } catch (e) {
    console.warn(`[hostloop-fence-probe] SKIPPED: no staged native agent (${(e as Error).message.split("\n")[0]})`);
    return null;
  }
})();

type Settings = { permissions?: Record<string, unknown> };
type GetSettings = { sources: { source: string; settings: Settings }[] };

describe.skipIf(!NATIVE)("hostloop fence: the agent accepts and merges the harness's fenced settings ($0)", () => {
  const top = mkdtempSync(join(tmpdir(), "cwh-fence-probe-"));
  afterAll(() => rmSync(top, { recursive: true, force: true }));
  const d = (...p: string[]) => {
    const x = join(top, ...p);
    mkdirSync(x, { recursive: true });
    return x;
  };
  const outputs = d("session", "mnt", "outputs");
  const roots = {
    folders: [d("user", "rw"), d("user", "ro")],
    readOnlyRoots: [d("session", "mnt", "uploads"), d("config", "projects"), d("config", "skills"), d("session", "mnt", "plugin-a")],
  };
  const args = hostLoopPermissionArgs({ processCwd: d("work", "host-cwd"), hostOutputsDir: outputs, fence: roots });
  const passed = JSON.parse(args.extraArgs[args.extraArgs.indexOf("--settings") + 1]!) as Settings;

  it("flagSettings carries what was passed, and a later push merges into it", async () => {
    // A fresh env: nothing from the operator's, so no credential reaches the child.
    const env = { PATH: "/usr/bin:/bin", HOME: d("home"), CLAUDE_CONFIG_DIR: d("cfg"), CLAUDE_CODE_ENTRYPOINT: "local-agent" };
    const child = spawn(
      NATIVE!,
      [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--debug-file",
        join(top, "debug.log"),
        ...args.extraArgs,
      ],
      { cwd: d("work", "host-cwd"), env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const pending = new Map<string, (r: { subtype: string; response?: unknown }) => void>();
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line) as { type?: string; response?: { request_id?: string; subtype: string } };
          if (m.type === "control_response" && m.response?.request_id) pending.get(m.response.request_id)?.(m.response);
        } catch {
          // not a frame
        }
      }
    });
    const req = (id: string, request: Record<string, unknown>) =>
      new Promise<{ subtype: string; response?: unknown }>((res) => {
        pending.set(id, res);
        child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
      });
    const flagSource = (g: { response?: unknown }) =>
      (g.response as GetSettings).sources.find((s) => s.source === "flagSettings")?.settings.permissions ?? {};
    try {
      expect((await req("1", { subtype: "initialize" })).subtype).toBe("success");
      const before = flagSource(await req("2", { subtype: "get_settings" }));
      expect(before).toEqual(passed.permissions);

      const extra = d("artifact-dir");
      expect(
        (await req("3", { subtype: "apply_flag_settings", settings: { permissions: { blockReadsExemptPaths: [extra] } } })).subtype,
      ).toBe("success");
      const after = flagSource(await req("4", { subtype: "get_settings" }));
      expect(after.blockReadsExemptPaths).toEqual([...(passed.permissions!.blockReadsExemptPaths as string[]), extra]);
      for (const k of [
        "additionalDirectories",
        "workingDirectoriesAsGiven",
        "blockReadsOutsideWorkingDirectories",
        "blockWritesOutsideWorkingDirectories",
      ])
        expect(after[k], k).toEqual(passed.permissions![k]);
    } finally {
      child.stdin.end();
      child.kill();
    }
  }, 60_000);
});

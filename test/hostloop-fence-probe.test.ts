// $0 acceptance probe for the host-loop outside-folder fence: the staged native agent, given the harness's own
// fenced --settings, reports every key in its flagSettings source, and merges a later apply_flag_settings into it
// (production sends the same keys at spawn and again right after, and relies on that merge). It also pins which
// entries the agent drops: it filters both path lists when it builds its permission context at startup and again on
// every settings change, logging "ignored N of M" at warn level, so the debug file shows it with no model turn.
// Control requests only, no user message, no credential in the child's env: no model call is possible. macOS only;
// skips loudly when the native agent is not staged.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  let n = 0;
  /** Spawn the agent with these extra args; returns a control-request sender, a debug-log reader and a closer. */
  const agent = (extraArgs: string[]) => {
    const log = join(top, `debug-${++n}.log`);
    // A fresh env: nothing from the operator's, so no credential reaches the child.
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: d("home"),
      CLAUDE_CONFIG_DIR: d("cfg"),
      CLAUDE_CODE_ENTRYPOINT: "local-agent",
      // No traffic the probe does not need: no update check, no telemetry.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    const child = spawn(
      NATIVE!,
      ["--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--debug-file", log, ...extraArgs],
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
    /** The "ignored N of M" lines for a key, waiting for the expected count to land (the log is written asynchronously). */
    const ignored = async (key: string, expected: number) => {
      const re = new RegExp(`permissions\\.${key}: ignored (\\d+) of (\\d+)`, "g");
      let got: string[] = [];
      for (let t = 0; t < 50 && got.length < expected; t++) {
        got = existsSync(log) ? [...readFileSync(log, "utf8").matchAll(re)].map((m) => `${m[1]} of ${m[2]}`) : [];
        if (got.length < expected) await new Promise((r) => setTimeout(r, 100));
      }
      return got;
    };
    const close = () => {
      child.stdin.end();
      child.kill();
    };
    return { req, ignored, close };
  };
  const flagSource = (g: { response?: unknown }) =>
    (g.response as GetSettings).sources.find((s) => s.source === "flagSettings")?.settings.permissions ?? {};
  const settingsArg = (permissions: Record<string, unknown>) => ["--settings", JSON.stringify({ permissions })];

  it("flagSettings carries what was passed, a later push merges into it, and the harness's own entries are all kept", async () => {
    const a = agent(args.extraArgs);
    try {
      expect((await a.req("1", { subtype: "initialize" })).subtype).toBe("success");
      const before = flagSource(await a.req("2", { subtype: "get_settings" }));
      expect(before).toEqual(passed.permissions);

      const extra = d("artifact-dir");
      expect(
        (await a.req("3", { subtype: "apply_flag_settings", settings: { permissions: { blockReadsExemptPaths: [extra] } } })).subtype,
      ).toBe("success");
      const after = flagSource(await a.req("4", { subtype: "get_settings" }));
      expect(after.blockReadsExemptPaths).toEqual([...(passed.permissions!.blockReadsExemptPaths as string[]), extra]);
      for (const k of [
        "additionalDirectories",
        "workingDirectoriesAsGiven",
        "blockReadsOutsideWorkingDirectories",
        "blockWritesOutsideWorkingDirectories",
      ])
        expect(after[k], k).toEqual(passed.permissions![k]);
      // A second push REPLACES the first (artifact-dir is gone) and is again unioned with --settings: production's
      // pushes each carry the full set, so nothing relies on pushes accumulating. Its bad entry is dropped and logged,
      // and the count proves every entry the harness sent was kept.
      await a.req("5", { subtype: "apply_flag_settings", settings: { permissions: { blockReadsExemptPaths: ["relative/y"] } } });
      const given = passed.permissions!.blockReadsExemptPaths as string[];
      expect(flagSource(await a.req("6", { subtype: "get_settings" })).blockReadsExemptPaths).toEqual([...given, "relative/y"]);
      expect(await a.ignored("blockReadsExemptPaths", 1)).toEqual([`1 of ${given.length + 1}`]);
      // A zero count returns on its first read, so it cannot wait for a late line; it is read only after the 1-count wait
      // above, on the same settings change, by which point that change's log lines are written.
      expect(await a.ignored("workingDirectoriesAsGiven", 0)).toEqual([]);
    } finally {
      a.close();
    }
  }, 60_000);

  it("drops a relative path, a filesystem root and a '..' segment from the exempt list at startup", async () => {
    const ok = d("exempt-ok");
    const a = agent(
      settingsArg({ blockReadsOutsideWorkingDirectories: true, blockReadsExemptPaths: [ok, "relative/x", "/", `${ok}/../exempt-ok`] }),
    );
    try {
      expect((await a.req("1", { subtype: "initialize" })).subtype).toBe("success");
      expect(await a.ignored("blockReadsExemptPaths", 1)).toEqual(["3 of 4"]);
    } finally {
      a.close();
    }
  }, 60_000);

  // The two trailing-separator facts differ by key; each is pinned on its own so neither is read from the other.
  it("exempt list: a trailing separator is normalized and KEPT (only the relative entry is dropped)", async () => {
    const ok = d("exempt-trailing");
    const a = agent(settingsArg({ blockReadsOutsideWorkingDirectories: true, blockReadsExemptPaths: [ok, `${ok}/`, "relative"] }));
    try {
      expect((await a.req("1", { subtype: "initialize" })).subtype).toBe("success");
      expect(await a.ignored("blockReadsExemptPaths", 1)).toEqual(["1 of 3"]);
    } finally {
      a.close();
    }
  }, 60_000);

  it("working directories as given: a trailing separator is DROPPED", async () => {
    const wd = d("wd-trailing");
    const a = agent(
      settingsArg({ additionalDirectories: [wd], blockReadsOutsideWorkingDirectories: true, workingDirectoriesAsGiven: [wd, `${wd}/`] }),
    );
    try {
      expect((await a.req("1", { subtype: "initialize" })).subtype).toBe("success");
      expect(await a.ignored("workingDirectoriesAsGiven", 1)).toEqual(["1 of 2"]);
    } finally {
      a.close();
    }
  }, 60_000);
});

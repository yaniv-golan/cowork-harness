// plugins.from_host in a cassette: the frozen `hostInputs` carries names and hashes only, its names are host-inventory
// findings at every tier, a plugin's own MCP servers are the fixture's, a from_host record runs the inventory
// pre-flight at any tier, and `verify-cassettes --host-inputs` compares the frozen set with this machine.
import { describe, it, expect, vi, afterEach } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import {
  CASSETTE_VERSION,
  hostInputsDrift,
  hostInventoryPreflight,
  readCassette,
  readCassetteForScan,
  scanCassette,
} from "../src/run/cassette.js";
import { HOST_INVENTORY_CLS } from "../src/scan.js";
import { selectHostInputs, stageHostInputs, type HostInputs } from "../src/host-inputs.js";
import { parseScenarioFile } from "../src/run/execute.js";
import { DEFAULT_USER_VISIBLE_ROOTS, recordedControlOut } from "./helpers/minimal-cassette.js";
import { fakeHostConfig } from "./helpers/fake-host-config.js";

const LATEST = loadBaseline("latest");
const CLI = resolve("dist/cli.js");
afterEach(() => vi.unstubAllEnvs());

const SHA = "a".repeat(64);
const HOST: HostInputs = {
  plugins: [{ key: "alpha@mk", version: "1.0.0", gitCommitSha: "abc1234", sha256: SHA }],
  skills: [{ name: "my-skill", sha256: SHA }],
  setHash: SHA,
};
const init = (o: Record<string, unknown>) => JSON.stringify({ type: "system", subtype: "init", ...o });
function cassette(o: { hostInputs?: unknown; session?: string; events?: string[]; fidelity?: string } = {}): any {
  return {
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "from-host",
      baseline: "latest",
      session: o.session ?? "(inline)",
      fidelity: o.fidelity ?? "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    effectiveFidelity: o.fidelity ?? "container",
    events: o.events ?? [init({ tools: [] }), JSON.stringify({ type: "result", subtype: "success", result: "ok" })],
    controlOut: recordedControlOut(),
    userVisibleRoots: [...DEFAULT_USER_VISIBLE_ROOTS],
    fingerprint: { baseline: LATEST.appVersion, hashFormat: "jcs1" },
    ...(o.hostInputs !== undefined ? { hostInputs: o.hostInputs } : {}),
  };
}

describe("privacy scan", () => {
  it("each hostInputs name is a host-inventory finding, even at a sealed tier", () => {
    const f = scanCassette(cassette({ hostInputs: HOST }), []).filter((x) => x.cls === HOST_INVENTORY_CLS);
    expect(f.map((x) => x.sample).sort()).toEqual(["alpha@mk", "my-skill"]);
    expect(
      scanCassette(cassette({ hostInputs: HOST }), [{ re: /.*/, cls: HOST_INVENTORY_CLS }]).filter((x) => x.cls === HOST_INVENTORY_CLS),
    ).toEqual([]);
    // a skipped or shadowed name is the host's too, though it was not delivered
    const more = { ...HOST, skipped: [{ key: "gone@mk", reason: "not-installed" }], shadowed: ["beta@mk", "skill:other-skill"] };
    expect(
      scanCassette(cassette({ hostInputs: more }), [])
        .filter((x) => x.cls === HOST_INVENTORY_CLS)
        .map((x) => x.sample)
        .sort(),
    ).toEqual(["alpha@mk", "beta@mk", "gone@mk", "my-skill", "other-skill"]);
    // no hostInputs at a sealed tier: no structural scan, as before
    expect(scanCassette(cassette(), []).filter((x) => x.cls === HOST_INVENTORY_CLS)).toEqual([]);
  });

  it("a declared plugin's own MCP server (plugin:<name>:<server>) is the fixture; another plugin's is not", () => {
    const events = [init({ mcp_servers: [{ name: "plugin:alpha:srv" }, { name: "plugin:other:srv" }], tools: [] })];
    const f = scanCassette(cassette({ hostInputs: HOST, events }), []).filter((x) => x.where.includes("mcp_servers"));
    expect(f.map((x) => x.sample)).toEqual(["plugin:other:srv"]);
  });

  it("a hostInputs that carries anything but names and hashes is refused at read, and its names are still scanned", () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-cass-"));
    const p = join(dir, "c.cassette.json");
    const leaky = { ...HOST, plugins: [{ ...HOST.plugins[0], body: "file contents" }] };
    writeFileSync(p, JSON.stringify(cassette({ hostInputs: leaky })));
    const r = readCassette(p);
    expect("error" in r && r.error).toMatch(/hostInputs/);
    const s = readCassetteForScan(p);
    expect("scannable" in s && scanCassette(s.scannable, []).filter((x) => x.cls === HOST_INVENTORY_CLS).length).toBe(2);
    // the malformed-document lane carries skipped and shadowed too
    writeFileSync(
      p,
      JSON.stringify(cassette({ hostInputs: { ...leaky, skipped: [{ key: "gone@mk", reason: "x" }], shadowed: ["skill:s2"] } })),
    );
    const s2 = readCassetteForScan(p);
    expect("scannable" in s2 && scanCassette(s2.scannable, []).filter((x) => x.cls === HOST_INVENTORY_CLS).length).toBe(4);
  });
});

describe("record pre-flight", () => {
  it("a from_host scenario recording into a repo-visible path is refused at container too, with a fix that fits", () => {
    const repo = mkdtempSync(join(tmpdir(), "fh-repo-"));
    spawnSync("git", ["-C", repo, "init", "-q"]);
    writeFileSync(join(repo, "session.yaml"), "model: claude-sonnet-5\nplugins:\n  from_host: true\n");
    writeFileSync(join(repo, "s.yaml"), "name: s\nfidelity: container\nsession: session.yaml\nprompt: hi\nassert:\n  - result: success\n");
    const sc = parseScenarioFile(join(repo, "s.yaml"));
    const v = hostInventoryPreflight(sc, join(repo, "s.cassette.json"), false);
    expect(v.kind).toBe("refuse");
    expect("message" in v && v.message).toContain("plugins.from_host");
    expect("message" in v && v.message).toContain("not a committable fixture at any tier");
    // without from_host, container is sealed and passes
    writeFileSync(join(repo, "session.yaml"), "model: claude-sonnet-5\n");
    expect(hostInventoryPreflight(parseScenarioFile(join(repo, "s.yaml")), join(repo, "s.cassette.json"), false).kind).toBe("ok");
  });
});

describe("hostInputsDrift (verify-cassettes --host-inputs)", () => {
  function recorded() {
    const cfg = fakeHostConfig([{ key: "a@m" }, { key: "dup@m" }], { sk: { "SKILL.md": "v1" } });
    const dir = mkdtempSync(join(tmpdir(), "fh-drift-"));
    writeFileSync(join(dir, "session.yaml"), "plugins:\n  from_host: true\n");
    const frozen = stageHostInputs(
      selectHostInputs(true, cfg, () => {}),
      ["dup@m"],
      mkdtempSync(join(tmpdir(), "fh-rec-")),
    ).hostInputs;
    return { cfg, dir, c: cassette({ hostInputs: frozen, session: "session.yaml" }) };
  }

  it("the same host: no drift, and a shadowed input is not read as added", () => {
    const { cfg, dir, c } = recorded();
    expect(hostInputsDrift(c, dir, undefined, cfg)).toEqual({ drift: [] });
  });

  it("a changed plugin or skill is drift, named", () => {
    const { cfg, dir, c } = recorded();
    appendFileSync(join(selectHostInputs(true, cfg, () => {}).plugins[0]!.installPath, "README.md"), "edit\n");
    appendFileSync(join(cfg, "skills", "sk", "SKILL.md"), "edit\n");
    expect(hostInputsDrift(c, dir, undefined, cfg).drift).toEqual([
      "host-inputs: this host's set differs from the recording's (plugin a@m changed, skill sk changed)",
    ]);
  });

  it("a cassette that froze no hostInputs is 'not recorded': a note, never drift", () => {
    const { cfg, dir } = recorded();
    const r = hostInputsDrift(cassette({ session: "session.yaml" }), dir, undefined, cfg);
    expect(r.drift).toEqual([]);
    expect(r.note).toMatch(/not recorded/);
  });
});

describe.skipIf(!existsSync(CLI))("verify-cassettes --host-inputs / --strict", () => {
  function run(args: string[], c: any, cfg: string) {
    const cwd = mkdtempSync(join(tmpdir(), "fh-vc-"));
    writeFileSync(join(cwd, "session.yaml"), "plugins:\n  from_host: true\n");
    writeFileSync(join(cwd, "c.cassette.json"), JSON.stringify(c));
    const r = spawnSync("node", [CLI, "verify-cassettes", "c.cassette.json", "--output-format", "json", "--skip-privacy", ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
    });
    return { code: r.status, env: r.stdout ? JSON.parse(r.stdout) : undefined, all: r.stdout + r.stderr };
  }
  const drifted = () => {
    const cfg = fakeHostConfig([{ key: "a@m" }]);
    const frozen = stageHostInputs(
      selectHostInputs(true, cfg, () => {}),
      [],
      mkdtempSync(join(tmpdir(), "fh-rec-")),
    ).hostInputs;
    appendFileSync(join(selectHostInputs(true, cfg, () => {}).plugins[0]!.installPath, "README.md"), "edit\n");
    return { cfg, c: cassette({ hostInputs: frozen, session: "session.yaml" }) };
  };

  it("--strict without --host-inputs is a usage error", () => {
    const r = run(["--strict"], cassette(), fakeHostConfig([]));
    expect(r.code, r.all).toBe(2);
    expect(r.all).toContain("--strict applies to --host-inputs only");
  });

  it("drift is a note by default (exit 0) and a failure under --strict (exit 1)", () => {
    const { cfg, c } = drifted();
    const note = run(["--host-inputs"], c, cfg);
    expect(note.code, note.all).toBe(0);
    expect(note.env.results[0].notes.join("\n")).toContain("host-inputs: this host's set differs");
    const strict = run(["--host-inputs", "--strict"], c, cfg);
    expect(strict.code, strict.all).toBe(1);
    expect(strict.env.results[0].staleness.join("\n")).toContain("host-inputs: this host's set differs");
  });

  it("--strict --host-inputs on a cassette that froze no hostInputs: 'not recorded' is a note, not a failure", () => {
    const r = run(["--host-inputs", "--strict"], cassette({ session: "session.yaml" }), fakeHostConfig([]));
    expect(r.code, r.all).toBe(0);
    expect(r.env.results[0].notes.join("\n")).toMatch(/host-inputs: not recorded/);
    expect(r.env.results[0].staleness).toEqual([]);
  });
});

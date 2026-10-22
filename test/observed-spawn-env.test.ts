import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDesktopLogLines,
  readObservedSpawnEnv,
  bundleHasSpawnEnvProducer,
  checkObservedAgainstHarness,
  harnessHostLoopKeys,
  type ObservedSpawnEnvInput,
} from "../src/sync/observed-spawn-env.js";
import { ObservedSpawnEnv } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";
import { classifySpawnEnvKey } from "../src/sync/spawn-env-registry.js";
import { readPreviousObservedSpawnEnv } from "../src/sync/cowork-sync.js";

// Synthetic Desktop main.log text in the shape Desktop's logger writes (util.inspect of the sdkOptions object):
// several short items per line, a `[length]: N` trailer, a long `plugins` list BEFORE `envKeys` (envKeys sits ~140
// lines into a real dump), and username-bearing paths in the fields the reader must never read.
const FAKE_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-TEST";
const FAKE_EMAIL = "someone.test@example.invalid";
const ORG_KEY = "ACME_INTERNAL_BILLING_ID";
const SECRET_SHAPED = "SECRET_SHAPED_VALUE_TEST";

const ts = (d: string) => `${d} [info]`;
const startApp = (when: string, appVersion: string) =>
  [`${ts(when)} Starting app {`, `  appVersion: '${appVersion}',`, "  isPackaged: true,", "  platform: 'darwin',", "}"].join("\n");
const session = (when: string) => `${ts(when)} [Lifecycle] Session local_00000000-0000-4000-8000-000000000000: initializing → running`;

interface DumpOpts {
  when: string;
  keys: string[];
  agent?: string;
  layout?: "flat" | "build";
  plugins?: number;
  perLine?: number;
  trailer?: number | null; // null = omit the trailer (truncated)
  extraItems?: string[]; // raw item text, e.g. "'x=y'"
  more?: number; // util.inspect's "... N more items"
}
function dump(o: DumpOpts): string {
  const agent = o.agent ?? "2.1.295";
  const app = o.layout === "flat" ? `claude-code/${agent}/claude.app` : `claude-code/${agent}/0123456789ab/claude.app`;
  const lines = [
    `${ts(o.when)} [HostLoop] sdkOptions after patch: {`,
    `  cwd: '/Users/someone/${FAKE_TOKEN}',`,
    "  executable: '/Applications/Claude.app/Contents/Helpers/disclaimer',",
    "  executableArgs: [",
    "    '--',",
    `    '/Users/someone/Library/Application Support/Claude/${app}/Contents/MacOS/claude',`,
    `    '--email=${FAKE_EMAIL}',`,
    "    [length]: 3",
    "  ],",
    "  plugins: [",
  ];
  for (let i = 0; i < (o.plugins ?? 140); i++) lines.push(`    { type: 'local', path: '/Users/someone/plugins/p${i}' },`);
  lines.push(`    [length]: ${o.plugins ?? 140}`, "  ],");
  const items = [...o.keys.map((k) => `'${k}'`), ...(o.extraItems ?? [])];
  if (items.length === 0 && o.trailer !== null) {
    lines.push("  envKeys: [ [length]: 0 ],");
  } else {
    lines.push("  envKeys: [");
    const per = o.perLine ?? 3;
    for (let i = 0; i < items.length; i += per) lines.push(`    ${items.slice(i, i + per).join(", ")},`);
    if (o.more) lines.push(`    ... ${o.more} more items`);
    if (o.trailer !== null) lines.push(`    [length]: ${o.trailer ?? items.length + (o.more ?? 0)}`, "  ],");
  }
  if (o.trailer !== null) {
    lines.push(`  CLAUDE_CONFIG_DIR: '/Users/someone/${FAKE_TOKEN}',`, `  model: '${SECRET_SHAPED}',`, "  autoMemoryHostDir: null", "}");
  }
  return lines.join("\n");
}

const CORE = ["CLAUDE_CODE_IS_COWORK", "CLAUDE_CODE_TAGS", "PATH", "HOME", "TZ"];

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function logsDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "oracle-logs-"));
  dirs.push(d);
  mkdirSync(d, { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t + "\n");
  return d;
}
const productNames = new Set([
  ...CORE,
  "CLAUDE_CODE_UNCLASSIFIED_TEST",
  "CLAUDE_CODE_SKILL_ATTRIBUTION",
  "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
]);
const input = (logs: string, over: Partial<ObservedSpawnEnvInput> = {}): ObservedSpawnEnvInput => ({
  logsDir: logs,
  appVersion: "2.31226.1",
  installedAtMs: null,
  bundle: { hasProducer: true, hasProductName: (n) => productNames.has(n) },
  previous: null,
  declare: null,
  ...over,
});
const everything = (r: ReturnType<typeof readObservedSpawnEnv>) => JSON.stringify(r);

describe("observed spawn-env oracle — privacy", () => {
  it("commits no value, no path, no org-defined name; withholds by COUNT and names only Desktop vocabulary locally", () => {
    const logs = logsDir({
      "main1.log": startApp("2026-10-09 22:46:06", "2.31226.1"),
      "main.log": [
        session("2026-10-10 11:28:40"),
        dump({ when: "2026-10-10 11:28:43", keys: [...CORE, ORG_KEY, "CLAUDE_CODE_UNCLASSIFIED_TEST"], extraItems: [`'${FAKE_TOKEN}'`] }),
      ].join("\n"),
    });
    const r = readObservedSpawnEnv(input(logs));
    const committed = JSON.stringify(r.block);
    for (const leak of [FAKE_TOKEN, FAKE_EMAIL, ORG_KEY, SECRET_SHAPED, "CLAUDE_CODE_UNCLASSIFIED_TEST", "/Users/"])
      expect(committed).not.toContain(leak);
    for (const leak of [FAKE_TOKEN, FAKE_EMAIL, ORG_KEY, SECRET_SHAPED, "/Users/"]) expect(everything(r)).not.toContain(leak);
    expect(r.block).toMatchObject({ observed: true, withheld: 1 });
    // Desktop vocabulary that nobody classified: a LOCAL write-blocking delta that may name it.
    expect(r.deltas.some((d) => d.includes("CLAUDE_CODE_UNCLASSIFIED_TEST"))).toBe(true);
    // The fake token as an envKeys item is not key-shaped: a malformed delta, counted, never quoted.
    expect(r.deltas.some((d) => /malformed/.test(d))).toBe(true);
    expect(ObservedSpawnEnv.safeParse(r.block).success).toBe(true);
  });

  it("holds no value: a key-shaped value outside envKeys is never retained", () => {
    const text = dump({ when: "2026-10-10 11:28:43", keys: CORE });
    const parsed = parseDesktopLogLines([startApp("2026-10-09 22:46:06", "2.31226.1"), ...text.split("\n")]);
    const all = JSON.stringify(parsed, (_k, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v] : v));
    expect(all).not.toContain(SECRET_SHAPED);
    expect(all).not.toContain(FAKE_TOKEN);
    expect(all).not.toContain("/Users/");
    // Structural: every string the parser keeps is either a key name or a strict version string.
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (v instanceof Set || Array.isArray(v)) for (const x of v) walk(x);
      else if (v instanceof Map) for (const [k, x] of v) (walk(k), walk(x));
      else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    walk(parsed);
    for (const s of strings) expect(s, s).toMatch(/^(?:[A-Z][A-Z0-9_]{0,127}|\d+\.\d+\.\d+|ok|incomplete|empty|malformed)$/);
  });
});

describe("observed spawn-env oracle — dump format", () => {
  it("reads envKeys after a long plugins list (envKeys ~140+ lines into the record)", () => {
    const logs = logsDir({
      "main1.log": startApp("2026-10-09 22:46:06", "2.31226.1"),
      "main.log": dump({ when: "2026-10-10 11:28:43", keys: CORE, plugins: 200 }),
    });
    const r = readObservedSpawnEnv(input(logs));
    expect(r.block).toMatchObject({ observed: true, sessions: 1 });
    expect(r.block.observed && r.block.keysAll).toEqual([...CORE].sort());
  });

  it("splits multi-item lines and checks the [length] trailer", () => {
    const p = parseDesktopLogLines([
      startApp("2026-10-09 22:46:06", "2.31226.1"),
      ...dump({ when: "2026-10-10 11:00:00", keys: CORE, perLine: 4 }).split("\n"),
    ]);
    expect(p.dumps).toHaveLength(1);
    expect(p.dumps[0].status).toBe("ok");
    expect([...p.dumps[0].names].sort()).toEqual([...CORE].sort());
  });

  it("marks a trailer that disagrees with the item count, '... N more items', an empty list and a truncated record", () => {
    const lines = [
      startApp("2026-10-09 22:46:06", "2.31226.1"),
      dump({ when: "2026-10-10 11:00:00", keys: CORE, trailer: 99 }),
      dump({ when: "2026-10-10 11:01:00", keys: CORE, more: 30 }),
      dump({ when: "2026-10-10 11:02:00", keys: [] }),
      dump({ when: "2026-10-10 11:03:00", keys: CORE, trailer: null }),
    ].join("\n");
    const p = parseDesktopLogLines(lines.split("\n"));
    expect(p.dumps.map((d) => d.status)).toEqual(["incomplete", "incomplete", "empty", "incomplete"]);
  });

  it("captures the native agent version from both executableArgs layouts", () => {
    const lines = [
      startApp("2026-10-09 22:46:06", "2.31226.1"),
      dump({ when: "2026-10-10 11:00:00", keys: CORE, agent: "2.1.281", layout: "flat" }),
      dump({ when: "2026-10-10 11:01:00", keys: CORE, agent: "2.1.295", layout: "build" }),
    ].join("\n");
    expect(parseDesktopLogLines(lines.split("\n")).dumps.map((d) => d.agentVersion)).toEqual(["2.1.281", "2.1.295"]);
  });
});

describe("observed spawn-env oracle — attribution to a Desktop build", () => {
  it("attributes each dump to the preceding 'Starting app' across rotated files, oldest file first", () => {
    const logs = logsDir({
      "main2.log": [
        startApp("2026-10-07 21:06:19", "2.26454.2"),
        dump({ when: "2026-10-08 10:00:00", keys: [...CORE, "CLAUDE_CODE_SKILL_ATTRIBUTION"] }),
      ].join("\n"),
      "main1.log": startApp("2026-10-09 22:46:06", "2.31226.1"),
      "main.log": dump({ when: "2026-10-10 11:28:43", keys: CORE }),
      "main-window.log": dump({ when: "2026-10-10 12:00:00", keys: [...CORE, "CLAUDE_CODE_WORKSPACE_HOST_PATHS"] }),
    });
    const r = readObservedSpawnEnv(input(logs));
    expect(r.block).toMatchObject({ observed: true, sessions: 1 });
    expect(r.block.observed && r.block.keysAll).toEqual([...CORE].sort());
  });

  it("splits keys present in every dump from keys in some", () => {
    const logs = logsDir({
      "main.log": [
        startApp("2026-10-09 22:46:06", "2.31226.1"),
        dump({ when: "2026-10-10 11:00:00", keys: CORE }),
        dump({ when: "2026-10-10 12:00:00", keys: [...CORE, "CLAUDE_CODE_WORKSPACE_HOST_PATHS"] }),
      ].join("\n"),
    });
    const r = readObservedSpawnEnv(input(logs));
    expect(r.block.observed && r.block.keysSome).toEqual(["CLAUDE_CODE_WORKSPACE_HOST_PATHS"]);
  });

  it("falls back to the install time (parsed as LOCAL wall-clock) only when no 'Starting app' precedes the dump", () => {
    const at = new Date(2026, 9, 10, 11, 0, 0).getTime();
    const logs = logsDir({
      "main.log": [dump({ when: "2026-10-10 10:59:59", keys: ["PATH"] }), dump({ when: "2026-10-10 11:00:01", keys: CORE })].join("\n"),
    });
    const r = readObservedSpawnEnv(input(logs, { installedAtMs: at }));
    expect(r.block.observed && r.block.keysAll).toEqual([...CORE].sort());
    expect(r.notes.some((n) => /install time/.test(n))).toBe(true);
  });
});

describe("observed spawn-env oracle — when no dump exists for this build", () => {
  it("records no-session with a WARNING when nothing ran", () => {
    const r = readObservedSpawnEnv(input(logsDir({ "main.log": startApp("2026-10-09 22:46:06", "2.31226.1") })));
    expect(r.block).toEqual({ observed: false, appVersion: "2.31226.1", reason: "no-session" });
    expect(r.deltas).toEqual([]);
    expect(r.notes.some((n) => /WARNING/.test(n))).toBe(true);
  });

  it("is a write-blocking parse failure when dumps exist for the build but none is readable", () => {
    const logs = logsDir({
      "main.log": [startApp("2026-10-09 22:46:06", "2.31226.1"), dump({ when: "2026-10-10 11:00:00", keys: CORE, trailer: 99 })].join("\n"),
    });
    const r = readObservedSpawnEnv(input(logs));
    expect(r.deltas.some((d) => /none could be read/.test(d))).toBe(true);
  });

  it("blocks when Desktop no longer carries the producer log line", () => {
    const r = readObservedSpawnEnv(input(logsDir({ "main.log": "" }), { bundle: { hasProducer: false, hasProductName: () => true } }));
    expect(r.deltas.some((d) => /producer/.test(d))).toBe(true);
  });

  it("records a lane-gone declaration only when no session and no dump exist for the build", () => {
    const quiet = logsDir({ "main.log": startApp("2026-10-09 22:46:06", "2.31226.1") });
    expect(readObservedSpawnEnv(input(quiet, { declare: "local-lane-removed" })).block).toEqual({
      observed: false,
      appVersion: "2.31226.1",
      reason: "lane-gone",
      declared: "local-lane-removed",
    });
    const busy = logsDir({ "main.log": [startApp("2026-10-09 22:46:06", "2.31226.1"), session("2026-10-10 11:00:00")].join("\n") });
    const r = readObservedSpawnEnv(input(busy, { declare: "local-lane-removed" }));
    expect(r.deltas.some((d) => /refus/.test(d))).toBe(true);
    const withDump = logsDir({
      "main.log": [startApp("2026-10-09 22:46:06", "2.31226.1"), dump({ when: "2026-10-10 11:00:00", keys: CORE })].join("\n"),
    });
    expect(readObservedSpawnEnv(input(withDump, { declare: "local-lane-removed" })).deltas.some((d) => /refus/.test(d))).toBe(true);
  });

  it("does not inherit a lane-gone declaration from the previous baseline", () => {
    const r = readObservedSpawnEnv(
      input(logsDir({ "main.log": "" }), {
        previous: { observed: false, appVersion: "2.31226.0", reason: "lane-gone", declared: "local-lane-removed" },
      }),
    );
    expect(r.block).toMatchObject({ observed: false, reason: "no-session" });
  });

  it("carries an observed block forward for the SAME Desktop build after its logs rotated away", () => {
    const prev = {
      observed: true as const,
      appVersion: "2.31226.1",
      nativeAgentVersions: ["2.1.295"],
      sessions: 3,
      keysAll: [...CORE].sort(),
      keysSome: [],
      withheld: 0,
    };
    expect(readObservedSpawnEnv(input(logsDir({ "main.log": "" }), { previous: prev })).block).toEqual(prev);
    expect(
      readObservedSpawnEnv(input(logsDir({ "main.log": "" }), { previous: { ...prev, appVersion: "2.31226.0" } })).block,
    ).toMatchObject({
      observed: false,
      reason: "no-session",
    });
  });
});

describe("producer check", () => {
  it("needs the full logged literal with its ': %o' tail and the envKeys construction", () => {
    const real = 'N.info("[HostLoop] sdkOptions after patch: %o",{...x,envKeys:e.env?Object.keys(e.env).sort():[]})';
    expect(bundleHasSpawnEnvProducer(real)).toBe(true);
    expect(bundleHasSpawnEnvProducer(real.replace(": %o", ""))).toBe(false);
    expect(bundleHasSpawnEnvProducer(real.replace("envKeys:", "keys:"))).toBe(false);
  });
});

describe("observed spawn-env oracle — comparison with the harness host-loop env", () => {
  const observed = (keysAll: string[], keysSome: string[] = []): ObservedSpawnEnv => ({
    observed: true,
    appVersion: "2.31226.1",
    nativeAgentVersions: ["2.1.295"],
    sessions: 2,
    keysAll,
    keysSome,
    withheld: 0,
  });

  it("blocks when a key the registry calls pinned or harness-set is missing from what the harness spawns", () => {
    const r = checkObservedAgainstHarness(observed(["CLAUDE_CODE_IS_COWORK", "TZ", "PATH"]), new Set(["TZ"]));
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas[0]).toContain("CLAUDE_CODE_IS_COWORK");
    // host-inherited / host-derived keys are not the harness's to set in this comparison
    expect(r.deltas.join()).not.toContain("PATH");
  });

  it("notes harness-only keys by registry name only, never an unregistered name", () => {
    const r = checkObservedAgainstHarness(observed(["TZ"]), new Set(["TZ", "CLAUDE_CODE_SIMPLE", "TEST_SHELL_ONLY"]));
    expect(r.deltas).toEqual([]);
    expect(r.notes.join()).toContain("CLAUDE_CODE_SIMPLE");
    expect(r.notes.join()).not.toContain("TEST_SHELL_ONLY");
  });

  it("does nothing for an unobserved block", () => {
    expect(checkObservedAgainstHarness({ observed: false, appVersion: "2.31226.1", reason: "no-session" }, new Set())).toEqual({
      deltas: [],
      notes: [],
    });
  });

  it("builds the harness side from an EMPTY operator env, so the maintainer's shell never enters the comparison", () => {
    process.env.TEST_SHELL_ONLY = "1";
    try {
      const keys = harnessHostLoopKeys(loadBaseline("latest"));
      expect(keys.has("TEST_SHELL_ONLY")).toBe(false);
      expect(keys.has("PATH")).toBe(false);
      for (const k of ["CLAUDE_CODE_IS_COWORK", "TZ", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_WORKSPACE_HOST_PATHS"])
        expect(keys.has(k), k).toBe(true);
    } finally {
      delete process.env.TEST_SHELL_ONLY;
    }
  });
});

// Over the operator's real Desktop logs (opt-in: COWORK_DESKTOP_LOGS_DIR=~/Library/Logs/Claude, plus the Desktop
// version to attribute to). Never on CI. Asserts the reader observes the build and that nothing private survives.
const REAL_LOGS = process.env.COWORK_DESKTOP_LOGS_DIR;
const REAL_APP = process.env.COWORK_DESKTOP_APP_VERSION;
describe.skipIf(!REAL_LOGS || !REAL_APP)("observed spawn-env oracle over real Desktop logs (COWORK_DESKTOP_LOGS_DIR)", () => {
  it("observes the build, and its output carries no path, no email and no unclassified name", () => {
    const r = readObservedSpawnEnv({
      logsDir: REAL_LOGS!,
      appVersion: REAL_APP!,
      installedAtMs: null,
      bundle: { hasProducer: true, hasProductName: () => false },
      previous: null,
      declare: null,
    });
    expect(r.block.observed).toBe(true);
    const out = JSON.stringify(r);
    expect(out).not.toContain("/Users/");
    expect(out).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});

describe("observed spawn-env oracle — review regressions", () => {
  const startNoVersion = (when: string) => [`${ts(when)} Starting app {`, "  version: 'x',", "  isPackaged: true,", "}"].join("\n");

  it("a 'Starting app' entry without its appVersion never lets the previous build attribute what follows", () => {
    const logs = logsDir({
      "main.log": [
        startApp("2026-10-09 04:35:07", "2.31226.0"),
        startNoVersion("2026-10-09 22:46:06"),
        session("2026-10-10 11:00:00"),
        dump({ when: "2026-10-10 11:00:01", keys: CORE }),
      ].join("\n"),
    });
    // Synced build 2.31226.1: the dump must not be credited to 2.31226.0, and the drift must block.
    const r = readObservedSpawnEnv(input(logs, { declare: "local-lane-removed" }));
    expect(r.deltas.some((d) => /no appVersion line/.test(d))).toBe(true);
    const asOld = readObservedSpawnEnv(input(logs, { appVersion: "2.31226.0" }));
    expect(asOld.block).toMatchObject({ observed: false, reason: "no-session" });
  });

  it("records a lane-gone declaration when the producer is gone, instead of leaving only --allow-empty", () => {
    const r = readObservedSpawnEnv(
      input(logsDir({ "main.log": startApp("2026-10-09 22:46:06", "2.31226.1") }), {
        bundle: { hasProducer: false, hasProductName: () => true },
        declare: "local-lane-removed",
      }),
    );
    expect(r.deltas).toEqual([]);
    expect(r.block).toEqual({ observed: false, appVersion: "2.31226.1", reason: "lane-gone", declared: "local-lane-removed" });
  });

  it("classifies the standard proxy names, and notes a default-absent key that every session carries", () => {
    for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"])
      expect(classifySpawnEnvKey(k, "observed")?.class).toBe("host-loop-unmodeled");
    const block: ObservedSpawnEnv = {
      observed: true,
      appVersion: "2.31226.1",
      nativeAgentVersions: [],
      sessions: 2,
      keysAll: ["CLAUDE_CODE_HOST_SCHEDULED_RUN"],
      keysSome: [],
      withheld: 0,
    };
    expect(checkObservedAgainstHarness(block, new Set()).notes.join()).toMatch(
      /CLAUDE_CODE_HOST_SCHEDULED_RUN is classed session-conditional/,
    );
  });
});

describe("observed spawn-env oracle — final-review regressions", () => {
  const busyNoDump = () =>
    logsDir({ "main.log": [startApp("2026-10-09 22:46:06", "2.31226.1"), session("2026-10-10 11:00:00")].join("\n") });

  it("blocks when local sessions ran under the build but none logged a dump, and never carries an old observation over it", () => {
    const prev: ObservedSpawnEnv = {
      observed: true,
      appVersion: "2.31226.1",
      nativeAgentVersions: ["2.1.295"],
      sessions: 3,
      keysAll: [...CORE].sort(),
      keysSome: [],
      withheld: 0,
    };
    const r = readObservedSpawnEnv(input(busyNoDump(), { previous: prev }));
    expect(r.deltas.some((d) => /none logged a host-loop dump/.test(d))).toBe(true);
    expect(r.block).toMatchObject({ observed: false, reason: "no-session" });
  });

  it("refuses a declaration when the producer is gone but local sessions still ran", () => {
    const r = readObservedSpawnEnv(
      input(busyNoDump(), { bundle: { hasProducer: false, hasProductName: () => true }, declare: "local-lane-removed" }),
    );
    expect(r.block).toMatchObject({ observed: false, reason: "no-session" });
    expect(r.deltas.some((d) => /refusing --spawn-env-unobservable/.test(d))).toBe(true);
  });

  it("refuses a declaration with no 'Starting app' entry for the build, and blocks logs it cannot read at all", () => {
    expect(readObservedSpawnEnv(input(logsDir({ "main.log": "" }), { declare: "local-lane-removed" })).deltas.join()).toMatch(
      /no 'Starting app' entry for Desktop 2\.31226\.1/,
    );
    const alien = logsDir({ "main.log": "[10/10/2026, 11:00:00] info: something\n[10/10/2026, 11:00:01] info: more" });
    const r = readObservedSpawnEnv(input(alien, { declare: "local-lane-removed" }));
    expect(r.deltas.some((d) => /no line this reader recognises/.test(d))).toBe(true);
    expect(r.block).toMatchObject({ observed: false, reason: "no-session" });
  });

  it("blocks when no selected dump names the agent it launched", () => {
    const text = dump({ when: "2026-10-10 11:00:01", keys: CORE }).replace(/claude-code\/[^']*claude\.app/, "somewhere/else.app");
    const r = readObservedSpawnEnv(input(logsDir({ "main.log": [startApp("2026-10-09 22:46:06", "2.31226.1"), text].join("\n") })));
    expect(r.deltas.some((d) => /named the agent/.test(d))).toBe(true);
  });
});

describe("readPreviousObservedSpawnEnv", () => {
  it("reads the NEWEST baseline's block, and returns null for an invalid one", () => {
    const d = mkdtempSync(join(tmpdir(), "oracle-baselines-"));
    dirs.push(d);
    const block = (appVersion: string) => ({
      provenance: { observedSpawnEnv: { observed: false, appVersion, reason: "no-session" } },
    });
    writeFileSync(join(d, "desktop-2.9939.4.json"), JSON.stringify(block("2.9939.4")));
    writeFileSync(join(d, "desktop-2.31226.1.json"), JSON.stringify(block("2.31226.1")));
    expect(readPreviousObservedSpawnEnv(d)).toEqual({ observed: false, appVersion: "2.31226.1", reason: "no-session" });
    writeFileSync(join(d, "desktop-2.31226.2.json"), JSON.stringify({ provenance: { observedSpawnEnv: { observed: true } } }));
    expect(readPreviousObservedSpawnEnv(d)).toBeNull();
  });
});

describe("observed spawn-env oracle — the committed 2.31226.1 observation", () => {
  // A note should mean something new. Both keys below are in every observed session and are left unset on purpose,
  // so comparing the committed observation with the harness must print nothing about them, and no default-absent note.
  it("prints no note for a known, triaged key", () => {
    const b = JSON.parse(readFileSync(join("baselines", "desktop-2.31226.1.json"), "utf8"));
    const block = ObservedSpawnEnv.parse(b.provenance.observedSpawnEnv);
    expect(block.observed && block.keysAll).toEqual(
      expect.arrayContaining(["CLAUDE_CODE_COWORK_FRAME_ARTIFACTS", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"]),
    );
    const r = checkObservedAgainstHarness(block, harnessHostLoopKeys(loadBaseline("desktop-2.31226.1")));
    expect(r.deltas).toEqual([]);
    const notes = r.notes.join("\n");
    expect(notes).not.toMatch(/absent by default/);
    expect(notes).not.toContain("CLAUDE_CODE_COWORK_FRAME_ARTIFACTS");
    expect(notes).not.toContain("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD");
    for (const k of ["CLAUDE_CODE_COWORK_FRAME_ARTIFACTS", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"])
      expect(classifySpawnEnvKey(k, "observed")?.class, k).toBe("deliberately-unset");
  });
});

// A dump cannot name its session, so the only kind it shows is "scheduled", from the key Desktop sets on a
// scheduled-task session alone; every other dump is counted as unknown.
describe("observed spawn-env oracle — session kinds", () => {
  const read = (keys: string[]) =>
    readObservedSpawnEnv(
      input(
        logsDir({
          "main1.log": startApp("2026-10-09 22:46:06", "2.31226.1"),
          "main.log": [session("2026-10-10 11:28:40"), dump({ when: "2026-10-10 11:28:43", keys })].join("\n"),
        }),
      ),
    );
  it("a dump carrying the scheduled-run key counts as scheduled, and that key is not reported as misclassified", () => {
    const r = read([...CORE, "CLAUDE_CODE_HOST_SCHEDULED_RUN"]);
    expect(r.block).toMatchObject({ observed: true, sessionKinds: { interactive: 0, scheduled: 1, other: 0, unknown: 0 } });
    expect(r.block.observed && r.block.keysAll).toContain("CLAUDE_CODE_HOST_SCHEDULED_RUN");
    expect(r.notes.join("\n")).not.toMatch(/CLAUDE_CODE_HOST_SCHEDULED_RUN is classed/);
    expect(ObservedSpawnEnv.safeParse(r.block).success).toBe(true);
  });
  it("a dump without it is unknown, never assumed interactive", () => {
    expect(read([...CORE]).block).toMatchObject({ sessionKinds: { interactive: 0, scheduled: 0, other: 0, unknown: 1 } });
  });
});

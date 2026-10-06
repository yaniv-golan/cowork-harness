import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDesktopInitSurface,
  desktopInstalledAtMs,
  DESKTOP_SESSIONS_DISPLAY,
  type InitSurfaceInput,
} from "../src/sync/desktop-init-surface.js";
import { DESKTOP_OWN_SERVERS, DesktopInitSurface } from "../src/types.js";

// Every frame here is SYNTHETIC. Bait names use reserved shapes only — UUIDs of the form
// 00000000-0000-4000-8000-0000000000NN and server names starting `fixture-` — and the last describe
// block enforces that over this file, so a real connector id or server name pasted in from a local log
// fails CI instead of being published.

const AGENT = "9.9.100";
const INSTALLED = Date.parse("2026-09-20T00:00:00.000Z");
const AFTER = "2026-09-21T10:00:00.000Z";
const BEFORE = "2026-09-19T10:00:00.000Z";

const BAIT = {
  connector: "00000000-0000-4000-8000-000000000001",
  userServer: "fixture-private-crm",
  userTool: "fixture_crm_lookup",
  shadowTool: "fixture_shadow_tool",
  doubleServer: "cowork__fixturex",
  email: "fixture-person@example.invalid",
  cwd: "/Users/fixture-user/secret-project",
  sessionId: "00000000-0000-4000-8000-000000000002",
} as const;

/** Desktop tool names the synthetic "bundle" defines as quoted literals. */
const BUNDLE = new Set([
  "save_skill",
  "present_files",
  "create_artifact",
  "list_skills",
  "list_plugins",
  // Each EXCLUDED frame below carries one of these. They are valid Desktop names, so if a filter
  // regressed and admitted that frame, its marker would surface in the output — the exclusion tests can fail.
  "marker_no_hmac",
  "marker_other_agent",
  "marker_pre_install",
  "marker_failed_status",
  "marker_not_init",
  "marker_sibling_file",
  "marker_symlinked",
  // Defined here so the ANCHOR, not G3, is the only thing that can keep `mcp__cowork__fixturex__leak`
  // out — otherwise an unanchored split would still pass the anchor test via the bundle check.
  "fixturex__leak",
]);
const bundleHasLiteral = (n: string) => BUNDLE.has(n);

type Srv = { name: string; status?: string };
function frame(opts: { servers: Srv[]; tools: string[]; agent?: string; ts?: string; hmac?: boolean; subtype?: string }): string {
  const f: Record<string, unknown> = {
    type: "system",
    subtype: opts.subtype ?? "init",
    claude_code_version: opts.agent ?? AGENT,
    cwd: BAIT.cwd,
    session_id: BAIT.sessionId,
    mcp_servers: opts.servers.map((s) => ({ name: s.name, status: s.status ?? "connected" })),
    tools: ["Bash", "Read", ...opts.tools],
    timestamp: opts.ts ?? AFTER,
    _audit_timestamp: opts.ts ?? AFTER,
  };
  if (opts.hmac !== false) f._audit_hmac = "ab".repeat(32);
  return JSON.stringify(f);
}

const own = (n: string): Srv => ({ name: n });
const fullServers: Srv[] = [
  own("cowork"),
  own("plugins"),
  own("skills"),
  { name: BAIT.connector },
  { name: BAIT.userServer },
  { name: "workspace" },
];
const fullTools = [
  "mcp__cowork__save_skill",
  "mcp__cowork__present_files",
  "mcp__cowork__create_artifact",
  "mcp__plugins__list_plugins",
  "mcp__skills__list_skills",
  `mcp__${BAIT.userServer}__${BAIT.userTool}`,
  `mcp__${BAIT.connector}__search`,
  "mcp__workspace__web_fetch",
];

let root: string;
let corpus: string;
let outside: string;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function put(rel: string, lines: string[]) {
  const p = join(corpus, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, lines.join("\n") + "\n");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "init-surface-"));
  corpus = join(root, "local-agent-mode-sessions");
  outside = join(root, "outside");
  // Session A: the full 14-tool-like kind (artifact tool present).
  put("acct/org/local_a/audit.jsonl", [
    JSON.stringify({ type: "user", subtype: "x" }),
    frame({ servers: fullServers, tools: fullTools }),
    "{not json at all",
  ]);
  // Session B: the "10-tool" kind — no artifact tool, and `skills` not connected.
  put("acct/org/local_b/audit.jsonl", [
    frame({
      servers: [own("cowork"), own("plugins"), { name: "skills", status: "pending" }, { name: BAIT.connector }],
      tools: ["mcp__cowork__save_skill", "mcp__cowork__present_files", "mcp__plugins__list_plugins"],
    }),
  ]);
  // Excluded frames, one per filter, each carrying a marker tool that would surface if admitted.
  put("acct/org/local_c/audit.jsonl", [
    frame({ servers: [own("cowork")], tools: ["mcp__cowork__marker_no_hmac"], hmac: false }),
    frame({ servers: [own("cowork")], tools: ["mcp__cowork__marker_other_agent"], agent: "9.9.99" }),
    frame({ servers: [own("cowork")], tools: ["mcp__cowork__marker_pre_install"], ts: BEFORE }),
    frame({ servers: [own("cowork")], tools: ["mcp__cowork__marker_not_init"], subtype: "status" }),
  ]);
  // A session where `cowork` FAILED to connect: its tools must not be attributed.
  put("acct/org/local_d/audit.jsonl", [
    frame({
      servers: [{ name: "cowork", status: "failed" }, own("plugins")],
      tools: ["mcp__cowork__marker_failed_status", "mcp__plugins__list_plugins"],
    }),
  ]);
  // A server NAMED `cowork__fixturex` (latent, 0 in the real corpus): `mcp__cowork__fixturex__leak`
  // must not be read as a cowork tool `fixturex__leak`.
  put("acct/org/local_e/audit.jsonl", [
    frame({
      servers: [own("cowork"), own("plugins"), own("skills"), { name: BAIT.doubleServer }],
      tools: [
        "mcp__cowork__save_skill",
        "mcp__cowork__present_files",
        "mcp__plugins__list_plugins",
        "mcp__skills__list_skills",
        `mcp__${BAIT.doubleServer}__leak`,
      ],
    }),
  ]);
  // Sibling metadata in the SAME tree (real ones carry email/cwd/system prompt) — must never be opened,
  // even though it holds a line that would pass every frame filter.
  put("acct/org/local_f.json", [
    JSON.stringify({ emailAddress: BAIT.email, cwd: BAIT.cwd }),
    frame({ servers: [own("cowork")], tools: ["mcp__cowork__marker_sibling_file"] }),
  ]);
  // A symlinked directory pointing outside the tree — must not be followed.
  mkdirSync(join(outside, "x"), { recursive: true });
  writeFileSync(join(outside, "x", "audit.jsonl"), frame({ servers: [own("cowork")], tools: ["mcp__cowork__marker_symlinked"] }) + "\n");
  symlinkSync(join(outside, "x"), join(corpus, "acct", "linked"));
  // An unreadable log: counted, never named.
  put("acct/org/local_g/audit.jsonl", [frame({ servers: [own("cowork")], tools: [] })]);
  chmodSync(join(corpus, "acct/org/local_g/audit.jsonl"), 0o000);
});

afterAll(() => {
  try {
    chmodSync(join(corpus, "acct/org/local_g/audit.jsonl"), 0o644);
  } catch {
    /* already gone */
  }
  rmSync(root, { recursive: true, force: true });
});

const input = (over: Partial<InitSurfaceInput> = {}): InitSurfaceInput => ({
  dir: corpus,
  agentVersion: AGENT,
  appVersion: "9.100.0",
  installedAtMs: INSTALLED,
  bundleHasLiteral,
  ...over,
});

/** Everything the reader lets escape: the returned block AND every message. */
const everythingEmitted = (r: ReturnType<typeof readDesktopInitSurface>) =>
  JSON.stringify({ surface: r.surface, notes: r.notes, deltas: r.deltas });

describe("readDesktopInitSurface — selection and the recorded block", () => {
  it("records only Desktop's own servers, with the all/some split, from the frames that pass every filter", () => {
    const r = readDesktopInitSurface(input());
    expect(r.framesSelected).toBe(4); // local_a, local_b, local_d, local_e
    expect(r.surface).toEqual({
      agentVersion: AGENT,
      appVersion: "9.100.0",
      observed: true,
      servers: {
        cowork: { presence: "some", toolsAll: ["present_files", "save_skill"], toolsSome: ["create_artifact"] },
        plugins: { presence: "all", toolsAll: ["list_plugins"], toolsSome: [] },
        skills: { presence: "some", toolsAll: ["list_skills"], toolsSome: [] },
      },
    });
    expect(DesktopInitSurface.safeParse(r.surface).success).toBe(true);
    expect(r.deltas).toEqual([]);
  });

  it("admits NO excluded frame: no hmac, another agent, pre-install, not-init, failed status, sibling file, symlink", () => {
    const out = everythingEmitted(readDesktopInitSurface(input()));
    for (const m of [
      "marker_no_hmac",
      "marker_other_agent",
      "marker_pre_install",
      "marker_not_init",
      "marker_failed_status",
      "marker_sibling_file",
      "marker_symlinked",
    ])
      expect(out, m).not.toContain(m);
  });

  it("anchors the tool split on both sides: a server named cowork__x contributes nothing to cowork", () => {
    const out = everythingEmitted(readDesktopInitSurface(input()));
    expect(out).not.toContain("fixturex");
    expect(out).not.toContain("leak");
  });

  it("counts the excluded inventory without naming it", () => {
    const r = readDesktopInitSurface(input());
    // local_a: connector + user server + workspace; local_b: connector; local_e: the cowork__x server.
    expect(r.excludedServers).toBe(5);
    expect(r.notes.join("\n")).toMatch(/excluded 5 non-Desktop server entries/);
  });

  it.skipIf(isRoot)("counts an unreadable log in a note that names no path", () => {
    const r = readDesktopInitSurface(input());
    expect(r.unreadableFiles).toBe(1);
    expect(r.notes.join("\n")).toMatch(/1 session-log file\(s\)\/dir\(s\) unreadable/);
  });
});

describe("readDesktopInitSurface — privacy: nothing but the allowlist and counts escapes (P5)", () => {
  it("emits no bait string, no home path and no corpus path in the block, notes or deltas", () => {
    const out = everythingEmitted(readDesktopInitSurface(input()));
    for (const b of Object.values(BAIT)) expect(out, b).not.toContain(b);
    expect(out).not.toContain("workspace");
    expect(out).not.toContain("web_fetch");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain(root);
  });

  it("a tool on a Desktop server that the bundle does not define is dropped and flagged WITHOUT its name (G3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "init-surface-shadow-"));
    try {
      mkdirSync(join(dir, "a"), { recursive: true });
      writeFileSync(
        join(dir, "a", "audit.jsonl"),
        frame({ servers: [own("cowork")], tools: ["mcp__cowork__save_skill", `mcp__cowork__${BAIT.shadowTool}`] }) + "\n",
      );
      const r = readDesktopInitSurface(input({ dir }));
      expect(r.surface.servers.cowork?.toolsAll).toEqual(["save_skill"]);
      expect(r.deltas).toHaveLength(1);
      expect(r.deltas[0]).toMatch(/1 tool name\(s\) on server "cowork" are not a quoted literal in the Desktop bundle/);
      expect(everythingEmitted(r)).not.toContain(BAIT.shadowTool);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("G3 negative control: a name absent from the bundle really is reported absent", () => {
    expect(bundleHasLiteral("save_skill")).toBe(true);
    expect(bundleHasLiteral(BAIT.shadowTool)).toBe(false);
  });

  it("with the bundle unavailable, records no tool names and raises a write-blocking delta", () => {
    const r = readDesktopInitSurface(input({ bundleHasLiteral: null }));
    for (const s of Object.values(r.surface.servers)) expect([...s!.toolsAll, ...s!.toolsSome]).toEqual([]);
    expect(r.deltas.length).toBeGreaterThan(0);
    expect(r.deltas.every((d) => d.includes("cannot verify"))).toBe(true);
  });
});

describe("readDesktopInitSurface — mutation: a widened filter is caught (P4)", () => {
  const widened = () => readDesktopInitSurface(input({ isOwnServer: () => true }));

  it("the bait corpus DOES leak through an accept-all filter — so the privacy assertions above can fail", () => {
    const out = everythingEmitted(widened());
    expect(out).toContain(BAIT.userServer);
    expect(out).toContain(BAIT.connector);
  });

  it("and the strict schema that guards every write and every committed baseline rejects the widened block", () => {
    expect(DesktopInitSurface.safeParse(widened().surface).success).toBe(false);
  });
});

describe("readDesktopInitSurface — missing or stale frames", () => {
  const unobservedChecks = (r: ReturnType<typeof readDesktopInitSurface>, agentVersion = AGENT) => {
    expect(r.surface).toEqual({ agentVersion, appVersion: "9.100.0", observed: false, servers: {} });
    expect(r.framesSelected).toBe(0);
    // A WARNING, never a delta: a delta would need --allow-empty, which waives every other sync guard.
    expect(r.deltas).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/^WARNING: desktopInitSurface UNOBSERVED/m);
    expect(DesktopInitSurface.safeParse(r.surface).success).toBe(true);
  };

  it("missing directory → observed:false, and the note uses the fixed display path, not the real one", () => {
    const r = readDesktopInitSurface(input({ dir: join(root, "does-not-exist") }));
    unobservedChecks(r);
    expect(r.notes.join("\n")).toContain(DESKTOP_SESSIONS_DISPLAY);
    expect(r.notes.join("\n")).not.toContain(root);
  });

  it("frames only at an OLDER agent version (stale) → observed:false, never the old surface", () => {
    // The corpus has frames at 9.9.100 and 9.9.99; the synced release runs 9.9.101, which nothing has run yet.
    unobservedChecks(readDesktopInitSurface(input({ agentVersion: "9.9.101" })), "9.9.101");
  });

  it("frames at the right agent version but only from BEFORE this Desktop was installed → observed:false", () => {
    unobservedChecks(readDesktopInitSurface(input({ installedAtMs: Date.parse("2030-01-01T00:00:00Z") })));
  });

  it("unknown install time → observed:false (selects nothing rather than guessing)", () => {
    unobservedChecks(readDesktopInitSurface(input({ installedAtMs: null })));
  });
});

describe("DesktopInitSurface schema", () => {
  const ok = {
    agentVersion: "1",
    appVersion: "2",
    observed: true,
    servers: { cowork: { presence: "all", toolsAll: ["a"], toolsSome: [] } },
  };

  it("its server keys are exactly DESKTOP_OWN_SERVERS", () => {
    const shape = (DesktopInitSurface as unknown as { _def: { in?: { shape?: object }; schema?: { shape?: object } } })._def;
    const outer = (shape.in ?? shape.schema ?? DesktopInitSurface) as { shape: { servers: { shape: object } } };
    expect(Object.keys(outer.shape.servers.shape).sort()).toEqual([...DESKTOP_OWN_SERVERS].sort());
  });

  it.each([
    ["an unknown server", { ...ok, servers: { ...ok.servers, workspace: ok.servers.cowork } }],
    ["an extra top-level key", { ...ok, cwd: "/x" }],
    ["an extra per-server key", { ...ok, servers: { cowork: { ...ok.servers.cowork, frames: 3 } } }],
    ["a UUID-shaped tool", { ...ok, servers: { cowork: { ...ok.servers.cowork, toolsAll: ["00000000-0000-4000-8000-000000000003"] } } }],
    ["a `__` tool", { ...ok, servers: { cowork: { ...ok.servers.cowork, toolsAll: ["x__leak"] } } }],
    ["an unsorted list", { ...ok, servers: { cowork: { ...ok.servers.cowork, toolsAll: ["b", "a"] } } }],
    ["overlapping lists", { ...ok, servers: { cowork: { ...ok.servers.cowork, toolsSome: ["a"] } } }],
    ["observed:false with servers", { ...ok, observed: false }],
  ])("rejects %s", (_label, value) => {
    expect(DesktopInitSurface.safeParse(value).success).toBe(false);
  });

  it("accepts the well-formed block", () => {
    expect(DesktopInitSurface.safeParse(ok).success).toBe(true);
  });
});

describe("fixture hygiene: this file carries no real identifiers", () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");

  it("every UUID-shaped string is a reserved synthetic one", () => {
    const uuids = src.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    expect(uuids.length).toBeGreaterThan(0); // the scan is live, not vacuous
    for (const u of uuids) expect(u).toMatch(/^00000000-0000-4000-8000-0000000000\d\d$/);
  });

  it("every bait server name uses the reserved prefix", () => {
    expect(BAIT.userServer.startsWith("fixture-")).toBe(true);
    expect(BAIT.doubleServer).toBe("cowork__fixturex");
  });
});

describe("desktopInstalledAtMs — the install time, not the build time", () => {
  // The updater installs a bundle whose timestamps were preserved from packaging, so the asar's mtime is
  // when the release was BUILT. Desktop 2.9939.2 measured it: mtime 17:40 on the release day, installed
  // 00:37 the next day. Reproduced here the same way, with real files: backdate a staged file, then
  // rename it into place.
  it("returns the time the file was renamed into place, not its preserved mtime", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-time-"));
    try {
      const staged = join(dir, "staged.asar");
      const installed = join(dir, "app.asar");
      writeFileSync(staged, "bundle");
      const built = new Date("2020-01-01T00:00:00Z");
      utimesSync(staged, built, built);
      const beforeInstall = Date.now() - 1000;
      renameSync(staged, installed);
      expect(statSync(installed).mtimeMs, "fixture: the preserved build time survived the rename").toBe(built.getTime());
      const at = desktopInstalledAtMs(installed)!;
      expect(at).toBeGreaterThanOrEqual(beforeInstall);
      expect(at).toBeGreaterThan(built.getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null when there is no bundle, which selects no frames", () => {
    expect(desktopInstalledAtMs(join(tmpdir(), "no-such-dir-xyz", "app.asar"))).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as execute from "../src/run/execute.js";
import * as provenance from "../src/run/input-host-paths.js";
import { computeVerdict } from "../src/run/verdict.js";
import type { RunResult } from "../src/types.js";
import type { LaunchPlan, Mount } from "../src/session.js";

// At container/microvm fidelity the verdict default-fails `host_path_leak` when model-visible text carries
// a host-root path. But a user who uploads or connects a file that itself contains `/Users/…` paths — a kept
// run dir's result.json, a log, a config — failed every run the moment the agent read or quoted it, though
// nothing leaked from the harness: real Cowork would show the same bytes. A host path is now exempt when it
// came VERBATIM from the scenario's own inputs (captured before the agent ran), unless it names a location
// the harness created for THIS run. Synthetic usernames only.

const { scanEvents, hostPathLeaked } = execute;
const hostPathTokens = (t: string): string[] => (execute as any).hostPathTokens(t);
const capture = (plan: Partial<LaunchPlan>, mntHost: string, outDir: string): void =>
  (provenance as any).captureInputHostPathCorpus(plan, mntHost, outDir);
const readCorpus = (outDir: string): Set<string> => (provenance as any).readInputHostPathCorpus?.(outDir) ?? new Set();

let dir: string;
let mnt: string;
let outDir: string;
// A host-SHAPED run dir for the own-root tests. The scratch dirs above come from os.tmpdir(), which is bare
// `/tmp` on Linux — deliberately not a host-path shape, so a path under it is never a token at all and an
// own-root test built on it would pass vacuously on macOS only. ownHostRoots needs no real directory.
const HOST_OUT = "/Users/alice/.cowork-harness/runs/scen/local_sid";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "input-host-paths-"));
  mnt = join(dir, "session", "mnt");
  outDir = join(dir, "run");
  mkdirSync(mnt, { recursive: true });
  mkdirSync(outDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mount = (mountPath: string, kind: Mount["kind"], mode: Mount["mode"] = "r"): Mount => ({
  hostPath: "/unused",
  mountPath,
  mode,
  kind,
});
const put = (rel: string, body: string | Buffer) => {
  const p = join(mnt, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
};
const say = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolResult = (text: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } });
const events = (...lines: string[]) => {
  const f = join(outDir, "events.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
};
const corpusOf = (tokens: Iterable<string>, neverExemptRoots: string[] = [outDir]) => ({ tokens: new Set(tokens), neverExemptRoots });

// A realistic kept run dir's status/result JSON, connected as a folder: the paths a user would really feed in.
const KEPT_RESULT = JSON.stringify(
  {
    outDir: "/Users/alice/.cowork-harness/runs/local_abc123",
    workDir: "/Users/alice/.cowork-harness/runs/local_abc123/work/session",
    vmWork: "/Users/alice/.cowork-harness/vm-work/local_abc123/mnt/outputs/report.md",
    note: "see /Users/alice/proj/notes.md for context",
  },
  null,
  2,
);

describe("hostPathTokens — the full path token, sharing hostPathLeaked's roots and boundary", () => {
  it("extracts each whole path up to its delimiter", () => {
    expect(hostPathTokens('cat "/Users/alice/x/result.json" and /home/bob/y.txt, then `/private/tmp/z`')).toEqual([
      "/Users/alice/x/result.json",
      "/home/bob/y.txt",
      "/private/tmp/z",
    ]);
  });
  it("a backslash ends a token; the decoded form contributes its own tokens", () => {
    expect(hostPathTokens("a /Users/alice/x\\n/Users/bob/y")).toEqual(expect.arrayContaining(["/Users/alice/x"]));
    expect(hostPathTokens("open %2FUsers%2Falice%2Fx now")).toContain("/Users/alice/x");
  });
  it("is non-empty exactly when hostPathLeaked is true (behaviour-identical)", () => {
    for (const t of [
      "",
      "no paths here",
      "/sessions/abc/mnt/outputs/x",
      "/Users/alice",
      "path=/home/x",
      "computer:///Users/alice/f.md",
      "file://localhost/Users/alice/f",
      "whatever/home/x",
      "%2Fhome%2Fvictim",
      "build 100% done",
      "file:\\\\host\\Users\\alice",
      "(/opt/cowork/agent)",
      "x/Users/alice",
    ])
      expect({ t, tokens: hostPathTokens(t).length > 0 }).toEqual({ t, tokens: hostPathLeaked(t) });
  });
});

describe("captureInputHostPathCorpus — the pre-run corpus of host paths the user supplied", () => {
  it("collects tokens from staged uploads and connected folders, sorted, into a private sidecar", () => {
    put("uploads/result.json", KEPT_RESULT);
    put("proj/logs/run.log", "wrote /Users/alice/proj/out.txt\n");
    capture({ mounts: [mount("uploads/result.json", "upload"), mount("proj", "folder", "rw")], resume: false }, mnt, outDir);
    const tokens = [...readCorpus(outDir)];
    expect(tokens).toEqual(
      [
        "/Users/alice/.cowork-harness/runs/local_abc123",
        "/Users/alice/.cowork-harness/runs/local_abc123/work/session",
        "/Users/alice/.cowork-harness/vm-work/local_abc123/mnt/outputs/report.md",
        "/Users/alice/proj/notes.md",
        "/Users/alice/proj/out.txt",
      ].sort(),
    );
    expect(existsSync(join(outDir, "input-host-paths.json"))).toBe(true);
  });

  it("ignores the managed config dir and outputs — they are not user input", () => {
    put("outputs/x.md", "/Users/alice/out/a");
    put(".claude/settings.json", '{"p":"/Users/alice/cfg"}');
    capture({ mounts: [], resume: false }, mnt, outDir);
    expect(readCorpus(outDir).size).toBe(0);
  });

  it("collects tokens from the STAGED copy of every plugin kind the scenario declared", () => {
    put(".local-plugins/marketplaces/local-desktop-app-uploads/p/references/catalog.md", "roots: `/Users/`, `/opt/cowork/`\n");
    put(".remote-plugins/plugin_abc/SKILL.md", "see /home/someone/doc.md\n");
    put(".local-plugins/cache/mkt/q/1.0.0/README.md", "under /private/var/empty\n");
    capture(
      {
        mounts: [
          mount(".local-plugins/marketplaces/local-desktop-app-uploads/p", "local-plugin"),
          mount(".remote-plugins/plugin_abc", "remote-plugin"),
          mount(".local-plugins/cache/mkt/q/1.0.0", "marketplace-plugin"),
        ],
        resume: false,
      },
      mnt,
      outDir,
    );
    expect([...readCorpus(outDir)]).toEqual(["/Users/", "/home/someone/doc.md", "/opt/cowork/", "/private/var/empty"]);
  });

  it("the inputs spend the shared file budget first: a large plugin never crowds out an input's tokens", () => {
    put("proj/a.txt", "/Users/alice/input-path");
    for (let i = 0; i < 5_000; i++) put(`.local-plugins/cache/big/f${String(i).padStart(4, "0")}.md`, "x");
    put(".local-plugins/cache/big/zz.md", "/Users/alice/plugin-path");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      capture({ mounts: [mount(".local-plugins/cache/big", "local-plugin"), mount("proj", "folder")], resume: false }, mnt, outDir);
    } finally {
      spy.mockRestore();
    }
    const tokens = [...readCorpus(outDir)];
    expect(tokens).toContain("/Users/alice/input-path");
    expect(tokens, "past the cap a plugin's later files are not scanned").not.toContain("/Users/alice/plugin-path");
    expect(JSON.parse(readFileSync(join(outDir, "input-host-paths.json"), "utf8")).capped).toBe(true);
  });

  it("a plugin file outside a declared plugin mount contributes nothing", () => {
    put(".local-plugins/cache/undeclared/SKILL.md", "/Users/alice/stray");
    capture({ mounts: [], resume: false }, mnt, outDir);
    expect(readCorpus(outDir).size).toBe(0);
  });

  it("does not tokenize oversize or binary files, nor .git/ or node_modules/", () => {
    put("proj/big.txt", "/Users/alice/big/x " + "a".repeat(2 * 1024 * 1024));
    put("proj/bin.dat", Buffer.concat([Buffer.from("/Users/alice/bin/x "), Buffer.from([0]), Buffer.from(" tail")]));
    put("proj/.git/config", "/Users/alice/git/x");
    put("proj/node_modules/m/index.js", "/Users/alice/nm/x");
    put("proj/ok.txt", "/Users/alice/ok/x");
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    expect([...readCorpus(outDir)]).toEqual(["/Users/alice/ok/x"]);
  });

  it("is captured on a fresh stage only — a resumed turn never re-walks (the folder is writable)", () => {
    put("proj/a.txt", "/Users/alice/a");
    const plan = { mounts: [mount("proj", "folder", "rw")], resume: false };
    capture(plan, mnt, outDir);
    // Turn 1's agent writes a host path into the rw folder …
    put("proj/b.txt", "/Users/alice/written-by-agent");
    // … and turn 2 (resume) must not pick it up.
    capture({ ...plan, resume: true }, mnt, outDir);
    expect([...readCorpus(outDir)]).toEqual(["/Users/alice/a"]);
  });

  it("the sidecar is written above the staged tree, never inside it", () => {
    put("proj/a.txt", "/Users/alice/a");
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    expect(existsSync(join(mnt, "input-host-paths.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(outDir, "input-host-paths.json"), "utf8")).tokens).toEqual(["/Users/alice/a"]);
  });
});

describe("scanEvents — a host path the user supplied is not a leak", () => {
  it("(a) the agent quoting a path from a connected kept result.json is exempt and counted", () => {
    put("prior/result.json", KEPT_RESULT);
    capture({ mounts: [mount("prior", "folder")], resume: false }, mnt, outDir);
    const f = events(toolResult(KEPT_RESULT), say("The prior run wrote /Users/alice/proj/notes.md earlier."));
    const scan = scanEvents(f, ["outputs"], corpusOf(readCorpus(outDir)) as any) as any;
    expect(scan.hostPathLeaked).toBe(false);
    expect(scan.hostPathsFromInputs).toBe(4);
  });

  it("(b) a host path NOT in the inputs still leaks, even beside an exempt one", () => {
    const f = events(say("see /Users/alice/proj/notes.md and /Users/bob/other"));
    const scan = scanEvents(f, ["outputs"], corpusOf(["/Users/alice/proj/notes.md"]) as any);
    expect(scan.hostPathLeaked).toBe(true);
  });

  it("(c) a path under a root the harness created for THIS run is never exempt, even if an input names it", () => {
    const own = join(HOST_OUT, "work", "session", "mnt", "outputs", "r.md");
    const f = events(say(`saved to ${own}`));
    const scan = scanEvents(f, ["outputs"], corpusOf([own], [HOST_OUT]) as any) as any;
    expect(scan.hostPathLeaked).toBe(true);
    expect(scan.hostPathsFromInputs ?? 0).toBe(0);
  });

  it("(d) a path that only appears in an oversize or binary input still leaks", () => {
    put("proj/big.txt", "/Users/alice/big/x " + "a".repeat(2 * 1024 * 1024));
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    const f = events(say("found /Users/alice/big/x"));
    expect(scanEvents(f, ["outputs"], corpusOf(readCorpus(outDir)) as any).hostPathLeaked).toBe(true);
  });

  it("(e) a host path the agent wrote into a rw folder in turn 1 leaks when quoted in turn 2", () => {
    put("proj/a.txt", "/Users/alice/a");
    const plan = { mounts: [mount("proj", "folder", "rw")], resume: false };
    capture(plan, mnt, outDir);
    put("proj/b.txt", "/Users/alice/written-by-agent");
    capture({ ...plan, resume: true }, mnt, outDir);
    const f = events(toolResult("/Users/alice/written-by-agent"));
    expect(scanEvents(f, ["outputs"], corpusOf(readCorpus(outDir)) as any).hostPathLeaked).toBe(true);
  });

  it("(f) an encoded spelling whose decoded token came from an input is exempt", () => {
    const f = events(say("link: file:///x?p=%2FUsers%2Falice%2Fx"));
    const scan = scanEvents(f, ["outputs"], corpusOf(["/Users/alice/x"]) as any) as any;
    expect(scan.hostPathLeaked).toBe(false);
  });

  it("control: with no corpus, behaviour is unchanged", () => {
    const f = events(say("see /Users/alice/proj/notes.md"));
    expect(scanEvents(f).hostPathLeaked).toBe(true);
  });
});

// The plugin under test is user-supplied input too: its own files (a reference catalog listing the host roots
// the leak guard looks for, say) reach the agent through the staged plugin, and the agent reading them is not a
// leak. Only literals present in the STAGED plugin's files are exempt; the plugin's host SOURCE location is
// what a leak of the plugin mount looks like, so it is never exempt even when a plugin file names it.
describe("the staged plugin's own files are input too", () => {
  const PLUGIN = ".local-plugins/marketplaces/local-desktop-app-uploads/cowork-harness";
  const CATALOG_ROW =
    "| `transcript_no_host_path: true` | no host path (`/Users/`, `/opt/cowork/`, `/home/`, `/root/`, and the macOS " +
    "`/private/var/`, `/private/tmp/`, `/var/folders/`, `/Volumes/` roots) leaked into model-visible text |\n";
  const read = (body: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_r", content: body }] } });
  const stagePlugin = (body: string, hostPath = "/unused") => {
    put(`${PLUGIN}/references/assertion-catalog.md`, body);
    capture({ mounts: [{ ...mount(PLUGIN, "local-plugin"), hostPath }], resume: false }, mnt, outDir);
  };
  const corpusFor = () => (execute as any).inputProvenanceCorpus(outDir, "local_sid", {}, "which assertion?", "container");
  const verdictOf = (scan: any) =>
    computeVerdict(
      {
        scenario: "t",
        fidelity: "container",
        effectiveFidelity: "container",
        baseline: "x",
        result: "success",
        decisions: [],
        egress: [],
        assertions: [],
        outDir: "/tmp/x",
        scan: { outputsDeletes: [], hostPathLeaked: scan.hostPathLeaked, selfHealRan: false },
      } as RunResult,
      "live",
    );

  it("router shape: the agent Reads the plugin's catalog row listing host roots — green", () => {
    stagePlugin(`# Assertion catalog\n\n${CATALOG_ROW}`);
    const f = events(read(`1\t# Assertion catalog\n2\t\n3\t${CATALOG_ROW}`));
    const scan = scanEvents(f, ["outputs"], corpusFor()) as any;
    expect(scan.hostPathLeaked).toBe(false);
    expect(scan.hostPathsFromInputs).toBe(8);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(verdictOf(scan).signals.map((s: any) => s.code)).not.toContain("host_path_leak");
    } finally {
      spy.mockRestore();
    }
  });

  it("a real leak: the same literal in NO plugin file stays red", () => {
    stagePlugin("# Assertion catalog\n\nnothing host-shaped here\n");
    const f = events(read(`3\t${CATALOG_ROW}`));
    const scan = scanEvents(f, ["outputs"], corpusFor()) as any;
    expect(scan.hostPathLeaked).toBe(true);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(verdictOf(scan).signals.map((s: any) => s.code)).toContain("host_path_leak");
    } finally {
      spy.mockRestore();
    }
  });

  it("mixed: the plugin's literals beside a real host path the agent produced — red", () => {
    stagePlugin(`# Assertion catalog\n\n${CATALOG_ROW}`);
    const f = events(read(`3\t${CATALOG_ROW}`), say("the roots are `/Users/`; your file is /Users/bob/secret.txt"));
    const scan = scanEvents(f, ["outputs"], corpusFor()) as any;
    expect(scan.hostPathLeaked).toBe(true);
  });

  it("the plugin's host SOURCE location leaks even when a plugin file names it", () => {
    const src = "/Users/alice/code/my-plugin";
    stagePlugin(`dev notes: built from ${src}/skills/x\n`, src);
    expect(corpusFor().tokens.has(`${src}/skills/x`), "precondition: the plugin file yields the token").toBe(true);
    const f = events(read(`dev notes: built from ${src}/skills/x`));
    expect(scanEvents(f, ["outputs"], corpusFor()).hostPathLeaked).toBe(true);
  });

  it("a host path the agent writes into the staged plugin tree during the run is not exempt", () => {
    stagePlugin("# Assertion catalog\n");
    put(`${PLUGIN}/references/later.md`, "/Users/alice/written-by-agent");
    capture({ mounts: [mount(PLUGIN, "local-plugin")], resume: true }, mnt, outDir);
    const f = events(read("/Users/alice/written-by-agent"));
    expect(scanEvents(f, ["outputs"], corpusFor()).hostPathLeaked).toBe(true);
  });
});

// `skills.local` skills reach the agent through the managed config dir (`mnt/.claude/skills/<name>`), not a mount,
// but they are the same kind of input as a plugin: the skill under test, staged from the user's own tree. The
// same rules apply, keyed on the declared skills only — never the rest of the config dir.
describe("the staged local skills' own files are input too", () => {
  const SKILL = ".claude/skills/my-skill";
  const ROW = "roots: `/Users/`, `/opt/cowork/`, `/private/var/empty`\n";
  const read = (body: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_s", content: body }] } });
  const stageSkill = (body: string, src = "/unused/my-skill") => {
    put(`${SKILL}/references/notes.md`, body);
    capture({ mounts: [], stagedSkills: [{ src, dest: "my-skill" }], resume: false } as any, mnt, outDir);
  };
  const corpusFor = () => (execute as any).inputProvenanceCorpus(outDir, "local_sid", {}, "go", "container");

  it("a literal from a staged local skill's file passes", () => {
    stageSkill(ROW);
    const scan = scanEvents(events(read(ROW)), ["outputs"], corpusFor()) as any;
    expect(scan.hostPathLeaked).toBe(false);
    expect(scan.hostPathsFromInputs).toBe(3);
  });

  it("the same literal absent from every skill file fails", () => {
    stageSkill("nothing host-shaped\n");
    expect(scanEvents(events(read(ROW)), ["outputs"], corpusFor()).hostPathLeaked).toBe(true);
  });

  it("a real host path mixed in with the skill's literals fails", () => {
    stageSkill(ROW);
    expect(scanEvents(events(read(ROW), say("and /Users/bob/secret.txt")), ["outputs"], corpusFor()).hostPathLeaked).toBe(true);
  });

  it("a skill file naming the skill's own host source location fails", () => {
    const src = "/Users/alice/code/my-skill";
    stageSkill(`built from ${src}/references\n`, src);
    expect(corpusFor().tokens.has(`${src}/references`), "precondition: the skill file yields the token").toBe(true);
    expect(scanEvents(events(read(`built from ${src}/references`)), ["outputs"], corpusFor()).hostPathLeaked).toBe(true);
  });

  it("a path written into the staged skill after staging fails", () => {
    stageSkill(ROW);
    put(`${SKILL}/later.md`, "/Users/alice/written-by-agent");
    capture({ mounts: [], stagedSkills: [{ src: "/unused/my-skill", dest: "my-skill" }], resume: true } as any, mnt, outDir);
    expect(scanEvents(events(read("/Users/alice/written-by-agent")), ["outputs"], corpusFor()).hostPathLeaked).toBe(true);
  });

  it("buildLaunchPlan carries the skills it staged (source and dest) for the capture to read", async () => {
    const { loadBaseline } = await import("../src/baseline.js");
    const { loadSession, buildLaunchPlan } = await import("../src/session.js");
    const src = join(dir, "src-skill");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: src-skill\ndescription: x\n---\n");
    const plan = buildLaunchPlan(
      loadSession({ skills: { local: [src] } }),
      loadBaseline("latest"),
      join(dir, "plan-out"),
      "container",
      false,
    );
    expect(plan.stagedSkills).toEqual([{ src, dest: "src-skill" }]);
  });

  it("only the declared skills are read — not the rest of the config dir", () => {
    put(".claude/skills/undeclared/SKILL.md", "/Users/alice/stray");
    put(".claude/settings.json", '{"p":"/Users/alice/cfg"}');
    capture({ mounts: [], stagedSkills: [], resume: false } as any, mnt, outDir);
    expect(readCorpus(outDir).size).toBe(0);
  });

  it("a staged skill spends the budget after the inputs", () => {
    put("proj/a.txt", "/Users/alice/input-path");
    for (let i = 0; i < 5_000; i++) put(`${SKILL}/f${String(i).padStart(4, "0")}.md`, "x");
    put(`${SKILL}/zz.md`, "/Users/alice/skill-path");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      capture(
        { mounts: [mount("proj", "folder")], stagedSkills: [{ src: "/unused/my-skill", dest: "my-skill" }], resume: false } as any,
        mnt,
        outDir,
      );
    } finally {
      spy.mockRestore();
    }
    const tokens = [...readCorpus(outDir)];
    expect(tokens).toContain("/Users/alice/input-path");
    expect(tokens).not.toContain("/Users/alice/skill-path");
  });
});

describe("verdict — a pass that relied on the exemption says so", () => {
  const rr = (scan: RunResult["scan"]): RunResult => ({
    scenario: "t",
    fidelity: "container",
    effectiveFidelity: "container",
    baseline: "x",
    result: "success",
    decisions: [],
    egress: [],
    assertions: [],
    outDir: "/tmp/x",
    scan,
  });
  it("no host_path_leak signal, and a notice naming the count", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: any) => {
      writes.push(String(c));
      return true;
    });
    try {
      const v = computeVerdict(
        rr({ outputsDeletes: [], hostPathLeaked: false, selfHealRan: false, inputHostPathTokens: 5, hostPathsFromInputs: 2 } as any),
        "live",
      );
      expect(v.signals.map((s) => s.code)).not.toContain("host_path_leak");
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toMatch(
      /::notice:: \[verdict\] 2 host path\(s\) in model-visible text came verbatim from the scenario's inputs, prompt, plugin or skill files; not counted as a leak/,
    );
  });
});

describe("ownHostRoots — what the harness created for this run", () => {
  it("covers the run dir (raw and realpath), the microvm session dir and every staged agent version", async () => {
    const { VM_WORK_HOST } = await import("../src/runtime/lima.js");
    const { realpathSync } = await import("node:fs");
    const { subtree, exact } = (execute as any).ownHostRoots(outDir, "local_sid", {
      agentBinary: { stagedPath: "/x/claude-code-vm/2.1.0/claude" },
    });
    expect(subtree).toContain(outDir);
    expect(subtree).toContain(realpathSync(outDir)); // /var/folders vs /private/var/folders on macOS
    expect(subtree).toContain(join(VM_WORK_HOST, "local_sid"));
    // The parent of the pinned version dir: a pruned pin falls back to a sibling version, which is the
    // one actually mounted.
    expect(subtree).toContain("/x/claude-code-vm");
    // Exact-only: the vm-work root and the runs dir hold OTHER sessions, which an input may legitimately name.
    expect(exact).toContain(VM_WORK_HOST);
    expect(exact).toContain(join(outDir, ".."));
  });
});

// A token ends at whitespace, `,` or `;`, so a path with a space in it — `Application Support`, `My
// Documents` — yields a TRUNCATED token that an unrelated input can easily carry too. A truncated spelling
// must never exempt the path it truncates.
describe("truncated tokens are never exempt", () => {
  const AGENT = "/Users/alice/Library/Application Support/Claude/claude-code-vm/2.1.0/claude";
  const baseline = { agentBinary: { stagedPath: AGENT } };

  it("the staged agent path under `Application Support` leaks, though an input names another path there", () => {
    put("proj/notes.md", "logs live in /Users/alice/Library/Application Support/Claude/logs/main.log\n");
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    const { subtree, exact } = (execute as any).ownHostRoots(outDir, "local_sid", baseline);
    const corpus = { tokens: readCorpus(outDir), neverExemptRoots: subtree, neverExemptExact: exact };
    expect(corpus.tokens.has("/Users/alice/Library/Application"), "precondition: the input yields the truncated token").toBe(true);
    const f = events(toolResult(`env: '${AGENT}': No such file or directory`));
    expect(scanEvents(f, ["outputs"], corpus as any).hostPathLeaked).toBe(true);
  });

  it("a truncated spelling of an own root is refused even with nothing after it", () => {
    const corpus = {
      tokens: new Set(["/Users/alice/Library/Application"]),
      neverExemptRoots: ["/Users/alice/Library/Application Support/Claude/claude-code-vm"],
    };
    const f = events(say("agent under `/Users/alice/Library/Application`"));
    expect(scanEvents(f, ["outputs"], corpus as any).hostPathLeaked).toBe(true);
  });

  for (const [name, corpus, text] of [
    ["a space in the leaked path", "/Users/alice/My", "opened /Users/alice/My Documents/x"],
    ["a runs dir containing a space", "/Users/alice/my", "wrote /Users/alice/my runs/local_x/work/session/mnt/outputs/r.md"],
    ["a comma continuing the path", "/Users/alice/proj", "read /Users/alice/proj,old/secret.txt"],
    ["a semicolon continuing the path", "/Users/alice/proj", "x=/Users/alice/proj;rm/secret"],
  ] as const)
    it(`${name} leaks`, () => {
      expect(scanEvents(events(say(text)), ["outputs"], corpusOf([corpus]) as any).hostPathLeaked).toBe(true);
    });

  for (const text of ["see /Users/alice/proj then stop", "/Users/alice/proj, and more", "/Users/alice/proj; done", "(/Users/alice/proj)"])
    it(`control: ${JSON.stringify(text)} is still exempt`, () => {
      expect(scanEvents(events(say(text)), ["outputs"], corpusOf(["/Users/alice/proj"]) as any).hostPathLeaked).toBe(false);
    });
});

describe("exact own roots: the vm-work root and the runs dir", () => {
  for (const which of ["vm-work root", "runs dir"])
    it(`the ${which} itself leaks even when an input names it`, async () => {
      const { VM_WORK_HOST } = await import("../src/runtime/lima.js");
      const root = which === "runs dir" ? join(HOST_OUT, "..") : VM_WORK_HOST;
      const { subtree, exact } = (execute as any).ownHostRoots(HOST_OUT, "local_sid", {});
      const corpus = { tokens: new Set([root]), neverExemptRoots: subtree, neverExemptExact: exact };
      expect(scanEvents(events(say(`ls ${root}`)), ["outputs"], corpus as any).hostPathLeaked).toBe(true);
    });
  it("control: ANOTHER session under the vm-work root, named by an input, is exempt", async () => {
    const { VM_WORK_HOST } = await import("../src/runtime/lima.js");
    const other = join(VM_WORK_HOST, "local_old", "mnt", "outputs", "r.md");
    const { subtree, exact } = (execute as any).ownHostRoots(outDir, "local_sid", {});
    const corpus = { tokens: new Set([other]), neverExemptRoots: subtree, neverExemptExact: exact };
    expect(scanEvents(events(say(`see ${other}`)), ["outputs"], corpus as any).hostPathLeaked).toBe(false);
  });
});

// What executeScenario hands scanEvents: the persisted corpus plus this turn's prompt, with the real
// own-roots — at the sandboxed tiers only.
describe("inputProvenanceCorpus — the corpus executeScenario scans with", () => {
  const corpusFor = (prompt: string, fidelity = "container", out = outDir) =>
    (execute as any).inputProvenanceCorpus(out, "local_sid", {}, prompt, fidelity);

  it("a path that appears only in the prompt is exempt", () => {
    const f = events(say("reading /Users/alice/brief.md as asked"));
    expect(scanEvents(f, ["outputs"], corpusFor("please summarise /Users/alice/brief.md")).hostPathLeaked).toBe(false);
  });
  it("a prompt path under a root the harness created still leaks", () => {
    const own = join(HOST_OUT, "work", "session", "mnt", "outputs", "r.md");
    expect(scanEvents(events(say(`saved ${own}`)), ["outputs"], corpusFor(`check ${own}`, "container", HOST_OUT)).hostPathLeaked).toBe(
      true,
    );
  });
  it("includes the corpus the first turn persisted", () => {
    put("proj/a.txt", "/Users/alice/a");
    capture({ mounts: [mount("proj", "folder")], resume: false }, mnt, outDir);
    expect([...corpusFor("hi").tokens]).toEqual(["/Users/alice/a"]);
  });
  for (const fidelity of ["hostloop", "protocol"])
    it(`is undefined at ${fidelity} (the signal is skipped there, and nothing was staged to scan)`, () => {
      expect(corpusFor("see /Users/alice/brief.md", fidelity)).toBeUndefined();
    });
});

// The runtimes' capture call sits between staging and the spawn inside spawnContainer/spawnMicroVm, which
// need Docker or a VM to run; the call order is pinned on the source. executeScenario's hand-off is pinned
// the same way — the behaviour of what it hands over is tested above.
describe("wiring", () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
  for (const tier of ["runtime/container.ts", "runtime/microvm.ts"])
    it(`${tier} captures the corpus right after staging`, () => {
      const s = src(tier);
      const staged = s.indexOf("stageWorkspace(plan, mntHost)");
      const captured = s.indexOf("captureInputHostPathCorpus(plan, mntHost, outDir)");
      expect(staged).toBeGreaterThan(-1);
      expect(captured).toBeGreaterThan(staged);
    });
  it("execute.ts scans with inputProvenanceCorpus for this run", () => {
    expect(src("run/execute.ts")).toMatch(
      /inputProvenanceCorpus\(outDir, sessionId, baseline, scenario\.prompt, effectiveFidelity\)[\s\S]{0,200}scanEvents\(join\(outDir, "events\.jsonl"\), deleteDeniedRootsFromPlan\(plan, outputsMountMode \?\? "rw"\), inputCorpus\)/,
    );
  });
});

// A whitespace-separated run that STARTS a new path (or a URL) is the next item in a list, not the rest of
// this one — refusing it would fail every one-path-per-line listing of the user's own files.
describe("continuation: a following new path or URL is not a continuation", () => {
  for (const [name, text] of [
    ["one path per line", "/Users/alice/a\n/Users/alice/b\n"],
    ["two paths on one command line", "cp /Users/alice/a /Users/alice/b"],
    ["a path then a URL", "see /Users/alice/a https://example.com/x"],
    ["a path then a sandbox path", "copied /Users/alice/a /sessions/x/mnt/outputs/b"],
  ] as const)
    it(`${name}: exempt when every host path is an input`, () => {
      const scan = scanEvents(events(say(text)), ["outputs"], corpusOf(["/Users/alice/a", "/Users/alice/b"]) as any);
      expect(scan.hostPathLeaked).toBe(false);
    });
  it("leak control: the second path is not an input", () => {
    expect(
      scanEvents(events(say("cp /Users/alice/a /Users/alice/b")), ["outputs"], corpusOf(["/Users/alice/a"]) as any).hostPathLeaked,
    ).toBe(true);
  });
  it("still refuses a space inside a path (`Application Support/…`)", () => {
    const t = "at /Users/alice/Library/Application Support/Claude/logs";
    expect(scanEvents(events(say(t)), ["outputs"], corpusOf(["/Users/alice/Library/Application"]) as any).hostPathLeaked).toBe(true);
  });
});

// Trailing sentence punctuation is part of the token (so an input path followed by `.` is not exempt), but it
// must not let an own root slip past the root checks either.
describe("own roots with trailing punctuation, and the runs root itself", () => {
  const withRoots = async (tokens: string[]) => {
    const { subtree, exact } = (execute as any).ownHostRoots(HOST_OUT, "local_sid", {});
    return { tokens: new Set(tokens), neverExemptRoots: subtree, neverExemptExact: exact };
  };
  for (const suffix of [".", ":", "?", "!"])
    it(`the run dir followed by ${JSON.stringify(suffix)} leaks`, async () => {
      const tok = `${HOST_OUT}${suffix}`;
      expect(scanEvents(events(say(`saved under ${tok}`)), ["outputs"], (await withRoots([tok])) as any).hostPathLeaked).toBe(true);
    });
  it("the vm-work root followed by `.` leaks", async () => {
    const { VM_WORK_HOST } = await import("../src/runtime/lima.js");
    const tok = `${VM_WORK_HOST}.`;
    expect(scanEvents(events(say(`in ${tok}`)), ["outputs"], (await withRoots([tok])) as any).hostPathLeaked).toBe(true);
  });
  it("the runs root (COWORK_HARNESS_RUNS_DIR) itself leaks", async () => {
    const runs = "/Users/alice/custom-runs";
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    try {
      const { exact } = (execute as any).ownHostRoots(HOST_OUT, "local_sid", {});
      expect(exact).toContain(runs);
      expect(scanEvents(events(say(`ls ${runs}`)), ["outputs"], (await withRoots([runs])) as any).hostPathLeaked).toBe(true);
    } finally {
      delete process.env.COWORK_HARNESS_RUNS_DIR;
    }
  });
});

// An own root respelled — through `..`, in another letter case (macOS's default filesystem ignores case),
// or with an invisible format character inside — still names the same place, so it is still never exempt.
describe("own roots respelled", () => {
  const spellings = (): [string, string][] => [
    ["via ..", `${join(HOST_OUT, "..")}/../${HOST_OUT.split("/").slice(-2).join("/")}/work/x`],
    // Only the part below the host root changes case: the root prefix itself is matched case-sensitively.
    ["another case", `${join(HOST_OUT, "..")}/${HOST_OUT.split("/").slice(-1)[0].toUpperCase()}/work/x`],
    ["a zero-width character inside", `${HOST_OUT.slice(0, -2)}\u200b${HOST_OUT.slice(-2)}/work/x`],
    ["a soft hyphen inside", `${HOST_OUT.slice(0, -2)}\u00ad${HOST_OUT.slice(-2)}/work/x`],
  ];
  for (const i of [0, 1, 2, 3])
    it(`spelling ${i} (${["via ..", "another case", "a zero-width character inside", "a soft hyphen inside"][i]}) leaks`, () => {
      const { subtree, exact } = (execute as any).ownHostRoots(HOST_OUT, "local_sid", {});
      const [, tok] = spellings()[i];
      const corpus = { tokens: new Set([tok]), neverExemptRoots: subtree, neverExemptExact: exact };
      expect(scanEvents(events(say(`see ${tok}`)), ["outputs"], corpus as any).hostPathLeaked).toBe(true);
    });
});

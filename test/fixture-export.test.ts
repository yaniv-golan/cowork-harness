import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportFixture } from "../src/fixture/export.js";
import { FsRefusal, NoFollowRoot } from "../src/hillclimb/fs.js";
import { VM_WORK_HOST } from "../src/runtime/lima.js";

let tmp: string;
let run: string;
let outputs: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "fixture-export-")));
  run = join(tmp, "runs", "scenario-x", "local_abc");
  outputs = join(run, "work", "session", "mnt", "outputs");
  mkdirSync(outputs, { recursive: true });
  mkdirSync(join(run, "turns", "1"), { recursive: true });
  writeResult({});
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeResult(over: Record<string, unknown>): void {
  writeFileSync(
    join(run, "turns", "1", "result.json"),
    JSON.stringify({ result: "success", command: "run", outputsDir: outputs, ...over }),
  );
}
const base = () => ({ runDir: run, out: join(tmp, "fixture"), allowHostPaths: false, secrets: [] as string[] });
const tree = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  walk(dir, "");
  return out;
};

describe("fixture export", () => {
  it("copies the kept run's outputs tree byte-for-byte, keeping mode bits", () => {
    mkdirSync(join(outputs, "deck"), { recursive: true });
    writeFileSync(join(outputs, "report.md"), "# Report\n");
    writeFileSync(join(outputs, "deck", "scores.json"), '{"a":1}');
    const bin = Buffer.from([0, 1, 2, 255, 254, 0, 10]);
    writeFileSync(join(outputs, "deck", "slides.bin"), bin);
    writeFileSync(join(outputs, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(outputs, "run.sh"), 0o755);
    const r = exportFixture(base());
    expect(r.exitCode).toBe(0);
    expect(tree(join(tmp, "fixture"))).toEqual(["deck/scores.json", "deck/slides.bin", "report.md", "run.sh"]);
    expect(readFileSync(join(tmp, "fixture", "deck", "slides.bin")).equals(bin)).toBe(true);
    expect(statSync(join(tmp, "fixture", "run.sh")).mode & 0o777).toBe(0o755);
    expect(r.written).toEqual(["deck/scores.json", "deck/slides.bin", "report.md", "run.sh"]);
    expect(r.notes?.some((n) => n.file === "deck/slides.bin" && n.kind === "binary")).toBe(true);
  });

  it("exports a PARTIAL run (a skill stopped mid-work is a real fixture source)", () => {
    writeResult({ partial: true });
    writeFileSync(join(outputs, "half.md"), "step 1 done\n");
    expect(exportFixture(base()).exitCode).toBe(0);
  });

  it("refuses a replay run dir (its outputs were materialized from a cassette, not produced)", () => {
    writeResult({ command: "replay", outputsDir: undefined });
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/replay/);
  });

  it("refuses an outputsDir that resolves outside the run dir (a hand-edited result.json)", () => {
    mkdirSync(join(tmp, "elsewhere"));
    writeFileSync(join(tmp, "elsewhere", "private.md"), "not this run's");
    writeResult({ outputsDir: join(tmp, "elsewhere") });
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/not this run's outputs dir/);
    expect(readdirSync(tmp)).not.toContain("fixture");
  });

  it("refuses an --out that exists and is not empty, and never merges into it", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    mkdirSync(join(tmp, "fixture"));
    writeFileSync(join(tmp, "fixture", "keep.md"), "K");
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(tree(join(tmp, "fixture"))).toEqual(["keep.md"]);
  });

  it("accepts an existing EMPTY --out", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    mkdirSync(join(tmp, "fixture"));
    expect(exportFixture(base()).exitCode).toBe(0);
  });

  it("refuses when a file contains a secret value, names the file but never the value, and writes nothing", () => {
    writeFileSync(join(outputs, "ok.md"), "fine");
    writeFileSync(join(outputs, "leak.md"), "token=sk-SECRET-123456");
    const r = exportFixture({ ...base(), secrets: ["sk-SECRET-123456"] });
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "leak.md", kind: "secret" }]);
    expect(readdirSync(tmp)).not.toContain("fixture");
  });

  it("refuses host paths unless --allow-host-paths, and refuses run-dir paths even then", () => {
    writeFileSync(join(outputs, "notes.md"), "saved under /Users/someone/Documents/plan.md");
    expect(exportFixture(base()).exitCode).toBe(2);
    expect(exportFixture({ ...base(), allowHostPaths: true }).exitCode).toBe(0);
    rmSync(join(tmp, "fixture"), { recursive: true });
    writeFileSync(join(outputs, "notes.md"), `see ${join(run, "work", "session", "mnt", "outputs", "x.md")}`);
    const r = exportFixture({ ...base(), allowHostPaths: true });
    expect(r.exitCode).toBe(2);
    expect(r.refused[0]?.kind).toBe("run_path");
  });

  it("reports other PII-class findings (email, domain) as notes, without refusing", () => {
    writeFileSync(join(outputs, "contact.md"), "write to someone@example.org");
    const r = exportFixture(base());
    expect(r.exitCode).toBe(0);
    expect(r.notes?.some((n) => n.file === "contact.md" && n.kind === "pii" && n.cls === "email")).toBe(true);
  });

  it("skips and LISTS symlinks and hard-linked files (they could not be staged as a fixture)", () => {
    writeFileSync(join(outputs, "real.md"), "R");
    symlinkSync(join(outputs, "real.md"), join(outputs, "alias.md"));
    writeFileSync(join(tmp, "outside.md"), "O");
    linkSync(join(tmp, "outside.md"), join(outputs, "hard.md"));
    const r = exportFixture(base());
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual(["real.md"]);
    expect(r.skipped).toEqual([
      { file: "alias.md", why: "symlink" },
      { file: "hard.md", why: "hard link" },
    ]);
  });

  it("checks the RAW BYTES of every file for a secret — a Latin-1 (non-UTF-8) CSV is not skipped", () => {
    writeFileSync(join(outputs, "people.csv"), Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(",TOP-SECRET-77\n")]));
    const r = exportFixture({ ...base(), secrets: ["TOP-SECRET-77"] });
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "people.csv", kind: "secret" }]);
  });

  it("refuses a non-ASCII secret stored as Latin-1", () => {
    writeFileSync(join(outputs, "legacy.csv"), Buffer.from("name,café-SECRET-5\n", "latin1"));
    const r = exportFixture({ ...base(), secrets: ["café-SECRET-5"] });
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "legacy.csv", kind: "secret" }]);
  });

  it("checks a binary file's bytes for a secret too", () => {
    writeFileSync(join(outputs, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("TOP-SECRET-77"), Buffer.from([0])]));
    const r = exportFixture({ ...base(), secrets: ["TOP-SECRET-77"] });
    expect(r.refused).toEqual([{ file: "blob.bin", kind: "secret" }]);
  });

  it("refuses a secret in a file's NAME (the name is committed too)", () => {
    writeFileSync(join(outputs, "TOP-SECRET-77.md"), "harmless");
    const r = exportFixture({ ...base(), secrets: ["TOP-SECRET-77"] });
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "TOP-SECRET-77.md", kind: "secret" }]);
  });

  it.each([
    ["csv cell", "name,/Users/bob/x.csv\n"],
    ["html cell", "<td>/Users/bob/x</td>"],
    ["bracketed", "[/Users/bob/x]"],
    ["pipe table", "|/home/bob/x|"],
    ["macOS data volume", "at /System/Volumes/Data/Users/bob/x"],
    ["Latin-1 text", Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(" /Users/bob/x\n")])],
  ])("refuses a host path the scanner's path class sees (%s)", (_n, body) => {
    writeFileSync(join(outputs, "t.txt"), body);
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "t.txt", kind: "host_path" }]);
  });

  it("refuses a host-path slug in a file's relative PATH", () => {
    mkdirSync(join(outputs, "-Users-bob-proj"));
    writeFileSync(join(outputs, "-Users-bob-proj", "a.md"), "A");
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "-Users-bob-proj/a.md", kind: "host_path" }]);
  });

  it("does not refuse the guest-only /opt/cowork/ path (the microvm agent mount, not a host path)", () => {
    writeFileSync(join(outputs, "a.md"), "agent at /opt/cowork/agent/claude");
    expect(exportFixture(base()).exitCode).toBe(0);
  });

  describe("run paths, in every spelling, are refused even with --allow-host-paths", () => {
    const allow = () => ({ ...base(), allowHostPaths: true });
    const expectRunPath = (body: string, opts = allow()) => {
      writeFileSync(join(outputs, "n.md"), body);
      const r = exportFixture(opts);
      expect(r.exitCode).toBe(2);
      expect(r.refused).toEqual([{ file: "n.md", kind: "run_path" }]);
    };

    it.skipIf(realpathSync(tmpdir()) === tmpdir())(
      "the non-realpath spelling of the run dir (/var/folders vs /private/var/folders)",
      () => {
        const raw = join(tmpdir(), tmp.slice(realpathSync(tmpdir()).length));
        expectRunPath(`see ${join(raw, "runs", "scenario-x", "local_abc", "work", "x.md")}`);
      },
    );

    it("the run dir as GIVEN, when that is not its realpath (portable: a symlinked parent)", () => {
      symlinkSync(join(tmp, "runs"), join(tmp, "alias"));
      const given = join(tmp, "alias", "scenario-x", "local_abc");
      expectRunPath(`see ${given}/work/x.md`, { ...allow(), runDir: given });
    });

    it("the tilde spelling of the run dir", () => {
      const home = process.env.HOME;
      process.env.HOME = tmp;
      try {
        expectRunPath("see ~/runs/scenario-x/local_abc/work/x.md");
      } finally {
        process.env.HOME = home;
      }
    });

    it("a path under runsWriteRoot()", () => {
      const prev = process.env.COWORK_HARNESS_RUNS_DIR;
      process.env.COWORK_HARNESS_RUNS_DIR = "/srv/ci-runs";
      try {
        expectRunPath("other run: /srv/ci-runs/foo/local_1/turns/1/result.json");
      } finally {
        if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
        else process.env.COWORK_HARNESS_RUNS_DIR = prev;
      }
    });

    it("not a sibling whose name merely starts with a run root (runs-old is not runs)", () => {
      const prev = process.env.COWORK_HARNESS_RUNS_DIR;
      process.env.COWORK_HARNESS_RUNS_DIR = "/srv/ci-runs";
      try {
        writeFileSync(join(outputs, "n.md"), "archive: /srv/ci-runs-old/foo");
        expect(exportFixture(allow()).exitCode).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
        else process.env.COWORK_HARNESS_RUNS_DIR = prev;
      }
    });

    it("a VM work dir path", () => {
      expectRunPath(`staged at ${VM_WORK_HOST}/abc123/mnt/outputs/y.md`);
    });

    it("a guest /sessions/ path", () => {
      expectRunPath("wrote /sessions/x/mnt/outputs/y.md");
    });

    it("not a URL whose path merely contains /sessions/", () => {
      writeFileSync(join(outputs, "n.md"), "docs at https://example.com/api/sessions/1");
      expect(exportFixture(allow()).exitCode).toBe(0);
    });

    it.each([["GET /sessions/{id}"], ["(/sessions/abc)"], ["see /sessions/abc/notes"]])(
      "not a /sessions/ mention outside the VM session layout (%s)",
      (body) => {
        writeFileSync(join(outputs, "n.md"), body);
        expect(exportFixture(allow()).exitCode).toBe(0);
      },
    );

    it("not a session-layout path inside a URL (the left boundary)", () => {
      writeFileSync(join(outputs, "n.md"), "see https://example.com/api/sessions/vm-1/mnt/x");
      expect(exportFixture(allow()).exitCode).toBe(0);
    });

    it.each([["/sessions/vm-1/mnt/outputs/x.md"], ["(/sessions/vm-1/.claude/settings.json)"]])("a guest session-layout path (%s)", (body) =>
      expectRunPath(body),
    );
  });

  it("resolves the outputs dir relative to a RELOCATED run dir", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    const moved = join(tmp, "moved");
    renameSync(run, moved);
    const r = exportFixture({ ...base(), runDir: moved });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual(["a.md"]);
    expect(r.outputsDir).toBe(join(moved, "work", "session", "mnt", "outputs"));
  });

  it("refuses a result.json whose outputsDir is the run dir itself", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    writeResult({ outputsDir: run });
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/not this run's outputs dir/);
    expect(readdirSync(tmp)).not.toContain("fixture");
  });

  it.skipIf(process.getuid?.() === 0)("lists an unreadable file under skipped (unreadable), never an internal error", () => {
    writeFileSync(join(outputs, "ok.md"), "fine");
    writeFileSync(join(outputs, "locked.md"), "no");
    chmodSync(join(outputs, "locked.md"), 0o000);
    try {
      const r = exportFixture(base());
      expect(r.exitCode).toBe(0);
      expect(r.written).toEqual(["ok.md"]);
      expect(r.skipped).toEqual([expect.objectContaining({ file: "locked.md", why: "unreadable" })]);
    } finally {
      chmodSync(join(outputs, "locked.md"), 0o644);
    }
  });

  it("lists a file refused at read time (FsRefusal) under skipped with its reason", () => {
    writeFileSync(join(outputs, "ok.md"), "fine");
    writeFileSync(join(outputs, "raced.md"), "x");
    const orig = NoFollowRoot.prototype.readBytes;
    const spy = vi.spyOn(NoFollowRoot.prototype, "readBytes").mockImplementation(function (this: NoFollowRoot, p: string) {
      if (p.endsWith("raced.md")) throw new FsRefusal("refusing to open through symlink: raced.md");
      return orig.call(this, p);
    });
    try {
      const r = exportFixture(base());
      expect(r.exitCode).toBe(0);
      expect(r.skipped).toEqual([{ file: "raced.md", why: "unreadable", reason: "refusing to open through symlink: raced.md" }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an --out inside the run dir (it would mutate the kept run)", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    const r = exportFixture({ ...base(), out: join(run, "fixture-copy", "deep") });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/inside the run dir/);
    expect(r.outputsDir).toBe(outputs);
    expect(r).not.toHaveProperty("written");
    expect(readdirSync(run)).not.toContain("fixture-copy");
  });

  it("on a write failure removes only what the export created, never pre-existing parents", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    writeFileSync(join(outputs, "b.md"), "B");
    mkdirSync(join(tmp, "pre"));
    writeFileSync(join(tmp, "pre", "keep.md"), "K");
    let n = 0;
    const orig = NoFollowRoot.prototype.createFile;
    const spy = vi.spyOn(NoFollowRoot.prototype, "createFile").mockImplementation(function (this: NoFollowRoot, ...a) {
      if (++n === 2) throw new FsRefusal("injected");
      return orig.apply(this, a);
    });
    try {
      const r = exportFixture({ ...base(), out: join(tmp, "pre", "new1", "new2") });
      expect(r.exitCode).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(join(tmp, "pre"))).toEqual(["keep.md"]);
  });

  it("on a write failure into an existing empty --out, leaves the --out dir itself", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    mkdirSync(join(outputs, "sub"));
    writeFileSync(join(outputs, "sub", "b.md"), "B");
    mkdirSync(join(tmp, "fixture"));
    let n = 0;
    const orig = NoFollowRoot.prototype.createFile;
    const spy = vi.spyOn(NoFollowRoot.prototype, "createFile").mockImplementation(function (this: NoFollowRoot, ...a) {
      if (++n === 2) throw new FsRefusal("injected");
      return orig.apply(this, a);
    });
    try {
      expect(exportFixture(base()).exitCode).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(join(tmp, "fixture"))).toEqual([]);
  });

  it("falls back to the highest turn that HAS a result.json", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    mkdirSync(join(run, "turns", "2"));
    const r = exportFixture(base());
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual(["a.md"]);
  });

  it("reports the source run's partial flag and result, and every post-scan refusal carries the payload", () => {
    writeResult({ partial: true, result: "error" });
    writeFileSync(join(outputs, "a.md"), "A");
    const ok = exportFixture(base());
    expect(ok).toMatchObject({ exitCode: 0, partial: true, result: "error" });
    rmSync(join(tmp, "fixture"), { recursive: true });
    mkdirSync(join(tmp, "fixture"));
    writeFileSync(join(tmp, "fixture", "x"), "x");
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r).toMatchObject({ outputsDir: outputs, skipped: [], notes: [], bytes: 1, partial: true, result: "error" });
  });

  it("refuses an empty outputs tree (nothing to resume from)", () => {
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/holds no regular files — nothing for a later step to resume from/);
  });

  it("refuses a run dir with no turns layout", () => {
    rmSync(join(run, "turns"), { recursive: true });
    const r = exportFixture(base());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/^fixture export: .* has neither a turns\/<N>\/ directory nor any pre-layout marker/);
  });

  it.skipIf(process.platform === "win32")("lists a FIFO in the outputs tree as not a regular file, without opening it", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    expect(spawnSync("mkfifo", [join(outputs, "pipe")]).status).toBe(0);
    const r = exportFixture(base());
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual(["a.md"]);
    expect(r.skipped).toEqual([{ file: "pipe", why: "not a regular file" }]);
  });

  it("exports a COPIED run dir from its own tree while the original still exists", () => {
    writeFileSync(join(outputs, "a.md"), "original");
    const copy = join(tmp, "copy");
    expect(spawnSync("cp", ["-R", run, copy]).status).toBe(0);
    writeFileSync(join(copy, "work", "session", "mnt", "outputs", "a.md"), "copied");
    writeFileSync(join(copy, "work", "session", "mnt", "outputs", "b.md"), "only in the copy");
    const r = exportFixture({ ...base(), runDir: copy });
    expect(r.exitCode).toBe(0);
    expect(r.outputsDir).toBe(join(copy, "work", "session", "mnt", "outputs"));
    expect(r.written).toEqual(["a.md", "b.md"]);
    expect(readFileSync(join(tmp, "fixture", "a.md"), "utf8")).toBe("copied");
  });

  it("reads the outputs shape the recorded outputsDir names (work/outputs), not the other one", () => {
    mkdirSync(join(run, "work", "outputs"));
    writeFileSync(join(run, "work", "outputs", "p.md"), "protocol");
    writeFileSync(join(outputs, "c.md"), "container");
    writeResult({ outputsDir: join(tmp, "gone", "work", "outputs") });
    const r = exportFixture(base());
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual(["p.md"]);
  });

  it.each([
    ["UTF-16LE", (s: string) => Buffer.from(s, "utf16le")],
    ["UTF-16BE", (s: string) => Buffer.from(s, "utf16le").swap16()],
  ])("refuses a secret stored as %s", (_n, enc) => {
    // The secret alone: with characters on both sides, a UTF-16 stream also contains the OTHER byte order shifted by
    // one byte, so a test with neighbours would pass with either form's check removed.
    writeFileSync(join(outputs, "wide.txt"), enc("TOP-SECRET-77"));
    const r = exportFixture({ ...base(), secrets: ["TOP-SECRET-77"] });
    expect(r.exitCode).toBe(2);
    expect(r.refused).toEqual([{ file: "wide.txt", kind: "secret" }]);
  });

  it("on a mkdir that fails partway down a multi-level path, removes the levels it already created", () => {
    mkdirSync(join(outputs, "l1", "l2"), { recursive: true });
    writeFileSync(join(outputs, "l1", "l2", "deep.md"), "D");
    mkdirSync(join(tmp, "fixture"));
    const orig = NoFollowRoot.prototype.mkdir;
    // Create the first level for real, then fail on the second — a partial `mkdir -p`.
    const spy = vi.spyOn(NoFollowRoot.prototype, "mkdir").mockImplementation(function (this: NoFollowRoot, dir: string) {
      orig.call(this, dirname(dir));
      throw new FsRefusal("injected at the second level");
    });
    try {
      expect(exportFixture(base()).exitCode).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(join(tmp, "fixture"))).toEqual([]);
  });

  it("a refusal BEFORE the scan carries no scan fields; one after it does", () => {
    writeResult({ command: "replay" });
    const pre = exportFixture(base());
    expect(pre.exitCode).toBe(2);
    for (const k of ["written", "skipped", "notes", "bytes"]) expect(pre).not.toHaveProperty(k);
    writeResult({ partial: true });
    const noOutputs = join(tmp, "elsewhere");
    mkdirSync(noOutputs);
    writeResult({ outputsDir: noOutputs, partial: true });
    const mid = exportFixture(base());
    expect(mid.exitCode).toBe(2);
    expect(mid).toMatchObject({ partial: true, result: "success" });
    for (const k of ["written", "skipped", "notes", "bytes"]) expect(mid).not.toHaveProperty(k);
    writeResult({});
    writeFileSync(join(outputs, "leak.md"), "TOP-SECRET-77");
    const post = exportFixture({ ...base(), secrets: ["TOP-SECRET-77"] });
    expect(post).toMatchObject({ exitCode: 2, written: [], skipped: [], notes: [], bytes: 13, outputsDir: outputs });
  });
});

describe("fixture export — the CLI", () => {
  const CLI = join(process.cwd(), "dist", "cli.js");
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("node", [CLI, "fixture", "export", ...args, "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "0", ...env },
    });

  it("exit 0 with one payload document carrying exactly the documented keys", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    const r = cli([run, "--out", join(tmp, "fixture")]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ command: "fixture", ok: true, written: ["a.md"], refused: [], error: null });
    const frame = new Set(["tool", "version", "command", "ok", "error", "budget"]);
    expect(
      Object.keys(doc)
        .filter((k) => !frame.has(k))
        .sort(),
    ).toEqual(["bytes", "message", "notes", "outputsDir", "partial", "refused", "result", "skipped", "written"].sort());
  });

  it("a secret in a file NAME never reaches stdout or stderr", () => {
    writeFileSync(join(outputs, "NAME-SECRET-99.md"), "x");
    const r = cli([run, "--out", join(tmp, "fixture")], { COWORK_HARNESS_SCRUB_VALUES: "NAME-SECRET-99" });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).refused).toEqual([{ file: "[REDACTED].md", kind: "secret" }]);
    expect(r.stdout + r.stderr).not.toContain("NAME-SECRET-99");
  });

  it("text mode says when the source run was incomplete or failed", () => {
    writeResult({ partial: true });
    writeFileSync(join(outputs, "a.md"), "A");
    const r = spawnSync("node", [CLI, "fixture", "export", run, "--out", join(tmp, "fixture")], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "0" },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/exported from an incomplete\/failed run — files may be truncated/);
  });

  it("a refusal before the scan carries no scan keys in the error envelope", () => {
    writeResult({ command: "replay" });
    const r = cli([run, "--out", join(tmp, "fixture")]);
    expect(r.status).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    for (const k of ["written", "skipped", "notes", "bytes"]) expect(doc).not.toHaveProperty(k);
  });

  it("a refusal is exit 2 with the error envelope carrying refused[] — and the secret never appears", () => {
    writeFileSync(join(outputs, "leak.md"), "k=VALUE-OF-A-SECRET-42");
    const r = cli([run, "--out", join(tmp, "fixture")], { COWORK_HARNESS_SCRUB_VALUES: "VALUE-OF-A-SECRET-42" });
    expect(r.status).toBe(2);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.refused).toEqual([{ file: "leak.md", kind: "secret" }]);
    expect(doc.error.category).toBe("runtime");
    expect(r.stdout + r.stderr).not.toContain("VALUE-OF-A-SECRET-42");
  });
});

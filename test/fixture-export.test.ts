import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFixture } from "../src/fixture/export.js";

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
    expect(r.notes.some((n) => n.file === "deck/slides.bin" && n.kind === "binary")).toBe(true);
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
    expect(r.message).toMatch(/outside the run dir/);
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
    expect(JSON.stringify(r)).not.toContain("sk-SECRET-123456");
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
    expect(r.notes.some((n) => n.file === "contact.md" && n.kind === "pii" && n.cls === "email")).toBe(true);
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

  it("refuses an empty outputs tree (nothing to resume from)", () => {
    expect(exportFixture(base()).exitCode).toBe(2);
  });

  it("refuses a run dir with no turns layout", () => {
    rmSync(join(run, "turns"), { recursive: true });
    expect(exportFixture(base()).exitCode).toBe(2);
  });
});

describe("fixture export — the CLI", () => {
  const CLI = join(process.cwd(), "dist", "cli.js");
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("node", [CLI, "fixture", "export", ...args, "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_FORBID_SPAWN: "0", ...env },
    });

  it("exit 0 with one payload document listing what was written", () => {
    writeFileSync(join(outputs, "a.md"), "A");
    const r = cli([run, "--out", join(tmp, "fixture")]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ command: "fixture", ok: true, written: ["a.md"], error: null });
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

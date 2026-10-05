import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// What stdout carries under --output-format json: a document in the standard frame, or nothing. Four
// commands broke that — `scaffold <run>` printed YAML, `lint --help` / `lint-skill --help` printed a
// usage-error document for a successful help request, `critique --help` printed its help on stdout, and
// `skill --dry-run` printed a bare object with no frame. Help goes to stderr (as it does for every other
// command, in both modes); a payload goes inside the envelope.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const { COWORK_HARNESS_OUTPUT_FORMAT: _inherited, ...inheritedEnv } = process.env;

function cli(args: string[], cwd?: string) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...inheritedEnv,
      COWORK_HARNESS_MODEL: "",
      COWORK_HARNESS_RUNS_DIR: join(mkdtempSync(join(tmpdir(), "stdout-content-runs-")), "runs"),
    },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function oneDoc(stdout: string, stderr: string): any {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`stdout is not exactly one JSON document (${(e as Error).message}):\n${stdout}\nstderr:\n${stderr}`);
  }
}

/** A kept run dir `scaffold` accepts: an events.jsonl from a committed cassette, next to a `turns/1/`. */
function keptRunDir(): string {
  const d = mkdtempSync(join(tmpdir(), "scaffold-json-"));
  const cassette = JSON.parse(readFileSync(resolve("examples/replays/example-pdf-skill.cassette.json"), "utf8"));
  writeFileSync(join(d, "events.jsonl"), (cassette.events as unknown[]).map((e) => JSON.stringify(e)).join("\n") + "\n");
  mkdirSync(join(d, "turns", "1"), { recursive: true });
  return d;
}

describe.skipIf(!can)("stdout under --output-format json is one framed document or nothing", () => {
  it("scaffold <run>: the scenario YAML is inside the envelope", () => {
    const d = keptRunDir();
    const r = cli(["scaffold", d, "--output-format", "json"]);
    expect(r.code, r.stderr).toBe(0);
    const doc = oneDoc(r.stdout, r.stderr);
    expect(doc.command).toBe("scaffold");
    expect(doc.ok).toBe(true);
    expect(doc.error).toBe(null);
    expect(doc.scenario).toMatch(/prompt:/);
    expect(doc.out).toBe(null);
  });

  it("scaffold <run> --out: the envelope names the file it wrote", () => {
    const d = keptRunDir();
    const outFile = join(d, "out", "s.yaml");
    const r = cli(["scaffold", d, "--out", outFile, "--output-format", "json"]);
    expect(r.code, r.stderr).toBe(0);
    const doc = oneDoc(r.stdout, r.stderr);
    expect(doc.out).toBe(outFile);
    expect(doc.scenario).toBe(readFileSync(outFile, "utf8"));
  });

  it("scaffold <run> in text mode still prints the YAML on stdout", () => {
    const d = keptRunDir();
    const r = cli(["scaffold", d]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/prompt:/);
  });

  for (const cmd of ["lint", "lint-skill"]) {
    for (const mode of [["--output-format", "json"], []]) {
      it(`${cmd} --help ${mode.join(" ")}: help on stderr, stdout empty, exit 0`.trim(), () => {
        const r = cli([cmd, "--help", ...mode]);
        expect(r.code, r.stderr).toBe(0);
        expect(r.stdout).toBe("");
        expect(r.stderr).toMatch(/usage/);
      });
    }
  }

  for (const mode of [["--output-format", "json"], []]) {
    it(`critique --help ${mode.join(" ")}: help on stderr, stdout empty, exit 0`.trim(), () => {
      const r = cli(["critique", "--help", ...mode]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/usage/);
    });
  }

  it("skill --dry-run: the preview is inside the envelope under json", () => {
    const plugin = mkdtempSync(join(tmpdir(), "skill-dry-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const r = cli(["skill", plugin, "hi", "--dry-run", "--output-format", "json"]);
    expect(r.code, r.stderr).toBe(0);
    const doc = oneDoc(r.stdout, r.stderr);
    expect(doc.tool).toBe("cowork-harness");
    expect(doc.command).toBe("skill");
    expect(doc.ok).toBe(true);
    expect(doc.dryRun).toBe(true);
    expect(doc.error).toBe(null);
    expect(doc.prompt).toBe("hi");
    expect(doc.model).toBe(null);
  });

  it("skill --dry-run in text mode still prints the bare preview object", () => {
    const plugin = mkdtempSync(join(tmpdir(), "skill-dry-"));
    writeFileSync(join(plugin, "SKILL.md"), "---\nname: p\ndescription: d\n---\nbody\n");
    const r = cli(["skill", plugin, "hi", "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj.tool).toBeUndefined();
    expect(obj.prompt).toBe("hi");
  });
});

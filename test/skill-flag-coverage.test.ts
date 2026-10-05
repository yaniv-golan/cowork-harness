import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Name guard for the companion skill: every long flag a CLI usage text prints, and every `error.code` value a
// machine-output schema declares, must appear somewhere in SKILL.md or references/*.md, or be on the allowlist
// below with its reason. Both lists are derived from the real sources: the flags from `--help` of every command
// in src/cli.ts's COMMANDS array (and the top-level help), run against dist/cli.js; the codes from the
// schema files. Nothing is copied by hand.
//
// It checks names only. A flag can be named in a passage that no longer describes what it does, so this test
// passes while the instructions go stale; the release checklist's companion-skill reconcile step covers that.
// Needs dist/cli.js (the `ci` script and the CI test job build first; the job fails if it is missing).

const SKILL_DIR = resolve(".claude/skills/cowork-harness");
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

/** Flags and codes that do not belong in the skill, each with the reason. Keep it small: a user-facing flag or
 *  code the skill does not mention is a gap to fix in the skill, not an entry here. */
const ALLOWLIST: Record<string, string> = {
  "--diff":
    "only `sync --diff`, which compares a live Claude Desktop install with the shipped baseline: baseline maintenance, not skill testing",
  "--strict-independent": "not a flag: help prose (analyze-skill's exit 3 holds whether or not --strict is passed)",
};

function skillDocs(): string {
  const refsDir = join(SKILL_DIR, "references");
  const refs = readdirSync(refsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(refsDir, f), "utf8"));
  return [readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"), ...refs].join("\n");
}

/** A token counts when it appears as itself, not as the prefix or suffix of a longer token. */
const mentions = (doc: string, token: string): boolean =>
  new RegExp(`(?<![\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(doc);

function commands(): string[] {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");
  const at = src.indexOf("const COMMANDS = [");
  const block = src.slice(at, src.indexOf("]", at));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function helpText(args: string[]): { code: number | null; text: string } {
  const cwd = mkdtempSync(join(tmpdir(), "cc-flagcov-")); // isolated cwd: no stray .env is loaded
  const r = spawnSync("node", [CLI, ...args, "--help"], { encoding: "utf8", cwd });
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

/** Every long flag in every command's help, with the commands that print it, and any help that failed. */
function helpFlags(): { flags: Map<string, Set<string>>; failed: string[] } {
  const flags = new Map<string, Set<string>>();
  const failed: string[] = [];
  for (const args of [[], ...commands().map((c) => [c])]) {
    const { code, text } = helpText(args);
    if (code !== 0) failed.push(`${args.join(" ") || "(top level)"} --help exited ${code}`);
    for (const m of text.matchAll(/(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g)) {
      const set = flags.get(m[0]) ?? new Set<string>();
      set.add(args.join(" ") || "(top level)");
      flags.set(m[0], set);
    }
  }
  return { flags, failed };
}

/** Every `code` enum under an `error` object or a `refusals[]` item, in every schema file. */
function schemaErrorCodes(): Map<string, string> {
  const codes = new Map<string, string>();
  const walk = (node: unknown, path: string[], file: string): void => {
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const code = (o.properties as Record<string, { enum?: unknown[] }> | undefined)?.code;
    const parent = path.filter((p) => p !== "properties" && p !== "items").at(-1);
    if (Array.isArray(code?.enum) && (parent === "error" || parent === "refusals"))
      for (const v of code.enum) if (typeof v === "string") codes.set(v, `${file} ${path.join("/")}`);
    for (const [k, v] of Object.entries(o)) walk(v, [...path, k], file);
  };
  for (const f of readdirSync(resolve("schema")).filter((x) => x.endsWith(".json")))
    walk(JSON.parse(readFileSync(resolve("schema", f), "utf8")), [], f);
  return codes;
}

describe.skipIf(!can)("skill docs mention every CLI long flag", () => {
  const { flags, failed } = helpFlags();
  const docs = skillDocs();

  it("derived a sane flag set (guards against the help parse silently emptying this test)", () => {
    expect(failed).toEqual([]);
    expect(flags.size).toBeGreaterThan(100);
    for (const f of ["--fidelity", "--allow-scrub-change", "--rejudge", "--output-format"]) expect(flags.has(f), f).toBe(true);
  });

  it("every flag a usage text prints appears in SKILL.md or references/*.md, or is allowlisted", () => {
    const missing = [...flags]
      .filter(([f]) => !(f in ALLOWLIST) && !mentions(docs, f))
      .map(([f, cmds]) => `${f} (${[...cmds].join(", ")})`);
    expect(missing, `the companion skill never mentions: ${missing.join("; ")} — teach it, or allowlist it with a reason`).toEqual([]);
  });

  it("every allowlisted flag is still printed by some usage text (a stale entry hides nothing and misleads)", () => {
    const stale = Object.keys(ALLOWLIST).filter((f) => f.startsWith("--") && !flags.has(f));
    expect(stale).toEqual([]);
  });
});

describe("skill docs mention every error.code in schema/*.json", () => {
  const codes = schemaErrorCodes();
  const docs = skillDocs();

  it("derived a sane code set", () => {
    expect(codes.size).toBeGreaterThan(3);
    expect(codes.has("rubric_unverifiable")).toBe(true);
  });

  it("every error.code value appears in SKILL.md or references/*.md, or is allowlisted", () => {
    const missing = [...codes].filter(([c]) => !(c in ALLOWLIST) && !mentions(docs, c)).map(([c, where]) => `${c} (${where})`);
    expect(missing, `the companion skill never mentions: ${missing.join("; ")}`).toEqual([]);
  });
});

// Contract test against the published hillclimb report builder. The upstream files are fetched at test time
// from a pinned commit and never committed (they are not ours to bundle). The pins are sha256s: a moved pin is a
// deliberate test change, never a surprise.
//
// What passing means: the lite builder at the pinned commit reads our fixture flow with no warning, counts the
// variants and cases we expect, writes the per-case means we compute independently, and links every trace. It
// says nothing about the full report viewer, which is not published.
//
// Network: a fetch failure skips loudly. With COWORK_HARNESS_CONTRACT_FETCH=required (CI), it fails instead.
// A fetched file whose sha256 differs from its pin always FAILS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFlowDir, SCHEMA_READING_COMMIT, VARIANT_DIR_RE } from "../src/hillclimb/schema-check.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "hillclimb-flow");

const UPSTREAM_PATH = "skills/claude-api/shared/evals/report";
const PINS: Record<string, string> = {
  "build-report-lite.mjs": "af79ca5fa5f06747dbcaa1d40017c8c8e81e0aa11cb8e32b848043893cdb03c7",
  "SCHEMA.md": "9a83404a9b3c413113df39d9bdf08e003ff4d6a75386f4010887da3298766687",
  "runner-scaffold.mjs": "c3a87ba4b94b3018b83c075d5148ba7760580aa447699d513d45ab55b82a531a",
};
const FETCHED = ["build-report-lite.mjs", "SCHEMA.md"] as const;
const FETCH_REQUIRED = process.env.COWORK_HARNESS_CONTRACT_FETCH === "required";
const FETCH_TIMEOUT_MS = 20_000;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

let work = "";
let skipReason: string | undefined;
const upstream: Record<string, Buffer> = {};

beforeAll(
  async () => {
    work = mkdtempSync(join(tmpdir(), "hc-lite-contract-"));
    try {
      for (const name of FETCHED) {
        const url = `https://raw.githubusercontent.com/anthropics/skills/${SCHEMA_READING_COMMIT}/${UPSTREAM_PATH}/${name}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
        upstream[name] = Buffer.from(await res.arrayBuffer());
      }
    } catch (e) {
      const why = `could not fetch the pinned hillclimb report files: ${e instanceof Error ? e.message : String(e)}`;
      if (FETCH_REQUIRED) throw new Error(`${why} (COWORK_HARNESS_CONTRACT_FETCH=required)`);
      skipReason = why;
      console.warn(`SKIPPING hillclimb lite contract: ${why}. Set COWORK_HARNESS_CONTRACT_FETCH=required to make this a failure.`);
    }
  },
  FETCH_TIMEOUT_MS * FETCHED.length + 5_000,
);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** The lite builder, written into the temp dir — only once its bytes equal the pin. */
function liteScript(): string {
  const bytes = upstream["build-report-lite.mjs"]!;
  const got = sha256(bytes);
  if (got !== PINS["build-report-lite.mjs"]) throw new Error(`build-report-lite.mjs sha256 ${got} is not the pin; refusing to run it`);
  const p = join(work, "build-report-lite.mjs");
  if (!existsSync(p)) writeFileSync(p, bytes);
  return p;
}

/** A fresh copy of the fixture flow (the builder writes report.html and trajectory/ into it). Absolute path. */
function copyFlow(tag: string): string {
  const flow = join(work, tag, "flow");
  mkdirSync(dirname(flow), { recursive: true });
  cpSync(FIXTURE, flow, { recursive: true });
  return flow;
}

function runLite(flow: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [liteScript(), flow], { cwd: work, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

type Row = { prompt_id: string; rep: number; status?: string; grade: Record<string, number | boolean> };

function readRows(file: string): Row[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
}

/** A grade value as the report reads it: a number or boolean in the dict form, else nothing (a bare or
 *  non-numeric grade contributes no value, so the cell comes out empty rather than as a wrong number). */
function gradeValue(grade: unknown, metric: string): number | undefined {
  if (typeof grade !== "object" || grade === null || Array.isArray(grade)) return undefined;
  const v = (grade as Record<string, unknown>)[metric];
  if (typeof v === "boolean") return Number(v);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Independent of the builder: variants in scaffold order, cases in first-seen order, per-case mean of the
 *  primary metric (first declared binary) over reps whose status is absent or "ok", to 3 decimals. */
function expectedScores(flow: string): { variants: string[]; cases: string[]; tsv: string } {
  const variants = readdirSync(flow)
    .filter((n) => VARIANT_DIR_RE.test(n) && statSync(join(flow, n)).isDirectory())
    .sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : Number(a.slice(1)) - Number(b.slice(1))));
  const state = JSON.parse(readFileSync(join(flow, "_state.json"), "utf8")) as {
    metrics: { id: string; kind: string }[];
    train_ids?: string[];
    val_ids?: string[];
    test_ids?: string[];
  };
  const primary = (state.metrics.find((m) => m.kind === "binary") ?? state.metrics[0]!).id;
  const split = new Map<string, string>();
  for (const sp of ["train", "val", "test"] as const) for (const id of state[`${sp}_ids`] ?? []) split.set(id, sp);
  const byVariant = new Map(variants.map((v) => [v, readRows(join(flow, v, "results.jsonl"))]));
  const cases: string[] = [];
  for (const v of variants) for (const r of byVariant.get(v)!) if (!cases.includes(r.prompt_id)) cases.push(r.prompt_id);
  const lines = [["id", "split", ...variants].join("\t")];
  for (const id of cases) {
    const cells = variants.map((v) => {
      const vals = byVariant
        .get(v)!
        .filter((r) => r.prompt_id === id && (r.status === undefined || r.status === "ok"))
        .map((r) => gradeValue(r.grade, primary))
        .filter((x): x is number => x !== undefined);
      return vals.length ? (vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(3) : "";
    });
    lines.push([id, split.get(id) ?? "all", ...cells].join("\t"));
  }
  return { variants, cases, tsv: lines.join("\n") + "\n" };
}

function traceFiles(flow: string): { variant: string; file: string; id: string; rep: string }[] {
  const out: { variant: string; file: string; id: string; rep: string }[] = [];
  for (const v of readdirSync(flow).filter((n) => VARIANT_DIR_RE.test(n)))
    for (const f of readdirSync(join(flow, v, "traces"))) {
      const m = /^(.+)_rep(\d+)\.json$/.exec(f);
      if (m) out.push({ variant: v, file: f, id: m[1]!, rep: m[2]! });
    }
  return out;
}

describe("hillclimb lite report builder contract (anthropics/skills@8a1541c4a3ff)", () => {
  it("the fetched upstream files match their sha256 pins", (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    for (const name of FETCHED) expect(sha256(upstream[name]!), name).toBe(PINS[name]);
  });

  it("builds the fixture flow with no warning, the expected header, independent per-case means and a link per trace", (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const flow = copyFlow("clean");
    const { variants, cases, tsv } = expectedScores(flow);
    // The fixture must exercise what the test claims: >=2 cases, 2 reps, baseline + v1, a truncated rep.
    expect(variants).toEqual(["baseline", "v1"]);
    expect(cases.length).toBeGreaterThanOrEqual(2);

    const r = runLite(flow);
    const lines = r.stderr.split("\n").filter(Boolean);
    expect(r.stdout).toBe("");
    expect(
      lines.filter((l) => l.startsWith("warning:")),
      r.stderr,
    ).toEqual([]);
    expect(r.stderr).toContain(`(${variants.length} variants, ${cases.length} cases)`);
    expect(r.status, r.stderr).toBe(0);

    const got = readFileSync(join(flow, "trajectory", "scores.tsv"), "utf8");
    expect(got).toBe(tsv);

    // The truncated rep is kept out of the mean: v1 long-answer has reps pass=1 (ok) and pass=0 (truncated),
    // so 1.000 here, where a mean over every rep would be 0.500.
    const v1Rows = readRows(join(flow, "v1", "results.jsonl")).filter((row) => row.prompt_id === "long-answer");
    expect(v1Rows.map((row) => [row.status, row.grade.pass])).toEqual([
      ["ok", 1],
      ["truncated", 0],
    ]);
    const longAnswer = got.split("\n").find((l) => l.startsWith("long-answer\t"))!;
    expect(longAnswer.split("\t")[3]).toBe("1.000");
    for (const row of got.trim().split("\n").slice(1)) {
      const cells = row.split("\t").slice(2);
      expect(cells.length).toBe(variants.length);
      for (const c of cells) expect(c, row).toMatch(/^\d\.\d{3}$/);
    }

    const html = readFileSync(join(flow, "report.html"), "utf8");
    const traces = traceFiles(flow);
    expect(traces.length).toBe(12);
    for (const t of traces) expect(html, `${t.variant}/${t.file}`).toContain(`<a href="${t.variant}/traces/${t.file}">rep${t.rep}</a>`);
    expect(html.match(/>rep\d+<\/a>/g)?.length).toBe(traces.length);
  });

  it("the same fixture passes our schema-check with no finding", () => {
    const r = checkFlowDir(FIXTURE);
    expect(r.findings, JSON.stringify(r.findings, null, 1)).toEqual([]);
  });

  // Negative controls: the green above is evidence only if the same instruments can show red.
  it("control: a mis-named variant dir makes the builder warn, and schema-check flags it", (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const flow = copyFlow("misnamed");
    cpSync(join(flow, "v1"), join(flow, "v2-better"), { recursive: true });
    const r = runLite(flow);
    expect(r.stderr.split("\n").some((l) => l.startsWith("warning:") && l.includes("v2-better"))).toBe(true);
    expect(checkFlowDir(flow).findings.some((f) => f.rule === "variant.name" && f.file === "v2-better")).toBe(true);
  });

  it("control: a bare-boolean grade exits 0 with no warning yet blanks the cell; only schema-check catches it", (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const flow = copyFlow("bare-grade");
    const file = join(flow, "v1", "results.jsonl");
    const rows = readRows(file).map((r) => (r.prompt_id === "extract-table" ? { ...r, grade: true } : r));
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = runLite(flow);
    expect(r.status).toBe(0);
    expect(r.stderr.split("\n").filter((l) => l.startsWith("warning:"))).toEqual([]);
    const row = readFileSync(join(flow, "trajectory", "scores.tsv"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("extract-table\t"))!;
    expect(row.split("\t")[3]).toBe("");
    expect(checkFlowDir(flow).findings.filter((f) => f.rule === "row.grade" && f.level === "error").length).toBe(2);
  });
});

/** The locally bundled copy of the skill, if this machine has one, must still match the pins. */
describe("hillclimb report files in the local skill bundle match the pins", () => {
  it("every bundled report/ file with a pin has the pinned sha256", (ctx) => {
    const uid = process.getuid?.();
    if (uid === undefined) return ctx.skip("no POSIX uid on this platform");
    const root = `/private/tmp/claude-${uid}/bundled-skills`;
    const reportDirs: { version: string; dir: string }[] = [];
    if (existsSync(root))
      for (const version of readdirSync(root))
        for (const hash of existsSync(join(root, version)) && statSync(join(root, version)).isDirectory()
          ? readdirSync(join(root, version))
          : []) {
          const dir = join(root, version, hash, "claude-api", "shared", "evals", "report");
          if (existsSync(dir)) reportDirs.push({ version, dir });
        }
    if (!reportDirs.length) {
      console.warn(`SKIPPING local-bundle drift check: no ${root}/*/*/claude-api/shared/evals/report/ on this machine`);
      return ctx.skip("no local claude-api skill bundle");
    }
    const drift: string[] = [];
    for (const { version, dir } of reportDirs) {
      const present = readdirSync(dir);
      for (const [name, pin] of Object.entries(PINS)) {
        if (!present.includes(name)) {
          drift.push(`bundle ${version}: ${name} is missing`);
          continue;
        }
        const got = sha256(readFileSync(join(dir, name)));
        if (got !== pin) drift.push(`bundle ${version}: ${name} sha256 ${got.slice(0, 12)}… differs from pin ${pin.slice(0, 12)}…`);
      }
      const unpinned = present.filter((n) => !(n in PINS));
      if (unpinned.length) console.warn(`bundle ${version} has unpinned report/ files: ${unpinned.join(", ")}`);
    }
    expect(drift, "the local claude-api bundle moved away from the pinned hillclimb sources; re-read them and move the pins").toEqual([]);
  });
});

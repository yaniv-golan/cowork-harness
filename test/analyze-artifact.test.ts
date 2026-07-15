import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { analyzeArtifactFile, collectArtifactSources, analyzeArtifacts } from "../src/run/analyze-artifact.js";

// This repo is pure ESM ("type": "module") — `__dirname` is undefined; derive the repo root from
// `import.meta.url` instead (this file lives at `<repoRoot>/test/analyze-artifact.test.ts`).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "analyze-artifact");

function fixture(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

// --------------------------------------------------------------------------------------------- //
// Cleanup registry for ad hoc temp dirs (permission-based failure injection, oversized files) that
// must not be committed to the repo as static fixtures.
// --------------------------------------------------------------------------------------------- //
const cleanupPaths: { path: string; restoreMode?: number }[] = [];
afterEach(() => {
  while (cleanupPaths.length) {
    const entry = cleanupPaths.pop()!;
    try {
      if (entry.restoreMode !== undefined) chmodSync(entry.path, entry.restoreMode);
    } catch {
      // best effort
    }
    try {
      rmSync(entry.path, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "analyze-artifact-"));
  cleanupPaths.push({ path: dir });
  return dir;
}

// ================================================================================================= //
// §B2/§B3 outcome matrix (a)-(j) — analyzeArtifactFile / analyzeArtifacts
// ================================================================================================= //

describe("analyzeArtifactFile — outcome matrix", () => {
  it("(a) .py generator with a lost relative POST -> artifact-write-back-lost (error)", () => {
    const path = fixture("a-lost-relative-post", "scripts", "generate_review.py");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.finding).toBeDefined();
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
    expect(result.finding?.severity).toBe("error");
    expect(result.finding?.path).toBe(path);
  });

  it('(b) "/api/check" local-fallback with response consulted -> artifact-write-back-suspect (advisory)', () => {
    const path = fixture("b-suspect-local-fallback", "review_inputs.py");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.finding).toBeDefined();
    expect(result.finding?.rule).toBe("artifact-write-back-suspect");
    expect(result.finding?.severity).toBe("advisory");
  });

  it("(c) parseable is_static-guarded write-back with an UNKNOWN runtime value -> suspect, NOT clean", () => {
    const path = fixture("c-suspect-unresolved-guard", "viewer.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.finding).toBeDefined();
    expect(result.finding?.rule).toBe("artifact-write-back-suspect");
    expect(result.finding?.severity).toBe("advisory");
    // The headline false-green: a merely LEXICAL guard match must never clear to clean.
  });

  it("(d) candidate with no RELATIVE write-back (only an absolute remote fetch) -> clean", () => {
    const path = fixture("d-clean-no-writeback", "report.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({});
  });

  it("(e) unparseable candidate (invalid JS from an unresolved template placeholder) -> failure stage=parse", () => {
    const path = fixture("e-parse-failure", "generate.py");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.finding).toBeUndefined();
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("parse");
    expect(result.failure?.path).toBe(path);
    expect(result.failure?.reason.length).toBeGreaterThan(0);
  });

  it("(f) ordinary .py with no browser+write-back markers -> not scanned (no finding, no failure)", () => {
    const path = fixture("f-not-candidate", "utils.py");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({});
  });

  it("(h) declarative .html whose only write-back is <form method=post action=/...> -> lost (HTML-inherent candidacy)", () => {
    const path = fixture("h-declarative-form", "submit.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.finding).toBeDefined();
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
    expect(result.finding?.severity).toBe("error");
  });

  it("a provable build-time-truthy guard (materialized is_static:true) -> clean (dead code)", () => {
    const path = fixture("provable-truthy-clean", "viewer.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({});
  });

  it("bonus: control flow the analyzer can't represent as a guard (switch case) -> failure stage=unsupported-guard", () => {
    const path = fixture("unsupported-guard", "viewer.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.finding).toBeUndefined();
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("unsupported-guard");
  });

  it("bonus: a source exceeding the byte cap -> failure stage=size, without attempting candidacy/parse", () => {
    const path = "/virtual/oversized.html";
    const huge = `<script>fetch("/api/x",{method:"POST"});</script>` + "x".repeat(3_000_001);
    const result = analyzeArtifactFile(path, huge);
    expect(result.finding).toBeUndefined();
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("size");
  });

  it("bonus: a source that blows the parser-node cap -> failure stage=node-limit", () => {
    const path = "/virtual/huge-script.html";
    const statements = Array.from({ length: 8000 }, (_, i) => `var x${i}=${i};`).join("\n");
    const text = `<html><body><script>\nfetch("/api/x",{method:"POST"});\n${statements}\n</script></body></html>`;
    const result = analyzeArtifactFile(path, text);
    expect(result.finding).toBeUndefined();
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("node-limit");
  });

  it("a candidate .py with browser+write-back markers but no isolatable <script> block -> failure stage=extract", () => {
    const path = "/virtual/generate_no_script.py";
    // Markers present (document., fetch() ) but never co-located inside a <script>...</script> pair —
    // nothing for the extractor to isolate.
    const text = [
      'HELPER = """',
      "document.title = 'x';",
      '"""',
      "",
      'CALL = """',
      'fetch("/api/feedback", {method: "POST"});',
      '"""',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding).toBeUndefined();
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("extract");
  });

  it("a non-source extension is never even a candidate (returns {})", () => {
    const result = analyzeArtifactFile("/virtual/README.md", '<script>fetch("/api/x",{method:"POST"})</script>');
    expect(result).toEqual({});
  });
});

describe("analyzeArtifacts — (j) precedence / aggregation across files", () => {
  it("(j) an artifact-write-back-lost finding AND an analysisFailures entry both surface from one run", () => {
    const lostTarget = fixture("a-lost-relative-post");
    const brokenDir = makeTmpDir();
    const nested = join(brokenDir, "unreadable");
    mkdirSync(nested);
    writeFileSync(join(nested, "x.html"), "<script>fetch('/api/x',{method:'POST'})</script>");
    chmodSync(nested, 0o000);
    cleanupPaths.push({ path: nested, restoreMode: 0o755 });

    const { findings, analysisFailures } = analyzeArtifacts([lostTarget, nested]);

    expect(findings.some((f) => f.rule === "artifact-write-back-lost")).toBe(true);
    expect(analysisFailures.some((f) => f.stage === "select")).toBe(true);
  });
});

// ================================================================================================= //
// Source-collection tests — the §B2 collection contract itself
// ================================================================================================= //

describe("collectArtifactSources — target shapes", () => {
  it("individual file target: selects the file iff it has a source extension", () => {
    const path = fixture("d-clean-no-writeback", "report.html");
    const { files, failures } = collectArtifactSources(path);
    expect(failures).toEqual([]);
    expect(files).toEqual([resolve(path)]);
  });

  it("individual file target with a non-source extension: selects nothing, no failure", () => {
    const path = fixture("collection", "standalone-skill", "references", "notes.md");
    const { files, failures } = collectArtifactSources(path);
    expect(files).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("standalone skill dir: reaches scripts/ (which the markdown resolver never reaches)", () => {
    const dir = fixture("collection", "standalone-skill");
    const { files, failures } = collectArtifactSources(dir);
    expect(failures).toEqual([]);
    expect(files).toContain(resolve(dir, "scripts", "generate.py"));
    // references/notes.md is not a source extension — must not appear.
    expect(files.some((f) => f.endsWith("notes.md"))).toBe(false);
  });

  it("plugin root: unions EACH contained skill's subtree (skill-a AND skill-b)", () => {
    const dir = fixture("collection", "plugin-root");
    const { files, failures } = collectArtifactSources(dir);
    expect(failures).toEqual([]);
    expect(files).toContain(resolve(dir, "skills", "skill-a", "scripts", "bad.py"));
    expect(files).toContain(resolve(dir, "skills", "skill-b", "references", "other.js"));
  });

  it("nested-plugin skill (skill-a targeted directly): excludes sibling skill-b entirely", () => {
    const skillA = fixture("collection", "plugin-root", "skills", "skill-a");
    const { files, failures } = collectArtifactSources(skillA);
    expect(failures).toEqual([]);
    expect(files).toContain(resolve(skillA, "scripts", "bad.py"));
    expect(files.some((f) => f.includes(`${join("skills", "skill-b")}`))).toBe(false);
  });

  it("glob (dir/**/*.py, recursive): matches nested source files under the given root", () => {
    const dir = fixture("collection", "plugin-root");
    const { files, failures } = collectArtifactSources(`${dir}/**/*.py`);
    expect(failures).toEqual([]);
    expect(files).toContain(resolve(dir, "skills", "skill-a", "scripts", "bad.py"));
  });

  it("glob (dir/*.html, shallow): matches only direct children, not nested files", () => {
    const dir = fixture("d-clean-no-writeback");
    const { files, failures } = collectArtifactSources(`${dir}/*.html`);
    expect(failures).toEqual([]);
    expect(files).toEqual([resolve(dir, "report.html")]);
  });

  it("an unreadable directory -> failures[stage=select], never a silent empty result", () => {
    const dir = makeTmpDir();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "x.html"), "<script>fetch('/api/x',{method:'POST'})</script>");
    chmodSync(locked, 0o000);
    cleanupPaths.push({ path: locked, restoreMode: 0o755 });

    const { files, failures } = collectArtifactSources(locked);
    expect(files).toEqual([]);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].stage).toBe("select");
    expect(failures[0].path).toBe(locked);
  });

  it("dedup: a file reached via two overlapping targets (plugin root + its own skill dir) is analyzed once", () => {
    const pluginRoot = fixture("collection", "plugin-root");
    const skillA = fixture("collection", "plugin-root", "skills", "skill-a");
    const { findings } = analyzeArtifacts([pluginRoot, skillA]);
    const lostForBad = findings.filter((f) => f.path.endsWith(join("skill-a", "scripts", "bad.py")));
    expect(lostForBad).toHaveLength(1);
  });

  it("a nonexistent target -> failures[stage=select]", () => {
    const { files, failures } = collectArtifactSources(fixture("does-not-exist"));
    expect(files).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0].stage).toBe("select");
  });
});

// ================================================================================================= //
// Legacy /sessions rule severities (imported types must keep the three legacy rules gating) — a light
// sanity check that this module's own outcome-ID additions don't collide with the existing rule ids.
// ================================================================================================= //
describe("rule-id sanity", () => {
  it("Item 1 outcome ids are distinct from the three legacy /sessions rule ids", () => {
    const legacy = new Set(["sessions-path-to-file-tool", "sessions-find-into-file-read", "unclosed-ignore-fence"]);
    expect(legacy.has("artifact-write-back-lost")).toBe(false);
    expect(legacy.has("artifact-write-back-suspect")).toBe(false);
  });
});

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}

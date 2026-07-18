import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    expect(result.findings[0]).toBeDefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
    expect(result.findings[0]?.severity).toBe("error");
    expect(result.findings[0]?.path).toBe(path);
  });

  it('(b) "/api/check" local-fallback with response consulted -> artifact-write-back-suspect (advisory)', () => {
    const path = fixture("b-suspect-local-fallback", "review_inputs.py");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]).toBeDefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect");
    expect(result.findings[0]?.severity).toBe("advisory");
  });

  it("(c) parseable is_static-guarded write-back with an UNKNOWN runtime value -> suspect, NOT clean", () => {
    const path = fixture("c-suspect-unresolved-guard", "viewer.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]).toBeDefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect");
    expect(result.findings[0]?.severity).toBe("advisory");
    // The headline false-green: a merely LEXICAL guard match must never clear to clean.
  });

  it("(d) candidate with no RELATIVE write-back (only an absolute remote fetch) -> clean", () => {
    const path = fixture("d-clean-no-writeback", "report.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({ findings: [] });
  });

  it("(e) unparseable candidate (invalid JS from an unresolved template placeholder) -> failure stage=parse", () => {
    const path = fixture("e-parse-failure", "generate.py");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("parse");
    expect(result.failure?.path).toBe(path);
    expect(result.failure?.reason.length).toBeGreaterThan(0);
  });

  it("(f) ordinary .py with no browser+write-back markers -> not scanned (no finding, no failure)", () => {
    const path = fixture("f-not-candidate", "utils.py");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({ findings: [] });
  });

  it("(h) declarative .html whose only write-back is <form method=post action=/...> -> lost (HTML-inherent candidacy)", () => {
    const path = fixture("h-declarative-form", "submit.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]).toBeDefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("a provable build-time-truthy guard (materialized is_static:true) -> clean (dead code)", () => {
    const path = fixture("provable-truthy-clean", "viewer.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({ findings: [] });
  });

  it("bonus: control flow the analyzer can't represent as a guard (switch case) -> failure stage=unsupported-guard", () => {
    const path = fixture("unsupported-guard", "viewer.html");
    const text = readFileText(path);
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("unsupported-guard");
  });

  it("bonus: a source exceeding the byte cap -> failure stage=size, without attempting candidacy/parse", () => {
    const path = "/virtual/oversized.html";
    const huge = `<script>fetch("/api/x",{method:"POST"});</script>` + "x".repeat(3_000_001);
    const result = analyzeArtifactFile(path, huge);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("size");
  });

  it("bonus: a source that blows the parser-node cap -> failure stage=node-limit", () => {
    const path = "/virtual/huge-script.html";
    const statements = Array.from({ length: 8000 }, (_, i) => `var x${i}=${i};`).join("\n");
    const text = `<html><body><script>\nfetch("/api/x",{method:"POST"});\n${statements}\n</script></body></html>`;
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
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
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("extract");
  });

  it("a non-source extension is never even a candidate (returns {})", () => {
    const result = analyzeArtifactFile("/virtual/README.md", '<script>fetch("/api/x",{method:"POST"})</script>');
    expect(result).toEqual({ findings: [] });
  });

  // ---- phantom-<script>-block regression (docstring/comment prose mis-extracted by the lexical regex) ----

  it("phantom <script> in a docstring (no write-back hint) does NOT sink the real parseable block", () => {
    const path = "/virtual/probe.py";
    const text = [
      '"""Emit an interactive HTML review page from a Python generator."""',
      "",
      'TEMPLATE = """<!doctype html><body>',
      '<button id="save">Save</button>',
      "<script>",
      'document.getElementById("save").onclick = function () {',
      '  fetch("/api/save", { method: "POST", body: JSON.stringify(window.state) })',
      '    .then(function (r) { if (!r.ok) throw new Error("server"); })',
      "    .catch(function () { /* download fallback */ });",
      "};",
      "</script>",
      '</body>"""',
      "",
      "def _embed(data):",
      '    """Encode for a <script> block: escape \'<\' so a value with \'</script>\' stays inert."""',
      "    return data",
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    // The real block is adjudicated (advisory suspect via the fall-through branch — OK_CHECK_RE wants
    // resp/res/response.ok, so `r.ok` is not matched); the prose block is discounted, not fatal.
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]).toBeDefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect");
  });

  it("phantom <script> prose alongside a LOST real block still reports the lost finding, no failure", () => {
    const path = "/virtual/lost-plus-prose.py";
    const text = [
      'TEMPLATE = """<script>',
      'fetch("/api/save", { method: "POST" });',
      'alert("Saved successfully");',
      '</script>"""',
      "",
      "def _doc():",
      '    """See <script>the save handler</script> for details."""',
      "    return None",
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]).toBeDefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
    expect(result.findings[0]?.severity).toBe("error");
  });

  it("an unparseable block that DOES carry a write-back hint stays could-not-verify (no silent pass)", () => {
    const path = "/virtual/clean-plus-broken.py";
    const text = [
      'CLEAN = """<script>',
      'document.title = "ok";',
      '</script>"""',
      'BROKEN = """<script>',
      'fetch("/api/" + ${OOPS}, { method: "POST" });',
      '</script>"""',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("parse");
  });

  it("a real lost write-back AND a genuinely-unparseable hint block surface BOTH finding and failure", () => {
    const path = "/virtual/both.py";
    const text = [
      'LOST = """<script>',
      'fetch("/api/save", { method: "POST" });',
      'alert("Saved successfully");',
      '</script>"""',
      'BROKEN = """<script>',
      'fetch("/api/x" + ${OOPS}, { method: "POST" });',
      '</script>"""',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]).toBeDefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("parse");
  });

  it("a .py candidate whose only <script> matches are phantom prose yields extract could-not-verify (fail-closed)", () => {
    const path = "/virtual/only-prose.py";
    const text = [
      '"""Doc: emit a <script>hello world</script> banner."""',
      "def go():",
      '    fetch("/api/save")  # python-side call; never co-located inside a <script> pair',
      "    return None",
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("extract");
  });

  it("JS-family candidate whose only <script> is phantom prose is could-not-verify, NOT a silent clean pass", () => {
    const path = "/virtual/generator.js";
    const text = [
      "// see the <script>save handler</script> docs",
      'fetch("/api/save", { method: "POST" });',
      'alert("Saved successfully");',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    // The top-level fetch is NOT inside a <script>, so it is not an extracted block; the only extracted
    // block is the phantom comment prose. Every isolated block is discounted -> fail-closed backstop, not
    // exit 0. (We intentionally do NOT whole-file-analyze a JS generator: that risks mis-attributing the
    // generator's own server-side calls as artifact write-backs.)
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("extract");
  });

  // ---- false-clean regressions: parsed-sibling backstop bypass + optional-call hint blindness ----

  it("a parseable sibling block must not disable the fail-closed backstop (.js, out-of-block write-back)", () => {
    const path = "/virtual/app.js";
    // Real write-back lives at TOP LEVEL (never extracted as a block); the only <script> pairs are a
    // phantom prose comment (unparseable, no hint -> discounted) and a trivially-parseable one.
    const text = [
      "// docs: the page embeds <script>just prose here explaining things</script> markers",
      "// helper: <script>var ok = 1;</script>",
      'fetch("/api/save", { method: "POST", body: JSON.stringify(state) });',
      'alert("Saved successfully");',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("extract");
  });

  it("phantom prose + parseable block + inline-handler write-back (.html) is could-not-verify, not clean", () => {
    const path = "/virtual/inline-handler.html";
    const text = [
      "<!doctype html><body>",
      "<!-- note: <script>prose about the save flow</script> -->",
      "<script>var ready = 1;</script>",
      `<button onclick="fetch('/api/save',{method:'POST',body:data}).then(()=>alert('Saved!'))">Save</button>`,
      "</body>",
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("extract");
  });

  it("an unparseable block whose write-back is spelled xhr?.open?.( is recorded, not discounted", () => {
    const path = "/virtual/optional-open.html";
    // Candidacy rides on the parseable GET-fetch sibling (WRITE_BACK_PRIMITIVE_RE does not see
    // optional-call spellings); the broken block's ONLY write-back token is the optional-call XHR open.
    const text = [
      "<!doctype html><body>",
      '<script>fetch("/api/data").then(r => r.json());</script>',
      '<script>const xhr = makeXhr(; xhr?.open?.("POST", "/api/save"); xhr?.send?.(payload);</script>',
      "</body>",
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("parse");
  });

  it("an unparseable block whose write-back is spelled $.post?.( is recorded, not discounted", () => {
    const path = "/virtual/optional-post.html";
    const text = [
      "<!doctype html><body>",
      '<script>fetch("/api/data");</script>',
      '<script>saveAll((; $.post?.("/api/save", data);</script>',
      "</body>",
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("parse");
  });

  it("an unparseable block whose write-back is spelled fetch?.( is recorded, not discounted", () => {
    const path = "/virtual/optional-fetch.html";
    const text = [
      "<!doctype html><body>",
      '<script>fetch("/api/data");</script>',
      '<script>go((; fetch?.("/api/save", { method: "POST" });</script>',
      "</body>",
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings).toEqual([]);
    expect(result.failure).toBeDefined();
    expect(result.failure?.stage).toBe("parse");
  });

  it("a SUSPECT (advisory) parsed block does not let a discounted-prose sibling mask a lost remainder write-back", () => {
    const path = "/virtual/suspect-plus-remainder.html";
    const text =
      `<script>if (window.flag) { fetch('/api/log', {method:'POST'}); }</script>\n` + // parses -> SUSPECT (advisory, guarded)
      `<!-- doc: see <script>prose about saving</script> for details -->\n` + // discounted prose (no hint)
      `<button onclick="fetch('/api/save',{method:'POST'}).then(()=>alert('Saved!'))">Save</button>`; // LOST, in the remainder
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect"); // the advisory is still surfaced
    expect(result.failure?.stage).toBe("extract"); // AND the un-analyzed remainder is could-not-verify
  });

  it("a member-spelled window.fetch( write-back inside a PARSED block is flagged, not silently clean", () => {
    const path = "/virtual/member-fetch.html";
    const text = [
      "<!-- doc: see <script>prose about the save flow</script> for details -->", // discounted prose (no hint)
      `<script>window.fetch('/api/save',{method:'POST'}).then(()=>alert('Saved!'))</script>`, // LOST, parses fine
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a form-lost finding with zero parsed blocks does not suppress an un-analyzed inline-handler remainder", () => {
    const path = "/virtual/form-plus-handler.html";
    const text = [
      '<form method="post" action="/api/legacy-save"><input name="x"/></form>', // relative form POST -> lost (error)
      "<!-- doc: see <script>prose about saving</script> for details -->", // discounted prose (no hint)
      `<button onclick="fetch('/api/backup',{method:'POST'})">Backup</button>`, // never analyzed, in the remainder
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
    expect(result.failure?.stage).toBe("extract");
  });

  it("a fetch-wrapper whose body calls window.fetch( is recognized as a wrapper, not just a bare fetch( body", () => {
    const path = "/virtual/member-fetch-wrapper.html";
    const text = [
      "<!-- doc: see <script>prose about the save flow</script> for details -->", // discounted prose (no hint)
      `<script>function save(u){ return window.fetch(u,{method:"POST"}); } save("/api/save"); alert("Saved!");</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a bare sendBeacon( identifier call is recognized, not just navigator.sendBeacon(", () => {
    const path = "/virtual/bare-sendbeacon.html";
    const text = [
      "<!-- doc: see <script>prose about saving</script> for details -->", // discounted prose (no hint)
      `<script>const sendBeacon = navigator.sendBeacon.bind(navigator); sendBeacon('/api/save', payload); alert('Saved!');</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a .post( call on a non-whitelisted receiver (an axios instance) with a relative URL is advisory, not invisible", () => {
    const path = "/virtual/axios-instance-post.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling; GET yields no outcome itself
      '<script>const api = axios.create({}); api.post("/api/save", d);</script>',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect");
  });

  // ---- axios verb/config-shape regressions: the AST must recognize every axios spelling the hint layer
  //      already treats as a write-back primitive (the bare word "axios"), not just `axios.post(` ----

  it("axios.put( is classified the same as axios.post( — not a silent clean parsed block", () => {
    const path = "/virtual/axios-put.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>axios.put("/api/save", d).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a bare axios({...}) config-object call is classified, not invisible", () => {
    const path = "/virtual/axios-config-call.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>axios({ method: "POST", url: "/api/save", data }).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("axios.request({...}) is classified, not invisible", () => {
    const path = "/virtual/axios-request-call.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>axios.request({ method: "POST", url: "/api/save" });</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]).toBeDefined();
  });

  it("api.put( on a non-whitelisted axios-instance receiver is advisory, not invisible", () => {
    const path = "/virtual/axios-instance-put.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      '<script>const api = axios.create({}); api.put("/api/save", d);</script>',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect");
  });

  it("(guard) map.delete( on an arbitrary receiver is never flagged — .delete is deliberately excluded", () => {
    const path = "/virtual/map-delete-guard.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      '<script>const map = new Map(); map.delete("/x");</script>',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({ findings: [] });
  });

  it("axios.delete( on the literal axios identifier is classified — no ambiguity like an arbitrary receiver's .delete(", () => {
    const path = "/virtual/axios-delete.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>axios.delete("/api/item/3").then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a DELETE flow whose only success signal is a 'Deleted'/'Removed' toast classifies as lost, not just suspect", () => {
    const path = "/virtual/delete-toast.html";
    const text = `<script>fetch("/api/item/3", { method: "DELETE" }).then(()=>alert("Removed!"));</script>`;
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost"); // "Removed!" is a persist claim (delete-flow vocabulary)
  });

  it("a hoisted axios(cfg) config identifier is classified the same as an inline axios({...}) call", () => {
    const path = "/virtual/axios-hoisted-config.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>const cfg = { method: "POST", url: "/api/save", data }; axios(cfg).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a hoisted axios.request(cfg) config identifier is classified the same as an inline axios.request({...}) call", () => {
    const path = "/virtual/axios-request-hoisted-config.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>const cfg = { method: "POST", url: "/api/save" }; axios.request(cfg).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("axios.postForm( (a v1 multipart form-data verb alias) is classified with the embedded POST verb", () => {
    const path = "/virtual/axios-post-form.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>const fd = new FormData(); axios.postForm("/api/save", fd).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  // ---- pins (already-correct boundaries): hint tokens + cap hits must be recorded, never discounted ----

  it("an unparseable block whose only write-back token is $.post( is recorded (hint boundary)", () => {
    const path = "/virtual/dollar-post-only.html";
    const text = ['<script>fetch("/api/data");</script>', '<script>saveAll((; $.post("/api/save", data);</script>'].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.failure?.stage).toBe("parse");
  });

  it("an unparseable block whose only write-back token is xhr.open( is recorded (hint boundary)", () => {
    const path = "/virtual/xhr-open-only.html";
    const text = ['<script>fetch("/api/data");</script>', '<script>mk((; xhr.open("POST", "/api/save");</script>'].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.failure?.stage).toBe("parse");
  });

  it("a cap-exceeded block beside a parseable sibling is recorded even WITHOUT a write-back hint", () => {
    const path = "/virtual/cap-sibling-no-hint.html";
    const statements = Array.from({ length: 8000 }, (_, i) => `var x${i}=${i};`).join("\n");
    const text = `<script>fetch("/api/data");</script>\n<script>\n${statements}\n</script>`;
    const result = analyzeArtifactFile(path, text);
    expect(result.failure?.stage).toBe("node-limit");
  });

  it("a cap-exceeded block beside a parseable sibling is recorded WITH a write-back hint", () => {
    const path = "/virtual/cap-sibling-with-hint.html";
    const statements = Array.from({ length: 8000 }, (_, i) => `var x${i}=${i};`).join("\n");
    const text = `<script>fetch("/api/data");</script>\n<script>\nfetch("/api/save",{method:"POST"});\n${statements}\n</script>`;
    const result = analyzeArtifactFile(path, text);
    expect(result.failure?.stage).toBe("node-limit");
  });

  // ---- candidacy-level regression: an optional-call spelling must still make the file a candidate ----

  it("a source whose only write-back spelling is fetch?.( still reaches candidacy and is flagged lost", () => {
    const path = "/virtual/optional-fetch-only.html";
    const text = `<script>fetch?.("/api/save",{method:"POST"}); alert("Saved!");</script>`;
    const result = analyzeArtifactFile(path, text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("multiple unparseable sibling blocks note the extra count in the failure reason", () => {
    const path = "/virtual/multi-broken.py";
    const text = [
      'HELPER1 = """',
      "<script>fetch('/api/save1', {method:'POST');</script>",
      '"""',
      'HELPER2 = """',
      "<script>fetch('/api/save2', {method:'POST');</script>",
      '"""',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.failure?.stage).toBe("parse");
    expect(result.failure?.reason).toMatch(/\(\+1 more unparseable block\(s\)\)$/);
  });

  it("candidacy check on a long non-matching whitespace run completes in linear time (no catastrophic backtracking)", () => {
    const path = "/virtual/whitespace-bomb.html";
    // "fetch" followed by a long run of whitespace and NO "(" — the shape that made the un-nested
    // `\s*(\?\.)?\s*` grouping quadratic (two independent `\s*` spans around one optional group admit
    // many equivalent partitions of the same whitespace run when the overall match ultimately fails).
    const text = `<!doctype html><body>fetch${" ".repeat(200_000)}</body>`;
    const start = Date.now();
    const result = analyzeArtifactFile(path, text);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(result).toEqual({ findings: [] }); // no "(" ever follows -> not a write-back primitive -> not a candidate
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

// ================================================================================================= //
// no-false-green regressions
// ================================================================================================= //

describe("— library-only write-backs reach candidacy", () => {
  it('HTML whose ONLY write-back is axios.post("/save") is a candidate and flagged (was a silent {})', () => {
    const text = `<script>axios.post("/api/save", d).then(()=>alert("Saved!"));</script>`;
    const result = analyzeArtifactFile("/virtual/axios-only.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it('HTML whose only write-back is $.post("/save") reaches candidacy (jQuery)', () => {
    const text = `<script>$.post("/api/save", d).then(()=>alert("Saved successfully"));</script>`;
    const result = analyzeArtifactFile("/virtual/jquery-only.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("an axios INSTANCE-only page (api.put) still reaches candidacy via the bare axios token", () => {
    const text = `<script>const api = axios.create({}); api.put("/api/save", d);</script>`;
    const result = analyzeArtifactFile("/virtual/axios-instance-only.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect"); // any-receiver .put -> advisory
  });
});

describe("— literal computed member calls are visible to the AST", () => {
  it('xhr["open"]("POST", url) is recognized (computed literal property)', () => {
    const text = `<script>const xhr = new XMLHttpRequest(); xhr["open"]("POST", "/api/save"); xhr.send(d); alert("Saved!");</script>`;
    const result = analyzeArtifactFile("/virtual/computed-open.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it('axios["post"]("/save") is recognized (computed literal property)', () => {
    const text = `<script>axios["post"]("/api/save", d).then(()=>alert("Saved!"));</script>`;
    const result = analyzeArtifactFile("/virtual/computed-post.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it('window["fetch"]("/save",{method:"POST"}) is recognized by the AST (candidacy via a sibling primitive)', () => {
    // Computed spellings are an AST-layer fix, not a candidacy tell — the bare `fetch(` GET
    // sibling establishes candidacy, then the AST resolves the computed `window["fetch"]` call.
    const text = `<script>fetch("/api/data");</script>\n<script>window["fetch"]("/api/save",{method:"POST"}).then(()=>alert("Saved!"));</script>`;
    const result = analyzeArtifactFile("/virtual/computed-fetch.html", text);
    expect(result.findings.some((f) => f.rule === "artifact-write-back-lost")).toBe(true);
  });
});

describe("findings 13/14 — module parsing and narrowed source contract", () => {
  it(".mjs with top-level import is parsed as a module and analyzed (not a parse could-not-verify)", () => {
    const text = `import { z } from "./z.js";\ndocument.title = z;\nfetch("/api/save", { method: "POST" });\nalert("Saved!");`;
    const result = analyzeArtifactFile("/virtual/gen.mjs", text);
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a .js with a top-level import reparses as a module (controlled script->module retry)", () => {
    const text = `import x from "./x.js";\ndocument.write(x);\nfetch("/api/save", { method: "POST" });\nalert("Saved!");`;
    const result = analyzeArtifactFile("/virtual/gen.js", text);
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it('an inline <script type="module"> with an import is analyzed, not a parse failure', () => {
    const text = `<!doctype html><script type="module">import {a} from "./a.js"; fetch("/api/save",{method:"POST"}); alert("Saved!");</script>`;
    const result = analyzeArtifactFile("/virtual/module-inline.html", text);
    expect(result.failure).toBeUndefined();
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it(".ts/.tsx/.jsx are no longer advertised source extensions — a .tsx target is out of scope, not a parse failure", () => {
    const result = analyzeArtifactFile("/virtual/comp.tsx", `<script>fetch("/api/save",{method:"POST"})</script>`);
    expect(result).toEqual({ findings: [] });
    // An EXISTING .ts file is simply out of scope (like a .md), never a select/parse failure.
    const dir = makeTmpDir();
    const tsFile = join(dir, "whatever.ts");
    writeFileSync(tsFile, `fetch("/api/save",{method:"POST"})`);
    const { files, failures } = collectArtifactSources(tsFile);
    expect(files).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe("— a named non-regular file (FIFO) is a could-not-verify, never a hang", () => {
  it("analyzeArtifacts on a named FIFO records a read failure without blocking", () => {
    const dir = makeTmpDir();
    const fifo = join(dir, "pipe.html");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform — skip
    }
    const { analysisFailures } = analyzeArtifacts([fifo]);
    expect(analysisFailures.some((f) => f.stage === "read" && /not a regular file/.test(f.reason))).toBe(true);
  });
});

describe("— the source walker rejects directory symlinks that escape the target root", () => {
  it("a symlinked subdirectory pointing outside the target is skipped with a select failure", () => {
    const outside = makeTmpDir();
    writeFileSync(join(outside, "evil.html"), `<script>fetch("/api/x",{method:"POST"})</script>`);
    const target = makeTmpDir();
    writeFileSync(join(target, "ok.html"), `<script>fetch("/api/ok",{method:"POST"})</script>`);
    try {
      symlinkSync(outside, join(target, "escape"), "dir");
    } catch {
      return; // symlink unsupported — skip
    }
    const { files, failures } = collectArtifactSources(target);
    expect(files.some((f) => f.endsWith("ok.html"))).toBe(true);
    expect(files.some((f) => f.endsWith("evil.html"))).toBe(false);
    expect(failures.some((f) => f.stage === "select" && /outside the target root/.test(f.reason))).toBe(true);
  });
});

describe("— hostname is compared exactly, not by prefix", () => {
  it("localhost.evil.com is REMOTE (was misclassified as local loopback)", () => {
    const text = `<script>fetch("https://localhost.evil.com/save",{method:"POST"}).then(()=>alert("Saved!"));</script>`;
    expect(analyzeArtifactFile("/virtual/host-evil.html", text)).toEqual({ findings: [] });
  });

  it("a form action to https://127.attacker.example is REMOTE, not loopback", () => {
    const text = `<form method="post" action="https://127.attacker.example/save"></form>`;
    expect(analyzeArtifactFile("/virtual/form-evil.html", text)).toEqual({ findings: [] });
  });

  it("a genuine loopback host (127.0.0.5) IS in scope", () => {
    const text = `<script>fetch("http://127.0.0.5/save",{method:"POST"}).then(()=>alert("Saved!"));</script>`;
    expect(analyzeArtifactFile("/virtual/loopback.html", text).findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("http://localhost:3000 is in scope (loopback with a port)", () => {
    const text = `<script>fetch("http://localhost:3000/save",{method:"POST"}).then(()=>alert("Saved!"));</script>`;
    expect(analyzeArtifactFile("/virtual/localhost-port.html", text).findings[0]?.rule).toBe("artifact-write-back-lost");
  });
});

describe("— protocol-relative / whitespace / non-slash schemes resolved via WHATWG URL", () => {
  it("//example.com/save is REMOTE (protocol-relative), not a local write-back", () => {
    const text = `<script>fetch("//example.com/save",{method:"POST"}).then(()=>alert("Saved!"));</script>`;
    expect(analyzeArtifactFile("/virtual/proto-rel.html", text)).toEqual({ findings: [] });
  });

  it("a leading-space absolute URL is REMOTE, not local", () => {
    const text = `<script>fetch(" https://example.com/save",{method:"POST"}).then(()=>alert("Saved!"));</script>`;
    expect(analyzeArtifactFile("/virtual/space-url.html", text)).toEqual({ findings: [] });
  });

  it("a mailto: form action is REMOTE (non-http scheme), never a local write-back", () => {
    const text = `<form method="post" action="mailto:ops@example.com"></form>`;
    expect(analyzeArtifactFile("/virtual/mailto-form.html", text)).toEqual({ findings: [] });
  });
});

describe("— unquoted remote form actions are NOT treated as local", () => {
  it("<form method=post action=https://api.example.com/save> (unquoted) is remote -> clean", () => {
    const text = `<form method=post action=https://api.example.com/save><input name=x></form>`;
    expect(analyzeArtifactFile("/virtual/unquoted-remote.html", text)).toEqual({ findings: [] });
  });

  it("<form method=post action=/api/save> (unquoted relative) is still lost", () => {
    const text = `<form method=post action=/api/save><input name=x></form>`;
    expect(analyzeArtifactFile("/virtual/unquoted-rel.html", text).findings[0]?.rule).toBe("artifact-write-back-lost");
  });
});

describe("— submitter formaction/formmethod overrides and form= linkage", () => {
  it("remote form + relative formaction button -> the relative submission IS flagged", () => {
    const text = `<form method="post" action="https://remote.example/x"><button formaction="/api/save">Save</button></form>`;
    expect(analyzeArtifactFile("/virtual/remote-form-rel-btn.html", text).findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("relative form + remote formaction button -> NO false lost (the submission goes remote)", () => {
    const text = `<form method="post" action="/api/save"><button formaction="https://remote.example/x">Go</button></form>`;
    expect(analyzeArtifactFile("/virtual/rel-form-remote-btn.html", text)).toEqual({ findings: [] });
  });

  it("a submit control linked via form=<id> to a relative POST form is flagged", () => {
    const text = `<form id="f1" method="post" action="/api/save"></form><button type="submit" form="f1">Save</button>`;
    expect(analyzeArtifactFile("/virtual/form-linked.html", text).findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a GET form whose button forces formmethod=post to a relative action is flagged", () => {
    const text = `<form method="get" action="/api/save"><button formmethod="post">Save</button></form>`;
    expect(analyzeArtifactFile("/virtual/get-form-post-btn.html", text).findings[0]?.rule).toBe("artifact-write-back-lost");
  });
});

describe("— native-form findings account for JS submit handlers", () => {
  it("a relative POST form with an inline onsubmit handler is DOWNGRADED to suspect, not hard-lost", () => {
    const text = `<form method="post" action="/api/save" onsubmit="return handle(event)"><button>Save</button></form>`;
    expect(analyzeArtifactFile("/virtual/form-onsubmit.html", text).findings[0]?.rule).toBe("artifact-write-back-suspect");
  });

  it("a page-level addEventListener('submit', …) downgrades a relative POST form to suspect", () => {
    const text = `<form id="f" method="post" action="/api/save"></form><script>document.getElementById("f").addEventListener("submit", e => e.preventDefault());</script>`;
    const result = analyzeArtifactFile("/virtual/form-listener.html", text);
    expect(result.findings.some((f) => f.rule === "artifact-write-back-suspect")).toBe(true);
    expect(result.findings.some((f) => f.rule === "artifact-write-back-lost")).toBe(false);
  });
});

describe("— constant folding is scope-aware (a shadowing parameter never folds live code dead)", () => {
  it("const ENABLED=false shadowed by a function parameter does NOT fold the guarded write-back dead", () => {
    const text = `<script>const ENABLED = false; function save(ENABLED){ if (ENABLED){ fetch("/api/save",{method:"POST"}); alert("Saved!"); } } save(true);</script>`;
    const result = analyzeArtifactFile("/virtual/shadow-param.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect"); // shadowed -> unknown -> suspect, NOT clean
  });
});

describe("— member mutation poisons a folded config object", () => {
  it("cfg.enabled=true after a false initializer does NOT fold the guarded write-back dead", () => {
    const text = `<script>const cfg = { enabled: false }; cfg.enabled = true; if (cfg.enabled){ fetch("/api/save",{method:"POST"}); alert("Saved!"); }</script>`;
    const result = analyzeArtifactFile("/virtual/member-mutate.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect"); // stale initializer must NOT clean
  });

  it("delete cfg.enabled also poisons the object binding", () => {
    const text = `<script>const cfg = { enabled: true }; delete cfg.enabled; if (cfg.enabled){ fetch("/api/save",{method:"POST"}); alert("Saved!"); }</script>`;
    const result = analyzeArtifactFile("/virtual/member-delete.html", text);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-suspect");
  });
});

describe("computed URL/method and spread options are could-not-verify, never silent", () => {
  it("a recognized write primitive with a computed URL yields suspect, not a silent clean", () => {
    const text = `<script>const u = "/api/" + part; fetch(u, { method: "POST" });</script>`;
    expect(analyzeArtifactFile("/virtual/computed-url.html", text).findings[0]?.rule).toBe("artifact-write-back-suspect");
  });

  it("a fetch with a computed method identifier yields suspect (method UNKNOWN)", () => {
    const text = `<script>fetch("/api/save", { method: verb });</script>`;
    expect(analyzeArtifactFile("/virtual/computed-method.html", text).findings[0]?.rule).toBe("artifact-write-back-suspect");
  });

  it("a spread options object (fetch(u, {...opts})) yields suspect, not a silent GET", () => {
    const text = `<script>fetch("/api/save", { ...opts });</script>`;
    expect(analyzeArtifactFile("/virtual/spread-opts.html", text).findings[0]?.rule).toBe("artifact-write-back-suspect");
  });

  it("axios({ ...cfg }) with a spread config yields suspect, not a silent clean", () => {
    const text = `<script>axios({ ...cfg, url: "/api/save" });</script>`;
    expect(analyzeArtifactFile("/virtual/axios-spread.html", text).findings[0]?.rule).toBe("artifact-write-back-suspect");
  });
});

describe("— consequence analysis is bounded to the call's own statement/promise chain", () => {
  it("an unrelated later resp.ok elsewhere in the block does NOT make a lost write-back look handled", () => {
    const text = `<script>fetch("/api/save",{method:"POST"}); alert("Saved!"); function other(resp){ return resp.ok; }</script>`;
    expect(analyzeArtifactFile("/virtual/late-ok.html", text).findings[0]?.rule).toBe("artifact-write-back-lost");
  });

  it("a write-back whose result escapes to an assigned variable is SUSPECT, not a false lost", () => {
    const text = `<script>async function s(){ const r = await fetch("/api/save",{method:"POST"}); alert("Saved!"); if (!r.ok) show(); }</script>`;
    expect(analyzeArtifactFile("/virtual/escaped-result.html", text).findings[0]?.rule).toBe("artifact-write-back-suspect");
  });
});

describe("— every distinct write-back in a file is surfaced", () => {
  it("two independent lost fetch write-backs produce TWO findings", () => {
    const text = `<script>fetch("/api/a",{method:"POST"}); alert("Saved!");</script>\n<script>fetch("/api/b",{method:"POST"}); alert("Done successfully");</script>`;
    const result = analyzeArtifactFile("/virtual/two-lost.html", text);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.rule === "artifact-write-back-lost")).toBe(true);
  });

  it("a lost form AND a lost script write-back both surface (form + JS)", () => {
    const text = `<form method="post" action="/api/save"></form>\n<script>fetch("/api/other",{method:"POST"}); alert("Saved!");</script>`;
    const result = analyzeArtifactFile("/virtual/form-plus-js.html", text);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.rule === "artifact-write-back-lost")).toBe(true);
  });

  it("errors sort before advisories — findings[0] is the lost when a file has both", () => {
    const text = `<script>if (window.flag){ fetch("/api/guarded",{method:"POST"}); }</script>\n<script>fetch("/api/save",{method:"POST"}); alert("Saved!");</script>`;
    const result = analyzeArtifactFile("/virtual/mixed-sev.html", text);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.findings[0]?.rule).toBe("artifact-write-back-lost");
    expect(result.findings.some((f) => f.rule === "artifact-write-back-suspect")).toBe(true);
  });

  it("analyzeArtifacts aggregates multiple per-file findings into the flat findings list", () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, "page.html"),
      `<script>fetch("/api/a",{method:"POST"}); alert("Saved!");</script>\n<script>fetch("/api/b",{method:"POST"}); alert("Saved!");</script>`,
    );
    const { findings } = analyzeArtifacts([join(dir, "page.html")]);
    expect(findings.filter((f) => f.rule === "artifact-write-back-lost")).toHaveLength(2);
  });
});

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}

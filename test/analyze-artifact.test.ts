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
    expect(result.finding).toBeDefined();
    expect(result.finding?.rule).toBe("artifact-write-back-suspect");
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
    expect(result.finding).toBeDefined();
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
    expect(result.finding?.severity).toBe("error");
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding).toBeDefined();
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding).toBeUndefined();
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
    expect(result.finding?.rule).toBe("artifact-write-back-suspect"); // the advisory is still surfaced
    expect(result.failure?.stage).toBe("extract"); // AND the un-analyzed remainder is could-not-verify
  });

  it("a member-spelled window.fetch( write-back inside a PARSED block is flagged, not silently clean", () => {
    const path = "/virtual/member-fetch.html";
    const text = [
      "<!-- doc: see <script>prose about the save flow</script> for details -->", // discounted prose (no hint)
      `<script>window.fetch('/api/save',{method:'POST'}).then(()=>alert('Saved!'))</script>`, // LOST, parses fine
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("a form-lost finding with zero parsed blocks does not suppress an un-analyzed inline-handler remainder", () => {
    const path = "/virtual/form-plus-handler.html";
    const text = [
      '<form method="post" action="/api/legacy-save"><input name="x"/></form>', // relative form POST -> lost (error)
      "<!-- doc: see <script>prose about saving</script> for details -->", // discounted prose (no hint)
      `<button onclick="fetch('/api/backup',{method:'POST'})">Backup</button>`, // never analyzed, in the remainder
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
    expect(result.failure?.stage).toBe("extract");
  });

  it("a fetch-wrapper whose body calls window.fetch( is recognized as a wrapper, not just a bare fetch( body", () => {
    const path = "/virtual/member-fetch-wrapper.html";
    const text = [
      "<!-- doc: see <script>prose about the save flow</script> for details -->", // discounted prose (no hint)
      `<script>function save(u){ return window.fetch(u,{method:"POST"}); } save("/api/save"); alert("Saved!");</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("a bare sendBeacon( identifier call is recognized, not just navigator.sendBeacon(", () => {
    const path = "/virtual/bare-sendbeacon.html";
    const text = [
      "<!-- doc: see <script>prose about saving</script> for details -->", // discounted prose (no hint)
      `<script>const sendBeacon = navigator.sendBeacon.bind(navigator); sendBeacon('/api/save', payload); alert('Saved!');</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("a .post( call on a non-whitelisted receiver (an axios instance) with a relative URL is advisory, not invisible", () => {
    const path = "/virtual/axios-instance-post.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling; GET yields no outcome itself
      '<script>const api = axios.create({}); api.post("/api/save", d);</script>',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-suspect");
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
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("a bare axios({...}) config-object call is classified, not invisible", () => {
    const path = "/virtual/axios-config-call.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>axios({ method: "POST", url: "/api/save", data }).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("axios.request({...}) is classified, not invisible", () => {
    const path = "/virtual/axios-request-call.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>axios.request({ method: "POST", url: "/api/save" });</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding).toBeDefined();
  });

  it("api.put( on a non-whitelisted axios-instance receiver is advisory, not invisible", () => {
    const path = "/virtual/axios-instance-put.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      '<script>const api = axios.create({}); api.put("/api/save", d);</script>',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-suspect");
  });

  it("(guard) map.delete( on an arbitrary receiver is never flagged — .delete is deliberately excluded", () => {
    const path = "/virtual/map-delete-guard.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      '<script>const map = new Map(); map.delete("/x");</script>',
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result).toEqual({});
  });

  it("axios.delete( on the literal axios identifier is classified — no ambiguity like an arbitrary receiver's .delete(", () => {
    const path = "/virtual/axios-delete.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>axios.delete("/api/item/3").then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("a DELETE flow whose only success signal is a 'Deleted'/'Removed' toast classifies as lost, not just suspect", () => {
    const path = "/virtual/delete-toast.html";
    const text = `<script>fetch("/api/item/3", { method: "DELETE" }).then(()=>alert("Removed!"));</script>`;
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost"); // "Removed!" is a persist claim (delete-flow vocabulary)
  });

  it("a hoisted axios(cfg) config identifier is classified the same as an inline axios({...}) call", () => {
    const path = "/virtual/axios-hoisted-config.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>const cfg = { method: "POST", url: "/api/save", data }; axios(cfg).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("a hoisted axios.request(cfg) config identifier is classified the same as an inline axios.request({...}) call", () => {
    const path = "/virtual/axios-request-hoisted-config.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>const cfg = { method: "POST", url: "/api/save" }; axios.request(cfg).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
  });

  it("axios.postForm( (a v1 multipart form-data verb alias) is classified with the embedded POST verb", () => {
    const path = "/virtual/axios-post-form.html";
    const text = [
      '<script>fetch("/api/data");</script>', // candidacy GET-fetch sibling
      `<script>const fd = new FormData(); axios.postForm("/api/save", fd).then(()=>alert("Saved!"));</script>`,
    ].join("\n");
    const result = analyzeArtifactFile(path, text);
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
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
    expect(result.finding?.rule).toBe("artifact-write-back-lost");
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
    expect(result).toEqual({}); // no "(" ever follows -> not a write-back primitive -> not a candidate
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

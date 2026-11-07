import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { catchSites, guardedFiles, processExitSites, srcFiles, stripComments } from "./helpers/exit-guard-scan.js";

// A command asks to exit by throwing ExitRequested (src/run/exit.ts) and the top level lets the event loop drain.
// Two ways to break that, both invisible to a test that only checks exit codes on the happy path:
//  - a broad `catch` that swallows the request (the command then carries on, or exits with another code);
//  - a new `process.exit(` that ends the process from inside a command again.
// The scan is source text over src/; test/helpers/exit-guard-scan.ts has the rules.

describe("every broad catch that can see an exit request lets it through", () => {
  const files = guardedFiles();

  it("the guarded set is computed and covers the files that raise exits", () => {
    // Printed on failure so a reviewer sees the set the guard applies to, not a count.
    const rel = files.map((f) => f.replace(/\\/g, "/"));
    for (const must of [
      "src/cli.ts",
      "src/run/envelope.ts",
      "src/run/cassette.ts",
      "src/critique/command.ts",
      "src/run/chat.ts",
      // the cross-file wrappers: they raise nothing, but decide what a job's throw means
      "src/eval/command.ts",
      "src/hillclimb/runner.ts",
    ])
      expect(rel, rel.join("\n")).toContain(must);
    expect(files.length, rel.join("\n")).toBeGreaterThanOrEqual(15);
  });

  it("each catch opens with rethrowIfExit(e), a narrow rethrow, or an `// exit-safe:` marker", () => {
    const sites = files.flatMap((f) => catchSites(f));
    expect(sites.length).toBeGreaterThan(200);
    const bad = sites.filter((c) => c.kind === "none").map((c) => `${c.file}:${c.line}: ${c.first}`);
    expect(bad, `catches that would swallow an exit request:\n${bad.join("\n")}`).toEqual([]);
  });

  it("the scanner sees a catch that does not rethrow (it is not green over nothing)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "exit-guard-"));
    try {
      const f = join(dir, "x.ts");
      writeFileSync(
        f,
        [
          "try { a(); } catch (e) { log(e); }",
          "try { a(); } catch (e) { rethrowIfExit(e); log(e); }",
          "try { a(); } catch (e) { if (!(e instanceof UsageError)) throw e; }",
          "try { a(); } catch { /* no binding */ }",
          "try { a(); } catch (e) { // exit-safe: test",
          "  log(e); }",
          "try { a(); } catch (e) {",
          "  // exit-safe: on the body's first line",
          "  log(e); }",
          "try { a(); } catch (e) { if (e instanceof InterruptedError || e instanceof ExitRequested) throw e; }",
          "try { a(); } catch (e) { if (e instanceof InterruptedError || e instanceof UsageError) throw e; }",
          'const s = "} catch (e) { not code }";',
        ].join("\n"),
      );
      expect(catchSites(f).map((c) => c.kind)).toEqual(["none", "rethrowIfExit", "narrow", "none", "marker", "marker", "narrow", "none"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the `// exit-safe:` markers are a pinned list: a new one is a visible diff here", () => {
    const markers: string[] = [];
    for (const f of srcFiles()) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l) => {
        const m = l.match(/\/\/\s*exit-safe:\s*(.+)$/);
        if (m) markers.push(`${f.replace(/\\/g, "/")}: ${m[1].trim()}`);
      });
    }
    expect(markers.sort()).toEqual(["src/hillclimb/runner.ts: captured, and rethrown below once the in-flight jobs have finished"]);
  });
});

describe("process.exit is called only where an exit cannot be a request", () => {
  it("the remaining sites are the allowlist, by file and count", () => {
    const sites = processExitSites().map((s) => s.replace(/\\/g, "/"));
    const byFile = new Map<string, number>();
    for (const s of sites) byFile.set(s.split(":")[0], (byFile.get(s.split(":")[0]) ?? 0) + 1);
    expect(Object.fromEntries(byFile), sites.join("\n")).toEqual({
      // the fallback timer, and an uncaught error while no other listener owns it
      "src/run/exit.ts": 2,
      // the signal handler's final exit (128+signo)
      "src/termination.ts": 1,
      // the egress proxy is its own process
      "src/egress/proxy.ts": 1,
      // critique's SIGINT/SIGTERM handler
      "src/critique/command.ts": 1,
    });
  });

  it("critique's one process.exit is inside its signal handler", () => {
    const src = stripComments(readFileSync(resolve("src/critique/command.ts"), "utf8"));
    const at = src.indexOf("process.exit(");
    expect(src.slice(Math.max(0, at - 160), at)).toMatch(/process\.on\(sig, \(\) => \{\s*killAllOutstandingChildGroups\(\);\s*$/);
  });

  it("fail() asks to exit and never calls process.exit itself", () => {
    const src = stripComments(readFileSync(resolve("src/run/envelope.ts"), "utf8"));
    const body = src.slice(src.indexOf("export function fail("), src.indexOf("export function printFailure("));
    expect(body).toContain("exitWith(printFailure(");
    expect(body).not.toContain("process.exit");
  });

  it("CI's error-envelope grep still matches what the code calls (it is not green over nothing)", () => {
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain('grep -nE "(process\\.exit|exitWith)\\([12]\\)" src/cli.ts src/run/doctor.ts src/run/cassette.ts');
    let hits = 0;
    for (const f of ["src/cli.ts", "src/run/doctor.ts", "src/run/cassette.ts"])
      hits += (readFileSync(resolve(f), "utf8").match(/(process\.exit|exitWith)\([12]\)/g) ?? []).length;
    expect(hits).toBeGreaterThan(0);
  });
});

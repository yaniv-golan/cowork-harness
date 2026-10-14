import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-text wiring for `--search-corpus`: each site the option must cross. A behaviour test of the whole path needs
// the real agent (the local-only real-binary test); these pin that the seams stay connected.
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const execute = src("src/run/execute.ts");
const hostloop = src("src/runtime/hostloop.ts");
const run = src("src/run/run.ts");
const observed = src("src/sync/observed-spawn-env.ts");

describe("--search-corpus wiring (source text)", () => {
  it("execute refuses before the run dir exists", () => {
    const at = execute.indexOf("searchCorpusRefusal({");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(execute.indexOf("const turnNumber = beginTurn(outDir);"));
    expect(execute.slice(at, at + 400)).toMatch(/authEnv: runtimeAuthEnv\(\)/);
  });

  it("execute starts the corpus before the hostloop spawn and hands it the interceptor env", () => {
    const start = execute.indexOf("searchCorpus = await startRunSearchCorpus(");
    const spawn = execute.indexOf("const hl = spawnHostLoop(");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(spawn);
    expect(execute.slice(spawn, spawn + 300)).toMatch(/searchCorpusEnv: searchCorpus\.env/);
  });

  it("the session stream gets the frames through drive's start options, and drive passes them to start()", () => {
    const drive = execute.indexOf("record = await run.drive(scenario.prompt, {");
    expect(execute.slice(drive, drive + 600)).toMatch(/searchCorpus: searchCorpus\.frames/);
    expect(run).toMatch(/this\.session\.start\(startOpts\)/);
  });

  it("the run finishes the corpus after the session and folds its verdict into infraErrors", () => {
    const fin = execute.indexOf("searchCorpusError = await searchCorpus.finish(outDir, plan.configDir)");
    expect(fin).toBeGreaterThan(execute.indexOf("record = await run.drive(scenario.prompt, {"));
    // after the agent and its proxy-inheriting children are stopped
    expect(fin).toBeGreaterThan(execute.indexOf("agentStopMs = await reapAgentOnTeardown({"));
    // and its per-query log is scrubbed with the other raw run logs
    expect(execute).toMatch(/scrubFileInPlace\(join\(outDir, "search-corpus\.jsonl"\), secrets\)/);
    expect(execute).toMatch(/record\.infraErrors\.push\(\{ source: "search-corpus", message: searchCorpusError \}\)/);
  });

  it("hostloop layers the interceptor env after buildHostLoopNativeEnv and before the spawn; sync's comparison never sees it", () => {
    const build = hostloop.indexOf("const nativeEnv = buildHostLoopNativeEnv(baseline, {");
    const layer = hostloop.indexOf("if (opts.searchCorpusEnv) Object.assign(nativeEnv, opts.searchCorpusEnv);");
    expect(layer).toBeGreaterThan(build);
    expect(layer).toBeLessThan(hostloop.indexOf("const child = spawn("));
    expect(observed).not.toMatch(/searchCorpusEnv/);
  });
});

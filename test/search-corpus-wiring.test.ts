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

  it("execute judges the refusals over the agent's real env (operator, baseline spawn env, session knobs), not the shell's", () => {
    const at = execute.indexOf("searchCorpusRefusal({");
    expect(execute).toMatch(
      /const searchCorpusAgentEnv = opts\.searchCorpus\s*\? buildHostLoopNativeEnv\(baseline, \{[\s\S]{0,300}agentEnv: agentEnvOverrides\(session\.agent_env\)/,
    );
    expect(execute.slice(at, at + 400)).toMatch(/agentEnv: searchCorpusAgentEnv!/);
    // and the run starts with the same env (an operator or baseline NODE_EXTRA_CA_CERTS is kept)
    expect(execute).toMatch(/startRunSearchCorpus\(\{[^}]*agentEnv: searchCorpusAgentEnv!/);
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

  it("the anchor check resolves the binary once, before the run dir exists, and the spawn launches that same path", () => {
    const resolved = execute.indexOf("const searchCorpusAgentBinary = opts.searchCorpus ? resolveHostAgentBinary(baseline) : undefined;");
    const check = execute.indexOf("agentAnchorsRefusal(searchCorpusAgentBinary, baseline.agentBinary!.searchAnchors!)");
    expect(resolved).toBeGreaterThan(execute.indexOf("searchCorpusRefusal({"));
    expect(check).toBeGreaterThan(resolved);
    expect(check).toBeLessThan(execute.indexOf("const turnNumber = beginTurn(outDir);"));
    expect(execute.slice(check, check + 200)).toMatch(/if \(drift\) throw new UsageError\(drift\);/);
    // the checked path reaches the spawn; hostloop resolves only when none is given
    const spawn = execute.indexOf("const hl = spawnHostLoop(");
    expect(execute.slice(spawn, spawn + 300)).toMatch(/agentNativeHost: searchCorpusAgentBinary!/);
    expect(hostloop).toMatch(/const agentNativeHost = opts\.agentNativeHost \?\? resolveHostAgentBinary\(baseline\);/);
    expect(execute.match(/resolveHostAgentBinary\(/g)).toHaveLength(1);
  });

  it("hostloop layers the interceptor env after buildHostLoopNativeEnv and before the spawn; sync's comparison never sees it", () => {
    const build = hostloop.indexOf("const nativeEnv = buildHostLoopNativeEnv(baseline, {");
    const layer = hostloop.indexOf("if (opts.searchCorpusEnv) Object.assign(nativeEnv, opts.searchCorpusEnv);");
    expect(layer).toBeGreaterThan(build);
    expect(layer).toBeLessThan(hostloop.indexOf("const child = spawn("));
    expect(observed).not.toMatch(/searchCorpusEnv/);
  });

  it("every serve frame is in events.jsonl before a command metric measures it: written at session close, before the stream ends, and the run measures after the drive", () => {
    const session = src("src/agent/session.ts");
    const atClose = session.indexOf("for (const f of await this.searchCorpus.finish()) this.events.write(f");
    expect(atClose).toBeGreaterThan(-1);
    expect(atClose).toBeLessThan(session.indexOf("this.events.end("));
    expect(execute.indexOf("record = await run.drive(scenario.prompt, {")).toBeLessThan(
      execute.indexOf("measureCommandMetrics(scenario.metrics"),
    );
  });

  it("the run's assertions read the corpus record after its finish", () => {
    const at = execute.indexOf("searchCorpus: searchCorpus?.result(),");
    expect(at).toBeGreaterThan(execute.indexOf("const assertCtx: AssertContext = {"));
    expect(at).toBeGreaterThan(execute.indexOf("searchCorpusError = await searchCorpus.finish(outDir, plan.configDir)"));
  });
});

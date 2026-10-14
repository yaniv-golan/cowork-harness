import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBaseline } from "../src/baseline.js";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";

// `--search-corpus` refusals, end to end through the CLI. Each test asserts the reason, never only the exit code:
// an unknown-flag guard would also exit non-zero. All are $0: every refusal fires before an agent is spawned.
const can = POSIX && existsSync(CLI);
const DUMMY = { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" };

function fixture(): StubFixture {
  const f = makeStubFixture("cat >/dev/null", DUMMY);
  writeFileSync(join(f.cwd, "s.yaml"), "permission_mode: bypassPermissions\n");
  return f;
}
function scenario(f: StubFixture, file: string, lines: string[]): string {
  const p = join(f.cwd, file);
  writeFileSync(p, ["name: sc", "baseline: latest", "session: ./s.yaml", "prompt: look something up", ...lines].join("\n") + "\n");
  return p;
}
async function cli(f: StubFixture, args: string[], env: Record<string, string> = {}) {
  const c = spawnCli(f, args, env);
  const r = await exited(c, 60_000);
  return { code: r.code, text: c.stdoutText() + c.stderrText() };
}

describe.runIf(can)("--search-corpus refusals (CLI, $0)", () => {
  it("validates its companion flags", async () => {
    const f = fixture();
    const s = scenario(f, "a.yaml", ["fidelity: hostloop"]);
    expect((await cli(f, ["run", s, "--model", "claude-sonnet-5", "--search-corpus", "p", "--search-corpus-miss", "pass"])).text).toMatch(
      /--search-corpus-miss must be "empty" or "error" \(got "pass"\)/,
    );
    expect(
      (await cli(f, ["run", s, "--model", "claude-sonnet-5", "--search-corpus", "p", "--search-corpus-min-score", "1.5"])).text,
    ).toMatch(/--search-corpus-min-score must be a number between 0 and 1/);
    expect((await cli(f, ["run", s, "--model", "claude-sonnet-5", "--search-corpus-miss", "error"])).text).toMatch(
      /need --search-corpus <pool>/,
    );
  });

  it("refuses protocol by name", async () => {
    const f = fixture();
    const r = await cli(f, ["run", scenario(f, "p.yaml", ["fidelity: protocol"]), "--model", "claude-sonnet-5", "--search-corpus", "p"]);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/--search-corpus is not available at fidelity protocol/);
  });

  it("refuses a baseline whose anchors predate the no-search templates, naming sync", async () => {
    const f = fixture();
    // A baseline file of its own (an absolute path), so the test does not depend on what the shipped one carries.
    const base = JSON.parse(JSON.stringify(loadBaseline("latest")));
    if (base.agentBinary?.searchAnchors) delete base.agentBinary.searchAnchors.noRequest;
    const bfile = join(f.root, "desktop-test.json");
    writeFileSync(bfile, JSON.stringify(base));
    const s = join(f.cwd, "h.yaml");
    writeFileSync(
      s,
      ["name: sc", `baseline: ${bfile}`, "session: ./s.yaml", "prompt: look something up", "fidelity: hostloop"].join("\n") + "\n",
    );
    const r = await cli(f, ["run", s, "--model", "claude-sonnet-5", "--search-corpus", "p"]);
    expect(r.text).toMatch(/searchAnchors\.noRequest.*re-run `cowork-harness sync`/);
  });

  it("refuses an agent whose search anchors differ from the baseline's, before the run dir exists", async () => {
    const f = fixture();
    // An agent binary with no search anchors at all: the check reads the exact file the spawn would launch.
    const agent = join(f.root, "other-agent");
    writeFileSync(agent, "not an agent");
    const r = await cli(f, ["run", scenario(f, "d.yaml", ["fidelity: hostloop"]), "--model", "claude-sonnet-5", "--search-corpus", "p"], {
      COWORK_HOST_AGENT_BINARY: agent,
    });
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/web-search anchors could not be read from it, the agent this run would launch/);
    expect(readdirSync(f.runsDir)).toEqual([]);
  });

  it("refuses a search_corpus_* assertion without --search-corpus, before the run dir exists", async () => {
    const f = fixture();
    const s = scenario(f, "k.yaml", ["fidelity: hostloop", "assert:", "  - search_corpus_max_miss_rate: 0.5"]);
    const r = await cli(f, ["run", s, "--model", "claude-sonnet-5"]);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/`search_corpus_max_miss_rate` needs --search-corpus <pool>/);
    expect(readdirSync(f.runsDir)).toEqual([]);
  });

  it("refuses a multi-leg scenario by name", async () => {
    const f = fixture();
    const p = join(f.cwd, "legs.yaml");
    writeFileSync(
      p,
      [
        "name: ml",
        "baseline: latest",
        "session: ./s.yaml",
        "fidelity: container",
        "legs:",
        "  - id: one",
        "    prompt: first",
        "  - id: two",
        "    prompt: second",
      ].join("\n") + "\n",
    );
    const r = await cli(f, ["run", p, "--model", "claude-sonnet-5", "--search-corpus", "p"]);
    expect(r.text).toMatch(/--search-corpus is not supported with a multi-leg scenario/);
  });

  it("refuses a search_corpus_* assertion in any leg of a multi-leg scenario before the first leg runs", async () => {
    const f = fixture();
    const p = join(f.cwd, "legs2.yaml");
    writeFileSync(
      p,
      [
        "name: ml",
        "baseline: latest",
        "session: ./s.yaml",
        "fidelity: container",
        "legs:",
        "  - id: one",
        "    prompt: first",
        "  - id: two",
        "    prompt: second",
        "    assert:",
        "      - search_corpus_nearby_citations: {path: outputs/r.md}",
      ].join("\n") + "\n",
    );
    const r = await cli(f, ["run", p, "--model", "claude-sonnet-5"]);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(
      /leg "two": `search_corpus_nearby_citations` needs --search-corpus, which a multi-leg scenario does not support/,
    );
    expect(readdirSync(f.runsDir)).toEqual([]);
  });

  it("refuses record of a scenario carrying a search_corpus_* key, without --search-corpus", async () => {
    const f = fixture();
    const s = scenario(f, "rk.yaml", ["fidelity: hostloop", "assert:", "  - search_corpus_max_miss_rate: 0.5"]);
    const r = await cli(f, ["record", s, "--model", "claude-sonnet-5"]);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/`search_corpus_max_miss_rate` needs --search-corpus <pool>/);
  });

  it("refuses record, naming the cassette version", async () => {
    const f = fixture();
    const r = await cli(f, ["record", scenario(f, "r.yaml", ["fidelity: hostloop"]), "--search-corpus", "p"]);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/record --search-corpus is refused: .*cassette version 19/);
  });

  it("refuses chat and probe-dispatch by name", async () => {
    const f = fixture();
    expect((await cli(f, ["chat", "--search-corpus", "p"])).text).toMatch(/chat --search-corpus is not available/);
    expect((await cli(f, ["probe-dispatch", "--search-corpus", "p"])).text).toMatch(/--search-corpus is not available on probe-dispatch/);
  });
});

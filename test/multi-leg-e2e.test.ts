// A multi-leg scenario end to end through the real CLI: `run` drives a stub agent through the protocol tier (no model
// call, no spend) for two prompt legs. The stub behaves like a gated skill that resumes from its own status file: it
// parks at `waiting` when it finds no run, and completes (invocation 2) when it finds a waiting one. Synthetic data only.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, POSIX, exited, makeStubFixture, spawnCli, type StubFixture } from "./helpers/stub-agent.js";
import { classifyRunDir } from "../src/run/turn-layout.js";

const can = POSIX && existsSync(CLI);
const DUMMY = { ANTHROPIC_API_KEY: "stub-placeholder-not-a-credential" };
const out = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const S = '"$COWORK_ARTIFACTS_ROOT/runs/r1/run_status.json"';
const STUB = [
  `mkdir -p "$COWORK_ARTIFACTS_ROOT/runs/r1"`,
  `if grep -q waiting ${S} 2>/dev/null; then printf '{"status":"complete","invocation":2,"resumed_from":{"gate":"g1"}}' > ${S}; ` +
    `else printf '{"status":"waiting","invocation":1,"up":"../etc"}' > ${S}; fi`,
  out({ type: "system", subtype: "init", session_id: "stub", model: "claude-sonnet-5", tools: [], cwd: "/tmp" }),
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done for now." }] }, session_id: "stub" }),
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done for now.",
    session_id: "stub",
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  "cat >/dev/null",
].join("\n");

function fixture(): StubFixture {
  const f = makeStubFixture(STUB, DUMMY);
  const bin = join(f.root, "bin", "claude");
  writeFileSync(
    bin,
    readFileSync(bin, "utf8").replace(
      "#!/bin/sh\n",
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo '  --permission-prompts <target>  Who answers: "host" or "none"'; fi\n`,
    ),
  );
  writeFileSync(
    join(f.cwd, "s.yaml"),
    ["answer_channel: none", "permission_mode: bypassPermissions", "agent_env:", "  artifacts_root: artifacts"].join("\n") + "\n",
  );
  return f;
}

const STATUS = "outputs/artifacts/runs/r1/run_status.json";
function scenario(f: StubFixture, workdir: "persistent" | "cowork-task"): string {
  const p = join(f.cwd, `ml-${workdir}.yaml`);
  writeFileSync(
    p,
    [
      "name: ml",
      "baseline: latest",
      "session: ./s.yaml",
      "fidelity: protocol",
      `workdir: ${workdir}`,
      "legs:",
      "  - id: ask",
      "    prompt: run the gated probe",
      "    assert:",
      `      - artifact_json: { artifact: ${STATUS}, path: status, equals: waiting }`,
      "  - id: resume",
      "    prompt: run the gated probe. FS_HOST_ANSWER g1=a",
      "    assert:",
      `      - artifact_json: { artifact: ${STATUS}, path: status, equals: complete }`,
      `      - artifact_json: { artifact: ${STATUS}, path: invocation, equals: 2 }`,
    ].join("\n") + "\n",
  );
  return p;
}
/** ask → a host action → resume. `run` is the action's argv; `status` its status read. */
function threeLeg(f: StubFixture, name: string, run: string[], extra: string[] = [], workdir = "persistent"): string {
  const p = join(f.cwd, `${name}.yaml`);
  writeFileSync(
    p,
    [
      `name: ${name}`,
      "baseline: latest",
      "session: ./s.yaml",
      "fidelity: protocol",
      `workdir: ${workdir}`,
      "legs:",
      "  - id: ask",
      "    prompt: run the gated probe",
      "    assert:",
      `      - artifact_json: { artifact: ${STATUS}, path: status, equals: waiting }`,
      "  - id: apply",
      "    host_action:",
      `      status: { artifact: ${STATUS}, expect: { status: waiting } }`,
      `      run: ${JSON.stringify(run)}`,
      ...(extra.length ? ["    assert:", ...extra] : []),
      "  - id: resume",
      "    prompt: run the gated probe. FS_HOST_ANSWER g1=a",
      "    assert:",
      `      - artifact_json: { artifact: ${STATUS}, path: status, equals: complete }`,
    ].join("\n") + "\n",
  );
  return p;
}
const legStatus = (env: { multiLeg: { legs: Array<{ id: string; status: string }> } }) =>
  env.multiLeg.legs.map((l) => `${l.id}:${l.status}`);

async function cli(f: StubFixture, args: string[]) {
  const c = spawnCli(f, args);
  const r = await exited(c, 120_000);
  return { ...r, stdout: c.stdoutText(), stderr: c.stderrText() };
}
const onlyRun = (f: StubFixture): string => {
  const d = join(f.runsDir, "ml");
  const runs = readdirSync(d).filter((x) => !x.startsWith("."));
  expect(runs).toHaveLength(1);
  return join(d, runs[0]!);
};

describe.runIf(can)("multi-leg run (stub agent, protocol)", () => {
  it("persistent: leg 2 is a new session that sees leg 1's files and completes the run; one index row", async () => {
    const f = fixture();
    try {
      const r = await cli(f, ["run", scenario(f, "persistent"), "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(0);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(true);
      expect(env.results).toHaveLength(2);
      expect(env.multiLeg.legs.map((l: { id: string; status: string }) => `${l.id}:${l.status}`)).toEqual(["ask:passed", "resume:passed"]);
      const ids = env.multiLeg.legs.map((l: { agentSessionId: string }) => l.agentSessionId);
      expect(new Set(ids).size).toBe(2); // two sessions, not a resume
      const root = onlyRun(f);
      expect(classifyRunDir(root)).toEqual({ kind: "legs", legs: ["ask", "resume"], complete: true });
      expect(existsSync(join(root, "work"))).toBe(true); // the shared tree is at the scenario root
      expect(existsSync(join(root, "legs", "ask", "work"))).toBe(false);
      const index = readFileSync(join(f.runsDir, "index.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(index.filter((row: { slug: string }) => row.slug === "ml")).toHaveLength(1);
      expect(index[index.length - 1]).toMatchObject({ multiLeg: true, pass: true, outDir: root });
    } finally {
      f.cleanup();
    }
  });

  it("cowork-task: leg 2's new task does not see leg 1's outputs, so the resume fails on invocation and the run fails", async () => {
    const f = fixture();
    try {
      const r = await cli(f, ["run", scenario(f, "cowork-task"), "--output-format", "json"]);
      expect(r.code).toBe(1);
      const env = JSON.parse(r.stdout);
      expect(env.ok).toBe(false);
      const resume = env.multiLeg.legs.find((l: { id: string }) => l.id === "resume");
      expect(resume.status).toBe("failed");
      const failures = resume.verdict.failures.map((x: { message: string }) => x.message).join("\n");
      expect(failures).toMatch(/status/); // the fresh run parked again: status is waiting, not complete
      expect(failures).toMatch(/invocation/);
      const root = onlyRun(f);
      expect(existsSync(join(root, "legs", "ask", "work"))).toBe(true);
      expect(existsSync(join(root, "legs", "resume", "work"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});

describe.runIf(can)("multi-leg run-time vacuity (stub agent, protocol)", () => {
  // Leg 2 asserts what leg 1 already left on the shared tree, so its block passes before it runs: it proves nothing,
  // fails as vacuous_positive_assertion naming the leg, and never spends. The glob form walks the previous leg's
  // user-visible roots, as the leg's own grade would.
  const twoLeg = (f: StubFixture, name: string, assertLine: string): string => {
    const p = join(f.cwd, `${name}.yaml`);
    writeFileSync(
      p,
      [
        `name: ${name}`,
        "baseline: latest",
        "session: ./s.yaml",
        "fidelity: protocol",
        "workdir: persistent",
        "legs:",
        "  - id: ask",
        "    prompt: run the gated probe",
        "    assert:",
        `      - artifact_json: { artifact: ${STATUS}, path: status, equals: waiting }`,
        "  - id: again",
        "    prompt: run the gated probe again",
        "    assert:",
        assertLine,
      ].join("\n") + "\n",
    );
    return p;
  };
  for (const [label, line] of [
    ["a literal path", `      - artifact_json: { artifact: ${STATUS}, path: status, equals: waiting }`],
    ["a glob", "      - artifact_json: { artifact: outputs/artifacts/runs/*/run_status.json, match: any, path: status, equals: waiting }"],
  ] as const) {
    it(`${label}: leg 2's block already passes on leg 1's tree ⇒ vacuous_positive_assertion, and leg 2 never runs`, async () => {
      const f = fixture();
      try {
        const name = label === "a glob" ? "vacg" : "vacl";
        const r = await cli(f, ["run", twoLeg(f, name, line), "--output-format", "json"]);
        expect(r.code, r.stdout + r.stderr).toBe(1);
        const env = JSON.parse(r.stdout);
        expect(legStatus(env)).toEqual(["ask:passed", "again:failed"]);
        const again = env.multiLeg.legs.find((l: { id: string }) => l.id === "again");
        expect(again.verdict.signals.map((s: { code: string }) => s.code)).toEqual(["vacuous_positive_assertion"]);
        expect(again.verdict.failures[0].message).toMatch(/^leg again: vacuous_positive_assertion/);
        const root = join(f.runsDir, name, readdirSync(join(f.runsDir, name)).filter((x) => !x.startsWith("."))[0]!);
        expect(existsSync(join(root, "legs", "again", "turns"))).toBe(false); // no agent session was started
      } finally {
        f.cleanup();
      }
    });
  }
});

describe.runIf(can)("multi-leg plugin identity (stub agent, protocol)", () => {
  // Every leg stages the session's plugins afresh. Two real staged trees that differ by one plugin file (the host
  // action edits the plugin's source between the legs) are not the scenario the author wrote: plugin_identity_changed.
  it("a plugin file edited between legs fails the later leg as plugin_identity_changed; an untouched plugin passes", async () => {
    const f = fixture();
    try {
      const plug = join(f.cwd, "plug");
      mkdirSync(join(plug, ".claude-plugin"), { recursive: true });
      mkdirSync(join(plug, "skills", "x"), { recursive: true });
      writeFileSync(join(plug, ".claude-plugin", "plugin.json"), '{ "name": "plug", "version": "0.1.0" }\n');
      const skill = join(plug, "skills", "x", "SKILL.md");
      writeFileSync(skill, "---\nname: x\ndescription: a synthetic skill\n---\nDo nothing.\n");
      writeFileSync(join(f.cwd, "s.yaml"), readFileSync(join(f.cwd, "s.yaml"), "utf8") + "plugins:\n  local_plugins:\n    - ./plug\n");

      const same = await cli(f, ["run", threeLeg(f, "idsame", ["sh", "-c", "true"]), "--output-format", "json"]);
      expect(same.code, same.stdout + same.stderr).toBe(0);
      expect(legStatus(JSON.parse(same.stdout))).toEqual(["ask:passed", "apply:passed", "resume:passed"]);

      const edit = await cli(f, [
        "run",
        threeLeg(f, "idedit", ["sh", "-c", `echo one more line >> '${skill}'`]),
        "--output-format",
        "json",
      ]);
      expect(edit.code, edit.stdout + edit.stderr).toBe(1);
      const env = JSON.parse(edit.stdout);
      expect(legStatus(env)).toEqual(["ask:passed", "apply:passed", "resume:failed"]);
      expect(env.multiLeg.verdict.signals.map((s: { code: string }) => s.code)).toContain("plugin_identity_changed");
      expect(JSON.stringify(env.multiLeg.verdict.failures)).toMatch(/leg resume: the staged skill\/plugin tree changed between legs/);
    } finally {
      f.cleanup();
    }
  });
});

describe.runIf(can)("multi-leg host actions (stub agent, protocol)", () => {
  const WRITE = 'mkdir -p artifacts/runs/r1 && printf "{\\"n\\":2}" > artifacts/runs/r1/corrections.json && echo applied 2 corrections';
  it("runs between the legs in the leg's tree, records what it wrote, and the resume leg completes", async () => {
    const f = fixture();
    try {
      const p = threeLeg(
        f,
        "act",
        ["sh", "-c", WRITE],
        [
          "      - exit_code: 0",
          '      - stdout_matches: "applied \\\\d+ corrections"',
          "      - file_exists: { path: outputs/artifacts/runs/r1/corrections.json, authored: true }",
        ],
      );
      const r = await cli(f, ["run", p, "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(0);
      const env = JSON.parse(r.stdout);
      expect(legStatus(env)).toEqual(["ask:passed", "apply:passed", "resume:passed"]);
      const root = join(f.runsDir, "act", readdirSync(join(f.runsDir, "act")).filter((x) => !x.startsWith("."))[0]!);
      const action = JSON.parse(readFileSync(join(root, "legs", "apply", "action.json"), "utf8"));
      expect(action).toMatchObject({ exitCode: 0, timedOut: false, pass: true });
      expect(action.stdout.head).toContain("applied 2 corrections");
      expect(action.produced.map((x: { path: string }) => x.path)).toEqual(["outputs/artifacts/runs/r1/corrections.json"]);
      expect(classifyRunDir(join(root, "legs", "apply"))).toEqual({ kind: "action-leg" });
    } finally {
      f.cleanup();
    }
  });

  it("an action that exits 1 fails its leg, and the resume leg is skipped, never run", async () => {
    const f = fixture();
    try {
      const r = await cli(f, ["run", threeLeg(f, "act1", ["sh", "-c", "exit 1"]), "--output-format", "json"]);
      expect(r.code).toBe(1);
      const env = JSON.parse(r.stdout);
      expect(legStatus(env)).toEqual(["ask:passed", "apply:failed", "resume:skipped"]);
      expect(env.results).toHaveLength(1); // the resume leg never ran
      expect(JSON.stringify(env.multiLeg.verdict.failures)).toMatch(/exited 1, expected 0 \(default\)/);
    } finally {
      f.cleanup();
    }
  });

  it("a status file that is absent, or a template that climbs out with .., fails the leg without running the command", async () => {
    const f = fixture();
    try {
      const marker = join(f.root, "ran");
      const p1 = threeLeg(f, "act2", ["sh", "-c", `touch ${marker}`]).replace("act2", "act2");
      writeFileSync(
        p1,
        readFileSync(p1, "utf8").replace(
          `status: { artifact: ${STATUS}, expect: { status: waiting } }`,
          "status: { artifact: outputs/nope.json }",
        ),
      );
      const r1 = await cli(f, ["run", p1, "--output-format", "json"]);
      expect(r1.code).toBe(1);
      expect(JSON.stringify(JSON.parse(r1.stdout).multiLeg.verdict.failures)).toMatch(/outputs\/nope.json is absent/);
      const r2 = await cli(f, ["run", threeLeg(f, "act3", ["ls", "{status.up}"]), "--output-format", "json"]);
      expect(r2.code).toBe(1);
      expect(JSON.stringify(JSON.parse(r2.stdout).multiLeg.verdict.failures)).toMatch(/\.\.\\" segment|\.\." segment/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});

describe.runIf(can)("multi-leg record → replay → verify-cassettes (stub agent, protocol, $0)", () => {
  it("records one v18 cassette with a nested cassette per prompt leg, each frozen at ITS end; replays green", async () => {
    const f = fixture();
    try {
      const p = threeLeg(f, "rec", ["sh", "-c", "echo applied 2 corrections"], ['      - stdout_matches: "applied \\\\d+"']);
      const cass = join(f.cwd, "rec.cassette.json");
      const r = await cli(f, ["record", p, "--out", cass, "--output-format", "json"]);
      expect(r.code, r.stderr).toBe(0);
      const c = JSON.parse(readFileSync(cass, "utf8"));
      expect(c.cassetteVersion).toBe(18);
      expect(c.scenario.prompt).toBeUndefined();
      expect(c.events).toBeUndefined();
      expect(c.legs.map((l: { id: string; kind: string }) => `${l.id}:${l.kind}`)).toEqual(["ask:prompt", "apply:action", "resume:prompt"]);
      // leg 1's nested cassette holds leg 1's tree (waiting), not the final one (complete): frozen when IT ended.
      const status = (leg: { cassette: { artifacts: Array<{ path: string; body?: string }> } }) =>
        JSON.parse(leg.cassette.artifacts.find((a) => a.path.endsWith("run_status.json"))!.body!).status;
      expect(status(c.legs[0])).toBe("waiting");
      expect(status(c.legs[2])).toBe("complete");
      // The frozen prompts are the nested cassettes' own.
      expect(c.scenario.legs[0].prompt).toBe(c.legs[0].cassette.scenario.prompt);

      const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(rep.code, rep.stderr).toBe(0);
      const env = JSON.parse(rep.stdout);
      expect(env.ok).toBe(true);
      expect(env.multiLegs[0].legs.map((l: { id: string; status: string }) => `${l.id}:${l.status}`)).toEqual([
        "ask:passed",
        "apply:passed",
        "resume:passed",
      ]);
      const vc = await cli(f, ["verify-cassettes", cass, "--output-format", "json"]);
      expect(vc.code, vc.stdout + vc.stderr).toBe(0);

      // The cassette's own top level (scenario, scenarioSource) is committed too, so it is scanned like a leg's.
      const top = JSON.parse(readFileSync(cass, "utf8"));
      top.scenario.name = "probe for ceo@acme-customer.com";
      top.scenario.legs[1].host_action.run = ["sh", "-c", "echo jane.doe@acme-customer.com"];
      top.scenarioSource = "../../../../../Users/alice/acme/rec.yaml";
      writeFileSync(join(f.cwd, "top.cassette.json"), JSON.stringify(top));
      const vcTop = await cli(f, ["verify-cassettes", join(f.cwd, "top.cassette.json"), "--output-format", "json"]);
      expect(vcTop.code, vcTop.stdout + vcTop.stderr).toBe(1);
      expect(vcTop.stdout).toMatch(/scenario: metadata:scenario\.name/);
      expect(vcTop.stdout).toMatch(/jane\.doe/);
      expect(vcTop.stdout).toMatch(/scenario: metadata:scenarioSource/);

      // An edited prompt in the scenario file is drift; an edited action exit expectation fails the replay.
      writeFileSync(p, readFileSync(p, "utf8").replace("run the gated probe. FS_HOST_ANSWER g1=a", "something else"));
      const vc2 = await cli(f, ["verify-cassettes", cass, "--output-format", "json"]);
      expect(vc2.code).toBe(1);
      expect(vc2.stdout).toMatch(/leg resume: the prompt changed/);
      // A scenario-wide field shapes every leg: its edit is drift too.
      writeFileSync(p, readFileSync(p, "utf8").replace("fidelity: protocol", "fidelity: container"));
      const vc3 = await cli(f, ["verify-cassettes", cass, "--output-format", "json"]);
      expect(vc3.code).toBe(1);
      expect(vc3.stdout).toMatch(/scenario-drift: fidelity changed/);
      const bad = JSON.parse(readFileSync(cass, "utf8"));
      bad.legs[1].action.exitCode = 1;
      writeFileSync(join(f.cwd, "bad.cassette.json"), JSON.stringify(bad));
      const rep2 = await cli(f, ["replay", join(f.cwd, "bad.cassette.json"), "--output-format", "json"]);
      expect(rep2.code).toBe(1);
      const env2 = JSON.parse(rep2.stdout);
      expect(env2.ok).toBe(false);
      expect(env2.multiLegs[0].legs.map((l: { status: string }) => l.status)).toEqual(["passed", "failed", "skipped"]);
    } finally {
      f.cleanup();
    }
  });

  it("redaction reaches every leg: a scrub-set value in leg 2's prompt is absent from the whole cassette, and it replays green", async () => {
    const f = fixture();
    try {
      const p = join(f.cwd, "red.yaml");
      writeFileSync(
        p,
        readFileSync(scenario(f, "persistent"), "utf8").replace("FS_HOST_ANSWER g1=a", "FS_HOST_ANSWER g1=a for Zyxwacme Holdings"),
      );
      const cass = join(f.cwd, "red.cassette.json");
      const env = { COWORK_HARNESS_REDACT_PATTERNS: "Zyxwacme" };
      const c = spawnCli(f, ["record", p, "--out", cass, "--output-format", "json"], env);
      const r = await exited(c, 120_000);
      expect(r.code, c.stdoutText() + c.stderrText()).toBe(0);
      const text = readFileSync(cass, "utf8");
      expect(JSON.parse(text).scenario.legs[1].prompt).toMatch(/for .* Holdings/); // the leg is there, its value scrubbed
      expect(text).not.toContain("Zyxwacme");
      const rep = await cli(f, ["replay", cass, "--output-format", "json"]);
      expect(rep.code, rep.stderr).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("a single-prompt reader refuses a multi-leg cassette by name; a dir batch names a legs scenario instead of skipping it", async () => {
    const f = fixture();
    try {
      const p = scenario(f, "persistent");
      const cass = join(f.cwd, "two.cassette.json");
      expect((await cli(f, ["record", p, "--out", cass])).code).toBe(0);
      const rh = await cli(f, ["rehash", cass, "--session", join(f.cwd, "s.yaml"), "--dry-run", "--output-format", "json"]);
      expect(rh.stdout + rh.stderr).toMatch(/multi-leg cassette/);
      const df = await cli(f, ["diff", cass, cass]);
      expect(df.code).not.toBe(0);
      expect(df.stderr + df.stdout).toMatch(/multi-leg cassette/);
      // The pre-spend refusals a single record gets: on_unanswered: prompt, and another scenario's cassette at the path.
      writeFileSync(
        join(f.cwd, "pr.yaml"),
        readFileSync(p, "utf8").replace("fidelity: protocol", "fidelity: protocol\non_unanswered: prompt"),
      );
      const pr = await cli(f, ["record", join(f.cwd, "pr.yaml"), "--dry-run", "--out", join(f.cwd, "pr.cassette.json")]);
      expect(pr.code).toBe(2);
      expect(pr.stdout + pr.stderr).toMatch(/on_unanswered: prompt/);
      writeFileSync(join(f.cwd, "other.yaml"), readFileSync(p, "utf8").replace("name: ml", "name: other"));
      mkdirSync(join(f.cwd, "cassettes"), { recursive: true });
      writeFileSync(join(f.cwd, "cassettes", "other.cassette.json"), JSON.stringify({ scenario: { name: "someone-else" } }));
      const col = await cli(f, ["record", join(f.cwd, "other.yaml"), "--dry-run"]);
      expect(col.code).toBe(2);
      expect(col.stdout + col.stderr).toMatch(/belongs to scenario "someone-else"/);
      const batch = await cli(f, ["record", f.cwd, "--dry-run", "--output-format", "json"]);
      expect(batch.stdout + batch.stderr).toMatch(/recorded on its own/);
      // --rerecord-stale over a dir holding a fresh multi-leg cassette: nothing to do, not a failure.
      const cdir = join(f.cwd, "cass");
      mkdirSync(cdir);
      writeFileSync(
        join(cdir, "two.cassette.json"),
        readFileSync(cass, "utf8").replace(/"scenarioSource": "([^"]+)"/, '"scenarioSource": "../$1"'),
      );
      const rs = await cli(f, ["record", cdir, "--rerecord-stale"]);
      expect(rs.code, rs.stdout + rs.stderr).toBe(0);
      expect(rs.stdout + rs.stderr).toMatch(/all cassettes under .* are fresh/);
    } finally {
      f.cleanup();
    }
  });
});

describe.runIf(can)("verify-run --leg (stub agent, protocol, $0)", () => {
  const rootOf = (f: StubFixture, name: string) =>
    join(f.runsDir, name, readdirSync(join(f.runsDir, name)).filter((x) => !x.startsWith("."))[0]!);
  it("persistent: every leg verifies from its own snapshot; without one, an earlier leg is refused (the shared tree moved on)", async () => {
    const f = fixture();
    try {
      const p = scenario(f, "persistent");
      expect((await cli(f, ["run", p])).code).toBe(0);
      const root = rootOf(f, "ml");
      const last = await cli(f, ["verify-run", root, p, "--leg", "resume", "--output-format", "json"]);
      expect(last.code, last.stdout + last.stderr).toBe(0);
      // Leg 1 asserted `waiting`; the shared tree now says `complete`. Its snapshot still says `waiting`.
      const first = await cli(f, ["verify-run", root, p, "--leg", "ask", "--output-format", "json"]);
      expect(first.code, first.stdout + first.stderr).toBe(0);
      const noLeg = await cli(f, ["verify-run", root, p]);
      expect(noLeg.stderr + noLeg.stdout).toMatch(/pass --leg <id>/);
      // regrade resolves the same leg the same way: the last leg loads as its own scenario (which has no judged assert,
      // so it stops there with no spend); an earlier leg is refused for the same reason verify-run refuses it.
      const rg = await cli(f, ["regrade", root, "--scenario", p, "--leg", "resume", "--output-format", "json"]);
      expect(rg.stdout + rg.stderr).toMatch(/no_semantic_asserts/);
      const tr = await cli(f, ["trace", root, "--leg", "resume", "--output-format", "json"]);
      expect(tr.code, tr.stderr).toBe(0);
      const byId = await cli(f, ["trace", root.split("/").pop()!, "--leg", "resume", "--output-format", "json"]);
      expect(byId.code, byId.stdout + byId.stderr).toBe(0);
      const trRoot = await cli(f, ["trace", root, "--output-format", "json"]);
      expect(trRoot.code).toBe(2);
      expect(trRoot.stdout).toMatch(/"category":"runtime".*multi-leg run/);
      const rg1 = await cli(f, ["regrade", root, "--scenario", p, "--leg", "ask", "--output-format", "json"]);
      expect(rg1.stdout + rg1.stderr).toMatch(/no_semantic_asserts/);
      // No usable snapshot (removed here; over the cap, or a tampered one, the same): back to the live-tree rule.
      rmSync(join(root, "legs", "ask", "snapshot.json"));
      const noSnap = await cli(f, ["verify-run", root, p, "--leg", "ask"]);
      expect(noSnap.code).toBe(2);
      expect(noSnap.stderr + noSnap.stdout).toMatch(/its session tree is shared and was changed by later legs/);
    } finally {
      f.cleanup();
    }
  });

  it("cowork-task: a leg verifies from its snapshot even after a host action wrote to its tree", async () => {
    const f = fixture();
    try {
      const p = scenario(f, "cowork-task");
      await cli(f, ["run", p]); // the resume leg fails by design (a new task does not see the run); ask is intact
      const ok = await cli(f, ["verify-run", join(rootOf(f, "ml"), "legs", "ask"), p, "--output-format", "json"]);
      expect(ok.code, ok.stdout + ok.stderr).toBe(0);
      const p2 = threeLeg(f, "touch", ["sh", "-c", "echo x > touched.txt"], [], "cowork-task");
      await cli(f, ["run", p2]);
      const moved = await cli(f, ["verify-run", rootOf(f, "touch"), p2, "--leg", "ask", "--output-format", "json"]);
      expect(moved.code, moved.stdout + moved.stderr).toBe(0);
      // Without the snapshot, the changed tree is refused, naming what changed.
      rmSync(join(rootOf(f, "touch"), "legs", "ask", "snapshot.json"));
      const live = await cli(f, ["verify-run", rootOf(f, "touch"), p2, "--leg", "ask"]);
      expect(live.code).toBe(2);
      expect(live.stderr + live.stdout).toMatch(/tree changed after the leg ended \(added outputs\/touched\.txt/);
      const action = await cli(f, ["verify-run", rootOf(f, "touch"), p2, "--leg", "apply"]);
      expect(action.stderr + action.stdout).toMatch(/is a host action/);
    } finally {
      f.cleanup();
    }
  });
});

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  scanHostInventory,
  KNOWN_COWORK_SERVERS,
  KNOWN_BUILTIN_AGENTS,
  KNOWN_BUILTIN_SKILLS,
  HOST_INVENTORY_CLS,
  DEFAULT_SCAN_PATTERNS,
} from "../src/scan.js";
import { collectDeclaredPlugins } from "../src/run/cassette.js";
import { makeSkillsHandler } from "../src/hostloop/skills-handler.js";
import { makePluginsHandler } from "../src/hostloop/plugins-handler.js";
import { makeWorkspaceHandler } from "../src/hostloop/workspace-handler.js";
import { makeCoworkHandler } from "../src/hostloop/cowork-handler.js";

// A cassette recorded at a host-inheriting tier freezes the recording MACHINE's inventory into its init and
// command-registry events. One such fixture shipped publicly carrying 18 personal MCP server names, the
// account org, and the host's agent roster. The text scanner could not see it: an unconnected MCP server
// declares no tools, so no `mcp__*` token is written and a `grep mcp__` reads clean — the inventory lives in
// NAME fields. These pin the structural replacement.

const init = (over: Record<string, unknown>) => ({ type: "system", subtype: "init", ...over });

describe("scanHostInventory — foreign MCP servers (the axis that caught the real leak)", () => {
  it("flags a server name outside the harness's own set", () => {
    const f = scanHostInventory(init({ mcp_servers: [{ name: "plaud", status: "pending" }] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["plaud"]);
    expect(f[0].cls).toBe(HOST_INVENTORY_CLS);
    expect(f[0].where).toContain("mcp_servers[].name");
  });

  it("flags an UNCONNECTED server — the shipped leak's servers were all pending/needs-auth/failed", () => {
    const f = scanHostInventory(
      init({
        mcp_servers: [
          { name: "claude.ai Gmail", status: "needs-auth" },
          { name: "paper", status: "failed" },
        ],
      }),
      "events[0]",
      [],
    );
    expect(f.map((x) => x.sample).sort()).toEqual(["claude.ai Gmail", "paper"]);
  });

  it("does NOT flag the harness's own servers", () => {
    const f = scanHostInventory(
      init({ mcp_servers: [...KNOWN_COWORK_SERVERS].map((name) => ({ name, status: "connected" })) }),
      "events[0]",
      [],
    );
    expect(f).toEqual([]);
  });

  // Field scoping: only NAME fields are read. Descriptions are unbounded free text with no clean predicate,
  // so a foreign name mentioned in prose is out of scope BY DESIGN. Non-vacuous only as a pair with the
  // positive above — on its own it would pass against a guard that reads nothing at all.
  it("does NOT flag a foreign name that appears only inside a description field", () => {
    const f = scanHostInventory(
      {
        type: "control_response",
        response: { response: { commands: [{ name: "x", description: "connect plaud and claude.ai Gmail here" }] } },
      },
      "events[0]",
      [],
    );
    expect(f).toEqual([]);
  });
});

describe("scanHostInventory — remaining axes", () => {
  it("flags a prefixed tool naming a foreign server (defence-in-depth)", () => {
    const f = scanHostInventory(init({ tools: ["Bash", "mcp__plaud__get_transcript", "mcp__skills__list_skills"] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["plaud"]);
  });

  it("flags each operator-identity key on the account block, and no others", () => {
    const f = scanHostInventory(
      {
        response: {
          response: {
            account: { email: "a@b.c", organization: "acme", subscriptionType: "max", apiProvider: "firstParty", tokenSource: "X" },
          },
        },
      },
      "events[0]",
      [],
    );
    expect(f.map((x) => x.sample).sort()).toEqual(["email", "organization", "subscriptionType"]);
  });

  it("does NOT flag a clean account block (tokenSource + apiProvider only)", () => {
    const f = scanHostInventory(
      { response: { response: { account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } } } },
      "events[0]",
      [],
    );
    expect(f).toEqual([]);
  });

  it("flags an agent outside the built-in roster, accepting both string and {name} shapes", () => {
    const strs = scanHostInventory(init({ agents: ["Plan", "codex:codex-rescue"] }), "events[0]", []);
    expect(strs.map((x) => x.sample)).toEqual(["codex:codex-rescue"]);
    const objs = scanHostInventory(
      { response: { response: { agents: [{ name: "Plan" }, { name: "hookify:conversation-analyzer" }] } } },
      "events[0]",
      [],
    );
    expect(objs.map((x) => x.sample)).toEqual(["hookify:conversation-analyzer"]);
  });

  it("does NOT flag the built-in agent roster", () => {
    expect(scanHostInventory(init({ agents: [...KNOWN_BUILTIN_AGENTS] }), "events[0]", [])).toEqual([]);
  });

  it("finds a declaration nested below the event root (registry responses sit two levels down)", () => {
    const f = scanHostInventory({ a: { b: { c: init({ mcp_servers: [{ name: "plaud" }] }) } } }, "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["plaud"]);
  });
});

describe("scanHostInventory — allow scoping", () => {
  it("a class-scoped allow suppresses it; a differently-scoped allow does not", () => {
    const ev = init({ mcp_servers: [{ name: "plaud" }] });
    expect(scanHostInventory(ev, "events[0]", [{ cls: HOST_INVENTORY_CLS, re: /plaud/ }])).toEqual([]);
    expect(scanHostInventory(ev, "events[0]", [{ cls: "path", re: /plaud/ }])).toHaveLength(1);
  });

  it("the allow must match the WHOLE name, not a substring", () => {
    const ev = init({ mcp_servers: [{ name: "claude.ai Gmail" }] });
    expect(scanHostInventory(ev, "events[0]", [{ cls: HOST_INVENTORY_CLS, re: /Gmail/ }])).toHaveLength(1);
    expect(scanHostInventory(ev, "events[0]", [{ cls: HOST_INVENTORY_CLS, re: /claude\.ai Gmail/ }])).toEqual([]);
  });
});

describe("host-inventory — drift guards", () => {
  // KNOWN_COWORK_SERVERS is a literal in scan.ts to avoid a scan->hostloop dependency. This asserts it
  // against what the handlers actually report, so the two cannot drift apart silently.
  it("KNOWN_COWORK_SERVERS equals exactly what the handlers report via initialize", async () => {
    const handlers = [
      makeSkillsHandler({ mountedSkills: [], mountedPluginNames: [], suggestSkillsEnabled: true, proactiveSkillSuggestEnabled: false }),
      makePluginsHandler({ mountedPlugins: [] }),
      makeWorkspaceHandler({ runDir: tmpdir(), sessionRoot: tmpdir(), egress: { allowDomains: [] } } as never),
      makeCoworkHandler({ userVisibleRoots: [] } as never),
    ];
    const reported = new Set<string>();
    for (const h of handlers) {
      // McpHandler is (server, jsonrpcRequest) => McpResult
      const res: any = await h(undefined as never, { method: "initialize", params: {} } as never);
      const name = res?.result?.serverInfo?.name;
      expect(typeof name).toBe("string");
      reported.add(name);
    }
    // EQUALITY, not containment. Containment only catches a handler the set forgot (a false POSITIVE, noisy
    // but safe). A stale EXTRA entry in the set is the dangerous direction — it silently exempts a server
    // the harness no longer serves, i.e. a miss — and only equality catches that.
    expect([...reported].sort()).toEqual([...KNOWN_COWORK_SERVERS].sort());
  });

  // The `cls` enum is hand-maintained in THREE places and had already rotted before this class existed:
  // `binary` was emitted by the artifact path but missing from the schema, so a JSON consumer validating
  // that output would reject it. An empty grep proves nothing here — assert the actual containment.
  it("every emitted cls literal is present in schema/verify-cassettes.json and SPEC.md", () => {
    const root = resolve(__dirname, "..");
    const schema = readFileSync(join(root, "schema/verify-cassettes.json"), "utf8");
    const spec = readFileSync(join(root, "SPEC.md"), "utf8");
    const enumMatch = /"enum":\s*\[([^\]]*)\]/.exec(schema.slice(schema.indexOf('"cls"')));
    const schemaEnum = new Set((enumMatch?.[1] ?? "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")));
    const emitted = [...DEFAULT_SCAN_PATTERNS.map((p) => p.cls), HOST_INVENTORY_CLS, "unscanned", "binary"];
    for (const cls of emitted) {
      expect(schemaEnum.has(cls), `${cls} missing from schema/verify-cassettes.json cls enum`).toBe(true);
      expect(spec.includes(cls), `${cls} missing from SPEC.md's cls union`).toBe(true);
    }
  });
});

// Reachability: the extractor being correct is worthless if the CLI never calls it. This drives the real
// `verify-cassettes` entry point. It FAILS rather than skips when dist/ is absent — a skipIf here would
// green-pass an unbuilt tree, which is the exact vacuous pass this test exists to prevent.
describe("host-inventory — reachable through the verify-cassettes CLI", () => {
  const CLI = resolve(__dirname, "../dist/cli.js");

  it("dist/cli.js exists (build before running this suite)", () => {
    expect(existsSync(CLI), "run `npm run build` — this test must not skip").toBe(true);
  });

  // Derived from a REAL committed cassette rather than hand-built: the loader is strict (scenario.session and
  // friends are required), so a synthesised shape fails as `[error] invalid cassette shape` and exits 3
  // ("could not verify") without ever reaching the privacy scan — a green-looking non-zero for the wrong
  // reason. Copying a known-valid fixture and injecting one foreign server keeps the exit code meaningful.
  const FIXTURES = resolve(__dirname, "../examples/replays");
  const inject = (dir: string, source: string) => {
    const c = JSON.parse(readFileSync(join(FIXTURES, source), "utf8"));
    const i = c.events.findIndex((l: string) => typeof l === "string" && l.includes('"mcp_servers"'));
    expect(i, `${source} should carry an init event with mcp_servers`).toBeGreaterThanOrEqual(0);
    const ev = JSON.parse(c.events[i]);
    ev.mcp_servers = [...(ev.mcp_servers ?? []), { name: "plaud", status: "pending" }];
    c.events[i] = JSON.stringify(ev);
    const p = join(dir, "t.cassette.json");
    writeFileSync(p, JSON.stringify(c, null, 2));
    return p;
  };

  it("a host-inheriting cassette carrying a foreign server FAILS the gate (exit 1, class named)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostinv-"));
    inject(dir, "hostloop-computer-links.cassette.json"); // hostloop = host-inheriting
    const r = spawnSync(process.execPath, [CLI, "verify-cassettes", dir], { encoding: "utf8" });
    const out = r.stdout + r.stderr;
    expect(out).toContain(HOST_INVENTORY_CLS);
    expect(out).toContain("plaud");
    expect(r.status).toBe(1); // 1 = verified & failed, NOT 3 (could not verify)
  });

  // The tier gate is load-bearing, not cosmetic: `mcp.config` is a documented way to attach an MCP server to
  // a session under test, and the cassette freezes only the session PATH — so the scan cannot tell a declared
  // server from a leaked one. At container the agent is sealed, so it must be exempt or this reds legitimate
  // fixtures. Same injected payload, only the tier differs.
  // REGRESSION (fail-open): `fidelity` is NOT required by the cassette shape, so a cassette that omits it
  // used to skip the whole check — a silent pass on exactly the file a leak arrives in. Unknown tier must
  // scan, same fail-closed reasoning as `cowork`.
  it("a cassette with NO scenario.fidelity still gets scanned (unknown tier fails closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostinv-nofid-"));
    const p = inject(dir, "hostloop-computer-links.cassette.json");
    const c = JSON.parse(readFileSync(p, "utf8"));
    delete c.scenario.fidelity;
    delete c.effectiveFidelity;
    writeFileSync(p, JSON.stringify(c, null, 2));
    const r = spawnSync(process.execPath, [CLI, "verify-cassettes", dir], { encoding: "utf8" });
    expect(r.stdout + r.stderr).toContain(HOST_INVENTORY_CLS);
  });

  it("the same payload in a container-tier cassette does NOT fail — a sealed run's server was declared", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostinv-ok-"));
    inject(dir, "example-pdf-skill.cassette.json"); // container = sealed
    const r = spawnSync(process.execPath, [CLI, "verify-cassettes", dir], { encoding: "utf8" });
    expect(r.stdout + r.stderr).not.toContain(HOST_INVENTORY_CLS);
  });
});

// ---------------------------------------------------------------------------------------------------
// Layer B — refuse a host-inheriting record into a repo-visible path, BEFORE the paid spawn.
// Unit-level (hostInventoryPreflight) so these are token-free and cannot accidentally start an agent.
import { hostInventoryPreflight } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

const scn = (fidelity: string): Scenario => ({ name: "t", fidelity, baseline: "latest", prompt: "p" }) as unknown as Scenario;

describe("hostInventoryPreflight — Layer B", () => {
  const repoPath = resolve(__dirname, "../examples/replays/brand-new.cassette.json"); // in-tree, not ignored, absent
  const ignoredPath = resolve(__dirname, "../cassettes/whatever.cassette.json"); // cassettes/ is gitignored
  const outsidePath = join(tmpdir(), "outside.cassette.json");

  it("REFUSES a new repo-visible fixture at protocol", () => {
    const v = hostInventoryPreflight(scn("protocol"), repoPath, false);
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") {
      expect(v.message).toContain("protocol");
      expect(v.message).toContain("container"); // names the fix
      expect(v.message).toContain("--allow-host-inventory-fixture"); // names the override
    }
  });

  it("REFUSES at hostloop too", () => {
    expect(hostInventoryPreflight(scn("hostloop"), repoPath, false).kind).toBe("refuse");
  });

  it("allows container tier into the very same path — sealed, nothing to leak", () => {
    expect(hostInventoryPreflight(scn("container"), repoPath, false).kind).toBe("ok");
  });

  // REGRESSION (fail-open): the gitignored-path case must exercise `git check-ignore` for real. The dir is
  // created first because `cassettes/` is gitignored and therefore absent in a fresh clone — without it this
  // test passes through the nonexistent-ancestor branch instead, and the check-ignore call could be deleted
  // entirely with the test still green.
  //
  // The dir is removed again when this test created it. Left behind, it leaked into every later test file
  // in the worker: a guard that listed the gitignored `cassettes/` passed in CI only because this ran first,
  // while failing in any fresh checkout. `rmdirSync` is non-recursive, so a recording someone wrote there
  // in the meantime is never deleted — the removal just fails instead.
  it("allows a gitignored in-repo path (the default cassettes/ dir) at protocol", () => {
    const created = mkdirSync(dirname(ignoredPath), { recursive: true });
    try {
      expect(existsSync(dirname(ignoredPath)), "the gitignored dir must exist or this asserts nothing").toBe(true);
      expect(hostInventoryPreflight(scn("protocol"), ignoredPath, false).kind).toBe("ok");
    } finally {
      if (created !== undefined) rmdirSync(created);
    }
  });

  // REGRESSION (fail-open): a first-ever record into a NEW subdirectory. `git -C <nonexistent>` exits 128,
  // and reading that as "not a repo" let the most dangerous case through — the path by which a brand-new
  // fixture is created. Must resolve the nearest existing ancestor and still refuse.
  it("REFUSES a repo path whose parent directory does not exist yet", () => {
    const nested = resolve(__dirname, "../examples/replays/brand-new-dir/deep/x.cassette.json");
    expect(existsSync(dirname(nested))).toBe(false);
    expect(hostInventoryPreflight(scn("protocol"), nested, false).kind).toBe("refuse");
  });

  it("allows a path outside any work tree at protocol", () => {
    expect(hostInventoryPreflight(scn("protocol"), outsidePath, false).kind).toBe("ok");
  });

  it("the override flag turns the refusal off", () => {
    expect(hostInventoryPreflight(scn("protocol"), repoPath, true).kind).toBe("ok");
  });

  // An in-place refresh of an EXISTING committed fixture warns instead of refusing. Refusing it would break
  // --rerecord-stale on every host-inheriting fixture, and the predictable result is that the override gets
  // passed by reflex — disabling the guard exactly where it matters. Layer A still hard-gates the result.
  it("WARNS (does not refuse) when re-recording an existing committed fixture in place", () => {
    const existing = resolve(__dirname, "../examples/replays/hostloop-computer-links.cassette.json");
    const v = hostInventoryPreflight(scn("hostloop"), existing, false);
    expect(v.kind).toBe("warn");
    if (v.kind === "warn") expect(v.message).toContain("verify-cassettes");
  });
});

// A plugin mounted BY the scenario contributes its own agents to the roster — at `hostloop` that is the
// fixture, not a leak of the recording machine's inventory. The sibling check A1 already carves out the
// equivalent case for `mcp.config`-attached servers; A4 flagged every plugin-with-agents consumer on
// upgrade and left them to invent a regex.
//
// The provenance is already in the payload: `plugins[]` sits beside `agents[]` in the same init object,
// and a plugin's agents are namespaced `<plugin>:<agent>` (the two cases above encode that convention).
// So the subtraction is derivable at scan time from an already-recorded cassette — no re-record.
describe("scanHostInventory — scenario-declared plugin agents", () => {
  it("does NOT flag an agent namespaced to a plugin the same init declares", () => {
    const f = scanHostInventory(init({ plugins: [{ name: "codex" }], agents: ["Plan", "codex:codex-rescue"] }), "events[0]", []);
    expect(f).toEqual([]);
  });

  it("still flags an agent namespaced to a plugin that is NOT declared", () => {
    const f = scanHostInventory(init({ plugins: [{ name: "codex" }], agents: ["hookify:conversation-analyzer"] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["hookify:conversation-analyzer"]);
  });

  it("still flags a non-namespaced foreign agent even when plugins are declared", () => {
    const f = scanHostInventory(init({ plugins: [{ name: "codex" }], agents: ["some-host-agent"] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["some-host-agent"]);
  });

  it("applies to the {name} object shape too", () => {
    const f = scanHostInventory(
      init({ plugins: [{ name: "hookify" }], agents: [{ name: "hookify:conversation-analyzer" }] }),
      "events[0]",
      [],
    );
    expect(f).toEqual([]);
  });

  // The registry `control_response` carries agents with no sibling `plugins[]`, so the caller harvests
  // plugin names from the events array and passes them in. Without that, this surface keeps false-positiving.
  it("accepts externally-harvested plugin names for payloads with no sibling plugins[]", () => {
    const noSibling = { response: { response: { agents: [{ name: "codex:codex-rescue" }] } } };
    expect(scanHostInventory(noSibling, "events[0]", [])).toHaveLength(1); // no context → still flagged
    expect(scanHostInventory(noSibling, "events[0]", [], ["codex"])).toEqual([]);
  });
});

// The registry `control_response` lists agents with no sibling `plugins[]`, so the plugin names are
// harvested once from the whole event stream and handed to every scan. A per-event scan alone would
// leave that surface false-positiving on the scenario's own plugin agents.
describe("collectDeclaredPlugins", () => {
  const line = (o: unknown) => JSON.stringify(o);

  it("collects plugin names from a system/init event", () => {
    const names = collectDeclaredPlugins([line({ type: "system", subtype: "init", plugins: [{ name: "my-pdf-skill" }] })]);
    expect(names).toEqual(["my-pdf-skill"]);
  });

  it("dedupes across events and tolerates a plugins[] of bare strings", () => {
    const names = collectDeclaredPlugins([
      line({ plugins: [{ name: "a" }, "b"] }),
      line({ plugins: [{ name: "a" }, { name: "c" }] }),
    ]).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("skips non-JSON lines and events without plugins instead of throwing", () => {
    expect(collectDeclaredPlugins(["not json", line({ type: "assistant" })])).toEqual([]);
  });

  it("returns empty for undefined events (a cassette may carry none)", () => {
    expect(collectDeclaredPlugins(undefined)).toEqual([]);
  });
});

// 240 findings printed as 240 indistinguishable lines. A consumer had to pipe through `uniq -c` to learn
// they were all one class with one cause — a detour that a single header line removes. Additive on
// purpose: the per-file rows are the audit trail and the rationale at the `notes` loop is right that
// collapsing them would destroy attribution, so the rollup PRECEDES the list and replaces nothing.
describe("verify-cassettes — findings rollup", () => {
  const CLI = resolve(__dirname, "../dist/cli.js");
  const FIXTURES = resolve(__dirname, "../examples/replays");

  /** Two host-inheriting cassettes, each carrying a foreign server ⇒ several findings of ONE class. */
  const twoBadCassettes = (dir: string) => {
    for (const n of ["a", "b"]) {
      const c = JSON.parse(readFileSync(join(FIXTURES, "hostloop-computer-links.cassette.json"), "utf8"));
      const i = c.events.findIndex((l: string) => typeof l === "string" && l.includes('"mcp_servers"'));
      const ev = JSON.parse(c.events[i]);
      ev.mcp_servers = [...(ev.mcp_servers ?? []), { name: "plaud", status: "pending" }];
      c.events[i] = JSON.stringify(ev);
      writeFileSync(join(dir, `${n}.cassette.json`), JSON.stringify(c, null, 2));
    }
  };

  it("prints a per-class count before the per-finding list", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollup-"));
    twoBadCassettes(dir);
    const r = spawnSync(process.execPath, [CLI, "verify-cassettes", dir], { encoding: "utf8" });
    const out = r.stdout + r.stderr;
    expect(out).toMatch(new RegExp(`findings by class:.*${HOST_INVENTORY_CLS} \\d+`));
    // The rollup is additive — every per-file row survives, so attribution is not lost.
    expect(out).toContain("a.cassette.json");
    expect(out).toContain("b.cassette.json");
  });

  // It summarizes the findings list as it stands, INFORMATIONAL classes included. `unscanned` is a
  // finding (the `·` rows), so counting it is what makes the header agree with the list beneath it —
  // and "what did this sweep decline to scan" is worth a number of its own. A gate-passing cassette
  // therefore still gets a rollup; only a genuinely finding-free one has nothing to print.
  it("counts informational classes too, so the header agrees with the list", () => {
    const dir = mkdtempSync(join(tmpdir(), "rollup-clean-"));
    writeFileSync(join(dir, "ok.cassette.json"), readFileSync(join(FIXTURES, "example-pdf-skill.cassette.json"), "utf8"));
    const r = spawnSync(process.execPath, [CLI, "verify-cassettes", dir], { encoding: "utf8" });
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/findings by class: unscanned 1/);
    const rollup = out.split("\n").findIndex((l) => l.startsWith("findings by class:"));
    const firstRow = out.split("\n").findIndex((l) => l.includes("[unscanned]"));
    expect(rollup, "the rollup must precede the rows it summarizes").toBeLessThan(firstRow);
  });
});

// `skills[]` sits in the same init payload as `mcp_servers`/`agents` and was read by no axis. It is a
// real leak vector, not a theoretical one: at `protocol` with local OAuth the harness keeps the
// OPERATOR'S REAL CLAUDE_CONFIG_DIR (src/runtime/protocol.ts — a fresh dir breaks OAuth), so the
// personal skills installed there are discoverable and would be frozen into a committed fixture.
//
// Two exemptions, mirroring the agents axis: the agent's own built-ins, and a `<plugin>:<skill>` whose
// plugin the same recording declares.
describe("scanHostInventory — skills[]", () => {
  it("does NOT flag the agent's built-in skills", () => {
    expect(scanHostInventory(init({ skills: [...KNOWN_BUILTIN_SKILLS] }), "events[0]", [])).toEqual([]);
  });

  it("does NOT flag the two built-ins host claude 2.1.319 lists", () => {
    expect(scanHostInventory(init({ skills: ["schedule", "send-to-project"] }), "events[0]", [])).toEqual([]);
  });

  it("flags a bare skill outside the built-in roster — a personal skill from the operator's config dir", () => {
    const f = scanHostInventory(init({ skills: ["deep-research", "my-private-notes"] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["my-private-notes"]);
    expect(f[0].where).toContain("skills[]");
  });

  it("does NOT flag a skill namespaced to a plugin the same init declares", () => {
    const payload = init({ plugins: [{ name: "my-pdf-skill" }], skills: ["deep-research", "my-pdf-skill:my-pdf-skill"] });
    expect(scanHostInventory(payload, "events[0]", [])).toEqual([]);
  });

  it("flags a skill namespaced to a plugin that was never declared", () => {
    const f = scanHostInventory(init({ plugins: [{ name: "my-pdf-skill" }], skills: ["hookify:writing-rules"] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["hookify:writing-rules"]);
  });

  it("honours externally-harvested plugin names, as the agents axis does", () => {
    const payload = { response: { response: { skills: ["codex:codex-cli-runtime"] } } };
    expect(scanHostInventory(payload, "events[0]", [])).toHaveLength(1);
    expect(scanHostInventory(payload, "events[0]", [], ["codex"])).toEqual([]);
  });

  it("is suppressible by an allow pattern like every other host-inventory finding", () => {
    const ev = init({ skills: ["my-private-notes"] });
    expect(scanHostInventory(ev, "events[0]", [{ cls: HOST_INVENTORY_CLS, re: /my-private-notes/ }])).toEqual([]);
    expect(scanHostInventory(ev, "events[0]", [])).toHaveLength(1); // non-vacuous: it really was suppressed
  });
});

// Every shipped cassette must stay clean under the new axis — these are the fixtures CI verifies, and a
// roster that is wrong reds the repo's own gate before it ever reaches a consumer.
describe("skills[] axis — the committed fixtures stay clean", () => {
  it("no shipped cassette trips the skills axis", () => {
    const root = resolve(__dirname, "..");
    const files = [
      join(root, "cassettes/skill-loads.cassette.json"),
      ...["example-pdf-skill", "example-multiselect-gate", "hostloop-computer-links"].map((n) =>
        join(root, `examples/replays/${n}.cassette.json`),
      ),
    ].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const c = JSON.parse(readFileSync(f, "utf8"));
      for (const line of c.events ?? []) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          continue;
        }
        const skillFindings = scanHostInventory(decoded, "events", []).filter((x) => x.where.includes("skills[]"));
        expect(
          skillFindings.map((x) => x.sample),
          `${f} tripped the skills axis`,
        ).toEqual([]);
      }
    }
  });
});

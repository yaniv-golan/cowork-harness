import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { batchBudgetTracker } from "../src/run/budget.js";

// `record --max-budget-usd` — the paid path's cost cap. `record` is the widest-blast-radius spend in the
// CLI (dir batch + --rerecord-stale + --concurrency up to 8) and shipped with no cap at all until 1.15.0.
//
// Everything here is TOKEN-FREE: the refusal fires BEFORE any agent spawn (that is the whole point of a
// pre-flight), and the degradation paths are pure history lookups. Nothing below performs live inference.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "rec-budget-runs-"));
}
function tmpWork() {
  return mkdtempSync(join(tmpdir(), "rec-budget-work-"));
}

/** Seed a priced run so `scenarioCostHistory` has something to refuse against. Mirrors the shape
 *  test/cli-stats.test.ts seeds; `stats --reindex` turns it into index.jsonl rows. */
function seedRun(root: string, scenario: string, runId: string, costUsd: number) {
  const dir = join(root, scenario, runId);
  mkdirSync(join(dir, "turns", "1"), { recursive: true });
  writeFileSync(
    join(dir, "turns", "1", "result.json"),
    JSON.stringify({
      scenario,
      fidelity: "container",
      baseline: "desktop-1.18286.0",
      result: "success",
      decisions: [],
      egress: [],
      assertions: [],
      outDir: dir,
      cost: { usd: costUsd },
    }),
  );
}

function cli(args: string[], root: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root } });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

function scenarioYaml(name: string): string {
  return `name: ${name}\nprompt: "do the thing"\nfidelity: protocol\nassert:\n  - result: success\n`;
}

describe.skipIf(!can)("record --max-budget-usd — flag surface", () => {
  it("appears in the usage line (a flag nobody can discover is not a feature)", () => {
    const r = cli(["record"], tmpRoot());
    expect(r.all).toMatch(/--max-budget-usd/);
  });

  it("rejects a non-positive value as usage (exit 2)", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), scenarioYaml("s"));
    for (const bad of ["0", "-1", "abc"]) {
      const r = cli(["record", join(work, "s.yaml"), "--max-budget-usd", bad], tmpRoot());
      expect(r.code, `value ${bad}`).toBe(2);
      expect(r.all).toMatch(/requires a positive number/);
    }
  });
});

describe.skipIf(!can)("record --max-budget-usd — single scenario", () => {
  it("REFUSES before spending when this scenario's own history exceeds the cap", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    // Asserted through --dry-run so this holds with or without model credentials. The gate is the SAME
    // one the real path runs (pinned by the dry-vs-real precedence test below); going through the real
    // path here would assert the auth guard's message on a tokenless runner instead — which is how this
    // test first passed locally (a repo .env supplies a token) and failed in CI.
    const r = cli(["record", join(work, "pricey.yaml"), "--max-budget-usd", "0.1", "--dry-run"], root);
    expect(r.all).toMatch(/refused before spending/);
    expect(r.all).toMatch(/has cost up to \$0\.5000/);
    expect(r.code).not.toBe(0);
  });

  it("PROCEEDS past the gate when history is under the cap (the refusal is not unconditional)", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "cheap", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "cheap.yaml"), scenarioYaml("cheap"));
    // --dry-run stops before any spawn; reaching the dry-run report proves the gate let it through.
    const r = cli(["record", join(work, "cheap.yaml"), "--max-budget-usd", "5", "--dry-run"], root);
    expect(r.all).not.toMatch(/refused before spending/);
    expect(r.all).toMatch(/record --dry-run/);
    expect(r.code).toBe(0);
  });

  it("degrades LOUDLY (warn + proceed UNCAPPED) when the scenario has never been priced", () => {
    const work = tmpWork();
    writeFileSync(join(work, "fresh.yaml"), scenarioYaml("fresh"));
    const r = cli(["record", join(work, "fresh.yaml"), "--max-budget-usd", "5", "--dry-run"], tmpRoot());
    expect(r.all).toMatch(/no priced run history/);
    expect(r.all).toMatch(/UNCAPPED/);
    expect(r.code).toBe(0);
  });
});

describe.skipIf(!can)("record --max-budget-usd — batch semantics are CUMULATIVE", () => {
  it("refuses on the SUM across the batch even when no single scenario exceeds the cap", () => {
    const root = tmpRoot();
    const work = tmpWork();
    // Neither is over $0.30 alone; together they are $0.36. A per-scenario cap would let this through —
    // which is exactly the hole the flag was requested to close (a 16-run re-record batch).
    for (const [name, cost] of [
      ["a", 0.18],
      ["b", 0.18],
    ] as const) {
      seedRun(root, name, "local_1", cost);
      writeFileSync(join(work, `${name}.yaml`), scenarioYaml(name));
    }
    cli(["stats", "--reindex"], root);
    const r = cli(["record", work, "--max-budget-usd", "0.3", "--dry-run"], root);
    expect(r.all).toMatch(/refused before spending/);
    expect(r.all).toMatch(/batch of 2 scenario\(s\)/);
    expect(r.code).not.toBe(0);
  });

  it("names the unpriced scenarios and calls the estimate a LOWER BOUND (never silently treats them as free)", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "priced", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "priced.yaml"), scenarioYaml("priced"));
    writeFileSync(join(work, "unpriced.yaml"), scenarioYaml("unpriced"));
    const r = cli(["record", work, "--max-budget-usd", "5", "--dry-run"], root);
    expect(r.all).toMatch(/1\/2 scenario\(s\) have no priced run history/);
    expect(r.all).toMatch(/unpriced/);
    expect(r.all).toMatch(/LOWER BOUND/);
  });
});

describe.skipIf(!can)("record --max-budget-usd — the gate is part of --dry-run, not skipped by it", () => {
  it("--dry-run refuses on budget rather than reporting clean (a preview that is then refused is a false preview)", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    const refused = cli(["record", join(work, "pricey.yaml"), "--max-budget-usd", "0.1", "--dry-run"], root);
    const allowed = cli(["record", join(work, "pricey.yaml"), "--max-budget-usd", "5", "--dry-run"], root);
    expect(refused.all).toMatch(/refused before spending/);
    expect(refused.code).not.toBe(0);
    // Same command, same scenario, only the cap differs — so the refusal is the gate deciding, not
    // --dry-run failing for some unrelated reason.
    expect(allowed.all).not.toMatch(/refused before spending/);
    expect(allowed.code).toBe(0);
  });

  it("on the REAL path the auth guard takes precedence over the budget gate when credentials are absent", () => {
    // Pins the ordering deterministically on any runner. With no token you cannot record at all, so the
    // credential error is the more fundamental thing to report — the budget gate sits after it. Asserting
    // the budget message here instead would make the test pass only where a token happens to exist.
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    const r = spawnSync("node", [CLI, "record", join(work, "pricey.yaml"), "--max-budget-usd", "0.1"], {
      encoding: "utf8",
      // Scrub every credential source the guard consults, so this is deterministic even where a repo
      // .env or an exported token would otherwise satisfy it.
      env: {
        ...process.env,
        COWORK_HARNESS_RUNS_DIR: root,
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
      cwd: work, // away from the repo root, so a repo-level .env is not in scope
    });
    expect(r.stdout + r.stderr).toMatch(/no model credentials/);
  });
});

describe.skipIf(!can)("record --max-budget-usd — concurrency honesty", () => {
  it("warns in the PREVIEW that the running-total stop is disabled above --concurrency 1", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "a", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "a.yaml"), scenarioYaml("a"));
    const r = cli(["record", work, "--max-budget-usd", "5", "--concurrency", "2", "--dry-run"], root);
    expect(r.all).toMatch(/running-total stop is DISABLED/);
    expect(r.all).toMatch(/--concurrency 1 for a running total/);
  });

  it("does NOT emit the caveat at --concurrency 1, where the running total does apply", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "a", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "a.yaml"), scenarioYaml("a"));
    const r = cli(["record", work, "--max-budget-usd", "5", "--concurrency", "1", "--dry-run"], root);
    expect(r.all).not.toMatch(/running-total stop is DISABLED/);
  });
});

// The running-total abort is unit-tested directly: driving it through the CLI would require real paid
// recordings, which is precisely what the flag exists to avoid.
describe("batchBudgetTracker — the running total", () => {
  it("stops once the cap is reached, but only when enforcement is on (--concurrency 1)", () => {
    const on = batchBudgetTracker(0.1, true);
    on.add(0.04);
    expect(on.stopped()).toBe(false);
    on.add(0.07); // 0.11 >= 0.10
    expect(on.stopped()).toBe(true);

    const off = batchBudgetTracker(0.1, false);
    off.add(0.04);
    off.add(0.07);
    expect(off.stopped()).toBe(false); // above concurrency 1 the total is not enforceable
  });

  it("never stops when no cap was given", () => {
    const none = batchBudgetTracker(undefined, true);
    none.add(999);
    expect(none.stopped()).toBe(false);
  });

  it("DISABLES the running total (loudly, once) when a run reports no cost telemetry", () => {
    const warnings: string[] = [];
    const t = batchBudgetTracker(0.1, true, (s) => warnings.push(s));
    // The priced runs alone total $0.18, well OVER the $0.10 cap — so if a missing-telemetry run were
    // silently treated as $0 and counting simply continued, stopped() would flip true. It must not:
    // once a run's cost is unknown the running total is no longer a fact about this batch, and a cap
    // enforced on an incomplete sum is a false guarantee. (These amounts are load-bearing — with both
    // adds under the cap the assertion passes either way and the test proves nothing.)
    t.add(0.09);
    t.add(undefined); // telemetry missing → the running total can no longer be trusted
    t.add(0.09);
    expect(t.stopped()).toBe(false);
    expect(warnings).toHaveLength(1); // once per batch, not once per unpriced run
    expect(warnings[0]).toMatch(/unenforceable/);
  });

  it("summary fires only when the cap actually cut the batch short", () => {
    const t = batchBudgetTracker(0.1, true);
    t.add(0.2);
    expect(t.summary(3, 10)).toMatch(/stopped the record batch early \(3\/10 recorded/);
    expect(t.summary(10, 10)).toBeUndefined(); // nothing was skipped
    const clean = batchBudgetTracker(0.1, true);
    clean.add(0.01);
    expect(clean.summary(3, 10)).toBeUndefined(); // cap never reached
  });
});

// The budget refusal's EXIT CODE on `record` (4.0.0): `1`, like every other pre-spend refusal of a
// scenario that loaded, so `2` always means "did not load". `skill` and `run` keep `2`. A placeholder
// credential lets the REAL path reach the gate (the auth guard sits above it); nothing spawns, since the
// gate refuses first and the unit lane's spawn guard would refuse anything that got past it.
describe.skipIf(!can)("record --max-budget-usd — a refusal exits 1, not 2", () => {
  const PLACEHOLDER = { ANTHROPIC_API_KEY: "placeholder-not-used-no-spawn-in-this-suite" };
  function cliWith(args: string[], root: string, cwd: string) {
    const r = spawnSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root, ...PLACEHOLDER },
      cwd,
    });
    return { code: r.status, all: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  it("single scenario, preview and real path: exit 1", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    const f = join(work, "pricey.yaml");
    for (const extra of [["--dry-run"], ["--out", join(work, "p.cassette.json")]]) {
      const r = cliWith(["record", f, "--max-budget-usd", "0.0001", ...extra], root, work);
      expect(r.all, extra.join(" ")).toMatch(/refused before spending/);
      expect(r.code, extra.join(" ")).toBe(1);
    }
  });

  it("json mode: the refusal envelope is ok:false and the exit is 1", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    const r = cliWith(
      ["record", join(work, "pricey.yaml"), "--max-budget-usd", "0.0001", "--dry-run", "--output-format", "json"],
      root,
      work,
    );
    expect(r.code).toBe(1);
    const env = JSON.parse(r.all.split("\n").find((l) => l.startsWith("{"))!);
    expect(env.ok).toBe(false);
    expect(env.error.message).toMatch(/refused before spending/);
  });

  it("a batch with broken files beside a loadable scenario over the cap: exit 1, and the budget gate is what refused", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    writeFileSync(join(work, "broken.yaml"), scenarioYaml("broken").replace("assert:", "assert:\n  - not_a_real_key: true"));
    for (const extra of [["--dry-run"], []]) {
      const r = cliWith(["record", work, "--max-budget-usd", "0.0001", ...extra], root, work);
      expect(r.all, extra.join(" ") || "real").toMatch(/refused before spending/);
      expect(r.code, extra.join(" ") || "real").toBe(1);
    }
  });

  it("`skill --max-budget-usd` is unchanged: its refusal still exits 2", () => {
    const root = tmpRoot();
    const work = tmpWork();
    const skillDir = join(work, "pricey-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: pricey-skill\ndescription: test skill\n---\nDo the thing.\n");
    // `skill` names its run `skill-<folder basename>`, so that is the history the gate reads.
    seedRun(root, "skill-pricey-skill", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    const r = cliWith(["skill", skillDir, "do the thing", "--max-budget-usd", "0.0001"], root, work);
    expect(r.all).toMatch(/refused before spending/);
    expect(r.code).toBe(2);
  });

  it("`run --max-budget-usd` is unchanged: its refusal still exits 2", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    const r = cliWith(["run", join(work, "pricey.yaml"), "--max-budget-usd", "0.0001"], root, work);
    expect(r.all).toMatch(/refused before spending/);
    expect(r.code).toBe(2);
  });

  it("`record --rerecord-stale` over the cap: exit 1 (it shares the batch gate)", () => {
    const root = tmpRoot();
    const work = tmpWork();
    // A committed cassette made stale by baseline drift: a free way to put one in the re-record set.
    const cassette = JSON.parse(readFileSync(resolve("examples/replays/example-multiselect-gate.cassette.json"), "utf8"));
    cassette.fingerprint.baseline = "desktop-0.0.1";
    writeFileSync(join(work, "s.cassette.json"), JSON.stringify(cassette));
    seedRun(root, cassette.scenario.name, "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    const r = cliWith(["record", work, "--rerecord-stale", "--max-budget-usd", "0.0001"], root, work);
    expect(r.all, "the budget gate must be what refused").toMatch(/refused before spending/);
    expect(r.code).toBe(1);
  });
});

// `record <dir/> --dry-run --output-format json` writes EXACTLY ONE JSON document to stdout, on every
// outcome. The dir arm used to write its payload envelope (usually `ok: true`) and THEN run the batch
// budget gate, whose refusal wrote a second, error envelope — a consumer reading the first line saw a
// false green. Each case parses stdout as a whole: a second document, or any non-JSON line, fails it.
describe.skipIf(!can)("record <dir/> --dry-run --output-format json — exactly one document on stdout", () => {
  function oneDoc(stdout: string, label: string) {
    const lines = stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length, `${label}: stdout must carry exactly one JSON document, got:\n${stdout}`).toBe(1);
    return JSON.parse(lines[0]);
  }

  /** A work dir holding the requested kinds of file, and a runs dir whose history prices `pricey` at $0.50
   *  and `cheap` at $0.01. `dup` is two loadable files sharing a name, which the dir arm refuses. */
  function corpus(kinds: ("pricey" | "cheap" | "broken" | "dup")[]) {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    seedRun(root, "cheap", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    for (const k of kinds) {
      if (k === "broken")
        writeFileSync(join(work, "broken.yaml"), scenarioYaml("broken").replace("assert:", "assert:\n  - not_a_real_key: true"));
      else if (k === "dup") {
        writeFileSync(join(work, "dup1.yaml"), scenarioYaml("dup"));
        writeFileSync(join(work, "dup2.yaml"), scenarioYaml("dup"));
      } else writeFileSync(join(work, `${k}.yaml`), scenarioYaml(k));
    }
    return { root, work };
  }

  function dry(work: string, root: string, cap: string, json = true) {
    const r = spawnSync("node", [CLI, "record", work, "--dry-run", "--max-budget-usd", cap, ...(json ? ["--output-format", "json"] : [])], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root },
      cwd: work,
    });
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  it("ok (under the cap): one ok:true payload, exit 0", () => {
    const { root, work } = corpus(["cheap"]);
    const r = dry(work, root, "5");
    const d = oneDoc(r.out, "ok");
    expect(d.ok).toBe(true);
    expect(d.dryRun).toBe(true);
    expect(r.code).toBe(0);
  });

  it("broken (under the cap): one ok:false payload carrying broken[], exit 1", () => {
    const { root, work } = corpus(["cheap", "broken"]);
    const r = dry(work, root, "5");
    const d = oneDoc(r.out, "broken");
    expect(d.ok).toBe(false);
    expect(d.broken).toHaveLength(1);
    expect(r.code).toBe(1);
  });

  it("refused (under the cap): one ok:false payload carrying refusals[], exit 1", () => {
    const { root, work } = corpus(["cheap", "dup"]);
    const r = dry(work, root, "5");
    const d = oneDoc(r.out, "refused");
    expect(d.ok).toBe(false);
    expect(d.refusals.length).toBeGreaterThan(0);
    expect(r.code).toBe(1);
  });

  it("over budget: ONLY the refusal envelope — no ok:true payload before it — exit 1", () => {
    const { root, work } = corpus(["pricey"]);
    const r = dry(work, root, "0.0001");
    const d = oneDoc(r.out, "over budget");
    expect(d.ok).toBe(false);
    expect(d.error.message).toMatch(/refused before spending/);
    expect(r.code).toBe(1);
  });

  it("mixed (broken + refused + over budget): one refusal envelope, and the broken/refused lines still reach stderr", () => {
    const { root, work } = corpus(["pricey", "broken", "dup"]);
    const r = dry(work, root, "0.0001");
    const d = oneDoc(r.out, "mixed");
    expect(d.ok).toBe(false);
    expect(d.error.message).toMatch(/refused before spending/);
    expect(r.code).toBe(1);
    // The refusal envelope carries no broken[]/refusals[], so under JSON those findings go to stderr
    // BEFORE the gate — otherwise a budget refusal would silently hide them.
    expect(r.err).toMatch(/✗ broken: .*broken\.yaml/);
    expect(r.err).toMatch(/✗ refused: .*dup\d\.yaml/);
    // …and once only (the refusal message itself is on stdout, in the envelope).
    expect(r.err.split("✗ broken:").length - 1).toBe(1);
    expect(r.err.split("✗ refused:").length - 1).toBe(1);
  });

  it("all broken: one payload, exit 1 (the budget gate never runs)", () => {
    const { root, work } = corpus(["broken"]);
    const r = dry(work, root, "0.0001");
    const d = oneDoc(r.out, "all broken");
    expect(d.ok).toBe(false);
    expect(d.broken).toHaveLength(1);
    expect(r.out).not.toMatch(/refused before spending/);
    expect(r.code).toBe(1);
  });

  it("nothing discovered: one payload, exit 2", () => {
    const { root, work } = corpus([]);
    const r = dry(work, root, "0.0001");
    const d = oneDoc(r.out, "empty");
    expect(d.scenarios).toEqual([]);
    expect(r.code).toBe(2);
  });

  it("text mode is unchanged: stdout stays empty, and every finding precedes the budget refusal on stderr", () => {
    const { root, work } = corpus(["pricey", "broken", "dup"]);
    const r = dry(work, root, "0.0001", false);
    expect(r.out).toBe("");
    expect(r.code).toBe(1);
    const at = (s: string) => {
      const i = r.err.indexOf(s);
      expect(i, `stderr must contain ${JSON.stringify(s)}:\n${r.err}`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at("✗ broken:"),
      at("✗ refused:"),
      at("record --dry-run: 3 scenario(s) in"),
      at("estimated batch cost:"),
      at("refused before spending"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Text mode prints each finding ONCE — the JSON-only stderr copy must not leak into it.
    expect(r.err.split("✗ broken:").length - 1).toBe(1);
    expect(r.err.split("✗ refused:").length - 1).toBe(1); // one duplicate-target pair → one refusal
  });
});

// The other refusal-capable JSON arms already emit one document; pinned so the class stays closed.
describe.skipIf(!can)("budget refusal under --output-format json — exactly one document on stdout, every arm", () => {
  const cases: { label: string; argv: (work: string) => string[]; code: number }[] = [
    { label: "run <file>", argv: (w) => ["run", join(w, "pricey.yaml")], code: 2 },
    { label: "record <file> --dry-run", argv: (w) => ["record", join(w, "pricey.yaml"), "--dry-run"], code: 1 },
    { label: "record <file> (real path)", argv: (w) => ["record", join(w, "pricey.yaml"), "--out", join(w, "p.cassette.json")], code: 1 },
    { label: "skill <dir>", argv: (w) => ["skill", join(w, "pricey-skill"), "do the thing"], code: 2 },
  ];
  for (const c of cases) {
    it(c.label, () => {
      const root = tmpRoot();
      const work = tmpWork();
      seedRun(root, "pricey", "local_1", 0.5);
      seedRun(root, "skill-pricey-skill", "local_1", 0.5);
      cli(["stats", "--reindex"], root);
      writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
      mkdirSync(join(work, "pricey-skill"));
      writeFileSync(join(work, "pricey-skill", "SKILL.md"), "---\nname: pricey-skill\ndescription: test skill\n---\nDo the thing.\n");
      const r = spawnSync("node", [CLI, ...c.argv(work), "--max-budget-usd", "0.0001", "--output-format", "json"], {
        encoding: "utf8",
        // A placeholder credential lets the real paths reach the gate (the auth guard sits above it); the
        // gate refuses before any spawn, and the unit lane's spawn guard backstops anything past it.
        env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root, ANTHROPIC_API_KEY: "placeholder-not-used-no-spawn-in-this-suite" },
        cwd: work,
      });
      const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim() !== "");
      expect(lines.length, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(1);
      const d = JSON.parse(lines[0]);
      expect(d.ok).toBe(false);
      expect(d.error.message).toMatch(/refused before spending/);
      expect(r.status).toBe(c.code);
    });
  }
});

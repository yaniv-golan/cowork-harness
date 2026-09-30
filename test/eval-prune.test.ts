// What `prune` does to an eval's runs. An eval's runs are ordinary ephemeral run dirs (`local_*`, the shape
// every unpinned run has), so `prune`'s --keep-last applies to them: at the defaults an eval leaves 10 runs
// per scenario and a bare `prune` keeps 5. The eval report never reads the run dirs (it is rebuilt from the
// eval dir), but its evidence links then point at deleted dirs — so prune says which evals it trimmed.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");

function runsWithEval(): string {
  const root = mkdtempSync(join(tmpdir(), "prune-eval-"));
  const scen = join(root, "q");
  for (let i = 0; i < 10; i++) {
    const d = join(scen, `local_eval${String(i).padStart(8, "0")}`);
    mkdirSync(join(d, "turns", "1"), { recursive: true });
    writeFileSync(join(d, "status.json"), JSON.stringify({ runLabel: `eval:20260930-000000-abc123:${i % 2 ? "after" : "before"}` }));
    writeFileSync(join(d, "turns", "1", "result.json"), "{}");
    const t = new Date(Date.UTC(2026, 8, 30, 0, i));
    utimesSync(d, t, t);
  }
  const plain = join(scen, "local_plainrun00");
  mkdirSync(join(plain, "turns", "1"), { recursive: true });
  const old = new Date(Date.UTC(2026, 0, 1));
  utimesSync(plain, old, old);
  return root;
}

describe.skipIf(!existsSync(CLI))("prune and an eval's runs", () => {
  it("a bare prune trims an eval's runs to --keep-last, and names the eval whose evidence links now dangle", () => {
    const root = runsWithEval();
    const r = spawnSync("node", [CLI, "prune", root], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(root, "q"))).toHaveLength(5);
    expect(r.stderr).toMatch(/5 of the pruned run dir\(s\) belong to eval 20260930-000000-abc123/);
    expect(r.stderr).toMatch(/eval report/);
  });

  it("--dry-run warns the same way and deletes nothing", () => {
    const root = runsWithEval();
    const r = spawnSync("node", [CLI, "prune", root, "--dry-run"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(root, "q"))).toHaveLength(11);
    expect(r.stderr).toMatch(
      /5 of the run dir\(s\) prune would remove belong to eval 20260930-000000-abc123 — its report's evidence links would point at deleted runs/,
    );
  });

  it("no warning when nothing pruned belongs to an eval", () => {
    const root = runsWithEval();
    const r = spawnSync("node", [CLI, "prune", root, "--keep-last", "20"], { encoding: "utf8" });
    expect(r.stderr).not.toMatch(/belong to eval/);
  });
});

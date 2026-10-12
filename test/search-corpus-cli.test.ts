import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderWebSearchResult } from "../src/search-corpus/render.js";

const CLI = resolve("dist/cli.js");
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

function keptRun(): string {
  const d = join(mkdtempSync(join(tmpdir(), "cwh-sp-cli-")), "scn", "local_1");
  mkdirSync(join(d, "turns", "1"), { recursive: true });
  const text = renderWebSearchResult({
    query: "widget market",
    entries: [
      { kind: "links", links: [{ title: "W", url: "https://w.example" }] },
      { kind: "text", text: "Invented prose." },
    ],
    reminder: "REMINDER: cite.",
  });
  writeFileSync(
    join(d, "events.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t", name: "WebSearch", input: { query: "widget market" } }] },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: text }] } }),
    ].join("\n"),
  );
  writeFileSync(join(d, "turns", "1", "result.json"), JSON.stringify({ scenario: "s", skillsInvoked: ["p:widgets"] }));
  return d;
}

describe.skipIf(!existsSync(CLI))("search-pool CLI end to end", () => {
  it("builds with --output-format json, exports and imports", () => {
    const pool = join(mkdtempSync(join(tmpdir(), "cwh-sp-out-")), "pool");
    const b = cli(["search-pool", "build", pool, "--from", keptRun(), "--output-format", "json"]);
    expect(b.code, b.err).toBe(0);
    const env = JSON.parse(b.out);
    expect(env.ok).toBe(true);
    expect(env.manifest).toMatchObject({ skills: ["widgets"], counts: { records: 1 } });
    const file = join(mkdtempSync(join(tmpdir(), "cwh-sp-x-")), "p.json");
    expect(cli(["search-pool", "export", pool, "--out", file]).code).toBe(0);
    expect(cli(["search-pool", "export", pool, "--out", file]).code).toBe(2); // refuses an existing file
    expect(cli(["search-pool", "import", file, join(mkdtempSync(join(tmpdir(), "cwh-sp-in-")), "p")]).code).toBe(0);
  });

  it("refuses a pool or export path inside a git work tree unless --allow-in-repo", () => {
    const inRepo = resolve("test", "fixtures-never-written-pool");
    const r = cli(["search-pool", "build", inRepo, "--from", keptRun()]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/inside a git work tree/);
    expect(existsSync(inRepo)).toBe(false);
  });
});

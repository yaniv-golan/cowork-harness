// Every env var the harness reads is named COWORK_HARNESS_*, except a short, fixed list: the agent and proxy binary and
// image overrides, and COWORK_ARTIFACTS_ROOT, which is Desktop's own key. A bare COWORK_* name anywhere else in src/ is
// either one this build refuses (removed or renamed in 5.0.0) or a new knob in the wrong namespace.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeCoworkEnvVars } from "../scripts/lib/env-scrape.js";
import { REFUSED_ENV_NAMES } from "../src/removed-env.js";

// Adding a name here is a public-surface decision (SPEC §12), not a way to make this test pass: name a new knob
// COWORK_HARNESS_<NAME> instead.
const KEPT = new Set([
  "COWORK_AGENT_BINARY",
  "COWORK_AGENT_IMAGE",
  "COWORK_HOST_AGENT_BINARY",
  "COWORK_PROXY_IMAGE",
  "COWORK_ARTIFACTS_ROOT",
]);

describe("bare COWORK_* env names", () => {
  const names = scrapeCoworkEnvVars();

  it("every scraped name outside COWORK_HARNESS_ is kept on purpose or refused at startup", () => {
    const refused = new Set(REFUSED_ENV_NAMES);
    const stray = [...names].filter((n) => !n.startsWith("COWORK_HARNESS_") && !KEPT.has(n) && !refused.has(n)).sort();
    expect(stray, "name a new knob COWORK_HARNESS_<NAME>").toEqual([]);
  });

  it("each kept name is still read (a stale entry would let a removed knob's name come back unnoticed)", () => {
    expect([...KEPT].filter((n) => !names.has(n))).toEqual([]);
  });

  it("a refused name appears in src/ only in the refusal table, so no code still reads it", () => {
    // The check above accepts a refused name wherever it is scraped, so a read site the rename missed would pass it.
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const refused = new Set(REFUSED_ENV_NAMES);
    const hits: string[] = [];
    for (const f of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!f.endsWith(".ts") || f === "removed-env.ts") continue;
      const text = readFileSync(join(src, f), "utf8");
      for (const n of new Set(text.match(/\bCOWORK_[A-Z0-9_]+/g) ?? [])) if (refused.has(n)) hits.push(`${f}: ${n}`);
    }
    expect(hits).toEqual([]);
  });
});

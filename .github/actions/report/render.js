#!/usr/bin/env node
// PR job-summary renderer for the cowork-harness composite action (../action.yml).
// Deliberately reads only `envelope.{command,ok,results[],error}` — any field a later wave adds
// (repeat-N's `rollups`, the matrix runner's `matrix`) is ignored, never destructured, so this
// script never breaks when the envelope grows. Kept dependency-free (plain Node, no npm install)
// so the action doesn't need a package install step just to report.
import { readFileSync, appendFileSync } from "node:fs";

/** @param {Record<string, unknown>} envelope */
export function renderSummary(envelope) {
  const results = /** @type {any[]} */ (envelope.results ?? []);
  const rows = results.map((r) => {
    const v = r.verdict ?? {};
    const status = v.pass ? "✅ pass" : "❌ fail";
    const signals = (v.signals ?? []).map((s) => s.code).join(", ") || "—";
    const cost = r.cost?.usd !== undefined ? `$${r.cost.usd}` : "—";
    const turns = r.usage?.turns !== undefined ? String(r.usage.turns) : "—";
    return `| ${r.scenario ?? "?"} | ${status} | ${signals} | ${cost} | ${turns} |`;
  });

  const lines = [
    `## cowork-harness — \`${envelope.command ?? "?"}\``,
    "",
    `Overall: **${envelope.ok ? "✅ pass" : "❌ fail"}**`,
    "",
    "| scenario | verdict | signals | cost | turns |",
    "|---|---|---|---|---|",
    ...(rows.length ? rows : ["| _(no results)_ | | | | |"]),
  ];

  const staleness = results.flatMap((r) => r.staleness ?? []);
  if (staleness.length) {
    lines.push("", `**Staleness findings (${staleness.length}):**`, ...staleness.map((s) => `- \`${s.class}\`: ${s.message}`));
  }

  const skipped = results.reduce(
    (acc, r) => ({
      full: acc.full + (r.skippedAssertions?.full ?? 0),
      partial: acc.partial + (r.skippedAssertions?.partial ?? 0),
    }),
    { full: 0, partial: 0 },
  );
  if (skipped.full || skipped.partial) {
    lines.push(
      "",
      `⚠️ Replay skipped ${skipped.full} live-only assertion(s) entirely and dropped the filesystem/egress half ` +
        `of ${skipped.partial} more — not evaluated on this token-free run.`,
    );
  }

  if (envelope.error) {
    const e = /** @type {any} */ (envelope.error);
    lines.push("", `**Error:** ${e.category} — ${e.message}`);
  }

  return lines.join("\n") + "\n";
}

function main() {
  const [, , file, ...flags] = process.argv;
  if (!file) {
    process.stderr.write("usage: render.js <envelope.json> [--summary]\n");
    process.exit(2);
  }
  const envelope = JSON.parse(readFileSync(file, "utf8"));
  const md = renderSummary(envelope);
  process.stdout.write(md);
  if (flags.includes("--summary") && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

// Run only when invoked directly (`node render.js ...`), not when imported by the test suite.
if (import.meta.url === `file://${process.argv[1]}`) main();

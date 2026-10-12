// `search-pool` command family: build, export and import a pool of recorded web searches.

import { parseArgs } from "../cli-args.js";
import { writeAllSync } from "../io.js";
import { applyParsedCommandGlobals, withCommandGlobals } from "../run/command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope, pkgVersion } from "../run/envelope.js";
import { collectSecrets, scrub } from "../secrets.js";
import {
  assemblePool,
  discoverRunDirs,
  exportPool,
  importPool,
  insideGitWorkTree,
  PoolBuildError,
  resolvePoolDir,
  writePool,
} from "./pool.js";
import { DEFAULT_RETRIEVAL } from "./retrieval.js";

const CMD = "search-pool";

export const SEARCH_POOL_USAGE =
  "usage: search-pool build <pool> --from <run-dir|runs-dir> [--from …]... [--skill <name>] [--mixed] [--exclude <record-id>]...\n" +
  "         [--min-score <n>] [--allow-in-repo] [--output-format text|json]\n" +
  "       search-pool export <pool> --out <file> [--allow-in-repo]\n" +
  "       search-pool import <file> <pool>\n" +
  "       Builds a pool of the WebSearch results recorded in kept runs: one record per search (its query, links and the\n" +
  "       search's prose summary) with the source run's skill and versions. Nothing serves a pool yet.\n" +
  "       <pool> is a name under ~/.cowork-harness/search-pools/, or a path. Dirs are 0700, files 0600; a path inside a\n" +
  "       git work tree is refused unless --allow-in-repo (a pool holds web text and summaries that can quote an upload).\n" +
  "       --from (repeatable): a kept run dir, or a dir whose run dirs sit up to three levels below it (a run's work dir\n" +
  "       is skipped).\n" +
  "       --mixed: allow searches from more than one skill, or from runs naming none (a measured variant, never a baseline).\n" +
  "       --skill: declare the pool's skill for runs that name no single skill under test (a run naming another skill is\n" +
  "       refused). A run's skill is its graded skill, else its one scoped skill, else its one invoked skill.\n" +
  "       --exclude: drop one record by id (repeatable); the build summary lists records that name an upload or repeat\n" +
  "       its text. A record containing a known secret (the credentials, COWORK_HARNESS_SCRUB_KEYS / _VALUES, and their\n" +
  "       encoded forms) refuses the build, naming it.\n" +
  "       --min-score: the relevance floor a query must clear to be served (default 0.4; part of the pool hash).\n" +
  "       export writes one JSON file (not a tarball) holding the pool and a notice, refusing an existing file and, like\n" +
  "       build and import, a path inside a git work tree; import re-verifies both hashes and the secret scan.";

function textSummary(s: ReturnType<typeof assemblePool>, dir: string): string[] {
  const { manifest: m, summary: u } = s;
  const lines = [
    `wrote ${dir}: ${m.counts.records} record(s), ${m.counts.urls} distinct URL(s), from ${u.runsWithSearches} of ${u.runs} run(s)`,
    `  pool ${m.poolId}@${m.sha256.slice(0, 8)}  skill${m.skills.length > 1 ? "s" : ""}: ${m.skills.join(", ")}${m.mixed ? " (mixed)" : ""}`,
    `  per skill: ${Object.entries(u.perSkill)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `  skipped: ${u.harvest.errorResults} error result(s), ${u.harvest.unparsed} unreadable, ${u.harvest.queryMismatch} query mismatch(es), ${u.harvest.searchErrors} search error(s); ${u.harvest.duplicates + u.crossRunDuplicates} duplicate(s) merged; ${u.excluded} excluded`,
  ];
  const unknown = m.sources.filter((x) => x.variantHash === null).length;
  if (unknown)
    lines.push(`  note: ${unknown} source run(s) record no skill snapshot signature, so this pool's provenance is unknown to eval`);
  for (const o of u.uploadOverlaps)
    lines.push(
      `  review: record ${o.id} ${o.why === "upload-filename" ? "names an upload file" : "repeats an upload's text"} (drop it with --exclude ${o.id})`,
    );
  return lines;
}

export async function cmdSearchPool(args: string[]): Promise<never> {
  const json = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(
      args,
      withCommandGlobals({
        booleans: ["--mixed", "--allow-in-repo"],
        values: ["--min-score", "--out", "--skill", "--output-format"],
        repeated: ["--from", "--exclude"],
        enums: { "--output-format": ["text", "json"] },
        noDashValue: ["--out"],
      }),
    );
  } catch (e) {
    return fail(CMD, "usage", scrub((e as Error).message, collectSecrets()), undefined, json);
  }
  applyParsedCommandGlobals(CMD, p, json);
  const secrets = collectSecrets();
  const [sub, a1, a2, ...extra] = p.positionals;
  const usage = (why: string) => fail(CMD, "usage", `${why}\n${SEARCH_POOL_USAGE}`, undefined, json);
  try {
    if (sub === "build") {
      if (!a1 || a2 || extra.length) return usage("search-pool build takes one <pool>");
      const from = p.repeated["--from"] ?? [];
      if (from.length === 0) return usage("search-pool build needs --from <run-dir|runs-dir>");
      const minRaw = p.options["--min-score"];
      const minScore = minRaw === undefined ? DEFAULT_RETRIEVAL.minScore : Number(minRaw);
      if (!Number.isFinite(minScore) || minScore <= 0 || minScore >= 1)
        return usage(`--min-score must be a number between 0 and 1 (got ${minRaw})`);
      const dir = resolvePoolDir(a1);
      if (!p.flags["--allow-in-repo"] && insideGitWorkTree(dir))
        return fail(
          CMD,
          "usage",
          `${dir} is inside a git work tree; a pool holds web text and model summaries that can quote an upload, so it is kept out of repositories. Pass --allow-in-repo to write it there anyway.`,
          undefined,
          json,
        );
      const runDirs = discoverRunDirs(from);
      if (runDirs.length === 0) return usage(`no run dirs under ${from.join(", ")}`);
      const built = assemblePool({
        poolId: a1.replace(/.*[\\/]/, ""),
        runDirs,
        mixed: p.flags["--mixed"] === true,
        exclude: new Set(p.repeated["--exclude"] ?? []),
        ...(p.options["--skill"] !== undefined ? { skill: p.options["--skill"] } : {}),
        retrieval: { ...DEFAULT_RETRIEVAL, minScore },
        harnessVersion: pkgVersion(),
        now: new Date(),
        secrets,
      });
      writePool(dir, built.manifest, built.records);
      if (json)
        writeAllSync(1, scrub(jsonPayloadEnvelope(CMD, true, { dir, manifest: built.manifest, summary: built.summary }), secrets) + "\n");
      else for (const line of textSummary(built, dir)) writeAllSync(2, scrub(line, secrets) + "\n");
      return process.exit(0);
    }
    if (sub === "export") {
      const out = p.options["--out"];
      if (!a1 || a2 || extra.length || !out) return usage("search-pool export takes one <pool> and --out <file>");
      if (!p.flags["--allow-in-repo"] && insideGitWorkTree(out))
        return fail(CMD, "usage", `${out} is inside a git work tree; pass --allow-in-repo to export a pool there anyway.`, undefined, json);
      exportPool(resolvePoolDir(a1), out);
      if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(CMD, true, { out }), secrets) + "\n");
      else writeAllSync(2, scrub(`wrote ${out}`, secrets) + "\n");
      return process.exit(0);
    }
    if (sub === "import") {
      if (!a1 || !a2 || extra.length) return usage("search-pool import takes <file> <pool>");
      const dir = resolvePoolDir(a2);
      if (!p.flags["--allow-in-repo"] && insideGitWorkTree(dir))
        return fail(CMD, "usage", `${dir} is inside a git work tree; pass --allow-in-repo to write a pool there anyway.`, undefined, json);
      const m = importPool(a1, dir, secrets);
      if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(CMD, true, { dir, manifest: m }), secrets) + "\n");
      else writeAllSync(2, scrub(`wrote ${dir}: pool ${m.poolId}@${m.sha256.slice(0, 8)}, ${m.counts.records} record(s)`, secrets) + "\n");
      return process.exit(0);
    }
    return usage(sub ? `unknown search-pool subcommand: ${sub}` : "search-pool needs a subcommand");
  } catch (e) {
    // A pool or export that cannot be read (missing, not JSON) is a runtime refusal, like a failed check.
    const code = (e as NodeJS.ErrnoException).code;
    if (
      e instanceof PoolBuildError ||
      e instanceof SyntaxError ||
      code === "ENOENT" ||
      code === "EACCES" ||
      code === "EISDIR" ||
      code === "ENOTDIR" ||
      code === "EEXIST"
    )
      return fail(CMD, "runtime", scrub((e as Error).message, secrets), undefined, json, 2);
    throw e;
  }
}

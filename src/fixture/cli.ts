// `fixture` command family. Today: `fixture export`.

import { parseArgs } from "../cli-args.js";
import { writeAllSync } from "../io.js";
import { applyParsedCommandGlobals, withCommandGlobals } from "../run/command-globals.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "../run/envelope.js";
import { collectSecrets, scrub } from "../secrets.js";
import { exportFixture, type ExportOutcome } from "./export.js";
import { FIXTURE_BOOLEAN_FLAGS, FIXTURE_USAGE, FIXTURE_VALUE_FLAGS } from "./usage.js";

const CMD = "fixture";

function textReport(o: ExportOutcome): string[] {
  const lines = [o.message];
  for (const s of o.skipped) lines.push(`  skipped ${s.file} (${s.why})`);
  for (const n of o.notes)
    lines.push(
      n.kind === "binary" ? `  note: ${n.file} is binary — copied unscanned` : `  note: ${n.file}: ${n.cls} ${JSON.stringify(n.sample)}`,
    );
  return lines;
}

export async function cmdFixture(args: string[]): Promise<never> {
  const json = isJsonOutput(args);
  let p;
  try {
    p = parseArgs(
      args,
      withCommandGlobals({
        booleans: [...FIXTURE_BOOLEAN_FLAGS],
        values: [...FIXTURE_VALUE_FLAGS],
        enums: { "--output-format": ["text", "json"] },
        noDashValue: ["--out"],
      }),
    );
  } catch (e) {
    return fail(CMD, "usage", scrub((e as Error).message, collectSecrets()), undefined, json);
  }
  applyParsedCommandGlobals(CMD, p, json);
  const secrets = collectSecrets();
  const [sub, runDir, ...extra] = p.positionals;
  const out = p.options["--out"];
  if (sub !== "export" || !runDir || extra.length || !out) return fail(CMD, "usage", FIXTURE_USAGE, undefined, json);
  const o = exportFixture({ runDir, out, allowHostPaths: p.flags["--allow-host-paths"] === true, secrets });
  const { exitCode, message, ...payload } = o;
  // A refusal is the shared error envelope (category runtime, exit 2) carrying the same payload, so a consumer reads
  // `refused[]`/`skipped[]`/`notes[]` from one place whichever way it went.
  if (exitCode !== 0) {
    if (!json) for (const line of textReport(o).slice(1)) writeAllSync(2, scrub(line, secrets) + "\n");
    return fail(CMD, "runtime", scrub(message, secrets), undefined, json, 2, undefined, { payload: payload as Record<string, unknown> });
  }
  if (json) writeAllSync(1, scrub(jsonPayloadEnvelope(CMD, true, { message, ...payload }), secrets) + "\n");
  else for (const line of textReport(o)) writeAllSync(2, scrub(line, secrets) + "\n");
  return process.exit(0);
}

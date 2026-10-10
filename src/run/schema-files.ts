// `artifact_json.schema: {file: <path>}` — read the schema file at load and inline it into the scenario, so every
// later step (the run, a recorded cassette's frozen scenario, replay) carries the schema itself and never reads the
// file again. A schema-file edit therefore behaves like an inline edit: `replay --assert-from` and a re-record pick it
// up; a plain replay grades with the schema frozen at record.
//
// A step beside the loader rather than inside it: `loadScenarioPure` reads the scenario file and nothing else. The
// loader's two callers (`parseScenarioFile`, and `lint`'s loader pass) both run this step after it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { UsageError } from "../errors.js";
import { schemaProblem } from "../json-schema.js";
import type { Scenario } from "../types.js";
import { gitEnvWithoutAmbientRepo } from "./skill-files.js";

const MAX_SCHEMA_FILE_BYTES = 1024 * 1024;

/** The tree a schema file must stay inside: the scenario's git work tree, or its directory outside one. The same rule
 *  `workspace_fixture` follows for a cassette: a ref that climbs out would not resolve on another checkout. */
function scenarioTree(scenarioPath: string): { root: string; inGit: boolean } {
  const dir = dirname(resolve(scenarioPath));
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", env: gitEnvWithoutAmbientRepo() });
  const inGit = top.status === 0 && top.stdout.trim() !== "";
  return { root: realpathSync.native(inGit ? top.stdout.trim() : dir), inGit };
}

/** Inline every `artifact_json.schema: {file}` of `scenario` (in place), checking each schema as an inline one is.
 *  Throws UsageError naming the assertion and the file. */
export function inlineSchemaFiles(scenario: Scenario, scenarioPath: string): Scenario {
  let tree: ReturnType<typeof scenarioTree> | undefined;
  scenario.assert.forEach((a, i) => {
    const schema = a.artifact_json?.schema as Record<string, unknown> | undefined;
    if (!schema || !("file" in schema) || Object.keys(schema).length !== 1 || typeof schema.file !== "string") return;
    const ref = schema.file;
    const where = `invalid scenario ${scenarioPath}: assert[${i}].artifact_json.schema {file: ${ref}}`;
    const abs = isAbsolute(ref) ? ref : resolve(dirname(resolve(scenarioPath)), ref);
    if (!existsSync(abs)) throw new UsageError(`${where}: no such file (${abs}); the path is relative to the scenario file`);
    tree ??= scenarioTree(scenarioPath);
    let real: string;
    try {
      real = realpathSync.native(abs);
    } catch (e) {
      throw new UsageError(`${where}: cannot be resolved (${(e as Error).message})`);
    }
    const rel = relative(tree.root, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new UsageError(
        `${where}: the file is outside ${tree.inGit ? "the scenario's repository" : "the scenario's directory"} (${tree.root}) — keep the schema next to the scenario, so the scenario resolves on any checkout`,
      );
    if (!statSync(real).isFile()) throw new UsageError(`${where}: not a regular file`);
    if (statSync(real).size > MAX_SCHEMA_FILE_BYTES) throw new UsageError(`${where}: larger than ${MAX_SCHEMA_FILE_BYTES} bytes`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(real, "utf8"));
    } catch (e) {
      // A read error (EACCES) and a parse error both name the assertion, as a usage error.
      throw new UsageError(`${where}: ${e instanceof SyntaxError ? "not valid JSON" : "cannot be read"} (${(e as Error).message})`);
    }
    const problem = schemaProblem(parsed);
    if (problem) throw new UsageError(`${where}: ${problem}`);
    (a.artifact_json as { schema: unknown }).schema = parsed;
  });
  return scenario;
}

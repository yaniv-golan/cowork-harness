import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Resolve the bundled `scenario.py` (the linter/scaffolder). It is the single readable source of the lint
 * rules — shipped both inside the plugin (the skill-authoring agent runs it via `python3` directly) and in
 * the npm package (so an `npm i -g cowork-harness` consumer can run `cowork-harness lint` without a skill
 * checkout). Looks in the source/packed layouts; throws a clear error if absent.
 */
export function resolveScenarioScript(): string {
  const root = fileURLToPath(new URL("../..", import.meta.url)); // dist/run/.. (or src/run/..) → package root
  const script = join(root, ".claude", "skills", "cowork-harness", "scripts", "scenario.py");
  if (existsSync(script)) return script;
  throw new Error(`bundled scenario.py not found (looked in: ${script}). Reinstall cowork-harness.`);
}

/** `cowork-harness lint <files…>` → `python3 scenario.py lint <files…>` (npm-consumer ergonomics; skill
 *  authors can still invoke python3 on the bundled script directly). Inherits stdio, exits with the child
 *  code. A missing python3 is exit 127 (the only thing the wrapper guards); PyYAML is bundled alongside
 *  scenario.py, so the linter no longer needs a separate install. */
export function cmdLint(args: string[]): never {
  const script = resolveScenarioScript();
  const py = process.env.PYTHON ?? "python3";
  const r = spawnSync(py, [script, "lint", ...args], { stdio: "inherit" });
  if (r.error) {
    const enoent = (r.error as NodeJS.ErrnoException).code === "ENOENT";
    process.stderr.write(
      (enoent ? `${py} not found — \`lint\` needs Python 3 (PyYAML is bundled). Set $PYTHON or install Python.` : String(r.error.message)) +
        "\n",
    );
    return process.exit(127);
  }
  return process.exit(r.status ?? 1);
}

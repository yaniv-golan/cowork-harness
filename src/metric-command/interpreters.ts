// The interpreters a command metric runs under, resolved once per process.
//
// Python: the absolute real binary `python3` names in the harness's own environment, asked from a fresh temp dir
// (pyenv honours a `.python-version` in cwd, so asking from the operator's cwd could pick a different one). Spawned
// by that absolute path: a PATH shim would not resolve under the metric's PATH=/usr/bin:/bin. 3.9 is the oldest
// version claimed (the runner avoids every newer syntax).
//
// Node: this process's own `process.execPath`, with the permission flag the version understands: `--permission`
// where `process.allowedNodeEnvironmentFlags` lists it (22.13 and later), else `--experimental-permission`
// (22.0–22.12, which reject `--permission` as a bad option). Every Node the engines floor admits confines either way.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MIN_PYTHON: readonly [number, number] = [3, 9];

export type PythonResolution = { executable: string; version: string } | { refused: string };

let cachedPython: PythonResolution | undefined;

export function resolvePython(): PythonResolution {
  if (cachedPython) return cachedPython;
  const dir = mkdtempSync(join(tmpdir(), "cwh-py-"));
  try {
    const out = execFileSync("python3", ["-c", "import sys;print(sys.executable);print('%d.%d.%d' % sys.version_info[:3])"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [exe, version] = out.trim().split("\n");
    const [maj, min] = version.split(".").map(Number);
    if (maj < MIN_PYTHON[0] || (maj === MIN_PYTHON[0] && min < MIN_PYTHON[1]))
      cachedPython = { refused: `python3 is ${version}; a Python command metric needs ${MIN_PYTHON.join(".")} or later` };
    else cachedPython = { executable: realpathSync(exe), version };
  } catch (e) {
    cachedPython = { refused: `python3 could not be resolved: ${(e as Error).message.split("\n")[0]}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cachedPython;
}

/** The Node permission flag this runtime understands. */
export function nodePermissionFlag(
  flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags,
): "--permission" | "--experimental-permission" {
  return flags.has("--permission") ? "--permission" : "--experimental-permission";
}

/** For tests. */
export function resetInterpreterCache(): void {
  cachedPython = undefined;
}

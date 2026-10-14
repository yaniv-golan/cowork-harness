/** Whether a test that needs python3 runs, skips or fails. Off CI a missing interpreter skips (a contributor's machine
 *  may not have one). Under CI it fails: a check that guards what ships, like the skill's size ceiling, must never pass
 *  by skipping. `ci` is the `CI` environment variable (set and not "false" or "0" means CI). */
export function pythonGate(havePython: boolean, ci: string | undefined): "run" | "skip" | "fail" {
  if (havePython) return "run";
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0" ? "fail" : "skip";
}

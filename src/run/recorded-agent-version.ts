// The agent version a recording ran, from the baseline it names (`RunResult.baseline` / `fingerprint.baseline`, an
// appVersion such as `2.26454.2`). Undefined when the baseline does not load here — the caller treats that as unknown.

import { loadBaseline } from "../baseline.js";

export function recordedAgentVersion(baselineRef: string | undefined): string | undefined {
  if (baselineRef === undefined || baselineRef === "") return undefined;
  for (const name of [`desktop-${baselineRef}`, baselineRef]) {
    try {
      return loadBaseline(name).agentVersion;
    } catch {
      /* try the next spelling */
    }
  }
  return undefined;
}

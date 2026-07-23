import type { SessionConfig } from "../session.js";

/**
 * The load-bearing safety layer — explicit opt-in for hostloop fidelity with a writable connected
 * folder. Such a folder gives the native agent process genuine host filesystem access gated ONLY by the
 * PreToolUse path-containment software check — no OS sandbox. Read-only folders and folder-less/scratch
 * runs need no opt-in (the only writable real-FS surface there is the harness-owned outputs dir).
 *
 * A `run` scenario opts in via the top-level `allow_host_writes: true` scenario field (committed YAML,
 * visible in PR diffs); the ad-hoc lanes — `chat`, `skill`, and `critique` (which forwards it to both of
 * its turns) — opt in via a `--allow-host-writes` CLI flag, because an ad-hoc session isn't committed YAML
 * and so has no scenario field to set.
 */
export function checkHostLoopWriteConsent(session: Pick<SessionConfig, "folders">, allowHostWrites: boolean): void {
  const writableFolders = session.folders.filter((f) => f.mode === "rw" || f.mode === "rwd");
  if (writableFolders.length > 0 && !allowHostWrites) {
    throw new Error(
      `hostloop fidelity with a writable connected folder (${writableFolders.map((f) => f.from).join(", ")}) ` +
        `gives the agent under test genuine, software-checked-only host filesystem access — no container ` +
        `sandbox (matches production's own host-loop risk model; see docs/boundary.md). This requires ` +
        `explicit consent: for a \`run\` scenario add \`allow_host_writes: true\` to the YAML; for ` +
        `\`chat\`/\`skill\`/\`critique\` pass --allow-host-writes.`,
    );
  }
}

/** The loud per-run notice, factored so execute.ts and chat.ts can't drift. Never
 *  gated by `--compact` (this is a safety disclosure, not decorative output). */
export function logHostWriteNotice(folders: Array<{ from: string; mode: string }>, warn: (m: string) => void): void {
  const writable = folders.filter((f) => f.mode === "rw" || f.mode === "rwd");
  for (const f of writable) {
    warn(
      `::warning:: [hostloop] ${f.from} is genuinely writable by the agent under test (matches production; no container sandbox for file tools)\n`,
    );
  }
}

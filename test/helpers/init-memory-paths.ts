/** The agent's `system`/`init` frame and its `memory_paths`, read from recorded event lines (a cassette's
 *  `events`, or a run's events.jsonl). The agent writes `memory_paths` into init only while auto-memory is ON, so
 *  this is the end-to-end witness for the CLAUDE_CODE_DISABLE_AUTO_MEMORY switch. `initSeen:false` means there was
 *  no init frame to judge — never read that as "no memory_paths". */
export function initMemoryPaths(lines: Iterable<string>): { initSeen: boolean; memoryPaths: unknown } {
  for (const line of lines) {
    let o: { type?: unknown; subtype?: unknown; memory_paths?: unknown };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "system" && o.subtype === "init") return { initSeen: true, memoryPaths: o.memory_paths };
  }
  return { initSeen: false, memoryPaths: undefined };
}

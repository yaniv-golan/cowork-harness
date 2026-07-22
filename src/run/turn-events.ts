// Turn scoping for `events.jsonl`, which is APPEND-ONLY across turns with no per-turn header.
//
// A LEAF module on purpose: `detectCapabilityUse` (runtime/image-capabilities.ts) needs this too, and
// `execute.ts` already imports that module — so exporting it from `execute.ts` would close an import
// cycle. `timeline.ts` documents the same reasoning for `readTimeline`.

/** The lines of `events.jsonl` belonging to the CURRENT turn.
 *
 *  `events.jsonl` is append-only across turns with no per-turn header, so every whole-file scanner saw
 *  the PRIOR turn's events too. That was not telemetry noise — three of them decide the run's outcome:
 *  `scanEvents` (outputs-delete / host-path-leak → `severity:"fail"` signals),
 *  `findUngatedPathToolCalls` (→ `record.result = "error"`), and `detectCapabilityUse`
 *  (→ `missing_capability`, a fail signal). So on any `--resume` — every `critique` reflection turn —
 *  turn 1's evidence FAILED turn 2.
 *
 *  `beginTurn` writes an `{_emu:"turn_start"}` marker at the start of a resumed turn; this slices from
 *  the last one. FAIL-CLOSED by design: with no marker (an older run dir, or a crash before it was
 *  written) this returns the whole file — today's over-strict behaviour. A missing marker must never turn
 *  a real turn-2 delete into a pass. */
export function currentTurnEventLines(lines: string[]): string[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes(TURN_START_MARKER)) continue;
    try {
      const o = JSON.parse(lines[i]!) as { _emu?: string };
      if (o?._emu === "turn_start") return lines.slice(i + 1);
    } catch {
      /* a corrupt line is not a marker — keep looking */
    }
  }
  return lines;
}

export const TURN_START_MARKER = '"_emu":"turn_start"';

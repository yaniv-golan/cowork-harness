// The events a command metric reads: one turn's slice of the run's `events.jsonl`. Pure.
//
// The harness appends `{"_emu":"turn_start","turn":N}` at the start of every resumed turn. Turn 1 is the lines before
// the first marker; turn N >= 2 is the lines after the marker whose `turn` is N, up to the next marker or the end.
// A turn >= 2 with no marker has no slice (`no_events`): unlike the fail-signal readers' whole-file fallback, a metric
// must never count turn 1 into turn 2. A marker forged inside a tool_result cannot split a slice — inside a JSON
// string its quotes are escaped, so the line never parses as a marker. Harness `_emu` rows other than markers stay in.

export type EventsSlice = { bytes: Buffer } | { none: "no_marker" };

const markerTurn = (line: string): number | undefined => {
  if (!line.includes('"turn_start"')) return undefined;
  try {
    const o = JSON.parse(line) as { _emu?: unknown; turn?: unknown };
    return o._emu === "turn_start" && typeof o.turn === "number" ? o.turn : undefined;
  } catch {
    return undefined;
  }
};

/** The slice for `turn`, as bytes: the selected lines joined with "\n", each line verbatim, newline-terminated. */
export function sliceTurnEvents(raw: Buffer | string, turn: number): EventsSlice {
  const lines = (typeof raw === "string" ? raw : raw.toString("utf8")).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const markers = lines.map((l, i) => ({ i, t: markerTurn(l) })).filter((x) => x.t !== undefined) as Array<{ i: number; t: number }>;
  let from: number;
  let to: number;
  if (turn <= 1) {
    from = 0;
    to = markers.length ? markers[0].i : lines.length;
  } else {
    const at = markers.find((m) => m.t === turn);
    if (!at) return { none: "no_marker" };
    from = at.i + 1;
    const next = markers.find((m) => m.i > at.i);
    to = next ? next.i : lines.length;
  }
  const picked = lines.slice(from, to);
  return { bytes: Buffer.from(picked.length ? picked.join("\n") + "\n" : "", "utf8") };
}

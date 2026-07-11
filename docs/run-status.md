# Checking a background run's status: `status.json` + `cowork-harness status`

A background `cowork-harness skill`/`run` invocation (e.g. one you're driving via `--decider-dir`, or
one launched with `&` while you do other work) needs a way to be checked on: is it still alive, and how
far along is it? **Don't use `ps aux`** — it only sees processes in your OWN PID namespace. If you're
checking from inside a container, VM, or sandboxed subagent, a perfectly healthy host-side
`cowork-harness` process is structurally invisible to you, and `ps aux` coming up empty means nothing —
it does **not** mean the run has exited.

`status.json` is the portable alternative: a small JSON file, written into the run's own output
directory, that any process with filesystem access to that directory can read — regardless of PID
namespace.

## How it works

1. As soon as the run's output directory (`outDir`) exists — before the container/VM even spawns — the
   harness writes `<outDir>/status.json` with `"state":"running"` and prints
   `[status] <outDir>` to stderr, so a driving agent capturing that output knows exactly where to look.
   `status.json`'s `fidelity` field is the scenario's DECLARED tier (`"cowork"` resolves to
   `container`/`hostloop` internally, but `status.json` shows `"cowork"`, matching `result.json`'s own
   convention) — not the resolved/effective one.
2. While the run is live, `<outDir>/status.json` is overwritten periodically (default every 5s, tunable
   via `COWORK_HARNESS_STATUS_INTERVAL_MS`) with live tool-call and sub-agent counts.
3. When the run finishes (success, error, or an unanswered-gate partial), `status.json` is written once
   more with a terminal `state` (`"done"` or `"error"`). On a terminal **error**, it also carries the
   terminal-error diagnostics — `errorSource` (`spawn`/`protocol`/`exit`/`agent`/`result`/`no_result`/`timeout`
   — `no_result` = the stream ended with no result event, i.e. turn/time exhaustion), the SDK `resultSubtype`
   (e.g. `error_max_turns`), `stderrLogPath`, and `resultErrorKind` (`transport`/`agent`/`usage_limit`) — so a
   failure-output reader gets more than a bare `"error"` (these mirror the same fields in `result.json`).
   `resultErrorKind: "usage_limit"` is worth checking for specifically: a batch/status watcher can halt fast
   on it instead of retrying into an already-spent quota.
4. **Crash safety net:** if the process unwinds via an uncaught throw (or receives `SIGTERM`) before
   either normal completion path runs, an `"exit"` handler still writes a terminal `"error"` status —
   `status.json` never gets stuck reporting `"running"` for a process that's actually gone.
5. **Staleness detection (the `SIGKILL` case):** an exit handler cannot run on `SIGKILL`/OOM-kill/a
   segfault — nothing in Node runs on those, by design of the OS signal itself, so `status.json` is left
   sitting at whatever it last said, frozen, with no terminal write ever coming. **Neither the crash
   handler above NOR a "never appeared" check catches this** — the file already exists and already says
   `"running"`. The actual signal is that `updatedAt` stops advancing: both `cowork-harness status` and
   `status --follow` treat a `"running"` status whose `updatedAt` is older than ~3× the write interval
   (default 15s) as **stale — probably dead**, and report/exit accordingly instead of trusting it forever.

`status.json` is diagnostic only — every write is best-effort and can never affect the run's real
result (`result.json`, exit code, assertions).

## `cowork-harness status <run-id | run-dir> [--follow]`

- **`cowork-harness status <dir>`** — read the current status once and print a one-line summary (or the
  full JSON with `--output-format json`, which also carries a `stale: boolean` field). Exits `0` for a
  fresh `running`/`done`, `1` for `error` or missing/malformed `status.json`, `2` for an unresolvable
  argument, `3` for a **stale** `running` (see below).
- **`cowork-harness status <dir> --follow`** — stream one JSON line per status change on stdout, until
  the run reaches a terminal state. The harness owns the poll loop, so a driving agent points **one**
  Monitor at this instead of hand-rolling a poll/read loop. Two things make `--follow` fail loud with a
  non-zero exit instead of hanging forever: `status.json` never appearing at all within
  `COWORK_HARNESS_STATUS_FIRST_SEEN_TIMEOUT_MS` (default 60s — wrong dir, or the run never started), or
  an existing `"running"` status going **stale** (see below — the `SIGKILL` case). `--follow` always
  emits raw JSON lines regardless of `--output-format` (matching `gates --follow`'s convention) — the
  flag only affects the one-shot (non-`--follow`) form.
- `<run-id | run-dir>` accepts either the literal directory printed in the `[status] <outDir>` stderr
  line (works from the very first moment, even before the run has produced any events), or a run-id /
  scenario fragment resolved the same way `trace`/`inspect` already do.

## Recipe

```bash
# Start the run in the background, capturing stderr so you can read the printed outDir.
cowork-harness skill ~/my-plugin "Render the report" 2> run.stderr.log &

# Grab the outDir the harness printed (poll briefly — it's written within ~1s of starting).
OUT_DIR=$(grep -m1 '^\[status\] ' run.stderr.log | sed 's/^\[status\] //')

# One-shot check:
cowork-harness status "$OUT_DIR"
# ● running — my-plugin [container] · pid 51234 · 42s · 7 tools · 1 sub-agents

# Or stream until done:
cowork-harness status "$OUT_DIR" --follow
# {"schemaVersion":1,"state":"running",...}
# {"schemaVersion":1,"state":"running",...}
# {"schemaVersion":1,"state":"done","result":"success","durationMs":67432,...}
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Healthy — `"running"` (fresh) or `"done"`. |
| `1` | The `<run-id \| run-dir>` argument resolved, but `status.json` is missing or malformed, or the run itself ended in `state:"error"`. |
| `2` | Usage error (bad flags/args), or an unresolvable `<run-id \| run-dir>` argument (wrong id, directory doesn't exist). Matches the behavior of `trace`, `inspect`, and `scaffold`. |
| `3` | **Stale** — `"running"` but `updatedAt` hasn't advanced; the process likely died without a clean exit (`SIGKILL`/OOM/segfault) and no exit handler could catch it. Distinct from `1` on purpose, so a script can tell "the run failed" from "can't confirm it's alive" without parsing text. `status` never throws `BoundaryError`, but this code is reused elsewhere in the CLI for the same "abnormal abort" semantic. |

## Notes and tuning

- **Never rely on `ps aux` to check a `cowork-harness` run.** It only works when the checker shares the
  target's PID namespace — true at a bare host shell, false inside almost any sandbox. `status.json` has
  no such requirement; only filesystem access to `outDir` is needed.
- **status.json is diagnostic, not authoritative.** For the real, verdict-affecting result, read
  `result.json` (or the process exit code / footer) once the run is `"done"`/`"error"`.
- **`readRunStatus` shape-validates `status.json`, not just parses it.** A file that's valid JSON but the
  wrong shape (`{}`, or a `state` of the wrong type) is reported **malformed** (exit `1`) rather than
  trusted as a bogus `state: undefined` — a corrupt/truncated write caught mid-shape fails loud instead of
  silently misreading the run's phase.
- **A `"running"` result can still mean "probably dead."** If the process was `SIGKILL`'d/OOM-killed/
  segfaulted, nothing in it ran to write a terminal state — check `stale` (JSON) or the `probably-dead`
  label (text) rather than treating any `"running"` read as gospel. This is inherent to any
  liveness-by-file-write scheme, not specific to this implementation — no `"exit"` handler runs on
  `SIGKILL`, so staleness detection (age of `updatedAt`) is the only way to catch it.
- **Env knobs:**
  - `COWORK_HARNESS_STATUS_INTERVAL_MS` — how often the harness overwrites `status.json` with live
    counts while a run is in progress (default 5000ms).
  - `COWORK_HARNESS_STATUS_POLL_MS` — how often `status --follow` polls for a change (default 1000ms).
  - `COWORK_HARNESS_STATUS_FIRST_SEEN_TIMEOUT_MS` — how long `status --follow` waits for `status.json`
    to appear at all before failing loud (default 60000ms / 60s). Does not apply once a first status has
    been observed — a long-running `"running"` run is never killed by this timeout.
  - `COWORK_HARNESS_STATUS_STALE_MS` — how old `updatedAt` must be before a `"running"` status is
    treated as stale/probably-dead (default: 3× `COWORK_HARNESS_STATUS_INTERVAL_MS`, i.e. 15s out of the
    box). Raise it if you deliberately run with a longer `COWORK_HARNESS_STATUS_INTERVAL_MS` and don't
    want staleness to trip prematurely.

## `mounts.json` — a run's VM-path resolution context

`status.json`'s sibling `mounts.json` records the mount/host-path resolution context a run used —
which mount name (`mnt/<name>/...`) maps to which real host directory, plus the resolved `outputs`/
`uploads` staging dirs and the tier the run actually resolved to. It exists so a process reading a KEPT
run dir later (after the writer has exited) can rebuild that context instead of only seeing raw VM
paths (`/sessions/<id>/mnt/...`) — the same information the live run already showed a human via
host-path translation at `hostloop`, but which would otherwise be lost the moment the process exits.

Written unconditionally, at every fidelity tier, right after the run's launch plan is built — same
convention as `status.json`: best-effort (a write failure warns and never fails the run), and purely
diagnostic (nothing reads it to decide a verdict).

```json
{ "v": 1, "sessionId": "…", "effectiveFidelity": "hostloop",
  "outputsHostDir": "/Users/you/.cowork-harness/runs/.../work/session/mnt/outputs",
  "uploadsHostDir": "/Users/you/.cowork-harness/runs/.../work/session/mnt/uploads",
  "folders": { "myproject": "/Users/you/code/myproject" } }
```

The first consumer is `cowork-harness trace --translate-paths` (text output only — `--output-format
json` always stays the raw machine record): when a run's `mounts.json` is present and its
`effectiveFidelity` was `"hostloop"` (the one tier where the resolved host path is
production-identical — see `src/run/display-translate.ts`'s module header), `trace`'s tool/text rows
show host paths instead of VM paths. Absent, corrupt, or a future-major-version `mounts.json` all
degrade silently to the untranslated VM-path rows you'd see today.

`mounts.json` never reaches a `record`ed cassette — a cassette snapshots exactly `events.jsonl` +
`control-out.jsonl` + the run's user-visible-roots subtree under `<outDir>/work/...`, and `mounts.json`
lives at the `outDir` ROOT, a sibling of `work/`, so it is structurally unreachable from that walk.

## See also

- [`decider-dir.md`](./decider-dir.md) — the closest existing precedent (`gates --follow` + `done.json`)
  for polling a file for run state.
- [`../src/run/run-status.ts`](../src/run/run-status.ts) — the implementation.
- [`../src/run/vm-path-ctx-file.ts`](../src/run/vm-path-ctx-file.ts) — the `mounts.json`
  serializer/reader implementation.

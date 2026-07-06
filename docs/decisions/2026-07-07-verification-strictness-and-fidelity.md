# Decision record: verification strictness and fidelity defaults

- **Date:** 2026-07-07
- **Status:** Accepted
- **Scope:** assertion/verdict semantics, replay/cassette compatibility, and two binary-verified fidelity behaviors.

This is the project's first decision record. It exists so that the behavior changes below — several of which flip a currently-passing run to failing — are an accountable, versioned commitment rather than tribal knowledge. Later records live alongside this one under `docs/decisions/`.

## Context

The harness is a verification tool: its core promise is that a green result means the run was actually checked and actually passed. Several current behaviors weaken that promise by treating *absence of evidence* or *incompleteness* as success. Separately, two runtime behaviors that emulate real Claude Cowork were unverified against the real product. The project is pre-1.0 with no external users and a small fixture set, so tightening defaults now — while a breaking change costs only a fixture refresh — is materially cheaper than doing it later.

The governing principle, already stated in the codebase, is **"can't verify is not green,"** extended here to **"incomplete is not green."**

## Decisions

### D1 — Missing or malformed evidence fails, never silently passes

When an assertion needs telemetry that is absent or unparseable (task tracking, web-search results, resource samples, present-files records, sidecar/infrastructure errors, capability probes, file hashes), the assertion **fails** as evidence-unavailable/malformed instead of passing by default.

**Rationale:** a verification tool that reports "passed" when it could not actually check is worse than one that errors — it launders unknowns into false confidence.

### D2 — Presence-free assertions become presence-required

Assertions that today pass vacuously when nothing matched (e.g. "no tool errored" with zero matching tools; "all tasks completed" with zero tasks; "all links resolve" with zero links) now **require at least one matching element**. A parallel `*_if_present` variant preserves the lenient behavior for authors who explicitly want it.

**Rationale:** the vacuous reading is almost never what an author intends and is a silent false-green. The opt-in sibling means no capability is lost — only the unsafe default.

### D3 — Incomplete batches fail by default

A matrix run that was truncated, or a repeat run stopped early by budget before completing its requested trials, **fails** unless an explicit opt-in flag is passed; the flag records the incomplete sample size in the verdict.

**Rationale:** a green result from a partial batch misrepresents coverage.

### D4 — Replay is strict by default

Cassettes with a future format version, or containing unknown/malformed assertion shapes, **fail** on replay unless an explicit best-effort flag is set. Recording-shaping drift (prompt, baseline, fidelity, answers, skills, capabilities, session content) hard-fails staleness detection rather than passing.

**Rationale:** an older harness replaying a cassette whose semantics it does not understand can produce a meaningless green.

### D5 — Verdict-suppression modifiers are `true`-only, and typo'd assertion keys fail at parse

Verdict-suppression modifiers accept only `true` (a suppression switch, not a boolean field); a `false` value is rejected rather than silently accepted as a no-op. Independently, misspelled assertion keys **fail at scenario/cassette parse** instead of being silently dropped.

**Rationale:** both are quiet authoring footguns where the author believes an assertion or suppression is in effect when it is not.

### D6 — Infrastructure errors are not author-suppressible

A crash of the egress/VM sidecar during a run is a hard failure on both the live and replay lanes and cannot be suppressed by an assertion modifier — it is treated like a transport error, not like a skill/scenario property.

**Rationale:** an infrastructure crash means the run's evidence is contaminated; the harness does not actually know what the skill did, so "pass anyway" is never a valid author choice.

## Fidelity determinations (binary-verified 2026-07-07)

Two emulated runtime behaviors were verified against the real product's binaries (the Desktop application bundle and the sandbox agent binary) before changing them. In both cases the verification **reversed** the intuition we would otherwise have followed, which is the reason it was done first.

### F1 — `present_files` accepts a fixed set of mount roots, with no filesystem or extension checks

Real Cowork's sandbox-mode handler validates a presented `mnt/...` path by a **pure string root-check** — the first path segment must be one of `outputs`, `uploads`, `.host-home`, `.auto-memory`, or a connected-folder name (with `..`/`.`/empty segments rejected); anything else is refused with "not accessible on the user's computer." It performs **no existence check and no extension denylist** on these paths. Existence, realpath-containment, and blocked-extension checks apply **only** to the scratchpad→outputs promotion path.

**Decision:** the harness will restrict mount presentation to that exact root set, and will **not** add existence or extension checks to mount paths (doing so would reject inputs the real product accepts). Existence/extension checks remain only on the scratchpad-promotion path, where they already exist and match the real product.

### F2 — Egress host matching normalizes the request host but not the allowlist entries

Real Cowork's sandbox egress proxy normalizes the **request host** (IPv6 bracket stripping, IDNA/Unicode folding, lowercasing, single trailing-dot strip) but compares against allowlist **entries** that are only lowercased — entries are not IDNA-folded or bracket-stripped.

**Decision:** the harness's host-normalization helper will add **IPv6 bracket stripping** (closing an internal inconsistency with the proxy, and faithful to the real product). It will **not** apply IDNA folding to allowlist entries or assertion needles: the real product leaves entries unfolded, so folding them would make the harness match a Unicode entry the real product would deny — a false-green. Wildcard (`*.`) support is added to assertion host-matching additively, without changing the subdomain-inclusive meaning of bare needles.

## Consequences

- **Behavior flips.** D1–D6 turn some currently-green runs red by design. The affected in-repo fixtures and example scenarios will be updated (add the required element, adopt an `*_if_present` variant, or pass an opt-in flag) as part of the change.
- **Cassette format bump + re-record.** The strict-replay and drift changes advance the cassette format version; the on-disk cassettes are re-recorded (not migrated in place — the new fingerprint/folder-mapping fields are record-time facts a rehash cannot synthesize faithfully).
- **Opt-outs are explicit.** Best-effort replay of future-version cassettes, truncated matrices, and budget-stopped repeats each remain possible via an explicit, self-documenting flag that records the reduced coverage in the verdict.
- **Scope and sequencing.** These decisions are adopted in full and rolled out in waves — the evidence/assertion/replay-strictness core first, path-identity and CLI-contract cleanups next, and the larger/fidelity-gated changes last — so each wave can be reviewed before the next.

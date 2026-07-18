# Architecture Decision Records (ADRs)

An ADR here records the "why" behind a cross-cutting default or decision — context, alternatives, and rationale — so the behavior is an accountable, versioned commitment rather than tribal knowledge.

## Records

- [2026-07-07-verification-strictness-and-fidelity.md](./2026-07-07-verification-strictness-and-fidelity.md) — Decision record: verification strictness and fidelity defaults. Tightens assertion/verdict semantics so missing or incomplete evidence fails instead of silently passing, makes cassette replay strict by default, hardens verdict modifiers and parse-time key validation, and records two binary-verified fidelity behaviors (decisions D1–D6).

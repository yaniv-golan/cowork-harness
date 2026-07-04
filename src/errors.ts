/**
 * Shared typed errors. Leaf module (no imports) so any layer can throw these without creating an
 * import cycle. `main().catch` (cli.ts) maps `BoundaryError` to a clean, no-stack exit 3.
 */

/**
 * Thrown for a boundary/integrity violation that must fail loud and clean (no stack trace):
 * a scenario asserting boundary behavior at a fidelity that can't enforce it (§5c), a symlinked
 * staging path that escapes the session tree, or a plugin/skill source that would mount EMPTY.
 */
export class BoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryError";
  }
}

/**
 * Thrown for a user-input mistake detected past the flag parser (e.g. a scenario file that fails
 * schema validation). `main().catch` (cli.ts) maps it to a clean category-`usage` exit 2 — without
 * this, a Zod throw from a scenario typo surfaced as category `internal` (a user mistake
 * masquerading as a harness bug).
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

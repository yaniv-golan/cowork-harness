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

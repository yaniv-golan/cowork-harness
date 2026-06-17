/**
 * Compile a user-authored regex case-insensitively, returning the RegExp or a typed error (the regex
 * engine's message). Centralizes the try/catch that assertion evaluation, scenario validation, and
 * scripted-answer matching each re-implemented. Callers prefix their own context, e.g.
 * `transcript_matches: bad regex "<p>": <error>`.
 */
export function compileUserRegex(pattern: string): { re: RegExp } | { error: string } {
  try {
    return { re: new RegExp(pattern, "i") };
  } catch (e) {
    return { error: String((e as Error).message) };
  }
}

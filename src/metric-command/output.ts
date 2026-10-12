// A command metric's stdout grammar: after trimming ASCII whitespace from both ends, exactly one JSON number whose
// value is finite. Anything else — empty output, a second number or line, `+1`, `01`, `.5`, `1.`, hex, `1_000`,
// `1,000`, `NaN`, `Infinity`, an overflow like `1e999`, a BOM, trailing text — is not a measurement. Pure.

const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

export type ParsedOutput = { value: number } | { invalid: string };

/** Parse one script's stdout bytes. Invalid UTF-8 is refused (a replacement character is never a digit). */
export function parseMetricOutput(stdout: Buffer): ParsedOutput {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
  } catch {
    return { invalid: "stdout is not valid UTF-8" };
  }
  const trimmed = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (trimmed === "") return { invalid: "stdout is empty" };
  if (!NUMBER.test(trimmed)) return { invalid: `stdout is not exactly one JSON number: ${JSON.stringify(trimmed.slice(0, 80))}` };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { invalid: `stdout overflows a finite number: ${JSON.stringify(trimmed.slice(0, 80))}` };
  return { value: Object.is(value, -0) ? 0 : value };
}

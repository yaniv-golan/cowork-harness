/**
 * Declarative CLI argument parser — the single choke point that makes "reject unknown flag / extra
 * positional / flag-looking value" the STRUCTURAL DEFAULT for every command. Hand-rolled per-command
 * parsing (the `args.find(a => !a.startsWith("--"))` / unbounded `args[i+1]` idioms) silently accepted
 * unknown flags and mistook flag values for positionals; declaring a flag-spec removes that whole class.
 *
 * Behavior contract (fidelity-preserving — error paths only, green paths unchanged):
 *  - unknown flag / missing value / bad enum / flag-looking value → throws `ArgError`; each command
 *    catches it and exits 2 (the existing usage-error code).
 *  - the equals form (`--out=foo`) parses identically to the spaced form and is the escape for a value
 *    that must legitimately start with `-`.
 */

export class ArgError extends Error {}

export type ArgSpec = {
  /** Boolean flags (no value), e.g. ["--strict", "--no-redact"]. */
  booleans?: string[];
  /** Value-flags that consume the next token, e.g. ["--out", "--output-format"]. */
  values?: string[];
  /** Value-flags allowed more than once; collected into `repeated`, e.g. ["--allow", "--plugin"]. */
  repeated?: string[];
  /** Value-flag → allowed values, e.g. {"--output-format": ["text","json"]}. */
  enums?: Record<string, string[]>;
  /**
   * Short-flag aliases → canonical `--name`, e.g. {"-q":"--quiet","-V":"--verbose"}. A single-dash token
   * not listed here is an unknown-flag error (fail loud). Declare only on commands that actually expose the
   * short flag (run/skill). Global -v/-h are consumed pre-dispatch in main() and never reach a command.
   */
  aliases?: Record<string, string>;
  /**
   * OPT-IN dash guard: value-flags whose value can NEVER legitimately be dash-prefixed (paths, run ids,
   * and the shell-command flag --decider-cmd so `--decider-cmd --output-format` injection is caught). A
   * SPACED value starting with `-` for one of these is a usage error. Numeric / semantically-validated
   * flags (e.g. --gate) are deliberately omitted so their own validator owns the message. The equals form
   * (`--out=-x`) always bypasses the guard, keeping a genuinely dash-leading value expressible.
   */
  noDashValue?: string[];
};

export type ParsedArgs = {
  positionals: string[];
  flags: Record<string, boolean>;
  options: Record<string, string | undefined>;
  repeated: Record<string, string[]>;
};

export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const booleans = new Set(spec.booleans ?? []);
  const repeated = new Set(spec.repeated ?? []);
  const values = new Set([...(spec.values ?? []), ...repeated]);
  const noDash = new Set(spec.noDashValue ?? []);
  const aliases = spec.aliases ?? {};
  const enums = spec.enums ?? {};
  const out: ParsedArgs = { positionals: [], flags: {}, options: {}, repeated: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-") || a === "-") {
      out.positionals.push(a); // non-flag (incl. the lone "-" stdin convention)
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1; // equals form only on long flags
    let name = eq > 0 ? a.slice(0, eq) : a;
    if (!a.startsWith("--")) {
      // short flag: resolve via aliases or fail loud (preserves -q/-V)
      if (!(name in aliases)) throw new ArgError(`unknown flag: ${name}`);
      name = aliases[name];
    }
    if (booleans.has(name)) {
      if (eq > 0) throw new ArgError(`${name} takes no value`);
      out.flags[name] = true;
      continue;
    }
    if (values.has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new ArgError(`${name} requires a value`); // wording matches the legacy flagValue helper
      if (enums[name] && !enums[name].includes(v)) throw new ArgError(`${name}: expected one of ${enums[name].join("|")}, got ${v}`);
      // opt-in dash guard, spaced form only (the equals form is the escape)
      if (noDash.has(name) && eq < 0 && v.startsWith("-")) throw new ArgError(`${name}: missing value (got flag-looking ${v})`);
      if (repeated.has(name)) (out.repeated[name] ??= []).push(v);
      else out.options[name] = v;
      continue;
    }
    throw new ArgError(`unknown flag: ${name}`);
  }
  return out;
}

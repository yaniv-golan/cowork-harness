// `--dotenv <path>` and `--run-dir <path>` after the subcommand.
//
// Both were leading-only: main() strips them from the front of argv before dispatch, and must never scan
// further, because a token like `--dotenv=x` can legitimately be ANOTHER flag's value (`skill … --answer=
// --dotenv=x=foo`). Only the command's own parser knows which tokens are values, so each parser recognizes
// the two flags itself and hands them here. This module is the single place that APPLIES them, so the
// placement changes nothing about what they do:
//
//   --dotenv   precedence stays process.env > --dotenv > ./.env > <install>/.env. main() has already
//              auto-loaded the two lower sources by the time a command parses, and loadDotenv only fills
//              undefined keys, so a plain load here would LOSE to ./.env. Instead a key is written unless it
//              was set before main loaded any file (an exported var, or the leading --run-dir's own key).
//   --run-dir  flag > COWORK_HARNESS_RUNS_DIR > default, exactly as the leading form sets it.
//
// Given both before and after the subcommand, or twice after it, is a usage error: there is no ordering
// between two explicit values that a reader could predict.
import { existsSync, readFileSync } from "node:fs";
import { parseDotenv, DotenvReadError } from "../dotenv.js";
import { expandUserPath } from "../session.js";
import type { ArgSpec, ParsedArgs } from "../cli-args.js";
import { fail, envOutputFormat } from "./envelope.js";
import { writeAllSync, tildeify } from "../io.js";
import { resolve } from "node:path";

const log = (s: string) => writeAllSync(2, s + "\n");

export const COMMAND_GLOBAL_FLAGS = ["--dotenv", "--run-dir"] as const;
export type CommandGlobalFlag = (typeof COMMAND_GLOBAL_FLAGS)[number];

export function isCommandGlobalFlag(name: string): name is CommandGlobalFlag {
  return (COMMAND_GLOBAL_FLAGS as readonly string[]).includes(name);
}

interface EnvState {
  /** Keys set before main() loaded any .env file: never overwritten by a per-command --dotenv. */
  protectedKeys: Set<string>;
  /** Which of the two flags were already given before the subcommand. */
  leading: Record<CommandGlobalFlag, boolean>;
  /** Credential keys main() loaded from the install's own .env (and named on stderr as coming from there). */
  installCredentials: Set<string>;
}
let state: EnvState | undefined;
const applied = new Set<CommandGlobalFlag>();

/** THE one resolver for a `--run-dir` value, before or after the subcommand: a shim over
 *  COWORK_HARNESS_RUNS_DIR (flag > env > default), relative to the cwd, `~` expanded. */
export function setRunsDir(value: string): void {
  process.env.COWORK_HARNESS_RUNS_DIR = expandUserPath(value);
}

/** Called once by main(), after the leading flags are handled and BEFORE any .env file is loaded. */
export function recordLeadingGlobals(leading: Record<CommandGlobalFlag, boolean>): void {
  state = { protectedKeys: new Set(Object.keys(process.env)), leading, installCredentials: new Set() };
}

/** Called by main() with the credential keys it loaded from the install's .env, so a per-command --dotenv
 *  that replaces one can correct the `[env] using … from <install>/.env` line main() already printed. */
export function recordInstallCredentials(keys: string[]): void {
  if (state) state.installCredentials = new Set(keys);
}

/** Apply one per-command `--dotenv` / `--run-dir`. `value` is the flag's value as the command's parser read it. */
export function applyCommandGlobal(command: string, flag: CommandGlobalFlag, value: string, json: boolean): void {
  if (state?.leading[flag]) fail(command, "usage", `${flag} given both before and after the subcommand — pass it once`, undefined, json);
  if (applied.has(flag)) fail(command, "usage", `${flag} given more than once — pass it once`, undefined, json);
  applied.add(flag);
  if (value.trim() === "") fail(command, "usage", `${flag} requires a path (none provided)`, undefined, json);
  if (flag === "--run-dir") {
    setRunsDir(value);
    // The runs root is now the user's explicit choice: a --dotenv applied after this must not replace it.
    state?.protectedKeys.add("COWORK_HARNESS_RUNS_DIR");
    return;
  }
  if (!existsSync(value)) fail(command, "usage", `--dotenv file not found: ${value}`, undefined, json);
  let entries: Map<string, string>;
  try {
    entries = parseDotenv(readFileSync(value, "utf8"));
  } catch (e) {
    fail(command, "usage", new DotenvReadError(value, e).message, undefined, json);
  }
  const protectedKeys = state?.protectedKeys ?? new Set(Object.keys(process.env));
  // The env var only ever selects json when it says exactly "json" (isJsonOutput's rule), so compare the
  // EFFECTIVE format: a file that restates what is already in force changes nothing and is not refused.
  const effective = envOutputFormat;
  const before = effective();
  const loaded: string[] = [];
  const replacedInstall: string[] = [];
  for (const [key, val] of entries) {
    if (protectedKeys.has(key)) continue;
    if (process.env[key] !== val) loaded.push(key);
    if (state?.installCredentials.has(key)) replacedInstall.push(key);
    process.env[key] = val;
  }
  // The output format is decided before a command's flags are parsed (its error envelope has to be), so a
  // value that arrives only now cannot take effect for this command. Refuse rather than print in the wrong one.
  if (effective() !== before)
    fail(
      command,
      "usage",
      `${value} sets COWORK_HARNESS_OUTPUT_FORMAT, which a --dotenv given after the subcommand is read too late to apply — ` +
        `put --dotenv before the subcommand (\`cowork-harness --dotenv ${value} ${command} …\`) or pass --output-format`,
      undefined,
      json,
    );
  // The same line, and the same condition (an explicit --dotenv always reports), as the leading form in main().
  if (loaded.length) log(`[env] loaded ${loaded.length} var(s): ${loaded.join(", ")}`);
  // main() named these as coming from the install's .env before this flag was parsed; say where they come from now.
  if (replacedInstall.length) log(`[env] ${replacedInstall.join(", ")} from ${tildeify(resolve(value))} (replacing the install's .env)`);
}

/** For a `parseArgs` command: accept the two flags (repeatable, so a duplicate is reported rather than
 *  last-write-wins; spaced values may not start with `-`, the equals form is the escape). */
export function withCommandGlobals(spec: ArgSpec): ArgSpec {
  return {
    ...spec,
    repeated: [...(spec.repeated ?? []), ...COMMAND_GLOBAL_FLAGS],
    noDashValue: [...(spec.noDashValue ?? []), ...COMMAND_GLOBAL_FLAGS],
  };
}

/** For a `parseArgs` command: apply what `withCommandGlobals` collected. --dotenv first, so a --run-dir given
 *  alongside it wins over a COWORK_HARNESS_RUNS_DIR in the file, as flag > env requires. */
export function applyParsedCommandGlobals(command: string, p: ParsedArgs, json: boolean): void {
  for (const flag of COMMAND_GLOBAL_FLAGS) {
    const values = p.repeated[flag] ?? [];
    if (values.length > 1) fail(command, "usage", `${flag} given more than once — pass it once`, undefined, json);
    if (values.length === 1) applyCommandGlobal(command, flag, values[0], json);
  }
}

/** Test seam: forget what this process applied (unit tests call commands in-process). */
export function resetCommandGlobalsForTest(): void {
  applied.clear();
  state = undefined;
}

/** For a command whose own parsing locates flags by scanning (`rejectUnknownFlags` + `positionals()` /
 *  `indexOf`): walk `args` left to right, keep every other flag's spaced VALUE in place (`valueFlags` lists
 *  the command's spaced value-taking flags — the same list its `positionals()` call skips), apply each
 *  `--dotenv`/`--run-dir` found in flag position, and return `args` without them. Call it before the
 *  command's own scans, so they never see the two flags. */
export function stripCommandGlobals(command: string, args: string[], valueFlags: readonly string[], json: boolean): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) {
      kept.push(a);
      if (i + 1 < args.length) kept.push(args[++i]); // another flag's value, whatever it looks like
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!isCommandGlobalFlag(name)) {
      kept.push(a);
      continue;
    }
    const v = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (v === undefined || (eq < 0 && v.startsWith("-")))
      fail(command, "usage", `${name} requires a path (none provided)`, undefined, json);
    applyCommandGlobal(command, name, v, json);
  }
  return kept;
}

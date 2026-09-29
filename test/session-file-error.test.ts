// A `session:` file that cannot be read is a usage error (`SessionFileError`), raised by the one loader
// every strict caller goes through; the callers that tolerate a session they cannot open (the cassette
// fingerprint and staleness paths, the model pre-flight) stay tolerant.
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile, loadSessionFromFile, unresolvedModelPreflight } from "../src/run/execute.js";
import { checkStaleness, resolveCassetteSessionPath, cassetteSessionRef, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";
import { SessionFileError, UsageError } from "../src/errors.js";

function work(): string {
  return mkdtempSync(join(tmpdir(), "cwh-session-file-"));
}

function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("parseSessionFile: an unreadable session file is a SessionFileError", () => {
  it("a missing file: not found, the absolute path, and where `session:` resolves from", () => {
    const p = join(work(), "gone.yaml");
    const e = thrown(() => parseSessionFile(p)) as SessionFileError;
    expect(e).toBeInstanceOf(SessionFileError);
    expect(e).toBeInstanceOf(UsageError);
    expect(e.message).toBe(`session file not found: ${p}`);
    expect(e.hint).toMatch(/relative to the scenario file's directory/);
  });

  it("a path through a regular file (ENOTDIR) is not found too", () => {
    const d = work();
    writeFileSync(join(d, "f"), "x");
    const e = thrown(() => parseSessionFile(join(d, "f", "s.yaml"))) as Error;
    expect(e).toBeInstanceOf(SessionFileError);
    expect(e.message).toMatch(/^session file not found: /);
  });

  it("a directory", () => {
    const d = work();
    const e = thrown(() => parseSessionFile(d)) as Error;
    expect(e).toBeInstanceOf(SessionFileError);
    expect(e.message).toBe(`session file is a directory: ${d}`);
  });

  it.skipIf(process.getuid?.() === 0)("a file that is not readable", () => {
    const p = join(work(), "locked.yaml");
    writeFileSync(p, "model: claude-sonnet-5\n");
    chmodSync(p, 0o000);
    const e = thrown(() => parseSessionFile(p)) as Error;
    chmodSync(p, 0o600);
    expect(e).toBeInstanceOf(SessionFileError);
    expect(e.message).toBe(`session file is not readable: ${p}`);
  });

  it("invalid YAML: a one-line reason, not the parser's multi-line dump", () => {
    const p = join(work(), "bad.yaml");
    writeFileSync(p, "model: [unclosed\n");
    const e = thrown(() => parseSessionFile(p)) as Error;
    expect(e).toBeInstanceOf(SessionFileError);
    expect(e.message).toMatch(new RegExp(`^session file is not valid YAML: ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\S`));
    expect(e.message).not.toMatch(/\n/);
  });

  it("green pin: a schema-invalid session (valid YAML) is not a SessionFileError", () => {
    const p = join(work(), "schema.yaml");
    writeFileSync(p, "no_such_key: 1\n");
    expect(parseSessionFile(p)).toEqual({ no_such_key: 1 });
  });

  it("green pin: the (inline) sentinel reads nothing", () => {
    expect(parseSessionFile("(inline)")).toEqual({});
  });
});

describe("`~` in a session path expands to the current user's home directory", () => {
  const home = process.env.HOME;
  afterEach(() => {
    process.env.HOME = home;
  });

  it("the file loads, and its relative mounts resolve against ITS directory, not `${cwd}/~`", () => {
    const d = work();
    mkdirSync(join(d, "sub", "data"), { recursive: true });
    writeFileSync(join(d, "sub", "s.yaml"), "model: claude-sonnet-5\nfolders:\n  - from: ./data\n");
    process.env.HOME = d;
    const s = loadSessionFromFile("~/sub/s.yaml");
    expect(s.model).toBe("claude-sonnet-5");
    expect(s.folders[0].from).toBe(join(d, "sub", "data"));
  });

  it("the cassette fingerprint reads the same file: `~/…` is home-relative, never cassette-relative", () => {
    const d = work();
    process.env.HOME = d;
    expect(resolveCassetteSessionPath("~/s.yaml", "/somewhere/cassettes").path).toBe(join(d, "s.yaml"));
    expect(resolveCassetteSessionPath("~/s.yaml").path).toBe(join(d, "s.yaml"));
  });

  it("the cassette stores a `~/…` session relative to itself, pointing at the expanded file", () => {
    const d = work();
    process.env.HOME = d;
    expect(cassetteSessionRef("~/s/session.yaml", join(d, "cassettes", "c.cassette.json"))).toBe(join("..", "s", "session.yaml"));
    expect(cassetteSessionRef("(inline)", join(d, "c.cassette.json"))).toBe("(inline)");
  });

  it("`~<user>` is a usage error, not a raw throw", () => {
    const e = thrown(() => parseSessionFile("~someone-else/s.yaml")) as Error;
    expect(e).toBeInstanceOf(SessionFileError);
    expect(e.message).toMatch(/another user's home directory/);
  });
});

describe("green pins: the tolerant callers stay tolerant", () => {
  const scenario = (session: string) => ({
    name: "t",
    baseline: "latest",
    session,
    fidelity: "container" as const,
    prompt: "hi",
    answers: [],
    expect_denied: [],
    assert: [],
  });

  it("the model pre-flight answers `undefined` for a session that does not load (the input check reports it)", () => {
    const prev = process.env.COWORK_HARNESS_MODEL;
    delete process.env.COWORK_HARNESS_MODEL;
    try {
      expect(unresolvedModelPreflight(scenario(join(work(), "gone.yaml")) as never, undefined)).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.COWORK_HARNESS_MODEL = prev;
    }
  });

  it("staleness on a cassette whose session moved is 'cannot verify', never a throw", () => {
    const c = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: scenario(join(work(), "moved-away.yaml")),
      events: [],
      fingerprint: { baseline: "latest", skillHash: "deadbeef" },
    } as unknown as Cassette;
    const msgs = checkStaleness(c, work());
    expect(msgs.some((m) => /cannot verify skill staleness/.test(m))).toBe(true);
  });

  it("staleness on a cassette whose session is now a directory is 'cannot verify', never a throw", () => {
    const d = work();
    const c = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: scenario(d),
      events: [],
      fingerprint: { baseline: "latest", skillHash: "deadbeef" },
    } as unknown as Cassette;
    const msgs = checkStaleness(c, d);
    expect(msgs.some((m) => /cannot verify skill staleness/.test(m))).toBe(true);
  });
});

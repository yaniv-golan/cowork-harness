import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_TOKEN, credentialLeaks, makeStubFixture, stubInvocationPids } from "./helpers/stub-agent.js";

// The stub-agent fixture's own contract: the credential it hands every CLI-level test, and the leak check that
// exempts exactly that credential and nothing else.
describe("stub-agent fixture", () => {
  it("drives the managed-config branch with the fake token: the token is set and COWORK_MANAGED_CONFIG is not", () => {
    const f = makeStubFixture("exec sleep 300");
    try {
      expect(f.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(STUB_TOKEN);
      // `=0` overrides a token, so it must stay unset for the token to select the managed branch.
      expect("COWORK_MANAGED_CONFIG" in f.env).toBe(false);
      expect(f.env.ANTHROPIC_API_KEY).toBe("");
      expect(f.env.ANTHROPIC_AUTH_TOKEN).toBe("");
    } finally {
      f.cleanup();
    }
  });

  describe("credentialLeaks", () => {
    const dump = (lines: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), "leaks-"));
      const file = join(dir, "env");
      writeFileSync(file, lines.join("\n") + "\n");
      return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
    };

    it("exempts the fixture's own token by exact value", () => {
      const d = dump([`CLAUDE_CODE_OAUTH_TOKEN=${STUB_TOKEN}`, "ANTHROPIC_API_KEY=", "PATH=/bin"]);
      try {
        expect(credentialLeaks(d.file)).toEqual([]);
      } finally {
        d.done();
      }
    });

    it("reports any other value under the same name, another fake included", () => {
      for (const v of ["sk-ant-oat01-real-looking", `${STUB_TOKEN}x`, "fake-token"]) {
        const d = dump([`CLAUDE_CODE_OAUTH_TOKEN=${v}`]);
        try {
          expect(credentialLeaks(d.file)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
        } finally {
          d.done();
        }
      }
    });

    it("reports the stub value under any other credential name", () => {
      const d = dump([`ANTHROPIC_AUTH_TOKEN=${STUB_TOKEN}`, "ANTHROPIC_API_KEY=DUMMY"]);
      try {
        expect(credentialLeaks(d.file).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
      } finally {
        d.done();
      }
    });
  });

  it("stubInvocationPids lists one pid per invocation file and ignores the last-pid file", () => {
    // A scratch dir, not a fixture: the fixture's cleanup() SIGKILLs every pid listed, and these are made up.
    const dir = mkdtempSync(join(tmpdir(), "pids-"));
    try {
      const pidFile = join(dir, "stub.pid");
      writeFileSync(pidFile, "111\n");
      writeFileSync(`${pidFile}.111`, "111\n");
      writeFileSync(`${pidFile}.222`, "222\n");
      writeFileSync(join(dir, "stub.env"), "X=1\n");
      expect(stubInvocationPids(pidFile).sort()).toEqual([111, 222]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

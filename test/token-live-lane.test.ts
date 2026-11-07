import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The live lane resolves its token in ONE place: test/setup/live-token.ts, listed in vitest.config.live.ts
// `setupFiles`, fills CLAUDE_CODE_OAUTH_TOKEN for every live worker. Before it, each live suite had its own chain
// (four had no .env step, one had COWORK_LIVE_DOTENV), so the same machine ran one suite and silently skipped
// another. The token-free proof, since the live lane itself must not run here.
const FAKE = "fake-token-not-real";

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "live-token-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the live lane's token lookup", () => {
  it("first hit wins: environment, then COWORK_LIVE_DOTENV, then ~/.cowork-harness-token, then the repo .env", async () => {
    const { resolveLiveToken } = await import("./setup/live-token-resolve.js");
    const s = scratch();
    try {
      const home = join(s.dir, "home");
      const repoEnv = join(s.dir, "repo.env");
      const dotenv = join(s.dir, "explicit.env");
      writeFileSync(repoEnv, `CLAUDE_CODE_OAUTH_TOKEN=${FAKE}-repo\n`);
      writeFileSync(dotenv, `CLAUDE_CODE_OAUTH_TOKEN="${FAKE}-dotenv"\n`);
      const paths = { home, repoEnv };
      // 4. nothing else: the repo .env
      expect(resolveLiveToken({}, paths)).toEqual({ token: `${FAKE}-repo`, source: repoEnv });
      // 3. the token file beats the repo .env
      mkdirSync(home);
      writeFileSync(join(home, ".cowork-harness-token"), `${FAKE}-file\n`);
      expect(resolveLiveToken({}, paths)).toEqual({ token: `${FAKE}-file`, source: join(home, ".cowork-harness-token") });
      // 2. COWORK_LIVE_DOTENV beats the token file
      expect(resolveLiveToken({ COWORK_LIVE_DOTENV: dotenv }, paths).token).toBe(`${FAKE}-dotenv`);
      // 1. the environment beats everything
      expect(resolveLiveToken({ CLAUDE_CODE_OAUTH_TOKEN: `${FAKE}-env`, COWORK_LIVE_DOTENV: dotenv }, paths)).toEqual({
        token: `${FAKE}-env`,
        source: "environment",
      });
      // an unreadable COWORK_LIVE_DOTENV means no credential: it does not fall through to the file or the repo .env
      expect(resolveLiveToken({ COWORK_LIVE_DOTENV: join(s.dir, "missing.env") }, paths).token).toBe("");
    } finally {
      s.done();
    }
  });

  it("apply fills the token only when unset or empty, records the source, and never the value", async () => {
    const { applyLiveToken, LIVE_TOKEN_SOURCE_VAR } = await import("./setup/live-token-resolve.js");
    const s = scratch();
    try {
      const repoEnv = join(s.dir, "repo.env");
      writeFileSync(repoEnv, `CLAUDE_CODE_OAUTH_TOKEN=${FAKE}\n`);
      const paths = { home: join(s.dir, "nohome"), repoEnv };
      const empty: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "" };
      applyLiveToken(empty, paths);
      expect(empty.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE);
      expect(empty[LIVE_TOKEN_SOURCE_VAR]).toBe(repoEnv);
      expect(LIVE_TOKEN_SOURCE_VAR).toBe("COWORK_HARNESS_LIVE_TOKEN_SOURCE");
      const explicit: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: `${FAKE}-mine` };
      applyLiveToken(explicit, paths);
      expect(explicit.CLAUDE_CODE_OAUTH_TOKEN).toBe(`${FAKE}-mine`);
      expect(explicit[LIVE_TOKEN_SOURCE_VAR]).toBe("environment");
      const none: NodeJS.ProcessEnv = {};
      applyLiveToken(none, { home: join(s.dir, "nohome"), repoEnv: join(s.dir, "missing.env") });
      expect(none.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(none[LIVE_TOKEN_SOURCE_VAR]).toMatch(/^none \(looked up: /);
      for (const v of [empty, explicit, none].map((e) => e[LIVE_TOKEN_SOURCE_VAR] ?? "")) expect(v).not.toContain(FAKE);
    } finally {
      s.done();
    }
  });

  it("the pure module has no import-time side effect on this worker's environment", async () => {
    const before = { t: process.env.CLAUDE_CODE_OAUTH_TOKEN, s: process.env.COWORK_HARNESS_LIVE_TOKEN_SOURCE };
    await import("./setup/live-token-resolve.js");
    expect({ t: process.env.CLAUDE_CODE_OAUTH_TOKEN, s: process.env.COWORK_HARNESS_LIVE_TOKEN_SOURCE }).toEqual(before);
  });

  it("vitest.config.live.ts loads the setup in every worker, and the setup applies it to process.env", () => {
    const cfg = readFileSync(resolve("vitest.config.live.ts"), "utf8");
    expect(cfg).toMatch(/setupFiles:\s*\[[^\]]*"test\/setup\/live-token\.ts"/);
    expect(readFileSync(resolve("test/setup/live-token.ts"), "utf8")).toMatch(/applyLiveToken\(process\.env\)/);
  });

  it("no live suite resolves its own token: each reads process.env, none reads the token file or a .env", () => {
    const files = readdirSync(resolve("test")).filter((f) => /^live-.*\.test\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(resolve("test"), f), "utf8");
      if (/\.cowork-harness-token`\)|parseDotenv|readFileSync\(\s*"\.env"/.test(src)) offenders.push(`${f}: resolves a token itself`);
      if (/\bTOKEN\b/.test(src) && !/const TOKEN = process\.env\.CLAUDE_CODE_OAUTH_TOKEN \?\? "";/.test(src))
        offenders.push(`${f}: TOKEN is not read from process.env`);
    }
    expect(offenders).toEqual([]);
  });
});

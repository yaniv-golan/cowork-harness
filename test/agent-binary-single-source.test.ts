import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Regression guard: `resolveAgentBinary` must be DEFINED exactly once (in src/baseline.ts). It used to be
// duplicated inline in container.ts and hostloop.ts WITHOUT the newest-staged fallback, so the fallback was
// dead on the real runtime paths (a green unit test on the exported copy while the spawn path hard-failed).
// One definition ⇒ every spawn path resolves through the fallback-bearing function. This structural guard is
// the primary protection (there is no noUnusedLocals/ESLint backstop, and no spawn-level behavioral test).

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...srcFiles(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("agent-binary resolution — single source of truth", () => {
  const files = srcFiles("src");

  it("defines resolveAgentBinary exactly once, in src/baseline.ts", () => {
    const defs: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/\bfunction resolveAgentBinary\b/.test(src) || /\bconst resolveAgentBinary\s*=/.test(src)) defs.push(f);
    }
    expect(defs).toEqual([join("src", "baseline.ts")]);
  });

  it("the runtime/chat consumers import resolveAgentBinary from baseline.js (not a local copy)", () => {
    for (const f of ["src/runtime/container.ts", "src/runtime/hostloop.ts", "src/run/chat.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${f} must import resolveAgentBinary from ../baseline.js`).toMatch(
        /import\s*\{[^}]*\bresolveAgentBinary\b[^}]*\}\s*from\s*["']\.\.\/baseline\.js["']/,
      );
    }
  });
});

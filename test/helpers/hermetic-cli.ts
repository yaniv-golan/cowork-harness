import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A package root for the built CLI that does not see this checkout's own `.env`.
 *
 * The CLI auto-loads `<install>/.env` — the file next to `dist/`, found from `import.meta.url` — so a test that
 * spawns `dist/cli.js` from a checkout with a package-root `.env` sees that file's keys, and CI (which has none)
 * does not. This builds a stand-in root in a temp dir: `dist/` is COPIED (Node resolves the entry script's
 * symlinks, so a linked `dist/` would find the real `.env` again) and every other top-level entry is linked, so
 * `node_modules`, `package.json`, `baselines` and the rest resolve as they do in the checkout. `packageEnv`, when
 * given, becomes the stand-in's `.env`. `parent` places the root under a chosen directory (default: a temp dir).
 */
// Every root this process built is removed when it exits, even if the file's own afterAll never runs (a crash,
// a timeout). rmSync removes the links, not what they point to.
const roots = new Set<string>();
let hooked = false;
function removeAtExit(root: string): void {
  roots.add(root);
  if (hooked) return;
  hooked = true;
  process.on("exit", () => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
}

export function hermeticPackageRoot(opts: { packageEnv?: string; parent?: string } = {}): { root: string; cli: string } {
  const repo = resolve(".");
  const parent = opts.parent ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "cwh-pkg-"));
  removeAtExit(root);
  for (const name of readdirSync(repo)) {
    if (name === ".env" || name === "dist" || name === ".git") continue;
    symlinkSync(join(repo, name), join(root, name));
  }
  cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true });
  if (opts.packageEnv !== undefined) writeFileSync(join(root, ".env"), opts.packageEnv);
  return { root, cli: join(root, "dist", "cli.js") };
}

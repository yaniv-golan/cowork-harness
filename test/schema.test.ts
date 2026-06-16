import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSchemas, SCHEMA_DIR } from "../scripts/gen-schema.js";

// Guard: the committed schema/*.schema.json must match what the zod schemas produce.
// If this fails, a zod schema changed without regenerating — run `npm run schema`.
describe("JSON schema is in sync with the zod source", () => {
  const generated = buildSchemas();
  for (const [file, body] of Object.entries(generated)) {
    it(`schema/${file} is up to date (run \`npm run schema\` if this fails)`, () => {
      const committed = readFileSync(join(SCHEMA_DIR, file), "utf8");
      expect(committed).toBe(body);
    });
  }
});

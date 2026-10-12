// `required` means opposite things for a schema a user writes and one the harness writes. In an INPUT schema
// (scenario, session) it constrains the author: dropping it accepts every file the old schema did (a widening),
// adding it can reject a file that used to load (a narrowing, breaking). In an OUTPUT schema (run results,
// cassettes, reports) it is a promise to readers: dropping it breaks a reader that relied on the field.
import { describe, it, expect } from "vitest";
import { diffSurfaces, INPUT_SCHEMAS } from "../scripts/check-surface.js";

const surface = (file: string, leaves: Record<string, object>) => ({ schemas: { [file]: leaves } });

describe("diffSurfaces: required on input and output schemas", () => {
  const base = { ".metrics[]": { type: "object" }, ".metrics[].path": { type: "string", required: true } };
  const optional = { ".metrics[]": { type: "object" }, ".metrics[].path": { type: "string" } };

  it("an input schema that drops a required is widened, not broken", () => {
    const d = diffSurfaces(surface("scenario.schema.json", base), surface("scenario.schema.json", optional));
    expect(d.removed).toEqual([]);
    expect(d.widened).toEqual(["schemas.scenario.schema.json..metrics[].path.required"]);
    expect(d.ok).toBe(true);
  });

  it("an output schema that drops a required is still a removal", () => {
    const d = diffSurfaces(surface("run-result.json", base), surface("run-result.json", optional));
    expect(d.removed).toEqual(["schemas.run-result.json..metrics[].path.required"]);
    expect(d.ok).toBe(false);
  });

  it("an input schema that makes an existing field required narrows it: a change", () => {
    const d = diffSurfaces(surface("session.schema.json", optional), surface("session.schema.json", base));
    expect(d.changed).toEqual(["schemas.session.schema.json..metrics[].path.required"]);
    expect(d.ok).toBe(false);
  });

  it("an input schema that adds a new required field to an existing object narrows it too", () => {
    const cur = { ...optional, ".metrics[].unit": { type: "string", required: true } };
    const d = diffSurfaces(surface("scenario.schema.json", optional), surface("scenario.schema.json", cur));
    expect(d.changed).toEqual(["schemas.scenario.schema.json..metrics[].unit.required"]);
    expect(d.ok).toBe(false);
  });

  it("a required field inside a new optional object is not a narrowing (no old file has the object)", () => {
    const cur = { ...optional, ".extra": { type: "object" }, ".extra.name": { type: "string", required: true } };
    const d = diffSurfaces(surface("scenario.schema.json", optional), surface("scenario.schema.json", cur));
    expect(d.changed).toEqual([]);
    expect(d.ok).toBe(true);
  });

  it("an output schema may add a required field: readers gain a guarantee", () => {
    const d = diffSurfaces(surface("run-result.json", optional), surface("run-result.json", base));
    expect(d.ok).toBe(true);
  });

  it("names exactly the schemas a user writes", () => {
    expect([...INPUT_SCHEMAS].sort()).toEqual(["scenario-multi-leg.schema.json", "scenario.schema.json", "session.schema.json"]);
  });
});

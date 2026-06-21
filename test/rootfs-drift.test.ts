import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dockerfileCorePip,
  parseImageStack,
  nodeMajorDiffers,
  diffStack,
  type ProvisioningManifest,
  type ImageStack,
} from "../scripts/capture-rootfs-manifest.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKERFILE = join(REPO_ROOT, "docker", "Dockerfile.agent");

// A manifest whose pip set mirrors the Dockerfile Layer-A pins plus a couple of apt/npm entries.
function makeManifest(overrides: Partial<ProvisioningManifest> = {}): ProvisioningManifest {
  const corePip = dockerfileCorePip(DOCKERFILE);
  const pip: Record<string, string> = {};
  for (const name of corePip) pip[name] = "1.0.0";
  return {
    capturedFrom: "rootfs.img",
    node: "v22.22.3",
    pip,
    aptDocStack: ["poppler-utils", "ghostscript"],
    npmGlobals: ["docx", "marked"],
    generatedNote: "test",
    ...overrides,
  };
}

function makeStack(overrides: Partial<ImageStack> = {}): ImageStack {
  const corePip = dockerfileCorePip(DOCKERFILE);
  const pip: Record<string, string> = {};
  for (const name of corePip) pip[name] = "1.0.0";
  return {
    node: "v22.22.3",
    pip,
    apt: new Set(["poppler-utils", "ghostscript"]),
    npmGlobals: new Set(["docx", "marked"]),
    ...overrides,
  };
}

describe("drift check covers the WHOLE Layer-A pip contract from the Dockerfile", () => {
  it("parses Layer-A pins (incl. the ones the old CORE_PIP subset omitted)", () => {
    const core = dockerfileCorePip(DOCKERFILE);
    // The packages the hand-maintained CORE_PIP set silently dropped ( evidence).
    for (const p of [
      "pdf2image",
      "img2pdf",
      "pypdfium2",
      "playa-pdf",
      "seaborn",
      "markdownify",
      "marko",
      "mistune",
      "python-dotenv",
      "graphviz",
      "sympy",
    ]) {
      expect(core.has(p)).toBe(true);
    }
  });

  it("does NOT pull in Layer-B (full-parity) pins", () => {
    const core = dockerfileCorePip(DOCKERFILE);
    expect(core.has("opencv-python")).toBe(false);
    expect(core.has("markitdown")).toBe(false);
    expect(core.has("onnxruntime")).toBe(false);
  });

  it("flags a non-CORE_PIP package (seaborn) missing from the image as drift", () => {
    const manifest = makeManifest();
    const stack = makeStack();
    delete stack.pip["seaborn"]; // a package the OLD check would have ignored
    const report = diffStack(stack, manifest, dockerfileCorePip(DOCKERFILE));
    expect(report.missingPip).toContain("seaborn");
  });

  it("greens when the image carries every Layer-A package", () => {
    const report = diffStack(makeStack(), makeManifest(), dockerfileCorePip(DOCKERFILE));
    expect(report.missingPip).toEqual([]);
    expect(report.missingApt).toEqual([]);
    expect(report.missingNpm).toEqual([]);
    expect(report.nodeMismatch).toBe(false);
  });
});

describe("Node version mismatch is drift", () => {
  it("nodeMajorDiffers compares the major version", () => {
    expect(nodeMajorDiffers("v22.22.3", "v22.0.0")).toBe(false);
    expect(nodeMajorDiffers("v20.11.0", "v22.22.3")).toBe(true);
    expect(nodeMajorDiffers("v18.0.0", "v22.22.3")).toBe(true);
  });

  it("diffStack flags a major node mismatch", () => {
    const report = diffStack(makeStack({ node: "v20.11.0" }), makeManifest({ node: "v22.22.3" }), dockerfileCorePip(DOCKERFILE));
    expect(report.nodeMismatch).toBe(true);
  });

  it("does not flag when only the patch differs", () => {
    const report = diffStack(makeStack({ node: "v22.9.0" }), makeManifest({ node: "v22.22.3" }), dockerfileCorePip(DOCKERFILE));
    expect(report.nodeMismatch).toBe(false);
  });

  it("does not flag when the rootfs node is 'unknown'", () => {
    const report = diffStack(makeStack({ node: "v22.22.3" }), makeManifest({ node: "unknown" }), dockerfileCorePip(DOCKERFILE));
    expect(report.nodeMismatch).toBe(false);
  });
});

describe("apt doc-stack and npm globals are diffed", () => {
  it("flags a missing apt doc-stack package", () => {
    const stack = makeStack({ apt: new Set(["poppler-utils"]) }); // ghostscript dropped
    const report = diffStack(stack, makeManifest(), dockerfileCorePip(DOCKERFILE));
    expect(report.missingApt).toContain("ghostscript");
  });

  it("flags a missing npm global", () => {
    const stack = makeStack({ npmGlobals: new Set(["docx"]) }); // marked dropped
    const report = diffStack(stack, makeManifest(), dockerfileCorePip(DOCKERFILE));
    expect(report.missingNpm).toContain("marked");
  });

  it("parseImageStack parses dpkg + npm-parseable sections", () => {
    const stdout = [
      "v22.22.3",
      "###PIP###",
      "numpy==2.2.6",
      "seaborn==0.13.2",
      "###APT###",
      "poppler-utils",
      "ghostscript",
      "###NPM###",
      "/usr/local/lib/node_modules_global/lib/node_modules/docx",
      "/usr/local/lib/node_modules_global/lib/node_modules/marked",
    ].join("\n");
    const stack = parseImageStack(stdout);
    expect(stack.node).toBe("v22.22.3");
    expect(stack.pip["numpy"]).toBe("2.2.6");
    expect(stack.pip["seaborn"]).toBe("0.13.2");
    expect(stack.apt.has("poppler-utils")).toBe(true);
    expect(stack.apt.has("ghostscript")).toBe(true);
    expect(stack.npmGlobals.has("docx")).toBe(true);
    expect(stack.npmGlobals.has("marked")).toBe(true);
    // The `lib` path segment must not be mistaken for a package name.
    expect(stack.npmGlobals.has("lib")).toBe(false);
  });
});

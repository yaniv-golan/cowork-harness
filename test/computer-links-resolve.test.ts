import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type AssertContext } from "../src/assert.js";
import { extractComputerLinks, normalizeHostShapedForReplay, resolveComputerLink } from "../src/run/computer-links.js";
import { replayCassette, buildManifest, CASSETTE_VERSION, type Cassette } from "../src/run/cassette.js";

const SID = "abc123";

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs", ".projects"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}
const pass = (r: ReturnType<typeof evaluate>) => r.every((x) => x.pass);

describe("extractComputerLinks — the three positions + percent-decoding", () => {
  it("markdown-link position", () => {
    const links = extractComputerLinks(`[View your report](computer:///sessions/${SID}/mnt/outputs/report.pdf)`);
    expect(links).toHaveLength(1);
    expect(links[0].raw).toBe(`/sessions/${SID}/mnt/outputs/report.pdf`);
    expect(links[0].vmShaped).toBe(true);
  });

  it("backtick-quoted position — counts as a link form (NOT excluded as code)", () => {
    const links = extractComputerLinks(`See \`computer:///sessions/${SID}/mnt/outputs/report.pdf\` for the file.`);
    expect(links).toHaveLength(1);
    expect(links[0].raw).toBe(`/sessions/${SID}/mnt/outputs/report.pdf`);
  });

  it("bare token position, ending at whitespace", () => {
    const links = extractComputerLinks(`Link: computer:///sessions/${SID}/mnt/outputs/report.pdf done.`);
    expect(links).toHaveLength(1);
    expect(links[0].raw).toBe(`/sessions/${SID}/mnt/outputs/report.pdf`);
  });

  it('bare token position, ending at a bare-token delimiter ("]`\\)', () => {
    const links = extractComputerLinks(`[computer:///sessions/${SID}/mnt/outputs/report.pdf]`);
    expect(links).toHaveLength(1);
    expect(links[0].raw).toBe(`/sessions/${SID}/mnt/outputs/report.pdf`);
  });

  it("percent-decodes per segment (a space encoded as %20)", () => {
    const links = extractComputerLinks(`[View](computer:///sessions/${SID}/mnt/outputs/report%20final.pdf)`);
    expect(links[0].raw).toBe(`/sessions/${SID}/mnt/outputs/report final.pdf`);
  });

  it("classifies a host-shaped link (no /sessions/<id>/mnt/ prefix) as NOT vmShaped", () => {
    const links = extractComputerLinks(`[View](computer:///Users/joe/Project/report.pdf)`);
    expect(links).toHaveLength(1);
    expect(links[0].vmShaped).toBe(false);
    expect(links[0].raw).toBe("/Users/joe/Project/report.pdf");
  });

  it("matches ANY session id in the VM-mount shape (AssertContext carries no sessionId)", () => {
    const links = extractComputerLinks(`computer:///sessions/some-other-session/mnt/outputs/x.txt`);
    expect(links[0].vmShaped).toBe(true);
  });

  it("finds all three forms together, and zero links on plain prose", () => {
    const text =
      `[a](computer:///sessions/${SID}/mnt/outputs/a.pdf) and ` +
      `\`computer:///sessions/${SID}/mnt/outputs/b.pdf\` and ` +
      `computer:///sessions/${SID}/mnt/outputs/c.pdf.`;
    const links = extractComputerLinks(text);
    expect(links.map((l) => l.raw.split("/").pop())).toEqual(["a.pdf", "b.pdf", "c.pdf."]);
    expect(extractComputerLinks("no links here")).toEqual([]);
  });

  it("an unterminated markdown-link opener still extracts the bare URL (a link the display would still show)", () => {
    const links = extractComputerLinks(`[View](computer:///sessions/${SID}/mnt/outputs/report.pdf without a closer`);
    expect(links).toHaveLength(1);
    expect(links[0].raw).toBe(`/sessions/${SID}/mnt/outputs/report.pdf`);
    expect(links[0].vmShaped).toBe(true);
  });

  it("well-formed markdown links are unaffected by the malformed-markdown fallback", () => {
    const links = extractComputerLinks(`[View](computer:///sessions/${SID}/mnt/outputs/report.pdf) and more text`);
    expect(links).toHaveLength(1);
    expect(links[0].raw).toBe(`/sessions/${SID}/mnt/outputs/report.pdf`);
  });
});

describe("normalizeHostShapedForReplay — structural marker + recorded folder prefixes", () => {
  it("normalizes an outputs-mount host path via the structural marker (no recorded prefix needed)", () => {
    expect(normalizeHostShapedForReplay("/tmp/run-xyz/work/session/mnt/outputs/report.pdf", undefined)).toBe("outputs/report.pdf");
  });

  it("normalizes an uploads-mount host path via the structural marker", () => {
    expect(normalizeHostShapedForReplay("/tmp/run-xyz/work/session/mnt/uploads/in.csv", undefined)).toBe("uploads/in.csv");
  });

  it("normalizes a connected-folder host path via a recorded prefix", () => {
    const folderPrefixes = new Map([["/Users/joe/Project", "myproject"]]);
    expect(normalizeHostShapedForReplay("/Users/joe/Project/report.pdf", folderPrefixes)).toBe("myproject/report.pdf");
  });

  it("returns null for a host path matching no marker and no recorded prefix", () => {
    expect(normalizeHostShapedForReplay("/Users/joe/Elsewhere/report.pdf", new Map([["/Users/joe/Project", "myproject"]]))).toBeNull();
  });

  it("picks the LONGEST matching prefix for nested connected folders (insertion order must not win)", () => {
    // Parent declared BEFORE the nested child — a first-match loop would remap via the parent and
    // produce the wrong mount. Longest-prefix wins regardless of Map insertion order.
    const folderPrefixes = new Map([
      ["/Users/me", "home"],
      ["/Users/me/project", "proj"],
    ]);
    expect(normalizeHostShapedForReplay("/Users/me/project/x.txt", folderPrefixes)).toBe("proj/x.txt");
    expect(normalizeHostShapedForReplay("/Users/me/other.txt", folderPrefixes)).toBe("home/other.txt");
  });
});

describe("resolveComputerLink — live mode", () => {
  const root = mkdtempSync(join(tmpdir(), "cwh-links-live-"));
  mkdirSync(join(root, "outputs"), { recursive: true });
  writeFileSync(join(root, "outputs", "report.pdf"), "x");

  it("VM-shaped: resolves against workRoot", () => {
    const link = extractComputerLinks(`computer:///sessions/${SID}/mnt/outputs/report.pdf`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live" });
    expect(outcome.resolved).toBe(true);
    expect(outcome.checkedDescription).toMatch(/work tree/);
  });

  it("VM-shaped: dangling reports the work-tree path checked", () => {
    const link = extractComputerLinks(`computer:///sessions/${SID}/mnt/outputs/missing.pdf`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live" });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/work tree/);
  });

  it("VM-shaped: a traversal escape is rejected as unsafe, not resolved", () => {
    const link = extractComputerLinks(`computer:///sessions/${SID}/mnt/../../../../etc/passwd`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live" });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/unsafe/);
  });

  // VM-shaped live: an agent-created in-tree symlink pointing OUT of workRoot must NOT resolve true by
  // walking onto the host (existsSync follows symlinks; safeJoin is only lexical). Realpath-containment.
  it("VM-shaped: an in-tree symlink whose target escapes workRoot is rejected (no host walk-out)", () => {
    const outside = mkdtempSync(join(tmpdir(), "cwh-links-vm-esc-"));
    writeFileSync(join(outside, "hosts"), "x");
    symlinkSync(outside, join(root, "outputs", "evil")); // outputs/evil -> outside dir
    const link = extractComputerLinks(`computer:///sessions/${SID}/mnt/outputs/evil/hosts`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live" });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/escape|escapes the work root/);
  });

  it("host-shaped: with no hostRoots, an existing real path is evidence-unavailable, never a silent existsSync pass", () => {
    const realFile = join(root, "host-file.txt");
    writeFileSync(realFile, "x");
    const link = extractComputerLinks(`computer://${realFile}`)[0];
    const outcome = resolveComputerLink(link, "/some/unrelated/workroot", { mode: "live" });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/no recorded workspace roots/);
  });

  it("host-shaped: with an empty hostRoots array, same evidence-unavailable outcome as hostRoots absent", () => {
    const realFile = join(root, "host-file2.txt");
    writeFileSync(realFile, "x");
    const link = extractComputerLinks(`computer://${realFile}`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live", hostRoots: [] });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/no recorded workspace roots/);
  });

  it("host-shaped: a nonexistent real path with no hostRoots is also evidence-unavailable", () => {
    const link = extractComputerLinks(`computer:///definitely/not/a/real/path.txt`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live" });
    expect(outcome.resolved).toBe(false);
  });

  it("host-shaped with hostRoots: a link inside a workspace root resolves", () => {
    const realFile = join(root, "outputs", "report.pdf");
    const link = extractComputerLinks(`computer://${realFile}`)[0];
    const outcome = resolveComputerLink(link, "/some/unrelated/workroot", { mode: "live", hostRoots: [root] });
    expect(outcome.resolved).toBe(true);
  });

  it("host-shaped with hostRoots: an EXISTING but out-of-workspace path is dangling, not delivered", () => {
    const outside = mkdtempSync(join(tmpdir(), "cwh-links-outside-"));
    const realFile = join(outside, "secret.txt");
    writeFileSync(realFile, "x");
    const link = extractComputerLinks(`computer://${realFile}`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live", hostRoots: [root] });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/outside the run's workspace roots/);
  });

  it("host-shaped with hostRoots: a sibling-prefix path does not sneak in (root vs root-extra)", () => {
    const sibling = root + "-extra";
    mkdirSync(sibling, { recursive: true });
    const realFile = join(sibling, "f.txt");
    writeFileSync(realFile, "x");
    const link = extractComputerLinks(`computer://${realFile}`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "live", hostRoots: [root] });
    expect(outcome.resolved).toBe(false);
  });

  // #40: an in-root symlink whose target escapes the root must NOT pass containment. Lexically the link
  // path is inside `root`; only realpath dereferencing catches the escape.
  it("host-shaped with hostRoots: an in-root symlink pointing OUTSIDE the root is rejected (not a delivered artifact)", () => {
    const outside = mkdtempSync(join(tmpdir(), "cwh-links-esc-target-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "x");
    const linkPath = join(root, "escape"); // lexically inside root, but symlinks outside
    symlinkSync(secret, linkPath);
    const link = extractComputerLinks(`computer://${linkPath}`)[0];
    const outcome = resolveComputerLink(link, "/some/unrelated/workroot", { mode: "live", hostRoots: [root] });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/outside the run's workspace roots/);
  });

  // #40 guard: a NON-existent in-root path must still classify as in-root (dangling, resolved:false) and
  // NOT regress to "outside workspace roots" — the /var↔/private/var asymmetry must not fire when realpath
  // can't run on a missing candidate.
  it("host-shaped with hostRoots: a non-existent in-root path is dangling-in-root, not outside-roots", () => {
    const missing = join(root, "outputs", "never-created.pdf");
    const link = extractComputerLinks(`computer://${missing}`)[0];
    const outcome = resolveComputerLink(link, "/some/unrelated/workroot", { mode: "live", hostRoots: [root] });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/host path \(direct\)/);
    expect(outcome.checkedDescription).not.toMatch(/outside the run's workspace roots/);
  });
});

describe("resolveComputerLink — replay mode (no filesystem probe of host-shaped links)", () => {
  const root = mkdtempSync(join(tmpdir(), "cwh-links-replay-"));
  mkdirSync(join(root, "outputs"), { recursive: true });
  writeFileSync(join(root, "outputs", "report.pdf"), "x");
  mkdirSync(join(root, "myproject"), { recursive: true });
  writeFileSync(join(root, "myproject", "notes.md"), "x");

  it("VM-shaped resolves against the manifest-materialized workRoot, same as live", () => {
    const link = extractComputerLinks(`computer:///sessions/${SID}/mnt/outputs/report.pdf`)[0];
    expect(resolveComputerLink(link, root, { mode: "replay" }).resolved).toBe(true);
  });

  it("host-shaped normalizes via the outputs structural marker, then resolves against the manifest", () => {
    const link = extractComputerLinks(`computer:///some/recorded/run/work/session/mnt/outputs/report.pdf`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "replay" });
    expect(outcome.resolved).toBe(true);
    expect(outcome.checkedDescription).toMatch(/replay manifest \(normalized from host path\)/);
  });

  it("host-shaped normalizes via a recorded folder prefix, then resolves against the manifest", () => {
    const link = extractComputerLinks(`computer:///Users/joe/Project/notes.md`)[0];
    const folderPrefixes = new Map([["/Users/joe/Project", "myproject"]]);
    expect(resolveComputerLink(link, root, { mode: "replay", folderPrefixes }).resolved).toBe(true);
  });

  it("host-shaped with no recorded prefix and no structural marker is dangling — never probes the live fs", () => {
    const link = extractComputerLinks(`computer:///Users/joe/Elsewhere/notes.md`)[0];
    const outcome = resolveComputerLink(link, root, { mode: "replay" });
    expect(outcome.resolved).toBe(false);
    expect(outcome.checkedDescription).toMatch(/no recorded folder\/outputs\/uploads prefix/);
  });
});

describe("assert.ts — computer_links_resolve", () => {
  it("FAILS when the transcript has zero computer:// links — presence-required", () => {
    const r = evaluate([{ computer_links_resolve: true }], ctx({ transcript: "no links at all", linkResolution: { mode: "live" } }));
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/no computer:\/\/ link|if_present/i);
  });

  it("computer_links_resolve_if_present passes vacuously on zero links", () => {
    const r = evaluate(
      [{ computer_links_resolve_if_present: true }],
      ctx({ transcript: "no links at all", linkResolution: { mode: "live" } }),
    );
    expect(pass(r)).toBe(true);
  });

  it("evidence-unavailable when the transcript sidecar is absent (transcriptMissing)", () => {
    const r = evaluate(
      [{ computer_links_resolve: true }],
      ctx({ transcript: "", transcriptMissing: true, linkResolution: { mode: "live" } }),
    );
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/evidence unavailable.*run\.jsonl/);
  });

  it("evidence-unavailable when links are found but no linkResolution was wired", () => {
    const r = evaluate(
      [{ computer_links_resolve: true }],
      ctx({ transcript: `computer:///sessions/${SID}/mnt/outputs/x.pdf` }), // no linkResolution
    );
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/evidence unavailable/);
  });

  it("passes (live) when every link resolves under workRoot", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-assert-live-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "report.pdf"), "x");
    const r = evaluate(
      [{ computer_links_resolve: true }],
      ctx({
        transcript: `[View your report](computer:///sessions/${SID}/mnt/outputs/report.pdf)`,
        workRoot: root,
        linkResolution: { mode: "live" },
      }),
    );
    expect(pass(r)).toBe(true);
    // Item 12 (--explain): a green computer_links_resolve carries a concrete evidence trail so it isn't
    // trusted blind — it names how many links resolved (the count is the load-bearing distinction from a
    // vacuous pass).
    expect(r[0].evidence).toMatch(/1 computer:\/\/ link\(s\) all resolved/);
  });

  it("computer_links_resolve_if_present carries evidence on a vacuous (zero-link) pass", () => {
    const r = evaluate(
      [{ computer_links_resolve_if_present: true }],
      ctx({ transcript: "no links here", linkResolution: { mode: "live" } }),
    );
    expect(pass(r)).toBe(true);
    expect(r[0].evidence).toMatch(/no computer:\/\/ links.*vacuous pass/);
  });

  it("fails (live) and names the dangling link + which target was checked", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-assert-live2-"));
    const r = evaluate(
      [{ computer_links_resolve: true }],
      ctx({
        transcript: `[View your report](computer:///sessions/${SID}/mnt/outputs/missing.pdf)`,
        workRoot: root,
        effectiveFidelity: "container",
        linkResolution: { mode: "live" },
      }),
    );
    expect(pass(r)).toBe(false);
    expect(r[0].message).toContain("missing.pdf");
    expect(r[0].message).toMatch(/work tree/);
    expect(r[0].message).toMatch(/container/);
  });

  it("passes (live, hostloop) when a host-shaped link's real path exists inside a recorded hostRoot, checked directly", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-assert-live3-"));
    const realFile = join(root, "report.pdf");
    writeFileSync(realFile, "x");
    const r = evaluate(
      [{ computer_links_resolve: true }],
      ctx({
        transcript: `[View your report](computer://${realFile})`,
        workRoot: "/irrelevant",
        effectiveFidelity: "hostloop",
        linkResolution: { mode: "live", hostRoots: [root] },
      }),
    );
    expect(pass(r)).toBe(true);
  });

  it("fails (live, hostloop) evidence-unavailable when a host-shaped link's real path exists but no hostRoots were recorded", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-assert-live4-"));
    const realFile = join(root, "report.pdf");
    writeFileSync(realFile, "x");
    const r = evaluate(
      [{ computer_links_resolve: true }],
      ctx({
        transcript: `[View your report](computer://${realFile})`,
        workRoot: "/irrelevant",
        effectiveFidelity: "hostloop",
        linkResolution: { mode: "live" },
      }),
    );
    expect(pass(r)).toBe(false);
    expect(r[0].message).toMatch(/no recorded workspace roots/);
  });
});

// --- replay-lane classification + manifest matching (via replayCassette directly) ---

const events = (text: string) => [
  JSON.stringify({ type: "system", subtype: "init", tools: [] }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
];

function baseCassette(over: Partial<Cassette> & { text: string }): Cassette {
  return {
    cassetteVersion: CASSETTE_VERSION,
    scenario: {
      name: "t",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "do the thing",
      answers: [],
      expect_denied: [],
      assert: [{ computer_links_resolve: true }],
    },
    events: events(over.text),
    controlOut: [],
    ...over,
  } as unknown as Cassette;
}

describe("replay classification — computer_links_resolve is a manifest key (not alwaysContentKeys)", () => {
  it("is SKIPPED (not evaluated) on a manifest-less cassette — same treatment as file_exists", async () => {
    const cassette = baseCassette({ text: `computer:///sessions/${SID}/mnt/outputs/report.pdf` });
    const result = await replayCassette(cassette);
    expect(result.assertions.some((a) => "computer_links_resolve" in a.assertion)).toBe(false);
    expect(result.skippedAssertions?.full).toBeGreaterThan(0);
  });

  it("IS evaluated when the cassette carries an artifacts manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-replay-manifest-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "report.pdf"), "x");
    const artifacts = buildManifest(root, undefined, ["outputs"]);
    const cassette = baseCassette({ text: `computer:///sessions/${SID}/mnt/outputs/report.pdf`, artifacts });
    const result = await replayCassette(cassette);
    const entry = result.assertions.find((a) => "computer_links_resolve" in a.assertion);
    expect(entry).toBeDefined();
    expect(entry!.pass).toBe(true);
    expect(result.skippedAssertions?.full).toBe(0);
  });

  it("a dangling link fails on replay when the manifest doesn't contain the target", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-replay-manifest2-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "unrelated.txt"), "x"); // non-empty manifest — the missing file is a REAL dangling link, not "no manifest at all"
    const artifacts = buildManifest(root, undefined, ["outputs"]);
    const cassette = baseCassette({ text: `computer:///sessions/${SID}/mnt/outputs/missing.pdf`, artifacts });
    const result = await replayCassette(cassette);
    const entry = result.assertions.find((a) => "computer_links_resolve" in a.assertion);
    expect(entry?.pass).toBe(false);
    expect(entry?.message).toContain("missing.pdf");
  });

  it("host-shaped normalizes via the outputs structural marker on replay (no session/folders needed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-replay-manifest3-"));
    mkdirSync(join(root, "outputs"), { recursive: true });
    writeFileSync(join(root, "outputs", "report.pdf"), "x");
    const artifacts = buildManifest(root, undefined, ["outputs"]);
    const cassette = baseCassette({
      text: `computer:///some/recorded/run/work/session/mnt/outputs/report.pdf`,
      artifacts,
    });
    const result = await replayCassette(cassette);
    const entry = result.assertions.find((a) => "computer_links_resolve" in a.assertion);
    expect(entry?.pass).toBe(true);
  });

  it("v9 cassette WITH a persisted folderPrefixMap resolves via it — NOT the current session (which doesn't even exist)", async () => {
    // Deliberately no session.yaml on disk anywhere — proves the persisted map alone drives resolution.
    const hostFolder = "/some/recorded/host/myproject-src";
    const root = mkdtempSync(join(tmpdir(), "cwh-replay-manifest4b-"));
    mkdirSync(join(root, "myproject-src"), { recursive: true });
    writeFileSync(join(root, "myproject-src", "notes.md"), "x");
    const artifacts = buildManifest(root, undefined, ["myproject-src"]);

    const cassette: Cassette = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "t",
        baseline: "latest",
        session: "(inline)", // no session file to reconstruct from at all
        fidelity: "container",
        prompt: "do the thing",
        answers: [],
        expect_denied: [],
        assert: [{ computer_links_resolve: true }],
      },
      events: events(`computer://${hostFolder}/notes.md`),
      controlOut: [],
      artifacts,
      userVisibleRoots: ["outputs", "myproject-src"],
      folderPrefixMap: [{ from: hostFolder, mount: "myproject-src" }],
    } as unknown as Cassette;
    const result = await replayCassette(cassette, []);
    const entry = result.assertions.find((a) => "computer_links_resolve" in a.assertion);
    expect(entry?.pass).toBe(true);
  });

  it("v9 cassette WITHOUT a persisted folderPrefixMap fails evidence-unavailable — never reconstructs from the current session", async () => {
    // Same fixture as the v8 test above (a real session.yaml with a matching folder), but this cassette
    // is v9+ and carries NO folderPrefixMap. Even though the current-session reconstruction WOULD
    // succeed (proven by the v8 test), a v9+ cassette must refuse to fall back to it.
    const sessionsRoot = mkdtempSync(join(tmpdir(), "cwh-replay-session-v9-"));
    const hostFolder = join(sessionsRoot, "myproject-src");
    mkdirSync(hostFolder, { recursive: true });
    writeFileSync(join(sessionsRoot, "session.yaml"), `folders:\n  - from: ${hostFolder}\n`);

    const root = mkdtempSync(join(tmpdir(), "cwh-replay-manifest4c-"));
    mkdirSync(join(root, "myproject-src"), { recursive: true });
    writeFileSync(join(root, "myproject-src", "notes.md"), "x");
    const artifacts = buildManifest(root, undefined, ["myproject-src"]);

    const cassette: Cassette = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "t",
        baseline: "latest",
        session: "session.yaml",
        fidelity: "container",
        prompt: "do the thing",
        answers: [],
        expect_denied: [],
        assert: [{ computer_links_resolve: true }],
      },
      events: events(`computer://${hostFolder}/notes.md`),
      controlOut: [],
      artifacts,
      userVisibleRoots: ["outputs", "myproject-src"],
      // no folderPrefixMap — unexpected for a v9+ cassette
    } as unknown as Cassette;
    const result = await replayCassette(cassette, [], { cassetteDir: sessionsRoot });
    const entry = result.assertions.find((a) => "computer_links_resolve" in a.assertion);
    expect(entry?.pass).toBe(false);
    expect(entry?.message).toMatch(/evidence unavailable/i);
  });

  // T3 / adversarial-review finding M1 regression guard: a `mode: "r"` connected-folder input is
  // captured BODY-LESS (buildManifest's bodyLessPrefixes), NOT excluded from the manifest. A
  // `computer://` link into that input must resolve identically on the LIVE lane (direct filesystem
  // check against the real host folder) and the REPLAY lane (materializeManifest writes a 0-byte
  // placeholder for the body-less entry, so existsSync still finds it). If this ever regresses to full
  // exclusion, replay would dangle while live still resolves — the exact asymmetry MANIFEST_KEYS exists
  // to prevent.
  it("a read-only (mode:r) folder input, captured body-less, resolves on BOTH live and replay", async () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "cwh-replay-session-ro-"));
    const hostFolder = join(sessionsRoot, "myproject-src");
    mkdirSync(hostFolder, { recursive: true });
    writeFileSync(join(hostFolder, "notes.md"), "read-only input content");
    const sessionPath = join(sessionsRoot, "session.yaml");
    writeFileSync(sessionPath, `folders:\n  - from: ${hostFolder}\n    mode: r\n`);

    const root = mkdtempSync(join(tmpdir(), "cwh-replay-manifest-ro-"));
    mkdirSync(join(root, "myproject-src"), { recursive: true });
    writeFileSync(join(root, "myproject-src", "notes.md"), "read-only input content");
    // Body-less capture: the entry SURVIVES (path + bytes + sha256) but carries no body.
    const artifacts = buildManifest(root, undefined, ["myproject-src"], ["myproject-src"]);
    const entry = artifacts.find((a) => a.path === "myproject-src/notes.md")!;
    expect(entry.body).toBeUndefined();
    expect(entry.truncated).toBe(true);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);

    // LIVE: resolveComputerLink checks the host-shaped path directly on the real filesystem, given
    // the folder's real host source as a recorded hostRoot (as execute.ts always supplies).
    const link = extractComputerLinks(`computer://${hostFolder}/notes.md`)[0];
    const liveOutcome = resolveComputerLink(link, root, { mode: "live", hostRoots: [hostFolder] });
    expect(liveOutcome.resolved).toBe(true);

    // REPLAY: no live filesystem — must resolve from the materialized manifest's 0-byte placeholder.
    // This test is about the body-less/truncated-entry resolution path, not folderPrefixMap persistence
    // itself, so the map is supplied directly (v9+ resolves via the persisted map, not session reconstruction).
    const cassette: Cassette = {
      cassetteVersion: CASSETTE_VERSION,
      scenario: {
        name: "t",
        baseline: "latest",
        session: "session.yaml",
        fidelity: "container",
        prompt: "do the thing",
        answers: [],
        expect_denied: [],
        assert: [{ computer_links_resolve: true }],
      },
      events: events(`computer://${hostFolder}/notes.md`),
      controlOut: [],
      artifacts,
      userVisibleRoots: ["outputs", "myproject-src"], // full root set — body-less, not excluded
      folderPrefixMap: [{ from: hostFolder, mount: "myproject-src" }],
    } as unknown as Cassette;
    const result = await replayCassette(cassette, [], { cassetteDir: sessionsRoot });
    const replayEntry = result.assertions.find((a) => "computer_links_resolve" in a.assertion);
    expect(replayEntry?.pass).toBe(true);
  });

  // Round-trip guard (v8): the per-entry `truncationReason` → replay wiring. buildManifest stamps a
  // mode:r input entry `truncationReason: "readonly"`, and replayCassette reads it off the materialized
  // manifest (truncatedPaths, a Map<path,reason>) to give artifact_json the PRECISE remedy. Unit tests
  // that hand a ctx directly can't catch a regression in that wiring; this drives replayCassette
  // end-to-end, plus a "size" control proving the per-entry reason (not the truncated flag alone)
  // drives the branch.
  it("replayCassette reads per-entry truncationReason → artifact_json gets the precise remedy", async () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-replay-ajt-ro-"));
    mkdirSync(join(root, "carta"), { recursive: true });
    writeFileSync(join(root, "carta", "input.json"), JSON.stringify({ a: 1 }));
    const roArtifacts = buildManifest(root, undefined, ["carta"], ["carta"]);
    const entry = roArtifacts.find((a) => a.path === "carta/input.json")!;
    expect(entry.truncated).toBe(true);
    expect(entry.truncationReason).toBe("readonly"); // buildManifest stamped the reason

    const mk = (artifacts: typeof roArtifacts): Cassette =>
      ({
        cassetteVersion: CASSETTE_VERSION,
        scenario: {
          name: "t",
          baseline: "latest",
          session: "(inline)",
          fidelity: "container",
          prompt: "p",
          answers: [],
          expect_denied: [],
          assert: [{ artifact_json: { artifact: "carta/input.json", path: "a", equals: 1 } }],
        },
        events: [],
        controlOut: [],
        artifacts,
        userVisibleRoots: ["outputs", "carta"],
      }) as unknown as Cassette;

    // truncationReason "readonly" → precise read-only remedy.
    const ro = await replayCassette(mk(roArtifacts), []);
    const ajRo = ro.assertions.find((a) => "artifact_json" in a.assertion)!;
    expect(ajRo.pass).toBe(false);
    expect(ajRo.message).toMatch(/read-only connected-folder input/i);
    expect(ajRo.message).not.toMatch(/--max-artifact-bytes/i);

    // Control — same truncated entry but reason "size" → over-cap remedy, proving the PER-ENTRY reason
    // (not the truncated flag alone) drives the branch.
    const sizeArtifacts = roArtifacts.map((a) => (a.path === "carta/input.json" ? { ...a, truncationReason: "size" as const } : a));
    const sz = await replayCassette(mk(sizeArtifacts), []);
    const ajSz = sz.assertions.find((a) => "artifact_json" in a.assertion)!;
    expect(ajSz.pass).toBe(false);
    expect(ajSz.message).toMatch(/--max-artifact-bytes/i);
    expect(ajSz.message).not.toMatch(/read-only connected-folder input/i);
  });
});

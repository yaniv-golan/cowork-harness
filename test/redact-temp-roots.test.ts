import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactText, findShadowedPatterns, type RedactionPolicy } from "../src/redact.js";
import { scanText } from "../src/scan.js";
import { scanCassette, redactCassette } from "../src/run/cassette.js";
import { normalizeHostShapedForReplay } from "../src/run/computer-links.js";

/**
 * A run dir under a TEMP root records its raw host path into tool results and `computer://` links, and
 * that path carries the operator's username — most often inside a SLUGGED segment, not a `/Users/<u>/`
 * one: a Claude session scratchpad lives at `/private/tmp/claude-<uid>/-Users-<user>-<project>/…`.
 *
 * Both privacy layers missed it. The packaged reference policy rewrote only `/Users/`, `/home/`,
 * `/root/`, and the scanner's `path` class had no `/private/tmp/` and no notion of a slugged home segment
 * — so `verify-cassettes` called such a recording clean. Separately, the scanner's boundary rejected a
 * preceding `/`, so a root path inside a `computer:///…` URI was never flagged at all.
 *
 * Synthetic username only (`alice`). The policy is loaded from the repo root, the same way
 * redact-pattern-order.test.ts does, so this exercises the file that `init-redact` ships.
 */

const POLICY_JSON = JSON.parse(readFileSync(resolve(".cowork-redact.json"), "utf8")) as {
  patterns: { regex: string; label?: string; flags?: string }[];
};
const POLICY: RedactionPolicy = {
  patterns: POLICY_JSON.patterns.map((p) => ({ re: new RegExp(p.regex, p.flags ?? "g"), label: p.label ?? "redacted" })),
  keyNames: [],
};

const MAC_SCRATCH = "/private/tmp/claude-501/-Users-alice-code-x/0f3e/scratchpad/run/r1/work/session/mnt/outputs/report.md";
const MAC_SCRATCH_NOREAL = "/tmp/claude-501/-Users-alice-code-x/0f3e/scratchpad/run/r1/work/session/mnt/outputs/report.md";
const LINUX_SCRATCH = "/tmp/claude-1000/-home-alice-code-x/0f3e/scratchpad/run/r1/work/session/mnt/outputs/report.md";
const VAR_FOLDERS = "/var/folders/ab/xyz123/T/cowork-run-alice/work/session/mnt/outputs/report.md";
const PRIVATE_VAR_FOLDERS = "/private/var/folders/ab/xyz123/T/cowork-run-alice/work/session/mnt/outputs/report.md";

const pathFindings = (text: string) => scanText(text, "t", []).filter((f) => f.cls === "path");

describe("reference redaction policy — temp-root host paths", () => {
  for (const [name, p] of [
    ["macOS scratchpad (/private/tmp)", MAC_SCRATCH],
    ["macOS scratchpad, not realpath'd (/tmp)", MAC_SCRATCH_NOREAL],
    ["Linux scratchpad (/tmp, -home- slug)", LINUX_SCRATCH],
    ["macOS os.tmpdir() (/var/folders)", VAR_FOLDERS],
    ["macOS os.tmpdir() realpath (/private/var/folders)", PRIVATE_VAR_FOLDERS],
  ] as const) {
    it(`removes the username from a ${name} computer:// link and keeps it resolvable`, () => {
      const link = `[View report.md](computer://${p})`;
      const red = redactText(link, POLICY);
      expect(red).not.toContain("alice");
      expect(red).toContain("[REDACTED:local-path:");
      // The /mnt/ tail survives, so the redacted link still normalizes on replay.
      expect(red).toContain("/mnt/outputs/report.md)");
      const inner = red.slice(red.indexOf("computer://") + "computer://".length, -1);
      expect(normalizeHostShapedForReplay(inner, undefined)).toBe("outputs/report.md");
    });
  }

  it("removes the username from a bare tool-result path with no /mnt/ tail", () => {
    const red = redactText("wrote /private/tmp/claude-501/-Users-alice-code-x/0f3e/scratchpad/notes.txt ok", POLICY);
    expect(red).not.toContain("alice");
    const red2 = redactText("cwd=/tmp/claude-1000/-home-alice-code-x/0f3e/scratchpad", POLICY);
    expect(red2).not.toContain("alice");
  });

  it("keeps its lookahead-anchored rules ahead of their bare twins", () => {
    expect(findShadowedPatterns(POLICY_JSON.patterns.map((p) => p.regex))).toEqual([]);
  });

  it("does not touch in-VM paths that carry no host information", () => {
    for (const s of [
      "computer:///sessions/local_4m8v794axu/mnt/outputs/report.md",
      '"messaging_socket_path":"/tmp/cc-socks/71701.sock"',
      "HOME=/tmp and /tmp/.claude/settings.json",
    ])
      expect(redactText(s, POLICY)).toBe(s);
  });
});

describe("scanner path class — temp roots, slugged home segments, URI-wrapped paths", () => {
  for (const p of [MAC_SCRATCH, MAC_SCRATCH_NOREAL, LINUX_SCRATCH, VAR_FOLDERS, PRIVATE_VAR_FOLDERS]) {
    it(`flags ${p.split("/").slice(0, 4).join("/")}/… as plain text`, () => {
      const f = pathFindings(`wrote ${p}`);
      expect(f.length).toBeGreaterThan(0);
      expect(f.some((x) => x.sample.includes("alice"))).toBe(true);
    });
    it(`flags ${p.split("/").slice(0, 4).join("/")}/… inside a computer:// link`, () => {
      const f = pathFindings(`[View report.md](computer://${p})`);
      expect(f.some((x) => x.sample.includes("alice"))).toBe(true);
    });
  }

  it("flags a /Users/ path inside a computer:// or file:// URI (the boundary used to reject the URI's slash)", () => {
    expect(pathFindings("[x](computer:///Users/alice/proj/mnt/outputs/f.md)").length).toBeGreaterThan(0);
    expect(pathFindings("see file:///home/alice/notes.md").length).toBeGreaterThan(0);
  });

  it("does NOT flag in-VM / host-neutral paths", () => {
    for (const s of [
      "computer:///sessions/local_4m8v794axu/mnt/outputs/report.md",
      '"messaging_socket_path":"/tmp/cc-socks/71701.sock"',
      "HOME=/tmp and /tmp/.claude/settings.json",
      "an at-home-care plan and a well-rooted-tree",
      "flags --home-dir and -Users-only are prose here",
    ])
      expect(pathFindings(s)).toEqual([]);
  });

  it("a whole-token --allow-path still clears a slug finding", () => {
    const f = scanText("/tmp/claude-1000/-home-alice-code-x/scratchpad", "t", [{ cls: "path", re: /-home-alice-code-x/ }]);
    expect(f.filter((x) => x.cls === "path")).toEqual([]);
  });
});

describe("verify-cassettes surface — scanCassette before and after the reference policy", () => {
  const events = [
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: `File created successfully at: ${MAC_SCRATCH}`,
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: `ls ${VAR_FOLDERS}` }] },
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_3", content: `cwd ${LINUX_SCRATCH}` }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", result: `Done. [View report.md](computer://${MAC_SCRATCH})` }),
  ];
  const cassette = () =>
    ({
      scenario: { name: "c", baseline: "latest", session: "(inline)", fidelity: "container", prompt: "hi", answers: [], assert: [] },
      events,
    }) as never;

  it("an unredacted temp-root recording is NOT clean", () => {
    // Only the /private/tmp + slug + computer:// lines — the /var/folders line was already flagged before
    // this fix, and would make this assertion pass for the wrong reason.
    const only = { ...(cassette() as object), events: [events[0], events[2], events[3]] } as never;
    const f = scanCassette(only, []).filter((x) => x.cls === "path");
    expect(f.length).toBeGreaterThan(0);
    expect(f.some((x) => x.sample.includes("alice"))).toBe(true);
  });

  it("the same recording after the reference policy is clean and carries no username", () => {
    const red = redactCassette(cassette(), POLICY) as unknown as { events: string[] };
    expect(JSON.stringify(red)).not.toContain("alice");
    expect(scanCassette(red as never, []).filter((x) => x.cls === "path")).toEqual([]);
  });
});

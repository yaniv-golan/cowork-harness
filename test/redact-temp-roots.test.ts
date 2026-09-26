import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactText, redactJsonLine, findShadowedPatterns, type RedactionPolicy } from "../src/redact.js";
import { hostPathLeaked } from "../src/run/execute.js";
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
    const text = "/tmp/claude-1000/-home-alice-code-x/scratchpad";
    // Precondition: without the allow the finding EXISTS, so the cleared case below is not vacuous.
    expect(pathFindings(text).map((x) => x.sample)).toEqual(["-home-alice-code-x"]);
    const f = scanText(text, "t", [{ cls: "path", re: /-home-alice-code-x/ }]);
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

/**
 * A slug can carry the username with NO path in front of it: `ls ~/.claude/projects` prints one slug per
 * line, `~/.claude.json` keys its projects by slug, and a tool result can simply begin with one. The slug
 * rule therefore accepts a segment start of string-start, `/`, a quote, or a newline (the two-char `\n`
 * too, since the scanner reads raw JSON lines) — but NOT a space, so ` -Users-only` in prose stays clean.
 */
describe("slugged home segment — boundaries beyond `/`", () => {
  const LS_OUTPUT = "-Users-alice-code-x\n-home-alice-proj-y\n";
  const CLAUDE_JSON = JSON.stringify({ projects: { "-Users-alice-code-x": { allowedTools: [] } } });

  it("scanner flags a slug at string start, after a newline, and as a quoted JSON key", () => {
    expect(pathFindings("-Users-alice-code-x").map((f) => f.sample)).toEqual(["-Users-alice-code-x"]);
    expect(pathFindings(`total 2\n${LS_OUTPUT}`).map((f) => f.sample)).toEqual(["-Users-alice-code-x", "-home-alice-proj-y"]);
    // a raw event line: the newline is the two-char escape `\\n`, the key is preceded by a quote
    const rawLine = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: `total 2\n${LS_OUTPUT}` }] } });
    expect(pathFindings(rawLine).filter((f) => f.sample.includes("alice")).length).toBe(2);
    expect(pathFindings(CLAUDE_JSON).some((f) => f.sample.includes("alice"))).toBe(true);
  });

  it("reference policy removes the username in each of those shapes", () => {
    expect(redactText("-Users-alice-code-x", POLICY)).not.toContain("alice");
    expect(redactText(`total 2\n${LS_OUTPUT}`, POLICY)).not.toContain("alice");
    expect(redactJsonLine(CLAUDE_JSON, POLICY)).not.toContain("alice");
  });

  it("a slug after a SPACE in prose is still left alone by both layers", () => {
    const prose = "flags --home-dir and -Users-only are prose here";
    expect(pathFindings(prose)).toEqual([]);
    expect(redactText(prose, POLICY)).toBe(prose);
  });

  it("a slug-shaped segment in an http(s) URL is not a host path", () => {
    const url = "see https://example.com/-home-page-x and https://h.test/p/-Users-alice-code-x/edit";
    expect(pathFindings(url)).toEqual([]);
    expect(redactText(url, POLICY)).toBe(url);
  });

  it("documented false positive: a directory literally named `-home-…` inside the VM is flagged; --allow-path clears it", () => {
    const vm = "/sessions/local_x/mnt/outputs/-home-x/notes.md";
    expect(pathFindings(vm).map((f) => f.sample)).toEqual(["-home-x"]);
    expect(scanText(vm, "t", [{ cls: "path", re: /-home-x/ }]).filter((f) => f.cls === "path")).toEqual([]);
  });
});

describe("scanner/policy parity on case, file://host and the macOS data-volume path", () => {
  it("the reference policy fixes case variants the (case-insensitive) scanner flags", () => {
    for (const s of ["cwd /users/alice/proj/x", "wrote /PRIVATE/TMP/claude-501/-Users-alice-code-x/f.md", "at /Home/alice/y"]) {
      expect(pathFindings(s).length).toBeGreaterThan(0);
      const red = redactText(s, POLICY);
      expect(red).not.toMatch(/alice/i);
      expect(pathFindings(red)).toEqual([]);
    }
  });

  it("flags file://localhost/Users/… (a file URI with a host part)", () => {
    expect(pathFindings("open file://localhost/Users/alice/notes.md").some((f) => f.sample.includes("alice"))).toBe(true);
  });

  it("flags /System/Volumes/Data/Users/… and the policy clears it", () => {
    const s = "mounted at /System/Volumes/Data/Users/alice/proj/f.md";
    expect(pathFindings(s).some((f) => f.sample.includes("alice"))).toBe(true);
    const red = redactText(s, POLICY);
    expect(red).not.toContain("alice");
    expect(pathFindings(red)).toEqual([]);
  });
});

describe("hostPathLeaked (live transcript_no_host_path signal)", () => {
  it("catches a host path inside a computer:// link and a /private/tmp run path", () => {
    expect(hostPathLeaked("[v](computer:///Users/alice/proj/mnt/outputs/f.md)")).toBe(true);
    expect(hostPathLeaked("wrote /private/tmp/claude-501/x/scratchpad/f.md")).toBe(true);
    expect(hostPathLeaked("[v](computer:///private/tmp/claude-501/x/mnt/outputs/f.md)")).toBe(true);
  });

  it("still ignores in-VM paths", () => {
    expect(hostPathLeaked("[v](computer:///sessions/local_x/mnt/outputs/f.md)")).toBe(false);
    expect(hostPathLeaked("socket /tmp/cc-socks/1.sock and HOME=/tmp")).toBe(false);
  });
});

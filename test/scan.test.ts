import { describe, it, expect } from "vitest";
import { scanText, DEFAULT_SCAN_PATTERNS } from "../src/scan.js";

describe("scanText — default PII heuristics (email + currency + domain + path + machine-inventory)", () => {
  it("flags an email", () => {
    const f = scanText("reach alice@acme.com today", "transcript", []);
    expect(f.some((x) => x.cls === "email")).toBe(true);
  });
  it("flags a currency figure", () => {
    const f = scanText("raised $1,250,000 last round", "transcript", []);
    expect(f.some((x) => x.cls === "currency")).toBe(true);
  });
  it("flags a bare domain", () => {
    const f = scanText("see customer.io for details", "transcript", []);
    expect(f.some((x) => x.cls === "domain")).toBe(true);
  });
  it("clean synthetic text → no findings", () => {
    expect(scanText("the quick brown fox jumped", "transcript", [])).toEqual([]);
  });
  it("does NOT flag multi-word proper names (opt-in only, not a default class)", () => {
    const f = scanText("Jane Doe met Acme Corp", "transcript", []);
    expect(f).toEqual([]);
  });
  it("allowlist suppresses a WHOLE-TOKEN match (synthetic / public reference name)", () => {
    const f = scanText("contact us at hello@acme.com", "transcript", [/hello@acme\.com/i]);
    expect(f.some((x) => x.cls === "email")).toBe(false);
  });
  it("F-2: a bare-domain allow does NOT bleed into the email class (substring no longer suppresses)", () => {
    // `acme\.com` is a substring of the email token `hello@acme.com`; under the old substring matcher this
    // silently cleared the email finding. Anchored whole-token matching keeps the email tripwire live.
    const f = scanText("contact us at hello@acme.com and see acme.com", "transcript", [/acme\.com/i]);
    expect(f.some((x) => x.cls === "email")).toBe(true); // email survives
    expect(f.some((x) => x.cls === "domain")).toBe(false); // bare domain acme.com still suppressed (whole token)
  });
  it("class-scoped allow only suppresses its own class", () => {
    const text = "contact us at hello@acme.com and see acme.com";
    // domain-scoped allow clears the domain finding but leaves email
    const dom = scanText(text, "transcript", [{ cls: "domain", re: /acme\.com/i }]);
    expect(dom.some((x) => x.cls === "domain")).toBe(false);
    expect(dom.some((x) => x.cls === "email")).toBe(true);
    // email-scoped allow clears the email finding but leaves domain
    const eml = scanText(text, "transcript", [{ cls: "email", re: /hello@acme\.com/i }]);
    expect(eml.some((x) => x.cls === "email")).toBe(false);
    expect(eml.some((x) => x.cls === "domain")).toBe(true);
  });
  it("each default pattern carries a class label", () => {
    expect(DEFAULT_SCAN_PATTERNS.map((p) => p.cls).sort()).toEqual(["currency", "domain", "email", "machine-inventory", "path"]);
  });
  it("flags a macOS host path", () => {
    const f = scanText("see /Users/alice/project/notes.md for details", "transcript", []);
    expect(f.some((x) => x.cls === "path" && x.sample.includes("/Users/alice"))).toBe(true);
  });
  it("flags a Linux host path under /home/", () => {
    const f = scanText("logs at /home/bob/.cache/thing", "transcript", []);
    expect(f.some((x) => x.cls === "path")).toBe(true);
  });
  it("flags a root-owned path under /root/", () => {
    const f = scanText("config in /root/.config/app", "transcript", []);
    expect(f.some((x) => x.cls === "path")).toBe(true);
  });
  it("does NOT flag an in-VM /sessions/ mount path (not a host root)", () => {
    const f = scanText("mounted at /sessions/abc123/mnt/outputs/x.json", "transcript", []);
    expect(f.some((x) => x.cls === "path")).toBe(false);
  });
  it("does NOT flag a bare word containing 'home' or 'users' as a substring (anchored to the path root)", () => {
    // "whatever/home/x" and "myusers/database" must not match — the root must be preceded by a boundary,
    // matching hostPathLeaked's proven anchoring approach in src/run/execute.ts.
    const f = scanText("see whatever/home/x and myusers/database for the schema", "transcript", []);
    expect(f.some((x) => x.cls === "path")).toBe(false);
  });
  it("path sample has no leading boundary junk (lookbehind, not a capturing group)", () => {
    const f = scanText('"cwd":"/Users/alice/x"', "events[17]", []);
    expect(f.find((x) => x.cls === "path")?.sample).toBe("/Users/alice/x");
  });
  it("allowlist suppresses a specific path finding (--allow-path equivalent)", () => {
    const f = scanText("see /Users/alice/project", "transcript", [{ cls: "path", re: /\/Users\/alice\/project/ }]);
    expect(f.some((x) => x.cls === "path")).toBe(false);
  });
  it("class-scoped path allow does not bleed into other classes", () => {
    const text = "contact alice@acme.com, path /Users/alice/x";
    const f = scanText(text, "transcript", [{ cls: "path", re: /\/Users\/alice\/x/ }]);
    expect(f.some((x) => x.cls === "email")).toBe(true); // email survives — path allow is scoped
    expect(f.some((x) => x.cls === "path")).toBe(false);
  });
  it("flags the machine-inventory sentinel, sample bounded at the phrase (not the app list)", () => {
    // SYNTHETIC app list only — never a real captured one, per the pattern's own comment.
    const f = scanText("Available applications on this machine: AppOne, AppTwo, AppThree, DevTool, NoteApp", "transcript", []);
    const hit = f.find((x) => x.cls === "machine-inventory");
    expect(hit).toBeDefined();
    expect(hit?.sample).toBe("Available applications on this machine:");
    expect(hit?.sample.includes("AppOne")).toBe(false);
  });
  it("flags a machine-inventory phrasing variant: 'installed on this system'", () => {
    const f = scanText("Applications installed on this system: FooApp, BarApp", "transcript", []);
    expect(f.some((x) => x.cls === "machine-inventory")).toBe(true);
  });
  it("flags a machine-inventory phrasing variant: 'running processes on this machine'", () => {
    const f = scanText("running processes on this machine", "transcript", []);
    expect(f.some((x) => x.cls === "machine-inventory")).toBe(true);
  });
  it("does NOT flag prose app mentions", () => {
    const f = scanText("use Slack and 1Password to share credentials", "transcript", []);
    expect(f.some((x) => x.cls === "machine-inventory")).toBe(false);
  });
  it("does NOT flag an enumerated integration list without the sentinel", () => {
    const f = scanText("integrates with Slack, Notion, Google Drive, Linear, and Airtable", "transcript", []);
    expect(f.some((x) => x.cls === "machine-inventory")).toBe(false);
  });
  it("does NOT flag near-miss prose ('install the app on this machine')", () => {
    const f = scanText("install the app on this machine", "transcript", []);
    expect(f.some((x) => x.cls === "machine-inventory")).toBe(false);
  });
  it("allowlist suppresses a machine-inventory finding (--allow-machine-inventory equivalent)", () => {
    const f = scanText("Available applications on this machine: AppOne, AppTwo", "transcript", [
      { cls: "machine-inventory", re: /Available applications on this machine:/ },
    ]);
    expect(f.some((x) => x.cls === "machine-inventory")).toBe(false);
  });
  it("class-scoped machine-inventory allow does not bleed into other classes", () => {
    const text = "contact alice@acme.com. Available applications on this machine: AppOne, AppTwo";
    const f = scanText(text, "transcript", [{ cls: "machine-inventory", re: /Available applications on this machine:/ }]);
    expect(f.some((x) => x.cls === "email")).toBe(true); // email survives — machine-inventory allow is scoped
    expect(f.some((x) => x.cls === "machine-inventory")).toBe(false);
  });
});

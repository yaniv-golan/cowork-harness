// Per-file wall time from vitest's JSON reporter, slowest first. CI's floor job appends this to its test log, so a
// slow or stuck file on the engines floor shows up by name even when the run passes.
// Usage: tsx scripts/ci/vitest-file-timing.ts <vitest json report> [top N, default 40]
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";

interface FileResult {
  name?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
}

export interface FileTiming {
  file: string;
  status: string;
  ms: number;
}

/** One row per test file that has both timestamps, slowest first. A file without them is left out, not guessed. */
export function fileTimings(report: { testResults?: FileResult[] }, cwd = process.cwd()): FileTiming[] {
  const rows: FileTiming[] = [];
  for (const r of report.testResults ?? []) {
    if (typeof r.startTime !== "number" || typeof r.endTime !== "number" || !r.name) continue;
    rows.push({ file: relative(cwd, r.name), status: r.status ?? "unknown", ms: Math.max(0, r.endTime - r.startTime) });
  }
  return rows.sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
}

export function formatTimings(rows: FileTiming[], top: number, total: number): string {
  const lines = [`== per-file wall time (slowest ${Math.min(top, rows.length)} of ${total} files) ==`];
  for (const r of rows.slice(0, top)) lines.push(`${(r.ms / 1000).toFixed(1).padStart(8)}s  ${r.status.padEnd(7)} ${r.file}`);
  return lines.join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [path, topArg] = process.argv.slice(2);
  if (!path) {
    process.stderr.write("usage: vitest-file-timing.ts <vitest json report> [top N]\n");
    process.exitCode = 2;
  } else {
    const report = JSON.parse(readFileSync(path, "utf8")) as { testResults?: FileResult[] };
    const rows = fileTimings(report);
    process.stdout.write(formatTimings(rows, Number(topArg) > 0 ? Number(topArg) : 40, (report.testResults ?? []).length));
  }
}

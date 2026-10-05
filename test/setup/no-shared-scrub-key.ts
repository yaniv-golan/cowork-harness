import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A run writes its installation key (`scrubset.key`) BESIDE its runs root. A test whose runs root is a direct
// child of the system temp dir would leave one shared, persistent `$TMPDIR/scrubset.key` that every such test then
// reads: tests stop being independent and a stray key outlives the suite. Fail the run when the suite creates it.
// Nest the runs root one level (`join(mkdtempSync(join(tmpdir(), "x-")), "runs")`) instead.
export default function setup(): () => void {
  const shared = join(tmpdir(), "scrubset.key");
  const before = existsSync(shared);
  return () => {
    if (!before && existsSync(shared))
      throw new Error(
        `the test suite created a shared ${shared}: a test's runs root is a direct child of the temp dir — nest it one level so the key lands in that test's own temp dir`,
      );
  };
}

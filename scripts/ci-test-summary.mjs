// Reads each workspace's vitest JSON report and prints GitHub annotations with
// the counts, so a run's results are visible without opening the logs.
// Exits 1 if any test was skipped: in CI every suite, database ones included, must run.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const roots = ["packages", "apps"];
let skipped = 0;
let failed = 0;
let found = 0;

for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const dir of readdirSync(root)) {
    const file = path.join(root, dir, "test-results.json");
    if (!existsSync(file)) continue;
    found++;
    const r = JSON.parse(readFileSync(file, "utf8"));
    const s = r.numPendingTests + (r.numTodoTests ?? 0);
    skipped += s;
    failed += r.numFailedTests;
    const suites = r.testResults.map((t) => `${path.basename(t.name)} (${t.assertionResults.length})`).join(", ");
    console.log(
      `::notice title=${root}/${dir} tests::${r.numPassedTests} passed, ${r.numFailedTests} failed, ${s} skipped of ${r.numTotalTests} — ${suites}`,
    );
    for (const t of r.testResults) {
      for (const a of t.assertionResults) {
        if (a.status === "failed") {
          const msg = (a.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 300);
          console.log(`::error title=FAIL ${a.fullName}::${msg}`);
        } else if (a.status === "pending" || a.status === "skipped" || a.status === "todo") {
          console.log(`::warning title=SKIPPED::${a.fullName}`);
        }
      }
      if (t.status === "failed" && t.assertionResults.length === 0) {
        console.log(`::error title=Suite failed to load ${path.basename(t.name)}::${String(t.message).split("\n")[0].slice(0, 300)}`);
      }
    }
  }
}

if (!found) {
  console.log("::error::No test reports found");
  process.exit(1);
}
if (skipped || failed) process.exit(1);

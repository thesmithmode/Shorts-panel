import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import libCoverage from "istanbul-lib-coverage";
const { createCoverageMap } = libCoverage;
import libSourceMaps from "istanbul-lib-source-maps";
const { createSourceMapStore } = libSourceMaps;
import libReport from "istanbul-lib-report";
const { createContext } = libReport;
import reports from "istanbul-reports";
function run(command: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extra },
  });
  if (result.status !== 0)
    throw new Error(`Coverage command failed: ${command} (${result.status})`);
}
rmSync("coverage", { recursive: true, force: true });
mkdirSync("coverage", { recursive: true });
try {
  run("npm", ["run", "build"], { VITE_COVERAGE: "true" });
  run(
    resolve("node_modules/.bin/c8"),
    ["node", "--import", "tsx", "scripts/coverage-suite.ts"],
    { SHORTS_BROWSER_COVERAGE: resolve("coverage/browser.json") },
  );
  const map = createCoverageMap(
    JSON.parse(readFileSync("coverage/coverage-final.json", "utf8")),
  );
  const browser = createCoverageMap({});
  for (const part of JSON.parse(
    readFileSync("coverage/browser.json", "utf8"),
  )) {
    if (!part) throw new Error("Browser instrumentation missing");
    browser.merge(part);
  }
  const remapped = await createSourceMapStore().transformCoverage(browser);
  const files = remapped.files();
  if (!files.some((p) => p.endsWith("/App.tsx")))
    throw new Error("Browser source maps missing");
  // Replace c8 all-files placeholders with actual browser statement/branch counters.
  const combined = createCoverageMap({});
  for (const file of map.files())
    if (!file.includes("/src/web/") || !files.includes(file))
      combined.addFileCoverage(map.fileCoverageFor(file));
  combined.merge(remapped);
  const context = createContext({ dir: "coverage", coverageMap: combined });
  for (const name of ["text", "json", "json-summary", "lcovonly"] as const)
    reports.create(name).execute(context);
  const summary = combined.getCoverageSummary();
  const thresholds = JSON.parse(readFileSync(".c8rc.json", "utf8"));
  let failed = false;
  for (const metric of [
    "lines",
    "statements",
    "branches",
    "functions",
  ] as const) {
    const value = summary[metric].pct;
    const threshold = thresholds[metric];
    if (!Number.isFinite(threshold) || threshold < 90)
      throw new Error("Coverage threshold cannot be below 90%");
    if (!Number.isFinite(value) || value < threshold) {
      console.error(`Coverage ${metric}: ${value}% < ${threshold}%`);
      failed = true;
    }
  }
  // Coverage reports must contain executable counters for each UI module.
  for (const file of combined
    .files()
    .filter((f) => f.includes("/src/web/") && !f.endsWith("/main.tsx"))) {
    const s = combined.fileCoverageFor(file).toSummary();
    if (s.functions.total === 0)
      throw new Error(`Missing executable UI counters: ${file}`);
  }
  if (failed && !process.argv.includes("--report-only")) process.exitCode = 1;
} finally {
  // Never leave an instrumented build as the production artifact.
  run("npm", ["run", "build"], { VITE_COVERAGE: "false" });
}

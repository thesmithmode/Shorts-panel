import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const script of [
  [
    "--import",
    "tsx",
    "--test",
    "--test-isolation=none",
    ...readdirSync("tests")
      .filter((n) => n.endsWith(".test.ts"))
      .map((n) => "tests/" + n),
  ],
  ["--import", "tsx", "scripts/smoke.ts"],
]) {
  const result = spawnSync(process.execPath, script, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

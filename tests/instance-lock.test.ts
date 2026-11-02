import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { acquireInstanceLock } from "../src/server/instance-lock.ts";

test("one worker per data directory, and lock is released when owner exits", () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-instance-"));
  const another = mkdtempSync(join(tmpdir(), "shorts-instance-other-"));
  let release = () => {};
  let releaseOther = () => {};
  try {
    release = acquireInstanceLock(dir);
    releaseOther = acquireInstanceLock(another);
    assert.throws(() => acquireInstanceLock(dir), /уже запущен/);
    release();
    release = acquireInstanceLock(dir);
  } finally {
    release(); releaseOther();
    rmSync(dir, { recursive: true }); rmSync(another, { recursive: true });
  }
});

test("second server with the same data directory stops before starting its worker", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "shorts-instance-process-"));
  const env = { ...process.env, SHORTS_DATA_DIR: dir, SHORTS_PUBLIC_ORIGIN: "http://127.0.0.1:5173", PORT: "0" };
  const first = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { env });
  let second: ReturnType<typeof spawn> | undefined;
  let restarted: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      first.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("listening")) resolve(); });
      first.once("error", reject);
      first.once("exit", (code) => reject(new Error(`server exited: ${code}`)));
    });
    second = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { env });
    const result = await Promise.race([
      once(second, "exit").then(([code]) => code),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    assert.notEqual(result, null, "second server must fail immediately");
    assert.notEqual(result, 0);
    first.kill("SIGKILL");
    await once(first, "exit");
    restarted = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], { env });
    await new Promise<void>((resolve, reject) => {
      restarted!.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("listening")) resolve(); });
      restarted!.once("error", reject);
      restarted!.once("exit", (code) => reject(new Error(`restart exited: ${code}`)));
    });
  } finally {
    if (restarted?.exitCode === null) restarted.kill("SIGTERM");
    if (second?.exitCode === null) second.kill("SIGTERM");
    if (first.exitCode === null) first.kill("SIGTERM");
    await Promise.all([first, ...(second ? [second] : []), ...(restarted ? [restarted] : [])].map((child) => child.exitCode === null && child.signalCode === null ? once(child, "exit").catch(() => {}) : Promise.resolve()));
    rmSync(dir, { recursive: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/server/store.ts";
import { createDatabaseBackup } from "../src/server/backup.ts";

test("online backup restores committed queue and encrypted settings using its key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-backup-"));
  const source = new Store(join(dir, "source"));
  const target = join(dir, "backup");
  let restored: Store | undefined;
  try {
    source.set("secret", { accessToken: "sensitive-value" });
    source.video({ id: "a", title: "Queue", hashtags: "", filename: "a.mp4", bytes: 4, createdAt: 1, position: 1, scheduledAt: 2, pinned: false, kind: "content", state: "queued", deletedAt: null });
    await createDatabaseBackup(source, target);
    assert.equal(existsSync(join(target, "BACKUP_COMPLETE")), true);
    assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.equal(statSync(join(target, "secret.key")).mode & 0o777, 0o600);
    assert.equal(statSync(join(target, "panel.sqlite")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(target, "videos", "a.mp4")), false);
    restored = new Store(target);
    assert.deepEqual(restored.get("secret"), { accessToken: "sensitive-value" });
    assert.equal(restored.videos()[0].title, "Queue");
    await assert.rejects(() => createDatabaseBackup(source, target));
    assert.equal(restored.videos().length, 1);
  } finally { restored?.db.close(); source.db.close(); rmSync(dir, { recursive: true }); }
});

test("backup without its encryption key cannot be mistaken for a complete backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-backup-incomplete-"));
  const source = new Store(join(dir, "source"));
  const target = join(dir, "backup");
  try {
    rmSync(join(source.dir, "secret.key"));
    await assert.rejects(() => createDatabaseBackup(source, target));
    assert.equal(existsSync(join(target, "BACKUP_COMPLETE")), false);
  } finally { source.db.close(); rmSync(dir, { recursive: true }); }
});

test("backup command refuses a missing source and creates a restorable snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-backup-cli-"));
  const source = new Store(join(dir, "source"));
  try {
    source.set("test", "value");
    const run = (sourceDir: string, target: string) => spawnSync(process.execPath, ["--import", "tsx", "scripts/backup.ts", target], { env: { ...process.env, SHORTS_DATA_DIR: sourceDir }, encoding: "utf8" });
    assert.notEqual(run(join(dir, "missing"), join(dir, "bad")).status, 0);
    assert.equal(existsSync(join(dir, "missing")), false);
    assert.equal(run(source.dir, join(dir, "good")).status, 0);
    assert.equal(existsSync(join(dir, "good", "BACKUP_COMPLETE")), true);
  } finally { source.db.close(); rmSync(dir, { recursive: true }); }
});


test("backup rejects an encryption key changed after the database was opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-backup-key-"));
  const source = new Store(join(dir, "source"));
  const target = join(dir, "backup");
  try {
    source.set("secret", "encrypted with original key");
    writeFileSync(join(source.dir, "secret.key"), Buffer.alloc(32, 7));
    await assert.rejects(() => createDatabaseBackup(source, target));
    assert.equal(existsSync(join(target, "BACKUP_COMPLETE")), false);
  } finally { source.db.close(); rmSync(dir, { recursive: true }); }
});

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { Store } from "../src/server/store.ts";
import { acquireInstanceLock } from "../src/server/instance-lock.ts";
import { listOrphanedVideos, recoverOrphanedVideo } from "../src/server/recovery.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shorts-recovery-"));
  const store = new Store(join(dir, "data"));
  const video = join(dir, "fixture.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=180x320:d=3.1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  const add = (extension = "mp4") => {
    const filename = `${randomUUID()}.${extension}`;
    copyFileSync(video, join(store.dir, "videos", filename));
    return filename;
  };
  return { dir, store, video, add, close() { store.db.close(); rmSync(dir, { recursive: true }); } };
}

for (const extension of ["mp4", "part"])
  test("offline recovery validates and registers a complete " + extension + " without publishing", async () => {
    const h = fixture();
    try {
      const filename = h.add(extension), other = h.add();
      const before = readFileSync(join(h.store.dir, "videos", filename));
      assert.equal(listOrphanedVideos(h.store).length, 2);
      const id = await recoverOrphanedVideo(h.store, filename, "Recovered", "#test");
      const saved = h.store.videos()[0];
      assert.equal(saved.id, id);
      assert.equal(saved.title, "Recovered");
      assert.equal(saved.hashtags, "#test");
      assert.equal(saved.state, "queued");
      assert.equal(saved.scheduledAt, null, "startup must claim old due jobs before replanning");
      assert.deepEqual(readFileSync(join(h.store.dir, "videos", saved.filename)), before);
      assert.equal(saved.bytes, before.length);
      assert.equal(h.store.deliveries().length, 0);
      assert.deepEqual(listOrphanedVideos(h.store).map(v => v.filename), [other]);
      await assert.rejects(() => recoverOrphanedVideo(h.store, saved.filename, "Again"));
    } finally { h.close(); }
  });

test("recovery refuses active worker, untrusted paths, symlinks and invalid media without deleting anything", async () => {
  const h = fixture();
  try {
    const filename = h.add();
    const unlock = acquireInstanceLock(h.store.dir);
    try { await assert.rejects(() => recoverOrphanedVideo(h.store, filename, "Test"), /уже запущена/); }
    finally { unlock(); }
    for (const name of ["../fixture.mp4", "/tmp/file.mp4", "unknown.mp4", `${randomUUID()}.mp4`])
      await assert.rejects(() => recoverOrphanedVideo(h.store, name, "Test"));
    const linked = `${randomUUID()}.mp4`;
    symlinkSync(h.video, join(h.store.dir, "videos", linked));
    await assert.rejects(() => recoverOrphanedVideo(h.store, linked, "Test"));
    const bad = h.add("part");
    writeFileSync(join(h.store.dir, "videos", bad), "broken");
    await assert.rejects(() => recoverOrphanedVideo(h.store, bad, "Test"));
    assert.equal(h.store.videos().length, 0);
    assert.ok(existsSync(join(h.store.dir, "videos", filename)));
    assert.ok(existsSync(join(h.store.dir, "videos", bad)));
    assert.equal(listOrphanedVideos(h.store).length, 2);
  } finally { h.close(); }
});

test("recovery refuses missing metadata and collisions; database failure retains the validated original", async () => {
  const h = fixture();
  try {
    const filename = h.add("part");
    for (const [title, tags] of [["", ""], ["x".repeat(101), ""], ["Test", "x".repeat(2001)]])
      await assert.rejects(() => recoverOrphanedVideo(h.store, filename, title, tags));
    const final = filename.replace(/\.part$/, ".mp4");
    writeFileSync(join(h.store.dir, "videos", final), "do not overwrite");
    await assert.rejects(() => recoverOrphanedVideo(h.store, filename, "Test"));
    assert.equal(readFileSync(join(h.store.dir, "videos", final), "utf8"), "do not overwrite");
    rmSync(join(h.store.dir, "videos", final));
    const fail = mock.method(h.store, "video", () => { throw new Error("database full"); });
    await assert.rejects(() => recoverOrphanedVideo(h.store, filename, "Test"), /database full/);
    fail.mock.restore();
    assert.ok(existsSync(join(h.store.dir, "videos", final)));
    assert.equal(h.store.videos().length, 0);
    await recoverOrphanedVideo(h.store, final, "Recovered after database repair");
    assert.equal(h.store.videos().length, 1);
  } finally { h.close(); }
});

test("recovery CLI lists candidates, requires metadata and never creates a missing data directory", () => {
  const h = fixture();
  try {
    const filename = h.add();
    const run = (source: string, ...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/recover.ts", ...args], { env: { ...process.env, SHORTS_DATA_DIR: source }, encoding: "utf8" });
    const missing = join(h.dir, "missing");
    assert.notEqual(run(missing, "list").status, 0);
    assert.equal(existsSync(missing), false);
    assert.match(run(h.store.dir, "list").stdout, new RegExp(filename));
    assert.notEqual(run(h.store.dir, filename).status, 0);
    assert.equal(run(h.store.dir, filename, "Recovered title", "#tag").status, 0);
    assert.equal(h.store.videos()[0].title, "Recovered title");
  } finally { h.close(); }
});
test("a dangling destination symlink is never overwritten during recovery", async () => {
  const h = fixture();
  try {
    const filename = h.add("part");
    const final = join(h.store.dir, "videos", filename.replace(/\.part$/, ".mp4"));
    const target = join(h.dir, "not-created.mp4");
    symlinkSync(target, final);
    await assert.rejects(() => recoverOrphanedVideo(h.store, filename, "Test"));
    assert.ok(existsSync(join(h.store.dir, "videos", filename)));
    assert.equal(h.store.videos().length, 0);
    assert.equal(existsSync(target), false);
  } finally { h.close(); }
});

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/server/store.ts";
import { Engine } from "../src/server/engine.ts";
import type { Providers } from "../src/server/providers.ts";
import { DAY, HOUR, parseMoscow } from "../src/shared/scheduler.ts";
import { PLATFORMS, type Video, type Delivery } from "../src/shared/model.ts";
test("real SQLite dispatch, failed platform independence, exact file retention across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-engine-"));
  let store = new Store(dir);
  let clock = parseMoscow("2026-11-02T12:00");
  const now = mock.method(Date, "now", () => clock);
  const sent: string[] = [];
  let tiktokWorks = false;
  const adapter = {
    connections: () =>
      PLATFORMS.map((platform) => ({
        platform,
        connected: platform !== "tiktok" || tiktokWorks,
      })),
    publish: async (v: Video, d: Delivery) => {
      sent.push(`${v.id}:${d.platform}`);
      d.state = "published";
      d.successAt = clock;
      d.externalId = v.id;
      store.delivery(d);
    },
  } as unknown as Providers;
  const video = (id: string, time: number): Video => ({
    id,
    title: id,
    hashtags: "",
    filename: id + ".mp4",
    bytes: 10,
    createdAt: clock,
    position: id === "A" ? 1 : 2,
    scheduledAt: time,
    pinned: false,
    kind: "content",
    state: "queued",
    deletedAt: null,
  });
  try {
    store.video(video("A", clock));
    writeFileSync(join(dir, "videos", "A.mp4"), "0123456789");
    let engine = new Engine(store, adapter);
    await engine.tick();
    assert.equal(
      store.deliveries().filter((d) => d.state === "published").length,
      2,
    );
    assert.ok(existsSync(join(dir, "videos", "A.mp4")));
    clock += 5 * HOUR;
    store.video(video("B", clock));
    writeFileSync(join(dir, "videos", "B.mp4"), "0123456789");
    await engine.tick();
    assert.ok(sent.includes("B:youtube"));
    assert.ok(sent.includes("B:instagram"));
    assert.ok(!sent.includes("A:tiktok"));
    clock = parseMoscow("2026-11-03T01:00");
    tiktokWorks = true;
    await engine.tick();
    assert.ok(sent.includes("A:tiktok"));
    assert.ok(existsSync(join(dir, "videos", "A.mp4")));
    store.db.close();
    store = new Store(dir);
    engine = new Engine(store, adapter);
    clock += DAY - 1;
    await engine.tick();
    assert.ok(existsSync(join(dir, "videos", "A.mp4")));
    clock++;
    await engine.tick();
    assert.ok(!existsSync(join(dir, "videos", "A.mp4")));
    assert.ok(store.videos().find((v) => v.id === "A")?.deletedAt);
    assert.equal(sent.filter((s) => s === "A:youtube").length, 1);
  } finally {
    now.mock.restore();
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});
test("uncertain response does not trigger blind duplicate retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-unknown-"));
  const store = new Store(dir);
  const clock = Date.now();
  let attempts = 0;
  const adapter = {
    connections: () =>
      PLATFORMS.map((platform) => ({ platform, connected: true })),
    publish: async () => {
      attempts++;
      throw new Error("timeout");
    },
  } as unknown as Providers;
  try {
    store.video({
      id: "x",
      title: "x",
      hashtags: "",
      filename: "x.mp4",
      bytes: 10,
      createdAt: clock,
      position: 1,
      scheduledAt: clock,
      pinned: false,
      kind: "content",
      state: "queued",
      deletedAt: null,
    });
    const engine = new Engine(store, adapter);
    await engine.tick();
    await engine.tick();
    assert.equal(attempts, 3);
    assert.ok(store.deliveries().every((d) => d.state === "unknown"));
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});

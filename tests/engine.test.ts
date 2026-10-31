import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/server/store.ts";
import { Engine } from "../src/server/engine.ts";
import type { PublicationGateway } from "../src/server/contracts.ts";
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
    verifyYoutube: async () => {},
  } satisfies PublicationGateway;
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
    verifyYoutube: async () => {},
  } satisfies PublicationGateway;
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

test("worker uses injected time without changing the global clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-clock-")),
    store = new Store(dir);
  const now = parseMoscow("2030-11-02T06:00");
  let sent = 0;
  const gateway = {
    connections: () =>
      PLATFORMS.map((platform) => ({ platform, connected: true })),
    publish: async () => {
      sent++;
    },
    verifyYoutube: async () => {},
  };
  try {
    store.video({
      id: "clock",
      title: "clock",
      hashtags: "",
      filename: "clock.mp4",
      bytes: 1,
      createdAt: now,
      position: 1,
      scheduledAt: now,
      pinned: false,
      kind: "content",
      state: "queued",
      deletedAt: null,
    });
    await new Engine(store, gateway, () => now).tick();
    assert.equal(sent, 3);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("restart quarantines only ambiguous processing and preserves resumable IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-restart-")),
    store = new Store(dir);
  const now = Date.now();
  const gateway: PublicationGateway = {
    connections: () => [],
    publish: async () => {},
    verifyYoutube: async () => {},
  };
  try {
    store.video({
      id: "r",
      title: "r",
      hashtags: "",
      filename: "r.mp4",
      bytes: 1,
      createdAt: now,
      position: 1,
      scheduledAt: now,
      pinned: false,
      kind: "content",
      state: "dispatched",
      deletedAt: null,
    });
    for (const platform of PLATFORMS)
      store.delivery({
        videoId: "r",
        platform,
        state: "processing",
        originalAt: now,
        nextAt: now,
        successAt: null,
        externalId: platform === "youtube" ? "uploaded-id" : null,
        url: null,
        error: null,
        attempts: 1,
      });
    new Engine(store, gateway);
    assert.equal(
      store.deliveries().find((d) => d.platform === "youtube")?.state,
      "processing",
    );
    assert.ok(
      store
        .deliveries()
        .filter((d) => d.platform !== "youtube")
        .every((d) => d.state === "unknown"),
    );
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("overlapping worker ticks never dispatch the same video twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-overlap-")),
    store = new Store(dir),
    now = Date.now();
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const gateway: PublicationGateway = {
    connections: () =>
      PLATFORMS.map((platform) => ({ platform, connected: true })),
    publish: async () => {
      calls++;
      await held;
    },
    verifyYoutube: async () => {},
  };
  try {
    store.video({
      id: "c",
      title: "c",
      hashtags: "",
      filename: "c.mp4",
      bytes: 1,
      createdAt: now,
      position: 1,
      scheduledAt: now,
      pinned: false,
      kind: "content",
      state: "queued",
      deletedAt: null,
    });
    const engine = new Engine(store, gateway, () => now),
      first = engine.tick();
    await engine.tick();
    assert.equal(calls, 3);
    release();
    await first;
    assert.equal(engine.running, false);
  } finally {
    release();
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});

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
for (const delay of [10 * 60_000, HOUR])
  test("rate limit respects exact grace boundary: " + delay, async () => {
    const { RateLimited } = await import("../src/server/contracts.ts");
    const dir = mkdtempSync(join(tmpdir(), "shorts-rate-boundary-"));
    const store = new Store(dir);
    const clock = parseMoscow("2026-11-02T12:00");
    const gateway: PublicationGateway = {
      connections: () => PLATFORMS.map(platform => ({ platform, connected: true })),
      publish: async () => { throw new RateLimited(clock + delay); },
      verifyYoutube: async () => {},
    };
    try {
      store.video({ id: "rate", title: "rate", hashtags: "", filename: "rate.mp4", bytes: 1, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "queued", deletedAt: null });
      await new Engine(store, gateway, () => clock).tick();
      const expected = delay < HOUR ? clock + delay : parseMoscow("2026-11-02T17:00");
      assert.ok(store.deliveries().every(d => d.nextAt === expected));
    } finally { store.db.close(); rmSync(dir, { recursive: true }); }
  });
test("platform cooldown delays retries and new jobs without delaying other platforms", async () => {
  const { RateLimited } = await import("../src/server/contracts.ts");
  const dir = mkdtempSync(join(tmpdir(), "shorts-rate-limit-"));
  const store = new Store(dir);
  let clock = parseMoscow("2026-11-02T12:00");
  const until = clock + 2 * HOUR;
  let cooldown = 0;
  let calls = 0;
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map(platform => ({ platform, connected: true })),
    notBefore: platform => platform === "youtube" ? cooldown : 0,
    publish: async (_v, d) => {
      if (d.platform === "youtube") {
        calls++;
        if (calls === 1) { cooldown = until; throw new RateLimited(until); }
      }
      d.state = "published"; d.successAt = clock; store.delivery(d);
    }, verifyYoutube: async () => {},
  };
  try {
    const add = (id: string) => store.video({ id, title: id, hashtags: "", filename: id + ".mp4", bytes: 1, createdAt: clock, position: store.videos().length + 1, scheduledAt: clock, pinned: true, kind: "content", state: "queued", deletedAt: null });
    add("a");
    let engine = new Engine(store, gateway, () => clock);
    await engine.tick();
    let first = store.deliveries().find(d => d.platform === "youtube")!;
    assert.equal(first.state, "failed");
    assert.equal(first.nextAt, parseMoscow("2026-11-02T17:00"));
    clock += 5 * 60_000; add("b");
    engine = new Engine(store, gateway, () => clock);
    await engine.tick();
    assert.equal(calls, 1);
    assert.ok(store.deliveries().filter(d => d.platform !== "youtube").every(d => d.state === "published"));
    assert.equal(store.deliveries().find(d => d.videoId === "b" && d.platform === "youtube")?.attempts, 0);
    clock = parseMoscow("2026-11-02T17:00");
    await engine.tick();
    assert.equal(calls, 2);
    assert.equal(store.deliveries().find(d => d.videoId === "a" && d.platform === "youtube")?.state, "published");
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});
test("revoked access blocks only its platform and keeps reconciliation IDs across restart", async () => {
  const { AccessRequired } = await import("../src/server/contracts.ts");
  const dir = mkdtempSync(join(tmpdir(), "shorts-access-"));
  let store = new Store(dir);
  let clock = parseMoscow("2026-11-02T12:00");
  let revoked = true;
  let checks = 0;
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map(platform => ({ platform, connected: platform !== "youtube" || !revoked || checks === 0 })),
    publish: async (_v, d) => {
      d.state = "published"; d.successAt = clock; store.delivery(d);
    },
    verifyYoutube: async d => {
      checks++;
      assert.equal(d.externalId, "already-uploaded");
      if (revoked) throw new AccessRequired();
      d.state = "published"; d.successAt = clock; store.delivery(d);
    },
  };
  try {
    store.video({ id: "access", title: "access", hashtags: "", filename: "access.mp4", bytes: 4, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "dispatched", deletedAt: null });
    writeFileSync(join(dir, "videos", "access.mp4"), "data");
    for (const platform of PLATFORMS) store.delivery({ videoId: "access", platform, state: "pending", originalAt: clock, nextAt: clock, externalId: platform === "youtube" ? "already-uploaded" : null, url: null, error: null, successAt: null, attempts: 0 });
    let engine = new Engine(store, gateway, () => clock);
    await engine.tick();
    let d = store.deliveries().find(d => d.platform === "youtube")!;
    assert.equal(d.state, "blocked");
    assert.match(d.error!, /повторно подключите/i);
    assert.equal(d.externalId, "already-uploaded");
    assert.ok(store.deliveries().filter(d => d.platform !== "youtube").every(d => d.state === "published"));
    clock += 60_000;
    await engine.tick();
    assert.equal(checks, 1);
    assert.ok(existsSync(join(dir, "videos", "access.mp4")));
    store.db.close(); store = new Store(dir);
    engine = new Engine(store, gateway, () => clock);
    revoked = false;
    clock = store.deliveries().find(d => d.platform === "youtube")!.nextAt;
    await engine.tick();
    d = store.deliveries().find(d => d.platform === "youtube")!;
    assert.equal(d.state, "published");
    assert.equal(checks, 2);
    assert.ok(existsSync(join(dir, "videos", "access.mp4")));
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});
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

test('restart after grace window schedules backlog rather than sending immediately', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shorts-late-')),store=new Store(dir);const now=parseMoscow('2026-11-02T14:00');let calls=0;
 const gateway:PublicationGateway={connections:()=>PLATFORMS.map(platform=>({platform,connected:true})),publish:async()=>{calls++;},verifyYoutube:async()=>{}};
 try {store.video({id:'late',title:'late',hashtags:'',filename:'late.mp4',bytes:1,createdAt:1,position:1,scheduledAt:parseMoscow('2026-11-02T12:00'),pinned:false,kind:'content',state:'queued',deletedAt:null});await new Engine(store,gateway,()=>now).tick();assert.equal(calls,0);assert.ok(store.deliveries().every(d=>d.nextAt>now));}
 finally{store.db.close();rmSync(dir,{recursive:true});}
});

test("safe pre-send failures retry within grace and move to recovery after the deadline", async () => {
  const { RetryableBeforeSend } = await import("../src/server/contracts.ts");
  const dir = mkdtempSync(join(tmpdir(), "shorts-retry-"));
  const store = new Store(dir);
  let clock = parseMoscow("2026-11-02T12:00");
  let attempts = 0;
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map((platform) => ({ platform, connected: true })),
    publish: async (_v, d) => {
      attempts++;
      if (d.platform === "youtube") throw new RetryableBeforeSend();
      d.state = "published";
      d.successAt = clock;
      store.delivery(d);
    },
    verifyYoutube: async () => {},
  };
  try {
    store.video({ id: "retry", title: "retry", hashtags: "", filename: "retry.mp4", bytes: 1, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "queued", deletedAt: null });
    const engine = new Engine(store, gateway, () => clock);
    await engine.tick();
    let delivery = store.deliveries().find((d) => d.platform === "youtube")!;
    assert.equal(delivery.state, "failed");
    assert.equal(delivery.nextAt, clock + 60_000);
    await engine.tick();
    assert.equal(attempts, 3);
    clock += 60_000;
    await engine.tick();
    assert.equal(attempts, 4);
    clock = delivery.originalAt + HOUR;
    await engine.tick();
    delivery = store.deliveries().find((d) => d.platform === "youtube")!;
    assert.equal(attempts, 4);
    assert.ok(delivery.nextAt > clock);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("restart schedules a recoverable YouTube session for reconciliation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-reconcile-"));
  const store = new Store(dir);
  const clock = parseMoscow("2026-11-02T12:00");
  let attempts = 0;
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map((platform) => ({ platform, connected: true })),
    canRecover: (d) => d.platform === "youtube",
    publish: async () => { attempts++; },
    verifyYoutube: async () => {},
  };
  try {
    store.video({ id: "resume", title: "resume", hashtags: "", filename: "resume.mp4", bytes: 1, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "dispatched", deletedAt: null });
    store.delivery({ videoId: "resume", platform: "youtube", state: "processing", originalAt: clock, nextAt: clock, successAt: null, externalId: null, url: null, error: null, attempts: 1 });
    const engine = new Engine(store, gateway, () => clock);
    assert.equal(store.deliveries()[0].state, "pending");
    await engine.tick();
    assert.equal(attempts, 1);
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});

test("interrupted upload schedules session reconciliation without requiring a restart", async () => {
  const { RetryableSession } = await import("../src/server/contracts.ts");
  assert.equal(typeof RetryableSession, "function");
  const dir = mkdtempSync(join(tmpdir(), "shorts-reconcile-live-"));
  const store = new Store(dir);
  let clock = parseMoscow("2026-11-02T12:00");
  let calls = 0;
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map((platform) => ({ platform, connected: true })),
    publish: async (_video, d) => {
      if (d.platform !== "youtube") return;
      calls++;
      if (calls === 1) throw new RetryableSession();
      d.state = "published"; d.successAt = clock; store.delivery(d);
    },
    verifyYoutube: async () => {},
  };
  try {
    store.video({ id: "live", title: "live", hashtags: "", filename: "live.mp4", bytes: 1, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "queued", deletedAt: null });
    const engine = new Engine(store, gateway, () => clock);
    await engine.tick();
    assert.equal(store.deliveries().find((d) => d.platform === "youtube")?.state, "failed");
    await engine.tick();
    assert.equal(calls, 1);
    clock += 60_000;
    await engine.tick();
    assert.equal(calls, 2);
    assert.equal(store.deliveries().find((d) => d.platform === "youtube")?.state, "published");
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});

test("a worker failure waits for other platform operations before allowing another tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-tick-error-"));
  const store = new Store(dir);
  const clock = parseMoscow("2026-11-02T12:00");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let checks = 0;
  const gateway: PublicationGateway = {
    connections: () => {
      checks++;
      if (checks === 2) throw new Error("unexpected connection failure");
      return PLATFORMS.map((platform) => ({ platform, connected: true }));
    },
    publish: async () => { calls++; await held; },
    verifyYoutube: async () => {},
  };
  try {
    store.video({ id: "held", title: "held", hashtags: "", filename: "held.mp4", bytes: 1, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "queued", deletedAt: null });
    const engine = new Engine(store, gateway, () => clock);
    const first = engine.tick().catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(engine.running, true);
    const initialCalls = calls;
    await engine.tick();
    assert.equal(calls, initialCalls);
    release();
    await first;
    assert.equal(engine.running, false);
  } finally { release(); store.db.close(); rmSync(dir, { recursive: true }); }
});

test("worker drain waits until in-flight platform requests settle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-drain-"));
  const store = new Store(dir);
  const clock = parseMoscow("2026-11-02T12:00");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map((platform) => ({ platform, connected: true })),
    publish: async () => { await held; }, verifyYoutube: async () => {},
  };
  try {
    store.video({ id: "drain", title: "drain", hashtags: "", filename: "drain.mp4", bytes: 1, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "queued", deletedAt: null });
    const engine = new Engine(store, gateway, () => clock);
    await engine.whenIdle();
    const tick = engine.tick();
    let drained = false;
    const wait = engine.whenIdle().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    release(); await tick; await wait;
    assert.equal(drained, true);
  } finally { release(); store.db.close(); rmSync(dir, { recursive: true }); }
});

test("missing original is flagged and scheduled safely without an ambiguous publication warning", async () => {
  const { SourceUnavailable } = await import("../src/server/contracts.ts");
  assert.equal(typeof SourceUnavailable, "function");
  const dir = mkdtempSync(join(tmpdir(), "shorts-no-source-"));
  const store = new Store(dir);
  const clock = parseMoscow("2026-11-02T12:00");
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map((platform) => ({ platform, connected: true })),
    publish: async () => { throw new SourceUnavailable(); }, verifyYoutube: async () => {},
  };
  try {
    store.video({ id: "missing", title: "missing", hashtags: "", filename: "missing.mp4", bytes: 1, createdAt: clock, position: 1, scheduledAt: clock, pinned: false, kind: "content", state: "queued", deletedAt: null });
    await new Engine(store, gateway, () => clock).tick();
    for (const d of store.deliveries()) {
      assert.equal(d.state, "failed");
      assert.match(d.error!, /файл/i);
      assert.equal(d.nextAt, clock + 60_000);
    }
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});

test("idle worker maintains supported connections hourly without blocking the queue after transient failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-idle-auth-"));
  const store = new Store(dir);
  let clock = parseMoscow("2026-11-02T12:00");
  const calls: string[] = [];
  let failure = true;
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map((platform) => ({ platform, connected: true })),
    maintain: async (platform) => { calls.push(platform); if (platform === "instagram" && failure) throw new Error("offline"); },
    publish: async () => {}, verifyYoutube: async () => {},
  };
  try {
    const engine = new Engine(store, gateway, () => clock);
    await engine.tick();
    assert.deepEqual(calls.sort(), ["instagram", "youtube"]);
    await engine.tick();
    assert.equal(calls.length, 2);
    failure = false; clock += HOUR;
    await engine.tick();
    assert.equal(calls.length, 4);
    assert.equal(engine.running, false);
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});

test("idle maintenance waits for a platform cooldown and skips disconnected accounts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-idle-cooldown-"));
  const store = new Store(dir);
  let clock = parseMoscow("2026-11-02T12:00");
  const until = clock + 2 * HOUR;
  const calls: string[] = [];
  const gateway: PublicationGateway = {
    connections: () => PLATFORMS.map((platform) => ({ platform, connected: platform !== "youtube" })),
    notBefore: (platform) => platform === "instagram" ? until : 0,
    maintain: async (platform) => { calls.push(platform); },
    publish: async () => {}, verifyYoutube: async () => {},
  };
  try {
    const engine = new Engine(store, gateway, () => clock);
    await engine.tick(); assert.deepEqual(calls, []);
    clock = until - 1; await engine.tick(); assert.deepEqual(calls, []);
    clock = until; await engine.tick(); assert.deepEqual(calls, ["instagram"]);
  } finally { store.db.close(); rmSync(dir, { recursive: true }); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApplication } from "../src/server/app.ts";
import { Store, passwordHash } from "../src/server/store.ts";
import { PLATFORMS, type Video, type Delivery } from "../src/shared/model.ts";
import { createHash, createHmac } from "node:crypto";
const origin = "http://127.0.0.1:5173";
async function fixture(override: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shorts-http-"));
  const store = new Store(dir);
  store.set("password", passwordHash("test-password-long-enough"));
  const gateway = {
    publish: async () => {},
    verifyYoutube: async () => {},
    connections: () =>
      PLATFORMS.map((platform) => ({
        platform,
        configured: false,
        connected: false,
        account: null,
        expiresAt: null,
        message: "Disconnected",
      })),
    authorization: (p: string, state: string) => {
      if (p === "tiktok") throw new Error("Not available");
      return "https://auth.example/?state=" + state;
    },
    exchange: async (_p: string, code: string) => {
      if (code === "bad") throw new Error("failed");
    },
  };
  const { app } = createApplication({
    env: { SHORTS_DATA_DIR: dir, SHORTS_PUBLIC_ORIGIN: origin, ...override },
    store,
    providers: gateway,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = "",
    csrf = "";
  async function req(
    path: string,
    body?: unknown,
    method?: string,
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Origin: origin,
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      redirect: "manual",
    });
    return response;
  }
  async function login() {
    const response = await req("/api/login", {
      password: "test-password-long-enough",
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    csrf = ((await response.json()) as any).csrf;
    return cookie;
  }
  function video(id = "v", state: Video["state"] = "queued"): Video {
    const v: Video = {
      id,
      title: id,
      hashtags: "",
      filename: id + ".mp4",
      bytes: 4,
      createdAt: Date.now(),
      position: 1,
      scheduledAt: Date.now() + 86400000,
      pinned: false,
      kind: "content",
      state,
      deletedAt: null,
    };
    store.video(v);
    return v;
  }
  return {
    dir,
    store,
    app,
    base,
    gateway,
    req,
    login,
    video,
    getCookie: () => cookie,
    getCsrf: () => csrf,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("HTTP auth/session/origin and rate-limit boundaries", async () => {
  const h = await fixture();
  try {
    assert.equal((await h.req("/healthz")).status, 200);
    assert.equal((await h.req("/api/state")).status, 401);
    assert.equal(
      (
        await h.req(
          "/api/login",
          { password: "test-password-long-enough" },
          "POST",
          { Origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    assert.equal((await h.req("/api/login", { password: 123 })).status, 401);
    await h.login();
    const snapshot = (await (await h.req("/api/state")).json()) as any;
    assert.equal(snapshot.videos.length, 0);
    assert.ok(snapshot.csrf);
    assert.ok(snapshot.storage.free > 0);
    assert.equal(
      (await h.req("/api/logout", {}, "POST", { "X-CSRF-Token": "wrong" }))
        .status,
      403,
    );
    assert.equal(
      (
        await h.req("/api/logout", {}, "POST", {
          Origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal((await h.req("/api/logout", {})).status, 200);
    assert.equal((await h.req("/api/state")).status, 401);
    for (let i = 0; i < 8; i++)
      assert.equal(
        (await h.req("/api/login", { password: "wrong" })).status,
        401,
      );
    assert.equal(
      (await h.req("/api/login", { password: "test-password-long-enough" }))
        .status,
      429,
    );
  } finally {
    await h.close();
  }
});
test("HTTP edit validation, pins, reorder and transactional rollback", async () => {
  const h = await fixture();
  try {
    await h.login();
    h.video("a");
    h.video("b");
    assert.equal((await h.req("/api/videos/missing", {}, "PATCH")).status, 404);
    for (const payload of [
      { title: "" },
      { title: 3 },
      { title: "a".repeat(101) },
      { hashtags: 1 },
      { hashtags: "x".repeat(2001) },
      { pin: "2026-02-30T12:00" },
      { pin: "2020-01-01T12:00" },
    ])
      assert.equal(
        (await h.req("/api/videos/a", payload, "PATCH")).status,
        400,
      );
    assert.equal(
      (
        await h.req(
          "/api/videos/a",
          { title: "Changed", hashtags: "#new" },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await h.req(
          "/api/videos/a",
          { pin: "2035-11-02T15:30", kind: "extra" },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(h.store.videos().find((v) => v.id === "a")?.kind, "extra");
    assert.equal(
      (await h.req("/api/videos/b", { pin: "2035-11-02T15:30" }, "PATCH"))
        .status,
      400,
    );
    assert.equal(
      (await h.req("/api/videos/a", { pin: null }, "PATCH")).status,
      200,
    );
    for (const ids of [[], ["a", "a"], ["a", "missing"], null])
      assert.equal((await h.req("/api/reorder", { ids })).status, 400);
    assert.equal(
      (await h.req("/api/reorder", { ids: ["b", "a"] })).status,
      200,
    );
    assert.ok(
      h.store.videos().find((v) => v.id === "b")!.position <
        h.store.videos().find((v) => v.id === "a")!.position,
    );
    h.video("sent", "dispatched");
    assert.equal(
      (await h.req("/api/videos/sent", { title: "changed" }, "PATCH")).status,
      409,
    );
    assert.equal(
      (
        await h.req(
          "/api/videos/a",
          { title: "must-roll-back", hashtags: 123 },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.notEqual(
      h.store.videos().find((v) => v.id === "a")?.title,
      "must-roll-back",
    );
  } finally {
    await h.close();
  }
});
test("HTTP OAuth state is one-use, session-bound and platform-bound; secrets never returned", async () => {
  const h = await fixture();
  try {
    await h.login();
    for (const platform of ["bad", "tiktok"])
      assert.equal(
        (
          await h.req(`/api/connections/${platform}/config`, {
            clientId: "x",
            clientSecret: "s",
          })
        ).status,
        400,
      );
    for (const body of [
      {},
      { clientId: "", clientSecret: "x" },
      { clientId: "x", clientSecret: "" },
    ])
      assert.equal(
        (await h.req("/api/connections/youtube/config", body)).status,
        400,
      );
    assert.equal(
      (
        await h.req("/api/connections/youtube/config", {
          clientId: "client",
          clientSecret: "do-not-return",
        })
      ).status,
      200,
    );
    assert.ok(
      !(await (await h.req("/api/state")).text()).includes("do-not-return"),
    );
    assert.equal((await h.req("/api/connections/bad/connect", {})).status, 404);
    assert.equal(
      (await h.req("/api/connections/tiktok/connect", {})).status,
      400,
    );
    assert.equal(
      (await h.req("/api/connections/bad/disconnect", {})).status,
      404,
    );
    assert.equal(
      (await h.req("/api/connections/youtube/disconnect", {})).status,
      200,
    );
    const auth = (await (
      await h.req("/api/connections/youtube/connect", {})
    ).json()) as any;
    const state = new URL(auth.url).searchParams.get("state")!;
    assert.equal(
      (
        await h.req(
          "/api/oauth/instagram/callback?state=" + state + "&code=good",
        )
      ).status,
      403,
    );
    const ok = await h.req(
      "/api/oauth/youtube/callback?state=" + state + "&code=good",
    );
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/?connected=1");
    assert.equal(
      (await h.req("/api/oauth/youtube/callback?state=" + state + "&code=good"))
        .status,
      403,
    );
    const badAuth = (await (
      await h.req("/api/connections/youtube/connect", {})
    ).json()) as any;
    const badState = new URL(badAuth.url).searchParams.get("state");
    const failed = await h.req(
      "/api/oauth/youtube/callback?state=" + badState + "&code=bad",
    );
    assert.equal(failed.headers.get("location"), "/?connection_error=1");
    assert.equal(
      (await h.req("/api/oauth/youtube/callback?state=missing")).status,
      403,
    );
  } finally {
    await h.close();
  }
});
test("HTTP file access and signed public fetch; malformed requests", async () => {
  const h = await fixture();
  try {
    await h.login();
    const v = h.video();
    writeFileSync(join(h.dir, "videos", v.filename), "data");
    assert.equal((await h.req("/api/videos/v/file")).status, 200);
    assert.equal((await h.req("/api/videos/no/file")).status, 404);
    const expires = Date.now() + 3600000;
    const signature = createHmac("sha256", h.store.key)
      .update(`v:${expires}`)
      .digest("hex");
    assert.equal(
      (await h.req(`/media/v?expires=${expires}&signature=${signature}`))
        .status,
      200,
    );
    for (const url of [
      "/media/v",
      "/media/v?expires=1&signature=bad",
      `/media/v?expires=${expires}&signature=${"x".repeat(64)}`,
    ])
      assert.equal((await h.req(url)).status, 403);
    assert.equal((await h.req("/api/reorder", "{broken")).status, 400);
    for (const headers of [
      {},
      { "X-Video-Title": "%ZZ" },
      { "X-Video-Title": "x", "Content-Type": "video/mp4" },
    ] as Record<string, string>[])
      assert.equal(
        (await h.req("/api/videos", "bad", "POST", headers)).status,
        400,
      );
  } finally {
    await h.close();
  }
});
test("HTTP retries respect confirmation and never retry completed/in-flight work", async () => {
  const h = await fixture();
  try {
    await h.login();
    h.video();
    const d: Delivery = {
      videoId: "v",
      platform: "youtube",
      state: "unknown",
      originalAt: Date.now(),
      nextAt: Date.now(),
      successAt: null,
      externalId: null,
      url: null,
      error: "network",
      attempts: 1,
    };
    h.store.delivery(d);
    assert.equal(
      (await h.req("/api/deliveries/v/youtube/retry", {})).status,
      409,
    );
    assert.equal(
      (await h.req("/api/deliveries/v/youtube/retry", { confirmNoPost: true }))
        .status,
      200,
    );
    for (const state of ["processing", "published"] as const) {
      d.state = state;
      h.store.delivery(d);
      assert.equal(
        (
          await h.req("/api/deliveries/v/youtube/retry", {
            confirmNoPost: true,
          })
        ).status,
        409,
      );
    }
    assert.equal(
      (await h.req("/api/deliveries/missing/youtube/retry", {})).status,
      409,
    );
  } finally {
    await h.close();
  }
});

test("HTTP origin rejects non-HTTP schemes even for localhost; media signature accepts only hex", async () => {
  for (const origin of [
    "ftp://localhost",
    "file://localhost",
    "http://remote.example",
    "https://panel.example/path",
    "https://panel.example/",
  ])
    assert.throws(() =>
      createApplication({
        env: {
          SHORTS_PUBLIC_ORIGIN: origin,
          SHORTS_DATA_DIR: "/tmp/never-used-origin-test",
        },
      }),
    );
  const h = await fixture();
  try {
    await h.login();
    h.video();
    const expires = Date.now() + 3600000;
    assert.equal(
      (
        await h.req(
          `/media/v?expires=${expires}&signature=${encodeURIComponent("é".repeat(64))}`,
        )
      ).status,
      403,
    );
  } finally {
    await h.close();
  }
});

test("HTTP rejects expired sessions, invalid disk limits and expired/wrong-session OAuth states", async () => {
  for (const value of ["0", "-1", "1.5", "NaN"])
    assert.throws(() =>
      createApplication({
        env: {
          SHORTS_PUBLIC_ORIGIN: origin,
          SHORTS_DATA_DIR: "/tmp/never-used-limits-test",
          SHORTS_RESERVE_BYTES: value,
        },
      }),
    );
  const h = await fixture();
  try {
    await h.login();
    const key = createHash("sha256")
      .update(h.getCookie().split("=")[1])
      .digest("hex");
    const connect = (await (
      await h.req("/api/connections/youtube/connect", {})
    ).json()) as any;
    const state = new URL(connect.url).searchParams.get("state")!;
    const stateHash = createHash("sha256").update(state).digest("hex");
    h.store.db
      .prepare("UPDATE oauth SET expires=? WHERE state=?")
      .run(0, stateHash);
    assert.equal(
      (await h.req("/api/oauth/youtube/callback?state=" + state + "&code=good"))
        .status,
      403,
    );
    h.store.db
      .prepare("UPDATE oauth SET expires=?, session=? WHERE state=?")
      .run(Date.now() + 60000, "wrong-session", stateHash);
    assert.equal(
      (await h.req("/api/oauth/youtube/callback?state=" + state + "&code=good"))
        .status,
      403,
    );
    h.store.db
      .prepare("UPDATE oauth SET session=? WHERE state=?")
      .run(key, stateHash);
    const denied = await h.req("/api/oauth/youtube/callback?state=" + state);
    assert.equal(denied.headers.get("location"), "/?connection_error=1");
    h.store.db.prepare("UPDATE sessions SET expires=?").run(0);
    assert.equal((await h.req("/api/state")).status, 401);
  } finally {
    await h.close();
  }
});

test("upload budget refuses new data without deleting queued originals", async () => {
  const h = await fixture({ SHORTS_VIDEO_BUDGET_BYTES: "1" });
  try {
    await h.login();
    h.video();
    const response = await h.req("/api/videos", "ftyp", "POST", {
      "Content-Type": "video/mp4",
      "X-Video-Title": "new",
    });
    assert.equal(response.status, 507);
    assert.equal(h.store.videos().length, 1);
  } finally {
    await h.close();
  }
});

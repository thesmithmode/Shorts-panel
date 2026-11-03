import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers } from "../src/server/providers.ts";
import { Store, configKey, tokenKey, type Token } from "../src/server/store.ts";
import {
  PLATFORMS,
  type Platform,
  type Video,
  type Delivery,
} from "../src/shared/model.ts";
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "shorts-provider-"));
  const store = new Store(dir),
    provider = new Providers(store, "https://panel.example");
  for (const p of PLATFORMS)
    store.set(configKey(p), {
      clientId: "test-client",
      clientSecret: "test-secret",
    });
  const token: Token = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: Date.now() + 60 * 86400000,
    account: "test-owner",
    accountId: "account-id",
  };
  const video: Video = {
    id: "v",
    title: "Test video",
    hashtags: "#test",
    filename: "v.mp4",
    bytes: 4,
    createdAt: 1,
    position: 1,
    scheduledAt: 1,
    pinned: false,
    kind: "content",
    state: "dispatched",
    deletedAt: null,
  };
  store.video(video);
  writeFileSync(join(dir, "videos", "v.mp4"), "data");
  const delivery = (p: Platform): Delivery => ({
    videoId: "v",
    platform: p,
    state: "processing",
    originalAt: 1,
    nextAt: 1,
    successAt: null,
    externalId: null,
    url: null,
    error: null,
    attempts: 1,
  });
  const replies: {
    body: unknown;
    status?: number;
    headers?: Record<string, string>;
  }[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: any, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (init?.body && typeof (init.body as any).destroy === "function") {
        for await (const chunk of init.body as any) {
          void chunk;
        }
      }
      const reply = replies.shift();
      assert.ok(reply, "Unexpected request " + input);
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: reply.headers,
      });
    },
  );
  return {
    store,
    provider,
    token,
    video,
    delivery,
    replies,
    calls,
    close() {
      fetchMock.mock.restore();
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const p of ["youtube", "instagram"] as const)
  test(p + " revoked refresh persists reconnect status without losing credentials", async () => {
    const h = harness();
    try {
      const old = { ...h.token, expiresAt: 0 };
      h.store.set(tokenKey(p), old);
      h.replies.push({ status: 400, body: p === "youtube"
        ? { error: "invalid_grant", error_description: "secret-provider-detail" }
        : { error: { code: 190, message: "secret-provider-detail" } } });
      await assert.rejects(() => h.provider.token(p), /повторно подключите/i);
      const connection = h.provider.connections().find(c => c.platform === p)!;
      assert.equal(connection.connected, false);
      assert.match(connection.message, /повторно подключите/i);
      assert.equal(connection.account, old.account);
      assert.ok(!JSON.stringify(connection).includes("secret-provider-detail"));
      const saved = h.store.get<Token>(tokenKey(p))!;
      assert.equal(saved.accessToken, old.accessToken);
      assert.equal(saved.refreshToken, old.refreshToken);
      const reopened = new Store(h.store.dir);
      try {
        const provider = new Providers(reopened, h.provider.origin);
        assert.equal(provider.connections().find(c => c.platform === p)?.connected, false);
        await assert.rejects(() => provider.token(p), /повторно подключите/i);
        assert.equal(h.calls.length, 1, "revoked credentials must not be retried over HTTP");
      } finally { reopened.db.close(); }
      // A failed new authorization must not hide the reconnect warning.
      h.replies.push({ body: { error: "invalid_grant" }, status: 400 });
      await assert.rejects(() => h.provider.exchange(p, "bad-code"));
      assert.equal(h.provider.connections().find(c => c.platform === p)?.connected, false);
      if (p === "youtube") h.replies.push(
        { body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } },
        { body: { items: [{ id: "account-id", snippet: { title: "test-owner" } }] } });
      else h.replies.push(
        { body: { access_token: "short" } },
        { body: { access_token: "new-access", expires_in: 5184000 } },
        { body: { user_id: "account-id", username: "test-owner" } });
      await h.provider.exchange(p, "new-code");
      assert.equal(h.provider.connections().find(c => c.platform === p)?.connected, true);
      assert.equal(h.store.get<Token>(tokenKey(p))?.accessToken, "new-access");
    } finally { h.close(); }
  });

for (const status of [429, 500])
  test("temporary refresh failure " + status + " does not disconnect the account", async () => {
    const h = harness();
    try {
      const old = { ...h.token, expiresAt: 0 };
      h.store.set(tokenKey("youtube"), old);
      h.replies.push({ status, body: { error: "temporarily_unavailable" } });
      await assert.rejects(() => h.provider.token("youtube"));
      assert.deepEqual(h.store.get(tokenKey("youtube")), old);
      assert.equal(h.provider.connections()[0].connected, true);
    } finally { h.close(); }
  });

for (const header of ["600", "date", "invalid", "0", "999999999999999999999999"])
  test("rate limit persists Retry-After " + header + " without discarding tokens", async () => {
    const h = harness();
    const now = Date.now();
    const time = mock.method(Date, "now", () => now);
    try {
      const old = { ...h.token, expiresAt: 0 };
      h.store.set(tokenKey("youtube"), old);
      const until = now + 600_000;
      const value = header === "date" ? new Date(until).toUTCString() : header;
      h.replies.push({ status: 429, headers: { "Retry-After": value }, body: {} });
      await assert.rejects(() => h.provider.token("youtube"));
      const expected = header === "600" ? until : header === "date"
        ? Math.floor(until / 1000) * 1000 : now + 60_000;
      assert.equal(h.provider.notBefore("youtube"), expected);
      const reopened = new Store(h.store.dir);
      try {
        assert.equal(new Providers(reopened, h.provider.origin).notBefore("youtube"), expected);
      } finally { reopened.db.close(); }
      assert.equal(h.provider.notBefore("instagram"), 0);
      assert.deepEqual(h.store.get(tokenKey("youtube")), old);
    } finally { time.mock.restore(); h.close(); }
  });

for (const phase of ["youtube-init", "youtube-session", "youtube-bytes", "youtube-status", "instagram-create", "instagram-status", "instagram-publish"])
  test("429 during " + phase + " preserves external progress and waits before HTTP retry", async () => {
    const h = harness();
    const now = Date.now();
    const time = mock.method(Date, "now", () => now);
    try {
      const p = phase.startsWith("youtube") ? "youtube" : "instagram";
      h.store.set(tokenKey(p), h.token);
      const d = h.delivery(p);
      const location = "https://www.googleapis.com/upload/limited";
      if (phase === "youtube-session") h.store.set("upload:v:youtube", { location });
      if (phase === "youtube-bytes") h.replies.push({ body: {}, headers: { location } });
      if (["youtube-status", "instagram-status", "instagram-publish"].includes(phase)) d.externalId = "existing-id";
      if (phase === "instagram-publish") h.replies.push({ body: { status_code: "FINISHED" } });
      h.replies.push({ status: 429, headers: { "Retry-After": "600" }, body: {} });
      await assert.rejects(() => phase === "youtube-status"
        ? h.provider.verifyYoutube(d) : h.provider.publish(h.video, d));
      assert.equal(h.provider.notBefore(p), now + 600_000);
      assert.equal(h.provider.connections().find(c => c.platform === p)?.connected, true);
      if (phase === "youtube-session" || phase === "youtube-bytes")
        assert.deepEqual(h.store.get("upload:v:youtube"), { location });
      if (phase === "instagram-publish") assert.equal(h.store.get("publishing:v:instagram"), true);
      if (["youtube-status", "instagram-status", "instagram-publish"].includes(phase)) assert.equal(d.externalId, "existing-id");
      const count = h.calls.length;
      await assert.rejects(() => h.provider.token(p));
      assert.equal(h.calls.length, count);
    } finally { time.mock.restore(); h.close(); }
  });

test("YouTube refresh preserves a rotated refresh token", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), { ...h.token, expiresAt: 0 });
    h.replies.push({ body: { access_token: "new", refresh_token: "rotated", expires_in: 3600 } });
    await h.provider.token("youtube");
    assert.equal(h.store.get<Token>(tokenKey("youtube"))?.refreshToken, "rotated");
  } finally { h.close(); }
});

for (const status of [404, 410])
  test("expired YouTube session " + status + " is remembered and never reused automatically", async () => {
    const h = harness();
    try {
      h.store.set(tokenKey("youtube"), h.token);
      const location = "https://www.googleapis.com/upload/expired";
      h.store.set("upload:v:youtube", { location });
      const d = h.delivery("youtube");
      h.replies.push({ status, body: {} });
      await assert.rejects(() => h.provider.publish(h.video, d), /сессия.*истекла/i);
      assert.deepEqual(h.store.get("upload:v:youtube"), { location, expired: true });
      assert.equal(h.provider.canRecover(d), false);
      await assert.rejects(() => h.provider.publish(h.video, d), /сессия.*истекла/i);
      assert.equal(h.calls.length, 1);
      assert.equal(d.externalId, null);
    } finally { h.close(); }
  });

for (const p of ["youtube", "instagram"] as const)
  test(p + " verification detects revoked access and preserves external ID", async () => {
    const h = harness();
    try {
      h.store.set(tokenKey(p), h.token);
      const d = h.delivery(p);
      d.externalId = "existing-id";
      h.replies.push({ status: 401, body: { error: { code: 190 } } });
      await assert.rejects(() => p === "youtube"
        ? h.provider.verifyYoutube(d) : h.provider.publish(h.video, d), /повторно подключите/i);
      assert.equal(h.provider.connections().find(c => c.platform === p)?.connected, false);
      assert.equal(d.externalId, "existing-id");
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  });
test("OAuth configuration, scope and state are platform specific and secrets stay server side", () => {
  const h = harness();
  try {
    h.store.set(configKey("youtube"), null);
    assert.throws(() => h.provider.authorization("youtube", "s"));
    assert.throws(() => h.provider.authorization("tiktok", "s"));
    assert.equal(
      h.provider.connections().find((c) => c.platform === "youtube")
        ?.configured,
      false,
    );
    h.store.set(configKey("youtube"), {
      clientId: "id",
      clientSecret: "secret",
    });
    for (const p of ["youtube", "instagram"] as const) {
      const url = new URL(h.provider.authorization(p, "random-state"));
      assert.equal(url.searchParams.get("state"), "random-state");
      assert.equal(
        url.searchParams.get("redirect_uri"),
        h.provider.callback(p),
      );
      assert.ok(!url.href.includes("secret"));
    }
    h.store.set(tokenKey("youtube"), h.token);
    assert.equal(h.provider.connections()[0].account, "test-owner");
    const media = new URL(h.provider.signedMedia("v"));
    assert.equal(media.pathname, "/media/v");
    assert.equal(media.searchParams.get("signature")?.length, 64);
  } finally {
    h.close();
  }
});
test("Google OAuth stores complete offline token and channel", async () => {
  const h = harness();
  try {
    h.replies.push(
      {
        body: {
          access_token: "new",
          refresh_token: "refresh",
          expires_in: 3600,
        },
      },
      { body: { items: [{ id: "channel", snippet: { title: "Owner" } }] } },
    );
    await h.provider.exchange("youtube", "code");
    assert.equal(h.store.get<Token>(tokenKey("youtube"))?.accountId, "channel");
    assert.equal(h.calls.length, 2);
  } finally {
    h.close();
  }
});
for (const response of [
  {},
  { access_token: "a" },
  { access_token: "a", refresh_token: "r", expires_in: 3600 },
])
  test(
    "incomplete Google authorization never replaces existing connection " +
      JSON.stringify(response),
    async () => {
      const h = harness();
      try {
        h.store.set(tokenKey("youtube"), h.token);
        h.replies.push({ body: response }, { body: { items: [] } });
        await assert.rejects(() => h.provider.exchange("youtube", "code"));
        assert.deepEqual(h.store.get(tokenKey("youtube")), h.token);
      } finally {
        h.close();
      }
    },
  );
test("Instagram OAuth exchanges long-lived credentials and reads own account", async () => {
  const h = harness();
  try {
    h.replies.push(
      { body: { access_token: "short" } },
      { body: { access_token: "long", expires_in: 5184000 } },
      { body: { user_id: "ig-id", username: "creator" } },
    );
    await h.provider.exchange("instagram", "code");
    assert.equal(
      h.store.get<Token>(tokenKey("instagram"))?.accessToken,
      "long",
    );
    assert.equal(h.store.get<Token>(tokenKey("instagram"))?.account, "creator");
  } finally {
    h.close();
  }
});
for (const p of ["youtube", "instagram"] as const)
  test(p + " refresh updates token and preserves account", async () => {
    const h = harness();
    try {
      h.store.set(tokenKey(p), { ...h.token, expiresAt: Date.now() - 1 });
      h.replies.push({ body: { access_token: "refreshed", expires_in: 3600 } });
      const t = await h.provider.token(p);
      assert.equal(t.accessToken, "refreshed");
      assert.equal(t.accountId, "account-id");
      assert.equal(t.refreshToken, "old-refresh");
    } finally {
      h.close();
    }
  });
for (const p of ["youtube", "instagram"] as const)
  test(
    p + " malformed refresh is rejected without losing old credentials",
    async () => {
      const h = harness();
      try {
        const old = { ...h.token, expiresAt: Date.now() - 1 };
        h.store.set(tokenKey(p), old);
        h.replies.push({ body: { expires_in: 3600 } });
        await assert.rejects(() => h.provider.token(p));
        assert.deepEqual(h.store.get(tokenKey(p)), old);
      } finally {
        h.close();
      }
    },
  );
test("valid tokens do not refresh; disconnected and failed authentication reject", async () => {
  const h = harness();
  try {
    await assert.rejects(() => h.provider.token("youtube"));
    h.store.set(tokenKey("youtube"), h.token);
    assert.equal((await h.provider.token("youtube")).accessToken, "old-access");
    assert.equal(h.calls.length, 0);
    h.store.set(tokenKey("youtube"), { ...h.token, expiresAt: 0 });
    h.replies.push({ body: { error: "invalid_grant" }, status: 400 });
    await assert.rejects(() => h.provider.token("youtube"));
    h.store.set(configKey("instagram"), null);
    await assert.rejects(() => h.provider.exchange("instagram", "code"));
  } finally {
    h.close();
  }
});
for (const status of [
  "uploaded",
  "processed",
  "failed",
  "rejected",
  "deleted",
  "missing",
])
  test("YouTube verification: " + status, async () => {
    const h = harness();
    try {
      h.store.set(tokenKey("youtube"), h.token);
      const d = h.delivery("youtube");
      d.externalId = "yt-id";
      h.replies.push({
        body: {
          items:
            status === "missing"
              ? []
              : [{ status: { uploadStatus: status, privacyStatus: "public" } }],
        },
      });
      if (["failed", "rejected", "deleted", "missing"].includes(status))
        await assert.rejects(() => h.provider.verifyYoutube(d));
      else {
        await h.provider.verifyYoutube(d);
        assert.equal(
          d.state,
          status === "processed" ? "published" : "processing",
        );
        assert.equal(d.successAt !== null, status === "processed");
      }
    } finally {
      h.close();
    }
  });
test("YouTube upload confirms public processing, not merely file receipt", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    const d = h.delivery("youtube");
    h.replies.push(
      {
        body: {},
        headers: { location: "https://www.googleapis.com/upload/session" },
      },
      { body: { id: "yt-id" } },
      {
        body: {
          items: [
            { status: { uploadStatus: "processed", privacyStatus: "public" } },
          ],
        },
      },
    );
    await h.provider.publish(h.video, d);
    assert.equal(d.state, "published");
    assert.equal(d.externalId, "yt-id");
    assert.ok(d.successAt);
    assert.equal(h.calls[1].init?.method, "PUT");
  } finally {
    h.close();
  }
});
for (const location of [
  "https://evil.invalid/upload",
  "http://www.googleapis.com/upload/session",
])
  test("reject unsafe upload location " + location, async () => {
    const h = harness();
    try {
      h.store.set(tokenKey("youtube"), h.token);
      h.replies.push({ body: {}, headers: { location } });
      await assert.rejects(() =>
        h.provider.publish(h.video, h.delivery("youtube")),
      );
      assert.equal(h.calls.length, 1);
    } finally {
      h.close();
    }
  });
for (const status of ["IN_PROGRESS", "ERROR", "EXPIRED", "FINISHED"])
  test("Instagram publishing state " + status, async () => {
    const h = harness();
    try {
      h.store.set(tokenKey("instagram"), h.token);
      const d = h.delivery("instagram");
      h.replies.push(
        { body: { id: "container" } },
        { body: { status_code: status } },
        { body: { id: "post-id" } },
        {
          body: { id: "post-id", permalink: "https://instagram.com/reel/test" },
        },
      );
      if (["ERROR", "EXPIRED"].includes(status))
        await assert.rejects(() => h.provider.publish(h.video, d));
      else {
        await h.provider.publish(h.video, d);
        assert.equal(
          d.state,
          status === "FINISHED" ? "published" : "processing",
        );
        assert.equal(
          h.calls.filter((c) => c.url.includes("media_publish")).length,
          status === "FINISHED" ? 1 : 0,
        );
      }
    } finally {
      h.close();
    }
  });
test("Instagram publication is successful even if optional permalink lookup fails", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("instagram"), h.token);
    const d = h.delivery("instagram");
    h.replies.push(
      { body: { id: "container" } },
      { body: { status_code: "FINISHED" } },
      { body: { id: "post-id" } },
      { body: { error: "temporary" }, status: 503 },
    );
    await h.provider.publish(h.video, d);
    assert.equal(d.state, "published");
    assert.equal(d.externalId, "post-id");
    assert.ok(d.successAt);
  } finally {
    h.close();
  }
});

test("unsupported TikTok OAuth exchange never pretends success", async () => {
  const h = harness();
  try {
    await assert.rejects(() => h.provider.exchange("tiktok", "code"));
    assert.equal(h.calls.length, 0);
  } finally {
    h.close();
  }
});

for (const expiry of [0, -1, 1.5, Infinity, "3600", 999999999])
  test("token expiry validation rejects " + expiry, async () => {
    const h = harness();
    try {
      const old = { ...h.token, expiresAt: 0 };
      h.store.set(tokenKey("youtube"), old);
      h.replies.push({ body: { access_token: "new", expires_in: expiry } });
      await assert.rejects(() => h.provider.token("youtube"));
      assert.deepEqual(h.store.get(tokenKey("youtube")), old);
    } finally {
      h.close();
    }
  });
for (const response of [
  { body: {}, status: 400 },
  { body: {} },
  { body: {}, headers: { location: "https://www.googleapis.com/upload/x" } },
])
  test(
    "YouTube incomplete upload acknowledgement is never a publication success " +
      JSON.stringify(response),
    async () => {
      const h = harness();
      try {
        h.store.set(tokenKey("youtube"), h.token);
        h.replies.push(response, { body: {}, status: 400 });
        const d = h.delivery("youtube");
        await assert.rejects(() => h.provider.publish(h.video, d));
        assert.equal(d.successAt, null);
        assert.notEqual(d.state, "published");
      } finally {
        h.close();
      }
    },
  );

test('Instagram already published container becomes confirmed without publishing again',async()=>{const h=harness();try{h.store.set(tokenKey('instagram'),h.token);const d=h.delivery('instagram');d.externalId='container';h.store.set('published:v:instagram','post-id');h.replies.push({body:{status_code:'PUBLISHED'}});await h.provider.publish(h.video,d);assert.equal(d.state,'published');assert.equal(d.externalId,'post-id');assert.ok(d.successAt);assert.equal(h.calls.length,1);}finally{h.close();}});

test("token refresh failure before a new upload is explicitly safe to retry", async () => {
  const { RetryableBeforeSend } = await import("../src/server/contracts.ts");
  assert.equal(typeof RetryableBeforeSend, "function");
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), { ...h.token, expiresAt: 0 });
    h.replies.push({ status: 503, body: { error: "unavailable" } });
    await assert.rejects(() => h.provider.publish(h.video, h.delivery("youtube")), RetryableBeforeSend);
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

test("YouTube resumes an interrupted session from the server-confirmed byte", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    h.store.set("upload:v:youtube", { location: "https://www.googleapis.com/upload/session" });
    h.replies.push(
      { status: 308, body: {}, headers: { range: "bytes=0-1" } },
      { body: { id: "yt-resumed" } },
      { body: { items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] } },
    );
    const d = h.delivery("youtube");
    await h.provider.publish(h.video, d);
    assert.equal(d.state, "published");
    assert.equal(h.calls[0].init?.method, "PUT");
    assert.equal(new Headers(h.calls[0].init?.headers).get("content-range"), "bytes */4");
    assert.equal(new Headers(h.calls[1].init?.headers).get("content-range"), "bytes 2-3/4");
    assert.equal(new Headers(h.calls[1].init?.headers).get("content-length"), "2");
  } finally { h.close(); }
});

test("YouTube recovers the ID from a completed session without uploading twice", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    h.store.set("upload:v:youtube", { location: "https://www.googleapis.com/upload/session" });
    h.replies.push({ body: { id: "yt-existing" } }, { body: { items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] } });
    const d = h.delivery("youtube");
    await h.provider.publish(h.video, d);
    assert.equal(d.externalId, "yt-existing");
    assert.equal(h.calls.length, 2);
    assert.equal(new Headers(h.calls[0].init?.headers).get("content-range"), "bytes */4");
  } finally { h.close(); }
});

test("expired YouTube session never silently starts a new upload", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    h.store.set("upload:v:youtube", { location: "https://www.googleapis.com/upload/session" });
    h.replies.push({ status: 404, body: {} });
    await assert.rejects(() => h.provider.publish(h.video, h.delivery("youtube")));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init?.method, "PUT");
  } finally { h.close(); }
});

for (const range of ["bytes=1-2", "bytes=0-3", "bytes=0-99999999999999999"]) {
  test(`YouTube refuses invalid resume range ${range}`, async () => {
    const h = harness();
    try {
      h.store.set(tokenKey("youtube"), h.token);
      h.store.set("upload:v:youtube", { location: "https://www.googleapis.com/upload/session" });
      h.replies.push({ status: 308, body: {}, headers: { range } });
      await assert.rejects(() => h.provider.publish(h.video, h.delivery("youtube")));
      assert.equal(h.calls.length, 1);
    } finally { h.close(); }
  });
}

test("YouTube session recovery validates stored addresses and starts at zero when no bytes were acknowledged", async () => {
  const h = harness();
  try {
    const d = h.delivery("youtube");
    assert.equal(h.provider.canRecover(d), false);
    h.store.set("upload:v:youtube", { location: "https://evil.invalid/upload" });
    assert.equal(h.provider.canRecover(d), false);
    assert.equal(h.provider.canRecover(h.delivery("instagram")), false);
    h.store.set("upload:v:youtube", { location: "https://www.googleapis.com/upload/session" });
    assert.equal(h.provider.canRecover(d), true);
    h.store.set(tokenKey("youtube"), h.token);
    h.replies.push({ status: 308, body: {} }, { body: { id: "yt-id" } }, { body: { items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] } });
    await h.provider.publish(h.video, d);
    assert.equal(new Headers(h.calls[1].init?.headers).get("content-range"), "bytes 0-3/4");
  } finally { h.close(); }
});

test("temporary error after recording YouTube session triggers safe reconciliation", async () => {
  const { RetryableSession } = await import("../src/server/contracts.ts");
  assert.equal(typeof RetryableSession, "function");
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    h.replies.push({ body: {}, headers: { location: "https://www.googleapis.com/upload/session" } }, { status: 503, body: {} });
    await assert.rejects(() => h.provider.publish(h.video, h.delivery("youtube")), RetryableSession);
    assert.equal(h.provider.canRecover(h.delivery("youtube")), true);
  } finally { h.close(); }
});

test("temporary YouTube status check error can be retried without another upload", async () => {
  const { RetryableSession } = await import("../src/server/contracts.ts");
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    h.replies.push({ status: 503, body: {} });
    const d = h.delivery("youtube"); d.externalId = "known-video";
    await assert.rejects(() => h.provider.verifyYoutube(d), RetryableSession);
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].url.includes("videos?"));
  } finally { h.close(); }
});

test("Instagram container status lookup failure can be retried without creating a second container", async () => {
  const { RetryableSession } = await import("../src/server/contracts.ts");
  const h = harness();
  try {
    h.store.set(tokenKey("instagram"), h.token);
    const d = h.delivery("instagram"); d.externalId = "known-container";
    h.replies.push({ status: 503, body: {} });
    await assert.rejects(() => h.provider.publish(h.video, d), RetryableSession);
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].url.includes("known-container"));
  } finally { h.close(); }
});

test("ambiguous Instagram publish is reconciled through the existing container without posting twice", async () => {
  const { RetryableSession } = await import("../src/server/contracts.ts");
  const h = harness();
  try {
    h.store.set(tokenKey("instagram"), h.token);
    const d = h.delivery("instagram"); d.externalId = "container";
    h.replies.push({ body: { status_code: "FINISHED" } }, { status: 503, body: {} });
    await assert.rejects(() => h.provider.publish(h.video, d), RetryableSession);
    h.replies.push({ body: { status_code: "PUBLISHED" } });
    await h.provider.publish(h.video, d);
    assert.equal(d.state, "published");
    assert.equal(h.calls.filter((call) => call.url.includes("media_publish")).length, 1);
  } finally { h.close(); }
});

test("unconfirmed Instagram publish never repeats even when container remains finished", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("instagram"), h.token);
    h.store.set("publishing:v:instagram", true);
    const d = h.delivery("instagram"); d.externalId = "container";
    h.replies.push({ body: { status_code: "FINISHED" } });
    await assert.rejects(() => h.provider.publish(h.video, d));
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

test("Instagram malformed status response does not leave a delivery processing forever", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("instagram"), h.token);
    const d = h.delivery("instagram"); d.externalId = "container";
    h.replies.push({ body: {} });
    await assert.rejects(() => h.provider.publish(h.video, d));
    assert.equal(h.calls.length, 1);
  } finally { h.close(); }
});

test("Instagram refuses an incomplete container creation response without issuing a status request", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("instagram"), h.token);
    const d = h.delivery("instagram");
    h.replies.push({ body: {} });
    await assert.rejects(() => h.provider.publish(h.video, d));
    assert.equal(h.calls.length, 1);
    assert.equal(d.externalId, null);
  } finally { h.close(); }
});

for (const platform of ["youtube", "instagram"] as const) {
  test(`${platform} refuses to initiate publication when original is missing`, async () => {
    const { SourceUnavailable } = await import("../src/server/contracts.ts");
    assert.equal(typeof SourceUnavailable, "function");
    const h = harness();
    try {
      h.store.set(tokenKey(platform), h.token);
      rmSync(join(h.store.dir, "videos", h.video.filename));
      await assert.rejects(() => h.provider.publish(h.video, h.delivery(platform)), SourceUnavailable);
      assert.equal(h.calls.length, 0);
    } finally { h.close(); }
  });
}

test("completed YouTube upload can still be confirmed even when local original is missing", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    h.store.set("upload:v:youtube", { location: "https://www.googleapis.com/upload/session" });
    rmSync(join(h.store.dir, "videos", h.video.filename));
    h.replies.push({ body: { id: "already-uploaded" } }, { body: { items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] } });
    const d = h.delivery("youtube");
    await h.provider.publish(h.video, d);
    assert.equal(d.state, "published");
  } finally { h.close(); }
});

test("a truncated original cannot start a new YouTube upload", async () => {
  const { SourceUnavailable } = await import("../src/server/contracts.ts");
  const h = harness();
  try {
    h.store.set(tokenKey("youtube"), h.token);
    writeFileSync(join(h.store.dir, "videos", h.video.filename), "x");
    await assert.rejects(() => h.provider.publish(h.video, h.delivery("youtube")), SourceUnavailable);
    assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test("published Instagram container can be confirmed even when local original is missing", async () => {
  const h = harness();
  try {
    h.store.set(tokenKey("instagram"), h.token);
    rmSync(join(h.store.dir, "videos", h.video.filename));
    const d = h.delivery("instagram"); d.externalId = "container";
    h.replies.push({ body: { status_code: "PUBLISHED" } });
    await h.provider.publish(h.video, d);
    assert.equal(d.state, "published");
  } finally { h.close(); }
});

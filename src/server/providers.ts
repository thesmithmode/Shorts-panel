import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import {
  Store,
  configKey,
  tokenKey,
  type AppConfig,
  type Token,
} from "./store.ts";
import type { Platform, Video, Delivery, Connection } from "../shared/model.ts";
import { AccessRequired, RateLimited, UploadSessionExpired, RetryableBeforeSend, RetryableSession, SourceUnavailable } from "./contracts.ts";
function tokenResponse(value: any): {
  access_token: string;
  expires_in: number;
} {
  if (
    typeof value?.access_token !== "string" ||
    !value.access_token.trim() ||
    !Number.isSafeInteger(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 366 * 86400
  )
    throw new Error(
      "Неполный ответ авторизации. Прежнее подключение сохранено.",
    );
  return value;
}
const IG = "https://graph.instagram.com/v25.0";
function checkRateLimit(response: Response): void {
  if (response.status !== 429) return;
  const now = Date.now();
  const header = response.headers.get("retry-after")?.trim() ?? "";
  const retryAt = /^\d+$/.test(header)
    ? now + Number(header) * 1000 : Date.parse(header);
  // Invalid, past, zero or overflowing values use a bounded one-minute fallback.
  throw new RateLimited(Number.isSafeInteger(retryAt) && retryAt > now && retryAt <= 8.64e15
    ? retryAt : now + 60_000);
}
async function sessionFetch(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new RetryableSession("Не удалось связаться с сессией загрузки", { cause });
  }
  checkRateLimit(response);
  if (response.status >= 500)
    throw new RetryableSession("Временная ошибка сессии загрузки");
  return response;
}
async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(45_000),
  });
  checkRateLimit(response);
  if (response.status === 401) throw new AccessRequired();
  const body = (await response.json()) as any;
  // Only explicit authorization failures. Quotas/5xx are not revoked access.
  if (response.status < 500 && response.status !== 429 &&
      (body?.error === "invalid_grant" || body?.error === "invalid_client" || body?.error?.code === 190))
    throw new AccessRequired();
  if (!response.ok || body.error)
    throw new Error(
      "Площадка отклонила запрос. Проверьте разрешения и подключение аккаунта.",
    );
  return body;
}
export class Providers {
  constructor(
    private store: Store,
    public origin: string,
  ) {}
  notBefore(p: Platform): number {
    return this.store.get<number>(`cooldown:${p}`) ?? 0;
  }
  private rememberRateLimit(p: Platform, error: unknown): void {
    if (error instanceof RateLimited)
      this.store.set(`cooldown:${p}`, Math.max(this.notBefore(p), error.retryAt));
  }
  private requireAccess(p: Platform): never {
    const token = this.store.get<Token>(tokenKey(p));
    if (token) this.store.set(tokenKey(p), { ...token, requiresReconnect: true });
    throw new AccessRequired();
  }
  private async request(p: Platform, url: string, init?: RequestInit) {
    try {
      if (this.notBefore(p) > Date.now()) throw new RateLimited(this.notBefore(p));
      return await json(url, init);
    } catch (error) {
      this.rememberRateLimit(p, error);
      if (error instanceof AccessRequired) this.requireAccess(p);
      throw error;
    }
  }
  private async sessionRequest(url: string, init: RequestInit) {
    try {
      const response = await sessionFetch(url, init);
      if (response.status === 401) this.requireAccess("youtube");
      return response;
    } catch (error) {
      this.rememberRateLimit("youtube", error);
      throw error;
    }
  }
  callback(p: Platform) {
    return `${this.origin}/api/oauth/${p}/callback`;
  }
  connections(): Connection[] {
    return (["youtube", "instagram", "tiktok"] as const).map((platform) => {
      const c = this.store.get<AppConfig>(configKey(platform));
      const t = this.store.get<Token>(tokenKey(platform));
      return {
        platform,
        configured: !!c,
        connected: !!c && !!t && !t.requiresReconnect,
        account: t?.account ?? null,
        expiresAt: t?.expiresAt ?? null,
        message:
          platform === "tiktok"
            ? "Нужен одобренный Direct Post: способ подключения ещё не выбран."
            : t?.requiresReconnect
              ? new AccessRequired().message
              : t
              ? "Аккаунт подключён"
              : c
                ? "Войдите и разрешите публикацию"
                : "Укажите данные OAuth-приложения",
      };
    });
  }
  authorization(p: Platform, state: string) {
    const c = this.store.get<AppConfig>(configKey(p));
    if (!c || p === "tiktok")
      throw new Error("Сначала настройте OAuth-приложение");
    const u = new URL(
      p === "youtube"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : "https://www.instagram.com/oauth/authorize",
    );
    const values =
      p === "youtube"
        ? {
            client_id: c.clientId,
            redirect_uri: this.callback(p),
            response_type: "code",
            scope:
              "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
            access_type: "offline",
            prompt: "consent",
            state,
          }
        : {
            client_id: c.clientId,
            redirect_uri: this.callback(p),
            response_type: "code",
            scope:
              "instagram_business_basic,instagram_business_content_publish",
            state,
            enable_fb_login: "0",
            force_authentication: "1",
          };
    for (const [key, value] of Object.entries(values))
      u.searchParams.set(key, value);
    return u.href;
  }
  async exchange(p: Platform, code: string) {
    if (p === "tiktok") throw new Error("Direct Post TikTok ещё не настроен");
    const c = this.store.get<AppConfig>(configKey(p));
    if (!c) throw new Error("Нет конфигурации");
    if (p === "youtube") {
      const t = await json("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: this.callback(p),
        }),
      });
      if (!t.access_token || !t.refresh_token)
        throw new Error(
          "Google не выдал долгосрочное разрешение. Повторите подключение.",
        );
      tokenResponse(t);
      const channel = await json(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${t.access_token}` } },
      );
      if (!channel.items?.[0]) throw new Error("Канал не найден");
      this.store.set(tokenKey(p), {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: Date.now() + t.expires_in * 1000,
        account: channel.items[0].snippet.title,
        accountId: channel.items[0].id,
      });
    } else if (p === "instagram") {
      const form = new FormData();
      for (const [k, v] of Object.entries({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: this.callback(p),
      }))
        form.set(k, v);
      const short = await json("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        body: form,
      });
      const t = await json(
        "https://graph.instagram.com/access_token?" +
          new URLSearchParams({
            grant_type: "ig_exchange_token",
            client_secret: c.clientSecret,
            access_token: short.access_token,
          }),
      );
      const me = await json(
        `${IG}/me?` +
          new URLSearchParams({
            fields: "user_id,username",
            access_token: t.access_token,
          }),
      );
      tokenResponse(t);
      if (!t.access_token || !me.user_id || !me.username)
        throw new Error("Неполный ответ Instagram");
      this.store.set(tokenKey(p), {
        accessToken: t.access_token,
        expiresAt: Date.now() + t.expires_in * 1000,
        account: me.username,
        accountId: me.user_id,
      });
    }
  }
  async token(p: Platform): Promise<Token> {
    const t = this.store.get<Token>(tokenKey(p));
    const c = this.store.get<AppConfig>(configKey(p));
    if (!t || !c) throw new Error("Подключите аккаунт");
    if (t.requiresReconnect) throw new AccessRequired();
    if (this.notBefore(p) > Date.now()) throw new RateLimited(this.notBefore(p));
    if (p === "youtube" && t.expiresAt < Date.now() + 120_000) {
      const r = await this.request(p, "https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          refresh_token: t.refreshToken!,
          grant_type: "refresh_token",
        }),
      });
      tokenResponse(r);
      if (typeof r.refresh_token === "string" && r.refresh_token.trim())
        t.refreshToken = r.refresh_token;
      t.accessToken = r.access_token;
      t.expiresAt = Date.now() + r.expires_in * 1000;
      this.store.set(tokenKey(p), t);
    } else if (
      p === "instagram" &&
      t.expiresAt < Date.now() + 30 * 86_400_000
    ) {
      const r = await this.request(p,
        "https://graph.instagram.com/refresh_access_token?" +
          new URLSearchParams({
            grant_type: "ig_refresh_token",
            access_token: t.accessToken,
          }),
      );
      tokenResponse(r);
      t.accessToken = r.access_token;
      t.expiresAt = Date.now() + r.expires_in * 1000;
      this.store.set(tokenKey(p), t);
    }
    return t;
  }
  signedMedia(videoId: string) {
    const expires = Date.now() + 6 * 3_600_000;
    const sig = createHmac("sha256", this.store.key)
      .update(`${videoId}:${expires}`)
      .digest("hex");
    return `${this.origin}/media/${videoId}?expires=${expires}&signature=${sig}`;
  }
  private validateYoutubeLocation(location: string) {
    const url = new URL(location);
    if (url.hostname !== "www.googleapis.com" || url.protocol !== "https:" || url.username || url.password || url.port)
      throw new Error("Некорректный адрес загрузки");
  }
  canRecover(d: Delivery) {
    if (d.platform !== "youtube") return false;
    const session = this.store.get<{ location?: unknown; expired?: boolean }>(`upload:${d.videoId}:youtube`);
    if (session?.expired || typeof session?.location !== "string") return false;
    try {
      this.validateYoutubeLocation(session.location);
      return true;
    } catch {
      return false;
    }
  }
  private requireSource(v: Video) {
    try {
      const file = statSync(join(this.store.dir, "videos", v.filename));
      if (file.isFile() && file.size === v.bytes) return;
    } catch {
      // Missing or inaccessible originals require restoration, not an API request.
    }
    throw new SourceUnavailable("Исходный файл недоступен или повреждён");
  }
  async publish(v: Video, d: Delivery): Promise<void> {
    let token: Token;
    try {
      token = await this.token(d.platform);
    } catch (cause) {
      if (cause instanceof AccessRequired || cause instanceof RateLimited) throw cause;
      throw new RetryableBeforeSend("Не удалось обновить доступ к площадке", { cause });
    }
    const save = () => this.store.delivery(d);
    if (d.platform === "youtube") {
      // A recorded session may already have completed. Probe it before sending bytes.
      const stored = this.store.get<{ location: string; expired?: boolean }>(`upload:${v.id}:youtube`);
      if (stored?.expired) throw new UploadSessionExpired();
      const checkExpiry = (response: Response, location: string) => {
        if (response.status === 404 || response.status === 410) {
          this.store.set(`upload:${v.id}:youtube`, { location, expired: true });
          throw new UploadSessionExpired();
        }
      };
      let location = stored?.location;
      let offset = 0;
      let result: any;
      if (location) {
        this.validateYoutubeLocation(location);
        const probe = await this.sessionRequest(location, {
          method: "PUT",
          redirect: "error",
          headers: { "Content-Length": "0", "Content-Range": `bytes */${v.bytes}` },
          signal: AbortSignal.timeout(45_000),
        });
        checkExpiry(probe, location);
        if (probe.status === 308) {
          const range = probe.headers.get("range");
          if (range) {
            const match = /^bytes=0-(\d+)$/.exec(range);
            if (!match) throw new Error("Некорректное смещение загрузки YouTube");
            offset = Number(match[1]) + 1;
            if (!Number.isSafeInteger(offset) || offset >= v.bytes)
              throw new Error("Некорректное смещение загрузки YouTube");
          }
        } else if (probe.ok) {
          result = await probe.json();
          if (!result?.id) throw new Error("Нет ID YouTube");
        } else throw new Error("Не удалось восстановить загрузку YouTube");
      } else {
        this.requireSource(v);
        const init = await fetch(
          "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
              "Content-Type": "application/json",
              "X-Upload-Content-Type": "video/mp4",
              "X-Upload-Content-Length": String(v.bytes),
            },
            body: JSON.stringify({
              snippet: { title: v.title, description: v.hashtags, categoryId: "22" },
              status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
            }),
            signal: AbortSignal.timeout(45_000),
          },
        );
        try { checkRateLimit(init); }
        catch (error) { this.rememberRateLimit("youtube", error); throw error; }
        if (init.status === 401) this.requireAccess("youtube");
        location = init.headers.get("location") ?? undefined;
        if (!init.ok || !location) throw new Error("YouTube не создал загрузку");
        this.validateYoutubeLocation(location);
        this.store.set(`upload:${v.id}:youtube`, { location });
      }
      if (!result) {
        this.requireSource(v);
        const response = await this.sessionRequest(location!, {
          method: "PUT",
          redirect: "error",
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(v.bytes - offset),
            ...(stored ? { "Content-Range": `bytes ${offset}-${v.bytes - 1}/${v.bytes}` } : {}),
          },
          body: createReadStream(join(this.store.dir, "videos", v.filename), { start: offset }) as any,
          duplex: "half",
          signal: AbortSignal.timeout(15 * 60_000),
        } as any);
        checkExpiry(response, location!);
        if (response.status === 308) throw new RetryableSession("Загрузка частично принята");
        if (!response.ok) throw new Error("Не удалось подтвердить загрузку YouTube");
        result = await response.json();
        if (!result.id) throw new Error("Нет ID YouTube");
      }
      d.externalId = result.id;
      save();
    } else if (d.platform === "instagram") {
      if (!d.externalId) {
        this.requireSource(v);
        const r = await this.request("instagram", `${IG}/${token.accountId}/media`, {
          method: "POST",
          body: new URLSearchParams({
            media_type: "REELS",
            video_url: this.signedMedia(v.id),
            caption: `${v.title}\n${v.hashtags}`,
            access_token: token.accessToken,
          }),
        });
        if (typeof r.id !== "string" || !r.id.trim())
          throw new Error("Instagram не подтвердил ID контейнера");
        d.externalId = r.id;
        save();
      }
      let status: any;
      try {
        status = await this.request("instagram",
          `${IG}/${d.externalId}?` +
            new URLSearchParams({
              fields: "status_code",
              access_token: token.accessToken,
            }),
        );
      } catch (cause) {
        if (cause instanceof AccessRequired || cause instanceof RateLimited) throw cause;
        throw new RetryableSession("Не удалось проверить контейнер Instagram", { cause });
      }
      if (status.status_code === "PUBLISHED") {
        const publishedId = this.store.get<string>(`published:${v.id}:instagram`);
        if (publishedId) d.externalId = publishedId;
        d.state = "published";
        d.successAt = Date.now();
        d.error = null;
        save();
        return;
      }
      if (status.status_code !== "FINISHED") {
        if (status.status_code === "ERROR" || status.status_code === "EXPIRED")
          throw new Error("Instagram не обработал видео");
        if (status.status_code !== "IN_PROGRESS")
          throw new RetryableSession("Instagram вернул неизвестный статус контейнера");
        d.state = "processing";
        d.nextAt = Date.now() + 30_000;
        save();
        return;
      }
      const publishingKey = `publishing:${v.id}:instagram`;
      if (this.store.get<boolean>(publishingKey))
        throw new Error("Instagram ещё не подтвердил результат публикации");
      // Persist before the request: a crash must never cause a blind second post.
      this.store.set(publishingKey, true);
      let published: any;
      try {
        published = await this.request("instagram", `${IG}/${token.accountId}/media_publish`, {
          method: "POST",
          body: new URLSearchParams({
            creation_id: d.externalId!,
            access_token: token.accessToken,
          }),
        });
      } catch (cause) {
        if (cause instanceof AccessRequired || cause instanceof RateLimited) throw cause;
        throw new RetryableSession("Проверим результат публикации Instagram", { cause });
      }
      this.store.set(`published:${v.id}:instagram`, published.id);
      if (typeof published.id !== "string" || !published.id)
        throw new Error("Instagram не подтвердил ID публикации");
      d.externalId = published.id;
      d.state = "published";
      d.successAt = Date.now();
      d.error = null;
      save();
      // Publishing success is durable before optional permalink enrichment.
      try {
        const media = await this.request("instagram",
          `${IG}/${published.id}?` +
            new URLSearchParams({
              fields: "id,permalink",
              access_token: token.accessToken,
            }),
        );
        d.url = typeof media.permalink === "string" ? media.permalink : null;
        save();
      } catch {
        /* A missing permalink must not schedule a second post. */
      }

      return;
    } else throw new Error("Direct Post TikTok ещё не настроен");
    await this.verifyYoutube(d, token);
  }
  async verifyYoutube(d: Delivery, token?: Token) {
    let r: any;
    try {
      const t = token ?? (await this.token("youtube"));
      r = await this.request("youtube",
        "https://www.googleapis.com/youtube/v3/videos?" +
          new URLSearchParams({
            part: "status,processingDetails",
            id: d.externalId!,
          }),
        { headers: { Authorization: `Bearer ${t.accessToken}` } },
      );
    } catch (cause) {
      if (cause instanceof AccessRequired || cause instanceof RateLimited) throw cause;
      throw new RetryableSession("Не удалось проверить статус YouTube", { cause });
    }
    const video = r.items?.[0];
    if (!video) throw new Error("Загрузка YouTube не найдена");
    if (
      video.status?.uploadStatus === "processed" &&
      video.status?.privacyStatus === "public"
    ) {
      d.state = "published";
      d.successAt = Date.now();
      d.url = `https://www.youtube.com/watch?v=${d.externalId}`;
      d.error = null;
    } else if (
      ["failed", "rejected", "deleted"].includes(video.status?.uploadStatus)
    )
      throw new Error("YouTube отклонил видео");
    else {
      d.state = "processing";
      d.nextAt = Date.now() + 30_000;
    }
    this.store.delivery(d);
  }
}

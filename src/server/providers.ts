import { createReadStream } from "node:fs";
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
import { RetryableBeforeSend } from "./contracts.ts";
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
async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await response.json()) as any;
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
        connected: !!t,
        account: t?.account ?? null,
        expiresAt: t?.expiresAt ?? null,
        message:
          platform === "tiktok"
            ? "Нужен одобренный Direct Post: способ подключения ещё не выбран."
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
    if (p === "youtube" && t.expiresAt < Date.now() + 120_000) {
      const r = await json("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          refresh_token: t.refreshToken!,
          grant_type: "refresh_token",
        }),
      });
      tokenResponse(r);
      t.accessToken = r.access_token;
      t.expiresAt = Date.now() + r.expires_in * 1000;
      this.store.set(tokenKey(p), t);
    } else if (
      p === "instagram" &&
      t.expiresAt < Date.now() + 30 * 86_400_000
    ) {
      const r = await json(
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
  async publish(v: Video, d: Delivery): Promise<void> {
    let token: Token;
    try {
      token = await this.token(d.platform);
    } catch (cause) {
      throw new RetryableBeforeSend("Не удалось обновить доступ к площадке", { cause });
    }
    const save = () => this.store.delivery(d);
    if (d.platform === "youtube") {
      // Persist resumable session before uploading. Never retry an ambiguous final upload.
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
            snippet: {
              title: v.title,
              description: v.hashtags,
              categoryId: "22",
            },
            status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
          }),
          signal: AbortSignal.timeout(45_000),
        },
      );
      const location = init.headers.get("location");
      if (!init.ok || !location) throw new Error("YouTube не создал загрузку");
      if (
        new URL(location).hostname !== "www.googleapis.com" ||
        new URL(location).protocol !== "https:"
      )
        throw new Error("Некорректный адрес загрузки");
      this.store.set(`upload:${v.id}:youtube`, { location });
      const response = await fetch(location, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(v.bytes),
        },
        body: createReadStream(
          join(this.store.dir, "videos", v.filename),
        ) as any,
        duplex: "half",
        signal: AbortSignal.timeout(15 * 60_000),
      } as any);
      if (!response.ok)
        throw new Error("Не удалось подтвердить загрузку YouTube");
      const result = (await response.json()) as any;
      if (!result.id) throw new Error("Нет ID YouTube");
      d.externalId = result.id;
      save();
    } else if (d.platform === "instagram") {
      if (!d.externalId) {
        const r = await json(`${IG}/${token.accountId}/media`, {
          method: "POST",
          body: new URLSearchParams({
            media_type: "REELS",
            video_url: this.signedMedia(v.id),
            caption: `${v.title}\n${v.hashtags}`,
            access_token: token.accessToken,
          }),
        });
        d.externalId = r.id;
        save();
      }
      const status = await json(
        `${IG}/${d.externalId}?` +
          new URLSearchParams({
            fields: "status_code",
            access_token: token.accessToken,
          }),
      );
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
        d.state = "processing";
        d.nextAt = Date.now() + 30_000;
        save();
        return;
      }
      const published = await json(`${IG}/${token.accountId}/media_publish`, {
        method: "POST",
        body: new URLSearchParams({
          creation_id: d.externalId!,
          access_token: token.accessToken,
        }),
      });
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
        const media = await json(
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
    const t = token ?? (await this.token("youtube"));
    const r = await json(
      "https://www.googleapis.com/youtube/v3/videos?" +
        new URLSearchParams({
          part: "status,processingDetails",
          id: d.externalId!,
        }),
      { headers: { Authorization: `Bearer ${t.accessToken}` } },
    );
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

import express from "express";
import {
  createHash,
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  createWriteStream,
  readFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  statfsSync,
  openSync,
  readSync,
  closeSync,
  fsyncSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Store, passwordCheck, configKey, tokenKey } from "./store.ts";
import { Providers } from "./providers.ts";
import { Engine } from "./engine.ts";
import { groupDeliveries } from "../shared/deliveries.ts";
import { PLATFORMS, type Platform, type Video } from "../shared/model.ts";
import { parseMoscow, recoveryAt } from "../shared/scheduler.ts";
import { validateVideoMetadata } from "./media.ts";
import { releaseIdentity } from "./health.ts";
export interface ApplicationOptions {
  env?: NodeJS.ProcessEnv;
  store?: Store;
  providers?: Pick<
    Providers,
    "connections" | "authorization" | "exchange" | "publish" | "verifyYoutube"
  >;
}
export function createApplication(options: ApplicationOptions = {}) {
  const env = options.env ?? process.env;
  const release = releaseIdentity(
    existsSync(resolve("release-sha"))
      ? readFileSync(resolve("release-sha"), "utf8")
      : undefined,
  );
  const dir = resolve(env.SHORTS_DATA_DIR ?? "data");
  const origin = env.SHORTS_PUBLIC_ORIGIN ?? "http://127.0.0.1:5173";
  const publicUrl = new URL(origin);
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    (publicUrl.protocol !== "https:" &&
      !["127.0.0.1", "localhost"].includes(publicUrl.hostname))
  )
    throw new Error("Production requires HTTPS");
  if (publicUrl.origin !== origin)
    throw new Error(
      "SHORTS_PUBLIC_ORIGIN must be an origin without path or trailing slash",
    );
  const secure = publicUrl.protocol === "https:";
  const cookieName = secure ? "__Host-shorts_session" : "shorts_session";
  const reserve = Number(env.SHORTS_RESERVE_BYTES ?? 2 * 1024 ** 3);
  const budget = Number(env.SHORTS_VIDEO_BUDGET_BYTES ?? 6 * 1024 ** 3);
  const maxFile = Number(env.SHORTS_MAX_FILE_BYTES ?? 1024 ** 3);
  if (
    [reserve, budget, maxFile].some((n) => !Number.isSafeInteger(n) || n <= 0)
  )
    throw new Error("Invalid disk limits");
  const store = options.store ?? new Store(dir);
  const providers = options.providers ?? new Providers(store, origin);
  const engine = new Engine(store, providers);
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (secure) res.set("Strict-Transport-Security", "max-age=31536000");
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  function session(req: express.Request) {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!cookie) return null;
    const key = hash(cookie);
    const r = store.db
      .prepare("SELECT hash,csrf,expires FROM sessions WHERE hash=?")
      .get(key) as { hash: string; csrf: string; expires: number } | undefined;
    return r && r.expires > Date.now() ? r : null;
  }
  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, service: "shorts-panel", release }),
  );
  const failures = new Map<string, { n: number; start: number }>();
  app.post("/api/login", (req, res) => {
    if (req.headers.origin !== origin)
      return res.status(403).json({ error: "Неверный источник запроса" });
    const key = req.socket.remoteAddress ?? "local";
    const item = failures.get(key);
    if (item && item.start > Date.now() - 15 * 60_000 && item.n >= 8)
      return res
        .status(429)
        .json({ error: "Слишком много попыток. Подождите 15 минут." });
    const password = req.body?.password;
    const stored = store.get<string>("password");
    if (
      typeof password !== "string" ||
      password.length > 1024 ||
      !stored ||
      !passwordCheck(password, stored)
    ) {
      failures.set(
        key,
        item && item.start > Date.now() - 15 * 60_000
          ? { ...item, n: item.n + 1 }
          : { start: Date.now(), n: 1 },
      );
      return res
        .status(401)
        .json({ error: "Неверный пароль либо доступ ещё не настроен" });
    }
    failures.delete(key);
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    store.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(hash(token), csrf, Date.now() + 7 * 86_400_000);
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 86_400_000,
    });
    res.json({ csrf });
  });
  // Public only through a time-limited HMAC for platform fetches. No directory listing.
  app.get("/media/:id", (req, res) => {
    const expires = Number(req.query.expires);
    const signature = String(req.query.signature ?? "");
    const expected = createHmac("sha256", store.key)
      .update(`${req.params.id}:${expires}`)
      .digest("hex");
    if (
      !Number.isSafeInteger(expires) ||
      expires < Date.now() ||
      expires > Date.now() + 6 * 3_600_000 ||
      !/^[0-9a-f]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return res.sendStatus(403);
    const v = store.videos().find((v) => v.id === req.params.id);
    if (!v || v.deletedAt) return res.sendStatus(404);
    res.set("Cache-Control", "private, no-store");
    res.sendFile(join(dir, "videos", v.filename));
  });
  app.get("/api/oauth/:platform/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const s = session(req);
    const row = store.db
      .prepare("SELECT platform,session,expires FROM oauth WHERE state=?")
      .get(hash(state)) as
      | { platform: string; session: string; expires: number }
      | undefined;
    if (
      !s ||
      !row ||
      row.expires < Date.now() ||
      row.session !== s.hash ||
      row.platform !== req.params.platform
    )
      return res.status(403).send("Недействительный запрос подключения");
    store.db.prepare("DELETE FROM oauth WHERE state=?").run(hash(state));
    try {
      if (typeof req.query.code !== "string") throw new Error();
      await providers.exchange(row.platform as Platform, req.query.code);
      res.redirect("/?connected=1");
    } catch {
      res.redirect("/?connection_error=1");
    }
  });
  app.use("/api", (req, res, next) => {
    const s = session(req);
    if (!s) return res.status(401).json({ error: "Войдите в панель" });
    res.locals.session = s;
    res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (req.headers.origin !== origin || req.headers["x-csrf-token"] !== s.csrf)
    )
      return res
        .status(403)
        .json({ error: "Обновите страницу и повторите действие" });
    next();
  });
  const storage = () => {
    const fs = statfsSync(dir);
    const tracked = new Map(
      store.videos().filter((v) => !v.deletedAt).map((v) => [v.filename, v.bytes]),
    );
    let used = [...tracked.values()].reduce((total, bytes) => total + bytes, 0);
    for (const entry of readdirSync(join(dir, "videos"), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const size = statSync(join(dir, "videos", entry.name)).size;
        used += Math.max(0, size - (tracked.get(entry.name) ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      free: fs.bavail * fs.bsize,
      used,
      reserve,
      budget,
    };
  };
  app.get("/api/state", (_req, res) => {
    const deliveriesByVideo = groupDeliveries(store.deliveries());
    res.json({
      videos: store.videos().sort((a, b) => a.position - b.position).map(v => ({...v, deliveries: deliveriesByVideo.get(v.id) ?? []})),
      connections: providers.connections(),
      storage: storage(),
      csrf: res.locals.session.csrf,
    });
  });
  app.post("/api/logout", (_req, res) => {
    store.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(res.locals.session.hash);
    res.clearCookie(cookieName, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "lax",
    });
    res.json({ ok: true });
  });
  let uploading = false;
  app.post("/api/videos", async (req, res) => {
    if (uploading)
      return res
        .status(409)
        .json({ error: "Дождитесь окончания текущей загрузки" });
    let title: string, hashtags: string;
    try {
      title = decodeURIComponent(
        String(req.headers["x-video-title"] ?? ""),
      ).trim();
      hashtags = decodeURIComponent(
        String(req.headers["x-video-hashtags"] ?? ""),
      ).trim();
    } catch {
      return res.status(400).json({ error: "Некорректное название" });
    }
    const size = Number(req.headers["content-length"]);
    if (
      !title ||
      title.length > 100 ||
      hashtags.length > 2000 ||
      req.headers["content-type"] !== "video/mp4" ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > maxFile
    )
      return res
        .status(400)
        .json({ error: "Нужен MP4 до 1 ГБ и название длиной до 100 символов" });
    const disk = storage();
    if (disk.used + size > budget || disk.free - size < reserve)
      return res.status(507).json({
        error: "Недостаточно места. Неопубликованные видео сохраняются.",
      });
    const id = randomUUID(),
      filename = id + ".mp4",
      temp = join(dir, "videos", id + ".part");
    uploading = true;
    try {
      let bytes = 0;
      const guard = new Transform({
        transform(chunk, _encoding, cb) {
          bytes += chunk.length;
          if (
            bytes > size ||
            statfsSync(dir).bavail * statfsSync(dir).bsize < reserve
          )
            return cb(new Error("Лимит места"));
          cb(null, chunk);
        },
      });
      await pipeline(
        req,
        guard,
        createWriteStream(temp, { mode: 0o600, flags: "wx" }),
      );
      if (bytes !== size) throw new Error("Неполная загрузка");
      const fd = openSync(temp, "r");
      try {
        const head = Buffer.alloc(12);
        readSync(fd, head, 0, 12, 0);
        if (head.toString("ascii", 4, 8) !== "ftyp") throw new Error("Не MP4");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const probe = await promisify(execFile)(
        "ffprobe",
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-show_entries",
          "stream=codec_type,width,height:format=duration",
          "-of",
          "json",
          temp,
        ],
        { timeout: 15_000, maxBuffer: 64 * 1024 },
      );
      validateVideoMetadata(JSON.parse(probe.stdout));
      renameSync(temp, join(dir, "videos", filename));
      engine.claim();
      store.transaction(() => {
        const videos = store.videos();
        const v: Video = {
          id,
          title,
          hashtags,
          filename,
          bytes,
          createdAt: Date.now(),
          position: Math.max(0, ...videos.map((v) => v.position)) + 1,
          scheduledAt: null,
          pinned: false,
          kind: "content",
          state: "queued",
          deletedAt: null,
        };
        store.video(v);
        engine.replan();
      });
      res.status(201).json({ id });
    } catch {
      for (const path of [temp, join(dir, "videos", filename)])
        try {
          unlinkSync(path);
        } catch {}
      if (!res.headersSent && !res.destroyed)
        res.status(400).json({
          error: "Загрузка не завершена. Проверьте MP4 и свободное место.",
        });
    } finally {
      uploading = false;
    }
  });
  app.get("/api/videos/:id/file", (req, res) => {
    const v = store.videos().find((v) => v.id === req.params.id);
    if (!v || v.deletedAt) return res.sendStatus(404);
    res.type("video/mp4").sendFile(join(dir, "videos", v.filename));
  });
  app.patch("/api/videos/:id", (req, res) => {
    const v = store.videos().find((v) => v.id === req.params.id);
    if (!v) return res.sendStatus(404);
    if (v.state !== "queued")
      return res.status(409).json({
        error: "Отправка уже началась. План этого ролика зафиксирован.",
      });
    try {
      store.transaction(() => {
        if ("title" in req.body) {
          if (
            typeof req.body.title !== "string" ||
            !req.body.title.trim() ||
            req.body.title.length > 100
          )
            throw new Error("Название: от 1 до 100 символов");
          v.title = req.body.title.trim();
        }
        if ("hashtags" in req.body) {
          if (
            typeof req.body.hashtags !== "string" ||
            req.body.hashtags.length > 2000
          )
            throw new Error("Слишком длинные хэштеги");
          v.hashtags = req.body.hashtags;
        }
        if ("pin" in req.body) {
          if (req.body.pin === null) {
            v.pinned = false;
            v.kind = "content";
          } else {
            const time = parseMoscow(String(req.body.pin));
            if (time <= Date.now()) throw new Error("Укажите будущее время");
            if (
              store
                .videos()
                .some((x) => x.id !== v.id && x.scheduledAt === time)
            )
              throw new Error("Время уже занято другим роликом");
            v.pinned = true;
            v.scheduledAt = time;
            v.kind = req.body.kind === "extra" ? "extra" : "content";
          }
        }
        store.video(v);
        engine.replan();
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.post("/api/reorder", (req, res) => {
    const ids = req.body.ids;
    const queued = store.videos().filter((v) => v.state === "queued");
    if (
      !Array.isArray(ids) ||
      ids.length !== queued.length ||
      new Set(ids).size !== queued.length ||
      queued.some((v) => !ids.includes(v.id))
    )
      return res
        .status(400)
        .json({ error: "Очередь изменилась. Обновите страницу." });
    store.transaction(() => {
      ids.forEach((id: string, i: number) => {
        const v = queued.find((v) => v.id === id)!;
        v.position = i + 1;
        store.video(v);
      });
      engine.replan(Date.now(), false);
    });
    res.json({ ok: true });
  });
  app.post("/api/connections/:platform/config", (req, res) => {
    const p = req.params.platform as Platform;
    if (!PLATFORMS.includes(p) || p === "tiktok")
      return res
        .status(400)
        .json({ error: "Способ Direct Post TikTok ещё не выбран" });
    const { clientId, clientSecret } = req.body;
    if (
      typeof clientId !== "string" ||
      !clientId.trim() ||
      clientId.length > 500 ||
      typeof clientSecret !== "string" ||
      !clientSecret ||
      clientSecret.length > 1000
    )
      return res.status(400).json({ error: "Нужны Client ID и Client Secret" });
    store.set(configKey(p), { clientId: clientId.trim(), clientSecret });
    store.set(tokenKey(p), null);
    res.json({ ok: true });
  });
  app.post("/api/connections/:platform/connect", (req, res) => {
    const p = req.params.platform as Platform;
    if (!PLATFORMS.includes(p)) return res.sendStatus(404);
    try {
      const state = randomBytes(32).toString("hex");
      const url = providers.authorization(p, state);
      store.db.prepare("DELETE FROM oauth WHERE expires<?").run(Date.now());
      store.db
        .prepare("INSERT INTO oauth VALUES(?,?,?,?)")
        .run(hash(state), p, res.locals.session.hash, Date.now() + 10 * 60_000);
      res.json({ url });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  app.post("/api/connections/:platform/disconnect", (req, res) => {
    if (!PLATFORMS.includes(req.params.platform as Platform))
      return res.sendStatus(404);
    store.set(tokenKey(req.params.platform as Platform), null);
    res.json({ ok: true });
  });
  app.post("/api/deliveries/:videoId/:platform/retry", (req, res) => {
    const d = store
      .deliveries()
      .find(
        (d) =>
          d.videoId === req.params.videoId &&
          d.platform === req.params.platform,
      );
    if (!d || d.state === "published")
      return res.status(409).json({ error: "Повтор не требуется" });
    if (d.state === "unknown" && req.body.confirmNoPost !== true)
      return res
        .status(409)
        .json({ error: "Сначала убедитесь, что пост не появился на площадке" });
    if (d.state === "processing")
      return res.status(409).json({ error: "Площадка обрабатывает видео" });
    store.transaction(() => {
      if (d.state === "unknown" && d.platform === "instagram")
        store.set(`publishing:${d.videoId}:instagram`, null);
      d.state = "pending";
      d.error = null;
      d.nextAt = recoveryAt(
        d.originalAt,
        Date.now(),
        d.platform,
        store.videos(),
        store.deliveries(),
      );
      store.delivery(d);
    });
    res.json({ ok: true });
  });
  app.use(express.static(resolve("dist")));
  app.get("/", (_req, res) => res.sendFile(resolve("dist/index.html")));
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(
        "Request failed:",
        err instanceof Error ? err.name : "Error",
      );
      if (!res.headersSent)
        res.status(400).json({ error: "Не удалось обработать запрос" });
    },
  );

  return { app, store, providers, engine };
}

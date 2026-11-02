import { useEffect, useState, type FormEvent } from "react";
import {
  CalendarDays,
  Clapperboard,
  Link2,
  Upload,
  HardDrive,
  LogOut,
  ArrowUp,
  ArrowDown,
  Film,
  AlertCircle,
} from "lucide-react";
import type { Snapshot } from "../shared/model.ts";
import { dayStart } from "../shared/scheduler.ts";
import { request, state } from "./api.ts";
import { bytes, date, time } from "./format.ts";
import { Calendar, Platforms, type View } from "./Calendar.tsx";
import { VideoEditor } from "./VideoEditor.tsx";
import { Connections } from "./Connections.tsx";
export function App() {
  const [data, setData] = useState<Snapshot | null>(null),
    [loggedIn, setLoggedIn] = useState<boolean | null>(null),
    [page, setPage] = useState("calendar");
  const [view, setView] = useState<View>("week"),
    [anchor, setAnchor] = useState(dayStart(Date.now())),
    [editor, setEditor] = useState<string | null>(null),
    [error, setError] = useState("");
  async function refresh() {
    try {
      const d = await state();
      setData(d);
      setLoggedIn(true);
    } catch (e) {
      if ((e as any).status === 401) {
        setLoggedIn(false);
        setData(null);
      } else setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).has("connection_error"))
      setError(
        "Подключение не завершено. Проверьте Redirect URI, права приложения и выбранный аккаунт.",
      );
  }, []);
  async function move(id: string, offset: number) {
    if (!data) return;
    const ids = data.videos
        .filter((v) => v.state === "queued")
        .map((v) => v.id),
      index = ids.indexOf(id),
      next = index + offset;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    try {
      await request("/reorder", { ids });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (loggedIn === null)
    return error ? (
      <div className="loading">
        <section>
          <h1>Панель временно недоступна</h1>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Повторить загрузку
          </button>
        </section>
      </div>
    ) : (
      <div className="loading">Загружаю панель…</div>
    );
  if (!loggedIn) return <Login onLogin={refresh} />;
  const selected = data?.videos.find((v) => v.id === editor);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Shorts Panel">
          <span className="brand-icon">
            <Clapperboard size={22} />
          </span>
          Shorts Panel
        </a>
        <nav aria-label="Основная навигация">
          {[
            { id: "calendar", title: "Календарь", icon: CalendarDays },
            { id: "videos", title: "Видео", icon: Clapperboard },
            { id: "connections", title: "Подключения", icon: Link2 },
          ].map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id)}
            >
              <Icon size={20} />
              {title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {data ? (
            <div className="disk">
              <HardDrive size={18} />
              <span>Свободно {bytes(data.storage.free)}</span>
              <progress max={data.storage.budget} value={data.storage.used} />
              <small>
                Видео: {bytes(data.storage.used)} из{" "}
                {bytes(data.storage.budget)}
              </small>
              {data.storage.orphaned > 0 ? (
                <small role="status">
                  Найдены файлы после прерванной загрузки: {data.storage.orphaned}. Требуется проверка.
                </small>
              ) : null}
              {data.storage.missing > 0 ? (
                <small role="status">
                  Не найдены файлы роликов: {data.storage.missing}. Требуется восстановление.
                </small>
              ) : null}
            </div>
          ) : null}
          <button
            className="logout"
            onClick={async () => {
              await request("/logout", {});
              setLoggedIn(false);
              setData(null);
            }}
          >
            <LogOut size={16} />
            Выйти
          </button>
        </div>
      </aside>
      <main>
        <header className="page-heading">
          <h1>
            {page === "calendar"
              ? "Календарь"
              : page === "videos"
                ? "Видео"
                : "Подключения"}
          </h1>
          <button className="primary" onClick={() => setEditor("new")}>
            <Upload size={18} />
            Загрузить видео
          </button>
        </header>
        {error ? (
          <div role="alert" className="error-banner">
            {error}
            <button onClick={() => setError("")} aria-label="Скрыть ошибку">
              Закрыть
            </button>
          </div>
        ) : null}
        {data ? (
          <>
            {page === "connections" ? (
              <Connections connections={data.connections} onChanged={refresh} />
            ) : (
              <>
                {page === "calendar" ? (
                  <Calendar
                    videos={data.videos}
                    view={view}
                    setView={setView}
                    anchor={anchor}
                    setAnchor={setAnchor}
                    onSelect={(v) => setEditor(v.id)}
                  />
                ) : null}
                <section className="queue">
                  <header>
                    <h2>
                      {page === "videos" ? "Все видео" : "Очередь видео"}{" "}
                      <span className="count">
                        {data.videos.filter((v) => v.state === "queued").length}
                      </span>
                    </h2>
                    <span className="muted">По порядку загрузки</span>
                  </header>
                  {data.videos.length ? (
                    <div className="video-list">
                      {data.videos.map((v) => (
                        <article key={v.id}>
                          <button
                            className="video-open"
                            onClick={() => setEditor(v.id)}
                          >
                            <span className="video-thumbnail">
                              <Film size={22} />
                            </span>
                            <span className="video-title">
                              {v.title}
                              <small>
                                {bytes(v.bytes)} ·{" "}
                                {v.deletedAt
                                  ? "Исходник удалён"
                                  : v.pinned
                                    ? v.kind === "extra"
                                      ? "Реклама · закреплено"
                                      : "Контент · закреплено"
                                    : "Автораспределение"}
                              </small>
                            </span>
                          </button>
                          <button
                            className="schedule-button"
                            onClick={() => setEditor(v.id)}
                          >
                            {v.scheduledAt ? (
                              <>
                                <CalendarDays size={15} />
                                {date(v.scheduledAt)} · {time(v.scheduledAt)}
                              </>
                            ) : (
                              "Назначаем время"
                            )}
                          </button>
                          <Platforms video={v} />
                          <span
                            className={
                              "status " +
                              (v.state === "published"
                                ? "published"
                                : v.deliveries.some(
                                      (d) => d.state === "unknown",
                                    )
                                  ? "unknown"
                                  : v.state === "dispatched"
                                    ? "blocked"
                                    : "pending")
                            }
                          >
                            {v.state === "published"
                              ? "Опубликовано"
                              : v.state === "dispatched"
                                ? "Результаты отправки"
                                : "Запланировано"}
                          </span>
                          <div className="order-buttons">
                            <button
                              className="icon"
                              disabled={
                                v.state !== "queued" ||
                                data.videos.filter(
                                  (v) => v.state === "queued",
                                )[0]?.id === v.id
                              }
                              onClick={() => move(v.id, -1)}
                              aria-label={"Выше: " + v.title}
                            >
                              <ArrowUp size={15} />
                            </button>
                            <button
                              className="icon"
                              disabled={
                                v.state !== "queued" ||
                                data.videos
                                  .filter((v) => v.state === "queued")
                                  .at(-1)?.id === v.id
                              }
                              onClick={() => move(v.id, 1)}
                              aria-label={"Ниже: " + v.title}
                            >
                              <ArrowDown size={15} />
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-queue">
                      <Film size={30} />
                      <h3>Здесь будут ваши видео</h3>
                      <p>
                        Добавьте первый ролик. Панель распределит очередь на
                        неделю вперёд.
                      </p>
                      <button onClick={() => setEditor("new")}>
                        Выбрать видео
                      </button>
                    </div>
                  )}
                </section>
                {data.connections.some((c) => !c.connected) ? (
                  <div className="connection-notice">
                    <AlertCircle size={28} />
                    <div>
                      <strong>Подключите аккаунты для публикации</strong>
                      <p>
                        Очередь сохраняется на сервере. Для отправки нужны
                        разрешения YouTube, TikTok и Instagram.
                      </p>
                    </div>
                    <button
                      className="primary"
                      onClick={() => setPage("connections")}
                    >
                      Перейти к подключениям
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
        <p className="retention-note">
          Исходники хранятся на сервере и удаляются через 24 часа после
          публикации на всех трёх площадках.
        </p>
      </main>
      {editor === "new" || selected ? (
        <VideoEditor
          key={editor}
          video={selected}
          onClose={() => setEditor(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/login", { password });
      setPassword("");
      await onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <form onSubmit={submit}>
        <div className="login-brand">
          <Clapperboard size={30} />
          <span>Shorts Panel</span>
        </div>
        <h1>Ваша неделя контента</h1>
        <p>Войдите, чтобы управлять видео и расписанием.</p>
        <label>
          Пароль
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            maxLength={1024}
          />
        </label>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="primary" disabled={busy}>
          {busy ? "Входим…" : "Войти в панель"}
        </button>
        <small>Личная панель · YouTube / TikTok / Instagram</small>
      </form>
    </div>
  );
}

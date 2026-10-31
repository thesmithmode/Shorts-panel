import { useState, type FormEvent } from "react";
import type { Snapshot } from "../shared/model.ts";
import { Modal } from "./Modal.tsx";
import { request, upload } from "./api.ts";
import { moscowDate, MOSCOW } from "../shared/scheduler.ts";
import { names, stateLabel, time, date } from "./format.ts";
type Item = Snapshot["videos"][number];
export function VideoEditor({
  video,
  onClose,
  onSaved,
}: {
  video?: Item;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(video?.title ?? ""),
    [hashtags, setHashtags] = useState(video?.hashtags ?? "");
  const [file, setFile] = useState<File | null>(null),
    [pinned, setPinned] = useState(video?.pinned ?? false),
    [kind, setKind] = useState(video?.kind ?? "content");
  const [when, setWhen] = useState(
    video?.scheduledAt
      ? new Date(video.scheduledAt + MOSCOW).toISOString().slice(0, 16)
      : "",
  );
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState("");
  const editable = !video || video.state === "queued";
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (video)
        await request(
          "/videos/" + video.id,
          { title, hashtags, pin: pinned ? when : null, kind },
          "PATCH",
        );
      else {
        if (!file) throw new Error("Выберите видео");
        await upload(file, title, hashtags, setProgress);
      }
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry(platform: string, unknown: boolean) {
    if (
      unknown &&
      !confirm(
        "Вы проверили аккаунт и убедились, что этот ролик НЕ опубликован? Повтор может создать дубликат.",
      )
    )
      return;
    setBusy(true);
    try {
      await request(`/deliveries/${video!.id}/${platform}/retry`, {
        confirmNoPost: unknown,
      });
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={video ? "Видео в очереди" : "Загрузить видео"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} className="editor">
        {!video ? (
          <label className="file-field">
            {file ? file.name : "Выберите вертикальное видео"}
            <input
              required
              type="file"
              accept="video/mp4,.mp4"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title)
                  setTitle(f.name.replace(/\.[^.]+$/, "").slice(0, 100));
              }}
            />
            <small>MP4 · один файл для всех трёх площадок</small>
          </label>
        ) : video.deletedAt ? (
          <p className="muted">
            Исходник удалён после завершения срока хранения.
          </p>
        ) : (
          <video
            controls
            preload="metadata"
            src={"/api/videos/" + video.id + "/file"}
          />
        )}
        <label>
          Название
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={100}
            disabled={!editable || busy}
          />
        </label>
        <label>
          Хэштеги
          <textarea
            aria-label="Хэштеги"
            value={hashtags}
            onChange={(e) => setHashtags(e.target.value)}
            maxLength={2000}
            placeholder="#shorts #видео"
            disabled={!editable || busy}
          />
          <small>Автоподбор можно будет настроить позже.</small>
        </label>
        {video && editable ? (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                disabled={busy}
              />
              Закрепить дату и время
            </label>
            {pinned ? (
              <div className="form-row">
                <label>
                  Время по Москве
                  <input
                    type="datetime-local"
                    required
                    value={when}
                    min={moscowDate(Date.now()) + "T00:00"}
                    onChange={(e) => setWhen(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  Тип поста
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    disabled={busy}
                  >
                    <option value="content">Обычный контент</option>
                    <option value="extra">Реклама / дополнительно</option>
                  </select>
                </label>
              </div>
            ) : (
              <p className="muted">
                Время назначается автоматически, сохраняя порядок очереди.
              </p>
            )}
          </>
        ) : null}
        {video ? (
          <div className="delivery-list">
            {video.deliveries.length ? (
              video.deliveries.map((d) => (
                <section key={d.platform}>
                  <div>
                    <strong>{names[d.platform]}</strong>
                    <span className={"status " + d.state}>
                      {stateLabel[d.state]}
                    </span>
                  </div>
                  {d.error ? <p>{d.error}</p> : null}
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noreferrer">
                      Открыть публикацию
                    </a>
                  ) : null}
                  {d.successAt ? (
                    <small>
                      {date(d.successAt)} в {time(d.successAt)}
                    </small>
                  ) : d.nextAt ? (
                    <small>
                      Следующая попытка: {date(d.nextAt)} в {time(d.nextAt)}
                    </small>
                  ) : null}
                  {["unknown", "failed", "blocked"].includes(d.state) ? (
                    <button
                      type="button"
                      onClick={() => retry(d.platform, d.state === "unknown")}
                      disabled={busy}
                    >
                      Повторить по правилам очереди
                    </button>
                  ) : null}
                </section>
              ))
            ) : (
              <p className="muted">
                Все три площадки получат видео в назначенное время.
              </p>
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {busy && !video ? (
          <label>
            Загрузка: {progress}%<progress max="100" value={progress} />
          </label>
        ) : null}
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>
            Закрыть
          </button>
          {editable ? (
            <button className="primary" disabled={busy}>
              {busy ? "Сохраняю…" : video ? "Сохранить" : "Добавить в очередь"}
            </button>
          ) : null}
        </footer>
      </form>
    </Modal>
  );
}

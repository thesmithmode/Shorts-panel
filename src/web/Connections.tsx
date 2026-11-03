import { useState, type FormEvent } from "react";
import { CheckCircle2, ExternalLink, KeyRound } from "lucide-react";
import type { Connection } from "../shared/model.ts";
import { names } from "./format.ts";
import { request } from "./api.ts";
export function Connections({
  connections,
  onChanged,
}: {
  connections: Connection[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>, platform: string) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await request(`/connections/${platform}/config`, {
        clientId: f.get("clientId"),
        clientSecret: f.get("clientSecret"),
      });
      setEditing("");
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function connect(platform: string) {
    setBusy(true);
    setError("");
    try {
      const { url } = await request(`/connections/${platform}/connect`, {});
      location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function disconnect(platform: string) {
    if (
      !confirm(
        "Отключить аккаунт? Исходники неопубликованных роликов останутся на сервере.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await request(`/connections/${platform}/disconnect`, {});
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connections">
      <p className="muted">
        Войдите в аккаунты и разрешите публикацию. Повторный вход перед каждым
        роликом не нужен.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {connections.map((c) => (
        <section className="connection" key={c.platform}>
          <div className="connection-heading">
            <div className={"connection-mark " + c.platform}>
              {c.platform === "youtube"
                ? "YT"
                : c.platform === "instagram"
                  ? "IG"
                  : "TT"}
            </div>
            <div>
              <h2>{names[c.platform]}</h2>
              <p>{c.account ?? c.message}</p>
              {c.account && !c.connected ? <p role="status">{c.message}</p> : null}
            </div>
            {c.connected ? (
              <CheckCircle2 className="success-icon" size={22} />
            ) : null}
          </div>
          {c.platform === "tiktok" ? (
            <p className="notice-text">
              Публичный Direct Post требует допущенного приложения. Приватная
              утилита может не пройти аудит TikTok. Подключение не имитируется;
              способ доступа ещё нужно выбрать.
            </p>
          ) : (
            <>
              <p className="muted">
                {c.platform === "youtube"
                  ? "Google Cloud: YouTube Data API, Web OAuth client, offline access. Режим Testing ограничивает срок разрешения."
                  : "Нужен Instagram Creator или Business. Используется Instagram Login; Facebook Page не обязательна."}
              </p>
              <label className="callback-label">
                Redirect URI
                <code>
                  {location.origin}/api/oauth/{c.platform}/callback
                </code>
              </label>
              <div className="connection-actions">
                {c.connected ? (
                  <button
                    disabled={busy}
                    onClick={() => disconnect(c.platform)}
                  >
                    Отключить аккаунт
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || !c.configured}
                    onClick={() => connect(c.platform)}
                  >
                    <ExternalLink size={16} />
                    Подключить аккаунт
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    setEditing(editing === c.platform ? "" : c.platform)
                  }
                >
                  <KeyRound size={16} />
                  {c.configured ? "Изменить OAuth" : "Настроить OAuth"}
                </button>
              </div>
              {editing === c.platform ? (
                <form
                  className="oauth-form"
                  onSubmit={(e) => save(e, c.platform)}
                >
                  <p className="muted">
                    Изменение приложения сбрасывает текущее подключение этой
                    площадки.
                  </p>
                  <label>
                    Client ID
                    <input
                      name="clientId"
                      autoComplete="off"
                      required
                      maxLength={500}
                    />
                  </label>
                  <label>
                    Client Secret
                    <input
                      name="clientSecret"
                      type="password"
                      autoComplete="new-password"
                      required
                      maxLength={1000}
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    Сохранить на сервере
                  </button>
                </form>
              ) : null}
            </>
          )}
        </section>
      ))}
      <p className="muted">
        Секреты хранятся на сервере в зашифрованном виде и не возвращаются в
        браузер.
      </p>
    </div>
  );
}

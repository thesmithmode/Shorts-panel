import type { Snapshot } from "../shared/model.ts";
let csrf = "";
export async function request<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json().catch(() => ({ error: "Сервер недоступен" }));
  if (!r.ok)
    throw Object.assign(
      new Error(data.error ?? "Не удалось выполнить действие"),
      { status: r.status },
    );
  if (data.csrf) csrf = data.csrf;
  return data;
}
export const state = () => request<Snapshot>("/state");
export function upload(
  file: File,
  title: string,
  hashtags: string,
  onProgress: (n: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos");
    xhr.setRequestHeader("Content-Type", "video/mp4");
    xhr.setRequestHeader("X-CSRF-Token", csrf);
    xhr.setRequestHeader("X-Video-Title", encodeURIComponent(title));
    xhr.setRequestHeader("X-Video-Hashtags", encodeURIComponent(hashtags));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let message = "Загрузка не удалась";
        try {
          message = JSON.parse(xhr.responseText).error;
        } catch {}
        reject(new Error(message));
      }
    };
    xhr.onerror = () =>
      reject(
        new Error(
          "Соединение прервано. Проверьте очередь перед повторной загрузкой.",
        ),
      );
    xhr.send(file);
  });
}

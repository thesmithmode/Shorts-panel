import { existsSync, lstatSync, readdirSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.ts";
import { acquireInstanceLock } from "./instance-lock.ts";
import { inspectVideoFile } from "./media.ts";

const uploadName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|part)$/;

/** Only files named by this application's upload flow; never follows symlinks. */
export function listOrphanedVideos(store: Store): { filename: string; bytes: number }[] {
  const tracked = new Set(store.videos().map(v => v.filename));
  return readdirSync(join(store.dir, "videos"), { withFileTypes: true })
    .filter(entry => entry.isFile() && uploadName.test(entry.name) && !tracked.has(entry.name))
    .map(entry => ({ filename: entry.name, bytes: lstatSync(join(store.dir, "videos", entry.name)).size }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
}

/** Offline, explicit recovery. Original metadata is never guessed. */
export async function recoverOrphanedVideo(store: Store, filename: string, title: string, hashtags = ""): Promise<string> {
  if (!uploadName.test(filename) || !title.trim() || title.trim().length > 100 || hashtags.length > 2000)
    throw new Error("Укажите файл загрузки, название до 100 символов и хэштеги до 2000 символов");
  const unlock = acquireInstanceLock(store.dir);
  try {
    const id = filename.replace(/\.(mp4|part)$/, "");
    const final = `${id}.mp4`;
    if (store.videos().some(v => v.filename === filename || v.filename === final || v.id === id))
      throw new Error("Ролик уже зарегистрирован в очереди");
    const source = join(store.dir, "videos", filename);
    const file = lstatSync(source);
    if (!file.isFile()) throw new Error("Нужен обычный файл, не ссылка или каталог");
    if (filename !== final && existsSync(join(store.dir, "videos", final)))
      throw new Error("Конечный файл уже существует; перезапись запрещена");
    await inspectVideoFile(source);
    if (filename !== final) {
      // link is exclusive even if a destination appears while ffprobe is running.
      linkSync(source, join(store.dir, "videos", final));
      unlinkSync(source);
    }
    // A database error must retain the validated source for another recovery attempt.
    store.transaction(() => store.video({
      id, title: title.trim(), hashtags: hashtags.trim(), filename: final, bytes: file.size,
      createdAt: Date.now(), position: Math.max(0, ...store.videos().map(v => v.position)) + 1,
      scheduledAt: null, pinned: false, kind: "content", state: "queued", deletedAt: null,
    }));
    return id;
  } finally { unlock(); }
}

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../src/server/store.ts";
import { acquireInstanceLock } from "../src/server/instance-lock.ts";
import { listOrphanedVideos, recoverOrphanedVideo } from "../src/server/recovery.ts";

const dir = resolve(process.env.SHORTS_DATA_DIR ?? "data");
const [filename, title, hashtags] = process.argv.slice(2);
if (!existsSync(join(dir, "panel.sqlite")) || !existsSync(join(dir, "secret.key")) || !filename)
  throw new Error("Нужен существующий SHORTS_DATA_DIR. Команды: recover -- list; recover -- файл название [хэштеги]");
const store = new Store(dir);
try {
  if (filename === "list") {
    const unlock = acquireInstanceLock(dir);
    try { console.log(JSON.stringify(listOrphanedVideos(store), null, 2)); }
    finally { unlock(); }
  } else {
    if (!title) throw new Error("Название обязательно: прежние метаданные не восстанавливаются догадками");
    const id = await recoverOrphanedVideo(store, filename, title, hashtags);
    console.log(`Ролик ${id} восстановлен в очередь. Публикация не запускалась.`);
  }
} finally { store.db.close(); }

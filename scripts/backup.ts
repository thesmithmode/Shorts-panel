import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../src/server/store.ts";
import { createDatabaseBackup } from "../src/server/backup.ts";

const source = resolve(process.env.SHORTS_DATA_DIR ?? "data");
const argument = process.argv[2];
if (!argument || !existsSync(join(source, "panel.sqlite")) || !existsSync(join(source, "secret.key")))
  throw new Error("Укажите новый каталог копии и существующий SHORTS_DATA_DIR с базой и ключом");
const destination = resolve(argument);
const store = new Store(source);
try {
  await createDatabaseBackup(store, destination);
  console.log("Копия базы и ключа создана. Видеофайлы в неё не входят.");
} finally {
  store.db.close();
}

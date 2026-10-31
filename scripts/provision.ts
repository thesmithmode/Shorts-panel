import { Store, passwordHash } from "../src/server/store.ts";
import { resolve } from "node:path";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 2048) throw new Error("Input too long");
}
const password = input.trim();
if (password.length < 14 || password.length > 1024)
  throw new Error("Пароль должен содержать от 14 до 1024 символов");
const store = new Store(resolve(process.env.SHORTS_DATA_DIR ?? "data"));
store.set("password", passwordHash(password));
store.db.exec("DELETE FROM sessions");
store.db.close();
console.log("Пароль сохранён; прежние сессии отозваны.");

import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** SQLite releases this separate exclusive lock even if the worker is killed. */
export function acquireInstanceLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "instance-lock.sqlite");
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (error instanceof Error && /locked|busy/i.test(error.message))
      throw new Error("Панель с этим каталогом данных уже запущена", { cause: error });
    throw error;
  }
  return () => db.close();
}

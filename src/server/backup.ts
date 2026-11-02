import { backup } from "node:sqlite";
import { chmodSync, constants, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

/** Creates a new private directory; never overwrites an existing backup. */
export async function createDatabaseBackup(store: Store, destination: string): Promise<void> {
  mkdirSync(destination, { mode: 0o700 });
  const database = join(destination, "panel.sqlite");
  await backup(store.db, database);
  chmodSync(database, 0o600);
  const key = join(destination, "secret.key");
  copyFileSync(join(store.dir, "secret.key"), key, constants.COPYFILE_EXCL);
  chmodSync(key, 0o600);
  writeFileSync(join(destination, "BACKUP_COMPLETE"), "shorts-panel-backup-v1\n", { mode: 0o600, flag: "wx" });
}

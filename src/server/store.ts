import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Video, Delivery, Platform } from "../shared/model.ts";
export class Store {
  db: DatabaseSync;
  key: Buffer;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "videos"), { recursive: true, mode: 0o700 });
    const keyPath = join(dir, "secret.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("Invalid encryption key");
    this.db = new DatabaseSync(join(dir, "panel.sqlite"));
    chmodSync(join(dir, "panel.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS deliveries(videoId TEXT NOT NULL REFERENCES videos(id), platform TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(videoId,platform));
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY,platform TEXT NOT NULL,session TEXT NOT NULL,expires INTEGER NOT NULL);
  `);
  }
  videos(): Video[] {
    return (
      this.db.prepare("SELECT json FROM videos").all() as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  deliveries(): Delivery[] {
    return (
      this.db.prepare("SELECT json FROM deliveries").all() as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  video(v: Video) {
    this.db
      .prepare(
        "INSERT INTO videos VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
      )
      .run(v.id, JSON.stringify(v));
  }
  delivery(d: Delivery) {
    this.db
      .prepare(
        "INSERT INTO deliveries VALUES(?,?,?) ON CONFLICT(videoId,platform) DO UPDATE SET json=excluded.json",
      )
      .run(d.videoId, d.platform, JSON.stringify(d));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T>(key: string): T | null {
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    return r ? JSON.parse(this.decrypt(r.value)) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, this.encrypt(JSON.stringify(value)));
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
  }
  decrypt(value: string) {
    const b = Buffer.from(value, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(
      "utf8",
    );
  }
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordCheck(password: string, hash: string) {
  const [salt, want] = hash.split(":");
  if (!salt || !want) return false;
  const got = scryptSync(password, salt, 64);
  const expected = Buffer.from(want, "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
export interface AppConfig {
  clientId: string;
  clientSecret: string;
}
export interface Token {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  account: string;
  accountId?: string;
}
export const configKey = (p: Platform) => `config:${p}`;
export const tokenKey = (p: Platform) => `token:${p}`;

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Single-process store. No Discord history mirror; queue payloads are short-lived. */
export class Store {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly now = Date.now,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA secure_delete=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(kind,key)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY, subscription TEXT NOT NULL, event TEXT NOT NULL,
        message TEXT NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, expires INTEGER NOT NULL,
        UNIQUE(subscription,event)
      );
      CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(next_attempt);
    `);
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE kind=? AND key=? AND expires>?")
      .get(kind, key, this.now());
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  set(kind: string, key: string, value: unknown, expires: number): void {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
      )
      .run(kind, key, JSON.stringify(value), expires);
  }
  delete(kind: string, key: string): void {
    this.db.prepare("DELETE FROM records WHERE kind=? AND key=?").run(kind, key);
  }
  list<T>(kind: string): { key: string; value: T }[] {
    return this.db
      .prepare("SELECT key,value FROM records WHERE kind=? AND expires>?")
      .all(kind, this.now())
      .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) as T }));
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  purge(): void {
    this.db.prepare("DELETE FROM records WHERE expires<=?").run(this.now());
    this.db
      .prepare(
        "DELETE FROM deliveries WHERE expires<=? OR NOT EXISTS (SELECT 1 FROM records WHERE kind='subscription' AND key=deliveries.subscription)",
      )
      .run(this.now());
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close(): void {
    this.db.close();
  }
}

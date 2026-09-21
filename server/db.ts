import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance: DatabaseSync | null = null;
let dbPath = 'data/flange-bench.sqlite';

export function setDbPath(path: string) {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  dbPath = path;
}

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  dbInstance = db;
  return db;
}

/** 测试用内存库 */
export function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wheel_position (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS raw_profile (
      id TEXT PRIMARY KEY,
      wheel_position TEXT NOT NULL,
      epoch TEXT NOT NULL,
      seq INTEGER NOT NULL,
      declared_direction TEXT NOT NULL,
      note TEXT,
      points_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_record (
      run_id TEXT PRIMARY KEY,
      wheel_position TEXT NOT NULL,
      std_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      config_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_wp ON run_record(wheel_position);
    CREATE INDEX IF NOT EXISTS idx_raw_wp ON raw_profile(wheel_position, seq);
  `);
  db.prepare(
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')`,
  ).run();
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

let singleton: DatabaseSync | null = null;

export function openDb(path = 'data/bench.sqlite'): DatabaseSync {
  if (singleton) return singleton;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  singleton = db;
  return db;
}

/** 仅供测试/重置：关闭并释放句柄。 */
export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

export function resetDbForTests(path: string): DatabaseSync {
  closeDb();
  singleton = null;
  return openDb(path);
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      fixture_id TEXT NOT NULL,
      standard_version TEXT NOT NULL,
      limit_version TEXT NOT NULL,
      reference_segments TEXT NOT NULL,
      lock_root INTEGER NOT NULL,
      exclude_outliers INTEGER NOT NULL,
      near_tie_rel_threshold REAL NOT NULL,
      input_fingerprint TEXT NOT NULL,
      shared_bias_json TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      run_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      wheel_position TEXT NOT NULL,
      epoch TEXT NOT NULL,
      import_order INTEGER NOT NULL,
      orientation TEXT NOT NULL,
      reversed INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      selected_candidate_id TEXT NOT NULL,
      applied_bias REAL NOT NULL,
      result_json TEXT NOT NULL,
      raw_points_json TEXT NOT NULL,
      PRIMARY KEY (run_id, profile_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS candidates (
      run_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      score REAL NOT NULL,
      relative_gap REAL NOT NULL,
      near_best INTEGER NOT NULL,
      seed TEXT NOT NULL,
      root_locked INTEGER NOT NULL,
      transform_json TEXT NOT NULL,
      PRIMARY KEY (run_id, profile_id, candidate_id),
      FOREIGN KEY (run_id, profile_id) REFERENCES profiles(run_id, profile_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_profiles_wheel ON profiles(wheel_position, epoch);
  `);
}

import { describe, it, expect, beforeEach } from 'vitest';
import { openMemoryDb } from '../server/db';
import type { DatabaseSync } from 'node:sqlite';

// store.ts 默认使用单例 getDb；这里直接用内存库验证 SQL 行为
describe('SQLite 持久化', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openMemoryDb();
  });

  it('空库计数为 0', () => {
    const p = db.prepare('SELECT COUNT(*) c FROM raw_profile').get() as { c: number };
    const r = db.prepare('SELECT COUNT(*) c FROM run_record').get() as { c: number };
    expect(p.c).toBe(0);
    expect(r.c).toBe(0);
  });

  it('轮廓 upsert 与查询', () => {
    db.prepare(
      `INSERT INTO raw_profile(id, wheel_position, epoch, seq, declared_direction, note, points_json, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run('w#1', 'w', '2026-01-01', 1, 'forward', null, JSON.stringify([{ x: 0, y: 0 }]), 't');
    db.prepare(
      `INSERT INTO raw_profile(id, wheel_position, epoch, seq, declared_direction, note, points_json, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET note=excluded.note`,
    ).run('w#1', 'w', '2026-01-01', 1, 'forward', 'updated', JSON.stringify([{ x: 0, y: 0 }]), 't');
    const row = db.prepare('SELECT * FROM raw_profile WHERE id=?').get('w#1') as any;
    expect(row.note).toBe('updated');
    expect(JSON.parse(row.points_json)).toHaveLength(1);
  });

  it('运行记录可写入并按指纹取回', () => {
    db.prepare(
      `INSERT INTO run_record(run_id, wheel_position, std_version, created_at, config_json, fingerprint, payload_json)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('run-1', 'w', 'STD-WP-1.0', 't', '{}', 'abc123', '{"runId":"run-1"}');
    const row = db.prepare('SELECT fingerprint FROM run_record WHERE run_id=?').get('run-1') as any;
    expect(row.fingerprint).toBe('abc123');
  });

  it('清空后可重新导入同一记录', () => {
    db.prepare(
      `INSERT INTO run_record(run_id, wheel_position, std_version, created_at, config_json, fingerprint, payload_json)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('run-x', 'w', 'STD-WP-1.0', 't', '{}', 'fp', '{}');
    db.exec('DELETE FROM run_record');
    expect((db.prepare('SELECT COUNT(*) c FROM run_record').get() as any).c).toBe(0);
    db.prepare(
      `INSERT INTO run_record(run_id, wheel_position, std_version, created_at, config_json, fingerprint, payload_json)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('run-x', 'w', 'STD-WP-1.0', 't', '{}', 'fp', '{}');
    expect((db.prepare('SELECT COUNT(*) c FROM run_record').get() as any).c).toBe(1);
  });
});

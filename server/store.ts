import { getDb } from './db';
import type { RawProfile } from '../src/core/types';

export interface RunRow {
  runId: string;
  wheelPosition: string;
  stdVersion: string;
  createdAt: string;
  configJson: string;
  fingerprint: string;
  payloadJson: string;
}

export function upsertWheelPosition(code: string, createdAt: string) {
  getDb()
    .prepare(
      `INSERT INTO wheel_position(code, created_at) VALUES (?, ?)
       ON CONFLICT(code) DO NOTHING`,
    )
    .run(code, createdAt);
}

export function upsertRawProfile(p: RawProfile) {
  upsertWheelPosition(p.wheelPosition, new Date().toISOString());
  getDb()
    .prepare(
      `INSERT INTO raw_profile(id, wheel_position, epoch, seq, declared_direction, note, points_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         wheel_position=excluded.wheel_position,
         epoch=excluded.epoch,
         seq=excluded.seq,
         declared_direction=excluded.declared_direction,
         note=excluded.note,
         points_json=excluded.points_json,
         created_at=excluded.created_at`,
    )
    .run(
      p.id,
      p.wheelPosition,
      p.epoch,
      p.seq,
      p.declaredDirection,
      p.note ?? null,
      JSON.stringify(p.points),
      new Date().toISOString(),
    );
}

function rowToRaw(r: Record<string, unknown>): RawProfile {
  return {
    id: r.id as string,
    wheelPosition: r.wheel_position as string,
    epoch: r.epoch as string,
    seq: r.seq as number,
    declaredDirection: r.declared_direction as RawProfile['declaredDirection'],
    note: (r.note as string | null) ?? undefined,
    points: JSON.parse(r.points_json as string),
  };
}

export function listRawProfiles(wheelPosition?: string): RawProfile[] {
  const db = getDb();
  const rows = wheelPosition
    ? (db
        .prepare(`SELECT * FROM raw_profile WHERE wheel_position = ? ORDER BY seq ASC`)
        .all(wheelPosition) as Record<string, unknown>[])
    : (db.prepare(`SELECT * FROM raw_profile ORDER BY wheel_position, seq ASC`).all() as Record<string, unknown>[]);
  return rows.map(rowToRaw);
}

export function getRawProfile(id: string): RawProfile | null {
  const r = getDb().prepare(`SELECT * FROM raw_profile WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToRaw(r) : null;
}

export function deleteRawProfile(id: string) {
  getDb().prepare(`DELETE FROM raw_profile WHERE id = ?`).run(id);
}

export function saveRun(row: RunRow) {
  getDb()
    .prepare(
      `INSERT INTO run_record(run_id, wheel_position, std_version, created_at, config_json, fingerprint, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         wheel_position=excluded.wheel_position,
         std_version=excluded.std_version,
         created_at=excluded.created_at,
         config_json=excluded.config_json,
         fingerprint=excluded.fingerprint,
         payload_json=excluded.payload_json`,
    )
    .run(
      row.runId,
      row.wheelPosition,
      row.stdVersion,
      row.createdAt,
      row.configJson,
      row.fingerprint,
      row.payloadJson,
    );
}

export function listRuns(wheelPosition?: string): RunRow[] {
  const db = getDb();
  const rows = wheelPosition
    ? (db
        .prepare(`SELECT * FROM run_record WHERE wheel_position = ? ORDER BY created_at DESC`)
        .all(wheelPosition) as Record<string, unknown>[])
    : (db.prepare(`SELECT * FROM run_record ORDER BY created_at DESC`).all() as Record<string, unknown>[]);
  return rows.map((r) => ({
    runId: r.run_id as string,
    wheelPosition: r.wheel_position as string,
    stdVersion: r.std_version as string,
    createdAt: r.created_at as string,
    configJson: r.config_json as string,
    fingerprint: r.fingerprint as string,
    payloadJson: r.payload_json as string,
  }));
}

export function getRun(runId: string): RunRow | null {
  const r = getDb().prepare(`SELECT * FROM run_record WHERE run_id = ?`).get(runId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    runId: r.run_id as string,
    wheelPosition: r.wheel_position as string,
    stdVersion: r.std_version as string,
    createdAt: r.created_at as string,
    configJson: r.config_json as string,
    fingerprint: r.fingerprint as string,
    payloadJson: r.payload_json as string,
  };
}

export function deleteRun(runId: string) {
  getDb().prepare(`DELETE FROM run_record WHERE run_id = ?`).run(runId);
}

export function clearAll() {
  const db = getDb();
  db.exec('DELETE FROM run_record; DELETE FROM raw_profile; DELETE FROM wheel_position;');
}

export function countAll() {
  const db = getDb();
  const profiles = (db.prepare(`SELECT COUNT(*) c FROM raw_profile`).get() as { c: number }).c;
  const runs = (db.prepare(`SELECT COUNT(*) c FROM run_record`).get() as { c: number }).c;
  return { profiles, runs };
}

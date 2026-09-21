import type { ProfileInput, RunRecord } from '../domain/types.js';
import type { DB } from './db.js';

interface SavedRun {
  run: RunRecord;
  inputs: ProfileInput[];
}

export function saveRun(db: DB, run: RunRecord, inputs: ProfileInput[]): void {
  const tx = db.prepare(
    `INSERT OR REPLACE INTO runs
      (run_id, created_at, fixture_id, standard_version, limit_version,
       reference_segments, lock_root, exclude_outliers, near_tie_rel_threshold,
       input_fingerprint, shared_bias_json, record_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  tx.run(
    run.runId,
    run.createdAt,
    run.fixtureId,
    run.standardVersion,
    run.limitVersion,
    JSON.stringify(run.referenceSegments),
    run.lockRoot ? 1 : 0,
    run.excludeOutliers ? 1 : 0,
    run.nearTieRelThreshold,
    run.inputFingerprint,
    JSON.stringify(run.sharedBiasCandidate),
    JSON.stringify(run),
  );

  const insProfile = db.prepare(
    `INSERT OR REPLACE INTO profiles
      (run_id, profile_id, wheel_position, epoch, import_order, orientation, reversed,
       fingerprint, selected_candidate_id, applied_bias, result_json, raw_points_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insCand = db.prepare(
    `INSERT OR REPLACE INTO candidates
      (run_id, profile_id, candidate_id, score, relative_gap, near_best, seed,
       root_locked, transform_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );

  inputs.forEach((inp, order) => {
    const result = run.profileResults.find((r) => r.profileId === inp.id);
    insProfile.run(
      run.runId,
      inp.id,
      inp.wheelPosition,
      inp.epoch,
      order,
      result?.orientation.orientation ?? inp.declaredOrientation ?? 'unknown',
      result?.orientation.reversed ? 1 : 0,
      result?.fingerprint ?? '',
      result?.selectedCandidateId ?? '',
      result?.appliedBias ?? 0,
      JSON.stringify(result ?? null),
      JSON.stringify(inp.rawPoints),
    );
    for (const c of result?.candidates ?? []) {
      insCand.run(
        run.runId,
        inp.id,
        c.candidateId,
        c.score,
        c.relativeGap,
        c.nearBest ? 1 : 0,
        c.seed,
        c.rootLocked ? 1 : 0,
        JSON.stringify(c.transform),
      );
    }
  });
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  fixtureId: string;
  standardVersion: string;
  limitVersion: string;
  lockRoot: boolean;
  excludeOutliers: boolean;
  profileCount: number;
  inputFingerprint: string;
}

export function listRuns(db: DB): RunSummary[] {
  const rows = db
    .prepare(
      `SELECT r.run_id, r.created_at, r.fixture_id, r.standard_version, r.limit_version,
              r.lock_root, r.exclude_outliers, r.input_fingerprint,
              (SELECT COUNT(*) FROM profiles p WHERE p.run_id = r.run_id) AS profile_count
       FROM runs r ORDER BY r.created_at DESC, r.run_id DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    runId: r.run_id as string,
    createdAt: r.created_at as string,
    fixtureId: r.fixture_id as string,
    standardVersion: r.standard_version as string,
    limitVersion: r.limit_version as string,
    lockRoot: !!r.lock_root,
    excludeOutliers: !!r.exclude_outliers,
    profileCount: r.profile_count as number,
    inputFingerprint: r.input_fingerprint as string,
  }));
}

export function loadRun(db: DB, runId: string): SavedRun | null {
  const row = db.prepare('SELECT record_json FROM runs WHERE run_id = ?').get(runId) as
    | { record_json: string }
    | undefined;
  if (!row) return null;
  const run = JSON.parse(row.record_json) as RunRecord;
  const prowRows = db
    .prepare('SELECT profile_id, raw_points_json FROM profiles WHERE run_id = ? ORDER BY import_order')
    .all(runId) as Array<{ profile_id: string; raw_points_json: string }>;
  const inputs: ProfileInput[] = prowRows.map((p) => {
    const meta = run.profileResults.find((r) => r.profileId === p.profile_id)!;
    return {
      id: p.profile_id,
      wheelPosition: meta.wheelPosition,
      epoch: meta.epoch,
      rawPoints: JSON.parse(p.raw_points_json),
      declaredOrientation: meta.orientation.orientation,
    };
  });
  return { run, inputs };
}

export function clearAllRuns(db: DB): void {
  db.exec('DELETE FROM candidates; DELETE FROM profiles; DELETE FROM runs;');
}

export function deleteRun(db: DB, runId: string): void {
  db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
}
